import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildEmbeddingEndpoint,
  isSafeEmbeddingBaseUrl,
} from "../../lib/core/embedding-service.js";
import { parseNpmPackReports } from "../../scripts/npm-pack-inventory.mjs";
import {
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "3";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_UPSTREAM_ADOPTION missing hash-bound adoption and retirement contract";

const BASE = "ef624f97cc616a9e00b6df653eded455fbd30e01";
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA1 = /^[0-9a-f]{40}$/;
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareText = (left, right) => left.localeCompare(right, "en");

const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: options.encoding ?? null,
    env: { ...process.env, LC_ALL: "C", ...options.env },
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
    shell: false,
    timeout: options.timeout ?? 90_000,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} failed with status ${result.status}: ${String(result.stderr || "").trim()}`,
  );
  return result.stdout;
}

function gitBlob(ref, relativePath) {
  return runCommand("git", ["cat-file", "blob", `${ref}:${relativePath}`]);
}

function listFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push({ bytes: readFileSync(absolutePath), path: relativePath });
    } else {
      assert.fail(`release inventory contains a non-regular entry: ${relativePath}`);
    }
  }
  return files.sort((left, right) => compareText(left.path, right.path));
}

function trackedFiles() {
  const paths = runCommand("git", ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
  return paths.map((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    const stat = lstatSync(absolutePath);
    assert.ok(stat.isFile(), `tracked source entry must be a regular file: ${relativePath}`);
    return { bytes: readFileSync(absolutePath), path: relativePath };
  });
}

function archiveFiles(tempRoot) {
  const archive = runCommand("git", ["archive", "--format=tar", "HEAD"]);
  const releaseRoot = path.join(tempRoot, "release");
  runCommand("mkdir", ["-m", "700", releaseRoot]);
  runCommand("tar", ["-xf", "-", "-C", releaseRoot], { input: archive });
  return listFiles(releaseRoot);
}

function packedFiles(tempRoot) {
  const packRoot = path.join(tempRoot, "pack");
  const cacheRoot = path.join(tempRoot, "npm-cache");
  runCommand("mkdir", ["-m", "700", packRoot]);
  const output = runCommand(
    "npm",
    [
      "--cache",
      cacheRoot,
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packRoot,
    ],
    { encoding: "utf8", env: { npm_config_ignore_scripts: "true" } },
  );
  const reports = parseNpmPackReports(output);
  assert.equal(reports.length, 1, "npm pack must produce exactly one package report");
  const archives = readdirSync(packRoot).filter((entry) => entry.endsWith(".tgz"));
  assert.equal(archives.length, 1, "npm pack must produce exactly one tarball");
  const extractedRoot = path.join(tempRoot, "package-extracted");
  runCommand("mkdir", ["-m", "700", extractedRoot]);
  runCommand("tar", ["-xzf", path.join(packRoot, archives[0]), "-C", extractedRoot]);
  const files = listFiles(path.join(extractedRoot, "package"));
  assert.deepEqual(
    files.map((entry) => entry.path).sort(compareText),
    reports[0].files.map((entry) => entry.path).sort(compareText),
    "npm report and extracted tarball inventories must match",
  );
  return files;
}

function publicInventoryFiles() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "public-release-manifest.json"), "utf8"));
  const paths = [...new Set([...manifest.repository.files, ...manifest.npm.files])].sort(compareText);
  return {
    files: paths.map((relativePath) => ({
      bytes: readFileSync(path.join(repoRoot, relativePath)),
      path: relativePath,
    })),
    paths,
  };
}

function assertRetiredAbsent(surface, files, forbiddenPaths, forbiddenHashes) {
  const paths = new Set(files.map((entry) => entry.path));
  for (const retiredPath of forbiddenPaths) {
    assert.equal(paths.has(retiredPath), false, `${surface} contains retired path ${retiredPath}`);
  }
  for (const entry of files) {
    assert.equal(
      forbiddenHashes.has(sha256(entry.bytes)),
      false,
      `${surface} contains retired implementation bytes at ${entry.path}`,
    );
  }
}

async function assertRetiredBehaviorAbsent(portMap) {
  const [
    hostTrust,
    beliefArbitration,
    worldModel,
    handoffBundle,
    handoffRecord,
    vaultSync,
    embeddingService,
    maintenanceService,
  ] = await Promise.all([
    import("../../lib/core/host-trust.js"),
    import("../../lib/core/belief-arbitration.js"),
    import("../../lib/core/world-model.js"),
    import("../../lib/core/handoff-bundle.js"),
    import("../../lib/core/handoff-record.js"),
    import("../../lib/core/vault-sync.js"),
    import("../../lib/core/embedding-service.js"),
    import("../../lib/core/maintenance-service.js"),
  ]);

  assert.ok(Object.hasOwn(hostTrust, "HUMAN"));
  assert.equal(typeof hostTrust.isRegisteredAgent, "function");
  assert.equal(hostTrust.isRegisteredAgent("synthetic-unregistered-agent"), false);
  assert.equal(typeof worldModel.configureBeliefTrust, "undefined");
  assert.equal(typeof beliefArbitration.runBeliefArbitration, "function");
  const low = beliefArbitration.resolveArbiterSettings({
    worldModel: { hostTrust: { synthetic_host: 0 } },
  });
  const high = beliefArbitration.resolveArbiterSettings({
    worldModel: { hostTrust: { synthetic_host: 1 } },
  });
  assert.ok(Object.isFrozen(low) && Object.isFrozen(high));
  assert.notEqual(low, high, "belief trust settings must not use retired module-global mutation");
  assert.ok(
    beliefArbitration.beliefHostTrustBonus({ source_host: "synthetic_host" }, low)
      < beliefArbitration.beliefHostTrustBonus({ source_host: "synthetic_host" }, high),
  );

  for (const retiredPath of [
    "lib/core/hygiene-migration.js",
    "lib/core/memory-passport.js",
    "lib/core/passport-bundle.js",
    "lib/core/vault-mirror.js",
    "scripts/gigabrain-hygiene-20260425.js",
  ]) {
    assert.equal(existsSync(path.join(repoRoot, retiredPath)), false, `retired behavior path exists: ${retiredPath}`);
  }
  assert.equal(typeof handoffBundle.exportPassportBundle, "function");
  assert.equal(typeof handoffRecord.buildMemoryPassport, "function");
  for (const retiredExport of [
    "buildVaultSurface",
    "inspectVaultHealth",
    "syncVaultMirror",
    "syncVaultPull",
  ]) {
    assert.equal(typeof vaultSync[retiredExport], "undefined");
  }
  assert.equal(typeof vaultSync.readVaultFileSafe, "function");
  assert.equal(vaultSync.readVaultFileSafe("/synthetic/not-present.md", { maxFileBytes: 1024 }).evicted, true);
  assert.equal(typeof embeddingService.DEFAULT_EMBEDDING_PROVIDER, "undefined");
  assert.equal(typeof embeddingService.normalizeEmbeddingProvider, "undefined");
  assert.equal(typeof maintenanceService.runHygieneMigration, "undefined");
  assert.equal(typeof maintenanceService.HYGIENE_VERSION, "undefined");

  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(packageJson.openclaw?.extensions, ["./index.js"]);
  assert.equal(existsSync(path.join(repoRoot, "index.js")), true);
  const forbiddenScriptPaths = new Set(portMap.retirementContracts.flatMap((row) => row.forbiddenPaths));
  for (const script of Object.values(packageJson.scripts || {})) {
    for (const forbiddenPath of forbiddenScriptPaths) {
      assert.equal(String(script).includes(forbiddenPath), false);
    }
  }
}

function assertDependencyTreeIdentity() {
  const upstreamPackage = JSON.parse(gitBlob(BASE, "package.json").toString("utf8"));
  const candidatePackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(candidatePackage.dependencies, upstreamPackage.dependencies);
  assert.deepEqual(candidatePackage.devDependencies, {
    ...upstreamPackage.devDependencies,
    acorn: "8.18.0",
    openclaw: "2026.7.1-2",
  });
  assert.deepEqual(candidatePackage.peerDependencies, upstreamPackage.peerDependencies);
  assert.deepEqual(candidatePackage.peerDependenciesMeta, upstreamPackage.peerDependenciesMeta);
  assert.deepEqual(candidatePackage.engines, upstreamPackage.engines);

  const upstreamLock = JSON.parse(gitBlob(BASE, "package-lock.json").toString("utf8"));
  const candidateLock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  assert.deepEqual(candidateLock.packages["node_modules/acorn"], {
    version: "8.18.0",
    resolved: "https://registry.npmjs.org/acorn/-/acorn-8.18.0.tgz",
    integrity: "sha512-lGq+9yr1/GuAWaVYIHRjvvySG5/4VfKIvC8EWxStPdcDh/Ka7FG3twP6v4d5BkravUilhIAsG4Qj83t02LWUPQ==",
    dev: true,
    license: "MIT",
    bin: { acorn: "bin/acorn" },
    engines: { node: ">=0.4.0" },
  });
  assert.equal(candidateLock.packages["node_modules/openclaw"]?.version, "2026.7.1-2");
  assert.equal(candidateLock.packages["node_modules/openclaw"]?.dev, true);
  const addedDevPaths = Object.keys(candidateLock.packages)
    .filter((packagePath) => !Object.hasOwn(upstreamLock.packages, packagePath));
  assert.ok(addedDevPaths.includes("node_modules/acorn"));
  assert.ok(addedDevPaths.includes("node_modules/openclaw"));
  assert.equal(
    addedDevPaths.every((packagePath) => candidateLock.packages[packagePath]?.dev === true),
    true,
    "every package added to the upstream lock must remain development-only",
  );
  for (const packagePath of addedDevPaths) delete candidateLock.packages[packagePath];
  delete candidateLock.packages[""].devDependencies.acorn;
  delete candidateLock.packages[""].devDependencies.openclaw;
  upstreamLock.version = "<release-version>";
  candidateLock.version = "<release-version>";
  upstreamLock.packages[""].version = "<release-version>";
  candidateLock.packages[""].version = "<release-version>";
  assert.deepEqual(
    candidateLock,
    upstreamLock,
    "production dependency lock may differ only by compatibility version metadata and development-only validation tooling",
  );
}

async function adoptionAndRetirementContract() {
  const allowlist = JSON.parse(readFileSync(
    path.join(repoRoot, "config", "migration", "upstream-source-allowlist.json"),
    "utf8",
  ));
  const portMap = JSON.parse(readFileSync(
    path.join(repoRoot, "config", "migration", "source-first-port-map.json"),
    "utf8",
  ));
  const testRegistry = JSON.parse(readFileSync(
    path.join(repoRoot, "config", "migration", "source-first-test-registry.json"),
    "utf8",
  ));
  const attestation = JSON.parse(readFileSync(
    path.join(repoRoot, "config", "migration", "retirement-evidence-attestation.json"),
    "utf8",
  ));
  const structural = await import("../../scripts/retirement-structural-fingerprint.mjs");
  assert.ok(Array.isArray(allowlist.adoptionContracts));
  assert.equal(allowlist.adoptionContractCount, allowlist.adoptionContracts.length);
  assert.equal(
    allowlist.adoptionContractManifestSha256,
    "e25eb05c00029eb2af2b5f89db51ee999c38fef3ef80e74964c44ce551fa35b2",
  );
  assert.equal(
    allowlist.adoptionContractManifestSha256,
    sha256(canonicalJson(allowlist.adoptionContracts)),
  );
  assert.ok(Array.isArray(portMap.retirementContracts));
  assert.equal(portMap.retirementContractCount, portMap.retirementContracts.length);
  assert.equal(
    portMap.retirementContractManifestSha256,
    "b5bd31b3650a80a7c7cd6e11bbf8fc16eb4acdad68b0a1c6dd891b104ed29cbb",
  );
  assert.equal(
    portMap.retirementContractManifestSha256,
    sha256(canonicalJson(portMap.retirementContracts)),
  );

  const expectedAdoptions = [
    "active-boundary-retention",
    "all-scope-guard",
    "custom-slot-framework",
    "handoff-v2",
    "observational-recall",
    "runtime-source-entry",
    "safe-filesystem-url",
    "timeline",
    "trust-arbitration",
    "vault-read-only",
    "workspace-identity",
  ];
  const expectedRetirements = [
    "belief-trust",
    "broad-vault-mirror",
    "hand-edited-runtime-blob",
    "host-trust",
    "one-time-hygiene",
    "passport",
    "remote-embedding-provider",
    "workspace-identity",
  ];
  assert.deepEqual(allowlist.adoptionContracts.map((row) => row.id), expectedAdoptions);
  assert.deepEqual(portMap.retirementContracts.map((row) => row.id), expectedRetirements);
  assert.equal(attestation.entryCount, attestation.entries.length);
  assert.equal(
    attestation.manifestSha256,
    "26f4bdd011ed499fd2b49ecdb0e563ac5053889ea76265f12408528fbe22e619",
  );
  assert.equal(attestation.manifestSha256, sha256(canonicalJson(attestation.entries)));
  assert.equal(attestation.structuralFingerprintCount, attestation.structuralFingerprints.length);
  assert.equal(
    attestation.structuralFingerprintManifestSha256,
    "c672074c8da1111872ea2da78f6e6eafaff15926f3d6bad6f29d85382b852b0b",
  );
  assert.equal(
    attestation.structuralFingerprintManifestSha256,
    sha256(canonicalJson(attestation.structuralFingerprints)),
  );

  const allowByPath = new Map(allowlist.entries.map((entry) => [entry.path, entry]));
  const candidateByPath = new Map(portMap.candidateChanges.map((entry) => [entry.targetPath, entry]));
  const registrationById = new Map(testRegistry.entries.map((entry) => [entry.id, entry]));
  const verifiedCorePatchPaths = new Set();
  for (const candidateChange of portMap.candidateChanges.filter((row) => row.disposition === "core_patch")) {
    const relativePath = candidateChange.targetPath;
    const registration = registrationById.get(candidateChange.gate?.registrationId);
    assert.equal(candidateChange.contentSha256, sha256(readFileSync(path.join(repoRoot, relativePath))), `core patch hash: ${relativePath}`);
    assert.ok(registration, `core patch registration missing: ${relativePath}`);
    assert.equal(registration.expectedOutcome, "pass", `core patch gate is not passing: ${relativePath}`);
    assert.match(String(registration.testSha256 || ""), SHA256, `core patch test hash missing: ${relativePath}`);
    assert.equal(
      registration.testSha256,
      sha256(readFileSync(path.join(repoRoot, registration.testPath))),
      `core patch test hash is stale: ${relativePath}`,
    );
    assert.ok(registration.coveredPaths.includes(relativePath), `core patch path is not covered: ${relativePath}`);
    assert.ok(
      registration.relevanceEvidence?.some((evidence) => evidence.targetPath === relativePath),
      `core patch relevance evidence missing: ${relativePath}`,
    );
    assert.ok(candidateChange.ownerTasks.includes(registration.ownerSourceFirstTaskId));
    verifiedCorePatchPaths.add(relativePath);
  }
  const adoptedPaths = new Set();
  for (const contract of allowlist.adoptionContracts) {
    assert.ok(Array.isArray(contract.paths) && contract.paths.length > 0);
    assert.deepEqual(contract.paths, [...contract.paths].sort(compareText));
    for (const relativePath of contract.paths) {
      const allowEntry = allowByPath.get(relativePath);
      const upstream = gitBlob(BASE, relativePath);
      const candidate = readFileSync(path.join(repoRoot, relativePath));
      const candidateChange = candidateByPath.get(relativePath);
      if (verifiedCorePatchPaths.has(relativePath)) {
        assert.equal(candidateChange.changeType, "modified", `adopted core patch type: ${relativePath}`);
      } else {
        assert.ok(allowEntry, `adopted path is neither byte-identical nor a verified core patch: ${relativePath}`);
        assert.deepEqual(candidate, upstream, `adopted module diverged from v0.11.0: ${relativePath}`);
      }
      if (allowEntry) {
        assert.equal(
          execFileSync("git", ["rev-parse", `${BASE}:${relativePath}`], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 10_000,
          }).trim(),
          allowEntry.blob,
        );
      }
      adoptedPaths.add(relativePath);
    }
  }
  const acceptedReplacementPaths = new Set([...adoptedPaths, ...verifiedCorePatchPaths]);

  const forbiddenHashes = new Set();
  const forbiddenPaths = new Set();
  for (const contract of portMap.retirementContracts) {
    assert.ok(["forbidden_bytes", "upstream_identity"].includes(contract.enforcement));
    assert.deepEqual(contract.forbiddenPaths, [...contract.forbiddenPaths].sort(compareText));
    assert.deepEqual(contract.replacementPaths, [...contract.replacementPaths].sort(compareText));
    for (const replacementPath of contract.replacementPaths) {
      assert.ok(acceptedReplacementPaths.has(replacementPath), `retirement replacement is not adopted: ${replacementPath}`);
    }
    for (const evidence of contract.evidence) {
      assert.match(evidence.commit, FULL_SHA1);
      assert.match(evidence.sourceBlob, FULL_SHA1);
      assert.match(evidence.sha256, SHA256);
      assert.ok(typeof evidence.path === "string" && evidence.path.length > 0);
      if (contract.enforcement === "forbidden_bytes") forbiddenHashes.add(evidence.sha256);
    }
    for (const retiredPath of contract.forbiddenPaths) forbiddenPaths.add(retiredPath);
  }
  assert.ok(forbiddenHashes.size > 0);
  assert.ok(forbiddenPaths.size > 0);

  const attestedByKey = new Map(attestation.entries.map((row) => [
    `${row.behaviorId}\0${row.commit}\0${row.path}`,
    row,
  ]));
  for (const contract of portMap.retirementContracts) {
    for (const evidence of contract.evidence) {
      assert.deepEqual(
        attestedByKey.get(`${contract.id}\0${evidence.commit}\0${evidence.path}`),
        { behaviorId: contract.id, ...evidence },
      );
    }
  }
  assert.equal(attestedByKey.size, portMap.retirementContracts.flatMap((row) => row.evidence).length);

  await assertRetiredBehaviorAbsent(portMap);

  assertDependencyTreeIdentity();
  assert.equal(isSafeEmbeddingBaseUrl("http://127.0.0.1:11434"), true);
  assert.equal(isSafeEmbeddingBaseUrl("http://localhost:11434"), true);
  assert.equal(isSafeEmbeddingBaseUrl("https://embedding.invalid/v1"), false);
  assert.equal(isSafeEmbeddingBaseUrl("http://embedding.invalid:11434"), false);
  assert.equal(isSafeEmbeddingBaseUrl("http://127.0.0.1:8080"), false);
  assert.equal(buildEmbeddingEndpoint("https://embedding.invalid/v1"), null);
  assert.equal(buildEmbeddingEndpoint("http://127.0.0.1:11434").origin, "http://127.0.0.1:11434");

  const tempRoot = mkdtempSync(path.join(tmpdir(), "gigabrain-upstream-adoption-"));
  try {
    const source = trackedFiles();
    const release = archiveFiles(tempRoot);
    const packed = packedFiles(tempRoot);
    const publicInventory = publicInventoryFiles();
    assertRetiredAbsent("source", source, forbiddenPaths, forbiddenHashes);
    assertRetiredAbsent("release archive", release, forbiddenPaths, forbiddenHashes);
    assertRetiredAbsent("npm package", packed, forbiddenPaths, forbiddenHashes);
    assertRetiredAbsent("public inventory", publicInventory.files, forbiddenPaths, forbiddenHashes);
    for (const [surface, files] of [
      ["source", source],
      ["release archive", release],
      ["npm package", packed],
      ["public inventory", publicInventory.files],
    ]) {
      const matches = structural.findRetiredStructuralFingerprintMatches(
        files,
        attestation.structuralFingerprints,
      );
      assert.deepEqual(matches, [], `${surface} contains retired structural behavior`);
    }
    for (const retiredPath of forbiddenPaths) {
      assert.equal(publicInventory.paths.includes(retiredPath), false);
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

export async function run() {
  await runBehaviorContract(EXPECTED_SIGNATURE, adoptionAndRetirementContract);
}

runDirect(import.meta.url, run);

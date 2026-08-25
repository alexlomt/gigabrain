import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
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

function assertDependencyTreeIdentity() {
  const upstreamPackage = JSON.parse(gitBlob(BASE, "package.json").toString("utf8"));
  const candidatePackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(candidatePackage.dependencies, upstreamPackage.dependencies);
  assert.deepEqual(candidatePackage.devDependencies, upstreamPackage.devDependencies);
  assert.deepEqual(candidatePackage.peerDependencies, upstreamPackage.peerDependencies);
  assert.deepEqual(candidatePackage.peerDependenciesMeta, upstreamPackage.peerDependenciesMeta);
  assert.deepEqual(candidatePackage.engines, upstreamPackage.engines);

  const upstreamLock = JSON.parse(gitBlob(BASE, "package-lock.json").toString("utf8"));
  const candidateLock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  upstreamLock.version = "<release-version>";
  candidateLock.version = "<release-version>";
  upstreamLock.packages[""].version = "<release-version>";
  candidateLock.packages[""].version = "<release-version>";
  assert.deepEqual(candidateLock, upstreamLock, "dependency lock may differ only by compatibility version metadata");
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
  assert.ok(Array.isArray(allowlist.adoptionContracts));
  assert.equal(allowlist.adoptionContractCount, allowlist.adoptionContracts.length);
  assert.equal(
    allowlist.adoptionContractManifestSha256,
    sha256(canonicalJson(allowlist.adoptionContracts)),
  );
  assert.ok(Array.isArray(portMap.retirementContracts));
  assert.equal(portMap.retirementContractCount, portMap.retirementContracts.length);
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

  const allowByPath = new Map(allowlist.entries.map((entry) => [entry.path, entry]));
  const adoptedPaths = new Set();
  for (const contract of allowlist.adoptionContracts) {
    assert.ok(Array.isArray(contract.paths) && contract.paths.length > 0);
    assert.deepEqual(contract.paths, [...contract.paths].sort(compareText));
    for (const relativePath of contract.paths) {
      const allowEntry = allowByPath.get(relativePath);
      assert.ok(allowEntry, `adopted path is not upstream allowlisted: ${relativePath}`);
      const upstream = gitBlob(BASE, relativePath);
      const candidate = readFileSync(path.join(repoRoot, relativePath));
      assert.deepEqual(candidate, upstream, `adopted module diverged from v0.11.0: ${relativePath}`);
      assert.equal(
        execFileSync("git", ["rev-parse", `${BASE}:${relativePath}`], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 10_000,
        }).trim(),
        allowEntry.blob,
      );
      adoptedPaths.add(relativePath);
    }
  }

  const forbiddenHashes = new Set();
  const forbiddenPaths = new Set();
  for (const contract of portMap.retirementContracts) {
    assert.ok(["forbidden_bytes", "upstream_identity"].includes(contract.enforcement));
    assert.deepEqual(contract.forbiddenPaths, [...contract.forbiddenPaths].sort(compareText));
    assert.deepEqual(contract.replacementPaths, [...contract.replacementPaths].sort(compareText));
    for (const replacementPath of contract.replacementPaths) {
      assert.ok(adoptedPaths.has(replacementPath), `retirement replacement is not adopted: ${replacementPath}`);
    }
    for (const evidence of contract.evidence) {
      assert.match(evidence.commit, FULL_SHA1);
      assert.match(evidence.sha256, SHA256);
      assert.ok(typeof evidence.path === "string" && evidence.path.length > 0);
      if (contract.enforcement === "forbidden_bytes") forbiddenHashes.add(evidence.sha256);
    }
    for (const retiredPath of contract.forbiddenPaths) forbiddenPaths.add(retiredPath);
  }
  assert.ok(forbiddenHashes.size > 0);
  assert.ok(forbiddenPaths.size > 0);

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

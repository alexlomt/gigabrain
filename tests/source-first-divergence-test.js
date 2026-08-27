import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hashStructuralTokenWindow,
  STRUCTURAL_FINGERPRINT_ALGORITHM,
  tokenizeStructuralSource,
} from "../scripts/retirement-structural-fingerprint.mjs";

export async function run() {

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardPath = path.join(repoRoot, "scripts", "check-source-first-divergence.mjs");
const mapPath = path.join(repoRoot, "config", "migration", "source-first-port-map.json");
const allowlistPath = path.join(repoRoot, "config", "migration", "upstream-source-allowlist.json");
const retirementEvidencePath = path.join(
  repoRoot,
  "config",
  "migration",
  "retirement-evidence-attestation.json",
);

for (const [label, requiredPath] of [
  ["source-first guard", guardPath],
  ["source-first port map", mapPath],
  ["upstream source allowlist", allowlistPath],
  ["retirement evidence attestation", retirementEvidencePath],
]) {
  assert.doesNotThrow(
    () => readFileSync(requiredPath),
    `missing ${label}: ${path.relative(repoRoot, requiredPath)}`,
  );
}

const realMap = JSON.parse(readFileSync(mapPath, "utf8"));
const realRegistry = JSON.parse(readFileSync(
  path.join(repoRoot, "config/migration/source-first-test-registry.json"),
  "utf8",
));
const task11WriterRegistration = realRegistry.entries.find((row) => row.id === "compat-projection-writer-registry");
const task11WriterEvidence = new Map(task11WriterRegistration.relevanceEvidence.map((row) => [row.targetPath, row]));
assert.equal([...task11WriterEvidence.values()].filter((row) => row.mode === "writer_exercised").length, 15);
assert.equal(task11WriterEvidence.get("lib/core/belief-arbitration.js")?.symbol, "consolidateBeliefRows");
assert.equal(task11WriterEvidence.get("lib/core/wiki-project.js")?.symbol, "reconcileWiki");
const assertMemoryApiSealing = () => {
  const memoryApiSource = readFileSync("memory_api/app.py", "utf8");
  const memoryApiReadme = readFileSync("memory_api/README.md", "utf8");
  assert.match(memoryApiSource, /memory_current/);
  assert.match(memoryApiSource, /memory_console_metadata/);
  assert.match(memoryApiReadme, /GB_API_READ_ONLY/);
};
assertMemoryApiSealing();
const realAllowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const realRetirementEvidence = JSON.parse(readFileSync(retirementEvidencePath, "utf8"));
assert.equal(realMap.deployedSource.commit, "43cd4b41518b5e35b3872722fcceaac535a1ff64");
assert.equal(realMap.deployedCommits.length, 47);
assert.equal(realMap.deployedFiles.length, 208);
assert.equal(realMap.preTagTools.length, 9);
assert.equal(realMap.candidateChanges.length, 207);
assert.equal(realMap.retirementContractCount, 8);
assert.equal(
  realMap.retirementContractManifestSha256,
  "b5bd31b3650a80a7c7cd6e11bbf8fc16eb4acdad68b0a1c6dd891b104ed29cbb",
);
assert.equal(realRetirementEvidence.entryCount, 13);
assert.equal(
  realRetirementEvidence.manifestSha256,
  "26f4bdd011ed499fd2b49ecdb0e563ac5053889ea76265f12408528fbe22e619",
);
assert.equal(realRetirementEvidence.structuralFingerprintCount, 13);
assert.equal(
  realRetirementEvidence.structuralFingerprintManifestSha256,
  "c672074c8da1111872ea2da78f6e6eafaff15926f3d6bad6f29d85382b852b0b",
);
assert.equal(realAllowlist.entries.length, 134);
assert.equal(realAllowlist.adoptionContractCount, 11);
assert.equal(
  realAllowlist.adoptionContractManifestSha256,
  "e25eb05c00029eb2af2b5f89db51ee999c38fef3ef80e74964c44ce551fa35b2",
);
assert.deepEqual(
  realMap.deployedCommits.map((row) => row.sequence),
  Array.from({ length: 47 }, (_, index) => index + 1),
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10_000,
  }).trim();
}

function commitAll(repo, message) {
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "-m", message]);
}

function blobIdentity(filePath) {
  return sha256(readFileSync(filePath));
}

function makeFixture(mutate = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-source-first-"));
  const fixtureRepo = path.join(root, "repo");
  const policyDir = path.join(root, "policy");
  mkdirSync(path.join(fixtureRepo, "lib"), { recursive: true });
  mkdirSync(policyDir, { recursive: true });

  git(fixtureRepo, ["init", "--quiet"]);
  git(fixtureRepo, ["config", "user.name", "Source First Test"]);
  git(fixtureRepo, ["config", "user.email", "source-first-test@example.com"]);
  writeFileSync(path.join(fixtureRepo, "package.json"), '{"type":"module"}\n');
  writeFileSync(path.join(fixtureRepo, "lib", "upstream.js"), "export const readUpstream = () => true;\n");
  writeFileSync(path.join(fixtureRepo, "lib", "core.js"), "export const core = true;\n");
  mkdirSync(path.join(fixtureRepo, "tests"), { recursive: true });
  writeFileSync(
    path.join(fixtureRepo, "tests", "unregistered-test.js"),
    "export async function run() { return true; }\n",
  );
  writeFileSync(
    path.join(fixtureRepo, "tests", "registered-test.js"),
    "export async function run() { return true; }\n",
  );
  writeFileSync(
    path.join(fixtureRepo, "tests", "contract-test-helpers.js"),
    [
      'export const importContractModule = async (relative) => import(`../${relative}`);',
      'export const requireCallable = () => () => false;',
      '',
    ].join("\n"),
  );
  commitAll(fixtureRepo, "fixture base");

  const base = git(fixtureRepo, ["rev-parse", "HEAD"]);
  const tree = git(fixtureRepo, ["rev-parse", "HEAD^{tree}"]);
  mkdirSync(path.join(fixtureRepo, "config"), { recursive: true });
  writeFileSync(path.join(fixtureRepo, "config", "meta.json"), "{\"fixture\":true}\n");
  commitAll(fixtureRepo, "allowed fixture delta");

  const legacyBytes = Buffer.from('export const legacy = "synthetic-obsolete-v0.7";\n');
  const retiredBytes = Buffer.from(`
export function syntheticRetiredPolicy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const parts = normalized.split(/\\s+/).filter(Boolean);
  if (parts.length < 2) return { accepted: false, reason: "too_short" };
  const score = parts.reduce((total, item) => total + item.length, 0);
  return { accepted: score > 12, count: parts.length, score };
}
`);
  const adoptionContracts = [
    {
      id: "synthetic-upstream",
      paths: ["lib/upstream.js"],
    },
  ];
  const retirementContracts = [
    {
      enforcement: "forbidden_bytes",
      evidence: [{
        commit: "1".repeat(40),
        path: "legacy/task3-retired.js",
        sha256: sha256(retiredBytes),
        sourceBlob: "7".repeat(40),
      }],
      forbiddenPaths: ["legacy/task3-retired.js"],
      id: "synthetic-retired",
      replacementPaths: ["lib/upstream.js"],
    },
  ];
  const deployedFiles = [
    {
      disposition: "retired",
      historicalDisposition: "Synthetic historical fixture; no candidate target.",
      ownerTasks: ["2A"],
      reason: "Exercises complete deployed-source manifest validation.",
      sourceBlob: "2".repeat(40),
      sourceMode: "100644",
      sourcePath: "legacy/source.js",
      testGate: "source-first divergence fixture gate",
    },
  ];
  const deployedCommits = [
    {
      commit: "1".repeat(40),
      contract: "Synthetic historical contract",
      disposition: "retired",
      historicalDisposition: "Synthetic fixture history only.",
      ownerTasks: ["2A"],
      reason: "Exercises complete deployed-commit ledger validation.",
      sequence: 1,
      sourcePaths: ["legacy/task3-retired.js", "lib/upstream.js"],
      testGate: "source-first divergence fixture gate",
    },
  ];
  const preTagTools = [
    {
      disposition: "private_dev_only",
      historicalDisposition: "Synthetic private development fixture.",
      id: "synthetic-pre-tag-tool",
      ownerTasks: ["2A"],
      reason: "Exercises explicit pre-tag disposition validation.",
      sourcePaths: ["legacy/tool.js"],
      testGate: "source-first divergence fixture gate",
    },
  ];
  const obsoleteSourceFingerprints = [
    {
      disposition: "retired",
      historicalDisposition: "Obsolete synthetic implementation must not be copied.",
      ownerTasks: ["2A"],
      reason: "Exercises byte-exact obsolete-source rejection.",
      sha256: sha256(legacyBytes),
      sourcePath: "legacy/obsolete.js",
      testGate: "source-first divergence fixture gate",
    },
  ];
  const candidateChanges = [
    {
      changeType: "added",
      contentSha256: blobIdentity(path.join(fixtureRepo, "config", "meta.json")),
      disposition: "operator_only",
      gate: { registrationId: "fixture-gate" },
      ownerTasks: ["2A"],
      reason: "Synthetic policy metadata owned by the fixture.",
      targetMode: "100644",
      targetPath: "config/meta.json",
    },
  ];
  const testRegistryEntries = [
    {
      coveredPaths: ["config/meta.json"],
      expectedOutcome: "pass",
      expectedSignature: null,
      id: "fixture-gate",
      ownerSourceFirstTaskId: "2A",
      runner: "node",
      testPath: "tests/registered-test.js",
    },
  ];
  const registry = {
    entries: testRegistryEntries,
    entryCount: testRegistryEntries.length,
    manifestSha256: sha256(canonicalJson(testRegistryEntries)),
    schemaVersion: 1,
  };
  const retiredTokens = tokenizeStructuralSource(retiredBytes);
  const retiredTokenCount = Math.min(48, retiredTokens.length);
  const retirementEvidenceEntries = [{
    behaviorId: "synthetic-retired",
    commit: "1".repeat(40),
    path: "legacy/task3-retired.js",
    sha256: sha256(retiredBytes),
    sourceBlob: "7".repeat(40),
  }];
  const retirementStructuralFingerprints = [{
    algorithm: STRUCTURAL_FINGERPRINT_ALGORITHM,
    behaviorId: "synthetic-retired",
    commit: "1".repeat(40),
    path: "legacy/task3-retired.js",
    sha256: hashStructuralTokenWindow(retiredTokens, 0, retiredTokenCount),
    sourceBlob: "7".repeat(40),
    sourceTokenOffset: 0,
    tokenCount: retiredTokenCount,
  }];

  const baseRows = git(fixtureRepo, ["ls-tree", "-r", base])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(line);
      assert(match);
      return { blob: match[3], mode: match[1], path: match[4], type: match[2] };
    });

  const fixture = {
    allowlist: {
      adoptionContractCount: adoptionContracts.length,
      adoptionContractManifestSha256: sha256(canonicalJson(adoptionContracts)),
      adoptionContracts,
      auditedBase: { commit: base, tree },
      entries: baseRows,
      entryCount: baseRows.length,
      manifestSha256: sha256(canonicalJson(baseRows)),
      schemaVersion: 1,
    },
    map: {
      auditedBase: { commit: base, tree },
      candidateChanges,
      deployedCommits,
      deployedFiles,
      deployedSource: {
        commit: "3".repeat(40),
        commitCount: deployedCommits.length,
        commitManifestSha256: sha256(canonicalJson(deployedCommits)),
        fileCount: deployedFiles.length,
        fileManifestSha256: sha256(canonicalJson(deployedFiles)),
        tree: "4".repeat(40),
      },
      obsoleteSourceFingerprints,
      obsoleteSourceManifestSha256: sha256(canonicalJson(obsoleteSourceFingerprints)),
      preTagToolCount: preTagTools.length,
      preTagToolManifestSha256: sha256(canonicalJson(preTagTools)),
      preTagTools,
      retirementContractCount: retirementContracts.length,
      retirementContractManifestSha256: sha256(canonicalJson(retirementContracts)),
      retirementContracts,
      retirementEvidenceAttestation: "retirement-evidence-attestation.json",
      schemaVersion: 1,
      testRegistry: "source-first-test-registry.json",
      upstreamAllowlist: "upstream-source-allowlist.json",
    },
    base,
    fixtureRepo,
    legacyBytes,
    policyDir,
    retiredBytes,
    retirementEvidence: {
      attestationKind: "read-only-deployed-source-hashes-v1",
      auditedDeployedSource: { commit: "3".repeat(40), tree: "4".repeat(40) },
      entries: retirementEvidenceEntries,
      entryCount: retirementEvidenceEntries.length,
      manifestSha256: sha256(canonicalJson(retirementEvidenceEntries)),
      schemaVersion: 1,
      structuralFingerprintCount: retirementStructuralFingerprints.length,
      structuralFingerprintManifestSha256: sha256(canonicalJson(retirementStructuralFingerprints)),
      structuralFingerprints: retirementStructuralFingerprints,
    },
    registry,
    root,
  };

  mutate(fixture);

  fixture.allowlist.entryCount ??= fixture.allowlist.entries.length;
  fixture.allowlist.manifestSha256 ??= sha256(canonicalJson(fixture.allowlist.entries));
  fixture.allowlist.adoptionContractCount ??= fixture.allowlist.adoptionContracts.length;
  fixture.allowlist.adoptionContractManifestSha256 ??= sha256(canonicalJson(fixture.allowlist.adoptionContracts));
  fixture.map.retirementContractCount ??= fixture.map.retirementContracts.length;
  fixture.map.retirementContractManifestSha256 ??= sha256(canonicalJson(fixture.map.retirementContracts));
  fixture.retirementEvidence.entryCount ??= fixture.retirementEvidence.entries.length;
  fixture.retirementEvidence.manifestSha256 ??= sha256(canonicalJson(fixture.retirementEvidence.entries));
  fixture.retirementEvidence.structuralFingerprintCount ??= fixture.retirementEvidence.structuralFingerprints.length;
  fixture.retirementEvidence.structuralFingerprintManifestSha256 ??= sha256(
    canonicalJson(fixture.retirementEvidence.structuralFingerprints),
  );
  fixture.registry.entryCount ??= fixture.registry.entries.length;
  fixture.registry.manifestSha256 ??= sha256(canonicalJson(fixture.registry.entries));
  writeFileSync(path.join(policyDir, "upstream-source-allowlist.json"), canonicalJson(fixture.allowlist));
  writeFileSync(path.join(policyDir, "source-first-test-registry.json"), canonicalJson(fixture.registry));
  writeFileSync(
    path.join(policyDir, "retirement-evidence-attestation.json"),
    canonicalJson(fixture.retirementEvidence),
  );
  writeFileSync(path.join(policyDir, "source-first-port-map.json"), canonicalJson(fixture.map));
  return fixture;
}

function runGuard(fixture, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [guardPath, "--base", fixture.base, "--map", path.join(fixture.policyDir, "source-first-port-map.json"), ...extraArgs],
    {
      cwd: fixture.fixtureRepo,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 10_000,
    },
  );
}

function registerFixtureCoverage(registry, targetPath) {
  if (!registry.entries[0].coveredPaths.includes(targetPath)) {
    registry.entries[0].coveredPaths.push(targetPath);
    registry.entries[0].coveredPaths.sort((left, right) => left.localeCompare(right, "en"));
  }
  registry.manifestSha256 = sha256(canonicalJson(registry.entries));
}

function addClassifiedFixtureFile({ fixtureRepo, map, registry }, targetPath, bytes) {
  const absolutePath = path.join(fixtureRepo, targetPath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
  commitAll(fixtureRepo, `classified fixture ${targetPath}`);
  map.candidateChanges.push({
    changeType: "added",
    contentSha256: blobIdentity(absolutePath),
    disposition: "compat_module",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic classified source-first fixture.",
    targetMode: "100644",
    targetPath,
  });
  map.candidateChanges.sort((left, right) => left.targetPath.localeCompare(right.targetPath, "en"));
  registerFixtureCoverage(registry, targetPath);
}

function expectPass(name, mutate) {
  const fixture = makeFixture(mutate);
  try {
    const result = runGuard(fixture);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /SOURCE_FIRST_DIVERGENCE OK\b/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function expectFailure(name, code, mutate, extraArgs = []) {
  const fixture = makeFixture(mutate);
  try {
    const result = runGuard(fixture, extraArgs);
    assert.notEqual(result.status, 0, `${name}: guard unexpectedly passed`);
    assert.match(result.stderr, new RegExp(`SOURCE_FIRST_DIVERGENCE ${code}\\b`), name);
    assert.doesNotMatch(result.stderr, /synthetic-obsolete-v0\.7|SOURCE_FIRST_PRIVATE_LITERAL/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function configureAdoptedCorePatch(fixture, {
  evidence = true,
  staleHash = false,
  testSource = "export async function run() { return true; }\n",
} = {}) {
  const targetPath = "lib/upstream.js";
  const testTargetPath = "tests/core-evidence-test.js";
  const testPath = path.join(fixture.fixtureRepo, testTargetPath);
  writeFileSync(path.join(fixture.fixtureRepo, targetPath), "export const readUpstream = () => false;\n");
  writeFileSync(testPath, testSource);
  commitAll(fixture.fixtureRepo, "adopted core patch evidence fixture");
  fixture.map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(path.join(fixture.fixtureRepo, targetPath)),
    disposition: "core_patch",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic adopted core patch evidence fixture.",
    targetMode: "100644",
    targetPath,
  });
  fixture.map.candidateChanges.push({
    changeType: "added",
    contentSha256: blobIdentity(testPath),
    disposition: "private_dev_only",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic hash-bound gate implementation fixture.",
    targetMode: "100644",
    targetPath: testTargetPath,
  });
  fixture.map.candidateChanges.sort((left, right) => left.targetPath.localeCompare(right.targetPath, "en"));
  registerFixtureCoverage(fixture.registry, targetPath);
  registerFixtureCoverage(fixture.registry, testTargetPath);
  const registration = fixture.registry.entries[0];
  registration.testPath = testTargetPath;
  registration.testSha256 = staleHash ? "0".repeat(64) : blobIdentity(testPath);
  if (evidence) registration.relevanceEvidence = [
    {
      binding: "readUpstream",
      mode: "import",
      resultBinding: "observed",
      symbol: "readUpstream",
      targetPath,
    },
  ];
  fixture.registry.manifestSha256 = sha256(canonicalJson(fixture.registry.entries));
}

function configureCompatModuleWriterEvidence(fixture) {
  const targetPath = "lib/compat-writer.js";
  const testTargetPath = "tests/compat-writer-test.js";
  const target = path.join(fixture.fixtureRepo, targetPath);
  const test = path.join(fixture.fixtureRepo, testTargetPath);
  writeFileSync(target, [
    "export const actualWriter = () => true;",
    "export const pureProbe = () => false;",
    "",
  ].join("\n"));
  writeFileSync(test, [
    'import assert from "node:assert/strict";',
    'import { pureProbe } from "../lib/compat-writer.js";',
    'export async function run() {',
    '  if (false) { const observed = pureProbe(); assert.equal(observed, false); }',
    '  assert.equal(true, true);',
    '}',
    '',
  ].join("\n"));
  commitAll(fixture.fixtureRepo, "compat writer evidence fixture");
  fixture.map.candidateChanges.push({
    changeType: "added",
    contentSha256: blobIdentity(target),
    disposition: "compat_module",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic compat writer evidence fixture.",
    targetMode: "100644",
    targetPath,
  }, {
    changeType: "added",
    contentSha256: blobIdentity(test),
    disposition: "private_dev_only",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic compat writer test fixture.",
    targetMode: "100644",
    targetPath: testTargetPath,
  });
  fixture.map.candidateChanges.sort((left, right) => left.targetPath.localeCompare(right.targetPath, "en"));
  registerFixtureCoverage(fixture.registry, targetPath);
  registerFixtureCoverage(fixture.registry, testTargetPath);
  const registration = fixture.registry.entries[0];
  registration.testPath = testTargetPath;
  registration.testSha256 = blobIdentity(test);
  registration.relevanceEvidence = [{
    binding: "pureProbe",
    mode: "writer_exercised",
    symbol: "pureProbe",
    targetPath,
  }];
  fixture.registry.manifestSha256 = sha256(canonicalJson(fixture.registry.entries));
}

function configureRetirementReplacementCorePatch(fixture, {
  evidence = "relevant",
  expectedOutcome = "pass",
  failingTest = false,
  registeredGate = true,
  staleHash = false,
} = {}) {
  const targetPath = "lib/core.js";
  const absoluteTarget = path.join(fixture.fixtureRepo, targetPath);
  writeFileSync(absoluteTarget, "export const core = () => false;\n");
  if (registeredGate) {
    const testPath = path.join(fixture.fixtureRepo, "tests", "core-evidence-test.js");
    const assertion = failingTest ? "assert.equal(observed, true);" : "assert.equal(observed, false);";
    const body = evidence === "unrelated"
      ? "const unrelated = 2 + 2; assert.equal(unrelated, 4);"
      : evidence === "live-unasserted-dead-assert"
        ? `core(); if (false) { const observed = core(); ${assertion} }`
        : evidence === "unrelated-live-assert"
          ? `core(); assert.equal(2 + 2, 4); if (false) { const observed = core(); ${assertion} }`
      : evidence === "dead"
        ? `if (false) { const observed = core(); ${assertion} }`
        : `const observed = core(); ${assertion}`;
    writeFileSync(testPath, [
      'import assert from "node:assert/strict";',
      'import { core } from "../lib/core.js";',
      `export async function run() { ${body} }`,
      '',
    ].join("\n"));
    if (expectedOutcome === "xfail") {
      const expectedFailurePath = path.join(fixture.fixtureRepo, "tests", "compat", "expected-failures.json");
      mkdirSync(path.dirname(expectedFailurePath), { recursive: true });
      writeFileSync(expectedFailurePath, canonicalJson({
        entries: [{
          ownerTask: "2A",
          signature: "SYNTHETIC_EXPECTED_CORE_PATCH",
          test: "core-evidence-test.js",
        }],
        schemaVersion: 1,
      }));
    }
  }
  commitAll(fixture.fixtureRepo, "retirement replacement core patch fixture");
  fixture.allowlist.entries = fixture.allowlist.entries.filter((entry) => entry.path !== targetPath);
  fixture.allowlist.entryCount = fixture.allowlist.entries.length;
  fixture.allowlist.manifestSha256 = sha256(canonicalJson(fixture.allowlist.entries));
  const candidate = {
    changeType: "modified",
    contentSha256: blobIdentity(absoluteTarget),
    disposition: "core_patch",
    ownerTasks: ["2A"],
    reason: "Synthetic tested retirement replacement core patch.",
    targetMode: "100644",
    targetPath,
  };
  if (registeredGate) candidate.gate = { registrationId: "fixture-gate" };
  fixture.map.candidateChanges.push(candidate);
  if (registeredGate) {
    const testTargetPath = "tests/core-evidence-test.js";
    fixture.map.candidateChanges.push({
      changeType: "added",
      contentSha256: blobIdentity(path.join(fixture.fixtureRepo, testTargetPath)),
      disposition: "private_dev_only",
      gate: { registrationId: "fixture-gate" },
      ownerTasks: ["2A"],
      reason: "Synthetic behavioral gate for a retirement replacement core patch.",
      targetMode: "100644",
      targetPath: testTargetPath,
    });
    if (expectedOutcome === "xfail") {
      const expectedFailureTargetPath = "tests/compat/expected-failures.json";
      fixture.map.candidateChanges.push({
        changeType: "added",
        contentSha256: blobIdentity(path.join(fixture.fixtureRepo, expectedFailureTargetPath)),
        disposition: "private_dev_only",
        gate: { registrationId: "fixture-gate" },
        ownerTasks: ["2A"],
        reason: "Synthetic exact expected-failure ownership fixture.",
        targetMode: "100644",
        targetPath: expectedFailureTargetPath,
      });
      registerFixtureCoverage(fixture.registry, expectedFailureTargetPath);
    }
    registerFixtureCoverage(fixture.registry, targetPath);
    registerFixtureCoverage(fixture.registry, testTargetPath);
    const registration = fixture.registry.entries[0];
    registration.testPath = testTargetPath;
    registration.expectedOutcome = expectedOutcome;
    registration.expectedSignature = expectedOutcome === "xfail" ? "SYNTHETIC_EXPECTED_CORE_PATCH" : null;
    registration.testSha256 = staleHash
      ? "0".repeat(64)
      : blobIdentity(path.join(fixture.fixtureRepo, testTargetPath));
    if (evidence === "missing") {
      delete registration.relevanceEvidence;
    } else {
      registration.relevanceEvidence = [{
        binding: "core",
        mode: "import",
        resultBinding: "observed",
        symbol: "core",
        targetPath,
      }];
    }
    fixture.registry.manifestSha256 = sha256(canonicalJson(fixture.registry.entries));
  }
  fixture.map.candidateChanges.sort((left, right) => left.targetPath.localeCompare(right.targetPath, "en"));
  fixture.map.retirementContracts[0].replacementPaths = [targetPath];
  fixture.map.retirementContractManifestSha256 = sha256(canonicalJson(fixture.map.retirementContracts));
}

function bindCorePatchToReadTest(fixture, targetPath) {
  const testTargetPath = "tests/core-evidence-test.js";
  const testPath = path.join(fixture.fixtureRepo, testTargetPath);
  writeFileSync(testPath, [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'export async function run() {',
    `  const targetSource = readFileSync("${targetPath}", "utf8");`,
    '  assert.ok(targetSource.length > 0);',
    '}',
    '',
  ].join("\n"));
  commitAll(fixture.fixtureRepo, `read-bound core patch gate ${targetPath}`);
  fixture.map.candidateChanges.push({
    changeType: "added",
    contentSha256: blobIdentity(testPath),
    disposition: "private_dev_only",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic read-bound core patch gate fixture.",
    targetMode: "100644",
    targetPath: testTargetPath,
  });
  fixture.map.candidateChanges.sort((left, right) => left.targetPath.localeCompare(right.targetPath, "en"));
  registerFixtureCoverage(fixture.registry, targetPath);
  registerFixtureCoverage(fixture.registry, testTargetPath);
  const registration = fixture.registry.entries[0];
  registration.testPath = testTargetPath;
  registration.testSha256 = blobIdentity(testPath);
  registration.relevanceEvidence = [
    { binding: "targetSource", mode: "read", targetPath },
  ];
  fixture.registry.manifestSha256 = sha256(canonicalJson(fixture.registry.entries));
}

function configureLiveIoDeadAssertionCorePatch(fixture, mode) {
  const targetPath = "lib/core.js";
  const testTargetPath = `tests/${mode}-evidence-test.js`;
  const absoluteTarget = path.join(fixture.fixtureRepo, targetPath);
  const testPath = path.join(fixture.fixtureRepo, testTargetPath);
  writeFileSync(absoluteTarget, "export const core = () => false;\n");
  const operation = mode === "read"
    ? `const ioResult = readFileSync("${targetPath}", "utf8");`
    : `const ioResult = spawnSync(process.execPath, ["--check", "${targetPath}"]);`;
  const imports = mode === "read"
    ? ['import { readFileSync } from "node:fs";']
    : ['import { spawnSync } from "node:child_process";', 'import process from "node:process";'];
  writeFileSync(testPath, [
    'import assert from "node:assert/strict";',
    ...imports,
    'export async function run() {',
    `  ${operation}`,
    '  if (false) { assert.equal(ioResult.status ?? ioResult.length, 0); }',
    '}',
    '',
  ].join("\n"));
  commitAll(fixture.fixtureRepo, `live ${mode} dead assertion fixture`);
  fixture.allowlist.entries = fixture.allowlist.entries.filter((entry) => entry.path !== targetPath);
  fixture.allowlist.entryCount = fixture.allowlist.entries.length;
  fixture.allowlist.manifestSha256 = sha256(canonicalJson(fixture.allowlist.entries));
  fixture.map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(absoluteTarget),
    disposition: "core_patch",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: `Synthetic live ${mode} dead assertion core patch.`,
    targetMode: "100644",
    targetPath,
  });
  fixture.map.candidateChanges.push({
    changeType: "added",
    contentSha256: blobIdentity(testPath),
    disposition: "private_dev_only",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: `Synthetic ${mode} evidence test.`,
    targetMode: "100644",
    targetPath: testTargetPath,
  });
  fixture.map.candidateChanges.sort((left, right) => left.targetPath.localeCompare(right.targetPath, "en"));
  registerFixtureCoverage(fixture.registry, targetPath);
  registerFixtureCoverage(fixture.registry, testTargetPath);
  const registration = fixture.registry.entries[0];
  registration.testPath = testTargetPath;
  registration.testSha256 = blobIdentity(testPath);
  registration.relevanceEvidence = [{ binding: "ioResult", mode, targetPath }];
  fixture.registry.manifestSha256 = sha256(canonicalJson(fixture.registry.entries));
  fixture.map.retirementContracts[0].replacementPaths = [targetPath];
  fixture.map.retirementContractManifestSha256 = sha256(canonicalJson(fixture.map.retirementContracts));
}

function configureSelfOnlyDeadCorePatch(fixture) {
  const testTargetPath = "tests/registered-test.js";
  const testPath = path.join(fixture.fixtureRepo, testTargetPath);
  writeFileSync(testPath, [
    'import assert from "node:assert/strict";',
    'export async function run() { if (false) { assert.equal(true, true); } }',
    '',
  ].join("\n"));
  commitAll(fixture.fixtureRepo, "self-only dead evidence fixture");
  fixture.map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(testPath),
    disposition: "core_patch",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic self-only dead evidence core patch.",
    targetMode: "100644",
    targetPath: testTargetPath,
  });
  fixture.map.candidateChanges.sort((left, right) => left.targetPath.localeCompare(right.targetPath, "en"));
  registerFixtureCoverage(fixture.registry, testTargetPath);
  const registration = fixture.registry.entries[0];
  registration.testSha256 = blobIdentity(testPath);
  registration.relevanceEvidence = [{ mode: "self", targetPath: testTargetPath }];
  fixture.registry.manifestSha256 = sha256(canonicalJson(fixture.registry.entries));
}

function configureImmutableGateExecutionFixture(fixture) {
  const firstTarget = "lib/0-mutator.js";
  const secondTarget = "lib/upstream.js";
  const firstTest = "tests/immutable-first-test.js";
  const secondTest = "tests/immutable-second-test.js";
  const secondWorktreePath = path.join(fixture.fixtureRepo, secondTest);
  writeFileSync(path.join(fixture.fixtureRepo, firstTarget), "export const mutator = () => false;\n");
  writeFileSync(path.join(fixture.fixtureRepo, secondTarget), "export const readUpstream = () => false;\n");
  writeFileSync(path.join(fixture.fixtureRepo, firstTest), [
    'import assert from "node:assert/strict";',
    'import { writeFileSync } from "node:fs";',
    'import { mutator } from "../lib/0-mutator.js";',
    'export async function run() {',
    '  const observed = mutator();',
    '  assert.equal(observed, false);',
    `  writeFileSync(${JSON.stringify(secondWorktreePath)}, 'throw new Error("mutable worktree test executed");\\n');`,
    '}',
    '',
  ].join("\n"));
  writeFileSync(path.join(fixture.fixtureRepo, secondTest), [
    'import assert from "node:assert/strict";',
    'import { readUpstream } from "../lib/upstream.js";',
    'export async function run() {',
    '  const observed = readUpstream();',
    '  assert.equal(observed, false);',
    '}',
    '',
  ].join("\n"));
  commitAll(fixture.fixtureRepo, "immutable gate execution fixture");

  const rows = [
    [firstTarget, "added", "core_patch", "immutable-first-gate"],
    [secondTarget, "modified", "core_patch", "immutable-second-gate"],
    [firstTest, "added", "private_dev_only", "immutable-first-gate"],
    [secondTest, "added", "private_dev_only", "immutable-second-gate"],
  ];
  for (const [targetPath, changeType, disposition, registrationId] of rows) {
    const existing = fixture.map.candidateChanges.find((row) => row.targetPath === targetPath);
    const row = {
      changeType,
      contentSha256: blobIdentity(path.join(fixture.fixtureRepo, targetPath)),
      disposition,
      gate: { registrationId },
      ownerTasks: ["2A"],
      reason: "Synthetic immutable exact-HEAD execution fixture.",
      targetMode: "100644",
      targetPath,
    };
    if (existing) Object.assign(existing, row);
    else fixture.map.candidateChanges.push(row);
    registerFixtureCoverage(fixture.registry, targetPath);
  }
  fixture.registry.entries.push(
    {
      coveredPaths: [firstTarget, firstTest],
      expectedOutcome: "pass",
      expectedSignature: null,
      id: "immutable-first-gate",
      ownerSourceFirstTaskId: "2A",
      relevanceEvidence: [{
        binding: "mutator",
        mode: "import",
        resultBinding: "observed",
        symbol: "mutator",
        targetPath: firstTarget,
      }],
      runner: "node",
      testPath: firstTest,
      testSha256: blobIdentity(path.join(fixture.fixtureRepo, firstTest)),
    },
    {
      coveredPaths: [secondTarget, secondTest],
      expectedOutcome: "pass",
      expectedSignature: null,
      id: "immutable-second-gate",
      ownerSourceFirstTaskId: "2A",
      relevanceEvidence: [{
        binding: "readUpstream",
        mode: "import",
        resultBinding: "observed",
        symbol: "readUpstream",
        targetPath: secondTarget,
      }],
      runner: "node",
      testPath: secondTest,
      testSha256: blobIdentity(path.join(fixture.fixtureRepo, secondTest)),
    },
  );
  fixture.map.candidateChanges.sort((left, right) => left.targetPath.localeCompare(right.targetPath, "en"));
  fixture.registry.entries.sort((left, right) => left.id.localeCompare(right.id, "en"));
  fixture.registry.entryCount = fixture.registry.entries.length;
  fixture.registry.manifestSha256 = sha256(canonicalJson(fixture.registry.entries));
}

expectPass("exact classified delta", () => {});

expectFailure("compat writer evidence must execute the declared target symbol", "GATE_DYNAMIC_EVIDENCE", (fixture) => {
  configureCompatModuleWriterEvidence(fixture);
});

expectPass("registered tests execute from an immutable exact-HEAD cohort", (fixture) => {
  configureImmutableGateExecutionFixture(fixture);
});

expectPass("retirement replacement may be an explicitly mapped behavioral core patch", (fixture) => {
  configureRetirementReplacementCorePatch(fixture);
});

expectFailure("retirement replacement core patch still requires a registered gate", "MISSING_TEST_GATE", (fixture) => {
  configureRetirementReplacementCorePatch(fixture, { registeredGate: false });
});

expectFailure("out-of-allowlist core patch requires relevance evidence", "GATE_EVIDENCE_MISSING", (fixture) => {
  configureRetirementReplacementCorePatch(fixture, { evidence: "missing" });
});

expectFailure("out-of-allowlist core patch rejects unrelated evidence", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureRetirementReplacementCorePatch(fixture, { evidence: "unrelated" });
});

expectFailure("out-of-allowlist core patch rejects a stale test hash", "GATE_TEST_HASH", (fixture) => {
  configureRetirementReplacementCorePatch(fixture, { staleHash: true });
});

expectFailure("out-of-allowlist core patch rejects a failing test", "GATE_EXECUTION_FAILED", (fixture) => {
  configureRetirementReplacementCorePatch(fixture, { failingTest: true });
});

expectFailure("out-of-allowlist core patch cannot ship behind xfail", "GATE_EXECUTION_FAILED", (fixture) => {
  configureRetirementReplacementCorePatch(fixture, { expectedOutcome: "xfail" });
});

expectFailure("out-of-allowlist core patch requires executed target-symbol evidence", "GATE_DYNAMIC_EVIDENCE", (fixture) => {
  configureRetirementReplacementCorePatch(fixture, { evidence: "dead" });
});

expectFailure("live import call cannot activate a dead asserted call", "GATE_DYNAMIC_EVIDENCE", (fixture) => {
  configureRetirementReplacementCorePatch(fixture, { evidence: "live-unasserted-dead-assert" });
});

expectFailure("unrelated live assertion cannot activate dead target evidence", "GATE_DYNAMIC_EVIDENCE", (fixture) => {
  configureRetirementReplacementCorePatch(fixture, { evidence: "unrelated-live-assert" });
});

expectFailure("live read requires its consuming assertion to execute", "GATE_DYNAMIC_EVIDENCE", (fixture) => {
  configureLiveIoDeadAssertionCorePatch(fixture, "read");
});

expectFailure("live spawn requires its consuming assertion to execute", "GATE_DYNAMIC_EVIDENCE", (fixture) => {
  configureLiveIoDeadAssertionCorePatch(fixture, "spawn");
});

expectFailure("self-only dead evidence cannot qualify a core patch", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureSelfOnlyDeadCorePatch(fixture);
});

expectFailure("shadowed import binding cannot borrow an unrelated real execution", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  readUpstream();',
      '  { const readUpstream = () => false; const observed = readUpstream(); assert.equal(observed, false); }',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("shadowed asserted call cannot borrow an unrelated real execution", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  readUpstream();',
      '  { const readUpstream = () => false; assert.equal(readUpstream(), false); }',
      '}',
      '',
    ].join("\n"),
  });
  delete fixture.registry.entries[0].relevanceEvidence[0].resultBinding;
  fixture.registry.manifestSha256 = sha256(canonicalJson(fixture.registry.entries));
});

expectFailure("parameter shadow cannot borrow an unrelated real execution", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'const localRead = () => false;',
      'readUpstream();',
      'export async function run(readUpstream = localRead) {',
      '  const observed = readUpstream();',
      '  assert.equal(observed, false);',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("destructured shadow cannot borrow an unrelated real execution", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  readUpstream();',
      '  { const { readUpstream } = { readUpstream: () => false };',
      '    const observed = readUpstream(); assert.equal(observed, false); }',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("catch binding shadow cannot borrow an unrelated real execution", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  readUpstream();',
      '  try { throw { readUpstream: () => false }; }',
      '  catch ({ readUpstream }) { const observed = readUpstream(); assert.equal(observed, false); }',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("shadowed result binding cannot attest the imported return value", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  const observed = readUpstream();',
      '  { const observed = false; assert.equal(observed, false); }',
      '}',
      '',
    ].join("\n"),
  });
  const targetPath = path.join(fixture.fixtureRepo, "lib", "upstream.js");
  writeFileSync(targetPath, "export const readUpstream = () => true;\n");
  commitAll(fixture.fixtureRepo, "true target for result-shadow fixture");
  fixture.map.candidateChanges.find((row) => row.targetPath === "lib/upstream.js").contentSha256 = blobIdentity(targetPath);
});

expectFailure("reassigned result binding cannot attest the imported return value", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  let observed = readUpstream();',
      '  observed = false;',
      '  assert.equal(observed, false);',
      '}',
      '',
    ].join("\n"),
  });
  const targetPath = path.join(fixture.fixtureRepo, "lib", "upstream.js");
  writeFileSync(targetPath, "export const readUpstream = () => true;\n");
  commitAll(fixture.fixtureRepo, "true target for result-reassignment fixture");
  fixture.map.candidateChanges.find((row) => row.targetPath === "lib/upstream.js").contentSha256 = blobIdentity(targetPath);
});

expectFailure("requireCallable must use the module loaded for the target", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'const importContractModule = async (relative) => import(`../${relative}`);',
      'const requireCallable = (module, name) => module[name];',
      'export async function run() {',
      '  const targetModule = await importContractModule("lib/upstream.js");',
      '  const wrongModule = { readUpstream: () => false };',
      '  const readUpstream = requireCallable(wrongModule, "readUpstream");',
      '  targetModule.readUpstream();',
      '  const observed = readUpstream();',
      '  assert.equal(observed, false);',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("nested module shadow cannot satisfy requireCallable linkage", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'const importContractModule = async (relative) => import(`../${relative}`);',
      'const requireCallable = (module, name) => module[name];',
      'export async function run() {',
      '  const targetModule = await importContractModule("lib/upstream.js");',
      '  targetModule.readUpstream();',
      '  { const targetModule = { readUpstream: () => false };',
      '    const readUpstream = requireCallable(targetModule, "readUpstream");',
      '    const observed = readUpstream(); assert.equal(observed, false); }',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("string literals cannot fabricate operation and assertion witnesses", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  readUpstream();',
      '  const fake = "const observed = readUpstream(); assert.equal(observed, false);";',
      '  return fake.length;',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("regular expression literals cannot fabricate operation and assertion witnesses", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  readUpstream();',
      '  const fake = /const observed = readUpstream(); assert.equal(observed, false);/;',
      '  return fake.source.length;',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("comments cannot fabricate operation and assertion witnesses", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  readUpstream();',
      '  /* const observed = readUpstream(); assert.equal(observed, false); */',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("child-process target execution cannot satisfy parent evidence", "GATE_DYNAMIC_EVIDENCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { spawnSync } from "node:child_process";',
      'import process from "node:process";',
      'import { importContractModule, requireCallable } from "./contract-test-helpers.js";',
      'export async function run() {',
      '  const targetModule = await importContractModule("lib/upstream.js");',
      '  const readUpstream = requireCallable(targetModule, "readUpstream");',
      '  const target = new URL("../lib/upstream.js", import.meta.url).href;',
      '  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `import { readUpstream } from ${JSON.stringify(target)}; readUpstream();`], { env: process.env });',
      '  assert.equal(child.status, 0);',
      '  const observed = readUpstream();',
      '  assert.equal(observed, false);',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("uninvoked helper cannot provide behavioral evidence", "GATE_DYNAMIC_EVIDENCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'const verifyTarget = () => { const observed = readUpstream(); assert.equal(observed, false); };',
      'export async function run() { readUpstream(); if (false) verifyTarget(); }',
      '',
    ].join("\n"),
  });
});

expectFailure("ambiguous duplicate evidence witnesses fail closed", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  { const observed = readUpstream(); assert.equal(observed, false); }',
      '  { const observed = readUpstream(); assert.equal(observed, false); }',
      '}',
      '',
    ].join("\n"),
  });
});

expectPass("nested async callback evidence preserves exact offsets", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  await Promise.resolve().then(async () => { const observed = readUpstream(); assert.equal(observed, false); });',
      '}',
      '',
    ].join("\n"),
  });
});

expectPass("awaited import result binding is accepted", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  const observed = await readUpstream();',
      '  assert.equal(observed, false);',
      '}',
      '',
    ].join("\n"),
  });
});

expectPass("transitively called helper evidence is accepted", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'const verifyTarget = () => { const observed = readUpstream(); assert.equal(observed, false); };',
      'export async function run() { verifyTarget(); }',
      '',
    ].join("\n"),
  });
});

expectPass("CRLF and non-ASCII prefixes preserve UTF-16 coverage alignment", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      '// π synthetic prefix',
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() { const observed = readUpstream(); assert.equal(observed, false); }',
      '',
    ].join("\r\n"),
  });
});

expectFailure("metadata-only fake passing coverage", "GATE_EVIDENCE_MISSING", (fixture) => {
  configureAdoptedCorePatch(fixture, { evidence: false });
});

expectFailure("declared import evidence without import", "GATE_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture);
});

expectFailure("unrelated import is not target evidence", "GATE_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: 'import "../lib/core.js";\nexport async function run() { return true; }\n',
  });
});

expectFailure("fresh-hash exact import no-op", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: 'import "../lib/upstream.js";\nexport async function run() { return true; }\n',
  });
});

expectFailure("unused exact import binding", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: 'import { readUpstream } from "../lib/upstream.js";\nexport async function run() { return true; }\n',
  });
});

expectFailure("void import use is not behavior", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: 'import { readUpstream } from "../lib/upstream.js";\nexport async function run() { void readUpstream; return true; }\n',
  });
});

expectFailure("assert true is unrelated", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() { assert.equal(true, true); }',
      '',
    ].join("\n"),
  });
});

expectFailure("unrelated assertion does not prove target", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() { const unrelated = 2 + 2; assert.equal(unrelated, 4); }',
      '',
    ].join("\n"),
  });
});

expectFailure("unexecuted target probe is not behavior", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'const probe = () => readUpstream();',
      'export async function run() { assert.equal(true, true); }',
      '',
    ].join("\n"),
  });
});

expectFailure("dead branch target proof is not executed", "GATE_DYNAMIC_EVIDENCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  if (false) { const observed = readUpstream(); assert.equal(observed, false); }',
      '  return true;',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("commented proof is not executed", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  // const observed = readUpstream(); assert.equal(observed, false);',
      '  return true;',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("shadowed declared binding is unrelated", "GATE_BEHAVIORAL_RELEVANCE", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() {',
      '  const readUpstream = () => false;',
      '  const observed = readUpstream();',
      '  assert.equal(observed, false);',
      '}',
      '',
    ].join("\n"),
  });
});

expectFailure("relevant but failing test is executed", "GATE_EXECUTION_FAILED", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() { const observed = readUpstream(); assert.equal(observed, true); }',
      '',
    ].join("\n"),
  });
});

expectFailure("relevant test hash is stale", "GATE_TEST_HASH", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    staleHash: true,
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() { const observed = readUpstream(); assert.equal(observed, false); }',
      '',
    ].join("\n"),
  });
});

expectPass("hash-bound executed relevant adopted core patch", (fixture) => {
  configureAdoptedCorePatch(fixture, {
    testSource: [
      'import assert from "node:assert/strict";',
      'import { readUpstream } from "../lib/upstream.js";',
      'export async function run() { const observed = readUpstream(); assert.equal(observed, false); }',
      '',
    ].join("\n"),
  });
});

expectFailure("adoption contracts are hash-bound", "ADOPTION_CONTRACT_MANIFEST", ({ allowlist }) => {
  allowlist.adoptionContracts[0].id = "changed-without-manifest-refresh";
});

expectFailure("retirement contracts are hash-bound", "RETIREMENT_CONTRACT_MANIFEST", ({ map }) => {
  map.retirementContracts[0].id = "changed-without-manifest-refresh";
});

expectFailure("adopted modules must be upstream allowlisted", "ADOPTION_PATH_NOT_UPSTREAM", ({ allowlist }) => {
  allowlist.adoptionContracts[0].paths = ["lib/not-upstream.js"];
  allowlist.adoptionContractManifestSha256 = sha256(canonicalJson(allowlist.adoptionContracts));
});

expectFailure(
  "retired implementation path cannot reappear",
  "RETIRED_PATH_PRESENT",
  ({ fixtureRepo }) => {
    mkdirSync(path.join(fixtureRepo, "legacy"), { recursive: true });
    writeFileSync(path.join(fixtureRepo, "legacy", "task3-retired.js"), "export default false;\n");
    commitAll(fixtureRepo, "retired path fixture");
  },
);

expectFailure(
  "retired implementation bytes cannot move to a new path",
  "RETIRED_BYTES_PRESENT",
  ({ fixtureRepo, retiredBytes }) => {
    writeFileSync(path.join(fixtureRepo, "retired-copy.js"), retiredBytes);
    commitAll(fixtureRepo, "retired byte copy fixture");
  },
);

expectFailure(
  "retirement replacement must be an adopted upstream path",
  "RETIREMENT_REPLACEMENT_NOT_ADOPTED",
  ({ map }) => {
    map.retirementContracts[0].replacementPaths = ["lib/core.js"];
    map.retirementContractManifestSha256 = sha256(canonicalJson(map.retirementContracts));
  },
);

expectFailure(
  "upstream identity evidence must match the audited base",
  "UPSTREAM_IDENTITY_EVIDENCE_MISMATCH",
  ({ allowlist, map, retirementEvidence }) => {
    const contract = map.retirementContracts[0];
    const sourceBlob = allowlist.entries.find((row) => row.path === "lib/upstream.js").blob;
    contract.enforcement = "upstream_identity";
    contract.evidence = [{
      commit: "1".repeat(40),
      path: "lib/upstream.js",
      sha256: "0".repeat(64),
      sourceBlob,
    }];
    contract.forbiddenPaths = [];
    map.retirementContractManifestSha256 = sha256(canonicalJson(map.retirementContracts));
    retirementEvidence.entries = [{
      behaviorId: contract.id,
      ...contract.evidence[0],
    }];
    retirementEvidence.entryCount = retirementEvidence.entries.length;
    retirementEvidence.manifestSha256 = sha256(canonicalJson(retirementEvidence.entries));
    retirementEvidence.structuralFingerprints = [];
    retirementEvidence.structuralFingerprintCount = 0;
    retirementEvidence.structuralFingerprintManifestSha256 = sha256(canonicalJson([]));
  },
);

expectFailure(
  "retirement evidence commit must be attested",
  "RETIREMENT_EVIDENCE_MISMATCH",
  ({ map }) => {
    map.retirementContracts[0].evidence[0].commit = "6".repeat(40);
    map.retirementContractManifestSha256 = sha256(canonicalJson(map.retirementContracts));
  },
);

expectFailure(
  "retirement evidence path must be attested",
  "RETIREMENT_EVIDENCE_MISMATCH",
  ({ map }) => {
    map.retirementContracts[0].evidence[0].path = "legacy/fabricated-retired.js";
    map.retirementContractManifestSha256 = sha256(canonicalJson(map.retirementContracts));
  },
);

expectFailure(
  "retirement evidence blob must be attested",
  "RETIREMENT_EVIDENCE_MISMATCH",
  ({ map }) => {
    map.retirementContracts[0].evidence[0].sourceBlob = "8".repeat(40);
    map.retirementContractManifestSha256 = sha256(canonicalJson(map.retirementContracts));
  },
);

expectFailure(
  "retirement evidence SHA-256 must be attested",
  "RETIREMENT_EVIDENCE_MISMATCH",
  ({ map }) => {
    map.retirementContracts[0].evidence[0].sha256 = "8".repeat(64);
    map.retirementContractManifestSha256 = sha256(canonicalJson(map.retirementContracts));
  },
);

expectFailure(
  "comment-modified retired source is structurally rejected",
  "RETIRED_STRUCTURAL_FINGERPRINT",
  (fixture) => {
    addClassifiedFixtureFile(
      fixture,
      "lib/comment-modified-retired.js",
      Buffer.concat([Buffer.from("// synthetic comment\n"), fixture.retiredBytes]),
    );
  },
);

expectFailure(
  "wrapper around retired source is structurally rejected",
  "RETIRED_STRUCTURAL_FINGERPRINT",
  (fixture) => {
    addClassifiedFixtureFile(
      fixture,
      "lib/wrapped-retired.js",
      Buffer.concat([
        Buffer.from("export const syntheticWrapperBefore = true;\n"),
        fixture.retiredBytes,
        Buffer.from("export const syntheticWrapperAfter = true;\n"),
      ]),
    );
  },
);

expectFailure(
  "retired logic transplanted to a renamed path is structurally rejected",
  "RETIRED_STRUCTURAL_FINGERPRINT",
  (fixture) => {
    addClassifiedFixtureFile(
      fixture,
      "lib/renamed-transplant.js",
      Buffer.concat([fixture.retiredBytes, Buffer.from("export const syntheticTail = null;\n")]),
    );
  },
);

expectFailure("candidate prose cannot stand in for test evidence", "UNSTRUCTURED_GATE", ({ map }) => {
  delete map.candidateChanges[0].gate;
  map.candidateChanges[0].testGate = "synthetic prose is not evidence";
});

expectFailure("active gate cannot point to an unrelated blob", "GATE_NOT_TEST", ({ registry }) => {
  registry.entries[0].testPath = "config/meta.json";
  registry.manifestSha256 = sha256(canonicalJson(registry.entries));
});

expectFailure("active gate test must be registered", "GATE_UNREGISTERED", ({ map }) => {
  map.candidateChanges[0].gate = { registrationId: "not-registered" };
});

expectFailure("active gate must cover its candidate path", "GATE_IRRELEVANT", ({ registry }) => {
  registry.entries[0].coveredPaths = ["lib/core.js"];
  registry.manifestSha256 = sha256(canonicalJson(registry.entries));
});

expectFailure("xfail registration requires an exact owned signature", "GATE_SIGNATURE_MISSING", ({ registry }) => {
  registry.entries[0].expectedOutcome = "xfail";
  registry.entries[0].expectedSignature = "";
  registry.manifestSha256 = sha256(canonicalJson(registry.entries));
});

expectFailure("xfail registration must match the expected-failure manifest", "GATE_SIGNATURE_MISMATCH", ({ registry }) => {
  registry.entries[0].expectedOutcome = "xfail";
  registry.entries[0].expectedSignature = "SYNTHETIC_EXPECTED_SIGNATURE";
  registry.manifestSha256 = sha256(canonicalJson(registry.entries));
});

expectFailure("removed upstream ownership requires core patch", "UPSTREAM_PATCH_NOT_CORE", ({ allowlist, fixtureRepo, map }) => {
  writeFileSync(path.join(fixtureRepo, "lib", "core.js"), "export const core = false;\n");
  commitAll(fixtureRepo, "non-core upstream patch fixture");
  allowlist.entries = allowlist.entries.filter((entry) => entry.path !== "lib/core.js");
  allowlist.entryCount = allowlist.entries.length;
  allowlist.manifestSha256 = sha256(canonicalJson(allowlist.entries));
  map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(path.join(fixtureRepo, "lib", "core.js")),
    disposition: "operator_only",
    ownerTasks: ["2A"],
    reason: "Synthetic non-core upstream patch fixture.",
    targetMode: "100644",
    targetPath: "lib/core.js",
    gate: { registrationId: "fixture-gate" },
  });
});

expectFailure(
  "canonical alternate policy cannot redefine production authority",
  "NON_AUTHORITATIVE_POLICY",
  ({ allowlist, fixtureRepo, map }) => {
    const head = git(fixtureRepo, ["rev-parse", "HEAD"]);
    const tree = git(fixtureRepo, ["rev-parse", "HEAD^{tree}"]);
    const headRows = git(fixtureRepo, ["ls-tree", "-r", head])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(line);
        assert(match);
        return { blob: match[3], mode: match[1], path: match[4], type: match[2] };
      });
    allowlist.auditedBase = { commit: head, tree };
    allowlist.entries = headRows;
    allowlist.entryCount = headRows.length;
    allowlist.manifestSha256 = sha256(canonicalJson(headRows));
    map.auditedBase = { commit: head, tree };
    map.candidateChanges = [];
  },
  ["--base", "HEAD"],
);

expectFailure("nonexistent active candidate gate", "ACTIVE_GATE_MISSING", ({ registry }) => {
  registry.entries[0].testPath = "tests/not-present-test.js";
  registry.manifestSha256 = sha256(canonicalJson(registry.entries));
});

expectFailure("unowned active candidate gate", "GATE_OWNER_MISMATCH", ({ registry }) => {
  registry.entries[0].ownerSourceFirstTaskId = "9";
  registry.manifestSha256 = sha256(canonicalJson(registry.entries));
});

expectFailure("preserved commit without target", "MISSING_COMMIT_TARGET", ({ map }) => {
  const row = map.deployedCommits[0];
  row.disposition = "compat_module";
  delete row.historicalDisposition;
  row.sourcePaths = ["legacy/source.js"];
  map.deployedSource.commitManifestSha256 = sha256(canonicalJson(map.deployedCommits));
});

expectFailure("retired commit without history", "MISSING_COMMIT_HISTORY", ({ map }) => {
  delete map.deployedCommits[0].historicalDisposition;
  map.deployedSource.commitManifestSha256 = sha256(canonicalJson(map.deployedCommits));
});

expectFailure("operator rules in committed defaults", "OPERATOR_LITERAL", ({ fixtureRepo, map }) => {
  writeFileSync(
    path.join(fixtureRepo, "config", "meta.json"),
    '{"defaults":{"operatorRules":{"aliases":["synthetic-example"]}}}\n',
  );
  commitAll(fixtureRepo, "operator defaults fixture");
  map.candidateChanges[0].contentSha256 = blobIdentity(path.join(fixtureRepo, "config", "meta.json"));
});

expectFailure("unbound synthetic exemption", "INVALID_SCAN_EXEMPTION", ({ map }) => {
  map.candidateChanges[0].scanExemptions = ["synthetic_operator_rules_fixture"];
});

expectFailure("unclassified file", "UNCLASSIFIED_DIFF", ({ fixtureRepo }) => {
  writeFileSync(path.join(fixtureRepo, "unclassified.js"), "export default true;\n");
  commitAll(fixtureRepo, "unclassified delta");
});

expectFailure("upstream-owned edit", "UPSTREAM_OWNED_EDIT", ({ fixtureRepo }) => {
  writeFileSync(path.join(fixtureRepo, "lib", "upstream.js"), "export const upstream = false;\n");
  commitAll(fixtureRepo, "upstream edit");
});

expectFailure("core patch without test", "MISSING_TEST_GATE", ({ allowlist, fixtureRepo, map }) => {
  writeFileSync(path.join(fixtureRepo, "lib", "core.js"), "export const core = false;\n");
  commitAll(fixtureRepo, "untested core patch");
  allowlist.entries = allowlist.entries.filter((entry) => entry.path !== "lib/core.js");
  allowlist.entryCount = allowlist.entries.length;
  allowlist.manifestSha256 = sha256(canonicalJson(allowlist.entries));
  map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(path.join(fixtureRepo, "lib", "core.js")),
    disposition: "core_patch",
    ownerTasks: ["2A"],
    reason: "Synthetic core patch fixture.",
    targetMode: "100644",
    targetPath: "lib/core.js",
  });
});

expectFailure("private literal marker in source", "PRIVATE_LITERAL", ({ allowlist, fixtureRepo, map, registry }) => {
  writeFileSync(
    path.join(fixtureRepo, "lib", "core.js"),
    'export const value = "SOURCE_FIRST_PRIVATE_LITERAL";\n',
  );
  commitAll(fixtureRepo, "private literal fixture");
  allowlist.entries = allowlist.entries.filter((entry) => entry.path !== "lib/core.js");
  allowlist.entryCount = allowlist.entries.length;
  allowlist.manifestSha256 = sha256(canonicalJson(allowlist.entries));
  map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(path.join(fixtureRepo, "lib", "core.js")),
    disposition: "core_patch",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic source scan fixture.",
    targetMode: "100644",
    targetPath: "lib/core.js",
  });
  bindCorePatchToReadTest({ fixtureRepo, map, registry }, "lib/core.js");
});

expectFailure("private literal marker in defaults", "PRIVATE_LITERAL", ({ fixtureRepo, map }) => {
  writeFileSync(path.join(fixtureRepo, "config", "meta.json"), '{"value":"SOURCE_FIRST_PRIVATE_LITERAL"}\n');
  commitAll(fixtureRepo, "private default fixture");
  map.candidateChanges[0].contentSha256 = blobIdentity(path.join(fixtureRepo, "config", "meta.json"));
});

expectFailure("obsolete implementation copied in", "OBSOLETE_SOURCE_COPY", ({ allowlist, fixtureRepo, legacyBytes, map, registry }) => {
  writeFileSync(path.join(fixtureRepo, "lib", "core.js"), legacyBytes);
  commitAll(fixtureRepo, "obsolete source fixture");
  allowlist.entries = allowlist.entries.filter((entry) => entry.path !== "lib/core.js");
  allowlist.entryCount = allowlist.entries.length;
  allowlist.manifestSha256 = sha256(canonicalJson(allowlist.entries));
  map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(path.join(fixtureRepo, "lib", "core.js")),
    disposition: "core_patch",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic obsolete-copy fixture.",
    targetMode: "100644",
    targetPath: "lib/core.js",
  });
  bindCorePatchToReadTest({ fixtureRepo, map, registry }, "lib/core.js");
});

expectFailure("stale map row", "STALE_MAP_ROW", ({ map, registry }) => {
  map.candidateChanges.push({
    changeType: "added",
    contentSha256: "5".repeat(64),
    disposition: "compat_module",
    gate: { registrationId: "fixture-gate" },
    ownerTasks: ["2A"],
    reason: "Synthetic stale row fixture.",
    targetMode: "100644",
    targetPath: "lib/not-present.js",
  });
  registerFixtureCoverage(registry, "lib/not-present.js");
});

expectFailure("stale allowlist row", "STALE_ALLOWLIST_ROW", ({ allowlist }) => {
  allowlist.entries.push({
    blob: "6".repeat(40),
    mode: "100644",
    path: "lib/not-in-base.js",
    type: "blob",
  });
  allowlist.entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  allowlist.entryCount = allowlist.entries.length;
  allowlist.manifestSha256 = sha256(canonicalJson(allowlist.entries));
});

expectFailure("missing deployed source row", "DEPLOYED_FILE_MANIFEST", ({ map }) => {
  map.deployedFiles = [];
});

expectFailure("unknown disposition", "UNKNOWN_DISPOSITION", ({ map }) => {
  map.deployedFiles[0].disposition = "unknown";
});

expectFailure("wildcard source path", "WILDCARD_PATH", ({ map }) => {
  map.deployedFiles[0].sourcePath = "legacy/*.js";
});

expectFailure("unexpected bytes in a classified delta", "UNEXPECTED_DIFF", ({ fixtureRepo }) => {
  writeFileSync(path.join(fixtureRepo, "config", "meta.json"), "{\"fixture\":false}\n");
  commitAll(fixtureRepo, "unexpected classified delta");
});

{
  const fixture = makeFixture();
  try {
    const result = runGuard(fixture, ["--base", "HEAD"]);
    assert.notEqual(result.status, 0, "invalid base: guard unexpectedly passed");
    assert.match(result.stderr, /SOURCE_FIRST_DIVERGENCE INVALID_BASE\b/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = makeFixture();
  try {
    writeFileSync(
      path.join(fixture.policyDir, "source-first-port-map.json"),
      JSON.stringify(fixture.map),
    );
    const result = runGuard(fixture);
    assert.notEqual(result.status, 0, "non-canonical map: guard unexpectedly passed");
    assert.match(result.stderr, /SOURCE_FIRST_DIVERGENCE NON_CANONICAL_JSON\b/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

console.log("source-first-divergence-test: ok");
}

await run();

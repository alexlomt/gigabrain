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
const realAllowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const realRetirementEvidence = JSON.parse(readFileSync(retirementEvidencePath, "utf8"));
assert.equal(realMap.deployedSource.commit, "43cd4b41518b5e35b3872722fcceaac535a1ff64");
assert.equal(realMap.deployedCommits.length, 47);
assert.equal(realMap.deployedFiles.length, 208);
assert.equal(realMap.preTagTools.length, 9);
assert.equal(realMap.candidateChanges.length, 125);
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
assert.equal(realAllowlist.entries.length, 142);
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
  writeFileSync(path.join(fixtureRepo, "lib", "upstream.js"), "export const upstream = true;\n");
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

expectPass("exact classified delta", () => {});

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
  registerFixtureCoverage(registry, "lib/core.js");
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
  registerFixtureCoverage(registry, "lib/core.js");
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

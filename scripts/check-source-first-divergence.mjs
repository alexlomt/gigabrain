#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJavaScript } from "acorn";

import {
  findRetiredStructuralFingerprintMatches,
  STRUCTURAL_FINGERPRINT_ALGORITHM,
} from "./retirement-structural-fingerprint.mjs";

const DISPOSITIONS = new Set([
  "upstream_owned",
  "compat_module",
  "core_patch",
  "operator_only",
  "private_dev_only",
  "retired",
]);
const CHANGE_TYPES = new Set(["added", "modified", "deleted"]);
const FULL_SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MODE = /^\d{6}$/;
const TASK = /^\d+[A-Z]?$/;
const WILDCARD = /[*?\[\]{}]/;
const AUTHORITATIVE_BASE = "ef624f97cc616a9e00b6df653eded455fbd30e01";
const POLICY_INFRASTRUCTURE = new Set([
  "config/migration/retirement-evidence-attestation.json",
  "config/migration/source-first-port-map.json",
  "config/migration/source-first-test-registry.json",
  "config/migration/upstream-source-allowlist.json",
  "scripts/check-source-first-divergence.mjs",
]);
const TEST_RUNNERS = new Set(["node", "python"]);
const EXPECTED_OUTCOMES = new Set(["pass", "xfail"]);
const RETIREMENT_ENFORCEMENTS = new Set(["forbidden_bytes", "upstream_identity"]);
const UPSTREAM_NON_RUNTIME_DISPOSITIONS = new Map([
  [".github/workflows/ci.yml", "private_dev_only"],
  ["tests/memory_api_security_test.py", "private_dev_only"],
  ["tests/run-all.js", "private_dev_only"],
  ["tests/unit-config-test.js", "private_dev_only"],
  ["tests/unit-pii-scanner-test.js", "private_dev_only"],
  ["tests/unit-plugin-runtime-test.js", "private_dev_only"],
  ["tests/unit-public-mirror-test.js", "private_dev_only"],
]);
const RELEVANCE_EVIDENCE_MODES = new Set(["import", "inventory_scan", "read", "self", "spawn", "writer_exercised"]);
const CANONICAL_REGISTRY_OWNERS = new Map([
  ["compat-generated-surface", "10"],
  ["compat-observational-diagnostics", "5"],
  ["compat-full-registry-migration", "14"],
  ["compat-rollback-restore", "14"],
]);

// These values are filled from the reviewed forensic snapshot. They deliberately
// bind counts and manifest hashes rather than source bytes or private literals.
const AUTHORITATIVE = {
  deployedCommit: "43cd4b41518b5e35b3872722fcceaac535a1ff64",
  deployedCommitCount: 47,
  deployedCommitManifestSha256: "1e4e971504a9b6ad74779b2336a6d633b16e7c4813993656919ce61439587dff",
  deployedFileCount: 208,
  deployedFileManifestSha256: "4e960bb350d48634ebf47f09d00036a942fff33933fe3b25786e9513b671bf2f",
  deployedTree: "2ea1117367407f87e5b9702ba65f7346f2c6390f",
  obsoleteSourceManifestSha256: "2f9eca0903c8c134fc731b37ee5b56aca5e77d5387c2c3f9d79844b5d84a94ff",
  preTagToolCount: 9,
  preTagToolManifestSha256: "8d213d472fc662239cf94348a9f427d1a9226d3bc84271cb5c0036061ee479ee",
  retirementEvidenceCount: 13,
  retirementEvidenceManifestSha256: "26f4bdd011ed499fd2b49ecdb0e563ac5053889ea76265f12408528fbe22e619",
  retirementStructuralFingerprintCount: 13,
  retirementStructuralFingerprintManifestSha256: "c672074c8da1111872ea2da78f6e6eafaff15926f3d6bad6f29d85382b852b0b",
};

class GuardError extends Error {
  constructor(code, value = "") {
    super(code);
    this.code = code;
    this.reference = value ? createHash("sha256").update(String(value)).digest("hex").slice(0, 12) : "";
  }
}

function fail(code, value) {
  throw new GuardError(code, value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  if (!isObject(value)) fail("SCHEMA");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("SCHEMA", key);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("SCHEMA", key);
  }
}

function nonEmptyString(value, code = "SCHEMA") {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) fail(code);
}

function validatePath(value) {
  nonEmptyString(value);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    WILDCARD.test(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").includes("..")
  ) {
    fail(WILDCARD.test(value) ? "WILDCARD_PATH" : "INVALID_PATH", value);
  }
}

function validatePathList(value) {
  if (!Array.isArray(value) || value.length === 0) fail("SCHEMA");
  const seen = new Set();
  for (const item of value) {
    validatePath(item);
    if (seen.has(item)) fail("DUPLICATE_ROW", item);
    seen.add(item);
  }
}

function validatePossiblyEmptyPathList(value) {
  if (!Array.isArray(value)) fail("SCHEMA");
  const seen = new Set();
  for (const item of value) {
    validatePath(item);
    if (seen.has(item)) fail("DUPLICATE_ROW", item);
    seen.add(item);
  }
  ensureSorted(value, (item) => item);
}

function validateDispositionRow(row, { requireTestGate = true } = {}) {
  if (!DISPOSITIONS.has(row.disposition)) fail("UNKNOWN_DISPOSITION", row.disposition);
  if (!Array.isArray(row.ownerTasks) || row.ownerTasks.length === 0) fail("MISSING_OWNER");
  const owners = new Set();
  for (const owner of row.ownerTasks) {
    if (typeof owner !== "string" || !TASK.test(owner) || owners.has(owner)) fail("MISSING_OWNER");
    owners.add(owner);
  }
  nonEmptyString(row.reason);
  if (requireTestGate) nonEmptyString(row.testGate, "MISSING_TEST_GATE");
}

function validateHistoricalTarget(row, { rowKind = "row" } = {}) {
  const hasHistory = typeof row.historicalDisposition === "string" && row.historicalDisposition.length > 0;
  const hasTarget = typeof row.targetPath === "string" && row.targetPath.length > 0;
  const hasTargets = Array.isArray(row.targetPaths) && row.targetPaths.length > 0;
  const hasSources = Array.isArray(row.sourcePaths) && row.sourcePaths.length > 0;
  if (row.disposition === "retired") {
    if (!hasHistory) {
      fail(rowKind === "commit" ? "MISSING_COMMIT_HISTORY" : "MISSING_PATH_DISPOSITION");
    }
  }
  if (rowKind === "commit" && row.disposition !== "retired" && !hasTarget && !hasTargets) {
    fail("MISSING_COMMIT_TARGET");
  }
  if (!hasHistory && !hasTarget && !hasTargets && !hasSources) fail("MISSING_PATH_DISPOSITION");
  if (hasHistory) nonEmptyString(row.historicalDisposition);
  if (hasTarget) validatePath(row.targetPath);
  if (hasTargets) validatePathList(row.targetPaths);
  if (hasSources) validatePathList(row.sourcePaths);
}

function validateCandidateGate(row) {
  if (Object.hasOwn(row, "testGate")) fail("UNSTRUCTURED_GATE");
  if (!Object.hasOwn(row, "gate")) fail("MISSING_TEST_GATE");
  exactKeys(row.gate, ["registrationId"]);
  nonEmptyString(row.gate.registrationId, "MISSING_TEST_GATE");
}

function validateAuditedBase(value) {
  exactKeys(value, ["commit", "tree"]);
  if (!FULL_SHA1.test(value.commit) || !FULL_SHA1.test(value.tree)) fail("SCHEMA");
}

function readCanonicalJson(filePath) {
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch {
    fail("MISSING_POLICY_FILE", filePath);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("INVALID_JSON", filePath);
  }
  if (!Buffer.from(canonicalJson(value)).equals(bytes)) fail("NON_CANONICAL_JSON", filePath);
  return value;
}

function validateMap(map) {
  exactKeys(map, [
    "auditedBase",
    "candidateChanges",
    "deployedCommits",
    "deployedFiles",
    "deployedSource",
    "obsoleteSourceFingerprints",
    "obsoleteSourceManifestSha256",
    "preTagToolCount",
    "preTagToolManifestSha256",
    "preTagTools",
    "retirementContractCount",
    "retirementContractManifestSha256",
    "retirementContracts",
    "retirementEvidenceAttestation",
    "schemaVersion",
    "testRegistry",
    "upstreamAllowlist",
  ]);
  if (map.schemaVersion !== 1) fail("SCHEMA_VERSION");
  validateAuditedBase(map.auditedBase);
  nonEmptyString(map.upstreamAllowlist);
  validatePath(map.upstreamAllowlist);
  nonEmptyString(map.testRegistry);
  validatePath(map.testRegistry);
  nonEmptyString(map.retirementEvidenceAttestation);
  validatePath(map.retirementEvidenceAttestation);

  exactKeys(map.deployedSource, [
    "commit",
    "commitCount",
    "commitManifestSha256",
    "fileCount",
    "fileManifestSha256",
    "tree",
  ]);
  if (!FULL_SHA1.test(map.deployedSource.commit) || !FULL_SHA1.test(map.deployedSource.tree)) fail("SCHEMA");
  if (!Number.isSafeInteger(map.deployedSource.fileCount) || map.deployedSource.fileCount < 0) fail("SCHEMA");
  if (!Number.isSafeInteger(map.deployedSource.commitCount) || map.deployedSource.commitCount < 0) fail("SCHEMA");
  if (!SHA256.test(map.deployedSource.fileManifestSha256)) fail("SCHEMA");
  if (!SHA256.test(map.deployedSource.commitManifestSha256)) fail("SCHEMA");

  if (!Array.isArray(map.deployedFiles)) fail("SCHEMA");
  const deployedPaths = new Set();
  for (const row of map.deployedFiles) {
    exactKeys(
      row,
      ["disposition", "ownerTasks", "reason", "sourceBlob", "sourceMode", "sourcePath", "testGate"],
      ["historicalDisposition", "targetPath"],
    );
    validateDispositionRow(row);
    validatePath(row.sourcePath);
    if (deployedPaths.has(row.sourcePath)) fail("DUPLICATE_ROW", row.sourcePath);
    deployedPaths.add(row.sourcePath);
    if (!FULL_SHA1.test(row.sourceBlob) || !MODE.test(row.sourceMode)) fail("SCHEMA");
    validateHistoricalTarget(row);
  }
  ensureSorted(map.deployedFiles, (row) => row.sourcePath);

  if (!Array.isArray(map.deployedCommits)) fail("SCHEMA");
  const deployedCommits = new Set();
  for (let index = 0; index < map.deployedCommits.length; index += 1) {
    const row = map.deployedCommits[index];
    exactKeys(
      row,
      ["commit", "contract", "disposition", "ownerTasks", "reason", "sequence", "testGate"],
      ["criticality", "historicalDisposition", "sourcePaths", "targetPaths"],
    );
    validateDispositionRow(row);
    if (!FULL_SHA1.test(row.commit) || deployedCommits.has(row.commit)) fail("DUPLICATE_ROW", row.commit);
    deployedCommits.add(row.commit);
    if (row.sequence !== index + 1) fail("COMMIT_SEQUENCE");
    nonEmptyString(row.contract);
    if (Object.hasOwn(row, "criticality")) nonEmptyString(row.criticality);
    validateHistoricalTarget(row, { rowKind: "commit" });
  }

  if (!Array.isArray(map.preTagTools)) fail("SCHEMA");
  const toolIds = new Set();
  for (const row of map.preTagTools) {
    exactKeys(
      row,
      ["disposition", "id", "ownerTasks", "reason", "testGate"],
      ["historicalDisposition", "sourcePaths", "targetPaths"],
    );
    validateDispositionRow(row);
    nonEmptyString(row.id);
    if (toolIds.has(row.id)) fail("DUPLICATE_ROW", row.id);
    toolIds.add(row.id);
    validateHistoricalTarget(row);
  }
  ensureSorted(map.preTagTools, (row) => row.id);

  if (!Array.isArray(map.obsoleteSourceFingerprints)) fail("SCHEMA");
  const obsoleteKeys = new Set();
  for (const row of map.obsoleteSourceFingerprints) {
    exactKeys(row, [
      "disposition",
      "historicalDisposition",
      "ownerTasks",
      "reason",
      "sha256",
      "sourcePath",
      "testGate",
    ]);
    validateDispositionRow(row);
    validateHistoricalTarget(row);
    validatePath(row.sourcePath);
    if (!SHA256.test(row.sha256)) fail("SCHEMA");
    const key = `${row.sourcePath}\0${row.sha256}`;
    if (obsoleteKeys.has(key)) fail("DUPLICATE_ROW", key);
    obsoleteKeys.add(key);
  }
  ensureSorted(map.obsoleteSourceFingerprints, (row) => `${row.sourcePath}\0${row.sha256}`);
  if (!SHA256.test(map.obsoleteSourceManifestSha256)) fail("SCHEMA");
  if (!Number.isSafeInteger(map.preTagToolCount) || map.preTagToolCount < 0) fail("SCHEMA");
  if (!SHA256.test(map.preTagToolManifestSha256)) fail("SCHEMA");

  if (!Array.isArray(map.retirementContracts)) fail("SCHEMA");
  if (!Number.isSafeInteger(map.retirementContractCount) || map.retirementContractCount < 0) fail("SCHEMA");
  if (!SHA256.test(map.retirementContractManifestSha256)) fail("SCHEMA");
  const retirementIds = new Set();
  for (const row of map.retirementContracts) {
    exactKeys(row, ["enforcement", "evidence", "forbiddenPaths", "id", "replacementPaths"]);
    nonEmptyString(row.id);
    if (retirementIds.has(row.id)) fail("DUPLICATE_ROW", row.id);
    retirementIds.add(row.id);
    if (!RETIREMENT_ENFORCEMENTS.has(row.enforcement)) fail("SCHEMA");
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) fail("SCHEMA");
    const evidenceKeys = new Set();
    for (const evidence of row.evidence) {
      exactKeys(evidence, ["commit", "path", "sha256", "sourceBlob"]);
      if (
        !FULL_SHA1.test(evidence.commit)
        || !FULL_SHA1.test(evidence.sourceBlob)
        || !SHA256.test(evidence.sha256)
      ) fail("SCHEMA");
      validatePath(evidence.path);
      const evidenceKey = `${evidence.commit}\0${evidence.path}`;
      if (evidenceKeys.has(evidenceKey)) fail("DUPLICATE_ROW", evidenceKey);
      evidenceKeys.add(evidenceKey);
    }
    ensureSorted(row.evidence, (evidence) => `${evidence.commit}\0${evidence.path}`);
    validatePossiblyEmptyPathList(row.forbiddenPaths);
    validatePathList(row.replacementPaths);
    ensureSorted(row.replacementPaths, (item) => item);
  }
  ensureSorted(map.retirementContracts, (row) => row.id);
  checkManifest(
    map.retirementContracts,
    map.retirementContractCount,
    map.retirementContractManifestSha256,
    "RETIREMENT_CONTRACT_MANIFEST",
  );

  if (!Array.isArray(map.candidateChanges)) fail("SCHEMA");
  const candidatePaths = new Set();
  for (const row of map.candidateChanges) {
    if (Object.hasOwn(row, "scanExemptions")) fail("INVALID_SCAN_EXEMPTION");
    exactKeys(row, [
      "changeType",
      "contentSha256",
      "disposition",
      "ownerTasks",
      "reason",
      "targetMode",
      "targetPath",
    ], ["gate", "testGate"]);
    validateDispositionRow(row, { requireTestGate: false });
    validateCandidateGate(row);
    validatePath(row.targetPath);
    if (candidatePaths.has(row.targetPath)) fail("DUPLICATE_ROW", row.targetPath);
    candidatePaths.add(row.targetPath);
    if (!CHANGE_TYPES.has(row.changeType) || !MODE.test(row.targetMode)) fail("SCHEMA");
    if (row.contentSha256 !== "canonical-self" && !SHA256.test(row.contentSha256)) fail("SCHEMA");
  }
  ensureSorted(map.candidateChanges, (row) => row.targetPath);

  checkManifest(
    map.deployedFiles,
    map.deployedSource.fileCount,
    map.deployedSource.fileManifestSha256,
    "DEPLOYED_FILE_MANIFEST",
  );
  checkManifest(
    map.deployedCommits,
    map.deployedSource.commitCount,
    map.deployedSource.commitManifestSha256,
    "DEPLOYED_COMMIT_MANIFEST",
  );
  checkManifest(map.preTagTools, map.preTagToolCount, map.preTagToolManifestSha256, "PRE_TAG_TOOL_MANIFEST");
  checkManifest(
    map.obsoleteSourceFingerprints,
    map.obsoleteSourceFingerprints.length,
    map.obsoleteSourceManifestSha256,
    "OBSOLETE_SOURCE_MANIFEST",
  );
}

function validateAllowlist(allowlist) {
  exactKeys(allowlist, [
    "adoptionContractCount",
    "adoptionContractManifestSha256",
    "adoptionContracts",
    "auditedBase",
    "entries",
    "entryCount",
    "manifestSha256",
    "schemaVersion",
  ]);
  if (allowlist.schemaVersion !== 1) fail("SCHEMA_VERSION");
  validateAuditedBase(allowlist.auditedBase);
  if (!Number.isSafeInteger(allowlist.entryCount) || allowlist.entryCount < 0) fail("SCHEMA");
  if (!SHA256.test(allowlist.manifestSha256) || !Array.isArray(allowlist.entries)) fail("SCHEMA");
  const seen = new Set();
  for (const row of allowlist.entries) {
    exactKeys(row, ["blob", "mode", "path", "type"]);
    validatePath(row.path);
    if (!FULL_SHA1.test(row.blob) || !MODE.test(row.mode) || row.type !== "blob") fail("SCHEMA");
    if (seen.has(row.path)) fail("DUPLICATE_ROW", row.path);
    seen.add(row.path);
  }
  ensureSorted(allowlist.entries, (row) => row.path);
  checkManifest(allowlist.entries, allowlist.entryCount, allowlist.manifestSha256, "ALLOWLIST_MANIFEST");
  if (!Array.isArray(allowlist.adoptionContracts)) fail("SCHEMA");
  if (!Number.isSafeInteger(allowlist.adoptionContractCount) || allowlist.adoptionContractCount < 0) fail("SCHEMA");
  if (!SHA256.test(allowlist.adoptionContractManifestSha256)) fail("SCHEMA");
  const adoptionIds = new Set();
  for (const row of allowlist.adoptionContracts) {
    exactKeys(row, ["id", "paths"]);
    nonEmptyString(row.id);
    if (adoptionIds.has(row.id)) fail("DUPLICATE_ROW", row.id);
    adoptionIds.add(row.id);
    validatePathList(row.paths);
    ensureSorted(row.paths, (item) => item);
  }
  ensureSorted(allowlist.adoptionContracts, (row) => row.id);
  checkManifest(
    allowlist.adoptionContracts,
    allowlist.adoptionContractCount,
    allowlist.adoptionContractManifestSha256,
    "ADOPTION_CONTRACT_MANIFEST",
  );
}

function validateRetirementEvidenceAttestation(attestation, map) {
  exactKeys(attestation, [
    "attestationKind",
    "auditedDeployedSource",
    "entries",
    "entryCount",
    "manifestSha256",
    "schemaVersion",
    "structuralFingerprintCount",
    "structuralFingerprintManifestSha256",
    "structuralFingerprints",
  ]);
  if (attestation.schemaVersion !== 1) fail("SCHEMA_VERSION");
  if (attestation.attestationKind !== "read-only-deployed-source-hashes-v1") fail("SCHEMA");
  exactKeys(attestation.auditedDeployedSource, ["commit", "tree"]);
  if (
    attestation.auditedDeployedSource.commit !== map.deployedSource.commit
    || attestation.auditedDeployedSource.tree !== map.deployedSource.tree
  ) {
    fail("RETIREMENT_EVIDENCE_MISMATCH");
  }
  if (!Array.isArray(attestation.entries) || !Number.isSafeInteger(attestation.entryCount)) fail("SCHEMA");
  if (!SHA256.test(attestation.manifestSha256)) fail("SCHEMA");
  const evidenceKeys = new Set();
  const deployedFiles = new Map(map.deployedFiles.map((row) => [row.sourcePath, row]));
  const deployedCommits = new Map(map.deployedCommits.map((row) => [row.commit, row]));
  for (const row of attestation.entries) {
    exactKeys(row, ["behaviorId", "commit", "path", "sha256", "sourceBlob"]);
    nonEmptyString(row.behaviorId);
    if (!FULL_SHA1.test(row.commit) || !FULL_SHA1.test(row.sourceBlob) || !SHA256.test(row.sha256)) {
      fail("SCHEMA");
    }
    validatePath(row.path);
    const key = `${row.behaviorId}\0${row.commit}\0${row.path}`;
    if (evidenceKeys.has(key)) fail("DUPLICATE_ROW", key);
    evidenceKeys.add(key);
    if (row.commit === map.deployedSource.commit) {
      const deployed = deployedFiles.get(row.path);
      if (!deployed || deployed.sourceBlob !== row.sourceBlob) {
        fail("RETIREMENT_EVIDENCE_MISMATCH", row.path);
      }
    } else {
      const commit = deployedCommits.get(row.commit);
      if (!commit || !commit.sourcePaths?.includes(row.path)) {
        fail("RETIREMENT_EVIDENCE_MISMATCH", row.path);
      }
    }
  }
  ensureSorted(attestation.entries, (row) => `${row.behaviorId}\0${row.commit}\0${row.path}`);
  checkManifest(
    attestation.entries,
    attestation.entryCount,
    attestation.manifestSha256,
    "RETIREMENT_EVIDENCE_MANIFEST",
  );

  if (
    !Array.isArray(attestation.structuralFingerprints)
    || !Number.isSafeInteger(attestation.structuralFingerprintCount)
    || !SHA256.test(attestation.structuralFingerprintManifestSha256)
  ) fail("SCHEMA");
  const fingerprintKeys = new Set();
  const fingerprintBehaviors = new Set();
  for (const row of attestation.structuralFingerprints) {
    exactKeys(row, [
      "algorithm",
      "behaviorId",
      "commit",
      "path",
      "sha256",
      "sourceBlob",
      "sourceTokenOffset",
      "tokenCount",
    ]);
    if (
      row.algorithm !== STRUCTURAL_FINGERPRINT_ALGORITHM
      || !FULL_SHA1.test(row.commit)
      || !FULL_SHA1.test(row.sourceBlob)
      || !SHA256.test(row.sha256)
      || !Number.isSafeInteger(row.sourceTokenOffset)
      || row.sourceTokenOffset < 0
      || !Number.isSafeInteger(row.tokenCount)
      || row.tokenCount < 32
    ) fail("SCHEMA");
    nonEmptyString(row.behaviorId);
    validatePath(row.path);
    const evidenceKey = `${row.behaviorId}\0${row.commit}\0${row.path}`;
    const evidence = attestation.entries.find((entry) => (
      `${entry.behaviorId}\0${entry.commit}\0${entry.path}` === evidenceKey
    ));
    if (!evidence || evidence.sourceBlob !== row.sourceBlob) {
      fail("RETIREMENT_EVIDENCE_MISMATCH", row.path);
    }
    const key = `${evidenceKey}\0${String(row.sourceTokenOffset).padStart(12, "0")}`;
    if (fingerprintKeys.has(key)) fail("DUPLICATE_ROW", key);
    fingerprintKeys.add(key);
    fingerprintBehaviors.add(row.behaviorId);
  }
  ensureSorted(
    attestation.structuralFingerprints,
    (row) => `${row.behaviorId}\0${row.commit}\0${row.path}\0${String(row.sourceTokenOffset).padStart(12, "0")}`,
  );
  checkManifest(
    attestation.structuralFingerprints,
    attestation.structuralFingerprintCount,
    attestation.structuralFingerprintManifestSha256,
    "RETIREMENT_STRUCTURAL_MANIFEST",
  );
  for (const contract of map.retirementContracts) {
    if (contract.enforcement === "forbidden_bytes" && !fingerprintBehaviors.has(contract.id)) {
      fail("RETIREMENT_STRUCTURAL_COVERAGE", contract.id);
    }
  }
  if (map.auditedBase.commit === AUTHORITATIVE_BASE) {
    const checks = [
      [attestation.entryCount, AUTHORITATIVE.retirementEvidenceCount],
      [attestation.manifestSha256, AUTHORITATIVE.retirementEvidenceManifestSha256],
      [attestation.structuralFingerprintCount, AUTHORITATIVE.retirementStructuralFingerprintCount],
      [
        attestation.structuralFingerprintManifestSha256,
        AUTHORITATIVE.retirementStructuralFingerprintManifestSha256,
      ],
    ];
    for (const [actual, expected] of checks) {
      if (actual !== expected) fail("AUTHORITATIVE_SNAPSHOT");
    }
  }
}

function validateAdoptionAndRetirement({
  allowlist,
  attestation,
  base,
  head,
  headByPath,
  map,
  verifiedCorePatchPaths,
}) {
  const upstreamPaths = new Set(allowlist.entries.map((row) => row.path));
  const adoptedPaths = new Set(allowlist.adoptionContracts.flatMap((row) => row.paths));
  for (const adoptedPath of adoptedPaths) {
    if (!upstreamPaths.has(adoptedPath) && !verifiedCorePatchPaths.has(adoptedPath)) {
      fail("ADOPTION_PATH_NOT_UPSTREAM", adoptedPath);
    }
  }
  const acceptedReplacementPaths = new Set([...adoptedPaths, ...verifiedCorePatchPaths]);
  const forbiddenHashes = new Set();
  const attestedByKey = new Map(attestation.entries.map((row) => [
    `${row.behaviorId}\0${row.commit}\0${row.path}`,
    row,
  ]));
  const usedEvidence = new Set();
  for (const contract of map.retirementContracts) {
    for (const replacementPath of contract.replacementPaths) {
      if (!acceptedReplacementPaths.has(replacementPath)) {
        fail("RETIREMENT_REPLACEMENT_NOT_ADOPTED", replacementPath);
      }
    }
    for (const forbiddenPath of contract.forbiddenPaths) {
      if (headByPath.has(forbiddenPath)) fail("RETIRED_PATH_PRESENT", forbiddenPath);
    }
    for (const evidence of contract.evidence) {
      const evidenceKey = `${contract.id}\0${evidence.commit}\0${evidence.path}`;
      const attested = attestedByKey.get(evidenceKey);
      if (
        !attested
        || attested.sourceBlob !== evidence.sourceBlob
        || attested.sha256 !== evidence.sha256
      ) {
        fail("RETIREMENT_EVIDENCE_MISMATCH", evidence.path);
      }
      usedEvidence.add(evidenceKey);
      if (contract.enforcement === "forbidden_bytes") {
        forbiddenHashes.add(evidence.sha256);
      } else if (
        !adoptedPaths.has(evidence.path)
        || sha256(blobAt(base, evidence.path)) !== attested.sha256
      ) {
        fail("UPSTREAM_IDENTITY_EVIDENCE_MISMATCH", evidence.path);
      }
    }
  }
  if (usedEvidence.size !== attestedByKey.size) fail("RETIREMENT_EVIDENCE_MISMATCH");
  for (const entry of headByPath.values()) {
    if (entry.type === "blob" && forbiddenHashes.has(sha256(blobAt(head, entry.path)))) {
      fail("RETIRED_BYTES_PRESENT", entry.path);
    }
  }
  const structuralMatches = findRetiredStructuralFingerprintMatches(
    [...headByPath.values()]
      .filter((entry) => entry.type === "blob")
      .map((entry) => ({ bytes: blobAt(head, entry.path), path: entry.path })),
    attestation.structuralFingerprints,
  );
  if (structuralMatches.length > 0) {
    fail("RETIRED_STRUCTURAL_FINGERPRINT", structuralMatches[0].path);
  }
}

function validateTestRegistry(registry) {
  exactKeys(registry, ["entries", "entryCount", "manifestSha256", "schemaVersion"]);
  if (registry.schemaVersion !== 1) fail("SCHEMA_VERSION");
  if (!Array.isArray(registry.entries) || !Number.isSafeInteger(registry.entryCount)) fail("SCHEMA");
  if (!SHA256.test(registry.manifestSha256)) fail("SCHEMA");
  const ids = new Set();
  for (const row of registry.entries) {
    exactKeys(row, [
      "coveredPaths",
      "expectedOutcome",
      "expectedSignature",
      "id",
      "ownerSourceFirstTaskId",
      "runner",
      "testPath",
    ], ["relevanceEvidence", "testSha256"]);
    nonEmptyString(row.id);
    if (ids.has(row.id)) fail("DUPLICATE_ROW", row.id);
    ids.add(row.id);
    const canonicalOwner = CANONICAL_REGISTRY_OWNERS.get(row.id);
    if (canonicalOwner && row.ownerSourceFirstTaskId !== canonicalOwner) {
      fail("STALE_OWNER", row.testPath);
    }
    if (typeof row.ownerSourceFirstTaskId !== "string" || !TASK.test(row.ownerSourceFirstTaskId)) {
      fail("MISSING_OWNER");
    }
    if (!TEST_RUNNERS.has(row.runner) || !EXPECTED_OUTCOMES.has(row.expectedOutcome)) fail("SCHEMA");
    validatePath(row.testPath);
    if (
      (row.runner === "node" && !/^tests\/.+-test\.js$/.test(row.testPath))
      || (row.runner === "python" && !/^tests\/.+_test\.py$/.test(row.testPath))
    ) {
      fail("GATE_NOT_TEST", row.testPath);
    }
    validatePathList(row.coveredPaths);
    ensureSorted(row.coveredPaths, (value) => value);
    if (Object.hasOwn(row, "testSha256") && !SHA256.test(String(row.testSha256 || ""))) {
      fail("SCHEMA");
    }
    if (Object.hasOwn(row, "relevanceEvidence")) {
      if (!Array.isArray(row.relevanceEvidence) || row.relevanceEvidence.length === 0) fail("SCHEMA");
      const evidencePaths = new Set();
      for (const evidence of row.relevanceEvidence) {
        exactKeys(evidence, ["mode", "targetPath"], ["binding", "resultBinding", "symbol"]);
        if (!RELEVANCE_EVIDENCE_MODES.has(evidence.mode)) fail("SCHEMA");
        validatePath(evidence.targetPath);
        for (const key of ["binding", "resultBinding", "symbol"]) {
          if (Object.hasOwn(evidence, key)) nonEmptyString(evidence[key]);
        }
        if (["import", "writer_exercised"].includes(evidence.mode) && (!evidence.binding || !evidence.symbol)) fail("SCHEMA");
        if (["read", "spawn"].includes(evidence.mode) && !evidence.binding) fail("SCHEMA");
        if (evidence.mode === "self" && (evidence.binding || evidence.resultBinding || evidence.symbol)) {
          fail("SCHEMA");
        }
        if (evidencePaths.has(evidence.targetPath)) fail("DUPLICATE_ROW", evidence.targetPath);
        evidencePaths.add(evidence.targetPath);
      }
      ensureSorted(row.relevanceEvidence, (evidence) => evidence.targetPath);
    }
    if (row.expectedOutcome === "xfail") {
      nonEmptyString(row.expectedSignature, "GATE_SIGNATURE_MISSING");
    } else if (row.expectedSignature !== null) {
      fail("SCHEMA");
    }
  }
  ensureSorted(registry.entries, (row) => row.id);
  checkManifest(registry.entries, registry.entryCount, registry.manifestSha256, "TEST_REGISTRY_MANIFEST");
}

const AST_FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const isAstNode = (value) => Boolean(value && typeof value === "object" && typeof value.type === "string");

const forEachAstChild = (node, callback) => {
  for (const [key, value] of Object.entries(node || {})) {
    if (["end", "loc", "range", "start", "type"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (isAstNode(child)) callback(child, key);
    } else if (isAstNode(value)) callback(value, key);
  }
};

const walkAst = (node, callback, parent = null, parentKey = "") => {
  if (!isAstNode(node)) return;
  if (callback(node, parent, parentKey) === false) return;
  forEachAstChild(node, (child, key) => walkAst(child, callback, node, key));
};

const patternIdentifiers = (pattern, out = []) => {
  if (!isAstNode(pattern)) return out;
  if (pattern.type === "Identifier") out.push(pattern);
  else if (pattern.type === "AssignmentPattern") patternIdentifiers(pattern.left, out);
  else if (pattern.type === "RestElement") patternIdentifiers(pattern.argument, out);
  else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements || []) patternIdentifiers(element, out);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties || []) {
      patternIdentifiers(property.type === "RestElement" ? property.argument : property.value, out);
    }
  }
  return out;
};

const buildEvidenceModel = (source) => {
  let ast;
  try {
    ast = parseJavaScript(source, {
      allowHashBang: true,
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch {
    return null;
  }
  const scopes = [];
  const nodeScopes = new WeakMap();
  const declarationIdentifiers = new WeakSet();
  const bindingByDeclaration = new WeakMap();
  const allBindings = [];
  const createScope = (parent, type, node) => {
    const scope = { bindings: new Map(), node, parent, type };
    scopes.push(scope);
    return scope;
  };
  const programScope = createScope(null, "program", ast);
  const nearestVarScope = (scope) => {
    let current = scope;
    while (current && !["function", "program"].includes(current.type)) current = current.parent;
    return current || programScope;
  };
  const declarePattern = (pattern, scope, details) => {
    for (const identifier of patternIdentifiers(pattern)) {
      const binding = { ...details, declaration: identifier, name: identifier.name, scope };
      scope.bindings.set(identifier.name, binding);
      declarationIdentifiers.add(identifier);
      bindingByDeclaration.set(identifier, binding);
      nodeScopes.set(identifier, scope);
      allBindings.push(binding);
    }
  };
  const visitPatternExpressions = (pattern, scope, visit) => {
    if (!isAstNode(pattern)) return;
    if (pattern.type === "AssignmentPattern") {
      visit(pattern.right, scope);
      visitPatternExpressions(pattern.left, scope, visit);
    } else if (pattern.type === "RestElement") visitPatternExpressions(pattern.argument, scope, visit);
    else if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements || []) visitPatternExpressions(element, scope, visit);
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties || []) {
        if (property.computed) visit(property.key, scope);
        visitPatternExpressions(property.type === "RestElement" ? property.argument : property.value, scope, visit);
      }
    }
  };
  const visit = (node, scope) => {
    if (!isAstNode(node)) return;
    nodeScopes.set(node, scope);
    if (node.type === "Program") {
      for (const child of node.body || []) visit(child, scope);
      return;
    }
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers || []) {
        const imported = specifier.type === "ImportSpecifier"
          ? String(specifier.imported?.name || specifier.imported?.value || "")
          : specifier.type === "ImportDefaultSpecifier" ? "default" : "*";
        declarePattern(specifier.local, scope, {
          imported,
          kind: "import",
          source: String(node.source?.value || ""),
          specifier,
        });
      }
      return;
    }
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
      if (node.declaration) visit(node.declaration, scope);
      return;
    }
    if (AST_FUNCTION_TYPES.has(node.type)) {
      let outerBinding = null;
      if (node.type === "FunctionDeclaration" && node.id) {
        declarePattern(node.id, scope, { functionNode: node, kind: "function", node });
        outerBinding = bindingByDeclaration.get(node.id);
      }
      const functionScope = createScope(scope, "function", node);
      nodeScopes.set(node, functionScope);
      if (node.type === "FunctionExpression" && node.id) {
        declarePattern(node.id, functionScope, { functionNode: node, kind: "function", node });
      }
      for (const parameter of node.params || []) {
        declarePattern(parameter, functionScope, { functionNode: null, kind: "parameter", node: parameter });
        visitPatternExpressions(parameter, functionScope, visit);
      }
      visit(node.body, functionScope);
      if (outerBinding) outerBinding.functionNode = node;
      return;
    }
    if (node.type === "BlockStatement") {
      const blockScope = createScope(scope, "block", node);
      nodeScopes.set(node, blockScope);
      for (const child of node.body || []) visit(child, blockScope);
      return;
    }
    if (["ForInStatement", "ForOfStatement", "ForStatement", "SwitchStatement"].includes(node.type)) {
      const blockScope = createScope(scope, "block", node);
      nodeScopes.set(node, blockScope);
      forEachAstChild(node, (child) => visit(child, blockScope));
      return;
    }
    if (node.type === "CatchClause") {
      const catchScope = createScope(scope, "catch", node);
      nodeScopes.set(node, catchScope);
      if (node.param) declarePattern(node.param, catchScope, { functionNode: null, kind: "catch", node });
      visit(node.body, catchScope);
      return;
    }
    if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations || []) {
        const targetScope = node.kind === "var" ? nearestVarScope(scope) : scope;
        declarePattern(declarator.id, targetScope, {
          declarator,
          functionNode: AST_FUNCTION_TYPES.has(declarator.init?.type) ? declarator.init : null,
          init: declarator.init,
          kind: node.kind,
          node: declarator,
        });
      }
      for (const declarator of node.declarations || []) {
        visitPatternExpressions(declarator.id, scope, visit);
        if (declarator.init) visit(declarator.init, scope);
      }
      return;
    }
    if (node.type === "ClassDeclaration" && node.id) {
      declarePattern(node.id, scope, { functionNode: null, kind: "class", node });
    }
    forEachAstChild(node, (child) => visit(child, scope));
  };
  visit(ast, programScope);
  const resolveIdentifier = (identifier) => {
    if (identifier?.type !== "Identifier") return null;
    if (declarationIdentifiers.has(identifier)) return bindingByDeclaration.get(identifier) || null;
    let scope = nodeScopes.get(identifier) || null;
    while (scope) {
      if (scope.bindings.has(identifier.name)) return scope.bindings.get(identifier.name);
      scope = scope.parent;
    }
    return null;
  };
  return {
    allBindings,
    ast,
    bindingByDeclaration,
    declarationIdentifiers,
    nodeScopes,
    programScope,
    resolveIdentifier,
    source,
  };
};

const unwrapExpression = (node) => {
  let current = node;
  while (["AwaitExpression", "ChainExpression"].includes(current?.type)) {
    current = current.type === "AwaitExpression" ? current.argument : current.expression;
  }
  return current;
};

const functionNodeForBinding = (binding) => {
  if (AST_FUNCTION_TYPES.has(binding?.functionNode?.type)) return binding.functionNode;
  const init = unwrapExpression(binding?.init);
  return AST_FUNCTION_TYPES.has(init?.type) ? init : null;
};

const collectReachableFunctions = (model) => {
  const root = functionNodeForBinding(model.programScope.bindings.get("run"));
  if (!root) return [];
  const reachable = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const fn = queue.shift();
    const inspect = (node) => {
      if (node !== fn && AST_FUNCTION_TYPES.has(node.type)) {
        if (!reachable.has(node)) {
          reachable.add(node);
          queue.push(node);
        }
        return false;
      }
      if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
        const helper = functionNodeForBinding(model.resolveIdentifier(node.callee));
        if (helper && !reachable.has(helper)) {
          reachable.add(helper);
          queue.push(helper);
        }
      }
      return true;
    };
    for (const parameter of fn.params || []) walkAst(parameter, inspect);
    walkAst(fn.body, inspect);
  }
  return [...reachable];
};

const collectReachableNodes = (model) => {
  const functions = collectReachableFunctions(model);
  const nodes = [];
  const seen = new WeakSet();
  for (const fn of functions) {
    const collect = (node) => {
      if (node !== fn && AST_FUNCTION_TYPES.has(node.type)) return false;
      if (!seen.has(node)) {
        seen.add(node);
        nodes.push(node);
      }
      return true;
    };
    for (const parameter of fn.params || []) walkAst(parameter, collect);
    walkAst(fn.body, collect);
  }
  return nodes;
};

const literalString = (node) => node?.type === "Literal" && typeof node.value === "string"
  ? node.value
  : "";

const rootIdentifier = (node) => {
  let current = node;
  while (current?.type === "MemberExpression") current = current.object;
  return current?.type === "Identifier" ? current : null;
};

const isTrustedAssertCall = (node, model) => {
  if (node?.type !== "CallExpression") return false;
  const identifier = rootIdentifier(node.callee);
  if (!identifier || identifier.name !== "assert") return false;
  const binding = model.resolveIdentifier(identifier);
  return binding?.kind === "import" && /^(?:node:)?assert(?:\/strict)?$/.test(binding.source);
};

const subtreeContainsBinding = (node, binding, model) => {
  let found = false;
  walkAst(node, (current, parent, parentKey) => {
    if (found) return false;
    if (current.type !== "Identifier" || current.name !== binding.name) return true;
    if (
      model.declarationIdentifiers.has(current)
      || (parent?.type === "MemberExpression" && parentKey === "property" && !parent.computed)
      || (parent?.type === "Property" && parentKey === "key" && !parent.computed && !parent.shorthand)
    ) return true;
    if (model.resolveIdentifier(current) === binding) found = true;
    return !found;
  });
  return found;
};

const subtreeStringValues = (node) => {
  const values = [];
  walkAst(node, (current) => {
    const value = literalString(current);
    if (value) values.push(value);
  });
  return values;
};

const trustedContractHelperBinding = (binding, name) => Boolean(
  binding?.kind === "import"
  && binding.imported === name
  && /(?:^|\/)contract-test-helpers\.js$/.test(binding.source),
);

const expectedDirectImportSource = (testPath, targetPath) => {
  let relative = path.posix.relative(path.posix.dirname(testPath), targetPath);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
};

const targetBindingMatchesEvidence = (binding, evidence, testPath, model) => {
  if (!binding || binding.name !== evidence.binding) return false;
  if (binding.kind === "import") {
    return binding.imported === evidence.symbol
      && binding.source === expectedDirectImportSource(testPath, evidence.targetPath);
  }
  const init = unwrapExpression(binding.init);
  if (init?.type !== "CallExpression" || init.callee?.type !== "Identifier") return false;
  if (!trustedContractHelperBinding(model.resolveIdentifier(init.callee), "requireCallable")) return false;
  if (literalString(init.arguments?.[1]) !== evidence.symbol || init.arguments?.[0]?.type !== "Identifier") return false;
  const moduleBinding = model.resolveIdentifier(init.arguments[0]);
  const moduleInit = unwrapExpression(moduleBinding?.init);
  if (moduleInit?.type !== "CallExpression" || moduleInit.callee?.type !== "Identifier") return false;
  return trustedContractHelperBinding(model.resolveIdentifier(moduleInit.callee), "importContractModule")
    && literalString(moduleInit.arguments?.[0]) === evidence.targetPath;
};

const callMatchesImportEvidence = (node, evidence, testPath, model) => Boolean(
  node?.type === "CallExpression"
  && node.callee?.type === "Identifier"
  && node.callee.name === evidence.binding
  && targetBindingMatchesEvidence(model.resolveIdentifier(node.callee), evidence, testPath, model)
);

const targetImportIsPresent = (model, evidence, testPath) => {
  const directSource = expectedDirectImportSource(testPath, evidence.targetPath);
  let present = false;
  walkAst(model.ast, (node) => {
    if (present) return false;
    if (node.type === "ImportDeclaration" && literalString(node.source) === directSource) present = true;
    if (
      node.type === "CallExpression"
      && node.callee?.type === "Identifier"
      && node.callee.name === "importContractModule"
      && literalString(node.arguments?.[0]) === evidence.targetPath
    ) present = true;
    return !present;
  });
  return present;
};

const bindingWasMutatedBetween = (binding, start, end, nodes, model) => nodes.some((node) => {
  if (node.start <= start || node.start >= end) return false;
  if (node.type === "AssignmentExpression") {
    return patternIdentifiers(node.left).some((identifier) => model.resolveIdentifier(identifier) === binding);
  }
  return node.type === "UpdateExpression"
    && node.argument?.type === "Identifier"
    && model.resolveIdentifier(node.argument) === binding;
});

const assessAstRelevanceEvidence = ({ evidence, source, testPath }) => {
  const model = buildEvidenceModel(source);
  if (!model) return "behavior_missing";
  const nodes = collectReachableNodes(model);
  const assertions = nodes.filter((node) => isTrustedAssertCall(node, model));
  if (evidence.mode === "self") {
    if (evidence.targetPath !== testPath) return "missing";
    if (assertions.length === 0) return "behavior_missing";
    return { assertionOffset: assertions[0].start, operationOffset: assertions[0].start, status: "ok" };
  }
  if (evidence.mode === "inventory_scan") {
    return source.includes(`"${evidence.targetPath}"`)
      && source.includes("readFileSync")
      && source.includes("directWrite.test")
      && source.includes("assert.deepEqual(offenders, []")
      ? { assertionOffset: source.indexOf("assert.deepEqual(offenders, []"), operationOffset: source.indexOf("directWrite.test"), status: "ok" }
      : "missing";
  }
  if (evidence.mode === "writer_exercised") {
    if (!targetImportIsPresent(model, evidence, testPath)) return "missing";
    const calls = nodes.filter((node) => callMatchesImportEvidence(node, evidence, testPath, model));
    for (const operation of calls) {
      const assertion = assertions.find((item) => item.start > operation.end);
      if (assertion) return { assertionOffset: assertion.start, operationOffset: operation.start, status: "ok" };
    }
    return calls.length > 0 ? "behavior_missing" : "missing";
  }
  if (["read", "spawn"].includes(evidence.mode)) {
    const operationNames = evidence.mode === "read"
      ? new Set(["readFile", "readFileSync"])
      : new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
    let sawTargetOperation = false;
    const candidates = [];
    for (const binding of model.allBindings.filter((item) => item.name === evidence.binding && item.declarator)) {
      if (!nodes.includes(binding.declarator) || !binding.init) continue;
      let operation = null;
      walkAst(binding.init, (node) => {
        if (operation || node.type !== "CallExpression" || node.callee?.type !== "Identifier") return !operation;
        const calleeBinding = model.resolveIdentifier(node.callee);
        const trustedSource = evidence.mode === "read" ? "node:fs" : "node:child_process";
        if (
          operationNames.has(node.callee.name)
          && calleeBinding?.kind === "import"
          && [trustedSource, trustedSource.replace("node:", "")].includes(calleeBinding.source)
          && subtreeStringValues(binding.init).includes(evidence.targetPath)
        ) operation = node;
        return !operation;
      });
      if (!operation) continue;
      sawTargetOperation = true;
      const assertion = assertions.find((item) => item.start > operation.end && subtreeContainsBinding(item, binding, model));
      if (assertion) candidates.push({ assertionOffset: assertion.start, operationOffset: operation.start, status: "ok" });
    }
    if (candidates.length > 0) return candidates[0];
    return sawTargetOperation ? "behavior_missing" : "missing";
  }
  if (evidence.mode !== "import") return "missing";
  if (!targetImportIsPresent(model, evidence, testPath)) return "missing";
  if (evidence.resultBinding) {
    const candidates = [];
    for (const binding of model.allBindings.filter((item) => item.name === evidence.resultBinding && item.declarator)) {
      if (!nodes.includes(binding.declarator)) continue;
      const operation = unwrapExpression(binding.init);
      if (!callMatchesImportEvidence(operation, evidence, testPath, model)) continue;
      const assertion = assertions.find((item) => (
        item.start > operation.end
        && subtreeContainsBinding(item, binding, model)
        && !bindingWasMutatedBetween(binding, operation.end, item.start, nodes, model)
      ));
      if (assertion) candidates.push({ assertionOffset: assertion.start, operationOffset: operation.start, status: "ok" });
    }
    return candidates.length === 1 ? candidates[0] : "behavior_missing";
  }
  const candidates = [];
  for (const assertion of assertions) {
    walkAst(assertion, (node) => {
      if (callMatchesImportEvidence(node, evidence, testPath, model)) {
        candidates.push({ assertionOffset: assertion.start, operationOffset: node.start, status: "ok" });
        return false;
      }
      return true;
    });
  }
  return candidates[0] || "behavior_missing";
};

function assessStaticRelevanceEvidence({ evidence, source, testPath }) {
  return assessAstRelevanceEvidence({ evidence, source, testPath });
}

function collectV8Coverage(coverageDir, { processId = null } = {}) {
  const executed = new Map();
  const rangesByPath = new Map();
  let documents = 0;
  try {
    for (const file of readdirSync(coverageDir).filter((name) => name.endsWith(".json"))) {
      if (processId !== null) {
        const coverageProcess = /^coverage-(\d+)-/.exec(file);
        if (!coverageProcess || Number(coverageProcess[1]) !== processId) continue;
      }
      const document = JSON.parse(readFileSync(path.join(coverageDir, file), "utf8"));
      if (!Array.isArray(document.result)) return { executed, rangesByPath, valid: false };
      documents += 1;
      for (const script of document.result) {
        if (typeof script?.url !== "string" || !script.url.startsWith("file:")) continue;
        let targetPath;
        try {
          const url = new URL(script.url);
          url.search = "";
          url.hash = "";
          targetPath = path.resolve(fileURLToPath(url));
        } catch {
          continue;
        }
        if (!executed.has(targetPath)) executed.set(targetPath, new Map());
        if (!rangesByPath.has(targetPath)) rangesByPath.set(targetPath, []);
        const bySymbol = executed.get(targetPath);
        const scriptRanges = rangesByPath.get(targetPath);
        for (const fn of Array.isArray(script.functions) ? script.functions : []) {
          const symbol = String(fn.functionName || "");
          const ranges = Array.isArray(fn.ranges) ? fn.ranges : [];
          for (const range of ranges) {
            const startOffset = Number(range.startOffset);
            const endOffset = Number(range.endOffset);
            const count = Number(range.count);
            if (
              Number.isSafeInteger(startOffset)
              && Number.isSafeInteger(endOffset)
              && endOffset > startOffset
              && Number.isFinite(count)
            ) {
              scriptRanges.push({ count, endOffset, startOffset });
            }
          }
          if (!symbol || !ranges.some((range) => Number(range.count) > 0)) continue;
          const rootRange = ranges[0] || {};
          const signature = `${Number(rootRange.startOffset)}:${Number(rootRange.endOffset)}`;
          if (!bySymbol.has(symbol)) bySymbol.set(symbol, new Set());
          bySymbol.get(symbol).add(signature);
        }
      }
    }
  } catch {
    return { executed, rangesByPath, valid: false };
  }
  return { executed, rangesByPath, valid: documents > 0 };
}

function hasUnambiguousExecutedTargetSymbol(coverage, targetPath, symbol, executionRoot = process.cwd()) {
  if (!coverage?.valid) return false;
  const absoluteTarget = path.resolve(executionRoot, targetPath);
  const signatures = coverage.executed.get(absoluteTarget)?.get(symbol);
  return signatures instanceof Set && signatures.size === 1;
}

function isTestSourceOffsetExecuted(coverage, testPath, offset, executionRoot = process.cwd()) {
  if (!coverage?.valid || !Number.isSafeInteger(offset) || offset < 0) return false;
  const absoluteTestPath = path.resolve(executionRoot, testPath);
  const containing = (coverage.rangesByPath.get(absoluteTestPath) || [])
    .filter((range) => range.startOffset <= offset && offset < range.endOffset);
  if (containing.length === 0) return false;
  const minimumWidth = Math.min(...containing.map((range) => range.endOffset - range.startOffset));
  const mostSpecific = containing.filter((range) => range.endOffset - range.startOffset === minimumWidth);
  return mostSpecific.length > 0 && mostSpecific.every((range) => range.count > 0);
}

function materializeImmutableHeadCohort(head) {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-source-first-head-"));
  try {
    const archive = git(["archive", "--format=tar", head], { binary: true }).stdout;
    const extracted = spawnSync("tar", ["-xf", "-", "-C", root], {
      cwd: process.cwd(),
      env: { ...process.env, LC_ALL: "C" },
      input: archive,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 20_000,
    });
    if (extracted.error || extracted.status !== 0) fail("GATE_EXECUTION_COHORT", head);
    const nodeModules = path.join(process.cwd(), "node_modules");
    if (existsSync(nodeModules)) symlinkSync(nodeModules, path.join(root, "node_modules"), "dir");
    return root;
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

function executeRegisteredNodeTest(registration, head) {
  const coverageDir = mkdtempSync(path.join(tmpdir(), "gigabrain-source-first-coverage-"));
  const executionRoot = materializeImmutableHeadCohort(head);
  const wrapper = [
    'import { pathToFileURL } from "node:url";',
    'const target = process.env.SOURCE_FIRST_GATE_TEST_PATH;',
    'if (!target) throw new Error("SOURCE_FIRST_TEST_PATH");',
    'const module = await import(`${pathToFileURL(target).href}?source-first-gate=${Date.now()}`);',
    'if (typeof module.run !== "function") throw new Error("SOURCE_FIRST_TEST_RUN_EXPORT");',
    'await module.run();',
  ].join("\n");
  try {
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      wrapper,
    ], {
      cwd: executionRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        LC_ALL: "C",
        NODE_V8_COVERAGE: coverageDir,
        SOURCE_FIRST_GATE_TEST_PATH: path.resolve(executionRoot, registration.testPath),
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return {
      coverage: collectV8Coverage(coverageDir, { processId: result.pid }),
      executionRoot,
      ok: !result.error && result.status === 0,
    };
  } finally {
    rmSync(coverageDir, { force: true, recursive: true });
    rmSync(executionRoot, { force: true, recursive: true });
  }
}

function ensureSorted(rows, key) {
  const values = rows.map(key);
  const sorted = [...values].sort(compareText);
  if (values.some((value, index) => value !== sorted[index])) fail("NON_CANONICAL_ORDER");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checkManifest(rows, count, expectedHash, code) {
  if (rows.length !== count || sha256(canonicalJson(rows)) !== expectedHash) fail(code);
}

function git(args, { binary = false, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: binary ? null : "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.error || (!allowFailure && result.status !== 0)) fail("GIT_ERROR");
  return result;
}

function gitText(args) {
  return git(args).stdout.trim();
}

function resolveCommit(value) {
  if (typeof value !== "string" || value.startsWith("-") || value.includes("\0")) fail("INVALID_BASE");
  const result = git(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], { allowFailure: true });
  if (result.status !== 0) fail("INVALID_BASE");
  return result.stdout.trim();
}

function readTree(commit) {
  const output = git(["ls-tree", "-r", "-z", commit], { binary: true }).stdout;
  const entries = [];
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
    if (!match) fail("GIT_TREE_PARSE");
    entries.push({ blob: match[3], mode: match[1], path: match[4], type: match[2] });
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  return entries;
}

function readDiff(base, head) {
  const fields = git(["diff", "--name-status", "--no-renames", "-z", base, head, "--"], {
    binary: true,
  }).stdout
    .toString("utf8")
    .split("\0");
  const rows = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const status = fields[index];
    const targetPath = fields[index + 1];
    if (!status || !targetPath || !/^[AMDT]$/.test(status)) fail("GIT_DIFF_PARSE");
    rows.push({ status, targetPath });
  }
  rows.sort((left, right) => compareText(left.targetPath, right.targetPath));
  return rows;
}

function blobAt(commit, targetPath) {
  return git(["cat-file", "blob", `${commit}:${targetPath}`], { binary: true }).stdout;
}

function validateAuthoritativeSnapshot(map) {
  if (map.auditedBase.commit !== AUTHORITATIVE_BASE) return;
  const checks = [
    [map.deployedSource.commit, AUTHORITATIVE.deployedCommit],
    [map.deployedSource.tree, AUTHORITATIVE.deployedTree],
    [map.deployedSource.fileCount, AUTHORITATIVE.deployedFileCount],
    [map.deployedSource.commitCount, AUTHORITATIVE.deployedCommitCount],
    [map.preTagToolCount, AUTHORITATIVE.preTagToolCount],
    [map.deployedSource.fileManifestSha256, AUTHORITATIVE.deployedFileManifestSha256],
    [map.deployedSource.commitManifestSha256, AUTHORITATIVE.deployedCommitManifestSha256],
    [map.preTagToolManifestSha256, AUTHORITATIVE.preTagToolManifestSha256],
    [map.obsoleteSourceManifestSha256, AUTHORITATIVE.obsoleteSourceManifestSha256],
  ];
  for (const [actual, expected] of checks) {
    if (expected === null || actual !== expected) fail("AUTHORITATIVE_SNAPSHOT");
  }
}

function validatePrivateAndObsolete(map, head, candidateRow) {
  if (candidateRow.changeType === "deleted") return;
  if (!isSourceOrDefault(candidateRow.targetPath) || POLICY_INFRASTRUCTURE.has(candidateRow.targetPath)) return;
  const bytes = blobAt(head, candidateRow.targetPath);
  const digest = sha256(bytes);
  if (map.obsoleteSourceFingerprints.some((row) => row.sha256 === digest)) {
    fail("OBSOLETE_SOURCE_COPY", candidateRow.targetPath);
  }
  if (bytes.includes(0)) return;
  const text = bytes.toString("utf8");
  const operatorPatterns = [
    /["']operatorRules["']\s*:/,
    /["']privateRules["']\s*:/,
    /\boperatorRules\s*=/,
    /\bprivateRules\s*=/,
  ];
  if (operatorPatterns.some((pattern) => pattern.test(text))) {
    const reviewedSchemaPaths = new Set([
      "lib/core/config.js",
      "openclaw.plugin.json",
      "scripts/build-operator-rules-migration.js",
    ]);
    let nonEmptyJsonRules = false;
    if (candidateRow.targetPath.endsWith(".json")) {
      try {
        const document = JSON.parse(text);
        const ruleNodeHasValues = (value) => {
          if (Array.isArray(value)) return value.length > 0;
          if (!value || typeof value !== "object") return false;
          const isSchema = value.type === "object" && value.properties && typeof value.properties === "object";
          if (isSchema) {
            const hasNonEmptyDefault = (schema) => {
              if (Array.isArray(schema)) return schema.some(hasNonEmptyDefault);
              if (!schema || typeof schema !== "object") return false;
              if (Array.isArray(schema.default) && schema.default.length > 0) return true;
              return Object.values(schema).some(hasNonEmptyDefault);
            };
            return hasNonEmptyDefault(value);
          }
          return Object.values(value).some(ruleNodeHasValues);
        };
        const hasConfiguredRuleNode = (value) => {
          if (Array.isArray(value)) return value.some(hasConfiguredRuleNode);
          if (!value || typeof value !== "object") return false;
          return Object.entries(value).some(([key, child]) => (
            key === "operatorRules" || key === "privateRules"
              ? ruleNodeHasValues(child)
              : hasConfiguredRuleNode(child)
          ));
        };
        nonEmptyJsonRules = hasConfiguredRuleNode(document);
      } catch {
        nonEmptyJsonRules = true;
      }
    }
    if (!reviewedSchemaPaths.has(candidateRow.targetPath) || nonEmptyJsonRules) {
      fail("OPERATOR_LITERAL", candidateRow.targetPath);
    }
  }
  const privatePatterns = [
    /SOURCE_FIRST_PRIVATE_LITERAL/,
    /\boperator[_-]?private\b/i,
    /\bprivate[_-]?rules?\b/i,
    /\/(?:home|Users)\/[A-Za-z0-9._-]+\//,
  ];
  if (privatePatterns.some((pattern) => pattern.test(text))) fail("PRIVATE_LITERAL", candidateRow.targetPath);
}

function validatePolicyAuthority({
  allowlistPath,
  base,
  head,
  map,
  mapPath,
  retirementEvidencePath,
  testRegistryPath,
}) {
  const repoRoot = path.resolve(gitText(["rev-parse", "--show-toplevel"]));
  const authoritativeBaseExists = git(
    ["cat-file", "-e", `${AUTHORITATIVE_BASE}^{commit}`],
    { allowFailure: true },
  ).status === 0;

  if (authoritativeBaseExists) {
    const canonicalMap = path.join(repoRoot, "config", "migration", "source-first-port-map.json");
    const canonicalAllowlist = path.join(repoRoot, "config", "migration", "upstream-source-allowlist.json");
    const canonicalRetirementEvidence = path.join(
      repoRoot,
      "config",
      "migration",
      "retirement-evidence-attestation.json",
    );
    const canonicalTestRegistry = path.join(repoRoot, "config", "migration", "source-first-test-registry.json");
    if (
      mapPath !== canonicalMap ||
      allowlistPath !== canonicalAllowlist ||
      retirementEvidencePath !== canonicalRetirementEvidence ||
      testRegistryPath !== canonicalTestRegistry ||
      base !== AUTHORITATIVE_BASE ||
      map.auditedBase.commit !== AUTHORITATIVE_BASE
    ) {
      fail("NON_AUTHORITATIVE_POLICY");
    }
    return;
  }

  // Synthetic repositories exercise the generic policy schema without the
  // production root of trust. They still may not redefine HEAD as their own
  // audited authority, which would reduce the guard to an empty-diff check.
  if (base === head && map.auditedBase.commit === head) fail("NON_AUTHORITATIVE_POLICY");
}

function readExpectedFailures(head, headByPath) {
  const manifestPath = "tests/compat/expected-failures.json";
  if (!headByPath.has(manifestPath)) return new Map();
  let document;
  try {
    document = JSON.parse(blobAt(head, manifestPath).toString("utf8"));
  } catch {
    fail("EXPECTED_FAILURE_SCHEMA");
  }
  if (document?.schemaVersion !== 1 || !Array.isArray(document.entries)) fail("EXPECTED_FAILURE_SCHEMA");
  return new Map(document.entries.map((entry) => [entry.test, entry]));
}

function validateActiveGates(map, registry, headByPath, head) {
  const registrations = new Map(registry.entries.map((entry) => [entry.id, entry]));
  const executedTests = new Map();
  const verifiedCorePatchPaths = new Set();
  const used = new Set();
  const expectedFailures = readExpectedFailures(head, headByPath);
  for (const row of map.candidateChanges) {
    const registration = registrations.get(row.gate.registrationId);
    if (!registration) fail("GATE_UNREGISTERED", row.targetPath);
    used.add(registration.id);
    if (!row.ownerTasks.includes(registration.ownerSourceFirstTaskId)) {
      fail("GATE_OWNER_MISMATCH", row.targetPath);
    }
    if (!registration.coveredPaths.includes(row.targetPath)) fail("GATE_IRRELEVANT", row.targetPath);
    const gateEntry = headByPath.get(registration.testPath);
    if (!gateEntry || gateEntry.type !== "blob") fail("ACTIVE_GATE_MISSING", registration.testPath);
    if (
      (registration.runner === "node" && !registration.testPath.endsWith("-test.js"))
      || (registration.runner === "python" && !registration.testPath.endsWith("_test.py"))
    ) {
      fail("GATE_NOT_TEST", registration.testPath);
    }
    const expected = expectedFailures.get(registration.testPath.replace(/^tests\//, ""));
    if (registration.expectedOutcome === "xfail") {
      if (
        !expected
        || expected.ownerTask !== registration.ownerSourceFirstTaskId
        || expected.signature !== registration.expectedSignature
      ) {
        fail("GATE_SIGNATURE_MISMATCH", registration.testPath);
      }
    } else if (expected) {
      fail("GATE_SIGNATURE_MISMATCH", registration.testPath);
    }
    const evidence = registration.relevanceEvidence?.find((item) => item.targetPath === row.targetPath);
    const requiresExecutableEvidence = row.disposition === "core_patch" || evidence?.mode === "writer_exercised";
    if (requiresExecutableEvidence) {
      if (registration.expectedOutcome !== "pass") fail("GATE_EXECUTION_FAILED", registration.testPath);
      if (!registration.testSha256) fail("GATE_EVIDENCE_MISSING", registration.testPath);
      if (sha256(blobAt(head, registration.testPath)) !== registration.testSha256) {
        fail("GATE_TEST_HASH", registration.testPath);
      }
      if (!evidence) fail("GATE_EVIDENCE_MISSING", row.targetPath);
      if (evidence.mode === "self") fail("GATE_BEHAVIORAL_RELEVANCE", row.targetPath);
      const testSource = blobAt(head, registration.testPath).toString("utf8");
      const relevance = assessStaticRelevanceEvidence({
        evidence,
        source: testSource,
        testPath: registration.testPath,
      });
      const relevanceStatus = typeof relevance === "string" ? relevance : relevance.status;
      if (relevanceStatus === "missing") {
        fail("GATE_RELEVANCE", row.targetPath);
      }
      if (relevanceStatus !== "ok") fail("GATE_BEHAVIORAL_RELEVANCE", row.targetPath);
      const executionKey = `${registration.testPath}\0${registration.testSha256}`;
      let execution = executedTests.get(executionKey);
      if (!execution) {
        if (registration.runner !== "node") {
          fail("GATE_EXECUTION_FAILED", registration.testPath);
        }
        execution = executeRegisteredNodeTest(registration, head);
        if (!execution.ok) fail("GATE_EXECUTION_FAILED", registration.testPath);
        executedTests.set(executionKey, execution);
      }
      if (
        ["import", "writer_exercised"].includes(evidence.mode)
        && !hasUnambiguousExecutedTargetSymbol(
          execution.coverage,
          evidence.targetPath,
          evidence.symbol,
          execution.executionRoot,
        )
      ) {
        fail("GATE_DYNAMIC_EVIDENCE", row.targetPath);
      }
      if (
        !isTestSourceOffsetExecuted(
          execution.coverage,
          registration.testPath,
          relevance.operationOffset,
          execution.executionRoot,
        )
        || !isTestSourceOffsetExecuted(
          execution.coverage,
          registration.testPath,
          relevance.assertionOffset,
          execution.executionRoot,
        )
      ) {
        fail("GATE_DYNAMIC_EVIDENCE", row.targetPath);
      }
      if (row.disposition === "core_patch") verifiedCorePatchPaths.add(row.targetPath);
    }
  }
  for (const registration of registry.entries) {
    if (!used.has(registration.id)) fail("TEST_REGISTRY_STALE", registration.id);
    for (const coveredPath of registration.coveredPaths) {
      if (!map.candidateChanges.some((row) => row.targetPath === coveredPath)) {
        fail("TEST_REGISTRY_STALE", coveredPath);
      }
    }
  }
  return verifiedCorePatchPaths;
}

function isSourceOrDefault(targetPath) {
  return (
    /^(?:index\.(?:js|ts)|lib\/|memory_api\/|scripts\/|config\/)/.test(targetPath) ||
    targetPath === "openclaw.plugin.json" ||
    targetPath === "package.json"
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--base" && flag !== "--map") fail("USAGE");
    const value = argv[index + 1];
    if (!value) fail("USAGE");
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.base || !options.map) fail("USAGE");
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const mapPath = path.resolve(process.cwd(), options.map);
  const map = readCanonicalJson(mapPath);
  validateMap(map);

  const allowlistPath = path.resolve(path.dirname(mapPath), map.upstreamAllowlist);
  const allowlist = readCanonicalJson(allowlistPath);
  validateAllowlist(allowlist);
  const retirementEvidencePath = path.resolve(path.dirname(mapPath), map.retirementEvidenceAttestation);
  const retirementEvidence = readCanonicalJson(retirementEvidencePath);
  validateRetirementEvidenceAttestation(retirementEvidence, map);
  const testRegistryPath = path.resolve(path.dirname(mapPath), map.testRegistry);
  const testRegistry = readCanonicalJson(testRegistryPath);
  validateTestRegistry(testRegistry);
  validateAuthoritativeSnapshot(map);

  const base = resolveCommit(options.base);
  const head = resolveCommit("HEAD");
  validatePolicyAuthority({
    allowlistPath,
    base,
    head,
    map,
    mapPath,
    retirementEvidencePath,
    testRegistryPath,
  });
  if (base !== map.auditedBase.commit || allowlist.auditedBase.commit !== base) fail("INVALID_BASE");
  const baseTreeId = gitText(["rev-parse", `${base}^{tree}`]);
  if (baseTreeId !== map.auditedBase.tree || allowlist.auditedBase.tree !== baseTreeId) fail("INVALID_BASE");
  if (git(["merge-base", "--is-ancestor", base, head], { allowFailure: true }).status !== 0) fail("INVALID_BASE");

  if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { binary: true }).stdout.length > 0) {
    fail("DIRTY_WORKTREE");
  }

  const baseEntries = readTree(base);
  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const allowByPath = new Map(allowlist.entries.map((entry) => [entry.path, entry]));
  const candidateByPath = new Map(map.candidateChanges.map((entry) => [entry.targetPath, entry]));

  for (const entry of allowlist.entries) {
    const baseEntry = baseByPath.get(entry.path);
    if (!baseEntry) fail("STALE_ALLOWLIST_ROW", entry.path);
    if (
      entry.mode !== baseEntry.mode ||
      entry.type !== baseEntry.type ||
      entry.blob !== baseEntry.blob
    ) {
      fail("ALLOWLIST_IDENTITY", entry.path);
    }
    const candidate = candidateByPath.get(entry.path);
    if (candidate && candidate.disposition !== "core_patch") {
      fail("ALLOWLIST_IDENTITY", entry.path);
    }
  }
  for (const entry of baseEntries) {
    if (allowByPath.has(entry.path)) continue;
    const candidate = candidateByPath.get(entry.path);
    if (!candidate || candidate.changeType === "added") fail("ALLOWLIST_INCOMPLETE", entry.path);
    const reviewedNonRuntimeDisposition = UPSTREAM_NON_RUNTIME_DISPOSITIONS.get(entry.path);
    if (reviewedNonRuntimeDisposition) {
      if (candidate.disposition !== reviewedNonRuntimeDisposition) {
        fail("UPSTREAM_NON_RUNTIME_DISPOSITION", entry.path);
      }
    } else if (candidate.disposition !== "core_patch") {
      fail("UPSTREAM_PATCH_NOT_CORE", entry.path);
    }
  }

  const diff = readDiff(base, head);
  const headByPath = new Map(readTree(head).map((entry) => [entry.path, entry]));
  const verifiedCorePatchPaths = validateActiveGates(map, testRegistry, headByPath, head);
  validateAdoptionAndRetirement({
    allowlist,
    attestation: retirementEvidence,
    base,
    head,
    headByPath,
    map,
    verifiedCorePatchPaths,
  });
  const seenDiffs = new Set();
  const statusToChange = { A: "added", D: "deleted", M: "modified", T: "modified" };
  for (const actual of diff) {
    seenDiffs.add(actual.targetPath);
    const expected = candidateByPath.get(actual.targetPath);
    if (allowByPath.has(actual.targetPath) && expected?.disposition !== "core_patch") {
      fail("UPSTREAM_OWNED_EDIT", actual.targetPath);
    }
    if (!expected) fail("UNCLASSIFIED_DIFF", actual.targetPath);
    if (expected.disposition === "upstream_owned") fail("UPSTREAM_OWNED_EDIT", actual.targetPath);
    if (expected.changeType !== statusToChange[actual.status]) fail("UNEXPECTED_DIFF", actual.targetPath);
    if (expected.changeType !== "deleted") {
      const treeEntry = headByPath.get(actual.targetPath);
      if (!treeEntry || treeEntry.type !== "blob" || treeEntry.mode !== expected.targetMode) {
        fail("UNEXPECTED_DIFF", actual.targetPath);
      }
      if (expected.contentSha256 === "canonical-self") {
        if (path.resolve(process.cwd(), actual.targetPath) !== mapPath) fail("UNEXPECTED_DIFF", actual.targetPath);
      } else if (sha256(blobAt(head, actual.targetPath)) !== expected.contentSha256) {
        fail("UNEXPECTED_DIFF", actual.targetPath);
      }
      validatePrivateAndObsolete(map, head, expected);
    }
  }
  for (const row of map.candidateChanges) {
    if (!seenDiffs.has(row.targetPath)) fail("STALE_MAP_ROW", row.targetPath);
  }

  process.stdout.write(
    `SOURCE_FIRST_DIVERGENCE OK diffs=${diff.length} upstream=${allowlist.entries.length} ` +
      `deployedFiles=${map.deployedFiles.length} commits=${map.deployedCommits.length} preTag=${map.preTagTools.length}\n`,
  );
}

try {
  main();
} catch (error) {
  if (error instanceof GuardError) {
    process.stderr.write(
      `SOURCE_FIRST_DIVERGENCE ${error.code}${error.reference ? ` ref=${error.reference}` : ""}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stderr.write("SOURCE_FIRST_DIVERGENCE INTERNAL_ERROR\n");
    process.exitCode = 1;
  }
}

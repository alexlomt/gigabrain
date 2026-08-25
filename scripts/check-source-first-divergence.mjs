#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

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
  "config/migration/source-first-port-map.json",
  "config/migration/upstream-source-allowlist.json",
  "scripts/check-source-first-divergence.mjs",
]);
const ACTIVE_GATE_KINDS = new Set(["active_test"]);

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
  const hasLegacyGate = Object.hasOwn(row, "testGate");
  const hasActiveGate = Object.hasOwn(row, "gate");
  if (hasLegacyGate === hasActiveGate) fail("MISSING_TEST_GATE");
  if (hasLegacyGate) {
    nonEmptyString(row.testGate, "MISSING_TEST_GATE");
    return;
  }
  exactKeys(row.gate, ["kind", "ownerSourceFirstTaskId", "testPath"]);
  if (!ACTIVE_GATE_KINDS.has(row.gate.kind)) fail("MISSING_TEST_GATE");
  if (typeof row.gate.ownerSourceFirstTaskId !== "string" || !TASK.test(row.gate.ownerSourceFirstTaskId)) {
    fail("MISSING_TEST_GATE");
  }
  validatePath(row.gate.testPath);
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
    "schemaVersion",
    "upstreamAllowlist",
  ]);
  if (map.schemaVersion !== 1) fail("SCHEMA_VERSION");
  validateAuditedBase(map.auditedBase);
  nonEmptyString(map.upstreamAllowlist);
  validatePath(map.upstreamAllowlist);

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
  exactKeys(allowlist, ["auditedBase", "entries", "entryCount", "manifestSha256", "schemaVersion"]);
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
  if (operatorPatterns.some((pattern) => pattern.test(text))) fail("OPERATOR_LITERAL", candidateRow.targetPath);
  const privatePatterns = [
    /SOURCE_FIRST_PRIVATE_LITERAL/,
    /\boperator[_-]?private\b/i,
    /\bprivate[_-]?rules?\b/i,
    /\/(?:home|Users)\/[A-Za-z0-9._-]+\//,
  ];
  if (privatePatterns.some((pattern) => pattern.test(text))) fail("PRIVATE_LITERAL", candidateRow.targetPath);
}

function validatePolicyAuthority({ allowlistPath, base, head, map, mapPath }) {
  const repoRoot = path.resolve(gitText(["rev-parse", "--show-toplevel"]));
  const authoritativeBaseExists = git(
    ["cat-file", "-e", `${AUTHORITATIVE_BASE}^{commit}`],
    { allowFailure: true },
  ).status === 0;

  if (authoritativeBaseExists) {
    const canonicalMap = path.join(repoRoot, "config", "migration", "source-first-port-map.json");
    const canonicalAllowlist = path.join(repoRoot, "config", "migration", "upstream-source-allowlist.json");
    if (
      mapPath !== canonicalMap ||
      allowlistPath !== canonicalAllowlist ||
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

function validateActiveGates(map, headByPath) {
  for (const row of map.candidateChanges) {
    if (!row.gate) continue;
    if (!row.ownerTasks.includes(row.gate.ownerSourceFirstTaskId)) {
      fail("GATE_OWNER_MISMATCH", row.targetPath);
    }
    const gateEntry = headByPath.get(row.gate.testPath);
    if (!gateEntry || gateEntry.type !== "blob") fail("ACTIVE_GATE_MISSING", row.gate.testPath);
  }
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
  validateAuthoritativeSnapshot(map);

  const base = resolveCommit(options.base);
  const head = resolveCommit("HEAD");
  validatePolicyAuthority({ allowlistPath, base, head, map, mapPath });
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
      entry.blob !== baseEntry.blob ||
      candidateByPath.has(entry.path)
    ) {
      fail("ALLOWLIST_IDENTITY", entry.path);
    }
  }
  for (const entry of baseEntries) {
    if (allowByPath.has(entry.path)) continue;
    const candidate = candidateByPath.get(entry.path);
    if (!candidate || candidate.changeType === "added") fail("ALLOWLIST_INCOMPLETE", entry.path);
  }

  const diff = readDiff(base, head);
  const headByPath = new Map(readTree(head).map((entry) => [entry.path, entry]));
  validateActiveGates(map, headByPath);
  const seenDiffs = new Set();
  const statusToChange = { A: "added", D: "deleted", M: "modified", T: "modified" };
  for (const actual of diff) {
    seenDiffs.add(actual.targetPath);
    if (allowByPath.has(actual.targetPath)) fail("UPSTREAM_OWNED_EDIT", actual.targetPath);
    const expected = candidateByPath.get(actual.targetPath);
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

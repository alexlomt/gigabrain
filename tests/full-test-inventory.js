import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const inventoryPath = path.join(repoRoot, "config", "migration", "deployed-test-inventory.json");
const deployedInventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const sourceFirstMap = JSON.parse(readFileSync(
  path.join(repoRoot, "config", "migration", "source-first-port-map.json"),
  "utf8",
));
export const SOURCE_FIRST_TEST_REGISTRY = Object.freeze(JSON.parse(readFileSync(
  path.join(repoRoot, "config", "migration", "source-first-test-registry.json"),
  "utf8",
)));
const stagePaths = readFileSync(path.join(repoRoot, "config", "migration", "task2-stage-paths.txt"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;
const RESTORE_STATES = new Set([
  "isolated_canary_adapted",
  "protected_private_development",
  "synthetic_restored",
  "upstream_replaced",
]);
const CANONICAL_EXPECTED_FAILURE_OWNERS = new Map([
  ["compat/generated-surface-test.js", "10"],
  ["compat/observational-diagnostics-test.js", "5"],
  ["compat/full-registry-migration-test.js", "14"],
  ["compat/rollback-restore-test.js", "14"],
]);
const CANONICAL_COMPATIBILITY_OWNERS = new Map([
  ["compat/generated-surface-test.js", "10"],
  ["compat/observational-diagnostics-test.js", "5"],
]);

export const DEPLOYED_CLASS_COUNTS = Object.freeze({
  normal_registered: 62,
  isolated_release_live: 2,
  private_memorybench_overlay: 1,
});

export const DEPLOYED_NORMAL_TEST_FILES = Object.freeze(
  deployedInventory.tests
    .filter((row) => row.class === "normal_registered")
    .map((row) => row.syntheticTarget.replace(/^tests\//, "")),
);

function validateDeployedInventory() {
  if (deployedInventory.schemaVersion !== 1 || !Array.isArray(deployedInventory.tests)) {
    throw new Error("DEPLOYED_TEST_INVENTORY_SCHEMA");
  }
  const paths = new Set();
  const counts = {
    normal_registered: 0,
    isolated_release_live: 0,
    private_memorybench_overlay: 0,
  };
  let previous = "";
  const staged = new Set(stagePaths);
  if (
    staged.size !== stagePaths.length ||
    stagePaths.some((entry, index) => /[*?\[\]{}]/.test(entry)
      || (index > 0 && stagePaths[index - 1].localeCompare(entry, "en") > 0))
  ) {
    throw new Error("TASK2_STAGE_PATH_INVENTORY");
  }
  for (const row of deployedInventory.tests) {
    if (
      typeof row.sourcePath !== "string" ||
      !row.sourcePath.endsWith("-test.js") ||
      paths.has(row.sourcePath) ||
      !/^[0-9a-f]{40}$/.test(row.sourceBlob) ||
      !/^[0-9a-f]{64}$/.test(row.sourceSha256) ||
      typeof row.syntheticTarget !== "string" ||
      !Object.hasOwn(counts, row.class) ||
      !RESTORE_STATES.has(row.restoreState) ||
      previous.localeCompare(row.sourcePath, "en") > 0
    ) {
      throw new Error("DEPLOYED_TEST_INVENTORY_SCHEMA");
    }
    paths.add(row.sourcePath);
    counts[row.class] += 1;
    previous = row.sourcePath;
    if (["isolated_canary_adapted", "synthetic_restored"].includes(row.restoreState) && !staged.has(row.syntheticTarget)) {
      throw new Error("TASK2_STAGE_PATH_INVENTORY");
    }
    if (row.class === "normal_registered") {
      try {
        readFileSync(path.join(repoRoot, row.syntheticTarget));
      } catch {
        throw new Error(`DEPLOYED_NORMAL_TARGET_MISSING ${row.syntheticTarget}`);
      }
    }
  }
  if (
    deployedInventory.tests.length !== 65 ||
    deployedInventory.deployedSource?.testCount !== 65 ||
    Object.entries(DEPLOYED_CLASS_COUNTS).some(([name, count]) => counts[name] !== count) ||
    sha256(canonicalJson(deployedInventory.tests)) !== deployedInventory.deployedSource?.manifestSha256
  ) {
    throw new Error("DEPLOYED_TEST_INVENTORY_MANIFEST");
  }
}

const PUBLIC_TEST_FILES = [
  "integration-remote-mcp-test.js",
  "unit-bitemporal-test.js",
  "unit-bm25-test.js",
  "unit-capture-service-test.js",
  "unit-checkpoint-migration-test.js",
  "unit-claim-promotion-auth-test.js",
  "unit-cloud-inbox-test.js",
  "unit-config-test.js",
  "unit-control-plane-test.js",
  "unit-cross-store-merge-test.js",
  "unit-event-store-test.js",
  "unit-git-wiki-test.js",
  "unit-handoff-pii-redaction-test.js",
  "unit-host-memory-sync-test.js",
  "unit-http-routes-test.js",
  "unit-lifecycle-hooks-test.js",
  "unit-pii-scanner-test.js",
  "unit-plugin-runtime-test.js",
  "unit-policy-test.js",
  "unit-projection-store-test.js",
  "unit-public-mirror-test.js",
  "unit-recall-service-test.js",
  "unit-remote-mcp-auth-test.js",
  "unit-runtime-guard-test.js",
  "unit-safe-boundaries-test.js",
  "unit-sqlite-test.js",
  "unit-standalone-client-test.js",
  "unit-transcript-harvester-test.js",
  "unit-utility-hardening-test.js",
];

const COMPATIBILITY_TESTS = [
  ["compat/auto-capture-worker-test.js", "9"],
  ["compat/checkpoint-promotion-isolation-test.js", "6"],
  ["compat/config-schema-parity-test.js", "4"],
  ["compat/dedupe-scope-isolation-test.js", "4"],
  ["compat/embedding-identity-test.js", "7"],
  ["compat/full-registry-migration-test.js", "14"],
  ["compat/generated-surface-test.js", "10"],
  ["compat/memory-api-projection-test.js", "11"],
  ["compat/native-lock-concurrency-test.js", "6"],
  ["compat/native-metadata-promotion-test.js", "6"],
  ["compat/observational-core-patches-test.js", "5"],
  ["compat/observational-diagnostics-test.js", "5"],
  ["compat/openclaw-hooks-and-flush-test.js", "5"],
  ["compat/openclaw-memory-authorization-test.js", "5"],
  ["compat/openclaw-memory-runtime-test.js", "5"],
  ["compat/operator-rules-migration-test.js", "4"],
  ["compat/packed-entry-smoke-test.js", "5"],
  ["compat/release-provenance-test.js", "5"],
  ["compat/rollback-restore-test.js", "14"],
  ["compat/scope-visibility-matrix-test.js", "4"],
  ["compat/upstream-adoption-test.js", "3"],
  ["compat/write-mode-gate-test.js", "5"],
];

const RESTORED_DEPLOYED_TESTS = DEPLOYED_NORMAL_TEST_FILES
  .filter((file) => !PUBLIC_TEST_FILES.includes(file));

const descriptor = (file, ownerTask, runner = "module", testClass = "normal") => Object.freeze({
  class: testClass,
  file,
  ownerTask,
  runner,
});

export const NORMAL_TEST_DESCRIPTORS = Object.freeze([
  ...PUBLIC_TEST_FILES.map((file) => descriptor(file, "upstream")),
  ...RESTORED_DEPLOYED_TESTS.map((file) => descriptor(file, "2B")),
  ...COMPATIBILITY_TESTS.map(([file, owner]) => descriptor(file, owner)),
  descriptor("compat/contract-behavior-harness-test.js", "2B"),
  descriptor("full-test-inventory-contract-test.js", "2B"),
  descriptor("npm-pack-parser-test.js", "2B"),
  descriptor("private-test-restoration-test.js", "2B"),
  descriptor("release-live-isolation-test.js", "2B"),
  descriptor("source-first-divergence-test.js", "2A", "script"),
].sort((left, right) => left.file.localeCompare(right.file, "en")));

export const RELEASE_LIVE_TEST_DESCRIPTORS = Object.freeze([
  descriptor("release-live-codex-cli-test.js", "14", "module", "isolated_release_live"),
  descriptor("release-live-openclaw-install-test.js", "14", "module", "isolated_release_live"),
]);

export const PHYSICAL_TEST_DESCRIPTORS = Object.freeze([
  ...NORMAL_TEST_DESCRIPTORS,
  ...RELEASE_LIVE_TEST_DESCRIPTORS,
].sort((left, right) => left.file.localeCompare(right.file, "en")));

export const FULL_TEST_FILES = Object.freeze(NORMAL_TEST_DESCRIPTORS.map((row) => row.file));

export function validatePhysicalInventory(discovered, descriptors = PHYSICAL_TEST_DESCRIPTORS) {
  const actual = [...new Set(discovered)].sort((left, right) => left.localeCompare(right, "en"));
  const expected = descriptors.map((row) => row.file).sort((left, right) => left.localeCompare(right, "en"));
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = actual.filter((file) => !expectedSet.has(file));
  const missing = expected.filter((file) => !actualSet.has(file));
  if (actual.length !== discovered.length || expected.length !== descriptors.length || unexpected.length || missing.length) {
    throw new Error(
      `TEST_INVENTORY_UNCLASSIFIED unexpected=${unexpected.join(",") || "none"} missing=${missing.join(",") || "none"}`,
    );
  }
  return true;
}

export function validateExpectedFailureManifest(entries, descriptors = NORMAL_TEST_DESCRIPTORS, releaseAcceptance = false) {
  if (!Array.isArray(entries)) throw new Error("EXPECTED_FAILURE_SCHEMA");
  const byTest = new Map(descriptors.map((row) => [row.file, row]));
  const validated = new Map();
  let previous = "";
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.test !== "string" ||
      typeof entry.ownerTask !== "string" ||
      typeof entry.signature !== "string" ||
      entry.signature.trim() !== entry.signature ||
      entry.signature.length === 0 ||
      validated.has(entry.test) ||
      previous.localeCompare(entry.test, "en") > 0
    ) {
      throw new Error("EXPECTED_FAILURE_SCHEMA");
    }
    const registered = byTest.get(entry.test);
    if (!registered) throw new Error(`EXPECTED_FAILURE_UNKNOWN_TEST ${entry.test}`);
    const canonicalOwner = CANONICAL_EXPECTED_FAILURE_OWNERS.get(entry.test);
    if (canonicalOwner && (entry.ownerTask !== canonicalOwner || registered.ownerTask !== canonicalOwner)) {
      throw new Error(`EXPECTED_FAILURE_STALE_OWNER ${entry.test}`);
    }
    if (registered.ownerTask !== entry.ownerTask) {
      throw new Error(`EXPECTED_FAILURE_STALE_OWNER ${entry.test}`);
    }
    validated.set(entry.test, Object.freeze({ ...entry }));
    previous = entry.test;
  }
  if (releaseAcceptance && validated.size > 0) throw new Error("EXPECTED_FAILURE_RELEASE_BLOCKED");
  return validated;
}

export function classifyExpectedOutcome(entry, error) {
  if (!error) throw new Error(`EXPECTED_FAILURE_XPASS ${entry.test}`);
  const signature = error instanceof Error ? error.message : String(error);
  if (signature !== entry.signature) {
    throw new Error(`EXPECTED_FAILURE_SIGNATURE_CHANGED ${entry.test}`);
  }
  return "xfail";
}

export function validateCanonicalCompatibilityOwners({
  descriptors = NORMAL_TEST_DESCRIPTORS,
  sourceRegistry = SOURCE_FIRST_TEST_REGISTRY,
  portMap = sourceFirstMap,
} = {}) {
  for (const [file, owner] of CANONICAL_COMPATIBILITY_OWNERS) {
    const testPath = `tests/${file}`;
    const descriptorOwner = descriptors.find((row) => row.file === file)?.ownerTask;
    const registrationOwner = sourceRegistry.entries.find((row) => row.testPath === testPath)?.ownerSourceFirstTaskId;
    const candidateOwners = portMap.candidateChanges.find((row) => row.targetPath === testPath)?.ownerTasks || [];
    if (descriptorOwner !== owner || registrationOwner !== owner || !candidateOwners.includes(owner)) {
      throw new Error(`TEST_OWNER_CANONICAL ${file}`);
    }
  }
  return true;
}

function validateRegisteredDeployedTargets() {
  const registered = new Set(NORMAL_TEST_DESCRIPTORS.map((row) => row.file));
  for (const file of DEPLOYED_NORMAL_TEST_FILES) {
    if (!registered.has(file)) throw new Error(`DEPLOYED_NORMAL_TARGET_UNREGISTERED tests/${file}`);
  }
}

function validateSourceFirstRegistrations() {
  const physical = new Set(PHYSICAL_TEST_DESCRIPTORS.map((row) => `tests/${row.file}`));
  physical.add("tests/memory_api_security_test.py");
  const expectedDocument = JSON.parse(readFileSync(
    path.join(repoRoot, "tests", "compat", "expected-failures.json"),
    "utf8",
  ));
  const expectedByTest = new Map(expectedDocument.entries.map((row) => [`tests/${row.test}`, row]));
  const registrationById = new Map();
  for (const row of SOURCE_FIRST_TEST_REGISTRY.entries || []) {
    if (registrationById.has(row.id) || !physical.has(row.testPath)) {
      throw new Error(`SOURCE_FIRST_TEST_UNREGISTERED ${row.testPath}`);
    }
    registrationById.set(row.id, row);
    const expected = expectedByTest.get(row.testPath);
    if (row.expectedOutcome === "xfail") {
      if (
        !expected
        || expected.ownerTask !== row.ownerSourceFirstTaskId
        || expected.signature !== row.expectedSignature
      ) {
        throw new Error(`SOURCE_FIRST_TEST_SIGNATURE ${row.testPath}`);
      }
    } else if (expected) {
      throw new Error(`SOURCE_FIRST_TEST_SIGNATURE ${row.testPath}`);
    }
  }
  for (const candidate of sourceFirstMap.candidateChanges || []) {
    const registration = registrationById.get(candidate.gate?.registrationId);
    if (
      !registration
      || !registration.coveredPaths.includes(candidate.targetPath)
      || !candidate.ownerTasks.includes(registration.ownerSourceFirstTaskId)
    ) {
      throw new Error(`SOURCE_FIRST_TEST_RELEVANCE ${candidate.targetPath}`);
    }
  }
}

validateDeployedInventory();
validateRegisteredDeployedTargets();
validateSourceFirstRegistrations();
validateCanonicalCompatibilityOwners();

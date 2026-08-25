import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const inventoryPath = path.join(repoRoot, "config", "migration", "deployed-test-inventory.json");
const deployedInventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
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

export const DEPLOYED_CLASS_COUNTS = Object.freeze({
  normal_registered: 62,
  isolated_release_live: 2,
  private_memorybench_overlay: 1,
});

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
      previous.localeCompare(row.sourcePath, "en") > 0
    ) {
      throw new Error("DEPLOYED_TEST_INVENTORY_SCHEMA");
    }
    paths.add(row.sourcePath);
    counts[row.class] += 1;
    previous = row.sourcePath;
    if (row.restoreState === "isolated_canary_adapted" && !staged.has(row.syntheticTarget)) {
      throw new Error("TASK2_STAGE_PATH_INVENTORY");
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
  ["compat/embedding-identity-test.js", "7"],
  ["compat/full-registry-migration-test.js", "4"],
  ["compat/generated-surface-test.js", "5"],
  ["compat/memory-api-projection-test.js", "11"],
  ["compat/native-lock-concurrency-test.js", "6"],
  ["compat/native-metadata-promotion-test.js", "6"],
  ["compat/observational-diagnostics-test.js", "12"],
  ["compat/openclaw-hooks-and-flush-test.js", "5"],
  ["compat/openclaw-memory-runtime-test.js", "5"],
  ["compat/rollback-restore-test.js", "4"],
  ["compat/scope-visibility-matrix-test.js", "5"],
];

const descriptor = (file, ownerTask, runner = "module", testClass = "normal") => Object.freeze({
  class: testClass,
  file,
  ownerTask,
  runner,
});

export const NORMAL_TEST_DESCRIPTORS = Object.freeze([
  ...PUBLIC_TEST_FILES.map((file) => descriptor(file, "upstream")),
  ...COMPATIBILITY_TESTS.map(([file, owner]) => descriptor(file, owner)),
  descriptor("full-test-inventory-contract-test.js", "2B"),
  descriptor("npm-pack-parser-test.js", "2B"),
  descriptor("private-test-restoration-test.js", "2B"),
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

validateDeployedInventory();

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsRoot, "..");
const args = process.argv.slice(2);
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

function discoverTests(directory = testsRoot, prefix = "") {
  const discovered = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      discovered.push(...discoverTests(path.join(directory, entry.name), relative));
    } else if (entry.isFile() && entry.name.endsWith("-test.js")) {
      discovered.push(relative);
    }
  }
  return discovered.sort((left, right) => left.localeCompare(right, "en"));
}

function readFilters() {
  const filters = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    if (value === "--filter" && args[index + 1]) {
      filters.push(String(args[index + 1]));
      index += 1;
    } else if (value.startsWith("--filter=")) {
      filters.push(value.slice("--filter=".length));
    }
  }
  return filters
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

async function runModuleTest(file) {
  const modulePath = pathToFileURL(path.join(testsRoot, file)).href;
  const testModule = await import(modulePath);
  if (typeof testModule.run !== "function") throw new Error(`TEST_RUNNER_MISSING_EXPORT ${file}`);
  await testModule.run();
}

function runScriptTest(file) {
  const result = spawnSync(process.execPath, [path.join(testsRoot, file)], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = String(result.stderr || result.stdout || "").trim();
    throw new Error(`SCRIPT_TEST_FAILED ${file}${output ? `: ${output}` : ""}`);
  }
}

async function execute(descriptor) {
  if (descriptor.runner === "script") return runScriptTest(descriptor.file);
  if (descriptor.runner === "module") return runModuleTest(descriptor.file);
  throw new Error(`TEST_RUNNER_UNKNOWN ${descriptor.file}`);
}

async function main() {
  const discovered = discoverTests();
  const fullInventoryPath = path.join(testsRoot, "full-test-inventory.js");
  const publicMatches = discovered.length === PUBLIC_TEST_FILES.length
    && [...discovered].sort().every((file, index) => file === [...PUBLIC_TEST_FILES].sort()[index]);
  let inventory = null;
  if (fs.existsSync(fullInventoryPath)) {
    inventory = await import(pathToFileURL(fullInventoryPath).href);
    try {
      inventory.validatePhysicalInventory(discovered, inventory.PHYSICAL_TEST_DESCRIPTORS);
    } catch (error) {
      if (!publicMatches) {
        throw new Error(`Test inventory matches neither the full nor public suite.\n${error.message}`);
      }
      inventory = null;
    }
  } else if (!publicMatches) {
    throw new Error("Test inventory matches neither the full nor public suite.");
  }
  const inventoryMode = inventory ? "private-compatibility" : "public";
  const releaseLive = args.includes("--release-live");
  const releaseAcceptance = args.includes("--release-acceptance")
    || process.env.GIGABRAIN_RELEASE_ACCEPTANCE === "1";
  if (!inventory && releaseLive) throw new Error("Release-live inventory is unavailable in the public suite.");
  let expectedFailures = new Map();
  if (inventory) {
    const expectedDocument = JSON.parse(
      fs.readFileSync(path.join(testsRoot, "compat", "expected-failures.json"), "utf8"),
    );
    if (expectedDocument.schemaVersion !== 1) throw new Error("EXPECTED_FAILURE_SCHEMA_VERSION");
    expectedFailures = inventory.validateExpectedFailureManifest(
      expectedDocument.entries,
      inventory.NORMAL_TEST_DESCRIPTORS,
      releaseAcceptance,
    );
  }
  const publicDescriptors = PUBLIC_TEST_FILES.map((file) => ({ file, ownerTask: "upstream", runner: "module" }));
  const descriptors = inventory
    ? (releaseLive ? inventory.RELEASE_LIVE_TEST_DESCRIPTORS : inventory.NORMAL_TEST_DESCRIPTORS)
    : publicDescriptors;
  const filters = readFilters();
  const selected = filters.length === 0
    ? descriptors
    : descriptors.filter((row) => filters.some((filter) => row.file.includes(filter)));
  if (selected.length === 0 && !args.includes("--inventory-only")) {
    throw new Error(`No tests matched filter(s): ${filters.join(", ")}`);
  }
  if (args.includes("--inventory-only")) {
    const output = inventory ? {
      deployedClasses: { isolated_release_live: 2, normal_registered: 62, private_memorybench_overlay: 1 },
      expectedFailures: expectedFailures.size,
      inventoryMode,
      normalTests: inventory.NORMAL_TEST_DESCRIPTORS.length,
      ok: true,
      physicalTests: inventory.PHYSICAL_TEST_DESCRIPTORS.length,
      releaseLiveTests: inventory.RELEASE_LIVE_TEST_DESCRIPTORS.length,
    } : {
      inventoryMode,
      ok: true,
      tests: PUBLIC_TEST_FILES,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  const results = [];
  for (const descriptor of selected) {
    const started = Date.now();
    let failure = null;
    try {
      await execute(descriptor);
    } catch (error) {
      failure = error;
    }
    const expected = expectedFailures.get(descriptor.file);
    if (expected) {
      const status = inventory.classifyExpectedOutcome(expected, failure);
      results.push({ elapsedMs: Date.now() - started, status, test: descriptor.file });
      continue;
    }
    if (failure) throw failure;
    results.push({ elapsedMs: Date.now() - started, status: "passed", test: descriptor.file });
  }
  process.stdout.write(`${JSON.stringify({
    filters,
    inventoryMode,
    ok: true,
    releaseLive,
    suite: "gigabrain-v0.11-source-first",
    tests: results,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

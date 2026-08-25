import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OWNER_TASK = "2B";

export async function run() {
  const inventoryPath = path.join(import.meta.dirname, "full-test-inventory.js");
  assert.ok(existsSync(inventoryPath), "TASK2_INVENTORY_RED missing full-test-inventory.js");
  const inventory = await import(`${pathToFileURL(inventoryPath).href}?contract=${Date.now()}`);
  assert.deepEqual(inventory.DEPLOYED_CLASS_COUNTS, {
    normal_registered: 62,
    isolated_release_live: 2,
    private_memorybench_overlay: 1,
  });
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const baseline = JSON.parse(readFileSync(path.join(repoRoot, "eval", "baseline.json"), "utf8"));
  assert.deepEqual(baseline.thresholds, {
    maxInstructionLeaks: 0,
    maxJunkWrapperLeaks: 0,
    maxMemoryMdPrivacyLeaks: 0,
    maxProvenanceLeaks: 0,
    maxTranscriptLeaks: 0,
    minCasePassRate: 0.9,
  });
  const evalResult = JSON.parse(execFileSync(
    process.execPath,
    [path.join(repoRoot, "eval", "run-deep-recall-eval.js")],
    { encoding: "utf8", timeout: 10_000 },
  ));
  assert.equal(evalResult.ok, true);
  assert.equal(evalResult.caseCount, 2);
  assert.doesNotThrow(() => execFileSync(
    "git",
    ["add", "--dry-run", "--pathspec-from-file=config/migration/task2-stage-paths.txt"],
    { cwd: repoRoot, stdio: "ignore", timeout: 10_000 },
  ));

  const descriptors = [{ file: "compat/example-test.js", ownerTask: "8", runner: "module" }];
  const entry = { test: "compat/example-test.js", ownerTask: "8", signature: "EXPECTED red" };
  assert.throws(
    () => inventory.validateExpectedFailureManifest([entry], [], false),
    /EXPECTED_FAILURE_UNKNOWN_TEST/,
  );
  assert.throws(
    () => inventory.validateExpectedFailureManifest([{ ...entry, ownerTask: "9" }], descriptors, false),
    /EXPECTED_FAILURE_STALE_OWNER/,
  );
  assert.throws(
    () => inventory.validateExpectedFailureManifest([entry], descriptors, true),
    /EXPECTED_FAILURE_RELEASE_BLOCKED/,
  );
  assert.throws(
    () => inventory.classifyExpectedOutcome(entry, null),
    /EXPECTED_FAILURE_XPASS/,
  );
  assert.throws(
    () => inventory.classifyExpectedOutcome(entry, new Error("different")),
    /EXPECTED_FAILURE_SIGNATURE_CHANGED/,
  );
  assert.equal(inventory.classifyExpectedOutcome(entry, new Error("EXPECTED red")), "xfail");
  assert.throws(
    () => inventory.validatePhysicalInventory(["compat/unregistered-test.js"], descriptors),
    /TEST_INVENTORY_UNCLASSIFIED/,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  run().then(
    () => process.stdout.write("full-test-inventory-contract-test: ok\n"),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

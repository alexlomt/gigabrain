import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

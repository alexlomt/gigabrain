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
  const deployed = JSON.parse(readFileSync(
    path.join(repoRoot, "config", "migration", "deployed-test-inventory.json"),
    "utf8",
  ));
  const deployedNormal = deployed.tests.filter((row) => row.class === "normal_registered");
  const missingNormalTargets = deployedNormal
    .filter((row) => !existsSync(path.join(repoRoot, row.syntheticTarget)))
    .map((row) => row.syntheticTarget);
  assert.deepEqual(
    missingNormalTargets,
    [],
    `DEPLOYED_NORMAL_TARGET_MISSING ${missingNormalTargets.join(",")}`,
  );
  const registered = new Set(inventory.NORMAL_TEST_DESCRIPTORS.map((row) => row.file));
  const unregisteredNormalTargets = deployedNormal
    .map((row) => row.syntheticTarget.replace(/^tests\//, ""))
    .filter((target) => !registered.has(target));
  assert.deepEqual(
    unregisteredNormalTargets,
    [],
    `DEPLOYED_NORMAL_TARGET_UNREGISTERED ${unregisteredNormalTargets.join(",")}`,
  );
  assert.equal(inventory.DEPLOYED_NORMAL_TEST_FILES.length, 62);
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

  const task14Contracts = [
    "compat/full-registry-migration-test.js",
    "compat/rollback-restore-test.js",
  ];
  const expectedFailures = JSON.parse(readFileSync(
    path.join(repoRoot, "tests", "compat", "expected-failures.json"),
    "utf8",
  ));
  const sourceRegistry = JSON.parse(readFileSync(
    path.join(repoRoot, "config", "migration", "source-first-test-registry.json"),
    "utf8",
  ));
  const portMap = JSON.parse(readFileSync(
    path.join(repoRoot, "config", "migration", "source-first-port-map.json"),
    "utf8",
  ));
  for (const file of task14Contracts) {
    assert.equal(inventory.NORMAL_TEST_DESCRIPTORS.find((row) => row.file === file)?.ownerTask, "14");
    assert.equal(expectedFailures.entries.find((row) => row.test === file)?.ownerTask, "14");
    assert.equal(
      sourceRegistry.entries.find((row) => row.testPath === `tests/${file}`)?.ownerSourceFirstTaskId,
      "14",
    );
    const candidate = portMap.candidateChanges.find((row) => row.targetPath === `tests/${file}`);
    assert.equal(candidate?.ownerTasks.includes("14"), true);
    assert.equal(candidate?.ownerTasks.includes("4"), false);
  }
  const mutuallyWrongDescriptor = [{
    file: "compat/full-registry-migration-test.js",
    ownerTask: "4",
    runner: "module",
  }];
  const mutuallyWrongEntry = [{
    test: "compat/full-registry-migration-test.js",
    ownerTask: "4",
    signature: "MUTUALLY_WRONG_OWNER",
  }];
  assert.throws(
    () => inventory.validateExpectedFailureManifest(mutuallyWrongEntry, mutuallyWrongDescriptor, false),
    /EXPECTED_FAILURE_STALE_OWNER/,
    "mutually consistent wrong owner labels must not bypass the canonical source-first plan",
  );

  const canonicalCompatibilityOwners = new Map([
    ["compat/generated-surface-test.js", "10"],
    ["compat/observational-diagnostics-test.js", "5"],
  ]);
  for (const [file, owner] of canonicalCompatibilityOwners) {
    assert.equal(inventory.NORMAL_TEST_DESCRIPTORS.find((row) => row.file === file)?.ownerTask, owner);
    assert.equal(expectedFailures.entries.find((row) => row.test === file)?.ownerTask, owner);
    assert.equal(
      sourceRegistry.entries.find((row) => row.testPath === `tests/${file}`)?.ownerSourceFirstTaskId,
      owner,
    );
    assert.equal(
      portMap.candidateChanges.find((row) => row.targetPath === `tests/${file}`)?.ownerTasks.includes(owner),
      true,
    );
  }
  const generatedWrongDescriptor = [{
    file: "compat/generated-surface-test.js",
    ownerTask: "5",
    runner: "module",
  }];
  const generatedWrongEntry = [{
    test: "compat/generated-surface-test.js",
    ownerTask: "5",
    signature: "MUTUALLY_WRONG_GENERATED_OWNER",
  }];
  assert.throws(
    () => inventory.validateExpectedFailureManifest(generatedWrongEntry, generatedWrongDescriptor, false),
    /EXPECTED_FAILURE_STALE_OWNER/,
    "mutually consistent Task-5 generated-surface ownership must fail",
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

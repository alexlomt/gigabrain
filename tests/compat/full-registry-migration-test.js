import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "4";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_FULL_MIGRATION missing source-first registry migration receipt";

export async function run() {
  const migration = await importContractModule("lib/compat/registry-migration.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const migrate = requireCallable(migration, "migrateRegistrySnapshot");
    const original = {
      memories: [{ content: "Synthetic memory", id: "m1", scope: "main" }],
      schemaVersion: 0,
    };
    const migrated = migrate(original);
    assert.deepEqual(migrated.snapshot, {
      memories: [{ content: "Synthetic memory", id: "m1", scope: "profile:main" }],
      schemaVersion: 11,
    });
    assert.deepEqual(migrated.receipt, {
      fromVersion: 0,
      migratedRows: 1,
      toVersion: 11,
    });
    assert.deepEqual(original, {
      memories: [{ content: "Synthetic memory", id: "m1", scope: "main" }],
      schemaVersion: 0,
    });
    assert.deepEqual(migrate(migrated.snapshot).receipt, {
      fromVersion: 11,
      migratedRows: 0,
      toVersion: 11,
    });
  });
}

runDirect(import.meta.url, run);

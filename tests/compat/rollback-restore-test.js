import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "4";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_ROLLBACK_RESTORE missing verified rollback restoration";

export async function run() {
  const rollback = await importContractModule("lib/compat/rollback-restore.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const createBundle = requireCallable(rollback, "createRollbackBundle");
    const restoreBundle = requireCallable(rollback, "restoreRollbackBundle");
    const original = {
      "config.json": "{\"version\":1}\n",
      "registry.json": "{\"memories\":1}\n",
    };
    const bundle = createBundle(original);
    assert.match(bundle.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(restoreBundle(bundle), original);
    assert.throws(
      () => restoreBundle({ ...bundle, files: { ...bundle.files, "config.json": "tampered\n" } }),
      /checksum/i,
    );
  });
}

runDirect(import.meta.url, run);

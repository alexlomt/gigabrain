import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "9";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_AUTO_CAPTURE missing durable bounded capture worker";

export async function run() {
  const queue = await importContractModule("lib/compat/auto-capture-queue.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    assert.equal(typeof requireCallable(queue, "enqueueAutoCaptureEvent"), "function");
    assert.equal(typeof requireCallable(queue, "processAutoCaptureQueue"), "function");
  });
}

runDirect(import.meta.url, run);

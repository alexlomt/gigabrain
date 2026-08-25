import assert from "node:assert/strict";

import { requireCallable, runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "2B";

export async function run() {
  await assert.rejects(
    () => runBehaviorContract("OWNED_BEHAVIOR_SIGNATURE", async () => {
      const noOpExport = () => undefined;
      requireCallable({ noOpExport }, "noOpExport")();
      assert.equal(noOpExport(), "required-result");
    }),
    (error) => error instanceof Error && error.message === "OWNED_BEHAVIOR_SIGNATURE",
  );
  await assert.doesNotReject(() => runBehaviorContract("OWNED_BEHAVIOR_SIGNATURE", async () => {
    const behavior = (value) => ({ normalized: value.trim().toLowerCase() });
    assert.deepEqual(behavior(" Synthetic "), { normalized: "synthetic" });
  }));
}

runDirect(import.meta.url, run);

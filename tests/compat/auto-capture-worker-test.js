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
  const capture = await importContractModule("lib/compat/auto-capture-policy.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const classify = requireCallable(capture, "classifyAutoCaptureCandidate");
    assert.deepEqual(
      classify({ content: "Remember that the synthetic harbour review is weekly.", role: "user" }),
      { action: "save", reason: "explicit_durable_request" },
    );
    assert.deepEqual(
      classify({ content: "Thanks!", role: "assistant" }),
      { action: "reject", reason: "transient_or_assistant" },
    );
    assert.deepEqual(
      classify({ content: "Remember synthetic-token-value", containsSecret: true, role: "user" }),
      { action: "reject", reason: "sensitive" },
    );
  });
}

runDirect(import.meta.url, run);

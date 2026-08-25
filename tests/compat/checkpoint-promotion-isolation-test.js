import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "6";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_CHECKPOINT_ISOLATION missing metadata-gated checkpoint promotion";

export async function run() {
  const metadata = await importContractModule("lib/compat/native-metadata.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const shouldPromote = requireCallable(metadata, "shouldPromoteNativeRecord");
    assert.equal(shouldPromote({ kind: "daily_note", metadata: { type: "DECISION" } }), true);
    assert.equal(shouldPromote({ kind: "session_checkpoint", metadata: { type: "EPISODE" } }), false);
    assert.equal(
      shouldPromote({ kind: "session_checkpoint", metadata: { promote: true, type: "EPISODE" } }),
      true,
    );
    assert.equal(shouldPromote({ kind: "daily_note", metadata: {} }), false);
  });
}

runDirect(import.meta.url, run);

import assert from "node:assert/strict";
import { detectSecretRisks, redactedPreview } from "../lib/core/handoff-record.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const credential = `${"sk-"}${"example"}${"A".repeat(20)}`;
  const preview = redactedPreview(`Synthetic contact synthetic@example.com with token ${credential}`);
  assert.doesNotMatch(preview, /synthetic@example\.com/);
  assert.doesNotMatch(preview, /sk-example/);
  const risks = detectSecretRisks([{ content: "Synthetic safe memory", memory_id: "m1" }]);
  assert.deepEqual(risks, []);
}
runDirect(import.meta.url, run);

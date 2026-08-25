import assert from "node:assert/strict";
import { parseMemoryActions } from "../lib/core/memory-actions.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const actions = parseMemoryActions('<memory_action action="remember" type="DECISION" confidence="high" scope="profile:synthetic">Use the harbour plan.</memory_action>');
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    action: "remember",
    confidence: 0.9,
    content: "Use the harbour plan.",
    durability: "auto",
    raw_tag: "memory_action",
    reason: "",
    scope: "profile:synthetic",
    target: "",
    target_memory_id: "",
    type: "DECISION",
  });
  assert.deepEqual(parseMemoryActions("<memory_action action=invalid>ignored</memory_action>"), []);
}
runDirect(import.meta.url, run);

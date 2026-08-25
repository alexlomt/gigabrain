import assert from "node:assert/strict";
import { buildSupportingMemoryLines, classifyQueryIntent } from "../lib/core/orchestrator.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.deepEqual(classifyQueryIntent("Where is the exact wording written?"), {
    reason: "source_or_exactness",
    requiresDeepLookup: true,
    strategy: "verification_lookup",
  });
  assert.equal(classifyQueryIntent("Tell me about Synthetic Project").strategy, "entity_brief");
  const lines = buildSupportingMemoryLines([{ content: "Synthetic fact", source_layer: "native", type: "CONTEXT" }]);
  assert.match(lines[0], /CONTEXT\|native/);
}
runDirect(import.meta.url, run);

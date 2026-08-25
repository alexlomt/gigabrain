import assert from "node:assert/strict";
import { classifyValue, detectJunk, normalizeContent } from "../lib/core/policy.js";
import { normalizeConfig } from "../lib/core/config.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(normalizeContent("  Synthetic   Harbour! "), "synthetic harbour");
  assert.equal(detectJunk("<tool_output>Synthetic output</tool_output>").junk, true);
  assert.equal(detectJunk("The synthetic harbour review is weekly and requires a signed owner.").junk, false);
  assert.equal(typeof classifyValue, "function");
  assert.throws(() => normalizeConfig({ memoryRegistryPath: "/tmp/legacy.sqlite" }), /deprecated/i);
}
runDirect(import.meta.url, run);

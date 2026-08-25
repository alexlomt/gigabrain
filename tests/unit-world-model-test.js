import assert from "node:assert/strict";
import { isBriefEligibleScope, isDurableMemoryTier, normalizeMemoryTier, resolveMemoryTier } from "../lib/core/world-model.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(normalizeMemoryTier("DURABLE_PROJECT"), "durable_project");
  assert.equal(isDurableMemoryTier("durable_project"), true);
  assert.equal(isDurableMemoryTier("working_reference"), false);
  assert.equal(resolveMemoryTier({ row: { content: "Project codename Synthetic Harbour", type: "CONTEXT" } }), "durable_project");
  assert.equal(isBriefEligibleScope({ payload: { scope: "profile:synthetic" } }), true);
  assert.equal(isBriefEligibleScope({ payload: { scope: "project:synthetic" } }), false);
}
runDirect(import.meta.url, run);

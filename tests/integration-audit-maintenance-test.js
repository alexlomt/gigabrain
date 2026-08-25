import assert from "node:assert/strict";
import { DAILY_SEQUENCE } from "../lib/core/maintenance-service.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(new Set(DAILY_SEQUENCE).size, DAILY_SEQUENCE.length);
  assert.ok(DAILY_SEQUENCE.indexOf("wiki_reconcile") < DAILY_SEQUENCE.indexOf("belief_refresh"));
  assert.ok(DAILY_SEQUENCE.indexOf("belief_refresh") < DAILY_SEQUENCE.indexOf("wiki_project"));
  assert.equal(DAILY_SEQUENCE.at(-1), "graph_build");
}
runDirect(import.meta.url, run);

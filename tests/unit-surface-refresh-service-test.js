import assert from "node:assert/strict";
import { pickSurfaceSummaryBelief, selectSurfaceBeliefsForEntity } from "../lib/core/world-model.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const entity = { aliases: ["synthetic harbour"], kind: "project", normalized_name: "synthetic harbour" };
  const beliefs = [
    { confidence: 0.95, content: "Synthetic Harbour project uses the blue release plan.", payload: { claim_slot: "project.plan", memory_tier: "durable_project", scope: "shared", surface_candidate: true }, status: "current", type: "project" },
    { content: "Unrelated stale plan.", payload: { claim_slot: "project.plan", scope: "shared" }, status: "superseded", type: "project" },
  ];
  const selected = selectSurfaceBeliefsForEntity(entity, beliefs, 5);
  assert.equal(selected.length, 1);
  assert.match(selected[0].content, /blue release plan/);
  assert.equal(pickSurfaceSummaryBelief(entity, beliefs)?.content, selected[0].content);
}
runDirect(import.meta.url, run);

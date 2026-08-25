import assert from "node:assert/strict";
import { beliefHostTrustBonus, beliefPriorityScore, beliefTrustTier } from "../lib/core/belief-arbitration.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const human = { confidence: 0.9, source_host: "human_wiki", source_layer: "native" };
  const cloud = { confidence: 0.9, source_host: "cloud_manual", source_layer: "host_memory" };
  const settings = { hostTrust: { cloud_manual: 0, human_wiki: 1 }, trustConfig: {} };
  assert.ok(beliefTrustTier(human, settings) > beliefTrustTier(cloud, settings));
  assert.ok(beliefHostTrustBonus(human, settings) > beliefHostTrustBonus(cloud, settings));
  assert.ok(beliefPriorityScore(human, settings) > beliefPriorityScore(cloud, settings));
}
runDirect(import.meta.url, run);

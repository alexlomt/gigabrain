import assert from "node:assert/strict";
import { classifyHostTier, hostTrustScore, ingestConfidence, isRegisteredAgent } from "../lib/core/host-trust.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(classifyHostTier("human_wiki"), "human");
  assert.equal(classifyHostTier("cloud_manual"), "manual_import");
  assert.ok(hostTrustScore("human_wiki") > hostTrustScore("cloud_manual"));
  assert.ok(ingestConfidence("human_wiki", "native_memory") > ingestConfidence("cloud_manual", "manual_import"));
  assert.equal(classifyHostTier("nimbus"), "own_agent");
  assert.equal(classifyHostTier("nimbus_fake"), "unknown");
  assert.equal(classifyHostTier("codex_fake9000"), "unknown");
  const config = {
    agentRegistry: [
      "paperclip-ceo",
      "scrapling-research-operator",
      "higgsfield-creator",
      "linkedin-public-evidence-operator",
    ],
  };
  for (const agent of config.agentRegistry) assert.equal(isRegisteredAgent(agent, config), true);
  assert.equal(isRegisteredAgent("paperclip-ceo-lookalike", config), false);
  assert.equal(isRegisteredAgent("nimbus_fake", config), false);
}
runDirect(import.meta.url, run);

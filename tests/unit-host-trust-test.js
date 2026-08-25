import assert from "node:assert/strict";
import { classifyHostTier, hostTrustScore, ingestConfidence } from "../lib/core/host-trust.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(classifyHostTier("human_wiki"), "human");
  assert.equal(classifyHostTier("cloud_manual"), "manual_import");
  assert.ok(hostTrustScore("human_wiki") > hostTrustScore("cloud_manual"));
  assert.ok(ingestConfidence("human_wiki", "native_memory") > ingestConfidence("cloud_manual", "manual_import"));
}
runDirect(import.meta.url, run);

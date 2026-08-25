import assert from "node:assert/strict";
import { classifyPersonRole, containsEntity, looksGermanContent, splitNameCandidates } from "../lib/core/person-service.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(classifyPersonRole("Synthetic Person is a thoughtful coach."), "public_profile");
  assert.equal(classifyPersonRole("Run the synthetic migration pipeline."), "ops_noise");
  assert.equal(containsEntity("Synthetic Person prefers concise output", "synthetic person"), true);
  assert.equal(looksGermanContent("Das ist eine synthetische Notiz"), true);
  assert.ok(splitNameCandidates("Project Synthetic Harbour works with Mira Vexley").includes("mira vexley"));
}
runDirect(import.meta.url, run);

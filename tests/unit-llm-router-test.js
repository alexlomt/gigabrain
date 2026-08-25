import assert from "node:assert/strict";
import { normalizeProvider, normalizeTaskProfiles, resolveTaskProfile } from "../lib/core/llm-router.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(normalizeProvider("OLLAMA"), "ollama");
  assert.equal(normalizeProvider("unsupported"), "none");
  const profiles = normalizeTaskProfiles({ memory_review: { max_tokens: 9, temperature: 2 } });
  assert.equal(profiles.memory_review.max_tokens, 32);
  assert.equal(profiles.memory_review.temperature, 1);
  const resolved = resolveTaskProfile({ profile: "memory_review", taskProfiles: profiles });
  assert.equal(resolved.model, profiles.memory_review.model);
}
runDirect(import.meta.url, run);

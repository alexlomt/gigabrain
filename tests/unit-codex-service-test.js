import assert from "node:assert/strict";
import { mergeAnnotatedResults, resolveReadStoreQueries } from "../lib/core/codex-service.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const merged = mergeAnnotatedResults([
    { origin: "project", results: [{ content: "Synthetic harbour", memory_id: "project:m1", origin: "project", relevance: {} }] },
    { origin: "user", results: [{ content: "Synthetic harbour", memory_id: "user:m1", origin: "user", relevance: {} }] },
  ], 8, "synthetic harbour");
  assert.equal(merged.length, 1);
  assert.equal(merged[0].origin, "project");
  assert.equal(typeof resolveReadStoreQueries, "function");
}
runDirect(import.meta.url, run);

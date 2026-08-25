import assert from "node:assert/strict";
import { buildExtractionPrompt, parseExtraction } from "../lib/core/llm-router.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const prompt = buildExtractionPrompt("User: remember the synthetic harbour review.");
  assert.match(prompt, /JSON/i);
  assert.doesNotMatch(prompt, /api[_-]?key/i);
  const parsed = parseExtraction('{"facts":[{"content":"Synthetic harbour review","type":"CONTEXT","confidence":0.8}]}');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].content, "Synthetic harbour review");
  assert.deepEqual(parseExtraction("not-json"), []);
}
runDirect(import.meta.url, run);

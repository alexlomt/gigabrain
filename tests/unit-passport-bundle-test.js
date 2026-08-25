import assert from "node:assert/strict";
import { BUNDLE_KIND, computeContentHash, EMBEDDING_CONTRACT, SCHEMA_VERSION } from "../lib/core/handoff-bundle.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(BUNDLE_KIND, "gigabrain.memory-passport-bundle");
  assert.equal(SCHEMA_VERSION, "1.0");
  assert.equal(EMBEDDING_CONTRACT, "re-embed-on-import");
  const first = computeContentHash([{ content: "Synthetic one", id: "m1" }, { content: "Synthetic two", id: "m2" }]);
  const second = computeContentHash([{ content: "Synthetic two", id: "m2" }, { content: "Synthetic one", id: "m1" }]);
  assert.notEqual(first, second);
}
runDirect(import.meta.url, run);

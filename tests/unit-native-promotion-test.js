import assert from "node:assert/strict";
import { inferChunkScope, inferChunkType } from "../lib/core/native-promotion.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(inferChunkType({ content: "We decided to use synthetic blue.", section: "" }), "DECISION");
  assert.equal(inferChunkType({ content: "The user prefers concise output.", section: "Preferences" }), "PREFERENCE");
  assert.equal(inferChunkScope({ scope: "project:synthetic" }), "project:synthetic");
  assert.equal(inferChunkScope({ scope: "" }), "shared");
}
runDirect(import.meta.url, run);

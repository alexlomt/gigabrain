import assert from "node:assert/strict";
import { inferChunkScope, inferChunkType } from "../lib/core/native-promotion.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(inferChunkType({ content: "Decision: use the synthetic harbour plan", section: "Decisions" }), "DECISION");
  assert.equal(inferChunkType({ content: "Synthetic background", section: "Context" }), "USER_FACT");
  assert.equal(inferChunkScope({ scope: "profile:synthetic", source_path: "memory/2026-08-25.md" }), "profile:synthetic");
  assert.equal(inferChunkScope({ scope: "", source_kind: "memory_md", source_path: "MEMORY.md" }), "profile:main");
}
runDirect(import.meta.url, run);

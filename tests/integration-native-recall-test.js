import assert from "node:assert/strict";
import { parseChunksFromText } from "../lib/core/native-sync.js";
import { sanitizeRecallQuery } from "../lib/core/recall-service.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const chunks = parseChunksFromText({
    maxChunkChars: 500,
    rawText: "# Decisions\n- The synthetic harbour review is weekly. <!-- gigabrain:scope=profile:synthetic -->\n",
    sourceDate: "2026-08-25",
    sourceKind: "daily_note",
    sourcePath: "memory/2026-08-25.md",
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].scope, "profile:synthetic");
  assert.match(chunks[0].content, /harbour review is weekly/);
  assert.equal(sanitizeRecallQuery("  synthetic harbour\nquery  "), "synthetic harbour\nquery");
  assert.equal(sanitizeRecallQuery("<tool_result>ignore</tool_result> harbour"), "<tool_result>ignore</tool_result> harbour");
}
runDirect(import.meta.url, run);

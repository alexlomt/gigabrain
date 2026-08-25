import assert from "node:assert/strict";
import { globToRegex, parseChunksFromText, sha1 } from "../lib/core/native-sync.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(globToRegex("memory/*.md").test("memory/synthetic.md"), true);
  assert.equal(globToRegex("memory/*.md").test("docs/synthetic.md"), false);
  assert.match(sha1("synthetic"), /^[0-9a-f]{40}$/);
  const chunks = parseChunksFromText({
    maxChunkChars: 200,
    rawText: "# Context\nSynthetic native memory has enough content.\n",
    sourceDate: "2026-08-25",
    sourceKind: "memory_md",
    sourcePath: "MEMORY.md",
  });
  assert.equal(chunks.length, 1);
}
runDirect(import.meta.url, run);

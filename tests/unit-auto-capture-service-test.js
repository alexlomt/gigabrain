import assert from "node:assert/strict";
import { inferTypeFromContent, parseMemoryNotes } from "../lib/core/capture-service.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const notes = parseMemoryNotes('<memory_note type="DECISION" confidence="0.9">Use the synthetic harbour plan.</memory_note>');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, "DECISION");
  assert.equal(notes[0].content, "Use the synthetic harbour plan.");
  assert.equal(inferTypeFromContent("The user prefers concise status updates"), "PREFERENCE");
}
runDirect(import.meta.url, run);

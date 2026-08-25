import assert from "node:assert/strict";
import { normalizeHost, normalizeKind, normalizePolicy, redactMemoryText } from "../lib/core/host-memory-sync.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(normalizeHost("Claude-Code"), "claude_code");
  assert.equal(normalizeKind("memory-md"), "native_memory");
  assert.equal(normalizePolicy("ALLOW_ALL"), "read_only");
  const redacted = redactMemoryText(`Token: ${"sk-"}${"example"}${"A".repeat(20)}`);
  assert.doesNotMatch(redacted, /sk-example/);
}
runDirect(import.meta.url, run);

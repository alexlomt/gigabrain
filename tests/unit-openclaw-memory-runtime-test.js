import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot, runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "openclaw.plugin.json"), "utf8"));
  assert.equal(manifest.id, "gigabrain");
  assert.equal(manifest.kind, "memory");
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.equal(manifest.configSchema.properties.recall.properties.autoInjectEnabled.default, false);
  assert.equal(manifest.configSchema.properties.capture.properties.requireMemoryNote.default, true);
  assert.equal(manifest.configSchema.properties.quality.properties.junkFilterEnabled.default, true);
}
runDirect(import.meta.url, run);

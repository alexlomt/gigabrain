import assert from "node:assert/strict";
import { normalizeConfig } from "../lib/core/config.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const config = normalizeConfig({
    dedupe: { autoThreshold: 0.8, reviewThreshold: 0.9 },
    runtime: { paths: { workspaceRoot: "/tmp/synthetic-workspace" } },
  });
  assert.ok(config.dedupe.autoThreshold >= config.dedupe.reviewThreshold);
  assert.equal(config.runtime.paths.workspaceRoot, "/tmp/synthetic-workspace");
  assert.equal(config.native.syncMode, "hybrid");
  assert.throws(() => normalizeConfig({ memoryRegistryPath: "/tmp/legacy.sqlite" }), /deprecated/i);
}
runDirect(import.meta.url, run);

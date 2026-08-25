import assert from "node:assert/strict";
import { resolveRuntimeStandaloneConfigPath } from "../lib/core/standalone-client.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.deepEqual(resolveRuntimeStandaloneConfigPath("/tmp/synthetic/config.json"), {
    attemptedPath: "/tmp/synthetic/config.json",
    fallbackKind: "missing",
    fallbackUsed: false,
    inputPath: "/tmp/synthetic/config.json",
    resolvedPath: "/tmp/synthetic/config.json",
  });
  assert.equal(resolveRuntimeStandaloneConfigPath("relative/config.json").fallbackKind, "missing");
}
runDirect(import.meta.url, run);

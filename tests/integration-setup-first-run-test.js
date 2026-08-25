import assert from "node:assert/strict";
import { defaultStandaloneConfigPathForStore, normalizeStandaloneStoreMode } from "../lib/core/standalone-client.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(normalizeStandaloneStoreMode("shared"), "global");
  assert.equal(normalizeStandaloneStoreMode("project-local"), "project_local");
  assert.equal(
    defaultStandaloneConfigPathForStore("/tmp/synthetic-store"),
    "/tmp/synthetic-store/config.json",
  );
}
runDirect(import.meta.url, run);

import assert from "node:assert/strict";
import { resolveSessionSettingsPath } from "../lib/core/lifecycle-hooks.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const settings = resolveSessionSettingsPath({
    cwd: "/tmp/synthetic-project",
    homeDir: "/tmp/synthetic-home",
  });
  assert.equal(settings, "/tmp/synthetic-home/.claude/settings.json");
  assert.doesNotMatch(settings, /\.codex/);
}
runDirect(import.meta.url, run);

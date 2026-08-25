import assert from "node:assert/strict";
import { buildSessionHookGroup, isGigabrainHookGroup, SESSION_HOOK_EVENTS } from "../lib/core/lifecycle-hooks.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const group = buildSessionHookGroup({
    checkpointScript: "/tmp/synthetic-checkpoint.js",
    configPath: "/tmp/synthetic-config.json",
    nodeBin: "/usr/bin/node",
  });
  assert.equal(isGigabrainHookGroup(group), true);
  assert.deepEqual(SESSION_HOOK_EVENTS, ["SessionEnd", "PreCompact"]);
  assert.match(group.hooks[0].command, /--surface claude/);
  assert.match(group.hooks[0].command, /--claude-hook-input/);
}
runDirect(import.meta.url, run);

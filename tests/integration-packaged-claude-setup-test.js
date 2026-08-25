import assert from "node:assert/strict";
import { buildSessionHookCommand } from "../lib/core/lifecycle-hooks.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const command = buildSessionHookCommand({
    checkpointScript: "/opt/synthetic/checkpoint.js",
    configPath: "/opt/synthetic/config.json",
    nodeBin: "/usr/bin/node",
  });
  assert.match(command, /^'\/usr\/bin\/node' '\/opt\/synthetic\/checkpoint\.js'/);
  assert.match(command, /--surface claude/);
  assert.match(command, /hook-failures\.log/);
  assert.doesNotMatch(command, /_npx/);
}
runDirect(import.meta.url, run);

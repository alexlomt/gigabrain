import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot, runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["codex:mcp"], "node scripts/gigabrain-mcp.js");
  assert.equal(pkg.bin["gigabrain-mcp"], "scripts/gigabrain-mcp.js");
  assert.ok(pkg.files.includes("scripts/gigabrain-mcp.js"));
}
runDirect(import.meta.url, run);

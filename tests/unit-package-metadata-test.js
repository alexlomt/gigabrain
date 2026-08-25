import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot, runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.11.0-openclaw.1");
  assert.match(pkg.engines.node, /^>=22/);
  assert.ok(pkg.files.includes("scripts/npm-pack-inventory.mjs"));
  assert.equal(pkg.scripts["test:full"], "node tests/run-all.js");
  assert.equal(pkg.openclaw.extensions[0], "./index.ts");
}
runDirect(import.meta.url, run);

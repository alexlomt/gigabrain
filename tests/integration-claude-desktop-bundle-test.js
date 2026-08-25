import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot, runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["claude:desktop:bundle"], "node scripts/build-claude-desktop-bundle.js");
  assert.ok(pkg.files.includes("scripts/build-claude-desktop-bundle.js"));
  assert.ok(pkg.files.includes("scripts/claude-desktop-launcher.sh"));
  assert.match(
    readFileSync(path.join(repoRoot, "scripts/claude-desktop-launcher.sh"), "utf8"),
    /^#!\/bin\/sh/,
  );
}
runDirect(import.meta.url, run);

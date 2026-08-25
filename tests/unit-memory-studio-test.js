import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot, runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.files.some((entry) => String(entry).startsWith("bench/memorybench")), false);
  assert.equal(pkg.files.some((entry) => String(entry).includes("memory-studio")), false);
  const baseline = JSON.parse(readFileSync(path.join(repoRoot, "eval", "baseline.json"), "utf8"));
  assert.equal(baseline.thresholds.maxMemoryMdPrivacyLeaks, 0);
}
runDirect(import.meta.url, run);

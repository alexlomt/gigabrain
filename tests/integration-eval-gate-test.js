import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { repoRoot, runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const report = JSON.parse(execFileSync(
    process.execPath,
    [path.join(repoRoot, "eval", "run-deep-recall-eval.js")],
    { encoding: "utf8", timeout: 10_000 },
  ));
  assert.equal(report.ok, true);
  assert.equal(report.aggregate.casePassRate, 1);
  for (const [name, value] of Object.entries(report.aggregate)) {
    if (name.endsWith("Leaks")) assert.equal(value, 0, name);
  }
}
runDirect(import.meta.url, run);

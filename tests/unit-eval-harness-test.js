import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { computeNDCG5, loadEvalCases } from "../lib/core/eval-harness.js";
import { runDirect, withTempRoot } from "./restored-private-test-helpers.js";

export async function run() {
  await withTempRoot("gigabrain-eval-harness-", async (root) => {
    const casesPath = path.join(root, "cases.jsonl");
    writeFileSync(casesPath, '{"id":"one","query":"synthetic"}\ninvalid\n{"id":"two","query":"harbour"}\n');
    assert.deepEqual(loadEvalCases(casesPath).map((row) => row.id), ["one", "two"]);
  });
  const score = computeNDCG5([{ content: "miss" }, { content: "synthetic hit" }], ["hit"]);
  assert.ok(score > 0 && score < 1);
}
runDirect(import.meta.url, run);

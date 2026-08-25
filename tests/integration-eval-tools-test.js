import assert from "node:assert/strict";
import { computeHitRate, computeMRR, computeMedian, computePercentile, precisionAtK } from "../lib/core/eval-harness.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const rows = [{ content: "unrelated" }, { content: "synthetic harbour answer" }];
  assert.equal(precisionAtK(rows, ["harbour"], 2), 0.5);
  assert.equal(computeMRR(rows, ["harbour"]), 0.5);
  assert.equal(computeHitRate(rows, ["harbour"]), 1);
  assert.equal(computeMedian([4, 1, 3, 2]), 2.5);
  assert.equal(computePercentile([1, 2, 3, 4], 100), 4);
}
runDirect(import.meta.url, run);

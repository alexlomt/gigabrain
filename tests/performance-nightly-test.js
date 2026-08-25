import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { computeMedian, computePercentile } from "../lib/core/eval-harness.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const values = Array.from({ length: 10_000 }, (_, index) => (index * 17) % 997);
  const started = performance.now();
  const median = computeMedian(values);
  const p95 = computePercentile(values, 95);
  const elapsed = performance.now() - started;
  assert.ok(median >= 490 && median <= 505);
  assert.ok(p95 > median);
  assert.ok(elapsed < 500, `synthetic aggregate exceeded budget: ${elapsed}ms`);
}
runDirect(import.meta.url, run);

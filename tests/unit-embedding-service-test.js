import assert from "node:assert/strict";
import { blobToVec, cosineSimilarity, vecToBlob } from "../lib/core/embedding-service.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  const vector = [0.25, -0.5, 0.75];
  const roundTrip = blobToVec(vecToBlob(vector));
  assert.deepEqual(roundTrip.map((value) => Number(value.toFixed(2))), vector);
}
runDirect(import.meta.url, run);

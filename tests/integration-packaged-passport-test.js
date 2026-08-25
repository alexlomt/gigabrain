import assert from "node:assert/strict";
import { computeContentHash, validateBundleShape } from "../lib/core/handoff-bundle.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const records = [{ content: "Synthetic memory", id: "m1", scope: "shared" }];
  const hash = computeContentHash(records);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, computeContentHash(records.map((row) => ({ ...row }))));
  assert.throws(() => validateBundleShape({ kind: "wrong", records }), /bundle|kind/i);
}
runDirect(import.meta.url, run);

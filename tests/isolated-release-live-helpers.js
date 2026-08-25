import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function resolveInside(root, relativePath) {
  const resolved = realpathSync(path.resolve(root, relativePath));
  const prefix = `${realpathSync(root)}${path.sep}`;
  assert.ok(resolved.startsWith(prefix), "release-live input escaped the isolated canary root");
  return resolved;
}

export function verifyIsolatedCanaryReceipt(kind) {
  const canaryRoot = String(process.env.GIGABRAIN_CANARY_ROOT || "");
  assert.ok(path.isAbsolute(canaryRoot), "release-live requires an absolute GIGABRAIN_CANARY_ROOT");
  const candidatePath = resolveInside(canaryRoot, "candidate/gigabrain.tgz");
  const receiptPath = resolveInside(canaryRoot, `receipts/${kind}.json`);
  const candidateMode = statSync(candidatePath).mode & 0o777;
  assert.equal(candidateMode & 0o222, 0, "candidate release must be immutable inside the canary");
  const candidateSha256 = sha256(readFileSync(candidatePath));
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, kind);
  assert.equal(receipt.sandbox, "bubblewrap");
  assert.equal(receipt.candidateSha256, candidateSha256);
  assert.equal(receipt.productionHostTouched, false);
  assert.equal(receipt.ok, true);
  assert.ok(Number.isInteger(receipt.port) && receipt.port >= 1024 && receipt.port <= 65535);
  if (Number.isInteger(receipt.productionPort)) assert.notEqual(receipt.port, receipt.productionPort);
}

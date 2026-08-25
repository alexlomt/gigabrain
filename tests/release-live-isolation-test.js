import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyIsolatedCanaryReceipt } from "./isolated-release-live-helpers.js";

export const OWNER_TASK = "2B";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function writeCanary(root, kind, overrides = {}) {
  mkdirSync(path.join(root, "candidate"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, "receipts"), { recursive: true, mode: 0o700 });
  const candidate = Buffer.from("synthetic immutable candidate\n");
  const candidatePath = path.join(root, "candidate", "gigabrain.tgz");
  if (existsSync(candidatePath)) chmodSync(candidatePath, 0o600);
  writeFileSync(candidatePath, candidate, { mode: 0o444 });
  chmodSync(candidatePath, 0o444);
  const receipt = {
    candidateSha256: sha256(candidate),
    kind,
    ok: true,
    port: 43123,
    productionHostTouched: false,
    productionPort: 18789,
    sandbox: "bubblewrap",
    schemaVersion: 1,
    ...overrides,
  };
  writeFileSync(
    path.join(root, "receipts", `${kind}.json`),
    `${JSON.stringify(receipt)}\n`,
    { mode: 0o600 },
  );
}

export async function run() {
  const previous = process.env.GIGABRAIN_CANARY_ROOT;
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-canary-isolation-"));
  try {
    process.env.GIGABRAIN_CANARY_ROOT = root;
    for (const kind of ["release-live-codex-cli", "release-live-openclaw-install"]) {
      writeCanary(root, kind);
      assert.doesNotThrow(() => verifyIsolatedCanaryReceipt(kind));

      writeCanary(root, kind, { productionPort: undefined });
      assert.throws(() => verifyIsolatedCanaryReceipt(kind), /productionPort is required/);

      writeCanary(root, kind, { port: 43123, productionPort: 43123 });
      assert.throws(() => verifyIsolatedCanaryReceipt(kind), /alternate port/);
    }
  } finally {
    if (previous === undefined) delete process.env.GIGABRAIN_CANARY_ROOT;
    else process.env.GIGABRAIN_CANARY_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  run().then(
    () => process.stdout.write("release-live-isolation-test: ok\n"),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

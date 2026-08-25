import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "6";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_NATIVE_LOCK missing cross-process native-memory lock";

export async function run() {
  const nativeMemory = await importContractModule("lib/core/native-memory.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const withLock = requireCallable(nativeMemory, "withNativeMemoryLock");
    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-native-lock-contract-"));
    const lockPath = path.join(root, "native-memory.lock");
    let active = 0;
    let maxActive = 0;
    const order = [];
    const worker = (id) => withLock({ lockPath, timeoutMs: 2_000 }, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end:${id}`);
      active -= 1;
    });
    try {
      await Promise.all([worker("one"), worker("two")]);
      assert.equal(maxActive, 1);
      assert.deepEqual(order, ["start:one", "end:one", "start:two", "end:two"]);
      assert.equal(existsSync(lockPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

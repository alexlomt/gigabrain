import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { acquireQueueLock, withQueueLock } from "../lib/core/review-queue.js";
import { runDirect, withTempRoot } from "./restored-private-test-helpers.js";

export async function run() {
  await withTempRoot("gigabrain-review-lock-", async (root) => {
    const queuePath = path.join(root, "queue.jsonl");
    const lock = acquireQueueLock(queuePath, { timeoutMs: 100 });
    assert.ok(existsSync(`${queuePath}.lock`));
    assert.throws(() => acquireQueueLock(queuePath, { timeoutMs: 25 }), /Timed out/);
    lock.release();
    assert.equal(existsSync(`${queuePath}.lock`), false);
    assert.equal(withQueueLock(queuePath, { timeoutMs: 100 }, () => "ok"), "ok");
  });
}
runDirect(import.meta.url, run);

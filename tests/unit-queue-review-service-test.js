import assert from "node:assert/strict";
import { statSync } from "node:fs";
import path from "node:path";
import { appendQueueRow, listQueueEntries } from "../lib/core/review-queue.js";
import { runDirect, withTempRoot } from "./restored-private-test-helpers.js";

export async function run() {
  await withTempRoot("gigabrain-queue-review-", async (root) => {
    const queuePath = path.join(root, "review", "queue.jsonl");
    appendQueueRow(queuePath, { content: "Synthetic review", reason_code: "quality", status: "pending" }, {
      allowedRoot: root,
      applyRetention: false,
    });
    const listed = listQueueEntries(queuePath, { allowedRoot: root, reasonCode: "quality" });
    assert.equal(listed.total, 1);
    assert.equal(listed.entries[0].content, "Synthetic review");
    assert.equal(statSync(queuePath).mode & 0o777, 0o600);
  });
}
runDirect(import.meta.url, run);

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeConfig, V3_CONFIG_SCHEMA } from "../../lib/core/config.js";
import { ensureProjectionStore } from "../../lib/core/projection-store.js";
import { makeConfigObject } from "../helpers.js";
import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "9";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_NIGHTLY_QUEUE_REVIEW missing bounded nightly review integration";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export async function run() {
  const service = await importContractModule("lib/compat/queue-review-service.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    requireCallable(service, "reviewQueuedCandidates");
    const defaults = normalizeConfig({}, { workspaceRoot: repoRoot });
    assert.equal(defaults.llm.queueReview.limit, 20);
    assert.equal(V3_CONFIG_SCHEMA.properties.llm.properties.queueReview.properties.limit.default, 20);

    const gigabrainCtlSource = readFileSync("scripts/gigabrainctl.js", "utf8");
    assert.match(gigabrainCtlSource, /queue-review-service\.js/);
    assert.match(gigabrainCtlSource, /reviewQueueStage:\s*nightlyReviewStage/);
    const maintenance = await importContractModule("lib/core/maintenance-service.js", EXPECTED_SIGNATURE);
    const runDailyMaintenanceSequence = requireCallable(maintenance, "runDailyMaintenanceSequence");
    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task9-nightly-review-"));
    try {
      const workspace = path.join(root, "workspace");
      const dbPath = path.join(workspace, "memory", "registry.sqlite");
      const outputDir = path.join(workspace, "output");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      ensureProjectionStore(db);
      db.close();
      const config = normalizeConfig(makeConfigObject(workspace).plugins.entries.gigabrain.config);
      config.lockPath = path.join(root, "native.lockdir");
      config.runtime.paths.registryPath = dbPath;
      config.runtime.paths.outputDir = outputDir;
      config.runtime.paths.reviewQueuePath = path.join(outputDir, "review-queue.jsonl");
      config.maintenance.snapshotDir = path.join(outputDir, "backups");
      config.maintenance.vacuum = false;
      config.native.enabled = false;
      config.nativePromotion.enabled = false;
      config.recall.semanticRerankEnabled = false;
      config.worldModel.enabled = false;
      config.llm.queueReview.enabled = true;
      const calls = [];
      const result = await runDailyMaintenanceSequence({
        config,
        dbPath,
        mode: "normal",
        outputDir,
        qualityReviewStage: async () => {
          calls.push("quality");
          return { ok: true, summary: { by_action: {} } };
        },
        reviewQueueStage: async () => {
          calls.push("review");
          return { mutationCount: 0, ok: true };
        },
        runId: "task9-nightly-review-order",
      });
      assert.equal(result.ok, true);
      assert.deepEqual(calls, ["review", "quality"]);
      assert.ok(
        result.receipts.findIndex((row) => row.stage === "11 memory_review_queue")
          < result.receipts.findIndex((row) => row.stage === "17 open_loops_syntheses_and_archive_retention"),
        "bounded review must execute before durable queue/archive retention",
      );
      assert.match(
        result.outputs["17 open_loops_syntheses_and_archive_retention"].suboperations.reviewQueueRetention,
        /^completed:/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }

    const release = JSON.parse(readFileSync("public-release-manifest.json", "utf8"));
    for (const list of [release.repository.files, release.npm.files]) {
      assert.equal(list.includes("lib/compat/queue-review-service.js"), true);
    }
  });
}

runDirect(import.meta.url, run);

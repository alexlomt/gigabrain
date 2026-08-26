import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { normalizeConfig, V3_CONFIG_SCHEMA } from "../../lib/core/config.js";
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
    const maintainAt = gigabrainCtlSource.indexOf("const maintain = runMaintenance(");
    const reviewAt = gigabrainCtlSource.indexOf("await reviewQueuedCandidates(", maintainAt);
    const retentionAt = gigabrainCtlSource.indexOf("applyQueueRetention(", reviewAt);
    const harmonizeAt = gigabrainCtlSource.indexOf("runNightlyHarmonize(", reviewAt);
    assert.ok(maintainAt >= 0 && reviewAt > maintainAt, "nightly review must follow the maintenance producer phase");
    assert.ok(retentionAt > reviewAt, "queue retention must follow queue review");
    assert.ok(harmonizeAt > retentionAt, "harmonize/audit must follow review and retention");
    assert.match(
      gigabrainCtlSource.slice(reviewAt, harmonizeAt),
      /const queueRetention = dryRun[\s\S]*\?[\s\S]*dry_run[\s\S]*:\s*applyQueueRetention/,
    );
    assert.match(gigabrainCtlSource.slice(reviewAt, harmonizeAt), /queueReview/);

    const release = JSON.parse(readFileSync("public-release-manifest.json", "utf8"));
    for (const list of [release.repository.files, release.npm.files]) {
      assert.equal(list.includes("lib/compat/queue-review-service.js"), true);
    }
  });
}

runDirect(import.meta.url, run);

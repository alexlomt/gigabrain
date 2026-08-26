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

    const source = readFileSync(path.join(repoRoot, "scripts", "gigabrainctl.js"), "utf8");
    assert.match(source, /queue-review-service\.js/);
    const maintainAt = source.indexOf("const maintain = runMaintenance(");
    const reviewAt = source.indexOf("await reviewQueuedCandidates(", maintainAt);
    const retentionAt = source.indexOf("applyQueueRetention(", reviewAt);
    const harmonizeAt = source.indexOf("runNightlyHarmonize(", reviewAt);
    assert.ok(maintainAt >= 0 && reviewAt > maintainAt, "nightly review must follow the maintenance producer phase");
    assert.ok(retentionAt > reviewAt, "queue retention must follow queue review");
    assert.ok(harmonizeAt > retentionAt, "harmonize/audit must follow review and retention");
    assert.match(source.slice(reviewAt, harmonizeAt), /dryRun\s*\?[^:]+:\s*applyQueueRetention/s);
    assert.match(source.slice(reviewAt, harmonizeAt), /queueReview/);

    const release = JSON.parse(readFileSync(path.join(repoRoot, "public-release-manifest.json"), "utf8"));
    for (const list of [release.repository.files, release.npm.files]) {
      assert.equal(list.includes("lib/compat/queue-review-service.js"), true);
    }
  });
}

runDirect(import.meta.url, run);

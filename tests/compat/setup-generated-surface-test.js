import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "10";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_SETUP_SURFACE missing explicit generated-surface CLI";

export async function run() {
  const surface = await importContractModule("lib/operator/generated-surface.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    requireCallable(surface, "buildGeneratedSurface");
    requireCallable(surface, "inspectGeneratedSurface");
    const cliSource = readFileSync("scripts/gigabrainctl.js", "utf8");
    assert.match(cliSource, /surface\s+build\|status\|doctor/);
    assert.match(cliSource, /commandSurface/);
    assert.match(cliSource, /buildGeneratedSurface/);
    assert.match(cliSource, /inspectGeneratedSurface/);
    const setupSource = readFileSync("scripts/setup-first-run.js", "utf8");
    assert.doesNotMatch(setupSource, /buildGeneratedSurface\s*\(/, "setup must not implicitly materialize private memory content");
    const release = JSON.parse(readFileSync("public-release-manifest.json", "utf8"));
    for (const list of [release.repository.files, release.npm.files]) {
      assert.equal(list.includes("lib/operator/generated-surface.js"), true);
      assert.equal(list.includes("lib/operator/surface-refresh-service.js"), true);
    }
  });
}

runDirect(import.meta.url, run);

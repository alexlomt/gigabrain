import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "10";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_GENERATED_SURFACE missing deterministic generated runtime surface";

export async function run() {
  const surface = await importContractModule("lib/operator/generated-surface.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const build = requireCallable(surface, "buildGeneratedSurface");
    const inspect = requireCallable(surface, "inspectGeneratedSurface");
    const first = await build({ db: null, config: {}, outputDir: "/synthetic", force: false });
    const second = await build({ db: null, config: {}, outputDir: "/synthetic", force: false });
    assert.deepEqual(second, first);
    assert.equal((await inspect({ db: null, config: {} })).healthy, true);
  });
}

runDirect(import.meta.url, run);

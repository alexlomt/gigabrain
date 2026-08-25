import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_SCOPE_VISIBILITY missing fail-closed scope visibility matrix";

export async function run() {
  const runtime = await importContractModule("lib/compat/openclaw-memory-runtime.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const resolve = requireCallable(runtime, "resolveScopeVisibility");
    assert.deepEqual(resolve({ scope: "shared" }), ["shared"]);
    assert.deepEqual(resolve({ scope: "profile:synthetic" }), ["profile:synthetic", "shared"]);
    assert.deepEqual(resolve({ scope: "project:synthetic" }), ["project:synthetic"]);
    assert.throws(() => resolve({ scope: "" }), /scope/i);
  });
}

runDirect(import.meta.url, run);

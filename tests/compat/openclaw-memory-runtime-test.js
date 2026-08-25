import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OPENCLAW_MEMORY_RUNTIME missing governed OpenClaw runtime adapter";

export async function run() {
  const runtime = await importContractModule("lib/compat/openclaw-memory-runtime.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const createManager = requireCallable(runtime, "createGigabrainMemoryManager");
    const recallCalls = [];
    const manager = await createManager({
      recall: async ({ query, scope }) => {
        recallCalls.push({ query, scope });
        return [{ content: "Synthetic harbour memory", scope }];
      },
      scope: "project:synthetic",
    });
    assert.equal(manager.scope, "project:synthetic");
    assert.equal(typeof manager.search, "function");
    assert.deepEqual(await manager.search("harbour"), [
      { content: "Synthetic harbour memory", scope: "project:synthetic" },
    ]);
    assert.deepEqual(recallCalls, [{ query: "harbour", scope: "project:synthetic" }]);
    assert.deepEqual(
      runtime.gigabrainMemoryRuntime.resolveMemoryBackendConfig({ backend: "gigabrain" }),
      { backend: "gigabrain" },
    );
  });
}

runDirect(import.meta.url, run);

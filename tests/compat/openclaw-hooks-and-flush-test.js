import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OPENCLAW_HOOKS missing prompt-build and compaction-flush hooks";

export async function run() {
  const hooks = await importContractModule("lib/compat/openclaw-hooks.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const buildFlushPlan = requireCallable(hooks, "buildGigabrainMemoryFlushPlan");
    const mergePromptContext = requireCallable(hooks, "mergePromptContext");
    const plan = buildFlushPlan({
      remainingTokens: 1_000,
      reserveTokens: 2_000,
      workspaceFiles: ["MEMORY.md", "AGENTS.md"],
    });
    assert.equal(plan.shouldFlush, true);
    assert.deepEqual(plan.readOnlyPaths, ["AGENTS.md", "MEMORY.md"]);
    assert.match(plan.instructions, /durable/i);
    assert.equal(
      mergePromptContext({ existing: "Base context", memory: "Synthetic recall" }),
      "Base context\n\nSynthetic recall",
    );
  });
}

runDirect(import.meta.url, run);

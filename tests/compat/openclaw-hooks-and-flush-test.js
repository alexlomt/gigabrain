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
  const adapter = await importContractModule("lib/compat/openclaw-adapter.js", EXPECTED_SIGNATURE);
  const flush = await importContractModule("lib/compat/flush-plan.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const resolvePlan = requireCallable(flush, "resolveGigabrainFlushPlan");
    const createPromptBuildHandler = requireCallable(adapter, "createPromptBuildHandler");
    const plan = resolvePlan({ runtime: { timezone: "UTC" } }, { nowMs: Date.UTC(2026, 7, 25, 23, 59, 0) });
    assert.equal(plan.relativePath, "memory/2026-08-25.md");
    assert.equal(plan.softThresholdTokens, 4_000);
    assert.equal(plan.forceFlushTranscriptBytes, 2 * 1024 * 1024);
    assert.equal(plan.reserveTokensFloor, 20_000);
    assert.match(plan.prompt, /<memory_note[^>]*type=/i);
    assert.match(plan.prompt, /confidence=/i);
    assert.match(plan.prompt, /append/i);
    assert.match(plan.prompt, /do not (?:overwrite|edit|replace|delete)/i);
    assert.match(plan.systemPrompt, /memory\/2026-08-25\.md/);

    const pinnedCfgPlan = resolvePlan(
      { runtime: { timezone: "Asia/Tokyo" } },
      {
        cfg: {
          agents: {
            defaults: {
              userTimezone: "America/Los_Angeles",
              compaction: {
                reserveTokensFloor: 22_000,
                memoryFlush: {
                  forceFlushTranscriptBytes: "3mb",
                  softThresholdTokens: 4_500,
                },
              },
            },
          },
        },
        nowMs: Date.UTC(2026, 0, 1, 0, 30, 0),
      },
    );
    assert.equal(pinnedCfgPlan.relativePath, "memory/2025-12-31.md", "host cfg timezone wins at the date boundary");
    assert.equal(pinnedCfgPlan.forceFlushTranscriptBytes, 3 * 1024 * 1024);
    assert.equal(pinnedCfgPlan.softThresholdTokens, 4_500);
    assert.equal(pinnedCfgPlan.reserveTokensFloor, 22_000);

    const recalls = [];
    const preludes = [];
    const handler = createPromptBuildHandler({
      config: { recall: { autoInjectEnabled: true }, synthesis: { enabled: true } },
      recall: async ({ query, scope }) => {
        recalls.push({ query, scope });
        return `<gigabrain-context>scope:${scope};query:${query}</gigabrain-context>`;
      },
      getSessionPrelude: async ({ scope }) => {
        preludes.push(scope);
        return `prelude:${scope}`;
      },
    });
    const event = { prompt: "Where is the harbour plan?", messages: [{ role: "user", content: "Where is the harbour plan?" }] };
    const ctx = { agentId: "paperclip-ceo", sessionKey: "agent:paperclip-ceo:stable-session" };
    const first = await handler(event, ctx);
    const second = await handler(event, ctx);
    assert.match(first.prependContext, /prelude:paperclip-ceo/);
    assert.match(first.prependContext, /scope:paperclip-ceo/);
    assert.doesNotMatch(first.prependContext, /profile:main|scope:shared/);
    assert.doesNotMatch(second.prependContext, /prelude:/, "a stable session receives its scoped prelude once");
    assert.deepEqual(preludes, ["paperclip-ceo"]);
    assert.deepEqual(recalls, [
      { query: "Where is the harbour plan?", scope: "paperclip-ceo" },
      { query: "Where is the harbour plan?", scope: "paperclip-ceo" },
    ]);
  });
}

runDirect(import.meta.url, run);

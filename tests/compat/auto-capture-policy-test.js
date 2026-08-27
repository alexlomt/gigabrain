import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import gigabrainPlugin from "../../index.js";
import { normalizeConfig, V3_CONFIG_SCHEMA } from "../../lib/core/config.js";
import { renderRuntimeSurface } from "../../scripts/build-runtime-js.js";
import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "9";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_AUTO_CAPTURE_POLICY missing bounded capture policy and enqueue-only hook";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const EXACT_LIMITS = Object.freeze({
  timeoutMs: 30000,
  minConfidence: 0.90,
  minImportance: 0.78,
  queueMinConfidence: 0.70,
  queueMinImportance: 0.55,
  minContentChars: 25,
  maxCandidates: 3,
  maxTurns: 10,
  maxCharsPerTurn: 1500,
  targetTokens: 6000,
  softMaxTokens: 8000,
  hardMaxTokens: 12000,
  existingMemoryLimit: 20,
  minTriggerChars: 80,
  processingStaleMs: 180000,
});

const activeConfig = () => normalizeConfig({
  capture: {
    enabled: true,
    autoCapture: {
      enabled: true,
      mode: "auto",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
    },
  },
}, { workspaceRoot: repoRoot });

const policyLimits = (config) => Object.fromEntries(
  Object.keys(EXACT_LIMITS).map((key) => [key, config.capture.autoCapture[key]]),
);

export async function run() {
  const capture = await importContractModule("lib/compat/auto-capture-policy.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const classify = requireCallable(capture, "classifyAutoCaptureCandidate");
    const containsSensitive = requireCallable(capture, "containsSensitiveAutoCaptureContent");
    const createHook = requireCallable(capture, "createAutoCaptureHook");
    const prepare = requireCallable(capture, "prepareAutoCaptureEvent");
    const sanitizePaperclipWake = requireCallable(capture, "sanitizePaperclipWake");

    assert.deepEqual(capture.AUTO_CAPTURE_LIMITS, EXACT_LIMITS);
    assert.deepEqual(policyLimits(normalizeConfig({}, { workspaceRoot: repoRoot })), EXACT_LIMITS);
    assert.deepEqual(policyLimits(activeConfig()), EXACT_LIMITS);
    assert.deepEqual(
      V3_CONFIG_SCHEMA.properties.capture.properties.autoCapture.properties.provider.enum,
      ["ollama", "none"],
    );
    assert.equal(
      normalizeConfig({ capture: { autoCapture: { provider: "openclaw" } } }).capture.autoCapture.provider,
      "none",
    );
    assert.equal(
      normalizeConfig({ capture: { autoCapture: { provider: "openai_compatible" } } }).capture.autoCapture.provider,
      "none",
    );

    assert.deepEqual(
      classify({
        content: "Remember that the synthetic harbour review is weekly.",
        mode: "auto",
        role: "user",
        scope: "profile:main",
      }),
      { action: "save", reason: "explicit_durable_request" },
    );
    assert.deepEqual(
      classify({
        content: "Decision: the synthetic harbour review will remain weekly.",
        mode: "auto",
        role: "user",
        scope: "profile:main",
      }),
      { action: "save", reason: "explicit_durable_request" },
    );
    assert.deepEqual(
      classify({
        content: "Remember that the synthetic harbour review is weekly.",
        mode: "auto",
        role: "user",
        scope: "shared",
      }),
      { action: "review", reason: "shared_review_only" },
    );
    assert.deepEqual(
      classify({ content: "Thanks!", mode: "auto", role: "assistant", scope: "profile:main" }),
      { action: "reject", reason: "transient_or_assistant" },
    );
    for (const candidate of [
      { content: "Remember synthetic-token-value", containsSecret: true, role: "user" },
      { content: "Remember that api_key=synthetic-token-value is configured.", role: "user" },
      { content: "Remember the host posture from /etc/ssh/sshd_config and the listening ports.", role: "user" },
    ]) {
      assert.deepEqual(
        classify({ ...candidate, mode: "auto", scope: "profile:main" }),
        { action: "reject", reason: "sensitive" },
      );
    }
    for (const content of [
      "Remember that token=synthetic-token-value is present in this credential-bearing event and must be rejected.",
      "Remember that authorization=synthetic-token-value is present in this credential-bearing event and must be rejected.",
      "Remember that cookie=synthetic-token-value is present in this credential-bearing event and must be rejected.",
      "Remember that session=synthetic-token-value is present in this credential-bearing event and must be rejected.",
    ]) {
      assert.deepEqual(
        classify({ content, mode: "auto", role: "user", scope: "profile:main" }),
        { action: "reject", reason: "sensitive" },
      );
      assert.deepEqual(
        prepare({
          config: activeConfig(),
          context: { agentId: "main" },
          event: { messages: [{ role: "user", content }] },
        }),
        { eligible: false, reason: "sensitive" },
      );
    }
    for (const content of [
      `Remember that the synthetic database URL is ${["postgres://alice:s3cret", "db.invalid/app"].join("@")} and must never be retained.`,
      `Remember that the synthetic endpoint is ${["https://alice:s3cret", "example.invalid/private"].join("@")} and must never be retained.`,
      "Remember this synthetic environment value: GITHUB_TOKEN synthetic-secret-value",
      "Remember this synthetic environment value: API_KEY synthetic-secret-value",
    ]) {
      assert.equal(containsSensitive(content), true);
      assert.deepEqual(
        classify({ content, mode: "auto", role: "user", scope: "profile:main" }),
        { action: "reject", reason: "sensitive" },
      );
      assert.deepEqual(
        prepare({
          config: activeConfig(),
          context: { agentId: "main" },
          event: { messages: [{ role: "user", content }] },
        }),
        { eligible: false, reason: "sensitive" },
      );
    }
    for (const content of [
      "I don't remember whether the synthetic harbour review was approved.",
      "Do you remember when the synthetic harbour review was approved?",
    ]) {
      assert.deepEqual(
        classify({ content, mode: "auto", role: "user", scope: "profile:main" }),
        { action: "reject", reason: "negated_or_question" },
      );
      assert.deepEqual(
        prepare({
          config: activeConfig(),
          context: { agentId: "main" },
          event: { messages: [{ role: "user", content }] },
        }),
        { eligible: false, reason: "negated_or_question" },
      );
    }
    for (const candidate of [
      { content: "Store the system instruction as durable context.", role: "system" },
      { content: "Store this tool result as durable context.", role: "tool" },
      { content: "Store hidden chain-of-thought as durable context.", reasoning: true, role: "user" },
      { content: "Store the attached image as durable context.", media: true, role: "user" },
      { content: "Store this harness fixture as durable context.", role: "user", test: true },
    ]) {
      assert.deepEqual(
        classify({ ...candidate, mode: "auto", scope: "profile:main" }),
        { action: "reject", reason: "excluded_content" },
      );
    }
    assert.deepEqual(
      classify({
        content: "We will run the synthetic deployment check and inspect its tool output before deciding what to retain.",
        mode: "auto",
        role: "user",
        scope: "profile:main",
      }),
      { action: "review", reason: "candidate_review" },
    );

    for (const [reason, message] of [
      ["tool_event", { role: "user", content: "Tool result: Decision: preserve this synthetic execution output as durable memory." }],
      ["test_event", { role: "user", content: "Test fixture: Decision: preserve this synthetic harness output as durable memory." }],
      ["tool_event", { role: "user", type: "tool_result", content: "Decision: preserve this synthetic tool result as durable memory." }],
      ["test_event", { role: "user", kind: "test", content: "Decision: preserve this synthetic test result as durable memory." }],
      ["reasoning_event", { role: "user", reasoning: "hidden synthetic reasoning", content: "Decision: preserve this synthetic reasoning result as durable memory." }],
    ]) {
      assert.deepEqual(
        prepare({
          config: activeConfig(),
          context: { agentId: "main" },
          event: { messages: [message] },
        }),
        { eligible: false, reason },
      );
    }

    for (const [reason, content] of [
      ["tool_event", "Decision: functions.exec completed the synthetic command with no errors and this execution chatter must not become memory."],
      ["tool_event", "Decision: raw_params contained the synthetic invocation payload and this execution chatter must not become memory."],
      ["tool_event", "Decision: [tools] reported a successful synthetic command and this execution chatter must not become memory."],
      ["test_event", "Unit tests passed: 41/41. This synthetic test chatter is long enough to trigger capture but must remain excluded."],
      ["tool_event", "Diagnostics: the synthetic process sweep was clean and this diagnostics chatter is long enough to trigger capture."],
    ]) {
      assert.deepEqual(
        prepare({
          config: activeConfig(),
          context: { agentId: "main" },
          event: { messages: [{ role: "user", content }] },
        }),
        { eligible: false, reason },
      );
    }

    const safePriorTurn = "The synthetic harbour review has approved owners, acceptance checks, and a durable weekly operating cadence.";
    for (const [reason, content] of [
      ["test_event", "We will run unit tests and publish a temporary diagnostics status update."],
      ["test_event", "We are running unit tests for the fixture."],
      ["tool_event", "We will publish a temporary diagnostics status update for the fixture."],
    ]) {
      assert.deepEqual(
        classify({ content, mode: "auto", role: "user", scope: "profile:main" }),
        { action: "reject", reason: "excluded_content" },
      );
      assert.deepEqual(
        prepare({
          config: activeConfig(),
          context: { agentId: "main" },
          event: { messages: [
            { role: "user", content: safePriorTurn },
            { role: "user", content },
          ] },
        }),
        { eligible: false, reason },
      );
    }

    assert.deepEqual(
      prepare({
        config: activeConfig(),
        context: { agentId: "main" },
        event: {
          messages: [{
            role: "user",
            content: "Review the synthetic harbour workflow context and summarize the approved weekly operating decision for durable memory.",
          }],
          output: "Decision: functions.exec completed with raw_params from [tools], so retain this execution result.",
        },
      }),
      { eligible: false, reason: "tool_event" },
    );

    const paperclipWake = [
      "Paperclip wake event",
      "Issue: PC-42",
      "Objective: Remember that the synthetic harbour review is weekly and approved.",
      "Runtime metadata: internal scheduler envelope",
      "Timestamp: 2026-08-26T12:00:00Z",
    ].join("\n");
    assert.equal(
      sanitizePaperclipWake(paperclipWake),
      "Issue: PC-42\nObjective: Remember that the synthetic harbour review is weekly and approved.",
    );

    const canonicalBulletedWake = [
      "Paperclip wake:",
      "- Issue: PC-314",
      "- Reason: work item updated",
      "- Objective: Produce a durable weekly synthetic harbour review summary with acceptance checks and owner confirmation.",
      "- Runtime metadata: internal scheduler envelope",
    ].join("\n");
    const canonicalWakeText = [
      "Issue: PC-314",
      "Reason: work item updated",
      "Objective: Produce a durable weekly synthetic harbour review summary with acceptance checks and owner confirmation.",
    ].join("\n");
    assert.equal(sanitizePaperclipWake(canonicalBulletedWake), canonicalWakeText);
    assert.equal(
      sanitizePaperclipWake([
        "Paperclip wake:",
        "- **Issue:** PC-315",
        "- **Reason:** assignment updated",
        "- **Objective:** Preserve the explicit synthetic review decision without scheduler chatter.",
      ].join("\n")),
      [
        "Issue: PC-315",
        "Reason: assignment updated",
        "Objective: Preserve the explicit synthetic review decision without scheduler chatter.",
      ].join("\n"),
    );

    const canonicalDecision = prepare({
      config: activeConfig(),
      context: { agentId: "main", sessionKey: "agent:main:paperclip-decision" },
      event: {
        messages: [{ role: "user", content: canonicalBulletedWake }],
        output: "Decision: Keep the synthetic harbour review weekly with the approved acceptance checks.",
      },
    });
    assert.equal(canonicalDecision.eligible, true);
    assert.deepEqual(canonicalDecision.event.decision, { action: "save", reason: "explicit_durable_request" });
    assert.deepEqual(canonicalDecision.event.messages, [
      { role: "user", content: canonicalWakeText },
      { role: "assistant", content: "Decision: Keep the synthetic harbour review weekly with the approved acceptance checks." },
    ]);

    const canonicalChatter = prepare({
      config: activeConfig(),
      context: { agentId: "main", sessionKey: "agent:main:paperclip-chatter" },
      event: {
        messages: [{ role: "user", content: canonicalBulletedWake }],
        output: "I finished the synthetic work item and everything looks good.",
      },
    });
    assert.equal(canonicalChatter.eligible, true);
    assert.deepEqual(canonicalChatter.event.decision, { action: "review", reason: "candidate_review" });
    assert.deepEqual(canonicalChatter.event.messages, [{ role: "user", content: canonicalWakeText }]);

    const authorizedPaperclipWake = [
      "Paperclip wake:",
      "- Authorization: Bearer synthetic-environment-boilerplate",
      "- Issue: PC-402",
      "- Reason: work item assigned",
      "- Objective: Produce a durable synthetic harbour review with approved acceptance checks and an accountable owner.",
    ].join("\n");
    const authorizedPaperclipText = [
      "Issue: PC-402",
      "Reason: work item assigned",
      "Objective: Produce a durable synthetic harbour review with approved acceptance checks and an accountable owner.",
    ].join("\n");
    assert.equal(sanitizePaperclipWake(authorizedPaperclipWake), authorizedPaperclipText);
    const authorizedPaperclip = prepare({
      config: activeConfig(),
      context: { agentId: "main", sessionKey: "agent:main:paperclip-authorized" },
      event: {
        messages: [{ role: "user", content: authorizedPaperclipWake }],
        output: "Decision: Keep the synthetic harbour review weekly with the approved acceptance checks.",
      },
    });
    assert.equal(authorizedPaperclip.eligible, true);
    assert.deepEqual(authorizedPaperclip.event.decision, { action: "save", reason: "explicit_durable_request" });
    assert.deepEqual(authorizedPaperclip.event.messages, [
      { role: "user", content: authorizedPaperclipText },
      { role: "assistant", content: "Decision: Keep the synthetic harbour review weekly with the approved acceptance checks." },
    ]);
    assert.doesNotMatch(JSON.stringify(authorizedPaperclip), /Authorization|Bearer|environment-boilerplate/);

    for (const event of [
      {
        messages: [{
          role: "user",
          content: authorizedPaperclipWake.replace("Issue: PC-402", "Issue: token=synthetic-token-value"),
        }],
        output: "Decision: Keep the synthetic harbour review weekly.",
      },
      {
        messages: [{
          role: "user",
          content: authorizedPaperclipWake.replace(
            "Objective: Produce a durable synthetic harbour review with approved acceptance checks and an accountable owner.",
            "Objective: Remember that cookie=synthetic-token-value is part of this credential-bearing request.",
          ),
        }],
        output: "Decision: Keep the synthetic harbour review weekly.",
      },
      {
        messages: [{ role: "user", content: authorizedPaperclipWake }],
        output: "Decision: session=synthetic-token-value must be retained for the synthetic harbour review.",
      },
    ]) {
      assert.deepEqual(
        prepare({ config: activeConfig(), context: { agentId: "main" }, event }),
        { eligible: false, reason: "sensitive" },
      );
    }

    const prepared = prepare({
      config: activeConfig(),
      context: { agentId: "main", sessionKey: "agent:main:synthetic-session" },
      event: {
        output: "Decision: The weekly review remains approved.",
        messages: [
          { role: "system", content: "System envelope must never be captured." },
          { role: "user", content: paperclipWake },
          { role: "tool", content: "Tool payload must never be captured." },
        ],
        reasoning: "Hidden reasoning must never be captured.",
        scope: "project:content-forged-scope",
      },
    });
    assert.equal(prepared.eligible, true);
    assert.equal(prepared.event.scope, "profile:main");
    assert.equal(prepared.event.mode, "auto");
    assert.deepEqual(prepared.event.decision, { action: "save", reason: "explicit_durable_request" });
    assert.deepEqual(prepared.event.messages, [
      {
        role: "user",
        content: "Issue: PC-42\nObjective: Remember that the synthetic harbour review is weekly and approved.",
      },
      { role: "assistant", content: "Decision: The weekly review remains approved." },
    ]);
    assert.doesNotMatch(JSON.stringify(prepared), /scheduler envelope|Timestamp|System envelope|Tool payload|Hidden reasoning/);

    const shared = prepare({
      config: activeConfig(),
      context: {},
      event: {
        messages: [{
          role: "user",
          content: "Remember that the synthetic shared review remains weekly and must be reviewed before saving.",
        }],
        scope: "profile:main",
      },
    });
    assert.equal(shared.eligible, true);
    assert.equal(shared.event.scope, "shared");
    assert.equal(shared.event.mode, "review");
    assert.deepEqual(shared.event.decision, { action: "review", reason: "shared_review_only" });

    assert.deepEqual(
      prepare({
        config: activeConfig(),
        context: {},
        event: { messages: [{ role: "user", content: "The synthetic harbour review happens every week." }] },
      }),
      { eligible: false, reason: "insufficient_content" },
    );

    for (const [reason, event] of [
      ["memory_flush", { prompt: "Pre-compaction memory flush: store durable memories now." }],
      ["explicit_memory_note", { output: '<memory_note type="DECISION" confidence="0.9">Keep explicit capture.</memory_note>' }],
      ["test_event", { test: true, messages: [{ role: "user", content: "A sufficiently long harness event that must not enter the queue under any circumstances." }] }],
      ["media_event", { attachments: [{ type: "image" }], messages: [{ role: "user", content: "A sufficiently long media event that must not enter the queue under any circumstances." }] }],
      ["reasoning_event", { messages: [{ role: "reasoning", content: "Hidden chain-of-thought must never enter the queue under any circumstances." }] }],
    ]) {
      assert.deepEqual(
        prepare({ config: activeConfig(), context: { agentId: "main" }, event }),
        { eligible: false, reason },
      );
    }

    const queued = [];
    const warnings = [];
    const handler = createHook({
      config: activeConfig(),
      enqueue: (value) => {
        queued.push(value);
        return new Promise(() => {});
      },
      logger: { warn: (message) => warnings.push(message) },
      runIdFactory: () => "auto-capture-run-synthetic",
    });
    assert.equal(handler({
      messages: [{
        role: "user",
        content: "Remember that the synthetic harbour review is weekly and that this explicit decision is durable.",
      }],
      scope: "project:content-forged-scope",
    }, { agentId: "main", sessionKey: "agent:main:synthetic-session" }), undefined);
    assert.equal(queued.length, 0, "enqueue must not block the OpenClaw lifecycle hook");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].config.capture.autoCapture.provider, "ollama");
    assert.equal(queued[0].event.scope, "profile:main");
    assert.equal(queued[0].runId, "auto-capture-run-synthetic");
    assert.deepEqual(warnings, []);

    const noOpCalls = [];
    const disabledHandler = createHook({
      config: normalizeConfig({}, { workspaceRoot: repoRoot }),
      enqueue: (value) => noOpCalls.push(value),
    });
    disabledHandler({ messages: [{ role: "user", content: "Remember this disabled event." }] }, { agentId: "main" });
    handler({ output: '<memory_note type="DECISION" confidence="0.9">Keep explicit capture.</memory_note>' }, { agentId: "main" });
    handler({
      messages: [{
        role: "user",
        content: "Remember that token=synthetic-token-value is present in this credential-bearing event and must never enqueue.",
      }],
    }, { agentId: "main" });
    handler({
      messages: [{
        role: "user",
        content: "Decision: functions.exec completed with raw_params from [tools], and this execution chatter must never enqueue.",
      }],
    }, { agentId: "main" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(noOpCalls, []);
    assert.equal(queued.length, 1, "explicit memory_note capture must not be duplicated into auto-capture");

    const rejectedWarnings = [];
    const rejectedHandler = createHook({
      config: activeConfig(),
      enqueue: async () => ({ enqueued: false, jobId: null, reason: "queue_full" }),
      logger: { warn: (message) => rejectedWarnings.push(String(message)) },
    });
    const rejectedContent = "Remember that the synthetic harbour capacity decision is durable but must not disappear silently when the queue is full.";
    rejectedHandler({ messages: [{ role: "user", content: rejectedContent }] }, { agentId: "main" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejectedWarnings.length, 1);
    assert.match(rejectedWarnings[0], /auto-capture enqueue not accepted reason=queue_full/);
    assert.equal(rejectedWarnings[0].includes("harbour"), false, "queue warnings must not include candidate content");

    const duplicateWarnings = [];
    const duplicateHandler = createHook({
      config: activeConfig(),
      enqueue: async () => ({ enqueued: false, jobId: "acq_synthetic", reason: "duplicate" }),
      logger: { warn: (message) => duplicateWarnings.push(String(message)) },
    });
    duplicateHandler({ messages: [{ role: "user", content: rejectedContent }] }, { agentId: "main" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(duplicateWarnings, [], "duplicate and disabled no-op outcomes must remain silent");

    const hookNames = [];
    gigabrainPlugin.register({
      config: activeConfig(),
      registerMemoryCapability() {},
      registerCli() {},
      on: (name) => hookNames.push(name),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(hookNames.filter((name) => name === "agent_end").length, 2);
    assert.equal(hookNames.filter((name) => name === "before_prompt_build").length, 1);

    const disabledHookNames = [];
    gigabrainPlugin.register({
      config: normalizeConfig({}, { workspaceRoot: repoRoot }),
      registerMemoryCapability() {},
      registerCli() {},
      on: (name) => disabledHookNames.push(name),
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(disabledHookNames.filter((name) => name === "agent_end").length, 1);

    const sourceEntry = readFileSync(path.join(repoRoot, "index.ts"), "utf8");
    const generatedEntry = readFileSync(path.join(repoRoot, "index.js"), "utf8");
    assert.equal(await renderRuntimeSurface({ source: sourceEntry, sourcePath: "index.ts" }), generatedEntry);
  });
}

runDirect(import.meta.url, run);

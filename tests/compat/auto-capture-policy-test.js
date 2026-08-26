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

    const prepared = prepare({
      config: activeConfig(),
      context: { agentId: "main", sessionKey: "agent:main:synthetic-session" },
      event: {
        output: "The weekly review decision is now recorded.",
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
      { role: "assistant", content: "The weekly review decision is now recorded." },
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(noOpCalls, []);
    assert.equal(queued.length, 1, "explicit memory_note capture must not be duplicated into auto-capture");

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

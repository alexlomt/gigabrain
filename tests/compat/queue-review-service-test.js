import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "9";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_QUEUE_REVIEW_SERVICE missing bounded durable queue review";

const hashFile = (filePath) => existsSync(filePath)
  ? createHash("sha256").update(readFileSync(filePath)).digest("hex")
  : "missing";
const writeRows = (filePath, rows) => {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "", { mode: 0o600 });
  chmodSync(filePath, 0o600);
};
const readRows = (filePath) => existsSync(filePath)
  ? readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const pendingRow = (id, overrides = {}) => ({
  id,
  payload: {
    content: `The synthetic review candidate ${id} is a durable operating decision with named owners.`,
    excerpt: `The synthetic review candidate ${id} is a durable operating decision with named owners.`,
    scope: "profile:main",
    type: "DECISION",
  },
  queued_at: "2026-08-26T12:00:00.000Z",
  reason_code: "capture_review_required",
  status: "pending",
  ...overrides,
});
const makeFixture = (label, enabled = true) => {
  const root = mkdtempSync(path.join(tmpdir(), `gigabrain-task9d-${label}-`));
  const queuePath = path.join(root, "output", "memory-review-queue.jsonl");
  return {
    config: {
      llm: {
        queueReview: {
          allowedReasons: ["capture_review_required", "duplicate_semantic"],
          enabled,
          limit: 200,
          minConfidence: 0.8,
          profile: "memory_review",
        },
        taskProfiles: {
          memory_review: {
            max_tokens: 180,
            reasoning: "off",
            temperature: 0.15,
            top_k: 20,
            top_p: 0.8,
          },
        },
      },
      memoryLlm: {
        baseUrl: "http://127.0.0.1:11434",
        enabled: true,
        maxRetries: 0,
        model: "qwen3.5:9b",
        provider: "ollama",
        timeoutMs: 15000,
      },
      runtime: { paths: { reviewQueuePath: queuePath } },
    },
    queuePath,
    root,
  };
};

export async function run() {
  const service = await importContractModule("lib/compat/queue-review-service.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const reviewQueuedCandidates = requireCallable(service, "reviewQueuedCandidates");
    const fixtures = [];
    const fixture = (label, enabled) => {
      const value = makeFixture(label, enabled);
      fixtures.push(value);
      return value;
    };
    try {
      {
        const current = fixture("disabled", false);
        let called = false;
        const result = await reviewQueuedCandidates({
          config: current.config,
          reviewer: async () => { called = true; },
        });
        assert.equal(result.enabled, false);
        assert.equal(result.mutatedRows, 0);
        assert.equal(called, false);
        assert.equal(existsSync(current.queuePath), false);
      }

      {
        const current = fixture("dry-run", true);
        writeRows(current.queuePath, [pendingRow("dry-run")]);
        const before = hashFile(current.queuePath);
        let called = false;
        const result = await reviewQueuedCandidates({
          config: current.config,
          dryRun: true,
          reviewer: async () => { called = true; },
        });
        assert.equal(result.dryRun, true);
        assert.equal(result.eligible, 1);
        assert.equal(result.processed, 0);
        assert.equal(result.mutatedRows, 0);
        assert.equal(called, false);
        assert.equal(hashFile(current.queuePath), before);
      }

      {
        const current = fixture("allowed", true);
        writeRows(current.queuePath, [
          pendingRow("allowed"),
          pendingRow("disallowed", { reason_code: "operator_only_reason" }),
        ]);
        const result = await reviewQueuedCandidates({
          applyDecision: async () => ({ dismissed: 1 }),
          config: current.config,
          reviewer: async () => ({ confidence: 0.95, decision: "dismiss", reason: "transient" }),
          runId: "task9d-allowed",
        });
        assert.equal(result.eligible, 1);
        assert.equal(result.processed, 1);
        assert.equal(result.dismissed, 1);
        assert.equal(result.mutatedRows, 1);
        const rows = readRows(current.queuePath);
        assert.equal(rows.find((row) => row.id === "allowed").status, "resolved_auto");
        assert.equal(rows.find((row) => row.id === "disallowed").status, "pending");
        const resolved = rows.find((row) => row.id === "allowed");
        assert.equal("payload" in resolved, false, "resolved rows must scrub memory candidate content");
        assert.match(resolved.payload_hash, /^[0-9a-f]{64}$/);
        assert.equal(JSON.stringify(resolved).includes("durable operating decision"), false);
      }

      {
        const current = fixture("limit", true);
        writeRows(current.queuePath, Array.from({ length: 25 }, (_, index) => pendingRow(`limit-${index}`)));
        let calls = 0;
        const result = await reviewQueuedCandidates({
          applyDecision: async () => ({ dismissed: 1 }),
          config: current.config,
          limit: 200,
          reviewer: async () => {
            calls += 1;
            return { confidence: 0.95, decision: "dismiss", reason: "bounded" };
          },
        });
        assert.equal(calls, 20, "queue review must enforce the hard 20-row ceiling");
        assert.equal(result.processed, 20);
        assert.equal(readRows(current.queuePath).filter((row) => row.status === "pending").length, 5);
      }

      {
        const current = fixture("failure-isolation", true);
        writeRows(current.queuePath, [pendingRow("retry"), pendingRow("success")]);
        const result = await reviewQueuedCandidates({
          applyDecision: async () => ({ dismissed: 1 }),
          config: current.config,
          reviewer: async ({ row }) => {
            if (row.id === "retry") throw new Error("memory_llm_ollama_http_503 private-body-must-not-persist");
            return { confidence: 0.96, decision: "dismiss", reason: "safe" };
          },
        });
        assert.equal(result.processed, 2);
        assert.equal(result.retryable, 1);
        assert.equal(result.dismissed, 1);
        const rows = readRows(current.queuePath);
        const retry = rows.find((row) => row.id === "retry");
        assert.equal(retry.status, "failed_retryable");
        assert.equal(retry.error_class, "provider_unavailable");
        assert.equal(JSON.stringify(retry).includes("private-body"), false);
        assert.equal(rows.find((row) => row.id === "success").status, "resolved_auto");
      }

      {
        const current = fixture("concurrent-append", true);
        writeRows(current.queuePath, [pendingRow("original")]);
        let appended = false;
        await reviewQueuedCandidates({
          applyDecision: async () => ({ dismissed: 1 }),
          config: current.config,
          reviewer: async () => {
            if (!appended) {
              appended = true;
              writeFileSync(current.queuePath, `${readFileSync(current.queuePath, "utf8")}${JSON.stringify(pendingRow("appended"))}\n`, { mode: 0o600 });
            }
            return { confidence: 0.95, decision: "dismiss", reason: "safe" };
          },
        });
        const rows = readRows(current.queuePath);
        assert.equal(rows.find((row) => row.id === "original").status, "resolved_auto");
        assert.equal(rows.find((row) => row.id === "appended").status, "pending");
      }

      {
        const current = fixture("local-provider", true);
        writeRows(current.queuePath, [pendingRow("local-provider")]);
        const originalFetch = globalThis.fetch;
        const calls = [];
        globalThis.fetch = async (url) => {
          calls.push(String(url));
          return new Response(JSON.stringify({
            response: JSON.stringify({ confidence: 0.96, decision: "dismiss", reason: "transient" }),
          }), { headers: { "Content-Type": "application/json" }, status: 200 });
        };
        try {
          const result = await reviewQueuedCandidates({
            applyDecision: async () => ({ dismissed: 1 }),
            config: current.config,
          });
          assert.equal(result.dismissed, 1);
        } finally {
          globalThis.fetch = originalFetch;
        }
        assert.deepEqual(calls, ["http://127.0.0.1:11434/api/generate"]);
      }
    } finally {
      for (const current of fixtures) rmSync(current.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

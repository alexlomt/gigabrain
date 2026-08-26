import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_AUTO_CAPTURE_QUEUE missing durable bounded queue state machine";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const requestedFixCase = (() => {
  const index = process.argv.indexOf("--case");
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
})();
const shouldRunFixCase = (name) => !requestedFixCase || requestedFixCase === name;

const writePrivate = (filePath, value) => {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
};

const makeFixture = (label) => {
  const root = mkdtempSync(path.join(tmpdir(), `gigabrain-task9b-${label}-`));
  const runtimeRoot = path.join(root, "runtime");
  const outputDir = path.join(runtimeRoot, "output");
  const vaultPath = path.join(root, "vault");
  const descriptorPath = path.join(runtimeRoot, "gigabrain-release.json");
  const descriptor = {
    autoCaptureQueuePath: path.join(outputDir, "gigabrain-auto-capture-queue.jsonl"),
    codeRoot: repoRoot,
    dbPath: path.join(runtimeRoot, "registry.sqlite"),
    graphPath: path.join(runtimeRoot, "graph.db"),
    nativeLockDir: path.join(runtimeRoot, "native-memory.lockdir"),
    operatorLogDir: path.join(outputDir, "operator"),
    outputDir,
    reviewQueuePath: path.join(outputDir, "memory-review-queue.jsonl"),
    vaultPath,
  };
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  mkdirSync(vaultPath, { recursive: true, mode: 0o700 });
  writePrivate(descriptor.dbPath, "synthetic-registry-state\n");
  writePrivate(descriptor.graphPath, "synthetic-graph-state\n");
  writePrivate(path.join(vaultPath, "manual-note.md"), "synthetic-vault-state\n");
  writePrivate(path.join(outputDir, "operator-marker.json"), "{\"synthetic\":true}\n");
  writePrivate(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  const decoyQueuePath = path.join(root, "decoy-output", "must-not-be-used.jsonl");
  const config = {
    compat: { writeMode: "full" },
    runtimeDescriptorPath: descriptorPath,
    runtime: {
      paths: {
        autoCaptureQueuePath: decoyQueuePath,
        outputDir: path.dirname(decoyQueuePath),
      },
    },
    capture: {
      enabled: true,
      autoCapture: {
        enabled: true,
        mode: "auto",
        processingStaleMs: 180000,
      },
    },
    nativeLock: { timeoutMs: 4_000, staleMs: 500 },
  };
  return { config, decoyQueuePath, descriptor, descriptorPath, root };
};

const packetEvent = (suffix = "one", overrides = {}) => ({
  schemaVersion: 1,
  source: "openclaw.agent_end",
  scope: "profile:main",
  mode: "auto",
  sessionKey: `agent:main:synthetic-${suffix}`,
  decision: { action: "save", reason: "explicit_durable_request" },
  messages: [
    {
      role: "user",
      content: `Remember that the synthetic harbour queue decision ${suffix} remains durable across worker restarts.`,
    },
  ],
  ...overrides,
});

const readRows = (queuePath) => {
  if (!existsSync(queuePath)) return [];
  return readFileSync(queuePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const writeRows = (queuePath, rows) => writePrivate(
  queuePath,
  rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
);

const treeHash = (targetPath) => {
  if (!existsSync(targetPath)) return "missing";
  const hash = createHash("sha256");
  const visit = (current, relative) => {
    const stat = lstatSync(current);
    hash.update(`${relative}\0${stat.mode & 0o777}\0`);
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const entry of readdirSync(current).sort()) visit(path.join(current, entry), path.join(relative, entry));
      return;
    }
    hash.update("file\0");
    hash.update(readFileSync(current));
  };
  visit(targetPath, ".");
  return hash.digest("hex");
};

const stateVector = ({ descriptor, descriptorPath }) => ({
  db: treeHash(descriptor.dbPath),
  descriptor: treeHash(descriptorPath),
  graph: treeHash(descriptor.graphPath),
  output: treeHash(descriptor.outputDir),
  queue: treeHash(descriptor.autoCaptureQueuePath),
  vault: treeHash(descriptor.vaultPath),
});

const forceDue = (queuePath) => {
  const rows = readRows(queuePath);
  rows[0].next_attempt_at = new Date(Date.now() - 60_000).toISOString();
  writeRows(queuePath, rows);
};

const processStartIdentity = (pid = process.pid) => {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = raw.lastIndexOf(")");
  return raw.slice(close + 2).trim().split(/\s+/)[19];
};

const holdDescriptorLock = (current, label) => {
  const lockDir = current.descriptor.nativeLockDir;
  mkdirSync(lockDir, { mode: 0o700 });
  writePrivate(path.join(lockDir, "owner.json"), `${JSON.stringify({
    created_at: new Date().toISOString(),
    created_at_ms: Date.now(),
    owner: `synthetic-${label}`,
    pid: process.pid,
    process_start: processStartIdentity(),
    token: `synthetic-${label}`,
  })}\n`);
  return () => rmSync(lockDir, { recursive: true, force: true });
};

const withDecoyLocks = (current) => ({
  ...current.config,
  lockPath: path.join(current.root, "decoy-direct.lockdir"),
  nativeLockDir: path.join(current.root, "decoy-native.lockdir"),
  nativeLock: { timeoutMs: 80, staleMs: 10_000 },
  runtime: {
    ...current.config.runtime,
    paths: {
      ...current.config.runtime.paths,
      nativeLockDir: path.join(current.root, "decoy-runtime.lockdir"),
    },
  },
});

export async function run() {
  const queue = await importContractModule("lib/compat/auto-capture-queue.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const enqueueAutoCaptureEvent = requireCallable(queue, "enqueueAutoCaptureEvent");
    const processAutoCaptureQueue = requireCallable(queue, "processAutoCaptureQueue");
    assert.deepEqual(queue.AUTO_CAPTURE_QUEUE_STATUSES, [
      "pending",
      "processing",
      "completed",
      "failed_retryable",
      "failed_terminal",
      "dead_lettered",
      "resolved_historical",
    ]);

    const fixtures = [];
    const fixture = (label) => {
      const value = makeFixture(label);
      fixtures.push(value);
      return value;
    };

    try {
      {
        const current = fixture("enqueue");
        const oversizedMessages = Array.from({ length: 14 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${index}: ${"bounded synthetic text ".repeat(120)}`,
        }));
        const first = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("stable", { messages: oversizedMessages }),
          runId: "synthetic-run-one",
        });
        assert.equal(first.enqueued, true);
        assert.match(first.jobId, /^acq_[0-9a-f]{24}$/);
        assert.equal(first.reason, "queued");
        assert.equal(existsSync(current.decoyQueuePath), false, "only the descriptor queue path may be used");
        const rows = readRows(current.descriptor.autoCaptureQueuePath);
        assert.equal(rows.length, 1);
        assert.equal(lstatSync(current.descriptor.autoCaptureQueuePath).mode & 0o777, 0o600);
        assert.equal(rows[0].id, first.jobId);
        assert.match(rows[0].packet_hash, /^[0-9a-f]{64}$/);
        assert.equal(rows[0].status, "pending");
        assert.equal(rows[0].attempts, 0);
        assert.equal(rows[0].scope, "profile:main");
        assert.equal(rows[0].agent_id, "main");
        assert.equal(rows[0].session_key, "agent:main:synthetic-stable");
        assert.match(rows[0].created_at, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(rows[0].updated_at, rows[0].created_at);
        assert.equal(rows[0].next_attempt_at, "");
        assert.equal(rows[0].packet.messages.length, 10, "packets must retain at most ten turns");
        assert.equal(
          rows[0].packet.messages.every((message) => message.content.length <= 1500),
          true,
          "each retained turn must remain within the 1,500-character policy bound",
        );
        assert.deepEqual(
          Object.keys(rows[0].packet).sort(),
          ["decision", "messages", "mode", "schemaVersion", "scope", "sessionKey", "source"],
          "raw event fields must not survive packet normalization",
        );

        const beforeDuplicate = stateVector(current);
        const duplicate = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("stable", { messages: oversizedMessages, rawPacket: "must not survive" }),
          runId: "synthetic-run-two",
        });
        assert.deepEqual(duplicate, { enqueued: false, jobId: first.jobId, reason: "duplicate" });
        assert.deepEqual(stateVector(current), beforeDuplicate, "duplicate enqueue must preserve all state bytes");
      }

      {
        const current = fixture("concurrency");
        const same = await Promise.all(Array.from({ length: 8 }, () => enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("concurrent-same"),
          runId: "synthetic-concurrent",
        })));
        assert.equal(same.filter((result) => result.enqueued).length, 1);
        assert.equal(readRows(current.descriptor.autoCaptureQueuePath).length, 1);
        await Promise.all(Array.from({ length: 8 }, (_, index) => enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent(`concurrent-distinct-${index}`),
          runId: `synthetic-concurrent-${index}`,
        })));
        assert.equal(readRows(current.descriptor.autoCaptureQueuePath).length, 9, "concurrent appends must not lose jobs");
        assert.equal(existsSync(current.descriptor.nativeLockDir), false, "the shared lock must be ownership-safely released");
      }

      {
        const current = fixture("queue-bound");
        for (let index = 0; index < 100; index += 1) {
          const result = await enqueueAutoCaptureEvent({
            config: current.config,
            event: packetEvent(`bound-${index}`),
            runId: `synthetic-bound-${index}`,
          });
          assert.equal(result.enqueued, true);
        }
        const beforeFull = stateVector(current);
        const full = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("bound-overflow"),
          runId: "synthetic-bound-overflow",
        });
        assert.deepEqual(full, { enqueued: false, jobId: null, reason: "queue_full" });
        assert.equal(readRows(current.descriptor.autoCaptureQueuePath).length, 100);
        assert.deepEqual(stateVector(current), beforeFull, "queue-full rejection must not rewrite state");
      }

      if (shouldRunFixCase("row-bounds")) {
        const current = fixture("row-bound-zero-terminal-budget");
        await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("row-bound-template"),
          runId: "row-bound-template",
        });
        const template = readRows(current.descriptor.autoCaptureQueuePath)[0];
        const rows = Array.from({ length: 250 }, (_, index) => ({
          ...structuredClone(template),
          id: `acq_${sha256(`row-bound-${index}`).slice(0, 24)}`,
          packet_hash: sha256(`row-bound-packet-${index}`),
          session_key: `agent:main:row-bound-${index}`,
        }));
        rows.push({
          ...structuredClone(template),
          id: `acq_${sha256("row-bound-terminal").slice(0, 24)}`,
          packet_hash: sha256("row-bound-terminal-packet"),
          status: "completed",
          processed_at: new Date().toISOString(),
        });
        writeRows(current.descriptor.autoCaptureQueuePath, rows);
        const before = stateVector(current);
        await assert.rejects(
          () => processAutoCaptureQueue({
            config: current.config,
            limit: 1,
            processJob: async () => ({ autoSaved: 0, queuedReview: 0 }),
          }),
          /AUTO_CAPTURE_QUEUE_ROW_LIMIT/,
          "an over-bound persisted queue must fail closed instead of choosing rows to discard",
        );
        assert.deepEqual(stateVector(current), before);
      }

      {
        const current = fixture("success-limit");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("success-a"), runId: "success-a" });
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("success-b"), runId: "success-b" });
        let calls = 0;
        const result = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          dryRun: false,
          processJob: async ({ job, packet }) => {
            calls += 1;
            const persisted = readRows(current.descriptor.autoCaptureQueuePath).find((row) => row.id === job.id);
            assert.equal(persisted.status, "processing", "processing must be persisted before dispatch");
            assert.equal(persisted.attempts, 1);
            assert.equal(persisted.packet_hash, job.packet_hash);
            assert.deepEqual(persisted.packet, packet);
            return {
              autoSaved: 1,
              queuedReview: 2,
              rawCandidate: "terminal rows must not retain this synthetic candidate",
            };
          },
        });
        assert.equal(calls, 1);
        assert.deepEqual(
          {
            autoSaved: result.autoSaved,
            completed: result.completed,
            inspected: result.inspected,
            mutated: result.mutated,
            processed: result.processed,
            queuedReview: result.queuedReview,
            retryable: result.retryable,
            terminal: result.terminal,
          },
          {
            autoSaved: 1,
            completed: 1,
            inspected: 2,
            mutated: true,
            processed: 1,
            queuedReview: 2,
            retryable: 0,
            terminal: 0,
          },
        );
        const rows = readRows(current.descriptor.autoCaptureQueuePath);
        const completed = rows.find((row) => row.status === "completed");
        assert.ok(completed);
        assert.equal(Object.hasOwn(completed, "packet"), false, "completed rows must scrub raw packets");
        assert.equal(completed.packet_summary.packet_scrubbed, true);
        assert.equal(completed.packet_summary.packet_hash, completed.packet_hash);
        assert.equal(completed.result.auto_saved, 1);
        assert.equal(completed.result.queued_review, 2);
        assert.match(completed.result.result_hash, /^[0-9a-f]{64}$/);
        assert.equal(JSON.stringify(completed).includes("terminal rows must not retain"), false);
        assert.equal(rows.filter((row) => row.status === "pending").length, 1, "--limit 1 must leave the second job pending");
      }

      {
        const current = fixture("retry");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("retry"), runId: "retry" });
        const retryingProcessor = async () => {
          const error = new Error("connect ECONNREFUSED with synthetic private candidate text");
          error.code = "ECONNREFUSED";
          throw error;
        };
        const first = await processAutoCaptureQueue({ config: current.config, limit: 1, processJob: retryingProcessor });
        assert.equal(first.retryable, 1);
        let row = readRows(current.descriptor.autoCaptureQueuePath)[0];
        assert.equal(row.status, "failed_retryable");
        assert.equal(row.attempts, 1);
        assert.equal(row.error_class, "network");
        assert.equal(row.error_message, "network", "stored errors must be classified instead of retaining raw messages");
        assert.equal(JSON.stringify(row).includes("synthetic private candidate text"), false);
        assert.match(row.next_attempt_at, /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(row.packet, "retryable jobs must retain the bounded packet");
        const deferredBefore = stateVector(current);
        const deferred = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          processJob: async () => { throw new Error("must not dispatch before next_attempt_at"); },
        });
        assert.equal(deferred.processed, 0);
        assert.equal(deferred.mutated, false);
        assert.deepEqual(stateVector(current), deferredBefore);

        forceDue(current.descriptor.autoCaptureQueuePath);
        const second = await processAutoCaptureQueue({ config: current.config, limit: 1, processJob: retryingProcessor });
        assert.equal(second.retryable, 1);
        forceDue(current.descriptor.autoCaptureQueuePath);
        const third = await processAutoCaptureQueue({ config: current.config, limit: 1, processJob: retryingProcessor });
        assert.equal(third.terminal, 1);
        row = readRows(current.descriptor.autoCaptureQueuePath)[0];
        assert.equal(row.status, "dead_lettered", "the third retryable failure must exhaust the bounded attempt budget");
        assert.equal(row.attempts, 3);
        assert.equal(Object.hasOwn(row, "packet"), false);
        assert.equal(row.packet_summary.packet_hash, row.packet_hash);
      }

      {
        const current = fixture("terminal");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("terminal"), runId: "terminal" });
        const result = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          processJob: async () => {
            const error = new Error("invalid payload contained synthetic candidate content");
            error.code = "AUTO_CAPTURE_INVALID_PAYLOAD";
            throw error;
          },
        });
        assert.equal(result.terminal, 1);
        const row = readRows(current.descriptor.autoCaptureQueuePath)[0];
        assert.equal(row.status, "failed_terminal");
        assert.equal(row.error_class, "invalid_payload");
        assert.equal(row.error_message, "invalid_payload");
        assert.equal(Object.hasOwn(row, "packet"), false);
        assert.equal(JSON.stringify(row).includes("synthetic candidate content"), false);
      }

      {
        const current = fixture("stale");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("stale"), runId: "stale" });
        let rows = readRows(current.descriptor.autoCaptureQueuePath);
        rows[0] = {
          ...rows[0],
          attempts: 1,
          error_class: "",
          error_message: "",
          processing_owner: "synthetic-crashed-worker",
          processing_started_at: new Date(Date.now() - 190_000).toISOString(),
          status: "processing",
          updated_at: new Date(Date.now() - 190_000).toISOString(),
        };
        writeRows(current.descriptor.autoCaptureQueuePath, rows);
        let dispatched = false;
        const result = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          processJob: async () => { dispatched = true; },
        });
        assert.equal(dispatched, false, "stale recovery must back off instead of immediately redispatching");
        assert.equal(result.processingRecovered, 1);
        assert.equal(result.processed, 0);
        assert.equal(result.retryable, 1);
        assert.equal(result.mutated, true);
        rows = readRows(current.descriptor.autoCaptureQueuePath);
        assert.equal(rows[0].status, "failed_retryable");
        assert.equal(rows[0].error_class, "timeout_or_aborted");
        assert.equal(rows[0].error_message, "stale_processing_recovered");
        assert.ok(Date.parse(rows[0].next_attempt_at) > Date.now());
        assert.equal(Object.hasOwn(rows[0], "processing_owner"), false);
      }

      {
        const current = fixture("fresh-processing");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("fresh"), runId: "fresh" });
        const rows = readRows(current.descriptor.autoCaptureQueuePath);
        rows[0] = {
          ...rows[0],
          attempts: 1,
          error_class: "",
          error_message: "",
          processing_owner: "synthetic-live-worker",
          processing_started_at: new Date(Date.now() - 170_000).toISOString(),
          status: "processing",
          updated_at: new Date(Date.now() - 170_000).toISOString(),
        };
        writeRows(current.descriptor.autoCaptureQueuePath, rows);
        const before = stateVector(current);
        const result = await processAutoCaptureQueue({ config: current.config, limit: 1, processJob: async () => undefined });
        assert.equal(result.processingRecovered, 0, "processingStaleMs must remain exactly 180000ms");
        assert.equal(result.processed, 0);
        assert.equal(result.mutated, false);
        assert.deepEqual(stateVector(current), before, "fresh processing rows are a no-op path");
      }

      {
        const current = fixture("circuit");
        for (let index = 0; index < 4; index += 1) {
          await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent(`circuit-${index}`), runId: `circuit-${index}` });
        }
        const now = Date.now();
        const rows = readRows(current.descriptor.autoCaptureQueuePath).map((row, index) => index < 3 ? {
          ...row,
          attempts: 1,
          error_class: "network",
          error_message: "network",
          next_attempt_at: new Date(now + 120_000).toISOString(),
          status: "failed_retryable",
          updated_at: new Date(now - 1_000).toISOString(),
        } : row);
        writeRows(current.descriptor.autoCaptureQueuePath, rows);
        const before = stateVector(current);
        let dispatched = false;
        const result = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          processJob: async () => { dispatched = true; },
        });
        assert.equal(dispatched, false);
        assert.equal(result.circuitOpen, true);
        assert.equal(result.circuitFailureCount, 3);
        assert.equal(result.processed, 0);
        assert.equal(result.mutated, false);
        assert.deepEqual(stateVector(current), before, "an open circuit must not rewrite queue or adjacent state");
      }

      if (shouldRunFixCase("circuit-attempts")) {
        const current = fixture("circuit-attempts");
        const failing = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("circuit-retry-one-job"),
          runId: "circuit-retry-one-job",
        });
        const later = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("circuit-later-pending"),
          runId: "circuit-later-pending",
        });
        const calls = [];
        const failProvider = async ({ job }) => {
          calls.push(job.id);
          const error = new Error("fetch failed with raw provider response sentinel");
          error.code = "ECONNRESET";
          throw error;
        };
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const outcome = await processAutoCaptureQueue({
            config: current.config,
            limit: 1,
            processJob: failProvider,
          });
          assert.equal(outcome.processed, 1);
          if (attempt < 3) {
            const rows = readRows(current.descriptor.autoCaptureQueuePath);
            const row = rows.find((entry) => entry.id === failing.jobId);
            row.next_attempt_at = new Date(Date.now() - 60_000).toISOString();
            writeRows(current.descriptor.autoCaptureQueuePath, rows);
          }
        }
        assert.deepEqual(calls, [failing.jobId, failing.jobId, failing.jobId]);
        const failedRow = readRows(current.descriptor.autoCaptureQueuePath)
          .find((row) => row.id === failing.jobId);
        assert.equal(failedRow.status, "dead_lettered");
        assert.equal(failedRow.provider_failure_count, 3);
        assert.equal(failedRow.provider_failure_timestamps.length, 3);
        assert.equal(
          failedRow.provider_failure_timestamps.every((value) => /^\d{4}-\d{2}-\d{2}T/.test(value)),
          true,
        );
        assert.equal(JSON.stringify(failedRow).includes("raw provider response"), false);

        const beforeBlocked = stateVector(current);
        let laterDispatched = false;
        const blocked = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          processJob: async ({ job }) => {
            laterDispatched = job.id === later.jobId;
            return { autoSaved: 0, queuedReview: 0 };
          },
        });
        assert.equal(laterDispatched, false, "three provider failures from one job must block a later pending job");
        assert.equal(blocked.circuitOpen, true);
        assert.equal(blocked.circuitFailureCount, 3);
        assert.equal(blocked.processed, 0);
        assert.equal(blocked.mutated, false);
        assert.deepEqual(stateVector(current), beforeBlocked);
      }

      if (shouldRunFixCase("legacy-circuit-history")) {
        const current = fixture("legacy-circuit-history");
        const failing = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("legacy-circuit-failing"),
          runId: "legacy-circuit-failing",
        });
        const later = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("legacy-circuit-later"),
          runId: "legacy-circuit-later",
        });
        const legacyFailureAt = new Date(Date.now() - 1_000).toISOString();
        let rows = readRows(current.descriptor.autoCaptureQueuePath);
        const legacyRetry = rows.find((row) => row.id === failing.jobId);
        legacyRetry.attempts = 1;
        legacyRetry.error_class = "network";
        legacyRetry.error_message = "network";
        legacyRetry.next_attempt_at = new Date(Date.now() - 500).toISOString();
        legacyRetry.status = "failed_retryable";
        legacyRetry.updated_at = legacyFailureAt;
        delete legacyRetry.provider_failure_count;
        delete legacyRetry.provider_failure_timestamps;
        writeRows(current.descriptor.autoCaptureQueuePath, rows);

        const calls = [];
        const failProvider = async ({ job }) => {
          calls.push(job.id);
          const error = new Error("fetch failed with raw legacy retry sentinel");
          error.code = "ECONNRESET";
          throw error;
        };
        for (let attempt = 2; attempt <= 3; attempt += 1) {
          const outcome = await processAutoCaptureQueue({
            config: current.config,
            limit: 1,
            processJob: failProvider,
          });
          assert.equal(outcome.processed, 1);
          if (attempt < 3) {
            rows = readRows(current.descriptor.autoCaptureQueuePath);
            rows.find((row) => row.id === failing.jobId).next_attempt_at = new Date(Date.now() - 500).toISOString();
            writeRows(current.descriptor.autoCaptureQueuePath, rows);
          }
        }
        assert.deepEqual(calls, [failing.jobId, failing.jobId]);
        const terminal = readRows(current.descriptor.autoCaptureQueuePath).find((row) => row.id === failing.jobId);
        assert.equal(terminal.status, "dead_lettered");
        assert.equal(terminal.attempts, 3, "legacy history must not increase the exact three-attempt execution ceiling");
        assert.equal(terminal.provider_failure_count, 3);
        assert.deepEqual(terminal.provider_failure_timestamps[0], legacyFailureAt);
        assert.equal(JSON.stringify(terminal).includes("raw legacy retry"), false);

        const beforeBlocked = stateVector(current);
        let laterDispatched = false;
        const blocked = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          processJob: async ({ job }) => {
            laterDispatched = job.id === later.jobId;
            return { autoSaved: 0, queuedReview: 0 };
          },
        });
        assert.equal(laterDispatched, false);
        assert.equal(blocked.circuitOpen, true);
        assert.equal(blocked.circuitFailureCount, 3);
        assert.equal(blocked.processed, 0);
        assert.equal(blocked.mutated, false);
        assert.deepEqual(stateVector(current), beforeBlocked);

        const terminalFixture = fixture("legacy-terminal-history");
        const historical = await enqueueAutoCaptureEvent({
          config: terminalFixture.config,
          event: packetEvent("legacy-terminal-history"),
          runId: "legacy-terminal-history",
        });
        await enqueueAutoCaptureEvent({
          config: terminalFixture.config,
          event: packetEvent("legacy-terminal-trigger"),
          runId: "legacy-terminal-trigger",
        });
        rows = readRows(terminalFixture.descriptor.autoCaptureQueuePath);
        const legacyTerminal = rows.find((row) => row.id === historical.jobId);
        legacyTerminal.attempts = 1;
        legacyTerminal.error_class = "network";
        legacyTerminal.error_message = "network";
        legacyTerminal.next_attempt_at = "";
        legacyTerminal.status = "failed_terminal";
        legacyTerminal.updated_at = legacyFailureAt;
        delete legacyTerminal.provider_failure_count;
        delete legacyTerminal.provider_failure_timestamps;
        writeRows(terminalFixture.descriptor.autoCaptureQueuePath, rows);
        await processAutoCaptureQueue({
          config: terminalFixture.config,
          limit: 1,
          processJob: async () => ({ autoSaved: 0, queuedReview: 0 }),
        });
        const seededTerminal = readRows(terminalFixture.descriptor.autoCaptureQueuePath)
          .find((row) => row.id === historical.jobId);
        assert.equal(seededTerminal.provider_failure_count, 1);
        assert.deepEqual(seededTerminal.provider_failure_timestamps, [legacyFailureAt]);
      }

      if (shouldRunFixCase("stale-circuit-history")) {
        const current = fixture("stale-circuit-history");
        const stale = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("stale-circuit-one-job"),
          runId: "stale-circuit-one-job",
        });
        let dispatched = false;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const rows = readRows(current.descriptor.autoCaptureQueuePath);
          const row = rows.find((entry) => entry.id === stale.jobId);
          const staleAt = new Date(Date.now() - 190_000).toISOString();
          row.attempts = attempt;
          row.error_class = "";
          row.error_message = "";
          row.next_attempt_at = "";
          row.processing_owner = `synthetic-stale-owner-${attempt}`;
          row.processing_started_at = staleAt;
          row.status = "processing";
          row.updated_at = staleAt;
          writeRows(current.descriptor.autoCaptureQueuePath, rows);
          const recovered = await processAutoCaptureQueue({
            config: current.config,
            limit: 1,
            processJob: async () => { dispatched = true; },
          });
          assert.equal(recovered.processingRecovered, 1);
          assert.equal(recovered.processed, 0);
          assert.equal(dispatched, false);
          const recoveredRow = readRows(current.descriptor.autoCaptureQueuePath)
            .find((entry) => entry.id === stale.jobId);
          assert.equal(recoveredRow.provider_failure_count, attempt);
          assert.equal(recoveredRow.provider_failure_timestamps.length, attempt);
          assert.equal(recoveredRow.error_class, "timeout_or_aborted");
          assert.equal(recoveredRow.error_message, "stale_processing_recovered");
        }
        const terminal = readRows(current.descriptor.autoCaptureQueuePath).find((row) => row.id === stale.jobId);
        assert.equal(terminal.status, "dead_lettered");
        assert.equal(terminal.attempts, 3);
        assert.equal(terminal.provider_failure_count, 3);

        const later = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("stale-circuit-later"),
          runId: "stale-circuit-later",
        });
        const beforeBlocked = stateVector(current);
        const blocked = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          processJob: async ({ job }) => {
            dispatched = job.id === later.jobId;
            return { autoSaved: 0, queuedReview: 0 };
          },
        });
        assert.equal(dispatched, false);
        assert.equal(blocked.circuitOpen, true);
        assert.equal(blocked.circuitFailureCount, 3);
        assert.equal(blocked.processed, 0);
        assert.equal(blocked.mutated, false);
        assert.deepEqual(stateVector(current), beforeBlocked);
      }

      if (shouldRunFixCase("producer-normalization")) {
        const current = fixture("producer-normalization");
        const exactMessage = "m".repeat(1_500);
        const exactSession = "s".repeat(256);
        const exactReason = "r".repeat(256);
        const exactRunId = "u".repeat(256);
        const exact = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("exact-bounds", {
            decision: { action: "save", reason: exactReason },
            messages: [{ role: "user", content: exactMessage }],
            sessionKey: exactSession,
          }),
          runId: exactRunId,
        });
        assert.equal(exact.enqueued, true);

        const cutMessage = `${"a".repeat(1_499)} tail-beyond-boundary`;
        const cutSession = `${"b".repeat(255)} trailing-session`;
        const cutReason = `${"c".repeat(255)} trailing-reason`;
        const cutRunId = `${"d".repeat(255)} trailing-run-id`;
        const cut = await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("cut-bounds", {
            decision: { action: "save", reason: cutReason },
            messages: [{ role: "user", content: cutMessage }],
            sessionKey: cutSession,
          }),
          runId: cutRunId,
        });
        assert.equal(cut.enqueued, true);

        const rows = readRows(current.descriptor.autoCaptureQueuePath);
        const exactRow = rows.find((row) => row.id === exact.jobId);
        const cutRow = rows.find((row) => row.id === cut.jobId);
        assert.equal(exactRow.packet.messages[0].content, exactMessage);
        assert.equal(exactRow.session_key, exactSession);
        assert.equal(exactRow.packet.decision.reason, exactReason);
        assert.equal(exactRow.run_id, exactRunId);
        assert.equal(cutRow.packet.messages[0].content, "a".repeat(1_499));
        assert.equal(cutRow.session_key, "b".repeat(255));
        assert.equal(cutRow.packet.decision.reason, "c".repeat(255));
        assert.equal(cutRow.run_id, "d".repeat(255));
        for (const value of [
          cutRow.packet.messages[0].content,
          cutRow.session_key,
          cutRow.packet.decision.reason,
          cutRow.run_id,
        ]) assert.equal(value, value.trim(), "persisted bounded text must be normalized after truncation");

        const before = stateVector(current);
        const dryRun = await processAutoCaptureQueue({ config: current.config, limit: 2, dryRun: true });
        assert.equal(dryRun.inspected, 2, "producer rows must be readable by the canonical persisted-row validator");
        assert.equal(dryRun.mutated, false);
        assert.deepEqual(stateVector(current), before);
      }

      {
        const current = fixture("dry-run");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("dry-run"), runId: "dry-run" });
        const before = stateVector(current);
        let dispatched = false;
        const result = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          dryRun: true,
          processJob: async () => { dispatched = true; },
        });
        assert.equal(dispatched, false);
        assert.equal(result.inspected, 1);
        assert.equal(result.processed, 0);
        assert.equal(result.mutated, false);
        assert.deepEqual(stateVector(current), before, "dry-run must preserve DB/queue/output/graph/vault bytes");
      }

      {
        const current = fixture("empty");
        const before = stateVector(current);
        const result = await processAutoCaptureQueue({ config: current.config, limit: 1, processJob: async () => undefined });
        assert.equal(result.inspected, 0);
        assert.equal(result.processed, 0);
        assert.equal(result.mutated, false);
        assert.equal(result.reason, "empty_queue");
        assert.deepEqual(stateVector(current), before, "empty queue processing must create no state");
      }

      {
        const current = fixture("no-processor");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("no-processor"), runId: "no-processor" });
        const before = stateVector(current);
        const result = await processAutoCaptureQueue({ config: current.config, limit: 1 });
        assert.equal(result.reason, "processor_unavailable");
        assert.equal(result.processed, 0);
        assert.equal(result.mutated, false);
        assert.deepEqual(stateVector(current), before, "9B must not invent model/review processing before 9C/9D");
      }

      {
        const current = fixture("write-mode");
        const readOnly = { ...current.config, compat: { writeMode: "read_only" } };
        const before = stateVector(current);
        await assert.rejects(
          () => enqueueAutoCaptureEvent({ config: readOnly, event: packetEvent("read-only"), runId: "read-only" }),
          /GIGABRAIN_WRITE_FORBIDDEN/,
        );
        assert.deepEqual(stateVector(current), before);
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("processable"), runId: "processable" });
        const beforeProcess = stateVector(current);
        await assert.rejects(
          () => processAutoCaptureQueue({ config: readOnly, limit: 1, processJob: async () => undefined }),
          /GIGABRAIN_WRITE_FORBIDDEN/,
        );
        assert.deepEqual(stateVector(current), beforeProcess, "write-mode rejection must precede lock or queue mutation");
        const dryRun = await processAutoCaptureQueue({ config: readOnly, limit: 1, dryRun: true });
        assert.equal(dryRun.mutated, false, "read-only dry-run remains observational");
      }

      if (shouldRunFixCase("descriptor-lock")) {
        const current = fixture("descriptor-lock-authority");
        const decoyConfig = withDecoyLocks(current);
        let release = holdDescriptorLock(current, "enqueue-held");
        try {
          await assert.rejects(
            () => enqueueAutoCaptureEvent({
              config: decoyConfig,
              event: packetEvent("descriptor-lock-enqueue"),
              runId: "descriptor-lock-enqueue",
            }),
            /GIGABRAIN_NATIVE_LOCK_TIMEOUT/,
            "enqueue must wait on the descriptor lock even when every caller lock field is a decoy",
          );
          assert.equal(existsSync(current.descriptor.autoCaptureQueuePath), false);
        } finally {
          release();
        }

        await enqueueAutoCaptureEvent({
          config: decoyConfig,
          event: packetEvent("descriptor-lock-process"),
          runId: "descriptor-lock-process",
        });
        const beforeClaim = stateVector(current);
        release = holdDescriptorLock(current, "claim-held");
        try {
          await assert.rejects(
            () => processAutoCaptureQueue({
              config: decoyConfig,
              limit: 1,
              processJob: async () => ({ autoSaved: 0, queuedReview: 0 }),
            }),
            /GIGABRAIN_NATIVE_LOCK_TIMEOUT/,
            "claim and recovery must wait on the descriptor lock",
          );
          assert.deepEqual(stateVector(current), beforeClaim);
        } finally {
          release();
        }

        let releaseFinalize;
        try {
          await assert.rejects(
            () => processAutoCaptureQueue({
              config: decoyConfig,
              limit: 1,
              processJob: async () => {
                releaseFinalize = holdDescriptorLock(current, "finalize-held");
                return { autoSaved: 0, queuedReview: 0 };
              },
            }),
            /GIGABRAIN_NATIVE_LOCK_TIMEOUT/,
            "finalize must use the same descriptor-authoritative lock as claim",
          );
        } finally {
          releaseFinalize?.();
        }
        const processing = readRows(current.descriptor.autoCaptureQueuePath)[0];
        assert.equal(processing.status, "processing", "a blocked finalize must leave the durable claim for stale recovery");
        for (const decoy of [decoyConfig.lockPath, decoyConfig.nativeLockDir, decoyConfig.runtime.paths.nativeLockDir]) {
          assert.equal(existsSync(decoy), false, `decoy lock must remain unused: ${path.basename(decoy)}`);
        }
      }

      if (shouldRunFixCase("row-schema")) {
        const invalidCases = [
          ["attempt-string", (rows) => { rows[0].attempts = "1"; }],
          ["attempt-overflow", (rows) => { rows[0].attempts = 4; }],
          ["job-id-format", (rows) => { rows[0].id = "unstable-job"; }],
          ["packet-hash-format", (rows) => { rows[0].packet_hash = "not-a-hash"; }],
          ["packet-hash-mismatch", (rows) => {
            rows[0].packet_hash = sha256("different-packet");
            rows[0].id = `acq_${rows[0].packet_hash.slice(0, 24)}`;
          }],
          ["job-id-unstable", (rows) => { rows[0].id = `acq_${"f".repeat(24)}`; }],
          ["created-timestamp", (rows) => { rows[0].created_at = "not-a-timestamp"; }],
          ["updated-timestamp", (rows) => { delete rows[0].updated_at; }],
          ["pending-packet", (rows) => { rows[0].packet.messages = []; }],
          ["processing-state", (rows) => {
            rows[0].attempts = 1;
            rows[0].status = "processing";
            delete rows[0].processing_owner;
            delete rows[0].processing_started_at;
          }],
          ["retry-state", (rows) => {
            rows[0].attempts = 1;
            rows[0].error_class = "network";
            rows[0].error_message = "network";
            rows[0].next_attempt_at = "";
            rows[0].status = "failed_retryable";
          }],
          ["completed-state", (rows) => {
            rows[0].status = "completed";
            delete rows[0].packet;
            delete rows[0].processed_at;
          }],
          ["active-extra-field", (rows) => { rows[0].rawCandidate = "must not be admitted"; }],
          ["duplicate-row", (rows) => { rows.push(structuredClone(rows[0])); }],
        ];
        const outcomes = [];
        let dispatched = 0;
        for (const [label, mutate] of invalidCases) {
          const current = fixture(`invalid-${label}`);
          await enqueueAutoCaptureEvent({
            config: current.config,
            event: packetEvent(`invalid-${label}`),
            runId: `invalid-${label}`,
          });
          const rows = readRows(current.descriptor.autoCaptureQueuePath);
          mutate(rows);
          writeRows(current.descriptor.autoCaptureQueuePath, rows);
          const before = stateVector(current);
          let code = "resolved";
          try {
            await processAutoCaptureQueue({
              config: current.config,
              limit: 1,
              processJob: async () => {
                dispatched += 1;
                return { autoSaved: 0, queuedReview: 0 };
              },
            });
          } catch (error) {
            code = String(error?.code || error?.message || "").split(":")[0];
          }
          outcomes.push({ code, unchanged: JSON.stringify(stateVector(current)) === JSON.stringify(before) });
        }
        assert.deepEqual(
          outcomes,
          invalidCases.map(() => ({ code: "AUTO_CAPTURE_QUEUE_ROW_INVALID", unchanged: true })),
          "every malformed persisted row must fail before dispatch or rewrite",
        );
        assert.equal(dispatched, 0);

        const oversized = fixture("invalid-row-size");
        await enqueueAutoCaptureEvent({
          config: oversized.config,
          event: packetEvent("invalid-row-size"),
          runId: "invalid-row-size",
        });
        const oversizedRows = readRows(oversized.descriptor.autoCaptureQueuePath);
        oversizedRows[0].run_id = "x".repeat(70_000);
        writeRows(oversized.descriptor.autoCaptureQueuePath, oversizedRows);
        const oversizedBefore = stateVector(oversized);
        await assert.rejects(
          () => processAutoCaptureQueue({
            config: oversized.config,
            limit: 1,
            processJob: async () => ({ autoSaved: 0, queuedReview: 0 }),
          }),
          /AUTO_CAPTURE_QUEUE_ROW_SIZE_INVALID/,
        );
        assert.deepEqual(stateVector(oversized), oversizedBefore);
      }

      if (shouldRunFixCase("terminal-allowlist")) {
        const current = fixture("terminal-allowlist");
        await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("legacy-terminal"),
          runId: "legacy-terminal",
        });
        await enqueueAutoCaptureEvent({
          config: current.config,
          event: packetEvent("terminal-trigger"),
          runId: "terminal-trigger",
        });
        const rows = readRows(current.descriptor.autoCaptureQueuePath);
        rows[0] = {
          ...rows[0],
          status: "completed",
          processed_at: new Date().toISOString(),
          error_class: "network",
          error_message: "raw legacy error sentinel must be removed",
          rawCandidate: "raw legacy candidate sentinel must be removed",
          raw_result: "raw legacy result sentinel must be removed",
          unexpected: { content: "nested legacy sentinel must be removed" },
          result: {
            auto_saved: 0,
            queued_review: 0,
            rawCandidate: "raw aggregate sentinel must be removed",
          },
        };
        writeRows(current.descriptor.autoCaptureQueuePath, rows);
        const processed = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          processJob: async () => ({
            autoSaved: 0,
            queuedReview: 1,
            rawCandidate: "raw live candidate sentinel must be removed",
          }),
        });
        assert.equal(processed.completed, 1);
        const terminalRows = readRows(current.descriptor.autoCaptureQueuePath);
        assert.equal(terminalRows.every((row) => row.status === "completed"), true);
        const safeTerminalKeys = new Set([
          "agent_id",
          "attempts",
          "created_at",
          "error_class",
          "error_message",
          "id",
          "next_attempt_at",
          "packet_hash",
          "packet_summary",
          "processed_at",
          "provider_failure_count",
          "provider_failure_timestamps",
          "result",
          "run_id",
          "scope",
          "session_key",
          "status",
          "terminal_at",
          "updated_at",
        ]);
        for (const row of terminalRows) {
          assert.equal(
            Object.keys(row).every((key) => safeTerminalKeys.has(key)),
            true,
            `terminal row retained non-audit field(s): ${Object.keys(row).filter((key) => !safeTerminalKeys.has(key)).join(",")}`,
          );
        }
        const serialized = JSON.stringify(terminalRows);
        for (const sentinel of ["raw legacy", "nested legacy", "raw aggregate", "raw live"]) {
          assert.equal(serialized.includes(sentinel), false, `terminal rewrite retained ${sentinel} content`);
        }
      }

      if (shouldRunFixCase("directory-fsync")) {
        const current = fixture("directory-fsync");
        const observed = [];
        const originalFsyncSync = fs.fsyncSync;
        fs.fsyncSync = (descriptor) => {
          const stat = fs.fstatSync(descriptor);
          observed.push(stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other");
          return originalFsyncSync(descriptor);
        };
        try {
          const result = await enqueueAutoCaptureEvent({
            config: current.config,
            event: packetEvent("directory-fsync"),
            runId: "directory-fsync",
          });
          assert.equal(result.enqueued, true);
        } finally {
          fs.fsyncSync = originalFsyncSync;
        }
        assert.equal(observed.includes("file"), true, "queue replacement must fsync its temporary file");
        assert.equal(
          observed.includes("directory"),
          true,
          "queue replacement must fsync the parent directory after the atomic rename",
        );
        assert.ok(
          observed.lastIndexOf("directory") > observed.indexOf("file"),
          "the durable directory sync must follow the file sync",
        );
        assert.equal(readRows(current.descriptor.autoCaptureQueuePath).length, 1);
      }

      {
        const current = fixture("unknown-status");
        const now = new Date().toISOString();
        writeRows(current.descriptor.autoCaptureQueuePath, [{
          attempts: 0,
          created_at: now,
          id: `acq_${sha256("unknown-status").slice(0, 24)}`,
          packet_hash: sha256("unknown-status-packet"),
          status: "invented_status",
          updated_at: now,
        }]);
        const before = stateVector(current);
        await assert.rejects(
          () => processAutoCaptureQueue({ config: current.config, limit: 1, processJob: async () => undefined }),
          /AUTO_CAPTURE_QUEUE_STATUS_INVALID/,
        );
        assert.deepEqual(stateVector(current), before, "invalid queue state must fail closed without a rewrite");
      }
    } finally {
      for (const current of fixtures) rmSync(current.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

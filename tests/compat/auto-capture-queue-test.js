import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

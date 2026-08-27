import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
import { parentPort, isMainThread, Worker, workerData } from "node:worker_threads";

import {
  appendCheckpointEpisode,
  ensureControlPlaneStore,
  getCheckpointEpisode,
  getMemoryReceipt,
  listClaimProposals,
  listCheckpointEpisodes,
} from "../../lib/core/control-plane.js";
import { migrateLegacyCheckpoints } from "../../lib/core/checkpoint-migration.js";
import { buildSessionHookCommand } from "../../lib/core/lifecycle-hooks.js";
import { ensureProjectionStore } from "../../lib/core/projection-store.js";
import { openDatabase } from "../../lib/core/sqlite.js";
import {
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "13";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_CHECKPOINT_CONCURRENCY missing atomic scope-session checkpoint governance";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const snapshotTree = (root) => {
  const rows = [];
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        rows.push({ mode: stat.mode & 0o777, path: relative, type: "directory" });
        walk(absolute, relative);
      } else if (stat.isFile()) {
        rows.push({ hash: sha256(readFileSync(absolute)), mode: stat.mode & 0o777, path: relative, type: "file" });
      } else {
        rows.push({ mode: stat.mode & 0o777, path: relative, type: "special" });
      }
    }
  };
  walk(root);
  return rows;
};

const checkpointInput = ({ checkpointId, scope, sessionId }) => ({
  checkpointId,
  createdAt: "2026-08-27T12:00:00.000Z",
  durableCandidates: ["Synthetic durable candidate must remain proposal-only."],
  evidence: ["test:task13-checkpoint-concurrency"],
  repo: { branch: "task13", commit: "synthetic", dirty: false, root: "/synthetic/repo" },
  scope,
  sessionId,
  sourceAgent: "codex",
  sourceClient: "codex",
  sourceHost: "synthetic-worker",
  summary: "Synthetic concurrent checkpoint governance fixture.",
});

const runCheckpointWorker = async () => {
  const barrier = new Int32Array(workerData.barrier);
  const db = openDatabase(workerData.dbPath);
  try {
    Atomics.add(barrier, 0, 1);
    Atomics.notify(barrier, 0);
    Atomics.wait(barrier, 1, 0, 30_000);
    const result = appendCheckpointEpisode(db, checkpointInput(workerData));
    parentPort.postMessage({
      checkpointId: result?.checkpoint?.checkpoint_id || null,
      deduplicated: result?.deduplicated === true,
      ok: true,
      receiptId: result?.receipt_id || null,
    });
  } catch (error) {
    parentPort.postMessage({ error: String(error?.message || error), ok: false });
  } finally {
    db.close();
  }
};

const waitForWorker = (worker) => new Promise((resolve, reject) => {
  let result = null;
  worker.once("message", (message) => { result = message; });
  worker.once("error", reject);
  worker.once("exit", (code) => {
    if (code !== 0) reject(new Error(`checkpoint worker exited ${code}`));
    else resolve(result);
  });
});

export async function run() {
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task13-checkpoint-"));
    const dbPath = path.join(root, "registry.sqlite");
    const scope = "project:synthetic-a";
    const sessionId = "session:task13-concurrent";
    try {
      const initialized = openDatabase(dbPath);
      ensureProjectionStore(initialized);
      ensureControlPlaneStore(initialized);
      initialized.close();

      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const state = new Int32Array(barrier);
      const workers = ["cp_task13_a", "cp_task13_b"].map((checkpointId) => new Worker(
        new URL(import.meta.url),
        { workerData: { barrier, checkpointId, dbPath, kind: "checkpoint-race", scope, sessionId } },
      ));
      while (Atomics.load(state, 0) < workers.length) Atomics.wait(state, 0, Atomics.load(state, 0), 100);
      Atomics.store(state, 1, 1);
      Atomics.notify(state, 1, workers.length);
      const raced = await Promise.all(workers.map(waitForWorker));
      assert.equal(raced.every((row) => row?.ok === true), true, "both workers must resolve through create-or-deduplicate");
      assert.equal(raced.filter((row) => row.deduplicated === true).length, 1, "exactly one worker must receive a dedup receipt");
      assert.equal(new Set(raced.map((row) => row.checkpointId)).size, 1, "both workers must resolve to one checkpoint id");

      const verified = openDatabase(dbPath);
      try {
        const rows = verified.prepare(`
          SELECT checkpoint_id FROM memory_checkpoints WHERE scope=? AND session_id=?
        `).all(scope, sessionId);
        assert.equal(rows.length, 1, "one checkpoint must exist per scope/session");
        const index = verified.prepare("PRAGMA index_list(memory_checkpoints)").all()
          .find((row) => row.name === "idx_memory_checkpoints_scope_session_unique");
        assert.equal(Number(index?.unique), 1, "scope/session governance requires the exact unique index");
        assert.deepEqual(
          verified.prepare("PRAGMA index_info(idx_memory_checkpoints_scope_session_unique)").all()
            .map((row) => row.name),
          ["scope", "session_id"],
        );
        const dedupResult = raced.find((row) => row.deduplicated === true);
        const dedupReceipt = getMemoryReceipt(verified, dedupResult.receiptId, { allowedScopes: [scope] });
        assert.equal(dedupReceipt.receipt_type, "checkpoint_dedup");
        assert.equal(dedupReceipt.status, "deduplicated");
        assert.equal(dedupReceipt.session_id, sessionId);

        const otherScope = appendCheckpointEpisode(verified, checkpointInput({
          checkpointId: "cp_task13_other_scope",
          scope: "project:synthetic-b",
          sessionId,
        }));
        assert.notEqual(otherScope.checkpoint.checkpoint_id, rows[0].checkpoint_id);
        assert.equal(
          getCheckpointEpisode(verified, rows[0].checkpoint_id, { allowedScopes: ["project:synthetic-b"] }),
          null,
          "checkpoint reads must not leak across scopes",
        );
        assert.deepEqual(
          listCheckpointEpisodes(verified, { allowedScopes: [scope] }).items.map((row) => row.scope),
          [scope],
        );

        const proposal = listClaimProposals(verified, { allowedScopes: [scope], status: "proposed" })[0];
        assert.ok(proposal, "durable checkpoint candidates must remain proposals");
        assert.equal(proposal.memory_id, null);
        assert.equal(
          verified.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content=?").get(proposal.content).c,
          0,
          "proposal text must not become recallable memory_current state",
        );
        assert.equal(
          verified.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE content=?").get(proposal.content).c,
          0,
          "proposal text must not become FTS-recallable",
        );
      } finally {
        verified.close();
      }

      const memoryRoot = path.join(root, "memory");
      mkdirSync(memoryRoot, { recursive: true });
      writeFileSync(path.join(memoryRoot, "2026-08-26.md"), `# 2026-08-26

## Codex App Sessions

- Codex App session (task13 dry-run): Synthetic legacy checkpoint. <!-- gigabrain:scope=project:legacy -->
`, { mode: 0o600 });
      const dryDbPath = path.join(root, "dry-run.sqlite");
      const dryDb = openDatabase(dryDbPath);
      ensureProjectionStore(dryDb);
      const beforeDryRun = snapshotTree(root);
      const dryResult = migrateLegacyCheckpoints(dryDb, {
        defaultScope: "project:fallback",
        dryRun: true,
        memoryRoot,
        today: "2026-08-27",
      });
      assert.equal(dryResult.imported, 0);
      assert.equal(dryResult.would_import, 1);
      assert.deepEqual(snapshotTree(root), beforeDryRun, "legacy dry-run must create no tables, rows, or files");
      assert.equal(
        dryDb.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'memory_checkpoint%' OR name LIKE 'memory_claim_proposal%' OR name='memory_receipts'").get().c,
        0,
      );
      dryDb.close();

      const hookConfigPath = path.join(root, "openclaw", "openclaw.json");
      mkdirSync(path.dirname(hookConfigPath), { recursive: true });
      writeFileSync(hookConfigPath, "{}\n", { mode: 0o600 });
      const hook = buildSessionHookCommand({
        checkpointScript: path.join(root, "missing-checkpoint-script.js"),
        configPath: hookConfigPath,
        nodeBin: process.execPath,
      });
      const { spawnSync } = await import("node:child_process");
      const hookRun = spawnSync("/bin/sh", ["-c", hook], {
        cwd: root,
        encoding: "utf8",
        input: "{}",
      });
      assert.equal(hookRun.status, 0, "advisory lifecycle wrapper may not block host teardown");
      const failureLog = path.join(path.dirname(hookConfigPath), "logs", "hook-failures.log");
      assert.equal(existsSync(failureLog), true, "hook failure redirection must create its log directory first");
      assert.match(readFileSync(failureLog, "utf8"), /gigabrain checkpoint hook failed/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}

if (!isMainThread && workerData?.kind === "checkpoint-race") {
  await runCheckpointWorker();
} else if (isMainThread) {
  runDirect(import.meta.url, run);
}

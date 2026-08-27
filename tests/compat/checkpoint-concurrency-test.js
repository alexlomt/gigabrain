import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import {
  appendCheckpointEpisode,
  appendClaimProposal,
  ensureControlPlaneStore,
  getCheckpointEpisode,
  getMemoryReceipt,
  listClaimProposals,
  listCheckpointEpisodes,
} from "../../lib/core/control-plane.js";
import { migrateLegacyCheckpoints } from "../../lib/core/checkpoint-migration.js";
import { createStandaloneCodexConfig } from "../../lib/core/codex-project.js";
import {
  bootstrapStandaloneStore,
  runCheckpoint,
  runClaimDecide,
} from "../../lib/core/codex-service.js";
import { buildSessionHookCommand } from "../../lib/core/lifecycle-hooks.js";
import { ensureProjectionStore } from "../../lib/core/projection-store.js";
import { openDatabase } from "../../lib/core/sqlite.js";
import { runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "13";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_CHECKPOINT_CONCURRENCY missing atomic scope-session checkpoint governance";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

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

const workerBarrier = () => {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  return { buffer, state: new Int32Array(buffer) };
};

const waitForWorker = (worker) => new Promise((resolve, reject) => {
  let message = null;
  worker.once("message", (value) => { message = value; });
  worker.once("error", reject);
  worker.once("exit", (code) => {
    if (code !== 0) reject(new Error(`checkpoint worker exited ${code}`));
    else resolve(message);
  });
});

const releaseWhenReady = async (workers, state, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(state, 0) < workers.length && Date.now() < deadline) {
    Atomics.wait(state, 0, Atomics.load(state, 0), 100);
  }
  if (Atomics.load(state, 0) !== workers.length) {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    throw new Error(`checkpoint workers did not reach readiness barrier within ${timeoutMs}ms`);
  }
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1, workers.length);
};

const runRace = async (payloads) => {
  const barrier = workerBarrier();
  const workers = payloads.map((payload) => new Worker(new URL(import.meta.url), {
    workerData: { ...payload, barrier: barrier.buffer },
  }));
  const results = workers.map(waitForWorker);
  await releaseWhenReady(workers, barrier.state);
  return Promise.all(results);
};

const workerMain = () => {
  const barrier = new Int32Array(workerData.barrier);
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  Atomics.wait(barrier, 1, 0, 30_000);
  if (workerData.kind === "direct-checkpoint-race") {
    const db = openDatabase(workerData.dbPath);
    try {
      const result = appendCheckpointEpisode(db, checkpointInput(workerData));
      return {
        checkpointId: result?.checkpoint?.checkpoint_id || null,
        deduplicated: result?.deduplicated === true,
        ok: true,
        proposalIds: result?.checkpoint?.proposal_ids || [],
        receiptId: result?.receipt_id || null,
      };
    } finally {
      db.close();
    }
  }
  if (workerData.kind === "public-checkpoint-race") {
    const result = runCheckpoint({
      allowedScopes: [workerData.scope],
      configPath: workerData.configPath,
      durableCandidates: [`Public checkpoint candidate ${workerData.checkpointId} requires authenticated promotion.`],
      evidence: [`test:public-run-checkpoint-race:${workerData.checkpointId}`],
      scope: workerData.scope,
      sessionId: workerData.sessionId,
      sessionLabel: workerData.checkpointId,
      summary: `Public runCheckpoint race fixture from ${workerData.checkpointId}.`,
      timestamp: "2026-08-27T12:30:00.000Z",
    });
    return {
      checkpointId: result.checkpoint_id,
      deduplicated: result.deduplicated,
      ok: result.ok,
      proposalIds: result.proposal_ids,
      receiptId: result.receipt_id,
      variant: workerData.checkpointId,
      writtenNative: result.written_native,
    };
  }
  throw new Error(`unknown checkpoint worker kind: ${workerData.kind}`);
};

const assertRaceOutcome = (rows) => {
  assert.equal(rows.every((row) => row?.ok === true), true, "both workers must resolve through create-or-deduplicate");
  assert.equal(rows.filter((row) => row.deduplicated === true).length, 1, "exactly one worker must receive a dedup receipt");
  assert.equal(new Set(rows.map((row) => row.checkpointId)).size, 1, "both workers must resolve to one checkpoint id");
};

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

      const raced = await runRace(["cp_task13_a", "cp_task13_b"].map((checkpointId) => ({
        checkpointId,
        dbPath,
        kind: "direct-checkpoint-race",
        scope,
        sessionId,
      })));
      assertRaceOutcome(raced);

      const verified = openDatabase(dbPath);
      try {
        assert.deepEqual({
          checkpoints: verified.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints WHERE scope=? AND session_id=?").get(scope, sessionId).c,
          items: verified.prepare("SELECT COUNT(*) AS c FROM memory_checkpoint_items").get().c,
          proposals: verified.prepare("SELECT COUNT(*) AS c FROM memory_claim_proposals").get().c,
          proposalEvents: verified.prepare("SELECT COUNT(*) AS c FROM memory_claim_proposal_events").get().c,
          receipts: verified.prepare("SELECT COUNT(*) AS c FROM memory_receipts").get().c,
        }, {
          checkpoints: 1,
          items: 2,
          proposals: 1,
          proposalEvents: 1,
          receipts: 2,
        }, "create+dedup must have exact atomic row counts");
        const index = verified.prepare("PRAGMA index_list(memory_checkpoints)").all()
          .find((row) => row.name === "idx_memory_checkpoints_scope_session_unique");
        assert.equal(Number(index?.unique), 1);
        assert.deepEqual(
          verified.prepare("PRAGMA index_info(idx_memory_checkpoints_scope_session_unique)").all().map((row) => row.name),
          ["scope", "session_id"],
        );
        const dedupResult = raced.find((row) => row.deduplicated === true);
        const dedupReceipt = getMemoryReceipt(verified, dedupResult.receiptId, { allowedScopes: [scope] });
        assert.deepEqual(
          {
            checkpointId: raced.find((row) => !row.deduplicated).checkpointId,
            receiptScope: dedupReceipt.scope,
            receiptSession: dedupReceipt.session_id,
            receiptStatus: dedupReceipt.status,
            receiptType: dedupReceipt.receipt_type,
          },
          {
            checkpointId: dedupResult.checkpointId,
            receiptScope: scope,
            receiptSession: sessionId,
            receiptStatus: "deduplicated",
            receiptType: "checkpoint_dedup",
          },
        );
        assert.equal(getMemoryReceipt(verified, dedupResult.receiptId, { allowedScopes: ["project:synthetic-b"] }), null);

        const winnerId = raced[0].checkpointId;
        const otherScope = appendCheckpointEpisode(verified, checkpointInput({
          checkpointId: "cp_task13_other_scope",
          scope: "project:synthetic-b",
          sessionId,
        }));
        assert.notEqual(otherScope.checkpoint.checkpoint_id, winnerId);
        assert.equal(getCheckpointEpisode(verified, winnerId, { allowedScopes: ["project:synthetic-b"] }), null);
        assert.deepEqual(
          listCheckpointEpisodes(verified, { allowedScopes: [scope] }).results.map((row) => row.scope),
          [scope],
        );
        assert.throws(() => appendClaimProposal(verified, {
          checkpointId: otherScope.checkpoint.checkpoint_id,
          claimType: "CONTEXT",
          content: "Cross-scope checkpoint reference must fail.",
          evidenceClass: "agent_inference",
          scope,
          sourceAgent: "codex",
          sourceHost: "synthetic-worker",
        }), /not found or not authorized/);
        assert.throws(() => appendCheckpointEpisode(verified, {
          ...checkpointInput({ checkpointId: "cp_task13_bad_parent", scope, sessionId: "session:bad-parent" }),
          parentCheckpointId: otherScope.checkpoint.checkpoint_id,
        }), /not found or not authorized/);

        const secondAlpha = appendCheckpointEpisode(verified, checkpointInput({
          checkpointId: "cp_task13_scope_a_second",
          scope,
          sessionId: "session:scope-a-second",
        }));
        const alphaPage = listCheckpointEpisodes(verified, { allowedScopes: [scope], limit: 1, scope });
        assert.equal(Boolean(alphaPage.next_cursor), true);
        assert.equal(alphaPage.results.length, 1);
        const wrongScopeCursor = listCheckpointEpisodes(verified, {
          allowedScopes: ["project:synthetic-b"],
          cursor: alphaPage.next_cursor,
          limit: 10,
          scope: "project:synthetic-b",
        });
        assert.equal(wrongScopeCursor.results.every((row) => row.scope === "project:synthetic-b"), true);
        assert.equal(wrongScopeCursor.results.some((row) => row.checkpoint_id === secondAlpha.checkpoint.checkpoint_id), false);

        const proposal = listClaimProposals(verified, { allowedScopes: [scope], status: "proposed" })[0];
        assert.ok(proposal);
        assert.equal(proposal.memory_id, null);
        assert.equal(verified.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content=?").get(proposal.content).c, 0);
        assert.equal(verified.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE content=?").get(proposal.content).c, 0);

        const beforeSavepoint = verified.prepare(`
          SELECT
            (SELECT COUNT(*) FROM memory_checkpoints) AS checkpoints,
            (SELECT COUNT(*) FROM memory_checkpoint_items) AS items,
            (SELECT COUNT(*) FROM memory_claim_proposals) AS proposals,
            (SELECT COUNT(*) FROM memory_receipts) AS receipts
        `).get();
        verified.exec("BEGIN IMMEDIATE");
        assert.throws(() => appendCheckpointEpisode(verified, {
          ...checkpointInput({ checkpointId: "cp_task13_savepoint", scope, sessionId: "session:savepoint" }),
          faultInjector: (stage) => { if (stage === "after_checkpoint") throw new Error("synthetic checkpoint savepoint failure"); },
        }), /synthetic checkpoint savepoint failure/);
        assert.equal(verified.isTransaction, true, "checkpoint failure must preserve caller transaction ownership");
        assert.deepEqual({ ...verified.prepare(`
          SELECT
            (SELECT COUNT(*) FROM memory_checkpoints) AS checkpoints,
            (SELECT COUNT(*) FROM memory_checkpoint_items) AS items,
            (SELECT COUNT(*) FROM memory_claim_proposals) AS proposals,
            (SELECT COUNT(*) FROM memory_receipts) AS receipts
        `).get() }, { ...beforeSavepoint });
        verified.exec("ROLLBACK");

        verified.exec("BEGIN IMMEDIATE");
        const nestedSuccess = appendCheckpointEpisode(verified, checkpointInput({
          checkpointId: "cp_task13_nested_success",
          scope,
          sessionId: "session:nested-success",
        }));
        assert.equal(verified.isTransaction, true, "successful nested append must preserve caller transaction ownership");
        assert.equal(
          verified.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints WHERE checkpoint_id=?").get(nestedSuccess.checkpoint.checkpoint_id).c,
          1,
        );
        verified.exec("ROLLBACK");
        assert.equal(
          verified.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints WHERE checkpoint_id=?").get(nestedSuccess.checkpoint.checkpoint_id).c,
          0,
          "caller rollback must remove the successful nested checkpoint and all children",
        );
      } finally {
        if (verified.isTransaction) verified.exec("ROLLBACK");
        verified.close();
      }

      const duplicateDb = openDatabase(path.join(root, "legacy-duplicates.sqlite"));
      ensureControlPlaneStore(duplicateDb);
      duplicateDb.exec("DROP INDEX idx_memory_checkpoints_scope_session_unique");
      const insertDuplicate = duplicateDb.prepare(`
        INSERT INTO memory_checkpoints (
          checkpoint_id, schema_version, created_at, session_id, scope,
          source_agent, source_client, source_host, summary, payload, record_hash
        ) VALUES (?, 'checkpoint.1', ?, 'legacy-duplicate-session', 'project:legacy',
          'legacy', 'legacy', 'legacy', 'legacy duplicate', '{}', ?)
      `);
      insertDuplicate.run("cp_legacy_dup_a", "2026-08-26T00:00:00.000Z", "a".repeat(64));
      insertDuplicate.run("cp_legacy_dup_b", "2026-08-26T00:01:00.000Z", "b".repeat(64));
      const duplicateBefore = duplicateDb.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints").get().c;
      assert.throws(() => ensureControlPlaneStore(duplicateDb), /CHECKPOINT_SCOPE_SESSION_DUPLICATES/);
      assert.equal(duplicateDb.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints").get().c, duplicateBefore);
      duplicateDb.close();

      const memoryRoot = path.join(root, "memory");
      mkdirSync(memoryRoot, { recursive: true });
      writeFileSync(path.join(memoryRoot, "2026-08-26.md"), `# 2026-08-26

## Codex App Sessions

- Codex App session (task13 dry-run): Synthetic legacy checkpoint. <!-- gigabrain:scope=project:legacy -->
`, { mode: 0o600 });
      const dryDb = openDatabase(path.join(root, "dry-run.sqlite"));
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
      assert.deepEqual(snapshotTree(root), beforeDryRun);
      assert.equal(
        dryDb.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'memory_checkpoint%' OR name LIKE 'memory_claim_proposal%' OR name='memory_receipts'").get().c,
        0,
      );
      dryDb.close();

      const publicRoot = path.join(root, "public-checkpoint-race");
      const projectRoot = path.join(publicRoot, "project");
      const storeRoot = path.join(publicRoot, "store");
      const configPath = path.join(storeRoot, "config.json");
      mkdirSync(projectRoot, { recursive: true });
      const config = createStandaloneCodexConfig({
        projectRoot,
        projectStorePath: storeRoot,
        userProfilePath: path.join(publicRoot, "profile"),
      });
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      bootstrapStandaloneStore({ configPath });
      const publicScope = "project:public-race";
      const publicSession = "session:public-run-checkpoint-race";
      const publicRace = await runRace(["worker-a", "worker-b"].map((checkpointId) => ({
        checkpointId,
        configPath,
        kind: "public-checkpoint-race",
        scope: publicScope,
        sessionId: publicSession,
      })));
      assertRaceOutcome(publicRace);
      const publicWinner = publicRace.find((row) => row.deduplicated === false);
      const publicLoser = publicRace.find((row) => row.deduplicated === true);
      assert.equal(publicWinner.writtenNative, true);
      assert.equal(publicLoser.writtenNative, false);
      const publicDbPath = path.join(storeRoot, "memory", "registry.sqlite");
      const publicDb = openDatabase(publicDbPath);
      try {
        assert.equal(publicDb.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints WHERE scope=? AND session_id=?").get(publicScope, publicSession).c, 1);
        const winningCheckpoint = getCheckpointEpisode(publicDb, publicWinner.checkpointId, { allowedScopes: [publicScope] });
        assert.equal(winningCheckpoint.summary, `Public runCheckpoint race fixture from ${publicWinner.variant}.`);
        assert.equal(
          winningCheckpoint.durable_candidates[0].content,
          `Public checkpoint candidate ${publicWinner.variant} requires authenticated promotion.`,
        );
        const publicProposalId = publicRace.flatMap((row) => row.proposalIds)[0];
        const publicProposal = listClaimProposals(publicDb, { allowedScopes: [publicScope], status: "proposed" })
          .find((row) => row.proposal_id === publicProposalId);
        assert.ok(publicProposal);
        assert.equal(publicDb.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content=?").get(publicProposal.content).c, 0);
        const authorization = {
          authority: "owner",
          memoryScopes: [publicScope],
          permissions: ["gigabrain:read", "gigabrain:commit"],
          subject: "task13-owner",
        };
        const promoted = runClaimDecide({
          action: "accepted",
          allowedScopes: [publicScope],
          authorization,
          configPath,
          proposalId: publicProposal.proposal_id,
          reason: "Authenticated owner promotion after checkpoint review.",
          scope: publicScope,
        });
        assert.equal(promoted.memory.recallable, true);
        assert.equal(publicDb.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE memory_id=?").get(promoted.memory.memory_id).c, 1);
        assert.equal(publicDb.prepare("SELECT COUNT(*) AS c FROM memory_fts WHERE memory_id=?").get(promoted.memory.memory_id).c, 1);
        assert.equal(
          publicDb.prepare("SELECT COUNT(*) AS c FROM memory_claim_proposal_events WHERE proposal_id=? AND action IN ('accepted','rejected','superseded')").get(publicProposal.proposal_id).c,
          1,
          "authenticated promotion must append exactly one terminal proposal event",
        );
      } finally {
        publicDb.close();
      }
      const nativePath = path.join(storeRoot, "memory", "2026-08-27.md");
      const nativeText = readFileSync(nativePath, "utf8");
      assert.match(nativeText, new RegExp(`Public runCheckpoint race fixture from ${publicWinner.variant}\\.`));
      assert.match(nativeText, new RegExp(`Public checkpoint candidate ${publicWinner.variant} requires authenticated promotion\\.`));
      assert.doesNotMatch(nativeText, new RegExp(`Public runCheckpoint race fixture from ${publicLoser.variant}\\.`));
      assert.doesNotMatch(nativeText, new RegExp(`Public checkpoint candidate ${publicLoser.variant} requires authenticated promotion\\.`));
      const mainThreadCheckpoint = runCheckpoint({
        allowedScopes: ["project:main-thread"],
        configPath,
        scope: "project:main-thread",
        sessionId: "session:main-thread-relevance",
        summary: "Main-thread checkpoint relevance fixture remains inside the temporary store.",
        timestamp: "2026-08-27T12:45:00.000Z",
      });
      assert.equal(mainThreadCheckpoint.ok, true, "exported run must directly execute the public checkpoint boundary");
      assert.equal(mainThreadCheckpoint.scope, "project:main-thread");

      const quotedConfigPath = path.join(root, "open claw's quoted config", "openclaw.json");
      mkdirSync(path.dirname(quotedConfigPath), { recursive: true });
      writeFileSync(quotedConfigPath, "{}\n", { mode: 0o600 });
      const hook = buildSessionHookCommand({
        checkpointScript: path.join(root, "missing checkpoint's script.js"),
        configPath: quotedConfigPath,
        nodeBin: process.execPath,
      });
      assert.match(hook, /mkdir\s+-p/, "the hook command must directly create its quoted failure-log directory");
      assert.match(hook, /hook-failures\.log/);
      const hookRun = spawnSync("/bin/sh", ["-c", hook], { cwd: root, encoding: "utf8", input: "{}" });
      assert.equal(hookRun.status, 0);
      const failureLog = path.join(path.dirname(quotedConfigPath), "logs", "hook-failures.log");
      assert.equal(existsSync(failureLog), true);
      assert.match(readFileSync(failureLog, "utf8"), /gigabrain checkpoint hook failed/);

      const checkpointDocs = readFileSync(path.join(repoRoot, "docs/checkpoint-control-plane.md"), "utf8");
      assert.match(checkpointDocs, /one checkpoint per \(scope, session_id\)/i);
      assert.match(checkpointDocs, /proposal.*not.*recallable/i);
      assert.match(checkpointDocs, /hooks?.*disabled.*default/i);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}

if (!isMainThread && workerData?.kind) {
  try {
    parentPort.postMessage(workerMain());
  } catch (error) {
    parentPort.postMessage({ error: String(error?.message || error), ok: false });
  }
} else if (isMainThread) {
  runDirect(import.meta.url, run);
}

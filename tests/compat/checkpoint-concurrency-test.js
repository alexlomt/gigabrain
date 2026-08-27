import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";

import {
  appendCheckpointEpisode,
  appendClaimProposal,
  ensureControlPlaneStore,
  getCheckpointEpisode,
  getMemoryReceipt,
  listClaimProposals,
  listCheckpointEpisodes,
} from "../../lib/core/control-plane.js";
import { captureFromEvent } from "../../lib/core/capture-service.js";
import { migrateLegacyCheckpoints } from "../../lib/core/checkpoint-migration.js";
import { createStandaloneCodexConfig } from "../../lib/core/codex-project.js";
import { normalizeConfig } from "../../lib/core/config.js";
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

const runChildRace = async (payloads) => {
  const orderDir = payloads.some((payload) => payload.kind === "capture-checkpoint-race")
    ? mkdtempSync(path.join(tmpdir(), "gigabrain-task13-lock-order-"))
    : "";
  const children = [];
  const bounded = (promise, label, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
  try {
    const states = payloads.map((payload) => {
      const childEnv = { ...process.env };
      delete childEnv.NODE_V8_COVERAGE;
      childEnv.GIGABRAIN_TASK13_CHILD_PAYLOAD = Buffer.from(JSON.stringify({
        ...payload,
        orderDir,
      })).toString("base64url");
      const child = fork(fileURLToPath(import.meta.url), [], {
        cwd: repoRoot,
        env: childEnv,
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      let readyResolve;
      let resultResolve;
      let resultReject;
      let receivedResult = false;
      const ready = new Promise((resolve) => { readyResolve = resolve; });
      const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
      child.on("message", (message) => {
        if (message?.type === "ready") readyResolve();
        if (message?.type === "result") {
          receivedResult = true;
          resultResolve(message.value);
        }
      });
      child.once("error", resultReject);
      child.once("exit", (code) => {
        if (code !== 0) resultReject(new Error(`checkpoint child exited ${code}: ${stderr.trim()}`));
        else if (!receivedResult) resultReject(new Error("checkpoint child exited without a result"));
      });
      return { child, ready, result };
    });
    await Promise.all(states.map((state, index) => bounded(state.ready, `checkpoint child ${index} readiness`)));
    for (const state of states) state.child.send({ type: "go" });
    return await Promise.all(states.map((state, index) => bounded(state.result, `checkpoint child ${index} result`)));
  } finally {
    for (const child of children) {
      if (child.connected) child.disconnect();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    if (orderDir) rmSync(orderDir, { force: true, recursive: true });
  }
};

const runRace = async (payloads) => {
  return runChildRace(payloads);
};

const workerMain = (data) => {
  if (data.kind === "direct-checkpoint-race") {
    const db = openDatabase(data.dbPath);
    try {
      const result = appendCheckpointEpisode(db, checkpointInput(data));
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
  if (data.kind === "public-checkpoint-race") {
    const result = runCheckpoint({
      allowedScopes: [data.scope],
      configPath: data.configPath,
      durableCandidates: [`Public checkpoint candidate ${data.checkpointId} requires authenticated promotion.`],
      evidence: [`test:public-run-checkpoint-race:${data.checkpointId}`],
      scope: data.scope,
      sessionId: data.sessionId,
      sessionLabel: data.checkpointId,
      summary: `Public runCheckpoint race fixture from ${data.checkpointId}.`,
      timestamp: "2026-08-27T12:30:00.000Z",
    });
    return {
      checkpointId: result.checkpoint_id,
      deduplicated: result.deduplicated,
      ok: result.ok,
      proposalIds: result.proposal_ids,
      receiptId: result.receipt_id,
      variant: data.checkpointId,
      writtenNative: result.written_native,
    };
  }
  if (data.kind === "capture-checkpoint-race") {
    const captureReadyPath = data.orderDir ? path.join(data.orderDir, "capture-ready") : "";
    const checkpointEnteredPath = data.orderDir ? path.join(data.orderDir, "checkpoint-entered") : "";
    const waitForMarker = (marker, label) => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      if (!existsSync(marker)) throw new Error(label);
    };
    if (data.role === "capture") {
      const db = openDatabase(data.dbPath);
      try {
        const result = captureFromEvent({
          config: data.config,
          db,
          event: {
            __captureLlm: {
              extract: () => {
                writeFileSync(captureReadyPath, "ready\n", { mode: 0o600 });
                waitForMarker(checkpointEnteredPath, "checkpoint did not enter ordered lock race");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
                return [{ content: data.captureContent, confidence: 0.95, type: "USER_FACT" }];
              },
            },
            agentId: "codex",
            messages: [{ role: "user", content: "remember this" }],
            output: data.captureContent,
            prompt: "remember this",
            scope: data.scope,
            sessionKey: "task13-lock-order-capture",
          },
          operationId: "task13-lock-order-capture",
          refreshDerived: false,
        });
        return {
          inserted: result.inserted,
          nativePath: result.write_records?.[0]?.source_path || "",
          nativeWritten: result.native_written,
          ok: true,
          role: "capture",
        };
      } finally {
        db.close();
      }
    }
    waitForMarker(captureReadyPath, "capture did not establish its database transaction");
    writeFileSync(checkpointEnteredPath, "entered\n", { mode: 0o600 });
    const result = runCheckpoint({
      allowedScopes: [data.scope],
      configPath: data.configPath,
      durableCandidates: [data.checkpointCandidate],
      scope: data.scope,
      sessionId: "session:task13-lock-order-checkpoint",
      summary: data.checkpointSummary,
      timestamp: "2026-08-27T12:20:00.000Z",
    });
    return {
      checkpointId: result.checkpoint_id,
      nativePath: result.source_path,
      nativeWritten: result.written_native,
      ok: result.ok,
      role: "checkpoint",
    };
  }
  throw new Error(`unknown checkpoint worker kind: ${data.kind}`);
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
      const resolvedConfig = normalizeConfig(config);
      const activeTransactionDb = openDatabase(path.join(storeRoot, "memory", "registry.sqlite"));
      try {
        activeTransactionDb.exec("BEGIN IMMEDIATE");
        assert.throws(() => captureFromEvent({
          config: resolvedConfig,
          db: activeTransactionDb,
          event: {
            agentId: "codex",
            messages: [{ role: "user", content: "remember this" }],
            output: '<memory_note type="USER_FACT" confidence="0.95">An active transaction without the outer native lock must fail closed.</memory_note>',
            prompt: "remember this",
            scope: "project:lock-order",
            sessionKey: "task13-active-transaction-guard",
          },
          refreshDerived: false,
        }), /GIGABRAIN_NATIVE_LOCK_ORDER/);
        assert.equal(activeTransactionDb.isTransaction, true);
      } finally {
        if (activeTransactionDb.isTransaction) activeTransactionDb.exec("ROLLBACK");
        activeTransactionDb.close();
      }
      const lockOrderScope = "project:lock-order";
      const captureContent = "Concurrent capture must commit without loss under the global database-to-native lock order.";
      const checkpointSummary = "Concurrent checkpoint must commit without timing out behind capture.";
      const checkpointCandidate = "Concurrent checkpoint candidate remains proposal-only after the lock-order race.";
      const lockOrderRace = await runRace([
        {
          captureContent,
          config: resolvedConfig,
          configPath,
          dbPath: path.join(storeRoot, "memory", "registry.sqlite"),
          kind: "capture-checkpoint-race",
          role: "capture",
          scope: lockOrderScope,
        },
        {
          checkpointCandidate,
          checkpointSummary,
          configPath,
          kind: "capture-checkpoint-race",
          role: "checkpoint",
          scope: lockOrderScope,
        },
      ]);
      assert.equal(lockOrderRace.every((row) => row?.ok === true), true, "capture/checkpoint race must finish without timeout");
      assert.deepEqual(lockOrderRace.map((row) => row.role).sort(), ["capture", "checkpoint"]);
      assert.equal(lockOrderRace.find((row) => row.role === "capture")?.inserted, 1);
      assert.equal(lockOrderRace.find((row) => row.role === "capture")?.nativeWritten, 1);
      assert.equal(lockOrderRace.find((row) => row.role === "checkpoint")?.nativeWritten, true);
      const lockOrderDb = openDatabase(path.join(storeRoot, "memory", "registry.sqlite"));
      try {
        assert.equal(lockOrderDb.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content=?").get(captureContent).c, 1);
        assert.equal(lockOrderDb.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints WHERE scope=? AND session_id=?")
          .get(lockOrderScope, "session:task13-lock-order-checkpoint").c, 1);
      } finally {
        lockOrderDb.close();
      }
      const lockOrderNativePath = lockOrderRace.find((row) => row.role === "capture")?.nativePath
        || lockOrderRace.find((row) => row.role === "checkpoint")?.nativePath;
      const lockOrderNative = readFileSync(lockOrderNativePath, "utf8");
      assert.match(lockOrderNative, new RegExp(captureContent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(lockOrderNative, new RegExp(checkpointSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(lockOrderNative, new RegExp(checkpointCandidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

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

      const nativeBeforeFailedCheckpoint = readFileSync(nativePath);
      const nativeModeBeforeFailedCheckpoint = lstatSync(nativePath).mode & 0o777;
      assert.throws(() => runCheckpoint({
        allowedScopes: ["project:main-thread"],
        configPath,
        durableCandidates: ["This candidate must be removed by native compensation."],
        faultInjector: (stage) => { if (stage === "after_checkpoint") throw new Error("synthetic public checkpoint failure"); },
        scope: "project:main-thread",
        sessionId: "session:public-failed-checkpoint",
        summary: "This native checkpoint block must be compensated exactly.",
        timestamp: "2026-08-27T12:50:00.000Z",
      }), /synthetic public checkpoint failure/);
      assert.deepEqual(
        readFileSync(nativePath),
        nativeBeforeFailedCheckpoint,
        "a post-native database failure must restore the exact prior native bytes",
      );
      assert.equal(
        lstatSync(nativePath).mode & 0o777,
        nativeModeBeforeFailedCheckpoint,
        "native compensation must restore the prior file mode",
      );
      const compensatedDb = openDatabase(publicDbPath);
      try {
        assert.equal(
          compensatedDb.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints WHERE scope=? AND session_id=?")
            .get("project:main-thread", "session:public-failed-checkpoint").c,
          0,
        );
      } finally {
        compensatedDb.close();
      }

      for (const [stage, sessionId, failureText] of [
        ["before_checkpoint_hydration", "session:public-hydration-failure", "synthetic checkpoint hydration failure"],
        ["before_checkpoint_outer_commit", "session:public-outer-commit-failure", "synthetic checkpoint outer commit failure"],
      ]) {
        const before = readFileSync(nativePath);
        assert.throws(() => runCheckpoint({
          allowedScopes: ["project:main-thread"],
          configPath,
          durableCandidates: [`${stage} candidate must be compensated.`],
          faultInjector: (value) => { if (value === stage) throw new Error(failureText); },
          scope: "project:main-thread",
          sessionId,
          summary: `${stage} native block must be compensated.`,
          timestamp: "2026-08-27T12:55:00.000Z",
        }), new RegExp(failureText));
        assert.deepEqual(readFileSync(nativePath), before);
        const failedDb = openDatabase(publicDbPath);
        try {
          assert.equal(failedDb.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints WHERE session_id=?").get(sessionId).c, 0);
        } finally {
          failedDb.close();
        }
      }

      const postCommitSession = "session:public-post-commit-failure";
      const postCommitSummary = "A post-commit injected failure must not compensate committed native bytes.";
      assert.throws(() => runCheckpoint({
        allowedScopes: ["project:main-thread"],
        configPath,
        faultInjector: (value) => { if (value === "after_checkpoint_outer_commit") throw new Error("synthetic post-commit failure"); },
        scope: "project:main-thread",
        sessionId: postCommitSession,
        summary: postCommitSummary,
        timestamp: "2026-08-27T12:56:00.000Z",
      }), /synthetic post-commit failure/);
      const postCommitDb = openDatabase(publicDbPath);
      try {
        assert.equal(postCommitDb.prepare("SELECT COUNT(*) AS c FROM memory_checkpoints WHERE session_id=?").get(postCommitSession).c, 1);
      } finally {
        postCommitDb.close();
      }
      assert.match(readFileSync(nativePath, "utf8"), new RegExp(postCommitSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

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

const childPayload = String(process.env.GIGABRAIN_TASK13_CHILD_PAYLOAD || '');
if (childPayload) {
  const data = JSON.parse(Buffer.from(childPayload, 'base64url').toString('utf8'));
  process.send?.({ type: 'ready' });
  process.once('message', (message) => {
    if (message?.type !== 'go') return;
    let value;
    try {
      value = workerMain(data);
    } catch (error) {
      value = { error: String(error?.message || error), ok: false };
    }
    process.send?.({ type: 'result', value }, () => process.disconnect?.());
  });
} else {
  runDirect(import.meta.url, run);
}

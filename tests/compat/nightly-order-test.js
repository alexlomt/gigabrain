import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { normalizeConfig } from "../../lib/core/config.js";
import { executeDailySequence as governedDailySequence } from "../../lib/core/maintenance-service.js";
import { ensureProjectionStore } from "../../lib/core/projection-store.js";
import { ensureWorldModelStore } from "../../lib/core/world-model.js";
import { makeConfigObject, seedMemoryCurrent } from "../helpers.js";
import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "12";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_NIGHTLY_ORDER missing fail-closed 24-stage nightly sequence";

const EXPECTED_SEQUENCE = Object.freeze([
  "01 preflight_config_scope_write_mode",
  "02 engine_consistent_pre_backup",
  "03 native_sync",
  "04 native_promotion",
  "05 native_reconciliation",
  "06 hygiene_test_session_generated_artifacts",
  "07 vault_reference_sync_optional",
  "08 host_sync_optional",
  "09 transcript_harvest_optional",
  "10 wiki_reconcile_optional",
  "11 memory_review_queue",
  "12 adaptive_trust_shadow",
  "13 belief_arbitration",
  "14 quality_review",
  "15 same_scope_dedupe",
  "16 entity_mentions_and_world_model",
  "17 open_loops_syntheses_and_archive_retention",
  "18 vacuum_compaction",
  "19 fts_refresh",
  "20 qwen_embedding_backfill",
  "21 recall_eval_gate",
  "22 wiki_projection_optional",
  "23 generated_surface_and_graph_refresh",
  "24 final_integrity_and_run_receipt",
]);

const OPTIONAL = new Set([
  EXPECTED_SEQUENCE[6],
  EXPECTED_SEQUENCE[7],
  EXPECTED_SEQUENCE[8],
  EXPECTED_SEQUENCE[9],
  EXPECTED_SEQUENCE[21],
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const snapshotTree = (root) => {
  const rows = [];
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"))) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        rows.push({ mode: stat.mode & 0o777, path: relative, type: "directory" });
        walk(absolute, relative);
      } else if (stat.isFile()) {
        rows.push({ hash: sha256(readFileSync(absolute)), mode: stat.mode & 0o777, path: relative, type: "file" });
      }
    }
  };
  walk(root);
  return rows;
};

const makeHandlers = (calls, overrides = {}) => Object.fromEntries(EXPECTED_SEQUENCE.map((stage) => [
  stage,
  async () => {
    calls.push(stage);
    if (overrides[stage]) return overrides[stage]();
    return { mutationCount: stage === EXPECTED_SEQUENCE[13] ? 2 : 0, ok: true };
  },
]));

const spawnNightly = (args, root, extraEnv = {}) => {
  const target = "scripts/gigabrainctl.js";
  return spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, "..", "..", target),
    "nightly",
    ...args,
  ], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, HOME: path.join(root, "home") },
    timeout: 60_000,
  });
};

export async function run() {
  const maintenance = await importContractModule("lib/core/maintenance-service.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const runDailyMaintenanceSequence = requireCallable(maintenance, "runDailyMaintenanceSequence");
    assert.deepEqual([...maintenance.DAILY_SEQUENCE], [...EXPECTED_SEQUENCE]);
    assert.equal(Object.isFrozen(maintenance.DAILY_SEQUENCE), true);

    for (const mode of ["normal", "shadow"]) {
      const calls = [];
      let backupComplete = false;
      const handlers = makeHandlers(calls, {
        [EXPECTED_SEQUENCE[1]]: () => { backupComplete = true; return { ok: true }; },
        [EXPECTED_SEQUENCE[2]]: () => {
          assert.equal(backupComplete, true, "no mutation may run before the backup succeeds");
          return { mutationCount: 1, ok: true };
        },
      });
      const result = await governedDailySequence({
        disabledStages: OPTIONAL,
        gatedStages: new Map([
          [EXPECTED_SEQUENCE[15], "world_rebuild_disabled"],
          [EXPECTED_SEQUENCE[22], "no_mutations"],
        ]),
        handlers,
        mode,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.receipts.map((row) => row.stage), [...EXPECTED_SEQUENCE]);
      assert.deepEqual(new Set(result.receipts.map((row) => row.status)), new Set(["completed", "skipped_disabled", "skipped_gate"]));
      assert.equal(result.receipts[15].reason, "world_rebuild_disabled");
      assert.equal(result.receipts[22].reason, "no_mutations");
      assert.deepEqual(calls, EXPECTED_SEQUENCE.filter((stage) => !OPTIONAL.has(stage) && ![EXPECTED_SEQUENCE[15], EXPECTED_SEQUENCE[22]].includes(stage)));
    }

    const missingHandlers = makeHandlers([]);
    delete missingHandlers[EXPECTED_SEQUENCE[5]];
    const missingResult = await governedDailySequence({ handlers: missingHandlers, mode: "normal" });
    assert.equal(missingResult.ok, false);
    assert.deepEqual(missingResult.failure, {
      stage: EXPECTED_SEQUENCE[5],
      error: `missing handler for ${EXPECTED_SEQUENCE[5]}`,
    });
    assert.equal(missingResult.receipts.at(-1).status, "completed", "stage 24 must receipt a missing-handler failure");

    for (const failingStage of [EXPECTED_SEQUENCE[1], EXPECTED_SEQUENCE[19], EXPECTED_SEQUENCE[20], EXPECTED_SEQUENCE[23]]) {
      const calls = [];
      const handlers = makeHandlers(calls, {
        [failingStage]: () => { throw new Error(`synthetic failure at ${failingStage}`); },
      });
      const result = await governedDailySequence({ handlers, mode: "normal" });
      const failedAt = EXPECTED_SEQUENCE.indexOf(failingStage);
      assert.equal(result.ok, false);
      assert.deepEqual(result.receipts.map((row) => row.stage), [...EXPECTED_SEQUENCE]);
      assert.equal(result.receipts[failedAt].status, "failed");
      assert.match(result.receipts[failedAt].error, /synthetic failure/);
      assert.equal(result.failure.stage, failingStage, "the original failure must remain authoritative");
      assert.equal(
        result.receipts.slice(failedAt + 1, -1).every((row) => row.status === "skipped_gate" && row.reason === "prior_stage_failed"),
        true,
      );
      if (failedAt < EXPECTED_SEQUENCE.length - 1) {
        assert.equal(result.receipts.at(-1).status, "completed", "final integrity/receipt must run after an earlier failure");
        assert.deepEqual(
          calls,
          [...EXPECTED_SEQUENCE.slice(0, failedAt + 1), EXPECTED_SEQUENCE.at(-1)],
          "only the final integrity/receipt handler may run after a failed gate",
        );
      } else {
        assert.deepEqual(calls, EXPECTED_SEQUENCE, "a final-stage failure runs after every earlier stage");
      }
    }

    const normalRoot = mkdtempSync(path.join(tmpdir(), "gigabrain-task12-normal-"));
    try {
      const workspace = path.join(normalRoot, "workspace");
      const dbPath = path.join(workspace, "memory", "registry.sqlite");
      const outputDir = path.join(workspace, "output");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const seeded = new DatabaseSync(dbPath);
      ensureProjectionStore(seeded);
      seeded.exec("CREATE TABLE task12_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
      seeded.close();
      const config = normalizeConfig(makeConfigObject(workspace).plugins.entries.gigabrain.config);
      config.runtime.paths.registryPath = dbPath;
      config.runtime.paths.outputDir = outputDir;
      config.runtime.paths.reviewQueuePath = path.join(outputDir, "review-queue.jsonl");
      config.maintenance.snapshotDir = path.join(outputDir, "backups");
      config.maintenance.vacuum = false;
      config.native.enabled = false;
      config.nativePromotion.enabled = false;
      config.recall.semanticRerankEnabled = false;
      config.worldModel.enabled = false;
      config.dedupe.semanticEnabled = false;
      const fsyncDirectories = [];
      const normalResult = await runDailyMaintenanceSequence({
        cohortIdentity: { fixture: "normal-failure-after-backup" },
        config,
        dbPath,
        directoryFsync: (directory) => { fsyncDirectories.push(directory); },
        mode: "normal",
        outputDir,
        qualityReviewStage: async ({ dbPath: stageDbPath }) => {
          const writer = new DatabaseSync(stageDbPath);
          try {
            writer.exec("INSERT INTO task12_probe (id, note) VALUES (1, 'mutation after verified backup')");
          } finally {
            writer.close();
          }
          throw new Error("synthetic quality failure after seeded mutation");
        },
        runId: "task12-normal-failure",
      });
      assert.equal(normalResult.ok, false);
      assert.equal(normalResult.failure.stage, EXPECTED_SEQUENCE[13]);
      assert.equal(normalResult.receipts.at(-1).status, "completed", "stage 24 must receipt the original failure");
      assert.equal(existsSync(normalResult.snapshot.targetPath), true, "stage 02 must create its verified snapshot");
      const preMutationSnapshot = new DatabaseSync(normalResult.snapshot.targetPath, { readOnly: true });
      try {
        assert.equal(preMutationSnapshot.prepare("SELECT COUNT(*) AS c FROM task12_probe").get().c, 0);
      } finally {
        preMutationSnapshot.close();
      }
      const mutatedSource = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(mutatedSource.prepare("SELECT COUNT(*) AS c FROM task12_probe").get().c, 1);
      } finally {
        mutatedSource.close();
      }
      assert.equal(statSync(normalResult.receiptPath).mode & 0o777, 0o600);
      const protectedReceipt = JSON.parse(readFileSync(normalResult.receiptPath, "utf8"));
      assert.equal(protectedReceipt.failure.stage, EXPECTED_SEQUENCE[13]);
      assert.equal(protectedReceipt.receipts.at(-1).status, "completed");
      assert.equal(protectedReceipt.snapshot.targetLogicalHash, normalResult.snapshot.targetLogicalHash);
      assert.match(protectedReceipt.configSha256, /^[0-9a-f]{64}$/);
      assert.match(protectedReceipt.cohortSha256, /^[0-9a-f]{64}$/);
      assert.match(protectedReceipt.runIdSha256, /^[0-9a-f]{64}$/);
      assert.equal(
        fsyncDirectories.length >= normalResult.receipts.length + 2,
        true,
        "every stage-ledger rename plus the final sealed ledger/receipt must fsync its parent directory",
      );
      const stageLedger = JSON.parse(readFileSync(normalResult.stageLedgerPath, "utf8"));
      assert.equal(stageLedger.complete, true);
      assert.deepEqual(stageLedger.receipts, normalResult.receipts);
      assert.equal(statSync(normalResult.stageLedgerPath).mode & 0o777, 0o600);
      assert.equal(protectedReceipt.stageLedgerSha256, sha256(readFileSync(normalResult.stageLedgerPath)));
      const beforeReuse = snapshotTree(normalRoot);
      await assert.rejects(
        runDailyMaintenanceSequence({
          cohortIdentity: { fixture: "normal-failure-after-backup" },
          config,
          dbPath,
          mode: "normal",
          outputDir,
          runId: "task12-normal-failure",
        }),
        /NIGHTLY_RUN_ID_REUSED/,
      );
      assert.deepEqual(snapshotTree(normalRoot), beforeReuse, "reused run IDs must fail before any mutation");
      for (let index = 0; index < 16; index += 1) {
        const stalePath = path.join(config.maintenance.snapshotDir, `registry-pre-nightly-stale-${String(index).padStart(2, "0")}.sqlite`);
        writeFileSync(stalePath, `stale-${index}\n`, { mode: 0o600 });
        utimesSync(stalePath, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
      }
      const concurrentOutput = path.join(normalRoot, "same-run-concurrency-output");
      const concurrentOptions = {
        cohortIdentity: { fixture: "same-run-concurrency" },
        config,
        dbPath,
        mode: "normal",
        outputDir: concurrentOutput,
        runId: "task12-same-run-concurrency",
      };
      const concurrentResults = await Promise.allSettled([
        runDailyMaintenanceSequence(concurrentOptions),
        runDailyMaintenanceSequence(concurrentOptions),
      ]);
      const winners = concurrentResults.filter((row) => row.status === "fulfilled" && row.value.ok === true);
      const losers = concurrentResults.filter((row) => row.status === "rejected" && /NIGHTLY_RUN_ID_REUSED/.test(String(row.reason)));
      assert.equal(winners.length, 1, "exactly one same-run worker must win under the native lock");
      assert.equal(losers.length, 1, "the second same-run worker must reject inside the acquired lock");
      const concurrentWinner = winners[0].value;
      assert.equal(existsSync(concurrentWinner.snapshot.targetPath), true, "retention must preserve the current run snapshot");
      const retainedPreNightly = readdirSync(config.maintenance.snapshotDir)
        .filter((name) => /^registry-pre-nightly-.*\.sqlite$/.test(name));
      assert.equal(retainedPreNightly.length <= 14, true, "pre-nightly retention must enforce the explicit count bound");
      assert.equal(concurrentWinner.physicalMaintenanceCount > 0, true, "stale pre-nightly snapshots must be physically pruned");
      assert.equal(concurrentWinner.mutationCount, 0, "prune-only physical maintenance must not count as a surface mutation");
      assert.equal(concurrentWinner.receipts[22].status, "skipped_gate");
      assert.equal(concurrentWinner.receipts[22].reason, "no_mutations");
      const bypassOutput = path.join(normalRoot, "unvalidated-shadow-output");
      await assert.rejects(
        runDailyMaintenanceSequence({ config, dbPath, mode: "shadow", outputDir: bypassOutput, runId: "unvalidated-shadow" }),
        /NIGHTLY_SHADOW_CAPABILITY_REQUIRED/,
      );
      assert.equal(existsSync(bypassOutput), false, "unvalidated direct shadow calls must fail before mutation");
    } finally {
      rmSync(normalRoot, { force: true, recursive: true });
    }

    const worldGateRoot = mkdtempSync(path.join(tmpdir(), "gigabrain-task12-world-gate-"));
    try {
      const workspace = path.join(worldGateRoot, "workspace");
      const dbPath = path.join(workspace, "memory", "registry.sqlite");
      const outputDir = path.join(workspace, "output");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      ensureProjectionStore(db);
      ensureWorldModelStore(db);
      db.prepare(`
        INSERT INTO memory_entities (
          entity_id, kind, display_name, normalized_name, status, confidence,
          aliases, created_at, updated_at, payload
        ) VALUES (?, 'person', 'Synthetic Protected Entity', 'synthetic protected entity',
          'active', 1.0, '[]', ?, ?, '{"protected":true}')
      `).run("entity:synthetic-protected", "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z");
      const beforeEntity = { ...db.prepare("SELECT * FROM memory_entities WHERE entity_id=?").get("entity:synthetic-protected") };
      db.close();
      const config = normalizeConfig(makeConfigObject(workspace).plugins.entries.gigabrain.config);
      config.lockPath = path.join(worldGateRoot, "native.lockdir");
      config.runtime.paths.registryPath = dbPath;
      config.runtime.paths.outputDir = outputDir;
      config.runtime.paths.reviewQueuePath = path.join(outputDir, "review-queue.jsonl");
      config.maintenance.snapshotDir = path.join(outputDir, "backups");
      config.maintenance.vacuum = false;
      config.native.enabled = false;
      config.nativePromotion.enabled = false;
      config.recall.semanticRerankEnabled = false;
      config.worldModel.enabled = true;
      const gated = await runDailyMaintenanceSequence({
        config,
        dbPath,
        mode: "normal",
        outputDir,
        runId: "task12-world-gate",
      });
      assert.equal(gated.ok, true);
      assert.equal(gated.receipts[15].status, "skipped_gate");
      assert.equal(gated.receipts[15].reason, "world_rebuild_requires_validated_cutover_capability");
      const verified = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.deepEqual(
          { ...verified.prepare("SELECT * FROM memory_entities WHERE entity_id=?").get("entity:synthetic-protected") },
          beforeEntity,
          "normal nightly must not change protected derived world-model rows before cutover authorization",
        );
      } finally {
        verified.close();
      }
    } finally {
      rmSync(worldGateRoot, { force: true, recursive: true });
    }

    const ftsRoot = mkdtempSync(path.join(tmpdir(), "gigabrain-task12-fts-parity-"));
    try {
      const workspace = path.join(ftsRoot, "workspace");
      const dbPath = path.join(workspace, "memory", "registry.sqlite");
      const outputDir = path.join(workspace, "output");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      ensureProjectionStore(db);
      seedMemoryCurrent(db, [{
        memory_id: "task12-fts-drift",
        content: "Synthetic active row used to verify bidirectional FTS parity.",
        confidence: 0.99,
        scope: "shared",
        type: "USER_FACT",
      }]);
      db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run("task12-fts-drift");
      db.close();
      const config = normalizeConfig(makeConfigObject(workspace).plugins.entries.gigabrain.config);
      config.lockPath = path.join(ftsRoot, "native.lockdir");
      config.runtime.paths.registryPath = dbPath;
      config.runtime.paths.outputDir = outputDir;
      config.runtime.paths.reviewQueuePath = path.join(outputDir, "review-queue.jsonl");
      config.maintenance.snapshotDir = path.join(outputDir, "backups");
      config.maintenance.vacuum = false;
      config.native.enabled = false;
      config.nativePromotion.enabled = false;
      config.recall.semanticRerankEnabled = false;
      config.worldModel.enabled = false;
      let surfaceCalls = 0;
      const result = await runDailyMaintenanceSequence({
        config,
        dbPath,
        mode: "normal",
        outputDir,
        qualityReviewStage: async ({ dbPath: stageDbPath }) => {
          const writer = new DatabaseSync(stageDbPath);
          try {
            writer.prepare("UPDATE memory_current SET status='archived' WHERE memory_id=?").run("task12-fts-drift");
            writer.prepare("UPDATE memories SET status='archived' WHERE id=?").run("task12-fts-drift");
            writer.prepare("INSERT INTO memory_fts (memory_id, content, normalized, type) VALUES (?, ?, ?, ?)")
              .run("task12-stale-fts-row", "stale FTS row", "stale fts row", "CONTEXT");
          } finally {
            writer.close();
          }
          return { ok: true, summary: { by_action: { archive: 1 } } };
        },
        runId: "task12-fts-parity",
        surfaceRefreshStage: async () => {
          surfaceCalls += 1;
          return { mutationCount: 0, ok: true };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.receipts[18].status, "completed", "drifted FTS must rebuild rather than claim a no-op");
      assert.match(result.outputs[EXPECTED_SEQUENCE[18]].suboperations.fts, /^rebuilt:/);
      assert.equal(surfaceCalls, 1, "the authoritative archive mutation should refresh the surface once");
      const verified = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const missing = verified.prepare(`
          SELECT COUNT(*) AS c FROM (
            SELECT memory_id, content, COALESCE(normalized, '') AS normalized, type
            FROM memory_current WHERE status='active'
            EXCEPT SELECT memory_id, content, normalized, type FROM memory_fts
          )
        `).get().c;
        const extra = verified.prepare(`
          SELECT COUNT(*) AS c FROM (
            SELECT memory_id, content, normalized, type FROM memory_fts
            EXCEPT SELECT memory_id, content, COALESCE(normalized, '') AS normalized, type
            FROM memory_current WHERE status='active'
          )
        `).get().c;
        assert.equal(Number(missing) + Number(extra), 0, "stage 19 must leave no bidirectional FTS drift");
      } finally {
        verified.close();
      }
    } finally {
      rmSync(ftsRoot, { force: true, recursive: true });
    }

    const concurrentRoot = mkdtempSync(path.join(tmpdir(), "gigabrain-task12-post-backup-race-"));
    try {
      const workspace = path.join(concurrentRoot, "workspace");
      const dbPath = path.join(workspace, "memory", "registry.sqlite");
      const outputDir = path.join(workspace, "output");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const seeded = new DatabaseSync(dbPath);
      ensureProjectionStore(seeded);
      seeded.exec("CREATE TABLE task12_race_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
      seeded.close();
      const config = normalizeConfig(makeConfigObject(workspace).plugins.entries.gigabrain.config);
      config.lockPath = path.join(concurrentRoot, "native.lockdir");
      config.runtime.paths.registryPath = dbPath;
      config.runtime.paths.outputDir = outputDir;
      config.runtime.paths.reviewQueuePath = path.join(outputDir, "review-queue.jsonl");
      config.maintenance.snapshotDir = path.join(outputDir, "backups");
      config.maintenance.vacuum = false;
      config.native.enabled = false;
      config.nativePromotion.enabled = false;
      config.recall.semanticRerankEnabled = false;
      config.worldModel.enabled = false;
      const raced = await runDailyMaintenanceSequence({
        afterBackup: async ({ dbPath: sourcePath }) => {
          const writer = new DatabaseSync(sourcePath);
          try {
            writer.exec("INSERT INTO task12_race_probe (id, note) VALUES (1, 'concurrent post-backup commit')");
          } finally {
            writer.close();
          }
        },
        cohortIdentity: { fixture: "post-backup-race" },
        config,
        dbPath,
        mode: "normal",
        outputDir,
        runId: "task12-post-backup-race",
      });
      assert.equal(raced.ok, false);
      assert.match(raced.failure.error, /NIGHTLY_SOURCE_CHANGED_AFTER_BACKUP/);
      assert.equal(raced.receipts.at(-1).status, "completed");
      const racedSnapshot = new DatabaseSync(raced.snapshot.targetPath, { readOnly: true });
      try {
        assert.equal(racedSnapshot.prepare("SELECT COUNT(*) AS c FROM task12_race_probe").get().c, 0);
      } finally {
        racedSnapshot.close();
      }
      const racedSource = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(racedSource.prepare("SELECT COUNT(*) AS c FROM task12_race_probe").get().c, 1);
      } finally {
        racedSource.close();
      }
    } finally {
      rmSync(concurrentRoot, { force: true, recursive: true });
    }

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task12-nightly-"));
    try {
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const sourceDb = path.join(root, "sealed-source.sqlite");
      const configPath = path.join(root, "openclaw.json");
      const dryRunOutput = path.join(root, "dry-run-output");
      const shadowOutput = path.join(root, "shadow-output");
      mkdirSync(home, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      const source = new DatabaseSync(sourceDb);
      ensureProjectionStore(source);
      seedMemoryCurrent(source, [
        {
          memory_id: "task12-shadow-duplicate-a",
          content: "The reviewed operator preference is concise production status reporting.",
          confidence: 0.99,
          scope: "profile:main",
          type: "PREFERENCE",
        },
        {
          memory_id: "task12-shadow-duplicate-b",
          content: "The reviewed operator preference is concise production status reporting.",
          confidence: 0.9,
          scope: "profile:main",
          type: "PREFERENCE",
        },
      ]);
      source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      source.close();
      for (const sidecar of [`${sourceDb}-wal`, `${sourceDb}-shm`]) {
        if (existsSync(sidecar)) rmSync(sidecar);
      }
      chmodSync(sourceDb, 0o400);
      const liveGraphPath = path.join(workspace, "live-graph-must-not-change.db");
      writeFileSync(liveGraphPath, "synthetic live graph sentinel\n", { mode: 0o600 });
      const liveGraphHash = sha256(readFileSync(liveGraphPath));
      const liveLockDir = path.join(workspace, "live-lock-must-not-change");
      mkdirSync(liveLockDir, { mode: 0o700 });
      const liveLockSentinel = path.join(liveLockDir, "sentinel.txt");
      writeFileSync(liveLockSentinel, "synthetic live lock sentinel\n", { mode: 0o600 });
      const liveLockHash = sha256(readFileSync(liveLockSentinel));
      const liveDescriptorPath = path.join(root, "live-runtime-descriptor.json");
      writeFileSync(liveDescriptorPath, `${JSON.stringify({ nativeLockDir: liveLockDir }, null, 2)}\n`, { mode: 0o600 });
      const liveDescriptorHash = sha256(readFileSync(liveDescriptorPath));
      writeFileSync(configPath, `${JSON.stringify({
        plugins: {
          entries: {
            gigabrain: {
              enabled: true,
              config: {
                compat: { writeMode: "full" },
                dedupe: { semanticEnabled: false },
                graph: { path: liveGraphPath },
                llm: { provider: "none", queueReview: { enabled: false } },
                maintenance: { vacuum: false },
                native: { enabled: false },
                nativePromotion: { enabled: false },
                recall: { semanticRerankEnabled: false },
                runtime: {
                  paths: {
                    outputDir: path.join(workspace, "live-output-must-not-exist"),
                    registryPath: path.join(workspace, "live-registry-must-not-exist.sqlite"),
                    reviewQueuePath: path.join(workspace, "live-queue-must-not-exist.jsonl"),
                    workspaceRoot: workspace,
                  },
                },
                worldModel: { enabled: false },
              },
            },
          },
        },
      }, null, 2)}\n`, { mode: 0o600 });

      const beforeDryRun = snapshotTree(root);
      const dryRun = spawnNightly([
        "--config", configPath,
        "--db", sourceDb,
        "--dry-run",
        "--output-dir", dryRunOutput,
      ], root);
      assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
      const dryRunReceipt = JSON.parse(dryRun.stdout);
      assert.equal(dryRunReceipt.ok, true);
      assert.equal(dryRunReceipt.dryRun, true);
      assert.deepEqual(dryRunReceipt.receipts.map((row) => row.stage), [...EXPECTED_SEQUENCE]);
      assert.equal(dryRunReceipt.receipts.at(-1).status, "skipped_gate");
      assert.equal(dryRunReceipt.receipts.at(-1).reason, "dry_run_no_receipt");
      assert.deepEqual(snapshotTree(root), beforeDryRun, "nightly --dry-run must perform zero filesystem and database writes");

      const liveDbAlias = path.join(workspace, "live-registry-must-not-exist.sqlite");
      linkSync(sourceDb, liveDbAlias);
      const aliasOutput = path.join(root, "hardlink-alias-output");
      const hardlinkAlias = spawnNightly([
        "--config", configPath,
        "--shadow",
        "--source-db", liveDbAlias,
        "--output-dir", aliasOutput,
      ], root);
      assert.notEqual(hardlinkAlias.status, 0);
      assert.match(hardlinkAlias.stderr, /NIGHTLY_SHADOW_SOURCE_UNSAFE|NIGHTLY_SHADOW_LIVE_SOURCE_FORBIDDEN/);
      assert.equal(existsSync(aliasOutput), false, "hard-link alias rejection must precede cohort creation");
      unlinkSync(liveDbAlias);

      const liveOutputAlias = path.join(workspace, "shadow-output-alias");
      const outputAlias = spawnNightly([
        "--config", configPath,
        "--shadow",
        "--source-db", sourceDb,
        "--output-dir", liveOutputAlias,
      ], root);
      assert.notEqual(outputAlias.status, 0);
      assert.match(outputAlias.stderr, /NIGHTLY_SHADOW_OUTPUT_ALIASES_LIVE_PATH/);
      assert.equal(existsSync(liveOutputAlias), false, "live-path alias rejection must precede cohort creation");

      const sourceBeforeShadow = snapshotTree(root).filter((row) => row.path.startsWith("sealed-source.sqlite"));
      const shadow = spawnNightly([
        "--config", configPath,
        "--shadow",
        "--source-db", sourceDb,
        "--output-dir", shadowOutput,
      ], root, { GIGABRAIN_RUNTIME_DESCRIPTOR: liveDescriptorPath });
      assert.equal(shadow.status, 0, shadow.stderr || shadow.stdout);
      const shadowReceipt = JSON.parse(shadow.stdout);
      assert.equal(shadowReceipt.ok, true);
      assert.equal(shadowReceipt.mode, "shadow");
      assert.deepEqual(shadowReceipt.receipts.map((row) => row.stage), [...EXPECTED_SEQUENCE]);
      assert.equal(shadowReceipt.receipts[15].status, "skipped_gate");
      assert.equal(shadowReceipt.receipts[15].reason, "world_rebuild_disabled");
      assert.equal(shadowReceipt.receipts[10].status, "skipped_disabled", "disabled queue review must be an explicit no-op");
      assert.equal(existsSync(shadowReceipt.workingDbPath), true);
      assert.equal(existsSync(shadowReceipt.snapshot.targetPath), true, "shadow stage 02 must create a real cohort snapshot");
      assert.equal(statSync(shadowReceipt.snapshot.targetPath).mode & 0o777, 0o600);
      assert.equal(existsSync(shadowReceipt.receiptPath), true, "shadow stage 24 must write a protected receipt");
      assert.equal(statSync(shadowReceipt.receiptPath).mode & 0o777, 0o600);
      assert.equal(Boolean(shadowReceipt.outputs[EXPECTED_SEQUENCE[12]]), true, "shadow must execute real arbitration on the clone");
      assert.equal(Boolean(shadowReceipt.outputs[EXPECTED_SEQUENCE[13]]), true, "shadow must execute real quality review on the clone");
      const shadowProtectedReceipt = JSON.parse(readFileSync(shadowReceipt.receiptPath, "utf8"));
      assert.equal(shadowProtectedReceipt.snapshot.targetLogicalHash, shadowReceipt.snapshot.targetLogicalHash);
      assert.equal(shadowProtectedReceipt.receipts.at(-1).status, "completed");
      assert.equal(shadowProtectedReceipt.stageLedgerSha256, sha256(readFileSync(shadowReceipt.stageLedgerPath)));
      for (const candidatePath of [
        shadowReceipt.workingDbPath,
        shadowReceipt.snapshot.targetPath,
        shadowReceipt.receiptPath,
      ]) {
        assert.equal(path.relative(shadowOutput, candidatePath).startsWith(".."), false, `${candidatePath} must stay inside the shadow cohort`);
      }
      assert.deepEqual(
        snapshotTree(root).filter((row) => row.path.startsWith("sealed-source.sqlite")),
        sourceBeforeShadow,
        "shadow mode must not change the sealed source or create source sidecars",
      );
      assert.equal(existsSync(path.join(workspace, "live-registry-must-not-exist.sqlite")), false);
      assert.equal(existsSync(path.join(workspace, "live-output-must-not-exist")), false);
      assert.equal(existsSync(path.join(workspace, "live-queue-must-not-exist.jsonl")), false);
      assert.equal(existsSync(path.join(shadowOutput, "working", "graph.db")), true, "real stage 23 must build the cohort graph");
      assert.equal(sha256(readFileSync(liveGraphPath)), liveGraphHash, "shadow graph subprocesses must not touch live graph state");
      assert.equal(shadowReceipt.cohortLockPath, path.join(shadowOutput, "state", "native-memory.lockdir"));
      assert.equal(sha256(readFileSync(liveLockSentinel)), liveLockHash, "shadow must not use the live descriptor lock");
      assert.equal(sha256(readFileSync(liveDescriptorPath)), liveDescriptorHash, "shadow must not rewrite the live runtime descriptor");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}

runDirect(import.meta.url, run);

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { ensureProjectionStore } from "../../lib/core/projection-store.js";
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

const spawnNightly = (args, root) => spawnSync(process.execPath, [
  path.resolve(import.meta.dirname, "..", "..", "scripts", "gigabrainctl.js"),
  "nightly",
  ...args,
], {
  cwd: path.resolve(import.meta.dirname, "..", ".."),
  encoding: "utf8",
  env: { ...process.env, HOME: path.join(root, "home") },
  timeout: 60_000,
});

export async function run() {
  const maintenance = await importContractModule("lib/core/maintenance-service.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const executeDailySequence = requireCallable(maintenance, "executeDailySequence");
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
      const result = await executeDailySequence({
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

    for (const failingStage of [EXPECTED_SEQUENCE[1], EXPECTED_SEQUENCE[19], EXPECTED_SEQUENCE[20], EXPECTED_SEQUENCE[23]]) {
      const calls = [];
      const handlers = makeHandlers(calls, {
        [failingStage]: () => { throw new Error(`synthetic failure at ${failingStage}`); },
      });
      const result = await executeDailySequence({ handlers, mode: "normal" });
      const failedAt = EXPECTED_SEQUENCE.indexOf(failingStage);
      assert.equal(result.ok, false);
      assert.deepEqual(result.receipts.map((row) => row.stage), [...EXPECTED_SEQUENCE]);
      assert.equal(result.receipts[failedAt].status, "failed");
      assert.match(result.receipts[failedAt].error, /synthetic failure/);
      assert.equal(result.receipts.slice(failedAt + 1).every((row) => row.status === "skipped_gate" && row.reason === "prior_stage_failed"), true);
      assert.deepEqual(calls, EXPECTED_SEQUENCE.slice(0, failedAt + 1), "no handler may run after a failed gate");
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
      source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      source.close();
      for (const sidecar of [`${sourceDb}-wal`, `${sourceDb}-shm`]) {
        if (existsSync(sidecar)) rmSync(sidecar);
      }
      chmodSync(sourceDb, 0o400);
      writeFileSync(configPath, `${JSON.stringify({
        plugins: {
          entries: {
            gigabrain: {
              enabled: true,
              config: {
                compat: { writeMode: "full" },
                dedupe: { semanticEnabled: false },
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
        "--dry-run",
        "--output-dir", dryRunOutput,
      ], root);
      assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
      const dryRunReceipt = JSON.parse(dryRun.stdout);
      assert.equal(dryRunReceipt.ok, true);
      assert.equal(dryRunReceipt.dryRun, true);
      assert.deepEqual(dryRunReceipt.receipts.map((row) => row.stage), [...EXPECTED_SEQUENCE]);
      assert.deepEqual(snapshotTree(root), beforeDryRun, "nightly --dry-run must perform zero filesystem and database writes");

      const sourceBeforeShadow = snapshotTree(root).filter((row) => row.path.startsWith("sealed-source.sqlite"));
      const shadow = spawnNightly([
        "--config", configPath,
        "--shadow",
        "--source-db", sourceDb,
        "--output-dir", shadowOutput,
      ], root);
      assert.equal(shadow.status, 0, shadow.stderr || shadow.stdout);
      const shadowReceipt = JSON.parse(shadow.stdout);
      assert.equal(shadowReceipt.ok, true);
      assert.equal(shadowReceipt.mode, "shadow");
      assert.deepEqual(shadowReceipt.receipts.map((row) => row.stage), [...EXPECTED_SEQUENCE]);
      assert.equal(shadowReceipt.receipts[15].status, "skipped_gate");
      assert.equal(shadowReceipt.receipts[15].reason, "world_rebuild_disabled");
      assert.equal(existsSync(shadowReceipt.workingDbPath), true);
      assert.deepEqual(
        snapshotTree(root).filter((row) => row.path.startsWith("sealed-source.sqlite")),
        sourceBeforeShadow,
        "shadow mode must not change the sealed source or create source sidecars",
      );
      assert.equal(existsSync(path.join(workspace, "live-registry-must-not-exist.sqlite")), false);
      assert.equal(existsSync(path.join(workspace, "live-output-must-not-exist")), false);
      assert.equal(existsSync(path.join(workspace, "live-queue-must-not-exist.jsonl")), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}

runDirect(import.meta.url, run);

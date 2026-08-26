import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { ensureAdaptiveTrustStore, loadAdaptiveTrustOverrides, runAdaptiveTrust } from "../../lib/core/adaptive-trust.js";
import { normalizeConfig } from "../../lib/core/config.js";
import { ensureNativeStore } from "../../lib/core/native-sync.js";
import { ensurePersonStore, rebuildEntityMentions } from "../../lib/core/person-service.js";
import { rebuildWorldModel } from "../../lib/core/world-model.js";
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from "../helpers.js";
import { runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "8";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_WORLD_MODEL_SHADOW missing protected non-consuming shadow semantics";

const NOW = "2026-08-26T00:00:00.000Z";

const seed = (db) => {
  seedMemoryCurrent(db, [
    {
      memory_id: "shadow-project",
      type: "CONTEXT",
      content: "Project Synthetic Harbour records a synthetic shadow ledger.",
      scope: "shared",
      confidence: 0.94,
      value_score: 0.9,
      value_label: "core",
      source_path: "MEMORY.md",
      created_at: NOW,
      updated_at: NOW,
    },
    {
      memory_id: "shadow-person",
      type: "USER_FACT",
      content: "Mira Vexley works as a systems architect.",
      scope: "profile:synthetic",
      confidence: 0.93,
      value_score: 0.9,
      value_label: "core",
      source_path: "MEMORY.md",
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
  ensurePersonStore(db);
  ensureNativeStore(db);
  ensureAdaptiveTrustStore(db);
  const insertNative = db.prepare(`
    INSERT INTO memory_native_chunks (
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, hash, scope, memory_type, origin_kind, linked_memory_id,
      first_seen_at, last_seen_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [chunkId, content] of [
    ["native-shadow-1", "Project Native Beacon preserves the first native world fact."],
    ["native-shadow-2", "Project Native Beacon preserves the second native world fact."],
  ]) {
    insertNative.run(
      chunkId,
      "memory/synthetic-native.md",
      "curated",
      "2026-08-26",
      "Projects",
      1,
      1,
      content,
      content.toLowerCase(),
      chunkId,
      "shared",
      "CONTEXT",
      "curated",
      null,
      NOW,
      NOW,
      "active",
    );
  }
  rebuildEntityMentions(db);
};

const logicalRows = (db, table, columns) => db.prepare(
  `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${columns[0]}`,
).all().map((row) => ({ ...row }));

const sourceRows = (db) => logicalRows(db, "memory_current", [
  "memory_id", "type", "content", "scope", "status", "confidence", "source_path",
]);

export async function run() {
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const first = makeTempWorkspace("gigabrain-task8-shadow-a-");
    const second = makeTempWorkspace("gigabrain-task8-shadow-b-");
    const dbA = openDb(first.dbPath);
    const dbB = openDb(second.dbPath);
    try {
      const configA = normalizeConfig(makeConfigObject(first.workspace).plugins.entries.gigabrain.config);
      const configB = normalizeConfig(makeConfigObject(second.workspace).plugins.entries.gigabrain.config);
      for (const config of [configA, configB]) {
        config.operatorRules.memoryTier.opsPatterns = [{ pattern: "synthetic shadow ledger", flags: "i" }];
      }
      seed(dbA);
      seed(dbB);
      const sourceBefore = sourceRows(dbA);
      const nativeBefore = logicalRows(dbA, "memory_native_chunks", [
        "chunk_id", "source_path", "source_kind", "content", "normalized", "scope",
        "memory_type", "origin_kind", "linked_memory_id", "status",
      ]);

      assert.equal(loadAdaptiveTrustOverrides({ db: dbA, config: configA }), null);
      const trust = runAdaptiveTrust({ db: dbA, config: configA, now: NOW, dryRun: false });
      assert.equal(trust.shadow, true);
      assert.deepEqual(sourceRows(dbA), sourceBefore, "shadow trust must not mutate source memories");

      const firstRebuild = rebuildWorldModel({ db: dbA, config: configA, now: NOW });
      const secondRebuild = rebuildWorldModel({ db: dbB, config: configB, now: NOW });
      assert.equal(firstRebuild.ok, true);
      assert.deepEqual(firstRebuild.counts, secondRebuild.counts);
      assert.deepEqual(sourceRows(dbA), sourceBefore, "world-model rebuild must preserve source memories");
      assert.deepEqual(sourceRows(dbB), sourceBefore, "identical shadow input must preserve source memories");
      assert.deepEqual(
        logicalRows(dbA, "memory_native_chunks", [
          "chunk_id", "source_path", "source_kind", "content", "normalized", "scope",
          "memory_type", "origin_kind", "linked_memory_id", "status",
        ]),
        nativeBefore,
        "world-model rebuild must preserve native source rows",
      );

      for (const [table, columns] of [
        ["memory_claims", ["memory_id", "memory_tier", "claim_slot", "consolidation_op", "source_strength", "surface_candidate", "payload"]],
        ["memory_entities", ["entity_id", "kind", "display_name", "normalized_name", "status", "confidence", "aliases", "payload"]],
        ["memory_beliefs", ["belief_id", "entity_id", "type", "content", "status", "confidence", "source_memory_id", "payload"]],
        ["memory_syntheses", ["synthesis_id", "kind", "subject_type", "subject_id", "content", "stale", "confidence", "input_hash", "payload"]],
      ]) {
        assert.deepEqual(
          logicalRows(dbA, table, columns),
          logicalRows(dbB, table, columns),
          `${table} must be deterministic for one immutable input`,
        );
      }

      const protectedClaim = dbA.prepare(
        "SELECT memory_tier FROM memory_claims WHERE memory_id = ?",
      ).get("shadow-project");
      assert.equal(protectedClaim?.memory_tier, "ops_runbook", "protected non-slot tier rules must be consumed");
      assert.equal(
        Number(dbA.prepare("SELECT COUNT(*) AS count FROM memory_claims WHERE memory_id LIKE 'native:%'").get()?.count || 0),
        2,
        "active native rows must participate in world-model projection",
      );
      assert.equal(
        dbA.prepare("SELECT kind FROM memory_entities WHERE entity_id = ?").get("project:native-beacon")?.kind,
        "project",
        "native-only entities must survive the shadow rebuild",
      );
    } finally {
      dbA.close();
      dbB.close();
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

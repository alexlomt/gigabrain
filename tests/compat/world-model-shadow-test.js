import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { ensureAdaptiveTrustStore, loadAdaptiveTrustOverrides, runAdaptiveTrust } from "../../lib/core/adaptive-trust.js";
import { normalizeConfig } from "../../lib/core/config.js";
import { ensureNativeStore } from "../../lib/core/native-sync.js";
import { ensurePersonStore, rebuildEntityMentions } from "../../lib/core/person-service.js";
import { ensureWorldModelReady, ensureWorldModelStore, rebuildWorldModel } from "../../lib/core/world-model.js";
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
    {
      memory_id: "legacy-agent-source",
      type: "AGENT_IDENTITY",
      content: "Harbor Wren is the synthetic agent.",
      scope: "shared",
      confidence: 0.97,
      value_score: 0.92,
      value_label: "core",
      source_path: "MEMORY.md",
      created_at: NOW,
      updated_at: NOW,
    },
    {
      memory_id: "legacy-protected-source",
      type: "USER_FACT",
      content: "Legacy Protected works as a synthetic advisor.",
      scope: "shared",
      confidence: 0.97,
      value_score: 0.92,
      value_label: "core",
      source_path: "MEMORY.md",
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
  ensurePersonStore(db);
  ensureNativeStore(db);
  ensureAdaptiveTrustStore(db);
  ensureWorldModelStore(db);
  const insertEntity = db.prepare(`
    INSERT INTO memory_entities (
      entity_id, kind, display_name, normalized_name, status, confidence,
      aliases, created_at, updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlias = db.prepare(`
    INSERT INTO memory_entity_aliases (
      alias_id, entity_id, alias, normalized_alias, confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBelief = db.prepare(`
    INSERT INTO memory_beliefs (
      belief_id, entity_id, type, content, status, confidence, valid_from, valid_to,
      supersedes_belief_id, source_memory_id, source_layer, source_path, source_line, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const legacy of [
    { id: "person:harbor", name: "Harbor", normalized: "harbor", memoryId: "legacy-agent-source", type: "identity" },
    { id: "person:legacy-protected", name: "Legacy Protected", normalized: "legacy protected", memoryId: "legacy-protected-source", type: "role" },
  ]) {
    insertEntity.run(
      legacy.id,
      "person",
      legacy.name,
      legacy.normalized,
      "active",
      0.97,
      JSON.stringify([legacy.name]),
      NOW,
      NOW,
      JSON.stringify({ scopes: ["shared"], surface_curated: true, surface_visible: true }),
    );
    insertAlias.run(
      `alias:${legacy.id}`,
      legacy.id,
      legacy.name,
      legacy.normalized,
      0.97,
      NOW,
      NOW,
    );
    insertBelief.run(
      `belief:${legacy.id}`,
      legacy.id,
      legacy.type,
      legacy.type === "identity" ? "Harbor Wren is the synthetic agent." : "Legacy Protected works as a synthetic advisor.",
      "current",
      0.97,
      "2026-08-26",
      null,
      null,
      legacy.memoryId,
      "registry",
      "MEMORY.md",
      1,
      JSON.stringify({
        claim_slot: legacy.type === "identity" ? "identity.preferred_name" : "role.primary_role",
        claim_topic: legacy.type === "identity" ? "identity" : "role",
        claim_subtopic: legacy.type === "identity" ? "preferred_name" : "primary_role",
        memory_tier: "durable_personal",
        scope: "shared",
        surface_candidate: true,
      }),
    );
  }
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

const insertNativeChunk = (db, {
  chunkId,
  content,
  sourceKind = "curated",
  memoryType = "CONTEXT",
  scope = "shared",
  sourcePath = "memory/synthetic-native.md",
  lastSeenAt = NOW,
} = {}) => {
  ensureNativeStore(db);
  db.prepare(`
    INSERT INTO memory_native_chunks (
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, hash, scope, memory_type, origin_kind, linked_memory_id,
      first_seen_at, last_seen_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunkId,
    sourcePath,
    sourceKind,
    String(lastSeenAt).slice(0, 10),
    "Synthetic fixture",
    1,
    1,
    content,
    content.toLowerCase(),
    `hash-${chunkId}`,
    scope,
    memoryType,
    sourceKind,
    null,
    lastSeenAt,
    lastSeenAt,
    "active",
  );
};

const insertProtectedEntity = (db, {
  entityId,
  displayName,
  normalizedName = displayName.toLowerCase(),
} = {}) => {
  ensureWorldModelStore(db);
  db.prepare(`
    INSERT INTO memory_entities (
      entity_id, kind, display_name, normalized_name, status, confidence,
      aliases, created_at, updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entityId,
    "person",
    displayName,
    normalizedName,
    "active",
    0.97,
    JSON.stringify([displayName]),
    NOW,
    NOW,
    JSON.stringify({ scopes: ["shared"], surface_curated: true, surface_visible: true }),
  );
  db.prepare(`
    INSERT INTO memory_entity_aliases (
      alias_id, entity_id, alias, normalized_alias, confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `alias:${entityId}`,
    entityId,
    displayName,
    normalizedName,
    0.97,
    NOW,
    NOW,
  );
};

export const runVaultBoundaryFixture = () => {
  const workspace = makeTempWorkspace("gigabrain-task8-vault-boundary-");
  const db = openDb(workspace.dbPath);
  try {
    const config = normalizeConfig(makeConfigObject(workspace.workspace).plugins.entries.gigabrain.config);
    ensurePersonStore(db);
    ensureWorldModelStore(db);
    insertNativeChunk(db, {
      chunkId: "vault-self",
      content: "I live in Vaultborough.",
      sourceKind: "vault",
      memoryType: "USER_FACT",
      sourcePath: "vault/synthetic-transcript.md",
    });
    insertNativeChunk(db, {
      chunkId: "vault-project",
      content: "Project Vault Mirage needs follow-up tomorrow, 2026-08-27.",
      sourceKind: "vault",
      memoryType: "EPISODE",
      sourcePath: "vault/synthetic-transcript.md",
    });
    rebuildEntityMentions(db);
    db.prepare(`
      INSERT INTO memory_entity_mentions (
        id, memory_id, entity_key, entity_display, role, confidence,
        source, scope, source_path, linked_memory_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "stale-vault-project-mention",
      "native:vault-project",
      "vault mirage",
      "Vault Mirage",
      "general",
      0.99,
      "memory_native",
      "shared",
      "vault/synthetic-transcript.md",
      null,
    );

    assert.equal(
      Number(db.prepare("SELECT COUNT(*) AS count FROM memory_native_chunks WHERE source_kind = 'vault' AND status = 'active'").get()?.count || 0),
      2,
      "the negative fixture must contain active vault source rows",
    );
    const rebuilt = rebuildWorldModel({ db, config, now: NOW });
    assert.equal(rebuilt.ok, true);
    const vaultSourceIds = ["native:vault-self", "native:vault-project"];
    assert.equal(
      Number(db.prepare("SELECT COUNT(*) AS count FROM memory_claims WHERE memory_id IN (?, ?)").get(...vaultSourceIds)?.count || 0),
      0,
      "vault chunks must produce zero world-model claims",
    );
    assert.equal(
      Number(db.prepare("SELECT COUNT(*) AS count FROM memory_beliefs WHERE source_memory_id IN (?, ?)").get(...vaultSourceIds)?.count || 0),
      0,
      "vault chunks must produce zero world-model beliefs",
    );
    assert.equal(
      Number(db.prepare(`
        SELECT COUNT(DISTINCT episode_id) AS count
        FROM memory_episodes, json_each(memory_episodes.source_memory_ids) AS source_row
        WHERE source_row.value IN (?, ?)
      `).get(...vaultSourceIds)?.count || 0),
      0,
      "vault chunks must produce zero world-model episodes",
    );
    assert.equal(
      Number(db.prepare(`
        SELECT COUNT(DISTINCT loop_id) AS count
        FROM memory_open_loops, json_each(memory_open_loops.source_memory_ids) AS source_row
        WHERE source_row.value IN (?, ?)
      `).get(...vaultSourceIds)?.count || 0),
      0,
      "vault chunks must produce zero world-model loops",
    );
    assert.equal(
      Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM memory_syntheses
        WHERE lower(content) LIKE '%vaultborough%'
           OR lower(content) LIKE '%vault mirage%'
      `).get()?.count || 0),
      0,
      "vault chunks must produce zero world-model syntheses",
    );
  } finally {
    db.close();
    rmSync(workspace.root, { recursive: true, force: true });
  }
};

export const runNativeOnlyReadinessFixture = () => {
  const workspace = makeTempWorkspace("gigabrain-task8-native-only-ready-");
  const db = openDb(workspace.dbPath);
  try {
    const config = normalizeConfig(makeConfigObject(workspace.workspace).plugins.entries.gigabrain.config);
    insertNativeChunk(db, {
      chunkId: "native-only-ready",
      content: "Project Native Solstice records a durable checkpoint.",
    });
    rebuildEntityMentions(db);
    const ready = ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    assert.equal(ready.rebuilt, true, "eligible native-only input must initialize the world model");
    assert.equal(
      Number(db.prepare("SELECT COUNT(*) AS count FROM memory_claims WHERE memory_id = ?").get("native:native-only-ready")?.count || 0),
      1,
      "eligible native-only input must be projected through readiness",
    );
  } finally {
    db.close();
    rmSync(workspace.root, { recursive: true, force: true });
  }
};

export const runNewerNativeReadinessFixture = () => {
  const workspace = makeTempWorkspace("gigabrain-task8-newer-native-ready-");
  const db = openDb(workspace.dbPath);
  try {
    const config = normalizeConfig(makeConfigObject(workspace.workspace).plugins.entries.gigabrain.config);
    seedMemoryCurrent(db, [{
      memory_id: "registry-readiness-anchor",
      type: "CONTEXT",
      content: "Project Registry Anchor initializes the world model.",
      scope: "shared",
      confidence: 0.94,
      value_score: 0.9,
      value_label: "core",
      source_path: "MEMORY.md",
      created_at: NOW,
      updated_at: NOW,
    }]);
    rebuildEntityMentions(db);
    const initialized = ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    assert.equal(initialized.rebuilt, true);

    insertNativeChunk(db, {
      chunkId: "newer-native-ready",
      content: "Project Fresh Native records a newer checkpoint.",
      lastSeenAt: "2099-01-02T03:04:05.000Z",
    });
    rebuildEntityMentions(db);
    const refreshed = ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    assert.equal(refreshed.rebuilt, true, "newer eligible native last_seen_at must refresh the world model");
    assert.equal(
      Number(db.prepare("SELECT COUNT(*) AS count FROM memory_claims WHERE memory_id = ?").get("native:newer-native-ready")?.count || 0),
      1,
      "newer eligible native input must be projected through readiness",
    );
  } finally {
    db.close();
    rmSync(workspace.root, { recursive: true, force: true });
  }
};

export const runProtectedEntityLifecycleFixture = () => {
  const workspace = makeTempWorkspace("gigabrain-task8-protected-lifecycle-");
  const db = openDb(workspace.dbPath);
  try {
    const config = normalizeConfig(makeConfigObject(workspace.workspace).plugins.entries.gigabrain.config);
    seedMemoryCurrent(db, [{
      memory_id: "duplicate-protected-source",
      type: "USER_FACT",
      content: "Duplicate Protected works as a synthetic advisor.",
      scope: "shared",
      confidence: 0.97,
      value_score: 0.92,
      value_label: "core",
      source_path: "MEMORY.md",
      created_at: NOW,
      updated_at: NOW,
    }]);
    ensureWorldModelStore(db);
    insertProtectedEntity(db, {
      entityId: "person:detached-protected",
      displayName: "Detached Protected",
    });
    insertProtectedEntity(db, {
      entityId: "person:duplicate-protected-a",
      displayName: "Duplicate Protected",
    });
    insertProtectedEntity(db, {
      entityId: "person:duplicate-protected-b",
      displayName: "Duplicate Protected",
    });
    rebuildEntityMentions(db);
    const rebuilt = rebuildWorldModel({ db, config, now: NOW });
    assert.equal(rebuilt.ok, true);
    assert.deepEqual(
      db.prepare(`
        SELECT entity_id
        FROM memory_entities
        WHERE entity_id IN (?, ?, ?)
        ORDER BY entity_id
      `).all(
        "person:detached-protected",
        "person:duplicate-protected-a",
        "person:duplicate-protected-b",
      ).map((row) => row.entity_id),
      [
        "person:detached-protected",
        "person:duplicate-protected-a",
        "person:duplicate-protected-b",
      ],
      "protected IDs must survive independently of exact-name mention extraction",
    );
    assert.equal(
      Number(db.prepare("SELECT COUNT(*) AS count FROM memory_entities WHERE normalized_name = ?").get("duplicate protected")?.count || 0),
      2,
      "duplicate protected normalized names must preserve every protected entity ID",
    );
  } finally {
    db.close();
    rmSync(workspace.root, { recursive: true, force: true });
  }
};

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
        config.operatorRules.entity.rejectTerms = ["legacy protected"];
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
      for (const protectedEntityId of ["person:harbor", "person:legacy-protected"]) {
        assert.equal(
          dbA.prepare("SELECT status FROM memory_entities WHERE entity_id = ?").get(protectedEntityId)?.status,
          "active",
          `${protectedEntityId} must survive as an existing protected entity`,
        );
      }
    } finally {
      dbA.close();
      dbB.close();
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
    runVaultBoundaryFixture();
    runNativeOnlyReadinessFixture();
    runNewerNativeReadinessFixture();
    runProtectedEntityLifecycleFixture();
  });
}

runDirect(import.meta.url, run);

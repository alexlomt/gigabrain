import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runAdaptiveTrust, ensureAdaptiveTrustStore } from "../../lib/core/adaptive-trust.js";
import { normalizeConfig } from "../../lib/core/config.js";
import { appendEvent } from "../../lib/core/event-store.js";
import { queryNativeChunks, ensureNativeStore } from "../../lib/core/native-sync.js";
import { orchestrateRecall } from "../../lib/core/orchestrator.js";
import { resolveEntityKeysForQuery, ensurePersonStore } from "../../lib/core/person-service.js";
import { recallForQuery } from "../../lib/core/recall-service.js";
import {
  configureWorldModelRules,
  ensureWorldModelStore,
  findEntityMatches,
  getEntityDetail,
  listEntities,
  matchCustomSlotRule,
} from "../../lib/core/world-model.js";
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from "../helpers.js";
import { runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OBSERVATIONAL_CORE_PATCHES missing direct ensure-path contracts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const snapshotTree = (root) => {
  if (!existsSync(root)) return [];
  const rows = [];
  const walk = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) rows.push({
        mode: statSync(absolute).mode & 0o777,
        path: relative,
        sha256: sha256(readFileSync(absolute)),
      });
    }
  };
  walk(root);
  return rows;
};

const snapshotDatabase = (db) => {
  const schema = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  const tables = schema.filter((row) => row.type === "table");
  const counts = tables.map((row) => {
    const safeName = String(row.name || "");
    assert.match(safeName, /^[A-Za-z0-9_]+$/);
    return [safeName, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${safeName}`).get()?.count || 0)];
  });
  return {
    counts,
    schema,
    totalChanges: Number(db.prepare("SELECT total_changes() AS count").get()?.count || 0),
  };
};

const snapshotState = (db, root) => ({ database: snapshotDatabase(db), files: snapshotTree(root) });

const assertEmptyEnsureFalseIsObservational = (label, root, operation) => {
  const db = new DatabaseSync(":memory:");
  try {
    const before = snapshotState(db, root);
    try {
      operation(db);
    } catch {
      // A missing schema is an allowed diagnostic outcome; creating it is not.
    }
    assert.deepEqual(snapshotState(db, root), before, `${label} ensure:false must not create schema or files`);
  } finally {
    db.close();
  }
};

const assertReadyPair = (label, db, root, withoutEnsure, withDefaultEnsure, project = (value) => value) => {
  const before = snapshotState(db, root);
  const observational = withoutEnsure();
  assert.deepEqual(snapshotState(db, root), before, `${label} ensure:false must be observational`);
  const defaultResult = withDefaultEnsure();
  assert.deepEqual(snapshotState(db, root), before, `${label} default ensure:true must preserve an already-ready store`);
  assert.deepEqual(project(observational), project(defaultResult), `${label} ensure:false must preserve read semantics`);
  return observational;
};

const seedReadyStore = (db, config) => {
  ensureNativeStore(db);
  ensurePersonStore(db);
  ensureWorldModelStore(db);
  ensureAdaptiveTrustStore(db);
  seedMemoryCurrent(db, [
    {
      memory_id: "synthetic-harbour-strong",
      type: "DECISION",
      content: "Synthetic Harbour blue routing checklist and rollout routing controls.",
      normalized: "synthetic harbour blue routing checklist and rollout routing controls",
      scope: "shared",
      confidence: 0.96,
      value_score: 0.91,
      value_label: "core",
    },
    {
      memory_id: "synthetic-harbour-weak",
      type: "CONTEXT",
      content: "Synthetic Harbour note for later.",
      normalized: "synthetic harbour note for later",
      scope: "shared",
      confidence: 0.55,
      value_score: 0.25,
      value_label: "situational",
    },
  ]);
  const now = "2026-08-25T00:00:00.000Z";
  db.prepare(`
    INSERT INTO memory_native_chunks (
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, hash, scope, linked_memory_id, first_seen_at, last_seen_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "native:synthetic-harbour",
    "memory/synthetic.md",
    "curated",
    "2026-08-25",
    "Decisions",
    1,
    1,
    "Synthetic Harbour blue routing native reference.",
    "synthetic harbour blue routing native reference",
    sha256("synthetic-harbour-native"),
    "shared",
    null,
    now,
    now,
    "active",
  );
  db.prepare(`
    INSERT INTO memory_entity_mentions (
      id, memory_id, entity_key, entity_display, role, confidence, source, scope, source_path, linked_memory_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "mention:synthetic-harbour",
    "synthetic-harbour-strong",
    "synthetic harbour",
    "Synthetic Harbour",
    "project",
    0.98,
    "memory_current",
    "shared",
    null,
    null,
  );
  db.prepare(`
    INSERT INTO memory_entities (
      entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "project:synthetic-harbour",
    "project",
    "Synthetic Harbour",
    "synthetic harbour",
    "active",
    0.97,
    JSON.stringify(["Synthetic Harbour"]),
    now,
    now,
    JSON.stringify({ recall_allowed: true, scopes: ["shared"] }),
  );
  db.prepare(`
    INSERT INTO memory_entity_aliases (
      alias_id, entity_id, alias, normalized_alias, confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "alias:synthetic-harbour",
    "project:synthetic-harbour",
    "Synthetic Harbour",
    "synthetic harbour",
    0.99,
    now,
    now,
  );
  appendEvent(db, {
    event_id: "event:synthetic-trust-verdict",
    timestamp: now,
    component: "belief_arbitration",
    action: "arbiter:verdict",
    memory_id: "host:alpha:winner",
    reason_codes: ["synthetic_fixture"],
    payload: {
      loserIds: ["host:beta:loser"],
      signals: { slot: "project.synthetic.status" },
      winnerId: "host:alpha:winner",
    },
  });
  config.worldModel = {
    ...(config.worldModel || {}),
    arbiter: {
      ...(config.worldModel?.arbiter || {}),
      adaptiveTrust: {
        enabled: false,
        evidenceHalfLifeDays: 90,
        maxDriftPerCycle: 0.02,
        trustCeil: 0.95,
        trustFloor: 0.35,
        witnessMin: 1,
      },
    },
  };
};

export async function run() {
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const workspace = makeTempWorkspace("gigabrain-task5-observational-core-");
    const config = normalizeConfig(makeConfigObject(workspace.workspace).plugins.entries.gigabrain.config);
    config.recall.semanticRerankEnabled = false;
    config.native.enabled = true;
    const db = openDb(workspace.dbPath);
    try {
      assertEmptyEnsureFalseIsObservational("adaptive trust", workspace.root, (empty) => runAdaptiveTrust({
        db: empty,
        config,
        dryRun: true,
        ensure: false,
        now: "2026-08-25T00:00:00.000Z",
      }));
      assertEmptyEnsureFalseIsObservational("native query", workspace.root, (empty) => queryNativeChunks({
        db: empty,
        config,
        ensure: false,
        query: "synthetic harbour",
      }));
      assertEmptyEnsureFalseIsObservational("entity resolution", workspace.root, (empty) => resolveEntityKeysForQuery(
        empty,
        "Synthetic Harbour",
        { ensure: false, fallbackTokens: true, scope: "shared" },
      ));
      assertEmptyEnsureFalseIsObservational("recall", workspace.root, (empty) => recallForQuery({
        db: empty,
        config,
        ensure: false,
        query: "synthetic harbour",
        scope: "shared",
      }));
      assertEmptyEnsureFalseIsObservational("orchestration", workspace.root, (empty) => orchestrateRecall({
        db: empty,
        config,
        query: "synthetic harbour",
        scope: "shared",
        scopeVisibility: { allowMaintenance: false },
      }));
      assertEmptyEnsureFalseIsObservational("world model", workspace.root, (empty) => getEntityDetail(
        empty,
        "project:synthetic-harbour",
        { ensure: false, scope: "shared" },
      ));

      seedReadyStore(db, config);

      const trust = assertReadyPair(
        "adaptive trust",
        db,
        workspace.root,
        () => runAdaptiveTrust({ db, config, dryRun: true, ensure: false, now: "2026-08-25T00:00:00.000Z" }),
        () => runAdaptiveTrust({ db, config, dryRun: true, now: "2026-08-25T00:00:00.000Z" }),
        (value) => value.hosts.map((row) => ({ host: row.host, target: row.target })).sort((a, b) => a.host.localeCompare(b.host, "en")),
      );
      assert.ok(trust.hosts.some((row) => row.host === "alpha" && row.target > 0));
      assert.ok(trust.hosts.some((row) => (
        row.host === "beta"
        && row.target <= 0
        && Number(row.evidence?.losses_total || 0) === 1
      )));
      assert.doesNotThrow(() => runAdaptiveTrust({
        db,
        config,
        dryRun: true,
        ensure: false,
        now: "2026-08-25T00:00:00.000Z",
      }));

      const nativeRows = assertReadyPair(
        "native query",
        db,
        workspace.root,
        () => queryNativeChunks({ db, config, ensure: false, query: "synthetic harbour blue routing", scope: "shared" }),
        () => queryNativeChunks({ db, config, query: "synthetic harbour blue routing", scope: "shared" }),
        (rows) => rows.map((row) => ({ id: row.chunk_id, score: row.score_total })),
      );
      assert.equal(nativeRows[0]?.chunk_id, "native:synthetic-harbour");
      assert.doesNotThrow(() => queryNativeChunks({
        db,
        config,
        ensure: false,
        query: "synthetic harbour blue routing",
        scope: "shared",
      }));

      const entityKeys = assertReadyPair(
        "entity resolution",
        db,
        workspace.root,
        () => resolveEntityKeysForQuery(db, "Who is Synthetic Harbour?", { ensure: false, fallbackTokens: true, scope: "shared" }),
        () => resolveEntityKeysForQuery(db, "Who is Synthetic Harbour?", { fallbackTokens: true, scope: "shared" }),
      );
      assert.ok(entityKeys.includes("synthetic harbour"));
      assert.doesNotThrow(() => resolveEntityKeysForQuery(
        db,
        "Who is Synthetic Harbour?",
        { ensure: false, fallbackTokens: true, scope: "shared" },
      ));

      const world = assertReadyPair(
        "world model",
        db,
        workspace.root,
        () => ({
          detail: getEntityDetail(db, "project:synthetic-harbour", { ensure: false, scope: "shared" }),
          entities: listEntities(db, { ensure: false, kind: "project" }),
          matches: findEntityMatches(db, "Synthetic Harbour", { ensure: false, scope: "shared" }),
        }),
        () => ({
          detail: getEntityDetail(db, "project:synthetic-harbour", { scope: "shared" }),
          entities: listEntities(db, { kind: "project" }),
          matches: findEntityMatches(db, "Synthetic Harbour", { scope: "shared" }),
        }),
        (value) => ({
          detail: value.detail?.entity_id,
          entities: value.entities.map((row) => row.entity_id),
          matches: value.matches.map((row) => row.entity_id),
        }),
      );
      assert.equal(world.detail?.entity_id, "project:synthetic-harbour");
      assert.equal(world.matches[0]?.entity_id, "project:synthetic-harbour");
      assert.doesNotThrow(() => getEntityDetail(
        db,
        "project:synthetic-harbour",
        { ensure: false, scope: "shared" },
      ));

      const recall = assertReadyPair(
        "observational recall and rank fusion",
        db,
        workspace.root,
        () => recallForQuery({
          db,
          config,
          ensure: false,
          query: "synthetic harbour blue routing",
          scope: "shared",
          strategyContext: { strategy: "quick_context" },
        }),
        () => recallForQuery({
          db,
          config,
          query: "synthetic harbour blue routing",
          scope: "shared",
          strategyContext: { strategy: "quick_context" },
        }),
        (value) => ({
          entityKeys: value.entityKeys,
          ids: value.results.map((row) => row.memory_id || row.chunk_id),
          rankingMode: value.rankingMode,
          scores: value.results.map((row) => row._score),
        }),
      );
      assert.equal(recall.results[0]?.memory_id, "synthetic-harbour-strong");
      assert.doesNotThrow(() => recallForQuery({
        db,
        config,
        ensure: false,
        query: "synthetic harbour blue routing",
        scope: "shared",
        strategyContext: { strategy: "quick_context" },
      }));

      const beforeObservationalOrchestration = snapshotState(db, workspace.root);
      const orchestration = orchestrateRecall({
        db,
        config,
        query: "Tell me about Synthetic Harbour",
        scope: "shared",
        scopeVisibility: { allowMaintenance: false, includeShared: true },
      });
      assert.deepEqual(
        snapshotState(db, workspace.root),
        beforeObservationalOrchestration,
        "orchestration allowMaintenance:false must propagate ensure:false without writes",
      );
      assert.equal(orchestration.selectedEntityId, "project:synthetic-harbour");
      assert.doesNotThrow(() => orchestrateRecall({
        db,
        config,
        query: "Tell me about Synthetic Harbour",
        scope: "shared",
        scopeVisibility: { allowMaintenance: false, includeShared: true },
      }));
      const defaultOrchestration = orchestrateRecall({
        db,
        config,
        query: "Tell me about Synthetic Harbour",
        scope: "shared",
        scopeVisibility: { includeShared: true },
      });
      const afterDefaultOrchestration = snapshotDatabase(db);
      assert.ok(
        afterDefaultOrchestration.totalChanges > beforeObservationalOrchestration.database.totalChanges,
        "default orchestration must retain its ensure:true world-model maintenance behavior",
      );
      assert.equal(Array.isArray(defaultOrchestration.entityMatches), true);
      assert.equal(typeof defaultOrchestration.strategy, "string");

      configureWorldModelRules({
        worldModel: {
          customSlotRules: [{
            pattern: "synthetic harbour.*blue",
            slot: "project.synthetic_harbour.color",
            subtopic: "color",
            topic: "project",
            value: "blue",
          }],
        },
      });
      assert.deepEqual(matchCustomSlotRule("Synthetic Harbour remains blue."), {
        normalizedValue: "blue",
        operation: "update",
        slot: "project.synthetic_harbour.color",
        subtopic: "color",
        topic: "project",
      });
    } finally {
      configureWorldModelRules({});
      db.close();
      rmSync(workspace.root, { force: true, recursive: true });
    }
  });
}

runDirect(import.meta.url, run);

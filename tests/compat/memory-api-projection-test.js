import assert from "node:assert/strict";

import { openDatabase } from "../../lib/core/sqlite.js";
import { importContractModule, requireCallable, runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "11";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_MEMORY_API_PROJECTION missing projection sync contract";

const memory = (id, overrides = {}) => ({
  confidence: 0.94,
  content: `Synthetic multilingual memory ${id}: Grüße 東京`,
  created_at: "2026-08-26T12:00:00.000Z",
  memory_id: id,
  scope: "profile:main",
  source: "synthetic",
  source_agent: "main",
  source_kind: "api",
  source_layer: "registry",
  status: "active",
  tags: ["synthetic"],
  type: "DECISION",
  updated_at: "2026-08-26T12:00:00.000Z",
  valid_from: "2026-08-26T11:00:00.000Z",
  ...overrides,
});
const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c || 0);

export async function run() {
  const projection = await importContractModule("lib/core/projection-store.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const ensureProjectionStore = requireCallable(projection, "ensureProjectionStore");
    const mutate = requireCallable(projection, "mutateCurrentMemoryWithLegacyProjection");
    const updateCurrentStatus = requireCallable(projection, "updateCurrentStatus");
    const upsertCurrentMemory = requireCallable(projection, "upsertCurrentMemory");
    const withBatch = requireCallable(projection, "withProjectionMutationBatch");
    const db = openDatabase(":memory:");
    try {
      ensureProjectionStore(db);
      for (const table of ["memory_current", "memories", "memory_console_metadata", "memory_events"]) {
        assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)), true, table);
      }
      const inserted = upsertCurrentMemory(db, memory("direct"), {
        metadata: {
          concept: "synthetic-concept",
          pinned: true,
          review_reason: "synthetic-review",
          review_version: "rv-synthetic",
          source_message_id: "message-direct",
          ttl_days: 30,
        },
        operationId: "direct-upsert",
      });
      assert.equal(inserted.memory_id, "direct");
      const current = db.prepare("SELECT * FROM memory_current WHERE memory_id = ?").get("direct");
      const legacy = db.prepare("SELECT * FROM memories WHERE id = ?").get("direct");
      const metadata = db.prepare("SELECT * FROM memory_console_metadata WHERE memory_id = ?").get("direct");
      for (const key of ["type", "content", "normalized", "source", "source_agent", "scope", "status", "created_at", "updated_at", "valid_until"]) {
        assert.equal(legacy[key], current[key], `legacy/current mismatch for ${key}`);
      }
      assert.deepEqual(
        {
          concept: metadata.concept,
          pinned: metadata.pinned,
          review_reason: metadata.review_reason,
          review_version: metadata.review_version,
          source_message_id: metadata.source_message_id,
          ttl_days: metadata.ttl_days,
        },
        {
          concept: "synthetic-concept",
          pinned: 1,
          review_reason: "synthetic-review",
          review_version: "rv-synthetic",
          source_message_id: "message-direct",
          ttl_days: 30,
        },
      );
      assert.match(current.normalized_hash, /^[0-9a-f]{64}$/);
      const directEvents = db.prepare("SELECT action, memory_id, payload FROM memory_events WHERE memory_id = ?").all("direct");
      assert.equal(directEvents.length, 1);
      assert.equal(directEvents[0].action, "projection:upsert");
      assert.equal(JSON.parse(directEvents[0].payload).operation_id, "direct-upsert");

      const receipt = withBatch({ db, operationId: "explicit-batch", now: "2026-08-26T13:00:00.000Z" }, (tx) => mutate({
        event: { action: "projection:upsert", component: "synthetic" },
        metadata: { concept: "batch-concept", pinned: false },
        mutation: { kind: "upsert", memory: memory("batch") },
        tx,
      }));
      assert.equal(receipt.result.memory_id, "batch");
      assert.equal(receipt.receipt.boundary, "begin_immediate");
      assert.equal(receipt.receipt.mutations, 1);

      db.exec("BEGIN IMMEDIATE");
      try {
        const nested = withBatch({ db, operationId: "nested-batch" }, (tx) => mutate({
          event: { action: "projection:upsert", component: "synthetic" },
          mutation: { kind: "upsert", memory: memory("nested") },
          tx,
        }));
        assert.equal(nested.receipt.boundary, "savepoint");
        assert.equal(db.isTransaction, true);
        db.exec("ROLLBACK");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      assert.equal(db.prepare("SELECT 1 FROM memory_current WHERE memory_id='nested'").get(), undefined);

      for (const stage of ["after_current", "after_legacy", "after_metadata", "after_event"]) {
        const before = {
          current: count(db, "memory_current"),
          events: count(db, "memory_events"),
          legacy: count(db, "memories"),
          metadata: count(db, "memory_console_metadata"),
        };
        assert.throws(() => withBatch({ db, operationId: `fault-${stage}` }, (tx) => mutate({
          event: { action: "projection:upsert", component: "synthetic" },
          faultInjector: (observed) => { if (observed === stage) throw new Error(`synthetic fault ${stage}`); },
          metadata: { concept: `fault-${stage}` },
          mutation: { kind: "upsert", memory: memory(`fault-${stage}`) },
          tx,
        })), new RegExp(`synthetic fault ${stage}`));
        assert.deepEqual({
          current: count(db, "memory_current"),
          events: count(db, "memory_events"),
          legacy: count(db, "memories"),
          metadata: count(db, "memory_console_metadata"),
        }, before, `${stage} must roll back every projection surface`);
      }

      assert.equal(updateCurrentStatus(db, "direct", "archived", {
        superseded_by: "batch",
        timestamp: "2026-08-26T14:00:00.000Z",
      }, { operationId: "status-update" }), 1);
      for (const [table, idColumn] of [["memory_current", "memory_id"], ["memories", "id"]]) {
        assert.deepEqual(db.prepare(`SELECT status, superseded_by FROM ${table} WHERE ${idColumn}='direct'`).get(), {
          status: "archived",
          superseded_by: "batch",
        });
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE memory_id='direct' AND action='projection:status'").get().c, 1);
    } finally {
      db.close();
    }
  });
}

runDirect(import.meta.url, run);

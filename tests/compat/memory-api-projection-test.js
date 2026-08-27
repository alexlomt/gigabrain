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
const projectionCounts = (db) => ({
  current: count(db, "memory_current"),
  events: count(db, "memory_events"),
  fts: count(db, "memory_fts"),
  legacy: count(db, "memories"),
  metadata: count(db, "memory_console_metadata"),
});

const assertLegacyAdditiveColumns = (ensureProjectionStore) => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'CONTEXT',
        content TEXT NOT NULL,
        normalized TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'capture',
        source_agent TEXT,
        source_session TEXT,
        confidence REAL DEFAULT 0.6,
        status TEXT NOT NULL DEFAULT 'active',
        scope TEXT NOT NULL DEFAULT 'shared',
        tags TEXT,
        created_at TEXT,
        updated_at TEXT,
        superseded_by TEXT,
        content_time TEXT,
        valid_until TEXT,
        value_score REAL,
        value_label TEXT,
        archived_at TEXT,
        last_reviewed_at TEXT
      )
    `);
    ensureProjectionStore(db);
    const columns = new Set(db.prepare("PRAGMA table_info(memories)").all().map((row) => row.name));
    for (const column of [
      "concept",
      "last_confirmed_at",
      "last_injected_at",
      "pinned",
      "review_reason",
      "review_version",
      "source_message_id",
      "ttl_days",
    ]) {
      assert.equal(columns.has(column), true, `legacy schema must add ${column}`);
    }
  } finally {
    db.close();
  }
};

export async function run() {
  const projection = await importContractModule("lib/core/projection-store.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const ensureProjectionStore = requireCallable(projection, "ensureProjectionStore");
    const mutate = requireCallable(projection, "mutateCurrentMemoryWithLegacyProjection");
    const updateCurrentStatus = requireCallable(projection, "updateCurrentStatus");
    const upsertCurrentMemory = requireCallable(projection, "upsertCurrentMemory");
    const withBatch = requireCallable(projection, "withProjectionMutationBatch");
    assertLegacyAdditiveColumns(ensureProjectionStore);
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

      const unicode = upsertCurrentMemory(db, memory("unicode", {
        content: "[m:12345678-abcd] Grüße 東京 — Café １２３",
        status: "pending",
      }), { operationId: "unicode-upsert" });
      assert.equal(unicode.normalized, "grüße 東京 café １２３");
      assert.equal(unicode.normalized_hash, "06731553c4e09eaab3f8ddf4f9745c88cf7988b396fb9d230e41784182bf02c7");
      assert.equal(unicode.status, "pending");

      const canonical = upsertCurrentMemory(db, memory("canonical", {
        content: "Canonical timestamps and normalized text",
        content_time: "2026-08-26T14:00:00+02:00",
        created_at: "2026-08-26T13:00:00+01:00",
        normalized: "CALLER SUPPLIED NORMALIZED VALUE MUST BE IGNORED",
        updated_at: "2026-08-26T14:30:00+02:00",
        valid_from: "2026-08-26T13:30:00+01:00",
        valid_until: "2026-09-26T14:30:00+02:00",
      }), {
        event: { action: "domain:canonicalized", component: "synthetic" },
        operationId: "canonical-upsert",
      });
      assert.deepEqual({
        content_time: canonical.content_time,
        created_at: canonical.created_at,
        normalized: canonical.normalized,
        updated_at: canonical.updated_at,
        valid_from: canonical.valid_from,
        valid_until: canonical.valid_until,
      }, {
        content_time: "2026-08-26T12:00:00.000Z",
        created_at: "2026-08-26T12:00:00.000Z",
        normalized: "canonical timestamps and normalized text",
        updated_at: "2026-08-26T12:30:00.000Z",
        valid_from: "2026-08-26T12:30:00.000Z",
        valid_until: "2026-09-26T12:30:00.000Z",
      });
      assert.deepEqual(
        { ...db.prepare("SELECT content_time, created_at, normalized, updated_at, valid_from, valid_until FROM memory_current WHERE memory_id='canonical'").get() },
        {
          content_time: "2026-08-26T12:00:00.000Z",
          created_at: "2026-08-26T12:00:00.000Z",
          normalized: "canonical timestamps and normalized text",
          updated_at: "2026-08-26T12:30:00.000Z",
          valid_from: "2026-08-26T12:30:00.000Z",
          valid_until: "2026-09-26T12:30:00.000Z",
        },
      );
      assert.deepEqual(
        { ...db.prepare("SELECT content_time, created_at, normalized, updated_at, valid_until FROM memories WHERE id='canonical'").get() },
        {
          content_time: "2026-08-26T12:00:00.000Z",
          created_at: "2026-08-26T12:00:00.000Z",
          normalized: "canonical timestamps and normalized text",
          updated_at: "2026-08-26T12:30:00.000Z",
          valid_until: "2026-09-26T12:30:00.000Z",
        },
      );
      assert.deepEqual(
        db.prepare("SELECT action, timestamp FROM memory_events WHERE memory_id='canonical'").all().map((row) => ({ ...row })),
        [{ action: "domain:canonicalized", timestamp: "2026-08-26T12:30:00.000Z" }],
        "a caller domain event must be the sole row event and use canonical UTC",
      );

      const noopInput = memory("true-noop", {
        content: "A byte-stable true no-op projection row",
        updated_at: "2026-08-26T12:00:00.000Z",
      });
      upsertCurrentMemory(db, noopInput, { operationId: "true-noop-first" });
      const noopEvents = count(db, "memory_events");
      upsertCurrentMemory(db, noopInput, { operationId: "true-noop-second" });
      assert.equal(count(db, "memory_events"), noopEvents, "an identical projection upsert must emit no event");

      const receipt = withBatch({ db, operationId: "explicit-batch", now: "2026-08-26T13:00:00.000Z" }, (tx) => mutate({
        event: { action: "projection:upsert", component: "synthetic" },
        metadata: { concept: "batch-concept", pinned: false },
        mutation: { kind: "upsert", memory: memory("batch") },
        tx,
      }));
      assert.equal(receipt.result.memory_id, "batch");
      assert.equal(receipt.receipt.boundary, "begin_immediate");
      assert.equal(receipt.receipt.mutations, 1);
      assert.throws(
        () => withBatch({ db, isolation: "deferred", operationId: "bad-isolation" }, () => null),
        /PROJECTION_ISOLATION_INVALID:deferred/,
      );
      assert.throws(
        () => withBatch({ db, operationId: "async-callback" }, async () => null),
        /PROJECTION_ASYNC_CALLBACK_FORBIDDEN/,
      );
      assert.equal(db.isTransaction, false, "an async callback rejection must close its owned transaction");

      const reused = withBatch({ db, operationId: "caller-tx-reuse" }, (tx) => upsertCurrentMemory(
        db,
        memory("caller-tx-row"),
        {
          event: { action: "domain:caller-tx", component: "synthetic" },
          tx,
        },
      ));
      assert.equal(reused.receipt.mutations, 1, "a caller-supplied tx must be reused instead of hidden by a nested batch");
      assert.equal(reused.receipt.events, 1);

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

      for (const boundary of ["top", "caller_owned"]) {
        for (const stage of ["after_current", "after_legacy", "after_metadata", "after_fts", "after_event"]) {
          if (boundary === "caller_owned") db.exec("BEGIN IMMEDIATE");
          try {
            const before = projectionCounts(db);
            let observedCount = 0;
            assert.throws(() => withBatch({ db, operationId: `fault-${boundary}-${stage}` }, (tx) => {
              for (let index = 1; index <= 2; index += 1) {
                mutate({
                  event: { action: "domain:fault-probe", component: "synthetic" },
                  faultInjector: (observed) => {
                    if (observed === stage && ++observedCount === 2) throw new Error(`synthetic nth fault ${stage}`);
                  },
                  metadata: { concept: `fault-${boundary}-${stage}-${index}` },
                  mutation: { kind: "upsert", memory: memory(`fault-${boundary}-${stage}-${index}`) },
                  tx,
                });
              }
            }), new RegExp(`synthetic nth fault ${stage}`));
            assert.deepEqual(projectionCounts(db), before, `${boundary} ${stage} must roll back every projection surface`);
            if (boundary === "caller_owned") assert.equal(db.isTransaction, true, "the caller transaction must remain owned by the caller");
          } finally {
            if (boundary === "caller_owned" && db.isTransaction) db.exec("ROLLBACK");
          }
        }
      }

      const patched = withBatch({ db, operationId: "temporal-patch", now: "2026-08-26T15:00:00.000Z" }, (tx) => mutate({
        event: { action: "domain:temporal-patch", component: "synthetic" },
        mutation: {
          kind: "patch",
          memoryId: "direct",
          patch: {
            updated_at: "2026-08-26T17:00:00+02:00",
            valid_from: "2026-08-26T16:00:00+02:00",
            valid_until: "2026-08-27T16:00:00+02:00",
          },
        },
        tx,
      })).result;
      assert.deepEqual({
        updated_at: patched.updated_at,
        valid_from: patched.valid_from,
        valid_until: patched.valid_until,
      }, {
        updated_at: "2026-08-26T15:00:00.000Z",
        valid_from: "2026-08-26T14:00:00.000Z",
        valid_until: "2026-08-27T14:00:00.000Z",
      });
      assert.throws(() => withBatch({ db, operationId: "invalid-patch" }, (tx) => mutate({
        event: { action: "domain:invalid-patch", component: "synthetic" },
        mutation: { kind: "patch", memoryId: "direct", patch: { content: "forbidden" } },
        tx,
      })), /PROJECTION_PATCH_FIELD_INVALID:content/);

      assert.equal(updateCurrentStatus(db, "direct", "archived", {
        superseded_by: "batch",
        timestamp: "2026-08-26T14:00:00.000Z",
      }, { operationId: "status-update" }), 1);
      for (const [table, idColumn] of [["memory_current", "memory_id"], ["memories", "id"]]) {
        assert.deepEqual({ ...db.prepare(`SELECT status, superseded_by FROM ${table} WHERE ${idColumn}='direct'`).get() }, {
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

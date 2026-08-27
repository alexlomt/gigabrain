import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { applyMemoryActions } from "../../lib/core/memory-actions.js";
import { openDatabase } from "../../lib/core/sqlite.js";
import { importContractModule, requireCallable, runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "11";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_PROJECTION_WRITER_REGISTRY missing centralized projection authority";
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const projectionMemory = (memoryId, content, overrides = {}) => ({
  confidence: 0.9,
  content,
  created_at: "2026-08-26T10:00:00.000Z",
  memory_id: memoryId,
  scope: "shared",
  source: "synthetic",
  source_agent: "codex",
  status: "active",
  type: "USER_FACT",
  updated_at: "2026-08-26T10:00:00.000Z",
  ...overrides,
});

const clearEvents = (db) => db.prepare("DELETE FROM memory_events").run();

const assertMemoryActionDomainEvents = ({ ensureProjectionStore, upsertCurrentMemory }) => {
  const db = openDatabase(":memory:");
  try {
    ensureProjectionStore(db);
    upsertCurrentMemory(db, projectionMemory("forget-target", "Forget target remains active if its domain event fails."));
    clearEvents(db);
    db.exec(`
      CREATE TRIGGER fail_memory_action_forget
      BEFORE INSERT ON memory_events
      WHEN NEW.action = 'memory_action_forget'
      BEGIN SELECT RAISE(ABORT, 'synthetic domain event failure'); END
    `);
    const invokeForget = () => applyMemoryActions({
      actions: [{ action: "forget", target_memory_id: "forget-target" }],
      config: { compat: { writeMode: "full" }, runtime: { cleanupVersion: "v0.11-test", paths: {} } },
      db,
      event: { agentId: "main", scope: "shared", sessionKey: "task11-memory-actions" },
      logger: { info() {}, warn() {} },
      reviewVersion: "rv-task11",
      runId: "task11-memory-actions",
    });
    assert.throws(invokeForget, /synthetic domain event failure/);
    for (const [table, idColumn] of [["memory_current", "memory_id"], ["memories", "id"]]) {
      assert.equal(db.prepare(`SELECT status FROM ${table} WHERE ${idColumn}='forget-target'`).get().status, "active");
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM memory_events").get().c, 0, "a failed domain event must roll back generic and domain events");

    db.exec("DROP TRIGGER fail_memory_action_forget");
    const result = invokeForget();
    assert.equal(result.rejected, 1);
    assert.deepEqual(
      db.prepare("SELECT action, memory_id FROM memory_events").all().map((row) => ({ ...row })),
      [{ action: "memory_action_forget", memory_id: "forget-target" }],
      "forget must emit exactly its caller-supplied domain row event",
    );

    upsertCurrentMemory(db, projectionMemory("replace-target", "The rollout target is the old release."));
    clearEvents(db);
    db.exec(`
      CREATE TRIGGER fail_memory_action_supersede
      BEFORE INSERT ON memory_events
      WHEN NEW.action = 'memory_action_supersede'
      BEGIN SELECT RAISE(ABORT, 'synthetic replacement event failure'); END
    `);
    const invokeReplacement = () => applyMemoryActions({
      actions: [{
        action: "replace",
        confidence: 0.95,
        content: "The rollout target is the reviewed compatibility release.",
        target_memory_id: "replace-target",
        type: "DECISION",
      }],
      config: {
        capture: { rememberIntent: { writeNative: false } },
        compat: { writeMode: "full" },
        runtime: { cleanupVersion: "v0.11-test", paths: {} },
      },
      db,
      event: { agentId: "main", scope: "shared", sessionKey: "task11-replacement" },
      logger: { info() {}, warn() {} },
      runId: "task11-replacement",
    });
    assert.throws(invokeReplacement, /synthetic replacement event failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE memory_id='replace-target' OR source='memory_action'").get().c, 1);
    assert.equal(db.prepare("SELECT status FROM memory_current WHERE memory_id='replace-target'").get().status, "active");
    assert.equal(countEvents(db), 0);

    db.exec("DROP TRIGGER fail_memory_action_supersede");
    const replaced = invokeReplacement();
    assert.equal(replaced.inserted, 1);
    assert.deepEqual(
      db.prepare("SELECT action FROM memory_events ORDER BY action").all().map((row) => row.action),
      ["memory_action_replace", "memory_action_supersede"],
      "replacement must give each changed row exactly one domain event",
    );
  } finally {
    db.close();
  }
};

const assertVerdictProjectionAuthority = ({ ensureProjectionStore, recordVerdict, upsertCurrentMemory }) => {
  const db = openDatabase(":memory:");
  try {
    ensureProjectionStore(db);
    for (const row of [
      projectionMemory("verdict-winner", "The canonical launch month is August."),
      projectionMemory("verdict-loser-a", "The launch month is June."),
      projectionMemory("verdict-loser-b", "The launch month is July."),
    ]) upsertCurrentMemory(db, row);
    clearEvents(db);
    const verdict = recordVerdict(db, {
      agentId: "codex",
      loserIds: ["verdict-loser-a", "verdict-loser-b", "verdict-loser-b"],
      reason: ["task11_atomicity"],
      winnerId: "verdict-winner",
    }, { timestamp: "2026-08-26T12:00:00.000Z" });
    assert.equal(verdict.supersedeEvents.length, 2, "duplicate loser ids must not duplicate row events");
    const rowEvents = db.prepare(`
      SELECT action, memory_id, payload FROM memory_events
      WHERE memory_id IN ('verdict-winner', 'verdict-loser-a', 'verdict-loser-b')
      ORDER BY memory_id, action
    `).all().map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    assert.deepEqual(rowEvents.map(({ action, memory_id }) => ({ action, memory_id })), [
      { action: "arbiter:supersede", memory_id: "verdict-loser-a" },
      { action: "arbiter:supersede", memory_id: "verdict-loser-b" },
      { action: "arbiter:verdict", memory_id: "verdict-winner" },
    ]);
    assert.equal(rowEvents.every((row) => row.payload.projection_event_kind === "row"), true);
    for (const loserId of ["verdict-loser-a", "verdict-loser-b"]) {
      const current = db.prepare("SELECT status, superseded_by, valid_until FROM memory_current WHERE memory_id=?").get(loserId);
      const legacy = db.prepare("SELECT status, superseded_by, valid_until FROM memories WHERE id=?").get(loserId);
      assert.deepEqual({ ...legacy }, { ...current });
    }

    clearEvents(db);
    const flipped = recordVerdict(db, {
      loserIds: ["verdict-winner"],
      reason: ["task11_flip"],
      winnerId: "verdict-loser-a",
    }, { timestamp: "2026-08-26T12:30:00.000Z" });
    assert.equal(flipped.reinstateEvent.action, "arbiter:reinstate");
    assert.equal(flipped.reinstateEvent.payload.projection_event_kind, "row");
    assert.equal(flipped.verdictEvent.action, "arbiter:verdict");
    assert.equal(flipped.verdictEvent.payload.projection_event_kind, "operation_summary");
    assert.equal(flipped.reinstateEvent.payload.verdict_event_id, flipped.verdictEvent.event_id);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE memory_id='verdict-loser-a' AND json_extract(payload, '$.projection_event_kind')='row'").get().c,
      1,
      "a reinstated winner has one row event plus one distinctly typed operation summary",
    );

    for (const row of [
      projectionMemory("atomic-winner", "Atomic winner."),
      projectionMemory("atomic-loser-a", "Atomic loser A."),
      projectionMemory("atomic-loser-b", "Atomic loser B."),
    ]) upsertCurrentMemory(db, row);
    clearEvents(db);
    db.exec(`
      CREATE TRIGGER fail_second_supersede
      BEFORE INSERT ON memory_events
      WHEN NEW.action = 'arbiter:supersede' AND NEW.memory_id = 'atomic-loser-b'
      BEGIN SELECT RAISE(ABORT, 'synthetic verdict event failure'); END
    `);
    assert.throws(() => recordVerdict(db, {
      loserIds: ["atomic-loser-a", "atomic-loser-b"],
      winnerId: "atomic-winner",
    }, { timestamp: "2026-08-26T13:00:00.000Z" }), /synthetic verdict event failure/);
    assert.deepEqual(
      db.prepare("SELECT memory_id, status, superseded_by, valid_until FROM memory_current WHERE memory_id LIKE 'atomic-%' ORDER BY memory_id").all().map((row) => ({ ...row })),
      [
        { memory_id: "atomic-loser-a", status: "active", superseded_by: null, valid_until: null },
        { memory_id: "atomic-loser-b", status: "active", superseded_by: null, valid_until: null },
        { memory_id: "atomic-winner", status: "active", superseded_by: null, valid_until: null },
      ],
    );
    assert.equal(countEvents(db), 0);
  } finally {
    db.close();
  }
};

const countEvents = (db) => Number(db.prepare("SELECT COUNT(*) AS c FROM memory_events").get()?.c || 0);

export async function run() {
  const projection = await importContractModule("lib/core/projection-store.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const mutateCurrentMemoryWithLegacyProjection = requireCallable(projection, "mutateCurrentMemoryWithLegacyProjection");
    const ensureProjectionStore = requireCallable(projection, "ensureProjectionStore");
    const recordVerdict = requireCallable(projection, "recordVerdict");
    const upsertCurrentMemory = requireCallable(projection, "upsertCurrentMemory");
    const withProjectionMutationBatch = requireCallable(projection, "withProjectionMutationBatch");
    assert.equal(typeof mutateCurrentMemoryWithLegacyProjection, "function");
    assert.equal(typeof withProjectionMutationBatch, "function");
    assert.deepEqual(
      projection.PROJECTION_WRITER_REGISTRY.map((row) => row.id),
      ["audit", "belief_arbitration", "capture", "codex", "handoff_import", "host_sync", "maintenance", "memory_actions", "native_promotion", "openclaw_import", "queue_review", "transcript_harvest", "wiki_reconcile"],
    );
    assert.throws(() => projection.dropLegacyMemoriesTable(null), /LEGACY_DROP_BLOCKED_COMPAT/);
    assertMemoryActionDomainEvents({ ensureProjectionStore, upsertCurrentMemory });
    assertVerdictProjectionAuthority({ ensureProjectionStore, recordVerdict, upsertCurrentMemory });
    const paths = [
      ...readdirSync(path.join(repoRoot, "lib", "core"), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
        .map((entry) => `lib/core/${entry.name}`),
      "lib/compat/queue-review-service.js",
      "scripts/gigabrainctl.js",
    ].sort();
    const directWrite = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:memory_current|memories)\b/i;
    const offenders = paths.filter((relative) => relative !== "lib/core/projection-store.js"
      && directWrite.test(readFileSync(path.join(repoRoot, relative), "utf8")));
    assert.deepEqual(offenders, [], `projection writers bypassed the authority: ${offenders.join(",")}`);
    const projectionSource = readFileSync("lib/core/projection-store.js", "utf8");
    for (const required of ["withProjectionMutationBatch", "mutateCurrentMemoryWithLegacyProjection", "memory_console_metadata", "BEGIN IMMEDIATE", "SAVEPOINT", "projection:upsert", "projection:status"]) {
      assert.equal(projectionSource.includes(required), true, `projection authority omitted ${required}`);
    }
    const verdictSource = projectionSource.slice(
      projectionSource.indexOf("const recordVerdict"),
      projectionSource.indexOf("const ADJUDICATION_ACTION"),
    );
    assert.doesNotMatch(verdictSource, /\bUPDATE\s+memory_current\b/i, "recordVerdict must use the projection mutation authority");
  });
}

runDirect(import.meta.url, run);

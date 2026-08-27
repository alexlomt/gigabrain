import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { reviewQueuedCandidates } from "../../lib/compat/queue-review-service.js";
import { runAudit, runAuditRestore } from "../../lib/core/audit-service.js";
import { captureFromEvent } from "../../lib/core/capture-service.js";
import { normalizeConfig } from "../../lib/core/config.js";
import { runMaintenance } from "../../lib/core/maintenance-service.js";
import { applyMemoryActions } from "../../lib/core/memory-actions.js";
import { promoteNativeChunks } from "../../lib/core/native-promotion.js";
import { ensureNativeStore } from "../../lib/core/native-sync.js";
import { openDatabase } from "../../lib/core/sqlite.js";
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from "../helpers.js";
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
const rowEvents = (db, memoryId) => db.prepare(`
  SELECT action, memory_id, payload FROM memory_events
  WHERE memory_id = ? ORDER BY rowid
`).all(memoryId).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
const assertCurrentLegacyStatus = (db, memoryId, expected) => {
  const current = db.prepare("SELECT status, superseded_by FROM memory_current WHERE memory_id=?").get(memoryId);
  const legacy = db.prepare("SELECT status, superseded_by FROM memories WHERE id=?").get(memoryId);
  assert.deepEqual({ ...current }, expected);
  assert.deepEqual({ ...legacy }, expected);
};
const writerConfig = (workspace) => {
  const config = normalizeConfig(makeConfigObject(workspace).plugins.entries.gigabrain.config);
  config.capture.rememberIntent.writeNative = false;
  config.maintenance.vacuum = false;
  config.native.enabled = false;
  config.nativePromotion.enabled = false;
  config.recall.semanticRerankEnabled = false;
  config.worldModel.enabled = false;
  return config;
};

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

const assertCaptureWriter = ({ withProjectionMutationBatch }) => {
  const temp = makeTempWorkspace("task11-writer-capture-");
  const config = writerConfig(temp.workspace);
  config.dedupe.semanticEnabled = false;
  const db = openDb(temp.dbPath);
  const invoke = (suffix, options = {}) => captureFromEvent({
    config,
    db,
    event: {
      agentId: "main",
      output: `<memory_note type="DECISION" confidence="0.95">Capture writer ${suffix} uses one reviewed projection boundary.</memory_note>`,
      scope: "shared",
      sessionKey: `task11-capture:${suffix}`,
    },
    logger: { info() {}, warn() {} },
    refreshDerived: false,
    reviewVersion: "rv-task11-writer-a",
    runId: `task11-capture-${suffix}`,
    ...options,
  });
  try {
    clearEvents(db);
    const success = invoke("success");
    assert.equal(success.inserted, 1);
    const memoryId = success.inserted_ids[0];
    const events = rowEvents(db, memoryId);
    assert.deepEqual(events.map((row) => row.action), ["capture_inserted"]);
    assert.equal(events[0].payload.projection_event_kind, "row");
    const current = db.prepare("SELECT content, status FROM memory_current WHERE memory_id=?").get(memoryId);
    const legacy = db.prepare("SELECT content, status FROM memories WHERE id=?").get(memoryId);
    assert.deepEqual({ ...legacy }, { ...current });

    for (const boundary of ["top", "caller_owned"]) {
      for (const stage of ["after_current", "after_legacy", "after_fts", "after_event"]) {
        if (boundary === "caller_owned") db.exec("BEGIN IMMEDIATE");
        try {
          const before = {
            current: db.prepare("SELECT COUNT(*) AS c FROM memory_current").get().c,
            events: countEvents(db),
            legacy: db.prepare("SELECT COUNT(*) AS c FROM memories").get().c,
          };
          const run = () => {
            const faultInjector = (observed) => {
              if (observed === stage) throw new Error(`capture synthetic ${stage}`);
            };
            if (boundary === "top") return invoke(`${boundary}-${stage}`, { faultInjector });
            return withProjectionMutationBatch({ db, operationId: `capture-${stage}` }, (tx) => (
              invoke(`${boundary}-${stage}`, { faultInjector, tx })
            ));
          };
          assert.throws(run, new RegExp(`capture synthetic ${stage}`));
          assert.deepEqual({
            current: db.prepare("SELECT COUNT(*) AS c FROM memory_current").get().c,
            events: countEvents(db),
            legacy: db.prepare("SELECT COUNT(*) AS c FROM memories").get().c,
          }, before, `capture ${boundary} ${stage} must roll back`);
          if (boundary === "caller_owned") assert.equal(db.isTransaction, true);
        } finally {
          if (boundary === "caller_owned" && db.isTransaction) db.exec("ROLLBACK");
        }
      }
    }
  } finally {
    db.close();
    rmSync(temp.root, { force: true, recursive: true });
  }
};

const assertAuditWriter = async () => {
  const temp = makeTempWorkspace("task11-writer-audit-");
  const config = writerConfig(temp.workspace);
  const memoryId = "audit-writer-row";
  const db = openDb(temp.dbPath);
  seedMemoryCurrent(db, [projectionMemory(memoryId, "The user prefers concise reviewed operating summaries.", {
    type: "PREFERENCE",
  })]);
  clearEvents(db);
  db.close();
  const output = (label) => ({
    out: path.join(temp.outputRoot, `${label}.jsonl`),
    samples: path.join(temp.outputRoot, `${label}.md`),
    summary: path.join(temp.outputRoot, `${label}.json`),
  });
  try {
    await runAudit({
      config,
      dbPath: temp.dbPath,
      mode: "apply",
      reviewVersion: "rv-task11-audit-success",
      runId: "task11-audit-success",
      ...output("success"),
    });
    const check = openDb(temp.dbPath);
    try {
      const events = rowEvents(check, memoryId);
      assert.equal(events.length, 1, "audit apply must emit exactly one row event");
      assert.match(events[0].action, /^audit_/);
      assert.equal(events[0].payload.projection_event_kind, "row");
      const current = check.prepare("SELECT status, value_score, value_label FROM memory_current WHERE memory_id=?").get(memoryId);
      const legacy = check.prepare("SELECT status, value_score, value_label FROM memories WHERE id=?").get(memoryId);
      assert.deepEqual({ ...legacy }, { ...current });
      clearEvents(check);
    } finally {
      check.close();
    }

    runAuditRestore({
      cleanupVersion: "v0.11-test",
      dbPath: temp.dbPath,
      reviewVersion: "rv-task11-audit-success",
      runId: "task11-audit-restore",
    });
    const restored = openDb(temp.dbPath);
    try {
      const events = rowEvents(restored, memoryId);
      assert.deepEqual(events.map((row) => row.action), ["audit_restore"]);
      assert.equal(events[0].payload.projection_event_kind, "row");
      clearEvents(restored);
      restored.exec(`
        CREATE TRIGGER fail_task11_audit_event
        BEFORE INSERT ON memory_events
        WHEN NEW.component='review' AND NEW.action LIKE 'audit_%'
        BEGIN SELECT RAISE(ABORT, 'audit synthetic event failure'); END
      `);
    } finally {
      restored.close();
    }

    const beforeFailure = openDb(temp.dbPath);
    const before = beforeFailure.prepare("SELECT status, value_score, value_label, last_reviewed_at FROM memory_current WHERE memory_id=?").get(memoryId);
    beforeFailure.close();
    const failedOutput = output("failed");
    await assert.rejects(() => runAudit({
      config,
      dbPath: temp.dbPath,
      mode: "apply",
      reviewVersion: "rv-task11-audit-failure",
      runId: "task11-audit-failure",
      ...failedOutput,
    }), /audit synthetic event failure/);
    const afterFailure = openDb(temp.dbPath);
    try {
      assert.deepEqual(
        { ...afterFailure.prepare("SELECT status, value_score, value_label, last_reviewed_at FROM memory_current WHERE memory_id=?").get(memoryId) },
        { ...before },
      );
      assert.equal(countEvents(afterFailure), 0);
      assert.equal(existsSync(failedOutput.out), false, "failed audit DB batch must not advance output completion");
    } finally {
      afterFailure.close();
    }
  } finally {
    rmSync(temp.root, { force: true, recursive: true });
  }
};

const maintenanceFixture = (label, fail = false) => {
  const temp = makeTempWorkspace(`task11-writer-maintenance-${label}-`);
  const config = writerConfig(temp.workspace);
  config.dedupe.semanticEnabled = false;
  config.nativePromotion.enabled = false;
  const ids = [`maintenance-${label}-a`, `maintenance-${label}-b`];
  const db = openDb(temp.dbPath);
  seedMemoryCurrent(db, ids.map((memoryId) => projectionMemory(
    memoryId,
    "The user prefers concise answers for every important reviewed decision.",
    { confidence: 0.99, type: "PREFERENCE", value_label: "core", value_score: 0.99 },
  )));
  clearEvents(db);
  if (fail) {
    db.exec(`
      CREATE TRIGGER fail_task11_maintenance_event
      BEFORE INSERT ON memory_events
      WHEN NEW.action='dedupe_exact_archive'
      BEGIN SELECT RAISE(ABORT, 'maintenance synthetic event failure'); END
    `);
  }
  db.close();
  return { config, ids, temp };
};

const assertMaintenanceWriter = () => {
  const success = maintenanceFixture("success");
  try {
    runMaintenance({
      config: success.config,
      dbPath: success.temp.dbPath,
      dryRun: false,
      reviewVersion: "rv-task11-maintenance",
      runId: "task11-maintenance-success",
    });
    const db = openDb(success.temp.dbPath);
    try {
      const archived = db.prepare(`
        SELECT memory_id FROM memory_current
        WHERE memory_id IN (?, ?) AND status='archived'
      `).all(...success.ids);
      assert.equal(archived.length, 1, "exact-dedupe maintenance phase must archive one loser");
      const loserId = archived[0].memory_id;
      assertCurrentLegacyStatus(db, loserId, { status: "archived", superseded_by: null });
      const events = rowEvents(db, loserId);
      assert.deepEqual(events.map((row) => row.action), ["dedupe_exact_archive"]);
      assert.equal(events[0].payload.projection_event_kind, "row");
    } finally {
      db.close();
    }
  } finally {
    rmSync(success.temp.root, { force: true, recursive: true });
  }

  const failed = maintenanceFixture("failure", true);
  try {
    assert.throws(() => runMaintenance({
      config: failed.config,
      dbPath: failed.temp.dbPath,
      dryRun: false,
      reviewVersion: "rv-task11-maintenance",
      runId: "task11-maintenance-failure",
    }), /maintenance synthetic event failure/);
    const db = openDb(failed.temp.dbPath);
    try {
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS c FROM memory_current
        WHERE memory_id IN (?, ?) AND status='active'
      `).get(...failed.ids).c, 2, "failed maintenance phase must roll back every loser mutation");
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS c FROM memory_events WHERE memory_id IN (?, ?)
      `).get(...failed.ids).c, 0);
      const eventsPath = String(failed.config.maintenance.eventsPath || "");
      if (eventsPath && existsSync(eventsPath)) {
        assert.doesNotMatch(readFileSync(eventsPath, "utf8"), /dedupe_exact_archive/);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(failed.temp.root, { force: true, recursive: true });
  }
};

const nativePromotionFixture = (label) => {
  const temp = makeTempWorkspace(`task11-writer-native-${label}-`);
  const config = writerConfig(temp.workspace);
  config.nativePromotion.enabled = true;
  config.nativePromotion.minConfidence = 0.72;
  config.nativePromotion.promoteFromMemoryMd = true;
  const db = openDb(temp.dbPath);
  ensureNativeStore(db);
  const sourcePath = path.join(temp.workspace, `${label}-MEMORY.md`);
  db.prepare(`
    INSERT INTO memory_native_chunks (
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, hash, scope, memory_type, origin_kind, linked_memory_id,
      first_seen_at, last_seen_at, status
    ) VALUES (?, ?, 'memory_md', '2026-08-26', 'Preferences', 1, 1, ?, ?, ?,
      'profile:main', 'PREFERENCE', 'human_native', NULL, ?, ?, 'active')
  `).run(
    `native-chunk-${label}`,
    sourcePath,
    "The user prefers concise answers for every important reviewed decision.",
    "the user prefers concise answers for every important reviewed decision",
    `hash-${label}`,
    "2026-08-26T10:00:00.000Z",
    "2026-08-26T10:00:00.000Z",
  );
  clearEvents(db);
  return { config, db, sourcePath, temp };
};

const assertNativePromotionWriter = ({ withProjectionMutationBatch }) => {
  const success = nativePromotionFixture("success");
  try {
    const result = promoteNativeChunks({
      config: success.config,
      db: success.db,
      operationId: "task11-native-success",
      sourcePaths: [success.sourcePath],
    });
    assert.equal(result.promoted_inserted, 1);
    const memoryId = result.promoted_ids[0];
    const events = rowEvents(success.db, memoryId);
    assert.deepEqual(events.map((row) => row.action), ["native_promotion_inserted"]);
    assert.equal(events[0].payload.projection_event_kind, "row");
    const current = success.db.prepare("SELECT content, status FROM memory_current WHERE memory_id=?").get(memoryId);
    const legacy = success.db.prepare("SELECT content, status FROM memories WHERE id=?").get(memoryId);
    assert.deepEqual({ ...legacy }, { ...current });
    assert.equal(success.db.prepare("SELECT linked_memory_id FROM memory_native_chunks WHERE chunk_id='native-chunk-success'").get().linked_memory_id, memoryId);
  } finally {
    success.db.close();
    rmSync(success.temp.root, { force: true, recursive: true });
  }

  const failed = nativePromotionFixture("failure");
  try {
    failed.db.exec(`
      CREATE TRIGGER fail_task11_native_event
      BEFORE INSERT ON memory_events
      WHEN NEW.action='native_promotion_inserted'
      BEGIN SELECT RAISE(ABORT, 'native promotion synthetic event failure'); END
    `);
    assert.throws(() => promoteNativeChunks({
      config: failed.config,
      db: failed.db,
      operationId: "task11-native-failure",
      sourcePaths: [failed.sourcePath],
    }), /native promotion synthetic event failure/);
    assert.equal(failed.db.prepare("SELECT COUNT(*) AS c FROM memory_current").get().c, 0);
    assert.equal(failed.db.prepare("SELECT linked_memory_id FROM memory_native_chunks WHERE chunk_id='native-chunk-failure'").get().linked_memory_id, null);
    assert.equal(countEvents(failed.db), 0);
  } finally {
    failed.db.close();
    rmSync(failed.temp.root, { force: true, recursive: true });
  }

  const nested = nativePromotionFixture("nested");
  try {
    nested.db.exec("BEGIN IMMEDIATE");
    try {
      assert.throws(() => withProjectionMutationBatch({ db: nested.db, operationId: "task11-native-nested" }, (tx) => (
        promoteNativeChunks({
          config: nested.config,
          db: nested.db,
          faultInjector: (stage) => { if (stage === "after_event") throw new Error("native nested after_event"); },
          operationId: "task11-native-nested",
          sourcePaths: [nested.sourcePath],
          tx,
        })
      )), /native nested after_event/);
      assert.equal(nested.db.isTransaction, true);
      assert.equal(nested.db.prepare("SELECT COUNT(*) AS c FROM memory_current").get().c, 0);
      assert.equal(nested.db.prepare("SELECT linked_memory_id FROM memory_native_chunks WHERE chunk_id='native-chunk-nested'").get().linked_memory_id, null);
    } finally {
      nested.db.exec("ROLLBACK");
    }
  } finally {
    nested.db.close();
    rmSync(nested.temp.root, { force: true, recursive: true });
  }
};

const queueReviewFixture = (label, enabled = true) => {
  const temp = makeTempWorkspace(`task11-writer-queue-${label}-`);
  const config = writerConfig(temp.workspace);
  const queuePath = path.join(temp.outputRoot, `${label}-queue.jsonl`);
  config.llm.queueReview = {
    allowedReasons: ["duplicate_semantic"],
    enabled,
    limit: 20,
    minConfidence: 0.8,
    profile: "memory_review",
  };
  config.runtime.paths.reviewQueuePath = queuePath;
  const db = openDb(temp.dbPath);
  seedMemoryCurrent(db, [
    projectionMemory(`queue-${label}-winner`, "The reviewed queue winner remains canonical."),
    projectionMemory(`queue-${label}-loser`, "The reviewed queue loser duplicates the canonical fact."),
  ]);
  clearEvents(db);
  const row = {
    id: `queue-row-${label}`,
    loser_memory_id: `queue-${label}-loser`,
    matched_memory_id: `queue-${label}-winner`,
    memory_id: `queue-${label}-loser`,
    payload: {
      matched_memory_id: `queue-${label}-winner`,
      memory_id: `queue-${label}-loser`,
      scope: "shared",
    },
    queued_at: "2026-08-26T10:00:00.000Z",
    reason_code: "duplicate_semantic",
    status: "pending",
    winner_memory_id: `queue-${label}-winner`,
  };
  mkdirSync(path.dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return { config, db, loserId: `queue-${label}-loser`, queuePath, temp, winnerId: `queue-${label}-winner` };
};

const assertQueueReviewWriter = async () => {
  const reviewer = async () => ({ confidence: 0.96, decision: "archive_loser", reason: "reviewed duplicate" });
  const success = queueReviewFixture("success");
  try {
    const result = await reviewQueuedCandidates({
      clock: () => Date.parse("2026-08-26T12:00:00.000Z"),
      config: success.config,
      db: success.db,
      reviewer,
      runId: "task11-queue-success",
    });
    assert.equal(result.duplicateArchived, 1);
    assertCurrentLegacyStatus(success.db, success.loserId, { status: "archived", superseded_by: success.winnerId });
    const events = rowEvents(success.db, success.loserId);
    assert.deepEqual(events.map((row) => row.action), ["queue_review_archive_loser"]);
    assert.equal(events[0].payload.projection_event_kind, "row");
    assert.match(String(events[0].payload.operation_id || ""), /queue-review/);
    assert.equal(JSON.parse(readFileSync(success.queuePath, "utf8")).status, "resolved_auto");
  } finally {
    success.db.close();
    rmSync(success.temp.root, { force: true, recursive: true });
  }

  const failed = queueReviewFixture("failure");
  try {
    const queueBefore = readFileSync(failed.queuePath, "utf8");
    failed.db.exec(`
      CREATE TRIGGER fail_task11_queue_event
      BEFORE INSERT ON memory_events
      WHEN NEW.action='queue_review_archive_loser'
      BEGIN SELECT RAISE(ABORT, 'queue review synthetic event failure'); END
    `);
    await assert.rejects(() => reviewQueuedCandidates({
      clock: () => Date.parse("2026-08-26T12:00:00.000Z"),
      config: failed.config,
      db: failed.db,
      reviewer,
      runId: "task11-queue-failure",
    }), /queue review synthetic event failure/);
    assertCurrentLegacyStatus(failed.db, failed.loserId, { status: "active", superseded_by: null });
    assert.equal(countEvents(failed.db), 0);
    assert.equal(readFileSync(failed.queuePath, "utf8"), queueBefore, "DB failure must leave queue completion retryable");
  } finally {
    failed.db.close();
    rmSync(failed.temp.root, { force: true, recursive: true });
  }

  const disabled = queueReviewFixture("disabled", false);
  try {
    const queueBefore = readFileSync(disabled.queuePath, "utf8");
    const result = await reviewQueuedCandidates({ config: disabled.config, db: disabled.db, reviewer });
    assert.equal(result.enabled, false);
    assert.equal(countEvents(disabled.db), 0);
    assert.equal(readFileSync(disabled.queuePath, "utf8"), queueBefore);
  } finally {
    disabled.db.close();
    rmSync(disabled.temp.root, { force: true, recursive: true });
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
    assertCaptureWriter({ withProjectionMutationBatch });
    await assertAuditWriter();
    assertMaintenanceWriter();
    assertNativePromotionWriter({ withProjectionMutationBatch });
    await assertQueueReviewWriter();
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

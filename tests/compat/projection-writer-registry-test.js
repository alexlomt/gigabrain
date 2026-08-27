import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { reviewQueuedCandidates } from "../../lib/compat/queue-review-service.js";
import { runAudit, runAuditRestore } from "../../lib/core/audit-service.js";
import { consolidateBeliefRows, resolveArbiterSettings } from "../../lib/core/belief-arbitration.js";
import { captureFromEvent } from "../../lib/core/capture-service.js";
import { runClaimDecide, runClaimPropose } from "../../lib/core/codex-service.js";
import { normalizeConfig } from "../../lib/core/config.js";
import { appendClaimDecision, appendClaimProposal, getClaimProposal } from "../../lib/core/control-plane.js";
import {
  BUNDLE_KIND,
  SCHEMA_VERSION,
  computeContentHash,
  importPassportBundle,
} from "../../lib/core/handoff-bundle.js";
import { scanCloudInbox, syncHostMemories } from "../../lib/core/host-memory-sync.js";
import { runMaintenance } from "../../lib/core/maintenance-service.js";
import { applyMemoryActions } from "../../lib/core/memory-actions.js";
import { promoteNativeChunks } from "../../lib/core/native-promotion.js";
import { ensureNativeStore } from "../../lib/core/native-sync.js";
import { importOpenClawRegistry } from "../../lib/core/openclaw-import.js";
import { normalizeContent } from "../../lib/core/policy.js";
import { upsertCurrentMemory } from "../../lib/core/projection-store.js";
import { openDatabase } from "../../lib/core/sqlite.js";
import { harvestTranscripts } from "../../lib/core/transcript-harvester.js";
import { projectArbitrationBeliefRows } from "../../lib/core/world-model.js";
import { HUMAN_WIKI_HOST, STATE_FILE, projectWiki, reconcileWiki } from "../../lib/core/wiki-project.js";
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
    const verdictEvents = db.prepare(`
      SELECT action, memory_id, payload FROM memory_events
      WHERE memory_id IN ('verdict-winner', 'verdict-loser-a', 'verdict-loser-b')
      ORDER BY rowid
    `).all().map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    const summaryEvents = verdictEvents.filter((row) => row.payload.projection_event_kind === "operation_summary");
    const rowMutationEvents = verdictEvents.filter((row) => row.payload.projection_event_kind === "row");
    assert.equal(summaryEvents.length, 1, "every verdict operation must append exactly one summary event");
    assert.equal(summaryEvents[0].action, "arbiter:verdict");
    assert.deepEqual(summaryEvents[0].payload.winnerId, "verdict-winner");
    assert.deepEqual(summaryEvents[0].payload.loserIds, ["verdict-loser-a", "verdict-loser-b"]);
    assert.deepEqual(rowMutationEvents.map(({ action, memory_id }) => ({ action, memory_id })), [
      { action: "arbiter:verdict", memory_id: "verdict-winner" },
      { action: "arbiter:supersede", memory_id: "verdict-loser-a" },
      { action: "arbiter:supersede", memory_id: "verdict-loser-b" },
    ]);
    assert.equal(rowMutationEvents.every((row) => row.payload.projection_event_kind === "row"), true);
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

    for (const row of [
      projectionMemory("noop-winner", "No-op temporal winner.", {
        created_at: "2026-08-26T14:00:00.000Z",
        updated_at: "2026-08-26T14:00:00.000Z",
      }),
      projectionMemory("noop-loser", "No-op temporal loser.", {
        created_at: "2026-08-26T13:00:00.000Z",
        updated_at: "2026-08-26T13:00:00.000Z",
      }),
    ]) upsertCurrentMemory(db, row);
    clearEvents(db);
    const noOpVerdict = recordVerdict(db, {
      loserIds: ["noop-loser"],
      signals: { decided_by: "trust", support: 1 },
      winnerId: "noop-winner",
    }, {
      operationId: "task11-noop-verdict",
      timestamp: "2026-08-26T14:00:00.000Z",
    });
    assert.equal(noOpVerdict.verdictEvent.payload.projection_event_kind, "operation_summary");
    const noOpEvents = rowEvents(db, "noop-winner");
    assert.equal(
      noOpEvents.filter((row) => row.payload.projection_event_kind === "operation_summary").length,
      1,
      "true-no-op winner still requires one verdict summary",
    );
    assert.equal(
      noOpEvents.filter((row) => row.payload.projection_event_kind === "row").length,
      0,
      "true-no-op winner must not receive a fake row event",
    );
    assert.deepEqual(
      rowEvents(db, "noop-loser").filter((row) => row.payload.projection_event_kind === "row").map((row) => row.action),
      ["arbiter:supersede"],
    );

    upsertCurrentMemory(db, projectionMemory("summary-fault-winner", "Summary fault winner.", {
      created_at: "2026-08-26T15:00:00.000Z",
      updated_at: "2026-08-26T15:00:00.000Z",
    }));
    upsertCurrentMemory(db, projectionMemory("summary-fault-loser", "Summary fault loser."));
    clearEvents(db);
    db.exec(`
      CREATE TRIGGER fail_verdict_operation_summary
      BEFORE INSERT ON memory_events
      WHEN NEW.action='arbiter:verdict'
        AND json_extract(NEW.payload, '$.projection_event_kind')='operation_summary'
      BEGIN SELECT RAISE(ABORT, 'synthetic verdict summary failure'); END
    `);
    assert.throws(() => recordVerdict(db, {
      loserIds: ["summary-fault-loser"],
      winnerId: "summary-fault-winner",
    }, {
      operationId: "task11-summary-fault",
      timestamp: "2026-08-26T15:00:00.000Z",
    }), /synthetic verdict summary failure/);
    assertCurrentLegacyStatus(db, "summary-fault-winner", { status: "active", superseded_by: null });
    assertCurrentLegacyStatus(db, "summary-fault-loser", { status: "active", superseded_by: null });
    assert.equal(countEvents(db), 0, "summary failure must roll back the complete verdict batch");
  } finally {
    db.close();
  }
};

const assertCaptureWriter = ({ upsertCurrentMemory, withProjectionMutationBatch }) => {
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

    upsertCurrentMemory(db, projectionMemory("capture-operation-target", "The capture operation target remains active on rollback."));
    clearEvents(db);
    for (const stage of ["after_current", "after_fts", "after_event"]) {
      const before = {
        current: db.prepare("SELECT COUNT(*) AS c FROM memory_current").get().c,
        events: countEvents(db),
        legacy: db.prepare("SELECT COUNT(*) AS c FROM memories").get().c,
      };
      let writes = 0;
      assert.throws(() => captureFromEvent({
        config,
        db,
        event: {
          agentId: "main",
          output: [
            '<memory_action action="forget" target_memory_id="capture-operation-target"></memory_action>',
            '<memory_note type="DECISION" confidence="0.95">First note in the atomic multi-note capture operation.</memory_note>',
            '<memory_note type="DECISION" confidence="0.95">Second distinct note in the atomic multi-note capture operation.</memory_note>',
          ].join("\n"),
          scope: "shared",
          sessionKey: `task11-capture-operation:${stage}`,
        },
        faultInjector: (observed) => {
          if (observed === stage && ++writes === 3) throw new Error(`capture operation ${stage}`);
        },
        logger: { info() {}, warn() {} },
        refreshDerived: false,
        runId: `task11-capture-operation-${stage}`,
      }), new RegExp(`capture operation ${stage}`));
      assert.deepEqual({
        current: db.prepare("SELECT COUNT(*) AS c FROM memory_current").get().c,
        events: countEvents(db),
        legacy: db.prepare("SELECT COUNT(*) AS c FROM memories").get().c,
      }, before, `later ${stage} failure must roll back the whole capture operation`);
      assertCurrentLegacyStatus(db, "capture-operation-target", { status: "active", superseded_by: null });
    }

    upsertCurrentMemory(db, projectionMemory(
      "capture-arbitration-old",
      "Jordan lives in Vienna near the first district.",
      {
        confidence: 0.74,
        source_agent: "codex",
        source_host: "codex",
        source_layer: "host_memory",
      },
    ));
    clearEvents(db);
    db.exec(`
      CREATE TRIGGER fail_post_capture_arbitration
      BEFORE INSERT ON memory_events
      WHEN NEW.action='arbiter:verdict'
      BEGIN SELECT RAISE(ABORT, 'post-capture arbitration event failure'); END
    `);
    const beforeArbitration = db.prepare("SELECT COUNT(*) AS c FROM memory_current").get().c;
    assert.throws(() => captureFromEvent({
      config,
      db,
      event: {
        __captureLlm: { decide: () => ({ confidence: 0.95, op: "ADD" }) },
        agentId: "main",
        output: '<memory_note type="USER_FACT" confidence="0.95">Jordan moved from Vienna and now lives in Graz near the river.</memory_note>',
        scope: "shared",
        sessionKey: "task11-post-capture-arbitration",
      },
      logger: { info() {}, warn() {} },
      projectBeliefRows: ({ db: arbitrationDb }) => {
        const fresh = arbitrationDb.prepare("SELECT memory_id, content FROM memory_current WHERE content LIKE '%now lives in Graz%' LIMIT 1").get();
        return [
          {
            belief_id: "belief-old",
            confidence: 0.2,
            content: "Jordan lives in Vienna near the first district.",
            entity_id: "person:jordan",
            payload: { claim_slot: "person.location", claim_value: "Vienna", scope: "shared" },
            source_agent: "transcript",
            source_host: "transcript",
            source_memory_id: "capture-arbitration-old",
            type: "USER_FACT",
          },
          {
            belief_id: "belief-new",
            confidence: 0.95,
            content: fresh?.content || "Jordan moved from Vienna and now lives in Graz near the river.",
            entity_id: "person:jordan",
            payload: { claim_slot: "person.location", claim_value: "Graz", scope: "shared" },
            source_agent: "human_wiki",
            source_host: "human_wiki",
            source_memory_id: fresh?.memory_id || "missing-fresh-memory",
            type: "USER_FACT",
          },
        ];
      },
      refreshDerived: true,
      runId: "task11-post-capture-arbitration",
    }), /post-capture arbitration event failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM memory_current").get().c, beforeArbitration);
    assertCurrentLegacyStatus(db, "capture-arbitration-old", { status: "active", superseded_by: null });
    assert.equal(countEvents(db), 0, "arbitration failure must roll back capture and arbitration events");
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

const assertAuditCompletionRetry = async () => {
  const temp = makeTempWorkspace("task11-writer-audit-completion-");
  const config = writerConfig(temp.workspace);
  const memoryId = "audit-completion-row";
  const newMemoryId = "audit-completion-new-row";
  const db = openDb(temp.dbPath);
  seedMemoryCurrent(db, [projectionMemory(memoryId, "The user prefers durable completion receipts for audit output.", {
    type: "PREFERENCE",
  })]);
  clearEvents(db);
  db.close();
  const paths = {
    out: path.join(temp.outputRoot, "completion.jsonl"),
    samples: path.join(temp.outputRoot, "completion.md"),
    summary: path.join(temp.outputRoot, "completion.json"),
  };
  const args = {
    config,
    dbPath: temp.dbPath,
    llm: { enabled: true, maxScore: 1, minScore: 0, model: "model-v1", provider: "injected" },
    mode: "apply",
    reviewer: async () => ({ confidence: 0.99, decision: "archive", ok: true, canonical_hint: "" }),
    reviewVersion: "rv-task11-audit-completion",
    runId: "task11-audit-completion-first-fresh-run-id",
    ...paths,
  };
  try {
    let reviewerCalls = 0;
    let failCompletion = true;
    await assert.rejects(() => runAudit({
      ...args,
      reviewer: async () => {
        reviewerCalls += 1;
        return { confidence: 0.99, decision: "archive", ok: true, canonical_hint: "" };
      },
      completionFaultInjector: (stage) => {
        if (stage === "before_audit_output" && failCompletion) {
          failCompletion = false;
          throw new Error("audit external completion failure");
        }
      },
    }), /audit external completion failure/);
    const committed = openDb(temp.dbPath);
    let rowBefore;
    try {
      rowBefore = committed.prepare("SELECT status, value_score, value_label, updated_at, last_reviewed_at FROM memory_current WHERE memory_id=?").get(memoryId);
      assert.equal(rowBefore.status, "archived", "first LLM override must be the committed audit action");
      assert.equal(rowEvents(committed, memoryId).length, 1);
      assert.equal(existsSync(paths.out), false);
      seedMemoryCurrent(committed, [projectionMemory(
        newMemoryId,
        "The user prefers newly eligible review rows to join resumed audit output.",
        { type: "PREFERENCE" },
      )]);
      committed.prepare("DELETE FROM memory_events WHERE memory_id=?").run(newMemoryId);
    } finally {
      committed.close();
    }

    await runAudit({
      ...args,
      llm: { ...args.llm, model: "model-v2" },
      runId: "task11-audit-completion-retry-new-timestamped-run-id",
      reviewer: async () => {
        reviewerCalls += 1;
        return { confidence: 0.99, decision: "keep", ok: true, canonical_hint: "changed output" };
      },
    });
    const retried = openDb(temp.dbPath);
    try {
      assert.deepEqual(
        { ...retried.prepare("SELECT status, value_score, value_label, updated_at, last_reviewed_at FROM memory_current WHERE memory_id=?").get(memoryId) },
        { ...rowBefore },
      );
      assert.equal(rowEvents(retried, memoryId).length, 1);
      assert.deepEqual(rowEvents(retried, newMemoryId).map((row) => row.action), ["audit_keep"]);
      assert.equal(existsSync(paths.out), true, "audit retry must resume external output completion");
      const completedRows = readFileSync(paths.out, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      assert.deepEqual(
        completedRows.map((row) => [row.memory_id, row.action]),
        [[memoryId, "archive"], [newMemoryId, "keep"]],
        "audit retry must merge committed receipt rows with newly reviewed rows in deterministic order",
      );
      assert.equal(reviewerCalls, 2, "receipt-backed A is not reviewed again; newly eligible B is reviewed exactly once");
    } finally {
      retried.close();
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

  const completion = maintenanceFixture("completion");
  try {
    let failCompletion = true;
    const args = {
      completionFaultInjector: (stage) => {
        if (stage === "before_maintenance_row_jsonl" && failCompletion) {
          failCompletion = false;
          throw new Error("maintenance external completion failure");
        }
      },
      config: completion.config,
      dbPath: completion.temp.dbPath,
      dryRun: false,
      reviewVersion: "rv-task11-maintenance-completion",
      runId: "task11-maintenance-completion-first-fresh-run-id",
    };
    assert.throws(() => runMaintenance(args), /maintenance external completion failure/);
    const committed = openDb(completion.temp.dbPath);
    let archivedBefore;
    try {
      archivedBefore = committed.prepare(`
        SELECT memory_id, status, updated_at, last_reviewed_at FROM memory_current
        WHERE memory_id IN (?, ?) AND status='archived'
      `).get(...completion.ids);
      assert.equal(Boolean(archivedBefore?.memory_id), true);
      const events = rowEvents(committed, archivedBefore.memory_id);
      assert.equal(events.length, 1);
      assert.match(String(events[0].payload.completion_id || ""), /exact_dedupe/);
    } finally {
      committed.close();
    }

    runMaintenance({
      ...args,
      completionFaultInjector: null,
      runId: "task11-maintenance-completion-retry-new-timestamped-run-id",
    });
    const retried = openDb(completion.temp.dbPath);
    try {
      assert.deepEqual(
        { ...retried.prepare("SELECT memory_id, status, updated_at, last_reviewed_at FROM memory_current WHERE memory_id=?").get(archivedBefore.memory_id) },
        { ...archivedBefore },
      );
      assert.equal(rowEvents(retried, archivedBefore.memory_id).length, 1);
      const eventsText = readFileSync(completion.config.maintenance.eventsPath, "utf8");
      assert.equal((eventsText.match(/dedupe_exact_archive/g) || []).length, 1, "maintenance retry must resume one missing row JSONL completion");
    } finally {
      retried.close();
    }
  } finally {
    rmSync(completion.temp.root, { force: true, recursive: true });
  }
};

const assertMaintenanceAutoResolveCompletionRetry = () => {
  const temp = makeTempWorkspace("task11-writer-maintenance-auto-completion-");
  const config = writerConfig(temp.workspace);
  config.dedupe.autoResolveArchive = true;
  config.dedupe.autoResolvePendingDays = 1;
  config.dedupe.autoThreshold = 0.99;
  config.dedupe.reviewThreshold = 0.1;
  const winnerId = "maintenance-auto-winner";
  const loserId = "maintenance-auto-loser";
  const db = openDb(temp.dbPath);
  seedMemoryCurrent(db, [
    projectionMemory(winnerId, "The user prefers concise reviewed answers for board updates.", {
      confidence: 0.99, type: "PREFERENCE", value_label: "core", value_score: 0.99,
    }),
    projectionMemory(loserId, "The user prefers concise reviewed answers for board update summaries.", {
      confidence: 0.9, type: "PREFERENCE", value_label: "core", value_score: 0.8,
    }),
  ]);
  clearEvents(db);
  db.close();
  const queuePath = config.runtime.paths.reviewQueuePath;
  mkdirSync(path.dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, `${JSON.stringify({
    id: "maintenance-auto-queue-row",
    loser_memory_id: loserId,
    matched_memory_id: winnerId,
    memory_id: loserId,
    queued_at: "2000-01-01T00:00:00.000Z",
    reason_code: "duplicate_semantic",
    status: "pending",
    winner_memory_id: winnerId,
  })}\n`, { mode: 0o600 });
  const args = {
    config,
    dbPath: temp.dbPath,
    dryRun: false,
    reviewVersion: "rv-task11-maintenance-auto",
    runId: "task11-maintenance-auto-first-fresh-run-id",
  };
  try {
    let failCompletion = true;
    assert.throws(() => runMaintenance({
      ...args,
      completionFaultInjector: (stage) => {
        if (stage === "before_auto_resolve_queue_completion" && failCompletion) {
          failCompletion = false;
          throw new Error("auto-resolve external completion failure");
        }
      },
    }), /auto-resolve external completion failure/);
    const committed = openDb(temp.dbPath);
    let rowBefore;
    try {
      rowBefore = committed.prepare("SELECT status, updated_at, last_reviewed_at FROM memory_current WHERE memory_id=?").get(loserId);
      assert.equal(rowBefore.status, "archived");
      const events = rowEvents(committed, loserId);
      assert.deepEqual(events.map((row) => row.action), ["auto_resolve_dedupe"]);
      assert.match(String(events[0].payload.completion_id || ""), /auto_resolve_dedupe/);
      assert.equal(JSON.parse(readFileSync(queuePath, "utf8")).status, "pending");
    } finally {
      committed.close();
    }

    runMaintenance({ ...args, runId: "task11-maintenance-auto-retry-new-timestamped-run-id" });
    const retried = openDb(temp.dbPath);
    try {
      assert.deepEqual(
        { ...retried.prepare("SELECT status, updated_at, last_reviewed_at FROM memory_current WHERE memory_id=?").get(loserId) },
        { ...rowBefore },
      );
      assert.equal(rowEvents(retried, loserId).length, 1);
      const completedQueue = readFileSync(queuePath, "utf8").trim();
      assert.equal(
        completedQueue === "" || JSON.parse(completedQueue).status === "resolved_auto",
        true,
        "auto-resolve retry must complete or retention-prune the resolved queue row",
      );
    } finally {
      retried.close();
    }
  } finally {
    rmSync(temp.root, { force: true, recursive: true });
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

  const completion = queueReviewFixture("completion");
  try {
    let reviewerCalls = 0;
    const originalReviewer = async () => {
      reviewerCalls += 1;
      return { confidence: 0.96, decision: "archive_loser", reason: "original reviewed duplicate" };
    };
    let failCompletion = true;
    await assert.rejects(() => reviewQueuedCandidates({
      clock: () => Date.parse("2026-08-26T12:00:00.000Z"),
      completionFaultInjector: (stage) => {
        if (stage === "before_queue_completion" && failCompletion) {
          failCompletion = false;
          throw new Error("queue external completion failure");
        }
      },
      config: completion.config,
      db: completion.db,
      reviewer: originalReviewer,
      runId: "task11-queue-completion-first",
    }), /queue external completion failure/);
    const committed = completion.db.prepare("SELECT status, superseded_by, updated_at, last_reviewed_at FROM memory_current WHERE memory_id=?").get(completion.loserId);
    assert.equal(committed.status, "archived");
    const committedEvents = rowEvents(completion.db, completion.loserId);
    assert.equal(committedEvents.length, 1);
    const decisionReceipt = JSON.parse(completion.db.prepare(`
      SELECT payload FROM memory_events
      WHERE action='queue_review_decision_receipt'
      ORDER BY rowid DESC LIMIT 1
    `).get().payload);
    assert.deepEqual({
      decision: decisionReceipt.review_decision,
      loser_id: decisionReceipt.loser_id,
      queue_row_id: decisionReceipt.queue_row_id,
      reason: decisionReceipt.review_reason,
      result_status: decisionReceipt.result_status,
      winner_id: decisionReceipt.winner_id,
    }, {
      decision: "archive_loser",
      loser_id: completion.loserId,
      queue_row_id: "queue-row-completion",
      reason: "original reviewed duplicate",
      result_status: "archived",
      winner_id: completion.winnerId,
    }, "queue receipt must preserve the content-free committed decision");
    assert.equal(JSON.parse(readFileSync(completion.queuePath, "utf8")).status, "pending");

    const retried = await reviewQueuedCandidates({
      clock: () => Date.parse("2026-08-26T12:00:00.000Z"),
      config: completion.config,
      db: completion.db,
      reviewer: async () => {
        reviewerCalls += 1;
        return { confidence: 0.99, decision: "keep_both", reason: "changed model output must be ignored" };
      },
      runId: "task11-queue-completion-retry-with-fresh-run-id",
    });
    assert.equal(retried.mutatedRows, 1);
    assert.deepEqual(
      { ...completion.db.prepare("SELECT status, superseded_by, updated_at, last_reviewed_at FROM memory_current WHERE memory_id=?").get(completion.loserId) },
      { ...committed },
      "queue completion retry must not reapply the DB mutation",
    );
    assert.equal(rowEvents(completion.db, completion.loserId).length, 1);
    assert.equal(JSON.parse(readFileSync(completion.queuePath, "utf8")).status, "resolved_auto");
    assert.equal(reviewerCalls, 1, "queue retry must consult the receipt before any reviewer/model call");
  } finally {
    completion.db.close();
    rmSync(completion.temp.root, { force: true, recursive: true });
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

const countRows = (db, table) => {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return exists ? Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c || 0) : 0;
};

const assertBulkStoreEmpty = (db, label, { includeEvidence = false, includeHostState = false } = {}) => {
  const tables = ["memory_current", "memories", "memory_console_metadata", "memory_events", "memory_source_links"];
  if (includeEvidence) tables.push("memory_import_evidence");
  if (includeHostState) tables.push("memory_host_sync_cursor", "memory_host_sync_runs");
  for (const table of tables) assert.equal(countRows(db, table), 0, `${label}: ${table} must roll back`);
};

const openClawImportFixture = (label) => {
  const temp = makeTempWorkspace(`task11-openclaw-${label}-`);
  const registryPath = path.join(temp.root, "legacy-openclaw.sqlite");
  const source = openDatabase(registryPath);
  try {
    source.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        type TEXT,
        content TEXT,
        normalized TEXT,
        source TEXT,
        source_agent TEXT,
        source_session TEXT,
        source_message_id TEXT,
        confidence REAL,
        status TEXT,
        scope TEXT,
        tags TEXT,
        created_at TEXT,
        updated_at TEXT,
        last_injected_at TEXT,
        last_confirmed_at TEXT,
        ttl_days INTEGER,
        pinned INTEGER,
        superseded_by TEXT,
        concept TEXT,
        value_score REAL,
        value_label TEXT,
        review_version TEXT,
        review_reason TEXT,
        archived_at TEXT,
        last_reviewed_at TEXT
      );
      CREATE TABLE evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        text_snippet TEXT NOT NULL,
        created_at TEXT
      );
    `);
    const insert = source.prepare(`
      INSERT INTO memories (
        id, type, content, normalized, source, source_agent, source_session,
        source_message_id, confidence, status, scope, tags, created_at, updated_at,
        last_injected_at, last_confirmed_at, ttl_days, pinned, superseded_by,
        concept, value_score, value_label, review_version, review_reason,
        archived_at, last_reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const index of [1, 2]) {
      const memoryId = `openclaw-b1-${index}`;
      insert.run(
        memoryId,
        index === 1 ? "USER_FACT" : "DECISION",
        `OpenClaw B1 imported memory ${index} keeps every legacy-only field.`,
        "",
        "openclaw",
        "main",
        `session-${index}`,
        `message-${index}`,
        0.8 + (index / 100),
        "active",
        "profile:main",
        JSON.stringify([`legacy-${index}`]),
        `2026-08-2${index}T10:00:00.000Z`,
        `2026-08-2${index}T11:00:00.000Z`,
        `2026-08-2${index}T12:00:00.000Z`,
        `2026-08-2${index}T13:00:00.000Z`,
        30 + index,
        index % 2,
        null,
        `concept-${index}`,
        0.9,
        "keep",
        `review-v${index}`,
        `review-reason-${index}`,
        null,
        `2026-08-2${index}T14:00:00.000Z`,
      );
      source.prepare("INSERT INTO evidence (memory_id, text_snippet, created_at) VALUES (?, ?, ?)").run(
        memoryId,
        `Evidence ${index}`,
        `2026-08-2${index}T15:00:00.000Z`,
      );
    }
  } finally {
    source.close();
  }
  return { db: openDb(temp.dbPath), registryPath, temp };
};

const invokeOpenClawImport = (fixture, options = {}) => importOpenClawRegistry({
  db: fixture.db,
  operationId: "task11-openclaw-stable-operation",
  registryPath: fixture.registryPath,
  sourceHost: "openclaw",
  sourceLabel: "task11-b1",
  ...options,
});

const assertOpenClawImportWriter = () => {
  const success = openClawImportFixture("success");
  try {
    const result = invokeOpenClawImport(success);
    assert.equal(result.imported_count, 2);
    assert.equal(result.evidence_imported_count, 2);
    for (const index of [1, 2]) {
      const memoryId = `openclaw-b1-${index}`;
      const events = rowEvents(success.db, memoryId);
      assert.deepEqual(events.map((row) => row.action), ["openclaw_import_upsert"]);
      assert.equal(events[0].payload.operation_id, "task11-openclaw-stable-operation");
      const metadata = success.db.prepare(`
        SELECT concept, source_message_id, last_injected_at, last_confirmed_at,
               ttl_days, pinned, review_version, review_reason
        FROM memory_console_metadata WHERE memory_id = ?
      `).get(memoryId);
      assert.deepEqual({ ...metadata }, {
        concept: `concept-${index}`,
        source_message_id: `message-${index}`,
        last_injected_at: `2026-08-2${index}T12:00:00.000Z`,
        last_confirmed_at: `2026-08-2${index}T13:00:00.000Z`,
        ttl_days: 30 + index,
        pinned: index % 2,
        review_version: `review-v${index}`,
        review_reason: `review-reason-${index}`,
      });
      const legacy = success.db.prepare(`
        SELECT concept, source_message_id, last_injected_at, last_confirmed_at,
               ttl_days, pinned, review_version, review_reason
        FROM memories WHERE id = ?
      `).get(memoryId);
      assert.deepEqual({ ...legacy }, { ...metadata }, "legacy and sidecar metadata must match exactly");
    }
    assert.equal(countRows(success.db, "memory_source_links"), 2);
    assert.equal(countRows(success.db, "memory_import_evidence"), 2);
    assert.equal(countRows(success.db, "memory_host_sync_runs"), 1);
    invokeOpenClawImport(success);
    assert.equal(countRows(success.db, "memory_host_sync_runs"), 1, "same import operation must reuse its receipt");
    assert.equal(countEvents(success.db), 2, "idempotent re-import must not append generic or duplicate row events");
  } finally {
    success.db.close();
    rmSync(success.temp.root, { force: true, recursive: true });
  }

  const unicode = openClawImportFixture("unicode-canonical-dedupe");
  try {
    const content = "Grüße 東京 — Café １２３";
    const source = openDatabase(unicode.registryPath);
    try {
      source.prepare("DELETE FROM memories WHERE id = ?").run("openclaw-b1-2");
      source.prepare("DELETE FROM evidence").run();
      source.prepare(`
        UPDATE memories
        SET id = ?, content = ?, normalized = ?, scope = ?, concept = ?,
            source_message_id = ?, review_version = ?, review_reason = ?
        WHERE id = ?
      `).run(
        "legacy-unicode-source",
        content,
        "grusse tokyo cafe 123",
        "profile:main",
        "unicode-concept",
        "unicode-message",
        "unicode-review-v1",
        "unicode-review-reason",
        "openclaw-b1-1",
      );
    } finally {
      source.close();
    }
    upsertCurrentMemory(unicode.db, projectionMemory("unicode-canonical-target", content, {
      scope: "profile:main",
    }), { operationId: "unicode-canonical-seed" });
    clearEvents(unicode.db);

    const result = invokeOpenClawImport(unicode, { operationId: "unicode-canonical-import" });
    assert.equal(result.imported_count, 0);
    assert.equal(result.updated_count, 1);
    assert.equal(result.duplicate_count, 1);
    assert.equal(countRows(unicode.db, "memory_current"), 1, "legacy normalized text must not create a Unicode duplicate");
    const current = unicode.db.prepare("SELECT memory_id, normalized FROM memory_current").get();
    assert.deepEqual({ ...current }, {
      memory_id: "unicode-canonical-target",
      normalized: normalizeContent(content),
    });
    assert.deepEqual({ ...unicode.db.prepare(`
      SELECT concept, source_message_id, review_version, review_reason
      FROM memory_console_metadata WHERE memory_id = ?
    `).get("unicode-canonical-target") }, {
      concept: "unicode-concept",
      source_message_id: "unicode-message",
      review_version: "unicode-review-v1",
      review_reason: "unicode-review-reason",
    });
    assert.deepEqual(rowEvents(unicode.db, "unicode-canonical-target").map((row) => row.action), ["openclaw_import_upsert"]);
    assert.equal(unicode.db.prepare("SELECT memory_id FROM memory_source_links").get()?.memory_id, "unicode-canonical-target");
  } finally {
    unicode.db.close();
    rmSync(unicode.temp.root, { force: true, recursive: true });
  }

  for (const stage of ["after_current", "after_legacy", "after_metadata", "after_fts", "after_event", "after_source_link", "after_evidence"]) {
    const failed = openClawImportFixture(`failure-${stage}`);
    try {
      let observedCount = 0;
      assert.throws(() => invokeOpenClawImport(failed, {
        faultInjector: (observed) => {
          if (observed === stage && ++observedCount === 2) throw new Error(`openclaw synthetic ${stage}`);
        },
      }), new RegExp(`openclaw synthetic ${stage}`));
      assertBulkStoreEmpty(failed.db, `OpenClaw ${stage}`, { includeEvidence: true, includeHostState: true });
    } finally {
      failed.db.close();
      rmSync(failed.temp.root, { force: true, recursive: true });
    }
  }

  const nested = openClawImportFixture("caller-owned");
  try {
    nested.db.exec("BEGIN IMMEDIATE");
    const result = invokeOpenClawImport(nested);
    assert.equal(result.imported_count, 2);
    assert.equal(nested.db.isTransaction, true, "OpenClaw import must release only its caller savepoint");
    nested.db.exec("ROLLBACK");
    assertBulkStoreEmpty(nested.db, "OpenClaw caller rollback", { includeEvidence: true, includeHostState: true });
  } finally {
    if (nested.db.isTransaction) nested.db.exec("ROLLBACK");
    nested.db.close();
    rmSync(nested.temp.root, { force: true, recursive: true });
  }
};

const passportBundleFixture = (label) => {
  const temp = makeTempWorkspace(`task11-handoff-${label}-`);
  const memories = [1, 2].map((index) => projectionMemory(
    `handoff-b1-${index}`,
    `Handoff B1 imported memory ${index} remains projection-atomic.`,
    {
      source: "handoff_source",
      source_agent: "codex",
      source_host: "codex",
      source_kind: "native_memory",
      source_layer: "host_memory",
      source_path: `/synthetic/handoff-${index}.md`,
      source_line: index,
      sync_policy: "read_only",
    },
  ));
  const bundle = {
    kind: BUNDLE_KIND,
    schema_version: SCHEMA_VERSION,
    generated_at: "2026-08-26T16:00:00.000Z",
    manifest: {
      content_hash: computeContentHash(memories),
      memory_count: memories.length,
    },
    memories,
    source_links: memories.map((memory) => ({
      content_hash: memory.memory_id,
      memory_id: memory.memory_id,
      source_host: "codex",
      source_kind: "native_memory",
      source_line: memory.source_line,
      source_path: memory.source_path,
      sync_policy: "read_only",
    })),
    events: null,
  };
  return { bundle, db: openDb(temp.dbPath), temp };
};

const invokeHandoffImport = (fixture, options = {}) => importPassportBundle({
  bundle: fixture.bundle,
  db: fixture.db,
  runId: "task11-handoff-stable-operation",
  ...options,
});

const assertHandoffImportWriter = () => {
  const success = passportBundleFixture("success");
  try {
    const result = invokeHandoffImport(success);
    assert.equal(result.imported_memories, 2);
    assert.equal(result.imported_source_links, 2);
    assert.equal(result.imported_events, 2);
    for (const index of [1, 2]) {
      const memoryId = `handoff-b1-${index}`;
      const current = success.db.prepare("SELECT content, status, source_host, source_path FROM memory_current WHERE memory_id=?").get(memoryId);
      const legacy = success.db.prepare("SELECT content, status, source_host, source_path FROM memories WHERE id=?").get(memoryId);
      assert.deepEqual({ ...legacy }, { ...current });
      const events = rowEvents(success.db, memoryId);
      assert.deepEqual(events.map((row) => row.action), ["handoff_import"]);
      assert.equal(events[0].payload.operation_id, "task11-handoff-stable-operation");
    }
  } finally {
    success.db.close();
    rmSync(success.temp.root, { force: true, recursive: true });
  }

  for (const stage of ["after_current", "after_legacy", "after_fts", "after_event", "after_source_link"]) {
    const failed = passportBundleFixture(`failure-${stage}`);
    try {
      let observedCount = 0;
      assert.throws(() => invokeHandoffImport(failed, {
        faultInjector: (observed) => {
          if (observed === stage && ++observedCount === 2) throw new Error(`handoff synthetic ${stage}`);
        },
      }), new RegExp(`handoff synthetic ${stage}`));
      assertBulkStoreEmpty(failed.db, `Handoff ${stage}`);
    } finally {
      failed.db.close();
      rmSync(failed.temp.root, { force: true, recursive: true });
    }
  }

  const nested = passportBundleFixture("caller-owned");
  try {
    nested.db.exec("BEGIN IMMEDIATE");
    const result = invokeHandoffImport(nested);
    assert.equal(result.imported_memories, 2);
    assert.equal(nested.db.isTransaction, true, "handoff import must release only its caller savepoint");
    nested.db.exec("ROLLBACK");
    assertBulkStoreEmpty(nested.db, "Handoff caller rollback");
  } finally {
    if (nested.db.isTransaction) nested.db.exec("ROLLBACK");
    nested.db.close();
    rmSync(nested.temp.root, { force: true, recursive: true });
  }
};

const hostSyncFixture = (label) => {
  const temp = makeTempWorkspace(`task11-host-${label}-`);
  const codexHome = path.join(temp.root, "codex-home");
  const memoryPath = path.join(codexHome, "memories", "facts.md");
  mkdirSync(path.dirname(memoryPath), { recursive: true });
  writeFileSync(memoryPath, [
    "- Host B1 first source row is transactionally projected.",
    "- Host B1 second source row is transactionally projected.",
    "",
  ].join("\n"), "utf8");
  const config = {
    codex: { projectRoot: temp.workspace },
    hostSync: { autoNightly: true, autoOnSetup: true },
    runtime: { paths: { workspaceRoot: temp.workspace } },
  };
  return { codexHome, config, db: openDb(temp.dbPath), temp };
};

const invokeHostSync = (fixture, options = {}) => syncHostMemories({
  arbitrate: false,
  codexHome: fixture.codexHome,
  config: fixture.config,
  db: fixture.db,
  hosts: ["codex"],
  incremental: true,
  scope: "profile:main",
  ...options,
});

const assertHostSyncWriter = () => {
  const success = hostSyncFixture("success");
  try {
    const result = invokeHostSync(success);
    assert.equal(result.ok, true);
    assert.equal(result.inserted_count, 2);
    assert.equal(countRows(success.db, "memory_source_links"), 2);
    assert.equal(countRows(success.db, "memory_host_sync_cursor"), 1);
    assert.equal(countRows(success.db, "memory_host_sync_runs"), 1);
    const ids = success.db.prepare("SELECT memory_id FROM memory_current ORDER BY memory_id").all().map((row) => row.memory_id);
    assert.equal(ids.length, 2);
    for (const memoryId of ids) {
      const events = rowEvents(success.db, memoryId);
      assert.deepEqual(events.map((row) => row.action), ["host_sync_inserted"]);
      const current = success.db.prepare("SELECT content, status, source_host, source_path FROM memory_current WHERE memory_id=?").get(memoryId);
      const legacy = success.db.prepare("SELECT content, status, source_host, source_path FROM memories WHERE id=?").get(memoryId);
      assert.deepEqual({ ...legacy }, { ...current });
    }
    const retry = invokeHostSync(success);
    assert.equal(retry.unchanged_sources, 1);
    assert.equal(countEvents(success.db), 2);
    assert.equal(countRows(success.db, "memory_host_sync_runs"), 1);
  } finally {
    success.db.close();
    rmSync(success.temp.root, { force: true, recursive: true });
  }

  for (const stage of ["after_current", "after_legacy", "after_fts", "after_event", "after_source_link", "after_cursor", "after_sync_run"]) {
    const failed = hostSyncFixture(`failure-${stage}`);
    try {
      let observedCount = 0;
      const nth = stage === "after_cursor" || stage === "after_sync_run" ? 1 : 2;
      const result = invokeHostSync(failed, {
        faultInjector: (observed) => {
          if (observed === stage && ++observedCount === nth) throw new Error(`host synthetic ${stage}`);
        },
      });
      assert.equal(result.ok, false, `host ${stage} must fail its source boundary`);
      assert.equal(result.inserted_count, 0, `host ${stage} must not report rolled-back inserts`);
      assert.equal(result.indexed_count, 0, `host ${stage} must not report rolled-back completion`);
      assert.equal(result.touched_memory_ids.length, 0, `host ${stage} must not arbitrate rolled-back rows`);
      assert.equal(result.sources[0].status, "error");
      assertBulkStoreEmpty(failed.db, `Host ${stage}`, { includeHostState: true });
      const failedOperationId = result.runs[0].run_id;

      const retried = invokeHostSync(failed);
      assert.equal(retried.ok, true);
      assert.equal(retried.inserted_count, 2);
      assert.equal(retried.runs[0].run_id, failedOperationId, "source retry must reuse its stable operation id");
      assert.equal(countEvents(failed.db), 2);
      assert.equal(countRows(failed.db, "memory_host_sync_runs"), 1);
    } finally {
      failed.db.close();
      rmSync(failed.temp.root, { force: true, recursive: true });
    }
  }

  for (const mode of ["automatic", "cloud"]) {
    const db = openDatabase(":memory:");
    try {
      if (mode === "automatic") {
        const result = syncHostMemories({
          automaticTrigger: "nightly",
          config: { hostSync: { autoNightly: false } },
          db,
        });
        assert.equal(result.automatic_disabled, true);
      } else {
        const result = scanCloudInbox({ db, config: { native: { cloudInbox: { enabled: false } } } });
        assert.equal(result.enabled, false);
      }
      assert.equal(
        Number(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get().c),
        0,
        `${mode} disabled mode must not initialize a store`,
      );
    } finally {
      db.close();
    }
  }
};

const assertCloudInboxWriter = () => {
  const temp = makeTempWorkspace("task11-cloud-b1-");
  const db = openDb(temp.dbPath);
  const inbox = path.join(temp.root, "cloud-inbox", "chatgpt");
  mkdirSync(inbox, { recursive: true });
  const firstPath = path.join(inbox, "a.json");
  const secondPath = path.join(inbox, "b.json");
  writeFileSync(firstPath, JSON.stringify({ conversations: [{ messages: [{ role: "user", content: "Cloud B1 first source remains isolated on failure." }] }] }), "utf8");
  writeFileSync(secondPath, JSON.stringify({ conversations: [{ messages: [{ role: "user", content: "Cloud B1 second source commits independently." }] }] }), "utf8");
  const config = { native: { cloudInbox: { dir: path.dirname(inbox), enabled: true } } };
  try {
    const first = scanCloudInbox({
      config,
      db,
      faultInjector: (stage, context = {}) => {
        if (stage === "after_event" && context.source_path === firstPath) throw new Error("cloud first source failure");
      },
      incremental: true,
      scope: "profile:main",
    });
    assert.equal(first.ok, false);
    const failedSource = first.sources.find((row) => row.source_path === firstPath);
    const committedSource = first.sources.find((row) => row.source_path === secondPath);
    assert.equal(failedSource.status, "error");
    assert.equal(committedSource.status, "scanned");
    assert.equal(countRows(db, "memory_current"), 1, "cloud source failure must not roll back a different source");
    assert.equal(countRows(db, "memory_source_links"), 1);
    assert.equal(countRows(db, "memory_host_sync_cursor"), 1);
    assert.equal(countRows(db, "memory_cloud_inbox_state"), 1);
    assert.equal(countEvents(db), 1);
    assert.equal(db.prepare("SELECT content FROM memory_current").get().content.includes("second source"), true);

    const retry = scanCloudInbox({ config, db, incremental: true, scope: "profile:main" });
    const retriedSource = retry.sources.find((row) => row.source_path === firstPath);
    assert.equal(retriedSource.operation_id, failedSource.operation_id, "cloud retry must reuse its stable operation id");
    assert.equal(countRows(db, "memory_current"), 2);
    assert.equal(countRows(db, "memory_source_links"), 2);
    assert.equal(countRows(db, "memory_host_sync_cursor"), 2);
    assert.equal(countRows(db, "memory_cloud_inbox_state"), 2);
    assert.equal(countEvents(db), 2);
    const actions = db.prepare("SELECT action FROM memory_events ORDER BY rowid").all().map((row) => row.action);
    assert.deepEqual(actions, ["cloud_inbox_inserted", "cloud_inbox_inserted"]);
  } finally {
    db.close();
    rmSync(temp.root, { force: true, recursive: true });
  }
};

const assertMalformedCloudInboxSourceIsolation = () => {
  const temp = makeTempWorkspace("task11-cloud-malformed-source-");
  const db = openDb(temp.dbPath);
  const inbox = path.join(temp.root, "cloud-inbox", "chatgpt");
  mkdirSync(inbox, { recursive: true });
  const malformedPath = path.join(inbox, "a-malformed.json");
  const validPath = path.join(inbox, "b-valid.json");
  writeFileSync(malformedPath, '{"conversations":[', "utf8");
  writeFileSync(validPath, JSON.stringify({
    conversations: [{
      messages: [{ role: "user", content: "Cloud B1 valid source commits after a malformed independent export." }],
    }],
  }), "utf8");
  const config = { native: { cloudInbox: { dir: path.dirname(inbox), enabled: true } } };
  try {
    const first = scanCloudInbox({ config, db, incremental: true, scope: "profile:main" });
    const malformed = first.sources.find((row) => row.source_path === malformedPath);
    const valid = first.sources.find((row) => row.source_path === validPath);
    assert.equal(first.ok, false, "one malformed source must be reported without aborting the directory scan");
    assert.equal(malformed.status, "error");
    assert.match(malformed.error, /json|parse/i);
    assert.equal(valid.status, "scanned");
    assert.equal(countRows(db, "memory_current"), 1);
    assert.equal(countRows(db, "memory_source_links"), 1);
    assert.equal(countRows(db, "memory_host_sync_cursor"), 1);
    assert.equal(countRows(db, "memory_cloud_inbox_state"), 1);
    assert.equal(countRows(db, "memory_host_sync_runs"), 1);
    assert.equal(countEvents(db), 1);
    assert.equal(db.prepare("SELECT content FROM memory_current").get().content.includes("valid source"), true);
    assert.equal(db.prepare("SELECT source_path FROM memory_host_sync_cursor").get().source_path, validPath);
    assert.equal(db.prepare("SELECT source_path FROM memory_host_sync_runs").get().source_path, validPath);

    const retry = scanCloudInbox({ config, db, incremental: true, scope: "profile:main" });
    assert.equal(retry.sources.find((row) => row.source_path === malformedPath).status, "error");
    assert.equal(retry.sources.find((row) => row.source_path === validPath).status, "unchanged");
    assert.equal(countRows(db, "memory_current"), 1);
    assert.equal(countRows(db, "memory_source_links"), 1);
    assert.equal(countRows(db, "memory_host_sync_cursor"), 1);
    assert.equal(countRows(db, "memory_cloud_inbox_state"), 1);
    assert.equal(countRows(db, "memory_host_sync_runs"), 1);
    assert.equal(countEvents(db), 1, "valid source retry must not duplicate its row event");
    assert.deepEqual(
      db.prepare("SELECT action FROM memory_events").all().map((row) => row.action),
      ["cloud_inbox_inserted"],
    );
  } finally {
    db.close();
    rmSync(temp.root, { force: true, recursive: true });
  }
};

export const runTask11WriterB1 = () => {
  assertOpenClawImportWriter();
  assertHandoffImportWriter();
  assertHostSyncWriter();
  assertCloudInboxWriter();
  assertMalformedCloudInboxSourceIsolation();
};

const beliefIntentFixture = (label) => {
  const temp = makeTempWorkspace(`task11-belief-b2-${label}-`);
  const db = openDb(temp.dbPath);
  const specs = [
    ["belief-location-winner", "Alex lives in London.", "human_wiki", "person:alex", "person.location", "London"],
    ["belief-location-loser", "Alex lives in Paris.", "transcript", "person:alex", "person.location", "Paris"],
    ["belief-port-winner", "The API listens on port 443.", "human_wiki", "service:api", "service.port", "443"],
    ["belief-port-loser", "The API listens on port 80.", "transcript", "service:api", "service.port", "80"],
  ];
  for (const [memoryId, content, sourceHost] of specs) {
    const sourceKind = sourceHost === "transcript" ? "chat_history_hint" : "human_edit";
    upsertCurrentMemory(db, projectionMemory(memoryId, content, {
      source_agent: sourceHost,
      source_host: sourceHost,
      source_kind: sourceKind,
      source_layer: "host_memory",
    }));
  }
  clearEvents(db);
  const rows = specs.map(([memoryId, content, sourceHost, entityId, slot, value], index) => ({
    belief_id: `belief-row-${index + 1}`,
    confidence: sourceHost === "human_wiki" ? 0.99 : 0.3,
    content,
    created_at: `2026-08-26T1${index}:00:00.000Z`,
    entity_id: entityId,
    payload: { claim_slot: slot, claim_value: value, scope: "shared" },
    source_agent: sourceHost,
    source_host: sourceHost,
    source_kind: sourceHost === "transcript" ? "chat_history_hint" : "human_edit",
    source_memory_id: memoryId,
    type: "USER_FACT",
  }));
  return { db, rows, temp };
};

const assertBeliefArbitrationWriter = () => {
  const success = beliefIntentFixture("success");
  try {
    const result = consolidateBeliefRows(success.rows, {
      db: success.db,
      operationId: "task11-belief-two-intents",
      settings: resolveArbiterSettings({}),
    });
    assert.equal(result.verdicts.length, 2, "two independent intent groups must resolve");
    for (const [loser, winner] of [
      ["belief-location-loser", "belief-location-winner"],
      ["belief-port-loser", "belief-port-winner"],
    ]) {
      assertCurrentLegacyStatus(success.db, loser, { status: "superseded", superseded_by: winner });
      const events = rowEvents(success.db, loser).filter((row) => row.payload.projection_event_kind === "row");
      assert.deepEqual(events.map((row) => row.action), ["arbiter:supersede"]);
      assert.equal(events[0].payload.operation_id, "task11-belief-two-intents");
    }
  } finally {
    success.db.close();
    rmSync(success.temp.root, { force: true, recursive: true });
  }

  for (const boundary of ["top", "caller-owned"]) {
    const failed = beliefIntentFixture(`failure-${boundary}`);
    try {
      if (boundary === "caller-owned") failed.db.exec("BEGIN IMMEDIATE");
      let eventsSeen = 0;
      assert.throws(() => consolidateBeliefRows(failed.rows, {
        db: failed.db,
        faultInjector: (stage) => {
          if (stage === "after_event" && ++eventsSeen === 4) throw new Error(`belief ${boundary} nth event failure`);
        },
        operationId: `task11-belief-${boundary}`,
        settings: resolveArbiterSettings({}),
      }), new RegExp(`belief ${boundary} nth event failure`));
      assertCurrentLegacyStatus(failed.db, "belief-location-loser", { status: "active", superseded_by: null });
      assertCurrentLegacyStatus(failed.db, "belief-port-loser", { status: "active", superseded_by: null });
      assert.equal(countEvents(failed.db), 0, "Nth verdict fault must roll back every intent and event");
      if (boundary === "caller-owned") assert.equal(failed.db.isTransaction, true);
    } finally {
      if (failed.db.isTransaction) failed.db.exec("ROLLBACK");
      failed.db.close();
      rmSync(failed.temp.root, { force: true, recursive: true });
    }
  }
};

const controlPlaneDecisionFixture = (label) => {
  const temp = makeTempWorkspace(`task11-control-b2-${label}-`);
  const db = openDb(temp.dbPath);
  const proposal = appendClaimProposal(db, {
    claimType: "DECISION",
    content: `Control-plane B2 proposal ${label} remains append-only and atomic.`,
    evidenceClass: "project_decision",
    evidenceRefs: [`fixture:${label}`],
    proposalId: `control-proposal-${label}`,
    scope: "project:task11",
    sourceAgent: "codex",
    sourceHost: "codex",
  });
  return { db, proposal, temp };
};

const assertControlPlaneWriter = () => {
  const success = controlPlaneDecisionFixture("success");
  try {
    const decision = appendClaimDecision(success.db, {
      action: "accepted",
      actorHost: "codex",
      actorId: "owner",
      allowedScopes: ["project:task11"],
      memoryId: "control-memory-success",
      operationId: "task11-control-decision-stable",
      proposalId: success.proposal.proposal_id,
      reason: "Reviewed control-plane decision.",
    });
    assert.equal(decision.action, "accepted");
    const event = success.db.prepare(`
      SELECT payload FROM memory_claim_proposal_events
      WHERE proposal_id=? AND action='accepted'
    `).get(success.proposal.proposal_id);
    assert.equal(JSON.parse(event.payload).operation_id, "task11-control-decision-stable");
  } finally {
    success.db.close();
    rmSync(success.temp.root, { force: true, recursive: true });
  }

  for (const boundary of ["top", "caller-owned"]) {
    const failed = controlPlaneDecisionFixture(`failure-${boundary}`);
    try {
      const before = {
        events: countRows(failed.db, "memory_claim_proposal_events"),
        receipts: countRows(failed.db, "memory_receipts"),
      };
      if (boundary === "caller-owned") failed.db.exec("BEGIN IMMEDIATE");
      assert.throws(() => appendClaimDecision(failed.db, {
        action: "accepted",
        actorHost: "codex",
        actorId: "owner",
        allowedScopes: ["project:task11"],
        faultInjector: (stage) => {
          if (stage === "after_claim_decision") throw new Error(`control ${boundary} decision failure`);
        },
        memoryId: `control-memory-${boundary}`,
        operationId: `task11-control-${boundary}`,
        proposalId: failed.proposal.proposal_id,
        reason: "Synthetic terminal fault.",
      }), new RegExp(`control ${boundary} decision failure`));
      assert.equal(getClaimProposal(failed.db, failed.proposal.proposal_id).status, "proposed");
      assert.deepEqual({
        events: countRows(failed.db, "memory_claim_proposal_events"),
        receipts: countRows(failed.db, "memory_receipts"),
      }, before);
      if (boundary === "caller-owned") assert.equal(failed.db.isTransaction, true);
    } finally {
      if (failed.db.isTransaction) failed.db.exec("ROLLBACK");
      failed.db.close();
      rmSync(failed.temp.root, { force: true, recursive: true });
    }
  }

  const restricted = openDatabase(":memory:");
  try {
    assert.throws(() => appendClaimProposal(restricted, {
      claimType: "CONTEXT",
      content: "Restricted proposal must initialize no tables.",
      evidenceClass: "agent_inference",
      scope: "project:task11",
      sourceAgent: "codex",
      sourceHost: "codex",
      writeMode: "native_only",
    }), /write|mode|blocked/i);
    assert.equal(Number(restricted.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get().c), 0);
  } finally {
    restricted.close();
  }
};

const codexClaimFixture = (label) => {
  const temp = makeTempWorkspace(`task11-codex-b2-${label}-`);
  const config = writerConfig(temp.workspace);
  config.dedupe.semanticEnabled = false;
  const scope = "project:task11";
  const common = {
    allowedScopes: [scope],
    config,
    scope,
    workspaceRoot: temp.workspace,
  };
  const proposed = runClaimPropose({
    ...common,
    claimType: "DECISION",
    content: `Codex B2 accepted claim ${label} must commit with its terminal proposal decision.`,
    evidenceClass: "project_decision",
    evidenceRefs: [`fixture:${label}`],
    sourceAgent: "codex",
    sourceHost: "codex",
  });
  return { common, config, proposed, scope, temp };
};

const assertCodexClaimWriter = () => {
  for (const stage of ["after_event", "after_claim_decision"]) {
    const fixture = codexClaimFixture(stage);
    const proposalId = fixture.proposed.proposal.proposal_id;
    const decide = (faultInjector = null) => runClaimDecide({
      ...fixture.common,
      action: "accepted",
      actorHost: "codex",
      actorId: "reviewer",
      authorization: { authority: "reviewer", memoryScopes: [fixture.scope] },
      faultInjector,
      operationId: `task11-codex-${stage}`,
      proposalId,
      reason: "Reviewed against the B2 transaction contract.",
    });
    try {
      assert.throws(() => decide((observed) => {
        if (observed === stage) throw new Error(`codex synthetic ${stage}`);
      }), new RegExp(`codex synthetic ${stage}`));
      const db = openDatabase(fixture.config.runtime.paths.registryPath);
      try {
        assert.equal(getClaimProposal(db, proposalId).status, "proposed", `${stage} must leave proposal open`);
        assert.equal(
          Number(db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content LIKE '%Codex B2 accepted claim%'").get().c),
          0,
          `${stage} must roll back accepted memory`,
        );
        assert.equal(countEvents(db), 0, `${stage} must roll back the memory row event`);
      } finally {
        db.close();
      }

      const accepted = decide();
      assert.equal(accepted.action, "accepted");
      assert.equal(accepted.memory.recallable, true);
      const verified = openDatabase(fixture.config.runtime.paths.registryPath);
      try {
        assert.equal(getClaimProposal(verified, proposalId).status, "accepted");
        const memoryEvents = rowEvents(verified, accepted.memory_id)
          .filter((row) => row.payload.projection_event_kind === "row");
        assert.deepEqual(memoryEvents.map((row) => row.action), ["capture_inserted"]);
        assert.equal(memoryEvents[0].payload.operation_id, `task11-codex-${stage}`);
        const terminal = verified.prepare(`
          SELECT payload FROM memory_claim_proposal_events
          WHERE proposal_id=? AND action='accepted'
        `).get(proposalId);
        assert.equal(JSON.parse(terminal.payload).operation_id, `task11-codex-${stage}`);
      } finally {
        verified.close();
      }
    } finally {
      rmSync(fixture.temp.root, { force: true, recursive: true });
    }
  }
};

const transcriptFixture = (label, { conflict = false } = {}) => {
  const temp = makeTempWorkspace(`task11-transcript-b2-${label}-`);
  const rollout = path.join(temp.root, "home", ".codex", "sessions", label, "rollout.jsonl");
  mkdirSync(path.dirname(rollout), { recursive: true });
  writeFileSync(rollout, `${JSON.stringify({
    type: "message",
    role: "user",
    content: conflict
      ? "I live in Vienna now, actually."
      : `Transcript B2 source ${label} contains one durable synthetic preference.`,
  })}\n`, "utf8");
  const config = writerConfig(temp.workspace);
  config.llm.provider = "none";
  config.native.transcripts = {
    enabled: true,
    globs: [rollout],
    maxFiles: 5,
    maxTurns: 20,
  };
  const db = openDb(temp.dbPath);
  if (conflict) {
    upsertCurrentMemory(db, projectionMemory("transcript-deliberate-berlin", "I live in Berlin.", {
      confidence: 0.95,
      scope: "profile:main",
      source_agent: "codex",
      source_host: "codex",
      source_kind: "native_memory",
      source_layer: "host_memory",
    }));
    clearEvents(db);
  }
  const event = {
    __captureLlm: {
      extract: (text) => [{ content: String(text), confidence: 0.7, type: "USER_FACT" }],
    },
  };
  return { config, db, event, rollout, temp };
};

const invokeTranscript = (fixture, options = {}) => harvestTranscripts({
  arbitrate: false,
  config: fixture.config,
  db: fixture.db,
  event: fixture.event,
  incremental: true,
  scope: "profile:main",
  ...options,
});

const assertTranscriptWriter = () => {
  const success = transcriptFixture("success");
  try {
    const result = invokeTranscript(success);
    assert.equal(result.ok, true);
    assert.equal(result.inserted_count, 1);
    assert.equal(countRows(success.db, "memory_source_links"), 1);
    assert.equal(countRows(success.db, "memory_transcript_sync_cursor"), 1);
    const current = success.db.prepare(`
      SELECT memory_id, content, status, source_host, source_kind, source_path
      FROM memory_current WHERE source_kind='chat_history_hint'
    `).get();
    const legacy = success.db.prepare(`
      SELECT id AS memory_id, content, status, source_host, source_kind, source_path
      FROM memories WHERE id=?
    `).get(current.memory_id);
    assert.deepEqual({ ...legacy }, { ...current });
    const events = rowEvents(success.db, current.memory_id)
      .filter((row) => row.payload.projection_event_kind === "row");
    assert.deepEqual(events.map((row) => row.action), ["transcript_harvest_inserted"]);
    assert.equal(events[0].payload.operation_id, result.sources[0].operation_id);
    const retry = invokeTranscript(success);
    assert.equal(retry.files_unchanged, 1);
    assert.equal(countEvents(success.db), 1);
  } finally {
    success.db.close();
    rmSync(success.temp.root, { force: true, recursive: true });
  }

  for (const [boundary, stage] of [["top", "after_cursor"], ["caller-owned", "after_event"]]) {
    const failed = transcriptFixture(`failure-${boundary}`);
    try {
      if (boundary === "caller-owned") failed.db.exec("BEGIN IMMEDIATE");
      const result = invokeTranscript(failed, {
        faultInjector: (observed) => {
          if (observed === stage) throw new Error(`transcript ${boundary} ${stage}`);
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.inserted_count, 0);
      assert.equal(result.facts_extracted, 0);
      assert.equal(result.sources[0].status, "error");
      assert.equal(countRows(failed.db, "memory_current"), 0);
      assert.equal(countRows(failed.db, "memories"), 0);
      assert.equal(countRows(failed.db, "memory_source_links"), 0);
      assert.equal(countRows(failed.db, "memory_transcript_sync_cursor"), 0);
      assert.equal(countEvents(failed.db), 0);
      if (boundary === "caller-owned") assert.equal(failed.db.isTransaction, true);
    } finally {
      if (failed.db.isTransaction) failed.db.exec("ROLLBACK");
      failed.db.close();
      rmSync(failed.temp.root, { force: true, recursive: true });
    }
  }

  const arbitration = transcriptFixture("arbitration-failure", { conflict: true });
  try {
    let eventWrites = 0;
    const failed = invokeTranscript(arbitration, {
      arbitrate: true,
      faultInjector: (stage) => {
        if (stage === "after_event" && ++eventWrites === 2) throw new Error("transcript arbitration event failure");
      },
      projectBeliefRows: projectArbitrationBeliefRows,
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.sources[0].status, "error");
    assertCurrentLegacyStatus(arbitration.db, "transcript-deliberate-berlin", { status: "active", superseded_by: null });
    assert.equal(
      Number(arbitration.db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE source_kind='chat_history_hint'").get().c),
      0,
    );
    assert.equal(countRows(arbitration.db, "memory_source_links"), 0);
    assert.equal(countRows(arbitration.db, "memory_transcript_sync_cursor"), 0);
    assert.equal(countEvents(arbitration.db), 0);
  } finally {
    arbitration.db.close();
    rmSync(arbitration.temp.root, { force: true, recursive: true });
  }

  for (const mode of ["disabled", "restricted"]) {
    const fixture = transcriptFixture(`zero-${mode}`);
    fixture.db.close();
    const db = openDatabase(":memory:");
    let extractorCalls = 0;
    try {
      const config = {
        ...fixture.config,
        compat: { ...fixture.config.compat, writeMode: mode === "restricted" ? "native_only" : "full" },
        native: {
          ...fixture.config.native,
          transcripts: { ...fixture.config.native.transcripts, enabled: mode !== "disabled" },
        },
      };
      const invoke = () => harvestTranscripts({
        config,
        db,
        event: { __captureLlm: { extract: () => { extractorCalls += 1; return []; } } },
      });
      if (mode === "restricted") assert.throws(invoke, /write|mode|blocked/i);
      else assert.equal(invoke().skipped_reason, "disabled");
      assert.equal(extractorCalls, 0);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get().c), 0);
    } finally {
      db.close();
      rmSync(fixture.temp.root, { force: true, recursive: true });
    }
  }
};

const wikiHumanCommit = (dir, message) => {
  const env = {
    ...process.env,
    GIT_AUTHOR_EMAIL: "operator@example.test",
    GIT_AUTHOR_NAME: "Synthetic Operator",
    GIT_COMMITTER_EMAIL: "operator@example.test",
    GIT_COMMITTER_NAME: "Synthetic Operator",
  };
  execFileSync("git", ["-C", dir, "add", "-A"], { env, stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", message], { env, stdio: "ignore" });
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
};

const wikiReconcileFixture = (label) => {
  const temp = makeTempWorkspace(`task11-wiki-b2-${label}-`);
  const wikiDir = path.join(temp.root, "wiki");
  const config = writerConfig(temp.workspace);
  config.native.wiki = { enabled: true, dir: wikiDir };
  const db = openDb(temp.dbPath);
  const agentContent = `The ${label} service runs in Examplebury.`;
  const humanContent = `The ${label} service runs in Synthville.`;
  upsertCurrentMemory(db, projectionMemory(`wiki-agent-${label}`, agentContent, {
    source_agent: "codex",
    source_host: "codex",
    source_kind: "native_memory",
    source_layer: "host_memory",
  }));
  const projected = projectWiki({ db, config });
  const filePath = path.join(wikiDir, "entities", "shared.md");
  const body = readFileSync(filePath, "utf8").replace(`- ${agentContent}`, `- ${humanContent}`);
  writeFileSync(filePath, body, "utf8");
  const humanHead = wikiHumanCommit(wikiDir, `operator: correct ${label}`);
  clearEvents(db);
  return {
    agentId: `wiki-agent-${label}`,
    config,
    db,
    humanContent,
    humanHead,
    projected,
    statePath: path.join(wikiDir, STATE_FILE),
    temp,
    wikiDir,
  };
};

const assertWikiWriter = () => {
  for (const boundary of ["top", "caller-owned"]) {
    const failed = wikiReconcileFixture(`failure-${boundary}`);
    try {
      const stateBefore = readFileSync(failed.statePath, "utf8");
      if (boundary === "caller-owned") failed.db.exec("BEGIN IMMEDIATE");
      let rowEventsSeen = 0;
      assert.throws(() => reconcileWiki({
        config: failed.config,
        db: failed.db,
        faultInjector: (stage) => {
          if (stage === "after_event" && ++rowEventsSeen === 2) throw new Error(`wiki ${boundary} nth row event`);
        },
      }), new RegExp(`wiki ${boundary} nth row event`));
      assertCurrentLegacyStatus(failed.db, failed.agentId, { status: "active", superseded_by: null });
      assert.equal(
        Number(failed.db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE source_host=?").get(HUMAN_WIKI_HOST).c),
        0,
      );
      assert.equal(countEvents(failed.db), 0);
      assert.equal(countRows(failed.db, "memory_wiki_reconcile_receipts"), 0);
      assert.equal(readFileSync(failed.statePath, "utf8"), stateBefore);
      if (boundary === "caller-owned") assert.equal(failed.db.isTransaction, true);
    } finally {
      if (failed.db.isTransaction) failed.db.exec("ROLLBACK");
      failed.db.close();
      rmSync(failed.temp.root, { force: true, recursive: true });
    }
  }

  const completion = wikiReconcileFixture("completion-retry");
  try {
    const stateBefore = readFileSync(completion.statePath, "utf8");
    assert.throws(() => reconcileWiki({
      completionFaultInjector: (stage) => {
        if (stage === "before_wiki_state_completion") throw new Error("wiki external completion failure");
      },
      config: completion.config,
      db: completion.db,
    }), /wiki external completion failure/);
    const human = completion.db.prepare(`
      SELECT memory_id, content, status, updated_at FROM memory_current WHERE source_host=?
    `).get(HUMAN_WIKI_HOST);
    assert.equal(human.content, completion.humanContent);
    assert.equal(human.status, "active");
    assertCurrentLegacyStatus(completion.db, completion.agentId, { status: "superseded", superseded_by: human.memory_id });
    const humanEvents = rowEvents(completion.db, human.memory_id)
      .filter((row) => row.payload.projection_event_kind === "row");
    const agentEvents = rowEvents(completion.db, completion.agentId)
      .filter((row) => row.payload.projection_event_kind === "row");
    assert.deepEqual(humanEvents.map((row) => row.action), ["wiki_reconcile_ingested"]);
    assert.deepEqual(agentEvents.map((row) => row.action), ["wiki_reconcile_superseded"]);
    assert.equal(countRows(completion.db, "memory_wiki_reconcile_receipts"), 1);
    const receipt = completion.db.prepare("SELECT operation_id, head_sha FROM memory_wiki_reconcile_receipts").get();
    assert.equal(receipt.head_sha, completion.humanHead);
    assert.equal(humanEvents[0].payload.operation_id, receipt.operation_id);
    assert.equal(agentEvents[0].payload.operation_id, receipt.operation_id);
    assert.equal(readFileSync(completion.statePath, "utf8"), stateBefore, "failed external completion must leave file retryable");
    const beforeRetry = {
      events: countEvents(completion.db),
      humanUpdated: human.updated_at,
      receipts: countRows(completion.db, "memory_wiki_reconcile_receipts"),
    };

    const resumed = reconcileWiki({
      config: completion.config,
      db: completion.db,
      faultInjector: () => { throw new Error("wiki retry repeated DB decision"); },
    });
    assert.equal(resumed.resumed, true);
    assert.equal(JSON.parse(readFileSync(completion.statePath, "utf8")).generatedSha, completion.humanHead);
    const afterHuman = completion.db.prepare("SELECT updated_at FROM memory_current WHERE memory_id=?").get(human.memory_id);
    assert.deepEqual({
      events: countEvents(completion.db),
      humanUpdated: afterHuman.updated_at,
      receipts: countRows(completion.db, "memory_wiki_reconcile_receipts"),
    }, beforeRetry);
  } finally {
    completion.db.close();
    rmSync(completion.temp.root, { force: true, recursive: true });
  }

  for (const mode of ["disabled", "read-only"]) {
    const temp = makeTempWorkspace(`task11-wiki-zero-${mode}-`);
    const db = openDatabase(":memory:");
    const wikiDir = path.join(temp.root, "wiki");
    const config = {
      compat: { writeMode: mode === "read-only" ? "read_only" : "full" },
      native: { wiki: { enabled: mode !== "disabled", dir: wikiDir } },
    };
    try {
      const invoke = () => reconcileWiki({ config, db });
      if (mode === "read-only") assert.throws(invoke, /write|mode|blocked/i);
      else assert.equal(invoke().enabled, false);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get().c), 0);
      assert.equal(existsSync(wikiDir), false);
    } finally {
      db.close();
      rmSync(temp.root, { force: true, recursive: true });
    }
  }
};

const assertWikiStateDurability = () => {
  const temp = makeTempWorkspace("task11-wiki-state-durable-");
  const wikiDir = path.join(temp.root, "wiki");
  const config = writerConfig(temp.workspace);
  config.native.wiki = { enabled: true, dir: wikiDir };
  const db = openDb(temp.dbPath);
  const stages = [];
  try {
    upsertCurrentMemory(db, projectionMemory("wiki-state-first", "Wiki state durability first fact."));
    projectWiki({
      config,
      db,
      stateFaultInjector: (stage, context = {}) => {
        stages.push(stage);
        if (stage === "after_temp_open") {
          assert.equal(path.dirname(context.tempPath), wikiDir, "state temp must be adjacent to final state");
          assert.equal(statSync(context.tempPath).mode & 0o777, 0o600, "state temp must open mode 0600");
        }
      },
    });
    assert.deepEqual(stages, [
      "after_temp_open",
      "after_temp_write",
      "after_temp_fsync",
      "after_state_rename",
      "after_directory_fsync",
    ]);
    const statePath = path.join(wikiDir, STATE_FILE);
    assert.equal(statSync(statePath).mode & 0o777, 0o600, "final wiki state must retain private mode");
    const stateBefore = readFileSync(statePath, "utf8");

    upsertCurrentMemory(db, projectionMemory("wiki-state-second", "Wiki state durability second fact."));
    assert.throws(() => projectWiki({
      config,
      db,
      stateFaultInjector: (stage) => {
        if (stage === "after_temp_fsync") throw new Error("synthetic wiki state fsync failure");
      },
    }), /synthetic wiki state fsync failure/);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore, "pre-rename failure must preserve prior complete state");
    assert.deepEqual(
      readdirSync(wikiDir).filter((name) => name.startsWith(`${STATE_FILE}.`) && name.endsWith(".tmp")),
      [],
      "state temp must be cleaned after failure",
    );
  } finally {
    db.close();
    rmSync(temp.root, { force: true, recursive: true });
  }
};

const assertWikiReceiptRecovery = () => {
  for (const [label, corruptState] of [
    ["truncated", ""],
    ["partial", '{"generatedSha":'],
    ["corrupt", "not-json"],
  ]) {
    const fixture = wikiReconcileFixture(`receipt-${label}`);
    try {
      assert.throws(() => reconcileWiki({
        completionFaultInjector: (stage) => {
          if (stage === "before_wiki_state_completion") throw new Error(`wiki ${label} completion failure`);
        },
        config: fixture.config,
        db: fixture.db,
      }), new RegExp(`wiki ${label} completion failure`));
      const human = fixture.db.prepare("SELECT memory_id, updated_at FROM memory_current WHERE source_host=?").get(HUMAN_WIKI_HOST);
      const before = {
        agent: { ...fixture.db.prepare("SELECT status, superseded_by, updated_at FROM memory_current WHERE memory_id=?").get(fixture.agentId) },
        events: countEvents(fixture.db),
        humanUpdated: human.updated_at,
        receipts: countRows(fixture.db, "memory_wiki_reconcile_receipts"),
      };
      writeFileSync(fixture.statePath, corruptState, "utf8");
      const resumed = reconcileWiki({
        config: fixture.config,
        db: fixture.db,
        faultInjector: () => { throw new Error("wiki corrupt-state retry repeated DB decision"); },
      });
      assert.equal(resumed.resumed, true, `${label} state must recover from DB receipt`);
      assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).generatedSha, fixture.humanHead);
      assert.equal(statSync(fixture.statePath).mode & 0o777, 0o600);
      assert.deepEqual({
        agent: { ...fixture.db.prepare("SELECT status, superseded_by, updated_at FROM memory_current WHERE memory_id=?").get(fixture.agentId) },
        events: countEvents(fixture.db),
        humanUpdated: fixture.db.prepare("SELECT updated_at FROM memory_current WHERE memory_id=?").get(human.memory_id).updated_at,
        receipts: countRows(fixture.db, "memory_wiki_reconcile_receipts"),
      }, before, `${label} recovery must perform external completion only`);
    } finally {
      fixture.db.close();
      rmSync(fixture.temp.root, { force: true, recursive: true });
    }
  }

  const mismatch = wikiReconcileFixture("receipt-mismatch");
  try {
    assert.throws(() => reconcileWiki({
      completionFaultInjector: () => { throw new Error("wiki mismatch completion failure"); },
      config: mismatch.config,
      db: mismatch.db,
    }), /wiki mismatch completion failure/);
    mismatch.db.prepare("UPDATE memory_wiki_reconcile_receipts SET head_sha=?").run("0".repeat(40));
    writeFileSync(mismatch.statePath, "not-json", "utf8");
    assert.throws(() => reconcileWiki({ config: mismatch.config, db: mismatch.db }), /WIKI_RECEIPT_MISMATCH/);
  } finally {
    mismatch.db.close();
    rmSync(mismatch.temp.root, { force: true, recursive: true });
  }

  const ambiguous = wikiReconcileFixture("receipt-ambiguous");
  try {
    assert.throws(() => reconcileWiki({
      completionFaultInjector: () => { throw new Error("wiki ambiguous completion failure"); },
      config: ambiguous.config,
      db: ambiguous.db,
    }), /wiki ambiguous completion failure/);
    const receipt = ambiguous.db.prepare("SELECT * FROM memory_wiki_reconcile_receipts").get();
    ambiguous.db.prepare(`
      INSERT INTO memory_wiki_reconcile_receipts (
        operation_id, wiki_dir, base_sha, head_sha, created_at, summary_json, state_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "wiki-reconcile-ambiguous-second",
      receipt.wiki_dir,
      "1".repeat(40),
      receipt.head_sha,
      "2026-08-27T23:59:59.000Z",
      receipt.summary_json,
      receipt.state_json,
    );
    writeFileSync(ambiguous.statePath, '{"generatedSha":', "utf8");
    assert.throws(() => reconcileWiki({ config: ambiguous.config, db: ambiguous.db }), /WIKI_RECEIPT_AMBIGUOUS/);
  } finally {
    ambiguous.db.close();
    rmSync(ambiguous.temp.root, { force: true, recursive: true });
  }
};

export const runTask11WriterB2 = () => {
  assertBeliefArbitrationWriter();
  assertControlPlaneWriter();
  assertCodexClaimWriter();
  assertTranscriptWriter();
  assertWikiWriter();
  assertWikiStateDurability();
  assertWikiReceiptRecovery();
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
    assertCaptureWriter({ upsertCurrentMemory, withProjectionMutationBatch });
    await assertAuditWriter();
    await assertAuditCompletionRetry();
    assertMaintenanceWriter();
    assertMaintenanceAutoResolveCompletionRetry();
    assertNativePromotionWriter({ withProjectionMutationBatch });
    await assertQueueReviewWriter();
    runTask11WriterB1();
    runTask11WriterB2();
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

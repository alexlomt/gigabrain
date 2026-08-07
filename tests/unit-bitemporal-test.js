import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { normalizeConfig } from '../lib/core/config.js';
import { captureFromEvent } from '../lib/core/capture-service.js';
import {
  ensureProjectionStore,
  getCurrentMemory,
  listBeliefsAsOf,
  recordVerdict,
} from '../lib/core/projection-store.js';
import { makeTempWorkspace, makeConfigObject, openDb, seedMemoryCurrent } from './helpers.js';

// ---------------------------------------------------------------------------
// U12: bi-temporal completion. valid_from/valid_until carry EVENT time ("when
// was this true in the world"); created_at + verdict/supersede/reinstate events
// carry TRANSACTION time ("when did the store learn it"). These tests pin:
//   (1) the one-time migration backfills valid_from = created_at on pre-U12 DBs,
//   (2) a verdict flips winner.valid_from = loser.valid_until at the SAME
//       instant, atomically inside the recordVerdict savepoint,
//   (3) listBeliefsAsOf answers "what was believed true at T" for winners AND
//       losers (half-open interval: at the flip instant the winner is in),
//   (4) capture-time content_time (event-level or per-extraction-fact) opens
//       the new row's valid_from,
//   (5) a verdict flip re-opens the reinstated winner at the flip timestamp and
//       never leaves a live row with valid_until < valid_from.
// ---------------------------------------------------------------------------

// The exact memory_current schema that shipped before U12 (no valid_from), so
// the migration path is exercised against a real legacy layout instead of a
// monkeypatched one. ensureProjectionStore must ALTER + backfill it.
const PRE_U12_MEMORY_CURRENT = `
  CREATE TABLE memory_current (
    memory_id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'CONTEXT',
    content TEXT NOT NULL,
    normalized TEXT NOT NULL DEFAULT '',
    normalized_hash TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'capture',
    source_agent TEXT,
    source_session TEXT,
    confidence REAL DEFAULT 0.6,
    scope TEXT NOT NULL DEFAULT 'shared',
    status TEXT NOT NULL DEFAULT 'active',
    value_score REAL,
    value_label TEXT,
    created_at TEXT,
    updated_at TEXT,
    archived_at TEXT,
    last_reviewed_at TEXT,
    tags TEXT,
    superseded_by TEXT,
    content_time TEXT,
    valid_until TEXT
  );
`;

const validRow = (db, memoryId) => db.prepare(
  'SELECT memory_id, status, valid_from, valid_until, created_at FROM memory_current WHERE memory_id = ?',
).get(memoryId);

const run = async () => {
  // -------------------------------------------------------------------------
  // (1) Migration: pre-U12 DB opened through ensureProjectionStore gains
  // valid_from backfilled from created_at (fallback updated_at, then now),
  // non-NULL for every row, and the backfill never re-runs (idempotent).
  // -------------------------------------------------------------------------
  {
    const ws = makeTempWorkspace('gb-v3-bitemporal-migrate-');
    const db = new DatabaseSync(ws.dbPath);
    try {
      db.exec(PRE_U12_MEMORY_CURRENT);
      const insert = db.prepare(`
        INSERT INTO memory_current (memory_id, content, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      insert.run('mig-created', 'Row with created_at must backfill from it.', '2026-01-05T08:00:00.000Z', '2026-01-06T08:00:00.000Z');
      insert.run('mig-updated-only', 'Row missing created_at falls back to updated_at.', null, '2026-02-02T09:00:00.000Z');
      insert.run('mig-no-times', 'Row missing both timestamps still gets a non-null start.', null, null);

      assert.equal(
        db.prepare("SELECT COUNT(*) AS c FROM pragma_table_info('memory_current') WHERE name = 'valid_from'").get().c,
        0,
        'precondition: the hand-built legacy schema has no valid_from column',
      );

      ensureProjectionStore(db);

      assert.equal(validRow(db, 'mig-created').valid_from, '2026-01-05T08:00:00.000Z', 'backfill must set valid_from = created_at');
      assert.equal(validRow(db, 'mig-updated-only').valid_from, '2026-02-02T09:00:00.000Z', 'NULL created_at falls back to updated_at');
      assert.ok(validRow(db, 'mig-no-times').valid_from, 'backfill must guarantee non-NULL valid_from even with no timestamps');
      assert.equal(
        db.prepare('SELECT COUNT(*) AS c FROM memory_current WHERE valid_from IS NULL').get().c,
        0,
        'no row may survive the migration with a NULL valid_from',
      );

      // Idempotence: the backfill is gated on the column being absent. A
      // post-migration valid_from (e.g. verdict-stamped) must survive re-opens.
      db.prepare("UPDATE memory_current SET valid_from = '2027-01-01T00:00:00.000Z' WHERE memory_id = 'mig-created'").run();
      ensureProjectionStore(db);
      assert.equal(
        validRow(db, 'mig-created').valid_from,
        '2027-01-01T00:00:00.000Z',
        're-running ensureProjectionStore must not re-backfill an existing valid_from',
      );
    } finally {
      db.close();
    }
  }

  // -------------------------------------------------------------------------
  // (2) Verdict flip is atomic: winner.valid_from = loser.valid_until = the
  // SAME verdict timestamp; a failure mid-verdict (forced via a trigger on the
  // second loser) rolls back BOTH sides and the ledger entry.
  // -------------------------------------------------------------------------
  {
    const ws = makeTempWorkspace('gb-v3-bitemporal-verdict-');
    const db = openDb(ws.dbPath);
    try {
      seedMemoryCurrent(db, [
        { memory_id: 'flip-w', content: 'The launch is scheduled for April, not March.', created_at: '2026-05-20T10:00:00.000Z', updated_at: '2026-05-20T10:00:00.000Z' },
        { memory_id: 'flip-l', content: 'The launch is scheduled for March.', created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-05-01T10:00:00.000Z' },
      ]);
      const flipTs = '2026-06-01T12:00:00.000Z';
      recordVerdict(db, { winnerId: 'flip-w', loserIds: ['flip-l'], reason: 'recency' }, { timestamp: flipTs });

      const winner = validRow(db, 'flip-w');
      const loser = validRow(db, 'flip-l');
      assert.equal(winner.valid_from, flipTs, 'verdict must open the winner valid time at the verdict instant');
      assert.equal(loser.valid_until, flipTs, 'verdict must close the loser valid time at the verdict instant');
      assert.equal(winner.valid_from, loser.valid_until, 'winner open and loser close must share ONE timestamp');
      assert.equal(loser.valid_from, '2026-05-01T10:00:00.000Z', 'the loser keeps its original valid_from (its window start is history, not the flip)');

      // Forced mid-verdict failure: the trigger aborts the SECOND loser's
      // supersession, after the winner stamp and the first loser already wrote.
      // The savepoint must roll everything back: no half-flipped valid time, no
      // verdict/supersede events.
      seedMemoryCurrent(db, [
        { memory_id: 'atom-w', content: 'Atomicity winner candidate fact for U12.', created_at: '2026-05-10T10:00:00.000Z', updated_at: '2026-05-10T10:00:00.000Z' },
        { memory_id: 'atom-l1', content: 'Atomicity first loser fact for U12.', created_at: '2026-05-02T10:00:00.000Z', updated_at: '2026-05-02T10:00:00.000Z' },
        { memory_id: 'atom-l2', content: 'Atomicity second loser fact for U12.', created_at: '2026-05-03T10:00:00.000Z', updated_at: '2026-05-03T10:00:00.000Z' },
      ]);
      db.exec(`
        CREATE TRIGGER gb_u12_force_fail BEFORE UPDATE ON memory_current
        WHEN NEW.memory_id = 'atom-l2' AND NEW.status = 'superseded'
        BEGIN SELECT RAISE(ABORT, 'forced mid-verdict failure'); END;
      `);
      const eventsBefore = db.prepare('SELECT COUNT(*) AS c FROM memory_events').get().c;
      assert.throws(
        () => recordVerdict(db, { winnerId: 'atom-w', loserIds: ['atom-l1', 'atom-l2'] }, { timestamp: '2026-06-02T12:00:00.000Z' }),
        /forced mid-verdict failure/i,
        'the injected mid-verdict failure must propagate',
      );
      db.exec('DROP TRIGGER gb_u12_force_fail');

      assert.equal(validRow(db, 'atom-w').valid_from, '2026-05-10T10:00:00.000Z', 'failed verdict must roll back the winner valid_from stamp');
      const l1 = validRow(db, 'atom-l1');
      assert.equal(l1.status, 'active', 'failed verdict must roll back the first loser supersession');
      assert.equal(l1.valid_until, null, 'failed verdict must roll back the first loser valid_until close');
      assert.equal(validRow(db, 'atom-l2').status, 'active', 'the aborting loser is untouched');
      assert.equal(
        db.prepare('SELECT COUNT(*) AS c FROM memory_events').get().c,
        eventsBefore,
        'failed verdict must leave zero ledger events (savepoint covers events too)',
      );
    } finally {
      db.close();
    }
  }

  // -------------------------------------------------------------------------
  // (3) As-of query: before the flip the LOSER was the belief; at/after the
  // flip the WINNER is (half-open interval [valid_from, valid_until)).
  // -------------------------------------------------------------------------
  {
    const ws = makeTempWorkspace('gb-v3-bitemporal-asof-');
    const db = openDb(ws.dbPath);
    try {
      seedMemoryCurrent(db, [
        { memory_id: 'asof-loser', type: 'USER_FACT', content: 'Jordan lives in Vienna near the first district.', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
        { memory_id: 'asof-winner', type: 'USER_FACT', content: 'Jordan lives in Graz after the spring relocation.', created_at: '2026-03-01T00:00:00.000Z', updated_at: '2026-03-01T00:00:00.000Z' },
      ]);
      const flipTs = '2026-03-01T00:00:00.000Z';
      recordVerdict(db, { winnerId: 'asof-winner', loserIds: ['asof-loser'], reason: 'recency' }, { timestamp: flipTs });

      const idsAt = (at) => listBeliefsAsOf(db, { at, scope: 'shared' }).map((row) => row.memory_id);

      const before = idsAt('2026-02-01T00:00:00.000Z');
      assert.ok(before.includes('asof-loser'), 'before the flip the (now superseded) loser was the belief');
      assert.ok(!before.includes('asof-winner'), 'before the flip the winner is not yet believed');

      const after = idsAt('2026-04-01T00:00:00.000Z');
      assert.ok(after.includes('asof-winner'), 'after the flip the winner is the belief');
      assert.ok(!after.includes('asof-loser'), 'after the flip the loser is no longer believed');

      const atFlip = idsAt(flipTs);
      assert.ok(atFlip.includes('asof-winner') && !atFlip.includes('asof-loser'), 'at the exact flip instant the interval is half-open: winner in, loser out');

      assert.ok(!idsAt('2025-12-01T00:00:00.000Z').includes('asof-loser'), 'before its valid_from even the loser was not believed yet');

      assert.throws(() => listBeliefsAsOf(db, {}), /parseable/i, 'listBeliefsAsOf must reject a missing/unparseable `at`');
    } finally {
      db.close();
    }
  }

  // -------------------------------------------------------------------------
  // (4) Capture content_time plumbing: a per-fact content_time from extraction
  // and an event-level content_time both open valid_from at the stated event
  // time (normalized to full ISO), not at capture time.
  // -------------------------------------------------------------------------
  {
    const ws = makeTempWorkspace('gb-v3-bitemporal-capture-');
    const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
    const db = openDb(ws.dbPath);
    try {
      // (4a) Extraction fact carries content_time (same seam the U7 eval and
      // host injections use: event.__captureLlm).
      const extractSummary = captureFromEvent({
        db,
        config,
        event: {
          scope: 'bitemporal',
          agentId: 'main',
          sessionKey: 'agent:main:bitemporal',
          text: 'Long transcript without tagged notes. Jordan mentioned relocating from Vienna to Graz back in mid-February for the new role.',
          __captureLlm: {
            extract: () => [{
              type: 'USER_FACT',
              content: 'Jordan relocated from Vienna to Graz for the new role.',
              confidence: 0.9,
              content_time: '2026-02-15',
            }],
          },
        },
        runId: 'bitemporal-unit',
        reviewVersion: 'rv-bitemporal',
        logger: { info: () => {}, warn: () => {} },
      });
      assert.equal(extractSummary.inserted, 1, 'extraction fact must insert');
      const extracted = getCurrentMemory(db, extractSummary.inserted_ids[0]);
      assert.equal(extracted.content_time, '2026-02-15', 'extraction content_time is stored');
      assert.equal(extracted.valid_from, '2026-02-15T00:00:00.000Z', 'valid_from opens at the extraction-stated event time (ISO-normalized)');

      // (4b) Event-level content_time seeds tagged-note captures.
      const noteSummary = captureFromEvent({
        db,
        config,
        event: {
          scope: 'bitemporal',
          agentId: 'main',
          sessionKey: 'agent:main:bitemporal',
          content_time: '2026-03-03',
          text: '<memory_note type="DECISION" confidence="0.9">The team decided to ship the arbitration ledger before the studio UI.</memory_note>',
        },
        runId: 'bitemporal-unit',
        reviewVersion: 'rv-bitemporal',
        logger: { info: () => {}, warn: () => {} },
      });
      assert.equal(noteSummary.inserted, 1, 'tagged note must insert');
      const noted = getCurrentMemory(db, noteSummary.inserted_ids[0]);
      assert.equal(noted.content_time, '2026-03-03', 'event-level content_time is stored on the note row');
      assert.equal(noted.valid_from, '2026-03-03T00:00:00.000Z', 'valid_from opens at the event-level content_time');

      // Without any content_time, valid_from defaults to created_at.
      const plainSummary = captureFromEvent({
        db,
        config,
        event: {
          scope: 'bitemporal',
          agentId: 'main',
          sessionKey: 'agent:main:bitemporal',
          text: '<memory_note type="PREFERENCE" confidence="0.9">Jordan prefers espresso over filter coffee in the morning.</memory_note>',
        },
        runId: 'bitemporal-unit',
        reviewVersion: 'rv-bitemporal',
        logger: { info: () => {}, warn: () => {} },
      });
      assert.equal(plainSummary.inserted, 1, 'plain note must insert');
      const plain = getCurrentMemory(db, plainSummary.inserted_ids[0]);
      assert.equal(plain.valid_from, plain.created_at, 'absent content_time, valid_from defaults to created_at');
    } finally {
      db.close();
    }
  }

  // -------------------------------------------------------------------------
  // (5) Reinstatement × valid_from (U2 flip): the reinstated winner re-opens at
  // the flip timestamp (valid_until cleared, valid_from = flip), and no live
  // row is left with valid_until < valid_from. As-of replays the full history.
  // -------------------------------------------------------------------------
  {
    const ws = makeTempWorkspace('gb-v3-bitemporal-reinstate-');
    const db = openDb(ws.dbPath);
    try {
      seedMemoryCurrent(db, [
        { memory_id: 'rein-a', type: 'USER_FACT', content: 'The vault sync cadence is nightly at 02:00.', created_at: '2026-01-10T00:00:00.000Z', updated_at: '2026-01-10T00:00:00.000Z' },
        { memory_id: 'rein-b', type: 'USER_FACT', content: 'The vault sync cadence is hourly during the day.', created_at: '2026-01-20T00:00:00.000Z', updated_at: '2026-01-20T00:00:00.000Z' },
      ]);
      const firstTs = '2026-02-01T00:00:00.000Z';
      const flipTs = '2026-04-01T00:00:00.000Z';
      recordVerdict(db, { winnerId: 'rein-a', loserIds: ['rein-b'], reason: 'recency' }, { timestamp: firstTs });
      const flip = recordVerdict(db, { winnerId: 'rein-b', loserIds: ['rein-a'], reason: 'trust' }, { timestamp: flipTs });
      assert.ok(flip.reinstateEvent, 'the flip must reinstate the previously superseded winner');

      const reinstated = validRow(db, 'rein-b');
      assert.equal(reinstated.status, 'active', 'reinstated winner is active');
      assert.equal(reinstated.valid_from, flipTs, 'the reinstated winner re-opens AT the flip timestamp');
      assert.equal(reinstated.valid_until, null, 'the reinstated winner valid time is open (live for recall)');
      const flippedLoser = validRow(db, 'rein-a');
      assert.equal(flippedLoser.valid_until, flipTs, 'the flipped loser closes at the same flip timestamp');

      // Interval sanity: no live row may carry valid_until < valid_from.
      const inverted = db.prepare(`
        SELECT COUNT(*) AS c FROM memory_current
        WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until < valid_from
      `).get().c;
      assert.equal(inverted, 0, 'a flip must never leave a live row with valid_until < valid_from');

      const idsAt = (at) => listBeliefsAsOf(db, { at }).map((row) => row.memory_id);
      assert.ok(idsAt('2026-03-01T00:00:00.000Z').includes('rein-a'), 'between the verdicts, A was the belief');
      assert.ok(!idsAt('2026-03-01T00:00:00.000Z').includes('rein-b'), 'between the verdicts, B was not believed');
      assert.ok(idsAt('2026-05-01T00:00:00.000Z').includes('rein-b'), 'after the flip, B is the belief');
      assert.ok(!idsAt('2026-05-01T00:00:00.000Z').includes('rein-a'), 'after the flip, A is no longer believed');

      // -----------------------------------------------------------------------
      // (5b) Third verdict in the chain (review #16): A beats B AGAIN at t3
      // (A→B→A). The second reinstatement must re-open A at t3, close B at the
      // SAME t3, leave zero inverted intervals anywhere, and the as-of query
      // must replay the chain: B's middle window [t2,t3) survives its loss
      // intact, A owns [t3,∞) with a half-open boundary at t3.
      // -----------------------------------------------------------------------
      const thirdTs = '2026-05-15T00:00:00.000Z';
      const third = recordVerdict(db, { winnerId: 'rein-a', loserIds: ['rein-b'], reason: 'recency' }, { timestamp: thirdTs });
      assert.ok(third.reinstateEvent, 'the third verdict reinstates the previously superseded A');

      const aFinal = validRow(db, 'rein-a');
      assert.equal(aFinal.status, 'active', 'A is active after winning the third verdict');
      assert.equal(aFinal.valid_from, thirdTs, 'A re-opens AT the third flip timestamp');
      assert.equal(aFinal.valid_until, null, 'A valid time is open (live for recall)');
      const bFinal = validRow(db, 'rein-b');
      assert.equal(bFinal.status, 'superseded', 'B is superseded after losing the third verdict');
      assert.equal(bFinal.valid_until, thirdTs, 'B closes at the same third flip timestamp');
      assert.equal(bFinal.valid_from, flipTs, 'B keeps its original window start — its middle phase is history, not the flip');

      // Interval sanity across the WHOLE table after the chain: no row — live
      // or superseded — may carry valid_until < valid_from.
      const invertedAfterChain = db.prepare(`
        SELECT COUNT(*) AS c FROM memory_current
        WHERE valid_until IS NOT NULL AND valid_until < valid_from
      `).get().c;
      assert.equal(invertedAfterChain, 0, 'a 3-verdict flip chain must leave zero inverted intervals');

      // As-of replay of the chain's phases. Phase 2 (B's reign) and phase 3
      // (A reinstated) replay from memory_current; phase 1 (A's first window
      // [t1,t2)) left the single-interval projection when A re-opened at t3 —
      // it stays replayable from the ledger alone (the reinstate event records
      // the window it overturns), which is asserted below, NOT from as-of.
      assert.ok(idsAt('2026-05-01T00:00:00.000Z').includes('rein-b'), 'phase 2 [t2,t3): B was the belief');
      assert.ok(!idsAt('2026-05-01T00:00:00.000Z').includes('rein-a'), 'phase 2 [t2,t3): A was not believed');
      assert.ok(idsAt(thirdTs).includes('rein-a') && !idsAt(thirdTs).includes('rein-b'),
        'at the exact third flip instant the interval is half-open: A in, B out');
      assert.ok(idsAt('2026-06-01T00:00:00.000Z').includes('rein-a'), 'phase 3 [t3,∞): A is the belief again');
      assert.ok(!idsAt('2026-06-01T00:00:00.000Z').includes('rein-b'), 'phase 3 [t3,∞): B is no longer believed');

      // Phase 1 stays on the ledger: A's second reinstate event preserves the
      // valid_until that closed A's first window (= t2, the first flip).
      const reinstatePayload = JSON.parse(String(db.prepare(`
        SELECT payload FROM memory_events
        WHERE action = 'arbiter:reinstate' AND memory_id = 'rein-a'
        ORDER BY rowid DESC LIMIT 1
      `).get()?.payload || '{}'));
      assert.equal(reinstatePayload.previous_valid_until, flipTs,
        'the reinstate ledger event preserves the closed first window (phase 1 replayable from the ledger)');
      assert.equal(reinstatePayload.previously_superseded_by, 'rein-b',
        'the reinstate ledger event names who had superseded A');
    } finally {
      db.close();
    }
  }

  console.log('bi-temporal completion (U12): all assertions passed');
};

export { run };

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}

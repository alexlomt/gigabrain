import assert from 'node:assert/strict';

import {
  appendEvent,
  appendEvents,
  listTimeline,
  buildEvent,
} from '../lib/core/event-store.js';
import { getCurrentMemory, recordVerdict } from '../lib/core/projection-store.js';
import { makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-unit-event-store-');
  const db = openDb(ws.dbPath);
  try {
    // agent_id persists on the append-only log and round-trips through the reader.
    appendEvent(db, {
      component: 'arbiter',
      action: 'arbiter:verdict',
      reason_codes: ['trust', 'authority'],
      memory_id: 'm-winner',
      agent_id: 'codex',
      payload: { winnerId: 'm-winner', loserIds: ['m-loser'] },
    });
    const timeline = listTimeline(db, 'm-winner');
    assert.equal(timeline.length, 1, 'verdict event should persist on the timeline');
    const ev = timeline[0];
    assert.equal(ev.agent_id, 'codex', 'agent_id should persist and round-trip');
    assert.deepEqual(ev.reason_codes, ['trust', 'authority'], 'reason_codes should persist');
    assert.equal(ev.action, 'arbiter:verdict', 'action should persist');
    assert.equal(ev.payload.winnerId, 'm-winner', 'payload should persist');
    assert.deepEqual(ev.payload.loserIds, ['m-loser'], 'payload loserIds should persist');

    // Missing agent_id defaults safely to null (null-safe default, R6).
    appendEvent(db, {
      component: 'maintenance',
      action: 'noop',
      memory_id: 'm-plain',
    });
    const plain = listTimeline(db, 'm-plain');
    assert.equal(plain.length, 1, 'non-arbiter event should still append');
    assert.equal(plain[0].agent_id, null, 'missing agent_id should default to null');

    // buildEvent picks up agent_id from defaults when the event omits it.
    const built = buildEvent({ memory_id: 'x', action: 'arbiter:verdict' }, { agent_id: 'hermes' });
    assert.equal(built.agent_id, 'hermes', 'buildEvent should fall back to defaults.agent_id');

    // appendEvents (batch) threads agent_id too.
    appendEvents(db, [
      { component: 'arbiter', action: 'arbiter:supersede', memory_id: 'm-loser', agent_id: 'cursor', matched_memory_id: 'm-winner' },
    ]);
    const loserTl = listTimeline(db, 'm-loser');
    assert.equal(loserTl.length, 1, 'batch-appended event should persist');
    assert.equal(loserTl[0].agent_id, 'cursor', 'batch append should thread agent_id');

    // --- recordVerdict ledger semantics (U2): flip reinstatement + attestation guards.
    const countEvents = () => db.prepare('SELECT COUNT(*) AS c FROM memory_events').get().c;

    // Attestation guards: unknown winner / winner∈losers throw and leave NO
    // partial write (savepoint rollback): no events, loser untouched.
    seedMemoryCurrent(db, [
      { memory_id: 'g-loser', content: 'Guard loser stays active on a rejected verdict.' },
    ]);
    const beforeGuard = countEvents();
    assert.throws(
      () => recordVerdict(db, { winnerId: 'g-missing', loserIds: ['g-loser'] }),
      /does not exist/i,
      'recordVerdict should reject a winner the store has never seen',
    );
    assert.throws(
      () => recordVerdict(db, { winnerId: 'g-loser', loserIds: ['g-loser'] }),
      /cannot also be a loser/i,
      'recordVerdict should reject winner∈losers',
    );
    assert.equal(countEvents(), beforeGuard, 'rejected verdicts must append zero events (no partial write)');
    assert.equal(getCurrentMemory(db, 'g-loser').status, 'active', 'rejected verdicts must not mutate the loser');

    // Flip reinstatement: A beats B, then a new verdict flips B over A. B must
    // come back active with superseded_by IS NULL (no supersession cycle), and
    // the flip itself is an arbiter:reinstate event referencing the prior verdict.
    seedMemoryCurrent(db, [
      { memory_id: 'flip-a', content: 'The launch is scheduled for March.' },
      { memory_id: 'flip-b', content: 'The launch is scheduled for April.' },
    ]);
    const first = recordVerdict(db, { winnerId: 'flip-a', loserIds: ['flip-b'], reason: 'recency' });
    assert.equal(first.reinstateEvent, null, 'a verdict over an active winner needs no reinstatement');
    assert.equal(getCurrentMemory(db, 'flip-b').status, 'superseded', 'first verdict supersedes B');

    // A capture-CONTRADICT loser also gets its valid time closed out; the flip
    // must reopen it or the reinstated winner is permanently recall-dead behind
    // the isLiveRecallRow valid_until filter (review finding, P1).
    db.prepare("UPDATE memory_current SET valid_until = '2026-06-01T00:00:00.000Z' WHERE memory_id = 'flip-b'").run();

    const flip = recordVerdict(db, { winnerId: 'flip-b', loserIds: ['flip-a'], reason: 'trust' });
    const reinstated = getCurrentMemory(db, 'flip-b');
    assert.equal(reinstated.status, 'active', 'flip must reinstate the previously superseded winner');
    assert.equal(reinstated.superseded_by, null, 'reinstated winner superseded_by IS NULL');
    assert.equal(reinstated.valid_until, null, 'reinstatement must reopen valid time (clear stale valid_until)');
    assert.equal(flip.reinstateEvent.payload.previous_valid_until, '2026-06-01T00:00:00.000Z', 'reinstate payload records the valid_until it cleared');
    const flippedLoser = getCurrentMemory(db, 'flip-a');
    assert.equal(flippedLoser.status, 'superseded', 'flip supersedes the previous winner');
    assert.equal(flippedLoser.superseded_by, 'flip-b', 'previous winner is superseded by the reinstated one');
    assert.ok(flip.reinstateEvent, 'flip verdict returns the reinstate event');
    assert.equal(flip.reinstateEvent.action, 'arbiter:reinstate', 'reinstate event action');
    assert.equal(flip.reinstateEvent.matched_memory_id, 'flip-a', 'reinstate references the rival that had superseded the winner');
    assert.equal(flip.reinstateEvent.payload.previously_superseded_by, 'flip-a', 'reinstate payload carries the prior rival');
    assert.equal(
      flip.reinstateEvent.payload.prior_supersede_event_id,
      first.supersedeEvents[0].event_id,
      'reinstate references the prior verdict (its supersede event) it overturns',
    );
    assert.equal(
      flip.reinstateEvent.payload.verdict_event_id,
      flip.verdictEvent.event_id,
      'reinstate is tied to the flipping verdict event',
    );

    // Zero-active-cycle impossible: exactly one rival is active after the flip.
    const activeRivals = db.prepare(`
      SELECT COUNT(*) AS c FROM memory_current
      WHERE memory_id IN ('flip-a', 'flip-b') AND status = 'active'
    `).get().c;
    assert.equal(activeRivals, 1, 'a flip must leave exactly one active rival');

    // Replaying the append-only log reconstructs the flip history in order:
    // verdict(A) → supersede(B) → verdict(B) → reinstate(B) → supersede(A).
    const flipHistory = db.prepare(`
      SELECT action, memory_id FROM memory_events
      WHERE memory_id IN ('flip-a', 'flip-b')
      ORDER BY rowid
    `).all().map((e) => `${e.action}:${e.memory_id}`);
    assert.deepEqual(
      flipHistory,
      [
        'arbiter:verdict:flip-a',
        'arbiter:supersede:flip-b',
        'arbiter:verdict:flip-b',
        'arbiter:reinstate:flip-b',
        'arbiter:supersede:flip-a',
      ],
      'replaying events reconstructs the flip history in order',
    );
  } finally {
    db.close();
  }
};

export { run };

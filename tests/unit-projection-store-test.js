import assert from 'node:assert/strict';

import {
  searchCurrentMemories,
  searchFTS5,
  tokenizeFtsQuery,
  recordVerdict,
  getCurrentMemory,
  updateCurrentStatus,
} from '../lib/core/projection-store.js';
import { listTimeline } from '../lib/core/event-store.js';
import { makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v5-unit-projection-store-');
  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'fts-prefix-hit',
        type: 'DECISION',
        content: 'Specialized rollout checklist for the nightly graph pipeline.',
        scope: 'shared',
        confidence: 0.91,
        value_score: 0.64,
        value_label: 'core',
      },
      {
        memory_id: 'plain-hit',
        type: 'DECISION',
        content: 'Graph rollout note for the nightly pipeline.',
        scope: 'shared',
        confidence: 0.7,
        value_score: 0.4,
        value_label: 'situational',
      },
    ]);

    const prefixResults = searchCurrentMemories(db, {
      query: 'special',
      topK: 5,
      scope: 'shared',
      statuses: ['active'],
    });
    assert.equal(prefixResults.some((row) => row.memory_id === 'fts-prefix-hit'), true, 'FTS prefix search should return rows even when lexical word-boundary scoring is zero');

    const graphResults = searchCurrentMemories(db, {
      query: 'graph',
      topK: 5,
      scope: 'shared',
      statuses: ['active'],
    });
    assert.equal(graphResults[0]?.memory_id === 'plain-hit' || graphResults[0]?.memory_id === 'fts-prefix-hit', true, 'search should still rank normal lexical hits after FTS weighting');

    assert.throws(
      () => searchCurrentMemories(db, {
        query: 'graph',
        topK: 5,
        scope: '../../etc/passwd',
        statuses: ['active'],
      }),
      /Invalid Gigabrain scope/i,
      'projection-store search should reject invalid scope strings instead of accepting raw values',
    );

    // Scope visibility (U14-opt fix #4): shared rows are cross-visible, so a
    // BARE agent scope ('main') sees own + shared — it previously fell through
    // the project:/profile: prefix match and saw ONLY its own rows. Requesting
    // 'shared' stays STRICT (shared only): shared-sees-everything was the old
    // dense-leg leak. project:/profile: semantics are unchanged (own + shared).
    seedMemoryCurrent(db, [
      { memory_id: 'scope-shared-row', type: 'CONTEXT', content: 'Beacon shared deployment notes for everyone.', scope: 'shared', confidence: 0.8 },
      { memory_id: 'scope-main-row', type: 'CONTEXT', content: 'Beacon main-agent calibration notes.', scope: 'main', confidence: 0.8 },
      { memory_id: 'scope-alpha-row', type: 'CONTEXT', content: 'Beacon alpha project rollout notes.', scope: 'project:alpha', confidence: 0.8 },
    ]);
    const idsFor = (scope) => searchCurrentMemories(db, {
      query: 'beacon',
      topK: 10,
      scope,
      statuses: ['active'],
    }).map((row) => row.memory_id).filter((id) => id.startsWith('scope-')).sort();
    assert.deepEqual(
      idsFor('main'),
      ['scope-main-row', 'scope-shared-row'],
      'bare agent scope must see own rows plus shared (fix #4) and nothing else',
    );
    assert.deepEqual(
      idsFor('shared'),
      ['scope-shared-row'],
      'requesting shared must stay strict: shared rows only, never other scopes',
    );
    assert.deepEqual(
      idsFor('project:alpha'),
      ['scope-alpha-row', 'scope-shared-row'],
      'project scope semantics must be unchanged: own rows plus shared',
    );

    // recordVerdict (U1): a planted two-belief conflict produces a verdict event
    // chain and superseded losers, all persisted on the ledger.
    seedMemoryCurrent(db, [
      { memory_id: 'verdict-winner', content: 'The neobank launched in March 2026.', confidence: 0.74 },
      { memory_id: 'verdict-loser-a', content: 'The neobank launched in January 2026.', confidence: 0.4 },
      { memory_id: 'verdict-loser-b', content: 'The neobank launched in February 2026.', confidence: 0.4 },
    ]);

    const result = recordVerdict(db, {
      winnerId: 'verdict-winner',
      loserIds: ['verdict-loser-a', 'verdict-loser-b'],
      signals: { maxTrust: 0.74, support: 1, recency: '2026-03-01' },
      agentId: 'codex',
      reason: ['trust', 'authority'],
    });

    // (a) verdict event persists with agent_id + reason_codes + payload.
    assert.equal(result.verdictEvent.action, 'arbiter:verdict', 'verdict event action');
    const winnerTl = listTimeline(db, 'verdict-winner');
    const verdict = winnerTl.find((e) => e.action === 'arbiter:verdict');
    assert.ok(verdict, 'verdict event should be on the winner timeline');
    assert.equal(verdict.agent_id, 'codex', 'verdict carries agent_id');
    assert.deepEqual(verdict.reason_codes, ['trust', 'authority'], 'verdict carries reason_codes');
    assert.equal(verdict.payload.winnerId, 'verdict-winner', 'verdict payload winnerId');
    assert.deepEqual(verdict.payload.loserIds, ['verdict-loser-a', 'verdict-loser-b'], 'verdict payload loserIds');
    assert.equal(verdict.payload.signals.support, 1, 'verdict payload carries signals');

    // (b) each loser gets status='superseded' + superseded_by=winner.
    for (const loserId of ['verdict-loser-a', 'verdict-loser-b']) {
      const loser = getCurrentMemory(db, loserId);
      assert.equal(loser.status, 'superseded', `${loserId} should be superseded`);
      assert.equal(loser.superseded_by, 'verdict-winner', `${loserId} superseded_by winner`);
      const loserTl = listTimeline(db, loserId);
      const supersede = loserTl.find((e) => e.action === 'arbiter:supersede');
      assert.ok(supersede, `${loserId} should have a supersede event`);
      assert.equal(supersede.agent_id, 'codex', 'supersede event carries agent_id');
      assert.equal(supersede.matched_memory_id, 'verdict-winner', 'supersede points at winner');
    }

    // Replaying the ledger reconstructs the verdict (winner + losers) from events alone.
    const replay = listTimeline(db, 'verdict-winner').find((e) => e.action === 'arbiter:verdict');
    assert.deepEqual(
      { winner: replay.payload.winnerId, losers: replay.payload.loserIds },
      { winner: 'verdict-winner', losers: ['verdict-loser-a', 'verdict-loser-b'] },
      'replay reconstructs the verdict',
    );

    // Missing agentId defaults safely (null), no throw.
    seedMemoryCurrent(db, [
      { memory_id: 'v2-winner', content: 'X is true.', confidence: 0.7 },
      { memory_id: 'v2-loser', content: 'X is false.', confidence: 0.4 },
    ]);
    const noAgent = recordVerdict(db, {
      winnerId: 'v2-winner',
      loserIds: ['v2-loser'],
      reason: 'recency',
    });
    assert.equal(noAgent.verdictEvent.agent_id, null, 'missing agentId defaults to null');
    assert.equal(getCurrentMemory(db, 'v2-loser').status, 'superseded', 'no-agent verdict still supersedes');
  } finally {
    db.close();
  }

  // U14: tokenizeFtsQuery widened to \p{L}\p{N}. The old [a-z0-9äöüß] class
  // deleted every non-Latin letter, so Cyrillic/CJK queries tokenized to
  // nothing and the FTS5 leg returned zero rows. Widening is additive: ASCII
  // and German behavior is byte-identical (asserted below).
  assert.deepEqual(
    tokenizeFtsQuery('Grüße über die Straße in München'),
    ['grüße', 'über', 'die', 'straße', 'in', 'münchen'],
    'German umlauts and ß must tokenize losslessly',
  );
  assert.deepEqual(
    tokenizeFtsQuery('Москва столица России'),
    ['москва', 'столица', 'россии'],
    'Cyrillic queries must tokenize losslessly instead of collapsing to nothing',
  );
  assert.deepEqual(
    tokenizeFtsQuery('東京タワー 写真'),
    ['東京タワー', '写真'],
    'CJK queries must tokenize losslessly instead of collapsing to nothing',
  );
  assert.deepEqual(
    tokenizeFtsQuery('Specialized rollout-checklist, v2!'),
    ['specialized', 'rollout', 'checklist', 'v2'],
    'existing English tokenization (punctuation to whitespace, lowercase) must be unchanged',
  );
  assert.deepEqual(
    tokenizeFtsQuery('!!! ??? --- '),
    [],
    'punctuation-only queries still tokenize to nothing',
  );

  // End-to-end through the FTS5 leg (searchFTS5 uses tokenizeFtsQuery
  // exclusively, so this isolates the widened tokenizer from the LIKE leg).
  const ftsWs = makeTempWorkspace('gb-v5-unit-projection-fts-unicode-');
  const ftsDb = openDb(ftsWs.dbPath);
  try {
    seedMemoryCurrent(ftsDb, [
      {
        memory_id: 'de-umlaut-row',
        type: 'USER_FACT',
        content: 'Dana Mercer bevorzugt Müsli mit Heidelbeeren zum Frühstück.',
        scope: 'shared',
        confidence: 0.85,
      },
      {
        memory_id: 'cyrillic-row',
        type: 'USER_FACT',
        content: 'Пользователь живёт недалеко от центра Москвы.',
        scope: 'shared',
        confidence: 0.85,
      },
      {
        memory_id: 'english-row',
        type: 'USER_FACT',
        content: 'The user keeps the deployment checklist in the wiki.',
        scope: 'shared',
        confidence: 0.85,
      },
    ]);

    const germanHits = searchFTS5(ftsDb, 'Müsli Frühstück', { topK: 5 });
    assert.equal(
      germanHits.some((hit) => hit.memory_id === 'de-umlaut-row'),
      true,
      'German umlaut query must reach the row through the FTS5 leg',
    );

    const cyrillicHits = searchFTS5(ftsDb, 'центра Москвы', { topK: 5 });
    assert.equal(
      cyrillicHits.some((hit) => hit.memory_id === 'cyrillic-row'),
      true,
      'Cyrillic query must reach the row through the FTS5 leg (was zero rows pre-U14)',
    );

    const englishResults = searchCurrentMemories(ftsDb, {
      query: 'deployment checklist',
      topK: 5,
      scope: 'shared',
      statuses: ['active'],
    });
    assert.equal(
      englishResults[0]?.memory_id,
      'english-row',
      'English lexical ranking must be unaffected by the tokenizer widening',
    );
  } finally {
    ftsDb.close();
  }

  // U14b (#23): status flips keep the FTS index fresh. Supersession removes
  // the row from memory_fts IMMEDIATELY — pre-#23 a dead row lingered in the
  // index until the nightly rebuild, consuming topK slots and skewing bm25 —
  // and reinstatement re-adds it.
  const pruneWs = makeTempWorkspace('gb-v5-unit-projection-fts-prune-');
  const pruneDb = openDb(pruneWs.dbPath);
  try {
    seedMemoryCurrent(pruneDb, [
      {
        memory_id: 'fts-prune-row',
        type: 'USER_FACT',
        content: 'The quokka enclosure opens at dawn for the keepers.',
        scope: 'shared',
        confidence: 0.9,
      },
    ]);
    const hitsActive = searchFTS5(pruneDb, 'quokka enclosure', { topK: 5 });
    assert.equal(
      hitsActive.some((hit) => hit.memory_id === 'fts-prune-row'),
      true,
      'an active row must be searchable through the FTS5 index',
    );

    updateCurrentStatus(pruneDb, 'fts-prune-row', 'superseded', { superseded_by: 'fts-prune-rival' });
    const hitsSuperseded = searchFTS5(pruneDb, 'quokka enclosure', { topK: 5 });
    assert.equal(
      hitsSuperseded.some((hit) => hit.memory_id === 'fts-prune-row'),
      false,
      'supersession must prune the row from the FTS5 index immediately (pre-nightly-rebuild)',
    );

    updateCurrentStatus(pruneDb, 'fts-prune-row', 'active', { clear_superseded_by: true, clear_valid_until: true });
    const hitsReinstated = searchFTS5(pruneDb, 'quokka enclosure', { topK: 5 });
    assert.equal(
      hitsReinstated.some((hit) => hit.memory_id === 'fts-prune-row'),
      true,
      'reinstatement must re-add the row to the FTS5 index',
    );
  } finally {
    pruneDb.close();
  }
};

export { run };

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}

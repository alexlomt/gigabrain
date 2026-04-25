import assert from 'node:assert/strict';

import { searchCurrentMemories } from '../lib/core/projection-store.js';
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

    seedMemoryCurrent(db, [
      {
        memory_id: 'profile-hit',
        type: 'PREFERENCE',
        content: 'Alex prefers direct execution when scope is clear.',
        scope: 'profile:main',
        confidence: 0.93,
        value_score: 0.72,
      },
      {
        memory_id: 'shared-visible-hit',
        type: 'PREFERENCE',
        content: 'Alex prefers direct execution in shared runbooks.',
        scope: 'shared',
        confidence: 0.82,
        value_score: 0.4,
      },
    ]);
    const mainScopedResults = searchCurrentMemories(db, {
      query: 'direct execution',
      topK: 10,
      scope: 'main',
      statuses: ['active'],
    }).map((row) => row.memory_id);
    assert.equal(mainScopedResults.includes('profile-hit'), true, 'legacy main scope queries should see profile:main memories');
    assert.equal(mainScopedResults.includes('shared-visible-hit'), true, 'profile/main scope queries should still include shared memories');

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
  } finally {
    db.close();
  }
};

export { run };

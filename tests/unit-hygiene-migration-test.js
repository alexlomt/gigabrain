import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { runHygieneMigration } from '../lib/core/hygiene-migration.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const readQueue = (queuePath) => fs.readFileSync(queuePath, 'utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-hygiene-migration-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'memtest-active',
        type: 'PREFERENCE',
        content: 'MEMTEST_CAPTURE_20260425 Alex prefers this temporary memory-system test.',
        scope: 'profile:main',
        status: 'active',
      },
      {
        memory_id: 'real-active',
        type: 'PREFERENCE',
        content: 'Alex prefers production-grade memory migrations.',
        scope: 'profile:main',
        status: 'active',
      },
    ]);

    fs.mkdirSync(ws.memoryRoot, { recursive: true });
    const dailyPath = path.join(ws.memoryRoot, '2026-04-25.md');
    fs.writeFileSync(dailyPath, [
      '# 2026-04-25',
      '',
      '## Session Notes',
      '- Keep this unique note.',
      '- Duplicate daily note bullet.',
      '- Duplicate daily note bullet.',
      '## Later',
      '- Duplicate daily note bullet.',
      '```',
      '- Duplicate daily note bullet.',
      '```',
      '',
    ].join('\n'), 'utf8');

    const queuePath = config.runtime.paths.reviewQueuePath;
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, `${JSON.stringify({
      status: 'pending',
      reason_code: 'capture_missing_note',
      timestamp: '2026-04-25T00:00:00.000Z',
      payload: {
        excerpt: 'Running the live checks now. Baseline looks healthy and I am validating progress.',
      },
    })}\n`, 'utf8');

    const dryRun = runHygieneMigration({
      db,
      dbPath: ws.dbPath,
      config,
      apply: false,
      refresh: false,
      now: '2026-04-25T11:00:00.000Z',
      runId: 'hygiene-test-run',
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.testArtifacts.candidates, 1, 'dry-run should identify active MEMTEST rows');
    assert.equal(dryRun.dailyNoteDedupe.removedBullets, 1, 'dry-run should identify duplicate daily-note bullets outside code fences');
    assert.equal(dryRun.queue.candidates, 1, 'dry-run should identify non-durable pending queue chatter');
    assert.equal((fs.readFileSync(dailyPath, 'utf8').match(/Duplicate daily note bullet\./g) || []).length, 4, 'dry-run must not edit native files');

    const applied = runHygieneMigration({
      db,
      dbPath: ws.dbPath,
      config,
      apply: true,
      refresh: false,
      now: '2026-04-25T11:01:00.000Z',
      runId: 'hygiene-test-run',
    });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.snapshot.copiedFiles > 0, true, 'apply should snapshot db and memory files before mutation');
    assert.equal(fs.existsSync(applied.snapshot.path), true, 'snapshot directory should exist');

    const memtest = db.prepare('SELECT status, value_label FROM memory_current WHERE memory_id = ?').get('memtest-active');
    assert.equal(String(memtest.status), 'rejected', 'active MEMTEST rows should be rejected, not deleted');
    assert.equal(String(memtest.value_label), 'hygiene_test_artifact');
    const real = db.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('real-active');
    assert.equal(String(real.status), 'active', 'real memory should not be touched');

    const daily = fs.readFileSync(dailyPath, 'utf8');
    assert.equal((daily.match(/Duplicate daily note bullet\./g) || []).length, 3, 'one same-section markdown duplicate should be removed while other sections and code fences stay intact');
    assert.match(daily, /## Later\n- Duplicate daily note bullet\./, 'dedupe should preserve separate sections');
    assert.match(daily, /```\n- Duplicate daily note bullet\.\n```/, 'dedupe must not touch code fences');

    const queueRows = readQueue(queuePath);
    assert.equal(String(queueRows[0].status), 'resolved_hygiene', 'non-durable queue row should be resolved with audit metadata');
    assert.equal(String(queueRows[0].resolved_reason), 'hygiene_non_durable_dismiss');

    const secondApply = runHygieneMigration({
      db,
      dbPath: ws.dbPath,
      config,
      apply: true,
      refresh: false,
      now: '2026-04-25T11:02:00.000Z',
      runId: 'hygiene-test-run-2',
    });
    assert.equal(secondApply.testArtifacts.changed, 0, 'migration should be idempotent for already rejected test rows');
    assert.equal(secondApply.dailyNoteDedupe.removedBullets, 0, 'migration should be idempotent for deduped daily notes');
    assert.equal(secondApply.queue.changed, 0, 'migration should be idempotent for resolved queue rows');
  } finally {
    db.close();
  }
};

export { run };

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadResolvedConfig } from '../lib/core/config.js';
import { reviewPendingQueue } from '../lib/core/queue-review-service.js';
import {
  makeTempWorkspace,
  makeConfigObject,
  openDb,
  seedMemoryCurrent,
  writeConfigFile,
} from './helpers.js';

const writeQueue = (queuePath, rows) => {
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
};

const loadConfig = (configPath) => loadResolvedConfig({
  configPath,
  mode: 'openclaw',
});

const makeReviewer = (parsed) => async () => ({ ok: true, parsed });

const run = async () => {
  {
    const temp = makeTempWorkspace('gb-v3-queue-review-store-');
    const raw = makeConfigObject(temp.workspace);
    raw.plugins.entries.gigabrain.config.llm.queueReview = {
      enabled: true,
      limit: 50,
      minConfidence: 0.8,
      profile: 'memory_review',
      allowedReasons: ['capture_missing_note'],
    };
    writeConfigFile(temp.configPath, raw);
    const { config } = loadConfig(temp.configPath);
    const queuePath = config.runtime.paths.reviewQueuePath;
    writeQueue(queuePath, [{
      status: 'pending',
      reason_code: 'capture_missing_note',
      timestamp: '2026-04-25T00:00:00.000Z',
      payload: {
        excerpt: 'Remember this: Alex prefers concise, direct answers.',
        source: 'assistant_reply',
      },
    }]);
    const db = openDb(temp.dbPath);
    try {
      const result = await reviewPendingQueue({
        db,
        config,
        dryRun: false,
        runId: 'test-run-store',
        reviewer: makeReviewer({
          decision: 'store',
          confidence: 0.96,
          type: 'PREFERENCE',
          content: 'Alex prefers concise, direct answers.',
          scope: 'profile:main',
          reason: 'durable user preference',
        }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.stored, 1, 'queue review should store one memory');
      const stored = db.prepare(`
        SELECT type, content, scope, status
        FROM memory_current
        WHERE content = ?
      `).get('Alex prefers concise, direct answers.');
      assert.equal(Boolean(stored), true, 'stored memory must exist');
      assert.equal(String(stored.type), 'PREFERENCE');
      assert.equal(String(stored.scope), 'profile:main');
      assert.equal(String(stored.status), 'active');
      const queueRows = fs.readFileSync(queuePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(String(queueRows[0].status), 'resolved_auto', 'queue row should be auto-resolved');
      assert.equal(String(queueRows[0].resolved_reason), 'queue_review_store', 'queue row should record store resolution');
      assert.equal(fs.existsSync(result.artifactPath), true, 'queue review artifact must be written');
    } finally {
      db.close();
    }
  }

  {
    const temp = makeTempWorkspace('gb-v3-queue-review-append-');
    const raw = makeConfigObject(temp.workspace);
    raw.plugins.entries.gigabrain.config.llm.queueReview = {
      enabled: true,
      limit: 50,
      minConfidence: 0.8,
      profile: 'memory_review',
      allowedReasons: ['capture_missing_note'],
    };
    writeConfigFile(temp.configPath, raw);
    const { config } = loadConfig(temp.configPath);
    const queuePath = config.runtime.paths.reviewQueuePath;
    writeQueue(queuePath, [{
      status: 'pending',
      reason_code: 'capture_missing_note',
      timestamp: '2026-04-25T00:00:00.000Z',
      payload: {
        excerpt: 'Remember this: Alex prefers clean queue review writes.',
        source: 'assistant_reply',
      },
    }]);
    const db = openDb(temp.dbPath);
    try {
      const result = await reviewPendingQueue({
        db,
        config,
        dryRun: false,
        runId: 'test-run-append',
        reviewer: async () => {
          fs.appendFileSync(queuePath, `${JSON.stringify({
            status: 'pending',
            reason_code: 'capture_missing_note',
            timestamp: '2026-04-25T00:01:00.000Z',
            payload: {
              excerpt: 'Remember this: appended row must survive queue review.',
            },
          })}\n`, 'utf8');
          return {
            ok: true,
            parsed: {
              decision: 'store',
              confidence: 0.96,
              type: 'PREFERENCE',
              content: 'Alex prefers clean queue review writes.',
              scope: 'profile:main',
              reason: 'durable user preference',
            },
          };
        },
      });
      assert.equal(result.stored, 1, 'queue review should store the original row');
      const queueRows = fs.readFileSync(queuePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(queueRows.length, 2, 'queue review writeback should preserve rows appended during review');
      assert.equal(String(queueRows[0].status), 'resolved_auto', 'original row should be resolved');
      assert.equal(String(queueRows[1].status), 'pending', 'concurrent appended row should remain pending');
      assert.match(String(queueRows[1]?.payload?.excerpt || ''), /appended row must survive/, 'appended row content should be preserved');
    } finally {
      db.close();
    }
  }

  {
    const temp = makeTempWorkspace('gb-v3-queue-review-dup-');
    const raw = makeConfigObject(temp.workspace);
    raw.plugins.entries.gigabrain.config.llm.queueReview = {
      enabled: true,
      limit: 50,
      minConfidence: 0.8,
      profile: 'memory_review',
      allowedReasons: ['duplicate_semantic'],
    };
    writeConfigFile(temp.configPath, raw);
    const { config } = loadConfig(temp.configPath);
    const queuePath = config.runtime.paths.reviewQueuePath;
    const db = openDb(temp.dbPath);
    try {
      seedMemoryCurrent(db, [
        {
          memory_id: 'winner-1',
          type: 'DECISION',
          scope: 'profile:main',
          content: 'Use raw Discord mention tokens for exact bot tagging.',
          normalized: 'use raw discord mention tokens for exact bot tagging',
          status: 'active',
        },
        {
          memory_id: 'loser-1',
          type: 'DECISION',
          scope: 'profile:main',
          content: 'When exact Discord bot tagging matters, send the raw mention token.',
          normalized: 'when exact discord bot tagging matters send the raw mention token',
          status: 'active',
        },
      ]);
      writeQueue(queuePath, [{
        status: 'pending',
        reason_code: 'duplicate_semantic',
        similarity: 0.91,
        payload: {
          memory_id: 'winner-1',
          matched_memory_id: 'loser-1',
        },
      }]);
      const result = await reviewPendingQueue({
        db,
        config,
        dryRun: false,
        runId: 'test-run-dup',
        reviewer: makeReviewer({
          decision: 'archive_loser',
          confidence: 0.93,
          reason: 'same durable fact',
        }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.duplicateArchived, 1, 'queue review should archive one duplicate');
      const loser = db.prepare('SELECT status, superseded_by FROM memory_current WHERE memory_id = ?').get('loser-1');
      assert.equal(String(loser.status), 'archived', 'loser must be archived');
      assert.equal(String(loser.superseded_by), 'winner-1', 'loser must point at winner');
      const queueRows = fs.readFileSync(queuePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(String(queueRows[0].status), 'resolved_auto', 'duplicate row should be auto-resolved');
      assert.equal(String(queueRows[0].resolved_reason), 'queue_review_duplicate_archive', 'duplicate row should record archive resolution');
    } finally {
      db.close();
    }
  }

  {
    const temp = makeTempWorkspace('gb-v3-queue-review-legacy-semantic-');
    const raw = makeConfigObject(temp.workspace);
    raw.plugins.entries.gigabrain.config.llm.queueReview = {
      enabled: true,
      limit: 50,
      minConfidence: 0.8,
      profile: 'memory_review',
      allowedReasons: ['duplicate_semantic'],
    };
    writeConfigFile(temp.configPath, raw);
    const { config } = loadConfig(temp.configPath);
    const queuePath = config.runtime.paths.reviewQueuePath;
    const db = openDb(temp.dbPath);
    try {
      seedMemoryCurrent(db, [
        {
          memory_id: 'existing-1',
          type: 'DECISION',
          scope: 'profile:main',
          content: 'Use a dedicated worker thread for sync browser work in async services.',
          normalized: 'use a dedicated worker thread for sync browser work in async services',
          status: 'active',
        },
      ]);
      writeQueue(queuePath, [{
        status: 'pending',
        reason: 'semantic_borderline',
        reason_code: 'capture_review_required',
        similarity: 0.84,
        payload: {
          type: 'DECISION',
          content: 'Run sync browser work on a dedicated worker thread instead of inside the event loop.',
          matched_memory_id: 'existing-1',
          matched_content: 'Use a dedicated worker thread for sync browser work in async services.',
          scope: 'profile:main',
        },
      }]);
      const result = await reviewPendingQueue({
        db,
        config,
        dryRun: false,
        runId: 'test-run-legacy-semantic',
        reviewer: makeReviewer({
          decision: 'keep_both',
          confidence: 0.91,
          reason: 'candidate and existing memory overlap but winner is not explicit',
        }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.keptBoth, 1, 'legacy semantic_borderline rows should resolve as duplicate review, not capture store');
      assert.equal(result.stored, 0, 'legacy semantic_borderline rows must not try to store and requeue themselves');
      const queueRows = fs.readFileSync(queuePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(String(queueRows[0].status), 'resolved_auto', 'legacy semantic duplicate row should be auto-resolved');
      assert.equal(String(queueRows[0].resolved_reason), 'queue_review_keep_both', 'legacy semantic duplicate row should record keep-both resolution');
    } finally {
      db.close();
    }
  }

};

export {
  run,
};

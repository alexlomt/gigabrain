import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { buildVaultSurface, loadSurfaceSummary } from '../lib/core/vault-mirror.js';
import { refreshGeneratedMemorySurface } from '../lib/core/surface-refresh-service.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v7-surface-refresh-');
  fs.writeFileSync(path.join(ws.workspace, 'MEMORY.md'), '# MEMORY\n\n- Surface refresh test fixture.\n', 'utf8');

  const openclaw = makeConfigObject(ws.workspace);
  openclaw.plugins.entries.gigabrain.config.vault = {
    enabled: true,
    path: 'obsidian-vault',
    subdir: 'Gigabrain',
    clean: true,
    homeNoteName: 'Home',
    exportActiveNodes: true,
    exportRecentArchivesLimit: 20,
    manualFolders: ['Inbox', 'Manual'],
    views: { enabled: true },
    reports: { enabled: true },
  };
  openclaw.plugins.entries.gigabrain.config.recall.semanticRerankEnabled = false;
  const config = normalizeConfig(openclaw.plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);

  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'surface-1',
        type: 'PREFERENCE',
        content: 'Jordan prefers generated memory surfaces to match live registry counts.',
        scope: 'profile:main',
        confidence: 0.92,
        value_score: 0.91,
        value_label: 'keep',
      },
    ]);

    const initial = buildVaultSurface({
      db,
      config,
      dryRun: false,
      runId: 'surface-refresh-initial',
    });
    assert.equal(initial.enabled, true, 'initial surface build should be enabled');
    assert.equal(initial.active_nodes, 1, 'initial surface should export one active node');

    seedMemoryCurrent(db, [
      {
        memory_id: 'surface-2',
        type: 'DECISION',
        content: 'Generated memory surfaces should be refreshed after post-maintenance mutations.',
        scope: 'profile:main',
        confidence: 0.93,
        value_score: 0.92,
        value_label: 'keep',
      },
    ]);

    const refreshed = refreshGeneratedMemorySurface({
      db,
      dbPath: ws.dbPath,
      config,
      reason: 'unit_test_surface_drift',
      runId: 'surface-refresh-test',
      rebuildGraph: false,
    });
    assert.equal(refreshed.ok, true, 'dirty surface refresh should succeed');
    assert.equal(refreshed.skipped, false, 'dirty surface refresh should not skip');
    assert.equal(refreshed.vault?.active_nodes, 2, 'refreshed surface should export two active nodes');
    assert.equal(refreshed.after?.vault?.stale, false, 'post-refresh health should be clean');
    assert.equal(Object.prototype.hasOwnProperty.call(refreshed, 'nodes'), false, 'refresh result must not expose raw memory nodes');
    assert.equal(Object.prototype.hasOwnProperty.call(refreshed, 'recent_archives'), false, 'refresh result must not expose archive contents');

    const loaded = loadSurfaceSummary({ config }).summary;
    assert.equal(Number(loaded?.active_nodes || 0), 2, 'written summary should match live active node count');
    assert.equal(Number(loaded?.counts?.by_status?.active || 0), 2, 'written summary status count should match live active count');

    const second = refreshGeneratedMemorySurface({
      db,
      dbPath: ws.dbPath,
      config,
      reason: 'unit_test_surface_current',
      runId: 'surface-refresh-test-current',
      rebuildGraph: false,
    });
    assert.equal(second.ok, true, 'current surface check should succeed');
    assert.equal(second.skipped, true, 'current surface should skip rebuild');
    assert.equal(second.reason, 'surface_current', 'current surface should report why it skipped');
  } finally {
    db.close();
  }
};

export { run };

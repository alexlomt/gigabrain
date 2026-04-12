import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { promoteNativeChunks, reconcilePromotedNativeRows } from '../lib/core/native-promotion.js';
import { syncNativeMemory } from '../lib/core/native-sync.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const runNativeCycle = ({ db, config }) => {
  const syncSummary = syncNativeMemory({
    db,
    config,
    dryRun: false,
  });
  const promotion = promoteNativeChunks({
    db,
    config,
    sourcePaths: syncSummary.changed_sources,
    dryRun: false,
  });
  const reconciliation = reconcilePromotedNativeRows({
    db,
    dryRun: false,
  });
  return {
    syncSummary,
    promotion,
    reconciliation,
  };
};

const run = async () => {
  const ws = makeTempWorkspace('gb-v4-native-promotion-');
  try {
    fs.writeFileSync(path.join(ws.workspace, 'MEMORY.md'), '# MEMORY\n\n## Preferences\n\n- Jordan prefers pour-over coffee.\n', 'utf8');
    fs.writeFileSync(path.join(ws.memoryRoot, `${new Date().toISOString().slice(0, 10)}.md`), '# Daily\n\n## Session Notes\n\n- Jordan is travelling today and tired.\n', 'utf8');

    const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
    const db = openDb(ws.dbPath);
    try {
      const { syncSummary, promotion, reconciliation } = runNativeCycle({ db, config });
      assert.equal(syncSummary.changed_files >= 2, true, 'native sync should see fresh MEMORY + daily files');
      assert.equal(promotion.promoted_inserted, 1, 'durable MEMORY.md bullet should promote into registry');
      assert.equal(reconciliation.rejected_orphaned, 0, 'freshly promoted rows should not be rejected');

      const promoted = db.prepare(`
        SELECT content, type, source, source_layer, source_path, source_line, scope
        FROM memory_current
        WHERE source = 'promoted_native'
        ORDER BY updated_at DESC
        LIMIT 1
      `).get();
      assert.equal(String(promoted?.type || ''), 'PREFERENCE');
      assert.equal(String(promoted?.source_layer || ''), 'promoted_native');
      assert.match(String(promoted?.source_path || ''), /MEMORY\.md$/, 'promoted row should point back to MEMORY.md');
      assert.equal(Number(promoted?.source_line || 0) > 0, true, 'promoted row should carry native line number');
      assert.equal(String(promoted?.scope || ''), 'profile:main', 'MEMORY.md promotions should stay in main profile scope');

      const dailyPromoted = db.prepare(`
        SELECT COUNT(*) AS c
        FROM memory_current
        WHERE content LIKE '%travelling today and tired%'
      `).get();
      assert.equal(Number(dailyPromoted?.c || 0), 0, 'situational daily note should not auto-promote into registry');

      const linkedChunks = db.prepare(`
        SELECT COUNT(*) AS c
        FROM memory_native_chunks
        WHERE linked_memory_id IS NOT NULL
      `).get();
      assert.equal(Number(linkedChunks?.c || 0) >= 1, true, 'promoted native chunk should be linked back to the promoted registry id');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }

  const legacyWs = makeTempWorkspace('gb-v4-native-promotion-legacy-');
  try {
    const memoryPath = path.join(legacyWs.workspace, 'MEMORY.md');
    fs.writeFileSync(memoryPath, '# MEMORY\n\n## Preferences\n\n- Jordan prefers pour-over coffee.\n', 'utf8');

    const config = normalizeConfig(makeConfigObject(legacyWs.workspace).plugins.entries.gigabrain.config);
    const db = openDb(legacyWs.dbPath);
    try {
      syncNativeMemory({ db, config, dryRun: false });
      seedMemoryCurrent(db, [
        {
          memory_id: 'legacy-native-row',
          type: 'PREFERENCE',
          content: 'Jordan prefers pour-over coffee.',
          source: 'promoted_native',
          source_layer: 'promoted_native',
          source_path: memoryPath,
          source_line: 4,
          scope: 'profile:main',
          confidence: 0.86,
          value_score: 0.82,
          value_label: 'core',
        },
      ]);

      const linksBefore = db.prepare(`
        SELECT COUNT(*) AS c
        FROM memory_native_chunks
        WHERE linked_memory_id = 'legacy-native-row'
      `).get();
      assert.equal(Number(linksBefore?.c || 0), 0, 'legacy row should start without native chunk links');

      const reconciliation = reconcilePromotedNativeRows({
        db,
        dryRun: false,
      });
      assert.equal(reconciliation.relinked_rows, 1, 'reconciliation should relink valid legacy promoted rows before rejecting them');

      const row = db.prepare(`
        SELECT status
        FROM memory_current
        WHERE memory_id = 'legacy-native-row'
      `).get();
      assert.equal(String(row?.status || ''), 'active', 'legacy promoted row with matching active chunk should remain active');

      const linksAfter = db.prepare(`
        SELECT COUNT(*) AS c
        FROM memory_native_chunks
        WHERE linked_memory_id = 'legacy-native-row'
          AND status = 'active'
      `).get();
      assert.equal(Number(linksAfter?.c || 0), 1, 'reconciliation should relink the matching active native chunk');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(legacyWs.root, { recursive: true, force: true });
  }
};

export { run };

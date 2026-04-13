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

  const dailyWs = makeTempWorkspace('gb-v4-native-promotion-daily-');
  try {
    const dailyPath = path.join(dailyWs.memoryRoot, '2026-04-13.md');
    fs.writeFileSync(dailyPath, [
      '# 2026-04-13',
      '',
      '## Preferences',
      '',
      '- Avery prefers weekly reporting cadence. <!-- gigabrain:scope=profile:main -->',
      '',
      '## Remembered Today',
      '',
      '- Avery prefers quiet Fridays. <!-- gigabrain:scope=profile:main type=PREFERENCE -->',
      '- Avery is tired today. <!-- gigabrain:scope=profile:main -->',
      '',
    ].join('\n'), 'utf8');

    const config = normalizeConfig(makeConfigObject(dailyWs.workspace).plugins.entries.gigabrain.config);
    const db = openDb(dailyWs.dbPath);
    try {
      const { promotion } = runNativeCycle({ db, config });
      assert.equal(promotion.promoted_inserted, 2, 'daily notes should preserve scope and explicit type metadata for durable promotions');

      const weekly = db.prepare(`
        SELECT type, scope, source_path
        FROM memory_current
        WHERE content = 'Avery prefers weekly reporting cadence.'
        LIMIT 1
      `).get();
      assert.equal(String(weekly?.type || ''), 'PREFERENCE', 'daily preference section should promote as preference');
      assert.equal(String(weekly?.scope || ''), 'profile:main', 'daily preference section should preserve profile scope');
      assert.equal(String(weekly?.source_path || ''), dailyPath, 'daily preference promotion should point back to the daily note');

      const remembered = db.prepare(`
        SELECT type, scope
        FROM memory_current
        WHERE content = 'Avery prefers quiet Fridays.'
        LIMIT 1
      `).get();
      assert.equal(String(remembered?.type || ''), 'PREFERENCE', 'Remembered Today metadata should preserve semantic type on promotion');
      assert.equal(String(remembered?.scope || ''), 'profile:main', 'Remembered Today metadata should preserve profile scope on promotion');

      const situational = db.prepare(`
        SELECT COUNT(*) AS c
        FROM memory_current
        WHERE content = 'Avery is tired today.'
      `).get();
      assert.equal(Number(situational?.c || 0), 0, 'situational daily note should still stay out of durable memory');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dailyWs.root, { recursive: true, force: true });
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

  const legacyRepairWs = makeTempWorkspace('gb-v4-native-promotion-repair-');
  try {
    const dailyPath = path.join(legacyRepairWs.memoryRoot, '2026-04-13.md');
    fs.writeFileSync(dailyPath, [
      '# 2026-04-13',
      '',
      '## Remembered Today',
      '',
      '- Avery prefers quiet Fridays. <!-- gigabrain:scope=profile:main type=PREFERENCE -->',
      '',
    ].join('\n'), 'utf8');

    const config = normalizeConfig(makeConfigObject(legacyRepairWs.workspace).plugins.entries.gigabrain.config);
    const db = openDb(legacyRepairWs.dbPath);
    try {
      syncNativeMemory({ db, config, dryRun: false });
      seedMemoryCurrent(db, [
        {
          memory_id: 'legacy-promoted-wrong-metadata',
          type: 'USER_FACT',
          content: 'Avery prefers quiet Fridays.',
          source: 'promoted_native',
          source_layer: 'promoted_native',
          source_path: dailyPath,
          source_line: 5,
          scope: 'shared',
          confidence: 0.72,
          value_score: 0.82,
          value_label: 'core',
        },
      ]);

      const reconciliation = reconcilePromotedNativeRows({
        db,
        dryRun: false,
      });
      assert.equal(reconciliation.relinked_rows, 1, 'reconciliation should relink legacy promoted rows with matching daily chunks');
      assert.equal(reconciliation.metadata_repaired, 1, 'reconciliation should repair wrong scope/type from linked native metadata');

      const repaired = db.prepare(`
        SELECT type, scope, status
        FROM memory_current
        WHERE memory_id = 'legacy-promoted-wrong-metadata'
      `).get();
      assert.equal(String(repaired?.type || ''), 'PREFERENCE', 'reconciliation should repair legacy promoted type from native metadata');
      assert.equal(String(repaired?.scope || ''), 'profile:main', 'reconciliation should repair legacy promoted scope from native metadata');
      assert.equal(String(repaired?.status || ''), 'active', 'repaired legacy promoted row should stay active');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(legacyRepairWs.root, { recursive: true, force: true });
  }
};

export { run };

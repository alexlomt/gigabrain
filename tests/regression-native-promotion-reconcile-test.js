import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { normalizeContent } from '../lib/core/policy.js';
import { upsertCurrentMemory } from '../lib/core/projection-store.js';
import { makeConfigObject, makeTempWorkspace, openDb } from './helpers.js';

const todayKey = () => new Date().toISOString().slice(0, 10);

const runMaintain = ({ ws, config, runId }) => runMaintenance({
  dbPath: ws.dbPath,
  config,
  dryRun: false,
  runId,
  reviewVersion: `rv-${runId}`,
});

const getRowByContent = (db, content) => db.prepare(`
  SELECT memory_id, status, source_path
  FROM memory_current
  WHERE content = ?
  ORDER BY updated_at DESC
  LIMIT 1
`).get(content);

const getStatus = (db, memoryId) => db.prepare(`
  SELECT status
  FROM memory_current
  WHERE memory_id = ?
`).get(memoryId)?.status || '';

const getActiveLinkCount = (db, memoryId) => Number(db.prepare(`
  SELECT COUNT(*) AS c
  FROM memory_native_chunks
  WHERE linked_memory_id = ?
    AND status = 'active'
`).get(memoryId)?.c || 0);

const run = async () => {
  const editWs = makeTempWorkspace('gb-v4-native-reconcile-edit-');
  try {
    const config = normalizeConfig(makeConfigObject(editWs.workspace).plugins.entries.gigabrain.config);
    const memoryPath = path.join(editWs.workspace, 'MEMORY.md');
    fs.writeFileSync(memoryPath, '# MEMORY\n\n## Preferences\n\n- Jordan prefers pour-over coffee.\n', 'utf8');

    runMaintain({ ws: editWs, config, runId: 'native-edit-1' });
    let db = openDb(editWs.dbPath);
    const original = getRowByContent(db, 'Jordan prefers pour-over coffee.');
    db.close();
    assert.equal(Boolean(original?.memory_id), true, 'initial native fact should promote during maintenance');

    fs.writeFileSync(memoryPath, '# MEMORY\n\n## Preferences\n\n- Jordan prefers espresso over filter coffee.\n', 'utf8');
    runMaintain({ ws: editWs, config, runId: 'native-edit-2' });

    db = openDb(editWs.dbPath);
    try {
      assert.equal(String(getStatus(db, original.memory_id)), 'rejected', 'edited-away promoted native row should be rejected after maintenance');
      const replacement = getRowByContent(db, 'Jordan prefers espresso over filter coffee.');
      assert.equal(String(replacement?.status || ''), 'active', 'replacement native fact should promote cleanly after edit');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(editWs.root, { recursive: true, force: true });
  }

  const deleteWs = makeTempWorkspace('gb-v4-native-reconcile-delete-');
  try {
    const config = normalizeConfig(makeConfigObject(deleteWs.workspace).plugins.entries.gigabrain.config);
    const notePath = path.join(deleteWs.memoryRoot, `${todayKey()}-delete.md`);
    fs.writeFileSync(notePath, '# Daily\n\n## Preferences\n\n- Jordan prefers pour-over coffee.\n', 'utf8');

    runMaintain({ ws: deleteWs, config, runId: 'native-delete-1' });
    let db = openDb(deleteWs.dbPath);
    const original = getRowByContent(db, 'Jordan prefers pour-over coffee.');
    db.close();
    assert.equal(Boolean(original?.memory_id), true, 'daily durable fact should promote before deletion');

    fs.unlinkSync(notePath);
    runMaintain({ ws: deleteWs, config, runId: 'native-delete-2' });

    db = openDb(deleteWs.dbPath);
    try {
      assert.equal(String(getStatus(db, original.memory_id)), 'rejected', 'deleted native source should reject the orphaned promoted row');
      assert.equal(getActiveLinkCount(db, original.memory_id), 0, 'deleted source should leave no active native links');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(deleteWs.root, { recursive: true, force: true });
  }

  const nativeLayerWs = makeTempWorkspace('gb-v4-native-reconcile-native-layer-');
  try {
    const config = normalizeConfig(makeConfigObject(nativeLayerWs.workspace).plugins.entries.gigabrain.config);
    const memoryPath = path.join(nativeLayerWs.workspace, 'MEMORY.md');
    fs.writeFileSync(memoryPath, '# MEMORY\n\n## Preferences\n\n- Jordan prefers espresso.\n', 'utf8');

    let db = openDb(nativeLayerWs.dbPath);
    try {
      upsertCurrentMemory(db, {
        memory_id: 'native-stale-row',
        type: 'PREFERENCE',
        content: 'Jordan prefers stale native test coffee.',
        normalized: normalizeContent('Jordan prefers stale native test coffee.'),
        source: 'capture',
        source_layer: 'native',
        source_path: memoryPath,
        source_line: 5,
        confidence: 0.9,
        scope: 'profile:main',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } finally {
      db.close();
    }

    runMaintain({ ws: nativeLayerWs, config, runId: 'native-layer-stale-1' });

    db = openDb(nativeLayerWs.dbPath);
    try {
      assert.equal(String(getStatus(db, 'native-stale-row')), 'rejected', 'source_layer=native rows whose source content disappeared should be rejected');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(nativeLayerWs.root, { recursive: true, force: true });
  }

  const scopeAliasWs = makeTempWorkspace('gb-v4-native-scope-alias-');
  try {
    const config = normalizeConfig(makeConfigObject(scopeAliasWs.workspace).plugins.entries.gigabrain.config);
    const memoryPath = path.join(scopeAliasWs.workspace, 'MEMORY.md');
    const content = 'Jordan prefers clean native scope dedupe.';
    fs.writeFileSync(memoryPath, `# MEMORY\n\n## Preferences\n\n- ${content} <!-- gigabrain:scope=main type=PREFERENCE -->\n`, 'utf8');

    let db = openDb(scopeAliasWs.dbPath);
    try {
      upsertCurrentMemory(db, {
        memory_id: 'scope-existing-row',
        type: 'PREFERENCE',
        content,
        normalized: normalizeContent(content),
        source: 'capture',
        source_layer: 'registry',
        confidence: 0.9,
        scope: 'profile:main',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } finally {
      db.close();
    }

    runMaintain({ ws: scopeAliasWs, config, runId: 'native-scope-alias-1' });

    db = openDb(scopeAliasWs.dbPath);
    try {
      const activeDuplicates = db.prepare(`
        SELECT COUNT(*) AS c
        FROM memory_current
        WHERE content = ?
          AND status = 'active'
      `).get(content);
      assert.equal(Number(activeDuplicates?.c || 0), 1, 'native scope=main should dedupe against profile:main rows');
      assert.equal(getActiveLinkCount(db, 'scope-existing-row') >= 1, true, 'scope-alias native chunk should link to existing profile:main memory');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(scopeAliasWs.root, { recursive: true, force: true });
  }

  const crossScopeWs = makeTempWorkspace('gb-v4-cross-scope-exact-dedupe-');
  try {
    const config = normalizeConfig(makeConfigObject(crossScopeWs.workspace).plugins.entries.gigabrain.config);
    const content = 'User prefers setup work done cleanly.';
    let db = openDb(crossScopeWs.dbPath);
    try {
      for (const [memoryId, scope] of [['cross-shared-row', 'shared'], ['cross-profile-row', 'profile:main']]) {
        upsertCurrentMemory(db, {
          memory_id: memoryId,
          type: 'PREFERENCE',
          content,
          normalized: normalizeContent(content),
          source: 'capture',
          source_layer: 'registry',
          confidence: 0.9,
          scope,
          status: 'active',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    } finally {
      db.close();
    }

    runMaintain({ ws: crossScopeWs, config, runId: 'cross-scope-dedupe-1' });

    db = openDb(crossScopeWs.dbPath);
    try {
      const activeDuplicates = db.prepare(`
        SELECT COUNT(*) AS c
        FROM memory_current
        WHERE content = ?
          AND status = 'active'
      `).get(content);
      assert.equal(Number(activeDuplicates?.c || 0), 1, 'exact duplicate content should not stay active across shared/profile:main scopes');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(crossScopeWs.root, { recursive: true, force: true });
  }

  const priorityWs = makeTempWorkspace('gb-v4-dedupe-priority-');
  try {
    const config = normalizeConfig(makeConfigObject(priorityWs.workspace).plugins.entries.gigabrain.config);
    const content = 'User prefers deterministic memory dedupe priority.';
    let db = openDb(priorityWs.dbPath);
    try {
      upsertCurrentMemory(db, {
        memory_id: 'priority-registry-row',
        type: 'PREFERENCE',
        content,
        normalized: normalizeContent(content),
        source: 'capture',
        source_layer: 'registry',
        confidence: 0.99,
        scope: 'profile:main',
        status: 'active',
        created_at: new Date(Date.now() + 1000).toISOString(),
        updated_at: new Date(Date.now() + 1000).toISOString(),
      });
      upsertCurrentMemory(db, {
        memory_id: 'priority-promoted-row',
        type: 'PREFERENCE',
        content,
        normalized: normalizeContent(content),
        source: 'native',
        source_layer: 'promoted_native',
        confidence: 0.9,
        scope: 'profile:main',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } finally {
      db.close();
    }

    runMaintain({ ws: priorityWs, config, runId: 'dedupe-priority-1' });

    db = openDb(priorityWs.dbPath);
    try {
      assert.equal(String(getStatus(db, 'priority-promoted-row')), 'active', 'promoted/native-backed row should win exact dedupe over registry');
      assert.equal(String(getStatus(db, 'priority-registry-row')), 'archived', 'registry duplicate should lose to promoted/native-backed row');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(priorityWs.root, { recursive: true, force: true });
  }

  const moveWs = makeTempWorkspace('gb-v4-native-reconcile-move-');
  try {
    const config = normalizeConfig(makeConfigObject(moveWs.workspace).plugins.entries.gigabrain.config);
    const noteA = path.join(moveWs.memoryRoot, `${todayKey()}-move-a.md`);
    const noteB = path.join(moveWs.memoryRoot, `${todayKey()}-move-b.md`);
    fs.writeFileSync(noteA, '# Daily\n\n## Preferences\n\n- Jordan prefers pour-over coffee.\n', 'utf8');

    runMaintain({ ws: moveWs, config, runId: 'native-move-1' });
    let db = openDb(moveWs.dbPath);
    const original = getRowByContent(db, 'Jordan prefers pour-over coffee.');
    db.close();
    assert.equal(Boolean(original?.memory_id), true, 'movable native fact should promote before relocation');

    fs.unlinkSync(noteA);
    fs.writeFileSync(noteB, '# Daily\n\n## Preferences\n\n- Jordan prefers pour-over coffee.\n', 'utf8');
    runMaintain({ ws: moveWs, config, runId: 'native-move-2' });

    db = openDb(moveWs.dbPath);
    try {
      assert.equal(String(getStatus(db, original.memory_id)), 'active', 'moved native fact should stay active when the same fact exists in a new note');
      assert.equal(getActiveLinkCount(db, original.memory_id) >= 1, true, 'moved native fact should relink to an active native chunk');
      const activeDuplicates = db.prepare(`
        SELECT COUNT(*) AS c
        FROM memory_current
        WHERE content = 'Jordan prefers pour-over coffee.'
          AND status = 'active'
      `).get();
      assert.equal(Number(activeDuplicates?.c || 0), 1, 'moving a fact between notes should not create active duplicate promoted rows');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(moveWs.root, { recursive: true, force: true });
  }
};

export { run };

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hashNormalized, normalizeContent } from '../lib/core/policy.js';
import {
  exportMemoryBrief,
  getSyncStatus,
  listMemorySources,
  syncHostMemories,
} from '../lib/core/host-memory-sync.js';
import { recordVerdict, updateCurrentStatus, upsertCurrentMemory } from '../lib/core/projection-store.js';
import { makeTempWorkspace, openDb } from './helpers.js';

const writeText = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

// U1 (R1/KTD2): re-sync must never resurrect arbitration losers. A superseded or
// rejected canonical row only gets its source link refreshed; the upsert is
// skipped and a debug-level `sync:skipped_superseded` ledger event records why.
const runStatusAwareResync = async () => {
  const temp = makeTempWorkspace('gb-host-resync-');
  const db = openDb(temp.dbPath);
  const codexHome = path.join(temp.root, 'codex-home');
  const codexMemory = path.join(codexHome, 'memories', 'prefs.md');
  const loserLine = 'User prefers tabs over spaces for indentation.';
  const rejectedLine = 'User keeps drafts in the scratch folder.';
  const activeLine = 'User reviews pull requests every morning.';
  const config = {
    runtime: { paths: { workspaceRoot: temp.workspace } },
    codex: { projectRoot: temp.workspace, defaultUserScope: 'profile:user' },
  };
  const syncOptions = { db, config, codexHome, hosts: ['codex'], scope: 'profile:user' };
  const rowFor = (line) => db.prepare(`
    SELECT memory_id, status, superseded_by, content, updated_at
    FROM memory_current
    WHERE normalized_hash = ? AND scope = 'profile:user'
  `).get(hashNormalized(normalizeContent(line)));
  const skipEventsFor = (memoryId) => db.prepare(`
    SELECT memory_id, reason_codes, payload
    FROM memory_events
    WHERE action = 'sync:skipped_superseded' AND memory_id = ?
  `).all(memoryId);

  try {
    writeText(codexMemory, `- ${loserLine}\n- ${rejectedLine}\n- ${activeLine}\n`);
    const seed = syncHostMemories(syncOptions);
    assert.equal(seed.ok, true, 'seed sync should succeed');
    assert.equal(seed.inserted_count, 3, 'seed sync should import all three lines');

    const loser = rowFor(loserLine);
    const rejected = rowFor(rejectedLine);
    upsertCurrentMemory(db, {
      memory_id: 'fact:winner',
      type: 'USER_FACT',
      content: 'User prefers spaces over tabs for indentation.',
      normalized: normalizeContent('User prefers spaces over tabs for indentation.'),
      source: 'capture',
      source_agent: 'main',
      scope: 'profile:user',
      status: 'active',
    });
    recordVerdict(db, { winnerId: 'fact:winner', loserIds: [loser.memory_id], reason: 'recency' });
    updateCurrentStatus(db, rejected.memory_id, 'rejected');

    // Scenario 1: re-sync the unchanged source file -> the superseded loser
    // stays superseded with its verdict intact; only the link is refreshed.
    const linkBefore = db.prepare(`
      SELECT last_seen_at FROM memory_source_links WHERE memory_id = ?
    `).get(loser.memory_id);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    const resync = syncHostMemories(syncOptions);
    assert.equal(resync.ok, true, 're-sync should succeed');
    assert.equal(resync.inserted_count, 0, 're-sync must not insert fresh rows for existing lines');
    const loserAfter = rowFor(loserLine);
    assert.equal(loserAfter.status, 'superseded', 're-sync must not resurrect a superseded loser');
    assert.equal(loserAfter.superseded_by, 'fact:winner', 're-sync must keep superseded_by intact');
    const linkAfter = db.prepare(`
      SELECT last_seen_at, status FROM memory_source_links WHERE memory_id = ?
    `).get(loser.memory_id);
    assert.equal(linkAfter.status, 'active', 're-sync should keep the provenance link active');
    assert.equal(linkAfter.last_seen_at > linkBefore.last_seen_at, true, 're-sync should refresh the source link');
    const loserEvents = skipEventsFor(loser.memory_id);
    assert.equal(loserEvents.length, 1, 're-sync should ledger one skipped_superseded event for the loser');
    // Ledger-growth guard (review finding): a second re-sync over the UNCHANGED
    // store must not append another skip event — once per (memory, content_hash).
    syncHostMemories(syncOptions);
    assert.equal(skipEventsFor(loser.memory_id).length, 1, 'repeat re-sync must not re-append skip events for an unchanged line');
    assert.equal(JSON.parse(loserEvents[0].reason_codes).includes('debug'), true, 'skip event should be debug-level');
    assert.equal(JSON.parse(loserEvents[0].payload).status, 'superseded', 'skip event payload should carry the row status');

    // Scenario 4: rejected rows behave like superseded ones.
    const rejectedAfter = rowFor(rejectedLine);
    assert.equal(rejectedAfter.status, 'rejected', 're-sync must not resurrect a rejected row');
    assert.equal(skipEventsFor(rejected.memory_id).length, 1, 're-sync should ledger the rejected skip too');

    // Scenario 3 (regression): active rows still sync normally, no skip event.
    const activeAfter = rowFor(activeLine);
    assert.equal(activeAfter.status, 'active', 'active rows should stay active across re-sync');
    assert.equal(skipEventsFor(activeAfter.memory_id).length, 0, 'active rows should not emit skip events');

    // Scenario 2: the source line is edited (new hash) -> a new memory may be
    // created, but the superseded row is untouched.
    const editedLine = `${loserLine} Always.`;
    writeText(codexMemory, `- ${editedLine}\n- ${rejectedLine}\n- ${activeLine}\n`);
    const edited = syncHostMemories(syncOptions);
    assert.equal(edited.ok, true, 'edited-line sync should succeed');
    assert.equal(edited.inserted_count, 1, 'edited line should import as one new memory');
    const editedRow = rowFor(editedLine);
    assert.equal(editedRow.status, 'active', 'the edited line becomes a fresh active memory');
    assert.notEqual(editedRow.memory_id, loser.memory_id, 'the edited line must not reuse the loser memory id');
    const loserFinal = rowFor(loserLine);
    assert.equal(loserFinal.status, 'superseded', 'editing the source line must leave the superseded row untouched');
    assert.equal(loserFinal.superseded_by, 'fact:winner', 'the superseded verdict survives the source edit');
    assert.equal(loserFinal.content, loserLine, 'the superseded row content is untouched');
  } finally {
    db.close();
  }
};

const run = async () => {
  await runStatusAwareResync();
  const temp = makeTempWorkspace('gb-host-sync-');
  const db = openDb(temp.dbPath);
  const codexHome = path.join(temp.root, 'codex-home');
  const claudeHome = path.join(temp.root, 'claude-home');
  const hermesHome = path.join(temp.root, 'hermes-home');
  const codexMemory = path.join(codexHome, 'memories', 'prefs.md');
  const claudeMemory = path.join(claudeHome, 'projects', 'example', 'memory', 'prefs.md');
  const hermesMemory = path.join(hermesHome, 'memories', 'MEMORY.md');
  const manualImport = path.join(temp.root, 'exports', 'chatgpt-export.md');
  const sharedLine = 'User prefers concise setup docs.';
  const secretValue = 'synthetic-runtime-token';
  const config = {
    runtime: {
      paths: {
        workspaceRoot: temp.workspace,
      },
    },
    codex: {
      projectRoot: temp.workspace,
      defaultUserScope: 'profile:user',
    },
  };

  try {
    writeText(codexMemory, `- ${sharedLine}\n- OPENAI_API_KEY=${secretValue}\n`);
    writeText(claudeMemory, `- ${sharedLine}\n`);
    writeText(hermesMemory, '- Hermes should recall fictional Atlas through Gigabrain MCP.\n');

    const sync = syncHostMemories({
      db,
      config,
      codexHome,
      claudeHome,
      hermesHome,
      hosts: ['codex', 'claude_code'],
      scope: 'profile:user',
    });
    assert.equal(sync.ok, true, 'host sync should succeed');
    assert.deepEqual(sync.summary, {
      source_count: 2,
      indexed_count: 3,
      inserted_count: 2,
      linked_count: 3,
      skipped_count: 0,
      // Feature #2/#3 additive counters: a non-incremental sync of two
      // non-conflicting sources skips nothing and produces zero verdicts.
      unchanged_sources: 0,
      arbitration_verdicts: 0,
    }, 'host sync should return compact summary counts');
    assert.equal(sync.indexed_count, 3, 'host sync should index all visible local lines');
    assert.equal(sync.linked_count, 3, 'host sync should link every imported line to provenance');
    assert.equal(Array.isArray(sync.warnings), true, 'host sync should return warnings array');

    const sharedHash = hashNormalized(normalizeContent(sharedLine));
    const sharedRows = db.prepare(`
      SELECT memory_id, source_host, source_kind, sync_policy
      FROM memory_current
      WHERE normalized_hash = ? AND scope = 'profile:user' AND status = 'active'
    `).all(sharedHash);
    assert.equal(sharedRows.length, 1, 'exact host duplicates should collapse to one current memory');
    assert.equal(sharedRows[0].source_host, 'codex', 'the first importer keeps canonical metadata');
    assert.equal(sharedRows[0].source_kind, 'native_memory');
    assert.equal(sharedRows[0].sync_policy, 'read_only');

    const links = db.prepare(`
      SELECT source_host, source_kind, sync_policy, source_path, source_line
      FROM memory_source_links
      WHERE memory_id = ?
      ORDER BY source_host ASC
    `).all(sharedRows[0].memory_id);
    assert.deepEqual(
      links.map((row) => row.source_host),
      ['claude_code', 'codex'],
      'deduped memories should retain both host provenance links',
    );
    assert.equal(links.every((row) => row.source_kind === 'native_memory'), true, 'local host links should be native memories');
    assert.equal(links.every((row) => row.sync_policy === 'read_only'), true, 'local host links should be read-only');

    const storedText = db.prepare("SELECT GROUP_CONCAT(content, '\n') AS text FROM memory_current").get()?.text || '';
    assert.equal(storedText.includes(secretValue), false, 'host sync must not store raw secrets');
    assert.equal(storedText.includes('[REDACTED_SECRET]'), true, 'host sync should leave a visible redaction marker');

    const sources = listMemorySources({ db, config });
    assert.equal(sources.sources.some((row) => row.source_host === 'codex' && row.memory_count >= 2), true, 'sources should include Codex counts');
    assert.equal(sources.sources.some((row) => row.source_host === 'claude_code' && row.memory_count >= 1), true, 'sources should include Claude Code counts');

    const hermes = syncHostMemories({
      db,
      config,
      hermesHome,
      hosts: ['hermes'],
      scope: 'profile:user',
    });
    assert.equal(hermes.ok, true, 'Hermes host sync should succeed');
    assert.equal(hermes.summary.source_count, 1, 'Hermes sync should see the Hermes memories folder');
    assert.equal(hermes.summary.inserted_count, 1, 'Hermes sync should import one local memory line');
    const hermesRow = db.prepare(`
      SELECT source_host, source_kind, sync_policy
      FROM memory_current
      WHERE content LIKE '%Atlas through Gigabrain MCP%'
      LIMIT 1
    `).get();
    assert.equal(hermesRow.source_host, 'hermes');
    assert.equal(hermesRow.source_kind, 'native_memory');
    assert.equal(hermesRow.sync_policy, 'read_only');

    const status = getSyncStatus({ db, config, codexHome, claudeHome, hermesHome });
    assert.equal(status.hosts.some((row) => row.source_host === 'codex' && row.status === 'ok'), true, 'sync status should report the Codex run');
    assert.equal(status.groups.ready.some((row) => row.source_host === 'codex'), true, 'sync status should group ready hosts');
    assert.equal(status.groups.manual_only.some((row) => row.source_host === 'chatgpt_manual'), true, 'sync status should group manual-only hosts');
    assert.equal(status.groups.bridge.some((row) => row.source_host === 'hermes' && row.local_sources_detected >= 1), true, 'sync status should group Hermes bridge/local source availability');
    assert.equal(status.hermes_bridge.mode, 'mcp_or_http_bridge', 'Hermes should be represented as a bridge, not a fake local path');

    writeText(manualImport, '- Manual cloud preference: user likes one-page briefs.\n');
    const manual = syncHostMemories({
      db,
      config,
      hosts: ['chatgpt_manual'],
      manualImportPath: manualImport,
      manualSourceHost: 'chatgpt_manual',
      scope: 'profile:user',
    });
    assert.equal(manual.ok, true, 'manual cloud import should succeed when explicitly provided');
    const manualRow = db.prepare(`
      SELECT source_host, source_kind, sync_policy
      FROM memory_current
      WHERE content LIKE '%one-page briefs%'
      LIMIT 1
    `).get();
    assert.equal(manualRow.source_host, 'chatgpt_manual');
    assert.equal(manualRow.source_kind, 'manual_import');
    assert.equal(manualRow.sync_policy, 'bidirectional_disallowed', 'manual cloud imports must not imply bidirectional sync');

    const brief = exportMemoryBrief({
      db,
      config,
      targetHost: 'claude_code',
      scope: 'profile:user',
      limit: 20,
    });
    assert.equal(brief.ok, true);
    assert.equal(brief.brief.includes('does not scrape'), true, 'export brief should state the closed-cloud boundary');
    assert.equal(brief.brief.includes(secretValue), false, 'export brief should not leak raw secrets');
    assert.equal(brief.brief.includes('[REDACTED_SECRET]'), false, 'export brief should omit secret-risk rows entirely');
    assert.equal(brief.omitted_secret_risks, 1, 'export brief should report omitted secret-risk rows');
    assert.equal(brief.brief.includes('User prefers concise setup docs.'), true, 'export brief should include useful memories');
  } finally {
    db.close();
  }
};

export { run };

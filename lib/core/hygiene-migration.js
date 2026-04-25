import fs from 'node:fs';
import path from 'node:path';

import { appendEvent } from './event-store.js';
import { promoteNativeChunks } from './native-promotion.js';
import { syncNativeMemory } from './native-sync.js';
import { rebuildEntityMentions } from './person-service.js';
import { ensureProjectionStore, rebuildFTS5, updateCurrentStatus } from './projection-store.js';
import { acquireQueueLock } from './review-queue.js';
import { buildVaultSurface } from './vault-mirror.js';
import { rebuildWorldModel } from './world-model.js';

const HYGIENE_VERSION = 'hygiene-20260425-v1';
const TEST_ARTIFACT_RE = /\b(?:MEMTEST[_-]?|MEM_TEST[_-]?|TEMPORARY MEMORY[-\s]SYSTEM TEST|DIRECT NATIVE[-\s]WRITE TEST|SEMANTIC DUPLICATE TEST|NATIVE[-\s]PROMOTION TEST|CONTROL (?:REMEMBER|REPLACE) TEST)\b/i;
const REVIEWABLE_QUEUE_REASONS = new Set([
  'capture_missing_note',
  'remember_intent_missing_note',
  'capture_review_required',
  'capture_parse_failed',
  'llm_unavailable',
]);
const NON_DURABLE_QUEUE_RE = /\b(?:running the live checks|baseline looks|validat(?:e|ing|ion)|audit chatter|install phase|progress chatter|transient tool output|tool output|partial logs?|same state|no action needed|NO_REPLY|HEARTBEAT_OK|i(?:’|'| a)m (?:flipping|moving|waiting|doing|taking)|done\.|checks? green|setup is complete|verified \d+\/\d+)\b/i;

const toTimestampSlug = (iso = new Date().toISOString()) => String(iso)
  .replaceAll(':', '')
  .replaceAll('-', '')
  .replace(/\.\d+Z$/, 'Z');

const normalizeBulletKey = (line = '') => String(line || '')
  .replace(/^\s*[-*]\s+/, '')
  .replace(/\[m:[0-9a-f-]{8,}\]\s*/ig, '')
  .replace(/<!--\s*gigabrain:[\s\S]*?-->/ig, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const isMarkdownFile = (filePath = '') => /\.md$/i.test(String(filePath || ''));

const walkFiles = (root, predicate = () => true) => {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, predicate));
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out.sort();
};

const resolveDailyNoteFiles = (memoryRoot = '') => {
  if (!memoryRoot || !fs.existsSync(memoryRoot)) return [];
  return fs.readdirSync(memoryRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}.*\.md$/i.test(entry.name))
    .map((entry) => path.join(memoryRoot, entry.name))
    .sort();
};

const copyFilePreservingRelativePath = ({ filePath, workspaceRoot, backupRoot }) => {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const rel = path.relative(workspaceRoot, filePath);
  const safeRel = rel && !rel.startsWith('..') ? rel : path.basename(filePath);
  const dest = path.join(backupRoot, safeRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(filePath, dest);
  return true;
};

const createHygieneSnapshot = ({ config, backupRoot, dbPath }) => {
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const memoryRoot = String(config?.runtime?.paths?.memoryRoot || path.join(workspaceRoot, 'memory'));
  const memoryMdPath = String(config?.native?.memoryMdPath || path.join(workspaceRoot, 'MEMORY.md'));
  fs.mkdirSync(backupRoot, { recursive: true });

  const copied = [];
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (candidate && fs.existsSync(candidate)) {
      const dest = path.join(backupRoot, 'db', path.basename(candidate));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(candidate, dest);
      copied.push(dest);
    }
  }

  const memoryFiles = Array.from(new Set([
    memoryMdPath,
    ...walkFiles(memoryRoot, isMarkdownFile),
  ].filter(Boolean)));
  for (const filePath of memoryFiles) {
    if (copyFilePreservingRelativePath({ filePath, workspaceRoot, backupRoot })) copied.push(filePath);
  }
  return {
    path: backupRoot,
    copiedFiles: copied.length,
  };
};

const findActiveTestArtifactRows = (db) => {
  ensureProjectionStore(db);
  const rows = db.prepare(`
    SELECT memory_id, type, scope, status, content
    FROM memory_current
    WHERE status = 'active'
      AND (
        upper(content) LIKE '%MEMTEST%'
        OR upper(content) LIKE '%MEM_TEST%'
        OR upper(content) LIKE '%TEMPORARY MEMORY-SYSTEM TEST%'
        OR upper(content) LIKE '%DIRECT NATIVE-WRITE TEST%'
        OR upper(content) LIKE '%SEMANTIC DUPLICATE TEST%'
        OR upper(content) LIKE '%NATIVE-PROMOTION TEST%'
        OR upper(content) LIKE '%CONTROL REMEMBER TEST%'
        OR upper(content) LIKE '%CONTROL REPLACE TEST%'
      )
    ORDER BY updated_at DESC, memory_id ASC
  `).all();
  return rows.filter((row) => TEST_ARTIFACT_RE.test(String(row.content || '')));
};

const rejectTestArtifacts = ({ db, apply, nowIso, runId, cleanupVersion }) => {
  const rows = findActiveTestArtifactRows(db);
  if (apply) {
    for (const row of rows) {
      updateCurrentStatus(db, row.memory_id, 'rejected', {
        timestamp: nowIso,
        last_reviewed_at: nowIso,
        value_score: 0,
        value_label: 'hygiene_test_artifact',
      });
      appendEvent(db, {
        timestamp: nowIso,
        component: 'hygiene_migration',
        action: 'reject_test_artifact',
        reason_codes: ['test_artifact', 'hygiene_migration'],
        memory_id: String(row.memory_id),
        cleanup_version: cleanupVersion,
        run_id: runId,
        review_version: HYGIENE_VERSION,
        payload: {
          previous_status: row.status,
          type: row.type,
          scope: row.scope,
          content: row.content,
        },
      });
    }
  }
  return {
    candidates: rows.length,
    changed: apply ? rows.length : 0,
    memoryIds: rows.map((row) => String(row.memory_id)),
  };
};

const dedupeDailyNoteFile = ({ filePath, apply }) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Map();
  const kept = [];
  const removed = [];
  let inFence = false;
  let currentSection = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (!inFence) {
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
      if (heading) currentSection = `${heading[1].length}:${String(heading[2] || '').trim().toLowerCase()}`;
    }
    const bullet = !inFence && line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet) {
      kept.push(line);
      continue;
    }
    const key = `${currentSection}|${normalizeBulletKey(line)}`;
    if (!key || key.length < 8) {
      kept.push(line);
      continue;
    }
    if (seen.has(key)) {
      removed.push({
        line: index + 1,
        firstLine: seen.get(key),
        content: String(bullet[1] || '').trim(),
      });
      continue;
    }
    seen.set(key, index + 1);
    kept.push(line);
  }
  if (apply && removed.length > 0) {
    const next = kept.join(eol);
    fs.writeFileSync(filePath, raw.endsWith('\n') && !next.endsWith('\n') ? `${next}${eol}` : next, 'utf8');
  }
  return {
    filePath,
    removed: removed.length,
    removedItems: removed,
  };
};

const dedupeDailyNotes = ({ config, apply }) => {
  const memoryRoot = String(config?.runtime?.paths?.memoryRoot || '');
  const files = resolveDailyNoteFiles(memoryRoot);
  const fileSummaries = files
    .map((filePath) => dedupeDailyNoteFile({ filePath, apply }))
    .filter((summary) => summary.removed > 0);
  return {
    scannedFiles: files.length,
    changedFiles: fileSummaries.length,
    removedBullets: fileSummaries.reduce((sum, item) => sum + Number(item.removed || 0), 0),
    files: fileSummaries,
  };
};

const parseQueueRows = (raw = '') => String(raw || '').split(/\r?\n/).filter(Boolean).map((line, index) => {
  try {
    return { row: JSON.parse(line), malformed: false, index };
  } catch {
    return { row: { status: 'malformed', raw: line }, malformed: true, index };
  }
});

const normalizeReasonCode = (row = {}) => String(row.reason_code || row.reason || '').trim().toLowerCase();
const queueRowText = (row = {}) => String(row?.payload?.excerpt || row?.payload?.content || row?.excerpt || row?.content || '').trim();

const shouldDismissQueueRow = (row = {}) => {
  const status = String(row.status || 'pending').trim().toLowerCase();
  if (status !== 'pending') return false;
  const reasonCode = normalizeReasonCode(row);
  if (!REVIEWABLE_QUEUE_REASONS.has(reasonCode)) return false;
  const text = queueRowText(row);
  if (!text) return false;
  if (/<memory_note\b/i.test(text)) return false;
  return NON_DURABLE_QUEUE_RE.test(text);
};

const resolveNonDurableQueueRows = ({ db, config, apply, nowIso, runId, cleanupVersion }) => {
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
  const summary = {
    queuePath,
    totalRows: 0,
    candidates: 0,
    changed: 0,
    malformedRows: 0,
  };
  if (!queuePath || !fs.existsSync(queuePath)) return summary;

  const updateRows = (raw) => {
    const parsed = parseQueueRows(raw);
    summary.totalRows = parsed.length;
    summary.malformedRows = parsed.filter((entry) => entry.malformed).length;
    const rows = parsed.map((entry) => entry.row);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!shouldDismissQueueRow(row)) continue;
      summary.candidates += 1;
      if (!apply) continue;
      rows[index] = {
        ...row,
        status: 'resolved_hygiene',
        auto_resolved: true,
        resolved_at: nowIso,
        updated_at: nowIso,
        resolved_reason: 'hygiene_non_durable_dismiss',
        auto_review: {
          at: nowIso,
          decision: 'dismiss',
          confidence: 1,
          reason: 'non-durable progress/test chatter resolved by hygiene migration',
          review_version: HYGIENE_VERSION,
          run_id: runId,
        },
      };
      summary.changed += 1;
      appendEvent(db, {
        timestamp: nowIso,
        component: 'hygiene_migration',
        action: 'resolve_queue_row',
        reason_codes: ['queue_hygiene', 'non_durable_dismiss'],
        memory_id: String(row.memory_id || row?.payload?.memory_id || `queue:${index}`),
        cleanup_version: cleanupVersion,
        run_id: runId,
        review_version: HYGIENE_VERSION,
        payload: {
          queue_index: index,
          reason_code: normalizeReasonCode(row),
          excerpt: queueRowText(row).slice(0, 500),
        },
      });
    }
    return rows;
  };

  if (!apply) {
    updateRows(fs.readFileSync(queuePath, 'utf8'));
    return summary;
  }

  const lock = acquireQueueLock(queuePath);
  try {
    const rows = updateRows(fs.readFileSync(queuePath, 'utf8'));
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length > 0 ? '\n' : ''}`, 'utf8');
  } finally {
    lock.release();
  }
  return summary;
};

const refreshMemorySurfaces = ({ db, dbPath, config, apply, runId }) => {
  const dryRun = !apply;
  const nativeSync = syncNativeMemory({ db, config, dryRun });
  const nativePromotion = promoteNativeChunks({
    db,
    config,
    sourcePaths: nativeSync.changed_sources || [],
    dryRun,
  });
  let fts = { ok: false };
  let worldModel = null;
  let vault = null;
  if (apply) {
    rebuildFTS5(db);
    fts = { ok: true };
    rebuildEntityMentions(db);
    worldModel = rebuildWorldModel({ db, config });
    vault = buildVaultSurface({
      db,
      dbPath,
      config,
      dryRun: false,
      runId,
    });
  }
  return {
    nativeSync,
    nativePromotion,
    fts,
    worldModel,
    vault,
  };
};

const runHygieneMigration = ({
  db,
  dbPath = '',
  config,
  apply = false,
  now = new Date().toISOString(),
  runId = '',
  refresh = true,
} = {}) => {
  if (!db) throw new Error('db is required');
  if (!config) throw new Error('config is required');
  const nowIso = String(now || new Date().toISOString());
  const resolvedRunId = runId || `hygiene-20260425-${toTimestampSlug(nowIso)}`;
  const cleanupVersion = String(config?.runtime?.cleanupVersion || 'v3.0.0');
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const snapshotRoot = path.join(
    String(config?.maintenance?.snapshotDir || path.join(workspaceRoot, 'memory', 'backups')),
    resolvedRunId,
  );
  const summary = {
    ok: true,
    version: HYGIENE_VERSION,
    runId: resolvedRunId,
    dryRun: !apply,
    snapshot: apply ? createHygieneSnapshot({ config, backupRoot: snapshotRoot, dbPath }) : { path: snapshotRoot, copiedFiles: 0 },
    testArtifacts: null,
    dailyNoteDedupe: null,
    queue: null,
    refresh: null,
  };

  summary.testArtifacts = rejectTestArtifacts({ db, apply, nowIso, runId: resolvedRunId, cleanupVersion });
  summary.dailyNoteDedupe = dedupeDailyNotes({ config, apply });
  summary.queue = resolveNonDurableQueueRows({ db, config, apply, nowIso, runId: resolvedRunId, cleanupVersion });
  if (refresh) {
    summary.refresh = refreshMemorySurfaces({ db, dbPath, config, apply, runId: resolvedRunId });
  }
  return summary;
};

export {
  HYGIENE_VERSION,
  dedupeDailyNoteFile,
  runHygieneMigration,
  shouldDismissQueueRow,
};

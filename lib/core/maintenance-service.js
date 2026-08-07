import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { appendEvent } from './event-store.js';
import {
  ensureProjectionStore,
  listCurrentMemories,
  materializeProjectionFromMemories,
  rebuildFTS5,
  updateCurrentStatus,
} from './projection-store.js';
import {
  classifyValue,
  createSemanticFingerprint,
  jaccardSimilarity,
  jaccardSimilarityFromFingerprints,
  normalizeContent,
  resolvePolicy,
  resolveSemanticThresholds,
} from './policy.js';
import { ensureNativeStore, syncNativeMemory, renderNativeSyncMarkdown } from './native-sync.js';
import { promoteNativeChunks } from './native-promotion.js';
import { syncVaultMemory } from './vault-sync.js';
import { discoverHostSources, syncHostMemories } from './host-memory-sync.js';
import { harvestTranscripts } from './transcript-harvester.js';
import { projectWiki, reconcileWiki } from './wiki-project.js';
import { runAdaptiveTrust } from './adaptive-trust.js';
import { ensurePersonStore, rebuildEntityMentions } from './person-service.js';
import { appendQueueRow, applyQueueRetention, withQueueLock } from './review-queue.js';
import { ensureWorldModelStore, projectArbitrationBeliefRows, rebuildWorldModel, resolveOpenLoopsFromNewMemories } from './world-model.js';
import { runBeliefArbitration } from './belief-arbitration.js';
import { evalRecall, loadEvalCases } from './eval-harness.js';
import { buildMissingEmbeddings } from './embedding-service.js';
import {
  captureSnapshotMetrics,
  getRecallLatencyStats,
  renderUsageLogEntry,
} from './metrics.js';
import { openDatabase } from './sqlite.js';
import { atomicWriteFileSync, readFileIfExistsSync } from './safe-fs.js';

const DAILY_SEQUENCE = Object.freeze([
  'snapshot',
  'native_sync',
  'native_promotion',
  'vault_sync',
  'host_sync',
  'transcript_sync',
  // idea #5 (git-wiki): RECONCILE runs in the ingest band, BEFORE the nightly
  // arbitration/world-model rebuild, so a human's wiki edit is ingested into the
  // ledger first and the rest of the cycle arbitrates over the corrected set.
  'wiki_reconcile',
  // B1: shadow recompute of per-host trust drift from the verdict ledger —
  // right after the ingest band so ingest-time verdicts are in the fold.
  'adaptive_trust',
  'quality_sweep',
  'exact_dedupe',
  'semantic_dedupe',
  'entity_refresh',
  'belief_refresh',
  'episode_refresh',
  'open_loop_refresh',
  'contradiction_detection',
  'synthesis_build',
  'briefing_build',
  'audit_delta',
  'archive_compression',
  'vacuum',
  'metrics_report',
  'eval_quality',
  // idea #5 (git-wiki): PROJECT runs LAST (after the world model is rebuilt), so
  // it materializes the FINAL arbitrated CURRENT belief set into the git wiki
  // tree. reconcile-before-project ordering holds across the whole cycle.
  'wiki_project',
  'graph_build',
]);

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const resolveArtifactOutputDir = (outputDir, dryRun) => (
  dryRun ? path.join(outputDir, 'previews') : outputDir
);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, '..', '..');

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const ensureFileDir = (filePath) => {
  ensureDir(path.dirname(filePath));
};

const appendJsonl = (filePath, row) => {
  if (!filePath) return;
  ensureFileDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
};

const appendUsageLog = (filePath, text) => {
  if (!filePath) return;
  ensureFileDir(filePath);
  fs.appendFileSync(filePath, text, 'utf8');
};

const copyIfExists = (source, target) => {
  if (!source || !target) return false;
  if (!fs.existsSync(source)) return false;
  ensureFileDir(target);
  fs.copyFileSync(source, target);
  return true;
};

// Crash-consistent DB snapshot: a raw byte copy
// of a live SQLite file tears pages under concurrent commits and misses -wal
// content entirely under WAL — such a backup fails only when you try to
// RESTORE it. VACUUM INTO produces a consistent, compacted snapshot through
// the SQLite engine itself; the raw copy remains only as a last-resort
// fallback for very old SQLite builds.
const snapshotDatabase = (db, source, target) => {
  if (!db || !source || !target) return false;
  if (!fs.existsSync(source)) return false;
  ensureFileDir(target);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    db.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`);
    try { fs.chmodSync(target, 0o600); } catch { /* best-effort */ }
    return true;
  } catch {
    const copied = copyIfExists(source, target);
    if (copied) {
      try { fs.chmodSync(target, 0o600); } catch { /* best-effort */ }
    }
    return copied;
  }
};

const scorePriority = (row) => {
  const confidence = Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0;
  const updated = Date.parse(String(row.updated_at || row.created_at || '')) || 0;
  return confidence + (updated / 1e14);
};

const parseTags = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  } catch {
    // ignore malformed tags and fall back to empty
  }
  return [];
};

const isProtectedMemory = (row = {}) => parseTags(row.tags).includes('protected');

const protectionAwarePriority = (row) => scorePriority(row) + (isProtectedMemory(row) ? 100 : 0);

const pruneBackups = ({
  snapshotDir,
  compactDays,
  emergencyDays,
  maxEmergencyFiles,
  maxCompactFiles = 5,
}) => {
  ensureDir(snapshotDir);
  const entries = fs.readdirSync(snapshotDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(snapshotDir, entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        mtime: stat.mtimeMs,
      };
    });
  const nowMs = Date.now();
  const compactCutoff = nowMs - (Math.max(1, compactDays) * 24 * 60 * 60 * 1000);
  const emergencyCutoff = nowMs - (Math.max(1, emergencyDays) * 24 * 60 * 60 * 1000);

  const compact = entries.filter((entry) => entry.name.includes('compact'));
  const emergency = entries.filter((entry) => entry.name.includes('emergency'));
  let pruned = 0;

  const compactSorted = [...compact].sort((a, b) => b.mtime - a.mtime);
  let keptCompact = 0;
  for (const entry of compactSorted) {
    const tooOld = entry.mtime < compactCutoff;
    const overLimit = keptCompact >= Math.max(1, maxCompactFiles);
    if (tooOld || overLimit) {
      fs.unlinkSync(entry.path);
      pruned += 1;
      continue;
    }
    keptCompact += 1;
  }
  const emergencySorted = [...emergency].sort((a, b) => b.mtime - a.mtime);
  let keptEmergency = 0;
  for (const entry of emergencySorted) {
    const tooOld = entry.mtime < emergencyCutoff;
    const overLimit = keptEmergency >= Math.max(1, maxEmergencyFiles);
    if (tooOld || overLimit) {
      fs.unlinkSync(entry.path);
      pruned += 1;
      continue;
    }
    keptEmergency += 1;
  }
  return { pruned };
};

const writeArchiveCompression = ({
  workspaceRoot,
  rows,
  runId,
  dryRun = false,
}) => {
  const prefix = dryRun ? 'archive-summary-dry-run' : 'archive-summary';
  const filePath = path.join(workspaceRoot, 'memory', `${prefix}-${new Date().toISOString().slice(0, 10)}.md`);
  ensureFileDir(filePath);
  const lines = [];
  lines.push('# Archive Summary');
  lines.push('');
  lines.push(`- run_id: \`${runId}\``);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- entries: ${rows.length}`);
  lines.push('');
  for (const row of rows.slice(0, 200)) {
    lines.push(`- [${row.memory_id}] (${row.type}/${row.scope}) ${String(row.content || '').trim()}`);
  }
  lines.push('');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

const writeExecutionArtifact = ({
  outputDir,
  dateKey,
  payload,
}) => {
  ensureDir(outputDir);
  const filePath = path.join(outputDir, `nightly-execution-${dateKey}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
};

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const writeArchivedOrKilledArtifacts = ({
  outputDir,
  dateKey,
  rows,
}) => {
  ensureDir(outputDir);
  const mdPath = path.join(outputDir, `memory-archived-or-killed-${dateKey}.md`);
  const jsonlPath = path.join(outputDir, `memory-archived-or-killed-${dateKey}.jsonl`);
  const csvPath = path.join(outputDir, `memory-archived-or-killed-${dateKey}.csv`);

  const byKey = new Map();
  const existingState = readFileIfExistsSync(jsonlPath, 'utf8');
  if (existingState.exists) {
    const existing = existingState.data
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of existing) {
      try {
        const row = JSON.parse(line);
        const key = `${String(row?.memory_id || '')}|${String(row?.after_status || '')}`;
        if (key !== '|') byKey.set(key, row);
      } catch {
        // Ignore malformed historical lines and continue forward.
      }
    }
  }
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const key = `${String(row?.memory_id || '')}|${String(row?.after_status || '')}`;
    if (key !== '|') byKey.set(key, row);
  }
  const list = Array.from(byKey.values());
  const md = [];
  md.push('# Archived Or Killed Memories');
  md.push('');
  md.push(`- generated_at: ${new Date().toISOString()}`);
  md.push(`- rows: ${list.length}`);
  md.push('');
  for (const row of list) {
    md.push(`## ${String(row.after_status || 'unknown').toUpperCase()} - ${row.memory_id}`);
    md.push(`- type: ${row.type}`);
    md.push(`- scope: ${row.scope}`);
    md.push(`- reason_codes: ${(row.reason_codes || []).join(', ') || '(none)'}`);
    if (Number.isFinite(Number(row.similarity))) md.push(`- similarity: ${Number(row.similarity).toFixed(4)}`);
    if (row.matched_memory_id) md.push(`- matched_memory_id: ${row.matched_memory_id}`);
    md.push(`- content: ${String(row.content || '').trim()}`);
    md.push('');
  }
  atomicWriteFileSync(mdPath, `${md.join('\n')}\n`, { mode: 0o600 });

  const jsonl = list.map((row) => JSON.stringify(row)).join('\n');
  atomicWriteFileSync(jsonlPath, jsonl ? `${jsonl}\n` : '', { mode: 0o600 });

  const csv = [];
  csv.push([
    'memory_id',
    'type',
    'scope',
    'before_status',
    'after_status',
    'reason_codes',
    'similarity',
    'matched_memory_id',
    'content',
  ].map(csvCell).join(','));
  for (const row of list) {
    csv.push([
      row.memory_id,
      row.type,
      row.scope,
      row.before_status,
      row.after_status,
      Array.isArray(row.reason_codes) ? row.reason_codes.join('|') : '',
      Number.isFinite(Number(row.similarity)) ? Number(row.similarity).toFixed(4) : '',
      row.matched_memory_id || '',
      row.content || '',
    ].map(csvCell).join(','));
  }
  atomicWriteFileSync(csvPath, `${csv.join('\n')}\n`, { mode: 0o600 });

  return {
    mdPath,
    jsonlPath,
    csvPath,
  };
};

const writeKeptArtifact = ({
  outputDir,
  dateKey,
  rows,
}) => {
  ensureDir(outputDir);
  const filePath = path.join(outputDir, `memory-kept-${dateKey}.md`);
  const list = Array.isArray(rows) ? rows : [];
  const lines = [];
  lines.push('# Kept Memories');
  lines.push('');
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- rows: ${list.length}`);
  lines.push('');
  for (const row of list) {
    lines.push(`- [${row.memory_id}] (${row.type}/${row.scope}) ${String(row.content || '').trim()}`);
  }
  lines.push('');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

const queueReview = (queuePath, row, options = {}) => {
  if (!queuePath) return;
  if (options?.dryRun === true) return;
  appendQueueRow(queuePath, row, {
    applyRetention: false,
  });
};

// Pending semantic-dupe pairs already in the queue. The nightly scan re-finds
// the same borderline pairs every run; without this guard each run appends a
// duplicate row and the queue grows without bound.
const loadPendingSemanticPairs = (queuePath) => {
  const pairs = new Set();
  if (!queuePath || !fs.existsSync(queuePath)) return pairs;
  try {
    const lines = fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (String(row?.reason_code || row?.reason || '') !== 'duplicate_semantic') continue;
        if (String(row?.status || '').trim().toLowerCase() !== 'pending') continue;
        const loserId = String(row?.loser_memory_id || row?.memory_id || '');
        const winnerId = String(row?.winner_memory_id || row?.matched_memory_id || '');
        if (loserId && winnerId) pairs.add(`${loserId}|${winnerId}`);
      } catch { /* skip malformed lines */ }
    }
  } catch {
    // Fail CLOSED: an unreadable queue with an empty
    // guard set would let the nightly re-append every borderline pair and
    // regrow the queue without bound; null tells the caller to skip semantic
    // enqueueing for this run instead.
    return null;
  }
  return pairs;
};

const hasTableColumn = (db, tableName, columnName) => {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => String(column?.name || '').toLowerCase() === String(columnName || '').toLowerCase());
};

const ensureTableColumn = (db, tableName, columnName, definitionSql) => {
  if (!hasTableColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
  }
};

const summarizeExcerpt = (value = '', max = 180) => {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

const pickSemanticQueuePair = (a, b) => {
  const loser = protectionAwarePriority(a) >= protectionAwarePriority(b) ? b : a;
  const winner = loser.memory_id === a.memory_id ? b : a;
  return { winner, loser };
};

const buildSemanticReviewQueueRow = ({ winner, loser, similarity, nowIso }) => ({
  timestamp: nowIso,
  queued_at: nowIso,
  status: 'pending',
  reason: 'semantic_borderline',
  queued_reason: 'semantic_borderline',
  reason_code: 'duplicate_semantic',
  action: 'maintenance_review',
  similarity,
  memory_id: String(loser.memory_id || ''),
  matched_memory_id: String(winner.memory_id || ''),
  winner_memory_id: String(winner.memory_id || ''),
  loser_memory_id: String(loser.memory_id || ''),
  memory_type: String(loser.type || ''),
  matched_memory_type: String(winner.type || ''),
  scope: String(loser.scope || ''),
  matched_scope: String(winner.scope || ''),
  payload: {
    excerpt: summarizeExcerpt(loser.content || loser.normalized || ''),
    matched_excerpt: summarizeExcerpt(winner.content || winner.normalized || ''),
  },
});

const withTransaction = (db, fn) => {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

const runMaintenance = ({
  dbPath,
  config,
  configPath = '',
  dryRun = false,
  runId = '',
  reviewVersion = '',
}) => {
  const resolvedRunId = String(runId || `maintain-${nowStamp()}`);
  const cleanupVersion = String(config?.runtime?.cleanupVersion || 'v3.0.0');
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const outputDir = String(config?.runtime?.paths?.outputDir || path.join(workspaceRoot, 'output'));
  const artifactOutputDir = resolveArtifactOutputDir(outputDir, dryRun);
  const snapshotDir = String(config?.maintenance?.snapshotDir || path.join(workspaceRoot, 'memory', 'backups'));
  const eventsPath = String(config?.maintenance?.eventsPath || path.join(workspaceRoot, 'output', 'memory-events.jsonl'));
  const usageLogPath = String(config?.maintenance?.usageLogPath || path.join(workspaceRoot, 'memory', 'usage-log.md'));
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || path.join(workspaceRoot, 'output', 'memory-review-queue.jsonl'));

  ensureDir(outputDir);
  ensureDir(artifactOutputDir);
  ensureDir(snapshotDir);
  ensureFileDir(eventsPath);
  ensureFileDir(usageLogPath);
  ensureFileDir(queuePath);

  const db = openDatabase(dbPath);
  const eventCounts = {
    quality_archived: 0,
    quality_rejected: 0,
    dedupe_exact_archived: 0,
    dedupe_semantic_archived: 0,
    dedupe_semantic_review_queue: 0,
    dedupe_auto_resolved: 0,
    queue_rows_pruned: 0,
    queue_malformed_rows: 0,
    native_sync_changed_files: 0,
    native_sync_inserted_chunks: 0,
    native_promoted_inserted: 0,
    native_promoted_linked_existing: 0,
    vault_sync_changed_files: 0,
    vault_sync_skipped_evicted: 0,
    host_sync_sources: 0,
    host_sync_inserted: 0,
    host_sync_skipped: 0,
    host_sync_unchanged: 0,
    host_sync_verdicts: 0,
    transcript_sync_files: 0,
    transcript_sync_turns: 0,
    transcript_sync_facts: 0,
    transcript_sync_inserted: 0,
    transcript_sync_verdicts: 0,
    wiki_reconcile_human_edits: 0,
    wiki_reconcile_ingested: 0,
    wiki_reconcile_verdicts: 0,
    wiki_project_committed: 0,
    wiki_project_files: 0,
    embeddings_computed: 0,
    embeddings_skipped: 0,
    embeddings_failed: 0,
    entity_mentions_rebuilt: 0,
    world_model_entities: 0,
    world_model_beliefs: 0,
    world_model_episodes: 0,
    world_model_open_loops: 0,
    world_model_contradictions: 0,
    world_model_syntheses: 0,
    open_loops_auto_resolved: 0,
    eval_case_count: 0,
    eval_precision_at_3: 0,
    eval_mrr: 0,
    graph_node_count: 0,
    graph_edge_count: 0,
    fts_rebuild_ok: 0,
    fts_rebuild_failed: 0,
    snapshots_created: 0,
    backups_pruned: 0,
  };

  try {
    ensureProjectionStore(db);
    ensureNativeStore(db);
    ensurePersonStore(db);
    ensureWorldModelStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS memory_eval_history (
      id TEXT PRIMARY KEY,
      run_date TEXT NOT NULL,
      version TEXT,
      precision_at_1 REAL,
      precision_at_3 REAL,
      precision_at_5 REAL,
      mrr REAL,
      ndcg_at_5 REAL,
      hit_rate REAL,
      case_count INTEGER,
      strategy_accuracy REAL
    )`);
    ensureTableColumn(db, 'memory_eval_history', 'avg_injection_tokens', 'REAL');
    ensureTableColumn(db, 'memory_eval_history', 'latency_median_ms', 'REAL');
    ensureTableColumn(db, 'memory_eval_history', 'latency_p95_ms', 'REAL');
    const projectionCount = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(projectionCount) === 0) {
      materializeProjectionFromMemories(db);
    }
    const policy = resolvePolicy(config);
    const startedAt = new Date().toISOString();

    const emit = (event) => {
      const row = appendEvent(db, {
        ...event,
        cleanup_version: cleanupVersion,
        run_id: resolvedRunId,
        review_version: String(reviewVersion || ''),
      });
      appendJsonl(eventsPath, row);
      return row;
    };

    emit({
      timestamp: startedAt,
      component: 'maintenance',
      action: 'maintenance_start',
      reason_codes: ['scheduled'],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        sequence: DAILY_SEQUENCE,
        dryRun,
      },
    });

    const preMetrics = captureSnapshotMetrics(db, dbPath);

    const emergencySnapshot = path.join(snapshotDir, `registry-emergency-${nowStamp()}.sqlite`);
    if (!dryRun && snapshotDatabase(db, dbPath, emergencySnapshot)) {
      eventCounts.snapshots_created += 1;
    }

    const changedForArchiveSummary = [];
    const archivedOrKilledRows = [];
    const nowIso = new Date().toISOString();
    const dateKey = nowIso.slice(0, 10);

    const nativeSyncSummary = syncNativeMemory({
      db,
      config,
      dryRun,
    });
    eventCounts.native_sync_changed_files = Number(nativeSyncSummary.changed_files || 0);
    eventCounts.native_sync_inserted_chunks = Number(nativeSyncSummary.inserted_chunks || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'native_sync',
      reason_codes: ['complete'],
      memory_id: `run:${resolvedRunId}`,
      payload: nativeSyncSummary,
    });

    const nativePromotionSummary = promoteNativeChunks({
      db,
      config,
      sourcePaths: nativeSyncSummary.changed_sources || [],
      dryRun,
    });
    eventCounts.native_promoted_inserted = Number(nativePromotionSummary.promoted_inserted || 0);
    eventCounts.native_promoted_linked_existing = Number(nativePromotionSummary.linked_existing || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'native_promotion',
      reason_codes: [eventCounts.native_promoted_inserted > 0 || eventCounts.native_promoted_linked_existing > 0 ? 'complete' : 'noop'],
      memory_id: `run:${resolvedRunId}`,
      payload: nativePromotionSummary,
    });

    // E3 — BUDGETED vault-sync. Ingests configured READ-ONLY vault corpora into
    // memory_native_chunks (source_kind='vault'). It deliberately does NOT feed
    // promoteNativeChunks: vault chunks NEVER become beliefs (R2 keystone). With
    // native.vaults:[] (the default) this is a zero-cost no-op.
    const vaultSyncSummary = syncVaultMemory({
      db,
      config,
      dryRun,
      maxFiles: Number(config?.native?.vaultSyncMaxFiles || 0) || 0,
    });
    eventCounts.vault_sync_changed_files = Number(vaultSyncSummary.changed_files || 0);
    eventCounts.vault_sync_skipped_evicted = Number(vaultSyncSummary.skipped_evicted || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'vault_sync',
      reason_codes: [vaultSyncSummary.enabled ? 'complete' : 'noop'],
      memory_id: `run:${resolvedRunId}`,
      payload: vaultSyncSummary,
    });

    // Feature #2 — BUDGETED host_sync. Auto-ingests local host memory stores
    // (codex/claude_code/hermes/cursor/windsurf/openclaw) into the cross-agent
    // bus on every nightly run, so the neutral arbiter is SELF-REFRESHING
    // instead of gated behind the manual `sync-hosts` CLI verb. The per-host
    // mtime/size/hash cursor (incremental:true) skips unchanged files cheaply,
    // and ingest-time arbitration (arbitrate, default ON) judges fresh
    // cross-store contradictions in-band. No hosts present → graceful no-op
    // (zero sources, zero verdicts). Best-effort: a host-sync failure must
    // never abort the nightly maintenance run.
    let hostSyncSummary = { ok: true, source_count: 0, indexed_count: 0, inserted_count: 0, skipped_count: 0, unchanged_sources: 0, arbitration_verdicts: 0 };
    try {
      hostSyncSummary = syncHostMemories({
        db,
        config,
        incremental: true,
        arbitrate: !dryRun,
        dryRun,
        projectBeliefRows: projectArbitrationBeliefRows,
      });
    } catch (hostErr) {
      hostSyncSummary = { ok: false, error: String(hostErr?.message || hostErr).slice(0, 200), source_count: 0, indexed_count: 0, inserted_count: 0, skipped_count: 0, unchanged_sources: 0, arbitration_verdicts: 0 };
    }
    eventCounts.host_sync_sources = Number(hostSyncSummary.source_count || 0);
    eventCounts.host_sync_inserted = Number(hostSyncSummary.inserted_count || 0);
    eventCounts.host_sync_skipped = Number(hostSyncSummary.skipped_count || 0);
    eventCounts.host_sync_unchanged = Number(hostSyncSummary.unchanged_sources || 0);
    eventCounts.host_sync_verdicts = Number(hostSyncSummary.arbitration_verdicts || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'host_sync',
      reason_codes: [hostSyncSummary.ok === false ? 'error' : (eventCounts.host_sync_sources > 0 ? 'complete' : 'noop')],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        ok: hostSyncSummary.ok !== false,
        source_count: eventCounts.host_sync_sources,
        inserted_count: eventCounts.host_sync_inserted,
        skipped_count: eventCounts.host_sync_skipped,
        unchanged_sources: eventCounts.host_sync_unchanged,
        arbitration_verdicts: eventCounts.host_sync_verdicts,
        error: hostSyncSummary.error || '',
      },
    });

    // idea #1 — BUDGETED transcript_sync. CDC-tails the RAW session rollouts
    // agents write (~/.codex/sessions, ~/.claude/projects), mining facts from
    // sessions that ended abruptly (crash / /clear / OOM) that host_sync's
    // curated-/memories walk never sees. READ-ONLY + LOCAL-ONLY: extraction runs
    // ONLY through a local provider (ollama) or injected hook — a cloud-only
    // config is a loud-but-safe SKIP (raw transcript text never leaves the box).
    // native.transcripts.enabled:false (DEFAULT) → an entire ZERO-COST no-op.
    // Per-file byte-offset cursor (incremental) reads only NEW bytes; maxFiles/
    // maxTurns bound the run; facts land at the LOW transcript trust tier and
    // their touched ids join ingest-time arbitration. Best-effort: a transcript
    // failure must never abort the nightly run.
    let transcriptSyncSummary = { ok: true, enabled: false, files_scanned: 0, turns_salient: 0, facts_extracted: 0, inserted_count: 0, arbitration_verdicts: 0 };
    try {
      transcriptSyncSummary = harvestTranscripts({
        db,
        config,
        incremental: true,
        arbitrate: !dryRun,
        dryRun,
        projectBeliefRows: projectArbitrationBeliefRows,
      });
    } catch (transcriptErr) {
      transcriptSyncSummary = { ok: false, enabled: true, error: String(transcriptErr?.message || transcriptErr).slice(0, 200), files_scanned: 0, turns_salient: 0, facts_extracted: 0, inserted_count: 0, arbitration_verdicts: 0 };
    }
    eventCounts.transcript_sync_files = Number(transcriptSyncSummary.files_scanned || 0);
    eventCounts.transcript_sync_turns = Number(transcriptSyncSummary.turns_salient || 0);
    eventCounts.transcript_sync_facts = Number(transcriptSyncSummary.facts_extracted || 0);
    eventCounts.transcript_sync_inserted = Number(transcriptSyncSummary.inserted_count || 0);
    eventCounts.transcript_sync_verdicts = Number(transcriptSyncSummary.arbitration_verdicts || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'transcript_sync',
      reason_codes: [
        transcriptSyncSummary.ok === false ? 'error'
          : (transcriptSyncSummary.enabled !== true ? 'noop'
            : (eventCounts.transcript_sync_files > 0 ? 'complete' : 'noop')),
      ],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        ok: transcriptSyncSummary.ok !== false,
        enabled: transcriptSyncSummary.enabled === true,
        skipped_reason: transcriptSyncSummary.skipped_reason || '',
        files_scanned: eventCounts.transcript_sync_files,
        turns_salient: eventCounts.transcript_sync_turns,
        facts_extracted: eventCounts.transcript_sync_facts,
        inserted_count: eventCounts.transcript_sync_inserted,
        arbitration_verdicts: eventCounts.transcript_sync_verdicts,
        error: transcriptSyncSummary.error || '',
      },
    });

    // idea #5 — wiki_reconcile. Ingests HUMAN edits to the git wiki tree (commits
    // NOT authored by GigaBrain) back into the ledger as high-trust `human_wiki`
    // facts that WIN arbitration over agent facts of the same slot. Runs BEFORE
    // the nightly arbitration/world-model rebuild so the corrected set drives the
    // rest of the cycle. native.wiki.enabled:false (DEFAULT) → zero-cost no-op.
    // Best-effort: a wiki/git failure must never abort the nightly run.
    let wikiReconcileSummary = { enabled: false, human_edits: 0, ingested: 0, arbitration_verdicts: 0 };
    try {
      wikiReconcileSummary = reconcileWiki({ db, config, dryRun });
    } catch (wikiErr) {
      wikiReconcileSummary = { enabled: true, error: String(wikiErr?.message || wikiErr).slice(0, 200), human_edits: 0, ingested: 0, arbitration_verdicts: 0 };
    }
    eventCounts.wiki_reconcile_human_edits = Number(wikiReconcileSummary.human_edits || 0);
    eventCounts.wiki_reconcile_ingested = Number(wikiReconcileSummary.ingested || 0);
    eventCounts.wiki_reconcile_verdicts = Number(wikiReconcileSummary.arbitration_verdicts || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'wiki_reconcile',
      reason_codes: [
        wikiReconcileSummary.error ? 'error'
          : (wikiReconcileSummary.enabled !== true ? 'noop'
            : (eventCounts.wiki_reconcile_human_edits > 0 ? 'complete' : 'noop')),
      ],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        enabled: wikiReconcileSummary.enabled === true,
        human_edits: eventCounts.wiki_reconcile_human_edits,
        ingested: eventCounts.wiki_reconcile_ingested,
        arbitration_verdicts: eventCounts.wiki_reconcile_verdicts,
        skipped: wikiReconcileSummary.skipped || '',
        error: wikiReconcileSummary.error || '',
      },
    });

    // B1 — adaptive host trust, SHADOW recompute.
    // Folds the whole verdict/reinstate ledger (including verdicts the ingest
    // band just produced) into per-host drift targets, moves stored deltas by
    // at most maxDriftPerCycle, and receipts changes as trust:drift events.
    // Nothing consumes the deltas unless worldModel.arbiter.adaptiveTrust
    // .enabled is true. Best-effort: a failure never aborts the nightly run.
    let adaptiveTrustSummary = { ok: true, shadow: true, hosts: [], drifted: [] };
    try {
      adaptiveTrustSummary = runAdaptiveTrust({ db, config, now: nowIso, dryRun });
    } catch (trustErr) {
      adaptiveTrustSummary = { ok: false, shadow: true, hosts: [], drifted: [], error: String(trustErr?.message || trustErr).slice(0, 200) };
    }
    eventCounts.adaptive_trust_hosts = adaptiveTrustSummary.hosts.length;
    eventCounts.adaptive_trust_drifted = adaptiveTrustSummary.drifted.length;
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'adaptive_trust',
      reason_codes: [adaptiveTrustSummary.ok === false ? 'error' : (adaptiveTrustSummary.drifted.length > 0 ? 'complete' : 'noop')],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        ok: adaptiveTrustSummary.ok !== false,
        shadow: adaptiveTrustSummary.shadow !== false,
        hosts: eventCounts.adaptive_trust_hosts,
        drifted: eventCounts.adaptive_trust_drifted,
        error: adaptiveTrustSummary.error || '',
      },
    });

    withTransaction(db, () => {
      const activeRows = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
      for (const row of activeRows) {
        if (isProtectedMemory(row)) {
          continue;
        }
        const result = classifyValue(row, policy);
        if (result.action === 'archive') {
          if (!dryRun) {
            updateCurrentStatus(db, row.memory_id, 'archived', {
              value_score: result.value_score,
              value_label: result.value_label,
              timestamp: nowIso,
              last_reviewed_at: nowIso,
            });
          }
          changedForArchiveSummary.push(row);
          archivedOrKilledRows.push({
            memory_id: String(row.memory_id),
            type: String(row.type || ''),
            scope: String(row.scope || ''),
            before_status: String(row.status || 'active'),
            after_status: 'archived',
            reason_codes: result.reason_codes || [],
            similarity: null,
            matched_memory_id: null,
            content: String(row.content || ''),
          });
          eventCounts.quality_archived += 1;
          emit({
            timestamp: nowIso,
            component: 'maintenance',
            action: 'quality_archive',
            reason_codes: result.reason_codes,
            memory_id: String(row.memory_id),
            payload: {
              score: result.value_score,
              label: result.value_label,
            },
          });
        } else if (result.action === 'reject') {
          if (!dryRun) {
            updateCurrentStatus(db, row.memory_id, 'rejected', {
              value_score: result.value_score,
              value_label: result.value_label,
              timestamp: nowIso,
              last_reviewed_at: nowIso,
            });
          }
          archivedOrKilledRows.push({
            memory_id: String(row.memory_id),
            type: String(row.type || ''),
            scope: String(row.scope || ''),
            before_status: String(row.status || 'active'),
            after_status: 'rejected',
            reason_codes: result.reason_codes || [],
            similarity: null,
            matched_memory_id: null,
            content: String(row.content || ''),
          });
          eventCounts.quality_rejected += 1;
          emit({
            timestamp: nowIso,
            component: 'maintenance',
            action: 'quality_reject',
            reason_codes: result.reason_codes,
            memory_id: String(row.memory_id),
            payload: {
              score: result.value_score,
              label: result.value_label,
            },
          });
        }
      }
    });

    withTransaction(db, () => {
      const rows = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
      const groups = new Map();
      for (const row of rows) {
        const key = `${String(row.scope || 'shared')}|${normalizeContent(row.normalized || row.content || '')}`;
        if (!key.endsWith('|')) {
          const list = groups.get(key) || [];
          list.push(row);
          groups.set(key, list);
        }
      }
      for (const list of groups.values()) {
        if (!list || list.length <= 1) continue;
        const sorted = [...list].sort((a, b) => protectionAwarePriority(b) - protectionAwarePriority(a));
        const winner = sorted[0];
        for (const loser of sorted.slice(1)) {
          if (isProtectedMemory(loser)) continue;
          if (!dryRun) {
            updateCurrentStatus(db, loser.memory_id, 'archived', {
              value_label: 'archive_candidate',
              timestamp: nowIso,
            });
          }
          archivedOrKilledRows.push({
            memory_id: String(loser.memory_id),
            type: String(loser.type || ''),
            scope: String(loser.scope || ''),
            before_status: String(loser.status || 'active'),
            after_status: 'archived',
            reason_codes: ['duplicate_exact'],
            similarity: 1,
            matched_memory_id: String(winner.memory_id),
            content: String(loser.content || ''),
          });
          eventCounts.dedupe_exact_archived += 1;
          emit({
            timestamp: nowIso,
            component: 'maintenance',
            action: 'dedupe_exact_archive',
            reason_codes: ['duplicate_exact'],
            memory_id: String(loser.memory_id),
            matched_memory_id: String(winner.memory_id),
            payload: {
              winner_id: String(winner.memory_id),
            },
          });
        }
      }
    });

    withTransaction(db, () => {
      const rows = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
      const archivedInRun = new Set();
      const pendingSemanticPairs = loadPendingSemanticPairs(queuePath);
      // Fingerprinting is linear in memory text length. Cache it once per row
      // instead of repeating tokenization and n-gram generation for every pair.
      const semanticFingerprints = new Map(rows.map((row) => [
        String(row.memory_id),
        createSemanticFingerprint(row.content || row.normalized || ''),
      ]));
      const semanticThresholdsByType = new Map();
      for (let i = 0; i < rows.length; i += 1) {
        const a = rows[i];
        if (archivedInRun.has(String(a.memory_id))) continue;
        for (let j = i + 1; j < rows.length; j += 1) {
          const b = rows[j];
          if (String(a.scope || 'shared') !== String(b.scope || 'shared')) continue;
          if (String(a.type || 'CONTEXT') !== String(b.type || 'CONTEXT')) continue;
          if (archivedInRun.has(String(b.memory_id))) continue;
          const similarity = jaccardSimilarityFromFingerprints(
            semanticFingerprints.get(String(a.memory_id)),
            semanticFingerprints.get(String(b.memory_id)),
          );
          const typeKey = String(a.type || 'CONTEXT').toUpperCase();
          if (!semanticThresholdsByType.has(typeKey)) {
            semanticThresholdsByType.set(typeKey, resolveSemanticThresholds(typeKey, config));
          }
          const semanticThresholds = semanticThresholdsByType.get(typeKey);
          if (similarity >= Number(semanticThresholds.auto)) {
            const { winner, loser } = pickSemanticQueuePair(a, b);
            if (isProtectedMemory(loser)) continue;
            archivedInRun.add(String(loser.memory_id));
            if (!dryRun) {
              updateCurrentStatus(db, loser.memory_id, 'archived', {
                value_label: 'archive_candidate',
                timestamp: nowIso,
              });
            }
            archivedOrKilledRows.push({
              memory_id: String(loser.memory_id),
              type: String(loser.type || ''),
              scope: String(loser.scope || ''),
              before_status: String(loser.status || 'active'),
              after_status: 'archived',
              reason_codes: ['duplicate_semantic'],
              similarity,
              matched_memory_id: String(winner.memory_id),
              content: String(loser.content || ''),
            });
            eventCounts.dedupe_semantic_archived += 1;
            emit({
              timestamp: nowIso,
              component: 'maintenance',
              action: 'dedupe_semantic_archive',
              reason_codes: ['duplicate_semantic'],
              memory_id: String(loser.memory_id),
              matched_memory_id: String(winner.memory_id),
              similarity,
              payload: {
                winner_id: String(winner.memory_id),
              },
            });
          } else if (similarity >= Number(semanticThresholds.review)) {
            const { winner, loser } = pickSemanticQueuePair(a, b);
            // Guard unavailable (null = queue unreadable): skip enqueueing
            // entirely this run rather than duplicating every pending pair.
            if (!pendingSemanticPairs) continue;
            const pairKey = `${String(loser.memory_id)}|${String(winner.memory_id)}`;
            if (pendingSemanticPairs.has(pairKey)) continue;
            pendingSemanticPairs.add(pairKey);
            eventCounts.dedupe_semantic_review_queue += 1;
            queueReview(queuePath, buildSemanticReviewQueueRow({
              winner,
              loser,
              similarity,
              nowIso,
            }), {
              dryRun,
            });
            emit({
              timestamp: nowIso,
              component: 'maintenance',
              action: 'dedupe_semantic_review_queue',
              reason_codes: ['duplicate_semantic'],
              memory_id: String(loser.memory_id),
              matched_memory_id: String(winner.memory_id),
              similarity,
              payload: {
                winner_id: String(winner.memory_id),
                loser_id: String(loser.memory_id),
              },
            });
          }
        }
      }
    });

    // Phase 0B: Auto-resolve dedupe items stuck pending >7 days
    const autoResolveDays = Number(config?.dedupe?.autoResolvePendingDays ?? 7);
    if (autoResolveDays > 0 && queuePath) {
      try {
        // This rewrite must use the SAME lock + atomic temp/rename discipline
        // as every other queue writer. A bare read-mutate-overwrite can race
        // appendQueueRow parks, which hold the ONLY copy of parked remember
        // content, and can truncate the queue on a crash mid-write.
        withQueueLock(queuePath, {}, () => {
        const queueState = readFileIfExistsSync(queuePath, 'utf8');
        if (!queueState.exists) return;
        const queueLines = queueState.data.split('\n').filter(Boolean);
        const cutoffMs = Date.now() - (autoResolveDays * 24 * 60 * 60 * 1000);
        const kept = [];
        let mutatedRows = 0;
        let autoResolved = 0;
        for (const line of queueLines) {
          try {
            const row = JSON.parse(line);
            const rowTs = Date.parse(String(row?.queued_at || row?.timestamp || ''));
            const rowStatus = String(row?.status || '').trim().toLowerCase();
            const isPendingSemantic = (
              String(row?.reason_code || row?.reason || '') === 'duplicate_semantic'
              && rowStatus === 'pending'
            );
            if (isPendingSemantic && Number.isFinite(rowTs) && rowTs < cutoffMs) {
              const winnerId = String(row?.winner_memory_id || row?.matched_memory_id || '');
              const loserId = String(row?.loser_memory_id || row?.memory_id || '');
              const winnerRow = winnerId
                ? db.prepare('SELECT memory_id, type, scope, status, content, normalized, confidence, created_at, updated_at, tags FROM memory_current WHERE memory_id = ?').get(winnerId)
                : null;
              const loserRow = loserId
                ? db.prepare('SELECT memory_id, type, scope, status, content, normalized, confidence, created_at, updated_at, tags FROM memory_current WHERE memory_id = ?').get(loserId)
                : null;
              const pairStillActive = (
                winnerRow
                && loserRow
                && String(winnerRow.status || '') === 'active'
                && String(loserRow.status || '') === 'active'
              );
              if (pairStillActive) {
                const currentPair = pickSemanticQueuePair(winnerRow, loserRow);
                const winnerStillWins = String(currentPair.winner?.memory_id || '') === winnerId;
                const loserStillLoses = String(currentPair.loser?.memory_id || '') === loserId;
                const thresholds = resolveSemanticThresholds(loserRow.type || winnerRow.type || 'CONTEXT', config);
                const currentSimilarity = jaccardSimilarity(
                  loserRow.content || loserRow.normalized || '',
                  winnerRow.content || winnerRow.normalized || '',
                );
                const stillBorderline = (
                  currentSimilarity >= Number(thresholds.review)
                  && currentSimilarity < Number(thresholds.auto)
                );
                // Off by default: pending age adds no evidence about whether
                // two borderline-similar memories are actually duplicates, so
                // auto-archiving on timeout can destroy distinct memories.
                const autoArchiveEnabled = config?.dedupe?.autoResolveArchive === true;
                if (autoArchiveEnabled && winnerStillWins && loserStillLoses && stillBorderline) {
                  if (!dryRun) {
                    updateCurrentStatus(db, loserId, 'archived', {
                      value_label: 'auto_resolved_dedupe',
                      timestamp: nowIso,
                    });
                  }
                  archivedOrKilledRows.push({
                    memory_id: loserId,
                    type: String(loserRow.type || ''),
                    scope: String(loserRow.scope || ''),
                    before_status: 'active',
                    after_status: 'archived',
                    reason_codes: ['auto_resolved_dedupe', 'pending_timeout_7d'],
                    similarity: currentSimilarity,
                    matched_memory_id: winnerId,
                    content: String(loserRow.content || ''),
                    auto_resolved: true,
                    auto_resolved_reason: 'pending_timeout_7d',
                    auto_resolved_at: nowIso,
                    auto_resolved_original_status: String(row?.status || 'pending'),
                  });
                  autoResolved += 1;
                  emit({
                    timestamp: nowIso,
                    component: 'maintenance',
                    action: 'auto_resolve_dedupe',
                    reason_codes: ['pending_timeout_7d'],
                    memory_id: loserId,
                    matched_memory_id: winnerId,
                    payload: {
                      similarity: currentSimilarity,
                      pending_since: row?.queued_at || row?.timestamp || '',
                      auto_resolved_reason: 'pending_timeout_7d',
                    },
                  });
                  row.status = 'resolved_auto';
                  row.auto_resolved = true;
                  row.auto_resolved_reason = 'pending_timeout_7d';
                  row.resolved_reason = 'pending_timeout_7d';
                  row.resolved_at = nowIso;
                  row.updated_at = nowIso;
                  row.similarity = currentSimilarity;
                  mutatedRows += 1;
                }
              }
              if (String(row.status || '') === 'pending') {
                // Past the timeout and not auto-resolved: close as stale
                // instead of pending forever (both memories keep their status).
                // The nightly scan re-queues the pair if it still matters.
                row.status = 'resolved_stale';
                row.resolved_reason = pairStillActive ? 'expired_unresolved' : 'pair_no_longer_active';
                row.resolved_at = nowIso;
                row.updated_at = nowIso;
                mutatedRows += 1;
              }
            }
            kept.push(JSON.stringify(row));
          } catch {
            kept.push(line);
          }
        }
        // Gate on ANY row mutation, not just archives: stale-closures alone
        // must persist too (they were silently discarded before when
        // autoResolved stayed 0).
        if (mutatedRows > 0 && !dryRun) {
          atomicWriteFileSync(queuePath, kept.join('\n') + '\n', { mode: 0o600 });
        }
        eventCounts.dedupe_auto_resolved = autoResolved;
        });
      } catch (error) {
        // Not silently best-effort anymore: a failed rewrite after DB-side
        // archives already committed leaves queue and DB divergent — that has
        // to be visible in the events ledger.
        emit({
          timestamp: nowIso,
          component: 'maintenance',
          action: 'auto_resolve_dedupe_failed',
          reason_codes: ['auto_resolve_rewrite_failed'],
          memory_id: `run:${resolvedRunId}`,
          payload: { error: String(error?.message || error) },
        });
      }
    }

    const queueRetention = applyQueueRetention(
      queuePath,
      config?.runtime?.reviewQueueRetention,
      { dryRun },
    );
    eventCounts.queue_rows_pruned = Number(queueRetention?.dropped_rows || 0);
    eventCounts.queue_malformed_rows = Number(queueRetention?.malformed_rows || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'review_queue_retention',
      reason_codes: ['queue_retention'],
      memory_id: `run:${resolvedRunId}`,
      payload: queueRetention,
    });

    rebuildEntityMentions(db);
    eventCounts.entity_mentions_rebuilt = 1;

    if (config?.worldModel?.enabled === false) {
      // U17: the toggle gates the world-model SURFACES only — nightly
      // maintenance still arbitrates fresh rows through the extracted module
      // so verdicts and supersession never stall while the world model is OFF.
      const arbitration = runBeliefArbitration({
        db,
        config,
        now: nowIso,
        projectBeliefRows: projectArbitrationBeliefRows,
      });
      eventCounts.belief_arbitration_verdicts = Number(arbitration?.counts?.verdicts || 0);
      eventCounts.belief_arbitration_beliefs = Number(arbitration?.counts?.beliefs || 0);
      emit({
        timestamp: nowIso,
        component: 'maintenance',
        action: 'belief_arbitration_refresh',
        reason_codes: ['world_model_disabled'],
        memory_id: `run:${resolvedRunId}`,
        payload: arbitration?.counts || {},
      });
    }
    if (config?.worldModel?.enabled !== false) {
      const worldModelSummary = rebuildWorldModel({ db, config, now: nowIso });
      eventCounts.world_model_entities = Number(worldModelSummary?.counts?.entities || 0);
      eventCounts.world_model_beliefs = Number(worldModelSummary?.counts?.beliefs || 0);
      eventCounts.world_model_episodes = Number(worldModelSummary?.counts?.episodes || 0);
      eventCounts.world_model_open_loops = Number(worldModelSummary?.counts?.open_loops || 0);
      eventCounts.world_model_contradictions = Number(worldModelSummary?.counts?.contradictions || 0);
      eventCounts.world_model_syntheses = Number(worldModelSummary?.counts?.syntheses || 0);
      emit({
        timestamp: nowIso,
        component: 'maintenance',
        action: 'world_model_refresh',
        reason_codes: ['complete'],
        memory_id: `run:${resolvedRunId}`,
        payload: worldModelSummary,
      });

      // Phase 4C: Auto-resolve open loops
      if (config?.worldModel?.autoResolveLoops !== false && !dryRun) {
        try {
          const loopResult = resolveOpenLoopsFromNewMemories(db, config);
          eventCounts.open_loops_auto_resolved = Number(loopResult.resolved || 0);
          emit({
            timestamp: nowIso,
            component: 'maintenance',
            action: 'open_loop_auto_resolve',
            reason_codes: [loopResult.resolved > 0 ? 'complete' : 'noop'],
            memory_id: `run:${resolvedRunId}`,
            payload: loopResult,
          });
        } catch {
          // auto-resolve is best-effort
        }
      }
    }

    const archiveSummaryPath = writeArchiveCompression({
      workspaceRoot,
      rows: changedForArchiveSummary,
      runId: resolvedRunId,
      dryRun,
    });
    const nativeSyncReportPath = path.join(artifactOutputDir, `memory-native-sync-${dateKey}.md`);
    fs.writeFileSync(nativeSyncReportPath, renderNativeSyncMarkdown({
      timestamp: nowIso,
      runId: resolvedRunId,
      summary: nativeSyncSummary,
    }), 'utf8');
    const archivedArtifacts = writeArchivedOrKilledArtifacts({
      outputDir: artifactOutputDir,
      dateKey,
      rows: archivedOrKilledRows,
    });
    const keptRows = listCurrentMemories(db, { statuses: ['active'], limit: 300000 });
    const keptArtifactPath = writeKeptArtifact({
      outputDir: artifactOutputDir,
      dateKey,
      rows: keptRows,
    });

    if (!dryRun && config?.maintenance?.vacuum !== false) {
      db.exec('VACUUM');
    }
    let ftsRebuildResult = { ok: true, skipped: false };
    try {
      rebuildFTS5(db);
      eventCounts.fts_rebuild_ok = 1;
    } catch (ftsErr) {
      ftsRebuildResult = {
        ok: false,
        skipped: false,
        error: String(ftsErr?.message || ftsErr).slice(0, 200),
      };
      eventCounts.fts_rebuild_failed = 1;
      emit({
        timestamp: nowIso,
        component: 'maintenance',
        action: 'fts_rebuild',
        reason_codes: ['error'],
        memory_id: `run:${resolvedRunId}`,
        payload: ftsRebuildResult,
      });
    }

    let embeddingBuildResult = { ok: false, skipped: true, reason: 'semantic_rerank_disabled' };
    if (config?.recall?.semanticRerankEnabled === true) {
      try {
        const summary = buildMissingEmbeddings(db, config);
        embeddingBuildResult = {
          ok: true,
          skipped: false,
          ...summary,
        };
        eventCounts.embeddings_computed = Number(summary.computed || 0);
        eventCounts.embeddings_skipped = Number(summary.skipped || 0);
        eventCounts.embeddings_failed = Number(summary.failed || 0);
      } catch (embeddingErr) {
        embeddingBuildResult = {
          ok: false,
          skipped: false,
          error: String(embeddingErr?.message || embeddingErr).slice(0, 200),
        };
      }
      emit({
        timestamp: nowIso,
        component: 'maintenance',
        action: 'embedding_build',
        reason_codes: [embeddingBuildResult.ok ? 'complete' : embeddingBuildResult.skipped ? 'skipped' : 'error'],
        memory_id: `run:${resolvedRunId}`,
        payload: embeddingBuildResult,
      });
    }

    // Phase 1D: eval_quality step — run eval harness in-process against the already-open DB.
    let evalResult = { ok: false, skipped: true, reason: 'eval_harness_not_available' };
    try {
      const evalCasesPath = path.join(PACKAGE_ROOT, 'eval', 'cases.jsonl');
      if (fs.existsSync(evalCasesPath)) {
        const evalOutPath = path.join(artifactOutputDir, `eval-nightly-${dateKey}.json`);
        const cases = loadEvalCases(evalCasesPath);
        const report = evalRecall({ db, config, cases, mode: 'live' });
        fs.writeFileSync(evalOutPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        const agg = report?.aggregate || {};
        const evalId = `eval-${nowIso.slice(0, 10)}-${resolvedRunId.slice(0, 12)}`;
        const pkgPath = path.join(PACKAGE_ROOT, 'package.json');
        let version = '';
        try { version = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))?.version || ''; } catch { /* ignore */ }
        if (!dryRun && agg.case_count) {
          db.prepare(`INSERT OR REPLACE INTO memory_eval_history
            (id, run_date, version, precision_at_1, precision_at_3, precision_at_5, mrr, ndcg_at_5, hit_rate, case_count, strategy_accuracy, avg_injection_tokens, latency_median_ms, latency_p95_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            evalId,
            nowIso.slice(0, 10),
            version,
            Number(agg.precision_at_1 || 0),
            Number(agg.precision_at_3 || 0),
            Number(agg.precision_at_5 || 0),
            Number(agg.mrr || 0),
            Number(agg.ndcg_at_5 || 0),
            Number(agg.hit_rate || 0),
            Number(agg.case_count || 0),
            Number(agg.strategy_accuracy || 0),
            Number(agg.avg_injection_tokens || 0),
            Number(agg.latency_median_ms || 0),
            Number(agg.latency_p95_ms || 0),
          );
        }
        evalResult = {
          ok: true,
          skipped: false,
          case_count: Number(agg.case_count || 0),
          aggregate: agg,
          output_path: evalOutPath,
        };
        eventCounts.eval_case_count = Number(agg.case_count || 0);
        eventCounts.eval_precision_at_3 = Number(agg.precision_at_3 || 0);
        eventCounts.eval_mrr = Number(agg.mrr || 0);
      }
    } catch (evalErr) {
      evalResult = { ok: false, skipped: false, error: String(evalErr?.message || evalErr).slice(0, 200) };
    }
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'eval_quality',
      reason_codes: [evalResult.ok ? 'complete' : evalResult.skipped ? 'skipped' : 'error'],
      memory_id: `run:${resolvedRunId}`,
      payload: evalResult,
    });

    // idea #5 — wiki_project. Materializes the FINAL arbitrated CURRENT belief
    // set into the git wiki tree and commits a GigaBrain-authored projection
    // commit (DETERMINISTIC + byte-stable: no belief change → no commit). Runs
    // AFTER the world-model rebuild so it projects the consolidated state, and
    // AFTER wiki_reconcile so a human edit ingested this cycle is reproduced
    // rather than clobbered (ordering guard refuses to regenerate over an
    // un-reconciled human edit). native.wiki.enabled:false (DEFAULT) → zero-cost
    // no-op. Best-effort: a wiki/git failure must never abort the nightly run.
    let wikiProjectSummary = { enabled: false, committed: false, files: 0 };
    try {
      wikiProjectSummary = projectWiki({ db, config, dryRun });
    } catch (wikiErr) {
      wikiProjectSummary = { enabled: true, error: String(wikiErr?.message || wikiErr).slice(0, 200), committed: false, files: 0 };
    }
    eventCounts.wiki_project_committed = wikiProjectSummary.committed ? 1 : 0;
    eventCounts.wiki_project_files = Number(wikiProjectSummary.files || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'wiki_project',
      reason_codes: [
        wikiProjectSummary.error ? 'error'
          : (wikiProjectSummary.enabled !== true ? 'noop'
            : (wikiProjectSummary.committed ? 'complete' : 'noop')),
      ],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        enabled: wikiProjectSummary.enabled === true,
        committed: wikiProjectSummary.committed === true,
        changed: wikiProjectSummary.changed === true,
        files: eventCounts.wiki_project_files,
        removed: Number(wikiProjectSummary.removed || 0),
        sha: wikiProjectSummary.sha || null,
        skipped: wikiProjectSummary.skipped || '',
        error: wikiProjectSummary.error || '',
      },
    });

    const compactSnapshot = path.join(snapshotDir, `registry-compact-${nowStamp()}.sqlite`);
    if (!dryRun && snapshotDatabase(db, dbPath, compactSnapshot)) {
      eventCounts.snapshots_created += 1;
    }

    const pruned = pruneBackups({
      snapshotDir,
      compactDays: Number(config?.maintenance?.compactDays ?? 30),
      emergencyDays: Number(config?.maintenance?.emergencyUnvacuumedDays ?? 7),
      maxEmergencyFiles: Number(config?.maintenance?.maxEmergencyFiles ?? 1),
      maxCompactFiles: Number(config?.maintenance?.maxCompactFiles ?? 5),
    });
    eventCounts.backups_pruned = Number(pruned.pruned || 0);

    const postMetrics = captureSnapshotMetrics(db, dbPath);
    const recallLatency = getRecallLatencyStats();
    const finishedAt = new Date().toISOString();
    let executionArtifactPath = writeExecutionArtifact({
      outputDir: artifactOutputDir,
      dateKey,
      payload: {
        triggered_at: startedAt,
        started_at: startedAt,
        finished_at: finishedAt,
        run_id: resolvedRunId,
        trigger_source: 'gigabrainctl-nightly',
        sequence: DAILY_SEQUENCE,
        cleanup_version: cleanupVersion,
        dry_run: dryRun,
        counts: eventCounts,
        recall_latency: recallLatency,
        eval: evalResult,
        fts_rebuild: ftsRebuildResult,
        artifacts: {
          archive_summary_path: archiveSummaryPath,
          native_sync_report_path: nativeSyncReportPath,
          archived_or_killed_md: archivedArtifacts.mdPath,
          archived_or_killed_jsonl: archivedArtifacts.jsonlPath,
          archived_or_killed_csv: archivedArtifacts.csvPath,
          kept_md: keptArtifactPath,
          usage_log_path: usageLogPath,
          events_path: eventsPath,
          queue_path: queuePath,
        },
        metrics: postMetrics,
      },
    });

    let graphBuildResult = { ok: false, skipped: true, reason: 'graph_build_not_run' };
    try {
      const graphScript = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'graph-build.js');
      if (fs.existsSync(graphScript)) {
        const graphArgs = [graphScript];
        if (configPath) {
          graphArgs.push('--config', String(configPath));
        }
        const graphOut = execFileSync(process.execPath, graphArgs, {
          timeout: 120000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const jsonMatch = graphOut.match(/\{[\s\S]*"ok"\s*:\s*true[\s\S]*\}/);
        if (jsonMatch) {
          try {
            graphBuildResult = JSON.parse(jsonMatch[0]);
          } catch {
            graphBuildResult = { ok: true, raw: true };
          }
        } else {
          graphBuildResult = { ok: true, raw: true };
        }
      } else {
        graphBuildResult = { ok: false, skipped: true, reason: 'graph_script_missing' };
      }
    } catch (graphErr) {
      graphBuildResult = {
        ok: false,
        error: String(graphErr?.message || graphErr).slice(0, 200),
      };
    }
    eventCounts.graph_node_count = Number(graphBuildResult?.node_count || graphBuildResult?.nodes || 0);
    eventCounts.graph_edge_count = Number(graphBuildResult?.edge_count || graphBuildResult?.edges || 0);
    emit({
      timestamp: new Date().toISOString(),
      component: 'maintenance',
      action: 'graph_build',
      reason_codes: [graphBuildResult.ok ? 'complete' : graphBuildResult.skipped ? 'skipped' : 'error'],
      memory_id: `run:${resolvedRunId}`,
      payload: graphBuildResult,
    });

    executionArtifactPath = writeExecutionArtifact({
      outputDir: artifactOutputDir,
      dateKey,
      payload: {
        triggered_at: startedAt,
        started_at: startedAt,
        finished_at: finishedAt,
        run_id: resolvedRunId,
        trigger_source: 'gigabrainctl-nightly',
        sequence: DAILY_SEQUENCE,
        cleanup_version: cleanupVersion,
        dry_run: dryRun,
        counts: eventCounts,
        recall_latency: recallLatency,
        eval: evalResult,
        fts_rebuild: ftsRebuildResult,
        graph: graphBuildResult,
        artifacts: {
          archive_summary_path: archiveSummaryPath,
          native_sync_report_path: nativeSyncReportPath,
          eval_report_path: evalResult.output_path || '',
          archived_or_killed_md: archivedArtifacts.mdPath,
          archived_or_killed_jsonl: archivedArtifacts.jsonlPath,
          archived_or_killed_csv: archivedArtifacts.csvPath,
          kept_md: keptArtifactPath,
          usage_log_path: usageLogPath,
          events_path: eventsPath,
          queue_path: queuePath,
        },
        metrics: postMetrics,
      },
    });

    emit({
      timestamp: finishedAt,
      component: 'maintenance',
      action: 'maintenance_end',
      reason_codes: ['complete'],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        archive_summary_path: archiveSummaryPath,
        native_sync_report_path: nativeSyncReportPath,
        archived_or_killed_md: archivedArtifacts.mdPath,
        archived_or_killed_jsonl: archivedArtifacts.jsonlPath,
        archived_or_killed_csv: archivedArtifacts.csvPath,
        kept_md: keptArtifactPath,
        execution_artifact_path: executionArtifactPath,
        metrics: postMetrics,
      },
    });

    appendUsageLog(usageLogPath, renderUsageLogEntry({
      timestamp: finishedAt,
      runId: resolvedRunId,
      cleanupVersion,
      sequence: DAILY_SEQUENCE,
      metrics: postMetrics,
      events: eventCounts,
      recallLatency,
    }));

    return {
      ok: true,
      runId: resolvedRunId,
      cleanupVersion,
      dryRun,
      sequence: DAILY_SEQUENCE,
      snapshots: {
        emergency: emergencySnapshot,
        compact: compactSnapshot,
      },
      artifacts: {
        archiveSummaryPath,
        nativeSyncReportPath,
        archivedOrKilledMdPath: archivedArtifacts.mdPath,
        archivedOrKilledJsonlPath: archivedArtifacts.jsonlPath,
        archivedOrKilledCsvPath: archivedArtifacts.csvPath,
        keptMdPath: keptArtifactPath,
        executionArtifactPath,
        eventsPath,
        usageLogPath,
        queuePath,
      },
      preMetrics,
      postMetrics,
      eventCounts,
    };
  } finally {
    db.close();
  }
};

export {
  DAILY_SEQUENCE,
  runMaintenance,
};

import fs from 'node:fs';
import path from 'node:path';
import { assertWriteAllowed, resolveWriteMode } from '../compat/write-policy.js';
import { assertConfiguredCandidateOperation } from '../compat/candidate-safety-guard.js';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { appendEvent } from './event-store.js';
import {
  ensureProjectionStore,
  listCurrentMemories,
  materializeProjectionFromMemories,
  rebuildFTS5,
  updateCurrentStatus,
  withProjectionMutationBatch,
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
import { withNativeMemoryLock } from './native-memory.js';
import { promoteNativeChunks } from './native-promotion.js';
import { syncVaultMemory } from './vault-sync.js';
import { discoverHostSources, shouldRunAutomaticHostSync, syncHostMemories } from './host-memory-sync.js';
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
import { loadDatabaseSync, openDatabase } from './sqlite.js';
import { atomicWriteFileSync, readFileIfExistsSync } from './safe-fs.js';

const DAILY_SEQUENCE = Object.freeze([
  '01 preflight_config_scope_write_mode',
  '02 engine_consistent_pre_backup',
  '03 native_sync',
  '04 native_promotion',
  '05 native_reconciliation',
  '06 hygiene_test_session_generated_artifacts',
  '07 vault_reference_sync_optional',
  '08 host_sync_optional',
  '09 transcript_harvest_optional',
  '10 wiki_reconcile_optional',
  '11 memory_review_queue',
  '12 adaptive_trust_shadow',
  '13 belief_arbitration',
  '14 quality_review',
  '15 same_scope_dedupe',
  '16 entity_mentions_and_world_model',
  '17 open_loops_syntheses_and_archive_retention',
  '18 vacuum_compaction',
  '19 fts_refresh',
  '20 qwen_embedding_backfill',
  '21 recall_eval_gate',
  '22 wiki_projection_optional',
  '23 generated_surface_and_graph_refresh',
  '24 final_integrity_and_run_receipt',
]);

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const stableMaintenanceOperationId = (value) => String(value || 'maintenance')
  .replace(/[^A-Za-z0-9._-]/g, '-')
  .slice(0, 128) || 'maintenance';
const maintenanceCompletionId = (stage, memoryId, matchedMemoryId = '') => stableMaintenanceOperationId(
  `maintenance-${stage}-${memoryId}-${matchedMemoryId || 'none'}-v1`,
);
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

const fsyncDirectory = (directory) => {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

const snapshotError = (code, message, cause = null) => {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
};

const quoteIdentifier = (value) => `"${String(value || '').replaceAll('"', '""')}"`;
const binaryCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const canonicalDatabaseValue = (value) => {
  if (value === null || value === undefined) return ['null'];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'nan'];
    if (value === Infinity) return ['number', 'infinity'];
    if (value === -Infinity) return ['number', '-infinity'];
    if (Object.is(value, -0)) return ['number', '-0'];
    return ['number', String(value)];
  }
  if (typeof value === 'string') return ['text', value];
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('hex')];
  return ['other', String(value)];
};

const logicalDatabaseManifest = (db) => {
  const rawSchema = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence'
    ORDER BY type COLLATE BINARY, name COLLATE BINARY
  `).all().map((row) => [
    String(row.type || ''),
    String(row.name || ''),
    String(row.tbl_name || ''),
    row.sql === null || row.sql === undefined ? null : String(row.sql),
  ]);
  const virtualTables = rawSchema
    .filter(([type, , , sql]) => type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(String(sql || '')))
    .map(([, name]) => name);
  const isVirtualShadowTable = (name) => virtualTables.some((virtualName) => (
    name !== virtualName && name.startsWith(`${virtualName}_`)
  ));
  // FTS/RTREE shadow rows encode physical index segments. VACUUM may repack
  // those BLOBs while preserving the virtual table's logical rows exactly.
  const schema = rawSchema.filter(([type, name]) => type !== 'table' || !isVirtualShadowTable(name));
  const tables = {};

  for (const schemaRow of schema.filter(([type]) => type === 'table')) {
    const tableName = schemaRow[1];
    const columns = db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`).all()
      .filter((column) => Number(column.hidden || 0) === 0)
      .sort((left, right) => Number(left.cid) - Number(right.cid))
      .map((column) => String(column.name || ''));
    const selectList = columns.length > 0
      ? columns.map(quoteIdentifier).join(', ')
      : '*';
    const rows = db.prepare(`SELECT ${selectList} FROM ${quoteIdentifier(tableName)}`).all()
      .map((row) => JSON.stringify(columns.map((column) => canonicalDatabaseValue(row[column]))))
      .sort(binaryCompare);
    tables[tableName] = createHash('sha256')
      .update(JSON.stringify([columns, rows]), 'utf8')
      .digest('hex');
  }
  return Object.freeze({
    schema: createHash('sha256').update(JSON.stringify(schema), 'utf8').digest('hex'),
    tables: Object.freeze(tables),
  });
};

const logicalDatabaseHash = (db) => createHash('sha256')
  .update(JSON.stringify(logicalDatabaseManifest(db)), 'utf8')
  .digest('hex');

const WORLD_DERIVED_TABLES = Object.freeze([
  'memory_beliefs',
  'memory_claims',
  'memory_entities',
  'memory_entity_aliases',
  'memory_entity_mentions',
  'memory_entity_relationships',
  'memory_episodes',
  'memory_open_loops',
  'memory_syntheses',
]);

const worldDerivedLogicalRoot = (db) => {
  const manifest = logicalDatabaseManifest(db);
  const rows = WORLD_DERIVED_TABLES.map((name) => [name, manifest.tables[name] || null]);
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
};

const inspectFtsParity = (db) => {
  const exists = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_fts' LIMIT 1",
  ).get());
  if (!exists) return { currentRows: 0, driftRows: 1, exists: false, ftsRows: 0 };
  const missingFromFts = Number(db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT memory_id, content, COALESCE(normalized, '') AS normalized, type
      FROM memory_current WHERE status='active'
      EXCEPT
      SELECT memory_id, content, normalized, type FROM memory_fts
    )
  `).get()?.c || 0);
  const extraInFts = Number(db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT memory_id, content, normalized, type FROM memory_fts
      EXCEPT
      SELECT memory_id, content, COALESCE(normalized, '') AS normalized, type
      FROM memory_current WHERE status='active'
    )
  `).get()?.c || 0);
  const currentRows = Number(db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE status='active'").get()?.c || 0);
  const ftsRows = Number(db.prepare('SELECT COUNT(*) AS c FROM memory_fts').get()?.c || 0);
  return {
    currentRows,
    driftRows: missingFromFts + extraInFts + Math.abs(currentRows - ftsRows),
    exists: true,
    ftsRows,
  };
};

const nearestExistingDirectory = (targetPath) => {
  let current = path.dirname(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
};

const removeFailedSnapshot = (targetPath) => {
  try {
    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile()) fs.unlinkSync(targetPath);
  } catch {
    // Preserve the original snapshot/validation failure.
  }
};

const snapshotDatabase = (db, target, options = {}) => {
  if (!db || !target) throw snapshotError('SNAPSHOT_INVALID_ARGUMENT', 'database and target are required');
  const targetPath = path.resolve(String(target));
  if (fs.existsSync(targetPath)) {
    throw snapshotError('SNAPSHOT_VACUUM_INTO_FAILED', `snapshot target already exists: ${targetPath}`);
  }

  const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count || 0);
  const freeListCount = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count || 0);
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size || 0);
  const liveBytes = Math.max(pageSize, Math.max(0, pageCount - freeListCount) * pageSize);
  const requiredBytes = Math.max(liveBytes * 2, liveBytes + (16 * 1024 * 1024));
  const statfs = typeof options.statfs === 'function' ? options.statfs : fs.statfsSync;
  const filesystem = statfs(nearestExistingDirectory(targetPath));
  const freeBytes = Number(filesystem?.bavail || 0) * Number(filesystem?.bsize || 0);
  if (!Number.isFinite(freeBytes) || freeBytes < requiredBytes) {
    throw snapshotError(
      'SNAPSHOT_INSUFFICIENT_SPACE',
      `snapshot requires ${requiredBytes} bytes but only ${Number.isFinite(freeBytes) ? freeBytes : 0} are available`,
    );
  }

  const sourceRow = db.prepare('PRAGMA database_list').all()
    .find((row) => String(row.name || '') === 'main');
  const sourcePath = path.resolve(String(sourceRow?.file || ''));
  if (!sourceRow?.file || !fs.existsSync(sourcePath)) {
    throw snapshotError('SNAPSHOT_SOURCE_PATH_UNAVAILABLE', 'main database must be a filesystem-backed SQLite file');
  }

  ensureFileDir(targetPath);
  const DatabaseSync = loadDatabaseSync();
  const observer = new DatabaseSync(`${pathToFileURL(sourcePath).href}?mode=ro`, { readOnly: true });
  const maxAttempts = Math.max(1, Math.min(5, Math.trunc(Number(options.maxAttempts || 3))));
  try {
    observer.exec('PRAGMA query_only = ON');
    const readDataVersion = () => Number(observer.prepare('PRAGMA data_version').get()?.data_version || 0);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const dataVersionBefore = readDataVersion();
      try {
        db.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`);
        if (typeof options.afterVacuum === 'function') {
          options.afterVacuum({ attempt, sourcePath, targetPath });
        }
      } catch (cause) {
        removeFailedSnapshot(targetPath);
        throw snapshotError('SNAPSHOT_VACUUM_INTO_FAILED', `VACUUM INTO failed for ${targetPath}`, cause);
      }

      try {
        fs.chmodSync(targetPath, 0o600);
        const sourceLogicalManifest = logicalDatabaseManifest(db);
        const sourceLogicalHash = createHash('sha256')
          .update(JSON.stringify(sourceLogicalManifest), 'utf8')
          .digest('hex');
        const dataVersionAfter = readDataVersion();
        if (dataVersionAfter !== dataVersionBefore) {
          removeFailedSnapshot(targetPath);
          if (attempt < maxAttempts) continue;
          throw snapshotError(
            'SNAPSHOT_SOURCE_CHANGED',
            `source changed during ${maxAttempts} consecutive snapshot attempt(s)`,
          );
        }

        const uri = `${pathToFileURL(targetPath).href}?mode=ro&immutable=1`;
        const immutable = new DatabaseSync(uri, { readOnly: true });
        let quickCheck = '';
        let foreignKeyErrors = 0;
        let targetLogicalHash = '';
        let targetLogicalManifest = null;
        try {
          immutable.exec('PRAGMA query_only = ON');
          const quickRows = immutable.prepare('PRAGMA quick_check').all();
          const quickValues = quickRows.map((row) => String(row.quick_check || Object.values(row)[0] || ''));
          quickCheck = quickValues.length === 1 && quickValues[0] === 'ok' ? 'ok' : quickValues.join('; ');
          if (quickCheck !== 'ok') {
            throw snapshotError('SNAPSHOT_QUICK_CHECK_FAILED', quickCheck || 'quick_check returned no result');
          }
          foreignKeyErrors = immutable.prepare('PRAGMA foreign_key_check').all().length;
          if (foreignKeyErrors > 0) {
            throw snapshotError('SNAPSHOT_FOREIGN_KEY_CHECK_FAILED', `${foreignKeyErrors} foreign-key violation(s)`);
          }
          targetLogicalManifest = logicalDatabaseManifest(immutable);
          targetLogicalHash = createHash('sha256')
            .update(JSON.stringify(targetLogicalManifest), 'utf8')
            .digest('hex');
        } finally {
          immutable.close();
        }
        if (sourceLogicalHash !== targetLogicalHash) {
          const changed = [];
          if (sourceLogicalManifest.schema !== targetLogicalManifest?.schema) changed.push('schema');
          const names = new Set([
            ...Object.keys(sourceLogicalManifest.tables),
            ...Object.keys(targetLogicalManifest?.tables || {}),
          ]);
          for (const name of [...names].sort(binaryCompare)) {
            if (sourceLogicalManifest.tables[name] !== targetLogicalManifest?.tables?.[name]) changed.push(name);
          }
          throw snapshotError(
            'SNAPSHOT_LOGICAL_HASH_MISMATCH',
            `source and snapshot logical roots differ (${changed.join(', ') || 'unknown'})`,
          );
        }
        return Object.freeze({
          ok: true,
          method: 'vacuum_into',
          targetPath,
          quickCheck,
          foreignKeyErrors,
          sourceLogicalHash,
          targetLogicalHash,
          immutable: true,
          targetMode: '0600',
          freeBytes,
          requiredBytes,
          sizeBytes: fs.statSync(targetPath).size,
          attempts: attempt,
          sourceDataVersion: dataVersionAfter,
        });
      } catch (error) {
        removeFailedSnapshot(targetPath);
        if (error?.code) throw error;
        throw snapshotError('SNAPSHOT_VALIDATION_FAILED', `snapshot validation failed for ${targetPath}`, error);
      }
    }
  } finally {
    observer.close();
  }
  throw snapshotError('SNAPSHOT_SOURCE_CHANGED', `source changed during ${maxAttempts} snapshot attempt(s)`);
};

const executeDailySequence = async ({
  disabledStages = new Set(),
  gatedStages = new Map(),
  handlers = {},
  mode = 'normal',
  onTransition = null,
} = {}) => {
  const disabled = disabledStages instanceof Set ? disabledStages : new Set(disabledStages || []);
  const gated = gatedStages instanceof Map ? gatedStages : new Map(Object.entries(gatedStages || {}));
  const receipts = [];
  let failed = false;
  let originalFailure = null;
  let mutationCount = 0;
  const record = (receipt) => {
    receipts.push(Object.freeze(receipt));
    if (typeof onTransition === 'function') onTransition(Object.freeze([...receipts]), receipts.at(-1));
  };
  for (const stage of DAILY_SEQUENCE) {
    const finalStage = stage === DAILY_SEQUENCE.at(-1);
    if (failed && !finalStage) {
      record({ stage, status: 'skipped_gate', reason: 'prior_stage_failed' });
      continue;
    }
    if (!finalStage && disabled.has(stage)) {
      record({ stage, status: 'skipped_disabled', reason: 'disabled' });
      continue;
    }
    if (!finalStage && gated.has(stage)) {
      record({ stage, status: 'skipped_gate', reason: String(gated.get(stage) || 'gated') });
      continue;
    }
    const handler = handlers?.[stage];
    if (typeof handler !== 'function') {
      const error = `missing handler for ${stage}`;
      record({ stage, status: 'failed', error });
      if (!originalFailure) originalFailure = Object.freeze({ stage, error });
      failed = true;
      continue;
    }
    try {
      const result = await handler({
        mode,
        originalFailure,
        receipts: Object.freeze([...receipts]),
        stage,
      });
      if (result?.ok === false) throw new Error(String(result.error || result.reason || `${stage} failed`));
      if (result?.status === 'skipped_disabled') {
        record({ stage, status: 'skipped_disabled', reason: String(result.reason || 'disabled') });
        continue;
      }
      if (result?.status === 'skipped_gate') {
        record({ stage, status: 'skipped_gate', reason: String(result.reason || 'gated') });
        continue;
      }
      mutationCount += Math.max(0, Number(result?.mutationCount || 0));
      record({
        stage,
        status: 'completed',
        mutationCount: Math.max(0, Number(result?.mutationCount || 0)),
      });
    } catch (error) {
      record({
        stage,
        status: 'failed',
        error: String(error?.message || error).slice(0, 500),
      });
      if (!originalFailure) {
        originalFailure = Object.freeze({
          stage,
          error: String(error?.message || error).slice(0, 500),
        });
      }
      failed = true;
    }
  }
  return Object.freeze({
    ok: !failed,
    failure: originalFailure,
    mode: String(mode || 'normal'),
    mutationCount,
    receipts: Object.freeze(receipts),
  });
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

const prunePreNightlyBackups = ({
  maxAgeDays = 30,
  maxFiles = 14,
  preservePath = '',
  snapshotDir,
} = {}) => {
  const preserve = preservePath ? path.resolve(preservePath) : '';
  const cutoff = Date.now() - (Math.max(1, Number(maxAgeDays || 30)) * 24 * 60 * 60 * 1000);
  const limit = Math.max(1, Math.trunc(Number(maxFiles || 14)));
  const entries = fs.readdirSync(snapshotDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^registry-pre-nightly-.*\.sqlite$/.test(entry.name))
    .map((entry) => {
      const filePath = path.join(snapshotDir, entry.name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs, name: entry.name };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || binaryCompare(left.name, right.name));
  let kept = preserve ? 1 : 0;
  let pruned = 0;
  for (const entry of entries) {
    if (preserve && path.resolve(entry.filePath) === preserve) continue;
    const expired = entry.mtimeMs < cutoff;
    const overLimit = kept >= limit;
    if (expired || overLimit) {
      fs.unlinkSync(entry.filePath);
      pruned += 1;
    } else {
      kept += 1;
    }
  }
  return { kept, maxAgeDays: Math.max(1, Number(maxAgeDays || 30)), maxFiles: limit, pruned };
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

const runExactSameScopeDedupe = ({ config, db, nowIso, queuePath, runId }) => {
  const rows = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
  const groups = new Map();
  for (const row of rows) {
    const normalized = normalizeContent(row.normalized || row.content || '');
    if (!normalized) continue;
    const key = `${String(row.scope || 'shared')}\u0000${normalized}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  let archived = 0;
  withProjectionMutationBatch({
    db,
    now: nowIso,
    operationId: stableMaintenanceOperationId(`${runId}:same-scope-dedupe`),
  }, (tx) => {
    for (const list of groups.values()) {
      if (list.length <= 1) continue;
      const sorted = [...list].sort((left, right) => {
        const priority = protectionAwarePriority(right) - protectionAwarePriority(left);
        return priority || binaryCompare(String(left.memory_id || ''), String(right.memory_id || ''));
      });
      const winner = sorted[0];
      for (const loser of sorted.slice(1)) {
        if (isProtectedMemory(loser)) continue;
        updateCurrentStatus(db, loser.memory_id, 'archived', {
          value_label: 'archive_candidate',
          timestamp: nowIso,
        }, {
          tx,
          event: {
            timestamp: nowIso,
            component: 'maintenance',
            action: 'dedupe_exact_archive',
            reason_codes: ['duplicate_exact'],
            memory_id: String(loser.memory_id),
            matched_memory_id: String(winner.memory_id),
            run_id: runId,
            payload: {
              completion_id: maintenanceCompletionId('exact_dedupe', String(loser.memory_id), String(winner.memory_id)),
              maintenance_stage: 'same_scope_dedupe',
              winner_id: String(winner.memory_id),
            },
          },
        });
        archived += 1;
      }
    }
  });
  let queued = 0;
  if (config?.dedupe?.semanticEnabled === true) {
    const active = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
    const archivedInRun = new Set();
    const pendingPairs = loadPendingSemanticPairs(queuePath);
    const fingerprints = new Map(active.map((row) => [
      String(row.memory_id),
      createSemanticFingerprint(row.content || row.normalized || ''),
    ]));
    const queuedRows = [];
    withProjectionMutationBatch({
      db,
      now: nowIso,
      operationId: stableMaintenanceOperationId(`${runId}:same-scope-semantic-dedupe`),
    }, (tx) => {
      for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
        const left = active[leftIndex];
        if (archivedInRun.has(String(left.memory_id))) continue;
        for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
          const right = active[rightIndex];
          if (String(left.scope || 'shared') !== String(right.scope || 'shared')) continue;
          if (String(left.type || 'CONTEXT') !== String(right.type || 'CONTEXT')) continue;
          if (archivedInRun.has(String(right.memory_id))) continue;
          const similarity = jaccardSimilarityFromFingerprints(
            fingerprints.get(String(left.memory_id)),
            fingerprints.get(String(right.memory_id)),
          );
          const thresholds = resolveSemanticThresholds(String(left.type || 'CONTEXT'), config);
          const { winner, loser } = pickSemanticQueuePair(left, right);
          if (similarity >= Number(thresholds.auto)) {
            if (isProtectedMemory(loser)) continue;
            updateCurrentStatus(db, loser.memory_id, 'archived', {
              value_label: 'archive_candidate',
              timestamp: nowIso,
            }, {
              tx,
              event: {
                timestamp: nowIso,
                component: 'maintenance',
                action: 'dedupe_semantic_archive',
                reason_codes: ['duplicate_semantic'],
                memory_id: String(loser.memory_id),
                matched_memory_id: String(winner.memory_id),
                similarity,
                run_id: runId,
                payload: {
                  completion_id: maintenanceCompletionId('semantic_dedupe', String(loser.memory_id), String(winner.memory_id)),
                  maintenance_stage: 'same_scope_dedupe',
                  winner_id: String(winner.memory_id),
                },
              },
            });
            archivedInRun.add(String(loser.memory_id));
            archived += 1;
          } else if (similarity >= Number(thresholds.review) && pendingPairs) {
            const pairKey = `${String(loser.memory_id)}|${String(winner.memory_id)}`;
            if (pendingPairs.has(pairKey)) continue;
            pendingPairs.add(pairKey);
            queuedRows.push(buildSemanticReviewQueueRow({ winner, loser, similarity, nowIso }));
          }
        }
      }
    });
    for (const row of queuedRows) queueReview(queuePath, row);
    queued = queuedRows.length;
  }
  return { archived, mutationCount: archived + queued, ok: true, queued };
};

const runDailyMaintenanceSequenceUnlocked = async ({
  afterBackup = null,
  cohortIdentity = {},
  config,
  configPath = '',
  dbPath,
  directoryFsync = fsyncDirectory,
  mode = 'normal',
  outputDir = '',
  qualityReviewStage = null,
  reviewQueueStage = null,
  runId = '',
  surfaceRefreshStage = null,
  writeReceipt = true,
} = {}) => {
  assertConfiguredCandidateOperation({ operation: 'maintenance.mutate', config, registryPath: dbPath });
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'maintenance.run' });
  const resolvedRunId = String(runId || `nightly-${nowStamp()}`);
  const resolvedOutputDir = path.resolve(String(
    outputDir || config?.runtime?.paths?.outputDir || path.join(process.cwd(), 'output'),
  ));
  const snapshotDir = path.resolve(String(
    config?.maintenance?.snapshotDir || path.join(resolvedOutputDir, 'backups'),
  ));
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`NIGHTLY_REGISTRY_MISSING: ${String(dbPath || '')}`);
  let db = openDatabase(dbPath, { readOnly: true, observational: true });
  let writable = false;
  const activateWritableDatabase = () => {
    if (writable) return db;
    const stat = fs.statSync(dbPath);
    const identity = `${String(stat.dev)}:${String(stat.ino)}`;
    const dataVersion = Number(db.prepare('PRAGMA data_version').get()?.data_version || 0);
    const logicalRoot = logicalDatabaseHash(db);
    if (
      identity !== state.backupSourceIdentity
      || dataVersion !== state.backupDataVersion
      || logicalRoot !== state.snapshot?.sourceLogicalHash
    ) {
      throw snapshotError('NIGHTLY_SOURCE_CHANGED_AFTER_BACKUP', 'source changed after stage 02 and before stage 03');
    }
    db.close();
    ensureDir(resolvedOutputDir);
    try { fs.chmodSync(resolvedOutputDir, 0o700); } catch { /* best-effort */ }
    db = openDatabase(dbPath);
    writable = true;
    return db;
  };
  const nowIso = new Date().toISOString();
  const state = {
    cohortSha256: createHash('sha256').update(JSON.stringify(cohortIdentity), 'utf8').digest('hex'),
    configSha256: createHash('sha256').update(JSON.stringify(config), 'utf8').digest('hex'),
    mutationCount: 0,
    nativeSync: null,
    outputs: {},
    physicalMaintenanceCount: 0,
    receiptPath: path.join(resolvedOutputDir, `nightly-receipt-${stableMaintenanceOperationId(resolvedRunId)}.json`),
    runIdSha256: createHash('sha256').update(resolvedRunId, 'utf8').digest('hex'),
    stageLedgerPath: path.join(resolvedOutputDir, `nightly-stages-${stableMaintenanceOperationId(resolvedRunId)}.json`),
  };
  const complete = (stage, result = {}) => {
    const mutationCount = Math.max(0, Number(result?.mutationCount || 0));
    state.mutationCount += mutationCount;
    state.outputs[stage] = Object.freeze({
      mutationCount,
      ok: result?.ok !== false,
      skipped: String(result?.reason || result?.skipped || result?.skipped_reason || ''),
      suboperations: result?.suboperations && typeof result.suboperations === 'object'
        ? Object.freeze({ ...result.suboperations })
        : null,
    });
    return { ...result, mutationCount, ok: result?.ok !== false };
  };

  const disabledStages = new Set();
  if (config?.native?.enabled === false) disabledStages.add(DAILY_SEQUENCE[2]);
  if (config?.nativePromotion?.enabled === false) disabledStages.add(DAILY_SEQUENCE[3]);
  if (config?.native?.enabled === false && config?.nativePromotion?.enabled === false) disabledStages.add(DAILY_SEQUENCE[4]);
  if (!Array.isArray(config?.native?.vaults) || config.native.vaults.length === 0) disabledStages.add(DAILY_SEQUENCE[6]);
  if (!shouldRunAutomaticHostSync(config, 'nightly')) disabledStages.add(DAILY_SEQUENCE[7]);
  if (config?.native?.transcripts?.enabled !== true) disabledStages.add(DAILY_SEQUENCE[8]);
  if (config?.native?.wiki?.enabled !== true) {
    disabledStages.add(DAILY_SEQUENCE[9]);
    disabledStages.add(DAILY_SEQUENCE[21]);
  }
  if (typeof reviewQueueStage !== 'function' || config?.llm?.queueReview?.enabled !== true) {
    disabledStages.add(DAILY_SEQUENCE[10]);
  }
  if (typeof qualityReviewStage !== 'function') disabledStages.add(DAILY_SEQUENCE[13]);
  if (config?.maintenance?.vacuum === false) disabledStages.add(DAILY_SEQUENCE[17]);
  if (config?.recall?.semanticRerankEnabled !== true) disabledStages.add(DAILY_SEQUENCE[19]);
  const gatedStages = new Map();
  const worldMutationAllowed = mode === 'shadow' && config?.worldModel?.enabled !== false;
  if (config?.worldModel?.enabled === false) gatedStages.set(DAILY_SEQUENCE[15], 'world_rebuild_disabled');
  else if (mode !== 'shadow') gatedStages.set(DAILY_SEQUENCE[15], 'world_rebuild_requires_validated_cutover_capability');

  const handlers = {
    [DAILY_SEQUENCE[0]]: async () => {
      const quick = db.prepare('PRAGMA quick_check').all().map((row) => String(row.quick_check || Object.values(row)[0] || ''));
      if (quick.length !== 1 || quick[0] !== 'ok') throw new Error(`NIGHTLY_PREFLIGHT_QUICK_CHECK_FAILED: ${quick.join('; ')}`);
      const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeys.length > 0) throw new Error(`NIGHTLY_PREFLIGHT_FOREIGN_KEY_CHECK_FAILED: ${foreignKeys.length}`);
      return complete(DAILY_SEQUENCE[0]);
    },
    [DAILY_SEQUENCE[1]]: async () => {
      ensureDir(snapshotDir);
      try { fs.chmodSync(snapshotDir, 0o700); } catch { /* best-effort */ }
      const target = path.join(snapshotDir, `registry-pre-nightly-${stableMaintenanceOperationId(resolvedRunId)}.sqlite`);
      state.snapshot = snapshotDatabase(db, target);
      const sourceStat = fs.statSync(dbPath);
      state.backupSourceIdentity = `${String(sourceStat.dev)}:${String(sourceStat.ino)}`;
      state.backupDataVersion = Number(db.prepare('PRAGMA data_version').get()?.data_version || 0);
      if (typeof afterBackup === 'function') await afterBackup({ dbPath, snapshot: state.snapshot });
      return complete(DAILY_SEQUENCE[1]);
    },
    [DAILY_SEQUENCE[2]]: async () => {
      const summary = syncNativeMemory({ db, config, dryRun: false });
      state.nativeSync = summary;
      return complete(DAILY_SEQUENCE[2], {
        mutationCount: Number(summary.inserted_chunks || 0) + Number(summary.removed_sources || 0),
      });
    },
    [DAILY_SEQUENCE[3]]: async () => {
      const summary = promoteNativeChunks({
        db,
        config,
        dryRun: false,
        operationId: `${resolvedRunId}:native-promotion`,
        sourcePaths: state.nativeSync?.changed_sources || [],
      });
      return complete(DAILY_SEQUENCE[3], {
        mutationCount: Number(summary.promoted_inserted || 0)
          + Number(summary.linked_existing || 0)
          + Number(summary.repaired_links || 0),
      });
    },
    [DAILY_SEQUENCE[4]]: async () => {
      const storedSources = db.prepare(`
        SELECT DISTINCT source_path FROM memory_native_chunks
        WHERE COALESCE(source_path, '') <> ''
      `).all().map((row) => String(row.source_path || ''));
      const sourcePaths = [...new Set([
        ...storedSources,
        ...(state.nativeSync?.active_sources || []),
        ...(state.nativeSync?.changed_sources || []),
      ].map((value) => String(value || '')).filter(Boolean))];
      const summary = promoteNativeChunks({
        db,
        config,
        dryRun: false,
        operationId: `${resolvedRunId}:native-reconciliation`,
        sourcePaths,
      });
      return complete(DAILY_SEQUENCE[4], {
        mutationCount: Number(summary.repaired_links || 0)
          + Number(summary.relinked || 0)
          + Number(summary.rejected_or_unlinked || 0),
      });
    },
    [DAILY_SEQUENCE[5]]: async () => {
      const unsafe = Number(db.prepare(`
        SELECT COUNT(*) AS c FROM memory_current
        WHERE status='active' AND (
          lower(COALESCE(source_layer, '')) IN ('generated_artifact', 'session_generated', 'test')
          OR lower(COALESCE(source, '')) IN ('generated_artifact', 'session_generated', 'test')
        )
      `).get()?.c || 0);
      if (unsafe > 0) throw new Error(`NIGHTLY_HYGIENE_BLOCKED: ${unsafe} generated/test/session artifact row(s)`);
      return complete(DAILY_SEQUENCE[5]);
    },
    [DAILY_SEQUENCE[6]]: async () => {
      const summary = syncVaultMemory({ db, config, dryRun: false, maxFiles: Number(config?.native?.vaultSyncMaxFiles || 0) || 0 });
      return complete(DAILY_SEQUENCE[6], {
        mutationCount: Number(summary.inserted_chunks || 0) + Number(summary.removed_sources || 0),
      });
    },
    [DAILY_SEQUENCE[7]]: async () => {
      const summary = syncHostMemories({
        db,
        config,
        automaticTrigger: 'nightly',
        incremental: true,
        arbitrate: true,
        dryRun: false,
        projectBeliefRows: projectArbitrationBeliefRows,
      });
      return complete(DAILY_SEQUENCE[7], { mutationCount: Number(summary.inserted_count || 0), ok: summary.ok !== false });
    },
    [DAILY_SEQUENCE[8]]: async () => {
      const summary = harvestTranscripts({
        db,
        config,
        incremental: true,
        arbitrate: true,
        dryRun: false,
        projectBeliefRows: projectArbitrationBeliefRows,
      });
      return complete(DAILY_SEQUENCE[8], { mutationCount: Number(summary.inserted_count || 0), ok: summary.ok !== false });
    },
    [DAILY_SEQUENCE[9]]: async () => {
      const summary = reconcileWiki({ db, config, dryRun: false });
      return complete(DAILY_SEQUENCE[9], { mutationCount: Number(summary.ingested || 0) + Number(summary.tombstoned || 0) });
    },
    [DAILY_SEQUENCE[10]]: async () => complete(DAILY_SEQUENCE[10], await reviewQueueStage({ config, db, runId: resolvedRunId })),
    [DAILY_SEQUENCE[11]]: async () => {
      const summary = runAdaptiveTrust({ db, config, now: nowIso, dryRun: true, ensure: false });
      atomicWriteFileSync(
        path.join(resolvedOutputDir, `adaptive-trust-shadow-${stableMaintenanceOperationId(resolvedRunId)}.json`),
        `${JSON.stringify({ fingerprint: summary.fingerprint, hosts: summary.hosts.length, ok: true, shadow: true }, null, 2)}\n`,
        { mode: 0o600 },
      );
      return complete(DAILY_SEQUENCE[11]);
    },
    [DAILY_SEQUENCE[12]]: async () => {
      const summary = runBeliefArbitration({
        db,
        config,
        now: nowIso,
        operationId: `${resolvedRunId}:belief-arbitration`,
        projectBeliefRows: projectArbitrationBeliefRows,
      });
      return complete(DAILY_SEQUENCE[12], { mutationCount: Number(summary?.counts?.verdicts || 0) });
    },
    [DAILY_SEQUENCE[13]]: async () => {
      const summary = await qualityReviewStage({ config, dbPath, runId: resolvedRunId });
      const actions = summary?.summary?.by_action || {};
      return complete(DAILY_SEQUENCE[13], {
        mutationCount: Number(actions.archive || 0) + Number(actions.reject || 0),
        ok: summary?.ok !== false,
      });
    },
    [DAILY_SEQUENCE[14]]: async () => complete(
      DAILY_SEQUENCE[14],
      runExactSameScopeDedupe({
        config,
        db,
        nowIso,
        queuePath: String(config?.runtime?.paths?.reviewQueuePath || path.join(resolvedOutputDir, 'memory-review-queue.jsonl')),
        runId: resolvedRunId,
      }),
    ),
    [DAILY_SEQUENCE[15]]: async () => {
      const beforeRoot = worldDerivedLogicalRoot(db);
      rebuildEntityMentions(db);
      const summary = rebuildWorldModel({ db, config, now: nowIso });
      const afterRoot = worldDerivedLogicalRoot(db);
      const mutationCount = beforeRoot === afterRoot ? 0 : 1;
      return complete(DAILY_SEQUENCE[15], { mutationCount, ok: summary?.ok !== false });
    },
    [DAILY_SEQUENCE[16]]: async () => {
      let mutationCount = 0;
      const suboperations = {};
      if (worldMutationAllowed && config?.worldModel?.autoResolveLoops !== false) {
        mutationCount += Number(resolveOpenLoopsFromNewMemories(db, config)?.resolved || 0);
        suboperations.openLoops = 'completed';
      } else {
        suboperations.openLoops = config?.worldModel?.enabled === false
          ? 'skipped_world_model_disabled'
          : 'skipped_world_mutation_not_authorized';
      }
      const synthesisCount = !worldMutationAllowed
        ? 0
        : Number(db.prepare('SELECT COUNT(*) AS c FROM memory_syntheses').get()?.c || 0);
      suboperations.syntheses = !worldMutationAllowed
        ? 'skipped_world_mutation_not_authorized'
        : `verified:${synthesisCount}`;
      const retention = applyQueueRetention(
        String(config?.runtime?.paths?.reviewQueuePath || path.join(resolvedOutputDir, 'memory-review-queue.jsonl')),
        config?.runtime?.reviewQueueRetention,
      );
      mutationCount += Number(retention?.dropped_rows || 0);
      const pruned = pruneBackups({
        snapshotDir,
        compactDays: Number(config?.maintenance?.compactDays ?? 30),
        emergencyDays: Number(config?.maintenance?.emergencyUnvacuumedDays ?? 7),
        maxEmergencyFiles: Number(config?.maintenance?.maxEmergencyFiles ?? 1),
        maxCompactFiles: Number(config?.maintenance?.maxCompactFiles ?? 5),
      });
      const preNightly = prunePreNightlyBackups({
        maxAgeDays: 30,
        maxFiles: 14,
        preservePath: state.snapshot?.targetPath || '',
        snapshotDir,
      });
      state.physicalMaintenanceCount += Number(pruned?.pruned || 0) + Number(preNightly?.pruned || 0);
      suboperations.archiveRetention = `completed:${Number(pruned?.pruned || 0)}`;
      suboperations.preNightlyRetention = `completed:${Number(preNightly?.pruned || 0)}:kept:${Number(preNightly?.kept || 0)}`;
      suboperations.reviewQueueRetention = `completed:${Number(retention?.dropped_rows || 0)}`;
      atomicWriteFileSync(
        path.join(resolvedOutputDir, `archive-retention-${stableMaintenanceOperationId(resolvedRunId)}.json`),
        `${JSON.stringify({ ok: true, synthesisCount, suboperations }, null, 2)}\n`,
        { mode: 0o600 },
      );
      return complete(DAILY_SEQUENCE[16], { mutationCount, suboperations });
    },
    [DAILY_SEQUENCE[17]]: async () => {
      db.exec('VACUUM');
      state.physicalMaintenanceCount += 1;
      return complete(DAILY_SEQUENCE[17]);
    },
    [DAILY_SEQUENCE[18]]: async () => {
      const before = inspectFtsParity(db);
      if (before.exists && before.driftRows === 0) {
        return { status: 'skipped_gate', reason: 'fts_already_current' };
      }
      rebuildFTS5(db);
      const after = inspectFtsParity(db);
      if (!after.exists || after.driftRows !== 0) {
        throw new Error(`NIGHTLY_FTS_PARITY_FAILED: residual drift=${after.driftRows}`);
      }
      state.physicalMaintenanceCount += 1;
      return complete(DAILY_SEQUENCE[18], {
        mutationCount: 0,
        suboperations: {
          fts: `rebuilt:${before.driftRows}`,
          parity: `verified:${after.currentRows}:${after.ftsRows}`,
        },
      });
    },
    [DAILY_SEQUENCE[19]]: async () => {
      const summary = buildMissingEmbeddings(db, config);
      if (summary?.identity_error || Number(summary?.failed || 0) > 0 || summary?.reachable === false) {
        throw new Error(`NIGHTLY_EMBEDDING_BACKFILL_FAILED: ${String(summary?.identity_error || 'embedding provider unavailable')}`);
      }
      return complete(DAILY_SEQUENCE[19], { mutationCount: Number(summary.computed || 0) });
    },
    [DAILY_SEQUENCE[20]]: async () => {
      if (mode === 'shadow' && config?.worldModel?.enabled === false) {
        return { status: 'skipped_gate', reason: 'rollback_safe_shadow_world_rebuild_disabled' };
      }
      const casesPath = path.join(PACKAGE_ROOT, 'eval', 'cases.jsonl');
      if (!fs.existsSync(casesPath)) return { status: 'skipped_disabled', reason: 'eval_cases_unavailable' };
      const activeCount = Number(db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE status='active'").get()?.c || 0);
      if (activeCount === 0) return { status: 'skipped_gate', reason: 'no_active_memories' };
      const rawReport = evalRecall({ db, config, cases: loadEvalCases(casesPath), mode: 'live' });
      const aggregate = rawReport?.aggregate || {};
      const gateFailures = [];
      if (Number(aggregate.error_case_count || 0) > 0) gateFailures.push('error_cases');
      if (Number(aggregate.precision_at_1 || 0) < 0.233) gateFailures.push('precision_at_1');
      if (Number(aggregate.mrr || 0) < 0.25) gateFailures.push('mrr');
      if (Number(aggregate.hit_rate || 0) < 0.3) gateFailures.push('hit_rate');
      const medianLatency = aggregate.latency_median_ms == null ? NaN : Number(aggregate.latency_median_ms);
      const p95Latency = aggregate.latency_p95_ms == null ? NaN : Number(aggregate.latency_p95_ms);
      if (!Number.isFinite(medianLatency) || medianLatency > 125) gateFailures.push('latency_median_ms');
      if (!Number.isFinite(p95Latency) || p95Latency > 250) gateFailures.push('latency_p95_ms');
      const vetoes = Object.fromEntries(Object.entries(aggregate).filter(([key, value]) => (
        (key.toLowerCase().includes('veto') || key.toLowerCase().endsWith('leaks')) && Number(value || 0) > 0
      )));
      if (Object.keys(vetoes).length > 0) gateFailures.push(...Object.keys(vetoes).map((key) => `veto:${key}`));
      const report = { ...rawReport, gateFailures, ok: gateFailures.length === 0, vetoes };
      const reportPath = path.join(resolvedOutputDir, `eval-nightly-${stableMaintenanceOperationId(resolvedRunId)}.json`);
      const reportBody = `${JSON.stringify(report, null, 2)}\n`;
      atomicWriteFileSync(reportPath, reportBody, { mode: 0o600 });
      const reportSha256 = createHash('sha256').update(reportBody, 'utf8').digest('hex');
      if (report.ok !== true) {
        throw new Error(`NIGHTLY_RECALL_EVAL_GATE_FAILED:${reportSha256}: ${gateFailures.join(',')}`);
      }
      return complete(DAILY_SEQUENCE[20]);
    },
    [DAILY_SEQUENCE[21]]: async () => {
      const summary = projectWiki({ db, config, dryRun: false });
      return complete(DAILY_SEQUENCE[21], { mutationCount: summary?.committed ? 1 : 0 });
    },
    [DAILY_SEQUENCE[22]]: async () => {
      if (state.mutationCount === 0) return { status: 'skipped_gate', reason: 'no_mutations' };
      if (typeof surfaceRefreshStage !== 'function') throw new Error('NIGHTLY_SURFACE_HANDLER_REQUIRED');
      return complete(
        DAILY_SEQUENCE[22],
        await surfaceRefreshStage({ config, configPath, dbPath, mutationCount: state.mutationCount, runId: resolvedRunId }),
      );
    },
    [DAILY_SEQUENCE[23]]: async ({ originalFailure, receipts, stage }) => {
      let integrityError = null;
      try {
        const quick = db.prepare('PRAGMA quick_check').all().map((row) => String(row.quick_check || Object.values(row)[0] || ''));
        if (quick.length !== 1 || quick[0] !== 'ok') throw new Error(`NIGHTLY_FINAL_QUICK_CHECK_FAILED: ${quick.join('; ')}`);
        const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
        if (foreignKeys.length > 0) throw new Error(`NIGHTLY_FINAL_FOREIGN_KEY_CHECK_FAILED: ${foreignKeys.length}`);
      } catch (error) {
        integrityError = error;
      }
      const finalReceipt = integrityError
        ? { stage, status: 'failed', error: String(integrityError.message || integrityError).slice(0, 500) }
        : { stage, status: 'completed', mutationCount: 0 };
      if (writeReceipt) {
        ensureDir(resolvedOutputDir);
        try { fs.chmodSync(resolvedOutputDir, 0o700); } catch { /* best-effort */ }
        const finalTransitions = [...receipts, finalReceipt];
        const stageLedgerBody = `${JSON.stringify({
          complete: true,
          contract: 'gigabrain-nightly-stage-ledger-v1',
          receipts: finalTransitions,
          runId: resolvedRunId,
        }, null, 2)}\n`;
        atomicWriteFileSync(state.stageLedgerPath, stageLedgerBody, { mode: 0o600 });
        directoryFsync(path.dirname(state.stageLedgerPath));
        const stageLedgerSha256 = createHash('sha256').update(stageLedgerBody, 'utf8').digest('hex');
        atomicWriteFileSync(state.receiptPath, `${JSON.stringify({
          contract: 'gigabrain-nightly-receipt-v1',
          cohortSha256: state.cohortSha256,
          configSha256: state.configSha256,
          dbPath,
          failure: originalFailure,
          mode,
          mutationCount: state.mutationCount,
          physicalMaintenanceCount: state.physicalMaintenanceCount,
          ok: !originalFailure && !integrityError,
          receipts: [...receipts, finalReceipt],
          sealed: true,
          resumeAllowed: false,
          runId: resolvedRunId,
          runIdSha256: state.runIdSha256,
          snapshot: state.snapshot ? {
            foreignKeyErrors: state.snapshot.foreignKeyErrors,
            method: state.snapshot.method,
            quickCheck: state.snapshot.quickCheck,
            sourceLogicalHash: state.snapshot.sourceLogicalHash,
            targetLogicalHash: state.snapshot.targetLogicalHash,
            targetPath: state.snapshot.targetPath,
          } : null,
          stageLedgerPath: state.stageLedgerPath,
          stageLedgerSha256,
          stageOutputs: state.outputs,
        }, null, 2)}\n`, { mode: 0o600 });
        directoryFsync(path.dirname(state.receiptPath));
      }
      if (integrityError) throw integrityError;
      return complete(DAILY_SEQUENCE[23]);
    },
  };

  for (const stage of DAILY_SEQUENCE.slice(2, -1)) {
    const handler = handlers[stage];
    handlers[stage] = async (context) => {
      activateWritableDatabase();
      return handler(context);
    };
  }

  try {
    const sequence = await executeDailySequence({
      disabledStages,
      gatedStages,
      handlers,
      mode,
      onTransition: writeReceipt ? (receipts, current) => {
        ensureDir(resolvedOutputDir);
        try { fs.chmodSync(resolvedOutputDir, 0o700); } catch { /* best-effort */ }
        atomicWriteFileSync(state.stageLedgerPath, `${JSON.stringify({
          complete: current.stage === DAILY_SEQUENCE.at(-1),
          contract: 'gigabrain-nightly-stage-ledger-v1',
          receipts,
          runId: resolvedRunId,
        }, null, 2)}\n`, { mode: 0o600 });
        directoryFsync(path.dirname(state.stageLedgerPath));
      } : null,
    });
    return Object.freeze({
      ...sequence,
      cohortSha256: state.cohortSha256,
      configSha256: state.configSha256,
      dbPath,
      outputs: Object.freeze(state.outputs),
      physicalMaintenanceCount: state.physicalMaintenanceCount,
      receiptPath: writeReceipt ? state.receiptPath : '',
      runId: resolvedRunId,
      runIdSha256: state.runIdSha256,
      snapshot: state.snapshot || null,
      stageLedgerPath: writeReceipt ? state.stageLedgerPath : '',
    });
  } finally {
    db.close();
  }
};

const validatedShadowCapabilities = new WeakSet();

const authorizeShadowMaintenanceCohort = ({ config, dbPath, outputDir, sourceDbPath }) => {
  const cohortRoot = path.resolve(path.dirname(outputDir));
  const resolvedDbPath = path.resolve(dbPath);
  const resolvedOutputDir = path.resolve(outputDir);
  const resolvedSource = path.resolve(sourceDbPath);
  const lockPath = path.resolve(String(config?.lockPath || ''));
  const workspaceRoot = path.resolve(String(config?.runtime?.paths?.workspaceRoot || ''));
  const within = (candidate) => candidate === cohortRoot || candidate.startsWith(`${cohortRoot}${path.sep}`);
  if (!within(resolvedDbPath) || !within(resolvedOutputDir) || !within(lockPath)) {
    throw snapshotError('NIGHTLY_SHADOW_CAPABILITY_INVALID', 'writable DB/output/lock must stay inside one cohort root');
  }
  if (resolvedDbPath === resolvedSource || !fs.existsSync(resolvedDbPath)) {
    throw snapshotError('NIGHTLY_SHADOW_CAPABILITY_INVALID', 'working DB must be a distinct materialized cohort file');
  }
  const workspaceStat = fs.statSync(workspaceRoot);
  if (!workspaceStat.isDirectory() || (workspaceStat.mode & 0o222) !== 0) {
    throw snapshotError('NIGHTLY_SHADOW_CAPABILITY_INVALID', 'input workspace must be read-only');
  }
  const capability = Object.freeze({ cohortRoot, dbPath: resolvedDbPath, outputDir: resolvedOutputDir });
  validatedShadowCapabilities.add(capability);
  return capability;
};

const runDailyMaintenanceSequence = async (options = {}) => {
  if (options.mode === 'shadow') {
    if (!validatedShadowCapabilities.has(options.shadowCapability)) {
      throw snapshotError('NIGHTLY_SHADOW_CAPABILITY_REQUIRED', 'shadow execution requires a validated cohort capability');
    }
    if (
      options.shadowCapability.dbPath !== path.resolve(options.dbPath)
      || options.shadowCapability.outputDir !== path.resolve(options.outputDir)
    ) throw snapshotError('NIGHTLY_SHADOW_CAPABILITY_INVALID', 'capability paths do not match execution paths');
  }
  const resolvedRunId = String(options.runId || `nightly-${nowStamp()}`);
  const resolvedOutputDir = path.resolve(String(
    options.outputDir || options.config?.runtime?.paths?.outputDir || path.join(process.cwd(), 'output'),
  ));
  const token = stableMaintenanceOperationId(resolvedRunId);
  const receiptPath = path.join(resolvedOutputDir, `nightly-receipt-${token}.json`);
  const ledgerPath = path.join(resolvedOutputDir, `nightly-stages-${token}.json`);
  const snapshotDir = path.resolve(String(
    options.config?.maintenance?.snapshotDir || path.join(resolvedOutputDir, 'backups'),
  ));
  const snapshotPath = path.join(snapshotDir, `registry-pre-nightly-${token}.sqlite`);
  const assertFreshRunId = () => {
    const existing = [receiptPath, ledgerPath, snapshotPath].filter((filePath) => fs.existsSync(filePath));
    if (existing.length > 0) {
      throw snapshotError('NIGHTLY_RUN_ID_REUSED', `run artifacts already exist: ${existing.join(', ')}`);
    }
  };
  assertFreshRunId();
  const normalized = { ...options, runId: resolvedRunId };
  return withNativeMemoryLock(options.config || {}, () => {
    assertFreshRunId();
    return runDailyMaintenanceSequenceUnlocked(normalized);
  });
};

const runMaintenance = ({
  dbPath,
  config,
  configPath = '',
  dryRun = false,
  runId = '',
  reviewVersion = '',
  faultInjector = null,
  operationId = '',
  completionFaultInjector = null,
}) => {
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'maintenance.run' });
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
    if (!dryRun && snapshotDatabase(db, emergencySnapshot)) {
      eventCounts.snapshots_created += 1;
    }

    const changedForArchiveSummary = [];
    const archivedOrKilledRows = [];
    const nowIso = new Date().toISOString();
    const dateKey = nowIso.slice(0, 10);
    const phaseOperationId = (phase) => stableMaintenanceOperationId(`${operationId || resolvedRunId}:${phase}`);
    const runMutationPhase = (phase, fn) => {
      if (dryRun) return fn(null, () => {});
      const resolvedPhaseOperationId = phaseOperationId(phase);
      const result = withProjectionMutationBatch({
        db,
        now: nowIso,
        operationId: resolvedPhaseOperationId,
      }, (tx) => fn(tx, () => {})).result;
      const completedRows = db.prepare(`
        SELECT * FROM memory_events
        WHERE json_extract(payload, '$.maintenance_stage') = ?
          AND json_extract(payload, '$.projection_event_kind') = 'row'
        ORDER BY timestamp, rowid
      `).all(phase).map((row) => ({
        ...row,
        reason_codes: (() => { try { return JSON.parse(row.reason_codes); } catch { return []; } })(),
        payload: (() => { try { return JSON.parse(row.payload); } catch { return {}; } })(),
      }));
      const existingEventIds = new Set();
      const eventFile = readFileIfExistsSync(eventsPath, 'utf8');
      if (eventFile.exists) {
        for (const line of eventFile.data.split('\n').filter(Boolean)) {
          try { existingEventIds.add(String(JSON.parse(line).event_id || '')); } catch { /* preserve malformed external evidence */ }
        }
      }
      for (const row of completedRows) {
        if (existingEventIds.has(String(row.event_id))) continue;
        if (typeof completionFaultInjector === 'function') completionFaultInjector('before_maintenance_row_jsonl', { event: row, phase });
        appendJsonl(eventsPath, row);
        existingEventIds.add(String(row.event_id));
      }
      return result;
    };

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
        automaticTrigger: 'nightly',
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

    runMutationPhase('quality_sweep', (tx, recordRowEvent) => {
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
            }, {
              tx,
              faultInjector,
              event: {
                timestamp: nowIso,
                component: 'maintenance',
                action: 'quality_archive',
                reason_codes: result.reason_codes,
                memory_id: String(row.memory_id),
                cleanup_version: cleanupVersion,
                run_id: resolvedRunId,
                review_version: String(reviewVersion || ''),
                payload: {
                  completion_id: maintenanceCompletionId('quality_sweep', String(row.memory_id)),
                  maintenance_stage: 'quality_sweep',
                  score: result.value_score,
                  label: result.value_label,
                },
              },
            });
            recordRowEvent();
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
        } else if (result.action === 'reject') {
          if (!dryRun) {
            updateCurrentStatus(db, row.memory_id, 'rejected', {
              value_score: result.value_score,
              value_label: result.value_label,
              timestamp: nowIso,
              last_reviewed_at: nowIso,
            }, {
              tx,
              faultInjector,
              event: {
                timestamp: nowIso,
                component: 'maintenance',
                action: 'quality_reject',
                reason_codes: result.reason_codes,
                memory_id: String(row.memory_id),
                cleanup_version: cleanupVersion,
                run_id: resolvedRunId,
                review_version: String(reviewVersion || ''),
                payload: {
                  completion_id: maintenanceCompletionId('quality_sweep', String(row.memory_id)),
                  maintenance_stage: 'quality_sweep',
                  score: result.value_score,
                  label: result.value_label,
                },
              },
            });
            recordRowEvent();
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
        }
      }
    });

    runMutationPhase('exact_dedupe', (tx, recordRowEvent) => {
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
            }, {
              tx,
              faultInjector,
              event: {
                timestamp: nowIso,
                component: 'maintenance',
                action: 'dedupe_exact_archive',
                reason_codes: ['duplicate_exact'],
                memory_id: String(loser.memory_id),
                matched_memory_id: String(winner.memory_id),
                cleanup_version: cleanupVersion,
                run_id: resolvedRunId,
                review_version: String(reviewVersion || ''),
                payload: {
                  completion_id: maintenanceCompletionId('exact_dedupe', String(loser.memory_id), String(winner.memory_id)),
                  maintenance_stage: 'exact_dedupe',
                  winner_id: String(winner.memory_id),
                },
              },
            });
            recordRowEvent();
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
        }
      }
    });

    const pendingSemanticQueueWrites = [];
    const pendingSemanticQueueEvents = [];
    runMutationPhase('semantic_dedupe', (tx, recordRowEvent) => {
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
              }, {
                tx,
                faultInjector,
                event: {
                  timestamp: nowIso,
                  component: 'maintenance',
                  action: 'dedupe_semantic_archive',
                  reason_codes: ['duplicate_semantic'],
                  memory_id: String(loser.memory_id),
                  matched_memory_id: String(winner.memory_id),
                  similarity,
                  cleanup_version: cleanupVersion,
                  run_id: resolvedRunId,
                  review_version: String(reviewVersion || ''),
                  payload: {
                    completion_id: maintenanceCompletionId('semantic_dedupe', String(loser.memory_id), String(winner.memory_id)),
                    maintenance_stage: 'semantic_dedupe',
                    winner_id: String(winner.memory_id),
                  },
                },
              });
              recordRowEvent();
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
          } else if (similarity >= Number(semanticThresholds.review)) {
            const { winner, loser } = pickSemanticQueuePair(a, b);
            // Guard unavailable (null = queue unreadable): skip enqueueing
            // entirely this run rather than duplicating every pending pair.
            if (!pendingSemanticPairs) continue;
            const pairKey = `${String(loser.memory_id)}|${String(winner.memory_id)}`;
            if (pendingSemanticPairs.has(pairKey)) continue;
            pendingSemanticPairs.add(pairKey);
            eventCounts.dedupe_semantic_review_queue += 1;
            pendingSemanticQueueWrites.push(buildSemanticReviewQueueRow({
              winner,
              loser,
              similarity,
              nowIso,
            }));
            pendingSemanticQueueEvents.push({
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
    for (const row of pendingSemanticQueueWrites) queueReview(queuePath, row, { dryRun });
    for (const event of pendingSemanticQueueEvents) emit(event);

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
        const outcome = runMutationPhase('auto_resolve_dedupe', (tx, recordRowEvent) => {
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
              const applied = loserId ? db.prepare(`
                SELECT timestamp, similarity, payload FROM memory_events
                WHERE action='auto_resolve_dedupe' AND memory_id=?
                  AND COALESCE(matched_memory_id, '') = ?
                  AND json_extract(payload, '$.completion_id') = ?
                  AND json_extract(payload, '$.projection_event_kind') = 'row'
                ORDER BY rowid DESC LIMIT 1
              `).get(
                loserId,
                winnerId,
                maintenanceCompletionId('auto_resolve_dedupe', loserId, winnerId),
              ) : null;
              if (applied) {
                let appliedPayload = {};
                try { appliedPayload = JSON.parse(String(applied.payload || '{}')); } catch { /* content-free receipt remains usable */ }
                row.status = 'resolved_auto';
                row.auto_resolved = true;
                row.auto_resolved_reason = 'pending_timeout_7d';
                row.resolved_reason = 'pending_timeout_7d';
                row.resolved_at = String(applied.timestamp || nowIso);
                row.updated_at = String(applied.timestamp || nowIso);
                row.similarity = Number.isFinite(Number(applied.similarity))
                  ? Number(applied.similarity)
                  : Number(appliedPayload.similarity || 0);
                autoResolved += 1;
                mutatedRows += 1;
                kept.push(JSON.stringify(row));
                continue;
              }
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
                    }, {
                      tx,
                      faultInjector,
                      event: {
                        timestamp: nowIso,
                        component: 'maintenance',
                        action: 'auto_resolve_dedupe',
                        reason_codes: ['pending_timeout_7d'],
                        memory_id: loserId,
                        matched_memory_id: winnerId,
                        cleanup_version: cleanupVersion,
                        run_id: resolvedRunId,
                        review_version: String(reviewVersion || ''),
                        payload: {
                          completion_id: maintenanceCompletionId('auto_resolve_dedupe', loserId, winnerId),
                          maintenance_stage: 'auto_resolve_dedupe',
                          similarity: currentSimilarity,
                          pending_since: row?.queued_at || row?.timestamp || '',
                          auto_resolved_reason: 'pending_timeout_7d',
                        },
                      },
                    });
                    recordRowEvent();
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
          } catch (error) {
            if (error instanceof SyntaxError) kept.push(line);
            else throw error;
          }
        }
        return { autoResolved, kept, mutatedRows };
        });
        // External completion advances only after the DB mutation phase commits.
        if (outcome.mutatedRows > 0 && !dryRun) {
          if (typeof completionFaultInjector === 'function') completionFaultInjector('before_auto_resolve_queue_completion');
          atomicWriteFileSync(queuePath, outcome.kept.join('\n') + '\n', { mode: 0o600 });
        }
        eventCounts.dedupe_auto_resolved = outcome.autoResolved;
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
        throw error;
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
    if (!dryRun && snapshotDatabase(db, compactSnapshot)) {
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

    const graphBuildResult = { ok: true, skipped: true, reason: 'deferred_to_surface_refresh' };
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
  authorizeShadowMaintenanceCohort,
  DAILY_SEQUENCE,
  executeDailySequence,
  logicalDatabaseHash,
  runDailyMaintenanceSequence,
  runMaintenance,
  snapshotDatabase,
};

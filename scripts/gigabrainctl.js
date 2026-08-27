#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from '../lib/core/sqlite.js';
import { ensureSupportedNodeRuntime } from '../lib/core/runtime-guard.js';

import { loadResolvedConfig } from '../lib/core/config.js';
import {
  authorizeShadowMaintenanceCohort,
  DAILY_SEQUENCE,
  executeDailySequence,
  runDailyMaintenanceSequence,
  snapshotDatabase,
} from '../lib/core/maintenance-service.js';
import { runAudit, runAuditRestore, runAuditReport, watchRun, bumpLocalCounters, exportLocalCounters, purgeNoopReviews } from '../lib/core/audit-service.js';
import { applyQueueRetention, listQueueEntries } from '../lib/core/review-queue.js';
import { dropLegacyMemoriesTable, ensureProjectionStore, listAdjudications, listBeliefsAsOf, materializeProjectionFromMemories } from '../lib/core/projection-store.js';
import { cloudInboxStaleness, exportMemoryBrief, getSyncStatus, listMemorySources, resolveHostRoots, syncHostMemories } from '../lib/core/host-memory-sync.js';
import { importOpenClawRegistry } from '../lib/core/openclaw-import.js';
import { ensureVaultStore, syncVaultMemory } from '../lib/core/vault-sync.js';
import { ensureTranscriptStore, harvestTranscripts, transcriptStatus } from '../lib/core/transcript-harvester.js';
import { projectWiki, reconcileWiki, resolveWikiConfig } from '../lib/core/wiki-project.js';
import { buildMemoryPassport, writeMemoryPassport } from '../lib/core/handoff-record.js';
import {
  exportHandoffBundle,
  importHandoffBundle,
  inspectLegacyV1Bundle,
  validateBundleShape,
} from '../lib/core/handoff-bundle.js';
import { captureSnapshotMetrics } from '../lib/core/metrics.js';
import { orchestrateRecall } from '../lib/core/orchestrator.js';
import { captureFromEvent } from '../lib/core/capture-service.js';
import { installSessionHook, uninstallSessionHook, resolveSessionSettingsPath } from '../lib/core/lifecycle-hooks.js';
import { runAdaptiveTrust } from '../lib/core/adaptive-trust.js';
import { proposeToVaultInbox } from '../lib/core/vault-inbox.js';
import { atomicWriteFileSync, readFileIfExistsSync } from '../lib/core/safe-fs.js';
import { migrateLegacyCheckpoints } from '../lib/core/checkpoint-migration.js';
import { classifyNativeOrigins } from '../lib/core/native-sync.js';
import { assertEntrypointAllowed, assertWriteAllowed, resolveWriteMode } from '../lib/compat/write-policy.js';
import { reviewQueuedCandidates } from '../lib/compat/queue-review-service.js';
import { buildGeneratedSurface, inspectGeneratedSurface } from '../lib/operator/generated-surface.js';
import { refreshGeneratedSurfaceAfterMutation } from '../lib/operator/surface-refresh-service.js';
import {
  ensureWorldModelReady,
  getEntityDetail,
  listContradictions,
  listEntities,
  listOpenLoops,
  rebuildWorldModel,
  listSyntheses,
  projectArbitrationBeliefRows,
} from '../lib/core/world-model.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = path.dirname(THIS_FILE);
const NIGHTLY_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

ensureSupportedNodeRuntime({ component: 'Gigabrain CLI' });

const HELP = `Gigabrain v3 Control CLI

Usage:
  node scripts/gigabrainctl.js <command> [flags]

Commands:
  init         Auto-detect installed coding agents and wire them in one command
  nightly      Run one full nightly cycle (maintain + optional harmonize + audit apply)
  snapshot     Create and verify one engine-consistent SQLite snapshot
  maintain     Run maintenance sequence only
  audit        Run audit service (--mode shadow|apply|restore)
  watch        Re-run the audit against the last watch snapshot; report only NEW findings (never mutates memories)
  inventory    Print current memory inventory metrics
  doctor       Validate config/db + print health checks
  world        Rebuild or inspect the world-model layer
  control      Apply structured memory actions
  orchestrator Explain how Gigabrain would answer a recall query
  synthesis    Inspect or rebuild synthesis artifacts
  briefing     Print the latest generated briefing artifacts
  review       Inspect contradictions, open loops, adjudications, the review queue, beliefs as of a timestamp, or adaptive host trust (trust)
  surface      Build or inspect the private generated operator surface (build|status|doctor)
  migrate      Run a migration (legacy-checkpoints/classify-native-origins; legacy-drop: BLOCKED in this release)
  vault        Sync or report on READ-ONLY Obsidian vault reference corpora (sync|status; never becomes a belief)
  wiki         Git-versioned LLM-wiki projection of the ledger (project|reconcile|status; human edits round-trip + win arbitration)
  sync-hosts   Sync local host memories into the cross-agent memory bus
  import-openclaw Import a legacy OpenClaw/Gigabrain registry.sqlite with provenance
  handoff      Audit/Handoff Records, plus Handoff v2 export|inspect|import
  export-bundle  Deprecated alias for handoff export
  import-bundle  Deprecated alias for handoff import

Examples:
  node scripts/gigabrainctl.js init
  node scripts/gigabrainctl.js init --project-root /path/to/repo
  node scripts/gigabrainctl.js nightly --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js snapshot --config ~/.openclaw/openclaw.json --db ./registry.sqlite --target ./registry.snapshot.sqlite
  node scripts/gigabrainctl.js nightly --harmonize
  node scripts/gigabrainctl.js nightly --skip-harmonize
  node scripts/gigabrainctl.js audit --mode shadow --db ~/.openclaw/gigabrain/memory/registry.sqlite
  node scripts/gigabrainctl.js audit --mode restore --review-version rv-2026-02-22
  node scripts/gigabrainctl.js watch --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js watch --install-hook
  node scripts/gigabrainctl.js review queue --status pending --reason-code capture_contradiction_durable_tie
  node scripts/gigabrainctl.js migrate legacy-checkpoints --dry-run --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js migrate legacy-checkpoints --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js vault status --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js vault sync --dry-run --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js transcript status --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js transcript sync --dry-run --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js wiki status --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js wiki reconcile --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js wiki project --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js world rebuild --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js control apply --action replace --target-memory-id <id> --content "<person> moved to <city>" --scope <scope>
  node scripts/gigabrainctl.js control apply --action reinstate --target-memory-id <id> --content "reverses a false over-merge supersession"
  node scripts/gigabrainctl.js orchestrator explain --query "Who is <person>?" --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js sync-hosts --config ~/.gigabrain/config.json --host codex,claude_code
  node scripts/gigabrainctl.js import-openclaw --config ~/.gigabrain/config.json --registry ~/.openclaw/gigabrain/memory/registry.sqlite --source-label remote-host-backup --dry-run
  node scripts/gigabrainctl.js handoff --config ~/.gigabrain/config.json --output-dir ./handoff-record
  node scripts/gigabrainctl.js export-bundle --config ~/.gigabrain/config.json --out ./memory-bundle.json
  node scripts/gigabrainctl.js import-bundle --config ~/.gigabrain/config.json --in ./memory-bundle.json
  node scripts/gigabrainctl.js sync-hosts export-brief --target-host claude_code --config ~/.gigabrain/config.json
`;

const args = process.argv.slice(2);
const command = String(args[0] || '').trim().toLowerCase();
const flags = args.slice(1);

const readFlag = (name, fallback = '', list = flags) => {
  const idx = list.indexOf(name);
  if (idx !== -1 && list[idx + 1] && !String(list[idx + 1]).startsWith('--')) return list[idx + 1];
  const withEq = list.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const readBool = (name, fallback = false, list = flags) => {
  if (list.includes(name)) return true;
  const withEq = list.find((item) => String(item || '').startsWith(`${name}=`));
  if (!withEq) return fallback;
  const raw = String(withEq.split('=').slice(1).join('=')).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
};

const wantsHelp = flags.includes('--help') || flags.includes('-h');

const hasTableReadOnly = (db, tableName) => Boolean(db.prepare(`
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
`).get(String(tableName || '')));

const LEGACY_COMPATIBILITY_REASON = 'v0.11 rollback window requires the legacy memories projection';
export const TASK14_MEMORY_CONSOLE_METADATA_MIGRATION_ID = 'gigabrain-schema-0.11-compat-v1:memory-console-metadata-backfill';
const TASK14_MIGRATION_LEDGER_TABLE = 'memory_schema_migrations';
const TASK14_RECEIPT_CONTRACT_VERSION = 'gigabrain-memory-console-metadata-receipt-v1';
const TASK14_SCHEMA_CONTRACT_VERSION = 'gigabrain-memory-console-metadata-schema-v1';
const TASK14_LOGICAL_ROOT_CONTRACT_VERSION = 'gigabrain-memory-console-metadata-logical-root-v1';
const TASK14_MAX_METADATA_ROWS = 10_000_000;
export const TASK14_MEMORY_CONSOLE_METADATA_RECEIPT_CONTRACT = Object.freeze({
  version: TASK14_RECEIPT_CONTRACT_VERSION,
  migrationId: TASK14_MEMORY_CONSOLE_METADATA_MIGRATION_ID,
  ledgerTable: TASK14_MIGRATION_LEDGER_TABLE,
  ledgerColumns: Object.freeze(['migration_id', 'status', 'receipt_hash', 'schema_hash', 'receipt_json']),
  receiptKeys: Object.freeze(['contract', 'migration_id', 'status', 'schema_hash', 'counts', 'metadata_roots']),
  countKeys: Object.freeze(['legacy_metadata_rows', 'sidecar_metadata_rows']),
  metadataRootKeys: Object.freeze(['legacy_sha256', 'sidecar_sha256']),
  logicalRootContract: TASK14_LOGICAL_ROOT_CONTRACT_VERSION,
  maxMetadataRows: TASK14_MAX_METADATA_ROWS,
});
export const TASK14_MEMORY_CONSOLE_METADATA_SCHEMA_CONTRACT = Object.freeze({
  version: TASK14_SCHEMA_CONTRACT_VERSION,
  schemaKeys: Object.freeze(['contract', 'table', 'index']),
  tableName: 'memory_console_metadata',
  tableKeys: Object.freeze(['name', 'sql', 'columns']),
  tableColumnKeys: Object.freeze(['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk']),
  indexName: 'idx_memory_console_metadata_concept_pinned',
  indexKeys: Object.freeze(['name', 'sql', 'columns']),
  indexColumnKeys: Object.freeze(['seqno', 'cid', 'name']),
});
const SQLITE_HEADER_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');
const RECEIPT_HASH_RE = /^[0-9a-f]{64}$/;

const inspectDoctorPreOpenSafety = (dbPath) => {
  if (!dbPath || !fs.existsSync(dbPath)) return { diagnostic: '', permitted: true };
  const header = Buffer.alloc(20);
  let fd = null;
  try {
    fd = fs.openSync(dbPath, 'r');
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead < header.length || !header.subarray(0, SQLITE_HEADER_MAGIC.length).equals(SQLITE_HEADER_MAGIC)) {
      return { diagnostic: 'sqlite_header_unavailable', permitted: false };
    }
  } catch {
    return { diagnostic: 'sqlite_header_unavailable', permitted: false };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* observational close */ }
    }
  }
  const walHeader = header[18] === 2 || header[19] === 2;
  if (walHeader && (!fs.existsSync(`${dbPath}-wal`) || !fs.existsSync(`${dbPath}-shm`))) {
    return { diagnostic: 'wal_coordination_sidecars_unavailable', permitted: false };
  }
  return { diagnostic: '', permitted: true };
};

const sha256Text = (value) => createHash('sha256').update(String(value || ''), 'utf8').digest('hex');

const hasExactObjectKeys = (value, expectedKeys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
};

const task14SchemaEvidence = (db) => {
  const schemaRow = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?');
  const table = schemaRow.get('table', TASK14_MEMORY_CONSOLE_METADATA_SCHEMA_CONTRACT.tableName);
  const index = schemaRow.get('index', TASK14_MEMORY_CONSOLE_METADATA_SCHEMA_CONTRACT.indexName);
  const evidence = {
    contract: TASK14_SCHEMA_CONTRACT_VERSION,
    table: {
      name: TASK14_MEMORY_CONSOLE_METADATA_SCHEMA_CONTRACT.tableName,
      sql: String(table?.sql || ''),
      columns: db.prepare('PRAGMA table_info(memory_console_metadata)').all().map((row) => ({
        cid: Number(row.cid),
        name: String(row.name || ''),
        type: String(row.type || ''),
        notnull: Number(row.notnull),
        dflt_value: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
        pk: Number(row.pk),
      })),
    },
    index: {
      name: TASK14_MEMORY_CONSOLE_METADATA_SCHEMA_CONTRACT.indexName,
      sql: String(index?.sql || ''),
      columns: db.prepare('PRAGMA index_info(idx_memory_console_metadata_concept_pinned)').all().map((row) => ({
        seqno: Number(row.seqno),
        cid: Number(row.cid),
        name: String(row.name || ''),
      })),
    },
  };
  const canonical = JSON.stringify(evidence);
  return { canonical, hash: sha256Text(canonical) };
};

const normalizeTask14MetadataRow = (row) => ({
  memory_id: String(row?.memory_id || ''),
  concept: row?.concept === null || row?.concept === undefined ? null : String(row.concept),
  source_message_id: row?.source_message_id === null || row?.source_message_id === undefined ? null : String(row.source_message_id),
  last_injected_at: row?.last_injected_at === null || row?.last_injected_at === undefined ? null : String(row.last_injected_at),
  last_confirmed_at: row?.last_confirmed_at === null || row?.last_confirmed_at === undefined ? null : String(row.last_confirmed_at),
  ttl_days: row?.ttl_days === null || row?.ttl_days === undefined ? null : Number(row.ttl_days),
  pinned: Number(row?.pinned || 0),
  review_version: row?.review_version === null || row?.review_version === undefined ? null : String(row.review_version),
  review_reason: row?.review_reason === null || row?.review_reason === undefined ? null : String(row.review_reason),
});

const task14MetadataEvidence = (db) => {
  const legacyCount = Number(db.prepare('SELECT COUNT(*) AS c FROM memories').get()?.c);
  const sidecarCount = Number(db.prepare('SELECT COUNT(*) AS c FROM memory_console_metadata').get()?.c);
  const counts = [legacyCount, sidecarCount];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0 || count > TASK14_MAX_METADATA_ROWS)) {
    return { bounded: false, counts: null, roots: null };
  }
  const legacyRows = db.prepare(`
    SELECT id AS memory_id, concept, source_message_id, last_injected_at,
           last_confirmed_at, ttl_days, pinned, review_version, review_reason
    FROM memories
    ORDER BY id COLLATE BINARY
  `).all().map(normalizeTask14MetadataRow);
  const sidecarRows = db.prepare(`
    SELECT memory_id, concept, source_message_id, last_injected_at,
           last_confirmed_at, ttl_days, pinned, review_version, review_reason
    FROM memory_console_metadata
    ORDER BY memory_id COLLATE BINARY
  `).all().map(normalizeTask14MetadataRow);
  const root = (rows) => sha256Text(JSON.stringify({
    contract: TASK14_LOGICAL_ROOT_CONTRACT_VERSION,
    rows,
  }));
  return {
    bounded: true,
    counts: {
      legacy_metadata_rows: legacyCount,
      sidecar_metadata_rows: sidecarCount,
    },
    roots: {
      legacy_sha256: root(legacyRows),
      sidecar_sha256: root(sidecarRows),
    },
  };
};

const parseTask14Receipt = (rawReceiptJson) => {
  let parsed = null;
  try {
    parsed = JSON.parse(String(rawReceiptJson || ''));
  } catch {
    return { receipt: null, reason: 'receipt_json_invalid' };
  }
  const contract = TASK14_MEMORY_CONSOLE_METADATA_RECEIPT_CONTRACT;
  if (
    !hasExactObjectKeys(parsed, contract.receiptKeys)
    || !hasExactObjectKeys(parsed.counts, contract.countKeys)
    || !hasExactObjectKeys(parsed.metadata_roots, contract.metadataRootKeys)
    || typeof parsed.contract !== 'string'
    || typeof parsed.migration_id !== 'string'
    || typeof parsed.status !== 'string'
    || typeof parsed.schema_hash !== 'string'
    || typeof parsed.counts.legacy_metadata_rows !== 'number'
    || typeof parsed.counts.sidecar_metadata_rows !== 'number'
    || typeof parsed.metadata_roots.legacy_sha256 !== 'string'
    || typeof parsed.metadata_roots.sidecar_sha256 !== 'string'
  ) {
    return { receipt: null, reason: 'receipt_contract_invalid' };
  }
  const canonical = JSON.stringify({
    contract: parsed.contract,
    migration_id: parsed.migration_id,
    status: parsed.status,
    schema_hash: parsed.schema_hash,
    counts: {
      legacy_metadata_rows: parsed.counts.legacy_metadata_rows,
      sidecar_metadata_rows: parsed.counts.sidecar_metadata_rows,
    },
    metadata_roots: {
      legacy_sha256: parsed.metadata_roots.legacy_sha256,
      sidecar_sha256: parsed.metadata_roots.sidecar_sha256,
    },
  });
  return {
    canonical,
    receipt: parsed,
    reason: String(rawReceiptJson || '') === canonical ? '' : 'receipt_json_noncanonical',
  };
};

const validateTask14MigrationEvidence = ({ db, migrationRow }) => {
  const reasons = [];
  const pushReason = (reason) => {
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };
  const migrationStatus = String(migrationRow?.status || '');
  if (migrationStatus === 'schema_only') pushReason('migration_schema_only');
  else if (migrationStatus !== 'completed') pushReason('migration_incomplete');

  const receiptHash = String(migrationRow?.receipt_hash || '');
  const schemaHash = String(migrationRow?.schema_hash || '');
  if (!RECEIPT_HASH_RE.test(receiptHash)) pushReason('receipt_hash_invalid');
  if (!RECEIPT_HASH_RE.test(schemaHash)) pushReason('schema_hash_invalid');

  const parsed = parseTask14Receipt(migrationRow?.receipt_json);
  pushReason(parsed.reason);
  const receipt = parsed.receipt;
  if (RECEIPT_HASH_RE.test(receiptHash) && sha256Text(String(migrationRow?.receipt_json || '')) !== receiptHash) {
    pushReason('receipt_hash_mismatch');
  }
  if (receipt) {
    if (
      receipt.contract !== TASK14_RECEIPT_CONTRACT_VERSION
      || receipt.migration_id !== TASK14_MEMORY_CONSOLE_METADATA_MIGRATION_ID
      || receipt.status !== migrationStatus
    ) pushReason('receipt_contract_mismatch');
    if (receipt.schema_hash !== schemaHash) pushReason('receipt_schema_hash_mismatch');
  }

  if (RECEIPT_HASH_RE.test(schemaHash)) {
    try {
      if (task14SchemaEvidence(db).hash !== schemaHash) pushReason('schema_hash_mismatch');
    } catch {
      pushReason('schema_evidence_unavailable');
    }
  }

  if (receipt) {
    const receiptCounts = [
      receipt.counts.legacy_metadata_rows,
      receipt.counts.sidecar_metadata_rows,
    ];
    const receiptCountsBounded = receiptCounts.every((count) => (
      Number.isSafeInteger(count) && count >= 0 && count <= TASK14_MAX_METADATA_ROWS
    ));
    if (!receiptCountsBounded) {
      pushReason('metadata_count_out_of_bounds');
    } else if (
      !RECEIPT_HASH_RE.test(receipt.metadata_roots.legacy_sha256)
      || !RECEIPT_HASH_RE.test(receipt.metadata_roots.sidecar_sha256)
    ) {
      pushReason('receipt_contract_invalid');
    } else {
      try {
        const actual = task14MetadataEvidence(db);
        if (!actual.bounded) {
          pushReason('metadata_count_out_of_bounds');
        } else {
          if (
            receiptCounts[0] !== receiptCounts[1]
            || actual.counts.legacy_metadata_rows !== actual.counts.sidecar_metadata_rows
            || receiptCounts[0] !== actual.counts.legacy_metadata_rows
            || receiptCounts[1] !== actual.counts.sidecar_metadata_rows
          ) pushReason('metadata_count_mismatch');
          if (
            receipt.metadata_roots.legacy_sha256 !== receipt.metadata_roots.sidecar_sha256
            || actual.roots.legacy_sha256 !== actual.roots.sidecar_sha256
            || receipt.metadata_roots.legacy_sha256 !== actual.roots.legacy_sha256
            || receipt.metadata_roots.sidecar_sha256 !== actual.roots.sidecar_sha256
          ) pushReason('metadata_root_mismatch');
        }
      } catch {
        pushReason('metadata_evidence_unavailable');
      }
    }
  }
  return reasons;
};

const inspectLegacyCompatibility = (
  dbPath,
  { db: suppliedDb = null, allowOpen = false, preOpenSafety: suppliedSafety = null } = {},
) => {
  let currentPresent = false;
  let legacyPresent = false;
  let sidecarPresent = false;
  let sidecarIndexPresent = false;
  let ledgerPresent = false;
  let ledgerColumnsPresent = false;
  let migrationRow = null;
  let migrationEvidenceReasons = [];
  let inspected = false;
  let diagnostic = '';
  let db = suppliedDb;
  let ownsDb = false;
  const preOpenSafety = suppliedSafety || inspectDoctorPreOpenSafety(dbPath);
  if (db || (allowOpen && dbPath && fs.existsSync(dbPath) && preOpenSafety.permitted)) {
    try {
      if (!db) {
        db = openDatabase(dbPath, { readOnly: true, observational: true });
        ownsDb = true;
      }
      try { db.exec('PRAGMA query_only = ON'); } catch { /* connection-local hardening */ }
      inspected = true;
      currentPresent = hasTableReadOnly(db, 'memory_current');
      legacyPresent = hasTableReadOnly(db, 'memories');
      sidecarPresent = hasTableReadOnly(db, 'memory_console_metadata');
      sidecarIndexPresent = Boolean(db.prepare(`
        SELECT 1 FROM sqlite_master
        WHERE type='index' AND name='idx_memory_console_metadata_concept_pinned'
        LIMIT 1
      `).get());
      ledgerPresent = hasTableReadOnly(db, TASK14_MIGRATION_LEDGER_TABLE);
      if (ledgerPresent) {
        const columns = db.prepare(`PRAGMA table_info(${TASK14_MIGRATION_LEDGER_TABLE})`).all()
          .map((row) => String(row?.name || ''));
        const requiredColumns = TASK14_MEMORY_CONSOLE_METADATA_RECEIPT_CONTRACT.ledgerColumns;
        ledgerColumnsPresent = columns.length === requiredColumns.length
          && columns.every((column, index) => column === requiredColumns[index]);
        if (ledgerColumnsPresent) {
          migrationRow = db.prepare(`
            SELECT migration_id, status, receipt_hash, schema_hash, receipt_json
            FROM ${TASK14_MIGRATION_LEDGER_TABLE}
            WHERE migration_id = ?
            LIMIT 1
          `).get(TASK14_MEMORY_CONSOLE_METADATA_MIGRATION_ID) || null;
          if (migrationRow) {
            migrationEvidenceReasons = validateTask14MigrationEvidence({ db, migrationRow });
          }
        }
      }
    } catch {
      currentPresent = false;
      legacyPresent = false;
      sidecarPresent = false;
      sidecarIndexPresent = false;
      ledgerPresent = false;
      ledgerColumnsPresent = false;
      migrationRow = null;
      migrationEvidenceReasons = [];
      inspected = false;
      diagnostic = 'registry_inspection_failed';
    } finally {
      if (ownsDb) {
        try { db?.close?.(); } catch { /* observational close */ }
      }
    }
  }
  if (!inspected && !diagnostic) diagnostic = preOpenSafety.diagnostic || 'registry_not_inspected';
  const schemaPresent = sidecarPresent && sidecarIndexPresent;
  const receiptPresent = Boolean(migrationRow);
  const pendingReasons = [];
  if (!inspected) {
    pendingReasons.push('registry_not_inspected');
  } else {
    if (!schemaPresent) pendingReasons.push('sidecar_schema_missing');
    if (!ledgerPresent) {
      pendingReasons.push('migration_ledger_missing');
    } else if (!ledgerColumnsPresent) {
      pendingReasons.push('migration_ledger_invalid');
    } else if (!migrationRow) {
      pendingReasons.push('migration_receipt_missing');
    } else {
      pendingReasons.push(...migrationEvidenceReasons);
    }
  }
  const task14Ready = pendingReasons.length === 0;
  return {
    legacyRequired: true,
    legacyDropBlocked: true,
    reason: LEGACY_COMPATIBILITY_REASON,
    memoryApiAuthority: {
      status: currentPresent && sidecarPresent ? 'ready' : 'pending',
      currentTable: 'memory_current',
      currentAuthoritative: true,
      metadataSidecar: 'memory_console_metadata',
      sidecarRole: 'legacy-only metadata',
      legacyProjection: 'memories',
      legacyProjectionStatus: legacyPresent ? 'preserved-required' : 'missing-required',
    },
    diagnostic,
    task14SidecarMigration: {
      status: task14Ready ? 'ready' : 'pending',
      migrationId: TASK14_MEMORY_CONSOLE_METADATA_MIGRATION_ID,
      ledgerTable: TASK14_MIGRATION_LEDGER_TABLE,
      requiredStatus: 'completed',
      receiptContract: TASK14_RECEIPT_CONTRACT_VERSION,
      schemaContract: TASK14_SCHEMA_CONTRACT_VERSION,
      maxMetadataRows: TASK14_MAX_METADATA_ROWS,
      schemaPresent,
      receiptRequired: true,
      receiptPresent,
      pendingReasons,
    },
  };
};

const duplicateGroups = (db) => {
  if (!hasTableReadOnly(db, 'memory_current')) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM (
      SELECT normalized_hash, scope, COUNT(*) AS cnt
      FROM memory_current
      WHERE status = 'active'
      GROUP BY normalized_hash, scope
      HAVING cnt > 1
    )
  `).get();
  return Number(row?.c || 0);
};

const resolveCliWriteOperation = () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  const operations = {
    audit: 'cli.audit',
    control: subcommand === 'apply' ? 'cli.control_apply' : '',
    'export-bundle': 'cli.export_bundle',
    handoff: subcommand === 'import'
      ? 'cli.import_bundle'
      : subcommand === 'export'
        ? 'cli.export_bundle'
        : subcommand === 'inspect'
          ? ''
          : 'cli.handoff',
    passport: 'cli.handoff',
    'import-bundle': 'cli.import_bundle',
    'import-openclaw': 'cli.import_openclaw',
    init: 'cli.setup',
    maintain: 'cli.maintain',
    migrate: 'cli.migrate',
    nightly: 'cli.nightly',
    snapshot: 'cli.snapshot',
    'sync-hosts': subcommand === 'status' ? '' : 'cli.sync_hosts',
    surface: subcommand === 'build' ? 'cli.surface_build' : '',
    synthesis: subcommand === 'build' ? 'cli.synthesis_build' : '',
    transcript: subcommand === 'sync' ? 'cli.transcript_sync' : '',
    vault: subcommand === 'sync' ? 'cli.vault_sync' : subcommand === 'inbox' ? 'cli.vault.inbox' : '',
    watch: 'cli.watch',
    wiki: subcommand === 'project' ? 'cli.wiki_project' : subcommand === 'reconcile' ? 'cli.wiki_reconcile' : '',
    world: subcommand === 'rebuild' ? 'cli.world_rebuild' : '',
  };
  return String(operations[command] || '');
};

const resolveCliAccessPlan = () => {
  const defaultWriterOperation = !String(flags[0] || '').trim()
    ? command === 'world'
      ? 'cli.world_rebuild'
      : command === 'synthesis'
        ? 'cli.synthesis_build'
        : ''
    : '';
  const operation = resolveCliWriteOperation() || defaultWriterOperation;
  return Object.freeze({
    access: operation ? 'write' : 'read',
    command,
    operation,
    subcommand: String(flags[0] || '').trim().toLowerCase(),
  });
};

const assertCliAccessPlanAllowed = ({ config, accessPlan } = {}) => {
  const mode = resolveWriteMode(config);
  if (accessPlan?.access === 'write') {
    return assertWriteAllowed({ mode, operation: accessPlan.operation });
  }
  return Object.freeze({ access: 'read', allowedModes: ['read_only', 'native_only', 'full'], mode });
};

const openCliDatabase = ({ config, dbPath, accessPlan, requiredTables = [] } = {}) => {
  assertCliAccessPlanAllowed({ config, accessPlan });
  if (accessPlan?.access === 'write') {
    ensureDir(path.dirname(dbPath));
    try { fs.chmodSync(path.dirname(dbPath), 0o700); } catch { /* best-effort */ }
    return { db: openDatabase(dbPath), diagnostic: '', missingTables: [], observational: false };
  }
  if (!fs.existsSync(dbPath)) {
    return { db: null, diagnostic: 'registry does not exist', missingTables: [], observational: true };
  }
  const db = openDatabase(dbPath, { readOnly: true, observational: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const missingTables = requiredTables
      .map((table) => String(table || '').trim())
      .filter((table) => table && !hasTableReadOnly(db, table));
    if (missingTables.length > 0) {
      db.close();
      return {
        db: null,
        diagnostic: `${missingTables.join(', ')} schema is unavailable`,
        missingTables,
        observational: true,
      };
    }
    return { db, diagnostic: '', missingTables: [], observational: true };
  } catch (error) {
    try { db.close(); } catch { /* already closed */ }
    throw error;
  }
};

const printReaderDiagnostic = ({ action, configPath, dbPath, opened } = {}) => {
  console.log(JSON.stringify({
    ok: false,
    action,
    read_only: true,
    observational: true,
    configPath,
    dbPath,
    diagnostic: opened?.diagnostic || 'required schema is unavailable',
    missing_tables: opened?.missingTables || [],
  }, null, 2));
};

const loadConfigAndDbPath = () => {
  const configPath = readFlag('--config', '');
  if (configPath) {
    const explicitConfigPath = path.resolve(configPath);
    if (!fs.existsSync(explicitConfigPath)) {
      throw new Error([
        `Gigabrain could not find a config at ${explicitConfigPath}.`,
        'If this should be a standalone store, run gigabrain-codex-setup or gigabrain-claude-setup first.',
        'If this should be an OpenClaw install, point --config at an existing openclaw.json.',
      ].join('\n'));
    }
  }
  const workspaceOverride = readFlag('--workspace', '');
  const mode = readFlag('--mode', '');
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
    mode: mode || undefined,
  });
  const accessPlan = resolveCliAccessPlan();
  if (accessPlan.access === 'write') {
    assertCliAccessPlanAllowed({ config: loaded.config, accessPlan });
  } else if (command === 'inventory') {
    assertEntrypointAllowed({ mode: resolveWriteMode(loaded.config), operation: 'cli.inventory' });
  } else {
    assertCliAccessPlanAllowed({ config: loaded.config, accessPlan });
  }
  const dbPath = path.resolve(readFlag('--db', loaded.config.runtime.paths.registryPath));
  // Fresh-install UX: node:sqlite's DatabaseSync throws a raw "unable to open
  // database file" when the registry's parent dir is missing. Ensure it exists
  // centrally so every command behaves like the sibling commands (sync-hosts,
  // import/export, handoff, vault-inbox) that already ensureDir before opening.
  if (accessPlan.access === 'write') {
    ensureDir(path.dirname(dbPath));
    // The memory dir holds the registry, backups, and usage logs, so keep it
    // owner-only on shared hosts.
    try { fs.chmodSync(path.dirname(dbPath), 0o700); } catch { /* best-effort */ }
  }
  return {
    configPath: loaded.configPath,
    source: loaded.source,
    config: loaded.config,
    dbPath,
    accessPlan,
  };
};

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const removeDirIfExists = (dirPath) => {
  if (!dirPath) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
};

const isPidAlive = (pid) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

const readJsonIfExists = (filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const getNightlyLockPaths = (config) => {
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const outputDir = String(config?.runtime?.paths?.outputDir || path.join(workspaceRoot, 'output'));
  return {
    outputDir,
    lockDir: path.join(outputDir, 'gigabrain-nightly.lock.d'),
    metadataPath: path.join(outputDir, 'gigabrain-nightly.lock.d', 'lock.json'),
  };
};

const acquireNightlyLock = ({ config, configPath = '', runId = '' } = {}) => {
  const { outputDir, lockDir, metadataPath } = getNightlyLockPaths(config);
  ensureDir(outputDir);
  const metadata = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    runId: String(runId || ''),
    configPath: String(configPath || ''),
  };

  const writeMetadata = () => {
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}
`, 'utf8');
  };

  const inspectExistingLock = () => {
    const existing = readJsonIfExists(metadataPath);
    if (existing && isPidAlive(existing.pid)) {
      return {
        active: true,
        existing,
        reason: 'pid_alive',
      };
    }
    const lockAgeMs = (() => {
      try {
        return Math.max(0, Date.now() - fs.statSync(lockDir).mtimeMs);
      } catch {
        return NIGHTLY_LOCK_STALE_MS;
      }
    })();
    const startedAtMs = Date.parse(String(existing?.startedAt || ''));
    const staleByAge = lockAgeMs >= NIGHTLY_LOCK_STALE_MS;
    const staleByStartedAt = Number.isFinite(startedAtMs) && (Date.now() - startedAtMs) >= NIGHTLY_LOCK_STALE_MS;
    if (existing && !isPidAlive(existing.pid)) {
      return {
        active: false,
        existing,
        reason: 'pid_missing',
      };
    }
    if (!existing && staleByAge) {
      return {
        active: false,
        existing: null,
        reason: 'metadata_missing_timeout',
      };
    }
    if (existing && staleByStartedAt) {
      return {
        active: false,
        existing,
        reason: 'started_at_timeout',
      };
    }
    return {
      active: true,
      existing,
      reason: existing ? 'unknown_owner' : 'metadata_missing_recent',
    };
  };

  const attemptAcquire = () => {
    fs.mkdirSync(lockDir);
    writeMetadata();
    return {
      acquired: true,
      skipped: false,
      clearedStale: false,
      staleReason: '',
      lockDir,
      metadataPath,
      metadata,
    };
  };

  try {
    return attemptAcquire();
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const inspection = inspectExistingLock();
    if (inspection.active) {
      return {
        acquired: false,
        skipped: true,
        clearedStale: false,
        staleReason: '',
        reason: 'nightly_already_running',
        lockDir,
        metadataPath,
        existing: inspection.existing,
        detail: inspection.reason,
      };
    }
    removeDirIfExists(lockDir);
    const acquired = attemptAcquire();
    return {
      ...acquired,
      clearedStale: true,
      staleReason: inspection.reason,
      previous: inspection.existing,
    };
  }
};

const releaseNightlyLock = (lockState) => {
  removeDirIfExists(lockState?.lockDir || '');
};

const commandMaintain = async () => {
  console.error('[gigabrain] `maintain` is a compatibility alias of the governed 24-stage `nightly` pipeline.');
  await commandNightly();
};

const commandAudit = async () => {
  const { config, dbPath } = loadConfigAndDbPath();
  const mode = String(readFlag('--mode', 'shadow') || 'shadow').trim().toLowerCase();
  const reviewVersion = readFlag('--review-version', '');
  const runId = readFlag('--run-id', '');
  if (mode === 'restore') {
    const result = runAuditRestore({
      dbPath,
      reviewVersion,
      runId,
      cleanupVersion: config.runtime.cleanupVersion,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (mode === 'report') {
    const out = readFlag('--out', '');
    const result = runAuditReport({
      dbPath,
      reviewVersion,
      out,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const llmEnabled = readBool('--llm-review', config.llm.review.enabled === true);
  const llm = {
    enabled: llmEnabled,
    provider: readFlag('--llm-provider', config.llm.provider),
    baseUrl: readFlag('--llm-base-url', config.llm.baseUrl),
    model: readFlag('--llm-model', config.llm.model),
    apiKey: readFlag('--llm-api-key', config.llm.apiKey),
    timeoutMs: Number(readFlag('--llm-timeout-ms', String(config.llm.timeoutMs)) || config.llm.timeoutMs),
    limit: Number(readFlag('--llm-review-limit', String(config.llm.review.limit)) || config.llm.review.limit),
    minScore: Number(readFlag('--llm-review-min-score', String(config.llm.review.minScore)) || config.llm.review.minScore),
    maxScore: Number(readFlag('--llm-review-max-score', String(config.llm.review.maxScore)) || config.llm.review.maxScore),
    minConfidence: Number(readFlag('--llm-review-min-confidence', String(config.llm.review.minConfidence)) || config.llm.review.minConfidence),
  };

  const result = await runAudit({
    dbPath,
    config,
    mode,
    reviewVersion,
    runId,
    out: readFlag('--out', ''),
    summary: readFlag('--summary', ''),
    samples: readFlag('--samples', ''),
    llm,
  });
  console.log(JSON.stringify(result, null, 2));
};

// ---------------------------------------------------------------------------
// U16 (R13): `gigabrain watch` — the recurring governance surface.
// ---------------------------------------------------------------------------
const WATCH_HELP = `Gigabrain watch

Re-runs the Memory Audit against the last watch snapshot cursor and reports
only NEW findings since that snapshot. The first run (no prior snapshot) is a
full audit and is labeled as such. Watch NEVER mutates memories: its entire
write surface is one watch:snapshot ledger event per run.

Usage:
  node scripts/gigabrainctl.js watch [flags]

Flags:
  --config <path>     Gigabrain config path
  --db <path>         Registry SQLite path override
  --json              Print the full JSON result instead of the human summary
  --run-id <id>       Run id override
  --install-hook      Write a host lifecycle hook. Default --kind=pre-push writes
                      an ADVISORY git pre-push hook into the current repo (warns
                      about new findings and NEVER blocks a push). --kind=session
                      writes a Claude Code SessionEnd (+ PreCompact) hook into the
                      project or user settings. The hook records one structured,
                      deduplicated lifecycle checkpoint per stable host session.
  --uninstall-hook    Remove the hook --install-hook wrote (honors --kind; refuses
                      to touch a hook Gigabrain did not install)
  --kind <kind>       pre-push (default) | session
  --settings <path>   --kind=session: explicit settings.json target (defaults to
                      ./.claude/settings.json, falling back to ~/.claude/settings.json)
  --export-counters   Print the opt-in local counters to stdout — COUNTS ONLY,
                      nothing is ever uploaded (see telemetry.countersEnabled)
  --arbitrate         OPT-IN: run belief arbitration (verdicts + supersession,
                      independent of worldModel.enabled) before the audit read.
                      This is the only watch mode that writes beyond the
                      snapshot event; the default stays read-only.
`;

const WATCH_HOOK_MARKER = '# gigabrain-watch-hook v1';

// Resolve the CURRENT repo's hooks directory. Prefer git itself (correct for
// worktrees and core.hooksPath); fall back to a plain .git/hooks walk-up when
// the git binary is unavailable.
const resolveGitHooksDir = (cwd) => {
  const probe = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (Number(probe.status) === 0) {
    const rel = String(probe.stdout || '').trim();
    if (rel) return path.resolve(cwd, rel);
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const gitPath = path.join(dir, '.git');
    try {
      if (fs.statSync(gitPath).isDirectory()) return path.join(gitPath, 'hooks');
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
};

const buildWatchHookScript = ({ configPath = '', dbPath = '' } = {}) => {
  const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const extraFlags = [
    configPath ? ` --config ${shq(configPath)}` : '',
    dbPath ? ` --db ${shq(dbPath)}` : '',
  ].join('');
  // The hook is ADVISORY ONLY: every path ends in `exit 0` — a failed audit,
  // missing node, or new findings all WARN and never block the push.
  return `#!/bin/sh
${WATCH_HOOK_MARKER}
# Installed by: gigabrainctl watch --install-hook
# Remove with:  gigabrainctl watch --uninstall-hook
# ADVISORY ONLY — this hook NEVER blocks a push. It re-runs the Gigabrain
# memory audit against the last watch snapshot and warns about NEW findings.
GB_NODE=${shq(process.execPath)}
GB_CTL=${shq(THIS_FILE)}
out="$("$GB_NODE" "$GB_CTL" watch --json${extraFlags} 2>/dev/null)"
if [ $? -ne 0 ]; then
  echo "gigabrain watch: audit run failed (push NOT blocked)" >&2
  exit 0
fi
new="$(printf '%s' "$out" | "$GB_NODE" -e 'let d="";process.stdin.on("data",(c)=>{d+=c;});process.stdin.on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(String(Math.max(0,Number(j.new_findings)||0)));}catch{process.stdout.write("0");}});')"
if [ "\${new:-0}" -gt 0 ] 2>/dev/null; then
  echo "gigabrain watch: \${new} NEW memory finding(s) since the last snapshot. Run 'gigabrainctl watch' for details. Push NOT blocked." >&2
fi
exit 0
`;
};

const commandWatchInstallHook = () => {
  const hooksDir = resolveGitHooksDir(process.cwd());
  if (!hooksDir) {
    throw new Error('watch --install-hook must run inside a git repository (no .git found from the current directory)');
  }
  const hookPath = path.join(hooksDir, 'pre-push');
  const hookState = readFileIfExistsSync(hookPath, 'utf8');
  if (hookState.exists) {
    if (!hookState.data.includes(WATCH_HOOK_MARKER)) {
      throw new Error([
        `Refusing to overwrite an existing pre-push hook Gigabrain did not install: ${hookPath}`,
        `Add a manual call to 'gigabrainctl watch' inside your hook instead.`,
      ].join('\n'));
    }
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  atomicWriteFileSync(hookPath, buildWatchHookScript({
    configPath: readFlag('--config', ''),
    dbPath: readFlag('--db', ''),
  }), { mode: 0o755 });
  // Counter is best-effort: hook installation must work without a configured
  // store (counters are opt-in and silently skipped when config is absent).
  try {
    const { config } = loadConfigAndDbPath();
    bumpLocalCounters(config, { hook_installs: 1 });
  } catch {
    // no configured store — skip counters
  }
  console.log(JSON.stringify({
    ok: true,
    action: 'watch_install_hook',
    hookPath,
    blocking: false,
    note: 'Advisory pre-push hook installed. It warns about NEW findings and never blocks a push.',
  }, null, 2));
};

const commandWatchUninstallHook = () => {
  const hooksDir = resolveGitHooksDir(process.cwd());
  if (!hooksDir) {
    throw new Error('watch --uninstall-hook must run inside a git repository (no .git found from the current directory)');
  }
  const hookPath = path.join(hooksDir, 'pre-push');
  const hookState = readFileIfExistsSync(hookPath, 'utf8');
  if (!hookState.exists) {
    console.log(JSON.stringify({ ok: true, action: 'watch_uninstall_hook', removed: false, reason: 'no_pre_push_hook' }, null, 2));
    return;
  }
  if (!hookState.data.includes(WATCH_HOOK_MARKER)) {
    throw new Error(`Refusing to delete a pre-push hook Gigabrain did not install: ${hookPath}`);
  }
  fs.rmSync(hookPath);
  console.log(JSON.stringify({ ok: true, action: 'watch_uninstall_hook', removed: true, hookPath }, null, 2));
};

// The git pre-push hook above fires on `git push`; the optional session hook
// records a structured checkpoint on Claude Code SessionEnd and PreCompact.
// Ownership, refusal, and merge safety live in lib/core/lifecycle-hooks.js.
const commandSessionInstallHook = () => {
  const settingsPath = resolveSessionSettingsPath({ explicit: readFlag('--settings', '') });
  const result = installSessionHook({
    settingsPath,
    configPath: readFlag('--config', ''),
  });
  if (result.ok) {
    try {
      const { config } = loadConfigAndDbPath();
      bumpLocalCounters(config, { hook_installs: 1 });
    } catch {
      // no configured store — skip counters
    }
  }
  console.log(JSON.stringify(result, null, 2));
};

const commandSessionUninstallHook = () => {
  const settingsPath = resolveSessionSettingsPath({ explicit: readFlag('--settings', '') });
  console.log(JSON.stringify(uninstallSessionHook({ settingsPath }), null, 2));
};

const renderWatchHuman = (result) => {
  const lines = [];
  if (result.full_run) {
    lines.push('gigabrain watch — FIRST RUN (no prior snapshot): full audit, every current finding below is reported as new.');
  } else {
    lines.push(`gigabrain watch — new findings since last snapshot (${result.since}):`);
  }
  if (result.arbitration) {
    lines.push(`arbitration (opt-in): ${result.arbitration.verdicts} verdict(s) over ${result.arbitration.beliefs} beliefs`);
  }
  lines.push(`rows audited: ${result.rows_audited}`);
  lines.push(`new findings: ${result.new_findings}`);
  for (const [action, count] of Object.entries(result.findings_by_action || {})) {
    lines.push(`  ${action}: ${count}`);
  }
  for (const finding of (result.findings || []).slice(0, 50)) {
    const reasons = (finding.reason_codes || []).join(', ') || 'none';
    lines.push(`- [${finding.action}] [${finding.type}] ${String(finding.content || '').replace(/\s+/g, ' ').trim().slice(0, 140)} (reasons: ${reasons})`);
  }
  if ((result.findings || []).length > 50) {
    lines.push(`... ${result.findings.length - 50} more (see ${result.output?.out || 'the findings report'})`);
  }
  if (result.new_findings === 0 && !result.full_run) {
    lines.push('No new findings since the last snapshot.');
  }
  lines.push(`snapshot recorded: ${result.snapshot_event_id} @ ${result.run_at}`);
  return lines.join('\n');
};

const commandWatch = async () => {
  if (wantsHelp) {
    console.log(WATCH_HELP.trim());
    return;
  }
  const hookKind = String(readFlag('--kind', 'pre-push')).trim().toLowerCase();
  if (readBool('--install-hook', false)) {
    if (hookKind === 'session') commandSessionInstallHook();
    else commandWatchInstallHook();
    return;
  }
  if (readBool('--uninstall-hook', false)) {
    if (hookKind === 'session') commandSessionUninstallHook();
    else commandWatchUninstallHook();
    return;
  }
  if (readBool('--export-counters', false)) {
    const { config } = loadConfigAndDbPath();
    // stdout carries COUNTS ONLY; this never uploads anything anywhere.
    console.log(JSON.stringify(exportLocalCounters(config), null, 2));
    if (config?.telemetry?.countersEnabled !== true) {
      console.error('note: telemetry.countersEnabled is false — counters are not being collected; this export shows zeros or stale counts.');
    }
    return;
  }
  const { config, dbPath } = loadConfigAndDbPath();
  const result = await watchRun({
    dbPath,
    config,
    runId: readFlag('--run-id', ''),
    out: readFlag('--out', ''),
    summary: readFlag('--summary', ''),
    samples: readFlag('--samples', ''),
    arbitrate: readBool('--arbitrate', false),
  });
  if (readBool('--json', false)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderWatchHuman(result));
};

const renderMemoryActionTag = ({
  action = '',
  type = '',
  confidence = '',
  scope = '',
  target = '',
  targetMemoryId = '',
  content = '',
} = {}) => {
  const attrs = [];
  const pushAttr = (key, value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const escaped = text.replace(/"/g, '&quot;');
    attrs.push(`${key}="${escaped}"`);
  };
  pushAttr('action', action);
  pushAttr('type', type);
  pushAttr('confidence', confidence);
  pushAttr('scope', scope);
  pushAttr('target', target);
  pushAttr('target_memory_id', targetMemoryId);
  const body = String(content || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<memory_action ${attrs.join(' ')}>${body}</memory_action>`;
};

const commandMigrate = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (subcommand === 'legacy-drop') {
    // The retained low-level compatibility guard throws unconditionally before
    // config resolution, database access, or snapshot path materialization.
    dropLegacyMemoriesTable();
  }
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: [
        'node scripts/gigabrainctl.js migrate legacy-checkpoints [--dry-run] [--memory-root <path>] [--scope <scope>] [--include-today] [--db <path>] [--config <path>]',
        'node scripts/gigabrainctl.js migrate classify-native-origins [--dry-run] [--db <path>] [--config <path>]',
        'legacy-drop: BLOCKED (LEGACY_DROP_BLOCKED_COMPAT; legacy projection is required through this release)',
      ],
    }, null, 2));
    return;
  }
  if (!['classify-native-origins', 'legacy-checkpoints', 'legacy-drop'].includes(subcommand)) {
    throw new Error(`unknown migrate subcommand: ${subcommand}`);
  }
  const migrateFlags = flags.slice(1);
  const dryRun = readBool('--dry-run', false, migrateFlags);

  const { config, dbPath } = loadConfigAndDbPath();
  const db = openDatabase(dbPath);
  try {
    if (subcommand === 'classify-native-origins') {
      const result = classifyNativeOrigins({ db, dryRun });
      console.log(JSON.stringify({
        ok: true,
        command: 'migrate',
        subcommand: 'classify-native-origins',
        ...result,
      }, null, 2));
      return;
    }
    if (subcommand === 'legacy-checkpoints') {
      const result = migrateLegacyCheckpoints(db, {
        memoryRoot: readFlag('--memory-root', config.runtime.paths.memoryRoot, migrateFlags),
        defaultScope: readFlag(
          '--scope',
          config?.codex?.defaultProjectScope || config?.codex?.projectScope || 'project:workspace',
          migrateFlags,
        ),
        dryRun,
        includeToday: readBool('--include-today', false, migrateFlags),
      });
      console.log(JSON.stringify({
        command: 'migrate',
        subcommand: 'legacy-checkpoints',
        ...result,
      }, null, 2));
      return;
    }
    // No accepted migration may reach residual behavior. Keep that residual
    // fail-closed as a second compatibility boundary; the helper cannot drop.
    dropLegacyMemoriesTable();
  } finally {
    db.close();
  }
};

const commandVault = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js vault <sync|status> [--dry-run] [--db <path>] [--config <path>]',
    }, null, 2));
    return;
  }
  if (subcommand !== 'sync' && subcommand !== 'status' && subcommand !== 'inbox') {
    throw new Error(`unknown vault subcommand: ${subcommand}`);
  }
  const vaultFlags = flags.slice(1);
  const dryRun = readBool('--dry-run', false, vaultFlags);

  const { config, dbPath } = loadConfigAndDbPath();

  // C2 slice: append the current findings digest to the GigaBrain-owned inbox
  // note (vault.inbox config; disabled by default; append-only, never touches
  // human notes). --dry-run prints the digest without contacting the API.
  if (subcommand === 'inbox') {
    ensureDir(path.dirname(dbPath));
    const db = openDatabase(dbPath);
    try {
      ensureProjectionStore(db);
      ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
      const result = await proposeToVaultInbox({ db, config, dryRun });
      console.log(JSON.stringify({ ok: result.ok, action: 'vault_inbox', ...result }, null, 2));
    } finally {
      db.close();
    }
    return;
  }
  const vaults = Array.isArray(config?.native?.vaults) ? config.native.vaults : [];

  // vaults:[] default → BOTH subcommands are graceful no-ops at zero cost. No
  // store creation, no DB open beyond the path resolve.
  if (vaults.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      command: 'vault',
      subcommand,
      enabled: false,
      reason: 'no vaults configured',
      vaults: [],
    }, null, 2));
    return;
  }

  if (subcommand === 'status' && !fs.existsSync(dbPath)) {
    console.log(JSON.stringify({ ok: false, observational: true, command: 'vault', subcommand: 'status', diagnostic: 'registry does not exist', vaults: [] }, null, 2));
    return;
  }
  const db = openDatabase(dbPath, subcommand === 'status' ? { readOnly: true, observational: true } : {});
  try {
    if (subcommand === 'sync') {
      const summary = syncVaultMemory({
        db,
        config,
        dryRun,
        maxFiles: Number(config?.native?.vaultSyncMaxFiles || 0) || 0,
      });
      console.log(JSON.stringify({
        ok: true,
        command: 'vault',
        subcommand: 'sync',
        dryRun,
        summary,
      }, null, 2));
      return;
    }

    // status: read-only per-vault rollup of chunk counts + last sync + evicted.
    try { db.exec('PRAGMA query_only = ON'); } catch { /* connection-local hardening */ }
    const perVaultRows = hasTableReadOnly(db, 'memory_native_chunks')
      ? db.prepare(`
      SELECT c.source_path AS source_path,
             COUNT(*) AS chunk_count,
             MAX(s.last_synced_at) AS last_synced_at
      FROM memory_native_chunks c
      LEFT JOIN memory_native_sync_state s ON s.source_path = c.source_path
      WHERE c.source_kind = 'vault' AND c.status = 'active'
      GROUP BY c.source_path
    `).all()
      : [];
    // Group source-level rollups under their configured vault root, then a
    // lightweight dry-run pass re-derives skipped_evicted per vault (the
    // eviction count is not persisted, so we recompute it read-only here).
    const vaultStatus = vaults.map((vault) => {
      const root = String(vault?.path || '').trim();
      const owned = perVaultRows.filter((row) => String(row.source_path || '').startsWith(`${root}/`) || String(row.source_path || '') === root);
      const chunkCount = owned.reduce((acc, row) => acc + Number(row.chunk_count || 0), 0);
      const lastSync = owned.reduce((acc, row) => {
        const v = String(row.last_synced_at || '');
        return v > acc ? v : acc;
      }, '');
      return {
        path: root,
        glob: String(vault?.glob || '').trim() || null,
        chunk_count: chunkCount,
        source_count: owned.length,
        last_synced_at: lastSync || null,
        skipped_evicted: null,
      };
    });
    const totalChunks = vaultStatus.reduce((acc, v) => acc + Number(v.chunk_count || 0), 0);
    console.log(JSON.stringify({
      ok: true,
      observational: true,
      command: 'vault',
      subcommand: 'status',
      enabled: true,
      vault_count: vaults.length,
      total_chunks: totalChunks,
      vaults: vaultStatus,
    }, null, 2));
  } finally {
    db.close();
  }
};

// idea #1 — transcript / rollout CDC harvester CLI. Mirrors `vault sync|status`.
//   transcript sync   — CDC-tail the configured rollout globs (local-only).
//   transcript status — read-only per-source cursor rollup (no walk, no LLM).
// native.transcripts.enabled:false (DEFAULT) → both subcommands are graceful
// no-ops at zero cost.
const commandTranscript = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js transcript <sync|status> [--dry-run] [--db <path>] [--config <path>]',
    }, null, 2));
    return;
  }
  if (subcommand !== 'sync' && subcommand !== 'status') {
    throw new Error(`unknown transcript subcommand: ${subcommand}`);
  }
  const subFlags = flags.slice(1);
  const dryRun = readBool('--dry-run', false, subFlags);

  const { config, dbPath } = loadConfigAndDbPath();
  const enabled = config?.native?.transcripts?.enabled === true;

  // Disabled → a graceful no-op at zero cost (no store creation, no walk).
  if (!enabled) {
    console.log(JSON.stringify({
      ok: true,
      command: 'transcript',
      subcommand,
      enabled: false,
      reason: 'native.transcripts.enabled is false',
    }, null, 2));
    return;
  }

  if (subcommand === 'status' && !fs.existsSync(dbPath)) {
    console.log(JSON.stringify({ ok: false, observational: true, command: 'transcript', subcommand: 'status', diagnostic: 'registry does not exist', sources: [] }, null, 2));
    return;
  }
  const db = openDatabase(dbPath, subcommand === 'status' ? { readOnly: true, observational: true } : {});
  try {
    if (subcommand === 'sync') {
      const summary = harvestTranscripts({
        db,
        config,
        incremental: true,
        arbitrate: !dryRun,
        dryRun,
        projectBeliefRows: projectArbitrationBeliefRows,
      });
      console.log(JSON.stringify({
        ok: summary.ok !== false,
        command: 'transcript',
        subcommand: 'sync',
        dryRun,
        summary,
      }, null, 2));
      return;
    }
    // status
    try { db.exec('PRAGMA query_only = ON'); } catch { /* connection-local hardening */ }
    const status = transcriptStatus({ db, config });
    console.log(JSON.stringify({
      ok: true,
      observational: true,
      command: 'transcript',
      subcommand: 'status',
      ...status,
    }, null, 2));
  } finally {
    db.close();
  }
};

// idea #5 — git-versioned LLM-wiki CLI. Mirrors `vault`/`transcript`.
//   wiki project    — materialize the arbitrated CURRENT belief set into the
//                     git wiki tree + commit (GigaBrain-authored, deterministic).
//   wiki reconcile  — ingest HUMAN edits to the wiki back into the ledger as
//                     high-trust human_wiki facts that WIN arbitration.
//   wiki status     — read-only: enabled?, dir, HEAD, last generated sha, files.
// native.wiki.enabled:false (DEFAULT) → all subcommands are graceful no-ops.
const commandWiki = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js wiki <project|reconcile|status> [--dry-run] [--db <path>] [--config <path>]',
    }, null, 2));
    return;
  }
  if (!['project', 'reconcile', 'status'].includes(subcommand)) {
    throw new Error(`unknown wiki subcommand: ${subcommand}`);
  }
  const subFlags = flags.slice(1);
  const dryRun = readBool('--dry-run', false, subFlags);

  const { config, dbPath } = loadConfigAndDbPath();
  const wiki = resolveWikiConfig(config);

  // Disabled → graceful no-op at zero cost (no repo, no disk, no DB walk).
  if (!wiki.enabled) {
    console.log(JSON.stringify({
      ok: true,
      command: 'wiki',
      subcommand,
      enabled: false,
      reason: 'native.wiki.enabled is false',
    }, null, 2));
    return;
  }

  if (subcommand === 'status') {
    // Read-only rollup: enabled, dir, whether a repo/commit exists, file count.
    const fsLocal = fs;
    const exists = fsLocal.existsSync(wiki.dir);
    let files = 0;
    try {
      const entitiesDir = path.join(wiki.dir, 'entities');
      if (fsLocal.existsSync(entitiesDir)) {
        files = fsLocal.readdirSync(entitiesDir).filter((f) => f.endsWith('.md')).length;
      }
    } catch { files = 0; }
    let state = {};
    try {
      state = JSON.parse(fsLocal.readFileSync(path.join(wiki.dir, '.gigabrain-wiki-state.json'), 'utf8')) || {};
    } catch { state = {}; }
    console.log(JSON.stringify({
      ok: true,
      command: 'wiki',
      subcommand: 'status',
      enabled: true,
      dir: wiki.dir,
      repo_exists: exists,
      files,
      last_generated_sha: state.generatedSha || null,
    }, null, 2));
    return;
  }

  const db = openDatabase(dbPath);
  try {
    if (subcommand === 'reconcile') {
      const summary = reconcileWiki({ db, config, dryRun });
      console.log(JSON.stringify({
        ok: !summary.error,
        command: 'wiki',
        subcommand: 'reconcile',
        dryRun,
        summary,
      }, null, 2));
      return;
    }
    // project
    const summary = projectWiki({ db, config, dryRun });
    console.log(JSON.stringify({
      ok: !summary.error,
      command: 'wiki',
      subcommand: 'project',
      dryRun,
      summary,
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandControl = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js control apply --action <remember|update|replace|forget|protect|do_not_store|reinstate> [--target-memory-id <id> | --target <text>] [--content <text>] [--scope <scope>] [--type <type>] [--confidence <n>]',
    }, null, 2));
    return;
  }
  if (subcommand !== 'apply') {
    throw new Error(`unknown control subcommand: ${subcommand}`);
  }
  const actionFlags = flags.slice(1);
  const action = String(readFlag('--action', '', actionFlags)).trim().toLowerCase();
  const content = String(readFlag('--content', '', actionFlags)).trim();
  const target = String(readFlag('--target', '', actionFlags)).trim();
  const targetMemoryId = String(readFlag('--target-memory-id', '', actionFlags)).trim();
  const scope = String(readFlag('--scope', 'shared', actionFlags)).trim() || 'shared';
  const type = String(readFlag('--type', '', actionFlags)).trim();
  const confidence = String(readFlag('--confidence', '', actionFlags)).trim();
  if (!action) throw new Error('--action is required');

  const { config, dbPath } = loadConfigAndDbPath();
  const db = openDatabase(dbPath);
  try {
    const tag = renderMemoryActionTag({
      action,
      type,
      confidence,
      scope,
      target,
      targetMemoryId,
      content,
    });
    const result = captureFromEvent({
      db,
      config,
      event: {
        scope,
        agentId: scope,
        sessionKey: `control:${scope}`,
        text: tag,
        output: tag,
        prompt: '',
        messages: [],
      },
      logger: console,
      runId: `control-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      reviewVersion: '',
    });
    console.log(JSON.stringify({
      ok: true,
      action,
      scope,
      result,
    }, null, 2));
  } finally {
    db.close();
  }
};

const loadNightlyConfigObservational = () => {
  const explicit = readFlag('--config', '');
  if (explicit && !fs.existsSync(path.resolve(explicit))) {
    throw new Error(`Gigabrain could not find a config at ${path.resolve(explicit)}.`);
  }
  const workspaceOverride = readFlag('--workspace', '');
  const loaded = loadResolvedConfig({
    configPath: explicit,
    workspaceRoot: workspaceOverride || undefined,
  });
  return {
    config: loaded.config,
    configPath: loaded.configPath,
    dbPath: path.resolve(readFlag('--db', loaded.config.runtime.paths.registryPath)),
  };
};

const validateStandaloneDatabase = (dbPath, { immutable = false } = {}) => {
  const openPath = immutable
    ? `${pathToFileURL(dbPath).href}?mode=ro&immutable=1`
    : dbPath;
  const db = openDatabase(openPath, { readOnly: true, observational: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const quick = db.prepare('PRAGMA quick_check').all()
      .map((row) => String(row.quick_check || Object.values(row)[0] || ''));
    if (quick.length !== 1 || quick[0] !== 'ok') {
      throw new Error(`NIGHTLY_SHADOW_QUICK_CHECK_FAILED: ${quick.join('; ') || 'empty result'}`);
    }
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length > 0) {
      throw new Error(`NIGHTLY_SHADOW_FOREIGN_KEY_CHECK_FAILED: ${foreignKeys.length}`);
    }
  } finally {
    db.close();
  }
};

const sha256FileSync = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const sha256DirectoryTree = (root) => {
  const hash = createHash('sha256');
  const walk = (directory, prefix = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`NIGHTLY_SHADOW_INPUT_UNSAFE: ${relative}`);
      }
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}\u0000${relative}\u0000${stat.mode & 0o777}\n`, 'utf8');
      if (entry.isDirectory()) walk(absolute, relative);
      else hash.update(fs.readFileSync(absolute));
    }
  };
  walk(root);
  return hash.digest('hex');
};

const pathIdentity = (filePath) => {
  const stat = fs.statSync(filePath);
  return `${String(stat.dev)}:${String(stat.ino)}`;
};

const canonicalFuturePath = (filePath) => {
  let current = path.resolve(filePath);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const base = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return path.resolve(base, ...suffix);
};

const pathsOverlap = (left, right) => (
  left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
);

const resolveRuntimePath = (config, value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(String(config?.runtime?.paths?.workspaceRoot || process.cwd()), raw);
};

const liveConfigPaths = ({ config, configPath, dbPath }) => {
  const paths = new Set([path.resolve(configPath), path.resolve(dbPath)]);
  for (const value of Object.values(config?.runtime?.paths || {})) {
    if (typeof value !== 'string' || !value.trim()) continue;
    paths.add(resolveRuntimePath(config, value));
  }
  for (const value of [config?.vault?.path, config?.graph?.path, config?.surface?.outputDir]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    paths.add(resolveRuntimePath(config, value));
  }
  return [...paths].filter(Boolean);
};

const validateSealedDirectory = (directory, label) => {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) {
    throw new Error(`${label}: expected a read-only non-symlink directory`);
  }
  return fs.realpathSync(directory);
};

const cloneNightlyConfigForCohort = ({ config, dbPath, outputDir, sourceMemoryRoot, sourceWorkspace }) => {
  const cohort = structuredClone(config);
  const liveWorkspace = path.resolve(String(config?.runtime?.paths?.workspaceRoot || process.cwd()));
  const liveMemoryRoot = resolveRuntimePath(config, config?.runtime?.paths?.memoryRoot || 'memory');
  const remapInputPath = (inputPath, label) => {
    const absolute = path.resolve(String(inputPath || ''));
    if (absolute === liveMemoryRoot || absolute.startsWith(`${liveMemoryRoot}${path.sep}`)) {
      return path.resolve(sourceMemoryRoot, path.relative(liveMemoryRoot, absolute));
    }
    if (absolute === liveWorkspace || absolute.startsWith(`${liveWorkspace}${path.sep}`)) {
      return path.resolve(sourceWorkspace, path.relative(liveWorkspace, absolute));
    }
    throw new Error(`NIGHTLY_SHADOW_UNMAPPED_INPUT: ${label}`);
  };
  cohort.runtimeDescriptorPath = '';
  cohort.lockPath = path.join(outputDir, 'state', 'native-memory.lockdir');
  cohort.runtime = cohort.runtime || {};
  cohort.runtime.paths = cohort.runtime.paths || {};
  cohort.runtime.paths.workspaceRoot = sourceWorkspace;
  cohort.runtime.paths.registryPath = dbPath;
  cohort.runtime.paths.memoryRoot = sourceMemoryRoot;
  cohort.runtime.paths.outputDir = path.join(outputDir, 'output');
  cohort.runtime.paths.reviewQueuePath = path.join(outputDir, 'state', 'memory-review-queue.jsonl');
  cohort.runtime.paths.nativeLockDir = cohort.lockPath;
  cohort.maintenance = cohort.maintenance || {};
  cohort.maintenance.snapshotDir = path.join(outputDir, 'backups');
  cohort.maintenance.eventsPath = path.join(outputDir, 'output', 'memory-events.jsonl');
  cohort.maintenance.usageLogPath = path.join(outputDir, 'memory', 'usage-log.md');
  cohort.vault = cohort.vault || {};
  cohort.vault.path = path.join(outputDir, 'vault');
  cohort.graph = cohort.graph || {};
  cohort.graph.path = path.join(outputDir, 'working', 'graph.db');
  cohort.native = cohort.native || {};
  cohort.native.memoryMdPath = remapInputPath(config?.native?.memoryMdPath, 'native.memoryMdPath');
  cohort.native.includeFiles = (config?.native?.includeFiles || [])
    .map((inputPath, index) => remapInputPath(inputPath, `native.includeFiles[${index}]`));
  cohort.native.vaults = (config?.native?.vaults || []).map((entry, index) => ({
    ...entry,
    path: remapInputPath(entry.path, `native.vaults[${index}].path`),
  }));
  cohort.native.cloudInbox = { ...cohort.native.cloudInbox, enabled: false, dir: path.join(outputDir, 'cloud-inbox-disabled') };
  cohort.native.wiki = cohort.native.wiki || {};
  cohort.native.wiki.dir = path.join(outputDir, 'wiki');
  cohort.telemetry = cohort.telemetry || {};
  cohort.telemetry.countersEnabled = false;
  return cohort;
};

const runTask12DryRun = async ({ config, configPath, dbPath, runId }) => {
  if (!fs.existsSync(dbPath)) throw new Error(`NIGHTLY_DRY_RUN_DB_MISSING: ${dbPath}`);
  if (fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`)) {
    throw new Error('NIGHTLY_DRY_RUN_REQUIRES_STANDALONE_DB');
  }
  validateStandaloneDatabase(dbPath, { immutable: true });
  const handlers = Object.fromEntries(DAILY_SEQUENCE.map((stage) => [stage, async () => (
    stage === DAILY_SEQUENCE[0]
      ? { mutationCount: 0, ok: true }
      : stage === DAILY_SEQUENCE.at(-1)
        ? { status: 'skipped_gate', reason: 'dry_run_no_receipt' }
      : { status: 'skipped_gate', reason: 'dry_run' }
  )]));
  const sequence = await executeDailySequence({ handlers, mode: 'dry_run' });
  console.log(JSON.stringify({
    ...sequence,
    command: 'nightly',
    configPath,
    dbPath,
    dryRun: true,
    runId,
  }, null, 2));
};

const nightlyReviewStage = async ({ config, db, runId }) => {
  const summary = await reviewQueuedCandidates({
    config,
    db,
    dryRun: false,
    limit: config?.llm?.queueReview?.limit,
    runId,
  });
  return { mutationCount: Number(summary?.mutatedRows || 0), ok: summary?.ok !== false };
};

const nightlyQualityStage = async ({ config, dbPath, runId }) => runAudit({
  dbPath,
  config,
  mode: 'apply',
  runId,
  llm: {
    enabled: config?.llm?.review?.enabled === true,
    provider: config?.llm?.provider,
    baseUrl: config?.llm?.baseUrl,
    model: config?.llm?.model,
    apiKey: config?.llm?.apiKey,
    timeoutMs: config?.llm?.timeoutMs,
    limit: config?.llm?.review?.limit,
    minScore: config?.llm?.review?.minScore,
    maxScore: config?.llm?.review?.maxScore,
    minConfidence: config?.llm?.review?.minConfidence,
  },
});

const nightlySurfaceStage = async ({ config, configPath, dbPath, mutationCount, runId }) => {
  const outputDir = path.join(String(config?.runtime?.paths?.outputDir || ''), 'generated-surface');
  const summary = await refreshGeneratedSurfaceAfterMutation({
    config,
    configPath,
    dbPath,
    mutationCount,
    outputDir,
    runId: `${runId}-surface`,
  });
  return { mutationCount: 0, ok: summary?.ok !== false };
};

const commandTask12ShadowNightly = async ({ config, configPath, dbPath, runId }) => {
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'cli.nightly' });
  const sourceDbFlag = readFlag('--source-db', '');
  const outputDirFlag = readFlag('--output-dir', '');
  if (!sourceDbFlag) throw new Error('NIGHTLY_SHADOW_SOURCE_REQUIRED: --source-db is required');
  if (!outputDirFlag) throw new Error('NIGHTLY_SHADOW_OUTPUT_REQUIRED: --output-dir is required');
  const sourceDb = path.resolve(sourceDbFlag);
  const outputDir = path.resolve(outputDirFlag);
  if (!fs.existsSync(sourceDb)) throw new Error(`NIGHTLY_SHADOW_SOURCE_MISSING: ${sourceDb}`);
  const sourceStat = fs.lstatSync(sourceDb);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
    throw new Error('NIGHTLY_SHADOW_SOURCE_UNSAFE: source must be one regular non-linked file');
  }
  if ((sourceStat.mode & 0o222) !== 0) {
    throw new Error('NIGHTLY_SHADOW_SOURCE_NOT_SEALED: source must be read-only');
  }
  if (fs.existsSync(`${sourceDb}-wal`) || fs.existsSync(`${sourceDb}-shm`)) {
    throw new Error('NIGHTLY_SHADOW_SOURCE_NOT_STANDALONE: WAL/SHM sidecars are forbidden');
  }
  if (fs.existsSync(outputDir)) throw new Error(`NIGHTLY_SHADOW_OUTPUT_EXISTS: ${outputDir}`);

  const sourceCanonical = fs.realpathSync(sourceDb);
  const sourceIdentity = pathIdentity(sourceDb);
  const outputCanonical = canonicalFuturePath(outputDir);
  const livePaths = liveConfigPaths({ config, configPath, dbPath });
  for (const livePath of livePaths) {
    const liveCanonical = canonicalFuturePath(livePath);
    if (pathsOverlap(outputCanonical, liveCanonical)) {
      throw new Error(`NIGHTLY_SHADOW_OUTPUT_ALIASES_LIVE_PATH: ${livePath}`);
    }
    if (fs.existsSync(livePath) && pathIdentity(livePath) === sourceIdentity) {
      throw new Error(`NIGHTLY_SHADOW_LIVE_SOURCE_FORBIDDEN: ${livePath}`);
    }
  }
  if (pathsOverlap(outputCanonical, sourceCanonical)) {
    throw new Error('NIGHTLY_SHADOW_OUTPUT_ALIASES_SOURCE');
  }

  const sourceWorkspaceFlag = readFlag('--source-workspace', '');
  const sourceMemoryRootFlag = readFlag('--source-memory-root', '');
  if (sourceMemoryRootFlag) {
    throw new Error('NIGHTLY_SHADOW_EXTERNAL_MEMORY_ROOT_UNSUPPORTED: preserve memoryRoot inside --source-workspace');
  }
  if (config?.native?.enabled !== false && !sourceWorkspaceFlag) {
    throw new Error('NIGHTLY_SHADOW_NATIVE_INPUT_REQUIRED: --source-workspace must preserve the sealed live workspace layout');
  }
  if (config?.hostSync?.autoNightly === true) {
    throw new Error('NIGHTLY_SHADOW_HOST_INPUT_REQUIRED: automatic host sync needs an explicit sealed host cohort');
  }
  if (config?.native?.transcripts?.enabled === true) {
    throw new Error('NIGHTLY_SHADOW_TRANSCRIPT_INPUT_REQUIRED: transcript harvest needs an explicit sealed transcript cohort');
  }
  let sourceWorkspace = '';
  let sourceMemoryRoot = '';
  let sourceWorkspaceHash = '';
  let sourceMemoryRootHash = '';
  if (sourceWorkspaceFlag) {
    sourceWorkspace = validateSealedDirectory(path.resolve(sourceWorkspaceFlag), 'NIGHTLY_SHADOW_WORKSPACE_NOT_SEALED');
    const liveWorkspace = path.resolve(String(config?.runtime?.paths?.workspaceRoot || process.cwd()));
    if (config?.native?.enabled !== false && sourceWorkspace !== liveWorkspace) {
      throw new Error('NIGHTLY_SHADOW_NATIVE_WORKSPACE_REQUIRES_LOGICAL_MOUNT');
    }
    const liveMemoryRoot = resolveRuntimePath(config, config?.runtime?.paths?.memoryRoot || 'memory');
    if (liveMemoryRoot !== liveWorkspace && !liveMemoryRoot.startsWith(`${liveWorkspace}${path.sep}`)) {
      throw new Error('NIGHTLY_SHADOW_MEMORY_ROOT_OUTSIDE_WORKSPACE');
    }
    sourceMemoryRoot = path.resolve(sourceWorkspace, path.relative(liveWorkspace, liveMemoryRoot));
    if (config?.native?.enabled !== false) {
      sourceMemoryRoot = validateSealedDirectory(sourceMemoryRoot, 'NIGHTLY_SHADOW_MEMORY_ROOT_NOT_SEALED');
    }
    if (pathsOverlap(outputCanonical, sourceWorkspace) || pathsOverlap(outputCanonical, sourceMemoryRoot)) {
      throw new Error('NIGHTLY_SHADOW_OUTPUT_ALIASES_INPUT_WORKSPACE');
    }
    sourceWorkspaceHash = sha256DirectoryTree(sourceWorkspace);
    sourceMemoryRootHash = sourceMemoryRoot === sourceWorkspace
      ? sourceWorkspaceHash
      : sha256DirectoryTree(sourceMemoryRoot);
  }

  validateStandaloneDatabase(sourceDb, { immutable: true });
  const sourceHashBefore = sha256FileSync(sourceDb);

  fs.mkdirSync(outputDir, { mode: 0o700, recursive: false });
  if (!sourceWorkspace) {
    sourceWorkspace = path.join(outputDir, 'sealed-empty-workspace');
    sourceMemoryRoot = path.join(sourceWorkspace, 'memory');
    fs.mkdirSync(sourceWorkspace, { mode: 0o700 });
    fs.mkdirSync(sourceMemoryRoot, { mode: 0o500 });
    fs.chmodSync(sourceMemoryRoot, 0o500);
    fs.chmodSync(sourceWorkspace, 0o500);
    sourceWorkspaceHash = sha256DirectoryTree(sourceWorkspace);
    sourceMemoryRootHash = sha256DirectoryTree(sourceMemoryRoot);
  }
  const workingDir = path.join(outputDir, 'working');
  fs.mkdirSync(workingDir, { mode: 0o700 });
  const workingDbPath = path.join(workingDir, 'registry.sqlite');
  fs.copyFileSync(sourceDb, workingDbPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(workingDbPath, 0o600);
  const sourceHashAfterCopy = sha256FileSync(sourceDb);
  const workingHash = sha256FileSync(workingDbPath);
  if (sourceHashAfterCopy !== sourceHashBefore || workingHash !== sourceHashBefore) {
    throw new Error('NIGHTLY_SHADOW_SOURCE_CHANGED_DURING_COPY');
  }
  validateStandaloneDatabase(workingDbPath);
  const cohortConfig = cloneNightlyConfigForCohort({
    config,
    dbPath: workingDbPath,
    outputDir,
    sourceMemoryRoot,
    sourceWorkspace,
  });
  const cohortStateDir = path.join(outputDir, 'state');
  fs.mkdirSync(cohortStateDir, { mode: 0o700, recursive: true });
  fs.chmodSync(cohortStateDir, 0o700);
  const cohortConfigPath = path.join(cohortStateDir, 'openclaw.shadow.json');
  const cohortConfigBody = `${JSON.stringify({
    plugins: { entries: { gigabrain: { enabled: true, config: cohortConfig } } },
  }, null, 2)}\n`;
  atomicWriteFileSync(cohortConfigPath, cohortConfigBody, { mode: 0o600 });
  const cohortConfigSha256 = createHash('sha256').update(cohortConfigBody, 'utf8').digest('hex');
  const shadowCapability = authorizeShadowMaintenanceCohort({
    config: cohortConfig,
    dbPath: workingDbPath,
    outputDir: cohortConfig.runtime.paths.outputDir,
    sourceDbPath: sourceDb,
  });
  const sequence = await runDailyMaintenanceSequence({
    cohortIdentity: {
      sourceDbSha256: sourceHashBefore,
      cohortConfigSha256,
      sourceMemoryRootSha256: sourceMemoryRootHash,
      sourceWorkspaceSha256: sourceWorkspaceHash,
      workingDbPath,
    },
    config: cohortConfig,
    configPath: cohortConfigPath,
    dbPath: workingDbPath,
    mode: 'shadow',
    outputDir: cohortConfig.runtime.paths.outputDir,
    qualityReviewStage: nightlyQualityStage,
    reviewQueueStage: nightlyReviewStage,
    runId,
    shadowCapability,
    surfaceRefreshStage: nightlySurfaceStage,
  });
  if (sha256FileSync(sourceDb) !== sourceHashBefore || pathIdentity(sourceDb) !== sourceIdentity) {
    throw new Error('NIGHTLY_SHADOW_SOURCE_CHANGED_DURING_RUN');
  }
  if (sourceWorkspaceFlag) {
    if (sha256DirectoryTree(sourceWorkspace) !== sourceWorkspaceHash) {
      throw new Error('NIGHTLY_SHADOW_WORKSPACE_CHANGED_DURING_RUN');
    }
    if (sourceMemoryRoot !== sourceWorkspace && sha256DirectoryTree(sourceMemoryRoot) !== sourceMemoryRootHash) {
      throw new Error('NIGHTLY_SHADOW_MEMORY_ROOT_CHANGED_DURING_RUN');
    }
  } else {
    fs.chmodSync(sourceMemoryRoot, 0o700);
    fs.chmodSync(sourceWorkspace, 0o700);
  }
  if (!sequence.ok) throw new Error(`NIGHTLY_SHADOW_FAILED: ${sequence.failure?.stage || 'unknown'} ${sequence.failure?.error || ''}`);
  console.log(JSON.stringify({
    ...sequence,
    cohortLockPath: cohortConfig.lockPath,
    command: 'nightly',
    cohortConfigPath,
    cohortConfigSha256,
    configPath,
    dryRun: false,
    sourceDb,
    sourceSha256: sourceHashBefore,
    sourceWorkspace,
    sourceWorkspaceSha256: sourceWorkspaceHash || sha256DirectoryTree(sourceWorkspace),
    workingDbPath,
  }, null, 2));
};

const commandSnapshot = async () => {
  const configPath = readFlag('--config', '');
  const loaded = loadResolvedConfig({ configPath });
  assertWriteAllowed({ mode: resolveWriteMode(loaded.config), operation: 'cli.snapshot' });
  const sourcePath = path.resolve(readFlag('--db', loaded.config.runtime.paths.registryPath));
  const targetFlag = readFlag('--target', '');
  if (!targetFlag) throw new Error('SNAPSHOT_TARGET_REQUIRED: --target is required');
  const targetPath = path.resolve(targetFlag);
  if (!fs.existsSync(sourcePath)) throw new Error(`SNAPSHOT_SOURCE_MISSING: ${sourcePath}`);
  const sourceStat = fs.lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
    throw new Error('SNAPSHOT_SOURCE_UNSAFE: source must be one regular non-linked file');
  }
  if (sourcePath === targetPath) throw new Error('SNAPSHOT_TARGET_ALIASES_SOURCE');
  const db = openDatabase(sourcePath, { readOnly: true, observational: true });
  try {
    const receipt = snapshotDatabase(db, targetPath);
    console.log(JSON.stringify({
      ...receipt,
      command: 'snapshot',
      configPath: loaded.configPath,
      sourcePath,
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandNightly = async () => {
  const dryRun = readBool('--dry-run', false);
  const shadow = readBool('--shadow', false);
  if (dryRun && shadow) throw new Error('NIGHTLY_MODE_CONFLICT: --dry-run and --shadow are mutually exclusive');
  if (dryRun || shadow) {
    const { config, configPath, dbPath } = loadNightlyConfigObservational();
    const runId = String(readFlag('--run-id', '') || `nightly-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    if (dryRun) await runTask12DryRun({ config, configPath, dbPath, runId });
    else await commandTask12ShadowNightly({ config, configPath, dbPath, runId });
    return;
  }
  const { configPath, config, dbPath } = loadNightlyConfigObservational();
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'cli.nightly' });
  const runId = readFlag('--run-id', '');
  const lock = acquireNightlyLock({
    config,
    configPath,
    runId,
  });
  if (lock.skipped) {
    console.log(JSON.stringify({
      ok: true,
      command: 'nightly',
      skipped: true,
      reason: lock.reason,
      lock,
    }, null, 2));
    return;
  }
  try {
    const sequence = await runDailyMaintenanceSequence({
      cohortIdentity: { dbPath, mode: 'normal' },
      dbPath,
      config,
      configPath,
      mode: 'normal',
      outputDir: config.runtime.paths.outputDir,
      qualityReviewStage: nightlyQualityStage,
      reviewQueueStage: nightlyReviewStage,
      runId,
      surfaceRefreshStage: nightlySurfaceStage,
    });
    console.log(JSON.stringify({
      ...sequence,
      command: 'nightly',
      lock,
    }, null, 2));
    if (!sequence.ok) {
      throw new Error(`NIGHTLY_FAILED: ${sequence.failure?.stage || 'unknown'} ${sequence.failure?.error || ''}`);
    }
  } finally {
    releaseNightlyLock(lock);
  }
};

const commandSurface = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || ['--help', '-h', 'help'].includes(subcommand)) {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js surface build|status|doctor [--config <path>] [--db <path>] [--output-dir <path>] [--force]',
    }, null, 2));
    return;
  }
  if (!['build', 'status', 'doctor'].includes(subcommand)) throw new Error(`unknown surface subcommand: ${subcommand}`);
  const { config, dbPath } = loadConfigAndDbPath();
  const outputDir = readFlag('--output-dir', '');
  if (subcommand === 'build') {
    const db = openDatabase(dbPath);
    try {
      const result = await buildGeneratedSurface({
        config,
        db,
        force: readBool('--force', false),
        outputDir,
        runId: readFlag('--run-id', `surface-${new Date().toISOString().replace(/[:.]/g, '-')}`),
      });
      console.log(JSON.stringify({ command: 'surface', subcommand, ...result }, null, 2));
    } finally {
      db.close();
    }
    return;
  }
  let db = null;
  try {
    if (fs.existsSync(dbPath)) db = openDatabase(dbPath, { readOnly: true, observational: true });
    const health = await inspectGeneratedSurface({ config, db, outputDir });
    console.log(JSON.stringify({
      command: 'surface',
      ok: subcommand === 'status' ? true : health.healthy,
      observational: true,
      subcommand,
      health,
    }, null, 2));
  } finally {
    db?.close?.();
  }
};
const commandInventory = async () => {
  const { dbPath } = loadConfigAndDbPath();
  if (!fs.existsSync(dbPath)) {
    console.log(JSON.stringify({ ok: false, observational: true, dbPath, diagnostic: 'registry does not exist' }, null, 2));
    return;
  }
  const db = openDatabase(dbPath, { readOnly: true, observational: true });
  try {
    try { db.exec('PRAGMA query_only = ON'); } catch { /* connection-local hardening */ }
    if (!hasTableReadOnly(db, 'memory_current')) {
      console.log(JSON.stringify({ ok: false, observational: true, dbPath, diagnostic: 'memory_current schema is unavailable' }, null, 2));
      return;
    }
    const metrics = captureSnapshotMetrics(db, dbPath, { ensure: false });
    console.log(JSON.stringify({
      ok: true,
      observational: true,
      dbPath,
      metrics,
      exact_duplicate_groups_active: duplicateGroups(db),
    }, null, 2));
  } finally {
    db.close();
  }
};

const pendingDoctorStoreHealth = ({ config, dbPath, diagnostic, target = 'project' } = {}) => ({
  target,
  ok: false,
  status: 'pending',
  workspace_root: String(config?.runtime?.paths?.workspaceRoot || '').trim(),
  db_path: dbPath,
  db_exists: Boolean(dbPath && fs.existsSync(dbPath)),
  memory_md_path: String(config?.native?.memoryMdPath || '').trim(),
  memory_md_exists: Boolean(config?.native?.memoryMdPath && fs.existsSync(config.native.memoryMdPath)),
  stats: {
    total: 0,
    status: {},
  },
  diagnostic,
});

const selectedCodexDoctorStores = ({ context, target = 'both' } = {}) => {
  const normalized = String(target || '').trim().toLowerCase();
  const targets = normalized === 'project'
    ? ['project']
    : normalized === 'user' ? ['user'] : ['project', 'user'];
  return targets.map((storeTarget) => {
    const storeConfig = storeTarget === 'project' ? context?.projectConfig : context?.userConfig;
    const storeDbPath = String(storeConfig?.runtime?.paths?.registryPath || '').trim();
    return {
      config: storeConfig || null,
      dbPath: storeDbPath,
      preOpenSafety: storeConfig
        ? inspectDoctorPreOpenSafety(storeDbPath)
        : { diagnostic: 'store_not_configured', permitted: true },
      target: storeTarget,
    };
  });
};

const commandDoctor = async () => {
  const { configPath, source, config, dbPath } = loadConfigAndDbPath();
  const target = readFlag('--target', 'both');
  if (source === 'standalone' && config?.codex?.enabled !== false) {
    const codexOptions = {
      configPath,
      target,
      workspaceRoot: readFlag('--workspace', ''),
      mode: readFlag('--mode', source),
    };
    const { loadCodexContext, runDoctor } = await import('../lib/core/codex-service.js');
    const context = loadCodexContext(codexOptions);
    const stores = selectedCodexDoctorStores({ context, target });
    const unsafeStores = stores.filter((store) => store.config && !store.preOpenSafety.permitted);
    const compatibilityStore = target === 'user'
      ? stores.find((store) => store.target === 'user')
      : stores.find((store) => store.target === 'project') || stores[0];
    let compatibility = inspectLegacyCompatibility(compatibilityStore?.dbPath || '', {
      preOpenSafety: compatibilityStore?.preOpenSafety,
    });
    if (unsafeStores.length > 0) {
      console.log(JSON.stringify({
        ok: false,
        observational: true,
        source,
        config_path: configPath,
        stores: stores.map((store) => pendingDoctorStoreHealth({
          config: store.config,
          dbPath: store.dbPath,
          diagnostic: !store.config
            ? 'store_not_configured'
            : store.preOpenSafety.permitted
              ? 'selected_store_preopen_blocked'
              : store.preOpenSafety.diagnostic,
          target: store.target,
        })),
        compatibility,
      }, null, 2));
      return;
    }
    compatibility = inspectLegacyCompatibility(compatibilityStore?.dbPath || '', {
      allowOpen: Boolean(compatibilityStore?.config),
      preOpenSafety: compatibilityStore?.preOpenSafety,
    });
    const result = await runDoctor(codexOptions);
    console.log(JSON.stringify({ ...result, observational: true, compatibility }, null, 2));
    return;
  }
  const preOpenSafety = inspectDoctorPreOpenSafety(dbPath);
  let compatibility = inspectLegacyCompatibility(dbPath, { preOpenSafety });
  const checks = [];
  checks.push({ name: 'config_loaded', ok: Boolean(config) });
  checks.push({ name: 'db_exists', ok: Boolean(dbPath) });
  let metrics = null;
  let duplicates = null;
  let cloudInboxNudges = [];
  if (!fs.existsSync(dbPath)) {
    checks.push({ name: 'projection_ready', ok: false, diagnostic: 'registry does not exist' });
    console.log(JSON.stringify({
      ok: false,
      observational: true,
      configKind: source,
      configPath,
      dbPath,
      checks,
      metrics,
      cloud_inbox: cloudInboxNudges,
      compatibility,
    }, null, 2));
    return;
  }
  if (!preOpenSafety.permitted) {
    checks.push({
      name: 'projection_ready',
      ok: false,
      diagnostic: preOpenSafety.diagnostic,
    });
    console.log(JSON.stringify({
      ok: false,
      observational: true,
      configKind: source,
      configPath,
      dbPath,
      checks,
      metrics,
      cloud_inbox: cloudInboxNudges,
      compatibility,
    }, null, 2));
    return;
  }
  const db = openDatabase(dbPath, { readOnly: true, observational: true });
  try {
    try { db.exec('PRAGMA query_only = ON'); } catch { /* connection-local hardening */ }
    compatibility = inspectLegacyCompatibility(dbPath, { db });
    if (!hasTableReadOnly(db, 'memory_current')) {
      checks.push({ name: 'projection_ready', ok: false, diagnostic: 'memory_current schema is unavailable' });
    } else {
      metrics = captureSnapshotMetrics(db, dbPath, { ensure: false });
      duplicates = duplicateGroups(db);
      checks.push({ name: 'projection_ready', ok: true, total: metrics.totals.all });
      checks.push({ name: 'exact_duplicates_active', ok: duplicates === 0, value: duplicates });
      checks.push({
        name: 'free_page_ratio_slo',
        ok: Number(metrics.db.page.free_page_ratio || 0) < 0.2,
        value: Number(metrics.db.page.free_page_ratio || 0),
      });
      // #6 cloud-inbox staleness nudge. Disabled (default) → [] (no check at all).
      cloudInboxNudges = cloudInboxStaleness({ db, config });
      const staleSources = cloudInboxNudges.filter((row) => row.status === 'stale');
      if (config?.native?.cloudInbox?.enabled === true) {
        checks.push({
          name: 'cloud_inbox_fresh',
          ok: staleSources.length === 0,
          stale: staleSources.map((row) => `${row.vendor} (${row.age_days}d > ${row.stale_days}d)`),
        });
      }
    }
  } finally {
    db.close();
  }
  console.log(JSON.stringify({
    ok: checks.every((check) => check.ok),
    observational: true,
    configKind: source,
    configPath,
    dbPath,
    checks,
    metrics,
    cloud_inbox: cloudInboxNudges,
    compatibility,
  }, null, 2));
};

const commandWorld = async () => {
  const action = String(flags[0] || 'rebuild').trim().toLowerCase();
  if (!['rebuild', 'entities'].includes(action)) throw new Error(`Unknown world action: ${action || '(none)'}`);
  const worldFlags = flags.slice(1);
  const configPath = readFlag('--config', '', worldFlags);
  const workspaceOverride = readFlag('--workspace', '', worldFlags);
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath, worldFlags));
  const accessPlan = resolveCliAccessPlan();
  const opened = openCliDatabase({
    config,
    dbPath,
    accessPlan,
    requiredTables: action === 'entities' ? ['memory_entities'] : [],
  });
  if (!opened.db) {
    printReaderDiagnostic({ action: 'world_entities', configPath: loaded.configPath, dbPath, opened });
    return;
  }
  const db = opened.db;
  try {
    if (action === 'rebuild') {
      ensureProjectionStore(db);
      ensureWorldModelReady({ db, config, rebuildIfEmpty: false });
      const result = rebuildWorldModel({ db, config });
      console.log(JSON.stringify({ ok: true, action: 'world_rebuild', configPath: loaded.configPath, dbPath, result }, null, 2));
      return;
    }
    if (action === 'entities') {
      const items = listEntities(db, {
        ensure: false,
        kind: readFlag('--kind', '', worldFlags),
        limit: Number(readFlag('--limit', '200', worldFlags) || 200),
      });
      console.log(JSON.stringify({ ok: true, action: 'world_entities', read_only: true, observational: true, items, count: items.length }, null, 2));
      return;
    }
  } finally {
    db.close();
  }
};

const commandOrchestrator = async () => {
  const action = String(flags[0] || 'explain').trim().toLowerCase();
  const orchestratorFlags = flags.slice(1);
  if (action !== 'explain') throw new Error(`Unknown orchestrator action: ${action || '(none)'}`);
  const query = String(readFlag('--query', '', orchestratorFlags)).trim();
  if (!query) throw new Error('orchestrator explain requires --query');
  const configPath = readFlag('--config', '', orchestratorFlags);
  const workspaceOverride = readFlag('--workspace', '', orchestratorFlags);
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath, orchestratorFlags));
  const accessPlan = resolveCliAccessPlan();
  const opened = openCliDatabase({
    config,
    dbPath,
    accessPlan,
    requiredTables: [
      'memory_beliefs',
      'memory_current',
      'memory_entities',
      'memory_entity_aliases',
      'memory_entity_mentions',
      'memory_episodes',
      'memory_native_chunks',
      'memory_open_loops',
      'memory_syntheses',
    ],
  });
  if (!opened.db) {
    printReaderDiagnostic({ action: 'orchestrator_explain', configPath: loaded.configPath, dbPath, opened });
    return;
  }
  const db = opened.db;
  try {
    const result = orchestrateRecall({
      db,
      config,
      query,
      scope: String(readFlag('--scope', '', orchestratorFlags)).trim(),
      scopeVisibility: { allowMaintenance: false },
    });
    console.log(JSON.stringify({ ok: true, action: 'orchestrator_explain', read_only: true, observational: true, result }, null, 2));
  } finally {
    db.close();
  }
};

const commandSynthesis = async () => {
  const action = String(flags[0] || 'build').trim().toLowerCase();
  if (!['build', 'list'].includes(action)) throw new Error(`Unknown synthesis action: ${action || '(none)'}`);
  const synthesisFlags = flags.slice(1);
  const configPath = readFlag('--config', '', synthesisFlags);
  const workspaceOverride = readFlag('--workspace', '', synthesisFlags);
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath, synthesisFlags));
  const accessPlan = resolveCliAccessPlan();
  const opened = openCliDatabase({
    config,
    dbPath,
    accessPlan,
    requiredTables: action === 'list' ? ['memory_syntheses'] : [],
  });
  if (!opened.db) {
    printReaderDiagnostic({ action: 'synthesis_list', configPath: loaded.configPath, dbPath, opened });
    return;
  }
  const db = opened.db;
  try {
    if (action === 'build') {
      ensureProjectionStore(db);
      ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
      const result = rebuildWorldModel({ db, config });
      console.log(JSON.stringify({ ok: true, action: 'synthesis_build', result }, null, 2));
      return;
    }
    if (action === 'list') {
      const items = listSyntheses(db, {
        ensure: false,
        kind: readFlag('--kind', '', synthesisFlags),
        limit: Number(readFlag('--limit', '200', synthesisFlags) || 200),
      });
      console.log(JSON.stringify({ ok: true, action: 'synthesis_list', read_only: true, observational: true, items, count: items.length }, null, 2));
      return;
    }
  } finally {
    db.close();
  }
};

const commandBriefing = async () => {
  const configPath = readFlag('--config', '');
  const workspaceOverride = readFlag('--workspace', '');
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath));
  const accessPlan = resolveCliAccessPlan();
  const opened = openCliDatabase({ config, dbPath, accessPlan, requiredTables: ['memory_syntheses'] });
  if (!opened.db) {
    printReaderDiagnostic({ action: 'briefing_build', configPath: loaded.configPath, dbPath, opened });
    return;
  }
  const db = opened.db;
  try {
    const items = listSyntheses(db, { ensure: false, kind: 'session_brief', limit: 5 });
    console.log(JSON.stringify({ ok: true, action: 'briefing_build', read_only: true, observational: true, items, count: items.length }, null, 2));
  } finally {
    db.close();
  }
};

const commandReview = async () => {
  const action = String(flags[0] || '').trim().toLowerCase();
  const reviewActions = ['adjudications', 'beliefs-as-of', 'contradictions', 'open-loops', 'queue', 'trust'];
  if (!reviewActions.includes(action)) throw new Error(`Unknown review action: ${action || '(none)'}`);
  const reviewFlags = flags.slice(1);
  const configPath = readFlag('--config', '', reviewFlags);
  const workspaceOverride = readFlag('--workspace', '', reviewFlags);
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath, reviewFlags));
  const accessPlan = resolveCliAccessPlan();
  assertCliAccessPlanAllowed({ config, accessPlan });
  // U16 read surface (agent-native review F3): list/filter review-queue
  // entries (incl. the U11/U13 escalation reason codes). READ-ONLY — listing
  // never rewrites or resolves entries; resolution is future scope. The
  // queue is file-based JSONL, so no db/world-model open is needed.
  if (action === 'queue') {
    const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
    const status = String(readFlag('--status', 'pending', reviewFlags)).trim().toLowerCase();
    const reasonCode = String(readFlag('--reason-code', '', reviewFlags)).trim().toLowerCase();
    const result = listQueueEntries(queuePath, {
      status,
      reasonCode,
      limit: Number(readFlag('--limit', '100', reviewFlags) || 100),
    });
    console.log(JSON.stringify({
      ok: true,
      action: 'review_queue',
      read_only: true,
      observational: true,
      queuePath,
      status: status || null,
      reason_code: reasonCode || null,
      items: result.entries,
      count: result.entries.length,
      total: result.total,
      malformed_rows: result.malformed,
    }, null, 2));
    return;
  }
  const requiredTablesByAction = {
    adjudications: ['memory_events'],
    'beliefs-as-of': ['memory_current'],
    contradictions: ['memory_open_loops'],
    'open-loops': ['memory_open_loops'],
    trust: ['memory_current', 'memory_events', 'memory_host_trust'],
  };
  const opened = openCliDatabase({
    config,
    dbPath,
    accessPlan,
    requiredTables: requiredTablesByAction[action] || [],
  });
  if (!opened.db) {
    printReaderDiagnostic({ action: `review_${action.replaceAll('-', '_')}`, configPath: loaded.configPath, dbPath, opened });
    return;
  }
  const db = opened.db;
  try {
    if (action === 'contradictions') {
      const items = listContradictions(db, { ensure: false, limit: Number(readFlag('--limit', '200', reviewFlags) || 200) });
      console.log(JSON.stringify({ ok: true, action: 'review_contradictions', read_only: true, observational: true, items, count: items.length }, null, 2));
      return;
    }
    if (action === 'open-loops') {
      const items = listOpenLoops(db, { ensure: false, limit: Number(readFlag('--limit', '200', reviewFlags) || 200) });
      console.log(JSON.stringify({ ok: true, action: 'review_open_loops', read_only: true, observational: true, items, count: items.length }, null, 2));
      return;
    }
    // B1 shadow surface: per-host adaptive-trust view (base tier, stored
    // delta, fold target, effective value, evidence). dryRun — a review never
    // moves deltas or writes events; only the nightly step does.
    if (action === 'trust') {
      const summary = runAdaptiveTrust({ db, config, dryRun: true, ensure: false });
      console.log(JSON.stringify({
        ok: true,
        action: 'review_trust',
        read_only: true,
        observational: true,
        shadow: summary.shadow,
        hosts: summary.hosts,
        fingerprint: summary.fingerprint,
      }, null, 2));
      return;
    }
    // U15 drill-down parity: CLI leg of the MCP + /gb/ + CLI triple for the
    // adjudication ledger and the bi-temporal as-of view.
    if (action === 'adjudications') {
      const states = String(readFlag('--states', '', reviewFlags) || '')
        .split(',')
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
      const items = listAdjudications(db, {
        memoryId: readFlag('--memory-id', '', reviewFlags),
        states,
        limit: Number(readFlag('--limit', '100', reviewFlags) || 100),
      });
      console.log(JSON.stringify({ ok: true, action: 'review_adjudications', read_only: true, observational: true, items, count: items.length }, null, 2));
      return;
    }
    if (action === 'beliefs-as-of') {
      const at = String(readFlag('--at', '', reviewFlags) || '').trim();
      if (!at || !Number.isFinite(Date.parse(at))) {
        throw new Error('review beliefs-as-of requires a parseable ISO --at timestamp');
      }
      const items = listBeliefsAsOf(db, {
        at,
        ensure: false,
        scope: readFlag('--scope', '', reviewFlags),
        limit: Number(readFlag('--limit', '200', reviewFlags) || 200),
      });
      console.log(JSON.stringify({ ok: true, action: 'review_beliefs_as_of', read_only: true, observational: true, at, items, count: items.length }, null, 2));
      return;
    }
  } finally {
    db.close();
  }
};

const parseHostList = (list = flags) => {
  const raw = String(readFlag('--host', '', list) || readFlag('--hosts', '', list)).trim();
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
};

const SYNC_HOSTS_HELP = `Gigabrain sync-hosts

Usage:
  node scripts/gigabrainctl.js sync-hosts [flags]
  node scripts/gigabrainctl.js sync-hosts sources [flags]
  node scripts/gigabrainctl.js sync-hosts status [flags]
  node scripts/gigabrainctl.js sync-hosts export-brief [flags]

Commands:
  sync-hosts            Force/debug re-index of local host memories into Gigabrain
  sync-hosts sources    Show synced source counts and optional local discovery
  sync-hosts status     Show host sync diagnostics grouped by readiness
  sync-hosts export-brief Generate an AGENTS.md/CLAUDE.md/manual-import brief

Note:
  Host memories are now auto-ingested on \`npm run setup\` and on every nightly
  \`maintain\` run (budgeted host_sync step, per-host incremental cursor). This
  verb is the FORCE/DEBUG path: it re-indexes ALL detected lines (the cursor is
  not consulted) and is useful for targeting a single host or troubleshooting.

Flags:
  --config <path>       Gigabrain config path
  --host <list>         Comma-separated hosts, for example codex,claude_code,cursor,windsurf
  --scope <scope>       Target scope for imported memories
  --codex-home <path>   Override Codex home containing memories/
  --claude-home <path>  Override Claude home containing projects/
  --hermes-home <path>  Override Hermes home containing memories/
  --manual-import <path> Explicit manual cloud export file/folder
  --manual-source-host <host> chatgpt_manual|gemini_manual|copilot_manual|claude_manual
  --dry-run             Discover and parse without writing
  --no-arbitrate        Skip ingest-time arbitration (debug; nightly still arbitrates)

Examples:
  node scripts/gigabrainctl.js sync-hosts --config ~/.gigabrain/config.json --host codex,claude_code
  node scripts/gigabrainctl.js sync-hosts sources --config ~/.gigabrain/config.json --include-discovery
  node scripts/gigabrainctl.js sync-hosts export-brief --config ~/.gigabrain/config.json --target-host claude_code
`;

const commandSyncHosts = async () => {
  const action = ['sources', 'status', 'export-brief'].includes(String(flags[0] || '').trim().toLowerCase())
    ? String(flags[0] || '').trim().toLowerCase()
    : 'sync';
  const syncFlags = action === 'sync' ? flags : flags.slice(1);
  if (syncFlags.includes('--help') || syncFlags.includes('-h')) {
    console.log(SYNC_HOSTS_HELP.trim());
    return;
  }
  const { configPath, config, dbPath } = loadConfigAndDbPath();
  const requestedHostsForSync = parseHostList(syncFlags);
  const manualImportPath = readFlag('--manual-import', '', syncFlags);
  const manualSourceHost = readFlag('--manual-source-host', 'chatgpt_manual', syncFlags);
  const effectiveHosts = requestedHostsForSync.length > 0
    ? requestedHostsForSync
    : (manualImportPath ? [manualSourceHost] : []);
  const commonOptions = {
    config,
    hosts: effectiveHosts,
    codexHome: readFlag('--codex-home', '', syncFlags),
    claudeHome: readFlag('--claude-home', '', syncFlags),
    hermesHome: readFlag('--hermes-home', '', syncFlags),
    workspaceRoot: readFlag('--workspace', '', syncFlags),
  };
  if (action === 'status') {
    if (!fs.existsSync(dbPath)) {
      console.log(JSON.stringify({
        ok: false,
        observational: true,
        configPath,
        dbPath,
        diagnostic: 'registry does not exist',
        hosts: [],
        groups: { ready: [], never_synced: [], manual_only: [], bridge: [] },
      }, null, 2));
      return;
    }
    const readDb = openDatabase(dbPath, { readOnly: true, observational: true });
    try {
      try { readDb.exec('PRAGMA query_only = ON'); } catch { /* connection-local hardening */ }
      const schemaReady = hasTableReadOnly(readDb, 'memory_host_sync_runs');
      console.log(JSON.stringify({
        configPath,
        dbPath,
        observational: true,
        ...getSyncStatus({ db: readDb, ...commonOptions }),
        ...(schemaReady ? {} : { diagnostic: 'memory_host_sync_runs schema is unavailable' }),
      }, null, 2));
    } finally {
      readDb.close();
    }
    return;
  }
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  const common = {
    db,
    ...commonOptions,
  };
  try {
    ensureProjectionStore(db);
    if (action === 'sources') {
      console.log(JSON.stringify({
        configPath,
        dbPath,
        ...listMemorySources({
          ...common,
          includeDiscovery: readBool('--include-discovery', false, syncFlags),
          manualImportPath,
          manualSourceHost,
        }),
      }, null, 2));
      return;
    }
    if (action === 'export-brief') {
      console.log(JSON.stringify({
        configPath,
        dbPath,
        ...exportMemoryBrief({
          db,
          config,
          targetHost: readFlag('--target-host', 'agents', syncFlags),
          scope: readFlag('--scope', '', syncFlags),
          limit: Number(readFlag('--limit', '25', syncFlags) || 25),
          allowAllScopes: readBool('--all-scopes', false, syncFlags),
        }),
      }, null, 2));
      return;
    }
    const result = syncHostMemories({
      ...common,
      scope: readFlag('--scope', '', syncFlags),
      dryRun: readBool('--dry-run', false, syncFlags),
      // Force/debug path: the cursor is NOT consulted (incremental defaults
      // off) so every detected line is re-indexed. Ingest-time arbitration
      // still runs (--no-arbitrate to skip) using the world-model projector.
      arbitrate: !readBool('--no-arbitrate', false, syncFlags),
      projectBeliefRows: projectArbitrationBeliefRows,
      manualImportPath,
      manualSourceHost,
    });
    console.log(JSON.stringify({
      configPath,
      dbPath,
      ...result,
    }, null, 2));
  } finally {
    db.close();
  }
};

const IMPORT_OPENCLAW_HELP = `Gigabrain import-openclaw

Usage:
  node scripts/gigabrainctl.js import-openclaw --registry /path/to/registry.sqlite [flags]

Flags:
  --config <path>       Gigabrain config path
  --db <path>           Target registry SQLite override
  --registry <path>     Legacy OpenClaw/Gigabrain registry.sqlite
  --memory-root <path>  Optional legacy memory folder for reporting/provenance
  --source-host <host>  Source host label, usually openclaw
  --source-label <name> Human label for this import, e.g. remote-host-backup-2026-02-12
  --dry-run             Read and count without writing

Examples:
  node scripts/gigabrainctl.js import-openclaw --config ~/.gigabrain/config.json --registry ~/.openclaw/gigabrain/memory/registry.sqlite --source-label remote-host-backup --dry-run
`;

const commandImportOpenClaw = async () => {
  if (flags.includes('--help') || flags.includes('-h')) {
    console.log(IMPORT_OPENCLAW_HELP.trim());
    return;
  }
  const registryPath = readFlag('--registry', '');
  if (!registryPath) {
    throw new Error('import-openclaw requires --registry /path/to/registry.sqlite');
  }
  const { configPath, dbPath } = loadConfigAndDbPath();
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  try {
    const result = importOpenClawRegistry({
      db,
      registryPath,
      memoryRoot: readFlag('--memory-root', ''),
      sourceHost: readFlag('--source-host', 'openclaw'),
      sourceLabel: readFlag('--source-label', ''),
      dryRun: readBool('--dry-run', false),
    });
    console.log(JSON.stringify({
      configPath,
      dbPath,
      ...result,
    }, null, 2));
  } finally {
    db.close();
  }
};

const PASSPORT_HELP = `Gigabrain Memory Audit + Handoff Records

Usage:
  node scripts/gigabrainctl.js handoff [flags]
  node scripts/gigabrainctl.js passport [flags]   (DEPRECATED alias of handoff)

Generates a static Memory Audit report (source inventory + trust-risk findings)
plus safe Handoff Records you can paste into another agent.

Flags:
  --config <path>       Gigabrain config path
  --db <path>           Registry SQLite path override
  --output-dir <path>   Directory for memory-audit.md/html/json and handoff-records/
  --format <list>       all|markdown|html|json|handoffs (comma-separated)
  --scope <scope>       Limit report and Handoff Record memories to a scope
  --limit <n>           Max rows per audit section
  --handoff-limit <n>   Max memories per generated Handoff Record
  --stale-days <n>      Mark memories stale when not updated within this many days
  --host <list>         Optional host discovery filter, for example codex,claude_code
  --codex-home <path>   Override Codex home containing memories/
  --claude-home <path>  Override Claude home containing projects/
  --workspace <path>    Workspace root for Cursor/Windsurf discovery
  --skip-handoffs       Do not write Handoff Record files

Examples:
  node scripts/gigabrainctl.js handoff --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js handoff --config ~/.gigabrain/config.json --scope profile:user --output-dir ./handoff-record
`;

const HANDOFF_TRANSFER_HELP = `Gigabrain Handoff v2 transfer

Usage:
  node scripts/gigabrainctl.js handoff export --config <path> --out <bundle.json> [--include-events]
  node scripts/gigabrainctl.js handoff inspect --in <bundle.json>
  node scripts/gigabrainctl.js handoff inspect --legacy-v1 --in <legacy.json>
  node scripts/gigabrainctl.js handoff import --config <path> --in <bundle.json>

Legacy v1 bundles are inspect-only. Import requires exact, complete
gigabrain.handoff-bundle/2.0 integrity and never replays carried source events.
The old export-bundle/import-bundle commands remain deprecated aliases.
`;

const commandPassport = async () => {
  const passportFlags = flags;
  if (passportFlags.includes('--help') || passportFlags.includes('-h')) {
    console.log(PASSPORT_HELP.trim());
    return;
  }
  const { configPath, config, dbPath } = loadConfigAndDbPath();
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) materializeProjectionFromMemories(db);
    const outputDir = path.resolve(readFlag(
      '--output-dir',
      path.join(String(config?.runtime?.paths?.outputDir || process.cwd()), 'memory-audit'),
      passportFlags,
    ));
    const requestedHostsForDiscovery = parseHostList(passportFlags);
    const passport = buildMemoryPassport({
      db,
      config,
      scope: readFlag('--scope', '', passportFlags),
      limit: Number(readFlag('--limit', '50', passportFlags) || 50),
      handoffLimit: Number(readFlag('--handoff-limit', '25', passportFlags) || 25),
      staleDays: Number(readFlag('--stale-days', '180', passportFlags) || 180),
      includeDiscovery: !passportFlags.includes('--skip-discovery'),
      hosts: requestedHostsForDiscovery,
      codexHome: readFlag('--codex-home', '', passportFlags),
      claudeHome: readFlag('--claude-home', '', passportFlags),
      workspaceRoot: readFlag('--workspace', '', passportFlags),
    });
    const files = writeMemoryPassport(passport, {
      outputDir,
      formats: readFlag('--format', 'all', passportFlags),
      includeHandoffs: !passportFlags.includes('--skip-handoffs'),
    });
    console.log(JSON.stringify({
      ok: true,
      action: 'memory_audit',
      configPath,
      dbPath,
      outputDir,
      files,
      summary: passport.summary,
      generated_at: passport.generated_at,
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandExportBundle = async () => {
  const { configPath, dbPath } = loadConfigAndDbPath();
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) materializeProjectionFromMemories(db);
    const outPath = path.resolve(readFlag('--out', './memory-bundle.json'));
    const bundle = exportHandoffBundle({
      db,
      scope: readFlag('--scope', ''),
      includeEvents: readBool('--include-events', false),
      pageSize: Number(readFlag('--page-size', '1000') || 1000),
      eventLimitPerMemory: Number(readFlag('--event-limit-per-memory', '2000') || 2000),
    });
    if (bundle.manifest.complete !== true || bundle.manifest.truncated !== false) {
      throw new Error('handoff export reached the source-event evidence cap; no artifact was written');
    }
    ensureDir(path.dirname(outPath));
    atomicWriteFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      ok: true,
      action: 'handoff_export',
      configPath,
      dbPath,
      outPath,
      manifest: bundle.manifest,
    }, null, 2));
  } finally {
    db.close();
  }
};

const readHandoffInput = () => {
  const inFlag = readFlag('--in', '');
  if (!inFlag) throw new Error('handoff requires --in /path/to/handoff-bundle.json');
  const inPath = path.resolve(inFlag);
  return { bundle: JSON.parse(fs.readFileSync(inPath, 'utf8')), inPath };
};

const commandInspectBundle = async () => {
  if (readBool('--skip-integrity-check', false)) {
    throw new Error('handoff integrity checks cannot be bypassed');
  }
  const { bundle, inPath } = readHandoffInput();
  if (readBool('--legacy-v1', false)) {
    console.log(JSON.stringify({ ...inspectLegacyV1Bundle(bundle), in_path: inPath }, null, 2));
    return;
  }
  const validated = validateBundleShape(bundle, { requireComplete: false });
  console.log(JSON.stringify({
    ok: true,
    action: 'handoff_inspect',
    importable: bundle.manifest.complete === true && bundle.manifest.truncated === false,
    inspect_only: false,
    in_path: inPath,
    kind: bundle.kind,
    schema_version: bundle.schema_version,
    root_sha256: validated.root,
    manifest: bundle.manifest,
  }, null, 2));
};

const commandImportBundle = async () => {
  if (readBool('--skip-integrity-check', false)) {
    throw new Error('handoff integrity checks cannot be bypassed');
  }
  if (readBool('--legacy-v1', false)) {
    throw new Error('legacy v1 handoff bundles are inspect-only; use physical database migration');
  }
  const { bundle, inPath } = readHandoffInput();
  // Validate before config resolution or destination-directory creation.
  validateBundleShape(bundle, { requireComplete: true });
  const { configPath, config, dbPath } = loadConfigAndDbPath();
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  try {
    const result = importHandoffBundle({
      db,
      bundle,
      runId: readFlag('--run-id', `handoff-import-${new Date().toISOString()}`),
    });
    // The bundle carries memories only; beliefs/entities are derived state and
    // must be re-projected from the imported rows (see handoff-bundle.js).
    let worldModel = null;
    if (!readBool('--skip-world-rebuild', false)) {
      worldModel = rebuildWorldModel({ db, config });
    }
    console.log(JSON.stringify({
      ok: true,
      action: 'handoff_import',
      configPath,
      dbPath,
      inPath,
      result,
      world_model_rebuilt: Boolean(worldModel?.rebuilt),
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandHandoff = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (['export', 'inspect', 'import'].includes(subcommand)
    && (flags.includes('--help') || flags.includes('-h'))) {
    console.log(HANDOFF_TRANSFER_HELP.trim());
    return;
  }
  if (subcommand === 'export') return commandExportBundle();
  if (subcommand === 'inspect') return commandInspectBundle();
  if (subcommand === 'import') return commandImportBundle();
  return commandPassport();
};

const INIT_HELP = `Gigabrain init

Auto-detect installed coding agents on this machine and wire each one to
Gigabrain in a single, idempotent command. Re-running is safe: existing
config is merged, not overwritten.

Usage:
  node scripts/gigabrainctl.js init [flags]

Flags:
  --project-root <path>   Repo root to wire (default: cwd)
  --config <path>         Standalone Gigabrain config path override
  --store-mode <mode>     Store mode for per-host setup: global (default) or project-local
  --host <list>           Limit to specific hosts, e.g. codex,claude_code
  --codex-home <path>     Override Codex home (for detection)
  --claude-home <path>    Override Claude home (for detection)
  --hermes-home <path>    Override Hermes home (for detection)
  --dry-run               Detect hosts and report without running setup
  --help                  Print this help

Examples:
  node scripts/gigabrainctl.js init
  node scripts/gigabrainctl.js init --project-root /path/to/repo
  node scripts/gigabrainctl.js init --dry-run
`;

// Per-host setup wiring. cursor/windsurf are read-only synced surfaces with no
// standalone setup script, so init reports them as detected (sync-only) rather
// than running a setup script.
const INIT_HOST_SETUP = {
  codex: { script: 'gigabrain-codex-setup.js', mode: 'setup' },
  claude_code: { script: 'gigabrain-claude-setup.js', mode: 'setup' },
  hermes: { script: 'gigabrain-hermes-setup.js', mode: 'setup' },
  cursor: { script: '', mode: 'sync_only' },
  windsurf: { script: '', mode: 'sync_only' },
};

const runHostSetupScript = ({ script, projectRoot, configPath, storeMode } = {}) => {
  const scriptPath = path.join(THIS_DIR, script);
  const scriptArgs = [scriptPath, '--project-root', String(projectRoot)];
  if (configPath) scriptArgs.push('--config', String(configPath));
  if (storeMode) scriptArgs.push('--store-mode', String(storeMode));
  const run = spawnSync(process.execPath, scriptArgs, {
    cwd: THIS_DIR,
    encoding: 'utf8',
    timeout: 180000,
    env: process.env,
  });
  const stdout = String(run.stdout || '').trim();
  const stderr = String(run.stderr || '').trim();
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
  }
  const ok = Number(run.status || 0) === 0 && (!parsed || parsed.ok !== false);
  return {
    ok,
    exitCode: Number(run.status ?? 1),
    configPath: parsed?.configPath || parsed?.standaloneConfigPath || '',
    stderr,
    stdout: parsed ? '' : stdout,
  };
};

const commandInit = async () => {
  if (flags.includes('--help') || flags.includes('-h')) {
    console.log(INIT_HELP.trim());
    return;
  }
  const projectRoot = path.resolve(readFlag('--project-root', process.cwd()));
  const explicitConfig = readFlag('--config', '');
  const storeMode = readFlag('--store-mode', '');
  const dryRun = readBool('--dry-run', false);
  const requestedHosts = parseHostList(flags);
  const requestedSet = requestedHosts.length > 0 ? new Set(requestedHosts) : null;

  // Reuse host discovery from host-memory-sync; resolveHostRoots stamps each
  // candidate root with `available` based on what is actually on disk.
  const roots = resolveHostRoots({
    codexHome: readFlag('--codex-home', ''),
    claudeHome: readFlag('--claude-home', ''),
    hermesHome: readFlag('--hermes-home', ''),
    workspaceRoot: projectRoot,
  });
  const detectedHosts = [...new Set(
    roots
      .filter((row) => row.available && INIT_HOST_SETUP[row.source_host])
      .map((row) => row.source_host),
  )].filter((host) => !requestedSet || requestedSet.has(host));

  const results = [];
  for (const host of detectedHosts) {
    const spec = INIT_HOST_SETUP[host];
    if (spec.mode === 'sync_only') {
      results.push({
        host,
        action: 'sync_only',
        ran: false,
        note: 'Read-only surface; wire memories with: gigabrainctl sync-hosts',
      });
      continue;
    }
    if (dryRun) {
      results.push({ host, action: 'setup', ran: false, reason: 'dry_run' });
      continue;
    }
    const setupResult = runHostSetupScript({
      script: spec.script,
      projectRoot,
      configPath: explicitConfig,
      storeMode,
    });
    results.push({
      host,
      action: 'setup',
      ran: true,
      ok: setupResult.ok,
      configPath: setupResult.configPath,
      ...(setupResult.ok ? {} : { exitCode: setupResult.exitCode, stderr: setupResult.stderr, stdout: setupResult.stdout }),
    });
  }

  const wiredHosts = results.filter((row) => row.action === 'setup' && row.ran && row.ok).map((row) => row.host);
  const failedHosts = results.filter((row) => row.action === 'setup' && row.ran && !row.ok).map((row) => row.host);
  const nextSteps = [];
  if (wiredHosts.length > 0) {
    nextSteps.push('Sync detected host memories: node scripts/gigabrainctl.js sync-hosts --config ~/.gigabrain/config.json');
    nextSteps.push('Generate a Memory Audit + Handoff Records: node scripts/gigabrainctl.js handoff --config ~/.gigabrain/config.json');
  } else if (detectedHosts.length === 0) {
    nextSteps.push('No installed agents detected on disk. Install Codex, Claude Code, or Hermes, then re-run init.');
  }

  console.log(JSON.stringify({
    ok: failedHosts.length === 0,
    command: 'init',
    projectRoot,
    dryRun,
    detectedHosts,
    wiredHosts,
    failedHosts,
    results,
    nextSteps,
  }, null, 2));
};

const main = async () => {
  if (command === 'init') {
    await commandInit();
    return;
  }
  if (command === 'sync-hosts') {
    await commandSyncHosts();
    return;
  }
  if (command === 'import-openclaw') {
    await commandImportOpenClaw();
    return;
  }
  if (command === 'handoff') {
    await commandHandoff();
    return;
  }
  if (command === 'passport') {
    // Deprecated alias of `handoff`. Note goes to stderr so JSON stdout stays clean.
    console.error('[gigabrain] note: `passport` is deprecated; use `handoff` (the Handoff Record verb). This alias still works.');
    await commandPassport();
    return;
  }
  if (command === 'export-bundle') {
    await commandExportBundle();
    return;
  }
  if (command === 'import-bundle') {
    await commandImportBundle();
    return;
  }
  if (['', 'help', '--help', '-h'].includes(command) || wantsHelp) {
    console.log(HELP.trim());
    return;
  }
  if (command === 'maintain') {
    await commandMaintain();
    return;
  }
  if (command === 'audit') {
    await commandAudit();
    return;
  }
  if (command === 'watch') {
    await commandWatch();
    return;
  }
  if (command === 'nightly') {
    await commandNightly();
    return;
  }
  if (command === 'snapshot') {
    await commandSnapshot();
    return;
  }
  if (command === 'inventory') {
    await commandInventory();
    return;
  }
  if (command === 'doctor') {
    await commandDoctor();
    return;
  }
  if (command === 'world') {
    await commandWorld();
    return;
  }
  if (command === 'control') {
    await commandControl();
    return;
  }
  if (command === 'orchestrator') {
    await commandOrchestrator();
    return;
  }
  if (command === 'synthesis') {
    await commandSynthesis();
    return;
  }
  if (command === 'briefing') {
    await commandBriefing();
    return;
  }
  if (command === 'review') {
    await commandReview();
    return;
  }
  if (command === 'surface') {
    await commandSurface();
    return;
  }
  if (command === 'migrate') {
    await commandMigrate();
    return;
  }
  if (command === 'vault') {
    await commandVault();
    return;
  }
  if (command === 'transcript') {
    await commandTranscript();
    return;
  }
  if (command === 'wiki') {
    await commandWiki();
    return;
  }
  throw new Error(`Unknown command: ${command || '(none)'}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

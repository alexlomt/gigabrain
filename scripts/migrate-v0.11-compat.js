#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { loadResolvedConfig } from '../lib/core/config.js';
import { hashNormalized, normalizeContent } from '../lib/core/policy.js';
import {
  auditRegistryPair,
  inspectMigrationState,
  createConsistentBackup,
  validateConsistentBackup,
} from '../lib/compat/migration-audit.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const DEFAULT_MANIFEST = path.join(repoRoot, 'config', 'migration', 'gigabrain-schema-0.11-compat-v1.json');
const SCHEMA_ID = 'gigabrain-schema-0.11-compat-v1';
const SIDECAR_MIGRATION_ID = `${SCHEMA_ID}:memory-console-metadata-backfill`;
const SIDECAR_RECEIPT_CONTRACT = 'gigabrain-memory-console-metadata-receipt-v1';
const SIDECAR_SCHEMA_CONTRACT = 'gigabrain-memory-console-metadata-schema-v1';
const SIDECAR_ROOT_CONTRACT = 'gigabrain-memory-console-metadata-logical-root-v1';
const FULL_RECEIPT_CONTRACT = 'gigabrain-full-migration-receipt-v1';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const binaryCompare = (left, right) => Buffer.compare(
  Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'),
);
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object' && !Buffer.isBuffer(value)
    ? Object.fromEntries(Object.keys(value).sort(binaryCompare).map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

const noProc = (filePath) => {
  const value = String(filePath || '');
  return value.startsWith('/proc/') || value.includes('/proc/self/fd');
};
const assertNoSymlinkAncestors = (targetPath, { includeLeaf = true } = {}) => {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const limit = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    const part = parts[index];
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('GIGABRAIN_MIGRATION_SYMLINK_ANCESTOR');
  }
};

const assertSafeCandidateDatabase = ({
  candidatePath,
  liveDbPath,
  runDir,
  operatorUid = process.getuid?.(),
  targetDevice = null,
} = {}) => {
  if (noProc(candidatePath) || noProc(runDir)) throw new Error('GIGABRAIN_MIGRATION_PROC_DESCRIPTOR_ALIAS');
  assertNoSymlinkAncestors(runDir);
  assertNoSymlinkAncestors(candidatePath);
  const runStat = fs.lstatSync(runDir);
  const candidateStat = fs.lstatSync(candidatePath);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error('GIGABRAIN_MIGRATION_RUN_DIR_INVALID');
  if ((runStat.mode & 0o777) !== 0o700) throw new Error('GIGABRAIN_MIGRATION_RUN_DIR_MODE_PERMISSION');
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) throw new Error('GIGABRAIN_MIGRATION_CANDIDATE_INVALID');
  if ((candidateStat.mode & 0o777) !== 0o600) throw new Error('GIGABRAIN_MIGRATION_CANDIDATE_MODE_PERMISSION');
  if (candidateStat.nlink !== 1) throw new Error('GIGABRAIN_MIGRATION_CANDIDATE_NLINK');
  if (operatorUid !== undefined && (runStat.uid !== operatorUid || candidateStat.uid !== operatorUid)) {
    throw new Error('GIGABRAIN_MIGRATION_CANDIDATE_OWNER_UID');
  }
  const relative = path.relative(path.resolve(runDir), path.resolve(candidatePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('GIGABRAIN_MIGRATION_CANDIDATE_CONTAINMENT');
  const target = targetDevice ?? runStat.dev;
  if (Number(runStat.dev) !== Number(target) || Number(candidateStat.dev) !== Number(target)) {
    throw new Error('GIGABRAIN_MIGRATION_CANDIDATE_FILESYSTEM_DEVICE');
  }
  if (liveDbPath) {
    if (noProc(liveDbPath)) throw new Error('GIGABRAIN_MIGRATION_LIVE_PROC_DESCRIPTOR');
    assertNoSymlinkAncestors(liveDbPath);
    const liveStat = fs.statSync(liveDbPath);
    if (liveStat.dev === candidateStat.dev && liveStat.ino === candidateStat.ino) {
      throw new Error('GIGABRAIN_MIGRATION_CANDIDATE_LIVE_IDENTITY_ALIAS');
    }
  }
  return Object.freeze({
    candidateIdentity: { dev: String(candidateStat.dev), ino: String(candidateStat.ino) },
    runIdentity: { dev: String(runStat.dev), ino: String(runStat.ino) },
  });
};

const readCanonicalJson = (filePath, label) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`GIGABRAIN_MIGRATION_${label}_JSON`); }
  if (raw !== canonicalJson(value)) throw new Error(`GIGABRAIN_MIGRATION_${label}_NONCANONICAL`);
  return value;
};

const loadManifest = (filePath = DEFAULT_MANIFEST) => {
  const manifest = readCanonicalJson(filePath, 'MANIFEST');
  if (JSON.stringify(Object.keys(manifest)) !== JSON.stringify(['columns', 'manifestSha256', 'objects', 'schemaId', 'schemaVersion'])) {
    throw new Error('GIGABRAIN_MIGRATION_MANIFEST_SHAPE');
  }
  const payload = { ...manifest };
  delete payload.manifestSha256;
  if (manifest.schemaId !== SCHEMA_ID || manifest.schemaVersion !== 1 || manifest.manifestSha256 !== sha256(canonicalJson(payload))) {
    throw new Error('GIGABRAIN_MIGRATION_MANIFEST_IDENTITY');
  }
  if (!Array.isArray(manifest.objects) || !Array.isArray(manifest.columns)) throw new Error('GIGABRAIN_MIGRATION_MANIFEST_SHAPE');
  const objectNames = manifest.objects.map((row) => row.name);
  const columnNames = manifest.columns.map((row) => `${row.table}.${row.name}`);
  if (new Set(objectNames).size !== objectNames.length || new Set(columnNames).size !== columnNames.length) {
    throw new Error('GIGABRAIN_MIGRATION_MANIFEST_DUPLICATE');
  }
  if (objectNames.some((name, index) => index > 0 && binaryCompare(objectNames[index - 1], name) > 0)) {
    throw new Error('GIGABRAIN_MIGRATION_MANIFEST_ORDER');
  }
  for (const object of manifest.objects) {
    if (object.sqlSha256 !== sha256(String(object.sql || ''))) throw new Error(`GIGABRAIN_MIGRATION_MANIFEST_SQL_HASH ${object.name}`);
  }
  return manifest;
};

const loadRelease = (releasePath, manifest) => {
  const release = readCanonicalJson(releasePath, 'RELEASE');
  if (!/^[0-9a-f]{40}$/.test(String(release.code_sha || ''))) throw new Error('GIGABRAIN_MIGRATION_RELEASE_CODE_SHA');
  if (release.schema_id !== SCHEMA_ID || release.schema_checksum !== manifest.manifestSha256) {
    throw new Error('GIGABRAIN_MIGRATION_RELEASE_SCHEMA');
  }
  return release;
};

const objectRow = (db, name) => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name=?').get(name) || null;
const validateObject = (db, object) => {
  const row = objectRow(db, object.name);
  if (!row || String(row.type) !== object.type || sha256(String(row.sql || '')) !== object.sqlSha256) {
    throw new Error(`GIGABRAIN_MIGRATION_EXISTING_SCHEMA_OBJECT_HASH ${object.name}`);
  }
  return row;
};
const hasColumn = (db, table, name) => db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all()
  .some((row) => String(row.name) === name);
const validateColumn = (db, row) => {
  const column = db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(row.table)})`).all()
    .find((item) => String(item.name) === row.name);
  if (!column) throw new Error(`GIGABRAIN_MIGRATION_EXISTING_COLUMN_MISSING ${row.table}.${row.name}`);
  const expected = {
    type: 'TEXT',
    notnull: row.name === 'origin_kind' ? 1 : 0,
    dflt: row.name === 'origin_kind' ? "'legacy_unclassified'" : null,
  };
  const actualDefault = column.dflt_value === null || column.dflt_value === undefined ? null : String(column.dflt_value);
  if (String(column.type || '') !== expected.type || Number(column.notnull) !== expected.notnull || actualDefault !== expected.dflt) {
    throw new Error(`GIGABRAIN_MIGRATION_EXISTING_COLUMN_DEFINITION ${row.table}.${row.name}`);
  }
};

const task14SchemaEvidence = (db) => {
  const select = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  const evidence = {
    contract: SIDECAR_SCHEMA_CONTRACT,
    table: {
      name: 'memory_console_metadata',
      sql: String(select.get('table', 'memory_console_metadata')?.sql || ''),
      columns: db.prepare('PRAGMA table_info(memory_console_metadata)').all().map((row) => ({
        cid: Number(row.cid), name: String(row.name || ''), type: String(row.type || ''),
        notnull: Number(row.notnull),
        dflt_value: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
        pk: Number(row.pk),
      })),
    },
    index: {
      name: 'idx_memory_console_metadata_concept_pinned',
      sql: String(select.get('index', 'idx_memory_console_metadata_concept_pinned')?.sql || ''),
      columns: db.prepare('PRAGMA index_info(idx_memory_console_metadata_concept_pinned)').all().map((row) => ({
        seqno: Number(row.seqno), cid: Number(row.cid), name: String(row.name || ''),
      })),
    },
  };
  return { evidence, hash: sha256(JSON.stringify(evidence)) };
};

const metadataEvidence = (db) => {
  const normalize = (row) => ({
    memory_id: String(row.memory_id || ''),
    concept: row.concept === null || row.concept === undefined ? null : String(row.concept),
    source_message_id: row.source_message_id === null || row.source_message_id === undefined ? null : String(row.source_message_id),
    last_injected_at: row.last_injected_at === null || row.last_injected_at === undefined ? null : String(row.last_injected_at),
    last_confirmed_at: row.last_confirmed_at === null || row.last_confirmed_at === undefined ? null : String(row.last_confirmed_at),
    ttl_days: row.ttl_days === null || row.ttl_days === undefined ? null : Number(row.ttl_days),
    pinned: Number(row.pinned || 0),
    review_version: row.review_version === null || row.review_version === undefined ? null : String(row.review_version),
    review_reason: row.review_reason === null || row.review_reason === undefined ? null : String(row.review_reason),
  });
  const legacy = db.prepare(`SELECT id AS memory_id,concept,source_message_id,last_injected_at,last_confirmed_at,ttl_days,pinned,review_version,review_reason FROM memories ORDER BY id COLLATE BINARY`).all().map(normalize);
  const sidecar = db.prepare(`SELECT memory_id,concept,source_message_id,last_injected_at,last_confirmed_at,ttl_days,pinned,review_version,review_reason FROM memory_console_metadata ORDER BY memory_id COLLATE BINARY`).all().map(normalize);
  const root = (rows) => sha256(JSON.stringify({ contract: SIDECAR_ROOT_CONTRACT, rows }));
  return {
    counts: { legacy_metadata_rows: legacy.length, sidecar_metadata_rows: sidecar.length },
    roots: { legacy_sha256: root(legacy), sidecar_sha256: root(sidecar) },
  };
};

const buildLedgerReceipt = (db) => {
  const metadata = metadataEvidence(db);
  return {
    contract: SIDECAR_RECEIPT_CONTRACT,
    migration_id: SIDECAR_MIGRATION_ID,
    status: 'completed',
    schema_hash: task14SchemaEvidence(db).hash,
    counts: metadata.counts,
    metadata_roots: metadata.roots,
  };
};

const sealReceipt = (body) => ({ ...body, receipt_sha256: sha256(canonicalJson(body)) });
const safeUnlink = (filePath) => {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* bounded rollback */ }
};
const assertReceiptTarget = (receiptPath, runDir, { existing = false } = {}) => {
  const resolvedRun = path.resolve(runDir);
  const resolvedReceipt = path.resolve(receiptPath);
  const relative = path.relative(resolvedRun, resolvedReceipt);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('GIGABRAIN_MIGRATION_RECEIPT_OUTSIDE_RUN_DIR');
  }
  const runStat = fs.lstatSync(resolvedRun);
  if (!runStat.isDirectory() || runStat.isSymbolicLink() || (runStat.mode & 0o777) !== 0o700) {
    throw new Error('GIGABRAIN_MIGRATION_RECEIPT_RUN_DIR');
  }
  assertNoSymlinkAncestors(resolvedRun);
  assertNoSymlinkAncestors(resolvedReceipt, { includeLeaf: existing });
  if (!existing && fs.existsSync(resolvedReceipt)) throw new Error('GIGABRAIN_MIGRATION_RECEIPT_EXISTS');
  return { receiptPath: resolvedReceipt, runDir: resolvedRun };
};

const fsyncFile = (filePath) => {
  const fd = fs.openSync(filePath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const fsyncDir = (directory) => {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

const publishReceipt = (receiptPath, receipt, faultInjector = null, runDir = path.dirname(receiptPath)) => {
  const safe = assertReceiptTarget(receiptPath, runDir);
  const temp = `${receiptPath}.tmp-${process.pid}`;
  safeUnlink(temp);
  assertReceiptTarget(temp, runDir);
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(temp, flags, 0o600);
    try {
      fs.writeFileSync(fd, canonicalJson(receipt));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    faultInjector?.('after_receipt_temp');
    faultInjector?.('before_receipt_publish');
    if (fs.existsSync(safe.receiptPath)) throw new Error('GIGABRAIN_MIGRATION_RECEIPT_EXISTS');
    fs.renameSync(temp, safe.receiptPath);
    fsyncFile(safe.receiptPath);
    fsyncDir(safe.runDir);
    const readback = readCanonicalJson(safe.receiptPath, 'RECEIPT');
    if (canonicalJson(readback) !== canonicalJson(receipt)) throw new Error('GIGABRAIN_MIGRATION_RECEIPT_READBACK');
    faultInjector?.('after_receipt_publish');
  } catch (error) {
    safeUnlink(temp);
    throw error;
  }
};

const readReceiptIfValid = (receiptPath, runDir = path.dirname(receiptPath)) => {
  if (!fs.existsSync(receiptPath)) return null;
  assertReceiptTarget(receiptPath, runDir, { existing: true });
  const stat = fs.lstatSync(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
    throw new Error('GIGABRAIN_MIGRATION_RECEIPT_PROTECTION');
  }
  const receipt = readCanonicalJson(receiptPath, 'RECEIPT');
  const body = { ...receipt };
  delete body.receipt_sha256;
  if (receipt.receipt_sha256 !== sha256(canonicalJson(body))) throw new Error('GIGABRAIN_MIGRATION_RECEIPT_HASH');
  return receipt;
};

const deterministicPaths = (runDir) => ({
  backupPath: path.join(runDir, 'pre-migration.sqlite'),
  backupReceiptPath: path.join(runDir, 'pre-migration.receipt.json'),
});

const buildFullReceipt = ({ dbPath, manifest, release, backupPath, ledgerRow }) => {
  const stat = fs.lstatSync(dbPath);
  return sealReceipt({
    backup: { path: path.resolve(backupPath), sha256: sha256(fs.readFileSync(backupPath)) },
    code_sha: release.code_sha,
    contract: FULL_RECEIPT_CONTRACT,
    database_identity: { dev: String(stat.dev), ino: String(stat.ino) },
    ledger: {
      migration_id: String(ledgerRow.migration_id),
      receipt_hash: String(ledgerRow.receipt_hash),
      schema_hash: String(ledgerRow.schema_hash),
    },
    schema_checksum: manifest.manifestSha256,
    schema_id: SCHEMA_ID,
    status: 'completed',
  });
};

const getLedgerRow = (db) => {
  const table = objectRow(db, 'memory_schema_migrations');
  if (!table) return null;
  return db.prepare(`SELECT migration_id,status,receipt_hash,schema_hash,receipt_json FROM memory_schema_migrations WHERE migration_id=?`).get(SIDECAR_MIGRATION_ID) || null;
};

const validateCompletedLedger = (db, row) => {
  if (!row || row.status !== 'completed' || row.migration_id !== SIDECAR_MIGRATION_ID) throw new Error('GIGABRAIN_MIGRATION_LEDGER_INCOMPLETE');
  if (sha256(String(row.receipt_json)) !== row.receipt_hash) throw new Error('GIGABRAIN_MIGRATION_LEDGER_RECEIPT_HASH');
  const expected = buildLedgerReceipt(db);
  if (String(row.receipt_json) !== JSON.stringify(expected) || row.schema_hash !== expected.schema_hash) {
    throw new Error('GIGABRAIN_MIGRATION_LEDGER_RECEIPT_CONTRACT');
  }
};

const applyManifestSchema = ({ db, manifest, faultInjector }) => {
  const tableObjects = manifest.objects.filter((row) => row.type === 'table');
  const indexObjects = manifest.objects.filter((row) => row.type === 'index');
  const triggerObjects = manifest.objects.filter((row) => row.type === 'trigger');
  for (const object of tableObjects) {
    const existing = objectRow(db, object.name);
    if (existing) {
      validateObject(db, object);
      continue;
    }
    if (object.disposition !== 'additive') throw new Error(`GIGABRAIN_MIGRATION_REQUIRED_EXISTING_OBJECT ${object.name}`);
    db.exec(object.sql);
    validateObject(db, object);
  }
  for (const column of manifest.columns) {
    const exists = hasColumn(db, column.table, column.name);
    if (!exists) {
      if (!column.disposition.startsWith('additive')) {
        throw new Error(`GIGABRAIN_MIGRATION_REQUIRED_EXISTING_COLUMN ${column.table}.${column.name}`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.name)) {
        throw new Error('GIGABRAIN_MIGRATION_MANIFEST_IDENTIFIER');
      }
      db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.definition}`);
    }
    validateColumn(db, column);
  }
  for (const object of [...indexObjects, ...triggerObjects]) {
    const existing = objectRow(db, object.name);
    if (existing) {
      validateObject(db, object);
      continue;
    }
    if (object.disposition !== 'additive') throw new Error(`GIGABRAIN_MIGRATION_REQUIRED_EXISTING_OBJECT ${object.name}`);
    db.exec(object.sql);
    validateObject(db, object);
  }
  faultInjector?.('after_schema');
  db.exec(`UPDATE memory_current SET valid_from=created_at WHERE valid_from IS NULL AND created_at IS NOT NULL`);
  faultInjector?.('after_valid_from');
  db.exec(`
    INSERT INTO memory_console_metadata (
      memory_id,concept,source_message_id,last_injected_at,last_confirmed_at,ttl_days,pinned,review_version,review_reason
    )
    SELECT id,concept,source_message_id,last_injected_at,last_confirmed_at,ttl_days,COALESCE(pinned,0),review_version,review_reason
    FROM memories
    WHERE 1
    ON CONFLICT(memory_id) DO UPDATE SET
      concept=excluded.concept,
      source_message_id=excluded.source_message_id,
      last_injected_at=excluded.last_injected_at,
      last_confirmed_at=excluded.last_confirmed_at,
      ttl_days=excluded.ttl_days,
      pinned=excluded.pinned,
      review_version=excluded.review_version,
      review_reason=excluded.review_reason
  `);
  faultInjector?.('after_sidecar');
  const metadata = metadataEvidence(db);
  if (
    metadata.counts.legacy_metadata_rows !== metadata.counts.sidecar_metadata_rows
    || metadata.roots.legacy_sha256 !== metadata.roots.sidecar_sha256
  ) throw new Error('GIGABRAIN_MIGRATION_SIDECAR_PARITY');
  for (const object of manifest.objects) validateObject(db, object);
  for (const column of manifest.columns) validateColumn(db, column);
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new Error('GIGABRAIN_MIGRATION_INTEGRITY');
  }
  faultInjector?.('before_ledger');
  const receipt = buildLedgerReceipt(db);
  const receiptJson = JSON.stringify(receipt);
  db.prepare(`INSERT INTO memory_schema_migrations(migration_id,status,receipt_hash,schema_hash,receipt_json) VALUES(?,?,?,?,?)`).run(
    SIDECAR_MIGRATION_ID,
    'completed',
    sha256(receiptJson),
    receipt.schema_hash,
    receiptJson,
  );
  faultInjector?.('after_ledger');
};

const migrateCandidateDatabase = ({
  dbPath,
  liveDbPath,
  runDir,
  releasePath,
  receiptPath,
  manifestPath = DEFAULT_MANIFEST,
  operatorUid = process.getuid?.(),
  targetDevice = null,
  faultInjector = null,
} = {}) => {
  const safety = assertSafeCandidateDatabase({ candidatePath: dbPath, liveDbPath, runDir, operatorUid, targetDevice });
  const manifest = loadManifest(manifestPath);
  const release = loadRelease(releasePath, manifest);
  const paths = deterministicPaths(runDir);
  const backupExists = fs.existsSync(paths.backupPath);
  const backupReceiptExists = fs.existsSync(paths.backupReceiptPath);
  if (backupExists !== backupReceiptExists) throw new Error('GIGABRAIN_MIGRATION_BACKUP_ARTIFACT_SET_INCOMPLETE');
  const readOnly = new DatabaseSync(dbPath, { readOnly: true });
  let existingLedger;
  try { existingLedger = getLedgerRow(readOnly); } finally { readOnly.close(); }
  if (backupExists) {
    validateConsistentBackup({
      sourcePath: dbPath,
      backupPath: paths.backupPath,
      receiptPath: paths.backupReceiptPath,
      runDir,
      operatorUid,
      requireSourceLogicalMatch: !existingLedger,
    });
  }
  if (existingLedger) {
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    try {
      validateCompletedLedger(verify, existingLedger);
      for (const object of manifest.objects) validateObject(verify, object);
      for (const column of manifest.columns) validateColumn(verify, column);
    } finally { verify.close(); }
    let existingReceipt = readReceiptIfValid(receiptPath, runDir);
    const recovered = true;
    if (!existingReceipt) {
      validateConsistentBackup({
        sourcePath: dbPath,
        backupPath: paths.backupPath,
        receiptPath: paths.backupReceiptPath,
        runDir,
        operatorUid,
        requireSourceLogicalMatch: false,
      });
      existingReceipt = buildFullReceipt({ dbPath, manifest, release, backupPath: paths.backupPath, ledgerRow: existingLedger });
      publishReceipt(receiptPath, existingReceipt, faultInjector, runDir);
    }
    return { ...existingReceipt, changed: false, idempotent: true, recovered, ok: true };
  }

  let backupCreated = false;
  let committed = false;
  try {
    if (!backupExists) {
      createConsistentBackup({
        sourcePath: dbPath,
        backupPath: paths.backupPath,
        receiptPath: paths.backupReceiptPath,
        runDir,
        operatorUid,
        targetDevice: targetDevice ?? fs.statSync(runDir).dev,
      });
      backupCreated = true;
    }
    faultInjector?.('after_backup');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      try {
        applyManifestSchema({ db, manifest, faultInjector });
        db.exec('COMMIT');
        committed = true;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* original error */ }
        throw error;
      }
    } finally { db.close(); }
    faultInjector?.('after_commit_before_receipt');
    const receiptDb = new DatabaseSync(dbPath, { readOnly: true });
    let ledgerRow;
    try { ledgerRow = getLedgerRow(receiptDb); validateCompletedLedger(receiptDb, ledgerRow); } finally { receiptDb.close(); }
    const receipt = buildFullReceipt({ dbPath, manifest, release, backupPath: paths.backupPath, ledgerRow });
    publishReceipt(receiptPath, receipt, faultInjector, runDir);
    return { ...receipt, changed: true, idempotent: false, recovered: false, ok: true, ...safety };
  } catch (error) {
    if (!committed && backupCreated) {
      safeUnlink(paths.backupPath);
      safeUnlink(paths.backupReceiptPath);
    }
    throw error;
  }
};

const eventColumns = (db) => db.prepare('PRAGMA table_xinfo(memory_events)').all().map((row) => String(row.name));
const stableEventId = (mode, memoryId) => `migration_${sha256(`${mode}\0${memoryId}`).slice(0, 32)}`;
const insertMigrationEvent = (db, { action, memoryId, beforeRoot, mode }) => {
  const eventId = stableEventId(mode, memoryId);
  db.prepare(`
    INSERT INTO memory_events(
      event_id,timestamp,component,action,reason_codes,memory_id,cleanup_version,
      run_id,review_version,similarity,matched_memory_id,payload,agent_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    eventId,
    '2000-01-01T00:00:00.000Z',
    'migration',
    action,
    '["task14_reconcile"]',
    `sha256:${sha256(memoryId)}`,
    'v0.11-compat',
    `task14-${mode}`,
    'task14',
    0,
    `sha256:${sha256(`matched:${memoryId}`)}`,
    JSON.stringify({ before_root: beforeRoot, mode, operation_id: sha256(`${mode}\0${beforeRoot}`) }),
    'migration',
  );
};

const reconciliationReceipt = ({ mode, beforeRoot, corrected, columns, tables, eventAction }) => sealReceipt({
  allowed_deltas: { columns: [...columns].sort(binaryCompare), event_action: eventAction, tables: [...tables].sort(binaryCompare) },
  before_root: beforeRoot,
  contract: 'gigabrain-reconcile-receipt-v1',
  corrected,
  event_count: corrected,
  mode,
  status: 'completed',
});

const recoverReconciliation = ({ db, mode, eventAction, receiptPath, runDir, faultInjector }) => {
  const rows = db.prepare('SELECT payload FROM memory_events WHERE action=? ORDER BY event_id COLLATE BINARY').all(eventAction);
  if (rows.length === 0) return null;
  const payloads = rows.map((row) => JSON.parse(String(row.payload || '{}')));
  const beforeRoot = String(payloads[0]?.before_root || '');
  if (!/^[0-9a-f]{64}$/.test(beforeRoot) || payloads.some((row) => row.before_root !== beforeRoot || row.mode !== mode)) {
    throw new Error('GIGABRAIN_MIGRATION_RECONCILE_RECOVERY');
  }
  const events = eventColumns(db).map((name) => `memory_events.${name}`);
  const projection = mode === 'legacy_projection';
  const receipt = reconciliationReceipt({
    mode,
    beforeRoot,
    corrected: rows.length,
    eventAction,
    columns: projection
      ? ['memories.scope', 'memories.updated_at', ...events]
      : ['memories.normalized', 'memory_current.normalized', 'memory_current.normalized_hash', ...events],
    tables: projection ? ['memories', 'memory_events'] : ['memories', 'memory_current', 'memory_events'],
  });
  const existing = readReceiptIfValid(receiptPath, runDir);
  if (existing) return { ...existing, corrected: 0, recovered: false, ok: true };
  publishReceipt(receiptPath, receipt, faultInjector, runDir);
  return { ...receipt, corrected: 0, recovered: true, ok: true };
};

const reconcileLegacyProjection = ({
  dbPath, liveDbPath, receiptPath, runDir, operatorUid = process.getuid?.(), targetDevice = null, faultInjector = null,
} = {}) => {
  assertSafeCandidateDatabase({ candidatePath: dbPath, liveDbPath, runDir, operatorUid, targetDevice });
  const readonly = new DatabaseSync(dbPath, { readOnly: true });
  let mismatches;
  try {
    mismatches = readonly.prepare(`
      SELECT c.memory_id,c.scope,c.updated_at FROM memory_current c
      JOIN memories l ON l.id=c.memory_id
      WHERE l.scope IS NOT c.scope OR l.updated_at IS NOT c.updated_at
      ORDER BY c.memory_id COLLATE BINARY
    `).all();
    if (mismatches.length === 0) {
      const recovered = recoverReconciliation({
        db: readonly, mode: 'legacy_projection', eventAction: 'migration_reconcile_legacy_projection',
        receiptPath, runDir, faultInjector,
      });
      return recovered || { corrected: 0, recovered: false, ok: true };
    }
  } finally { readonly.close(); }
  const before = inspectMigrationState({ dbPath });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const update = db.prepare('UPDATE memories SET scope=?,updated_at=? WHERE id=?');
      for (const row of mismatches) {
        update.run(row.scope, row.updated_at, row.memory_id);
        faultInjector?.('after_legacy');
        insertMigrationEvent(db, {
          action: 'migration_reconcile_legacy_projection', memoryId: row.memory_id,
          beforeRoot: before.root, mode: 'legacy_projection',
        });
        faultInjector?.('after_event');
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* original error */ }
      throw error;
    }
  } finally { db.close(); }
  faultInjector?.('after_commit_before_receipt');
  const eventDb = new DatabaseSync(dbPath, { readOnly: true });
  let columns;
  try {
    columns = ['memories.scope', 'memories.updated_at', ...eventColumns(eventDb).map((name) => `memory_events.${name}`)];
  } finally {
    eventDb.close();
  }
  const receipt = reconciliationReceipt({
    mode: 'legacy_projection', beforeRoot: before.root, corrected: mismatches.length,
    columns, tables: ['memories', 'memory_events'], eventAction: 'migration_reconcile_legacy_projection',
  });
  publishReceipt(receiptPath, receipt, faultInjector, runDir);
  return { ...receipt, recovered: false, ok: true };
};

const reconcileNormalizedHashes = ({
  dbPath, liveDbPath, receiptPath, runDir, operatorUid = process.getuid?.(), targetDevice = null, faultInjector = null,
} = {}) => {
  assertSafeCandidateDatabase({ candidatePath: dbPath, liveDbPath, runDir, operatorUid, targetDevice });
  const readonly = new DatabaseSync(dbPath, { readOnly: true });
  let mismatches;
  try {
    mismatches = readonly.prepare(`SELECT memory_id,content,normalized,normalized_hash FROM memory_current ORDER BY memory_id COLLATE BINARY`).all()
      .map((row) => ({ ...row, expectedNormalized: normalizeContent(row.content), expectedHash: hashNormalized(row.content) }))
      .filter((row) => row.normalized !== row.expectedNormalized || row.normalized_hash !== row.expectedHash);
    if (mismatches.length === 0) {
      const recovered = recoverReconciliation({
        db: readonly, mode: 'normalized_hashes', eventAction: 'migration_reconcile_normalized_hash',
        receiptPath, runDir, faultInjector,
      });
      return recovered || { corrected: 0, recovered: false, ok: true };
    }
  } finally { readonly.close(); }
  const before = inspectMigrationState({ dbPath });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateCurrent = db.prepare('UPDATE memory_current SET normalized=?,normalized_hash=? WHERE memory_id=?');
      const updateLegacy = db.prepare('UPDATE memories SET normalized=? WHERE id=?');
      for (const row of mismatches) {
        updateCurrent.run(row.expectedNormalized, row.expectedHash, row.memory_id);
        faultInjector?.('after_current');
        updateLegacy.run(row.expectedNormalized, row.memory_id);
        faultInjector?.('after_legacy');
        insertMigrationEvent(db, {
          action: 'migration_reconcile_normalized_hash', memoryId: row.memory_id,
          beforeRoot: before.root, mode: 'normalized_hashes',
        });
        faultInjector?.('after_event');
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* original error */ }
      throw error;
    }
  } finally { db.close(); }
  faultInjector?.('after_commit_before_receipt');
  const eventDb = new DatabaseSync(dbPath, { readOnly: true });
  let events;
  try { events = eventColumns(eventDb).map((name) => `memory_events.${name}`); } finally { eventDb.close(); }
  const receipt = reconciliationReceipt({
    mode: 'normalized_hashes', beforeRoot: before.root, corrected: mismatches.length,
    columns: ['memories.normalized', 'memory_current.normalized', 'memory_current.normalized_hash', ...events],
    tables: ['memories', 'memory_current', 'memory_events'], eventAction: 'migration_reconcile_normalized_hash',
  });
  publishReceipt(receiptPath, receipt, faultInjector, runDir);
  return { ...receipt, recovered: false, ok: true };
};

const readFlag = (args, name, fallback = '') => {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !String(args[index + 1]).startsWith('--')) return args[index + 1];
  const equal = args.find((value) => String(value).startsWith(`${name}=`));
  return equal ? equal.slice(name.length + 1) : fallback;
};
const resolveLiveDb = (configPath) => loadResolvedConfig({ configPath }).config.runtime.paths.registryPath;

const runCli = (args = process.argv.slice(2)) => {
  if (args.includes('--apply-production')) throw new Error('GIGABRAIN_MIGRATION_PRODUCTION_APPLY_UNSUPPORTED');
  if (args.includes('--audit')) {
    return auditRegistryPair({ beforePath: readFlag(args, '--before'), afterPath: readFlag(args, '--after') });
  }
  const dbPath = path.resolve(readFlag(args, '--db'));
  const configPath = path.resolve(readFlag(args, '--config'));
  const runDir = path.resolve(readFlag(args, '--run-dir'));
  const releasePath = path.resolve(readFlag(args, '--release'));
  const receiptPath = path.resolve(readFlag(args, '--receipt'));
  const liveDbPath = path.resolve(resolveLiveDb(configPath));
  assertSafeCandidateDatabase({ candidatePath: dbPath, liveDbPath, runDir });
  if (args.includes('--schema-only')) {
    return migrateCandidateDatabase({ dbPath, liveDbPath, runDir, releasePath, receiptPath });
  }
  if (args.includes('--reconcile-legacy-projection')) {
    return reconcileLegacyProjection({ dbPath, liveDbPath, receiptPath, runDir });
  }
  if (args.includes('--reconcile-normalized-hashes')) {
    return reconcileNormalizedHashes({ dbPath, liveDbPath, receiptPath, runDir });
  }
  throw new Error('GIGABRAIN_MIGRATION_USAGE');
};

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

export {
  assertSafeCandidateDatabase,
  migrateCandidateDatabase,
  reconcileLegacyProjection,
  reconcileNormalizedHashes,
  runCli,
};

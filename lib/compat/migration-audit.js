import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const binaryCompare = (left, right) => Buffer.compare(
  Buffer.from(String(left), 'utf8'),
  Buffer.from(String(right), 'utf8'),
);
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object' && !Buffer.isBuffer(value)
    ? Object.fromEntries(Object.keys(value).sort(binaryCompare).map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

const typedValue = (storageType, value) => {
  if (storageType === 'null') return ['null'];
  if (storageType === 'blob') return ['blob', Buffer.from(value).toString('hex')];
  return [String(storageType), String(value)];
};

const assertNoProcPath = (filePath, label) => {
  if (String(filePath || '').startsWith('/proc/') || String(filePath || '').includes('/proc/self/fd')) {
    throw new Error(`GIGABRAIN_MIGRATION_${label.toUpperCase()}_PROC_DESCRIPTOR`);
  }
};

const assertNoSymlinkAncestors = (targetPath, { includeLeaf = true } = {}) => {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const limit = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, parts[index]);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('GIGABRAIN_MIGRATION_SYMLINK_ANCESTOR');
  }
};

const assertContained = (targetPath, runDir, label) => {
  const resolvedRun = path.resolve(runDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRun, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`GIGABRAIN_MIGRATION_${label.toUpperCase()}_OUTSIDE_RUN_DIR`);
  }
};

const assertProtectedDirectory = (runDir, operatorUid = process.getuid?.()) => {
  assertNoProcPath(runDir, 'run_dir');
  assertNoSymlinkAncestors(runDir);
  const stat = fs.lstatSync(runDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('GIGABRAIN_MIGRATION_RUN_DIR_INVALID');
  if ((stat.mode & 0o777) !== 0o700) throw new Error('GIGABRAIN_MIGRATION_RUN_DIR_MODE');
  if (operatorUid !== undefined && stat.uid !== operatorUid) throw new Error('GIGABRAIN_MIGRATION_RUN_DIR_OWNER_UID');
  return stat;
};

const assertProtectedInput = (filePath, label, operatorUid = process.getuid?.()) => {
  assertNoProcPath(filePath, label);
  assertNoSymlinkAncestors(filePath);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`GIGABRAIN_MIGRATION_${label.toUpperCase()}_INVALID`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`GIGABRAIN_MIGRATION_${label.toUpperCase()}_MODE`);
  if (stat.nlink !== 1) throw new Error(`GIGABRAIN_MIGRATION_${label.toUpperCase()}_NLINK`);
  if (operatorUid !== undefined && stat.uid !== operatorUid) throw new Error(`GIGABRAIN_MIGRATION_${label.toUpperCase()}_OWNER_UID`);
  return stat;
};

const assertNewOutput = (filePath, runDir, label, targetDevice = null) => {
  assertNoProcPath(filePath, label);
  assertNoSymlinkAncestors(filePath, { includeLeaf: false });
  assertContained(filePath, runDir, label);
  if (fs.existsSync(filePath) || fs.lstatSync(path.dirname(filePath)).isSymbolicLink()) {
    throw new Error(`GIGABRAIN_MIGRATION_${label.toUpperCase()}_EXISTS`);
  }
  if (targetDevice !== null && Number(fs.statSync(path.dirname(filePath)).dev) !== Number(targetDevice)) {
    throw new Error(`GIGABRAIN_MIGRATION_${label.toUpperCase()}_FILESYSTEM_DEVICE`);
  }
};

const openReadOnly = (dbPath) => new DatabaseSync(dbPath, { readOnly: true });

const databaseState = (dbPath, shape = null) => {
  const db = openReadOnly(dbPath);
  try {
    const tableNames = shape?.tableNames || db.prepare(`
      SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name COLLATE BINARY
    `).all().map((row) => String(row.name));
    const columns = {};
    const tableRoots = {};
    const columnRoots = {};
    for (const tableName of tableNames) {
      const columnInfo = db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`).all();
      const available = columnInfo.map((row) => String(row.name));
      const names = shape?.columns?.[tableName] || available;
      if (!names.every((name) => available.includes(name))) throw new Error(`GIGABRAIN_AUDIT_OLD_COLUMN_MISSING ${tableName}`);
      columns[tableName] = names;
      if (names.length === 0) continue;
      const infoByName = new Map(columnInfo.map((row) => [String(row.name), row]));
      const projection = names.flatMap((name, index) => Number(infoByName.get(name)?.hidden || 0) > 0
        ? [`'hidden' AS ${quoteIdentifier(`t${index}`)}`, `NULL AS ${quoteIdentifier(`v${index}`)}`]
        : [
          `typeof(${quoteIdentifier(name)}) AS ${quoteIdentifier(`t${index}`)}`,
          `${quoteIdentifier(name)} AS ${quoteIdentifier(`v${index}`)}`,
        ]).join(',');
      const rows = db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(tableName)}`).all().map((row) => (
        names.map((name, index) => [
          name,
          Number(infoByName.get(name)?.hidden || 0) > 0
            ? ['hidden', String(infoByName.get(name).hidden)]
            : typedValue(row[`t${index}`], row[`v${index}`]),
        ])
      ));
      rows.sort((left, right) => binaryCompare(canonicalJson(left), canonicalJson(right)));
      tableRoots[tableName] = sha256(canonicalJson(rows));
      for (let index = 0; index < names.length; index += 1) {
        const values = rows.map((row) => row[index][1])
          .sort((left, right) => binaryCompare(canonicalJson(left), canonicalJson(right)));
        columnRoots[`${tableName}.${names[index]}`] = sha256(canonicalJson(values));
      }
    }
    const schema = db.prepare(`
      SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY
    `).all().filter((row) => !shape?.excludeSchemaTable || String(row.tbl_name) !== shape.excludeSchemaTable)
      .map((row) => ({
        name: String(row.name),
        sql_sha256: row.sql === null || row.sql === undefined ? null : sha256(String(row.sql)),
        table: String(row.tbl_name),
        type: String(row.type),
      }));
    const pragmas = {
      application_id: Number(db.prepare('PRAGMA application_id').get().application_id),
      auto_vacuum: Number(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum),
      encoding: String(db.prepare('PRAGMA encoding').get().encoding),
      journal_mode: String(db.prepare('PRAGMA journal_mode').get().journal_mode),
      page_size: Number(db.prepare('PRAGMA page_size').get().page_size),
      user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
    };
    const state = { columns, pragmas, schema, tableRoots };
    return {
      ...state,
      columnRoots,
      tableNames,
      root: sha256(canonicalJson(state)),
    };
  } finally {
    db.close();
  }
};

const auditRegistryDatabase = ({ dbPath } = {}) => {
  const state = databaseState(path.resolve(String(dbPath || '')));
  const output = {
    columns: state.columns,
    pragmas: state.pragmas,
    schema: state.schema.filter((row) => row.sql_sha256 !== null),
    tableRoots: state.tableRoots,
  };
  return { ...output, root: sha256(canonicalJson(output)) };
};

const inspectMigrationState = ({ dbPath } = {}) => {
  const probe = openReadOnly(dbPath);
  let tableNames;
  try {
    tableNames = probe.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type='table' AND name <> 'memory_schema_migrations'
      ORDER BY name COLLATE BINARY
    `).all().map((row) => String(row.name));
  } finally {
    probe.close();
  }
  const state = databaseState(path.resolve(dbPath), {
    excludeSchemaTable: 'memory_schema_migrations',
    tableNames,
  });
  const schemaObjects = state.schema.map((row) => ({
    name: row.name, sqlSha256: row.sql_sha256, table: row.table, type: row.type,
  }));
  return {
    columnRoots: state.columnRoots,
    columnsByTable: state.columns,
    pragmas: state.pragmas,
    schemaObjects,
    tableNames,
    tableRoots: state.tableRoots,
    root: sha256(canonicalJson({
      columnRoots: state.columnRoots,
      pragmas: state.pragmas,
      schemaObjects,
      tableRoots: state.tableRoots,
    })),
  };
};

const auditRegistryPair = ({ beforePath, afterPath } = {}) => {
  const before = databaseState(path.resolve(beforePath));
  const after = databaseState(path.resolve(afterPath), {
    columns: before.columns,
    excludeSchemaTable: 'memory_schema_migrations',
    tableNames: before.tableNames,
  });
  const beforeSchema = before.schema.map((row) => ({
    name: row.name, sqlSha256: row.sql_sha256, table: row.table, type: row.type,
  }));
  const afterFull = databaseState(path.resolve(afterPath));
  const afterSchema = afterFull.schema
    .filter((row) => row.table !== 'memory_schema_migrations')
    .map((row) => ({ name: row.name, sqlSha256: row.sql_sha256, table: row.table, type: row.type }));
  const afterByKey = new Map(afterSchema.map((row) => [`${row.type}\0${row.name}`, row]));
  const changedOld = beforeSchema.filter((row) => (
    afterByKey.get(`${row.type}\0${row.name}`)?.sqlSha256 !== row.sqlSha256
  )).map((row) => `${row.type}\0${row.name}`).sort(binaryCompare);
  const preserved = beforeSchema.filter((row) => !changedOld.includes(`${row.type}\0${row.name}`));
  return {
    content_free: true,
    old_column_roots: { before: before.columnRoots, after: after.columnRoots },
    old_table_roots: { before: before.tableRoots, after: after.tableRoots },
    pragmas: { before: before.pragmas, after: after.pragmas },
    schema_objects: {
      after: afterSchema,
      before: beforeSchema,
      changed_old: changedOld,
      preserved,
    },
  };
};

const fsyncFile = (filePath) => {
  const fd = fs.openSync(filePath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const fsyncDirectory = (directory) => {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const safeUnlink = (filePath) => {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best-effort rollback */ }
};
const removeDbSidecars = (filePath) => {
  safeUnlink(`${filePath}-wal`);
  safeUnlink(`${filePath}-shm`);
};

const sealReceipt = (body) => ({ ...body, receipt_sha256: sha256(canonicalJson(body)) });

const createConsistentBackup = ({
  sourcePath,
  backupPath,
  receiptPath,
  runDir,
  operatorUid = process.getuid?.(),
  targetDevice = null,
  faultInjector = null,
} = {}) => {
  const runStat = assertProtectedDirectory(runDir, operatorUid);
  const sourceStat = assertProtectedInput(sourcePath, 'source', operatorUid);
  const device = targetDevice ?? runStat.dev;
  assertNewOutput(backupPath, runDir, 'backup', device);
  assertNewOutput(receiptPath, runDir, 'receipt', device);
  const backupTemp = `${backupPath}.tmp-${process.pid}`;
  const receiptTemp = `${receiptPath}.tmp-${process.pid}`;
  let publishedBackup = false;
  let publishedReceipt = false;
  try {
    assertNewOutput(backupTemp, runDir, 'backup_temp', device);
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${String(backupTemp).replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    fs.chmodSync(backupTemp, 0o600);
    const backupDb = new DatabaseSync(backupTemp);
    try { backupDb.exec('PRAGMA journal_mode=WAL'); } finally { backupDb.close(); }
    removeDbSidecars(backupTemp);
    fs.chmodSync(backupTemp, 0o600);
    fsyncFile(backupTemp);
    faultInjector?.('after_backup_temp');
    faultInjector?.('before_backup_publish');
    fs.renameSync(backupTemp, backupPath);
    publishedBackup = true;
    fsyncDirectory(runDir);
    faultInjector?.('after_backup_publish');
    const sourceAudit = auditRegistryDatabase({ dbPath: sourcePath });
    const backupAudit = auditRegistryDatabase({ dbPath: backupPath });
    removeDbSidecars(backupPath);
    if (sourceAudit.root !== backupAudit.root) throw new Error('GIGABRAIN_MIGRATION_BACKUP_LOGICAL_ROOT_MISMATCH');
    const receipt = sealReceipt({
      backup_path: path.resolve(backupPath),
      backup_sha256: sha256(fs.readFileSync(backupPath)),
      contract: 'gigabrain-consistent-backup-receipt-v1',
      ok: true,
      source_identity: { dev: String(sourceStat.dev), ino: String(sourceStat.ino) },
      source_logical_root: sourceAudit.root,
      status: 'completed',
    });
    fs.writeFileSync(receiptTemp, canonicalJson(receipt), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(receiptTemp, 0o600);
    fsyncFile(receiptTemp);
    faultInjector?.('after_receipt_temp');
    faultInjector?.('before_receipt_publish');
    fs.renameSync(receiptTemp, receiptPath);
    publishedReceipt = true;
    fsyncDirectory(runDir);
    faultInjector?.('after_receipt_publish');
    return receipt;
  } catch (error) {
    safeUnlink(backupTemp);
    removeDbSidecars(backupTemp);
    safeUnlink(receiptTemp);
    if (publishedReceipt) safeUnlink(receiptPath);
    if (publishedBackup) {
      safeUnlink(backupPath);
      removeDbSidecars(backupPath);
    }
    throw error;
  }
};

const readProtectedReceipt = (receiptPath, operatorUid) => {
  assertProtectedInput(receiptPath, 'receipt', operatorUid);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const body = { ...receipt };
  delete body.receipt_sha256;
  if (receipt.receipt_sha256 !== sha256(canonicalJson(body))) throw new Error('GIGABRAIN_MIGRATION_RECEIPT_SHA256');
  return receipt;
};

const validateConsistentBackup = ({
  sourcePath,
  backupPath,
  receiptPath,
  runDir,
  operatorUid = process.getuid?.(),
  requireSourceLogicalMatch = true,
} = {}) => {
  assertProtectedDirectory(runDir, operatorUid);
  const sourceStat = assertProtectedInput(sourcePath, 'source', operatorUid);
  assertProtectedInput(backupPath, 'backup', operatorUid);
  assertContained(backupPath, runDir, 'backup');
  assertContained(receiptPath, runDir, 'receipt');
  const receipt = readProtectedReceipt(receiptPath, operatorUid);
  if (receipt.contract !== 'gigabrain-consistent-backup-receipt-v1' || receipt.status !== 'completed') {
    throw new Error('GIGABRAIN_MIGRATION_BACKUP_RECEIPT_CONTRACT');
  }
  if (
    String(receipt.source_identity?.dev) !== String(sourceStat.dev)
    || String(receipt.source_identity?.ino) !== String(sourceStat.ino)
  ) throw new Error('GIGABRAIN_MIGRATION_BACKUP_SOURCE_IDENTITY');
  if (receipt.backup_path !== path.resolve(backupPath) || receipt.backup_sha256 !== sha256(fs.readFileSync(backupPath))) {
    throw new Error('GIGABRAIN_MIGRATION_BACKUP_CHECKSUM_TAMPER');
  }
  const sourceAudit = auditRegistryDatabase({ dbPath: sourcePath });
  const backupAudit = auditRegistryDatabase({ dbPath: backupPath });
  if (receipt.source_logical_root !== backupAudit.root) {
    throw new Error('GIGABRAIN_MIGRATION_BACKUP_LOGICAL_ROOT_MISMATCH');
  }
  if (requireSourceLogicalMatch && receipt.source_logical_root !== sourceAudit.root) {
    throw new Error('GIGABRAIN_MIGRATION_BACKUP_SOURCE_LOGICAL_ROOT_MISMATCH');
  }
  return receipt;
};

const assertDatabaseIntegrity = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('GIGABRAIN_MIGRATION_QUICK_CHECK');
    db.exec('PRAGMA foreign_keys=ON');
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('GIGABRAIN_MIGRATION_FOREIGN_KEY_CHECK');
  } finally {
    db.close();
  }
};

const restoreVerifiedBackup = ({
  backupPath,
  backupReceiptPath,
  destinationPath,
  receiptPath,
  runDir,
  operatorUid = process.getuid?.(),
  targetDevice = null,
  faultInjector = null,
} = {}) => {
  const runStat = assertProtectedDirectory(runDir, operatorUid);
  if (targetDevice !== null && Number(runStat.dev) !== Number(targetDevice)) {
    throw new Error('GIGABRAIN_MIGRATION_DESTINATION_FILESYSTEM_DEVICE');
  }
  assertProtectedInput(backupPath, 'backup', operatorUid);
  assertContained(backupPath, runDir, 'backup');
  assertContained(backupReceiptPath, runDir, 'receipt');
  const backupReceipt = readProtectedReceipt(backupReceiptPath, operatorUid);
  if (backupReceipt.contract !== 'gigabrain-consistent-backup-receipt-v1') throw new Error('GIGABRAIN_MIGRATION_BACKUP_RECEIPT_CONTRACT');
  if (backupReceipt.backup_sha256 !== sha256(fs.readFileSync(backupPath))) throw new Error('GIGABRAIN_MIGRATION_BACKUP_CHECKSUM_TAMPER');
  const device = targetDevice ?? runStat.dev;
  assertNewOutput(destinationPath, runDir, 'destination', device);
  assertNewOutput(receiptPath, runDir, 'receipt', device);
  const destinationTemp = `${destinationPath}.tmp-${process.pid}`;
  const receiptTemp = `${receiptPath}.tmp-${process.pid}`;
  let publishedDestination = false;
  let publishedReceipt = false;
  try {
    fs.copyFileSync(backupPath, destinationTemp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destinationTemp, 0o600);
    fsyncFile(destinationTemp);
    faultInjector?.('after_temp_copy');
    faultInjector?.('before_integrity');
    assertDatabaseIntegrity(destinationTemp);
    const audit = auditRegistryDatabase({ dbPath: destinationTemp });
    removeDbSidecars(destinationTemp);
    if (audit.root !== backupReceipt.source_logical_root) throw new Error('GIGABRAIN_MIGRATION_RESTORE_LOGICAL_ROOT');
    faultInjector?.('after_integrity');
    faultInjector?.('before_destination_publish');
    fs.renameSync(destinationTemp, destinationPath);
    publishedDestination = true;
    fsyncDirectory(runDir);
    faultInjector?.('after_destination_publish');
    const destinationStat = fs.lstatSync(destinationPath);
    const receipt = sealReceipt({
      backup_sha256: backupReceipt.backup_sha256,
      contract: 'gigabrain-restore-receipt-v1',
      destination_identity: { dev: String(destinationStat.dev), ino: String(destinationStat.ino) },
      logical_root: audit.root,
      ok: true,
      status: 'completed',
    });
    fs.writeFileSync(receiptTemp, canonicalJson(receipt), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(receiptTemp, 0o600);
    fsyncFile(receiptTemp);
    faultInjector?.('before_receipt_publish');
    fs.renameSync(receiptTemp, receiptPath);
    publishedReceipt = true;
    fsyncDirectory(runDir);
    faultInjector?.('after_receipt_publish');
    return receipt;
  } catch (error) {
    safeUnlink(destinationTemp);
    removeDbSidecars(destinationTemp);
    safeUnlink(receiptTemp);
    if (publishedReceipt) safeUnlink(receiptPath);
    if (publishedDestination) {
      safeUnlink(destinationPath);
      removeDbSidecars(destinationPath);
    }
    throw error;
  }
};

export {
  auditRegistryDatabase,
  auditRegistryPair,
  inspectMigrationState,
  createConsistentBackup,
  validateConsistentBackup,
  restoreVerifiedBackup,
};

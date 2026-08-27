import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "14";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_ROLLBACK_RESTORE missing verified rollback restoration";

const CONTENT_SENTINEL = "ROLLBACK-CONTENT-MUST-NOT-ENTER-RECEIPTS";
const SEEDED_MARKERS = [
  CONTENT_SENTINEL, "checkpointed", "wal-only", "WAL row must survive backup", "visible",
  '{"b":2,"a":1}', '{"wal":true}', Buffer.from([0, 1, 2, 255]).toString("hex"),
  Buffer.from([7, 8, 9]).toString("hex"),
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const binaryCompare = (left, right) => Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object" && !Buffer.isBuffer(value)
    ? Object.fromEntries(Object.keys(value).sort(binaryCompare).map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

const typed = (storageType, value) => {
  if (storageType === "null") return ["null"];
  if (storageType === "blob") return ["blob", Buffer.from(value).toString("hex")];
  return [storageType, String(value)];
};

const independentAudit = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare(`
      SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name
    `).all().map((row) => String(row.name));
    const tableRoots = {};
    const columns = {};
    for (const table of tables) {
      const names = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => String(row.name));
      columns[table] = names;
      if (names.length === 0) continue;
      const projection = names.flatMap((name, index) => [
        `typeof(${quoteIdentifier(name)}) AS ${quoteIdentifier(`t${index}`)}`,
        `${quoteIdentifier(name)} AS ${quoteIdentifier(`v${index}`)}`,
      ]).join(",");
      const rows = db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)}`).all().map((row) => (
        names.map((name, index) => [name, typed(row[`t${index}`], row[`v${index}`])])
      ));
      rows.sort((left, right) => binaryCompare(canonicalJson(left), canonicalJson(right)));
      tableRoots[table] = sha256(canonicalJson(rows));
    }
    const schema = db.prepare(`
      SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name
    `).all().map((row) => ({
      name: String(row.name),
      sql_sha256: sha256(String(row.sql)),
      table: String(row.tbl_name),
      type: String(row.type),
    }));
    const pragmas = {
      application_id: Number(db.prepare("PRAGMA application_id").get().application_id),
      auto_vacuum: Number(db.prepare("PRAGMA auto_vacuum").get().auto_vacuum),
      encoding: String(db.prepare("PRAGMA encoding").get().encoding),
      journal_mode: String(db.prepare("PRAGMA journal_mode").get().journal_mode),
      page_size: Number(db.prepare("PRAGMA page_size").get().page_size),
      user_version: Number(db.prepare("PRAGMA user_version").get().user_version),
    };
    const state = { columns, pragmas, schema, tableRoots };
    return { ...state, root: sha256(canonicalJson(state)) };
  } finally {
    db.close();
  }
};

const createWalSource = (dbPath) => {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(dbPath), 0o700);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    PRAGMA foreign_keys=ON;
    PRAGMA application_id=1195987534;
    PRAGMA user_version=7;
    CREATE TABLE parent_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL UNIQUE,
      payload BLOB,
      json_value TEXT,
      nullable_value TEXT
    );
    CREATE TABLE child_records (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      FOREIGN KEY(parent_id) REFERENCES parent_records(id)
    );
    CREATE INDEX idx_child_records_parent ON child_records(parent_id);
    CREATE TRIGGER child_records_no_delete BEFORE DELETE ON child_records
    BEGIN SELECT RAISE(ABORT, 'children retained'); END;
  `);
  const insertParent = db.prepare("INSERT INTO parent_records(label,payload,json_value,nullable_value) VALUES(?,?,?,?)");
  const first = insertParent.run("checkpointed", Buffer.from([0, 1, 2, 255]), '{"b":2,"a":1}', null);
  db.prepare("INSERT INTO child_records VALUES(?,?,?)").run(1, Number(first.lastInsertRowid), CONTENT_SENTINEL);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const second = insertParent.run("wal-only", Buffer.from([7, 8, 9]), '{"wal":true}', "visible");
  db.prepare("INSERT INTO child_records VALUES(?,?,?)").run(2, Number(second.lastInsertRowid), "WAL row must survive backup");
  chmodSync(dbPath, 0o600);
  assert.equal(existsSync(`${dbPath}-wal`), true);
  assert.equal(existsSync(`${dbPath}-shm`), true);
  return db;
};

const assertIntegrity = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    db.exec("PRAGMA foreign_keys=ON");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
};

const assertProtectedRegularFile = (filePath) => {
  const stat = lstatSync(filePath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  if (typeof process.getuid === "function") assert.equal(stat.uid, process.getuid());
};

const assertContentFree = (value) => {
  const text = JSON.stringify(value);
  for (const marker of SEEDED_MARKERS) assert.equal(text.includes(marker), false, `receipt leaked ${marker}`);
};

const assertExactKeys = (value, keys, label) => assert.deepEqual(Object.keys(value), [...keys].sort(binaryCompare), `${label} exact keys`);

const snapshotDirectory = (directory) => readdirSync(directory).sort(binaryCompare).map((name) => {
  const filePath = path.join(directory, name);
  const stat = lstatSync(filePath);
  return {
    hash: stat.isFile() ? sha256(readFileSync(filePath)) : null,
    mode: stat.mode & 0o777,
    name,
    type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "special",
  };
});

export async function run() {
  const audit = await importContractModule("lib/compat/migration-audit.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const auditRegistryDatabase = requireCallable(audit, "auditRegistryDatabase");
    const createConsistentBackup = requireCallable(audit, "createConsistentBackup");
    const restoreVerifiedBackup = requireCallable(audit, "restoreVerifiedBackup");

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task14-restore-"));
    chmodSync(root, 0o700);
    let source = null;
    try {
      const sourcePath = path.join(root, "source", "registry.sqlite");
      source = createWalSource(sourcePath);
      const before = independentAudit(sourcePath);
      assert.equal(source.prepare("SELECT COUNT(*) AS c FROM parent_records").get().c, 2);
      const sourceHashBefore = sha256(readFileSync(sourcePath));
      const sourceWalHashBefore = sha256(readFileSync(`${sourcePath}-wal`));
      const sourceShmHashBefore = sha256(readFileSync(`${sourcePath}-shm`));

      const runDir = path.join(root, "restore-run");
      mkdirSync(runDir, { mode: 0o700 });
      const backupPath = path.join(runDir, "pre-migration.sqlite");
      const backupReceiptPath = path.join(runDir, "pre-migration.receipt.json");
      const backupArgs = { backupPath, receiptPath: backupReceiptPath, runDir, sourcePath };
      const assertBackupRejected = (overrides, pattern) => {
        const beforeSource = independentAudit(sourcePath);
        assert.throws(() => createConsistentBackup({ ...backupArgs, ...overrides }), pattern);
        assert.deepEqual(independentAudit(sourcePath), beforeSource);
      };
      chmodSync(runDir, 0o755);
      assertBackupRejected({}, /run.dir|mode|permission/i);
      chmodSync(runDir, 0o700);
      chmodSync(sourcePath, 0o644);
      assertBackupRejected({}, /source|mode|permission/i);
      chmodSync(sourcePath, 0o600);
      assertBackupRejected({ operatorUid: Number(process.getuid?.() || 0) + 1 }, /owner|uid/i);
      const sourceSymlink = path.join(root, "source-symlink.sqlite");
      symlinkSync(sourcePath, sourceSymlink);
      try { assertBackupRejected({ sourcePath: sourceSymlink }, /source|symlink|alias/i); } finally { unlinkSync(sourceSymlink); }
      const sourceHardlink = path.join(root, "source-hardlink.sqlite");
      linkSync(sourcePath, sourceHardlink);
      try { assertBackupRejected({}, /source|link|nlink/i); } finally { unlinkSync(sourceHardlink); }
      const sourceFd = openSync(sourcePath, "r");
      try { assertBackupRejected({ sourcePath: `/proc/self/fd/${sourceFd}` }, /proc|descriptor|source|alias/i); } finally { closeSync(sourceFd); }
      const sourceParentAlias = path.join(root, "source-parent-alias");
      symlinkSync(path.dirname(sourcePath), sourceParentAlias);
      try {
        assertBackupRejected({ sourcePath: path.join(sourceParentAlias, path.basename(sourcePath)) }, /ancestor|symlink|canonical/i);
      } finally { unlinkSync(sourceParentAlias); }
      assertBackupRejected({ backupPath: path.join(root, "outside-backup.sqlite") }, /contain|run.dir|backup/i);
      assertBackupRejected({ receiptPath: path.join(root, "outside-backup.receipt.json") }, /contain|run.dir|receipt/i);
      const existingBackup = path.join(runDir, "existing-backup.sqlite");
      writeFileSync(existingBackup, "existing", { mode: 0o600 });
      assertBackupRejected({ backupPath: existingBackup }, /exist|overwrite|backup/i);
      const existingReceipt = path.join(runDir, "existing-backup.receipt.json");
      writeFileSync(existingReceipt, "existing", { mode: 0o600 });
      assertBackupRejected({ receiptPath: existingReceipt }, /exist|overwrite|receipt/i);
      if (existsSync("/dev/shm") && statSync("/dev/shm").dev !== statSync(runDir).dev) {
        const crossRun = mkdtempSync(path.join("/dev/shm", "gigabrain-task14-backup-crossfs-"));
        try {
          chmodSync(crossRun, 0o700);
          assertBackupRejected({
            backupPath: path.join(crossRun, "backup.sqlite"),
            receiptPath: path.join(crossRun, "backup.receipt.json"),
            runDir: crossRun,
            targetDevice: statSync(runDir).dev,
          }, /filesystem|device/i);
        } finally { rmSync(crossRun, { recursive: true, force: true }); }
      }
      for (const stage of [
        "after_backup_temp", "before_backup_publish", "after_backup_publish",
        "after_receipt_temp", "before_receipt_publish", "after_receipt_publish",
      ]) {
        const faultBackupPath = path.join(runDir, `backup-fault-${stage}.sqlite`);
        const faultReceiptPath = path.join(runDir, `backup-fault-${stage}.receipt.json`);
        const beforeFaultInventory = snapshotDirectory(runDir);
        assert.throws(() => createConsistentBackup({
          backupPath: faultBackupPath,
          receiptPath: faultReceiptPath,
          runDir,
          sourcePath,
          faultInjector: (observed) => { if (observed === stage) throw new Error(`synthetic ${stage}`); },
        }), new RegExp(`synthetic ${stage}`));
        assert.deepEqual(snapshotDirectory(runDir), beforeFaultInventory, `${stage} exact backup directory rollback`);
        assert.equal(sha256(readFileSync(sourcePath)), sourceHashBefore);
        assert.equal(sha256(readFileSync(`${sourcePath}-wal`)), sourceWalHashBefore);
        assert.equal(sha256(readFileSync(`${sourcePath}-shm`)), sourceShmHashBefore);
      }
      const backupReceipt = createConsistentBackup({
        backupPath,
        receiptPath: backupReceiptPath,
        runDir,
        sourcePath,
      });
      assert.equal(backupReceipt.ok, true);
      assert.equal(backupReceipt.source_logical_root, before.root);
      assert.equal(backupReceipt.backup_sha256, sha256(readFileSync(backupPath)));
      assert.match(backupReceipt.receipt_sha256, /^[0-9a-f]{64}$/);
      const backupReceiptBody = { ...backupReceipt };
      delete backupReceiptBody.receipt_sha256;
      assert.equal(backupReceipt.receipt_sha256, sha256(canonicalJson(backupReceiptBody)));
      assertProtectedRegularFile(backupReceiptPath);
      const persistedBackupReceipt = JSON.parse(readFileSync(backupReceiptPath, "utf8"));
      assert.deepEqual(persistedBackupReceipt, backupReceipt);
      assertExactKeys(persistedBackupReceipt, [
        "backup_path", "backup_sha256", "contract", "ok", "receipt_sha256", "source_identity",
        "source_logical_root", "status",
      ], "backup receipt");
      assertExactKeys(persistedBackupReceipt.source_identity, ["dev", "ino"], "backup source identity");
      assert.equal(persistedBackupReceipt.contract, "gigabrain-consistent-backup-receipt-v1");
      assert.equal(persistedBackupReceipt.status, "completed");
      assertContentFree(backupReceipt);
      assertProtectedRegularFile(backupPath);
      assert.notEqual(statSync(sourcePath).ino, statSync(backupPath).ino);
      assert.deepEqual(independentAudit(backupPath), before, "engine backup must include uncheckpointed WAL rows");
      assert.deepEqual(auditRegistryDatabase({ dbPath: backupPath }), before);
      assertIntegrity(backupPath);
      assert.equal(sha256(readFileSync(sourcePath)), sourceHashBefore);
      assert.equal(sha256(readFileSync(`${sourcePath}-wal`)), sourceWalHashBefore);
      assert.equal(sha256(readFileSync(`${sourcePath}-shm`)), sourceShmHashBefore);

      const restorePath = path.join(runDir, "restored.sqlite");
      const restoreReceiptPath = path.join(runDir, "restored.receipt.json");
      const restoreArgs = {
        backupPath, backupReceiptPath, destinationPath: restorePath, receiptPath: restoreReceiptPath, runDir,
      };
      const assertRestoreRejected = (overrides, pattern) => {
        assert.throws(() => restoreVerifiedBackup({ ...restoreArgs, ...overrides }), pattern);
        assert.equal(existsSync(overrides.destinationPath || restorePath), false);
        assert.equal(existsSync(overrides.receiptPath || restoreReceiptPath), false);
      };
      chmodSync(backupPath, 0o644);
      assertRestoreRejected({}, /backup|mode|permission/i);
      chmodSync(backupPath, 0o600);
      chmodSync(backupReceiptPath, 0o644);
      assertRestoreRejected({}, /receipt|mode|permission/i);
      chmodSync(backupReceiptPath, 0o600);
      assertRestoreRejected({ operatorUid: Number(process.getuid?.() || 0) + 1 }, /owner|uid/i);
      const backupAlias = path.join(runDir, "backup-alias.sqlite");
      symlinkSync(backupPath, backupAlias);
      try { assertRestoreRejected({ backupPath: backupAlias }, /backup|symlink|alias/i); } finally { unlinkSync(backupAlias); }
      const backupHardlink = path.join(runDir, "backup-hardlink-input.sqlite");
      linkSync(backupPath, backupHardlink);
      try { assertRestoreRejected({}, /backup|link|nlink/i); } finally { unlinkSync(backupHardlink); }
      const backupInputFd = openSync(backupPath, "r");
      try { assertRestoreRejected({ backupPath: `/proc/self/fd/${backupInputFd}` }, /proc|descriptor|backup|alias/i); } finally { closeSync(backupInputFd); }
      const receiptAlias = path.join(runDir, "backup-receipt-alias.json");
      symlinkSync(backupReceiptPath, receiptAlias);
      try { assertRestoreRejected({ backupReceiptPath: receiptAlias }, /receipt|symlink|alias/i); } finally { unlinkSync(receiptAlias); }
      const receiptHardlinkInput = path.join(runDir, "backup-receipt-hardlink.json");
      linkSync(backupReceiptPath, receiptHardlinkInput);
      try { assertRestoreRejected({}, /receipt|link|nlink/i); } finally { unlinkSync(receiptHardlinkInput); }
      const receiptInputFd = openSync(backupReceiptPath, "r");
      try { assertRestoreRejected({ backupReceiptPath: `/proc/self/fd/${receiptInputFd}` }, /proc|descriptor|receipt|alias/i); } finally { closeSync(receiptInputFd); }
      chmodSync(runDir, 0o755);
      assertRestoreRejected({}, /run.dir|mode|permission/i);
      chmodSync(runDir, 0o700);
      const restored = restoreVerifiedBackup({
        backupPath,
        backupReceiptPath,
        destinationPath: restorePath,
        receiptPath: restoreReceiptPath,
        runDir,
      });
      assert.equal(restored.ok, true);
      assert.equal(restored.logical_root, before.root);
      assert.equal(restored.backup_sha256, backupReceipt.backup_sha256);
      assertContentFree(restored);
      assertProtectedRegularFile(restoreReceiptPath);
      const persistedRestoreReceipt = JSON.parse(readFileSync(restoreReceiptPath, "utf8"));
      assert.deepEqual(persistedRestoreReceipt, restored);
      assertExactKeys(persistedRestoreReceipt, [
        "backup_sha256", "contract", "destination_identity", "logical_root", "ok",
        "receipt_sha256", "status",
      ], "restore receipt");
      assertExactKeys(persistedRestoreReceipt.destination_identity, ["dev", "ino"], "restore destination identity");
      assert.equal(persistedRestoreReceipt.contract, "gigabrain-restore-receipt-v1");
      assert.equal(persistedRestoreReceipt.status, "completed");
      const restoreReceiptBody = { ...persistedRestoreReceipt };
      delete restoreReceiptBody.receipt_sha256;
      assert.equal(persistedRestoreReceipt.receipt_sha256, sha256(canonicalJson(restoreReceiptBody)));
      assertProtectedRegularFile(restorePath);
      assert.notEqual(statSync(restorePath).ino, statSync(sourcePath).ino);
      assert.notEqual(statSync(restorePath).ino, statSync(backupPath).ino);
      assert.deepEqual(independentAudit(restorePath), before);
      assertIntegrity(restorePath);
      const restoredDb = new DatabaseSync(restorePath, { readOnly: true });
      assert.deepEqual(restoredDb.prepare("SELECT label FROM parent_records ORDER BY id").all().map((row) => row.label), [
        "checkpointed",
        "wal-only",
      ]);
      assert.equal(restoredDb.prepare("SELECT seq FROM sqlite_sequence WHERE name='parent_records'").get().seq, 2);
      restoredDb.close();

      const secondRestorePath = path.join(runDir, "restored-second.sqlite");
      const secondRestoreReceiptPath = path.join(runDir, "restored-second.receipt.json");
      const restoredSecond = restoreVerifiedBackup({
        backupPath,
        backupReceiptPath,
        destinationPath: secondRestorePath,
        receiptPath: secondRestoreReceiptPath,
        runDir,
      });
      assert.equal(restoredSecond.logical_root, restored.logical_root);
      assert.equal(sha256(readFileSync(secondRestorePath)), sha256(readFileSync(restorePath)));

      const existingPath = path.join(runDir, "existing.sqlite");
      writeFileSync(existingPath, "do not overwrite", { mode: 0o600 });
      const existingHash = sha256(readFileSync(existingPath));
      assert.throws(() => restoreVerifiedBackup({
        backupPath,
        backupReceiptPath,
        destinationPath: existingPath,
        receiptPath: path.join(runDir, "existing.receipt.json"),
        runDir,
      }), /exist|overwrite|destination/i);
      assert.equal(sha256(readFileSync(existingPath)), existingHash);

      const receiptTarget = path.join(runDir, "receipt-target.json");
      writeFileSync(receiptTarget, "receipt target", { mode: 0o600 });
      const receiptTargetHash = sha256(readFileSync(receiptTarget));
      const outputReceiptSymlink = path.join(runDir, "output-receipt-symlink.json");
      symlinkSync(receiptTarget, outputReceiptSymlink);
      try {
        assert.throws(() => restoreVerifiedBackup({
          backupPath, backupReceiptPath,
          destinationPath: path.join(runDir, "receipt-symlink-output.sqlite"),
          receiptPath: outputReceiptSymlink, runDir,
        }), /receipt|symlink|alias|exist/i);
      } finally { unlinkSync(outputReceiptSymlink); }
      assert.equal(sha256(readFileSync(receiptTarget)), receiptTargetHash);
      const outputReceiptHardlink = path.join(runDir, "output-receipt-hardlink.json");
      linkSync(receiptTarget, outputReceiptHardlink);
      try {
        assert.throws(() => restoreVerifiedBackup({
          backupPath, backupReceiptPath,
          destinationPath: path.join(runDir, "receipt-hardlink-output.sqlite"),
          receiptPath: outputReceiptHardlink, runDir,
        }), /receipt|link|alias|exist/i);
      } finally { unlinkSync(outputReceiptHardlink); }
      const receiptFd = openSync(receiptTarget, "r");
      try {
        assert.throws(() => restoreVerifiedBackup({
          backupPath, backupReceiptPath,
          destinationPath: path.join(runDir, "receipt-fd-output.sqlite"),
          receiptPath: `/proc/self/fd/${receiptFd}`, runDir,
        }), /proc|descriptor|receipt|contain/i);
      } finally { closeSync(receiptFd); }

      const symlinkPath = path.join(runDir, "restore-symlink.sqlite");
      symlinkSync(sourcePath, symlinkPath);
      try {
        assert.throws(() => restoreVerifiedBackup({
          backupPath,
          backupReceiptPath,
          destinationPath: symlinkPath,
          receiptPath: path.join(runDir, "symlink.receipt.json"),
          runDir,
        }), /symlink|alias|destination|exist/i);
      } finally {
        unlinkSync(symlinkPath);
      }
      const hardlinkPath = path.join(runDir, "restore-hardlink.sqlite");
      linkSync(sourcePath, hardlinkPath);
      try {
        assert.throws(() => restoreVerifiedBackup({
          backupPath,
          backupReceiptPath,
          destinationPath: hardlinkPath,
          receiptPath: path.join(runDir, "hardlink.receipt.json"),
          runDir,
        }), /link|alias|destination|exist/i);
      } finally {
        unlinkSync(hardlinkPath);
      }
      const backupFd = openSync(backupPath, "r");
      try {
        assert.throws(() => restoreVerifiedBackup({
          backupPath,
          backupReceiptPath,
          destinationPath: `/proc/self/fd/${backupFd}`,
          receiptPath: path.join(runDir, "fd.receipt.json"),
          runDir,
        }), /proc|descriptor|destination|contain/i);
      } finally {
        closeSync(backupFd);
      }
      assert.throws(() => restoreVerifiedBackup({
        backupPath,
        backupReceiptPath,
        destinationPath: path.join(root, "outside-restore.sqlite"),
        receiptPath: path.join(runDir, "outside.receipt.json"),
        runDir,
      }), /contain|run.dir|destination/i);
      const restoreRunAlias = path.join(root, "restore-run-alias");
      symlinkSync(runDir, restoreRunAlias);
      try {
        assert.throws(() => restoreVerifiedBackup({
          backupPath, backupReceiptPath,
          destinationPath: path.join(restoreRunAlias, "ancestor-output.sqlite"),
          receiptPath: path.join(restoreRunAlias, "ancestor-output.receipt.json"),
          runDir: restoreRunAlias,
        }), /ancestor|symlink|canonical|run.dir/i);
      } finally { unlinkSync(restoreRunAlias); }
      if (existsSync("/dev/shm") && statSync("/dev/shm").dev !== statSync(runDir).dev) {
        const crossRestoreRun = mkdtempSync(path.join("/dev/shm", "gigabrain-task14-restore-crossfs-"));
        try {
          chmodSync(crossRestoreRun, 0o700);
          assert.throws(() => restoreVerifiedBackup({
            backupPath, backupReceiptPath,
            destinationPath: path.join(crossRestoreRun, "restored.sqlite"),
            receiptPath: path.join(crossRestoreRun, "restored.receipt.json"),
            runDir: crossRestoreRun,
            targetDevice: statSync(runDir).dev,
          }), /filesystem|device/i);
        } finally { rmSync(crossRestoreRun, { recursive: true, force: true }); }
      }

      const tamperedBackup = path.join(runDir, "tampered.sqlite");
      copyFileSync(backupPath, tamperedBackup);
      writeFileSync(tamperedBackup, Buffer.concat([readFileSync(tamperedBackup), Buffer.from([1])]));
      chmodSync(tamperedBackup, 0o600);
      assert.throws(() => restoreVerifiedBackup({
        backupPath: tamperedBackup,
        backupReceiptPath,
        destinationPath: path.join(runDir, "tampered-output.sqlite"),
        receiptPath: path.join(runDir, "tampered.receipt.json"),
        runDir,
      }), /checksum|sha256|tamper/i);
      assert.equal(existsSync(path.join(runDir, "tampered-output.sqlite")), false);

      const badBackupReceiptPath = path.join(runDir, "bad-backup-source.receipt.json");
      writeFileSync(badBackupReceiptPath, canonicalJson({ ...backupReceipt, backup_sha256: "0".repeat(64) }), { mode: 0o600 });
      assert.throws(() => restoreVerifiedBackup({
        backupPath,
        backupReceiptPath: badBackupReceiptPath,
        destinationPath: path.join(runDir, "bad-receipt-output.sqlite"),
        receiptPath: path.join(runDir, "bad-backup-receipt.json"),
        runDir,
      }), /checksum|receipt|sha256/i);
      assert.equal(existsSync(path.join(runDir, "bad-receipt-output.sqlite")), false);

      for (const stage of [
        "after_temp_copy", "before_integrity", "after_integrity", "before_destination_publish",
        "after_destination_publish", "before_receipt_publish", "after_receipt_publish",
      ]) {
        const destinationPath = path.join(runDir, `fault-${stage}.sqlite`);
        const beforeFaultInventory = snapshotDirectory(runDir);
        assert.throws(() => restoreVerifiedBackup({
          backupPath,
          backupReceiptPath,
          destinationPath,
          receiptPath: path.join(runDir, `fault-${stage}.receipt.json`),
          runDir,
          faultInjector: (observed) => { if (observed === stage) throw new Error(`synthetic ${stage}`); },
        }), new RegExp(`synthetic ${stage}`));
        assert.equal(existsSync(destinationPath), false, `${stage} must remove the incomplete destination`);
        assert.equal(existsSync(path.join(runDir, `fault-${stage}.receipt.json`)), false);
        assert.equal(sha256(readFileSync(backupPath)), backupReceipt.backup_sha256);
        assert.deepEqual(snapshotDirectory(runDir), beforeFaultInventory, `${stage} exact directory rollback`);
      }

      assert.equal(sha256(readFileSync(sourcePath)), sourceHashBefore);
      assert.equal(sha256(readFileSync(`${sourcePath}-wal`)), sourceWalHashBefore);
      assert.equal(sha256(readFileSync(`${sourcePath}-shm`)), sourceShmHashBefore);
      assert.deepEqual(independentAudit(sourcePath), before);
    } finally {
      try { source?.close(); } catch { /* already closed */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

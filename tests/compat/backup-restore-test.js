import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "12";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_BACKUP_RESTORE missing verified VACUUM INTO snapshot contract";

const sha256File = async (filePath) => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
};

const makeWalFixture = (root, name = "registry.sqlite") => {
  const dbPath = path.join(root, name);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    PRAGMA foreign_keys = ON;
    CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parents(id),
      note TEXT NOT NULL
    );
    CREATE TABLE sequence_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL);
    INSERT INTO parents (id, name) VALUES (1, 'sealed parent');
    INSERT INTO sequence_probe (note) VALUES ('kept'), ('deleted gap');
    DELETE FROM sequence_probe WHERE id = 2;
  `);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("INSERT INTO children (id, parent_id, note) VALUES (7, 1, 'uncheckpointed WAL row')");
  assert.equal(existsSync(`${dbPath}-wal`), true, "fixture must retain an uncheckpointed WAL sidecar");
  return { db, dbPath };
};

export async function run() {
  const maintenance = await importContractModule("lib/core/maintenance-service.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const snapshotDatabase = requireCallable(maintenance, "snapshotDatabase");
    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task12-backup-"));
    try {
      const fixture = makeWalFixture(root);
      const target = path.join(root, "backups", "registry-vacuum.sqlite");
      const receipt = snapshotDatabase(fixture.db, target);

      assert.equal(receipt.ok, true);
      assert.equal(receipt.method, "vacuum_into");
      assert.equal(receipt.targetPath, target);
      assert.equal(receipt.quickCheck, "ok");
      assert.equal(receipt.foreignKeyErrors, 0);
      assert.equal(receipt.sourceLogicalHash, receipt.targetLogicalHash);
      assert.match(receipt.sourceLogicalHash, /^[0-9a-f]{64}$/);
      assert.equal(receipt.immutable, true);
      assert.equal(receipt.targetMode, "0600");
      assert.equal(receipt.freeBytes >= receipt.requiredBytes, true);
      assert.equal(statSync(target).mode & 0o777, 0o600);

      const standalone = new DatabaseSync(target, { readOnly: true });
      try {
        assert.deepEqual(
          { ...standalone.prepare("SELECT id, parent_id, note FROM children").get() },
          { id: 7, parent_id: 1, note: "uncheckpointed WAL row" },
        );
        assert.equal(standalone.prepare("PRAGMA quick_check").get()["quick_check"], "ok");
        assert.equal(standalone.prepare("PRAGMA foreign_key_check").all().length, 0);
      } finally {
        standalone.close();
      }

      fixture.db.close();
      const restorePath = path.join(root, "restored", "registry.sqlite");
      mkdirSync(path.dirname(restorePath), { recursive: true });
      copyFileSync(target, restorePath);
      const restored = new DatabaseSync(restorePath);
      try {
        assert.equal(restored.prepare("SELECT note FROM children WHERE id=7").get().note, "uncheckpointed WAL row");
        restored.exec("INSERT INTO children (id, parent_id, note) VALUES (8, 1, 'restored database is writable')");
        assert.equal(restored.prepare("SELECT COUNT(*) AS c FROM children").get().c, 2);
      } finally {
        restored.close();
      }
      const restoredSequence = new DatabaseSync(restorePath);
      const sourceSequence = new DatabaseSync(fixture.dbPath);
      try {
        const restoredId = Number(restoredSequence.prepare("INSERT INTO sequence_probe (note) VALUES ('restored next id')").run().lastInsertRowid);
        const sourceId = Number(sourceSequence.prepare("INSERT INTO sequence_probe (note) VALUES ('source next id')").run().lastInsertRowid);
        assert.equal(restoredId, 3, "restored AUTOINCREMENT must preserve the deleted ID gap");
        assert.equal(sourceId, restoredId, "source and restored next IDs must advance identically");
      } finally {
        restoredSequence.close();
        sourceSequence.close();
      }

      const concurrent = makeWalFixture(root, "concurrent.sqlite");
      const concurrentWriter = new DatabaseSync(concurrent.dbPath);
      const concurrentTarget = path.join(root, "backups", "concurrent-retry.sqlite");
      let injected = false;
      try {
        const concurrentReceipt = snapshotDatabase(concurrent.db, concurrentTarget, {
          afterVacuum: ({ attempt }) => {
            if (attempt !== 1 || injected) return;
            concurrentWriter.exec("INSERT INTO children (id, parent_id, note) VALUES (9, 1, 'concurrent committed row')");
            injected = true;
          },
        });
        assert.equal(concurrentReceipt.attempts, 2, "a concurrent commit must discard and retry the first cohort");
        assert.equal(concurrentReceipt.sourceLogicalHash, concurrentReceipt.targetLogicalHash);
        const concurrentSnapshot = new DatabaseSync(concurrentTarget, { readOnly: true });
        try {
          assert.equal(
            concurrentSnapshot.prepare("SELECT note FROM children WHERE id=9").get().note,
            "concurrent committed row",
          );
        } finally {
          concurrentSnapshot.close();
        }
      } finally {
        concurrentWriter.close();
        concurrent.db.close();
      }

      const lowSpace = makeWalFixture(root, "low-space.sqlite");
      const lowSpaceTarget = path.join(root, "backups", "must-not-exist.sqlite");
      assert.throws(
        () => snapshotDatabase(lowSpace.db, lowSpaceTarget, {
          statfs: () => ({ bavail: 0, bsize: 4096 }),
        }),
        (error) => error?.code === "SNAPSHOT_INSUFFICIENT_SPACE",
      );
      assert.equal(existsSync(lowSpaceTarget), false, "free-space failure must happen before destination creation");
      lowSpace.db.close();

      const noFallback = makeWalFixture(root, "no-fallback.sqlite");
      const impossibleTarget = path.join(root, "backups", "destination-is-a-directory.sqlite");
      mkdirSync(impossibleTarget, { recursive: true });
      const sourceHashBefore = await sha256File(noFallback.dbPath);
      assert.throws(
        () => snapshotDatabase(noFallback.db, impossibleTarget),
        (error) => error?.code === "SNAPSHOT_VACUUM_INTO_FAILED",
      );
      assert.equal(statSync(impossibleTarget).isDirectory(), true, "failure must not replace the destination with a raw copy");
      assert.equal(await sha256File(noFallback.dbPath), sourceHashBefore);
      noFallback.db.close();

      const invalidPath = path.join(root, "invalid-fk.sqlite");
      const invalid = new DatabaseSync(invalidPath);
      invalid.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
        INSERT INTO child (id, parent_id) VALUES (1, 999);
      `);
      const invalidTarget = path.join(root, "backups", "invalid-fk-backup.sqlite");
      assert.throws(
        () => snapshotDatabase(invalid, invalidTarget),
        (error) => error?.code === "SNAPSHOT_FOREIGN_KEY_CHECK_FAILED",
      );
      assert.equal(existsSync(invalidTarget), false, "an unverifiable destination must be removed");
      invalid.close();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}

runDirect(import.meta.url, run);

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureProjectionStore } from "../../lib/core/projection-store.js";
import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "6";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_NATIVE_METADATA missing typed native metadata parser";

const rowsForSource = (db, sourcePath) => db.prepare(`
  SELECT chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
         content, normalized, hash, scope, memory_type, origin_kind, linked_memory_id,
         first_seen_at, last_seen_at, status
  FROM memory_native_chunks
  WHERE source_path = ?
  ORDER BY chunk_id
`).all(sourcePath);

const currentRows = (db) => db.prepare(`
  SELECT memory_id, type, content, normalized, source, source_layer, source_path,
         source_line, scope, status
  FROM memory_current
  ORDER BY memory_id
`).all();

const makeConfig = ({ root, memoryMd, curated, lockDir }) => ({
  compat: { writeMode: "full" },
  runtime: { paths: {
    workspaceRoot: root,
    memoryRoot: path.join(root, "memory"),
    nativeLockDir: lockDir,
  } },
  native: {
    enabled: true,
    memoryMdPath: memoryMd,
    dailyNotesGlob: "memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md",
    includeFiles: [curated],
    excludeGlobs: [],
    maxChunkChars: 900,
  },
  nativePromotion: {
    enabled: true,
    promoteFromDaily: true,
    promoteFromMemoryMd: true,
    requireDailyMetadata: true,
    minConfidence: 0.72,
  },
  quality: {
    durableEnabled: true,
    durablePatternsAppend: ["always", "decision"],
    valueThresholds: { keep: 0.5, archive: 0.3, reject: 0.18 },
  },
  dedupe: { exactEnabled: true, semanticEnabled: true, autoThreshold: 0.92, reviewThreshold: 0.85 },
});

export async function run() {
  const metadata = await importContractModule("lib/compat/native-metadata.js", EXPECTED_SIGNATURE);
  const nativeSync = await importContractModule("lib/core/native-sync.js", EXPECTED_SIGNATURE);
  const promotion = await importContractModule("lib/core/native-promotion.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const parseNativeMetadata = requireCallable(metadata, "parseNativeMetadata");
    const renderNativeMetadata = requireCallable(metadata, "renderNativeMetadata");
    const classifyNativeOrigins = requireCallable(nativeSync, "classifyNativeOrigins");
    const ensureNativeStore = requireCallable(nativeSync, "ensureNativeStore");
    const queryNativeChunks = requireCallable(nativeSync, "queryNativeChunks");
    const resolveNativeSourcePaths = requireCallable(nativeSync, "resolveNativeSourcePaths");
    const syncNativeMemory = requireCallable(nativeSync, "syncNativeMemory");
    const isPromotionEligibleChunk = requireCallable(promotion, "isPromotionEligibleChunk");
    const promoteNativeChunks = requireCallable(promotion, "promoteNativeChunks");

    assert.equal(
      renderNativeMetadata({ scope: "profile:synthetic", type: "DECISION" }),
      "<!-- gigabrain:scope=profile:synthetic type=DECISION -->",
    );
    assert.deepEqual(
      parseNativeMetadata("- A governed decision. <!-- gigabrain:scope=profile:synthetic type=DECISION -->"),
      { scope: "profile:synthetic", type: "DECISION", originKind: "human_native" },
    );
    assert.deepEqual(
      parseNativeMetadata("- Structured. <!-- gigabrain:origin=structured_checkpoint --> <!-- gigabrain:scope=project:synthetic type=EPISODE -->"),
      { scope: "project:synthetic", type: "EPISODE", originKind: "structured_checkpoint" },
    );
    assert.deepEqual(
      parseNativeMetadata("- Wrong order. <!-- gigabrain:type=DECISION scope=shared -->"),
      { scope: "", type: "", originKind: "legacy_unclassified" },
    );
    assert.throws(
      () => renderNativeMetadata({ scope: "", type: "DECISION" }),
      /GIGABRAIN_NATIVE_METADATA_INVALID/,
    );
    assert.throws(
      () => renderNativeMetadata({ scope: "../../escape", type: "DECISION" }),
      /GIGABRAIN_NATIVE_METADATA_INVALID/,
    );
    assert.throws(
      () => renderNativeMetadata({ scope: "shared", type: "NOT_A_MEMORY_TYPE" }),
      /GIGABRAIN_NATIVE_METADATA_INVALID/,
    );
    for (const invalid of [
      "- Invalid scope. <!-- gigabrain:scope=../../escape type=DECISION -->",
      "- Invalid empty profile. <!-- gigabrain:scope=profile: type=DECISION -->",
      "- Invalid type. <!-- gigabrain:scope=profile:synthetic type=NOT_A_MEMORY_TYPE -->",
    ]) {
      assert.deepEqual(
        parseNativeMetadata(invalid),
        { scope: "", type: "", originKind: "legacy_unclassified" },
        "invalid scope/type metadata must remain fail-closed",
      );
    }

    const legacyDb = new DatabaseSync(":memory:");
    try {
      legacyDb.exec(`
        CREATE TABLE memory_native_chunks (
          chunk_id TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_kind TEXT NOT NULL,
          source_date TEXT, section TEXT, line_start INTEGER, line_end INTEGER,
          content TEXT NOT NULL, normalized TEXT NOT NULL, hash TEXT NOT NULL, scope TEXT,
          linked_memory_id TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE memory_native_sync_state (
          source_path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
          hash TEXT NOT NULL, last_synced_at TEXT NOT NULL
        );
        INSERT INTO memory_native_chunks (
          chunk_id, source_path, source_kind, content, normalized, hash,
          first_seen_at, last_seen_at, status
        ) VALUES ('legacy', '/fixture/memory/2026-08-20.md', 'daily_note',
          'Legacy unannotated daily memory', 'legacy unannotated daily memory', 'hash',
          '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'active');
      `);
      ensureNativeStore(legacyDb);
      ensureNativeStore(legacyDb);
      const columns = new Map(legacyDb.prepare("PRAGMA table_info(memory_native_chunks)").all().map((row) => [row.name, row]));
      assert.equal(columns.get("memory_type")?.type, "TEXT");
      assert.equal(columns.get("origin_kind")?.notnull, 1);
      assert.equal(columns.get("origin_kind")?.dflt_value, "'legacy_unclassified'");
      assert.deepEqual(
        legacyDb.prepare("SELECT memory_type, origin_kind FROM memory_native_chunks WHERE chunk_id='legacy'").get(),
        { memory_type: null, origin_kind: "legacy_unclassified" },
      );
      assert.equal(
        legacyDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_memory_native_chunks_origin_status'").get().n,
        1,
      );
    } finally {
      legacyDb.close();
    }

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-native-metadata-contract-"));
    const memoryRoot = path.join(root, "memory");
    const memoryMd = path.join(root, "MEMORY.md");
    const curated = path.join(memoryRoot, "current-projects.md");
    const dailyAnnotated = path.join(memoryRoot, "2026-08-21.md");
    const dailyUnannotated = path.join(memoryRoot, "2026-08-22.md");
    const dailyUnrelated = path.join(memoryRoot, "2026-08-23.md");
    const outside = path.join(root, "outside.md");
    const symlinked = path.join(memoryRoot, "2026-08-24.md");
    const lockDir = path.join(root, "runtime", "native-memory.lockdir");
    mkdirSync(memoryRoot, { recursive: true });
    writeFileSync(memoryMd, "# Decisions\n- Always keep the core synthetic memory contract.\n");
    writeFileSync(curated, "# Facts\n- The curated synthetic source is shared. <!-- gigabrain:scope=shared type=USER_FACT -->\n");
    writeFileSync(dailyAnnotated, "# Daily\n\n## Decisions\n- Decision: Always use the synthetic harbour control contract for every release. <!-- gigabrain:scope=profile:synthetic type=DECISION -->\n");
    writeFileSync(
      dailyUnannotated,
      "# Daily\n\n## Preferences\n- Always keep this unannotated daily preference native-only.\n- Decision: Reject the invalid type marker. <!-- gigabrain:scope=profile:synthetic type=NOT_A_MEMORY_TYPE -->\n- Decision: Reject the invalid scope marker. <!-- gigabrain:scope=../../escape type=DECISION -->\n",
    );
    writeFileSync(dailyUnrelated, "# Daily\n\n## Decisions\n- Decision: Always preserve the unrelated source unchanged. <!-- gigabrain:scope=project:unrelated type=DECISION -->\n");
    writeFileSync(outside, "- Decision: outside symlink content must never sync. <!-- gigabrain:scope=shared type=DECISION -->\n");
    symlinkSync(outside, symlinked);
    const config = makeConfig({ root, memoryMd, curated, lockDir });
    const db = new DatabaseSync(path.join(memoryRoot, "registry.sqlite"));
    try {
      ensureProjectionStore(db);
      ensureNativeStore(db);
      const resolved = resolveNativeSourcePaths(config);
      assert.equal(resolved.includes(symlinked), false, "symlinked sources must not cross native containment");
      const first = syncNativeMemory({ db, config, dryRun: false });
      assert.equal(first.changed_files, 5);

      const annotated = rowsForSource(db, dailyAnnotated)[0];
      const unannotated = rowsForSource(db, dailyUnannotated)[0];
      const curatedRow = rowsForSource(db, curated)[0];
      const coreRow = rowsForSource(db, memoryMd)[0];
      assert.deepEqual(
        { scope: annotated.scope, type: annotated.memory_type, origin: annotated.origin_kind },
        { scope: "profile:synthetic", type: "DECISION", origin: "human_native" },
      );
      assert.deepEqual(
        { scope: unannotated.scope, type: unannotated.memory_type, origin: unannotated.origin_kind },
        { scope: "profile:main", type: "PREFERENCE", origin: "legacy_unclassified" },
      );
      assert.deepEqual(
        { scope: curatedRow.scope, type: curatedRow.memory_type, origin: curatedRow.origin_kind },
        { scope: "shared", type: "USER_FACT", origin: "human_native" },
      );
      assert.deepEqual(
        { scope: coreRow.scope, type: coreRow.memory_type, origin: coreRow.origin_kind },
        { scope: "profile:main", type: "DECISION", origin: "human_native" },
      );
      assert.equal(isPromotionEligibleChunk(annotated, { config }), true);
      assert.equal(isPromotionEligibleChunk(unannotated, { config }), false);
      const invalidTypeRow = rowsForSource(db, dailyUnannotated)
        .find((row) => row.content.includes("invalid type marker"));
      const invalidScopeRow = rowsForSource(db, dailyUnannotated)
        .find((row) => row.content.includes("invalid scope marker"));
      assert.equal(invalidTypeRow.origin_kind, "legacy_unclassified");
      assert.equal(invalidScopeRow.origin_kind, "legacy_unclassified");
      assert.equal(isPromotionEligibleChunk(invalidTypeRow, { config }), false);
      assert.equal(isPromotionEligibleChunk(invalidScopeRow, { config }), false);

      assert.equal(queryNativeChunks({ db, config, query: "unannotated daily preference", scope: "profile:main", includeShared: false }).length, 1);
      for (const scope of ["profile:other", "project:other", "shared"]) {
        assert.equal(
          queryNativeChunks({ db, config, query: "unannotated daily preference", scope, includeShared: false }).length,
          0,
          `unannotated daily memory must not leak to ${scope}`,
        );
      }

      const unrelatedBefore = JSON.stringify(rowsForSource(db, dailyUnrelated));
      const unrelatedStateBefore = JSON.stringify(db.prepare("SELECT * FROM memory_native_sync_state WHERE source_path = ?").get(dailyUnrelated));
      writeFileSync(dailyAnnotated, readFileSync(dailyAnnotated, "utf8").replace("every release", "every governed release"));
      const targeted = syncNativeMemory({ db, config, sourcePaths: [dailyAnnotated], dryRun: false });
      assert.deepEqual(targeted.active_sources, [dailyAnnotated]);
      assert.equal(JSON.stringify(rowsForSource(db, dailyUnrelated)), unrelatedBefore);
      assert.equal(JSON.stringify(db.prepare("SELECT * FROM memory_native_sync_state WHERE source_path = ?").get(dailyUnrelated)), unrelatedStateBefore);

      const exactRow = rowsForSource(db, dailyAnnotated).find((row) => row.status === "active");
      db.prepare("UPDATE memory_native_chunks SET origin_kind='legacy_unclassified', memory_type=NULL WHERE chunk_id=?")
        .run(exactRow.chunk_id);
      const insertIdentityFixture = db.prepare(`
        INSERT INTO memory_native_chunks (
          chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
          content, normalized, hash, scope, memory_type, origin_kind, linked_memory_id,
          first_seen_at, last_seen_at, status
        ) VALUES (?, ?, 'daily_note', '2026-08-21', ?, ?, ?, ?, ?, ?, NULL, NULL,
          'legacy_unclassified', NULL, '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z', ?)
      `);
      insertIdentityFixture.run(
        "line-drift-active",
        dailyAnnotated,
        exactRow.section,
        exactRow.line_start,
        exactRow.line_end,
        "Stale content occupying a line that now contains governed metadata.",
        "stale content occupying a line that now contains governed metadata",
        "not-the-current-line-hash",
        "active",
      );
      insertIdentityFixture.run(
        "stale-inactive",
        dailyAnnotated,
        exactRow.section,
        exactRow.line_start,
        exactRow.line_end,
        "Inactive stale content must never be reclassified.",
        "inactive stale content must never be reclassified",
        "not-the-current-inactive-hash",
        "inactive",
      );
      const allClassificationRows = () => db.prepare(`
        SELECT chunk_id, content, normalized, hash, scope, memory_type, origin_kind, status
        FROM memory_native_chunks
        ORDER BY chunk_id
      `).all();
      const classificationRowsBefore = JSON.stringify(allClassificationRows());
      const dryClassification = classifyNativeOrigins({ db, dryRun: true });
      assert.equal(JSON.stringify(dryClassification).includes("governed release"), false, "classification summaries must never expose content");
      assert.equal(dryClassification.updated >= 1, true, "dry run must report the exact eligible change without applying it");
      assert.equal(JSON.stringify(allClassificationRows()), classificationRowsBefore, "dry-run classification must change no rows");
      const appliedClassification = classifyNativeOrigins({ db, dryRun: false });
      assert.equal(appliedClassification.counts.human_native >= 1, true);
      const classifiedRows = new Map(allClassificationRows().map((row) => [row.chunk_id, row]));
      assert.equal(classifiedRows.get(exactRow.chunk_id).origin_kind, "human_native");
      assert.equal(classifiedRows.get(exactRow.chunk_id).memory_type, "DECISION");
      for (const chunkId of ["line-drift-active", "stale-inactive"]) {
        assert.deepEqual(
          {
            memory_type: classifiedRows.get(chunkId).memory_type,
            origin_kind: classifiedRows.get(chunkId).origin_kind,
          },
          { memory_type: null, origin_kind: "legacy_unclassified" },
          `${chunkId} must not be classified without exact stored-content/hash identity`,
        );
      }
      for (const invalidRow of [invalidTypeRow, invalidScopeRow]) {
        assert.equal(classifiedRows.get(invalidRow.chunk_id).origin_kind, "legacy_unclassified");
      }

      const promoted = promoteNativeChunks({ db, config, sourcePaths: [dailyAnnotated, dailyUnannotated], dryRun: false });
      assert.equal(promoted.promoted_inserted, 1, "only the exactly annotated human daily decision may promote");
      assert.equal(promoted.rejected_or_unlinked, 0);
      const promotedId = rowsForSource(db, dailyAnnotated)[0].linked_memory_id;
      assert.ok(promotedId);
      assert.equal(rowsForSource(db, dailyUnannotated)[0].linked_memory_id, null);

      writeFileSync(dailyAnnotated, readFileSync(dailyAnnotated, "utf8")
        .replace("profile:synthetic type=DECISION", "project:repaired type=PREFERENCE"));
      syncNativeMemory({ db, config, sourcePaths: [dailyAnnotated], dryRun: false });
      const repaired = promoteNativeChunks({ db, config, sourcePaths: [dailyAnnotated], dryRun: false });
      assert.equal(repaired.repaired_links, 1);
      assert.deepEqual(
        db.prepare("SELECT type, scope, source_path FROM memory_current WHERE memory_id=?").get(promotedId),
        { type: "PREFERENCE", scope: "project:repaired", source_path: dailyAnnotated },
      );

      writeFileSync(dailyAnnotated, readFileSync(dailyAnnotated, "utf8")
        .replace(" <!-- gigabrain:scope=project:repaired type=PREFERENCE -->", ""));
      syncNativeMemory({ db, config, sourcePaths: [dailyAnnotated], dryRun: false });
      const disallowed = promoteNativeChunks({ db, config, sourcePaths: [dailyAnnotated], dryRun: false });
      assert.equal(disallowed.rejected_or_unlinked, 1);
      assert.equal(rowsForSource(db, dailyAnnotated).find((row) => row.status === "active")?.linked_memory_id, null);
      assert.equal(db.prepare("SELECT status FROM memory_current WHERE memory_id=?").get(promotedId).status, "rejected");

      unlinkSync(dailyAnnotated);
      const removed = syncNativeMemory({ db, config, sourcePaths: [dailyAnnotated], dryRun: false });
      assert.equal(removed.removed_sources, 1);
      assert.equal(JSON.stringify(rowsForSource(db, dailyUnrelated)), unrelatedBefore);
      assert.equal(currentRows(db).filter((row) => row.status === "active" && row.source_path === dailyUnannotated).length, 0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

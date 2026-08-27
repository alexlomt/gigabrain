import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { hashNormalized, normalizeContent } from "../../lib/core/policy.js";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "14";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_FULL_MIGRATION missing source-first registry migration receipt";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const migrationCliPath = path.join(repoRoot, "scripts", "migrate-v0.11-compat.js");
const gigabrainCtlPath = path.join(repoRoot, "scripts", "gigabrainctl.js");
const manifestPath = path.join(repoRoot, "config", "migration", "gigabrain-schema-0.11-compat-v1.json");
const registryShapePath = path.join(repoRoot, "config", "migration", "registry-shape-v0.7-custom.json");
const SCHEMA_ID = "gigabrain-schema-0.11-compat-v1";
const CODE_SHA = "0123456789abcdef0123456789abcdef01234567";
const SIDECAR_MIGRATION_ID = `${SCHEMA_ID}:memory-console-metadata-backfill`;
const SIDECAR_RECEIPT_CONTRACT = "gigabrain-memory-console-metadata-receipt-v1";
const SIDECAR_SCHEMA_CONTRACT = "gigabrain-memory-console-metadata-schema-v1";
const SIDECAR_ROOT_CONTRACT = "gigabrain-memory-console-metadata-logical-root-v1";
const FULL_RECEIPT_CONTRACT = "gigabrain-full-migration-receipt-v1";
const CONTENT_SENTINELS = [
  "TOP-SECRET-MIGRATION-CONTENT",
  "Café   DEAL!!! [m:deadbeef]",
  "private-source-message-17",
];
const NFKC_SENSITIVE_CONTENT = "Ｆｕｌｌｗｉｄｔｈ Café Cafe\u0301";
const UNICODE_FIXTURE_CONTENT = `${CONTENT_SENTINELS[1]} ${NFKC_SENSITIVE_CONTENT}`;
const BMP_ORDER_MARKER = "seed-order-\uE000";
const NON_BMP_ORDER_MARKER = "seed-order-😀";
const EXPECTED_SIDECAR_ROWS = [
  {
    memory_id: "seed-memory-alpha",
    concept: "seed-concept-alpha",
    source_message_id: CONTENT_SENTINELS[2],
    last_injected_at: "2001-01-03T00:00:00.000Z",
    last_confirmed_at: "2001-01-04T00:00:00.000Z",
    ttl_days: 30,
    pinned: 1,
    review_version: "seed-review-v1",
    review_reason: "seed-review-reason-alpha",
  },
  {
    memory_id: "seed-memory-unicode",
    concept: "seed-concept-unicode",
    source_message_id: "seed-message-unicode",
    last_injected_at: null,
    last_confirmed_at: null,
    ttl_days: null,
    pinned: 0,
    review_version: null,
    review_reason: null,
  },
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

// Hashes are independent literals captured from the reviewed upstream SQLite
// objects. A manifest and implementation cannot drift together unnoticed.
const EXPECTED_OBJECT_HASHES = Object.freeze({
  idx_memory_checkpoint_items_checkpoint: "e40bcfc400e45e1657034dd26912af8a02bd84729f65ff615b70814efbe7620c",
  idx_memory_checkpoints_agent_time: "e67e1a35d5b0d539ef61f0518c25e68c70904a0b05bdbfcd80adb8ac887cf0f2",
  idx_memory_checkpoints_scope_session_unique: "11b4c229774bec62d8a8208d93ef74aa4e0ecfaf41e9fb6e379301d03e93f315",
  idx_memory_checkpoints_scope_time: "6ae8c2e8293083ca114417800d3f19ae39c9c28ac3de19e9791deb4624367ddd",
  idx_memory_checkpoints_session: "57cbe2f04ce15b429b8e382344ee4cdf1140635d8352b8bd4428dd85adc897ff",
  idx_memory_claim_events_one_terminal: "1f920c86fb682b5b00d120ba0a9ab394b4b02aca4c230bf320c083093b2b5886",
  idx_memory_claim_events_proposal_time: "43305d3ccaeb5a59ce7272ceef6ef131c0393bdb1a425fca7bc875208fecd63a",
  idx_memory_claim_proposals_checkpoint: "ec4c372d8425ad2a805f0bec8df3e07739dcc0dac4cee2dd176d40aee164c5be",
  idx_memory_claim_proposals_scope_time: "187ac9756b51d782889fcc3f251b3236add276c964fc8dbd387b1781e0c3517c",
  idx_memory_cloud_inbox_state_host: "4fbf6dd0f158f589b8f25b6604bf78dddc56a1bb1bfb233c06a5b4e536a6ffe6",
  idx_memory_console_metadata_concept_pinned: "f16b25264e6b1176c30e8abe0496546660b5d4f05a4293dbc4a5b597f2c32b35",
  idx_memory_embeddings_identity: "d9c4648d40ed6c152b9598a922d3935befc70eb91274da37ceedc86b6925f81f",
  idx_memory_host_sync_cursor_host: "4a3abaeecf858e01b2cd2d84cd7fdca32b7b467e0a5134e8278a013682ca88aa",
  idx_memory_host_sync_runs_host_time: "99d9a59451e61e9f5e4d9b2480c80b449494e8393a43d147d3e8d408287de997",
  idx_memory_native_chunks_origin_status: "203ad57c43df75cf8fdbf35ec793a41ad628e438ea53edbb4704eb52e6b846c2",
  idx_memory_receipts_scope_time: "303ee1995c420321b0e9d502358b4c8b2fbb875a576ef157d1f31f44231d625b",
  idx_memory_receipts_session: "411ad6442798b2102e57f0e8fbe4e963a9e81e74f003e2f25ce3f219f9da2e85",
  idx_memory_source_links_host_status: "3d5663d22d26f315be9fea385be93e4e43b5def2102d4ffb2e60a6f797eebb9c",
  idx_memory_source_links_memory: "7ed2622fa5bbd4a60ce40e3d35199f5b04aa6fc59c116afba97a533c5dcaa041",
  idx_memory_transcript_cursor_host: "1095edf1105410817d0f820babcfe709fa4fb92a7bc5e52304a7ee80f3fd16fb",
  memory_checkpoint_items: "39411dd018e9627d554118bd5ecdb11a3ea26921998c6a980ce1b25494c2f25e",
  memory_checkpoint_items_immutable_delete: "8918bc3a87712b05591afbb4bd36cbbdf5a6ed5d725ac5488c6b474ff5e4a5c4",
  memory_checkpoint_items_immutable_update: "a12c66bde8997913e3d2f15b489145d5a80cc96c6ad42082068ce507249c231c",
  memory_checkpoints: "0bbc5cb7b9882e0d9360f0d50b84c7930eacec63c461bab87f48c2c4a23f40ff",
  memory_checkpoints_immutable_delete: "a5841e021f4a00622d749325ded42490dbffffcd321457934f9c991c6af35757",
  memory_checkpoints_immutable_update: "709d6093cc0fcb71360c7c86bfe972be8421a8786e4448fa4566483d10ca4e97",
  memory_claim_proposal_events: "04d365182dd73077cba7a3ddd19c2a7066a57cac337776d38c34b14bbaef3f16",
  memory_claim_proposal_events_immutable_delete: "1af2ac828bf7563e1d2006f51a7998066da2e6590c9ac5595a2e5c2d7da2325e",
  memory_claim_proposal_events_immutable_update: "5befac6af0c74448496b96ba8cfc47ac161451097a327fb812b9682665d8d977",
  memory_claim_proposals: "b8e9beb494e1799b1f6e8ac1a1d588b85257cc4fda288c72f927723dc6f66a5f",
  memory_claim_proposals_immutable_delete: "6fa850924e1a7107aea2c04c17caed583a3b115489985df495d00a73eb900c82",
  memory_claim_proposals_immutable_update: "9ffc980115b5872c75f69a69e51fa07d44a68b61f5aad2af2af543bad9c61ceb",
  memory_cloud_inbox_state: "b640b52b2232e228c031e13083501b77215bf7beadecbf6edf803768bff778c4",
  memory_console_metadata: "7eba53a742252bbe6c735a091ea458485500eaab9af27996cbb03d40e11afcb3",
  memory_host_sync_cursor: "4dc4df7392e62cf85ad82607d5bf4ccc002bef92147b06a96fdf7d44316f230b",
  memory_host_sync_runs: "b5707a694af751b3798c1e68b9158a77d3baca915d54bc99edb3a621e43ad6f0",
  memory_host_trust: "9a3b4790667bd8f65f992dac3afce76a60d022456f4080a6e53af1d2a3213d17",
  memory_native_chunk_embeddings: "5c08c1c0be115d6b7a7685ba65a764393e2885277660e40f35162168ec9f67cd",
  memory_receipts: "9e8f5b6d9255505cd7707cb021ea7f165c0d6d8dd5b08fab2b4ee9928a856119",
  memory_receipts_immutable_delete: "0e144e62d71451beffeaec82dcb4e66c29b490d6263bebf63a270895f518ff76",
  memory_receipts_immutable_update: "e670e3ea1828525b240d48b835f3a37a0992e45335e4d4f1170ef75cc1d21852",
  memory_schema_migrations: "38fc6cf04ab93c0e0393fc9667e1fad20bf31215a061537bba4b1c434000ca4f",
  memory_source_links: "88d51104bfb00a6a615eda22dd1c5d3949142c05aa162663d4540a948297f228",
  memory_transcript_sync_cursor: "daa242095955f6fbb8599e6b06c69764dce89c402b432b9519fc40fa520f2ca8",
});

const EXPECTED_COLUMNS = Object.freeze({
  "memory_current.valid_from": Object.freeze({ definition: "TEXT", disposition: "existing_validate_backfill_created_at" }),
  "memory_embeddings.model_fingerprint": Object.freeze({ definition: "TEXT", disposition: "additive_nullable" }),
  "memory_events.agent_id": Object.freeze({ definition: "TEXT", disposition: "existing_validate" }),
  "memory_native_chunks.memory_type": Object.freeze({ definition: "TEXT", disposition: "existing_validate" }),
  "memory_native_chunks.origin_kind": Object.freeze({
    definition: "TEXT NOT NULL DEFAULT 'legacy_unclassified'",
    disposition: "additive_default",
  }),
});
const EXPECTED_POST_ALTER_TABLE_HASHES = Object.freeze({
  memory_embeddings: "a477a57d37ab7fd7d3e12c94bf59d964654fec04a0f2891f56495345f5d7fead",
  memory_native_chunks: "88692f39387c1ecb9cb017b74502e209d8a9338ee8eb5e994ebd8386106bfcc1",
});

const normalizedTableXinfo = (rows) => rows.map((row) => ({
  cid: Number(row.cid),
  name: String(row.name),
  type: String(row.type || ""),
  notnull: Number(row.notnull),
  dflt_value: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
  pk: Number(row.pk),
  hidden: Number(row.hidden || 0),
}));

const typedValue = (storageType, value) => {
  if (storageType === "null") return ["null"];
  if (storageType === "blob") return ["blob", Buffer.from(value).toString("hex")];
  if (storageType === "integer") return ["integer", String(value)];
  if (storageType === "real") return ["real", Object.is(value, -0) ? "-0" : String(value)];
  return ["text", String(value)];
};

const changedRootKeys = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((key) => before[key] !== after[key])
  .sort(binaryCompare);

const openReadOnly = (dbPath) => new DatabaseSync(dbPath, { readOnly: true });

const captureLogicalState = (dbOrPath, shape = null) => {
  const ownsDb = typeof dbOrPath === "string";
  const db = ownsDb ? openReadOnly(dbOrPath) : dbOrPath;
  try {
    const tableNames = shape?.tableNames || db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type='table' AND name NOT LIKE 'memory_schema_migrations'
      ORDER BY name COLLATE BINARY
    `).all().map((row) => String(row.name));
    const columnsByTable = {};
    const tableRoots = {};
    const columnRoots = {};
    for (const tableName of tableNames) {
      const allColumns = db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`).all()
        .map((row) => String(row.name));
      const columns = shape?.columnsByTable?.[tableName] || allColumns;
      assert.equal(columns.every((column) => allColumns.includes(column)), true, `old columns missing from ${tableName}`);
      columnsByTable[tableName] = columns;
      if (columns.length === 0) continue;
      const select = columns.flatMap((column, index) => [
        `typeof(${quoteIdentifier(column)}) AS ${quoteIdentifier(`__type_${index}`)}`,
        `${quoteIdentifier(column)} AS ${quoteIdentifier(`__value_${index}`)}`,
      ]).join(", ");
      const encodedRows = db.prepare(`SELECT ${select} FROM ${quoteIdentifier(tableName)}`).all().map((row) => (
        columns.map((column, index) => [column, typedValue(row[`__type_${index}`], row[`__value_${index}`])])
      ));
      encodedRows.sort((left, right) => binaryCompare(canonicalJson(left), canonicalJson(right)));
      tableRoots[tableName] = sha256(canonicalJson(encodedRows));
      for (let index = 0; index < columns.length; index += 1) {
        const values = encodedRows.map((row) => row[index][1]).sort((left, right) => (
          binaryCompare(canonicalJson(left), canonicalJson(right))
        ));
        columnRoots[`${tableName}.${columns[index]}`] = sha256(canonicalJson(values));
      }
    }
    const schemaObjects = db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE tbl_name NOT LIKE 'memory_schema_migrations%'
      ORDER BY type COLLATE BINARY, name COLLATE BINARY
    `).all().map((row) => ({
      name: String(row.name),
      sqlSha256: row.sql === null || row.sql === undefined ? null : sha256(String(row.sql)),
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
    return {
      columnRoots,
      columnsByTable,
      pragmas,
      schemaObjects,
      tableNames,
      tableRoots,
      root: sha256(canonicalJson({ columnRoots, pragmas, schemaObjects, tableRoots })),
    };
  } finally {
    if (ownsDb) db.close();
  }
};

const validateRegistryShape = (shape) => {
  assert.deepEqual(Object.keys(shape), [
    "contentFree", "contract", "createStatements", "manifestSha256", "objects", "schemaVersion", "source", "tables",
  ]);
  assert.equal(shape.schemaVersion, 1);
  assert.equal(shape.contract, "gigabrain-registry-shape-v0.7-custom/1");
  assert.equal(shape.contentFree, true);
  assert.equal(shape.source.schemaOnly, true);
  assert.equal(shape.source.tableCount, 28);
  assert.deepEqual(Object.keys(shape.source), ["schemaOnly", "tableCount", "version"]);
  assert.equal(shape.tables.length, 28);
  assert.equal(shape.objects.length, 93);
  const { manifestSha256, schemaVersion, ...body } = shape;
  assert.equal(manifestSha256, sha256(canonicalJson(body)));
  assert.deepEqual(shape.tables.map((row) => row.name), [...shape.tables.map((row) => row.name)].sort(binaryCompare));
  assert.deepEqual(
    shape.objects.map((row) => `${row.type}\0${row.name}`),
    [...shape.objects.map((row) => `${row.type}\0${row.name}`)].sort(binaryCompare),
  );
  for (const object of shape.objects) {
    assert.deepEqual(Object.keys(object), ["name", "sql", "sqlSha256", "table", "type"]);
    assert.equal(object.sqlSha256, object.sql === null ? null : sha256(object.sql));
  }
  for (const table of shape.tables) {
    assert.deepEqual(Object.keys(table), ["columns", "name", "sql"]);
    assert.equal(new Set(table.columns.map((column) => column.name)).size, table.columns.length);
    for (const column of table.columns) {
      assert.deepEqual(Object.keys(column), ["cid", "dflt_value", "hidden", "name", "notnull", "pk", "type"]);
    }
  }
  assert.equal(shape.createStatements.every((statement) => typeof statement === "string" && statement.trim() === statement), true);
  const forbiddenDataKeys = new Set(["data", "records", "row", "rows", "seed", "seedData", "values"]);
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenDataKeys.has(key), false, `registry shape raw-data key: ${key}`);
      visit(child);
    }
  };
  visit(shape);
  const columnNames = new Map(shape.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
  for (const [table, column] of [
    ["memory_console_metadata", "review_reason"],
    ["memory_current", "valid_from"],
    ["memory_events", "agent_id"],
    ["memory_native_chunks", "memory_type"],
  ]) assert.equal(columnNames.get(table)?.has(column), true, `${table}.${column} must pre-exist`);
  assert.equal(columnNames.get("memory_native_chunks")?.has("origin_kind"), false);
  assert.equal(columnNames.get("memory_embeddings")?.has("model_fingerprint"), false);
  const shapeText = JSON.stringify(shape);
  for (const sentinel of [...CONTENT_SENTINELS, NFKC_SENSITIVE_CONTENT, BMP_ORDER_MARKER, NON_BMP_ORDER_MARKER]) {
    assert.equal(shapeText.includes(sentinel), false, "registry shape must contain schema only");
  }
  return shape;
};

const expectedPostAlterXinfo = (shape, tableName) => {
  const base = structuredClone(shape.tables.find((table) => table.name === tableName).columns);
  if (tableName === "memory_embeddings") {
    base.push({ cid: base.length, name: "model_fingerprint", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 });
  } else if (tableName === "memory_native_chunks") {
    base.push({
      cid: base.length, name: "origin_kind", type: "TEXT", notnull: 1,
      dflt_value: "'legacy_unclassified'", pk: 0, hidden: 0,
    });
  }
  return base;
};

const markerValue = (table, column, type, suffix, markers) => {
  const marker = `seed:${table}:${column}:${suffix}`;
  if (/BLOB/i.test(type)) {
    const value = Buffer.from(`blob:${marker}`, "utf8");
    markers.add(value.toString("hex"));
    markers.add(`blob:${marker}`);
    return value;
  }
  if (/INT/i.test(type)) return 1;
  if (/REAL|FLOA|DOUB/i.test(type)) return 0.125;
  markers.add(marker);
  return marker;
};

const insertShapeRow = (db, table, overrides, suffix, markers) => {
  const columns = db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all()
    .filter((column) => Number(column.hidden || 0) === 0);
  const values = columns.map((column) => {
    if (Object.hasOwn(overrides, column.name)) return overrides[column.name];
    if (Number(column.pk) === 1 && /INT/i.test(String(column.type || ""))) return null;
    return markerValue(table, String(column.name), String(column.type || ""), suffix, markers);
  });
  for (const value of values) {
    if (typeof value === "string" && value.length >= 4) markers.add(value);
    if (Buffer.isBuffer(value)) {
      markers.add(value.toString("hex"));
      markers.add(value.toString("utf8"));
    }
  }
  db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columns.map((column) => quoteIdentifier(column.name)).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...values);
};

const createLegacyWalFixture = (dbPath, shape) => {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(dbPath), 0o700);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON; PRAGMA application_id=1195987534; PRAGMA user_version=7;");
  for (const statement of shape.createStatements) db.exec(statement);
  const markers = new Set(CONTENT_SENTINELS);
  markers.add(NFKC_SENSITIVE_CONTENT);
  const alphaId = "seed-memory-alpha";
  const unicodeId = "seed-memory-unicode";
  const alphaContent = CONTENT_SENTINELS[0];
  const unicodeContent = UNICODE_FIXTURE_CONTENT;
  const legacyCommon = {
    status: "active",
    source: "seed-source-registry",
    source_agent: "seed-agent-main",
    source_session: "seed-session-task14",
    source_layer: "registry",
    source_host: "seed-host-main",
    source_kind: "registry",
    sync_policy: "read_only",
  };
  insertShapeRow(db, "memories", {
    ...legacyCommon, id: alphaId, type: "USER_FACT", content: alphaContent,
    normalized: "seed-wrong-normalized-alpha", source_message_id: CONTENT_SENTINELS[2],
    confidence: 0.875, scope: "project:legacy", tags: '["seed-tag-alpha"]',
    created_at: "2001-01-01T00:00:00.000Z", updated_at: "2001-01-02T00:00:00.000Z",
    last_injected_at: "2001-01-03T00:00:00.000Z", last_confirmed_at: "2001-01-04T00:00:00.000Z",
    ttl_days: 30, pinned: 1, concept: "seed-concept-alpha", review_version: "seed-review-v1",
    review_reason: "seed-review-reason-alpha",
  }, "alpha", markers);
  insertShapeRow(db, "memories", {
    ...legacyCommon, id: unicodeId, type: "DECISION", content: unicodeContent,
    normalized: "seed-wrong-normalized-unicode", source_message_id: "seed-message-unicode",
    confidence: 0.75, scope: "project:legacy", tags: '["seed-tag-unicode"]',
    created_at: null, updated_at: "2001-02-02T00:00:00.000Z", last_injected_at: null,
    last_confirmed_at: null, ttl_days: null, pinned: 0, concept: "seed-concept-unicode",
    review_version: null, review_reason: null,
  }, "unicode", markers);
  insertShapeRow(db, "memory_current", {
    ...legacyCommon, memory_id: alphaId, type: "USER_FACT", content: alphaContent,
    normalized: "seed-current-wrong-alpha", normalized_hash: "0".repeat(64), confidence: 0.875,
    scope: "profile:main", tags: '["seed-tag-alpha"]', created_at: "2001-01-01T00:00:00.000Z",
    updated_at: "2001-01-06T00:00:00.000Z", valid_from: null,
  }, "alpha", markers);
  insertShapeRow(db, "memory_current", {
    ...legacyCommon, memory_id: unicodeId, type: "DECISION", content: unicodeContent,
    normalized: "seed-current-wrong-unicode", normalized_hash: "f".repeat(64), confidence: 0.75,
    scope: "profile:main", tags: '["seed-tag-unicode"]', created_at: null,
    updated_at: "2001-02-02T00:00:00.000Z", valid_from: null,
  }, "unicode", markers);
  insertShapeRow(db, "memory_console_metadata", {
    memory_id: alphaId, concept: "seed-concept-alpha", source_message_id: CONTENT_SENTINELS[2],
    last_injected_at: "2001-01-03T00:00:00.000Z", last_confirmed_at: "2001-01-04T00:00:00.000Z",
    ttl_days: 30, pinned: 1, review_version: "seed-review-v1", review_reason: "seed-review-reason-alpha",
  }, "alpha", markers);
  insertShapeRow(db, "memory_events", {
    event_id: "seed-event-before", timestamp: "2001-01-01T00:00:00.000Z", component: "seed-component",
    action: "seed-captured", reason_codes: '["seed-reason"]', memory_id: alphaId,
    cleanup_version: "seed-v0.7.1", run_id: "seed-run-before", review_version: "seed-review",
    payload: '{"seed":true}', agent_id: "seed-agent-preexisting",
  }, "before", markers);
  insertShapeRow(db, "memory_native_chunks", {
    chunk_id: "seed-chunk-before", source_path: "/seed/native.md", source_kind: "daily_note",
    content: "seed-native-content", normalized: "seed-native-content", hash: sha256("seed-native-content"),
    scope: "profile:main", first_seen_at: "2001-01-01T00:00:00.000Z",
    last_seen_at: "2001-01-01T00:00:00.000Z", status: "active", memory_type: "DECISION",
  }, "before", markers);
  insertShapeRow(db, "memory_embeddings", {
    memory_id: alphaId, model: "qwen3-embedding:4b", embedding: Buffer.from("blob:seed-embedding", "utf8"),
    dims: 2560, computed_at: "2001-01-01T00:00:00.000Z",
  }, "before", markers);
  const special = new Set(["memories", "memory_current", "memory_console_metadata", "memory_events", "memory_native_chunks", "memory_embeddings", "memory_fts"]);
  for (const table of shape.tables.map((row) => row.name)) {
    if (special.has(table) || table === "sqlite_sequence" || table.startsWith("memory_fts_")) continue;
    insertShapeRow(db, table, {}, "all-columns", markers);
  }
  insertShapeRow(db, "memory_fts", {
    memory_id: alphaId, content: alphaContent, normalized: "seed-fts-normalized", type: "USER_FACT",
  }, "fts", markers);
  insertShapeRow(db, "documents", { id: BMP_ORDER_MARKER }, "bmp-order", markers);
  insertShapeRow(db, "documents", { id: NON_BMP_ORDER_MARKER }, "non-bmp-order", markers);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  insertShapeRow(db, "documents", { id: "seed-document-wal" }, "wal-only", markers);
  chmodSync(dbPath, 0o600);
  assert.equal(existsSync(`${dbPath}-wal`), true, "fixture must carry an uncheckpointed WAL row");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table'").get().c, 28);
  return { db, markers: [...markers].filter((marker) => marker.length >= 4).sort(binaryCompare) };
};

const writeConfig = (configPath, registryPath, workspaceRoot) => {
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, canonicalJson({
    plugins: { entries: { gigabrain: { enabled: true, config: {
      compat: { writeMode: "full" },
      runtime: { paths: { registryPath, workspaceRoot } },
    } } } },
  }), { mode: 0o600 });
};

const writeRelease = (releasePath, schemaChecksum = "0".repeat(64)) => {
  writeFileSync(releasePath, canonicalJson({
    code_sha: CODE_SHA,
    schema_checksum: schemaChecksum,
    schema_id: SCHEMA_ID,
  }), { mode: 0o600 });
};

const runMigrationCli = (args, options = {}) => spawnSync(process.execPath, [migrationCliPath, ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C", TZ: "UTC", ...options.env },
  maxBuffer: 16 * 1024 * 1024,
  stdio: options.stdio || ["ignore", "pipe", "pipe"],
  timeout: 30_000,
});

const runGigabrainCtl = (args) => spawnSync(process.execPath, [gigabrainCtlPath, ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  maxBuffer: 8 * 1024 * 1024,
  timeout: 30_000,
});

const parseSuccessfulCli = (result) => {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const assertContentFree = (value, label, markers = CONTENT_SENTINELS) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of markers) assert.equal(text.includes(marker), false, `${label} leaked seeded value`);
};

const validateManifest = (manifest) => {
  assert.deepEqual(Object.keys(manifest), ["columns", "manifestSha256", "objects", "schemaId", "schemaVersion"]);
  assert.equal(manifest.schemaId, SCHEMA_ID);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(Array.isArray(manifest.objects), true);
  assert.equal(Array.isArray(manifest.columns), true);
  const payload = { ...manifest };
  delete payload.manifestSha256;
  assert.equal(manifest.manifestSha256, sha256(canonicalJson(payload)));
  const expectedObjectNames = Object.keys(EXPECTED_OBJECT_HASHES).sort(binaryCompare);
  assert.equal(new Set(manifest.objects.map((row) => row.name)).size, manifest.objects.length, "manifest object names must be unique");
  assert.deepEqual(manifest.objects.map((row) => row.name), expectedObjectNames, "manifest object set must be exact");
  const objects = new Map(manifest.objects.map((row) => [row.name, row]));
  for (const [name, expectedHash] of Object.entries(EXPECTED_OBJECT_HASHES)) {
    const object = objects.get(name);
    assert.deepEqual(Object.keys(object), ["disposition", "name", "sql", "sqlSha256", "type"]);
    assert.equal(sha256(object.sql), object.sqlSha256, `${name} manifest SQL must recompute`);
    assert.equal(object.sqlSha256, expectedHash, `${name} manifest SQL hash`);
  }
  assert.equal(new Set(manifest.columns.map((row) => `${row.table}.${row.name}`)).size, manifest.columns.length);
  assert.deepEqual(
    manifest.columns.map((row) => `${row.table}.${row.name}`),
    Object.keys(EXPECTED_COLUMNS).sort(binaryCompare),
    "manifest column set must reject extras and omissions",
  );
  for (const row of manifest.columns) {
    assert.deepEqual(Object.keys(row), ["definition", "disposition", "name", "table"]);
    assert.deepEqual({ definition: row.definition, disposition: row.disposition }, EXPECTED_COLUMNS[`${row.table}.${row.name}`]);
  }
};

const sqliteObjectHashes = (db) => Object.fromEntries(db.prepare(`
  SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name
`).all().map((row) => [String(row.name), sha256(String(row.sql))]));

const task14SchemaEvidence = (db) => {
  const schemaRow = db.prepare("SELECT sql FROM sqlite_schema WHERE type=? AND name=?");
  const evidence = {
    contract: SIDECAR_SCHEMA_CONTRACT,
    table: {
      name: "memory_console_metadata",
      sql: String(schemaRow.get("table", "memory_console_metadata")?.sql || ""),
      columns: db.prepare("PRAGMA table_info(memory_console_metadata)").all().map((row) => ({
        cid: Number(row.cid), name: String(row.name || ""), type: String(row.type || ""),
        notnull: Number(row.notnull),
        dflt_value: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
        pk: Number(row.pk),
      })),
    },
    index: {
      name: "idx_memory_console_metadata_concept_pinned",
      sql: String(schemaRow.get("index", "idx_memory_console_metadata_concept_pinned")?.sql || ""),
      columns: db.prepare("PRAGMA index_info(idx_memory_console_metadata_concept_pinned)").all().map((row) => ({
        seqno: Number(row.seqno), cid: Number(row.cid), name: String(row.name || ""),
      })),
    },
  };
  return { hash: sha256(JSON.stringify(evidence)), evidence };
};

const task14MetadataEvidence = (db) => {
  const normalize = (row) => ({
    memory_id: String(row.memory_id || ""),
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
    metadata_roots: { legacy_sha256: root(legacy), sidecar_sha256: root(sidecar) },
    rows: { legacy, sidecar },
  };
};

const expectedLedgerReceipt = (db) => {
  const metadata = task14MetadataEvidence(db);
  return {
    contract: SIDECAR_RECEIPT_CONTRACT,
    migration_id: SIDECAR_MIGRATION_ID,
    status: "completed",
    schema_hash: task14SchemaEvidence(db).hash,
    counts: metadata.counts,
    metadata_roots: metadata.metadata_roots,
  };
};

const assertExactKeys = (value, expected, label) => {
  assert.deepEqual(Object.keys(value), [...expected].sort(binaryCompare), `${label} exact keys`);
};

const assertReconcileReceipt = ({ path: receiptPath, mode, corrected, eventAction, markers }) => {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(receiptPath).nlink, 1);
  assertExactKeys(receipt, [
    "allowed_deltas", "before_root", "contract", "corrected", "event_count", "mode",
    "receipt_sha256", "status",
  ], `${mode} receipt`);
  assert.equal(receipt.contract, "gigabrain-reconcile-receipt-v1");
  assert.equal(receipt.mode, mode);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.corrected, corrected);
  assert.equal(receipt.event_count, corrected);
  assert.match(receipt.before_root, /^[0-9a-f]{64}$/);
  assertExactKeys(receipt.allowed_deltas, ["columns", "event_action", "tables"], `${mode} allowed deltas`);
  assert.equal(receipt.allowed_deltas.event_action, eventAction);
  const body = { ...receipt };
  delete body.receipt_sha256;
  assert.equal(receipt.receipt_sha256, sha256(canonicalJson(body)));
  assertContentFree(receipt, `${mode} receipt`, markers);
  return receipt;
};

const assertIntegrity = (db) => {
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
};

const normalizedFixtureValue = (value) => normalizeContent(value);

const snapshotFiles = (root) => readdirSync(root).sort(binaryCompare).map((name) => {
  const filePath = path.join(root, name);
  const stat = lstatSync(filePath);
  return {
    hash: stat.isFile() ? sha256(readFileSync(filePath)) : null,
    mode: stat.mode & 0o777,
    name,
    type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "special",
  };
});

export async function run() {
  assert.equal(existsSync(registryShapePath), true, "content-free v0.7 registry shape must exist");
  const registryShape = validateRegistryShape(JSON.parse(readFileSync(registryShapePath, "utf8")));
  assert.deepEqual([NON_BMP_ORDER_MARKER, BMP_ORDER_MARKER].sort(binaryCompare), [BMP_ORDER_MARKER, NON_BMP_ORDER_MARKER]);
  assert.notDeepEqual([NON_BMP_ORDER_MARKER, BMP_ORDER_MARKER].sort(), [BMP_ORDER_MARKER, NON_BMP_ORDER_MARKER]);
  const fixturePreflightRoot = mkdtempSync(path.join(tmpdir(), "gigabrain-task14-shape-preflight-"));
  try {
    chmodSync(fixturePreflightRoot, 0o700);
    const fixture = createLegacyWalFixture(path.join(fixturePreflightRoot, "registry.sqlite"), registryShape);
    const state = captureLogicalState(fixture.db);
    assert.equal(state.tableNames.length, 28);
    assert.equal(Object.keys(state.columnRoots).length, registryShape.tables.reduce((count, table) => count + table.columns.length, 0));
    assert.equal(fixture.markers.length > 100, true, "fixture must seed every production column with leak-detectable markers");
    assert.deepEqual(
      fixture.db.prepare("SELECT id FROM documents WHERE id LIKE 'seed-order-%' ORDER BY id COLLATE BINARY").all().map((row) => row.id),
      [BMP_ORDER_MARKER, NON_BMP_ORDER_MARKER],
    );
    fixture.db.close();
  } finally {
    rmSync(fixturePreflightRoot, { recursive: true, force: true });
  }
  const migration = await importContractModule("scripts/migrate-v0.11-compat.js", EXPECTED_SIGNATURE);
  const audit = await importContractModule("lib/compat/migration-audit.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const assertSafeCandidateDatabase = requireCallable(migration, "assertSafeCandidateDatabase");
    const migrateCandidateDatabase = requireCallable(migration, "migrateCandidateDatabase");
    const reconcileLegacyProjection = requireCallable(migration, "reconcileLegacyProjection");
    const reconcileNormalizedHashes = requireCallable(migration, "reconcileNormalizedHashes");
    const auditRegistryPair = requireCallable(audit, "auditRegistryPair");
    assert.equal(existsSync(manifestPath), true, "reviewed schema manifest must exist");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    validateManifest(manifest);
    for (const [label, mutate] of [
      ["duplicate-object", (value) => value.objects.splice(1, 0, structuredClone(value.objects[0]))],
      ["missing-object", (value) => value.objects.pop()],
      ["extra-object", (value) => value.objects.push({ disposition: "additive", name: "unexpected_object", sql: "CREATE TABLE unexpected_object(id TEXT)", sqlSha256: sha256("CREATE TABLE unexpected_object(id TEXT)"), type: "table" })],
      ["sql-hash", (value) => { value.objects[0].sqlSha256 = "0".repeat(64); }],
      ["duplicate-column", (value) => value.columns.splice(1, 0, structuredClone(value.columns[0]))],
      ["missing-column", (value) => value.columns.pop()],
      ["extra-column", (value) => value.columns.push({ definition: "TEXT", disposition: "additive", name: "unexpected", table: "memory_current" })],
    ]) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      const body = { ...candidate };
      delete body.manifestSha256;
      candidate.manifestSha256 = sha256(canonicalJson(body));
      assert.throws(() => validateManifest(candidate), undefined, label);
    }

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task14-migration-"));
    chmodSync(root, 0o700);
    let writer = null;
    let seedMarkers = [];
    try {
      const livePath = path.join(root, "production-sentinel.sqlite");
      const live = new DatabaseSync(livePath);
      live.exec("CREATE TABLE sentinel(id INTEGER PRIMARY KEY, note TEXT); INSERT INTO sentinel VALUES(1,'live untouched')");
      live.close();
      chmodSync(livePath, 0o600);
      const liveBefore = sha256(readFileSync(livePath));
      const runDir = path.join(root, "candidate-run");
      mkdirSync(runDir, { mode: 0o700 });
      const candidatePath = path.join(runDir, "candidate.sqlite");
      const fixture = createLegacyWalFixture(candidatePath, registryShape);
      writer = fixture.db;
      seedMarkers = fixture.markers;
      const before = captureLogicalState(writer);
      assert.equal(before.tableNames.length, 28);
      assert.equal(Object.keys(before.columnRoots).length, registryShape.tables.reduce((count, table) => count + table.columns.length, 0));
      const configPath = path.join(root, "openclaw.json");
      writeConfig(configPath, livePath, root);
      const releasePath = path.join(runDir, "RELEASE.json");
      writeRelease(releasePath, manifest.manifestSha256);
      const receiptPath = path.join(runDir, "schema-only.receipt.json");

      const rejectedProduction = runMigrationCli([
        "--apply-production", "--db", candidatePath, "--config", configPath,
      ]);
      assert.notEqual(rejectedProduction.status, 0);
      assert.match(`${rejectedProduction.stderr}${rejectedProduction.stdout}`, /production|unsupported|usage/i);
      assert.deepEqual(captureLogicalState(writer), before);
      assert.equal(existsSync(receiptPath), false);

      const migrationResult = parseSuccessfulCli(runMigrationCli([
        "--schema-only", "--db", candidatePath, "--config", configPath,
        "--run-dir", runDir, "--release", releasePath, "--receipt", receiptPath,
      ]));
      assert.deepEqual({
        changed: migrationResult.changed,
        codeSha: migrationResult.code_sha,
        ok: migrationResult.ok,
        schemaChecksum: migrationResult.schema_checksum,
        schemaId: migrationResult.schema_id,
      }, {
        changed: true,
        codeSha: CODE_SHA,
        ok: true,
        schemaChecksum: manifest.manifestSha256,
        schemaId: SCHEMA_ID,
      });
      assertContentFree(migrationResult, "schema-only stdout", seedMarkers);
      assert.equal(sha256(readFileSync(livePath)), liveBefore, "live database bytes must remain untouched");

      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
      assert.equal(lstatSync(receiptPath).nlink, 1);
      assertExactKeys(receipt, [
        "backup", "code_sha", "contract", "database_identity", "ledger", "receipt_sha256",
        "schema_checksum", "schema_id", "status",
      ], "full migration receipt");
      assert.equal(receipt.contract, FULL_RECEIPT_CONTRACT);
      assert.equal(receipt.schema_id, SCHEMA_ID);
      assert.equal(receipt.schema_checksum, manifest.manifestSha256);
      assert.equal(receipt.code_sha, CODE_SHA);
      assert.equal(receipt.status, "completed");
      assertExactKeys(receipt.backup, ["path", "sha256"], "backup receipt field");
      assertExactKeys(receipt.database_identity, ["dev", "ino"], "database identity field");
      assertExactKeys(receipt.ledger, ["migration_id", "receipt_hash", "schema_hash"], "ledger receipt field");
      assert.match(receipt.receipt_sha256, /^[0-9a-f]{64}$/);
      assertContentFree(receipt, "schema-only receipt", seedMarkers);
      const receiptBody = { ...receipt };
      delete receiptBody.receipt_sha256;
      assert.equal(receipt.receipt_sha256, sha256(canonicalJson(receiptBody)));
      assert.equal(existsSync(receipt.backup.path), true);
      assert.equal(receipt.backup.sha256, sha256(readFileSync(receipt.backup.path)));
      assert.equal(lstatSync(receipt.backup.path).mode & 0o777, 0o600);
      assert.notEqual(statSync(receipt.backup.path).ino, statSync(candidatePath).ino);
      assert.deepEqual(captureLogicalState(receipt.backup.path, before), before, "consistent backup must include WAL-only rows");

      const migrated = new DatabaseSync(candidatePath);
      try {
        assertIntegrity(migrated);
        const oldAfter = captureLogicalState(migrated, before);
        const allowedChangedColumns = new Set([
          "memory_console_metadata.memory_id", "memory_console_metadata.concept",
          "memory_console_metadata.source_message_id", "memory_console_metadata.last_injected_at",
          "memory_console_metadata.last_confirmed_at", "memory_console_metadata.ttl_days",
          "memory_console_metadata.pinned", "memory_console_metadata.review_version",
          "memory_console_metadata.review_reason", "memory_current.valid_from",
        ]);
        assert.deepEqual(
          Object.fromEntries(Object.entries(oldAfter.columnRoots).filter(([key]) => !allowedChangedColumns.has(key))),
          Object.fromEntries(Object.entries(before.columnRoots).filter(([key]) => !allowedChangedColumns.has(key))),
        );
        assert.deepEqual(
          Object.fromEntries(Object.entries(oldAfter.tableRoots).filter(([key]) => !["memory_console_metadata", "memory_current"].includes(key))),
          Object.fromEntries(Object.entries(before.tableRoots).filter(([key]) => !["memory_console_metadata", "memory_current"].includes(key))),
        );
        assert.deepEqual(oldAfter.pragmas, before.pragmas);
        const objectHashes = sqliteObjectHashes(migrated);
        for (const [name, expectedHash] of Object.entries(EXPECTED_OBJECT_HASHES)) {
          assert.equal(objectHashes[name], expectedHash, `${name} sqlite_schema hash`);
        }
        for (const [tableName, expectedHash] of Object.entries(EXPECTED_POST_ALTER_TABLE_HASHES)) {
          const tableSql = String(migrated.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(tableName)?.sql || "");
          assert.equal(sha256(tableSql), expectedHash, `${tableName} exact post-ALTER table SQL`);
          assert.deepEqual(
            normalizedTableXinfo(migrated.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`).all()),
            expectedPostAlterXinfo(registryShape, tableName),
            `${tableName} exact post-ALTER table_xinfo`,
          );
        }
        assert.deepEqual(migrated.prepare(`
          SELECT memory_id, concept, source_message_id, last_injected_at, last_confirmed_at,
                 ttl_days, pinned, review_version, review_reason
          FROM memory_console_metadata ORDER BY memory_id
        `).all().map((row) => ({ ...row })), EXPECTED_SIDECAR_ROWS);
        assert.deepEqual(migrated.prepare("SELECT memory_id, valid_from FROM memory_current ORDER BY memory_id COLLATE BINARY").all().map((row) => ({ ...row })), [
          { memory_id: "seed-memory-alpha", valid_from: "2001-01-01T00:00:00.000Z" },
          { memory_id: "seed-memory-unicode", valid_from: null },
        ]);
        assert.equal(migrated.prepare("SELECT agent_id FROM memory_events WHERE event_id='seed-event-before'").get().agent_id, "seed-agent-preexisting");
        assert.deepEqual({ ...migrated.prepare("SELECT memory_type,origin_kind FROM memory_native_chunks WHERE chunk_id='seed-chunk-before'").get() }, {
          memory_type: "DECISION",
          origin_kind: "legacy_unclassified",
        });
        assert.equal(migrated.prepare("SELECT model_fingerprint FROM memory_embeddings WHERE memory_id='seed-memory-alpha'").get().model_fingerprint, null);
        const featureTables = [
          "memory_checkpoint_items", "memory_checkpoints", "memory_claim_proposal_events", "memory_claim_proposals",
          "memory_cloud_inbox_state", "memory_host_sync_cursor", "memory_host_sync_runs", "memory_host_trust",
          "memory_native_chunk_embeddings", "memory_receipts", "memory_source_links", "memory_transcript_sync_cursor",
        ];
        for (const table of featureTables) assert.equal(migrated.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}`).get().c, 0, `${table} schema-only population`);
        const beforeSchema = new Map(before.schemaObjects.map((row) => [`${row.type}\0${row.name}`, row]));
        const afterSchema = new Map(oldAfter.schemaObjects.map((row) => [`${row.type}\0${row.name}`, row]));
        for (const [key, row] of beforeSchema) {
          if (["table\0memory_embeddings", "table\0memory_native_chunks"].includes(key)) {
            const tableName = key.split("\0")[1];
            assert.equal(afterSchema.get(key)?.sqlSha256, EXPECTED_POST_ALTER_TABLE_HASHES[tableName]);
            assert.notEqual(afterSchema.get(key)?.sqlSha256, row.sqlSha256);
            continue;
          }
          assert.deepEqual(afterSchema.get(key), row, `old schema object changed: ${key}`);
        }
        const explicitAllowed = new Set(Object.keys(EXPECTED_OBJECT_HASHES));
        const newFeatureTables = new Set(featureTables);
        for (const row of oldAfter.schemaObjects) {
          if (beforeSchema.has(`${row.type}\0${row.name}`) || explicitAllowed.has(row.name)) continue;
          assert.equal(row.type === "index" && row.sqlSha256 === null && newFeatureTables.has(row.table), true, `unexpected post-schema object ${row.name}`);
        }
        const ledger = migrated.prepare("SELECT migration_id,status,receipt_hash,schema_hash,receipt_json FROM memory_schema_migrations").all();
        assert.equal(ledger.length, 1);
        const ledgerReceipt = expectedLedgerReceipt(migrated);
        const ledgerReceiptJson = JSON.stringify(ledgerReceipt);
        assert.deepEqual(Object.keys(ledgerReceipt), ["contract", "migration_id", "status", "schema_hash", "counts", "metadata_roots"]);
        assert.deepEqual(Object.keys(ledgerReceipt.counts), ["legacy_metadata_rows", "sidecar_metadata_rows"]);
        assert.deepEqual(Object.keys(ledgerReceipt.metadata_roots), ["legacy_sha256", "sidecar_sha256"]);
        assertContentFree(ledgerReceipt, "sidecar ledger receipt", seedMarkers);
        assert.deepEqual({ ...ledger[0] }, {
          migration_id: SIDECAR_MIGRATION_ID,
          status: "completed",
          receipt_hash: sha256(ledgerReceiptJson),
          schema_hash: task14SchemaEvidence(migrated).hash,
          receipt_json: ledgerReceiptJson,
        });
        assert.deepEqual(receipt.ledger, {
          migration_id: SIDECAR_MIGRATION_ID,
          receipt_hash: ledger[0].receipt_hash,
          schema_hash: ledger[0].schema_hash,
        });
      } finally {
        migrated.close();
      }

      const candidateDoctorConfig = path.join(root, "candidate-doctor.json");
      writeConfig(candidateDoctorConfig, candidatePath, root);
      const doctor = runGigabrainCtl(["doctor", "--config", candidateDoctorConfig, "--target", "project"]);
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      const doctorPayload = JSON.parse(doctor.stdout);
      assert.equal(doctorPayload.compatibility.task14SidecarMigration.status, "ready");
      assert.equal(doctorPayload.compatibility.task14SidecarMigration.migrationId, SIDECAR_MIGRATION_ID);
      assert.deepEqual(doctorPayload.compatibility.task14SidecarMigration.pendingReasons, []);

      writer.close();
      writer = null;
      const checkpointed = new DatabaseSync(candidatePath);
      checkpointed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      checkpointed.close();
      const firstDbHash = sha256(readFileSync(candidatePath));
      const firstRunFiles = snapshotFiles(runDir);
      const repeated = parseSuccessfulCli(runMigrationCli([
        "--schema-only", "--db", candidatePath, "--config", configPath,
        "--run-dir", runDir, "--release", releasePath, "--receipt", receiptPath,
      ]));
      assert.deepEqual({ changed: repeated.changed, idempotent: repeated.idempotent, ok: repeated.ok }, {
        changed: false,
        idempotent: true,
        ok: true,
      });
      const checkpointedAgain = new DatabaseSync(candidatePath);
      checkpointedAgain.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      assert.equal(checkpointedAgain.prepare("SELECT COUNT(*) AS c FROM memory_schema_migrations").get().c, 1);
      checkpointedAgain.close();
      assert.equal(sha256(readFileSync(candidatePath)), firstDbHash, "second schema-only run must not rewrite the DB");
      assert.deepEqual(snapshotFiles(runDir), firstRunFiles, "second schema-only run must create no artifact or timestamp churn");

      const auditArgs = ["--audit", "--before", receipt.backup.path, "--after", candidatePath];
      const auditFirst = parseSuccessfulCli(runMigrationCli(auditArgs));
      const auditSecond = parseSuccessfulCli(runMigrationCli(auditArgs));
      assert.deepEqual(auditSecond, auditFirst);
      assertContentFree(auditFirst, "audit output", seedMarkers);
      assert.equal(auditFirst.content_free, true);
      assert.deepEqual(auditFirst.old_column_roots.before, before.columnRoots);
      assert.deepEqual(changedRootKeys(auditFirst.old_column_roots.before, auditFirst.old_column_roots.after), [
        "memory_console_metadata.concept", "memory_console_metadata.last_confirmed_at",
        "memory_console_metadata.last_injected_at", "memory_console_metadata.memory_id",
        "memory_console_metadata.pinned", "memory_console_metadata.review_reason",
        "memory_console_metadata.review_version", "memory_console_metadata.source_message_id",
        "memory_console_metadata.ttl_days", "memory_current.valid_from",
      ]);
      assert.deepEqual(auditFirst.old_table_roots.before, before.tableRoots);
      assert.deepEqual(changedRootKeys(auditFirst.old_table_roots.before, auditFirst.old_table_roots.after), [
        "memory_console_metadata", "memory_current",
      ]);
      assert.deepEqual(auditFirst.pragmas.before, before.pragmas);
      assert.deepEqual(auditFirst.pragmas.before, auditFirst.pragmas.after);
      assert.deepEqual(auditFirst.schema_objects.before, before.schemaObjects);
      assert.deepEqual(
        auditFirst.schema_objects.preserved,
        before.schemaObjects.filter((row) => !(
          row.type === "table" && ["memory_embeddings", "memory_native_chunks"].includes(row.name)
        )),
      );
      assert.deepEqual(auditFirst.schema_objects.changed_old, [
        "table\0memory_embeddings", "table\0memory_native_chunks",
      ]);
      assert.deepEqual(auditRegistryPair({ beforePath: receipt.backup.path, afterPath: candidatePath }), auditFirst);

      const projectionReceiptPath = path.join(runDir, "projection.receipt.json");
      const beforeProjection = captureLogicalState(candidatePath);
      const currentBeforeProjection = Object.fromEntries(Object.entries(beforeProjection.columnRoots).filter(([key]) => key.startsWith("memory_current.")));
      const projection = parseSuccessfulCli(runMigrationCli([
        "--reconcile-legacy-projection", "--db", candidatePath, "--config", configPath,
        "--run-dir", runDir, "--release", releasePath, "--receipt", projectionReceiptPath,
      ]));
      assert.equal(projection.corrected, 2);
      assertContentFree(projection, "projection receipt/output", seedMarkers);
      const projectionReceipt = assertReconcileReceipt({
        path: projectionReceiptPath,
        mode: "legacy_projection",
        corrected: 2,
        eventAction: "migration_reconcile_legacy_projection",
        markers: seedMarkers,
      });
      assert.equal(projectionReceipt.before_root, beforeProjection.root);
      const reconciledDb = new DatabaseSync(candidatePath);
      try {
        assert.deepEqual(reconciledDb.prepare("SELECT id,scope,updated_at FROM memories ORDER BY id").all().map((row) => ({ ...row })), [
          { id: "seed-memory-alpha", scope: "profile:main", updated_at: "2001-01-06T00:00:00.000Z" },
          { id: "seed-memory-unicode", scope: "profile:main", updated_at: "2001-02-02T00:00:00.000Z" },
        ]);
        assert.equal(reconciledDb.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE action='migration_reconcile_legacy_projection'").get().c, 2);
        for (const row of reconciledDb.prepare("SELECT payload FROM memory_events WHERE action='migration_reconcile_legacy_projection'").all()) {
          assertContentFree(row.payload, "projection event", seedMarkers);
        }
      } finally {
        reconciledDb.close();
      }
      const afterProjection = captureLogicalState(candidatePath);
      const eventColumnKeys = beforeProjection.columnsByTable.memory_events.map((name) => `memory_events.${name}`);
      assert.deepEqual(changedRootKeys(beforeProjection.columnRoots, afterProjection.columnRoots), [
        "memories.scope", "memories.updated_at", ...eventColumnKeys,
      ].sort(binaryCompare));
      assert.deepEqual(changedRootKeys(beforeProjection.tableRoots, afterProjection.tableRoots), ["memories", "memory_events"]);
      assert.deepEqual(
        Object.fromEntries(Object.entries(afterProjection.columnRoots).filter(([key]) => key.startsWith("memory_current."))),
        currentBeforeProjection,
        "projection reconciliation must preserve every authoritative current column",
      );
      assert.deepEqual(projectionReceipt.allowed_deltas, {
        columns: ["memories.scope", "memories.updated_at", ...eventColumnKeys].sort(binaryCompare),
        event_action: "migration_reconcile_legacy_projection",
        tables: ["memories", "memory_events"],
      });
      const residualProjection = new DatabaseSync(candidatePath, { readOnly: true });
      assert.equal(residualProjection.prepare(`
        SELECT COUNT(*) AS c FROM memories l JOIN memory_current c ON c.memory_id=l.id
        WHERE l.scope IS NOT c.scope OR l.updated_at IS NOT c.updated_at
      `).get().c, 0);
      residualProjection.close();
      const projectionArtifactBeforeRetry = {
        db: sha256(readFileSync(candidatePath)),
        receipt: sha256(readFileSync(projectionReceiptPath)),
        files: snapshotFiles(runDir),
      };
      const projectionAgain = parseSuccessfulCli(runMigrationCli([
        "--reconcile-legacy-projection", "--db", candidatePath, "--config", configPath,
        "--run-dir", runDir, "--release", releasePath, "--receipt", projectionReceiptPath,
      ]));
      assert.equal(projectionAgain.corrected, 0);
      assert.deepEqual({
        db: sha256(readFileSync(candidatePath)),
        receipt: sha256(readFileSync(projectionReceiptPath)),
        files: snapshotFiles(runDir),
      }, projectionArtifactBeforeRetry, "projection retry must be artifact-idempotent");

      const normalizedReceiptPath = path.join(runDir, "normalized.receipt.json");
      const beforeNormalized = captureLogicalState(candidatePath);
      const normalized = parseSuccessfulCli(runMigrationCli([
        "--reconcile-normalized-hashes", "--db", candidatePath, "--config", configPath,
        "--run-dir", runDir, "--release", releasePath, "--receipt", normalizedReceiptPath,
      ]));
      assert.equal(normalized.corrected, 2);
      assertContentFree(normalized, "normalized receipt/output", seedMarkers);
      const normalizedReceipt = assertReconcileReceipt({
        path: normalizedReceiptPath,
        mode: "normalized_hashes",
        corrected: 2,
        eventAction: "migration_reconcile_normalized_hash",
        markers: seedMarkers,
      });
      assert.equal(normalizedReceipt.before_root, beforeNormalized.root);
      const normalizedDb = new DatabaseSync(candidatePath);
      try {
        const expectedUnicode = normalizedFixtureValue(UNICODE_FIXTURE_CONTENT);
        assert.notEqual(expectedUnicode, normalizedFixtureValue(UNICODE_FIXTURE_CONTENT.normalize("NFKC")), "fixture must detect invented NFKC normalization");
        const current = normalizedDb.prepare("SELECT normalized,normalized_hash FROM memory_current WHERE memory_id='seed-memory-unicode'").get();
        const legacy = normalizedDb.prepare("SELECT normalized FROM memories WHERE id='seed-memory-unicode'").get();
        assert.equal(current.normalized, expectedUnicode);
        assert.equal(current.normalized_hash, hashNormalized(UNICODE_FIXTURE_CONTENT));
        assert.equal(legacy.normalized, expectedUnicode);
        assert.equal(normalizedDb.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE action='migration_reconcile_normalized_hash'").get().c, 2);
      } finally {
        normalizedDb.close();
      }
      const afterNormalized = captureLogicalState(candidatePath);
      assert.deepEqual(changedRootKeys(beforeNormalized.columnRoots, afterNormalized.columnRoots), [
        "memories.normalized", "memory_current.normalized", "memory_current.normalized_hash", ...eventColumnKeys,
      ].sort(binaryCompare));
      assert.deepEqual(changedRootKeys(beforeNormalized.tableRoots, afterNormalized.tableRoots), [
        "memories", "memory_current", "memory_events",
      ]);
      assert.deepEqual(normalizedReceipt.allowed_deltas, {
        columns: ["memories.normalized", "memory_current.normalized", "memory_current.normalized_hash", ...eventColumnKeys].sort(binaryCompare),
        event_action: "migration_reconcile_normalized_hash",
        tables: ["memories", "memory_current", "memory_events"],
      });
      const residualNormalized = new DatabaseSync(candidatePath, { readOnly: true });
      const residualRows = residualNormalized.prepare("SELECT memory_id,content,normalized,normalized_hash FROM memory_current ORDER BY memory_id COLLATE BINARY").all();
      assert.equal(residualRows.every((row) => row.normalized === normalizeContent(row.content) && row.normalized_hash === hashNormalized(row.content)), true);
      residualNormalized.close();
      const normalizedArtifactBeforeRetry = {
        db: sha256(readFileSync(candidatePath)),
        receipt: sha256(readFileSync(normalizedReceiptPath)),
        files: snapshotFiles(runDir),
      };
      const normalizedAgain = parseSuccessfulCli(runMigrationCli([
        "--reconcile-normalized-hashes", "--db", candidatePath, "--config", configPath,
        "--run-dir", runDir, "--release", releasePath, "--receipt", normalizedReceiptPath,
      ]));
      assert.equal(normalizedAgain.corrected, 0);
      assert.deepEqual({
        db: sha256(readFileSync(candidatePath)),
        receipt: sha256(readFileSync(normalizedReceiptPath)),
        files: snapshotFiles(runDir),
      }, normalizedArtifactBeforeRetry, "normalized retry must be artifact-idempotent");

      for (const [mode, reconcile, stage] of [
        ["legacy_projection", reconcileLegacyProjection, "after_legacy"],
        ["legacy_projection", reconcileLegacyProjection, "after_event"],
        ["normalized_hashes", reconcileNormalizedHashes, "after_current"],
        ["normalized_hashes", reconcileNormalizedHashes, "after_legacy"],
        ["normalized_hashes", reconcileNormalizedHashes, "after_event"],
      ]) {
        const rollbackRoot = path.join(root, `rollback-${mode}-${stage}`);
        mkdirSync(rollbackRoot, { mode: 0o700 });
        const rollbackDbPath = path.join(rollbackRoot, "candidate.sqlite");
        const rollbackFixture = createLegacyWalFixture(rollbackDbPath, registryShape);
        rollbackFixture.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        rollbackFixture.db.close();
        const rollbackRelease = path.join(rollbackRoot, "RELEASE.json");
        writeRelease(rollbackRelease, manifest.manifestSha256);
        migrateCandidateDatabase({
          dbPath: rollbackDbPath,
          liveDbPath: livePath,
          manifestPath,
          receiptPath: path.join(rollbackRoot, "schema.receipt.json"),
          releasePath: rollbackRelease,
          runDir: rollbackRoot,
        });
        const beforeFaultState = captureLogicalState(rollbackDbPath);
        const beforeFaultFiles = snapshotFiles(rollbackRoot);
        let observed = 0;
        const faultReceiptPath = path.join(rollbackRoot, `${mode}.receipt.json`);
        assert.throws(() => reconcile({
          dbPath: rollbackDbPath,
          receiptPath: faultReceiptPath,
          runDir: rollbackRoot,
          faultInjector: (observedStage) => {
            if (observedStage === stage && ++observed === 2) throw new Error(`synthetic nth ${stage}`);
          },
        }), new RegExp(`synthetic nth ${stage}`));
        assert.deepEqual(captureLogicalState(rollbackDbPath), beforeFaultState, `${mode} ${stage} total rollback`);
        assert.deepEqual(snapshotFiles(rollbackRoot), beforeFaultFiles, `${mode} ${stage} exact artifact rollback`);
        assert.equal(existsSync(faultReceiptPath), false);
      }

      for (const [mode, reconcile, eventAction] of [
        ["legacy_projection", reconcileLegacyProjection, "migration_reconcile_legacy_projection"],
        ["normalized_hashes", reconcileNormalizedHashes, "migration_reconcile_normalized_hash"],
      ]) {
        for (const stage of ["after_commit_before_receipt", "after_receipt_temp", "after_receipt_publish"]) {
          const recoveryRoot = path.join(root, `recovery-${mode}-${stage}`);
          mkdirSync(recoveryRoot, { mode: 0o700 });
          const recoveryDbPath = path.join(recoveryRoot, "candidate.sqlite");
          const recoveryFixture = createLegacyWalFixture(recoveryDbPath, registryShape);
          recoveryFixture.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          recoveryFixture.db.close();
          const recoveryRelease = path.join(recoveryRoot, "RELEASE.json");
          writeRelease(recoveryRelease, manifest.manifestSha256);
          migrateCandidateDatabase({
            dbPath: recoveryDbPath,
            liveDbPath: livePath,
            manifestPath,
            receiptPath: path.join(recoveryRoot, "schema.receipt.json"),
            releasePath: recoveryRelease,
            runDir: recoveryRoot,
          });
          const recoveryReceiptPath = path.join(recoveryRoot, `${mode}.receipt.json`);
          assert.throws(() => reconcile({
            dbPath: recoveryDbPath,
            receiptPath: recoveryReceiptPath,
            runDir: recoveryRoot,
            faultInjector: (observed) => { if (observed === stage) throw new Error(`synthetic ${stage}`); },
          }), new RegExp(`synthetic ${stage}`));
          const recovered = reconcile({ dbPath: recoveryDbPath, receiptPath: recoveryReceiptPath, runDir: recoveryRoot });
          assert.equal(recovered.corrected, 0, `${mode} retry must recover committed state rather than reapply`);
          assertReconcileReceipt({
            path: recoveryReceiptPath,
            mode,
            corrected: 2,
            eventAction,
            markers: recoveryFixture.markers,
          });
          const recoveryDb = new DatabaseSync(recoveryDbPath, { readOnly: true });
          assert.equal(recoveryDb.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE action=?").get(eventAction).c, 2);
          recoveryDb.close();
          const recoveredInventory = snapshotFiles(recoveryRoot);
          reconcile({ dbPath: recoveryDbPath, receiptPath: recoveryReceiptPath, runDir: recoveryRoot });
          assert.deepEqual(snapshotFiles(recoveryRoot), recoveredInventory, `${stage} exact recovery inventory`);
        }
      }

      // Every fault boundary is inside the single schema/backfill/ledger transaction.
      for (const stage of ["after_backup", "after_schema", "after_valid_from", "after_sidecar", "before_ledger", "after_ledger"]) {
        const faultRoot = path.join(root, `fault-${stage}`);
        mkdirSync(faultRoot, { mode: 0o700 });
        const faultDbPath = path.join(faultRoot, "candidate.sqlite");
        const faultFixture = createLegacyWalFixture(faultDbPath, registryShape);
        faultFixture.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        faultFixture.db.close();
        const faultBefore = captureLogicalState(faultDbPath);
        const faultRelease = path.join(faultRoot, "RELEASE.json");
        writeRelease(faultRelease, manifest.manifestSha256);
        assert.throws(() => migrateCandidateDatabase({
          dbPath: faultDbPath,
          liveDbPath: livePath,
          manifestPath,
          receiptPath: path.join(faultRoot, "receipt.json"),
          releasePath: faultRelease,
          runDir: faultRoot,
          faultInjector: (observed) => { if (observed === stage) throw new Error(`synthetic ${stage}`); },
        }), new RegExp(`synthetic ${stage}`));
        assert.deepEqual(captureLogicalState(faultDbPath, faultBefore), faultBefore);
        const faultCheck = new DatabaseSync(faultDbPath);
        assert.equal(faultCheck.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE name='memory_schema_migrations'").get().c, 0);
        assertIntegrity(faultCheck);
        faultCheck.close();
        assert.equal(existsSync(path.join(faultRoot, "receipt.json")), false);
      }

      for (const stage of ["after_commit_before_receipt", "after_receipt_temp", "after_receipt_publish"]) {
        const recoveryRoot = path.join(root, `schema-recovery-${stage}`);
        mkdirSync(recoveryRoot, { mode: 0o700 });
        const recoveryDbPath = path.join(recoveryRoot, "candidate.sqlite");
        const recoveryFixture = createLegacyWalFixture(recoveryDbPath, registryShape);
        recoveryFixture.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        recoveryFixture.db.close();
        const recoveryRelease = path.join(recoveryRoot, "RELEASE.json");
        const recoveryReceiptPath = path.join(recoveryRoot, "schema.receipt.json");
        writeRelease(recoveryRelease, manifest.manifestSha256);
        assert.throws(() => migrateCandidateDatabase({
          dbPath: recoveryDbPath,
          liveDbPath: livePath,
          manifestPath,
          receiptPath: recoveryReceiptPath,
          releasePath: recoveryRelease,
          runDir: recoveryRoot,
          faultInjector: (observed) => { if (observed === stage) throw new Error(`synthetic ${stage}`); },
        }), new RegExp(`synthetic ${stage}`));
        const recovered = migrateCandidateDatabase({
          dbPath: recoveryDbPath,
          liveDbPath: livePath,
          manifestPath,
          receiptPath: recoveryReceiptPath,
          releasePath: recoveryRelease,
          runDir: recoveryRoot,
        });
        assert.equal(recovered.changed, false);
        assert.equal(recovered.recovered, true);
        assert.equal(existsSync(recoveryReceiptPath), true);
        const recoveryDb = new DatabaseSync(recoveryDbPath, { readOnly: true });
        assert.equal(recoveryDb.prepare("SELECT COUNT(*) AS c FROM memory_schema_migrations WHERE migration_id=?").get(SIDECAR_MIGRATION_ID).c, 1);
        recoveryDb.close();
        const recoveredInventory = snapshotFiles(recoveryRoot);
        migrateCandidateDatabase({
          dbPath: recoveryDbPath,
          liveDbPath: livePath,
          manifestPath,
          receiptPath: recoveryReceiptPath,
          releasePath: recoveryRelease,
          runDir: recoveryRoot,
        });
        assert.deepEqual(snapshotFiles(recoveryRoot), recoveredInventory, `${stage} recovery artifact idempotence`);
      }

      for (const [label, mutate] of [
        ["console-index-order", (db) => db.exec("DROP INDEX idx_memory_console_metadata_concept_pinned; CREATE INDEX idx_memory_console_metadata_concept_pinned ON memory_console_metadata(pinned,concept,memory_id)")],
        ["console-extra-column", (db) => db.exec("ALTER TABLE memory_console_metadata ADD COLUMN unexpected_task14_column TEXT")],
      ]) {
        const mismatchRoot = path.join(root, `existing-object-${label}`);
        mkdirSync(mismatchRoot, { mode: 0o700 });
        const mismatchDbPath = path.join(mismatchRoot, "candidate.sqlite");
        const mismatchFixture = createLegacyWalFixture(mismatchDbPath, registryShape);
        mismatchFixture.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        mutate(mismatchFixture.db);
        mismatchFixture.db.close();
        const mismatchBefore = captureLogicalState(mismatchDbPath);
        const mismatchRelease = path.join(mismatchRoot, "RELEASE.json");
        writeRelease(mismatchRelease, manifest.manifestSha256);
        assert.throws(() => migrateCandidateDatabase({
          dbPath: mismatchDbPath,
          liveDbPath: livePath,
          manifestPath,
          receiptPath: path.join(mismatchRoot, "receipt.json"),
          releasePath: mismatchRelease,
          runDir: mismatchRoot,
        }), /existing|schema|object|hash/i, label);
        assert.deepEqual(captureLogicalState(mismatchDbPath), mismatchBefore);
        assert.equal(existsSync(path.join(mismatchRoot, "receipt.json")), false);
      }

      const safeArgs = { candidatePath, liveDbPath: livePath, operatorUid: process.getuid?.(), runDir };
      assert.doesNotThrow(() => assertSafeCandidateDatabase(safeArgs));
      for (const [label, candidateAlias, cleanup] of [
        ["literal live path", livePath, () => {}],
        ["canonical live path", `${runDir}/../production-sentinel.sqlite`, () => {}],
        ["symlink", path.join(root, "live-symlink.sqlite"), () => unlinkSync(path.join(root, "live-symlink.sqlite"))],
        ["hardlink", path.join(root, "live-hardlink.sqlite"), () => unlinkSync(path.join(root, "live-hardlink.sqlite"))],
      ]) {
        if (label === "symlink") symlinkSync(livePath, candidateAlias);
        if (label === "hardlink") linkSync(livePath, candidateAlias);
        try {
          assert.throws(() => assertSafeCandidateDatabase({ ...safeArgs, candidatePath: candidateAlias, runDir: root }), /candidate|alias|identity|link/i, label);
        } finally {
          cleanup();
        }
      }
      const liveFd = openSync(livePath, "r");
      try {
        assert.throws(() => assertSafeCandidateDatabase({
          ...safeArgs,
          candidatePath: `/proc/self/fd/${liveFd}`,
          runDir: root,
        }), /proc|descriptor|alias|identity/i);
      } finally {
        closeSync(liveFd);
      }
      const escapedPath = path.join(root, "outside.sqlite");
      copyFileSync(candidatePath, escapedPath);
      chmodSync(escapedPath, 0o600);
      assert.throws(() => assertSafeCandidateDatabase({ ...safeArgs, candidatePath: escapedPath }), /contain|run.dir|candidate/i);
      const candidateMode = lstatSync(candidatePath).mode & 0o777;
      chmodSync(candidatePath, 0o644);
      assert.throws(() => assertSafeCandidateDatabase(safeArgs), /mode|permission/i);
      chmodSync(candidatePath, candidateMode);
      assert.throws(() => assertSafeCandidateDatabase({ ...safeArgs, operatorUid: Number(process.getuid?.() || 0) + 1 }), /owner|uid/i);
      const linkedCandidate = path.join(runDir, "candidate-hardlink.sqlite");
      linkSync(candidatePath, linkedCandidate);
      try {
        assert.throws(() => assertSafeCandidateDatabase(safeArgs), /link|nlink/i);
      } finally {
        unlinkSync(linkedCandidate);
      }
      const symlinkedParent = path.join(root, "run-alias");
      symlinkSync(runDir, symlinkedParent);
      try {
        assert.throws(() => assertSafeCandidateDatabase({
          ...safeArgs,
          candidatePath: path.join(symlinkedParent, "candidate.sqlite"),
          runDir: symlinkedParent,
        }), /symlink|canonical|ancestor/i);
      } finally {
        unlinkSync(symlinkedParent);
      }

      if (existsSync("/dev/shm") && statSync("/dev/shm").dev !== statSync(runDir).dev) {
        const crossRoot = mkdtempSync(path.join("/dev/shm", "gigabrain-task14-crossfs-"));
        try {
          chmodSync(crossRoot, 0o700);
          const crossCandidate = path.join(crossRoot, "candidate.sqlite");
          copyFileSync(candidatePath, crossCandidate);
          chmodSync(crossCandidate, 0o600);
          assert.throws(() => assertSafeCandidateDatabase({
            ...safeArgs,
            candidatePath: crossCandidate,
            runDir: crossRoot,
            targetDevice: statSync(runDir).dev,
          }), /filesystem|device/i);
        } finally {
          rmSync(crossRoot, { recursive: true, force: true });
        }
      }
    } finally {
      try { writer?.close(); } catch { /* already closed */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

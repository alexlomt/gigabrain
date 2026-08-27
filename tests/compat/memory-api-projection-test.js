import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDatabase } from "../../lib/core/sqlite.js";
import { importContractModule, requireCallable, runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "11";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_MEMORY_API_PROJECTION missing projection sync contract";

const memory = (id, overrides = {}) => ({
  confidence: 0.94,
  content: `Synthetic multilingual memory ${id}: Grüße 東京`,
  created_at: "2026-08-26T12:00:00.000Z",
  memory_id: id,
  scope: "profile:main",
  source: "synthetic",
  source_agent: "main",
  source_kind: "api",
  source_layer: "registry",
  status: "active",
  tags: ["synthetic"],
  type: "DECISION",
  updated_at: "2026-08-26T12:00:00.000Z",
  valid_from: "2026-08-26T11:00:00.000Z",
  ...overrides,
});
const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c || 0);
const projectionCounts = (db) => ({
  current: count(db, "memory_current"),
  events: count(db, "memory_events"),
  fts: count(db, "memory_fts"),
  legacy: count(db, "memories"),
  metadata: count(db, "memory_console_metadata"),
});

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const cliPath = path.join(repoRoot, "scripts", "gigabrainctl.js");
const TASK14_SIDECAR_MIGRATION_ID = "gigabrain-schema-0.11-compat-v1:memory-console-metadata-backfill";
const TASK14_RECEIPT_CONTRACT = "gigabrain-memory-console-metadata-receipt-v1";
const TASK14_SCHEMA_CONTRACT = "gigabrain-memory-console-metadata-schema-v1";
const TASK14_LOGICAL_ROOT_CONTRACT = "gigabrain-memory-console-metadata-logical-root-v1";
const TASK14_MAX_METADATA_ROWS = 10_000_000;
const hashBytes = (value) => createHash("sha256").update(value).digest("hex");
const snapshotTree = (root) => {
  if (!existsSync(root)) return [];
  const rows = [];
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        rows.push({ mode: stat.mode & 0o777, path: `${relative}/`, type: "directory" });
        walk(absolute, relative);
      } else if (stat.isSymbolicLink()) {
        rows.push({ path: relative, target: readlinkSync(absolute), type: "symlink" });
      } else {
        rows.push({ mode: stat.mode & 0o777, path: relative, sha256: hashBytes(readFileSync(absolute)), type: "file" });
      }
    }
  };
  walk(root);
  return rows;
};

const runCli = (args) => spawnSync(process.execPath, [cliPath, ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C" },
  timeout: 30_000,
});

const observationalTree = (root) => snapshotTree(root).map((row) => (
  row.path.endsWith("registry.sqlite-shm")
    ? { mode: row.mode, path: row.path, type: row.type }
    : row
));

const task14MigrationState = ({
  pendingReasons = [],
  receiptPresent = true,
  schemaPresent = true,
  status = "ready",
} = {}) => ({
  status,
  migrationId: TASK14_SIDECAR_MIGRATION_ID,
  ledgerTable: "memory_schema_migrations",
  requiredStatus: "completed",
  receiptContract: TASK14_RECEIPT_CONTRACT,
  schemaContract: TASK14_SCHEMA_CONTRACT,
  maxMetadataRows: TASK14_MAX_METADATA_ROWS,
  schemaPresent,
  receiptRequired: true,
  receiptPresent,
  pendingReasons,
});

const task14SchemaEvidence = (db) => {
  const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?");
  const table = schemaRow.get("table", "memory_console_metadata");
  const index = schemaRow.get("index", "idx_memory_console_metadata_concept_pinned");
  const evidence = {
    contract: TASK14_SCHEMA_CONTRACT,
    table: {
      name: "memory_console_metadata",
      sql: String(table?.sql || ""),
      columns: db.prepare("PRAGMA table_info(memory_console_metadata)").all().map((row) => ({
        cid: Number(row.cid),
        name: String(row.name || ""),
        type: String(row.type || ""),
        notnull: Number(row.notnull),
        dflt_value: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
        pk: Number(row.pk),
      })),
    },
    index: {
      name: "idx_memory_console_metadata_concept_pinned",
      sql: String(index?.sql || ""),
      columns: db.prepare("PRAGMA index_info(idx_memory_console_metadata_concept_pinned)").all().map((row) => ({
        seqno: Number(row.seqno),
        cid: Number(row.cid),
        name: String(row.name || ""),
      })),
    },
  };
  return {
    canonical: JSON.stringify(evidence),
    hash: hashBytes(JSON.stringify(evidence)),
  };
};

const task14MetadataRows = (db, source) => {
  const rows = source === "legacy"
    ? db.prepare(`
        SELECT id AS memory_id, concept, source_message_id, last_injected_at,
               last_confirmed_at, ttl_days, pinned, review_version, review_reason
        FROM memories
        ORDER BY id COLLATE BINARY
      `).all()
    : db.prepare(`
        SELECT memory_id, concept, source_message_id, last_injected_at,
               last_confirmed_at, ttl_days, pinned, review_version, review_reason
        FROM memory_console_metadata
        ORDER BY memory_id COLLATE BINARY
      `).all();
  return rows.map((row) => ({
    memory_id: String(row.memory_id || ""),
    concept: row.concept === null || row.concept === undefined ? null : String(row.concept),
    source_message_id: row.source_message_id === null || row.source_message_id === undefined ? null : String(row.source_message_id),
    last_injected_at: row.last_injected_at === null || row.last_injected_at === undefined ? null : String(row.last_injected_at),
    last_confirmed_at: row.last_confirmed_at === null || row.last_confirmed_at === undefined ? null : String(row.last_confirmed_at),
    ttl_days: row.ttl_days === null || row.ttl_days === undefined ? null : Number(row.ttl_days),
    pinned: Number(row.pinned || 0),
    review_version: row.review_version === null || row.review_version === undefined ? null : String(row.review_version),
    review_reason: row.review_reason === null || row.review_reason === undefined ? null : String(row.review_reason),
  }));
};

const task14MetadataEvidence = (db) => {
  const legacyRows = task14MetadataRows(db, "legacy");
  const sidecarRows = task14MetadataRows(db, "sidecar");
  const root = (rows) => hashBytes(JSON.stringify({
    contract: TASK14_LOGICAL_ROOT_CONTRACT,
    rows,
  }));
  return {
    counts: {
      legacy_metadata_rows: legacyRows.length,
      sidecar_metadata_rows: sidecarRows.length,
    },
    roots: {
      legacy_sha256: root(legacyRows),
      sidecar_sha256: root(sidecarRows),
    },
  };
};

const buildTask14Receipt = (db, overrides = {}) => {
  const schema = task14SchemaEvidence(db);
  const metadata = task14MetadataEvidence(db);
  const receipt = {
    contract: TASK14_RECEIPT_CONTRACT,
    migration_id: String(overrides.migration_id || TASK14_SIDECAR_MIGRATION_ID),
    status: String(overrides.status || "completed"),
    schema_hash: String(overrides.schema_hash || schema.hash),
    counts: overrides.counts || metadata.counts,
    metadata_roots: overrides.metadata_roots || metadata.roots,
  };
  const canonical = JSON.stringify(receipt);
  return {
    canonical,
    hash: hashBytes(canonical),
    receipt,
    schemaHash: schema.hash,
  };
};

const createTask14Ledger = (db, row = null) => {
  db.exec(`
    CREATE TABLE memory_schema_migrations (
      migration_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL
    )
  `);
  if (!row) return;
  const built = buildTask14Receipt(db, row.receipt || row);
  const receiptJson = String(row.receipt_json ?? built.canonical);
  db.prepare(`
    INSERT INTO memory_schema_migrations (
      migration_id, status, receipt_hash, schema_hash, receipt_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    String(row.migration_id || TASK14_SIDECAR_MIGRATION_ID),
    String(row.status || "completed"),
    String(row.receipt_hash ?? hashBytes(receiptJson)),
    String(row.schema_hash ?? built.receipt.schema_hash),
    receiptJson,
  );
};

const writeStandaloneConfig = (
  configPath,
  workspaceRoot,
  registryPath,
  { userProfilePath = "" } = {},
) => {
  writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    compat: { writeMode: "read_only" },
    runtime: { paths: {
      workspaceRoot,
      memoryRoot: path.dirname(registryPath),
      registryPath,
      outputDir: path.join(workspaceRoot, "output"),
      reviewQueuePath: path.join(workspaceRoot, "output", "queue.jsonl"),
    } },
    native: { cloudInbox: { enabled: false }, memoryMdPath: path.join(workspaceRoot, "MEMORY.md") },
    codex: {
      enabled: true,
      projectRoot: workspaceRoot,
      projectStorePath: workspaceRoot,
      userProfilePath,
    },
    recall: { semanticRerankEnabled: false },
  }, null, 2)}\n`, { mode: 0o600 });
};

const writeOpenClawConfig = (configPath, workspaceRoot, registryPath) => {
  writeFileSync(configPath, `${JSON.stringify({
    plugins: { entries: { gigabrain: { enabled: true, config: {
      enabled: true,
      compat: { writeMode: "read_only" },
      runtime: { paths: {
        workspaceRoot,
        memoryRoot: path.dirname(registryPath),
        registryPath,
        outputDir: path.join(workspaceRoot, "output"),
        reviewQueuePath: path.join(workspaceRoot, "output", "queue.jsonl"),
      } },
      native: { cloudInbox: { enabled: false }, memoryMdPath: path.join(workspaceRoot, "MEMORY.md") },
      codex: { enabled: false, projectRoot: workspaceRoot },
      recall: { semanticRerankEnabled: false },
    } } } },
  }, null, 2)}\n`, { mode: 0o600 });
};

const assertLegacyDropCliBlocked = ({ ensureProjectionStore, upsertCurrentMemory }) => {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task11-legacy-drop-"));
  const workspace = path.join(root, "workspace");
  const memoryRoot = path.join(workspace, "memory");
  const dbPath = path.join(memoryRoot, "registry.sqlite");
  const snapshotPath = path.join(root, "must-not-exist.sqlite");
  mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    upsertCurrentMemory(db, memory("legacy-drop-fixture"), { operationId: "legacy-drop-fixture" });
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* non-WAL fixture */ }
  } finally {
    db.close();
  }
  try {
    const before = snapshotTree(root);
    for (const args of [
      ["migrate", "legacy-drop", "--db", dbPath],
      ["migrate", "legacy-drop", "--dry-run", "--db", dbPath],
      ["migrate", "legacy-drop", "--snapshot", snapshotPath, "--db", dbPath],
      ["migrate", "legacy-drop", "--dry-run", "--snapshot", snapshotPath, "--db", dbPath],
    ]) {
      const result = runCli(args);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.match(`${result.stdout}\n${result.stderr}`, /LEGACY_DROP_BLOCKED_COMPAT/);
      assert.deepEqual(snapshotTree(root), before, `${args.join(" ")} must touch no path or DB byte`);
      assert.equal(existsSync(snapshotPath), false);
    }

    const missingRoot = path.join(root, "missing");
    const missingDb = path.join(missingRoot, "registry.sqlite");
    const missingConfig = path.join(missingRoot, "missing.json");
    const missing = runCli([
      "migrate", "legacy-drop", "--dry-run", "--config", missingConfig, "--db", missingDb,
    ]);
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}\n${missing.stderr}`, /LEGACY_DROP_BLOCKED_COMPAT/);
    assert.equal(existsSync(missingRoot), false, "blocked command must fail before config/parent creation");

    const help = runCli(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /legacy-drop[^\n]*BLOCKED/i);
    assert.doesNotMatch(help.stdout, /migrate legacy-drop --(?:dry-run|snapshot)/);
    const migrateHelp = runCli(["migrate"]);
    assert.equal(migrateHelp.status, 0);
    assert.match(migrateHelp.stdout, /legacy-drop[^\n]*BLOCKED/i);
    assert.doesNotMatch(migrateHelp.stdout, /migrate legacy-drop \[--dry-run\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const assertDoctorCompatibilityDiagnostics = ({ ensureProjectionStore, upsertCurrentMemory }) => {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task11-doctor-compat-"));
  const workspace = path.join(root, "workspace");
  const memoryRoot = path.join(workspace, "memory");
  const dbPath = path.join(memoryRoot, "registry.sqlite");
  const configPath = path.join(root, "openclaw.json");
  mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
  const db = openDatabase(dbPath);
  ensureProjectionStore(db);
  upsertCurrentMemory(db, memory("doctor-compat"), {
    metadata: { concept: "synthetic-doctor", pinned: true },
    operationId: "doctor-compat",
  });
  createTask14Ledger(db, { status: "completed" });
  writeOpenClawConfig(configPath, workspace, dbPath);
  try {
    const doctorTree = () => observationalTree(root);
    const before = doctorTree();
    const dbHashBefore = hashBytes(readFileSync(dbPath));
    const doctor = runCli(["doctor", "--config", configPath, "--target", "project"]);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.ok, true, "preserved legacy projection is required, not corruption");
    assert.equal(payload.observational, true);
    assert.deepEqual(payload.compatibility, {
      legacyRequired: true,
      legacyDropBlocked: true,
      reason: "v0.11 rollback window requires the legacy memories projection",
      memoryApiAuthority: {
        status: "ready",
        currentTable: "memory_current",
        currentAuthoritative: true,
        metadataSidecar: "memory_console_metadata",
        sidecarRole: "legacy-only metadata",
        legacyProjection: "memories",
        legacyProjectionStatus: "preserved-required",
      },
      diagnostic: "",
      task14SidecarMigration: task14MigrationState(),
    });
    assert.deepEqual(doctorTree(), before, "doctor compatibility diagnostics must preserve the file tree");
    assert.equal(hashBytes(readFileSync(dbPath)), dbHashBefore, "doctor must not change a DB byte");

    const missingWorkspace = path.join(root, "missing-workspace");
    const missingDb = path.join(missingWorkspace, "memory", "registry.sqlite");
    const missingConfig = path.join(root, "missing-openclaw.json");
    writeOpenClawConfig(missingConfig, missingWorkspace, missingDb);
    const missingBefore = snapshotTree(root);
    const missingDoctor = runCli(["doctor", "--config", missingConfig, "--target", "project"]);
    assert.equal(missingDoctor.status, 0, missingDoctor.stderr || missingDoctor.stdout);
    const missingPayload = JSON.parse(missingDoctor.stdout);
    assert.equal(missingPayload.compatibility.legacyRequired, true);
    assert.equal(missingPayload.compatibility.legacyDropBlocked, true);
    assert.equal(missingPayload.compatibility.memoryApiAuthority.status, "pending");
    assert.equal(missingPayload.compatibility.diagnostic, "registry_not_inspected");
    assert.deepEqual(missingPayload.compatibility.task14SidecarMigration, task14MigrationState({
      pendingReasons: ["registry_not_inspected"],
      receiptPresent: false,
      schemaPresent: false,
      status: "pending",
    }));
    assert.equal(existsSync(missingWorkspace), false);
    assert.deepEqual(snapshotTree(root), missingBefore, "missing-DB doctor must create nothing");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
};

const assertTask14MigrationLedgerReadiness = ({ ensureProjectionStore, upsertCurrentMemory }) => {
  const cliSource = readFileSync(cliPath, "utf8");
  assert.match(
    cliSource,
    /export const TASK14_MEMORY_CONSOLE_METADATA_MIGRATION_ID = ['"]gigabrain-schema-0\.11-compat-v1:memory-console-metadata-backfill['"];/,
    "the exact Task 14 receipt identity must be a named CLI export",
  );
  assert.match(cliSource, /export const TASK14_MEMORY_CONSOLE_METADATA_RECEIPT_CONTRACT = Object\.freeze\(/);
  assert.match(cliSource, /export const TASK14_MEMORY_CONSOLE_METADATA_SCHEMA_CONTRACT = Object\.freeze\(/);
  const variants = [
    {
      name: "missing-ledger-table",
      expected: task14MigrationState({
        pendingReasons: ["migration_ledger_missing"],
        receiptPresent: false,
        status: "pending",
      }),
      setup: () => {},
    },
    {
      name: "missing-receipt-row",
      expected: task14MigrationState({
        pendingReasons: ["migration_receipt_missing"],
        receiptPresent: false,
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db),
    },
    {
      name: "missing-receipt-json-column",
      expected: task14MigrationState({
        pendingReasons: ["migration_ledger_invalid"],
        receiptPresent: false,
        status: "pending",
      }),
      setup: (db) => db.exec(`
        CREATE TABLE memory_schema_migrations (
          migration_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          receipt_hash TEXT NOT NULL,
          schema_hash TEXT NOT NULL
        )
      `),
    },
    {
      name: "extra-ledger-column",
      expected: task14MigrationState({
        pendingReasons: ["migration_ledger_invalid"],
        receiptPresent: false,
        status: "pending",
      }),
      setup: (db) => {
        createTask14Ledger(db, { status: "completed" });
        db.exec("ALTER TABLE memory_schema_migrations ADD COLUMN unexpected_column TEXT");
      },
    },
    {
      name: "incomplete-receipt",
      expected: task14MigrationState({
        pendingReasons: ["migration_incomplete"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, { status: "running" }),
    },
    {
      name: "non-exact-completed-status",
      expected: task14MigrationState({
        pendingReasons: ["migration_incomplete"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, { status: "COMPLETED" }),
    },
    {
      name: "schema-only-receipt",
      expected: task14MigrationState({
        pendingReasons: ["migration_schema_only"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, { status: "schema_only" }),
    },
    {
      name: "bad-receipt-hash",
      expected: task14MigrationState({
        pendingReasons: ["receipt_hash_invalid"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, { receipt_hash: "not-a-receipt-hash" }),
    },
    {
      name: "bad-schema-hash",
      expected: task14MigrationState({
        pendingReasons: ["schema_hash_invalid"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, { schema_hash: "not-a-schema-hash" }),
    },
    {
      name: "arbitrary-well-formed-receipt-hash",
      expected: task14MigrationState({
        pendingReasons: ["receipt_hash_mismatch"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, { receipt_hash: "d".repeat(64) }),
    },
    {
      name: "arbitrary-well-formed-schema-hash",
      expected: task14MigrationState({
        pendingReasons: ["schema_hash_mismatch"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, { schema_hash: "c".repeat(64) }),
    },
    {
      name: "invalid-receipt-json",
      expected: task14MigrationState({
        pendingReasons: ["receipt_json_invalid"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, {
        receipt_json: "{",
        receipt_hash: hashBytes("{"),
      }),
    },
    {
      name: "noncanonical-receipt-json",
      expected: task14MigrationState({
        pendingReasons: ["receipt_json_noncanonical"],
        status: "pending",
      }),
      setup: (db) => {
        const built = buildTask14Receipt(db);
        const receiptJson = JSON.stringify(built.receipt, null, 2);
        createTask14Ledger(db, { receipt_json: receiptJson, receipt_hash: hashBytes(receiptJson) });
      },
    },
    {
      name: "receipt-shape-extra-field",
      expected: task14MigrationState({
        pendingReasons: ["receipt_contract_invalid"],
        status: "pending",
      }),
      setup: (db) => {
        const built = buildTask14Receipt(db);
        const receiptJson = JSON.stringify({ ...built.receipt, extra: 1 });
        createTask14Ledger(db, { receipt_json: receiptJson, receipt_hash: hashBytes(receiptJson) });
      },
    },
    {
      name: "receipt-schema-mismatch",
      expected: task14MigrationState({
        pendingReasons: ["receipt_schema_hash_mismatch"],
        status: "pending",
      }),
      setup: (db) => {
        const built = buildTask14Receipt(db, { schema_hash: "c".repeat(64) });
        createTask14Ledger(db, {
          receipt_json: built.canonical,
          receipt_hash: built.hash,
          schema_hash: task14SchemaEvidence(db).hash,
        });
      },
    },
    {
      name: "receipt-count-out-of-bounds",
      expected: task14MigrationState({
        pendingReasons: ["metadata_count_out_of_bounds"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, { receipt: {
        counts: {
          legacy_metadata_rows: TASK14_MAX_METADATA_ROWS + 1,
          sidecar_metadata_rows: TASK14_MAX_METADATA_ROWS + 1,
        },
      } }),
    },
    {
      name: "receipt-count-mismatch",
      expected: task14MigrationState({
        pendingReasons: ["metadata_count_mismatch"],
        status: "pending",
      }),
      setup: (db) => createTask14Ledger(db, { receipt: {
        counts: {
          legacy_metadata_rows: 2,
          sidecar_metadata_rows: 2,
        },
      } }),
    },
    {
      name: "altered-index-contract",
      expected: task14MigrationState({
        pendingReasons: ["schema_hash_mismatch"],
        status: "pending",
      }),
      setup: (db) => {
        createTask14Ledger(db, { status: "completed" });
        db.exec(`
          DROP INDEX idx_memory_console_metadata_concept_pinned;
          CREATE INDEX idx_memory_console_metadata_concept_pinned
            ON memory_console_metadata(pinned, concept, memory_id);
        `);
      },
    },
    {
      name: "altered-table-contract",
      expected: task14MigrationState({
        pendingReasons: ["schema_hash_mismatch"],
        status: "pending",
      }),
      setup: (db) => {
        createTask14Ledger(db, { status: "completed" });
        db.exec("ALTER TABLE memory_console_metadata ADD COLUMN unexpected_task14_column TEXT");
      },
    },
    {
      name: "unequal-metadata-counts",
      expected: task14MigrationState({
        pendingReasons: ["metadata_count_mismatch", "metadata_root_mismatch"],
        status: "pending",
      }),
      setup: (db) => {
        createTask14Ledger(db, { status: "completed" });
        db.exec("DELETE FROM memory_console_metadata");
      },
    },
    {
      name: "unequal-metadata-roots",
      expected: task14MigrationState({
        pendingReasons: ["metadata_root_mismatch"],
        status: "pending",
      }),
      setup: (db) => {
        createTask14Ledger(db, { status: "completed" });
        db.exec("UPDATE memory_console_metadata SET concept = 'altered-after-receipt'");
      },
    },
  ];

  for (const variant of variants) {
    const root = mkdtempSync(path.join(tmpdir(), `gigabrain-task11-task14-${variant.name}-`));
    const workspace = path.join(root, "workspace");
    const memoryRoot = path.join(workspace, "memory");
    const dbPath = path.join(memoryRoot, "registry.sqlite");
    const configPath = path.join(root, "openclaw.json");
    mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
    const db = openDatabase(dbPath);
    try {
      ensureProjectionStore(db);
      upsertCurrentMemory(db, memory(`task14-${variant.name}`), {
        metadata: { concept: `task14-${variant.name}`, pinned: false },
        operationId: `task14-${variant.name}`,
      });
      variant.setup(db);
      writeOpenClawConfig(configPath, workspace, dbPath);
      const before = observationalTree(root);
      const dbHashBefore = hashBytes(readFileSync(dbPath));
      const doctor = runCli(["doctor", "--config", configPath, "--target", "project"]);
      assert.equal(doctor.status, 0, `${variant.name}: ${doctor.stderr || doctor.stdout}`);
      const payload = JSON.parse(doctor.stdout);
      assert.deepEqual(payload.compatibility.task14SidecarMigration, variant.expected, variant.name);
      assert.doesNotMatch(
        JSON.stringify(payload.compatibility.task14SidecarMigration),
        /[0-9a-f]{64}/,
        `${variant.name}: diagnostics must not expose receipt material`,
      );
      assert.deepEqual(observationalTree(root), before, `${variant.name}: doctor must preserve the file tree`);
      assert.equal(hashBytes(readFileSync(dbPath)), dbHashBefore, `${variant.name}: doctor must preserve DB bytes`);
      if (variant.name === "missing-ledger-table") {
        assert.equal(
          Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_schema_migrations'").get()),
          false,
          "doctor must not create the Task 14 ledger",
        );
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
};

const assertCodexDoctorPreOpenSafety = ({ ensureProjectionStore, upsertCurrentMemory }) => {
  for (const sidecars of [[], ["wal"], ["shm"]]) {
    const label = sidecars.length === 0 ? "missing" : `${sidecars[0]}-only`;
    const root = mkdtempSync(path.join(tmpdir(), `gigabrain-task11-codex-preopen-${label}-`));
    const workspace = path.join(root, "workspace");
    const memoryRoot = path.join(workspace, "memory");
    const dbPath = path.join(memoryRoot, "registry.sqlite");
    const configPath = path.join(root, "gigabrain.json");
    mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
    const fixtureDb = openDatabase(dbPath);
    try {
      ensureProjectionStore(fixtureDb);
      upsertCurrentMemory(fixtureDb, memory(`codex-preopen-${label}`), { operationId: `codex-preopen-${label}` });
      fixtureDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      fixtureDb.close();
    }
    const header = readFileSync(dbPath).subarray(0, 20);
    assert.deepEqual([header[18], header[19]], [2, 2], `${label}: fixture must retain a WAL header`);
    assert.equal(existsSync(`${dbPath}-wal`), false, `${label}: fixture starts without WAL sidecar`);
    assert.equal(existsSync(`${dbPath}-shm`), false, `${label}: fixture starts without SHM sidecar`);
    for (const suffix of sidecars) writeFileSync(`${dbPath}-${suffix}`, "", { mode: 0o600 });
    writeStandaloneConfig(configPath, workspace, dbPath);
    try {
      const before = snapshotTree(root);
      const doctor = runCli(["doctor", "--config", configPath, "--mode", "standalone", "--target", "project"]);
      assert.equal(doctor.status, 0, `${label}: ${doctor.stderr || doctor.stdout}`);
      const payload = JSON.parse(doctor.stdout);
      assert.equal(payload.ok, false, label);
      assert.equal(payload.observational, true, label);
      assert.equal(Object.hasOwn(payload, "build"), false, `${label}: unsafe pre-open state must bypass runDoctor`);
      assert.equal(payload.compatibility.diagnostic, "wal_coordination_sidecars_unavailable", label);
      assert.deepEqual(payload.compatibility.task14SidecarMigration, task14MigrationState({
        pendingReasons: ["registry_not_inspected"],
        receiptPresent: false,
        schemaPresent: false,
        status: "pending",
      }));
      assert.deepEqual(payload.stores, [{
        target: "project",
        ok: false,
        status: "pending",
        workspace_root: workspace,
        db_path: dbPath,
        db_exists: true,
        memory_md_path: path.join(workspace, "MEMORY.md"),
        memory_md_exists: false,
        stats: { total: 0, status: {} },
        diagnostic: "wal_coordination_sidecars_unavailable",
      }]);
      assert.deepEqual(snapshotTree(root), before, `${label}: unsafe doctor must not touch any path or sidecar byte`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task11-codex-preopen-safe-"));
  const workspace = path.join(root, "workspace");
  const memoryRoot = path.join(workspace, "memory");
  const dbPath = path.join(memoryRoot, "registry.sqlite");
  const configPath = path.join(root, "gigabrain.json");
  mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    upsertCurrentMemory(db, memory("codex-preopen-safe"), {
      metadata: { concept: "codex-preopen-safe", pinned: false },
      operationId: "codex-preopen-safe",
    });
    createTask14Ledger(db, { status: "completed" });
    writeStandaloneConfig(configPath, workspace, dbPath);
    const before = observationalTree(root);
    const doctor = runCli(["doctor", "--config", configPath, "--mode", "standalone", "--target", "project"]);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.observational, true);
    assert.equal(Object.hasOwn(payload, "build"), true, "safe pre-open state may call runDoctor");
    assert.equal(payload.stores?.[0]?.status, undefined, "normal runDoctor health remains authoritative");
    assert.deepEqual(payload.compatibility.task14SidecarMigration, task14MigrationState());
    assert.deepEqual(observationalTree(root), before, "safe Codex doctor must remain observational");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
};

const assertCodexDoctorSelectedStoreSafety = ({ ensureProjectionStore, upsertCurrentMemory }) => {
  const createStore = ({ dbPath, id, safe }) => {
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = openDatabase(dbPath);
    ensureProjectionStore(db);
    upsertCurrentMemory(db, memory(id), { operationId: id });
    if (safe) {
      assert.equal(existsSync(`${dbPath}-wal`), true, `${id}: safe store must retain WAL`);
      assert.equal(existsSync(`${dbPath}-shm`), true, `${id}: safe store must retain SHM`);
      return db;
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const header = readFileSync(dbPath).subarray(0, 20);
    assert.deepEqual([header[18], header[19]], [2, 2], `${id}: unsafe fixture must retain a WAL header`);
    assert.equal(existsSync(`${dbPath}-wal`), false, `${id}: unsafe store starts without WAL`);
    assert.equal(existsSync(`${dbPath}-shm`), false, `${id}: unsafe store starts without SHM`);
    return null;
  };

  for (const unsafeTarget of ["project", "user"]) {
    const root = mkdtempSync(path.join(tmpdir(), `gigabrain-task11-selected-${unsafeTarget}-unsafe-`));
    const projectRoot = path.join(root, "project-store");
    const userRoot = path.join(root, "user-store");
    const projectDbPath = path.join(projectRoot, "memory", "registry.sqlite");
    const userDbPath = path.join(userRoot, "memory", "registry.sqlite");
    const configPath = path.join(root, "gigabrain.json");
    const projectDb = createStore({
      dbPath: projectDbPath,
      id: `selected-${unsafeTarget}-project`,
      safe: unsafeTarget !== "project",
    });
    const userDb = createStore({
      dbPath: userDbPath,
      id: `selected-${unsafeTarget}-user`,
      safe: unsafeTarget !== "user",
    });
    writeStandaloneConfig(configPath, projectRoot, projectDbPath, { userProfilePath: userRoot });
    try {
      const before = snapshotTree(root);
      const doctor = runCli(["doctor", "--config", configPath, "--mode", "standalone", "--target", "both"]);
      assert.equal(doctor.status, 0, `${unsafeTarget}: ${doctor.stderr || doctor.stdout}`);
      const payload = JSON.parse(doctor.stdout);
      assert.equal(payload.ok, false, unsafeTarget);
      assert.equal(payload.observational, true, unsafeTarget);
      assert.equal(Object.hasOwn(payload, "build"), false, `${unsafeTarget}: one unsafe selection must bypass runDoctor`);
      assert.deepEqual(
        payload.stores.map((store) => ({
          db_path: store.db_path,
          diagnostic: store.diagnostic,
          status: store.status,
          target: store.target,
        })),
        [
          {
            db_path: projectDbPath,
            diagnostic: unsafeTarget === "project"
              ? "wal_coordination_sidecars_unavailable"
              : "selected_store_preopen_blocked",
            status: "pending",
            target: "project",
          },
          {
            db_path: userDbPath,
            diagnostic: unsafeTarget === "user"
              ? "wal_coordination_sidecars_unavailable"
              : "selected_store_preopen_blocked",
            status: "pending",
            target: "user",
          },
        ],
        unsafeTarget,
      );
      assert.deepEqual(snapshotTree(root), before, `${unsafeTarget}: no selected store may be opened or changed`);
    } finally {
      projectDb?.close();
      userDb?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task11-selected-both-safe-"));
  const projectRoot = path.join(root, "project-store");
  const userRoot = path.join(root, "user-store");
  const projectDbPath = path.join(projectRoot, "memory", "registry.sqlite");
  const userDbPath = path.join(userRoot, "memory", "registry.sqlite");
  const configPath = path.join(root, "gigabrain.json");
  const projectDb = createStore({ dbPath: projectDbPath, id: "selected-safe-project", safe: true });
  const userDb = createStore({ dbPath: userDbPath, id: "selected-safe-user", safe: true });
  writeStandaloneConfig(configPath, projectRoot, projectDbPath, { userProfilePath: userRoot });
  try {
    const before = observationalTree(root);
    const doctor = runCli(["doctor", "--config", configPath, "--mode", "standalone", "--target", "both"]);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.ok, true);
    assert.equal(Object.hasOwn(payload, "build"), true, "both safe stores may reach runDoctor");
    assert.deepEqual(payload.stores.map((store) => [store.target, store.ok]), [["project", true], ["user", true]]);
    assert.deepEqual(observationalTree(root), before, "normal both-store doctor remains observational");
  } finally {
    projectDb.close();
    userDb.close();
    rmSync(root, { recursive: true, force: true });
  }
};

const assertLegacyAdditiveColumns = (ensureProjectionStore) => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'CONTEXT',
        content TEXT NOT NULL,
        normalized TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'capture',
        source_agent TEXT,
        source_session TEXT,
        confidence REAL DEFAULT 0.6,
        status TEXT NOT NULL DEFAULT 'active',
        scope TEXT NOT NULL DEFAULT 'shared',
        tags TEXT,
        created_at TEXT,
        updated_at TEXT,
        superseded_by TEXT,
        content_time TEXT,
        valid_until TEXT,
        value_score REAL,
        value_label TEXT,
        archived_at TEXT,
        last_reviewed_at TEXT
      )
    `);
    ensureProjectionStore(db);
    const columns = new Set(db.prepare("PRAGMA table_info(memories)").all().map((row) => row.name));
    for (const column of [
      "concept",
      "last_confirmed_at",
      "last_injected_at",
      "pinned",
      "review_reason",
      "review_version",
      "source_message_id",
      "ttl_days",
    ]) {
      assert.equal(columns.has(column), true, `legacy schema must add ${column}`);
    }
  } finally {
    db.close();
  }
};

const assertTask11PythonBridge = () => {
  const appPath = path.join(repoRoot, "memory_api", "app.py");
  const memoryApiAppSource = readFileSync("memory_api/app.py", "utf8");
  assert.equal(existsSync(appPath), true);
  assert.match(memoryApiAppSource, /memory_current/);
  const candidates = [
    process.env.GIGABRAIN_TASK11_PYTHON,
    path.join(repoRoot, "memory_api", ".venv-v0.11-prod", "bin", "python"),
    "python3.10",
  ].filter(Boolean);
  const python = candidates.find((candidate) => spawnSync(candidate, ["--version"], {
    cwd: repoRoot, encoding: "utf8", shell: false, timeout: 10_000,
  }).status === 0);
  assert.ok(python, "Task 11 Python 3.10 projection interpreter is required");
  const pythonProjection = spawnSync(python, ["tests/memory_api_projection_test.py"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 180_000,
  });
  assert.equal(pythonProjection.status, 0, pythonProjection.stderr || pythonProjection.stdout);
};

export async function run() {
  assertTask11PythonBridge();
  const projection = await importContractModule("lib/core/projection-store.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const ensureProjectionStore = requireCallable(projection, "ensureProjectionStore");
    const mutate = requireCallable(projection, "mutateCurrentMemoryWithLegacyProjection");
    const updateCurrentStatus = requireCallable(projection, "updateCurrentStatus");
    const upsertCurrentMemory = requireCallable(projection, "upsertCurrentMemory");
    const withBatch = requireCallable(projection, "withProjectionMutationBatch");
    assertLegacyAdditiveColumns(ensureProjectionStore);
    assertLegacyDropCliBlocked({ ensureProjectionStore, upsertCurrentMemory });
    assertDoctorCompatibilityDiagnostics({ ensureProjectionStore, upsertCurrentMemory });
    assertTask14MigrationLedgerReadiness({ ensureProjectionStore, upsertCurrentMemory });
    assertCodexDoctorPreOpenSafety({ ensureProjectionStore, upsertCurrentMemory });
    assertCodexDoctorSelectedStoreSafety({ ensureProjectionStore, upsertCurrentMemory });
    const db = openDatabase(":memory:");
    try {
      ensureProjectionStore(db);
      for (const table of ["memory_current", "memories", "memory_console_metadata", "memory_events"]) {
        assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)), true, table);
      }
      const inserted = upsertCurrentMemory(db, memory("direct"), {
        metadata: {
          concept: "synthetic-concept",
          pinned: true,
          review_reason: "synthetic-review",
          review_version: "rv-synthetic",
          source_message_id: "message-direct",
          ttl_days: 30,
        },
        operationId: "direct-upsert",
      });
      assert.equal(inserted.memory_id, "direct");
      const current = db.prepare("SELECT * FROM memory_current WHERE memory_id = ?").get("direct");
      const legacy = db.prepare("SELECT * FROM memories WHERE id = ?").get("direct");
      const metadata = db.prepare("SELECT * FROM memory_console_metadata WHERE memory_id = ?").get("direct");
      for (const key of ["type", "content", "normalized", "source", "source_agent", "scope", "status", "created_at", "updated_at", "valid_until"]) {
        assert.equal(legacy[key], current[key], `legacy/current mismatch for ${key}`);
      }
      assert.deepEqual(
        {
          concept: metadata.concept,
          pinned: metadata.pinned,
          review_reason: metadata.review_reason,
          review_version: metadata.review_version,
          source_message_id: metadata.source_message_id,
          ttl_days: metadata.ttl_days,
        },
        {
          concept: "synthetic-concept",
          pinned: 1,
          review_reason: "synthetic-review",
          review_version: "rv-synthetic",
          source_message_id: "message-direct",
          ttl_days: 30,
        },
      );
      assert.match(current.normalized_hash, /^[0-9a-f]{64}$/);
      const directEvents = db.prepare("SELECT action, memory_id, payload FROM memory_events WHERE memory_id = ?").all("direct");
      assert.equal(directEvents.length, 1);
      assert.equal(directEvents[0].action, "projection:upsert");
      assert.equal(JSON.parse(directEvents[0].payload).operation_id, "direct-upsert");

      const unicode = upsertCurrentMemory(db, memory("unicode", {
        content: "[m:12345678-abcd] Grüße 東京 — Café １２３",
        status: "pending",
      }), { operationId: "unicode-upsert" });
      assert.equal(unicode.normalized, "grüße 東京 café １２３");
      assert.equal(unicode.normalized_hash, "06731553c4e09eaab3f8ddf4f9745c88cf7988b396fb9d230e41784182bf02c7");
      assert.equal(unicode.status, "pending");

      const canonical = upsertCurrentMemory(db, memory("canonical", {
        content: "Canonical timestamps and normalized text",
        content_time: "2026-08-26T14:00:00+02:00",
        created_at: "2026-08-26T13:00:00+01:00",
        normalized: "CALLER SUPPLIED NORMALIZED VALUE MUST BE IGNORED",
        updated_at: "2026-08-26T14:30:00+02:00",
        valid_from: "2026-08-26T13:30:00+01:00",
        valid_until: "2026-09-26T14:30:00+02:00",
      }), {
        event: { action: "domain:canonicalized", component: "synthetic" },
        now: "2026-08-26T12:30:00.000Z",
        operationId: "canonical-upsert",
      });
      assert.deepEqual({
        content_time: canonical.content_time,
        created_at: canonical.created_at,
        normalized: canonical.normalized,
        updated_at: canonical.updated_at,
        valid_from: canonical.valid_from,
        valid_until: canonical.valid_until,
      }, {
        content_time: "2026-08-26T12:00:00.000Z",
        created_at: "2026-08-26T12:00:00.000Z",
        normalized: "canonical timestamps and normalized text",
        updated_at: "2026-08-26T12:30:00.000Z",
        valid_from: "2026-08-26T12:30:00.000Z",
        valid_until: "2026-09-26T12:30:00.000Z",
      });
      assert.deepEqual(
        { ...db.prepare("SELECT content_time, created_at, normalized, updated_at, valid_from, valid_until FROM memory_current WHERE memory_id='canonical'").get() },
        {
          content_time: "2026-08-26T12:00:00.000Z",
          created_at: "2026-08-26T12:00:00.000Z",
          normalized: "canonical timestamps and normalized text",
          updated_at: "2026-08-26T12:30:00.000Z",
          valid_from: "2026-08-26T12:30:00.000Z",
          valid_until: "2026-09-26T12:30:00.000Z",
        },
      );
      assert.deepEqual(
        { ...db.prepare("SELECT content_time, created_at, normalized, updated_at, valid_until FROM memories WHERE id='canonical'").get() },
        {
          content_time: "2026-08-26T12:00:00.000Z",
          created_at: "2026-08-26T12:00:00.000Z",
          normalized: "canonical timestamps and normalized text",
          updated_at: "2026-08-26T12:30:00.000Z",
          valid_until: "2026-09-26T12:30:00.000Z",
        },
      );
      assert.deepEqual(
        db.prepare("SELECT action, timestamp FROM memory_events WHERE memory_id='canonical'").all().map((row) => ({ ...row })),
        [{ action: "domain:canonicalized", timestamp: "2026-08-26T12:30:00.000Z" }],
        "a caller domain event must be the sole row event and use canonical UTC",
      );

      const futureIngestStarted = Date.now();
      const futureClock = upsertCurrentMemory(db, memory("future-ingest-clock", {
        content: "Future caller metadata must not move the trusted ingest clock",
        content_time: "2998-01-01T00:00:00+01:00",
        updated_at: "2999-01-01T00:00:00+01:00",
        valid_from: null,
      }), { operationId: "future-ingest-clock" });
      const futureIngestFinished = Date.now();
      assert.equal(futureClock.updated_at, "2998-12-31T23:00:00.000Z", "caller updated_at remains canonical persisted data");
      for (const [field, value] of [["content_time", futureClock.content_time], ["valid_from", futureClock.valid_from]]) {
        const time = Date.parse(value);
        assert.equal(
          time >= futureIngestStarted && time <= futureIngestFinished,
          true,
          `future caller updated_at must not let ${field} escape the wall-clock clamp`,
        );
      }
      const futureEventTime = Date.parse(db.prepare("SELECT timestamp FROM memory_events WHERE memory_id='future-ingest-clock'").get().timestamp);
      assert.equal(
        futureEventTime >= futureIngestStarted && futureEventTime <= futureIngestFinished,
        true,
        "future caller updated_at must not move the transaction/event ingest clock",
      );

      const historicalIngestStarted = Date.now();
      const historicalClock = upsertCurrentMemory(db, memory("historical-ingest-clock", {
        content: "A legitimate historical content time may follow its stored update timestamp",
        content_time: "2001-02-03T04:05:06+01:00",
        updated_at: "2000-01-02T03:04:05+01:00",
        valid_from: null,
      }), { operationId: "historical-ingest-clock" });
      const historicalIngestFinished = Date.now();
      assert.deepEqual({
        content_time: historicalClock.content_time,
        updated_at: historicalClock.updated_at,
        valid_from: historicalClock.valid_from,
      }, {
        content_time: "2001-02-03T03:05:06.000Z",
        updated_at: "2000-01-02T02:04:05.000Z",
        valid_from: "2001-02-03T03:05:06.000Z",
      }, "historical updated_at must not clamp a later content_time that is still before ingest");
      const historicalEventTime = Date.parse(db.prepare("SELECT timestamp FROM memory_events WHERE memory_id='historical-ingest-clock'").get().timestamp);
      assert.equal(
        historicalEventTime >= historicalIngestStarted && historicalEventTime <= historicalIngestFinished,
        true,
        "historical updated_at must not move the transaction/event ingest clock backward",
      );

      const noopInput = memory("true-noop", {
        content: "A byte-stable true no-op projection row",
        updated_at: "2026-08-26T12:00:00.000Z",
      });
      upsertCurrentMemory(db, noopInput, { operationId: "true-noop-first" });
      const noopEvents = count(db, "memory_events");
      upsertCurrentMemory(db, noopInput, { operationId: "true-noop-second" });
      assert.equal(count(db, "memory_events"), noopEvents, "an identical projection upsert must emit no event");

      const receipt = withBatch({ db, operationId: "explicit-batch", now: "2026-08-26T13:00:00.000Z" }, (tx) => mutate({
        event: { action: "projection:upsert", component: "synthetic" },
        metadata: { concept: "batch-concept", pinned: false },
        mutation: { kind: "upsert", memory: memory("batch") },
        tx,
      }));
      assert.equal(receipt.result.memory_id, "batch");
      assert.equal(receipt.receipt.boundary, "begin_immediate");
      assert.equal(receipt.receipt.mutations, 1);
      assert.throws(
        () => withBatch({ db, isolation: "deferred", operationId: "bad-isolation" }, () => null),
        /PROJECTION_ISOLATION_INVALID:deferred/,
      );
      assert.throws(
        () => withBatch({ db, operationId: "async-callback" }, async () => null),
        /PROJECTION_ASYNC_CALLBACK_FORBIDDEN/,
      );
      assert.equal(db.isTransaction, false, "an async callback rejection must close its owned transaction");

      const reused = withBatch({ db, operationId: "caller-tx-reuse" }, (tx) => upsertCurrentMemory(
        db,
        memory("caller-tx-row"),
        {
          event: { action: "domain:caller-tx", component: "synthetic" },
          tx,
        },
      ));
      assert.equal(reused.receipt.mutations, 1, "a caller-supplied tx must be reused instead of hidden by a nested batch");
      assert.equal(reused.receipt.events, 1);

      db.exec("BEGIN IMMEDIATE");
      try {
        const nested = withBatch({ db, operationId: "nested-batch" }, (tx) => mutate({
          event: { action: "projection:upsert", component: "synthetic" },
          mutation: { kind: "upsert", memory: memory("nested") },
          tx,
        }));
        assert.equal(nested.receipt.boundary, "savepoint");
        assert.equal(db.isTransaction, true);
        db.exec("ROLLBACK");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      assert.equal(db.prepare("SELECT 1 FROM memory_current WHERE memory_id='nested'").get(), undefined);

      for (const boundary of ["top", "caller_owned"]) {
        for (const stage of ["after_current", "after_legacy", "after_metadata", "after_fts", "after_event"]) {
          if (boundary === "caller_owned") db.exec("BEGIN IMMEDIATE");
          try {
            const before = projectionCounts(db);
            let observedCount = 0;
            assert.throws(() => withBatch({ db, operationId: `fault-${boundary}-${stage}` }, (tx) => {
              for (let index = 1; index <= 2; index += 1) {
                mutate({
                  event: { action: "domain:fault-probe", component: "synthetic" },
                  faultInjector: (observed) => {
                    if (observed === stage && ++observedCount === 2) throw new Error(`synthetic nth fault ${stage}`);
                  },
                  metadata: { concept: `fault-${boundary}-${stage}-${index}` },
                  mutation: { kind: "upsert", memory: memory(`fault-${boundary}-${stage}-${index}`) },
                  tx,
                });
              }
            }), new RegExp(`synthetic nth fault ${stage}`));
            assert.deepEqual(projectionCounts(db), before, `${boundary} ${stage} must roll back every projection surface`);
            if (boundary === "caller_owned") assert.equal(db.isTransaction, true, "the caller transaction must remain owned by the caller");
          } finally {
            if (boundary === "caller_owned" && db.isTransaction) db.exec("ROLLBACK");
          }
        }
      }

      const patched = withBatch({ db, operationId: "temporal-patch", now: "2026-08-26T15:00:00.000Z" }, (tx) => mutate({
        event: { action: "domain:temporal-patch", component: "synthetic" },
        mutation: {
          kind: "patch",
          memoryId: "direct",
          patch: {
            updated_at: "2026-08-26T17:00:00+02:00",
            valid_from: "2026-08-26T16:00:00+02:00",
            valid_until: "2026-08-27T16:00:00+02:00",
          },
        },
        tx,
      })).result;
      assert.deepEqual({
        updated_at: patched.updated_at,
        valid_from: patched.valid_from,
        valid_until: patched.valid_until,
      }, {
        updated_at: "2026-08-26T15:00:00.000Z",
        valid_from: "2026-08-26T14:00:00.000Z",
        valid_until: "2026-08-27T14:00:00.000Z",
      });
      assert.throws(() => withBatch({ db, operationId: "invalid-patch" }, (tx) => mutate({
        event: { action: "domain:invalid-patch", component: "synthetic" },
        mutation: { kind: "patch", memoryId: "direct", patch: { content: "forbidden" } },
        tx,
      })), /PROJECTION_PATCH_FIELD_INVALID:content/);

      assert.equal(updateCurrentStatus(db, "direct", "archived", {
        superseded_by: "batch",
        timestamp: "2026-08-26T14:00:00.000Z",
      }, { operationId: "status-update" }), 1);
      for (const [table, idColumn] of [["memory_current", "memory_id"], ["memories", "id"]]) {
        assert.deepEqual({ ...db.prepare(`SELECT status, superseded_by FROM ${table} WHERE ${idColumn}='direct'`).get() }, {
          status: "archived",
          superseded_by: "batch",
        });
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE memory_id='direct' AND action='projection:status'").get().c, 1);
    } finally {
      db.close();
    }
  });
}

runDirect(import.meta.url, run);

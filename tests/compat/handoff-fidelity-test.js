import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { appendEvent, ensureEventStore } from "../../lib/core/event-store.js";
import { ensureHostMemoryStore, linkMemorySource } from "../../lib/core/host-memory-sync.js";
import { ensureProjectionStore, upsertCurrentMemory } from "../../lib/core/projection-store.js";
import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "13";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_HANDOFF_V2_FIDELITY missing canonical zero-write Handoff v2 contract";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const binaryCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const SECTION_ORDER = ["memories", "source_links", "events"];
const LEGACY_MEMORY_FIELDS = [
  "memory_id", "type", "content", "normalized", "normalized_hash",
  "source", "source_agent", "source_session", "source_layer",
  "source_path", "source_line", "source_host", "source_kind", "sync_policy",
  "confidence", "scope", "status", "value_score", "value_label",
  "created_at", "updated_at", "archived_at", "last_reviewed_at",
  "tags", "superseded_by", "content_time", "valid_until",
];

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(binaryCompare).map((key) => [key, canonicalize(value[key])]));
};

const sectionKey = (name, row) => {
  if (name === "memories") return String(row.memory_id || "");
  if (name === "source_links") {
    return [row.memory_id, row.source_host, row.source_kind, row.source_path, row.source_line, row.content_hash]
      .map((value) => String(value ?? "")).join("\u0000");
  }
  return [row.memory_id, row.timestamp, row.event_id, row.action]
    .map((value) => String(value ?? "")).join("\u0000");
};

const canonicalSection = (name, records = []) => [...records]
  .map(canonicalize)
  .sort((left, right) => binaryCompare(sectionKey(name, left), sectionKey(name, right)));

const oracleSectionHash = (name, records = []) => sha256(JSON.stringify({
  name,
  records: canonicalSection(name, records),
}));

const oracleRoot = (order, sections) => sha256(JSON.stringify(order.map((name) => ({
  count: Number(sections[name].count),
  name,
  sha256: String(sections[name].sha256),
}))));

const oracleLegacyV1Hash = (records = []) => sha256(JSON.stringify([...records]
  .sort((left, right) => binaryCompare(String(left.memory_id || ""), String(right.memory_id || "")))
  .map((row) => Object.fromEntries(LEGACY_MEMORY_FIELDS.map((field) => [field, row[field] === undefined ? null : row[field]])))));

const resealV2 = (bundle) => {
  const order = bundle.events === undefined || bundle.events === null
    ? ["memories", "source_links"]
    : SECTION_ORDER;
  bundle.manifest.section_order = order;
  bundle.manifest.sections = Object.fromEntries(order.map((name) => [name, {
    count: bundle[name].length,
    sha256: oracleSectionHash(name, bundle[name]),
  }]));
  bundle.manifest.root_sha256 = oracleRoot(order, bundle.manifest.sections);
  return bundle;
};

const snapshotTree = (root) => {
  const rows = [];
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort(binaryCompare)) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        rows.push({ mode: stat.mode & 0o777, path: relative, type: "directory" });
        walk(absolute, relative);
      } else if (stat.isFile()) {
        rows.push({ hash: sha256(readFileSync(absolute)), mode: stat.mode & 0o777, path: relative, type: "file" });
      } else {
        rows.push({ mode: stat.mode & 0o777, path: relative, type: "special" });
      }
    }
  };
  walk(root);
  return rows;
};

const insertPagedRows = (db, start, end) => {
  const insert = db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash, source,
      source_agent, confidence, scope, status, created_at, updated_at, valid_from
    ) VALUES (?, 'USER_FACT', ?, ?, ?, 'synthetic', 'codex', 0.9,
      'project:handoff-v2', 'active', ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = start; index < end; index += 1) {
      const suffix = String(index).padStart(5, "0");
      const content = `Synthetic paginated Handoff memory ${suffix}.`;
      const timestamp = `2026-08-20T${String(Math.floor(index / 3600) % 24).padStart(2, "0")}:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
      insert.run(
        `handoff-v2-memory-${suffix}`,
        content,
        content.toLowerCase(),
        sha256(content.toLowerCase()),
        timestamp,
        timestamp,
        `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const seedSource = (db) => {
  ensureProjectionStore(db);
  ensureHostMemoryStore(db);
  ensureEventStore(db);
  for (let index = 0; index < 7; index += 1) {
    const memoryId = `handoff-v2-memory-${String(index).padStart(5, "0")}`;
    upsertCurrentMemory(db, {
      confidence: 0.9,
      content: `Synthetic Handoff v2 memory ${index}.`,
      created_at: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      memory_id: memoryId,
      scope: "project:handoff-v2",
      source: "synthetic",
      source_agent: "codex",
      status: "active",
      type: "USER_FACT",
      updated_at: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      valid_from: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }, { now: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00.000Z` });
    linkMemorySource(db, {
      content_hash: sha256(`Synthetic Handoff v2 memory ${index}.`),
      memory_id: memoryId,
      source_host: "synthetic-host",
      source_kind: "native_memory",
      source_line: index + 1,
      source_path: `/synthetic/memory-${index}.md`,
      sync_policy: "read_only",
    });
    appendEvent(db, {
      action: `source:evidence:${index}`,
      component: "task13-handoff-fixture",
      memory_id: memoryId,
      payload: { synthetic: true },
      reason_codes: ["handoff_v2_fixture"],
      timestamp: `2026-08-${String(index + 1).padStart(2, "0")}T11:00:00.000Z`,
    });
  }
  insertPagedRows(db, 7, 10005);
};

const destinationFixture = (root, label) => {
  const dir = path.join(root, label);
  const dbPath = path.join(dir, "destination.sqlite");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, note TEXT NOT NULL); INSERT INTO sentinel VALUES (1, 'unchanged')");
  db.close();
  return { dbPath, dir };
};

const assertRejectedWithoutWrites = ({ bundle, importBundle, root, label, pattern = /handoff|bundle|integrity|schema|truncat|version|canonical|source/i }) => {
  const fixture = destinationFixture(root, label);
  const before = snapshotTree(fixture.dir);
  const db = new DatabaseSync(fixture.dbPath);
  try {
    assert.throws(() => importBundle({ bundle, db }), pattern);
  } finally {
    db.close();
  }
  assert.deepEqual(snapshotTree(fixture.dir), before, `${label} rejection must happen before schema or row writes`);
};

const assertCanonicalManifest = (bundle) => {
  for (const name of bundle.manifest.section_order) {
    assert.equal(bundle.manifest.sections[name].count, bundle[name].length);
    assert.equal(bundle.manifest.sections[name].sha256, oracleSectionHash(name, bundle[name]));
    assert.deepEqual(bundle[name], canonicalSection(name, bundle[name]), `${name} must be canonically ordered`);
  }
  assert.equal(bundle.manifest.root_sha256, oracleRoot(bundle.manifest.section_order, bundle.manifest.sections));
};

const smallBundle = (bundle, memoryCount = 2) => {
  const allowed = new Set(bundle.memories.slice(0, memoryCount).map((row) => row.memory_id));
  return resealV2({
    ...clone(bundle),
    events: bundle.events.filter((row) => allowed.has(row.memory_id)),
    manifest: { ...clone(bundle.manifest), complete: true, truncated: false },
    memories: bundle.memories.filter((row) => allowed.has(row.memory_id)),
    source_links: bundle.source_links.filter((row) => allowed.has(row.memory_id)),
  });
};

const countImportedRows = (db) => ({
  events: existsSyncTable(db, "memory_events") ? db.prepare("SELECT COUNT(*) AS c FROM memory_events").get().c : 0,
  memories: existsSyncTable(db, "memory_current") ? db.prepare("SELECT COUNT(*) AS c FROM memory_current").get().c : 0,
  sourceLinks: existsSyncTable(db, "memory_source_links") ? db.prepare("SELECT COUNT(*) AS c FROM memory_source_links").get().c : 0,
});

const existsSyncTable = (db, name) => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
).get(name));

const cliConfig = (root, label) => {
  const configPath = path.join(root, `${label}.json`);
  const dbPath = path.join(root, `${label}-destination`, "registry.sqlite");
  writeFileSync(configPath, `${JSON.stringify({
    plugins: { entries: { gigabrain: { enabled: true, config: {
      compat: { writeMode: "full" },
      runtime: { paths: { registryPath: dbPath, workspaceRoot: path.join(root, `${label}-workspace`) } },
    } } } },
  }, null, 2)}\n`, { mode: 0o600 });
  return { configPath, dbPath };
};

export async function run() {
  const handoff = await importContractModule("lib/core/handoff-bundle.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    assert.equal(
      oracleLegacyV1Hash([{ memory_id: "legacy-oracle-1", content: "Synthetic legacy oracle." }]),
      "458195a084604c0fcf244bd535d69a206fd32be9ccbda4e71731890cfbc3100e",
      "the independent v1 oracle must stay bound to a literal precomputed fixture hash",
    );
    assert.equal(handoff.BUNDLE_KIND, "gigabrain.handoff-bundle/2.0");
    assert.equal(handoff.SCHEMA_VERSION, "2.0");
    const exportHandoffBundle = requireCallable(handoff, "exportHandoffBundle");
    const exportPassportBundle = requireCallable(handoff, "exportPassportBundle");
    const importHandoffBundle = requireCallable(handoff, "importHandoffBundle");
    const importPassportBundle = requireCallable(handoff, "importPassportBundle");
    const inspectLegacyV1Bundle = requireCallable(handoff, "inspectLegacyV1Bundle");

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task13-handoff-"));
    try {
      const sourcePath = path.join(root, "source.sqlite");
      const source = new DatabaseSync(sourcePath);
      seedSource(source);
      const bundle = exportHandoffBundle({
        db: source,
        generatedAt: "2026-08-27T12:30:00.000Z",
        includeEvents: true,
        pageSize: 997,
        scope: "project:handoff-v2",
      });
      assert.equal(bundle.kind, "gigabrain.handoff-bundle/2.0");
      assert.equal(bundle.schema_version, "2.0");
      assert.equal(bundle.manifest.complete, true);
      assert.equal(bundle.manifest.truncated, false);
      assert.equal(bundle.memories.length, 10005, "pagination must pass the historical 10,000-row limit");
      assert.equal(bundle.memories[0].memory_id, "handoff-v2-memory-00000");
      assert.equal(bundle.memories.at(-1).memory_id, "handoff-v2-memory-10004");
      assert.equal(bundle.source_links.length, 7);
      assert.equal(bundle.events.length >= 14, true);
      assert.equal(bundle.memories.every((row) => typeof row.valid_from === "string" && row.valid_from.length > 0), true);
      assertCanonicalManifest(bundle);

      const aliasBundle = exportPassportBundle({
        db: source,
        generatedAt: "2026-08-27T12:30:00.000Z",
        includeEvents: false,
        pageSize: 997,
        scope: "project:handoff-v2",
      });
      assert.equal(aliasBundle.kind, bundle.kind, "deprecated Passport export must emit exact Handoff v2");
      assert.equal(aliasBundle.manifest.events_included, false);
      assert.equal(aliasBundle.events === null || aliasBundle.events === undefined || aliasBundle.events.length === 0, true);
      assert.equal(aliasBundle.manifest.section_order.includes("events"), false);
      assertCanonicalManifest(aliasBundle);

      const compact = smallBundle(bundle);
      const importedFixture = destinationFixture(root, "valid-v2-import");
      const destination = new DatabaseSync(importedFixture.dbPath);
      const eventsBefore = countImportedRows(destination).events;
      const imported = importHandoffBundle({ bundle: compact, db: destination, operationId: "task13-valid-v2-import" });
      const afterFirst = countImportedRows(destination);
      assert.equal(imported.ok, true);
      assert.equal(imported.imported_memories, compact.memories.length);
      assert.equal(imported.imported_source_links, compact.source_links.length);
      assert.equal(imported.source_events_replayed, 0);
      assert.equal(imported.import_events_written, afterFirst.events - eventsBefore);
      assert.equal(destination.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE action LIKE 'source:evidence:%'").get().c, 0);
      assert.deepEqual(
        destination.prepare("SELECT valid_from FROM memory_current ORDER BY memory_id").all().map((row) => row.valid_from),
        compact.memories.map((row) => row.valid_from),
      );
      const beforeSecond = countImportedRows(destination);
      const repeated = importPassportBundle({ bundle: compact, db: destination, operationId: "task13-valid-v2-import" });
      assert.deepEqual(countImportedRows(destination), beforeSecond, "idempotent import must append no rows or events");
      assert.equal(repeated.imported_memories, 0);
      assert.equal(repeated.imported_source_links, 0);
      assert.equal(repeated.import_events_written, 0);
      destination.close();

      for (const section of SECTION_ORDER) {
        const tampered = clone(compact);
        const record = tampered[section][0];
        const key = Object.keys(record).find((name) => typeof record[name] === "string") || Object.keys(record)[0];
        record[key] = `${String(record[key] ?? "")}tampered`;
        assertRejectedWithoutWrites({ bundle: tampered, importBundle: importHandoffBundle, label: `tampered-${section}`, root });

        const reordered = clone(compact);
        reordered[section].reverse();
        assertRejectedWithoutWrites({ bundle: reordered, importBundle: importHandoffBundle, label: `reordered-${section}`, root });

        const countMismatch = clone(compact);
        countMismatch.manifest.sections[section].count += 1;
        assertRejectedWithoutWrites({ bundle: countMismatch, importBundle: importHandoffBundle, label: `count-${section}`, root });
      }
      for (const section of SECTION_ORDER) {
        const missing = clone(compact);
        delete missing[section];
        assertRejectedWithoutWrites({ bundle: missing, importBundle: importHandoffBundle, label: `missing-${section}`, root });
      }
      const badRoot = clone(compact);
      badRoot.manifest.root_sha256 = "0".repeat(64);
      assertRejectedWithoutWrites({ bundle: badRoot, importBundle: importHandoffBundle, label: "root-mismatch", root });
      const reorderedManifest = clone(compact);
      reorderedManifest.manifest.section_order.reverse();
      reorderedManifest.manifest.root_sha256 = oracleRoot(
        reorderedManifest.manifest.section_order,
        reorderedManifest.manifest.sections,
      );
      assertRejectedWithoutWrites({
        bundle: reorderedManifest,
        importBundle: importHandoffBundle,
        label: "reordered-manifest-sections",
        root,
      });

      const malformedLink = clone(compact);
      malformedLink.source_links[0].source_host = "";
      resealV2(malformedLink);
      assertRejectedWithoutWrites({ bundle: malformedLink, importBundle: importHandoffBundle, label: "malformed-link", root });

      for (const stage of ["after_current", "after_legacy", "after_fts", "after_event", "after_source_link"]) {
        const fixture = destinationFixture(root, `fault-${stage}`);
        const db = new DatabaseSync(fixture.dbPath);
        let observed = 0;
        assert.throws(() => importHandoffBundle({
          bundle: compact,
          db,
          faultInjector: (value) => { if (value === stage && ++observed === 2) throw new Error(`synthetic ${stage}`); },
          operationId: `task13-fault-${stage}`,
        }), new RegExp(`synthetic ${stage}`));
        assert.deepEqual(countImportedRows(db), { events: 0, memories: 0, sourceLinks: 0 });
        db.close();
      }

      const legacyMemories = compact.memories.map(({ valid_from, ...row }) => row);
      const legacyV1 = {
        events: null,
        generated_at: "2026-08-27T12:00:00.000Z",
        kind: "gigabrain.memory-passport-bundle",
        manifest: {
          content_hash: oracleLegacyV1Hash(legacyMemories),
          event_count: 0,
          events_included: false,
          memory_count: legacyMemories.length,
          source_link_count: compact.source_links.length,
        },
        memories: legacyMemories,
        schema_version: "1.0",
        source_links: compact.source_links,
      };
      const inspection = inspectLegacyV1Bundle(legacyV1);
      assert.equal(inspection.ok, true);
      assert.equal(inspection.inspect_only, true);
      assert.equal(inspection.importable, false);
      assert.equal(inspection.missing_valid_from, true);
      assert.equal(inspection.source_events_replayed, 0);
      assert.equal(inspection.excluded_state.length > 0, true);
      assert.throws(
        () => inspectLegacyV1Bundle({
          ...clone(legacyV1),
          manifest: { ...legacyV1.manifest, memory_count: legacyV1.manifest.memory_count + 1 },
        }),
        /count|manifest/i,
      );
      assert.throws(
        () => inspectLegacyV1Bundle({
          ...clone(legacyV1),
          events: Array.from({ length: 2000 }, (_, index) => ({ event_id: `legacy-cap-${index}` })),
          manifest: { ...legacyV1.manifest, event_count: 2000, events_included: true },
        }),
        /cap|truncat|event/i,
      );
      assertRejectedWithoutWrites({ bundle: legacyV1, importBundle: importHandoffBundle, label: "legacy-v1-import", root });
      assertRejectedWithoutWrites({
        bundle: { ...clone(compact), kind: "gigabrain.handoff-bundle/3.0", schema_version: "3.0" },
        importBundle: importHandoffBundle,
        label: "future-version-import",
        root,
      });

      const cappedMemoryId = compact.memories[0].memory_id;
      const existingEvents = source.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE memory_id=?").get(cappedMemoryId).c;
      for (let index = Number(existingEvents); index < 2000; index += 1) {
        appendEvent(source, {
          action: "source:capped-evidence",
          component: "task13-handoff-cap",
          memory_id: cappedMemoryId,
          payload: { index },
          reason_codes: ["handoff_event_cap_fixture"],
          timestamp: `2026-08-27T13:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        });
      }
      assert.equal(source.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE memory_id=?").get(cappedMemoryId).c, 2000);
      const truncated = exportHandoffBundle({
        db: source,
        eventLimitPerMemory: 2000,
        generatedAt: "2026-08-27T14:00:00.000Z",
        includeEvents: true,
        pageSize: 997,
        scope: "project:handoff-v2",
      });
      assert.equal(truncated.manifest.truncated, true, "reaching the exact evidence cap must fail closed");
      assert.equal(truncated.manifest.complete, false);
      assertRejectedWithoutWrites({ bundle: truncated, importBundle: importHandoffBundle, label: "truncated-v2-import", root });
      const compactPath = path.join(root, "handoff-v2-compact.json");
      const truncatedPath = path.join(root, "handoff-v2-truncated.json");
      writeFileSync(compactPath, `${JSON.stringify(compact, null, 2)}\n`, { mode: 0o600 });
      writeFileSync(truncatedPath, `${JSON.stringify(truncated, null, 2)}\n`, { mode: 0o600 });
      source.close();

      const noEventsCompact = resealV2({
        ...clone(aliasBundle),
        events: null,
        manifest: { ...clone(aliasBundle.manifest), complete: true, truncated: false },
        memories: aliasBundle.memories.slice(0, 2),
        source_links: aliasBundle.source_links.filter((row) => new Set(aliasBundle.memories.slice(0, 2).map((memory) => memory.memory_id)).has(row.memory_id)),
      });
      const noEventsFixture = destinationFixture(root, "no-events-import");
      const noEventsDb = new DatabaseSync(noEventsFixture.dbPath);
      const noEventsBefore = countImportedRows(noEventsDb).events;
      const noEventsResult = importPassportBundle({
        bundle: noEventsCompact,
        db: noEventsDb,
        operationId: "task13-no-source-events",
      });
      const noEventsAfter = countImportedRows(noEventsDb).events;
      assert.equal(noEventsResult.source_events_replayed, 0);
      assert.equal(noEventsResult.import_events_written, noEventsAfter - noEventsBefore);
      assert.equal(noEventsDb.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE action LIKE 'source:%'").get().c, 0);
      noEventsDb.close();

      const legacyPath = path.join(root, "legacy-v1.json");
      const malformedLegacyPath = path.join(root, "legacy-v1-malformed.json");
      writeFileSync(legacyPath, `${JSON.stringify(legacyV1, null, 2)}\n`, { mode: 0o600 });
      writeFileSync(malformedLegacyPath, `${JSON.stringify({ ...legacyV1, manifest: { ...legacyV1.manifest, content_hash: "0".repeat(64) } }, null, 2)}\n`, { mode: 0o600 });
      const cli = cliConfig(root, "handoff-cli");
      const beforeInspect = snapshotTree(root);
      const inspect = spawnSync(process.execPath, [
        path.join(repoRoot, "scripts", "gigabrainctl.js"), "handoff", "inspect", "--legacy-v1", "--in", legacyPath,
      ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
      assert.equal(inspect.status, 0, inspect.stderr);
      assert.equal(JSON.parse(inspect.stdout).inspect_only, true);
      assert.deepEqual(snapshotTree(root), beforeInspect, "legacy inspection must not open config or create destination state");

      for (const [label, args] of [
        ["legacy-import", ["handoff", "import", "--legacy-v1", "--in", legacyPath, "--config", cli.configPath]],
        ["passport-import-alias", ["import-bundle", "--in", legacyPath, "--config", cli.configPath]],
        ["legacy-inspect-without-flag", ["handoff", "inspect", "--in", legacyPath]],
        ["malformed-legacy-inspect", ["handoff", "inspect", "--legacy-v1", "--in", malformedLegacyPath]],
        ["truncated-v2-import", ["handoff", "import", "--in", truncatedPath, "--config", cli.configPath]],
        ["integrity-bypass", ["handoff", "import", "--in", compactPath, "--config", cli.configPath, "--skip-integrity-check"]],
        ["passport-integrity-bypass", ["import-bundle", "--in", compactPath, "--config", cli.configPath, "--skip-integrity-check"]],
      ]) {
        const before = snapshotTree(root);
        const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "gigabrainctl.js"), ...args], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.notEqual(result.status, 0, `${label} must fail closed`);
        assert.equal(result.stdout, "", `${label} must not emit a success artifact`);
        assert.equal(existsSync(path.dirname(cli.dbPath)), false, `${label} must fail before destination path creation`);
        assert.deepEqual(snapshotTree(root), before, `${label} must be zero-write`);
      }

      const securitySource = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
      const configurationDocs = readFileSync(path.join(repoRoot, "docs/configuration.md"), "utf8");
      const handoffDocs = readFileSync(path.join(repoRoot, "docs/handoff-record.md"), "utf8");
      const upgradingDocs = readFileSync(path.join(repoRoot, "docs/upgrading.md"), "utf8");
      const gigabrainCtlSource = readFileSync(path.join(repoRoot, "scripts/gigabrainctl.js"), "utf8");
      assert.match(securitySource, /gigabrain\.handoff-bundle\/2\.0/);
      assert.match(configurationDocs, /source events.*evidence.*not replayed/is);
      assert.match(handoffDocs, /transfer artifact.*not a backup/is);
      assert.match(upgradingDocs, /legacy v1.*inspect-only.*physical database migration/is);
      assert.match(gigabrainCtlSource, /handoff[\s\S]*inspect[\s\S]*legacy-v1/);
      const docs = [securitySource, configurationDocs, handoffDocs, upgradingDocs].join("\n");
      for (const excludedFamily of [
        /embeddings/i,
        /world model|entities|beliefs/i,
        /checkpoints|claim proposals|receipts/i,
        /review queue/i,
        /native sync|host sync cursor/i,
        /transcript|wiki/i,
      ]) assert.match(docs, excludedFamily, `excluded state family ${excludedFamily} must be documented`);

      const portMap = JSON.parse(readFileSync(path.join(repoRoot, "config", "migration", "source-first-port-map.json"), "utf8"));
      for (const requiredPath of [
        "lib/core/control-plane.js",
        "lib/core/checkpoint-migration.js",
        "lib/core/handoff-bundle.js",
        "lib/core/lifecycle-hooks.js",
        "lib/core/codex-service.js",
        "scripts/gigabrainctl.js",
        "docs/checkpoint-control-plane.md",
        "docs/handoff-record.md",
        "docs/upgrading.md",
        "docs/configuration.md",
        "SECURITY.md",
        "tests/compat/checkpoint-concurrency-test.js",
        "tests/compat/handoff-fidelity-test.js",
      ]) {
        assert.equal(
          portMap.candidateChanges.find((row) => row.targetPath === requiredPath)?.ownerTasks.includes("13"),
          true,
          `${requiredPath} must carry Task 13 source-first ownership`,
        );
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}

runDirect(import.meta.url, run);

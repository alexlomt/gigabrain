import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { appendEvent, ensureEventStore } from "../../lib/core/event-store.js";
import {
  ensureHostMemoryStore,
  linkMemorySource,
} from "../../lib/core/host-memory-sync.js";
import {
  ensureProjectionStore,
  upsertCurrentMemory,
} from "../../lib/core/projection-store.js";
import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "13";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_HANDOFF_V2_FIDELITY missing canonical zero-write Handoff v2 contract";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);

const snapshotTree = (root) => {
  const rows = [];
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
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

const seedSource = (db) => {
  ensureProjectionStore(db);
  ensureHostMemoryStore(db);
  ensureEventStore(db);
  for (let index = 0; index < 7; index += 1) {
    const memoryId = `handoff-v2-memory-${String(index).padStart(2, "0")}`;
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
};

const destinationFixture = (root, label) => {
  const dir = path.join(root, label);
  const dbPath = path.join(dir, "destination.sqlite");
  mkdirSync(dir, { recursive: true });
  const fs = new DatabaseSync(dbPath);
  fs.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, note TEXT NOT NULL); INSERT INTO sentinel VALUES (1, 'unchanged')");
  fs.close();
  return { dbPath, dir };
};

const assertRejectedWithoutWrites = ({ bundle, importBundle, root, label }) => {
  const fixture = destinationFixture(root, label);
  const before = snapshotTree(fixture.dir);
  const db = new DatabaseSync(fixture.dbPath);
  try {
    assert.throws(() => importBundle({ bundle, db }), /handoff|bundle|integrity|schema|truncat|version/i);
  } finally {
    db.close();
  }
  assert.deepEqual(snapshotTree(fixture.dir), before, `${label} rejection must happen before schema or row writes`);
};

export async function run() {
  const handoff = await importContractModule("lib/core/handoff-bundle.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    assert.equal(handoff.BUNDLE_KIND, "gigabrain.handoff-bundle/2.0");
    assert.equal(handoff.SCHEMA_VERSION, "2.0");
    const computeContentHash = requireCallable(handoff, "computeContentHash");
    const computeManifestRoot = requireCallable(handoff, "computeManifestRoot");
    const computeSectionHash = requireCallable(handoff, "computeSectionHash");
    const exportBundle = requireCallable(handoff, "exportPassportBundle");
    const importBundle = requireCallable(handoff, "importPassportBundle");
    const inspectLegacyV1Bundle = requireCallable(handoff, "inspectLegacyV1Bundle");

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task13-handoff-"));
    try {
      const sourcePath = path.join(root, "source.sqlite");
      const source = new DatabaseSync(sourcePath);
      seedSource(source);
      const bundle = exportBundle({
        db: source,
        generatedAt: "2026-08-27T12:30:00.000Z",
        includeEvents: true,
        pageSize: 2,
        scope: "project:handoff-v2",
      });
      assert.equal(bundle.kind, "gigabrain.handoff-bundle/2.0");
      assert.equal(bundle.schema_version, "2.0");
      assert.equal(bundle.manifest.complete, true);
      assert.equal(bundle.manifest.truncated, false);
      assert.equal(bundle.manifest.pagination.page_size, 2);
      assert.equal(bundle.manifest.pagination.pages, 4);
      assert.equal(bundle.manifest.pagination.exhausted, true);
      assert.deepEqual(bundle.manifest.section_order, ["memories", "source_links", "events"]);
      assert.equal(bundle.memories.length, 7, "pagination must continue past every intermediate page");
      assert.equal(bundle.source_links.length, 7);
      assert.equal(bundle.events.length >= 7, true);
      assert.deepEqual(
        bundle.memories.map((row) => row.valid_from),
        Array.from({ length: 7 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
        "valid_from must survive export in canonical order",
      );
      for (const name of bundle.manifest.section_order) {
        assert.deepEqual(Object.keys(bundle.manifest.sections[name]).sort(), ["count", "sha256"]);
        assert.equal(bundle.manifest.sections[name].count, bundle[name].length);
        assert.equal(bundle.manifest.sections[name].sha256, computeSectionHash(name, bundle[name]));
      }
      assert.equal(
        bundle.manifest.root_sha256,
        computeManifestRoot(bundle.manifest.section_order, bundle.manifest.sections),
      );

      const importedFixture = destinationFixture(root, "valid-v2-import");
      const destination = new DatabaseSync(importedFixture.dbPath);
      const imported = importBundle({ bundle, db: destination, operationId: "task13-valid-v2-import" });
      assert.equal(imported.ok, true);
      assert.equal(imported.imported_memories, 7);
      assert.equal(imported.imported_source_links, 7);
      assert.equal(imported.source_events_replayed, 0, "source events are evidence-only");
      assert.equal(imported.import_events_written, 7, "only destination import events may be written");
      assert.equal(
        destination.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE action LIKE 'source:evidence:%'").get().c,
        0,
      );
      assert.deepEqual(
        destination.prepare("SELECT valid_from FROM memory_current ORDER BY memory_id").all().map((row) => row.valid_from),
        bundle.memories.map((row) => row.valid_from),
      );
      destination.close();

      for (const [label, mutate] of [
        ["tampered-memories", (value) => { value.memories[0].content = "tampered"; }],
        ["tampered-source-links", (value) => { value.source_links[0].source_host = "tampered"; }],
        ["tampered-events", (value) => { value.events[0].action = "tampered"; }],
        ["reordered-memories", (value) => { value.memories.reverse(); }],
        ["missing-events-section", (value) => { delete value.events; }],
        ["count-mismatch", (value) => { value.manifest.sections.memories.count += 1; }],
        ["root-mismatch", (value) => { value.manifest.root_sha256 = "0".repeat(64); }],
      ]) {
        const candidate = clone(bundle);
        mutate(candidate);
        assertRejectedWithoutWrites({ bundle: candidate, importBundle, label, root });
      }

      const legacyMemories = bundle.memories.map(({ valid_from, ...row }) => row);
      const legacyV1 = {
        events: null,
        generated_at: "2026-08-27T12:00:00.000Z",
        kind: "gigabrain.memory-passport-bundle",
        manifest: {
          content_hash: computeContentHash(legacyMemories),
          event_count: 0,
          events_included: false,
          memory_count: bundle.memories.length,
          source_link_count: bundle.source_links.length,
        },
        memories: legacyMemories,
        schema_version: "1.0",
        source_links: bundle.source_links,
      };
      const inspection = inspectLegacyV1Bundle(legacyV1);
      assert.equal(inspection.ok, true);
      assert.equal(inspection.inspect_only, true);
      assert.equal(inspection.importable, false);
      assert.equal(inspection.missing_valid_from, true);
      assert.equal(inspection.source_events_replayed, 0);
      assert.equal(inspection.excluded_state.length > 0, true);
      assertRejectedWithoutWrites({ bundle: legacyV1, importBundle, label: "legacy-v1-import", root });
      assertRejectedWithoutWrites({
        bundle: { ...clone(bundle), kind: "gigabrain.handoff-bundle/3.0", schema_version: "3.0" },
        importBundle,
        label: "future-version-import",
        root,
      });

      const cappedMemoryId = bundle.memories[0].memory_id;
      for (let index = 0; index < 2001; index += 1) {
        appendEvent(source, {
          action: "source:capped-evidence",
          component: "task13-handoff-cap",
          memory_id: cappedMemoryId,
          payload: { index },
          reason_codes: ["handoff_event_cap_fixture"],
          timestamp: `2026-08-27T13:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        });
      }
      const truncated = exportBundle({
        db: source,
        eventLimitPerMemory: 2000,
        generatedAt: "2026-08-27T14:00:00.000Z",
        includeEvents: true,
        pageSize: 2,
        scope: "project:handoff-v2",
      });
      assert.equal(truncated.manifest.truncated, true);
      assert.equal(truncated.manifest.complete, false);
      assertRejectedWithoutWrites({ bundle: truncated, importBundle, label: "truncated-v2-import", root });
      source.close();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}

runDirect(import.meta.url, run);

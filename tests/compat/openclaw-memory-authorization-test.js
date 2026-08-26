import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";
import { appendEvent, ensureEventStore } from "../../lib/core/event-store.js";
import { ensureNativeStore } from "../../lib/core/native-sync.js";
import { ensurePersonStore } from "../../lib/core/person-service.js";
import { ensureProjectionStore, upsertCurrentMemory } from "../../lib/core/projection-store.js";
import { readContainedRegularFileNoFollowSync } from "../../lib/core/safe-fs.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OPENCLAW_MEMORY_AUTHORIZATION missing caller-bound direct reads";

const makeFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task5-auth-"));
  const workspace = path.join(root, "workspace");
  const memoryRoot = path.join(workspace, "memory");
  mkdirSync(memoryRoot, { recursive: true });
  const mixedPath = path.join(memoryRoot, "2026-08-25.md");
  writeFileSync(mixedPath, [
    "# 2026-08-25",
    "",
    "- Main private fact. <!-- gigabrain:scope=profile:main -->",
    "- Shared fact. <!-- gigabrain:scope=shared -->",
    "- CEO private fact. <!-- gigabrain:scope=paperclip-ceo -->",
    "",
  ].join("\n"));
  const outside = path.join(root, "outside.md");
  writeFileSync(outside, "outside secret\n");
  symlinkSync(outside, path.join(memoryRoot, "linked.md"));
  const dbPath = path.join(memoryRoot, "registry.sqlite");
  const db = new DatabaseSync(dbPath);
  ensureProjectionStore(db);
  ensureEventStore(db);
  ensureNativeStore(db);
  ensurePersonStore(db);
  for (const [id, scope, content] of [
    ["main-memory", "profile:main", "Main exact memory"],
    ["shared-memory", "shared", "Shared exact memory"],
    ["ceo-memory", "paperclip-ceo", "CEO exact memory"],
  ]) {
    upsertCurrentMemory(db, {
      memory_id: id,
      type: "CONTEXT",
      content,
      normalized: content.toLowerCase(),
      scope,
      status: "active",
      created_at: "2026-08-25T00:00:00.000Z",
      updated_at: "2026-08-25T00:00:00.000Z",
    });
  }
  appendEvent(db, {
    event_id: "event-main",
    timestamp: "2026-08-25T01:00:00.000Z",
    component: "capture",
    action: "capture_inserted",
    memory_id: "main-memory",
    cleanup_version: "test",
    run_id: "test",
    review_version: "test",
  });
  appendEvent(db, {
    event_id: "event-ceo",
    timestamp: "2026-08-25T01:00:00.000Z",
    component: "capture",
    action: "capture_inserted",
    memory_id: "ceo-memory",
    cleanup_version: "test",
    run_id: "test",
    review_version: "test",
  });
  const insertChunk = db.prepare(`
    INSERT INTO memory_native_chunks (
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, hash, scope, linked_memory_id, first_seen_at, last_seen_at, status
    ) VALUES (?, ?, 'daily_note', '2026-08-25', '', 1, 1, ?, ?, ?, ?, NULL, ?, ?, 'active')
  `);
  for (const [id, scope, content] of [
    ["chunk-main", "profile:main", "Main native chunk"],
    ["chunk-shared", "shared", "Shared native chunk"],
    ["chunk-ceo", "paperclip-ceo", "CEO native chunk"],
  ]) insertChunk.run(id, mixedPath, content, content.toLowerCase(), id, scope, "2026-08-25T00:00:00Z", "2026-08-25T00:00:00Z");
  db.exec(`
    CREATE TABLE memory_entities (
      entity_id TEXT PRIMARY KEY, kind TEXT, display_name TEXT, normalized_name TEXT,
      status TEXT, confidence REAL, aliases TEXT, created_at TEXT, updated_at TEXT, payload TEXT
    );
    CREATE TABLE memory_beliefs (
      belief_id TEXT PRIMARY KEY, entity_id TEXT, type TEXT, content TEXT, status TEXT,
      confidence REAL, valid_from TEXT, valid_to TEXT, supersedes_belief_id TEXT,
      source_memory_id TEXT, source_layer TEXT, source_path TEXT, source_line INTEGER, payload TEXT
    );
  `);
  db.prepare("INSERT INTO memory_entities VALUES (?, 'person', ?, ?, 'active', 0.9, '[]', ?, ?, '{}')")
    .run("entity-main", "Main Entity", "main entity", "2026-08-25T00:00:00Z", "2026-08-25T00:00:00Z");
  db.prepare("INSERT INTO memory_entities VALUES (?, 'person', ?, ?, 'active', 0.9, '[]', ?, ?, '{}')")
    .run("entity-ceo", "CEO Entity", "ceo entity", "2026-08-25T00:00:00Z", "2026-08-25T00:00:00Z");
  db.prepare("INSERT INTO memory_entities VALUES (?, 'person', ?, ?, 'active', 0.9, ?, ?, ?, '{}')")
    .run("entity-mixed", "Foreign Canonical Name", "mixed entity", JSON.stringify(["Foreign Secret Alias"]), "2026-08-25T00:00:00Z", "2026-08-25T00:00:00Z");
  db.prepare("INSERT INTO memory_entities VALUES (?, 'person', ?, ?, 'active', 0.9, ?, ?, ?, '{}')")
    .run("entity-foreign", "Foreign Only Name", "foreign only", JSON.stringify(["Foreign Only Alias"]), "2026-08-25T00:00:00Z", "2026-08-25T00:00:00Z");
  db.prepare("INSERT INTO memory_beliefs VALUES (?, ?, 'CONTEXT', ?, 'current', 0.9, NULL, NULL, NULL, ?, 'registry', NULL, NULL, '{}')")
    .run("belief-main", "entity-main", "Main entity belief", "main-memory");
  db.prepare("INSERT INTO memory_beliefs VALUES (?, ?, 'CONTEXT', ?, 'current', 0.9, NULL, NULL, NULL, ?, 'registry', NULL, NULL, '{}')")
    .run("belief-ceo", "entity-ceo", "CEO entity belief", "ceo-memory");
  db.prepare("INSERT INTO memory_beliefs VALUES (?, ?, 'CONTEXT', ?, 'current', 0.9, NULL, NULL, NULL, ?, 'registry', NULL, NULL, '{}')")
    .run("belief-mixed-main", "entity-mixed", "Authorized mixed entity belief", "main-memory");
  db.prepare("INSERT INTO memory_beliefs VALUES (?, ?, 'CONTEXT', ?, 'current', 0.9, NULL, NULL, NULL, ?, 'registry', NULL, NULL, '{}')")
    .run("belief-mixed-ceo", "entity-mixed", "Foreign mixed entity belief", "ceo-memory");
  db.prepare("INSERT INTO memory_beliefs VALUES (?, ?, 'CONTEXT', ?, 'current', 0.9, NULL, NULL, NULL, ?, 'registry', NULL, NULL, '{}')")
    .run("belief-foreign", "entity-foreign", "Foreign only entity belief", "ceo-memory");
  const insertMention = db.prepare(`
    INSERT INTO memory_entity_mentions (
      id, memory_id, entity_key, entity_display, role, confidence, source, scope, source_path, linked_memory_id
    ) VALUES (?, ?, ?, ?, 'subject', 0.9, 'registry', ?, NULL, NULL)
  `);
  insertMention.run("mention-mixed-main", "main-memory", "mixed entity", "Safe Main Alias", "profile:main");
  insertMention.run("mention-mixed-ceo", "ceo-memory", "mixed entity", "Foreign Secret Alias", "paperclip-ceo");
  insertMention.run("mention-foreign", "ceo-memory", "foreign only", "Foreign Only Alias", "paperclip-ceo");
  db.close();
  return {
    root,
    config: {
      runtime: { paths: { workspaceRoot: workspace, memoryRoot, registryPath: dbPath } },
      native: { memoryMdPath: path.join(workspace, "MEMORY.md"), includeFiles: [] },
      recall: { semanticRerankEnabled: false },
    },
  };
};

const assertConcealed = async (promise) => {
  await assert.rejects(promise, (error) => error?.code === "GIGABRAIN_MEMORY_NOT_FOUND");
};

export async function run() {
  const runtime = await importContractModule("lib/compat/openclaw-memory-runtime.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const createManager = requireCallable(runtime, "createGigabrainMemoryManager");
    const readOperator = requireCallable(runtime, "readOperatorNativeFile");
    const fixture = makeFixture();
    try {
      const manager = createManager({ config: fixture.config, scope: "profile:main" });
      assert.match((await manager.readFile({ relPath: "gigabrain://memory/main-memory" })).text, /Main exact memory/);
      assert.match((await manager.readFile({ relPath: "gigabrain://memory/shared-memory" })).text, /Shared exact memory/);
      await assertConcealed(manager.readFile({ relPath: "gigabrain://memory/ceo-memory" }));
      await assertConcealed(manager.readFile({ relPath: "gigabrain://memory/absent-memory" }));
      assert.match((await manager.readFile({ relPath: "gigabrain://timeline/main-memory" })).text, /event-main/);
      await assertConcealed(manager.readFile({ relPath: "gigabrain://timeline/ceo-memory" }));
      assert.match((await manager.readFile({ relPath: "gigabrain://entity/entity-main" })).text, /Main entity belief/);
      await assertConcealed(manager.readFile({ relPath: "gigabrain://entity/entity-ceo" }));
      const mixedEntity = await manager.readFile({ relPath: "gigabrain://entity/entity-mixed" });
      assert.match(mixedEntity.text, /Safe Main Alias/);
      assert.match(mixedEntity.text, /Authorized mixed entity belief/);
      assert.doesNotMatch(mixedEntity.text, /Foreign Canonical Name|Foreign Secret Alias|Foreign mixed entity belief/);
      await assertConcealed(manager.readFile({ relPath: "gigabrain://entity/entity-foreign" }));
      assert.match((await manager.readFile({ relPath: "gigabrain://native/chunk-main" })).text, /Main native chunk/);
      assert.match((await manager.readFile({ relPath: "gigabrain://native/chunk-shared" })).text, /Shared native chunk/);
      await assertConcealed(manager.readFile({ relPath: "gigabrain://native/chunk-ceo" }));

      for (const relPath of [
        "memory/2026-08-25.md",
        "../outside.md",
        "/etc/passwd",
        "gigabrain://memory/main-memory?scope=paperclip-ceo",
      ]) await assert.rejects(manager.readFile({ relPath }), /GIGABRAIN_(?:VIRTUAL_PATH_REQUIRED|INVALID_VIRTUAL_PATH)/);

      const raw = readOperator({
        config: fixture.config,
        relativePath: "memory/2026-08-25.md",
        authority: "operator-admin",
        transport: "loopback",
        pathSource: "cli",
      });
      assert.match(raw.text, /Main private fact/);
      assert.match(raw.text, /CEO private fact/);
      const contained = readContainedRegularFileNoFollowSync(
        fixture.config.runtime.paths.workspaceRoot,
        "memory/2026-08-25.md",
        "utf8",
      );
      assert.match(contained.data, /Shared fact/);
      for (const params of [
        { relativePath: "/etc/passwd", authority: "operator-admin", transport: "loopback", pathSource: "cli" },
        { relativePath: "../outside.md", authority: "operator-admin", transport: "loopback", pathSource: "cli" },
        { relativePath: "memory/linked.md", authority: "operator-admin", transport: "loopback", pathSource: "cli" },
        { relativePath: "memory", authority: "operator-admin", transport: "loopback", pathSource: "cli" },
        { relativePath: "memory/2026-08-25.md", authority: "agent", transport: "loopback", pathSource: "cli" },
        { relativePath: "memory/2026-08-25.md", authority: "operator-admin", transport: "remote", pathSource: "cli" },
        { relativePath: "memory/2026-08-25.md", authority: "operator-admin", transport: "loopback", pathSource: "model" },
        { relativePath: "memory/2026-08-25.md", authority: "operator-admin", transport: "loopback", pathSource: "cli", scopeOverride: "shared" },
      ]) assert.throws(() => readOperator({ config: fixture.config, ...params }), /GIGABRAIN_RAW_READ_FORBIDDEN|GIGABRAIN_PATH_REJECTED/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

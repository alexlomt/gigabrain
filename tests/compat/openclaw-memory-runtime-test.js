import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";
import { ensureProjectionStore, upsertCurrentMemory } from "../../lib/core/projection-store.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OPENCLAW_MEMORY_RUNTIME missing governed OpenClaw runtime adapter";

const sha = (value) => createHash("sha256").update(value).digest("hex");

const treeHash = (root) => {
  if (!root || !statSync(root, { throwIfNoEntry: false })) return "missing";
  const rows = [];
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, rel);
      else if (entry.isFile()) rows.push(`${rel}\0${sha(readFileSync(absolute))}`);
    }
  };
  walk(root);
  return sha(rows.join("\n"));
};

const logicalDbHash = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const rows = [];
    for (const { name } of tables) {
      const quoted = `"${String(name).replaceAll('"', '""')}"`;
      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all().map((row) => String(row.name));
      const order = columns.length ? ` ORDER BY ${columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(",")}` : "";
      rows.push([name, db.prepare(`SELECT * FROM ${quoted}${order}`).all()]);
    }
    return sha(JSON.stringify(rows));
  } finally {
    db.close();
  }
};

const snapshot = (fixture) => ({
  db: logicalDbHash(fixture.dbPath),
  graph: treeHash(fixture.graph),
  native: treeHash(fixture.native),
  output: treeHash(fixture.output),
  queues: [fixture.queue, fixture.remoteQueue].map((file) => sha(readFileSync(file))),
  vault: treeHash(fixture.vault),
});

const makeFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task5-runtime-"));
  const workspace = path.join(root, "workspace");
  const native = path.join(workspace, "memory");
  const output = path.join(workspace, "output");
  const graph = path.join(workspace, "graph");
  const vault = path.join(workspace, "vault");
  for (const dir of [native, output, graph, vault]) mkdirSync(dir, { recursive: true });
  const dbPath = path.join(native, "registry.sqlite");
  const queue = path.join(output, "memory-review-queue.jsonl");
  const remoteQueue = path.join(output, "remote-memory-review-queue.jsonl");
  writeFileSync(path.join(native, "2026-08-25.md"), "# 2026-08-25\n\n- Native fixture. <!-- gigabrain:scope=profile:main -->\n");
  writeFileSync(queue, "");
  writeFileSync(remoteQueue, "");
  writeFileSync(path.join(output, "surface.json"), "{\"stable\":true}\n");
  writeFileSync(path.join(graph, "graph.json"), "{\"nodes\":[]}\n");
  writeFileSync(path.join(vault, "note.md"), "# Vault fixture\n");
  const db = new DatabaseSync(dbPath);
  ensureProjectionStore(db);
  upsertCurrentMemory(db, {
    memory_id: "main-memory",
    type: "DECISION",
    content: "Synthetic harbour memory",
    normalized: "synthetic harbour memory",
    scope: "profile:main",
    status: "active",
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  });
  db.close();
  return {
    root, workspace, native, output, graph, vault, dbPath, queue, remoteQueue,
    config: {
      enabled: true,
      compat: { writeMode: "full" },
      runtime: {
        timezone: "UTC",
        paths: {
          workspaceRoot: workspace,
          memoryRoot: native,
          registryPath: dbPath,
          outputDir: output,
          reviewQueuePath: queue,
        },
      },
      native: { enabled: true, memoryMdPath: path.join(workspace, "MEMORY.md"), includeFiles: [] },
      recall: { autoInjectEnabled: false, topK: 8, maxTokens: 1200, semanticRerankEnabled: false },
      capture: { enabled: false },
      synthesis: { enabled: false },
    },
  };
};

export async function run() {
  const adapter = await importContractModule("lib/compat/openclaw-adapter.js", EXPECTED_SIGNATURE);
  const runtimeModule = await importContractModule("lib/compat/openclaw-memory-runtime.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const register = requireCallable(adapter, "registerOpenClawCompatibility");
    const createRuntime = requireCallable(runtimeModule, "createGigabrainMemoryRuntime");
    const fixture = makeFixture();
    try {
      const partial = [];
      assert.throws(
        () => register({
          registerCli: () => partial.push("cli"),
          on: (name) => partial.push(`hook:${name}`),
        }, fixture.config),
        /GIGABRAIN_UNSUPPORTED_OPENCLAW_MEMORY_CAPABILITY/,
      );
      assert.deepEqual(partial, [], "an unsupported host must receive zero partial registrations");

      const missingCli = [];
      assert.throws(
        () => register({
          registerMemoryCapability: () => missingCli.push("capability"),
          on: (name) => missingCli.push(`hook:${name}`),
        }, fixture.config),
        /GIGABRAIN_UNSUPPORTED_OPENCLAW_CLI/,
      );
      assert.deepEqual(missingCli, [], "CLI preflight must happen before capability registration");

      const calls = [];
      const handlers = new Map();
      const beforeRegistration = snapshot(fixture);
      register({
        registerMemoryCapability: (capability) => calls.push(["capability", capability]),
        registerCli: (registrar, options) => calls.push(["cli", registrar, options]),
        on: (name, handler) => {
          calls.push(["hook", name]);
          handlers.set(name, handler);
        },
        logger: { info() {}, warn() {}, error() {} },
      }, fixture.config);
      assert.deepEqual(snapshot(fixture), beforeRegistration, "registration must be observational");
      assert.equal(calls.filter(([kind]) => kind === "capability").length, 1);
      assert.equal(calls.filter(([kind]) => kind === "cli").length, 1);
      assert.equal(calls.some(([, name]) => name === "before_agent_start"), false);
      assert.equal(handlers.has("before_prompt_build"), true);
      const capability = calls.find(([kind]) => kind === "capability")[1];
      assert.equal(typeof capability.runtime?.getMemorySearchManager, "function");
      assert.equal(typeof capability.flushPlanResolver, "function");

      const runtime = createRuntime(fixture.config);
      const beforeManager = snapshot(fixture);
      const resolved = await runtime.getMemorySearchManager({ cfg: {}, agentId: "main", purpose: "status" });
      assert.equal(resolved.error, undefined);
      assert.equal(resolved.manager.status().backend, "qmd", "the pinned host routes custom runtimes through its qmd backend branch");
      assert.equal(resolved.manager.status().provider, "gigabrain");
      const results = await resolved.manager.search("harbour", { maxResults: 5 });
      assert.equal(results.length, 1);
      assert.match(results[0].snippet, /harbour/i);
      assert.deepEqual(snapshot(fixture), beforeManager, "status and first search must be observational");
      assert.equal(typeof resolved.manager.sync, "undefined", "the adapter must not expose an implicit sync seam");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

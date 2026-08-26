import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { captureFromEvent } from "../../lib/core/capture-service.js";
import { createMcpServer } from "../../lib/core/codex-mcp.js";
import { runRemember } from "../../lib/core/codex-service.js";
import {
  appendCheckpointEpisode,
  appendClaimDecision,
  appendClaimProposal,
  appendMemoryReceipt,
} from "../../lib/core/control-plane.js";
import { createMemoryHttpHandler } from "../../lib/core/http-routes.js";
import { runMaintenance } from "../../lib/core/maintenance-service.js";
import { applyMemoryActions } from "../../lib/core/memory-actions.js";
import { writeNativeMemoryEntry, writeNativeSessionCheckpoint } from "../../lib/core/native-memory.js";
import { resolveRemoteMcpOptions } from "../../lib/core/remote-mcp.js";
import { openDatabase } from "../../lib/core/sqlite.js";
import { ensureProjectionStore, upsertCurrentMemory } from "../../lib/core/projection-store.js";
import { harvestTranscripts } from "../../lib/core/transcript-harvester.js";
import { projectWiki, reconcileWiki } from "../../lib/core/wiki-project.js";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_WRITE_MODE_GATE missing complete fail-closed writer policy";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const snapshotTree = (root) => {
  if (!existsSync(root)) return "missing";
  const rows = [];
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) rows.push(`${relative}:${statSync(absolute).mode & 0o777}:${sha(readFileSync(absolute))}`);
    }
  };
  walk(root);
  return sha(rows.join("\n"));
};

export async function run() {
  const policy = await importContractModule("lib/compat/write-policy.js", EXPECTED_SIGNATURE);
  const runtime = await importContractModule("lib/compat/openclaw-memory-runtime.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const assertWriteAllowed = requireCallable(policy, "assertWriteAllowed");
    const assertWriterRegistryComplete = requireCallable(policy, "assertWriterRegistryComplete");
    const discoverWriterEntrypoints = requireCallable(policy, "discoverWriterEntrypoints");
    const captureNative = requireCallable(runtime, "captureNativeExplicitRemember");
    const registry = policy.WRITER_REGISTRY;
    const discovered = discoverWriterEntrypoints({ repoRoot });
    assert.equal(assertWriterRegistryComplete(discovered), true);
    const discoveredIds = new Set(discovered.map((entry) => entry.operation));
    for (const required of ["package.migrate-v3", "package.harmonize", "cli.inventory", "cli.vault.inbox"]) {
      assert.equal(discoveredIds.has(required), true, `discovery must include ${required}`);
      assert.ok(registry[required], `registry must classify ${required}`);
    }
    const operations = Object.keys(registry).sort();
    for (const operation of operations.filter((item) => registry[item].access === "write")) {
      assert.throws(() => assertWriteAllowed({ mode: "read_only", operation }), /GIGABRAIN_WRITE_FORBIDDEN/);
      assert.doesNotThrow(() => assertWriteAllowed({ mode: "full", operation }));
      if (operation === "openclaw.native_explicit_remember") {
        assert.doesNotThrow(() => assertWriteAllowed({ mode: "native_only", operation }));
      } else {
        assert.throws(() => assertWriteAllowed({ mode: "native_only", operation }), /GIGABRAIN_WRITE_FORBIDDEN/);
      }
    }
    assert.throws(() => assertWriteAllowed({ mode: "full", operation: "future.unclassified_writer" }), /GIGABRAIN_UNCLASSIFIED_WRITER/);
    assert.throws(() => assertWriteAllowed({ mode: "unexpected", operation: "capture.capture_from_event" }), /GIGABRAIN_INVALID_WRITE_MODE/);

    const discoveryRoot = mkdtempSync(path.join(tmpdir(), "gigabrain-writer-discovery-"));
    try {
      mkdirSync(path.join(discoveryRoot, "scripts"), { recursive: true });
      writeFileSync(path.join(discoveryRoot, "package.json"), JSON.stringify({ scripts: { "future-writer": "node scripts/future-writer.js" } }));
      writeFileSync(path.join(discoveryRoot, "scripts", "future-writer.js"), "import { writeFileSync } from 'node:fs'; writeFileSync('state', 'changed');\n");
      const future = discoverWriterEntrypoints({ repoRoot: discoveryRoot });
      assert.equal(future.some((entry) => entry.operation === "package.future-writer"), true);
      assert.throws(() => assertWriterRegistryComplete(future), /GIGABRAIN_UNCLASSIFIED_WRITER/);
      writeFileSync(path.join(discoveryRoot, "scripts", "gigabrainctl.js"), `
        import { writeFileSync } from "node:fs";
        const command = "future";
        const flags = ["write"];
        const resolveCliWriteOperation = () => "";
        const commandFuture = async () => {
          const subcommand = String(flags[0] || "");
          if (subcommand === "write") writeFileSync("state", "changed");
        };
        if (command === "future") await commandFuture();
      `);
      const nestedFuture = discoverWriterEntrypoints({ repoRoot: discoveryRoot });
      assert.equal(
        nestedFuture.some((entry) => entry.operation === "cli.future.write" && entry.access === "write"),
        true,
        "nested CLI writers must be derived from branch behavior, not only the declaration map",
      );
      assert.throws(() => assertWriterRegistryComplete(nestedFuture), /GIGABRAIN_UNCLASSIFIED_WRITER/);
    } finally {
      rmSync(discoveryRoot, { recursive: true, force: true });
    }

    const readOnlyConfig = {
      compat: { writeMode: "read_only" },
      native: { transcripts: { enabled: false }, wiki: { enabled: false } },
      runtime: { paths: {} },
    };
    assert.throws(() => captureFromEvent({ config: readOnlyConfig, db: null }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => applyMemoryActions({
      config: readOnlyConfig,
      db: null,
      actions: [{ action: "forget" }],
    }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => harvestTranscripts({ config: readOnlyConfig, db: {} }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => projectWiki({ config: readOnlyConfig, db: null }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => reconcileWiki({ config: readOnlyConfig, db: null }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => runMaintenance({ config: readOnlyConfig, dbPath: "" }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => writeNativeMemoryEntry({ config: readOnlyConfig }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => writeNativeSessionCheckpoint({ config: readOnlyConfig }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => appendCheckpointEpisode(null, { writeMode: "read_only" }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => appendClaimProposal(null, { writeMode: "read_only" }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => appendClaimDecision(null, { writeMode: "read_only" }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => appendMemoryReceipt(null, { writeMode: "read_only" }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => runRemember({ config: readOnlyConfig, content: "synthetic", target: "project" }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.ok(createMcpServer({ config: readOnlyConfig }));
    assert.equal(typeof createMemoryHttpHandler({ config: readOnlyConfig, dbPath: "", token: "" }), "function");
    assert.throws(() => resolveRemoteMcpOptions({
      allowedScopes: ["shared"],
      allowNoAuth: true,
      enableWrites: true,
      writeMode: "read_only",
    }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => openDatabase("/definitely/not/a/gigabrain/registry.sqlite", {
      observational: true,
      readOnly: true,
    }));
    const gigabrainCtlSource = readFileSync("scripts/gigabrainctl.js", "utf8");
    const gigabrainMcpSource = readFileSync("scripts/gigabrain-mcp.js", "utf8");
    const harmonizeSource = readFileSync("scripts/harmonize-memory.js", "utf8");
    const migrateV3Source = readFileSync("scripts/migrate-v3.js", "utf8");
    const setupSource = readFileSync("scripts/setup-first-run.js", "utf8");
    assert.match(gigabrainCtlSource, /assertWriteAllowed/);
    assert.match(gigabrainMcpSource, /writeMode/);
    assert.match(harmonizeSource, /package\.harmonize/);
    assert.match(migrateV3Source, /package\.migrate-v3/);
    assert.match(setupSource, /setup\.first_run/);

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task5-native-only-"));
    try {
      const workspace = path.join(root, "workspace");
      const memoryRoot = path.join(workspace, "memory");
      const config = {
        compat: { writeMode: "native_only" },
        runtime: { paths: {
          workspaceRoot: workspace,
          memoryRoot,
          registryPath: path.join(memoryRoot, "registry.sqlite"),
          reviewQueuePath: path.join(workspace, "output", "memory-review-queue.jsonl"),
          outputDir: path.join(workspace, "output"),
        } },
        native: { memoryMdPath: path.join(workspace, "MEMORY.md") },
      };
      const result = captureNative({
        config,
        event: {
          output: '<memory_note type="PREFERENCE" confidence="0.93">Use synthetic harbour fixtures.</memory_note>',
          agentId: "main",
          sessionKey: "agent:main:test",
        },
        scope: "profile:main",
        now: "2026-08-25T12:00:00.000Z",
      });
      assert.equal(result.written, 1);
      const nativeText = readFileSync(path.join(memoryRoot, "2026-08-25.md"), "utf8");
      assert.match(nativeText, /Remembered Today/);
      assert.match(nativeText, /Use synthetic harbour fixtures/);
      assert.match(nativeText, /gigabrain:scope=profile:main/);
      assert.equal(existsSync(config.runtime.paths.registryPath), false, "native_only must not create a registry");
      assert.equal(existsSync(config.runtime.paths.reviewQueuePath), false, "native_only must not create a queue");
      assert.throws(() => captureNative({
        config,
        event: { output: "Use synthetic harbour fixtures." },
        scope: "profile:main",
        now: "2026-08-25T12:00:00.000Z",
      }), /GIGABRAIN_NATIVE_NOTE_METADATA_REQUIRED/);
      assert.throws(() => captureNative({
        config,
        event: { output: '<memory_note type="PREFERENCE">Missing confidence.</memory_note>' },
        scope: "profile:main",
        now: "2026-08-25T12:00:00.000Z",
      }), /GIGABRAIN_NATIVE_NOTE_METADATA_REQUIRED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const entryRoot = mkdtempSync(path.join(tmpdir(), "gigabrain-task5-entrypoint-guard-"));
    try {
      const workspace = path.join(entryRoot, "workspace");
      const memoryRoot = path.join(workspace, "memory");
      const outputDir = path.join(workspace, "output");
      mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
      mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      const dbPath = path.join(memoryRoot, "registry.sqlite");
      const db = new DatabaseSync(dbPath);
      ensureProjectionStore(db);
      upsertCurrentMemory(db, {
        memory_id: "writer-guard-memory",
        type: "CONTEXT",
        content: "Writer guard fixture",
        normalized: "writer guard fixture",
        scope: "shared",
        status: "active",
        created_at: "2026-08-25T00:00:00.000Z",
        updated_at: "2026-08-25T00:00:00.000Z",
      });
      db.close();
      const configPath = path.join(entryRoot, "openclaw.json");
      const entryConfig = {
        enabled: true,
        compat: { writeMode: "read_only" },
        runtime: { paths: {
          workspaceRoot: workspace,
          memoryRoot,
          registryPath: dbPath,
          outputDir,
          reviewQueuePath: path.join(outputDir, "queue.jsonl"),
        } },
        native: { enabled: true, memoryMdPath: path.join(workspace, "MEMORY.md"), includeFiles: [] },
      };
      writeFileSync(configPath, JSON.stringify({ plugins: { entries: { gigabrain: { enabled: true, config: entryConfig } } } }));
      const before = snapshotTree(entryRoot);
      for (const [label, script, args] of [
        ["migrate-v3", "scripts/migrate-v3.js", ["--apply", "--config", configPath]],
        ["harmonize", "scripts/harmonize-memory.js", ["--config", configPath]],
        ["vault inbox", "scripts/gigabrainctl.js", ["vault", "inbox", "--config", configPath]],
      ]) {
        const result = spawnSync(process.execPath, [path.join(repoRoot, script), ...args], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
        assert.notEqual(result.status, 0, `${label} must be rejected in read_only`);
        assert.match(`${result.stdout}\n${result.stderr}`, /GIGABRAIN_WRITE_FORBIDDEN/);
        assert.equal(snapshotTree(entryRoot), before, `${label} must reject before any state mutation`);
      }
      const inventory = spawnSync(process.execPath, [
        path.join(repoRoot, "scripts", "gigabrainctl.js"),
        "inventory",
        "--config",
        configPath,
      ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
      assert.equal(inventory.status, 0, String(inventory.stderr || inventory.stdout));
      assert.equal(snapshotTree(entryRoot), before, "read_only inventory must be observational");
    } finally {
      rmSync(entryRoot, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

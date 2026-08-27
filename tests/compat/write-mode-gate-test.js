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
import { ensureAdaptiveTrustStore } from "../../lib/core/adaptive-trust.js";
import { resolveRemoteMcpOptions } from "../../lib/core/remote-mcp.js";
import { openDatabase } from "../../lib/core/sqlite.js";
import { ensureProjectionStore, upsertCurrentMemory } from "../../lib/core/projection-store.js";
import { harvestTranscripts } from "../../lib/core/transcript-harvester.js";
import { projectWiki, reconcileWiki } from "../../lib/core/wiki-project.js";
import { ensureWorldModelReady } from "../../lib/core/world-model.js";
import { assertWriterRegistryComplete as governedWriterRegistryGate } from "../../lib/compat/write-policy.js";

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

const sqliteTableNames = (dbPath) => {
  if (!existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map((row) => String(row.name));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
};

export async function run() {
  const policy = await importContractModule("lib/compat/write-policy.js", EXPECTED_SIGNATURE);
  const runtime = await importContractModule("lib/compat/openclaw-memory-runtime.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const assertWriteAllowed = requireCallable(policy, "assertWriteAllowed");
    const discoverWriterEntrypoints = requireCallable(policy, "discoverWriterEntrypoints");
    const captureNative = requireCallable(runtime, "captureNativeExplicitRemember");
    const registry = policy.WRITER_REGISTRY;
    const discovered = discoverWriterEntrypoints({ repoRoot });
    assert.equal(governedWriterRegistryGate(discovered), true);
    assert.equal(discovered.length, 183, "all shipped entrypoints remain in the discovery inventory");
    assert.equal(
      new Set(discovered.filter((entry) => entry.access === "write").map((entry) => entry.canonicalOperation || entry.operation)).size,
      75,
      "nested aliases must not inflate the canonical shipped-writer count",
    );
    assert.equal(
      discovered.find((entry) => entry.operation === "cli.vault.sync")?.access,
      "write",
      "pure nested discovery must recognize syncVaultMemory without relying on the declaration map alias",
    );
    assert.equal(
      discovered.find((entry) => entry.operation === "cli.wiki.reconcile")?.access,
      "write",
      "explicitly mapped reconcileWiki must classify its nested CLI call as write",
    );
    assert.equal(
      discovered.find((entry) => entry.operation === "cli.surface.build")?.canonicalOperation,
      "cli.surface_build",
      "generated surface build must remain bound to its full-mode writer guard",
    );
    assert.equal(
      discovered.find((entry) => entry.operation === "cli.surface")?.access,
      "read",
      "generated surface status and doctor remain observational",
    );
    const expectedFallbackWriters = new Map([
      ["cli.control.apply", "cli.control_apply"],
      ["cli.migrate.legacy.drop", "cli.migrate"],
      ["cli.sync.hosts.sync", "cli.sync_hosts"],
      ["cli.wiki.project", "cli.wiki_project"],
    ]);
    for (const [operation, canonicalOperation] of expectedFallbackWriters) {
      const entry = discovered.find((item) => item.operation === operation);
      assert.equal(entry?.access, "write", `${operation} must be discovered from fall-through behavior`);
      assert.equal(entry?.canonicalOperation, canonicalOperation, `${operation} must link its actual fallback guard`);
      assert.equal(entry?.branchKind, "fallback", `${operation} must remain independently visible as fallback behavior`);
    }
    assert.deepEqual(
      discovered
        .filter((entry) => entry.branchKind === "fallback" && entry.access === "write")
        .map((entry) => entry.operation)
        .sort(),
      [...expectedFallbackWriters.keys()].sort(),
      "all current fall-through/default writers must be enumerated",
    );
    const discoveredIds = new Set(discovered.map((entry) => entry.operation));
    for (const required of ["package.migrate-v3", "package.harmonize", "cli.inventory", "cli.snapshot", "cli.vault.inbox"]) {
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
      assert.throws(() => governedWriterRegistryGate(future), /GIGABRAIN_UNCLASSIFIED_WRITER/);
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
      assert.throws(() => governedWriterRegistryGate(nestedFuture), /GIGABRAIN_UNGUARDED_WRITER/);

      mkdirSync(path.join(discoveryRoot, "lib", "core"), { recursive: true });
      writeFileSync(path.join(discoveryRoot, "lib", "core", "domain-state.js"), `
        import { writeFileSync } from "node:fs";
        const syncDomainState = () => writeFileSync("domain-state", "changed");
        export { syncDomainState };
      `);
      writeFileSync(path.join(discoveryRoot, "lib", "core", "vault-sync.js"), `
        import { writeFileSync } from "node:fs";
        const syncVaultMemory = () => writeFileSync("vault-state", "changed");
        export { syncVaultMemory };
      `);
      writeFileSync(path.join(discoveryRoot, "scripts", "gigabrainctl.js"), `
        import { openDatabase } from "../lib/core/sqlite.js";
        import { syncDomainState } from "../lib/core/domain-state.js";
        import { syncVaultMemory } from "../lib/core/vault-sync.js";
        const command = "future";
        const flags = ["domain"];
        const resolveCliWriteOperation = () => "";
        const commandFuture = async () => {
          const subcommand = String(flags[0] || "");
          if (subcommand === "domain") syncDomainState();
          if (subcommand === "known") syncVaultMemory();
          if (subcommand === "db-write") openDatabase("state.sqlite");
          if (subcommand === "db-ambiguous") openDatabase("state.sqlite", {});
          if (subcommand === "db-read") openDatabase("state.sqlite", { readOnly: true, observational: true });
        };
        if (command === "future") await commandFuture();
      `);
      const domainDiscovery = discoverWriterEntrypoints({ repoRoot: discoveryRoot });
      for (const operation of [
        "cli.future.domain",
        "cli.future.known",
        "cli.future.db.write",
        "cli.future.db.ambiguous",
      ]) {
        assert.equal(
          domainDiscovery.find((entry) => entry.operation === operation)?.access,
          "write",
          `${operation} must fail closed as a nested writer`,
        );
      }
      assert.equal(
        domainDiscovery.find((entry) => entry.operation === "cli.future.db.read")?.access,
        "read",
        "structurally proven read-only SQLite opens must remain readers",
      );

      const explicitMapRoot = path.join(discoveryRoot, "explicit-map");
      mkdirSync(path.join(explicitMapRoot, "lib", "core"), { recursive: true });
      mkdirSync(path.join(explicitMapRoot, "scripts"), { recursive: true });
      writeFileSync(path.join(explicitMapRoot, "package.json"), JSON.stringify({ scripts: {} }));
      writeFileSync(path.join(explicitMapRoot, "lib", "core", "domain-state.js"), `
        const settleDomainState = () => ({ settled: true });
        export { settleDomainState };
      `);
      writeFileSync(path.join(explicitMapRoot, "scripts", "gigabrainctl.js"), `
        import { settleDomainState as closeState } from "../lib/core/domain-state.js";
        const command = "future";
        const flags = ["settle"];
        const resolveCliWriteOperation = () => {
          const subcommand = String(flags[0] || "");
          const operations = { future: subcommand === "settle" ? "cli.audit" : "" };
          return String(operations[command] || "");
        };
        const commandFuture = async () => {
          const subcommand = String(flags[0] || "");
          if (subcommand === "settle") closeState();
        };
        if (command === "future") await commandFuture();
      `);
      const explicitMapDiscovery = discoverWriterEntrypoints({
        repoRoot: explicitMapRoot,
        exportedWriterOperationBySymbol: {
          "lib/core/domain-state.js#settleDomainState": "internal.event.append",
        },
      });
      assert.equal(
        explicitMapDiscovery.some((entry) => entry.operation === "internal.event.append" && entry.symbol === "settleDomainState"),
        true,
        "explicit map membership must discover a non-generic exported writer symbol",
      );
      assert.equal(
        explicitMapDiscovery.find((entry) => entry.operation === "cli.future.settle")?.access,
        "write",
        "explicitly mapped writers must propagate through import aliases into nested call sites",
      );
      assert.equal(governedWriterRegistryGate(explicitMapDiscovery), true);

      const missingGuardRoot = path.join(discoveryRoot, "missing-guard");
      mkdirSync(path.join(missingGuardRoot, "scripts"), { recursive: true });
      writeFileSync(path.join(missingGuardRoot, "package.json"), JSON.stringify({ scripts: {} }));
      const currentCliSource = readFileSync(path.join(repoRoot, "scripts", "gigabrainctl.js"), "utf8");
      const missingInboxGuardSource = currentCliSource.replace(
        "subcommand === 'sync' ? 'cli.vault_sync' : subcommand === 'inbox' ? 'cli.vault.inbox' : ''",
        "subcommand === 'sync' ? 'cli.vault_sync' : ''",
      );
      assert.notEqual(missingInboxGuardSource, currentCliSource, "fixture must remove the shipped vault-inbox guard mapping");
      writeFileSync(path.join(missingGuardRoot, "scripts", "gigabrainctl.js"), missingInboxGuardSource);
      const missingGuardDiscovery = discoverWriterEntrypoints({ repoRoot: missingGuardRoot });
      assert.equal(
        missingGuardDiscovery.find((entry) => entry.operation === "cli.vault.inbox")?.access,
        "write",
        "vault inbox must remain behaviorally discovered after its guard mapping is removed",
      );
      assert.throws(
        () => governedWriterRegistryGate(missingGuardDiscovery),
        /GIGABRAIN_UNGUARDED_WRITER/,
        "a dotted registry classification must not conceal a missing pre-work guard link",
      );

      const missingFallbackGuardRoot = path.join(discoveryRoot, "missing-fallback-guards");
      mkdirSync(path.join(missingFallbackGuardRoot, "scripts"), { recursive: true });
      writeFileSync(path.join(missingFallbackGuardRoot, "package.json"), JSON.stringify({ scripts: {} }));
      const fallbackGuardRemovals = [
        {
          operation: "cli.control.apply",
          from: "control: subcommand === 'apply' ? 'cli.control_apply' : '',",
          to: "control: '',",
        },
        {
          operation: "cli.migrate.legacy.drop",
          from: "migrate: 'cli.migrate',",
          to: "migrate: '',",
        },
        {
          operation: "cli.sync.hosts.sync",
          from: "'sync-hosts': subcommand === 'status' ? '' : 'cli.sync_hosts',",
          to: "'sync-hosts': '',",
        },
        {
          operation: "cli.wiki.project",
          from: "wiki: subcommand === 'project' ? 'cli.wiki_project' : subcommand === 'reconcile' ? 'cli.wiki_reconcile' : '',",
          to: "wiki: subcommand === 'reconcile' ? 'cli.wiki_reconcile' : '',",
        },
      ];
      for (const fixture of fallbackGuardRemovals) {
        const changedSource = currentCliSource.replace(fixture.from, fixture.to);
        assert.notEqual(changedSource, currentCliSource, `fixture must remove the shipped ${fixture.operation} fallback guard`);
        writeFileSync(path.join(missingFallbackGuardRoot, "scripts", "gigabrainctl.js"), changedSource);
        const changedDiscovery = discoverWriterEntrypoints({ repoRoot: missingFallbackGuardRoot });
        assert.equal(
          changedDiscovery.find((entry) => entry.operation === fixture.operation)?.access,
          "write",
          `${fixture.operation} must remain behaviorally discovered after its fallback guard is removed`,
        );
        assert.throws(
          () => governedWriterRegistryGate(changedDiscovery),
          /GIGABRAIN_UNGUARDED_WRITER/,
          `removing the ${fixture.operation} fallback guard must fail completeness`,
        );
      }

      const fallbackRoot = path.join(discoveryRoot, "future-fallback");
      mkdirSync(path.join(fallbackRoot, "scripts"), { recursive: true });
      writeFileSync(path.join(fallbackRoot, "package.json"), JSON.stringify({ scripts: {} }));
      writeFileSync(path.join(fallbackRoot, "scripts", "gigabrainctl.js"), `
        import { writeFileSync } from "node:fs";
        const command = "future";
        const flags = [];
        const resolveCliWriteOperation = () => {
          const subcommand = String(flags[0] || "apply").trim().toLowerCase();
          const operations = { future: subcommand === "status" ? "" : "cli.audit" };
          return String(operations[command] || "");
        };
        const commandFuture = async () => {
          const subcommand = String(flags[0] || "apply").trim().toLowerCase();
          if (!subcommand || subcommand === "--help" || subcommand === "-h") {
            console.log("usage");
            return;
          }
          if (!["apply", "status"].includes(subcommand)) throw new Error("unknown future subcommand");
          if (subcommand === "status") {
            console.log("status");
            return;
          }
          writeFileSync("state", "changed");
        };
        if (command === "future") await commandFuture();
      `);
      const fallbackDiscovery = discoverWriterEntrypoints({ repoRoot: fallbackRoot });
      const futureFallback = fallbackDiscovery.find((entry) => entry.operation === "cli.future.apply");
      assert.equal(futureFallback?.access, "write", "future fall-through writers must be discovered from residual behavior");
      assert.equal(futureFallback?.canonicalOperation, "cli.audit", "future fall-through writers must link the resolver fallback");
      assert.equal(futureFallback?.branchKind, "fallback", "future fall-through writers need a distinct behavioral row");
      assert.equal(
        fallbackDiscovery.find((entry) => entry.operation === "cli.future.status")?.access,
        "read",
        "explicit default-read branches must not become writer false positives",
      );
      assert.equal(governedWriterRegistryGate(fallbackDiscovery), true);
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

    const readerCommands = [
      { label: "world entities", args: ["world", "entities"] },
      { label: "synthesis list", args: ["synthesis", "list"] },
      { label: "orchestrator explain", args: ["orchestrator", "explain", "--query", "synthetic harbour"] },
      { label: "briefing", args: ["briefing"] },
      { label: "review contradictions", args: ["review", "contradictions"] },
      { label: "review open-loops", args: ["review", "open-loops"] },
      { label: "review trust", args: ["review", "trust"] },
      { label: "review adjudications", args: ["review", "adjudications"] },
      { label: "review beliefs-as-of", args: ["review", "beliefs-as-of", "--at", "2026-08-25T00:00:00.000Z"] },
      { label: "review queue", args: ["review", "queue"] },
    ];
    for (const dbState of ["missing", "empty", "ready"]) {
      for (const reader of readerCommands) {
        const readerRoot = mkdtempSync(path.join(tmpdir(), `gigabrain-task5-reader-${dbState}-`));
        try {
          const workspace = path.join(readerRoot, "workspace");
          const memoryRoot = path.join(workspace, "memory");
          const outputDir = path.join(workspace, "output");
          mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
          mkdirSync(outputDir, { recursive: true, mode: 0o700 });
          const dbPath = path.join(memoryRoot, "registry.sqlite");
          const configPath = path.join(readerRoot, "openclaw.json");
          const readerConfig = {
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
          if (dbState === "empty") new DatabaseSync(dbPath).close();
          if (dbState === "ready") {
            const setupDb = new DatabaseSync(dbPath);
            ensureProjectionStore(setupDb);
            ensureWorldModelReady({ db: setupDb, config: readerConfig, rebuildIfEmpty: false });
            ensureAdaptiveTrustStore(setupDb);
            setupDb.close();
          }
          writeFileSync(configPath, JSON.stringify({ plugins: { entries: { gigabrain: { enabled: true, config: readerConfig } } } }));
          const before = snapshotTree(readerRoot);
          const result = spawnSync(process.execPath, [
            path.join(repoRoot, "scripts", "gigabrainctl.js"),
            ...reader.args,
            "--config",
            configPath,
          ], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
          assert.equal(result.status, 0, `${reader.label}/${dbState}: ${String(result.stderr || result.stdout)}`);
          const after = snapshotTree(readerRoot);
          if (after !== before) {
            process.stderr.write(`[reader-mutation] ${reader.label}/${dbState} tables=${sqliteTableNames(dbPath).join(",") || "none"}\n`);
          }
          assert.equal(
            after,
            before,
            `${reader.label}/${dbState} must be byte-identical; observed tables: ${sqliteTableNames(dbPath).join(",") || "none"}`,
          );
          const parsed = JSON.parse(String(result.stdout || "{}"));
          assert.equal(parsed.read_only ?? parsed.observational, true, `${reader.label}/${dbState} must identify its read-only result`);
          if (reader.args[1] !== "queue" && dbState !== "ready") {
            assert.match(String(parsed.diagnostic || ""), dbState === "missing" ? /registry does not exist/ : /schema is unavailable/);
          }
        } finally {
          rmSync(readerRoot, { recursive: true, force: true });
        }
      }
    }

    const sharedSetupRoot = mkdtempSync(path.join(tmpdir(), "gigabrain-task5-shared-setup-discovery-"));
    try {
      mkdirSync(path.join(sharedSetupRoot, "scripts"), { recursive: true });
      writeFileSync(path.join(sharedSetupRoot, "package.json"), JSON.stringify({ scripts: {} }));
      writeFileSync(path.join(sharedSetupRoot, "scripts", "gigabrainctl.js"), `
        import { openDatabase } from "../lib/core/sqlite.js";
        const command = "future";
        const flags = ["read"];
        const resolveCliWriteOperation = () => flags[0] === "write" ? "cli.audit" : "";
        const commandFuture = async () => {
          const action = String(flags[0] || "read");
          const db = openDatabase("state.sqlite");
          if (action === "read") console.log(db.prepare("SELECT 1").get());
          if (action === "write") db.exec("CREATE TABLE state (id INTEGER)");
        };
        if (command === "future") await commandFuture();
      `);
      const sharedSetupDiscovery = discoverWriterEntrypoints({ repoRoot: sharedSetupRoot });
      assert.equal(
        sharedSetupDiscovery.find((entry) => entry.operation === "cli.future.read")?.access,
        "write",
        "nested discovery must include shared setup before the reader branch",
      );
    } finally {
      rmSync(sharedSetupRoot, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

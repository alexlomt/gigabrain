import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";
import { runMemoryDoctorRead, runMemoryGet, runMemorySearch, runMemoryStatus } from "../../lib/compat/openclaw-memory-cli.js";
import { ensureControlPlaneStore } from "../../lib/core/control-plane.js";
import { ensureEventStore } from "../../lib/core/event-store.js";
import { ensureHostMemoryStore, listMemorySources } from "../../lib/core/host-memory-sync.js";
import { captureSnapshotMetrics } from "../../lib/core/metrics.js";
import { ensureNativeStore } from "../../lib/core/native-sync.js";
import { ensurePersonStore } from "../../lib/core/person-service.js";
import { ensureProjectionStore, getCurrentMemory, upsertCurrentMemory } from "../../lib/core/projection-store.js";
import { runProvenance, runRecent, runSources, runSyncStatus } from "../../lib/core/codex-service.js";
import { ensureTranscriptStore, transcriptStatus } from "../../lib/core/transcript-harvester.js";
import { ensureVaultStore } from "../../lib/core/vault-sync.js";
import { ensureWorldModelStore } from "../../lib/core/world-model.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OBSERVATIONAL_DIAGNOSTICS missing zero-write diagnostics guard";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const runCli = (args) => spawnSync(process.execPath, [path.join(repoRoot, "scripts", "gigabrainctl.js"), ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C" },
  timeout: 30_000,
});

const verifyDirectReadHelpers = (fixture) => {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const directMetrics = captureSnapshotMetrics(db, fixture.dbPath, { ensure: false });
    const directMemory = getCurrentMemory(db, "diagnostic-memory", { ensure: false });
    const directSources = listMemorySources({ db, config: fixture.config });
    const directTranscript = transcriptStatus({ db, config: fixture.config });
    assert.equal(directMetrics.totals.all, 1);
    assert.equal(directMemory.memory_id, "diagnostic-memory");
    assert.equal(Array.isArray(directSources.sources), true);
    assert.equal(Array.isArray(directTranscript.sources), true);
  } finally {
    db.close();
  }
};

const makeFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task5-observational-"));
  const workspace = path.join(root, "workspace");
  const memoryRoot = path.join(workspace, "memory");
  const outputDir = path.join(workspace, "output");
  const graphDir = path.join(workspace, "graph");
  const vaultDir = path.join(workspace, "vault");
  for (const dir of [memoryRoot, outputDir, graphDir, vaultDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(memoryRoot, "registry.sqlite");
  const reviewQueuePath = path.join(outputDir, "memory-review-queue.jsonl");
  const remoteQueuePath = path.join(outputDir, "remote-memory-review-queue.jsonl");
  writeFileSync(path.join(memoryRoot, "2026-08-25.md"), "# 2026-08-25\n\n- Observational harbour fact. <!-- gigabrain:scope=project:diagnostic -->\n", { mode: 0o600 });
  writeFileSync(reviewQueuePath, "", { mode: 0o600 });
  writeFileSync(remoteQueuePath, "", { mode: 0o600 });
  writeFileSync(path.join(outputDir, "surface.json"), "{\"stable\":true}\n", { mode: 0o600 });
  writeFileSync(path.join(graphDir, "graph.json"), "{\"nodes\":[]}\n", { mode: 0o600 });
  writeFileSync(path.join(vaultDir, "note.md"), "# Vault fixture\n", { mode: 0o600 });

  const db = new DatabaseSync(dbPath);
  ensureProjectionStore(db);
  ensureEventStore(db);
  ensureNativeStore(db);
  ensurePersonStore(db);
  ensureWorldModelStore(db);
  ensureControlPlaneStore(db);
  ensureHostMemoryStore(db);
  ensureTranscriptStore(db);
  ensureVaultStore(db);
  upsertCurrentMemory(db, {
    memory_id: "diagnostic-memory",
    type: "CONTEXT",
    content: "Observational harbour fact",
    normalized: "observational harbour fact",
    scope: "project:diagnostic",
    status: "active",
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  });
  db.close();

  const config = {
    enabled: true,
    compat: { writeMode: "read_only" },
    runtime: { paths: { workspaceRoot: workspace, memoryRoot, registryPath: dbPath, outputDir, reviewQueuePath } },
    native: {
      enabled: true,
      memoryMdPath: path.join(workspace, "MEMORY.md"),
      includeFiles: [],
      transcripts: { enabled: false },
      vaults: [],
    },
    recall: { semanticRerankEnabled: false },
    codex: {
      enabled: true,
      projectRoot: workspace,
      projectStorePath: workspace,
      projectScope: "project:diagnostic",
      storeMode: "project",
      defaultTarget: "project",
      recallOrder: ["project"],
    },
  };
  const configPath = path.join(root, "openclaw.json");
  writeFileSync(configPath, `${JSON.stringify({ plugins: { entries: { gigabrain: { enabled: true, config } } } }, null, 2)}\n`, { mode: 0o600 });
  return { config, configPath, dbPath, graphDir, memoryRoot, outputDir, remoteQueuePath, reviewQueuePath, root, vaultDir, workspace };
};

export async function run() {
  const diagnostics = await importContractModule("lib/compat/observational-diagnostics.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const snapshotState = requireCallable(diagnostics, "snapshotObservationalState");
    const assertUnchanged = requireCallable(diagnostics, "assertObservationalStateUnchanged");
    const cliSource = readFileSync("scripts/gigabrainctl.js", "utf8");
    const metricsSource = readFileSync("lib/core/metrics.js", "utf8");
    const projectionSource = readFileSync("lib/core/projection-store.js", "utf8");
    const hostSyncSource = readFileSync("lib/core/host-memory-sync.js", "utf8");
    const transcriptSource = readFileSync("lib/core/transcript-harvester.js", "utf8");
    assert.match(cliSource, /readOnly:\s*true/);
    assert.match(metricsSource, /options\.ensure !== false/);
    assert.match(projectionSource, /options\.ensure !== false/);
    assert.match(hostSyncSource, /hasTable\(db, 'memory_(?:source_links|host_sync_runs)'\)/);
    assert.doesNotMatch(transcriptSource.match(/const transcriptStatus[\s\S]*?return \{/i)?.[0] || "", /ensureTranscriptStore/);
    const fixture = makeFixture();
    const stateOptions = {
      dbPath: fixture.dbPath,
      roots: [fixture.memoryRoot, fixture.outputDir, fixture.graphDir, fixture.vaultDir],
      files: [fixture.reviewQueuePath, fixture.remoteQueuePath, fixture.configPath],
    };
    const io = { stdout: { write() {} } };
    const check = async (label, operation) => {
      const before = snapshotState(stateOptions);
      await operation();
      assert.equal(assertUnchanged(before, snapshotState(stateOptions), label), true);
    };
    try {
      for (const [label, args] of [
        ["help", ["--help"]],
        ["doctor", ["doctor", "--config", fixture.configPath, "--target", "project"]],
        ["inventory", ["inventory", "--config", fixture.configPath]],
        ["vault status", ["vault", "status", "--config", fixture.configPath]],
        ["transcript status", ["transcript", "status", "--config", fixture.configPath]],
      ]) {
        await check(label, () => {
          const result = runCli(args);
          assert.equal(result.status, 0, `${label}: ${String(result.stderr || result.stdout)}`);
        });
      }

      await check("direct observational helpers", () => verifyDirectReadHelpers(fixture));

      await check("memory status", () => runMemoryStatus({ config: fixture.config, options: { agent: "project:diagnostic" }, io }));
      await check("memory search", () => runMemorySearch({ config: fixture.config, query: "harbour", options: { agent: "project:diagnostic" }, io }));
      await check("memory get", () => runMemoryGet({ config: fixture.config, lookup: "gigabrain://memory/diagnostic-memory", options: { agent: "project:diagnostic" }, io }));
      await check("memory doctor-read", () => runMemoryDoctorRead({ config: fixture.config, options: { agent: "project:diagnostic" }, io }));
      const serviceOptions = { config: fixture.config, target: "project", scope: "project:diagnostic", workspaceRoot: fixture.workspace };
      await check("recent", () => runRecent(serviceOptions));
      await check("provenance", () => runProvenance({ ...serviceOptions, memoryId: "diagnostic-memory" }));
      await check("sources", () => runSources(serviceOptions));
      await check("sync-status", () => runSyncStatus(serviceOptions));

      const missingRoot = path.join(fixture.root, "missing-workspace");
      const missingConfig = path.join(fixture.root, "missing-config.json");
      writeFileSync(missingConfig, `${JSON.stringify({
        plugins: { entries: { gigabrain: { enabled: true, config: {
          ...fixture.config,
          runtime: { paths: {
            workspaceRoot: missingRoot,
            memoryRoot: path.join(missingRoot, "memory"),
            registryPath: path.join(missingRoot, "memory", "registry.sqlite"),
            outputDir: path.join(missingRoot, "output"),
            reviewQueuePath: path.join(missingRoot, "output", "queue.jsonl"),
          } },
        } } } },
      }, null, 2)}\n`, { mode: 0o600 });
      for (const command of ["doctor", "inventory"]) {
        const result = runCli([command, "--config", missingConfig, "--target", "project"]);
        assert.equal(existsSync(missingRoot), false, `${command} must not create a missing workspace`);
        assert.match(`${result.stdout}\n${result.stderr}`, /missing|does not exist|db_exists|unavailable/i);
      }

      const schemaRoot = path.join(fixture.root, "missing-schema-workspace");
      mkdirSync(path.join(schemaRoot, "memory"), { recursive: true, mode: 0o700 });
      const schemaDbPath = path.join(schemaRoot, "memory", "registry.sqlite");
      new DatabaseSync(schemaDbPath).close();
      const schemaConfigPath = path.join(fixture.root, "missing-schema-config.json");
      writeFileSync(schemaConfigPath, `${JSON.stringify({
        plugins: { entries: { gigabrain: { enabled: true, config: {
          ...fixture.config,
          runtime: { paths: {
            workspaceRoot: schemaRoot,
            memoryRoot: path.join(schemaRoot, "memory"),
            registryPath: schemaDbPath,
            outputDir: path.join(schemaRoot, "output"),
            reviewQueuePath: path.join(schemaRoot, "output", "queue.jsonl"),
          } },
        } } } },
      }, null, 2)}\n`, { mode: 0o600 });
      const schemaState = { dbPath: schemaDbPath, roots: [schemaRoot], files: [schemaConfigPath] };
      const beforeSchema = snapshotState(schemaState);
      for (const command of ["doctor", "inventory"]) {
        const result = runCli([command, "--config", schemaConfigPath, "--target", "project"]);
        assert.equal(result.status, 0, String(result.stderr || result.stdout));
        assert.match(`${result.stdout}\n${result.stderr}`, /schema is unavailable|projection_ready/i);
        assert.equal(assertUnchanged(beforeSchema, snapshotState(schemaState), `${command} missing schema`), true);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

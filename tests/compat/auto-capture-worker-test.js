import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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

import { parseNpmPackReports } from "../../scripts/npm-pack-inventory.mjs";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "9";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_AUTO_CAPTURE missing durable bounded capture worker";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workerPath = path.join(repoRoot, "scripts", "auto-capture-worker.js");
const requestedFixCase = (() => {
  const index = process.argv.indexOf("--case");
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
})();
const shouldRunFixCase = (name) => !requestedFixCase || requestedFixCase === name;

const writePrivate = (filePath, value) => {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
};

const makeFixture = (label) => {
  const root = mkdtempSync(path.join(tmpdir(), `gigabrain-task9b-worker-${label}-`));
  const runtimeRoot = path.join(root, "runtime");
  const outputDir = path.join(runtimeRoot, "output");
  const vaultPath = path.join(root, "vault");
  const descriptorPath = path.join(runtimeRoot, "gigabrain-release.json");
  const configPath = path.join(root, "candidate-config.json");
  const descriptor = {
    autoCaptureQueuePath: path.join(outputDir, "gigabrain-auto-capture-queue.jsonl"),
    codeRoot: repoRoot,
    dbPath: path.join(runtimeRoot, "registry.sqlite"),
    graphPath: path.join(runtimeRoot, "graph.db"),
    nativeLockDir: path.join(runtimeRoot, "native-memory.lockdir"),
    operatorLogDir: path.join(outputDir, "operator"),
    outputDir,
    reviewQueuePath: path.join(outputDir, "memory-review-queue.jsonl"),
    vaultPath,
  };
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  mkdirSync(vaultPath, { recursive: true, mode: 0o700 });
  writePrivate(descriptor.dbPath, "synthetic-worker-registry\n");
  writePrivate(descriptor.graphPath, "synthetic-worker-graph\n");
  writePrivate(path.join(vaultPath, "manual-note.md"), "synthetic-worker-vault\n");
  writePrivate(path.join(outputDir, "operator-marker.json"), "{\"worker\":\"synthetic\"}\n");
  writePrivate(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  const decoyRoot = path.join(root, "decoy-runtime");
  const config = {
    compat: { writeMode: "full" },
    runtimeDescriptorPath: descriptorPath,
    runtime: {
      paths: {
        autoCaptureQueuePath: path.join(decoyRoot, "wrong-queue.jsonl"),
        outputDir: path.join(decoyRoot, "output"),
        registryPath: path.join(decoyRoot, "wrong-registry.sqlite"),
      },
    },
    capture: {
      enabled: true,
      autoCapture: {
        enabled: true,
        mode: "auto",
        processingStaleMs: 180000,
      },
    },
  };
  writePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { config, configPath, decoyRoot, descriptor, descriptorPath, root };
};

const packetEvent = (suffix) => ({
  schemaVersion: 1,
  source: "openclaw.agent_end",
  scope: "profile:main",
  mode: "auto",
  sessionKey: `agent:main:worker-${suffix}`,
  decision: { action: "save", reason: "explicit_durable_request" },
  messages: [{
    role: "user",
    content: `Remember that the synthetic worker ${suffix} path must remain observational when no work is dispatched.`,
  }],
});

const treeHash = (targetPath) => {
  if (!existsSync(targetPath)) return "missing";
  const hash = createHash("sha256");
  const visit = (current, relative) => {
    const stat = lstatSync(current);
    hash.update(`${relative}\0${stat.mode & 0o777}\0`);
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const entry of readdirSync(current).sort()) visit(path.join(current, entry), path.join(relative, entry));
      return;
    }
    hash.update("file\0");
    hash.update(readFileSync(current));
  };
  visit(targetPath, ".");
  return hash.digest("hex");
};

const stateVector = ({ configPath, descriptor, descriptorPath }) => ({
  config: treeHash(configPath),
  db: treeHash(descriptor.dbPath),
  descriptor: treeHash(descriptorPath),
  graph: treeHash(descriptor.graphPath),
  output: treeHash(descriptor.outputDir),
  queue: treeHash(descriptor.autoCaptureQueuePath),
  vault: treeHash(descriptor.vaultPath),
});

const runWorker = (args, fixture) => spawnSync(process.execPath, [workerPath, ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    GIGABRAIN_RUNTIME_DESCRIPTOR: fixture.descriptorPath,
    OPENCLAW_CONFIG: path.join(fixture.root, "ambient-config-must-not-be-used.json"),
  },
  timeout: 30_000,
});

const parseWorkerJson = (result) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
};

export async function run() {
  const queue = await importContractModule("lib/compat/auto-capture-queue.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    if (!existsSync(workerPath)) throw new Error(EXPECTED_SIGNATURE);
    const enqueueAutoCaptureEvent = requireCallable(queue, "enqueueAutoCaptureEvent");
    const processAutoCaptureQueue = requireCallable(queue, "processAutoCaptureQueue");
    const fixtures = [];
    const fixture = (label) => {
      const value = makeFixture(label);
      fixtures.push(value);
      return value;
    };

    try {
      {
        const current = fixture("help");
        const before = stateVector(current);
        const result = runWorker(["--help", "--config", current.configPath], current);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /^Usage: auto-capture-worker/m);
        assert.match(result.stdout, /--config <path>/);
        assert.match(result.stdout, /--dry-run/);
        assert.match(result.stdout, /--limit <1-20>/);
        assert.equal(result.stderr, "");
        assert.deepEqual(stateVector(current), before, "--help must preserve DB/queue/output/graph/vault bytes");
      }

      {
        const current = fixture("requires-config");
        const before = stateVector(current);
        const result = runWorker([], current);
        assert.notEqual(result.status, 0, "the worker must not fall back to ambient production config");
        assert.match(result.stderr, /AUTO_CAPTURE_WORKER_CONFIG_REQUIRED/);
        assert.deepEqual(stateVector(current), before);
        assert.equal(existsSync(current.decoyRoot), false);
      }

      {
        const current = fixture("empty");
        const before = stateVector(current);
        const output = parseWorkerJson(runWorker(["--config", current.configPath, "--limit", "1"], current));
        assert.equal(output.ok, true);
        assert.equal(output.reason, "empty_queue");
        assert.equal(output.inspected, 0);
        assert.equal(output.processed, 0);
        assert.equal(output.mutated, false);
        assert.deepEqual(stateVector(current), before, "an empty queue must preserve every candidate state surface");
        assert.equal(existsSync(current.descriptor.autoCaptureQueuePath), false);
        assert.equal(existsSync(current.decoyRoot), false);
      }

      {
        const current = fixture("dry-run");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("dry-run"), runId: "worker-dry-run" });
        const before = stateVector(current);
        const output = parseWorkerJson(runWorker([
          "--config",
          current.configPath,
          "--limit",
          "1",
          "--dry-run",
        ], current));
        assert.equal(output.ok, true);
        assert.equal(output.dryRun, true);
        assert.equal(output.inspected, 1);
        assert.equal(output.processable, 1);
        assert.equal(output.processed, 0);
        assert.equal(output.mutated, false);
        assert.deepEqual(stateVector(current), before, "worker dry-run must perform zero state transitions");
        assert.equal(existsSync(current.decoyRoot), false);
      }

      {
        const current = fixture("no-processable");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("completed"), runId: "worker-completed" });
        const completed = await processAutoCaptureQueue({
          config: current.config,
          limit: 1,
          processJob: async () => ({ autoSaved: 0, queuedReview: 1 }),
        });
        assert.equal(completed.completed, 1);
        const before = stateVector(current);
        const output = parseWorkerJson(runWorker(["--config", current.configPath], current));
        assert.equal(output.ok, true);
        assert.equal(output.reason, "no_processable_rows");
        assert.equal(output.inspected, 1);
        assert.equal(output.processed, 0);
        assert.equal(output.mutated, false);
        assert.deepEqual(stateVector(current), before, "no-processable worker path must not refresh or rewrite any state");
        assert.equal(existsSync(current.decoyRoot), false);
      }

      {
        const current = fixture("processor-boundary");
        await enqueueAutoCaptureEvent({ config: current.config, event: packetEvent("pending"), runId: "worker-pending" });
        const before = stateVector(current);
        const output = parseWorkerJson(runWorker(["--config", current.configPath, "--limit", "1"], current));
        assert.equal(output.ok, true);
        assert.equal(output.reason, "processor_unavailable");
        assert.equal(output.processed, 0);
        assert.equal(output.mutated, false);
        assert.deepEqual(stateVector(current), before, "9B worker must wait for the 9C/9D processor without consuming the job");
      }

      {
        const current = fixture("arguments");
        const before = stateVector(current);
        const result = runWorker(["--config", current.configPath, "--limit", "0"], current);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /AUTO_CAPTURE_WORKER_LIMIT_INVALID/);
        assert.deepEqual(stateVector(current), before);
      }

      if (shouldRunFixCase("package")) {
        const cacheDirectory = mkdtempSync(path.join(tmpdir(), "gigabrain-task9b-pack-cache-"));
        let packed;
        try {
          packed = spawnSync(
            process.platform === "win32" ? "npm.cmd" : "npm",
            ["--cache", cacheDirectory, "pack", "--dry-run", "--json", "--ignore-scripts"],
            {
              cwd: repoRoot,
              encoding: "utf8",
              env: {
                ...process.env,
                npm_config_audit: "false",
                npm_config_fund: "false",
                npm_config_ignore_scripts: "true",
                npm_config_update_notifier: "false",
              },
              maxBuffer: 5 * 1024 * 1024,
              timeout: 180_000,
            },
          );
        } finally {
          rmSync(cacheDirectory, { recursive: true, force: true });
        }
        assert.equal(packed.status, 0, packed.stderr || packed.stdout);
        const reports = parseNpmPackReports(packed.stdout);
        assert.equal(reports.length, 1);
        const byPath = new Map(reports[0].files.map((entry) => [entry.path, entry]));
        const queueEntry = byPath.get("lib/compat/auto-capture-queue.js");
        const workerEntry = byPath.get("scripts/auto-capture-worker.js");
        assert.ok(queueEntry, "the installed package must contain the Task 9B queue module");
        assert.ok(workerEntry, "the installed package must contain the Task 9B worker executable");
        if (Number.isInteger(queueEntry.mode)) assert.equal(queueEntry.mode & 0o111, 0);
        if (Number.isInteger(workerEntry.mode)) {
          assert.equal(workerEntry.mode & 0o100, 0o100, "packed worker must retain its owner executable bit");
          assert.equal(workerEntry.mode & 0o022, 0, "packed worker must never become group/world writable");
        }

        const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
        const releaseManifest = JSON.parse(readFileSync(path.join(repoRoot, "public-release-manifest.json"), "utf8"));
        assert.equal(packageJson.files.includes("scripts/auto-capture-worker.js"), true);
        for (const runtimePath of [
          "lib/compat/auto-capture-policy.js",
          "lib/compat/auto-capture-queue.js",
          "lib/compat/native-metadata.js",
          "lib/compat/runtime-descriptor.js",
          "lib/compat/scope-policy.js",
          "lib/compat/write-policy.js",
          "scripts/auto-capture-worker.js",
        ]) {
          assert.equal(releaseManifest.repository.files.includes(runtimePath), true, `release source allowlist omitted ${runtimePath}`);
          assert.equal(releaseManifest.npm.files.includes(runtimePath), true, `release npm inventory omitted ${runtimePath}`);
        }
        assert.equal(releaseManifest.npm.packageFiles.includes("scripts/auto-capture-worker.js"), true);
      }
    } finally {
      for (const current of fixtures) rmSync(current.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

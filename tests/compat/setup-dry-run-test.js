import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "12";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_SETUP_DRY_RUN missing apply-only first-run setup";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const setupScript = path.join(repoRoot, "scripts", "setup-first-run.js");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const snapshotTree = (root) => {
  const out = [];
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"))) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        out.push({ mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, path: relative, type: "directory" });
        walk(absolute, relative);
      } else if (stat.isFile()) {
        out.push({ hash: sha256(readFileSync(absolute)), mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, path: relative, type: "file" });
      } else {
        out.push({ mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, path: relative, type: "special" });
      }
    }
  };
  walk(root);
  return out;
};

const runSetup = (args, home) => spawnSync(process.execPath, [setupScript, ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: home,
    OPENCLAW_CONFIG: "",
    OPENCLAW_WORKSPACE_ROOT: "",
  },
  timeout: 30_000,
});

const parseOutput = (run) => {
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
};

export async function run() {
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task12-setup-"));
    try {
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const configPath = path.join(root, "openclaw.json");
      const agentsPath = path.join(workspace, "AGENTS.md");
      mkdirSync(home, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(agentsPath, "# Synthetic operator rules\n", { mode: 0o640 });
      chmodSync(agentsPath, 0o640);
      writeFileSync(configPath, `${JSON.stringify({
        syntheticSecret: "do-not-print-this-secret",
        plugins: {
          entries: {
            gigabrain: {
              config: {
                compat: { writeMode: "full" },
                hostSync: { autoOnSetup: false },
                native: { enabled: false },
                nativePromotion: { enabled: false },
              },
            },
          },
        },
      }, null, 2)}\n`, { mode: 0o600 });

      const common = [
        "--config", configPath,
        "--workspace", workspace,
        "--agents-path", agentsPath,
        "--skip-restart",
      ];
      const before = snapshotTree(root);

      const plannedDefault = parseOutput(spawnSync(process.execPath, [
        path.resolve(repoRoot, "scripts/setup-first-run.js"),
        ...common,
      ], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_CONFIG: "",
          OPENCLAW_WORKSPACE_ROOT: "",
        },
        timeout: 30_000,
      }));
      assert.deepEqual(snapshotTree(root), before, "setup without --apply must be observational");
      assert.equal(plannedDefault.ok, true);
      assert.equal(plannedDefault.applied, false);
      assert.equal(plannedDefault.mode, "plan");
      assert.equal(plannedDefault.applyRequired, true);
      assert.match(plannedDefault.planHash, /^[0-9a-f]{64}$/);
      assert.equal(Array.isArray(plannedDefault.deltas), true);
      assert.equal(plannedDefault.deltas.length > 0, true);

      const plannedDryRun = parseOutput(runSetup([...common, "--dry-run"], home));
      assert.deepEqual(snapshotTree(root), before, "setup --dry-run must be byte-for-byte observational");
      assert.equal(plannedDryRun.applied, false);
      assert.equal(plannedDryRun.mode, "dry_run");
      assert.equal(plannedDryRun.planHash, plannedDefault.planHash);
      assert.deepEqual(plannedDryRun.deltas, plannedDefault.deltas);
      assert.equal(JSON.stringify(plannedDryRun.deltas).includes("do-not-print-this-secret"), false);
      assert.deepEqual(
        plannedDryRun.deltas.map((row) => row.sortKey),
        [...plannedDryRun.deltas.map((row) => row.sortKey)].sort((left, right) => left.localeCompare(right, "en")),
        "planned deltas must be deterministic and exactly ordered",
      );
      for (const delta of plannedDryRun.deltas) {
        assert.deepEqual(Object.keys(delta).sort(), ["after", "before", "domain", "operation", "path", "sortKey"]);
      }
      const agentsDelta = plannedDryRun.deltas.find((row) => row.domain === "agents");
      assert.match(agentsDelta.after, /mode:0640$/, "the plan must preserve the existing AGENTS mode");

      const applied = parseOutput(runSetup([...common, "--apply"], home));
      assert.equal(applied.ok, true);
      assert.equal(applied.applied, true);
      assert.equal(applied.mode, "apply");
      assert.equal(applied.planHash, plannedDefault.planHash);
      assert.deepEqual(applied.deltas, plannedDefault.deltas);
      assert.equal(existsSync(path.join(workspace, "memory", "registry.sqlite")), true);
      assert.equal(statSync(configPath).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(workspace, "memory", "registry.sqlite")).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(workspace, "memory")).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(workspace, "output")).mode & 0o777, 0o700);
      assert.equal(statSync(agentsPath).mode & 0o777, 0o640, "setup must preserve the existing AGENTS mode");
      assert.match(readFileSync(agentsPath, "utf8"), /GIGABRAIN_MEMORY_PROTOCOL_START/);
      assert.equal(applied.bootstrap.hostSync.ran, false);
      assert.equal(applied.gatewayRestart, "skipped");

      const registryPath = path.join(workspace, "memory", "registry.sqlite");
      const existingHashBefore = sha256(readFileSync(registryPath));
      const existingTreeBefore = snapshotTree(root);
      const existingApply = parseOutput(runSetup([...common, "--apply"], home));
      assert.equal(existingApply.bootstrap.existing, true);
      assert.equal(existingApply.bootstrap.validated, true);
      assert.equal(existingApply.bootstrap.hostSync.ran, false);
      assert.equal(sha256(readFileSync(registryPath)), existingHashBefore, "existing DB setup must stay observational");
      assert.deepEqual(snapshotTree(root), existingTreeBefore, "existing DB setup must preserve DB/WAL/SHM bytes, modes, and tree shape");

      const beforeConflict = snapshotTree(root);
      const conflict = runSetup([...common, "--apply", "--dry-run"], home);
      assert.notEqual(conflict.status, 0);
      assert.match(conflict.stderr, /SETUP_MODE_CONFLICT/);
      assert.deepEqual(snapshotTree(root), beforeConflict, "conflicting mode flags must fail before any mutation");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}

runDirect(import.meta.url, run);

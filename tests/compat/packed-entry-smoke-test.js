import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_PACKED_ENTRY missing production JavaScript package entry";

const resolveEntryArg = () => {
  const index = process.argv.indexOf("--entry");
  const value = index >= 0 ? process.argv[index + 1] : "./index.js";
  return path.resolve(process.cwd(), value || "./index.js");
};

const runVersionedFixturePack = () => {
  const fixtureRoot = mkdtempSync(path.join(path.resolve("memory_api"), ".c1-package-fixture-"));
  const fixtureVenv = path.join(fixtureRoot, ".venv-versioned");
  const fixtureCache = path.join(fixtureRoot, "__pycache__", "fixture.pyc");
  const npmCache = mkdtempSync(path.join(tmpdir(), "gigabrain-c1-npm-cache-"));
  try {
    mkdirSync(fixtureVenv, { recursive: true });
    writeFileSync(path.join(fixtureVenv, "must-not-pack.txt"), "excluded\n");
    mkdirSync(path.dirname(fixtureCache), { recursive: true });
    writeFileSync(fixtureCache, "excluded\n");
    const packed = spawnSync("npm", [
      "pack", "--dry-run", "--json", "--ignore-scripts", "--cache", npmCache,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      shell: false,
      timeout: 60_000,
    });
    assert.equal(packed.error, undefined, `npm pack must finish within 60s: ${packed.error?.message || ""}`);
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const document = JSON.parse(packed.stdout);
    const record = Array.isArray(document) ? document[0] : Object.values(document)[0];
    const packedFiles = record.files.map((row) => String(row.path)).sort();
    const releaseManifest = JSON.parse(readFileSync("public-release-manifest.json", "utf8"));
    assert.deepEqual(packedFiles, [...releaseManifest.npm.files].sort(), "reviewed npm inventory must equal actual npm pack");
    for (const required of [
      "memory_api/.env.example",
      "memory_api/README.md",
      "memory_api/app.py",
      "memory_api/requirements.txt",
      "memory_api/requirements-prod-py310-linux-x86_64.lock",
      "memory_api/static/index.html",
      "memory_api/wheelhouse-py310-linux-x86_64.manifest.json",
    ]) assert.equal(packedFiles.includes(required), true, `npm runtime missing ${required}`);
    assert.equal(packedFiles.includes("memory_api/requirements-dev.lock"), false, "dev lock must not ship in npm runtime");
    assert.equal(
      packedFiles.some((file) => /(?:^|\/)(?:\.venv[^/]*|venv[^/]*|__pycache__)(?:\/|$)|\.pyc$/i.test(file)),
      false,
      "npm runtime must contain no venv/cache bytecode",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(npmCache, { recursive: true, force: true });
  }
};

const runFixtureWorker = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "packed-entry-smoke-test.js"), "--fixture-worker"], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", reject);
  child.on("close", (status) => {
    clearTimeout(timer);
    if (status !== 0) reject(new Error(stderr || stdout || `fixture worker exited ${status}`));
    else resolve(stdout);
  });
});

export async function run() {
  if (process.argv.includes("--fixture-worker")) {
    runVersionedFixturePack();
    return;
  }
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const entry = resolveEntryArg();
    assert.equal(existsSync(entry), true, "generated production entry must exist");
    execFileSync(process.execPath, ["--check", entry], { stdio: "pipe", timeout: 30_000 });
    const loaded = await import(`${pathToFileURL(entry).href}?packed-smoke=${Date.now()}`);
    assert.equal(typeof loaded.default?.register, "function");
    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-packed-entry-"));
    try {
      const calls = [];
      loaded.default.register({
        config: {
          enabled: true,
          compat: { writeMode: "read_only" },
          runtime: { paths: {
            workspaceRoot: root,
            memoryRoot: path.join(root, "memory"),
            registryPath: path.join(root, "memory", "registry.sqlite"),
            outputDir: path.join(root, "output"),
            reviewQueuePath: path.join(root, "output", "queue.jsonl"),
          } },
          recall: { autoInjectEnabled: false },
          capture: { enabled: false },
        },
        registerMemoryCapability: (value) => calls.push(["capability", value]),
        registerCli: (value) => calls.push(["cli", value]),
        on: (name) => calls.push(["hook", name]),
        logger: { info() {}, warn() {}, error() {} },
      });
      assert.equal(calls.filter(([kind]) => kind === "capability").length, 1);
      assert.equal(calls.filter(([kind]) => kind === "cli").length, 1);
      assert.equal(calls.some(([, name]) => name === "before_prompt_build"), true);
      assert.equal(existsSync(path.join(root, "memory", "registry.sqlite")), false, "direct entry load/register must not create runtime data");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const packageJson = JSON.parse(readFileSync(path.join(path.dirname(entry), "package.json"), "utf8"));
    const generatedEntrySource = readFileSync("index.js", "utf8");
    const sourceEntry = readFileSync("index.ts", "utf8");
    const npmIgnore = readFileSync(".npmignore", "utf8");
    const gitIgnore = readFileSync(".gitignore", "utf8");
    const buildScript = readFileSync("scripts/build-runtime-js.js", "utf8");
    const packedSmokeSource = readFileSync(new URL(import.meta.url), "utf8");
    const stageContract = readFileSync("config/migration/task5-stage-paths.txt", "utf8");
    assert.match(generatedEntrySource, /Generated from index\.ts/);
    assert.match(sourceEntry, /registerOpenClawCompatibility/);
    assert.match(npmIgnore, /__pycache__/);
    assert.match(gitIgnore, /task5-stage-paths/);
    assert.match(buildScript, /stripTypeScriptTypes/);
    for (const forbidden of [".venv-c1-" + "package-fixture", "c1-package-" + "fixture.pyc"]) {
      assert.equal(packedSmokeSource.includes(forbidden), false, "packed fixture paths must be unique per invocation");
    }
    assert.match(stageContract, /^index\.js$/m);
    assert.deepEqual(packageJson.openclaw.extensions, ["./index.js"]);
    assert.equal(packageJson.dependencies.acorn, undefined);
    assert.equal(packageJson.devDependencies.acorn, "8.18.0");
    const files = new Set(packageJson.files);
    for (const required of ["index.js", "lib/", "memory_api/", "openclaw.plugin.json", "scripts/gigabrainctl.js", "scripts/gigabrain-mcp.js"]) {
      assert.equal(files.has(required), true, `package files must include ${required}`);
    }
    assert.equal([...files].some((item) => /^tests\/?/.test(item)), false);
    assert.equal([...files].some((item) => /(?:^|\/)(?:\.venv|venv|runtime|output|secrets?)(?:\/|$)/i.test(item)), false);

    const workers = await Promise.all([runFixtureWorker(), runFixtureWorker()]);
    assert.equal(workers.length, 2);
    assert.equal(workers.every((output) => /packed-entry-smoke-test\.js: ok/.test(output)), true,
      "parallel packed-fixture workers must complete independently");
  });
}

runDirect(import.meta.url, run);

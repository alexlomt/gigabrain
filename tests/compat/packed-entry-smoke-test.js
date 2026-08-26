import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

export async function run() {
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
    const buildScript = readFileSync("scripts/build-runtime-js.js", "utf8");
    assert.match(generatedEntrySource, /Generated from index\.ts/);
    assert.match(sourceEntry, /registerOpenClawCompatibility/);
    assert.match(npmIgnore, /__pycache__/);
    assert.match(buildScript, /stripTypeScriptTypes/);
    assert.deepEqual(packageJson.openclaw.extensions, ["./index.js"]);
    const files = new Set(packageJson.files);
    for (const required of ["index.js", "lib/", "memory_api/", "openclaw.plugin.json", "scripts/gigabrainctl.js", "scripts/gigabrain-mcp.js"]) {
      assert.equal(files.has(required), true, `package files must include ${required}`);
    }
    assert.equal([...files].some((item) => /^tests\/?/.test(item)), false);
    assert.equal([...files].some((item) => /(?:^|\/)(?:\.venv|venv|runtime|output|secrets?)(?:\/|$)/i.test(item)), false);
  });
}

runDirect(import.meta.url, run);

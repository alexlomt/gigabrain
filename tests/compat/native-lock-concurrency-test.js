import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "6";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_NATIVE_LOCK missing cross-process native-memory lock";

const runChild = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    else resolve({ stdout, stderr });
  });
});

const processStartIdentity = (pid = process.pid) => {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = raw.lastIndexOf(")");
  return raw.slice(close + 2).trim().split(/\s+/)[19];
};

const occurrences = (text, needle) => text.split(needle).length - 1;

export async function run() {
  const nativeMemory = await importContractModule("lib/core/native-memory.js", EXPECTED_SIGNATURE);
  const descriptorModule = await importContractModule("lib/compat/runtime-descriptor.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const withNativeMemoryLock = requireCallable(nativeMemory, "withNativeMemoryLock");
    const writeNativeMemoryEntry = requireCallable(nativeMemory, "writeNativeMemoryEntry");
    const loadRuntimeDescriptor = requireCallable(descriptorModule, "loadRuntimeDescriptor");
    const root = path.join(tmpdir(), `gigabrain-native-lock-contract-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const workspace = path.join(root, "workspace");
    const memoryRoot = path.join(workspace, "memory");
    const runtimeRoot = path.join(root, "runtime");
    const outputDir = path.join(runtimeRoot, "output");
    const descriptorPath = path.join(runtimeRoot, "gigabrain-release.json");
    const lockDir = path.join(runtimeRoot, "native-memory.lockdir");
    mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const descriptor = {
      codeRoot: path.resolve(import.meta.dirname, "..", ".."),
      dbPath: path.join(runtimeRoot, "registry.sqlite"),
      outputDir,
      reviewQueuePath: path.join(outputDir, "memory-review-queue.jsonl"),
      autoCaptureQueuePath: path.join(outputDir, "gigabrain-auto-capture-queue.jsonl"),
      vaultPath: path.join(root, "transcript-vault"),
      graphPath: path.join(runtimeRoot, "graph.db"),
      nativeLockDir: lockDir,
      operatorLogDir: path.join(outputDir, "operator"),
    };
    const writeDescriptor = (value = descriptor, target = descriptorPath) => {
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      chmodSync(target, 0o600);
    };
    writeDescriptor();
    const config = {
      compat: { writeMode: "full" },
      runtimeDescriptorPath: descriptorPath,
      runtime: { paths: { workspaceRoot: workspace, memoryRoot, nativeLockDir: lockDir } },
      native: { memoryMdPath: path.join(workspace, "MEMORY.md") },
      nativeLock: { timeoutMs: 4_000, staleMs: 100 },
    };

    try {
      const priorOpenClawRoot = process.env.OPENCLAW_ROOT;
      const isolatedOpenClawRoot = path.join(root, "isolated-openclaw-root");
      try {
        process.env.OPENCLAW_ROOT = isolatedOpenClawRoot;
        const isolatedDescriptorModule = await import(
          `${pathToFileURL(path.resolve(import.meta.dirname, "..", "..", "lib", "compat", "runtime-descriptor.js")).href}?isolated-root=${Date.now()}`,
        );
        assert.equal(
          isolatedDescriptorModule.DEFAULT_RUNTIME_DESCRIPTOR_PATH,
          path.join(isolatedOpenClawRoot, "runtime", "gigabrain-release.json"),
          "the runtime descriptor default must derive from OPENCLAW_ROOT rather than an operator home path",
        );
      } finally {
        if (priorOpenClawRoot === undefined) delete process.env.OPENCLAW_ROOT;
        else process.env.OPENCLAW_ROOT = priorOpenClawRoot;
      }
      assert.deepEqual(loadRuntimeDescriptor(descriptorPath), descriptor);
      assert.throws(
        () => loadRuntimeDescriptor(path.join(runtimeRoot, "missing-release.json")),
        /GIGABRAIN_RUNTIME_DESCRIPTOR_MISSING/,
      );
      writeFileSync(descriptorPath, "{malformed", { mode: 0o600 });
      chmodSync(descriptorPath, 0o600);
      assert.throws(() => loadRuntimeDescriptor(descriptorPath), /GIGABRAIN_RUNTIME_DESCRIPTOR_JSON/);
      writeDescriptor({ ...descriptor, unexpectedKey: path.join(root, "unexpected") });
      assert.throws(() => loadRuntimeDescriptor(descriptorPath), /GIGABRAIN_RUNTIME_DESCRIPTOR_SCHEMA/);
      writeDescriptor({ ...descriptor, dbPath: "relative.sqlite" });
      assert.throws(() => loadRuntimeDescriptor(descriptorPath), /GIGABRAIN_RUNTIME_DESCRIPTOR_PATH/);
      writeDescriptor({ ...descriptor, outputDir: path.parse(root).root });
      assert.throws(() => loadRuntimeDescriptor(descriptorPath), /GIGABRAIN_RUNTIME_DESCRIPTOR_PATH/);
      writeDescriptor();
      chmodSync(descriptorPath, 0o640);
      assert.throws(() => loadRuntimeDescriptor(descriptorPath), /GIGABRAIN_RUNTIME_DESCRIPTOR_MODE/);
      chmodSync(descriptorPath, 0o600);
      const descriptorLink = path.join(runtimeRoot, "descriptor-link.json");
      symlinkSync(descriptorPath, descriptorLink);
      assert.throws(() => loadRuntimeDescriptor(descriptorLink), /GIGABRAIN_RUNTIME_DESCRIPTOR_SYMLINK/);
      const descriptorHardLink = path.join(runtimeRoot, "descriptor-hard-link.json");
      linkSync(descriptorPath, descriptorHardLink);
      assert.throws(
        () => loadRuntimeDescriptor(descriptorHardLink),
        /GIGABRAIN_RUNTIME_DESCRIPTOR_(?:IDENTITY|HARDLINK)/,
        "a second directory entry must not satisfy descriptor identity",
      );
      rmSync(descriptorHardLink, { force: true });
      const descriptorRealParent = path.join(root, "descriptor-real-parent");
      const descriptorParentLink = path.join(root, "descriptor-parent-link");
      const descriptorThroughParentLink = path.join(descriptorParentLink, "gigabrain-release.json");
      mkdirSync(descriptorRealParent, { mode: 0o700 });
      writeDescriptor(descriptor, path.join(descriptorRealParent, "gigabrain-release.json"));
      symlinkSync(descriptorRealParent, descriptorParentLink, "dir");
      assert.throws(
        () => loadRuntimeDescriptor(descriptorThroughParentLink),
        /GIGABRAIN_RUNTIME_DESCRIPTOR_.*SYMLINK/,
        "descriptor reads must reject symlinked path parents, not only a symlinked final entry",
      );
      const targetRealParent = path.join(root, "target-real-parent");
      const targetParentLink = path.join(root, "target-parent-link");
      mkdirSync(targetRealParent, { mode: 0o700 });
      symlinkSync(targetRealParent, targetParentLink, "dir");
      writeDescriptor({ ...descriptor, vaultPath: path.join(targetParentLink, "vault") });
      assert.throws(
        () => loadRuntimeDescriptor(descriptorPath),
        /GIGABRAIN_RUNTIME_DESCRIPTOR_.*SYMLINK/,
        "descriptor target paths must reject symlinked parents",
      );
      writeDescriptor();
      if (typeof process.getuid === "function" && process.getuid() !== 0) {
        assert.throws(
          () => loadRuntimeDescriptor("/etc/passwd"),
          /GIGABRAIN_RUNTIME_DESCRIPTOR_OWNER/,
          "a descriptor owned by another uid must fail before mode or payload parsing",
        );
      }

      let active = 0;
      let maxActive = 0;
      const order = [];
      const worker = (id) => withNativeMemoryLock(config, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`end:${id}`);
        active -= 1;
      });
      await Promise.all([worker("one"), worker("two")]);
      assert.equal(maxActive, 1);
      assert.deepEqual(order, ["start:one", "end:one", "start:two", "end:two"]);
      assert.equal(existsSync(lockDir), false);

      const reentrantOrder = [];
      let markOuterStarted;
      let releaseOuter;
      const outerStarted = new Promise((resolve) => { markOuterStarted = resolve; });
      const outerRelease = new Promise((resolve) => { releaseOuter = resolve; });
      const outer = withNativeMemoryLock(config, async () => {
        reentrantOrder.push("outer:start");
        markOuterStarted();
        await withNativeMemoryLock(config, async () => {
          reentrantOrder.push("nested");
        });
        reentrantOrder.push("outer:nested-complete");
        await outerRelease;
        reentrantOrder.push("outer:end");
      });
      await outerStarted;
      const parallel = withNativeMemoryLock(config, async () => {
        reentrantOrder.push("parallel");
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(reentrantOrder.includes("parallel"), false, "parallel callers must remain excluded by a reentrant owner");
      releaseOuter();
      await Promise.all([outer, parallel]);
      assert.deepEqual(
        reentrantOrder,
        ["outer:start", "nested", "outer:nested-complete", "outer:end", "parallel"],
      );
      assert.equal(existsSync(lockDir), false);

      await assert.rejects(
        () => withNativeMemoryLock(config, async () => { throw new Error("synthetic locked callback failure"); }),
        /synthetic locked callback failure/,
      );
      assert.equal(existsSync(lockDir), false, "callback failure must release the acquired lock generation");
      const blockedParent = path.join(runtimeRoot, "blocked-parent");
      const blockedLockDir = path.join(blockedParent, "native-memory.lockdir");
      const blockedDescriptorPath = path.join(runtimeRoot, "blocked-release.json");
      writeFileSync(blockedParent, "not-a-directory", { mode: 0o600 });
      writeDescriptor({ ...descriptor, nativeLockDir: blockedLockDir }, blockedDescriptorPath);
      await assert.rejects(
        () => withNativeMemoryLock({ ...config, runtimeDescriptorPath: blockedDescriptorPath }, async () => undefined),
      );
      assert.equal(existsSync(blockedLockDir), false, "failed acquisition must leave no stranded lock generation");

      const trailingHeadingPath = path.join(memoryRoot, "2026-08-24.md");
      writeFileSync(trailingHeadingPath, "# 2026-08-24\n\n## Decisions\n\n", { mode: 0o600 });
      for (const content of ["trailing-heading-one", "trailing-heading-two"]) {
        writeNativeMemoryEntry({
          config,
          type: "DECISION",
          content,
          durable: false,
          timestamp: "2026-08-24T14:00:00.000Z",
          scope: "profile:synthetic",
        });
      }
      assert.equal(occurrences(readFileSync(trailingHeadingPath, "utf8"), "## Decisions"), 1);

      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
        token: "dead-owner",
        pid: 99999999,
        process_start: "missing",
        created_at_ms: Date.now() - 10_000,
        owner: "dead-fixture",
      }), { mode: 0o600 });
      await withNativeMemoryLock(config, async () => undefined);
      assert.equal(existsSync(lockDir), false, "dead stale owners must be reclaimed");

      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
        token: "live-owner",
        pid: process.pid,
        process_start: processStartIdentity(),
        created_at_ms: Date.now() - 10_000,
        owner: "live-fixture",
      }), { mode: 0o600 });
      await assert.rejects(
        () => withNativeMemoryLock({ ...config, nativeLock: { timeoutMs: 80, staleMs: 10 } }, async () => undefined),
        /GIGABRAIN_NATIVE_LOCK_TIMEOUT/,
      );
      assert.equal(existsSync(lockDir), true, "an old but live owner must never be stolen");
      rmSync(lockDir, { recursive: true, force: true });

      await withNativeMemoryLock(config, async () => {
        const displaced = `${lockDir}.displaced`;
        renameSync(lockDir, displaced);
        mkdirSync(lockDir, { mode: 0o700 });
        writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
          token: "successor-owner",
          pid: process.pid,
          process_start: processStartIdentity(),
          created_at_ms: Date.now(),
          owner: "successor-fixture",
        }), { mode: 0o600 });
        rmSync(displaced, { recursive: true, force: true });
      });
      assert.equal(existsSync(lockDir), true, "a process may release only the lock generation it acquired");
      assert.equal(JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8")).token, "successor-owner");
      rmSync(lockDir, { recursive: true, force: true });

      const nativeMemoryUrl = pathToFileURL(path.join(descriptor.codeRoot, "lib", "core", "native-memory.js")).href;
      const workerPath = path.join(root, "node-worker.mjs");
      writeFileSync(workerPath, `
        import fs from 'node:fs';
        const native = await import(process.env.NATIVE_MEMORY_URL);
        const config = JSON.parse(process.env.NATIVE_CONFIG);
        const mode = process.argv[2];
        const prefix = process.argv[3];
        if (mode === 'entry') {
          for (let index = 0; index < 5; index += 1) {
            native.writeNativeMemoryEntry({
              config,
              type: 'DECISION',
              content: prefix + '-' + index,
              durable: false,
              timestamp: '2026-08-25T14:00:00.000Z',
              scope: 'profile:synthetic',
            });
          }
        } else if (mode === 'checkpoint') {
          native.writeNativeSessionCheckpoint({
            config,
            timestamp: '2026-08-25T14:00:00.000Z',
            surface: 'agent',
            sessionLabel: prefix,
            summary: prefix + '-summary',
            decisions: [prefix + '-decision'],
            scope: 'project:synthetic',
          });
        } else if (mode === 'compact') {
          for (let index = 0; index < 8; index += 1) {
            await native.withNativeMemoryLock(config, async () => {
              const file = config.runtime.paths.memoryRoot + '/2026-08-25.md';
              if (fs.existsSync(file)) fs.writeFileSync(file, fs.readFileSync(file), { mode: 0o600 });
            });
          }
        }
      `);
      const pythonPath = path.join(root, "python-promoter.py");
      writeFileSync(pythonPath, `
import json, os, pathlib, time, uuid
descriptor = json.loads(pathlib.Path(os.environ['RUNTIME_DESCRIPTOR']).read_text())
lock = pathlib.Path(descriptor['nativeLockDir'])
memory = pathlib.Path(os.environ['MEMORY_FILE'])
token = str(uuid.uuid4())
deadline = time.monotonic() + 4
while True:
    try:
        lock.mkdir(mode=0o700)
        stat = pathlib.Path('/proc/self/stat').read_text()
        close = stat.rfind(')')
        start = stat[close + 2:].split()[19]
        (lock / 'owner.json').write_text(json.dumps({'token': token, 'pid': os.getpid(), 'process_start': start, 'created_at_ms': int(time.time()*1000), 'owner': 'python-promoter'}))
        break
    except FileExistsError:
        if time.monotonic() >= deadline:
            raise RuntimeError('python lock timeout')
        time.sleep(.01)
try:
    text = memory.read_text() if memory.exists() else '# 2026-08-25\\n\\n## Decisions\\n\\n'
    if not text.endswith('\\n'):
        text += '\\n'
    for index in range(5):
        text += f'- py-promoter-{index} <!-- gigabrain:scope=profile:synthetic type=DECISION -->\\n'
    memory.parent.mkdir(parents=True, exist_ok=True)
    temp = memory.with_name(memory.name + '.python-tmp')
    temp.write_text(text)
    os.chmod(temp, 0o600)
    os.replace(temp, memory)
finally:
    try:
        owner = json.loads((lock / 'owner.json').read_text())
    except Exception:
        owner = {}
    if owner.get('token') == token:
        retired = lock.with_name(lock.name + '.release-' + token)
        try:
            os.replace(lock, retired)
            for child in retired.iterdir(): child.unlink()
            retired.rmdir()
        except FileNotFoundError:
            pass
      `);

      const childEnv = {
        ...process.env,
        NATIVE_CONFIG: JSON.stringify(config),
        NATIVE_MEMORY_URL: nativeMemoryUrl,
        RUNTIME_DESCRIPTOR: descriptorPath,
        MEMORY_FILE: path.join(memoryRoot, "2026-08-25.md"),
      };
      await Promise.all([
        runChild(process.execPath, [workerPath, "entry", "node-a"], { cwd: root, env: childEnv }),
        runChild(process.execPath, [workerPath, "entry", "node-b"], { cwd: root, env: childEnv }),
        runChild(process.execPath, [workerPath, "checkpoint", "node-checkpoint"], { cwd: root, env: childEnv }),
        runChild(process.execPath, [workerPath, "compact", "node-compact"], { cwd: root, env: childEnv }),
        runChild("python3", [pythonPath], { cwd: root, env: childEnv }),
      ]);
      const finalText = readFileSync(path.join(memoryRoot, "2026-08-25.md"), "utf8");
      for (const prefix of ["node-a", "node-b"]) {
        let previous = -1;
        for (let index = 0; index < 5; index += 1) {
          const value = `${prefix}-${index}`;
          assert.equal(occurrences(finalText, value), 1, `${value} must survive exactly once`);
          const position = finalText.indexOf(value);
          assert.ok(position > previous, `${prefix} bullet order must be preserved`);
          previous = position;
        }
      }
      let previousPython = -1;
      for (let index = 0; index < 5; index += 1) {
        const value = `py-promoter-${index}`;
        assert.equal(occurrences(finalText, value), 1, `${value} must survive exactly once`);
        const position = finalText.indexOf(value);
        assert.ok(position > previousPython, "Python promoter bullet order must be preserved");
        previousPython = position;
      }
      assert.equal(occurrences(finalText, "node-checkpoint-summary"), 1);
      assert.equal(occurrences(finalText, "node-checkpoint-decision"), 1);
      assert.ok(occurrences(finalText, "## Decisions") <= 2, "native entries must not multiply compatible Decisions headings");
      assert.match(finalText, /gigabrain:origin=structured_checkpoint/);
      assert.equal(existsSync(lockDir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadResolvedConfig } from '../lib/core/config.js';
import { openDatabase } from '../lib/core/sqlite.js';
import { ensureProjectionStore, materializeProjectionFromMemories } from '../lib/core/projection-store.js';
import { ensureEventStore } from '../lib/core/event-store.js';
import { ensureWorldModelReady } from '../lib/core/world-model.js';
import { applyAutoCaptureQueueRetention, processAutoCaptureQueue, resolveAutoCaptureQueuePath } from '../lib/core/auto-capture-service.js';
import { refreshGeneratedMemorySurface } from '../lib/core/surface-refresh-service.js';

const args = process.argv.slice(2);
const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return args[idx + 1];
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const clampInt = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
};

const ensureDir = (dirPath) => fs.mkdirSync(dirPath, { recursive: true });

const isPidAlive = (pid) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

const readJsonIfExists = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const readQueueRows = (filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
  } catch {
    return [];
  }
};

const hasProcessableQueueRows = (queuePath) => readQueueRows(queuePath)
  .some((row) => ['pending', 'failed_retryable', 'processing'].includes(String(row?.status || 'pending')));

const acquireLock = ({ outputDir, configPath }) => {
  ensureDir(outputDir);
  const lockDir = path.join(outputDir, 'gigabrain-auto-capture-worker.lock.d');
  const metadataPath = path.join(lockDir, 'lock.json');
  const staleMs = 10 * 60 * 1000;
  try {
    fs.mkdirSync(lockDir);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const existing = readJsonIfExists(metadataPath);
    const ageMs = (() => {
      try { return Date.now() - fs.statSync(lockDir).mtimeMs; } catch { return staleMs + 1; }
    })();
    if (existing && isPidAlive(existing.pid) && ageMs < staleMs) {
      return { acquired: false, lockDir, metadataPath, existing };
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  fs.writeFileSync(metadataPath, JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    configPath,
  }, null, 2));
  return { acquired: true, lockDir, metadataPath };
};

const releaseLock = (lock) => {
  if (lock?.acquired && lock.lockDir) fs.rmSync(lock.lockDir, { recursive: true, force: true });
};

const makeRefreshRunId = () => `auto-capture-worker-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const runSurfaceRefresh = ({ config, configPath, dbPath, db = null, reason }) => refreshGeneratedMemorySurface({
  config,
  configPath,
  dbPath,
  db,
  reason,
  runId: makeRefreshRunId(),
  force: false,
  rebuildGraph: true,
});

const main = async () => {
  const configPath = readFlag('--config', '/home/alex/.openclaw/openclaw.json');
  const limit = clampInt(readFlag('--limit', '3'), 1, 20, 3);
  const loaded = loadResolvedConfig({ configPath });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath));
  const workspaceRoot = String(config.runtime.paths.workspaceRoot || process.cwd());
  const outputDirRaw = String(config.runtime.paths.outputDir || 'output');
  const outputDir = path.isAbsolute(outputDirRaw) ? outputDirRaw : path.join(workspaceRoot, outputDirRaw);
  const lock = acquireLock({ outputDir, configPath: loaded.configPath || configPath });
  if (!lock.acquired) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'lock_active', existing: lock.existing || null }, null, 2));
    return;
  }

  let db;
  try {
    const queuePath = resolveAutoCaptureQueuePath(config);
    const retention = applyAutoCaptureQueueRetention({ queuePath });
    if (!hasProcessableQueueRows(queuePath)) {
      const surfaceRefresh = runSurfaceRefresh({
        config,
        configPath: loaded.configPath || configPath,
        dbPath,
        reason: 'auto_capture_no_processable_rows',
      });
      if (surfaceRefresh.ok === false) process.exitCode = 1;
      console.log(JSON.stringify({
        ok: surfaceRefresh.ok !== false,
        queuePath,
        rows: readQueueRows(queuePath).length,
        processed: 0,
        completed: 0,
        failed: 0,
        autoSaved: 0,
        queuedReview: 0,
        results: [],
        skipped: true,
        reason: 'no_processable_rows',
        retention,
        surfaceRefresh,
      }, null, 2));
      return;
    }
    db = openDatabase(dbPath);
    ensureProjectionStore(db);
    ensureEventStore(db);
    materializeProjectionFromMemories(db);
    ensureWorldModelReady({ db, config });
    const result = await processAutoCaptureQueue({
      db,
      config,
      queuePath,
      limit,
      logger: console,
      reviewVersion: 'auto-capture-worker-v1',
    });
    const surfaceRefresh = runSurfaceRefresh({
      config,
      configPath: loaded.configPath || configPath,
      dbPath,
      db,
      reason: 'auto_capture_post_process',
    });
    const ok = result?.ok !== false && surfaceRefresh.ok !== false;
    if (!ok) process.exitCode = 1;
    console.log(JSON.stringify({ ok, ...result, retention, surfaceRefresh }, null, 2));
  } finally {
    try { db?.close?.(); } catch {}
    releaseLock(lock);
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

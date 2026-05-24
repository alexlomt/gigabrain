import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildMissingEmbeddings } from './embedding-service.js';
import { ensureProjectionStore, materializeProjectionFromMemories } from './projection-store.js';
import { openDatabase } from './sqlite.js';
import { buildVaultSurface, inspectVaultHealth } from './vault-mirror.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');
const SURFACE_REFRESH_LOCK_STALE_MS = 30 * 60 * 1000;

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const removeDirIfExists = (dirPath) => {
  if (!dirPath) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
};

const readJsonIfExists = (filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

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

const outputDirForConfig = (config = {}) => {
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const rawOutputDir = String(config?.runtime?.paths?.outputDir || 'output');
  return path.isAbsolute(rawOutputDir) ? rawOutputDir : path.join(workspaceRoot, rawOutputDir);
};

const safeRunId = (value = '') => String(value || new Date().toISOString()).replace(/[:.]/g, '-');

const getSurfaceRefreshLockPaths = (config = {}) => {
  const outputDir = outputDirForConfig(config);
  return {
    outputDir,
    lockDir: path.join(outputDir, 'gigabrain-surface-refresh.lock.d'),
    metadataPath: path.join(outputDir, 'gigabrain-surface-refresh.lock.d', 'lock.json'),
  };
};

const inspectExistingLock = ({ lockDir, metadataPath }) => {
  const existing = readJsonIfExists(metadataPath);
  if (existing && isPidAlive(existing.pid)) {
    return {
      active: true,
      existing,
      reason: 'pid_alive',
    };
  }
  const lockAgeMs = (() => {
    try {
      return Math.max(0, Date.now() - fs.statSync(lockDir).mtimeMs);
    } catch {
      return SURFACE_REFRESH_LOCK_STALE_MS;
    }
  })();
  const startedAtMs = Date.parse(String(existing?.startedAt || ''));
  const staleByAge = lockAgeMs >= SURFACE_REFRESH_LOCK_STALE_MS;
  const staleByStartedAt = Number.isFinite(startedAtMs)
    && (Date.now() - startedAtMs) >= SURFACE_REFRESH_LOCK_STALE_MS;
  if (existing && !isPidAlive(existing.pid)) return { active: false, existing, reason: 'pid_missing' };
  if (!existing && staleByAge) return { active: false, existing: null, reason: 'metadata_missing_timeout' };
  if (existing && staleByStartedAt) return { active: false, existing, reason: 'started_at_timeout' };
  return {
    active: true,
    existing,
    reason: existing ? 'unknown_owner' : 'metadata_missing_recent',
  };
};

const acquireSurfaceRefreshLock = ({ config, reason = '', runId = '' } = {}) => {
  const { outputDir, lockDir, metadataPath } = getSurfaceRefreshLockPaths(config);
  ensureDir(outputDir);
  const metadata = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    reason: String(reason || ''),
    runId: String(runId || ''),
  };
  const writeMetadata = () => {
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  };
  const attemptAcquire = () => {
    fs.mkdirSync(lockDir);
    writeMetadata();
    return {
      acquired: true,
      skipped: false,
      clearedStale: false,
      lockDir,
      metadataPath,
      metadata,
    };
  };
  try {
    return attemptAcquire();
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const inspection = inspectExistingLock({ lockDir, metadataPath });
    if (inspection.active) {
      return {
        acquired: false,
        skipped: true,
        reason: 'surface_refresh_already_running',
        detail: inspection.reason,
        lockDir,
        metadataPath,
        existing: inspection.existing,
      };
    }
    removeDirIfExists(lockDir);
    const acquired = attemptAcquire();
    return {
      ...acquired,
      clearedStale: true,
      staleReason: inspection.reason,
      previous: inspection.existing,
    };
  }
};

const releaseSurfaceRefreshLock = (lockState) => {
  if (lockState?.acquired) removeDirIfExists(lockState.lockDir);
};

const compactStatusCounts = (value = {}) => {
  const input = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.entries(input)
    .map(([key, count]) => [String(key || ''), Number(count || 0)])
    .filter(([key]) => key));
};

const compactReviewQueue = (value = {}) => {
  if (!value || typeof value !== 'object') return null;
  return {
    total: Number(value.total || 0),
    pending: Number(value.pending || 0),
    by_reason: value.by_reason && typeof value.by_reason === 'object' ? { ...value.by_reason } : {},
  };
};

const compactHealth = (health = {}) => ({
  enabled: health?.enabled === true,
  summary_path: String(health?.summary_path || ''),
  manual_protection: {
    ok: health?.manual_protection?.ok === true,
    issues: Array.isArray(health?.manual_protection?.issues) ? [...health.manual_protection.issues] : [],
  },
  vault: {
    last_built_at: health?.vault?.last_built_at || null,
    stale: health?.vault?.stale === true,
    age_stale: health?.vault?.age_stale === true,
    drift: {
      stale: health?.vault?.drift?.stale === true,
      reasons: Array.isArray(health?.vault?.drift?.reasons) ? [...health.vault.drift.reasons] : [],
      live_status_counts: compactStatusCounts(health?.vault?.drift?.live_status_counts || {}),
      summary_status_counts: compactStatusCounts(health?.vault?.drift?.summary_status_counts || {}),
      live_active_nodes: Number(health?.vault?.drift?.live_active_nodes || 0),
      summary_active_nodes: Number(health?.vault?.drift?.summary_active_nodes || 0),
      live_review_queue: compactReviewQueue(health?.vault?.drift?.live_review_queue),
      summary_review_queue: compactReviewQueue(health?.vault?.drift?.summary_review_queue),
    },
  },
});

const compactVaultBuild = (summary = {}) => ({
  enabled: summary?.enabled === true,
  generated_at: summary?.generated_at || null,
  run_id: String(summary?.run_id || ''),
  active_nodes: Number(summary?.active_nodes || 0),
  source_files: Number(summary?.source_files || 0),
  copied_files: Number(summary?.copied_files || 0),
  skipped_unchanged: Number(summary?.skipped_unchanged || 0),
  removed_files: Number(summary?.removed_files || 0),
  counts: {
    by_status: compactStatusCounts(summary?.counts?.by_status || {}),
  },
  review_queue: compactReviewQueue(summary?.review_queue),
  surface_summary_path: String(summary?.surface_summary_path || ''),
  mirror_root: String(summary?.mirror_root || ''),
});

const compactEmbeddingBuild = (result = {}) => ({
  ok: result?.ok !== false,
  skipped: result?.skipped === true,
  reason: String(result?.reason || ''),
  enabled: result?.enabled === true,
  before: result?.before ? {
    active: Number(result.before.active || 0),
    embedded: Number(result.before.embedded || 0),
    missing: Number(result.before.missing || 0),
    coverage: Number(result.before.coverage || 0),
  } : undefined,
  after: result?.after ? {
    active: Number(result.after.active || 0),
    embedded: Number(result.after.embedded || 0),
    missing: Number(result.after.missing || 0),
    coverage: Number(result.after.coverage || 0),
  } : undefined,
  computed: Number(result?.computed || 0),
  failed: Number(result?.failed || 0),
  error: result?.error ? String(result.error) : undefined,
});

const parseGraphBuildStdout = (stdout = '') => {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // graph-build logs human-readable progress before printing its JSON result.
    const match = text.match(/(\{\s*"ok"\s*:\s*(?:true|false)[\s\S]*\})\s*$/);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
};

const runGraphBuild = ({ configPath = '', dbPath = '' } = {}) => {
  const scriptPath = path.join(PACKAGE_ROOT, 'scripts', 'graph-build.js');
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, skipped: true, reason: 'graph_script_missing' };
  }
  const args = [scriptPath];
  if (configPath) args.push('--config', String(configPath));
  if (dbPath) args.push('--db', String(dbPath));
  const run = spawnSync(process.execPath, args, {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = String(run.stdout || '').trim();
  const stderr = String(run.stderr || '').trim();
  const parsed = parseGraphBuildStdout(stdout);
  const ok = Number(run.status || 0) === 0 && (!parsed || parsed.ok !== false);
  return {
    ok,
    skipped: false,
    exitCode: Number(run.status ?? 1),
    signal: run.signal || null,
    node_count: Number(parsed?.node_count || parsed?.nodes || 0),
    edge_count: Number(parsed?.edge_count || parsed?.edges || 0),
    outputPath: String(parsed?.outputPath || parsed?.out || ''),
    stdout: parsed || ok ? '' : stdout.slice(-1000),
    stderr: stderr.slice(0, 1000),
  };
};

const surfaceIsCurrent = (health = {}) => (
  health?.enabled !== true
    || (
      health?.vault?.stale !== true
      && health?.manual_protection?.ok === true
    )
);

const refreshGeneratedMemorySurface = ({
  db = null,
  dbPath = '',
  config,
  configPath = '',
  dryRun = false,
  runId = '',
  reason = 'surface_refresh',
  force = false,
  rebuildGraph = false,
} = {}) => {
  if (config?.vault?.enabled !== true) {
    return {
      ok: true,
      skipped: true,
      reason: 'vault_disabled',
    };
  }

  const resolvedRunId = String(runId || `${reason}-${safeRunId()}`);
  const lock = acquireSurfaceRefreshLock({ config, reason, runId: resolvedRunId });
  if (!lock.acquired) {
    return {
      ok: true,
      skipped: true,
      reason: lock.reason,
      lock,
    };
  }

  let openedDb = false;
  let connection = db;
  try {
    if (!connection) {
      if (!dbPath) throw new Error('surface refresh requires db or dbPath');
      connection = openDatabase(dbPath);
      openedDb = true;
    }
    ensureProjectionStore(connection);
    materializeProjectionFromMemories(connection);

    const before = inspectVaultHealth({ config, db: connection });
    if (!force && surfaceIsCurrent(before)) {
      return {
        ok: true,
        skipped: true,
        reason: 'surface_current',
        lock: { acquired: true, clearedStale: lock.clearedStale === true },
        before: compactHealth(before),
      };
    }

    if (dryRun) {
      return {
        ok: true,
        skipped: true,
        dryRun: true,
        reason: 'dry_run_would_refresh',
        force: force === true,
        before: compactHealth(before),
      };
    }

    let embeddings = {
      ok: true,
      skipped: true,
      reason: 'semantic_rerank_disabled',
      enabled: false,
    };
    if (config?.recall?.semanticRerankEnabled === true) {
      try {
        embeddings = {
          ok: true,
          skipped: false,
          ...buildMissingEmbeddings(connection, config),
        };
      } catch (err) {
        embeddings = {
          ok: false,
          skipped: false,
          enabled: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const vault = buildVaultSurface({
      db: connection,
      config,
      dryRun: false,
      runId: resolvedRunId,
    });
    const graph = rebuildGraph
      ? runGraphBuild({ configPath, dbPath })
      : { ok: true, skipped: true, reason: 'not_requested' };
    const after = inspectVaultHealth({ config, db: connection });
    const ok = embeddings.ok !== false
      && graph.ok !== false
      && after?.vault?.stale !== true
      && after?.manual_protection?.ok === true;

    return {
      ok,
      skipped: false,
      reason,
      force: force === true,
      lock: {
        acquired: true,
        clearedStale: lock.clearedStale === true,
        staleReason: lock.staleReason || '',
      },
      before: compactHealth(before),
      embeddings: compactEmbeddingBuild(embeddings),
      vault: compactVaultBuild(vault),
      graph,
      after: compactHealth(after),
    };
  } finally {
    if (openedDb) {
      try { connection?.close?.(); } catch {}
    }
    releaseSurfaceRefreshLock(lock);
  }
};

export {
  refreshGeneratedMemorySurface,
};

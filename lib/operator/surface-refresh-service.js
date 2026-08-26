import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildMissingEmbeddings } from '../core/embedding-service.js';
import { withNativeMemoryLock } from '../core/native-memory.js';
import { openDatabase } from '../core/sqlite.js';
import { buildGeneratedSurface } from './generated-surface.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let localRefreshActive = false;

const parseJsonTail = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* try final object */ }
  const match = text.match(/(\{[\s\S]*\})\s*$/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
};

const defaultEmbeddingBuild = async ({ config, db }) => {
  if (config?.recall?.semanticRerankEnabled !== true || !db) {
    return { computed: 0, ok: true, reason: 'semantic_rerank_disabled', skipped: true };
  }
  try {
    return { ok: true, skipped: false, ...buildMissingEmbeddings(db, config) };
  } catch (error) {
    return { error: String(error?.message || error), ok: false, skipped: false };
  }
};

const defaultGraphBuild = async ({ configPath = '', dbPath = '' }) => {
  const script = path.join(PACKAGE_ROOT, 'scripts', 'graph-build.js');
  const args = [script];
  if (configPath) args.push('--config', String(configPath));
  if (dbPath) args.push('--db', String(dbPath));
  const run = spawnSync(process.execPath, args, {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  const parsed = parseJsonTail(run.stdout);
  return {
    edges: Number(parsed?.edge_count || parsed?.edges || 0),
    error: Number(run.status || 0) === 0 ? '' : String(run.stderr || 'graph_build_failed').slice(0, 500),
    nodes: Number(parsed?.node_count || parsed?.nodes || 0),
    ok: Number(run.status || 0) === 0 && parsed?.ok !== false,
    skipped: false,
  };
};

const executeRefresh = async ({
  buildEmbeddings,
  buildGraph,
  buildSurface,
  config,
  configPath,
  db,
  dbPath,
  force,
  mutationCount,
  outputDir,
  runId,
}) => {
  let connection = db;
  let opened = false;
  try {
    if (!connection && dbPath) {
      connection = openDatabase(dbPath);
      opened = true;
    }
    const embeddings = await buildEmbeddings({ config, db: connection, dbPath, runId });
    const surface = await buildSurface({ config, db: connection, force, outputDir, runId });
    const graph = await buildGraph({ config, configPath, db: connection, dbPath, runId });
    return {
      embeddings,
      graph,
      inputMutationCount: mutationCount,
      ok: embeddings?.ok !== false && surface?.ok !== false && graph?.ok !== false,
      reason: 'mutations_refreshed',
      skipped: false,
      surface,
    };
  } finally {
    if (opened) connection?.close?.();
  }
};

const refreshGeneratedSurfaceAfterMutation = async ({
  buildEmbeddings = defaultEmbeddingBuild,
  buildGraph = defaultGraphBuild,
  buildSurface = buildGeneratedSurface,
  config = {},
  configPath = '',
  db,
  dbPath = '',
  force = false,
  mutationCount = 0,
  outputDir = '',
  runId = '',
} = {}) => {
  const mutations = Math.max(0, Number(mutationCount || 0));
  if (mutations === 0) {
    return { mutationCount: 0, ok: true, reason: 'no_mutations', skipped: true };
  }
  if (localRefreshActive) {
    return { inputMutationCount: mutations, ok: true, reason: 'surface_refresh_active', skipped: true };
  }
  const execute = async () => {
    localRefreshActive = true;
    try {
      return await executeRefresh({
        buildEmbeddings,
        buildGraph,
        buildSurface,
        config,
        configPath,
        db,
        dbPath,
        force,
        mutationCount: mutations,
        outputDir,
        runId,
      });
    } finally {
      localRefreshActive = false;
    }
  };
  if (config?.runtimeDescriptorPath || process.env.GIGABRAIN_RUNTIME_DESCRIPTOR) {
    return withNativeMemoryLock(config, execute);
  }
  return execute();
};

export {
  refreshGeneratedSurfaceAfterMutation,
};

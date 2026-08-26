import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFileSync, readFileIfExistsSync } from '../core/safe-fs.js';

const GENERATED_FILES = Object.freeze([
  '00 Home/Home.md',
  '30 Views/Current State.md',
  '30 Views/Important People.md',
  '30 Views/Important Projects.md',
  '30 Views/Native Notes.md',
  '30 Views/What Changed.md',
  '40 Reports/surface-summary.json',
  '40 Reports/vault-build-summary.json',
  '40 Reports/vault-build-summary.md',
  '40 Reports/vault-freshness.json',
  '40 Reports/vault-manifest.json',
  '50 Briefings/Session Brief.md',
  'vault-index.md',
]);
const DEFAULT_MANUAL_FOLDERS = Object.freeze(['Inbox', 'Manual']);
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_VIEW_ROWS = 200;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;
const posix = (value) => String(value || '').split(path.sep).join('/');
const cleanLine = (value, max = 1000) => String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max).trim();
const safeFileName = (value, fallback = 'entity') => {
  const normalized = String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || fallback;
};
const tableExists = (db, tableName) => Boolean(db?.prepare?.(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
).get(String(tableName || '')));

const resolveSurfaceRoot = ({ config = {}, outputDir = '' } = {}) => {
  if (outputDir) return path.resolve(String(outputDir));
  const vaultRoot = String(config?.vault?.path || '').trim();
  if (!vaultRoot) return '';
  const subdir = String(config?.vault?.subdir || 'Gigabrain').trim() || 'Gigabrain';
  return path.resolve(vaultRoot, subdir);
};
const resolveManualFolders = (config = {}) => {
  const configured = Array.isArray(config?.vault?.manualFolders)
    ? config.vault.manualFolders.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  return configured.length ? [...new Set(configured)] : [...DEFAULT_MANUAL_FOLDERS];
};
const isWithin = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const assertSafePath = (root, target, { allowMissing = true } = {}) => {
  if (!root || !target || !isWithin(root, target)) throw new Error('GENERATED_SURFACE_PATH_INVALID');
  let current = target;
  while (isWithin(root, current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('GENERATED_SURFACE_SYMLINK_REJECTED');
      if (stat.isFile() && Number(stat.nlink) !== 1) throw new Error('GENERATED_SURFACE_HARDLINK_REJECTED');
    } catch (error) {
      if (error?.code !== 'ENOENT' || !allowMissing) throw error;
    }
    if (current === root) break;
    current = path.dirname(current);
  }
};
const ensurePrivateDir = (root, dirPath) => {
  assertSafePath(root, dirPath);
  fs.mkdirSync(dirPath, { recursive: true, mode: DIRECTORY_MODE });
  fs.chmodSync(dirPath, DIRECTORY_MODE);
};
const readJson = (filePath) => {
  const snapshot = readFileIfExistsSync(filePath, 'utf8', { maxBytes: 4 * 1024 * 1024 });
  if (!snapshot.exists) return null;
  try {
    return JSON.parse(snapshot.data);
  } catch {
    return null;
  }
};

const queryRows = (db, sql, params = []) => {
  try {
    return db?.prepare?.(sql).all(...params) || [];
  } catch {
    return [];
  }
};
const collectRegistry = (db) => {
  if (!tableExists(db, 'memory_current')) return [];
  return queryRows(db, `
    SELECT memory_id, type, content, confidence, scope, status, source_layer, source_path, created_at, updated_at
    FROM memory_current
    ORDER BY COALESCE(updated_at, created_at, '') DESC, memory_id ASC
    LIMIT 5000
  `).map((row) => ({
    confidence: Number(row.confidence || 0),
    content: String(row.content || ''),
    created_at: String(row.created_at || ''),
    memory_id: String(row.memory_id || ''),
    scope: String(row.scope || 'shared'),
    source_layer: String(row.source_layer || ''),
    source_path: String(row.source_path || ''),
    status: String(row.status || ''),
    type: String(row.type || 'CONTEXT'),
    updated_at: String(row.updated_at || ''),
  }));
};
const collectEntities = (db) => {
  if (!tableExists(db, 'memory_entities')) return [];
  return queryRows(db, `
    SELECT entity_id, kind, display_name, normalized_name, status, confidence, updated_at
    FROM memory_entities
    WHERE status = 'active'
    ORDER BY kind ASC, display_name ASC, entity_id ASC
    LIMIT 2000
  `).map((row) => ({
    confidence: Number(row.confidence || 0),
    display_name: String(row.display_name || ''),
    entity_id: String(row.entity_id || ''),
    kind: String(row.kind || 'topic'),
    normalized_name: String(row.normalized_name || ''),
    status: String(row.status || 'active'),
    updated_at: String(row.updated_at || ''),
  }));
};
const collectBeliefs = (db) => {
  if (!tableExists(db, 'memory_beliefs')) return [];
  return queryRows(db, `
    SELECT belief_id, entity_id, type, content, status, confidence, source_memory_id
    FROM memory_beliefs
    WHERE status = 'current'
    ORDER BY entity_id ASC, confidence DESC, belief_id ASC
    LIMIT 5000
  `).map((row) => ({
    belief_id: String(row.belief_id || ''),
    confidence: Number(row.confidence || 0),
    content: String(row.content || ''),
    entity_id: String(row.entity_id || ''),
    source_memory_id: String(row.source_memory_id || ''),
    status: String(row.status || ''),
    type: String(row.type || ''),
  }));
};
const collectSyntheses = (db) => {
  if (!tableExists(db, 'memory_syntheses')) return [];
  return queryRows(db, `
    SELECT synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at
    FROM memory_syntheses
    WHERE stale = 0
    ORDER BY generated_at DESC, synthesis_id ASC
    LIMIT 200
  `).map((row) => ({ ...row, content: String(row.content || '') }));
};

const reviewQueueSummary = (queuePath) => {
  if (!queuePath || !fs.existsSync(queuePath)) return { byReason: {}, pending: 0, total: 0 };
  const byReason = {};
  let pending = 0;
  let total = 0;
  for (const line of fs.readFileSync(queuePath, 'utf8').split(/\r?\n/).filter(Boolean).slice(0, 5000)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    total += 1;
    if (String(row?.status || 'pending') === 'pending') pending += 1;
    const reason = String(row?.reason_code || row?.reason || 'unknown');
    byReason[reason] = Number(byReason[reason] || 0) + 1;
  }
  return { byReason, pending, total };
};
const countsFor = (memories, queue) => {
  const byScope = {};
  const byStatus = {};
  const byType = {};
  for (const row of memories) {
    byScope[row.scope] = Number(byScope[row.scope] || 0) + 1;
    byStatus[row.status] = Number(byStatus[row.status] || 0) + 1;
    byType[row.type] = Number(byType[row.type] || 0) + 1;
  }
  return {
    active: Number(byStatus.active || 0),
    byScope,
    byStatus,
    byType,
    pendingReview: Number(queue.pending || 0),
    total: memories.length,
  };
};

const nativeSources = (config = {}) => {
  const workspace = String(config?.runtime?.paths?.workspaceRoot || '').trim();
  if (!workspace) return [];
  const candidates = [path.join(workspace, 'MEMORY.md')];
  const daily = path.join(workspace, 'memory');
  if (fs.existsSync(daily) && fs.statSync(daily).isDirectory()) {
    for (const name of fs.readdirSync(daily).sort()) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) candidates.push(path.join(daily, name));
    }
  }
  return candidates.filter((filePath) => {
    try { return fs.statSync(filePath).isFile(); } catch { return false; }
  }).map((filePath) => ({
    bytes: fs.readFileSync(filePath),
    relative: posix(path.relative(workspace, filePath)),
  }));
};

const latestTimestamp = (...groups) => {
  let latest = 0;
  for (const row of groups.flat()) {
    for (const key of ['updated_at', 'generated_at', 'created_at']) {
      const parsed = Date.parse(String(row?.[key] || ''));
      if (Number.isFinite(parsed)) latest = Math.max(latest, parsed);
    }
  }
  return new Date(latest || 0).toISOString();
};
const markdownList = (rows, render) => rows.length ? rows.map(render).join('\n') : '- none';

const buildPlan = ({ config, memories, entities, beliefs, syntheses, queue, generatedAt, sourceHash }) => {
  const active = memories.filter((row) => row.status === 'active').slice(0, MAX_VIEW_ROWS);
  const people = entities.filter((row) => row.kind === 'person').slice(0, MAX_VIEW_ROWS);
  const projects = entities.filter((row) => ['project', 'organization'].includes(row.kind)).slice(0, MAX_VIEW_ROWS);
  const counts = countsFor(memories, queue);
  const files = new Map();
  files.set('00 Home/Home.md', `# Gigabrain Home\n\n- generated_at: ${generatedAt}\n- active_memories: ${counts.active}\n- pending_review: ${counts.pendingReview}\n\n## Views\n\n- [[30 Views/Current State]]\n- [[30 Views/Important People]]\n- [[30 Views/Important Projects]]\n- [[30 Views/Native Notes]]\n- [[30 Views/What Changed]]\n`);
  files.set('vault-index.md', `# Gigabrain Index\n\n- source_hash: \`${sourceHash}\`\n- [[00 Home/Home]]\n- [[50 Briefings/Session Brief]]\n`);
  files.set('30 Views/Current State.md', `# Current State\n\n${markdownList(active, (row) => `- **${row.type}** [${row.scope}] ${cleanLine(row.content)}`)}\n`);
  files.set('30 Views/Important People.md', `# Important People\n\n${markdownList(people, (row) => `- [[20 Entities/people/${safeFileName(row.entity_id)}|${cleanLine(row.display_name)}]]`)}\n`);
  files.set('30 Views/Important Projects.md', `# Important Projects\n\n${markdownList(projects, (row) => `- [[20 Entities/${row.kind}s/${safeFileName(row.entity_id)}|${cleanLine(row.display_name)}]]`)}\n`);
  const natives = nativeSources(config);
  files.set('30 Views/Native Notes.md', `# Native Notes\n\n${markdownList(natives, (row) => `- [[10 Native/${row.relative.replace(/\.md$/i, '')}]]`)}\n`);
  files.set('30 Views/What Changed.md', `# What Changed\n\n${markdownList(memories.slice(0, 100), (row) => `- ${row.updated_at || row.created_at || 'unknown'} — **${row.status}** ${cleanLine(row.content)}`)}\n`);
  for (const native of natives) files.set(posix(path.join('10 Native', native.relative)), native.bytes);
  const beliefsByEntity = new Map();
  for (const belief of beliefs) {
    if (!beliefsByEntity.has(belief.entity_id)) beliefsByEntity.set(belief.entity_id, []);
    beliefsByEntity.get(belief.entity_id).push(belief);
  }
  if (config?.surface?.obsidian?.entityPages !== false && config?.surface?.obsidian?.exportEntityPages !== 'off') {
    for (const entity of entities) {
      const kindDir = entity.kind === 'person' ? 'people' : `${entity.kind || 'topic'}s`;
      const entityBeliefs = beliefsByEntity.get(entity.entity_id) || [];
      files.set(posix(path.join('20 Entities', kindDir, `${safeFileName(entity.entity_id)}.md`)), `# ${cleanLine(entity.display_name)}\n\n- kind: ${entity.kind}\n- confidence: ${entity.confidence.toFixed(2)}\n\n## Current Beliefs\n\n${markdownList(entityBeliefs.slice(0, 50), (row) => `- ${cleanLine(row.content)}`)}\n`);
    }
  }
  const sessionBrief = syntheses.find((row) => row.kind === 'session_brief' && String(row.content || '').trim());
  files.set('50 Briefings/Session Brief.md', sessionBrief
    ? `# Session Brief\n\n${String(sessionBrief.content).trim()}\n`
    : `# Session Brief\n\n- active_memories: ${counts.active}\n- pending_review: ${counts.pendingReview}\n`);
  const summary = {
    counts,
    entities: entities.length,
    generated_at: generatedAt,
    review_queue: queue,
    source_hash: sourceHash,
  };
  const generatedFiles = [...new Set([...GENERATED_FILES, ...files.keys()])].sort();
  const manifest = {
    generated_at: generatedAt,
    generated_files: generatedFiles,
    manual_folders: resolveManualFolders(config),
    schema_version: 1,
    source_hash: sourceHash,
  };
  const freshness = {
    generated_at: generatedAt,
    manual_protection: { issues: [], ok: true },
    source_hash: sourceHash,
    stale: false,
  };
  files.set('40 Reports/surface-summary.json', canonicalJson(summary));
  files.set('40 Reports/vault-build-summary.json', canonicalJson(summary));
  files.set('40 Reports/vault-build-summary.md', `# Vault Build Report\n\n- generated_at: ${generatedAt}\n- source_hash: \`${sourceHash}\`\n- active_memories: ${counts.active}\n- pending_review: ${counts.pendingReview}\n- generated_files: ${generatedFiles.length}\n`);
  files.set('40 Reports/vault-freshness.json', canonicalJson(freshness));
  files.set('40 Reports/vault-manifest.json', canonicalJson(manifest));
  return { counts, files, freshness, generatedFiles, manifest, summary };
};

const fileCurrent = (filePath, content) => {
  try {
    const existing = fs.readFileSync(filePath);
    const expected = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && (stat.mode & 0o777) === FILE_MODE && Buffer.compare(existing, expected) === 0;
  } catch {
    return false;
  }
};
const writeManaged = (root, relative, content) => {
  const target = path.resolve(root, relative);
  assertSafePath(root, target);
  ensurePrivateDir(root, path.dirname(target));
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (fileCurrent(target, expected)) return false;
  atomicWriteFileSync(target, expected, { mode: FILE_MODE });
  fs.chmodSync(target, FILE_MODE);
  return true;
};
const removeStaleGenerated = (root, previousManifest, expected, manualFolders) => {
  let removed = 0;
  for (const relative of Array.isArray(previousManifest?.generated_files) ? previousManifest.generated_files : []) {
    if (expected.has(relative) || manualFolders.some((folder) => relative === folder || relative.startsWith(`${folder}/`))) continue;
    const target = path.resolve(root, relative);
    if (!isWithin(root, target)) throw new Error('GENERATED_SURFACE_PATH_INVALID');
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('GENERATED_SURFACE_STALE_PATH_INVALID');
      fs.unlinkSync(target);
      removed += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return removed;
};
const privateTreeIssues = (root, manifest, manualFolders) => {
  const issues = [];
  if (!root || !fs.existsSync(root)) return ['surface_root_missing'];
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== DIRECTORY_MODE) issues.push('surface_root_mode');
  for (const folder of manualFolders) {
    const target = path.join(root, folder);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) issues.push(`manual_folder_invalid:${folder}`);
    } catch {
      issues.push(`manual_folder_missing:${folder}`);
    }
  }
  for (const relative of Array.isArray(manifest?.generated_files) ? manifest.generated_files : []) {
    const target = path.join(root, relative);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE) {
        issues.push(`generated_file_invalid:${relative}`);
      }
    } catch {
      issues.push(`generated_file_missing:${relative}`);
    }
  }
  return issues;
};

const collectSource = ({ config, db }) => {
  const memories = collectRegistry(db);
  const entities = collectEntities(db);
  const beliefs = collectBeliefs(db);
  const syntheses = collectSyntheses(db);
  const queue = reviewQueueSummary(config?.runtime?.paths?.reviewQueuePath);
  const native = nativeSources(config).map((row) => ({ relative: row.relative, sha256: sha256(row.bytes) }));
  const sourceHash = sha256(canonicalJson({ beliefs, entities, memories, native, queue, syntheses }));
  return {
    beliefs,
    entities,
    generatedAt: latestTimestamp(memories, entities, syntheses),
    memories,
    queue,
    sourceHash,
    syntheses,
  };
};

const buildGeneratedSurface = async ({ db, config = {}, outputDir = '', force = false, runId = '' } = {}) => {
  const root = resolveSurfaceRoot({ config, outputDir });
  if (!root) return { counts: { active: 0, pendingReview: 0, total: 0 }, mutationCount: 0, ok: true, reason: 'surface_disabled', skipped: true };
  assertSafePath(root, root);
  ensurePrivateDir(root, root);
  const manualFolders = resolveManualFolders(config);
  for (const folder of manualFolders) ensurePrivateDir(root, path.join(root, folder));
  const source = collectSource({ config, db });
  const manifestPath = path.join(root, '40 Reports', 'vault-manifest.json');
  const previousManifest = readJson(manifestPath);
  const previousIssues = privateTreeIssues(root, previousManifest, manualFolders);
  if (!force && previousManifest?.source_hash === source.sourceHash && previousIssues.length === 0) {
    const previousSummary = readJson(path.join(root, '40 Reports', 'surface-summary.json'));
    return {
      counts: previousSummary?.counts || countsFor(source.memories, source.queue),
      mutationCount: 0,
      ok: true,
      outputDir: root,
      reason: 'surface_current',
      runId: String(runId || ''),
      skipped: true,
      sourceHash: source.sourceHash,
    };
  }
  const plan = buildPlan({
    beliefs: source.beliefs,
    config,
    entities: source.entities,
    generatedAt: source.generatedAt,
    memories: source.memories,
    queue: source.queue,
    sourceHash: source.sourceHash,
    syntheses: source.syntheses,
  });
  let mutationCount = 0;
  for (const [relative, content] of plan.files) {
    if (writeManaged(root, relative, content)) mutationCount += 1;
  }
  mutationCount += removeStaleGenerated(root, previousManifest, new Set(plan.generatedFiles), manualFolders);
  const outputArtifactDir = String(config?.runtime?.paths?.outputDir || '').trim();
  if (outputArtifactDir) {
    ensurePrivateDir(outputArtifactDir, outputArtifactDir);
    const outputPath = path.join(outputArtifactDir, 'memory-surface-summary.json');
    if (writeManaged(outputArtifactDir, 'memory-surface-summary.json', canonicalJson(plan.summary))) mutationCount += 1;
    fs.chmodSync(outputPath, FILE_MODE);
  }
  const issues = privateTreeIssues(root, plan.manifest, manualFolders);
  return {
    counts: plan.counts,
    generatedFiles: plan.generatedFiles,
    mutationCount,
    ok: issues.length === 0,
    outputDir: root,
    reason: issues.length ? 'surface_invalid' : 'surface_built',
    runId: String(runId || ''),
    skipped: false,
    sourceHash: source.sourceHash,
    issues,
  };
};

const inspectGeneratedSurface = async ({ db, config = {}, outputDir = '' } = {}) => {
  const root = resolveSurfaceRoot({ config, outputDir });
  const manualFolders = resolveManualFolders(config);
  const manifest = root ? readJson(path.join(root, '40 Reports', 'vault-manifest.json')) : null;
  const summary = root ? readJson(path.join(root, '40 Reports', 'surface-summary.json')) : null;
  const issues = root ? privateTreeIssues(root, manifest, manualFolders) : ['surface_disabled'];
  let sourceHash = manifest?.source_hash || '';
  if (db) {
    sourceHash = collectSource({ config, db }).sourceHash;
    if (manifest?.source_hash !== sourceHash) issues.push('surface_source_drift');
  }
  const manualIssues = issues.filter((value) => value.startsWith('manual_folder_'));
  return {
    counts: summary?.counts || { active: 0, pendingReview: 0, total: 0 },
    generatedAt: manifest?.generated_at || null,
    healthy: issues.length === 0,
    issues,
    manualProtection: { issues: manualIssues, ok: manualIssues.length === 0 },
    outputDir: root,
    sourceHash,
  };
};

export {
  buildGeneratedSurface,
  inspectGeneratedSurface,
};

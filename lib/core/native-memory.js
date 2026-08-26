import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeContent } from './policy.js';
import { assertWriteAllowed, resolveWriteMode } from '../compat/write-policy.js';
import { atomicWriteFileSync } from './safe-fs.js';
import {
  parseNativeMetadata,
  renderNativeMetadata,
  renderNativeOriginMarker,
  stripNativeMetadata,
} from '../compat/native-metadata.js';
import { DEFAULT_RUNTIME_DESCRIPTOR_PATH, resolveRuntimeDescriptor } from '../compat/runtime-descriptor.js';

const HEADING_BY_TYPE = Object.freeze({
  PREFERENCE: 'Preferences',
  DECISION: 'Decisions',
  USER_FACT: 'User Facts',
  AGENT_IDENTITY: 'Agent Identity',
  ENTITY: 'Entities',
  EPISODE: 'Episodes',
  CONTEXT: 'Session Notes',
});

const CHECKPOINT_BASE_SECTION_TITLES = Object.freeze({
  decisions: 'Decisions',
  open_loops: 'Open Loops',
  touched_files: 'Touched Files',
  durable_candidates: 'Durable Candidates',
});

const MEMORY_LINK_RE = /\[m:[0-9a-f-]{8,}\]\s*/ig;
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
const LEGACY_SCOPE_COMMENT_RE = /\s*<!--\s*gigabrain:scope=([^\s>]+)\s*-->\s*$/i;
const OWNER_FILE_NAME = 'owner.json';
const DEFAULT_NATIVE_LOCK_TIMEOUT_MS = 90_000;
const DEFAULT_NATIVE_LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_POLL_MS = 20;
const nativeLockContext = new AsyncLocalStorage();

// Path validation constants
const VALID_FILENAME_RE = /^[a-zA-Z0-9_\-.]{1,256}$/;
const MAX_PATH_LENGTH = 4096;

const lockError = (code, detail = '') => {
  const error = new Error(`${code}${detail ? `: ${detail}` : ''}`);
  error.code = code;
  return error;
};

const processStartIdentity = (pid = process.pid) => {
  try {
    const raw = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return '';
    return String(raw.slice(close + 2).trim().split(/\s+/)[19] || '');
  } catch {
    return '';
  }
};

const readOwner = (lockDir) => {
  try {
    const ownerPath = path.join(lockDir, OWNER_FILE_NAME);
    const stat = fs.lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const ownerIsLive = (owner = {}) => {
  const pid = Number(owner?.pid || 0);
  const expectedStart = String(owner?.process_start || '');
  if (!Number.isInteger(pid) || pid <= 0 || !expectedStart) return false;
  const observedStart = processStartIdentity(pid);
  return Boolean(observedStart && observedStart === expectedStart);
};

const resolveNativeLockOptions = (config = {}) => {
  let lockDir = String(config?.lockPath || '').trim();
  if (!lockDir && (config?.runtimeDescriptorPath || config?.runtimeDescriptor || config?.runtime?.descriptorPath)) {
    lockDir = resolveRuntimeDescriptor(config).nativeLockDir;
  }
  if (!lockDir && fs.existsSync(DEFAULT_RUNTIME_DESCRIPTOR_PATH)) {
    lockDir = resolveRuntimeDescriptor({}).nativeLockDir;
  }
  if (!lockDir) lockDir = String(config?.nativeLockDir || config?.runtime?.paths?.nativeLockDir || '').trim();
  if (!lockDir) {
    const memoryRoot = String(config?.runtime?.paths?.memoryRoot || '').trim();
    if (!memoryRoot) throw lockError('GIGABRAIN_NATIVE_LOCK_PATH');
    lockDir = path.join(path.resolve(memoryRoot), '.gigabrain-native-memory.lockdir');
  }
  const resolved = path.resolve(lockDir);
  if (resolved === path.parse(resolved).root) throw lockError('GIGABRAIN_NATIVE_LOCK_PATH', resolved);
  return {
    lockDir: resolved,
    timeoutMs: Math.max(1, Number(config?.timeoutMs ?? config?.nativeLock?.timeoutMs ?? DEFAULT_NATIVE_LOCK_TIMEOUT_MS) || DEFAULT_NATIVE_LOCK_TIMEOUT_MS),
    staleMs: Math.max(1, Number(config?.staleMs ?? config?.nativeLock?.staleMs ?? DEFAULT_NATIVE_LOCK_STALE_MS) || DEFAULT_NATIVE_LOCK_STALE_MS),
  };
};

const sameInode = (left, right) => Boolean(left && right
  && Number(left.dev) === Number(right.dev)
  && Number(left.ino) === Number(right.ino));

const retireLockGeneration = (handle, label) => {
  let currentStat;
  try { currentStat = fs.lstatSync(handle.lockDir); } catch { return false; }
  if (!currentStat.isDirectory() || currentStat.isSymbolicLink() || !sameInode(currentStat, handle.stat)) return false;
  const owner = readOwner(handle.lockDir);
  if (!owner || String(owner.token || '') !== handle.token) return false;
  const retired = `${handle.lockDir}.${label}-${handle.token}`;
  try {
    fs.renameSync(handle.lockDir, retired);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const retiredOwner = readOwner(retired);
  let retiredStat = null;
  try { retiredStat = fs.lstatSync(retired); } catch { /* disappeared */ }
  if (!sameInode(retiredStat, handle.stat) || String(retiredOwner?.token || '') !== handle.token) {
    throw lockError('GIGABRAIN_NATIVE_LOCK_GENERATION_CHANGED', handle.lockDir);
  }
  fs.rmSync(retired, { recursive: true, force: true });
  return true;
};

const reclaimStaleLock = (lockDir, staleMs) => {
  let stat;
  try { stat = fs.lstatSync(lockDir); } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw lockError('GIGABRAIN_NATIVE_LOCK_TYPE', lockDir);
  const owner = readOwner(lockDir);
  if (ownerIsLive(owner)) return false;
  const createdAt = Number(owner?.created_at_ms || stat.mtimeMs || 0);
  if ((Date.now() - createdAt) < staleMs) return false;
  const token = String(owner?.token || 'unknown');
  if (token === 'unknown') {
    const secondStat = fs.lstatSync(lockDir);
    if (!sameInode(stat, secondStat)) return false;
    const retired = `${lockDir}.stale-${crypto.randomUUID()}`;
    fs.renameSync(lockDir, retired);
    fs.rmSync(retired, { recursive: true, force: true });
    return true;
  }
  return retireLockGeneration({ lockDir, stat, token }, 'stale');
};

const tryAcquireNativeLock = ({ lockDir, staleMs }) => {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(lockDir), 0o700); } catch { /* best-effort */ }
  try {
    const existing = fs.lstatSync(lockDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw lockError('GIGABRAIN_NATIVE_LOCK_TYPE', lockDir);
    if (reclaimStaleLock(lockDir, staleMs)) return null;
    return null;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error?.code?.startsWith?.('GIGABRAIN_')) throw error;
      if (existsSyncSafe(lockDir)) return null;
      throw error;
    }
  }
  const token = crypto.randomUUID();
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  const stat = fs.lstatSync(lockDir);
  const owner = {
    token,
    pid: process.pid,
    process_start: processStartIdentity(process.pid),
    created_at_ms: Date.now(),
    created_at: new Date().toISOString(),
    owner: `node:${path.basename(process.argv[1] || 'gigabrain')}`,
    host: os.hostname(),
  };
  try {
    fs.writeFileSync(path.join(lockDir, OWNER_FILE_NAME), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    try { retireLockGeneration({ lockDir, stat, token }, 'failed'); } catch { /* preserve original */ }
    throw error;
  }
  return { lockDir, owner, stat, token };
};

const existsSyncSafe = (target) => {
  try { fs.lstatSync(target); return true; } catch { return false; }
};

const blockingDelay = (ms) => {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, Math.max(1, ms));
};

const acquireNativeLockSync = (options) => {
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const handle = tryAcquireNativeLock(options);
    if (handle) return handle;
    if (Date.now() >= deadline) throw lockError('GIGABRAIN_NATIVE_LOCK_TIMEOUT', options.lockDir);
    blockingDelay(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
  }
};

const acquireNativeLockAsync = async (options) => {
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const handle = tryAcquireNativeLock(options);
    if (handle) return handle;
    if (Date.now() >= deadline) throw lockError('GIGABRAIN_NATIVE_LOCK_TIMEOUT', options.lockDir);
    await new Promise((resolve) => setTimeout(resolve, Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now()))));
  }
};

const runWithAcquiredLock = (handle, fn) => {
  let result;
  try {
    result = nativeLockContext.run(
      Object.freeze({ lockDir: handle.lockDir, token: handle.token }),
      fn,
    );
  } catch (error) {
    retireLockGeneration(handle, 'release');
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).finally(() => retireLockGeneration(handle, 'release'));
  }
  retireLockGeneration(handle, 'release');
  return result;
};

const withNativeMemoryLock = async (config, fn) => {
  if (typeof fn !== 'function') throw new TypeError('withNativeMemoryLock requires a callback');
  const options = resolveNativeLockOptions(config);
  if (nativeLockContext.getStore()?.lockDir === options.lockDir) return fn();
  const immediate = tryAcquireNativeLock(options);
  if (immediate) return runWithAcquiredLock(immediate, fn);
  const handle = await acquireNativeLockAsync(options);
  return runWithAcquiredLock(handle, fn);
};

const withNativeMemoryLockSync = (config, fn) => {
  if (typeof fn !== 'function') throw new TypeError('withNativeMemoryLockSync requires a callback');
  const options = resolveNativeLockOptions(config);
  if (nativeLockContext.getStore()?.lockDir === options.lockDir) return fn();
  const handle = acquireNativeLockSync(options);
  return runWithAcquiredLock(handle, fn);
};

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const resolveRealPath = (filePath) => {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
};

const validateFilePath = (filePath, allowedRoot) => {
  if (!filePath || typeof filePath !== 'string') return false;
  if (!allowedRoot || typeof allowedRoot !== 'string') return false;
  if (filePath.length > MAX_PATH_LENGTH) return false;
  // Block path traversal attempts
  if (filePath.includes('..')) return false;
  if (filePath.includes('\0')) return false;

  // Resolve to absolute path and ensure it's within allowed root
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(allowedRoot);

  // Check that resolved path starts with resolved root
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  // Symlink containment. The target file is often NOT created yet (memory writes
  // append to a new daily-note / MEMORY.md), so realpath(target) would throw and
  // the old code skipped the symlink check entirely — letting a dangling symlink
  // planted at the target path redirect the write outside the root. Two guards:
  //   (a) confine the nearest EXISTING ancestor directory (always resolvable), and
  //   (b) if the target itself is a symlink (even a dangling one), resolve its
  //       link destination manually and confine that — fs.writeFileSync follows
  //       the final symlink hop, which realpathSync(parent) does not catch.
  const realRoot = resolveRealPath(resolvedRoot);
  if (!realRoot) return false; // root must exist and be resolvable

  // (b) reject a symlinked target whose destination escapes the root
  let lst = null;
  try { lst = fs.lstatSync(resolved); } catch { lst = null; }
  if (lst && lst.isSymbolicLink()) {
    let linkDest = '';
    try { linkDest = fs.readlinkSync(resolved); } catch { return false; }
    const resolvedLink = path.isAbsolute(linkDest)
      ? path.resolve(linkDest)
      : path.resolve(path.dirname(resolved), linkDest);
    const linkRelative = path.relative(realRoot, resolvedLink);
    if (linkRelative.startsWith('..') || path.isAbsolute(linkRelative)) {
      return false;
    }
  }

  // (a) confine the nearest existing ancestor directory
  let probe = resolved;
  let realProbe = resolveRealPath(probe);
  while (!realProbe) {
    const parent = path.dirname(probe);
    if (parent === probe) break; // reached filesystem root without resolving
    probe = parent;
    realProbe = resolveRealPath(probe);
  }
  if (realProbe) {
    const realRelative = path.relative(realRoot, realProbe);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      return false;
    }
  }

  return true;
};

const stripScopeComment = (value = '') => {
  const raw = String(value || '');
  const parsed = parseNativeMetadata(raw);
  const legacyScope = String(raw.match(LEGACY_SCOPE_COMMENT_RE)?.[1] || '').trim();
  return {
    scope: parsed.scope || legacyScope,
    type: parsed.type,
    originKind: parsed.originKind,
    text: stripNativeMetadata(raw).trim(),
  };
};

const appendNativeMetadata = (value = '', { scope = '', type = 'CONTEXT', originKind = '' } = {}) => {
  const text = String(value || '').trim();
  const normalizedScope = String(scope || '').trim() || 'profile:main';
  const marker = originKind ? `${renderNativeOriginMarker(originKind)} ` : '';
  return `${text} ${marker}${renderNativeMetadata({ scope: normalizedScope, type })}`;
};

const normalizeCheckpointSurface = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'codex';
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'openclaw' || normalized === 'agent') {
    return normalized;
  }
  return 'agent';
};

const checkpointSurfaceLabel = (surface = '') => {
  switch (normalizeCheckpointSurface(surface)) {
    case 'claude':
      return 'Claude';
    case 'openclaw':
      return 'OpenClaw';
    case 'agent':
      return 'Agent';
    case 'codex':
    default:
      return 'Codex App';
  }
};

const checkpointSectionTitlesForSurface = (surface = '') => {
  const label = checkpointSurfaceLabel(surface);
  return {
    summary: `${label} Sessions`,
    ...CHECKPOINT_BASE_SECTION_TITLES,
  };
};

const headingForType = (type, durable) => {
  const normalizedType = String(type || '').trim().toUpperCase() || 'CONTEXT';
  if (!durable && (normalizedType === 'USER_FACT' || normalizedType === 'PREFERENCE')) return 'Remembered Today';
  return HEADING_BY_TYPE[normalizedType] || (durable ? 'Durable Notes' : 'Session Notes');
};

const normalizeBulletContent = (line) => {
  const match = String(line || '').match(BULLET_RE);
  const parsed = stripScopeComment(match?.[1] || '');
  const { scope, text } = parsed;
  const raw = String(text || '').replace(MEMORY_LINK_RE, '').trim();
  return {
    normalized: normalizeContent(raw),
    scope,
    type: parsed.type,
    originKind: parsed.originKind,
  };
};

const findExistingBulletLine = (lines, content, scope = '') => {
  const target = normalizeContent(content);
  const targetScope = String(scope || '').trim();
  if (!target) return 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!BULLET_RE.test(String(lines[index] || ''))) continue;
    const existing = normalizeBulletContent(lines[index]);
    if (existing.normalized === target && existing.scope === targetScope) return index + 1;
  }
  return 0;
};

const appendSectionAndBullet = ({ filePath, title, sectionHeading, bulletLine, content, scope = '' }, allowedRoot = '') => {
  // Validate filePath to prevent path traversal
  const memoryRoot = allowedRoot || process.env.GIGABRAIN_MEMORY_ROOT || '/tmp/gigabrain';
  if (!validateFilePath(filePath, memoryRoot)) {
    throw new Error('Invalid file path: path traversal detected');
  }

  ensureDir(path.dirname(filePath));
  // Use atomic read to avoid TOCTOU race condition
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    existing = '';
  }
  const lines = existing ? existing.replace(/\r/g, '').split('\n') : [];
  const existingLine = findExistingBulletLine(lines, content, scope);
  if (existingLine > 0) {
    return {
      written: false,
      line: existingLine,
    };
  }

  const appended = [];
  if (lines.length === 0) {
    appended.push(`# ${title}`, '', `## ${sectionHeading}`, '', bulletLine, '');
  } else {
    if (String(lines[lines.length - 1] || '').trim() !== '') appended.push('');
    const lastSectionHeading = [...lines].reverse().find((line) => /^#{1,2}\s+/.test(String(line || '').trim()));
    if (String(lastSectionHeading || '').trim() !== `## ${sectionHeading}`) {
      appended.push(`## ${sectionHeading}`, '');
    }
    appended.push(bulletLine, '');
  }

  const startLine = lines.length + 1;
  const lineNumber = startLine + appended.findIndex((line) => line === bulletLine);
  const merged = [...lines, ...appended].join('\n').replace(/\n{3,}$/g, '\n\n');
  // Rewrites the full native file through the shared exclusive, fsync-before-
  // rename writer. Concurrent writers remain last-writer-wins.
  atomicWriteFileSync(
    filePath,
    `${merged.endsWith('\n') ? merged : `${merged}\n`}`,
    { mode: 0o600 },
  );
  return {
    written: true,
    line: lineNumber,
  };
};

const normalizeCheckpointItems = (items = []) => {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = String(item || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = normalizeContent(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
};

const prefixCheckpointItem = (prefix, value) => `${prefix}: ${String(value || '').trim()}`;

const appendCheckpointSections = ({
  filePath,
  title,
  sections = [],
  scope = '',
  allowedRoot = '',
} = {}) => {
  const memoryRoot = allowedRoot || process.env.GIGABRAIN_MEMORY_ROOT || '/tmp/gigabrain';
  if (!validateFilePath(filePath, memoryRoot)) {
    throw new Error('Invalid file path: path traversal detected');
  }
  ensureDir(path.dirname(filePath));
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lines = existing ? existing.replace(/\r/g, '').split('\n') : [];
  const seen = new Set();
  for (const line of lines) {
    if (!BULLET_RE.test(String(line || ''))) continue;
    const item = normalizeBulletContent(line);
    if (item.normalized) seen.add(`${item.scope}\u0000${item.normalized}`);
  }

  const pending = [];
  for (const [sectionHeading, entries, memoryType = 'CONTEXT'] of sections) {
    const bullets = [];
    for (const entry of entries || []) {
      const text = String(entry || '').trim();
      const key = `${String(scope || '').trim()}\u0000${normalizeContent(text)}`;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      bullets.push(`- ${appendNativeMetadata(text, {
        scope,
        type: memoryType,
        originKind: 'structured_checkpoint',
      })}`);
    }
    if (bullets.length > 0) pending.push([sectionHeading, bullets, memoryType]);
  }
  if (pending.length === 0) {
    return {
      written: false,
      source_line: null,
      written_sections: [],
      item_count: 0,
    };
  }

  const appended = [];
  if (lines.length === 0) appended.push(`# ${title}`, '');
  else if (String(lines[lines.length - 1] || '').trim() !== '') appended.push('');
  let firstBulletOffset = null;
  for (const [sectionHeading, bullets] of pending) {
    appended.push(`## ${sectionHeading}`, '');
    for (const bullet of bullets) {
      appended.push(bullet);
      if (firstBulletOffset === null) firstBulletOffset = appended.length - 1;
    }
    appended.push('');
  }
  const merged = [...lines, ...appended].join('\n').replace(/\n{3,}$/g, '\n\n');
  atomicWriteFileSync(
    filePath,
    `${merged.endsWith('\n') ? merged : `${merged}\n`}`,
    { mode: 0o600 },
  );
  return {
    written: true,
    source_line: firstBulletOffset === null ? null : lines.length + firstBulletOffset + 1,
    written_sections: pending.map(([sectionHeading]) => sectionHeading),
    item_count: pending.reduce((count, [, bullets]) => count + bullets.length, 0),
  };
};

const writeNativeSessionCheckpoint = ({
  config,
  timestamp = new Date().toISOString(),
  surface = '',
  sessionLabel = '',
  summary = '',
  decisions = [],
  openLoops = [],
  touchedFiles = [],
  durableCandidates = [],
  scope = '',
  policyOperation = 'native.checkpoint',
} = {}) => {
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: policyOperation });
  return withNativeMemoryLockSync(config, () => {
    const dateKey = String(timestamp).slice(0, 10) || new Date().toISOString().slice(0, 10);
    const memoryRoot = String(config?.runtime?.paths?.memoryRoot || '').trim();
    if (!memoryRoot) throw new Error('memoryRoot is required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('Invalid date format for checkpoint filename');
    const filePath = path.join(memoryRoot, `${dateKey}.md`);
    const surfaceLabel = checkpointSurfaceLabel(surface);
    const sectionTitles = checkpointSectionTitlesForSurface(surface);
    const normalizedSummary = String(summary || '').replace(/\s+/g, ' ').trim();
    const normalizedLabel = String(sessionLabel || '').replace(/\s+/g, ' ').trim();
    const summaryEntries = normalizedSummary
      ? [normalizedLabel ? `${surfaceLabel} session (${normalizedLabel}): ${normalizedSummary}` : `${surfaceLabel} session: ${normalizedSummary}`]
      : [];
    const sections = [
      [sectionTitles.summary, summaryEntries, 'EPISODE'],
      [sectionTitles.decisions, normalizeCheckpointItems(decisions).map((item) => prefixCheckpointItem('Decision', item)), 'DECISION'],
      [sectionTitles.open_loops, normalizeCheckpointItems(openLoops).map((item) => prefixCheckpointItem('Open loop', item)), 'CONTEXT'],
      [sectionTitles.touched_files, normalizeCheckpointItems(touchedFiles).map((item) => prefixCheckpointItem('Touched file', item)), 'CONTEXT'],
      [sectionTitles.durable_candidates, normalizeCheckpointItems(durableCandidates), 'CONTEXT'],
    ];
    const normalizedScope = String(scope || '').trim() || 'profile:main';
    const result = appendCheckpointSections({
      filePath,
      title: dateKey,
      sections,
      scope: normalizedScope,
      allowedRoot: memoryRoot,
    });
    return {
      written: result.written,
      source_path: filePath,
      source_line: result.source_line,
      source_kind: 'daily_note',
      origin_kind: 'structured_checkpoint',
      section: sectionTitles.summary,
      written_sections: result.written_sections,
      item_count: result.item_count,
    };
  });
};

const writeNativeMemoryEntry = ({
  config,
  memoryId = '',
  type = 'CONTEXT',
  content = '',
  durable = false,
  timestamp = new Date().toISOString(),
  scope = '',
  policyOperation = 'native.entry',
} = {}) => {
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: policyOperation });
  const note = String(content || '').trim();
  if (!note) {
    return {
      written: false,
      source_path: '',
      source_line: null,
      source_kind: durable ? 'memory_md' : 'daily_note',
    };
  }

  return withNativeMemoryLockSync(config, () => {
    const dateKey = String(timestamp).slice(0, 10) || new Date().toISOString().slice(0, 10);
    const memoryRoot = String(config?.runtime?.paths?.memoryRoot || '').trim();
    const memoryMdPath = String(config?.native?.memoryMdPath || '').trim();

  // Validate paths to prevent path traversal
    if (!memoryRoot) throw new Error('memoryRoot is required');
    if (durable && !memoryMdPath) throw new Error('memoryMdPath is required for durable entries');

  // Validate dateKey is a safe filename (YYYY-MM-DD format)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('Invalid date format for memory entry filename');

    const filePath = durable ? memoryMdPath : path.join(memoryRoot, `${dateKey}.md`);
  // Anchor durable writes on the workspace root (the ancestor that both MEMORY.md
  // and memoryRoot/ live under), NOT the target file's own dirname — using the
  // file's dirname made validateFilePath's containment check a tautological no-op
  // (a file always resolves within its own directory). workspaceRoot keeps the
  // legit MEMORY.md write allowed while still rejecting /etc/passwd, ../escapes, etc.
    const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || '').trim() || path.dirname(memoryRoot);
    const allowedRoot = durable ? workspaceRoot : memoryRoot;
    const sectionHeading = headingForType(type, durable);
    const bulletContent = memoryId ? `[m:${memoryId}] ${note}` : note;
    const title = durable ? 'MEMORY' : dateKey;
    const normalizedScope = String(scope || '').trim() || 'profile:main';
    const result = appendSectionAndBullet({
      filePath,
      title,
      sectionHeading,
      bulletLine: `- ${appendNativeMetadata(bulletContent, { scope: normalizedScope, type })}`,
      content: note,
      scope: normalizedScope,
    }, allowedRoot);

    return {
      written: result.written,
      source_path: filePath,
      source_line: result.line,
      source_kind: durable ? 'memory_md' : 'daily_note',
      origin_kind: 'human_native',
      memory_type: String(type || 'CONTEXT').trim().toUpperCase(),
      section: sectionHeading,
    };
  });
};

export {
  headingForType,
  processStartIdentity,
  withNativeMemoryLock,
  writeNativeMemoryEntry,
  writeNativeSessionCheckpoint,
  normalizeCheckpointSurface,
};

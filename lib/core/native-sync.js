import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { containsEntity } from './person-service.js';
import { normalizeContent } from './policy.js';
import { readRegularFileWithStatNoFollowSync } from './safe-fs.js';
import {
  classifyNativeOrigin,
  parseNativeMetadata,
  stripNativeMetadata,
} from '../compat/native-metadata.js';

const MEMORY_ID_RE = /\[m:([0-9a-f-]{8,})\]/i;
const MEMORY_ID_GLOBAL_RE = /\[m:[0-9a-f-]{8,}\]\s*/ig;
const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
const LEGACY_SCOPE_COMMENT_RE = /\s*<!--\s*gigabrain:scope=([^\s>]+)\s*-->\s*$/i;
const FALLBACK_DAILY_RE = /^\d{4}-\d{2}-\d{2}.*\.md$/i;
const INTERNAL_CONTEXT_OPEN_RE = /<gigabrain-context>/i;
const INTERNAL_CONTEXT_CLOSE_RE = /<\/gigabrain-context>/i;
const TRANSCRIPT_LINE_RE = /^(?:user|assistant|system|tool)\s*:/i;
const COMMAND_LINE_RE = /^\/[a-z0-9_-]+\b/i;
const RECALL_ARTIFACT_RE = /\b(?:entity_answer_hints:|entity_mode:|fallback:|query:\s|source:\s(?:memory|\/Users\/)|\bsrc=|new session started\b|model set to\b|internal tags|recall mechanics)\b/i;
const ENTITY_INSTRUCTION_RE = /^entity_instruction:/i;
const CONVERSATION_SUMMARY_RE = /\bconversation summary\b/i;

const sha1 = (value) => crypto.createHash('sha1').update(String(value || '')).digest('hex');

const parseLineMetadata = (value = '', { sourceKind = '', section = '' } = {}) => {
  const raw = String(value || '');
  const parsed = parseNativeMetadata(raw);
  const legacyScope = String(raw.match(LEGACY_SCOPE_COMMENT_RE)?.[1] || '').trim();
  return {
    scope: parsed.scope || legacyScope,
    type: parsed.type,
    originKind: classifyNativeOrigin({ line: raw, sourceKind, section }),
    text: stripNativeMetadata(raw).trim(),
  };
};

const inferNativeMemoryType = ({ section = '', content = '' } = {}) => {
  const upper = String(section || '').toUpperCase();
  if (upper.includes('PREFERENCE')) return 'PREFERENCE';
  if (upper.includes('DECISION')) return 'DECISION';
  if (upper.includes('AGENT IDENTITY') || upper.includes('AGENT_IDENTITY')) return 'AGENT_IDENTITY';
  if (upper.includes('USER FACT') || upper.includes('USER_FACT') || upper.includes('FACT')) return 'USER_FACT';
  if (upper.includes('ENTITY')) return 'ENTITY';
  if (upper.includes('EPISODE') || upper.endsWith(' SESSIONS')) return 'EPISODE';
  const raw = String(content || '');
  if (/\b(?:prefer|preference|likes?|dislikes?)\b/i.test(raw)) return 'PREFERENCE';
  if (/\b(?:decided|decision|always use|we will|must)\b/i.test(raw)) return 'DECISION';
  return 'CONTEXT';
};

const defaultNativeScope = (sourceKind = '') => {
  if (String(sourceKind || '') === 'curated') return 'shared';
  return 'profile:main';
};

const normalizeNativeQueryScope = (value = '') => {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase();
  if (!raw || key === 'shared' || key === 'default') return 'shared';
  return raw;
};

const toIsoDate = (value) => {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
};

const basenameDate = (filePath) => {
  const base = path.basename(String(filePath || ''));
  const match = base.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
};

const globToRegex = (pattern) => {
  const raw = String(pattern || '').replace(/\\/g, '/').trim();
  if (!raw) return /^$/;
  let escaped = raw
    .replace(/[\\.+^${}()|]/g, '\\$&')
    .replace(/\*\*/g, '__GB_GLOBSTAR__')
    .replace(/\*/g, '__GB_STAR__')
    .replace(/\?/g, '__GB_QMARK__');
  escaped = escaped
    .replace(/__GB_GLOBSTAR__/g, '.*')
    .replace(/__GB_STAR__/g, '[^/]*')
    .replace(/__GB_QMARK__/g, '.');
  escaped = escaped
    .replace(/\\\[([^\]]+)\\\]/g, '[$1]');
  return new RegExp(`^${escaped}$`, 'i');
};

const normalizeRelative = (workspaceRoot, filePath) => {
  const rel = path.relative(workspaceRoot, filePath);
  return String(rel || '').replace(/\\/g, '/');
};

const isContainedPath = (workspaceRoot, filePath, { requireFile = false } = {}) => {
  const resolvedRoot = path.resolve(String(workspaceRoot || ''));
  const resolvedPath = path.resolve(String(filePath || ''));
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  let rootReal;
  try { rootReal = fs.realpathSync(resolvedRoot); } catch { return false; }
  let lstat = null;
  try { lstat = fs.lstatSync(resolvedPath); } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  if (lstat?.isSymbolicLink()) return false;
  if (requireFile && (!lstat || !lstat.isFile())) return false;
  let probe = lstat ? resolvedPath : path.dirname(resolvedPath);
  let probeReal = null;
  while (!probeReal) {
    try { probeReal = fs.realpathSync(probe); } catch { /* find nearest existing ancestor */ }
    if (probeReal) break;
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  const realRelative = path.relative(rootReal, probeReal);
  return !realRelative.startsWith('..') && !path.isAbsolute(realRelative);
};

const includePath = (workspaceRoot, filePath, excludeGlobs = []) => {
  const rel = normalizeRelative(workspaceRoot, filePath);
  if (!rel || rel.startsWith('../')) return false;
  for (const glob of excludeGlobs) {
    const re = globToRegex(glob);
    if (re.test(rel)) return false;
  }
  return true;
};

const parseHeadingStack = (state, line) => {
  const match = String(line || '').match(HEADING_RE);
  if (!match) return;
  const level = Number(String(match[1] || '').length || 1);
  const text = String(match[2] || '').trim();
  if (!text) return;
  if (level === 1) {
    state.h1 = text;
    state.h2 = '';
    state.h3 = '';
    return;
  }
  if (level === 2) {
    state.h2 = text;
    state.h3 = '';
    return;
  }
  state.h3 = text;
};

const sectionLabel = (state = {}) => (
  [state.h1, state.h2, state.h3]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(' > ')
);

const shouldSkipNativeChunk = ({ text = '', section = '' } = {}) => {
  const raw = String(text || '').trim();
  const sectionValue = String(section || '').trim();
  if (!raw) return true;
  if (INTERNAL_CONTEXT_OPEN_RE.test(raw) || INTERNAL_CONTEXT_CLOSE_RE.test(raw)) return true;
  if (TRANSCRIPT_LINE_RE.test(raw)) return true;
  if (COMMAND_LINE_RE.test(raw)) return true;
  if (ENTITY_INSTRUCTION_RE.test(raw)) return true;
  if (RECALL_ARTIFACT_RE.test(raw)) return true;
  if (CONVERSATION_SUMMARY_RE.test(sectionValue) && raw.includes(':')) return true;
  return false;
};

const parseChunksFromText = ({
  sourcePath,
  sourceKind,
  sourceDate,
  rawText,
  maxChunkChars,
}) => {
  const lines = String(rawText || '').split(/\r?\n/);
  const chunks = [];
  const headings = { h1: '', h2: '', h3: '' };
  let inInternalContext = false;
  const pushChunk = ({
    text,
    lineStart,
    lineEnd,
    section,
    linkedMemoryId,
    scope = '',
    memoryType = '',
    originKind = 'legacy_unclassified',
  }) => {
    const content = String(text || '').trim().slice(0, maxChunkChars);
    if (!content) return;
    if (shouldSkipNativeChunk({ text: content, section })) return;
    const normalized = normalizeContent(content);
    if (!normalized) return;
    const lineKey = `${lineStart || 0}:${lineEnd || 0}`;
    const chunkId = sha1(`${sourcePath}|${lineKey}|${normalized}`);
    chunks.push({
      chunk_id: chunkId,
      source_path: sourcePath,
      source_kind: sourceKind,
      source_date: sourceDate,
      section: section || null,
      line_start: Number(lineStart || 0) || 0,
      line_end: Number(lineEnd || lineStart || 0) || 0,
      content,
      normalized,
      hash: sha1(normalized),
      scope: String(scope || '').trim() || defaultNativeScope(sourceKind),
      memory_type: String(memoryType || '').trim().toUpperCase() || inferNativeMemoryType({ section, content }),
      origin_kind: String(originKind || '').trim() || 'legacy_unclassified',
      linked_memory_id: linkedMemoryId || null,
    });
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = String(lines[idx] || '');
    if (INTERNAL_CONTEXT_OPEN_RE.test(line)) {
      inInternalContext = true;
      continue;
    }
    if (INTERNAL_CONTEXT_CLOSE_RE.test(line)) {
      inInternalContext = false;
      continue;
    }
    if (inInternalContext) continue;
    parseHeadingStack(headings, line);
    const bullet = line.match(BULLET_RE);
    if (!bullet?.[1]) continue;
    const section = sectionLabel(headings);
    const scoped = parseLineMetadata(bullet[1] || '', { sourceKind, section });
    const original = String(scoped.text || '').trim();
    if (!original) continue;
    const linkedMemoryId = original.match(MEMORY_ID_RE)?.[1] || null;
    const cleaned = original.replace(MEMORY_ID_GLOBAL_RE, '').trim();
    if (!cleaned || cleaned.length < 4) continue;
    pushChunk({
      text: cleaned,
      lineStart: idx + 1,
      lineEnd: idx + 1,
      section,
      linkedMemoryId,
      scope: scoped.scope,
      memoryType: scoped.type,
      originKind: scoped.originKind,
    });
  }

  if (chunks.length > 0) return chunks;

  let buffer = [];
  let startLine = 0;
  inInternalContext = false;
  const flush = (lineEnd) => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length >= 16) {
      pushChunk({
        text: joined,
        lineStart: startLine,
        lineEnd,
        section: sectionLabel(headings),
        linkedMemoryId: null,
        scope: defaultNativeScope(sourceKind),
        memoryType: inferNativeMemoryType({ section: sectionLabel(headings), content: joined }),
        originKind: classifyNativeOrigin({ line: joined, sourceKind, section: sectionLabel(headings) }),
      });
    }
    buffer = [];
    startLine = 0;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = String(lines[idx] || '');
    if (INTERNAL_CONTEXT_OPEN_RE.test(line)) {
      inInternalContext = true;
      flush(idx);
      continue;
    }
    if (INTERNAL_CONTEXT_CLOSE_RE.test(line)) {
      inInternalContext = false;
      continue;
    }
    if (inInternalContext) continue;
    parseHeadingStack(headings, line);
    if (!line.trim() || HEADING_RE.test(line) || shouldSkipNativeChunk({ text: line, section: sectionLabel(headings) })) {
      flush(idx);
      continue;
    }
    if (!startLine) startLine = idx + 1;
    buffer.push(line.trim());
    if (buffer.join(' ').length >= maxChunkChars) flush(idx + 1);
  }
  flush(lines.length);

  return chunks;
};

const resolveDailyNoteFiles = (workspaceRoot, config = {}) => {
  const globPattern = String(config?.native?.dailyNotesGlob || 'memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*.md').trim();
  const relativeDir = path.dirname(globPattern);
  const basenamePattern = path.basename(globPattern);
  const notesDir = path.resolve(workspaceRoot, relativeDir || 'memory');
  if (!fs.existsSync(notesDir)) return [];
  const baseRe = globToRegex(basenamePattern || FALLBACK_DAILY_RE.source);
  return fs.readdirSync(notesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => baseRe.test(name) || FALLBACK_DAILY_RE.test(name))
    .map((name) => path.join(notesDir, name))
    .sort();
};

const resolveNativeSourcePaths = (config = {}) => {
  const workspaceRoot = path.resolve(String(config?.runtime?.paths?.workspaceRoot || process.cwd()));
  const resolveWorkspacePath = (value, fallback = '') => path.resolve(workspaceRoot, String(value || fallback));
  const memoryMdPath = resolveWorkspacePath(config?.native?.memoryMdPath, 'MEMORY.md');
  const includeFiles = Array.isArray(config?.native?.includeFiles)
    ? config.native.includeFiles.map((item) => resolveWorkspacePath(item))
    : [];
  const excludeGlobs = Array.isArray(config?.native?.excludeGlobs) ? config.native.excludeGlobs : [];

  const candidateSet = new Set();
  if (fs.existsSync(memoryMdPath)) candidateSet.add(memoryMdPath);
  for (const filePath of includeFiles) {
    if (fs.existsSync(filePath)) candidateSet.add(filePath);
  }
  for (const filePath of resolveDailyNoteFiles(workspaceRoot, config)) {
    candidateSet.add(filePath);
  }

  return Array.from(candidateSet)
    .filter((filePath) => includePath(workspaceRoot, filePath, excludeGlobs))
    .filter((filePath) => isContainedPath(workspaceRoot, filePath, { requireFile: true }))
    .map((filePath) => fs.realpathSync(filePath))
    .sort();
};

const resolveTargetedNativeSourcePaths = (config = {}, sourcePaths = []) => {
  const workspaceRoot = path.resolve(String(config?.runtime?.paths?.workspaceRoot || process.cwd()));
  const resolveWorkspacePath = (value, fallback = '') => path.resolve(workspaceRoot, String(value || fallback));
  const memoryMdPath = resolveWorkspacePath(config?.native?.memoryMdPath, 'MEMORY.md');
  const includeFiles = new Set((Array.isArray(config?.native?.includeFiles) ? config.native.includeFiles : [])
    .map((item) => resolveWorkspacePath(item)));
  const excludeGlobs = Array.isArray(config?.native?.excludeGlobs) ? config.native.excludeGlobs : [];
  const dailyGlob = String(config?.native?.dailyNotesGlob || 'memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*.md');
  const dailyRegex = globToRegex(dailyGlob);
  const out = new Set();
  for (const value of sourcePaths) {
    const resolved = resolveWorkspacePath(value);
    const relative = normalizeRelative(workspaceRoot, resolved);
    const configured = resolved === memoryMdPath || includeFiles.has(resolved) || dailyRegex.test(relative);
    if (!configured || !includePath(workspaceRoot, resolved, excludeGlobs)) continue;
    if (!isContainedPath(workspaceRoot, resolved, { requireFile: false })) continue;
    let canonical = resolved;
    try {
      const lstat = fs.lstatSync(resolved);
      if (lstat.isSymbolicLink() || !lstat.isFile()) continue;
      canonical = fs.realpathSync(resolved);
    } catch (error) {
      if (error?.code !== 'ENOENT') continue;
    }
    out.add(canonical);
  }
  return [...out].sort();
};

const classifySourceKind = ({
  sourcePath,
  memoryMdPath,
  includeFiles,
}) => {
  const normalized = String(sourcePath || '');
  if (normalized === String(memoryMdPath || '')) return 'memory_md';
  if (includeFiles.includes(normalized)) return 'curated';
  return 'daily_note';
};

const ensureNativeStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_native_chunks (
      chunk_id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_date TEXT,
      section TEXT,
      line_start INTEGER,
      line_end INTEGER,
      content TEXT NOT NULL,
      normalized TEXT NOT NULL,
      hash TEXT NOT NULL,
      scope TEXT,
      memory_type TEXT,
      origin_kind TEXT NOT NULL DEFAULT 'legacy_unclassified',
      linked_memory_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_source ON memory_native_chunks(source_path, status);
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_kind ON memory_native_chunks(source_kind, status);
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_date ON memory_native_chunks(source_date, status);

    CREATE TABLE IF NOT EXISTS memory_native_sync_state (
      source_path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      hash TEXT NOT NULL,
      last_synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_native_sync_state_synced ON memory_native_sync_state(last_synced_at);
  `);
  const nativeColumns = db.prepare('PRAGMA table_info(memory_native_chunks)').all();
  if (!nativeColumns.some((row) => String(row.name || '') === 'scope')) {
    db.exec('ALTER TABLE memory_native_chunks ADD COLUMN scope TEXT');
  }
  if (!nativeColumns.some((row) => String(row.name || '') === 'linked_memory_id')) {
    db.exec('ALTER TABLE memory_native_chunks ADD COLUMN linked_memory_id TEXT');
  }
  if (!nativeColumns.some((row) => String(row.name || '') === 'memory_type')) {
    db.exec('ALTER TABLE memory_native_chunks ADD COLUMN memory_type TEXT');
  }
  if (!nativeColumns.some((row) => String(row.name || '') === 'origin_kind')) {
    db.exec("ALTER TABLE memory_native_chunks ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'legacy_unclassified'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_scope ON memory_native_chunks(scope, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_linked ON memory_native_chunks(linked_memory_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_origin_status ON memory_native_chunks(origin_kind, status)');
};

const syncNativeMemory = ({
  db,
  config,
  sourcePaths = [],
  dryRun = false,
} = {}) => {
  ensureNativeStore(db);
  const workspaceRoot = path.resolve(String(config?.runtime?.paths?.workspaceRoot || process.cwd()));
  const nowIso = new Date().toISOString();
  const maxChunkChars = Math.max(120, Number(config?.native?.maxChunkChars || 900) || 900);
  const memoryMdPath = path.resolve(workspaceRoot, String(config?.native?.memoryMdPath || 'MEMORY.md'));
  const includeFiles = Array.isArray(config?.native?.includeFiles)
    ? config.native.includeFiles.map((item) => path.resolve(workspaceRoot, String(item)))
    : [];
  const targeted = Array.isArray(sourcePaths) && sourcePaths.some((item) => String(item || '').trim());
  const candidatePaths = targeted
    ? resolveTargetedNativeSourcePaths(config, sourcePaths)
    : resolveNativeSourcePaths(config);

  const existingStateRows = db.prepare(`
    SELECT source_path, mtime_ms, size_bytes, hash
    FROM memory_native_sync_state
  `).all();
  const existingState = new Map(existingStateRows.map((row) => [String(row.source_path), row]));

  const summary = {
    scanned_files: candidatePaths.length,
    changed_files: 0,
    changed_sources: [],
    skipped_unchanged: 0,
    inserted_chunks: 0,
    linked_chunks: 0,
    removed_sources: 0,
    active_sources: candidatePaths,
  };

  const insertChunk = db.prepare(`
    INSERT INTO memory_native_chunks (
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, hash, scope, memory_type, origin_kind, linked_memory_id,
      first_seen_at, last_seen_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      source_path = excluded.source_path,
      source_kind = excluded.source_kind,
      source_date = excluded.source_date,
      section = excluded.section,
      line_start = excluded.line_start,
      line_end = excluded.line_end,
      content = excluded.content,
      normalized = excluded.normalized,
      hash = excluded.hash,
      scope = excluded.scope,
      memory_type = excluded.memory_type,
      origin_kind = excluded.origin_kind,
      last_seen_at = excluded.last_seen_at,
      status = 'active'
  `);
  const upsertState = db.prepare(`
    INSERT INTO memory_native_sync_state (source_path, mtime_ms, size_bytes, hash, last_synced_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      hash = excluded.hash,
      last_synced_at = excluded.last_synced_at
  `);
  const markInactiveForSource = db.prepare(`
    UPDATE memory_native_chunks
    SET status = 'inactive', last_seen_at = ?
    WHERE source_path = ? AND status = 'active'
  `);
  const deleteState = db.prepare('DELETE FROM memory_native_sync_state WHERE source_path = ?');

  const runInTx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  runInTx(() => {
    for (const sourcePath of candidatePaths) {
      let snapshot;
      try {
        snapshot = readRegularFileWithStatNoFollowSync(sourcePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
          const knownChunks = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_native_chunks WHERE source_path = ?').get(sourcePath)?.n || 0);
          if (existingState.has(sourcePath) || knownChunks > 0) {
            summary.removed_sources += 1;
            summary.changed_sources.push(sourcePath);
            if (!dryRun) {
              markInactiveForSource.run(nowIso, sourcePath);
              deleteState.run(sourcePath);
            }
          }
          continue;
        }
        throw error;
      }
      const { stat, data: raw } = snapshot;
      const fileHash = sha1(raw);
      const known = existingState.get(sourcePath);
      const unchanged = known
        && Number(known.mtime_ms) === Number(stat.mtimeMs)
        && Number(known.size_bytes) === Number(stat.size)
        && String(known.hash || '') === String(fileHash);
      if (unchanged) {
        summary.skipped_unchanged += 1;
        continue;
      }
      summary.changed_files += 1;
      summary.changed_sources.push(sourcePath);
      const sourceKind = classifySourceKind({
        sourcePath,
        memoryMdPath,
        includeFiles,
      });
      const sourceDate = basenameDate(sourcePath) || toIsoDate(stat.mtime.toISOString());
      const parsed = parseChunksFromText({
        sourcePath,
        sourceKind,
        sourceDate,
        rawText: raw,
        maxChunkChars,
      });
      if (!dryRun) {
        markInactiveForSource.run(nowIso, sourcePath);
        for (const chunk of parsed) {
          if (chunk.linked_memory_id) summary.linked_chunks += 1;
          insertChunk.run(
            chunk.chunk_id,
            chunk.source_path,
            chunk.source_kind,
            chunk.source_date,
            chunk.section,
            chunk.line_start,
            chunk.line_end,
            chunk.content,
            chunk.normalized,
            chunk.hash,
            chunk.scope,
            chunk.memory_type,
            chunk.origin_kind,
            chunk.linked_memory_id,
            nowIso,
            nowIso,
            'active',
          );
          summary.inserted_chunks += 1;
        }
        upsertState.run(sourcePath, Number(stat.mtimeMs), Number(stat.size), fileHash, nowIso);
      } else {
        summary.inserted_chunks += parsed.length;
        summary.linked_chunks += parsed.filter((chunk) => Boolean(chunk.linked_memory_id)).length;
      }
    }

    if (!targeted) {
      const activeSet = new Set(candidatePaths);
      for (const row of existingStateRows) {
        const sourcePath = String(row.source_path || '');
        if (!sourcePath || activeSet.has(sourcePath)) continue;
        summary.removed_sources += 1;
        summary.changed_sources.push(sourcePath);
        if (!dryRun) {
          markInactiveForSource.run(nowIso, sourcePath);
          deleteState.run(sourcePath);
        }
      }
    }
  });

  summary.changed_sources = [...new Set(summary.changed_sources)].sort();

  return summary;
};

const classifyNativeOrigins = ({ db, dryRun = false } = {}) => {
  ensureNativeStore(db);
  const rows = db.prepare(`
    SELECT chunk_id, source_path, source_kind, section, line_start, content,
           normalized, hash, scope, memory_type, origin_kind, status
    FROM memory_native_chunks
    ORDER BY chunk_id
  `).all();
  const lineCache = new Map();
  const sourceLine = (row) => {
    const sourcePath = String(row.source_path || '');
    if (!lineCache.has(sourcePath)) {
      let lines = [];
      try {
        lines = String(readRegularFileWithStatNoFollowSync(sourcePath, 'utf8').data || '')
          .replace(/\r/g, '')
          .split('\n');
      } catch { /* missing/unreadable sources remain fail-closed */ }
      lineCache.set(sourcePath, lines);
    }
    return String(lineCache.get(sourcePath)[Math.max(0, Number(row.line_start || 1) - 1)] || '');
  };
  const update = db.prepare(`
    UPDATE memory_native_chunks
    SET scope = ?, memory_type = ?, origin_kind = ?
    WHERE chunk_id = ?
  `);
  const summary = {
    ok: true,
    dry_run: dryRun === true,
    scanned: rows.length,
    updated: 0,
    counts: {
      human_native: 0,
      structured_checkpoint: 0,
      legacy_checkpoint: 0,
      legacy_unclassified: 0,
    },
  };
  if (!dryRun) db.exec('BEGIN');
  try {
    for (const row of rows) {
      const line = sourceLine(row);
      const bullet = line.match(BULLET_RE);
      const parsed = parseLineMetadata(bullet?.[1] || line, {
        sourceKind: row.source_kind,
        section: row.section,
      });
      const previousOrigin = String(row.origin_kind || 'legacy_unclassified');
      if (previousOrigin !== 'legacy_unclassified') {
        summary.counts[Object.hasOwn(summary.counts, previousOrigin) ? previousOrigin : 'legacy_unclassified'] += 1;
        continue;
      }
      const lineContent = String(parsed.text || '').replace(MEMORY_ID_GLOBAL_RE, '').trim();
      const lineNormalized = normalizeContent(lineContent);
      const exactIdentity = String(row.status || '') === 'active'
        && lineContent === String(row.content || '').trim()
        && lineNormalized === String(row.normalized || '')
        && sha1(lineNormalized) === String(row.hash || '');
      if (!exactIdentity) {
        summary.counts.legacy_unclassified += 1;
        continue;
      }
      const originKind = parsed.originKind;
      const scope = parsed.scope
        || String(row.scope || '').trim()
        || defaultNativeScope(row.source_kind);
      const memoryType = parsed.type
        || String(row.memory_type || '').trim().toUpperCase()
        || inferNativeMemoryType({ section: row.section, content: row.content });
      summary.counts[Object.hasOwn(summary.counts, originKind) ? originKind : 'legacy_unclassified'] += 1;
      if (scope !== String(row.scope || '').trim()
        || memoryType !== String(row.memory_type || '').trim()
        || originKind !== previousOrigin) {
        summary.updated += 1;
        if (!dryRun) update.run(scope, memoryType, originKind, String(row.chunk_id));
      }
    }
    if (!dryRun) db.exec('COMMIT');
  } catch (error) {
    if (!dryRun) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    }
    throw error;
  }
  return summary;
};

const lexicalScore = (content, tokens = []) => {
  const normalized = normalizeContent(content);
  if (!normalized || tokens.length === 0) return 0;
  let hit = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (containsEntity(normalized, token, true)) hit += 1;
  }
  return hit / Math.max(1, tokens.length);
};

const queryNativeChunks = ({
  db,
  config,
  query = '',
  scope = 'shared',
  includeShared = true,
  startDate = '',
  endDate = '',
  limit = 24,
  entityKeys = [],
  ensure = true,
} = {}) => {
  if (ensure !== false) ensureNativeStore(db);
  const topK = Math.max(1, Math.min(500, Number(limit || 24) || 24));
  const normalizedQuery = normalizeContent(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean).slice(0, 10);
  const entityList = Array.isArray(entityKeys) ? entityKeys.map((item) => normalizeContent(item)).filter(Boolean) : [];
  const searchTerms = Array.from(new Set([...tokens, ...entityList]))
    .filter((term) => term.length >= 3)
    .slice(0, 12);
  const normalizedScope = normalizeNativeQueryScope(scope);
  const effectiveScopeSql = `COALESCE(CASE WHEN linked.status = 'active' THEN linked.scope END, chunk.scope, CASE
    WHEN chunk.source_kind = 'curated' THEN 'shared'
    WHEN chunk.source_kind = 'memory_md' THEN 'profile:main'
    WHEN chunk.source_kind = 'daily_note' THEN 'profile:main'
    WHEN chunk.source_kind = 'vault' THEN 'profile:user'
    ELSE ''
  END)`;
  // Conflict suppression at the recall boundary (R1): a chunk whose linked
  // memory lost an arbitration verdict (superseded) or was rejected must never
  // re-enter recall through the native leg. Unlinked chunks and dangling links
  // (linked.status IS NULL) pass through unaffected.
  const where = [
    'chunk.status = ?',
    "(linked.status IS NULL OR linked.status NOT IN ('superseded', 'rejected'))",
  ];
  const params = ['active'];
  if (normalizedScope === 'shared') {
    where.push(`${effectiveScopeSql} = ?`);
    params.push('shared');
  } else if (includeShared === false) {
    where.push(`${effectiveScopeSql} = ?`);
    params.push(normalizedScope);
  } else if (!normalizedScope.startsWith('project:') && !normalizedScope.startsWith('profile:')) {
    where.push(`(${effectiveScopeSql} = ? OR ${effectiveScopeSql} = 'shared' OR ${effectiveScopeSql} = ''${normalizedScope === 'main' ? ` OR ${effectiveScopeSql} = 'profile:main'` : ''})`);
    params.push(normalizedScope);
  } else {
    where.push(`(${effectiveScopeSql} = ? OR ${effectiveScopeSql} = 'shared')`);
    params.push(normalizedScope);
  }
  if (startDate) {
    where.push('(chunk.source_date IS NOT NULL AND chunk.source_date >= ?)');
    params.push(String(startDate));
  }
  if (endDate) {
    where.push('(chunk.source_date IS NOT NULL AND chunk.source_date <= ?)');
    params.push(String(endDate));
  }
  if (searchTerms.length > 0) {
    where.push(`(${searchTerms.map(() => '(chunk.normalized LIKE ? OR chunk.content LIKE ?)').join(' OR ')})`);
    for (const term of searchTerms) {
      const like = `%${term}%`;
      params.push(like, like);
    }
  }
  const sqlLimit = Math.max(
    searchTerms.length > 0 ? 600 : 120,
    searchTerms.length > 0 ? topK * 24 : topK * 8,
  );
  const rows = db.prepare(`
    SELECT
      chunk.chunk_id,
      chunk.source_path,
      chunk.source_kind,
      chunk.source_date,
      chunk.section,
      chunk.line_start,
      chunk.line_end,
      chunk.content,
      chunk.normalized,
      chunk.hash,
      chunk.memory_type,
      chunk.origin_kind,
      ${effectiveScopeSql} AS scope,
      chunk.linked_memory_id,
      linked.status AS linked_status,
      chunk.first_seen_at,
      chunk.last_seen_at,
      chunk.status
    FROM memory_native_chunks AS chunk
    LEFT JOIN memory_current AS linked
      ON linked.memory_id = chunk.linked_memory_id
    WHERE ${where.join(' AND ')}
    ORDER BY chunk.source_date DESC, chunk.last_seen_at DESC
    LIMIT ?
  `).all(...params, Math.min(8000, sqlLimit));

  const filtered = rows
    .map((row) => {
      const lex = lexicalScore(row.content || row.normalized || '', tokens);
      let entityHit = 0;
      if (entityList.length > 0) {
        const normalized = normalizeContent(row.content || row.normalized || '');
        for (const key of entityList) {
          if (containsEntity(normalized, key, true)) {
            entityHit += 1;
            break;
          }
        }
      }
      return {
        ...row,
        score_lexical: lex,
        score_entity: entityHit > 0 ? 1 : 0,
        score_total: lex + (entityHit > 0 ? 0.35 : 0),
      };
    })
    .filter((row) => !shouldSkipNativeChunk({ text: row.content, section: row.section }))
    .filter((row) => row.score_total > 0 || entityList.length === 0)
    .sort((a, b) => Number(b.score_total || 0) - Number(a.score_total || 0))
    .slice(0, topK);
  return filtered;
};

const renderNativeSyncMarkdown = ({ timestamp, runId, summary }) => {
  const lines = [];
  lines.push('# Native Memory Sync Report');
  lines.push('');
  lines.push(`- timestamp: ${timestamp}`);
  lines.push(`- run_id: \`${runId}\``);
  lines.push(`- scanned_files: ${Number(summary?.scanned_files || 0)}`);
  lines.push(`- changed_files: ${Number(summary?.changed_files || 0)}`);
  lines.push(`- skipped_unchanged: ${Number(summary?.skipped_unchanged || 0)}`);
  lines.push(`- inserted_chunks: ${Number(summary?.inserted_chunks || 0)}`);
  lines.push(`- linked_chunks: ${Number(summary?.linked_chunks || 0)}`);
  lines.push(`- removed_sources: ${Number(summary?.removed_sources || 0)}`);
  lines.push('');
  const sources = Array.isArray(summary?.active_sources) ? summary.active_sources : [];
  if (sources.length > 0) {
    lines.push('## Sources');
    lines.push('');
    for (const sourcePath of sources) {
      lines.push(`- ${sourcePath}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

export {
  ensureNativeStore,
  classifyNativeOrigins,
  resolveNativeSourcePaths,
  syncNativeMemory,
  queryNativeChunks,
  shouldSkipNativeChunk,
  renderNativeSyncMarkdown,
  // E1: reused by vault-sync.js — the vault corpus is chunked with the EXACT
  // same machinery as native memory (same heading/bullet parsing, same skip
  // rules, same deterministic chunk_id hashing) so a vault entry indexes
  // identically to a curated note, minus promotion/belief side effects.
  parseChunksFromText,
  globToRegex,
  sha1,
};

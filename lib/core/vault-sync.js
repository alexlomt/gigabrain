/**
 * E1 — vault-sync core.
 *
 * Ingests an Obsidian-style vault directory as a READ-ONLY reference corpus
 * into `memory_native_chunks` with `source_kind:'vault'`. It REUSES the native
 * chunker (`parseChunksFromText`) so a vault note is chunked, normalized and
 * hashed identically to a curated native note — same heading/bullet parsing,
 * same skip rules, same deterministic chunk_id — minus every write-side effect
 * that would let a vault claim influence the world model.
 *
 * R2 KEYSTONE (hard invariant, enforced here at the WRITE boundary):
 *   - vault chunks NEVER become beliefs,
 *   - vault chunks NEVER feed promoteNativeChunks,
 *   - vault chunks NEVER write memory_current.
 *   This module only ever touches memory_native_chunks / its sync-state /
 *   the isolated vault embedding table. It imports nothing from promotion,
 *   capture, projection-store or world-model, so the keystone holds by
 *   construction, not by discipline.
 *
 * SCOPE FIX (E1, write-time): queryNativeChunks' effectiveScopeSql CASE maps
 *   curated→shared and memory_md→profile:main and ELSE→'' (filtered out at the
 *   SQL layer). queryNativeChunks falls back to chunk.scope when set, so we
 *   stamp scope='profile:user' on vault rows at upsert. Recall RANKING is
 *   deliberately untouched here (that is E2) — this only makes vault rows
 *   addressable instead of silently dropped.
 *
 * iCloud-eviction-safe: an Obsidian vault in iCloud Drive holds dataless
 *   placeholders for evicted files. The reader stats + reads inside a guard
 *   that treats 0-byte placeholders, `.icloud` stubs and any read error
 *   (EIO/ENOENT/EACCES while the OS is materializing) as SKIP+count, never a
 *   throw. There is NO AbortSignal/timer anywhere on this path: a timer started
 *   before a system sleep would fire spuriously on wake, so the reader stays
 *   wall-clock-robust by simply not arming one.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseChunksFromText, globToRegex, sha1 } from './native-sync.js';
import {
  getEmbeddingSync,
  vecToBlob,
  isSafeEmbeddingBaseUrl,
  DEFAULT_OLLAMA_URL,
  DEFAULT_MODEL,
} from './embedding-service.js';
import { readRegularFileWithStatNoFollowSync } from './safe-fs.js';

// Vault rows are stamped with this scope so queryNativeChunks' chunk.scope
// fallback can surface them (see SCOPE FIX above). Distinct from 'shared' /
// 'profile:main' so vault provenance stays legible downstream.
const VAULT_SCOPE = 'profile:user';
const DEFAULT_VAULT_GLOB = '**/*.md';
const DEFAULT_MAX_FILE_KB = 512;
// Hard ceiling on directory entries walked per vault, so an accidentally huge
// or symlink-looped vault can never hang a nightly run.
const MAX_WALK_ENTRIES = 200000;

const ensureVaultStore = (db) => {
  // Reuse of the native chunk table: vault rows live alongside native chunks,
  // distinguished only by source_kind='vault' + scope='profile:user'. The
  // table is created by ensureNativeStore on the native path; recreate it
  // defensively here so vault-sync is safe to call standalone.
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
      linked_memory_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_source ON memory_native_chunks(source_path, status);
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_kind ON memory_native_chunks(source_kind, status);
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_scope ON memory_native_chunks(scope, status);

    CREATE TABLE IF NOT EXISTS memory_native_sync_state (
      source_path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      hash TEXT NOT NULL,
      last_synced_at TEXT NOT NULL
    );

    -- Isolated vault embedding store, keyed by chunk_id (NOT memory_id). This
    -- deliberately does NOT touch memory_embeddings: vault chunks have no
    -- memory_current row, so co-locating them in memory_embeddings would imply
    -- a memory that does not exist. Keeping them separate is part of the R2
    -- keystone — the dense recall leg over memory_current cannot see these.
    CREATE TABLE IF NOT EXISTS memory_native_chunk_embeddings (
      chunk_id    TEXT PRIMARY KEY,
      model       TEXT NOT NULL DEFAULT 'bge-m3',
      embedding   BLOB NOT NULL,
      dims        INTEGER NOT NULL,
      computed_at TEXT NOT NULL
    );
  `);
};

// iCloud placeholder filenames look like `.<name>.icloud` (dataless stub for an
// evicted file). Treat them as evicted regardless of read outcome.
const isICloudPlaceholderName = (filePath) => /(?:^|\/)\.[^/]+\.icloud$/i.test(String(filePath || ''));

// Map a walked path back to the source_path we track/store. An evicted file can
// surface as its `.icloud` placeholder (`dir/.foo.md.icloud`) whose underlying
// tracked source_path is `dir/foo.md`. Non-placeholder paths pass through
// unchanged. Mirrors the effective-path derivation in walkVault so an evicted
// note maps to the exact source_path recorded when it was last readable.
const vaultSourcePath = (filePath) => {
  if (!isICloudPlaceholderName(filePath)) return String(filePath);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).replace(/^\./, '').replace(/\.icloud$/i, '');
  return path.join(dir, base);
};

// True when sourcePath lives under vaultRoot (used to scope the transient-walk
// guard to a single vault's previously-tracked sources).
const isUnderVaultRoot = (sourcePath, vaultRoot) => {
  const rel = path.relative(vaultRoot, sourcePath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Bounded, eviction-safe reader. Returns { text } on success, or { evicted:true }
 * when the file is a dataless/evicted/unreadable placeholder, or { tooLarge:true }
 * when it exceeds maxFileKB. NEVER throws on eviction or I/O error.
 */
const readVaultFileSafe = (filePath, { maxFileBytes }) => {
  if (isICloudPlaceholderName(filePath)) return { evicted: true };
  let snapshot;
  try {
    snapshot = readRegularFileWithStatNoFollowSync(filePath, 'utf8', { maxBytes: maxFileBytes });
  } catch (error) {
    if (error?.code === 'EFBIG') return { tooLarge: true, stat: error.stat };
    // ENOENT/EIO while the OS materializes a dataless file: treat as evicted.
    return { evicted: true };
  }
  const { stat, data: text } = snapshot;
  if (!stat.isFile()) return { evicted: true };
  // A 0-byte file that matched a content glob is, for our purposes, a dataless
  // placeholder — nothing to index, count it as evicted rather than emitting an
  // empty (and confusing) "indexed 0 chunks" outcome.
  if (Number(stat.size) === 0) return { evicted: true };
  // Guard against a read that returned nothing usable (partial materialization).
  if (typeof text !== 'string') return { evicted: true, stat };
  return { text, stat };
};

/**
 * Recursively collect candidate files under a vault root that match `glob`
 * (matched against the vault-relative path). Skips dotfiles/dot-dirs except
 * that `.icloud` placeholders are surfaced so they can be counted as evicted.
 * Bounded by MAX_WALK_ENTRIES; never throws on an unreadable subdirectory.
 */
const walkVault = (vaultRoot, glob) => {
  const matchRe = globToRegex(glob);
  // `**/*.md` must also match a file at the vault ROOT (zero directories), but
  // globToRegex compiles `**/` to `.*/` which requires a separator. Compile a
  // second, root-friendly pattern from the trailing segment so depth-0 files
  // (e.g. `index.md`) match `**/<pat>` exactly as Obsidian/ripgrep treat them.
  const globStarMatch = String(glob || '').match(/^\*\*\/(.+)$/);
  const baseRe = globStarMatch ? globToRegex(globStarMatch[1]) : null;
  const matches = (rel) => matchRe.test(rel) || (baseRe ? baseRe.test(rel) : false);
  const out = [];
  const stack = [vaultRoot];
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= MAX_WALK_ENTRIES) break;
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip silently, stay robust
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= MAX_WALK_ENTRIES) break;
      const name = String(entry.name || '');
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        if (name.startsWith('.')) continue; // skip .git, .obsidian, etc.
        stack.push(full);
        continue;
      }
      const isPlaceholder = isICloudPlaceholderName(name);
      // Skip other dotfiles, but keep `.icloud` placeholders so the caller can
      // count them as skipped_evicted.
      if (name.startsWith('.') && !isPlaceholder) continue;
      // Match `.<name>.icloud` against the underlying name's relative path so an
      // evicted `notes/foo.md` (stored as `notes/.foo.md.icloud`) still matches
      // a `**/*.md` glob.
      const effectiveFull = isPlaceholder
        ? path.join(dir, name.replace(/^\./, '').replace(/\.icloud$/i, ''))
        : full;
      const rel = path.relative(vaultRoot, effectiveFull).replace(/\\/g, '/');
      if (!rel || rel.startsWith('../')) continue;
      if (!matches(rel)) continue;
      out.push(full);
    }
  }
  out.sort();
  return out;
};

const runInTx = (db, fn) => {
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

/**
 * Sync configured vaults[] into memory_native_chunks as source_kind='vault'.
 *
 * @param {object} params
 * @param {import('node:sqlite').DatabaseSync} params.db
 * @param {object} params.config  resolved gigabrain config
 * @param {boolean} [params.dryRun]
 * @param {boolean} [params.embed]  best-effort dense embeddings for vault chunks
 *   into the isolated vault table (default true; degrades to no-op if Ollama is
 *   unreachable). NEVER writes memory_embeddings / memory_current.
 * @param {number} [params.maxFiles]  BUDGET: hard cap on CHANGED files processed
 *   per call (across all vaults). Files beyond the budget are counted in
 *   summary.budget_deferred and left for the next run (their sync-state is not
 *   updated, so they remain "changed" and are retried). 0/undefined = unbounded.
 *   Used by the nightly path to keep vault-sync bounded; vaults:[] stays a
 *   zero-cost no-op regardless.
 * @returns {object} summary
 */
const syncVaultMemory = ({
  db,
  config,
  dryRun = false,
  embed = true,
  maxFiles = 0,
} = {}) => {
  const vaults = Array.isArray(config?.native?.vaults) ? config.native.vaults : [];
  const summary = {
    enabled: vaults.length > 0,
    vaults: vaults.length,
    scanned_files: 0,
    changed_files: 0,
    skipped_unchanged: 0,
    skipped_evicted: 0,
    skipped_too_large: 0,
    inserted_chunks: 0,
    embedded_chunks: 0,
    removed_sources: 0,
    budget_deferred: 0,
    changed_sources: [],
    active_sources: [],
  };
  const fileBudget = Number.isFinite(Number(maxFiles)) && Number(maxFiles) > 0
    ? Math.floor(Number(maxFiles))
    : Infinity;

  // vaults:[] default → silent no-op at zero cost. No store creation, no I/O.
  if (vaults.length === 0) return summary;

  ensureVaultStore(db);
  const nowIso = new Date().toISOString();
  const maxChunkChars = Math.max(120, Number(config?.native?.maxChunkChars || 900) || 900);
  const globalMaxFileKB = DEFAULT_MAX_FILE_KB;

  // Embedding wiring (best-effort, fully isolated). Reuses the recall embedding
  // endpoint config when present; otherwise the bge-m3 localhost default.
  const ollamaUrl = String(config?.recall?.ollamaUrl || DEFAULT_OLLAMA_URL);
  const embedModel = String(config?.recall?.embeddingModel || DEFAULT_MODEL);
  const embedTimeoutMs = Number(config?.recall?.embeddingTimeoutMs || 5000) || 5000;
  const embedEnabled = embed && !dryRun && isSafeEmbeddingBaseUrl(ollamaUrl);

  const existingStateRows = db.prepare(`
    SELECT source_path, mtime_ms, size_bytes, hash
    FROM memory_native_sync_state
    WHERE source_path IN (
      SELECT DISTINCT source_path FROM memory_native_chunks WHERE source_kind = 'vault'
    )
  `).all();
  const existingState = new Map(existingStateRows.map((row) => [String(row.source_path), row]));

  const insertChunk = db.prepare(`
    INSERT INTO memory_native_chunks (
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, hash, scope, linked_memory_id, first_seen_at, last_seen_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const deleteChunksForSource = db.prepare("DELETE FROM memory_native_chunks WHERE source_path = ? AND source_kind = 'vault'");
  const deleteEmbedsForSource = db.prepare(`
    DELETE FROM memory_native_chunk_embeddings
    WHERE chunk_id IN (SELECT chunk_id FROM memory_native_chunks WHERE source_path = ? AND source_kind = 'vault')
  `);
  const deleteState = db.prepare('DELETE FROM memory_native_sync_state WHERE source_path = ?');
  const upsertEmbedding = db.prepare(`
    INSERT OR REPLACE INTO memory_native_chunk_embeddings (chunk_id, model, embedding, dims, computed_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const activeSet = new Set();
  // Every source_path SURFACED by the directory walk this run — including
  // evicted placeholders and over-size files, which still EXIST in the vault.
  // The prune only removes sources absent from this set, so a transiently
  // iCloud-evicted note is never wiped from the index (superset of activeSet).
  const seenPaths = new Set();
  // Files that need their chunks (re-)inserted; collected inside the read pass
  // and applied in one transaction so a mid-walk crash can't leave half a file.
  const pending = [];

  for (const vault of vaults) {
    const vaultRoot = String(vault?.path || '').trim();
    if (!vaultRoot || !fs.existsSync(vaultRoot)) continue;
    const glob = String(vault?.glob || '').trim() || DEFAULT_VAULT_GLOB;
    const maxFileKB = Number.isFinite(Number(vault?.maxFileKB))
      ? Math.max(1, Number(vault.maxFileKB))
      : globalMaxFileKB;
    const maxFileBytes = maxFileKB * 1024;

    const files = walkVault(vaultRoot, glob);
    // iCloud safety: a walk that surfaces NOTHING for a vault we previously
    // indexed is a transient unmount / whole-vault eviction (readdir failing on
    // the root or every subdir), NOT a mass deletion. Protect this vault's
    // tracked sources from the prune rather than wiping recall in one run; they
    // re-confirm on the next walk that can actually read the tree.
    if (files.length === 0) {
      for (const row of existingStateRows) {
        const sp = String(row.source_path || '');
        if (sp && isUnderVaultRoot(sp, vaultRoot)) seenPaths.add(sp);
      }
      continue;
    }
    for (const filePath of files) {
      summary.scanned_files += 1;
      const read = readVaultFileSafe(filePath, { maxFileBytes });
      // The file was surfaced by the walk, so it still exists in the vault —
      // record it as seen (mapping an `.icloud` placeholder to its real
      // source_path) BEFORE any skip so the prune never treats a transiently
      // evicted or over-size note as deleted.
      seenPaths.add(vaultSourcePath(filePath));
      if (read.evicted) {
        summary.skipped_evicted += 1;
        continue;
      }
      if (read.tooLarge) {
        summary.skipped_too_large += 1;
        continue;
      }
      const realPath = filePath; // resolved, non-evicted source
      activeSet.add(realPath);
      const fileHash = sha1(read.text);
      const known = existingState.get(realPath);
      const unchanged = known
        && Number(known.mtime_ms) === Number(read.stat.mtimeMs)
        && Number(known.size_bytes) === Number(read.stat.size)
        && String(known.hash || '') === String(fileHash);
      if (unchanged) {
        summary.skipped_unchanged += 1;
        continue;
      }
      // BUDGET: stop processing NEW/changed files once the per-run cap is hit.
      // The file stays in activeSet (so it is never pruned) but is not synced
      // this run; its sync-state is left untouched so it is retried next run.
      if (summary.changed_files >= fileBudget) {
        summary.budget_deferred += 1;
        continue;
      }
      const sourceDate = (() => {
        try {
          return new Date(read.stat.mtime).toISOString().slice(0, 10);
        } catch {
          return null;
        }
      })();
      const parsed = parseChunksFromText({
        sourcePath: realPath,
        sourceKind: 'vault',
        sourceDate,
        rawText: read.text,
        maxChunkChars,
      });
      summary.changed_files += 1;
      summary.changed_sources.push(realPath);
      pending.push({
        sourcePath: realPath,
        stat: read.stat,
        fileHash,
        chunks: parsed,
      });
    }
  }

  summary.active_sources = Array.from(activeSet).sort();

  if (dryRun) {
    summary.inserted_chunks = pending.reduce((acc, p) => acc + p.chunks.length, 0);
    // Only sources ABSENT from the walk (truly deleted) would be pruned; a
    // transiently evicted source stays in seenPaths and survives.
    for (const row of existingStateRows) {
      const sourcePath = String(row.source_path || '');
      if (sourcePath && !seenPaths.has(sourcePath)) summary.removed_sources += 1;
    }
    return summary;
  }

  // Embeddings are computed OUTSIDE the write transaction (they make network
  // calls and must never hold a DB write lock across I/O). We buffer them, then
  // persist inside the same tx as the chunks.
  const embedBuffer = [];
  if (embedEnabled) {
    for (const item of pending) {
      for (const chunk of item.chunks) {
        const vec = getEmbeddingSync(chunk.content, {
          baseUrl: ollamaUrl,
          model: embedModel,
          timeoutMs: embedTimeoutMs,
        });
        if (!vec || vec.length === 0) continue; // graceful degradation
        embedBuffer.push({ chunkId: chunk.chunk_id, vec });
      }
    }
  }

  runInTx(db, () => {
    for (const item of pending) {
      deleteEmbedsForSource.run(item.sourcePath);
      deleteChunksForSource.run(item.sourcePath);
      for (const chunk of item.chunks) {
        insertChunk.run(
          chunk.chunk_id,
          chunk.source_path,
          'vault',
          chunk.source_date,
          chunk.section,
          chunk.line_start,
          chunk.line_end,
          chunk.content,
          chunk.normalized,
          chunk.hash,
          // SCOPE FIX (E1): write-time scope stamp so queryNativeChunks'
          // chunk.scope fallback surfaces vault rows instead of dropping them.
          VAULT_SCOPE,
          null, // linked_memory_id ALWAYS null — vault rows never link a belief
          nowIso,
          nowIso,
          'active',
        );
        summary.inserted_chunks += 1;
      }
      upsertState.run(
        item.sourcePath,
        Number(item.stat.mtimeMs),
        Number(item.stat.size),
        item.fileHash,
        nowIso,
      );
    }
    for (const e of embedBuffer) {
      upsertEmbedding.run(e.chunkId, embedModel, vecToBlob(e.vec), e.vec.length, nowIso);
      summary.embedded_chunks += 1;
    }

    // Prune sources CONFIRMED absent from the directory walk (deleted). Sources
    // still present but skipped this run — iCloud-evicted placeholders, over-size
    // files — are in seenPaths and are deliberately NOT pruned, so a transient
    // eviction never empties recall. We only ever touch previously-tracked
    // vault-owned sources.
    for (const row of existingStateRows) {
      const sourcePath = String(row.source_path || '');
      if (!sourcePath || seenPaths.has(sourcePath)) continue;
      summary.removed_sources += 1;
      deleteEmbedsForSource.run(sourcePath);
      deleteChunksForSource.run(sourcePath);
      deleteState.run(sourcePath);
    }
  });

  return summary;
};

export {
  ensureVaultStore,
  syncVaultMemory,
  readVaultFileSafe,
  walkVault,
  VAULT_SCOPE,
};

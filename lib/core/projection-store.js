import { hashNormalized, normalizeContent } from './policy.js';
import { appendEvent, ensureEventStore } from './event-store.js';

const SCOPE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;

const normalizeProjectionScope = (value = '', options = {}) => {
  const raw = String(value || '').trim();
  if (!raw) {
    if (options.allowEmpty === true) return '';
    return String(options.fallback || 'shared');
  }
  const lowered = raw.toLowerCase();
  if (lowered === 'default') return 'shared';
  if (lowered === 'shared' || lowered === 'main') return lowered;
  const segments = raw.split(':');
  if (segments.length === 1 && SCOPE_SEGMENT_RE.test(raw)) {
    return raw;
  }
  if (segments.length < 2 || !segments.every((segment) => SCOPE_SEGMENT_RE.test(String(segment || '')))) {
    throw new Error(`Invalid Gigabrain scope: ${raw}`);
  }
  return raw;
};

// Scope visibility (U14-opt fix #4): 'shared' rows are by definition
// cross-visible, so ANY non-'shared' requested scope (project:X, profile:Y,
// or a BARE agent scope like 'main') sees its own rows PLUS shared.
// Previously bare agent scopes fell through the project:/profile: prefix
// pattern-match and saw ONLY their own rows — agent=main could not retrieve
// shared rows. Requesting 'shared' stays STRICT (shared rows only): the old
// dense leg's shared-sees-everything WAS the scope leak; do not reintroduce it.
const scopeWhereForRequested = (scope, options = {}) => {
  const requested = String(scope || '').trim();
  if (!requested) return { sql: '', params: [] };
  if (requested === 'shared') return { sql: 'memory_current.scope = ?', params: ['shared'] };
  const includeShared = options.includeShared !== false;
  // Recall read-paths opt into profile visibility: on a single-user machine,
  // personal (profile:*) memories must be findable from any project. Cross-project
  // isolation is preserved: other projects' project:* rows stay excluded. Governance-grade
  // surfaces (exports, beliefs-as-of) keep exact scoping by not opting in.
  if (options.includeProfile === true && requested.startsWith('project:')) {
    const clauses = ['memory_current.scope = ?'];
    if (includeShared) clauses.push("memory_current.scope = 'shared'");
    clauses.push("memory_current.scope LIKE 'profile:%'");
    return {
      sql: `(${clauses.join(' OR ')})`,
      params: [requested],
    };
  }
  if (!includeShared) return { sql: 'memory_current.scope = ?', params: [requested] };
  return { sql: "(memory_current.scope = ? OR memory_current.scope = 'shared')", params: [requested] };
};

const rowVisibleForRequestedScope = (rowScope = '', requestedScope = '', options = {}) => {
  const requested = String(requestedScope || '').trim();
  if (!requested) return true;
  const actual = String(rowScope || '').trim();
  if (requested === 'shared') return actual === 'shared';
  if (options.includeProfile === true && requested.startsWith('project:') && actual.startsWith('profile:')) {
    return true;
  }
  return actual === requested || (options.includeShared !== false && actual === 'shared');
};

const escapeLikeValue = (value = '') => String(value || '').replace(/[\\%_]/g, '\\$&');

const hasTable = (db, tableName) => {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(String(tableName || ''));
  return Boolean(row?.name);
};

const ALLOWED_TABLE_NAMES = new Set(['memories', 'memory_current', 'memory_console_metadata', 'memory_native_chunks', 'memory_events', 'memory_entity_mentions', 'memory_quality_reviews', 'memory_native_sync_state', 'memory_claims', 'memory_source_links', 'memory_host_sync_runs']);
const hasColumn = (db, tableName, columnName) => {
  if (!hasTable(db, tableName)) return false;
  if (!ALLOWED_TABLE_NAMES.has(tableName)) {
    throw new Error(`hasColumn: invalid table '${tableName}'`);
  }
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some((col) => String(col?.name || '').toLowerCase() === String(columnName || '').toLowerCase());
};

const ensureColumn = (db, tableName, columnName, definitionSql) => {
  if (hasColumn(db, tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
};

// U18: the legacy `memories` table is deprecated (U9) and slated for a
// containment-gated physical drop. ensureLegacyMemoriesTable historically ran
// unconditionally in projection setup, which re-materialized the table on EVERY
// fresh install — defeating the drop and leaving every new DB carrying a dead
// table. The CREATE is now gated: it only fires when the table ALREADY exists
// (so existing/upgraded DBs keep their schema migrated, fully backward
// compatible) OR when an explicit opt-in (config.migration?.keepLegacyTable) is
// supplied (back-compat dual-write path / tooling that still wants it). When
// neither holds — the fresh-install case — this is a no-op and no `memories`
// table is materialized. Callers that genuinely need the table (the opt-in
// dual-write in upsertCurrentMemory, the deprecation test) pass
// { force: true }. The column-backfill loop runs only after a CREATE, so it
// never touches a DB that has no legacy table.
const ensureLegacyMemoriesTable = (db, options = {}) => {
  const force = options.force === true || options.keepLegacyTable === true;
  const alreadyPresent = hasTable(db, 'memories');
  if (!force && !alreadyPresent) {
    // Fresh install with no opt-in: do not materialize the deprecated table.
    return false;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'CONTEXT',
      content TEXT NOT NULL,
      normalized TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'capture',
      source_agent TEXT,
      source_session TEXT,
      source_message_id TEXT,
      confidence REAL DEFAULT 0.6,
      status TEXT NOT NULL DEFAULT 'active',
      scope TEXT NOT NULL DEFAULT 'shared',
      tags TEXT,
      created_at TEXT,
      updated_at TEXT,
      last_injected_at TEXT,
      last_confirmed_at TEXT,
      ttl_days INTEGER,
      pinned INTEGER DEFAULT 0,
      superseded_by TEXT,
      concept TEXT,
      content_time TEXT,
      valid_until TEXT,
      value_score REAL,
      value_label TEXT,
      review_version TEXT,
      review_reason TEXT,
      archived_at TEXT,
      last_reviewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_status_scope ON memories(status, scope);
    CREATE INDEX IF NOT EXISTS idx_memories_normalized_scope ON memories(normalized, scope);
  `);
  ensureColumn(db, 'memories', 'source', "TEXT NOT NULL DEFAULT 'capture'");
  ensureColumn(db, 'memories', 'source_agent', 'TEXT');
  ensureColumn(db, 'memories', 'source_session', 'TEXT');
  ensureColumn(db, 'memories', 'source_message_id', 'TEXT');
  ensureColumn(db, 'memories', 'confidence', 'REAL DEFAULT 0.6');
  ensureColumn(db, 'memories', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'memories', 'scope', "TEXT NOT NULL DEFAULT 'shared'");
  ensureColumn(db, 'memories', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'memories', 'created_at', 'TEXT');
  ensureColumn(db, 'memories', 'updated_at', 'TEXT');
  ensureColumn(db, 'memories', 'last_injected_at', 'TEXT');
  ensureColumn(db, 'memories', 'last_confirmed_at', 'TEXT');
  ensureColumn(db, 'memories', 'ttl_days', 'INTEGER');
  ensureColumn(db, 'memories', 'pinned', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'memories', 'concept', 'TEXT');
  ensureColumn(db, 'memories', 'value_score', 'REAL');
  ensureColumn(db, 'memories', 'value_label', 'TEXT');
  ensureColumn(db, 'memories', 'review_version', 'TEXT');
  ensureColumn(db, 'memories', 'review_reason', 'TEXT');
  ensureColumn(db, 'memories', 'archived_at', 'TEXT');
  ensureColumn(db, 'memories', 'last_reviewed_at', 'TEXT');
  ensureColumn(db, 'memories', 'superseded_by', 'TEXT');
  ensureColumn(db, 'memories', 'content_time', 'TEXT');
  ensureColumn(db, 'memories', 'valid_until', 'TEXT');
  ensureColumn(db, 'memories', 'source_layer', "TEXT NOT NULL DEFAULT 'registry'");
  ensureColumn(db, 'memories', 'source_path', 'TEXT');
  ensureColumn(db, 'memories', 'source_line', 'INTEGER');
  ensureColumn(db, 'memories', 'source_host', "TEXT NOT NULL DEFAULT 'gigabrain'");
  ensureColumn(db, 'memories', 'source_kind', "TEXT NOT NULL DEFAULT 'registry'");
  ensureColumn(db, 'memories', 'sync_policy', "TEXT NOT NULL DEFAULT 'read_only'");
  return true;
};

const ensureProjectionStore = (db, options = {}) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_current (
      memory_id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'CONTEXT',
      content TEXT NOT NULL,
      normalized TEXT NOT NULL DEFAULT '',
      normalized_hash TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'capture',
      source_agent TEXT,
      source_session TEXT,
      confidence REAL DEFAULT 0.6,
      scope TEXT NOT NULL DEFAULT 'shared',
      status TEXT NOT NULL DEFAULT 'active',
      value_score REAL,
      value_label TEXT,
      created_at TEXT,
      updated_at TEXT,
      archived_at TEXT,
      last_reviewed_at TEXT,
      tags TEXT,
      superseded_by TEXT,
      content_time TEXT,
      valid_until TEXT,
      valid_from TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_current_status_scope ON memory_current(status, scope);
    CREATE INDEX IF NOT EXISTS idx_memory_current_norm_scope ON memory_current(normalized_hash, scope, status);
  `);
  // The v0.11 compatibility release keeps the deployed legacy table as a
  // transactional rollback projection. Physical removal is forbidden until
  // the externally receipted rollback boundary closes in a later release.
  ensureLegacyMemoriesTable(db, { force: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_console_metadata (
      memory_id TEXT PRIMARY KEY,
      concept TEXT,
      source_message_id TEXT,
      last_injected_at TEXT,
      last_confirmed_at TEXT,
      ttl_days INTEGER CHECK (ttl_days IS NULL OR ttl_days >= 0),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      review_version TEXT,
      review_reason TEXT,
      FOREIGN KEY (memory_id) REFERENCES memory_current(memory_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_console_metadata_concept_pinned
      ON memory_console_metadata(concept, pinned, memory_id);
  `);
  ensureEventStore(db);
  ensureColumn(db, 'memory_current', 'source_layer', "TEXT NOT NULL DEFAULT 'registry'");
  ensureColumn(db, 'memory_current', 'source_path', 'TEXT');
  ensureColumn(db, 'memory_current', 'source_line', 'INTEGER');
  ensureColumn(db, 'memory_current', 'source_host', "TEXT NOT NULL DEFAULT 'gigabrain'");
  ensureColumn(db, 'memory_current', 'source_kind', "TEXT NOT NULL DEFAULT 'registry'");
  ensureColumn(db, 'memory_current', 'sync_policy', "TEXT NOT NULL DEFAULT 'read_only'");
  // U12 bi-temporal: valid_from opens the EVENT-time interval that valid_until
  // closes ("when was this true in the world"), while created_at + the
  // verdict/supersede events carry TRANSACTION time ("when did the store learn
  // it"). One-time migration: when the column is first added on a pre-U12 DB,
  // backfill valid_from = created_at (fallback updated_at, then now) inside a
  // savepoint so the ALTER + backfill land atomically and every existing row
  // gets a non-NULL event-time start. New writes derive it in
  // upsertCurrentMemory; idempotent because hasColumn gates the whole block.
  if (!hasColumn(db, 'memory_current', 'valid_from')) {
    db.exec('SAVEPOINT gb_u12_valid_from');
    try {
      try {
        db.exec('ALTER TABLE memory_current ADD COLUMN valid_from TEXT');
      } catch (alterErr) {
        // Concurrent double-open (MCP server + CLI): both pass the hasColumn
        // gate, the loser's ALTER hits "duplicate column name" — the column
        // existing IS success; the backfill below still runs. (A re-check
        // inside the savepoint would NOT close this window: SAVEPOINT takes
        // no write lock until its first write, which is the ALTER itself.)
        if (!/duplicate column name/i.test(String(alterErr?.message || ''))) throw alterErr;
      }
      db.prepare(`
        UPDATE memory_current
        SET valid_from = COALESCE(created_at, updated_at, ?)
        WHERE valid_from IS NULL
      `).run(new Date().toISOString());
      db.exec('RELEASE gb_u12_valid_from');
    } catch (err) {
      try { db.exec('ROLLBACK TO gb_u12_valid_from'); db.exec('RELEASE gb_u12_valid_from'); } catch { /* savepoint already gone */ }
      throw err;
    }
  }
  // NOTE (review #8, rejected on apply): an at-open self-heal stamping NULL
  // valid_from was tried and reverted — the savepoint already makes
  // ALTER+backfill atomic (no crash window), and stamping changes NULL's
  // observable recall semantics ("no event-time claim") for rows inserted
  // outside upsertCurrentMemory. The remaining downgrade path (pre-U12 binary
  // writing post-migration) is covered by COALESCE at the read boundaries.
  try { ensureFTS5(db); } catch { /* FTS5 optional */ }
};

const FTS5_TABLE = 'memory_fts';

const ensureFTS5 = (db) => {
  const hasFts = hasTable(db, FTS5_TABLE);
  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS5_TABLE} USING fts5(
        memory_id UNINDEXED,
        content,
        normalized,
        type UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    db.exec(`
      INSERT INTO ${FTS5_TABLE}(memory_id, content, normalized, type)
      SELECT memory_id, content, COALESCE(normalized, ''), type
      FROM memory_current
      WHERE status = 'active'
    `);
  }
};

const syncFTS5Row = (db, memoryId, content, normalized, type, status) => {
  const existing = db.prepare(`SELECT rowid FROM ${FTS5_TABLE} WHERE memory_id = ?`).get(memoryId);
  if (existing) {
    db.prepare(`DELETE FROM ${FTS5_TABLE} WHERE rowid = ?`).run(existing.rowid);
  }
  if (status === 'active' && content) {
    db.prepare(`INSERT INTO ${FTS5_TABLE}(memory_id, content, normalized, type) VALUES (?, ?, ?, ?)`).run(
      memoryId,
      content,
      normalized || '',
      type || 'CONTEXT',
    );
  }
};

const rebuildFTS5 = (db) => {
  try { db.exec(`DROP TABLE IF EXISTS ${FTS5_TABLE}`); } catch { /* ignore */ }
  ensureFTS5(db);
};

// EN+DE stopwords stripped at QUERY time only (never at index time, so bm25 IDF
// stays intact). Without this, common words like "was/ist/das/the/is" match nearly
// every row and let an irrelevant high-value row outrank the exact phrase match.
const FTS_STOPWORDS = new Set([
  'wer', 'ist', 'war', 'was', 'wie', 'wo', 'wann', 'warum', 'wieso', 'ueber', 'über',
  'und', 'oder', 'der', 'die', 'das', 'ein', 'eine', 'einer', 'einem', 'einen', 'den',
  'dem', 'des', 'mit', 'von', 'zu', 'im', 'in', 'am', 'an', 'auf', 'gibt', 'gibts',
  'about', 'tell', 'me', 'who', 'is', 'the', 'a', 'an', 'and', 'or', 'to', 'for',
  'please', 'bitte', 'what', 'how', 'when', 'where', 'why', 'of', 'on', 'do', 'does',
]);

// U14 (R11): \p{L}\p{N} property classes instead of [a-z0-9äöüß] — the old
// class silently DELETED every non-Latin letter, so Cyrillic/CJK/Greek queries
// tokenized to nothing and the FTS5 leg returned zero rows. The index side
// (unicode61 remove_diacritics 2) always handled full Unicode; only the query
// tokenizer was lossy. Strictly additive for ASCII+German queries: \p{L} is a
// superset of [a-zäöüß], punctuation/underscore still map to whitespace.
const tokenizeFtsQuery = (query) => String(query || '').trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter((token) => token.length >= 2)
  .slice(0, 12);

// Build an FTS5 MATCH expression with implicit-AND (space-joined), prefix only on
// the LAST content token, and each token quote-sanitized so FTS5 operators can't
// leak. Returns '' if nothing usable remains.
const buildFtsMatch = (tokens) => {
  if (!tokens.length) return '';
  return tokens.map((t, i) => {
    const safe = `"${String(t).replace(/"/g, '""')}"`;
    return i === tokens.length - 1 ? `${safe}*` : safe;
  }).join(' ');
};

const searchFTS5 = (db, query, options = {}) => {
  const topK = Math.max(1, Math.min(100, Number(options.topK || 20) || 20));
  const allTokens = tokenizeFtsQuery(query);
  if (allTokens.length === 0) return [];
  // Drop stopwords; if everything was a stopword, fall back to the raw tokens so
  // a pure-stopword query still returns something.
  const content = allTokens.filter((t) => !FTS_STOPWORDS.has(t));
  let working = content.length > 0 ? content : allTokens;

  const runMatch = (tokens) => {
    const expr = buildFtsMatch(tokens);
    if (!expr) return null;
    try {
      const hits = db.prepare(`
        SELECT memory_id, rank, -bm25(${FTS5_TABLE}) AS bm25_score
        FROM ${FTS5_TABLE}
        WHERE ${FTS5_TABLE} MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(expr, topK);
      return hits;
    } catch {
      return null;
    }
  };

  // Implicit-AND relaxation ladder: AND of all content tokens is strict and may
  // return nothing on short multilingual queries. If empty, drop the last token
  // and retry, down to a single token — so AND never collapses to zero results.
  try {
    while (working.length > 0) {
      const hits = runMatch(working);
      if (hits && hits.length > 0) return hits;
      if (working.length === 1) break;
      working = working.slice(0, -1);
    }
    return [];
  } catch {
    return [];
  }
};

const toIso = (value, fallback = new Date().toISOString()) => {
  if (!value) return fallback;
  const text = String(value);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return fallback;
  return new Date(parsed).toISOString();
};

const canonicalStatus = (status) => {
  const key = String(status || '').trim().toLowerCase();
  if (['active', 'archived', 'pending', 'rejected', 'superseded'].includes(key)) return key;
  return 'active';
};

const CURRENT_ROW_FIELDS = Object.freeze([
  'memory_id', 'type', 'content', 'normalized', 'normalized_hash', 'source',
  'source_agent', 'source_session', 'source_layer', 'source_path', 'source_line',
  'source_host', 'source_kind', 'sync_policy', 'confidence', 'scope', 'status',
  'value_score', 'value_label', 'created_at', 'updated_at', 'archived_at',
  'last_reviewed_at', 'tags', 'superseded_by', 'content_time', 'valid_until',
  'valid_from',
]);
const LEGACY_CORE_FIELDS = Object.freeze([
  'type', 'content', 'normalized', 'source', 'source_agent', 'source_session',
  'source_layer', 'source_path', 'source_line', 'source_host', 'source_kind',
  'sync_policy', 'confidence', 'status', 'scope', 'tags', 'created_at',
  'updated_at', 'superseded_by', 'content_time', 'valid_until', 'value_score',
  'value_label', 'archived_at', 'last_reviewed_at',
]);
const CONSOLE_METADATA_FIELDS = Object.freeze([
  'concept', 'source_message_id', 'last_injected_at', 'last_confirmed_at',
  'ttl_days', 'pinned', 'review_version', 'review_reason',
]);
const PATCH_FIELDS = new Set([
  'archived_at', 'last_reviewed_at', 'status', 'superseded_by', 'updated_at',
  'valid_from', 'valid_until', 'value_label', 'value_score',
]);

const rawCurrentMemory = (db, memoryId) => db.prepare(
  'SELECT * FROM memory_current WHERE memory_id = ?',
).get(String(memoryId || '')) || null;

const canonicalOptionalIso = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return toIso(value, null);
};

// `content_time` may deliberately carry date precision only. Preserve an exact
// YYYY-MM-DD assertion, but canonicalize actual timestamps to one UTC `Z` form.
const canonicalContentTime = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return canonicalOptionalIso(raw);
};

const canonicalCurrentRow = (memory = {}, existing = null, now = new Date().toISOString()) => {
  const nowIso = toIso(now);
  const memoryId = String(memory.memory_id || memory.id || '').trim();
  if (!memoryId) throw new Error('memory_id is required');
  const content = String(memory.content || '').trim();
  if (!content) throw new Error('content is required');
  const normalized = normalizeContent(content);
  let contentTime = canonicalContentTime(memory.content_time);
  if (contentTime && Date.parse(contentTime) > Date.parse(nowIso)) contentTime = nowIso;
  const createdAt = existing ? (existing.created_at ?? null) : toIso(memory.created_at, nowIso);
  const explicitValidFrom = canonicalOptionalIso(memory.valid_from)
    || (contentTime ? toIso(contentTime, null) : null);
  return {
    memory_id: memoryId,
    type: String(memory.type || 'CONTEXT').trim().toUpperCase() || 'CONTEXT',
    content,
    normalized,
    normalized_hash: hashNormalized(normalized),
    source: String(memory.source || 'capture'),
    source_agent: memory.source_agent ? String(memory.source_agent) : null,
    source_session: memory.source_session ? String(memory.source_session) : null,
    source_layer: memory.source_layer ? String(memory.source_layer) : 'registry',
    source_path: memory.source_path ? String(memory.source_path) : null,
    source_line: (memory.source_line === null || memory.source_line === undefined || memory.source_line === '')
      ? null
      : (Number.isFinite(Number(memory.source_line)) ? Math.max(1, Math.trunc(Number(memory.source_line))) : null),
    source_host: memory.source_host ? String(memory.source_host) : 'gigabrain',
    source_kind: memory.source_kind ? String(memory.source_kind) : 'registry',
    sync_policy: memory.sync_policy ? String(memory.sync_policy) : 'read_only',
    confidence: Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 0.6,
    scope: normalizeProjectionScope(memory.scope || 'shared'),
    status: canonicalStatus(memory.status || 'active'),
    value_score: (memory.value_score === null || memory.value_score === undefined || memory.value_score === '')
      ? null
      : (Number.isFinite(Number(memory.value_score)) ? Number(memory.value_score) : null),
    value_label: memory.value_label ? String(memory.value_label) : null,
    created_at: createdAt,
    updated_at: toIso(memory.updated_at, nowIso),
    archived_at: canonicalOptionalIso(memory.archived_at),
    last_reviewed_at: canonicalOptionalIso(memory.last_reviewed_at),
    tags: Array.isArray(memory.tags) ? JSON.stringify(memory.tags) : (memory.tags ? String(memory.tags) : '[]'),
    superseded_by: memory.superseded_by ? String(memory.superseded_by) : null,
    content_time: contentTime,
    valid_until: canonicalOptionalIso(memory.valid_until),
    valid_from: explicitValidFrom || existing?.valid_from || createdAt || nowIso,
  };
};

const rowsEqual = (left, right, fields) => Boolean(left && right) && fields.every((field) => (
  (left[field] ?? null) === (right[field] ?? null)
));

const writeCurrentMemoryRow = (db, row) => db.prepare(`
  INSERT INTO memory_current (
    memory_id, type, content, normalized, normalized_hash, source, source_agent, source_session,
    source_layer, source_path, source_line, source_host, source_kind, sync_policy, confidence,
    scope, status, value_score, value_label, created_at, updated_at, archived_at,
    last_reviewed_at, tags, superseded_by, content_time, valid_until, valid_from
  ) VALUES (${CURRENT_ROW_FIELDS.map(() => '?').join(', ')})
  ON CONFLICT(memory_id) DO UPDATE SET
    type=excluded.type, content=excluded.content, normalized=excluded.normalized,
    normalized_hash=excluded.normalized_hash, source=excluded.source,
    source_agent=excluded.source_agent, source_session=excluded.source_session,
    source_layer=excluded.source_layer, source_path=excluded.source_path,
    source_line=excluded.source_line, source_host=excluded.source_host,
    source_kind=excluded.source_kind, sync_policy=excluded.sync_policy,
    confidence=excluded.confidence, scope=excluded.scope, status=excluded.status,
    value_score=excluded.value_score, value_label=excluded.value_label,
    updated_at=excluded.updated_at, archived_at=excluded.archived_at,
    last_reviewed_at=excluded.last_reviewed_at, tags=excluded.tags,
    superseded_by=excluded.superseded_by, content_time=excluded.content_time,
    valid_until=excluded.valid_until, valid_from=excluded.valid_from
`).run(...CURRENT_ROW_FIELDS.map((field) => row[field] ?? null));

const normalizedMetadataValue = (field, value) => {
  if (field === 'pinned') return value === true || Number(value) === 1 ? 1 : 0;
  if (field === 'ttl_days') {
    if (value === null || value === undefined || value === '') return null;
    return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : null;
  }
  if (field === 'last_injected_at' || field === 'last_confirmed_at') return canonicalOptionalIso(value);
  return value === null || value === undefined || value === '' ? null : String(value);
};

const finalConsoleMetadata = (existing, supplied = {}) => {
  const row = Object.fromEntries(CONSOLE_METADATA_FIELDS.map((field) => [field, existing?.[field] ?? (field === 'pinned' ? 0 : null)]));
  for (const field of CONSOLE_METADATA_FIELDS) {
    if (Object.hasOwn(supplied, field)) row[field] = normalizedMetadataValue(field, supplied[field]);
  }
  return row;
};

const legacyRowFor = (current, metadata) => ({
  id: current.memory_id,
  ...Object.fromEntries(LEGACY_CORE_FIELDS.map((field) => [field, current[field] ?? null])),
  ...metadata,
});

const writeLegacyMemoryRow = (db, row) => {
  const fields = ['id', ...LEGACY_CORE_FIELDS, ...CONSOLE_METADATA_FIELDS];
  const updates = fields.slice(1).map((field) => `${field}=excluded.${field}`).join(', ');
  return db.prepare(`
    INSERT INTO memories (${fields.join(', ')})
    VALUES (${fields.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${updates}
  `).run(...fields.map((field) => row[field] ?? null));
};

const writeConsoleMetadata = (db, memoryId, row) => {
  const fields = ['memory_id', ...CONSOLE_METADATA_FIELDS];
  return db.prepare(`
    INSERT INTO memory_console_metadata (${fields.join(', ')})
    VALUES (${fields.map(() => '?').join(', ')})
    ON CONFLICT(memory_id) DO UPDATE SET
      ${CONSOLE_METADATA_FIELDS.map((field) => `${field}=excluded.${field}`).join(', ')}
  `).run(String(memoryId), ...CONSOLE_METADATA_FIELDS.map((field) => row[field] ?? null));
};

const statusRowFor = (existing, status, extra, now) => canonicalCurrentRow({
  ...existing,
  archived_at: canonicalStatus(status) === 'archived' ? (extra.archived_at || now) : null,
  last_reviewed_at: extra.last_reviewed_at || now,
  status: canonicalStatus(status),
  superseded_by: extra.clear_superseded_by === true
    ? null
    : (extra.superseded_by ? String(extra.superseded_by) : existing.superseded_by),
  updated_at: extra.preserve_updated_at === true ? existing.updated_at : now,
  valid_until: extra.clear_valid_until === true ? null : existing.valid_until,
  value_label: extra.value_label ? String(extra.value_label) : existing.value_label,
  value_score: Number.isFinite(Number(extra.value_score)) ? Number(extra.value_score) : existing.value_score,
}, existing, now);

const patchedRowFor = (existing, patch = {}, now) => {
  for (const field of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(field)) throw new Error(`PROJECTION_PATCH_FIELD_INVALID:${field}`);
  }
  return canonicalCurrentRow({ ...existing, ...patch }, existing, now);
};

let projectionBatchCounter = 0;
const PROJECTION_WRITER_REGISTRY = Object.freeze([
  ['audit', 'lib/core/audit-service.js'],
  ['belief_arbitration', 'lib/core/belief-arbitration.js'],
  ['capture', 'lib/core/capture-service.js'],
  ['codex', 'lib/core/codex-service.js'],
  ['handoff_import', 'lib/core/handoff-bundle.js'],
  ['host_sync', 'lib/core/host-memory-sync.js'],
  ['maintenance', 'lib/core/maintenance-service.js'],
  ['memory_actions', 'lib/core/memory-actions.js'],
  ['native_promotion', 'lib/core/native-promotion.js'],
  ['openclaw_import', 'lib/core/openclaw-import.js'],
  ['queue_review', 'lib/compat/queue-review-service.js'],
  ['transcript_harvest', 'lib/core/transcript-harvester.js'],
  ['wiki_reconcile', 'lib/core/wiki-project.js'],
].map(([id, sourcePath]) => Object.freeze({ id, sourcePath })));
const safeOperationId = (value = '') => String(value || 'projection-mutation')
  .replace(/[^A-Za-z0-9._-]/g, '-')
  .slice(0, 128) || 'projection-mutation';

const finalizeProjectionBoundary = (db, boundary, savepoint, ok) => {
  if (boundary === 'begin_immediate') {
    db.exec(ok ? 'COMMIT' : 'ROLLBACK');
    return;
  }
  if (ok) db.exec(`RELEASE ${savepoint}`);
  else {
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
  }
};

const withProjectionMutationBatch = ({ db, operationId = '', isolation = 'immediate', now = '' } = {}, fn) => {
  if (!db || typeof fn !== 'function') throw new TypeError('withProjectionMutationBatch requires db and callback');
  if (String(isolation || 'immediate').toLowerCase() !== 'immediate') {
    throw new Error(`PROJECTION_ISOLATION_INVALID:${String(isolation || '')}`);
  }
  ensureProjectionStore(db);
  const active = db.isTransaction === true;
  const boundary = active ? 'savepoint' : 'begin_immediate';
  const savepoint = `gb_projection_${++projectionBatchCounter}`;
  if (active) db.exec(`SAVEPOINT ${savepoint}`);
  else db.exec('BEGIN IMMEDIATE');
  const tx = {
    boundary,
    db,
    events: 0,
    lastMutationEvent: null,
    mutations: 0,
    now: toIso(now || new Date().toISOString()),
    operationId: safeOperationId(operationId),
    savepoint: active ? savepoint : '',
  };
  const finish = (result, ok, error = null) => {
    try {
      finalizeProjectionBoundary(db, boundary, savepoint, ok);
    } catch (boundaryError) {
      if (error) throw error;
      throw boundaryError;
    }
    if (!ok) throw error;
    return {
      receipt: Object.freeze({
        boundary,
        events: tx.events,
        mutations: tx.mutations,
        operationId: tx.operationId,
        timestamp: tx.now,
      }),
      result,
    };
  };
  try {
    const result = fn(tx);
    if (result && typeof result.then === 'function') {
      throw new Error('PROJECTION_ASYNC_CALLBACK_FORBIDDEN');
    }
    return finish(result, true);
  } catch (error) {
    return finish(undefined, false, error);
  }
};

const mutateCurrentMemoryWithLegacyProjection = ({
  event = {},
  faultInjector,
  metadata = {},
  mutation = {},
  tx,
} = {}) => {
  if (!tx?.db || !['begin_immediate', 'savepoint'].includes(tx.boundary)) {
    throw new Error('PROJECTION_MUTATION_BATCH_REQUIRED');
  }
  const inject = (stage) => {
    if (typeof faultInjector === 'function') faultInjector(stage);
  };
  let result;
  let desired;
  let memoryId = '';
  let action = String(event.action || '').trim();
  let metadataInput = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  if (mutation.kind === 'upsert') {
    const sourceMessageId = mutation?.memory?.source_message_id;
    memoryId = String(mutation?.memory?.memory_id || mutation?.memory?.id || '').trim();
    const existing = rawCurrentMemory(tx.db, memoryId);
    desired = canonicalCurrentRow(mutation.memory, existing, tx.now);
    metadataInput = {
      ...(sourceMessageId !== undefined ? { source_message_id: sourceMessageId } : {}),
      ...metadataInput,
    };
    result = desired;
    action ||= 'projection:upsert';
  } else if (mutation.kind === 'status') {
    memoryId = String(mutation.memoryId || '');
    const existing = rawCurrentMemory(tx.db, memoryId);
    if (!existing) return 0;
    desired = statusRowFor(existing, mutation.status, mutation.extra || {}, tx.now);
    result = 1;
    action ||= 'projection:status';
  } else if (mutation.kind === 'patch') {
    memoryId = String(mutation.memoryId || '');
    const existing = rawCurrentMemory(tx.db, memoryId);
    if (!existing) throw new Error(`PROJECTION_MEMORY_NOT_FOUND:${memoryId}`);
    desired = patchedRowFor(existing, mutation.patch || {}, tx.now);
    result = desired;
    action ||= 'projection:patch';
  } else {
    throw new Error(`PROJECTION_MUTATION_KIND_INVALID:${String(mutation.kind || '')}`);
  }

  const currentBefore = rawCurrentMemory(tx.db, memoryId);
  const metadataBefore = tx.db.prepare(
    'SELECT * FROM memory_console_metadata WHERE memory_id = ?',
  ).get(memoryId) || null;
  const metadataSupplied = CONSOLE_METADATA_FIELDS.some((field) => Object.hasOwn(metadataInput, field));
  const desiredMetadata = finalConsoleMetadata(metadataBefore, metadataInput);
  const shouldWriteMetadata = Boolean(metadataBefore || metadataSupplied);
  const legacyDesired = legacyRowFor(desired, desiredMetadata);
  const legacyBefore = tx.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) || null;
  const currentChanged = !rowsEqual(currentBefore, desired, CURRENT_ROW_FIELDS);
  const legacyFields = ['id', ...LEGACY_CORE_FIELDS, ...CONSOLE_METADATA_FIELDS];
  const legacyChanged = !rowsEqual(legacyBefore, legacyDesired, legacyFields);
  const metadataChanged = shouldWriteMetadata
    && !rowsEqual(metadataBefore, { memory_id: memoryId, ...desiredMetadata }, ['memory_id', ...CONSOLE_METADATA_FIELDS]);
  if (!currentChanged && !legacyChanged && !metadataChanged) {
    tx.lastMutationEvent = null;
    return mutation.kind === 'status' ? 0 : result;
  }

  if (currentChanged) {
    writeCurrentMemoryRow(tx.db, desired);
    inject('after_current');
  }
  if (legacyChanged) {
    writeLegacyMemoryRow(tx.db, legacyDesired);
    inject('after_legacy');
  }
  if (metadataChanged) {
    writeConsoleMetadata(tx.db, memoryId, desiredMetadata);
    inject('after_metadata');
  }
  if (currentChanged && hasTable(tx.db, FTS5_TABLE)) {
    syncFTS5Row(tx.db, memoryId, desired.content, desired.normalized, desired.type, desired.status);
    inject('after_fts');
  }

  const rowEvent = appendEvent(tx.db, {
    action,
    agent_id: event.agent_id || mutation?.memory?.source_agent || null,
    cleanup_version: event.cleanup_version || 'v0.11-compat',
    component: event.component || 'projection',
    memory_id: memoryId,
    reason_codes: event.reason_codes || [mutation.kind],
    review_version: event.review_version || '',
    run_id: event.run_id || tx.operationId,
    matched_memory_id: event.matched_memory_id || null,
    similarity: Number.isFinite(Number(event.similarity)) ? Number(event.similarity) : null,
    timestamp: toIso(event.timestamp || tx.now, tx.now),
    payload: {
      ...(event.payload && typeof event.payload === 'object' ? event.payload : {}),
      operation_id: tx.operationId,
      projection_event_kind: 'row',
      projection_mutation: mutation.kind,
    },
  });
  inject('after_event');
  tx.events += 1;
  tx.mutations += 1;
  tx.lastMutationEvent = rowEvent;
  return result;
};

const executeProjectionMutation = ({ db, now, operationId, options }, mutationArgs) => {
  if (options?.tx) {
    if (options.tx.db !== db) throw new Error('PROJECTION_TRANSACTION_DB_MISMATCH');
    return mutateCurrentMemoryWithLegacyProjection({ ...mutationArgs, tx: options.tx });
  }
  return withProjectionMutationBatch({ db, now, operationId }, (tx) => (
    mutateCurrentMemoryWithLegacyProjection({ ...mutationArgs, tx })
  )).result;
};

const upsertCurrentMemory = (db, memory = {}, options = {}) => executeProjectionMutation({
  db,
  now: options.now || memory.updated_at || '',
  operationId: options.operationId || `upsert-${memory.memory_id || memory.id || 'memory'}`,
  options,
}, {
  event: options.event || { action: 'projection:upsert', component: 'projection' },
  faultInjector: options.faultInjector,
  metadata: options.metadata || {},
  mutation: { kind: 'upsert', memory },
});

const updateCurrentStatus = (db, memoryId, status, extra = {}, options = {}) => executeProjectionMutation({
  db,
  now: options.now || extra.timestamp || '',
  operationId: options.operationId || `status-${memoryId}`,
  options,
}, {
  event: options.event || { action: 'projection:status', component: 'projection' },
  faultInjector: options.faultInjector,
  metadata: options.metadata || {},
  mutation: { extra, kind: 'status', memoryId, status },
});

const appendProjectionOperationSummary = ({ tx, event = {}, faultInjector } = {}) => {
  const summary = appendEvent(tx.db, {
    ...event,
    timestamp: toIso(event.timestamp || tx.now, tx.now),
    payload: {
      ...(event.payload && typeof event.payload === 'object' ? event.payload : {}),
      operation_id: tx.operationId,
      projection_event_kind: 'operation_summary',
    },
  });
  if (typeof faultInjector === 'function') faultInjector('after_event');
  tx.events += 1;
  return summary;
};

const getCurrentMemory = (db, memoryId, options = {}) => {
  if (options.ensure !== false) ensureProjectionStore(db);
  if (!hasTable(db, 'memory_current')) return null;
  const hasClaims = hasTable(db, 'memory_claims');
  const row = db.prepare(`
    SELECT
      memory_current.memory_id, memory_current.type, memory_current.content, memory_current.normalized, memory_current.normalized_hash, memory_current.source, memory_current.source_agent, memory_current.source_session,
      memory_current.source_layer, memory_current.source_path, memory_current.source_line, memory_current.source_host, memory_current.source_kind, memory_current.sync_policy, memory_current.confidence, memory_current.scope, memory_current.status, memory_current.value_score, memory_current.value_label,
      memory_current.created_at, memory_current.updated_at, memory_current.archived_at, memory_current.last_reviewed_at, memory_current.tags, memory_current.superseded_by, memory_current.content_time, memory_current.valid_until, memory_current.valid_from
      ${hasClaims ? `,
      c.memory_tier,
      c.claim_slot,
      c.consolidation_op,
      c.source_strength,
      c.surface_candidate,
      c.updated_at AS claim_updated_at` : ''}
    FROM memory_current
    ${hasClaims ? 'LEFT JOIN memory_claims c ON c.memory_id = memory_current.memory_id' : ''}
    WHERE memory_current.memory_id = ?
    LIMIT 1
  `).get(String(memoryId || ''));
  if (!row) return null;
  return {
    ...row,
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.6,
    value_score: Number.isFinite(Number(row.value_score)) ? Number(row.value_score) : null,
    tags: (() => {
      try { return JSON.parse(String(row.tags || '[]')); } catch { return []; }
    })(),
  };
};

const listCurrentMemories = (db, options = {}) => {
  if (options.ensure !== false) ensureProjectionStore(db);
  if (!hasTable(db, 'memory_current')) return [];
  const hasClaims = hasTable(db, 'memory_claims');
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((item) => canonicalStatus(item))
    : [];
  const scope = normalizeProjectionScope(options.scope || '', { allowEmpty: true });
  const memoryTiers = Array.isArray(options.memoryTiers)
    ? options.memoryTiers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const limit = Math.max(1, Math.min(10000, Number(options.limit || 1000) || 1000));
  const where = [];
  const params = [];
  if (statuses.length > 0) {
    where.push(`memory_current.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (scope) {
    const scopeWhere = scopeWhereForRequested(scope, {
      includeProfile: options.includeProfile !== false,
      includeShared: options.includeShared !== false,
    });
    where.push(scopeWhere.sql);
    params.push(...scopeWhere.params);
  }
  if (hasClaims && memoryTiers.length > 0) {
    where.push(`c.memory_tier IN (${memoryTiers.map(() => '?').join(',')})`);
    params.push(...memoryTiers);
  }
  const sql = `
    SELECT
      memory_current.memory_id, memory_current.type, memory_current.content, memory_current.normalized, memory_current.normalized_hash, memory_current.source, memory_current.source_agent, memory_current.source_session,
      memory_current.source_layer, memory_current.source_path, memory_current.source_line, memory_current.source_host, memory_current.source_kind, memory_current.sync_policy, memory_current.confidence, memory_current.scope, memory_current.status, memory_current.value_score, memory_current.value_label,
      memory_current.created_at, memory_current.updated_at, memory_current.archived_at, memory_current.last_reviewed_at, memory_current.tags, memory_current.superseded_by, memory_current.content_time, memory_current.valid_until, memory_current.valid_from
      ${hasClaims ? `,
      c.memory_tier,
      c.claim_slot,
      c.consolidation_op,
      c.source_strength,
      c.surface_candidate,
      c.updated_at AS claim_updated_at` : ''}
    FROM memory_current
    ${hasClaims ? 'LEFT JOIN memory_claims c ON c.memory_id = memory_current.memory_id' : ''}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(memory_current.content_time, memory_current.valid_from, memory_current.created_at) DESC
    LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params);
};

const lexicalScore = (text, tokens) => {
  const normalized = normalizeContent(text);
  const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasToken = (token) => {
    if (!token) return false;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(token)}([^\\p{L}\\p{N}_]|$)`, 'iu');
    return re.test(normalized);
  };
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (hasToken(token)) score += 1;
  }
  return score;
};

const searchCurrentMemories = (db, options = {}) => {
  if (options.ensure !== false) ensureProjectionStore(db);
  if (!hasTable(db, 'memory_current')) return [];
  const hasClaims = hasTable(db, 'memory_claims');
  const query = String(options.query || '').trim();
  if (!query) return [];
  const topK = Math.max(1, Math.min(100, Number(options.topK || 8) || 8));
  const scope = normalizeProjectionScope(options.scope || '', { allowEmpty: true });
  const memoryTiers = Array.isArray(options.memoryTiers)
    ? options.memoryTiers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((status) => canonicalStatus(status))
    : ['active'];
  const tokens = normalizeContent(query).split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return [];

  const where = [];
  const params = [];
  if (statuses.length > 0) {
    where.push(`memory_current.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (scope) {
    const scopeWhere = scopeWhereForRequested(scope, {
      includeProfile: options.includeProfile !== false,
      includeShared: options.includeShared !== false,
    });
    where.push(scopeWhere.sql);
    params.push(...scopeWhere.params);
  }
  if (hasClaims && memoryTiers.length > 0) {
    where.push(`c.memory_tier IN (${memoryTiers.map(() => '?').join(',')})`);
    params.push(...memoryTiers);
  }
  where.push(`(${tokens.map(() => "(memory_current.content LIKE ? ESCAPE '\\' OR memory_current.normalized LIKE ? ESCAPE '\\')").join(' OR ')})`);
  for (const token of tokens) {
    const like = `%${escapeLikeValue(token)}%`;
    params.push(like, like);
  }

  const sql = `
    SELECT
      memory_current.memory_id, memory_current.type, memory_current.content, memory_current.normalized, memory_current.confidence, memory_current.scope, memory_current.status,
      memory_current.value_score, memory_current.value_label, memory_current.created_at, memory_current.updated_at, memory_current.archived_at,
      memory_current.content_time, memory_current.valid_until, memory_current.valid_from,
      memory_current.source_agent, memory_current.source_layer, memory_current.source_host
      ${hasClaims ? `,
      c.memory_tier,
      c.claim_slot,
      c.consolidation_op,
      c.source_strength,
      c.surface_candidate,
      c.updated_at AS claim_updated_at` : ''}
    FROM memory_current
    ${hasClaims ? 'LEFT JOIN memory_claims c ON c.memory_id = memory_current.memory_id' : ''}
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(memory_current.value_score, memory_current.confidence, 0) DESC, memory_current.updated_at DESC
    LIMIT ?
  `;
  params.push(Math.max(20, topK * 10));
  const rows = db.prepare(sql).all(...params);

  // Real corpus-weighted FTS5 bm25() relevance per memory_id, normalized to [0,1]
  // across this query's hits. This becomes the primary lexical-relevance signal
  // (see _fts_bm25 below + recall-service rankActiveRow/rankNativeRow), replacing
  // the dead constant-IDF bm25ScoreForRow. A small rank-based boost is kept for
  // back-compat with the supplementary FTS-only fetch path.
  const ftsBoost = new Map();
  const ftsBm25 = new Map();
  try {
    const ftsHits = searchFTS5(db, query, { topK: Math.max(20, topK * 3) });
    let maxScore = 0;
    for (const hit of ftsHits) {
      const sc = Number(hit.bm25_score);
      if (Number.isFinite(sc) && sc > maxScore) maxScore = sc;
    }
    for (let index = 0; index < ftsHits.length; index += 1) {
      const hit = ftsHits[index];
      const bonus = Math.max(0, 1 - (index / Math.max(ftsHits.length, 1))) * 0.25;
      ftsBoost.set(hit.memory_id, bonus);
      const sc = Number(hit.bm25_score);
      ftsBm25.set(hit.memory_id, maxScore > 0 && Number.isFinite(sc) ? Math.max(0, sc) / maxScore : 0);
    }
  } catch {
    // FTS5 is optional in some SQLite builds.
  }

  const scored = rows.map((row) => {
    const scoreLexical = lexicalScore(row.content || row.normalized || '', tokens);
    const valueScore = Number.isFinite(Number(row.value_score)) ? Number(row.value_score) : 0;
    const confidence = Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0;
    const fts5Bm25 = ftsBm25.get(row.memory_id) || 0;
    const fts5Bonus = ftsBoost.get(row.memory_id) || 0;
    // Corpus-weighted FTS5 bm25() is the PRIMARY relevance signal and must dominate
    // ordering; the substring lexicalScore is only a fallback when FTS5 produced no
    // score, and value_score/confidence are tie-breakers (not the primary sort key
    // the old `ORDER BY value_score` made them). This is what makes the exact-phrase
    // match outrank a high-value tangential row.
    const lexicalRelevance = fts5Bm25 > 0
      ? fts5Bm25
      : (scoreLexical / Math.max(tokens.length, 1)) * 0.4;
    const total = lexicalRelevance
      + valueScore * 0.12
      + confidence * 0.06
      + fts5Bonus * 0.2;
    return {
      ...row,
      score_lexical: scoreLexical,
      score_total: total,
      _fts_bm25: fts5Bm25,
    };
  });

  const lexicalIds = new Set(scored.filter((row) => row.score_lexical > 0).map((row) => row.memory_id));
  for (const [memoryId, bonus] of ftsBoost) {
    if (lexicalIds.has(memoryId)) continue;
    try {
      const ftsRow = db.prepare(`
        SELECT
          memory_current.memory_id,
          memory_current.type,
          memory_current.content,
          memory_current.normalized,
          memory_current.confidence,
          memory_current.scope,
          memory_current.status,
          memory_current.value_score,
          memory_current.value_label,
          memory_current.created_at,
          memory_current.updated_at,
          memory_current.archived_at,
          memory_current.content_time,
          memory_current.valid_until,
          memory_current.valid_from
          ${hasClaims ? `,
          c.memory_tier,
          c.claim_slot,
          c.consolidation_op,
          c.source_strength,
          c.surface_candidate,
          c.updated_at AS claim_updated_at` : ''}
        FROM memory_current
        ${hasClaims ? 'LEFT JOIN memory_claims c ON c.memory_id = memory_current.memory_id' : ''}
        WHERE memory_current.memory_id = ?
        LIMIT 1
      `).get(memoryId);
      if (ftsRow) {
        if (statuses.length > 0 && !statuses.includes(canonicalStatus(ftsRow.status))) continue;
        if (scope && !rowVisibleForRequestedScope(ftsRow.scope, scope, {
          includeProfile: options.includeProfile !== false,
          includeShared: options.includeShared !== false,
        })) continue;
        if (hasClaims && memoryTiers.length > 0 && !memoryTiers.includes(String(ftsRow.memory_tier || '').trim())) continue;
        scored.push({
          ...ftsRow,
          score_lexical: 0,
          score_total: bonus,
          _fts_bm25: ftsBm25.get(memoryId) || 0,
        });
      }
    } catch {
      // Ignore malformed FTS rows and keep the lexical results.
    }
  }

  return scored
    .filter((row) => Number(row.score_lexical || 0) > 0 || ftsBoost.has(row.memory_id))
    .sort((a, b) => {
      // Primary: corpus-weighted FTS5 bm25 relevance (a true exact/phrase match
      // leads); tie-break on the blended score_total (value/confidence/substring).
      const fb = Number(b._fts_bm25 || 0) - Number(a._fts_bm25 || 0);
      if (Math.abs(fb) > 1e-9) return fb;
      return Number(b.score_total || 0) - Number(a.score_total || 0);
    })
    .slice(0, topK);
};

// U9: reverse-migration backfill ONLY. Reads the legacy `memories` table and
// materializes it into memory_current. This is intentionally the single
// remaining reader of `memories`, and it is a guarded one-time path: callers
// (openPreparedDb) invoke it solely when memory_current is empty, i.e. when
// opening a legacy DB that predates the projection store. It is NOT part of
// normal operation. It must be retained (not no-op'd) so upgrades from
// legacy-only DBs do not lose data; removing it would be a data-loss
// regression. When memory_current already has rows, this never runs.
const materializeProjectionFromMemories = (db) => {
  ensureProjectionStore(db);
  if (!hasTable(db, 'memories')) return { imported: 0 };

  const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map((col) => String(col.name || '').toLowerCase()));
  const col = (name, fallbackSql) => (columns.has(name) ? name : `${fallbackSql} AS ${name}`);
  const rows = db.prepare(`
    SELECT
      ${col('id', "''")},
      ${col('type', "'CONTEXT'")},
      ${col('content', "''")},
      ${col('normalized', "LOWER(TRIM(content))")},
      ${col('source', "'capture'")},
      ${col('source_agent', "''")},
      ${col('source_session', "''")},
      ${col('source_layer', "'registry'")},
      ${col('source_path', 'NULL')},
      ${col('source_line', 'NULL')},
      ${col('source_host', "'gigabrain'")},
      ${col('source_kind', "'registry'")},
      ${col('sync_policy', "'read_only'")},
      ${col('confidence', '0.6')},
      ${col('scope', "'shared'")},
      ${col('status', "'active'")},
      ${col('value_score', 'NULL')},
      ${col('value_label', 'NULL')},
      ${col('created_at', 'NULL')},
      ${col('updated_at', 'NULL')},
      ${col('archived_at', 'NULL')},
      ${col('last_reviewed_at', 'NULL')},
      ${col('tags', "'[]'")},
      ${col('superseded_by', 'NULL')},
      ${col('content_time', 'NULL')},
      ${col('valid_until', 'NULL')}
    FROM memories
    ORDER BY ${columns.has('updated_at') ? 'updated_at' : columns.has('created_at') ? 'created_at' : 'id'} ASC
  `).all();

  let imported = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      upsertCurrentMemory(db, {
        memory_id: row.id,
        type: row.type,
        content: row.content,
        normalized: row.normalized,
        source: row.source,
        source_agent: row.source_agent,
        source_session: row.source_session,
        source_layer: row.source_layer,
        source_path: row.source_path,
        source_line: row.source_line,
        source_host: row.source_host,
        source_kind: row.source_kind,
        sync_policy: row.sync_policy,
        confidence: row.confidence,
        scope: row.scope,
        status: row.status,
        value_score: row.value_score,
        value_label: row.value_label,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at,
        last_reviewed_at: row.last_reviewed_at,
        tags: row.tags,
        superseded_by: row.superseded_by,
        content_time: row.content_time,
        valid_until: row.valid_until,
      }, { syncLegacy: false });
      imported += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { imported };
};

// U18 containment check: is every legacy `memories` row represented in the
// authoritative memory_current projection? An ORPHAN is a legacy row whose `id`
// has NO matching memory_current.memory_id — dropping the legacy table while
// orphans exist would silently lose those facts. The physical drop must be
// REFUSED while orphanCount > 0. When the legacy table is absent (fresh install
// post-drop) containment is trivially clean (nothing to contain). Returns the
// counts plus a bounded sample of orphan ids/content for the operator report.
const checkLegacyContainment = (db) => {
  if (!hasTable(db, 'memories')) {
    return { tablePresent: false, containedCount: 0, orphanCount: 0, orphans: [] };
  }
  ensureProjectionStore(db);
  const containedRow = db.prepare(`
    SELECT COUNT(*) AS c
    FROM memories m
    WHERE EXISTS (SELECT 1 FROM memory_current mc WHERE mc.memory_id = m.id)
  `).get();
  const orphanRow = db.prepare(`
    SELECT COUNT(*) AS c
    FROM memories m
    WHERE NOT EXISTS (SELECT 1 FROM memory_current mc WHERE mc.memory_id = m.id)
  `).get();
  const orphans = db.prepare(`
    SELECT m.id, m.content, m.status, m.scope
    FROM memories m
    WHERE NOT EXISTS (SELECT 1 FROM memory_current mc WHERE mc.memory_id = m.id)
    ORDER BY m.id ASC
    LIMIT 50
  `).all().map((row) => ({
    id: String(row.id || ''),
    content: String(row.content || '').slice(0, 200),
    status: String(row.status || ''),
    scope: String(row.scope || ''),
  }));
  return {
    tablePresent: true,
    containedCount: Number(containedRow?.c || 0),
    orphanCount: Number(orphanRow?.c || 0),
    orphans,
  };
};

// U18 containment-gated physical drop of the deprecated `memories` table.
// Refuses unless containment passes (no orphan legacy rows). When `snapshot` is
// a path, a `VACUUM INTO` snapshot of the WHOLE DB is written BEFORE the DROP so
// the operation is recoverable; the DROP then runs and EXACTLY ONE ledger event
// (action 'migrate:legacy_drop') is appended via the same appendEvent API used
// by every other migration/arbitration record. The whole thing rides one
// SAVEPOINT so a failed DROP leaves no half-recorded ledger entry. A no-op when
// the table is already absent (returns dropped:false, idempotent).
const dropLegacyMemoriesTable = () => {
  const error = new Error('LEGACY_DROP_BLOCKED_COMPAT: legacy projection is required during the rollback window');
  error.code = 'LEGACY_DROP_BLOCKED_COMPAT';
  throw error;
};

const tableStats = (db, options = {}) => {
  if (options.ensure !== false) ensureProjectionStore(db);
  if (!hasTable(db, 'memory_current')) return { status: {}, total: 0 };
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM memory_current
    GROUP BY status
  `).all();
  const status = {};
  for (const row of rows) {
    status[String(row.status || 'unknown')] = Number(row.count || 0);
  }
  return {
    status,
    total: Object.values(status).reduce((sum, value) => sum + Number(value || 0), 0),
  };
};

// Arbitration ledger entry point (R1/R2). Records a judgment ABOUT rival facts
// on the append-only event log and drives supersession on the losers. No new
// table: the verdict rides `action` + `reason_codes` + `payload` + `agent_id`,
// and losers are marked via the existing `superseded_by`/`status='superseded'`
// machinery (updateCurrentStatus). The store never keeps a rival copy.
const recordVerdict = (db, { winnerId, loserIds = [], signals = {}, agentId = null, reason } = {}, options = {}) => {
  ensureProjectionStore(db);
  const winner = String(winnerId || '').trim();
  if (!winner) throw new Error('recordVerdict requires winnerId');
  const losers = [...new Set((Array.isArray(loserIds) ? loserIds : [loserIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  const agent = agentId ? String(agentId) : null;
  const nowIso = toIso(options.timestamp || new Date().toISOString());
  const reasonCodes = reason === undefined || reason === null ? [] : reason;
  const run = (tx) => {
    if (losers.includes(winner)) {
      throw new Error(`recordVerdict winner ${winner} cannot also be a loser`);
    }
    const winnerRow = rawCurrentMemory(db, winner);
    if (!winnerRow) {
      throw new Error(`recordVerdict winner ${winner} does not exist in memory_current`);
    }
    const verdictPayload = {
      winnerId: winner,
      loserIds: losers,
      signals: signals && typeof signals === 'object' ? signals : {},
    };
    let verdictEvent = null;
    let reinstateEvent = null;
    if (String(winnerRow.status || '').toLowerCase() === 'superseded') {
      const previouslySupersededBy = winnerRow.superseded_by ? String(winnerRow.superseded_by) : null;
      const previousValidUntil = winnerRow.valid_until ? String(winnerRow.valid_until) : null;
      const priorSupersede = db.prepare(`
        SELECT event_id FROM memory_events
        WHERE action = 'arbiter:supersede' AND memory_id = ?
        ORDER BY timestamp DESC, rowid DESC
        LIMIT 1
      `).get(winner);
      verdictEvent = appendProjectionOperationSummary({
        tx,
        faultInjector: options.faultInjector,
        event: {
          component: 'arbiter',
          action: 'arbiter:verdict',
          reason_codes: reasonCodes,
          memory_id: winner,
          agent_id: agent,
          timestamp: nowIso,
          payload: verdictPayload,
        },
      });
      mutateCurrentMemoryWithLegacyProjection({
        tx,
        faultInjector: options.faultInjector,
        mutation: {
          kind: 'patch',
          memoryId: winner,
          patch: {
            archived_at: null,
            last_reviewed_at: nowIso,
            status: 'active',
            superseded_by: null,
            updated_at: nowIso,
            valid_from: nowIso,
            valid_until: null,
          },
        },
        event: {
          component: 'arbiter',
          action: 'arbiter:reinstate',
          reason_codes: reasonCodes,
          memory_id: winner,
          matched_memory_id: previouslySupersededBy,
          agent_id: agent,
          timestamp: nowIso,
          payload: {
            winnerId: winner,
            previously_superseded_by: previouslySupersededBy,
            previous_valid_until: previousValidUntil,
            prior_supersede_event_id: priorSupersede?.event_id || null,
            verdict_event_id: verdictEvent.event_id,
          },
        },
      });
      reinstateEvent = tx.lastMutationEvent;
    } else {
      const winnerUntil = winnerRow.valid_until && winnerRow.valid_until <= nowIso ? null : winnerRow.valid_until;
      mutateCurrentMemoryWithLegacyProjection({
        tx,
        faultInjector: options.faultInjector,
        mutation: {
          kind: 'patch',
          memoryId: winner,
          patch: { valid_from: nowIso, valid_until: winnerUntil },
        },
        event: {
          component: 'arbiter',
          action: 'arbiter:verdict',
          reason_codes: reasonCodes,
          memory_id: winner,
          agent_id: agent,
          timestamp: nowIso,
          payload: verdictPayload,
        },
      });
      verdictEvent = tx.lastMutationEvent;
    }

    const supersedeEvents = [];
    for (const loserId of losers) {
      const loser = rawCurrentMemory(db, loserId);
      if (!loser) continue;
      const validUntil = loser.valid_until && loser.valid_until <= nowIso ? loser.valid_until : nowIso;
      mutateCurrentMemoryWithLegacyProjection({
        tx,
        faultInjector: options.faultInjector,
        mutation: {
          kind: 'patch',
          memoryId: loserId,
          patch: {
            archived_at: null,
            last_reviewed_at: nowIso,
            status: 'superseded',
            superseded_by: winner,
            updated_at: nowIso,
            valid_until: validUntil,
          },
        },
        event: {
          component: 'arbiter',
          action: 'arbiter:supersede',
          reason_codes: reasonCodes,
          memory_id: loserId,
          matched_memory_id: winner,
          agent_id: agent,
          timestamp: nowIso,
          payload: { winnerId: winner, loserId },
        },
      });
      if (tx.lastMutationEvent) supersedeEvents.push(tx.lastMutationEvent);
    }
    return { verdictEvent, reinstateEvent, supersedeEvents };
  };

  if (options.tx) {
    if (options.tx.db !== db) throw new Error('PROJECTION_TRANSACTION_DB_MISMATCH');
    return run(options.tx);
  }
  return withProjectionMutationBatch({
    db,
    now: nowIso,
    operationId: options.operationId || `verdict-${winner}`,
  }, run).result;
};

// Write-time state adjudication ledger (R8b/U11). The capture decision pass
// emits one KEEP/STALE/REPLACE/UNKNOWN verdict per retrieved neighbor; every
// verdict is appended to memory_events (action 'capture_state_adjudication',
// memory_id = the adjudicated neighbor) — KEEP no-ops included — so the ledger
// can answer "when did we learn X was stale" from the events alone.
const ADJUDICATION_ACTION = 'capture_state_adjudication';
const ADJUDICATION_STATE_SET = new Set(['KEEP', 'STALE', 'REPLACE', 'UNKNOWN']);

const recordAdjudication = (db, {
  memoryId,
  state,
  candidateContent = '',
  decisionOp = '',
  confidence = null,
  reason = '',
  scope = '',
  agentId = null,
  runId = '',
  reviewVersion = '',
  cleanupVersion = '',
} = {}, options = {}) => {
  ensureProjectionStore(db);
  const id = String(memoryId || '').trim();
  if (!id) throw new Error('recordAdjudication requires memoryId');
  const stateKey = String(state || '').trim().toUpperCase();
  if (!ADJUDICATION_STATE_SET.has(stateKey)) {
    throw new Error(`recordAdjudication invalid state: ${state}`);
  }
  return appendEvent(db, {
    component: 'capture',
    action: ADJUDICATION_ACTION,
    reason_codes: ['state_adjudication', `adjudication_${stateKey.toLowerCase()}`],
    memory_id: id,
    agent_id: agentId ? String(agentId) : null,
    timestamp: toIso(options.timestamp || new Date().toISOString()),
    run_id: runId || '',
    review_version: reviewVersion || '',
    cleanup_version: cleanupVersion || '',
    payload: {
      state: stateKey,
      decision_op: String(decisionOp || '').trim().toUpperCase(),
      candidate_content: String(candidateContent || ''),
      confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
      reason: String(reason || '').slice(0, 240),
      scope: String(scope || ''),
    },
  });
};

// Ledger query for adjudications: "when did we learn X was stale" =
// listAdjudications(db, { memoryId: X, states: ['STALE'] })[0].timestamp.
const listAdjudications = (db, options = {}) => {
  if (!hasTable(db, 'memory_events')) return [];
  const memoryId = String(options.memoryId || '').trim();
  const states = (Array.isArray(options.states) ? options.states : [])
    .map((item) => String(item || '').trim().toUpperCase())
    .filter((item) => ADJUDICATION_STATE_SET.has(item));
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 100) || 100));
  const where = ['action = ?'];
  const params = [ADJUDICATION_ACTION];
  if (memoryId) {
    where.push('memory_id = ?');
    params.push(memoryId);
  }
  const rows = db.prepare(`
    SELECT event_id, timestamp, memory_id, agent_id, run_id, reason_codes, payload
    FROM memory_events
    WHERE ${where.join(' AND ')}
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ?
  `).all(...params, limit);
  const parsed = rows.map((row) => {
    let payload = {};
    try { payload = JSON.parse(String(row.payload || '{}')) || {}; } catch { payload = {}; }
    return { ...row, payload, state: String(payload.state || '').toUpperCase() };
  });
  return states.length > 0 ? parsed.filter((row) => states.includes(row.state)) : parsed;
};

// U12 event-time snapshot: "what was believed true at time T", for winners AND
// losers. Interval semantics: valid_from <= T AND (valid_until IS NULL OR
// valid_until > T) — half-open [valid_from, valid_until), so at the exact flip
// instant the winner is in and the loser is out. Superseded rows are included
// by default because they WERE believed true inside their interval; pass
// options.statuses to narrow. This is an event-time query only — transaction
// time ("when did the store learn it") lives in created_at + the
// verdict/supersede/reinstate events and is NOT filtered here. valid_from is
// COALESCEd with created_at as belt-and-braces for rows that predate a
// completed U12 backfill (the migration guarantees non-NULL).
const listBeliefsAsOf = (db, options = {}) => {
  if (options.ensure !== false) ensureProjectionStore(db);
  const atMs = Date.parse(String(options.at || ''));
  if (!Number.isFinite(atMs)) throw new Error('listBeliefsAsOf requires a parseable `at` timestamp');
  const atIso = new Date(atMs).toISOString();
  const scope = normalizeProjectionScope(options.scope || '', { allowEmpty: true });
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((item) => canonicalStatus(item))
    : ['active', 'superseded'];
  const limit = Math.max(1, Math.min(10000, Number(options.limit || 1000) || 1000));
  const where = [
    'COALESCE(memory_current.valid_from, memory_current.created_at) <= ?',
    '(memory_current.valid_until IS NULL OR memory_current.valid_until > ?)',
    `memory_current.status IN (${statuses.map(() => '?').join(',')})`,
  ];
  const params = [atIso, atIso, ...statuses];
  if (scope) {
    const scopeWhere = scopeWhereForRequested(scope);
    where.push(scopeWhere.sql);
    params.push(...scopeWhere.params);
  }
  return db.prepare(`
    SELECT
      memory_current.memory_id, memory_current.type, memory_current.content, memory_current.normalized,
      memory_current.source, memory_current.confidence, memory_current.scope, memory_current.status,
      memory_current.value_score, memory_current.value_label, memory_current.created_at, memory_current.updated_at,
      memory_current.tags, memory_current.superseded_by, memory_current.content_time,
      memory_current.valid_from, memory_current.valid_until
    FROM memory_current
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(memory_current.valid_from, memory_current.created_at) DESC, memory_current.memory_id ASC
    LIMIT ?
  `).all(...params, limit);
};

export {
  hasTable,
  hasColumn,
  ensureLegacyMemoriesTable,
  checkLegacyContainment,
  dropLegacyMemoriesTable,
  ensureProjectionStore,
  PROJECTION_WRITER_REGISTRY,
  withProjectionMutationBatch,
  mutateCurrentMemoryWithLegacyProjection,
  normalizeProjectionScope,
  upsertCurrentMemory,
  updateCurrentStatus,
  recordVerdict,
  recordAdjudication,
  listAdjudications,
  listBeliefsAsOf,
  getCurrentMemory,
  listCurrentMemories,
  searchCurrentMemories,
  materializeProjectionFromMemories,
  rebuildFTS5,
  searchFTS5,
  tokenizeFtsQuery,
  rowVisibleForRequestedScope,
  scopeWhereForRequested,
  tableStats,
};

/**
 * Semantic reranking service via BGE-M3 embeddings through Ollama's
 * OpenAI-compatible API.  Designed as a reranker over BM25 lexical
 * candidates -- NOT a full-corpus cosine scan.
 *
 * Architecture (U14): lexical FTS5/BM25 candidates and a dense bge-m3 cosine
 * ranking are fused by weighted Borda count (hybridFuseRecall); dense-only
 * hits are hydrated into the pool. The legacy alpha-blend rerank was deleted
 * in U17 (zero callers since the U14 fusion default).
 *
 * Gated by config:  recall.semanticRerankEnabled  (default: true since U14)
 * Graceful fallback: if Ollama is unreachable or no embeddings are cached,
 * candidates pass through unchanged (lexical-only) — silently, no log spam,
 * matching capture's U10 jaccard-fallback convention.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { rowVisibleForRequestedScope, scopeWhereForRequested } from './projection-store.js';
import { assertConfiguredCandidateOperation } from '../compat/candidate-safety-guard.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3-embedding:4b';
const DEFAULT_DIMS = 2560;
const EMBEDDING_QUERY_INSTRUCTION = 'Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:';
const DEFAULT_TIMEOUT_MS = 5000;
const NIGHTLY_BATCH_SIZE = 50;
const DEFAULT_OLLAMA_PORT = '11434';
const DEFAULT_EMBEDDING_ENDPOINT = `http://127.0.0.1:${DEFAULT_OLLAMA_PORT}/v1/embeddings`;
const EMBEDDING_FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

const embeddingIdentityError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const normalizeLoopbackHostname = (value = '') => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1);
  return raw;
};

const isAllowedEmbeddingHost = (hostname = '') => {
  const normalized = normalizeLoopbackHostname(hostname);
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1';
};

const buildEmbeddingEndpoint = (value = '') => {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.startsWith('-')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:') return null;
    if (!isAllowedEmbeddingHost(parsed.hostname)) return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash) return null;
    if (parsed.port && parsed.port !== DEFAULT_OLLAMA_PORT) return null;
    return new URL(DEFAULT_EMBEDDING_ENDPOINT);
  } catch {
    return null;
  }
};

const isSafeEmbeddingBaseUrl = (value = '') => {
  return buildEmbeddingEndpoint(value) !== null;
};

const resolveEmbeddingIdentity = (config = {}) => {
  const recall = config?.recall && typeof config.recall === 'object' ? config.recall : config;
  const model = String(recall?.embeddingModel || recall?.model || DEFAULT_MODEL).trim();
  const dimensions = Number(recall?.embeddingDimensions ?? recall?.dimensions ?? DEFAULT_DIMS);
  const fingerprint = String(recall?.embeddingModelFingerprint || recall?.fingerprint || '').trim();
  if (model !== DEFAULT_MODEL) throw embeddingIdentityError('GIGABRAIN_EMBEDDING_IDENTITY_MODEL');
  if (!Number.isSafeInteger(dimensions) || dimensions !== DEFAULT_DIMS) {
    throw embeddingIdentityError('GIGABRAIN_EMBEDDING_IDENTITY_DIMENSIONS');
  }
  if (!EMBEDDING_FINGERPRINT_RE.test(fingerprint)) {
    throw embeddingIdentityError('GIGABRAIN_EMBEDDING_IDENTITY_FINGERPRINT');
  }
  return Object.freeze({ model, dimensions, fingerprint });
};

const resolveEmbeddingTransport = (config = {}) => {
  const recall = config?.recall && typeof config.recall === 'object' ? config.recall : config;
  const provider = String(recall?.embeddingProvider || recall?.provider || 'ollama').trim().toLowerCase();
  const baseUrl = String(recall?.embeddingBaseUrl || recall?.baseUrl || recall?.ollamaUrl || DEFAULT_OLLAMA_URL).trim();
  if (provider !== 'ollama' || !isSafeEmbeddingBaseUrl(baseUrl)) {
    throw embeddingIdentityError('GIGABRAIN_EMBEDDING_TRANSPORT_LOOPBACK_ONLY');
  }
  const parsed = new URL(baseUrl);
  return Object.freeze({ provider: 'ollama', baseUrl: parsed.origin });
};

const formatEmbeddingQuery = (query = '') => `${EMBEDDING_QUERY_INSTRUCTION}\n${String(query || '')}`;

const embeddingVectorFromValue = (value) => {
  if (value instanceof Float32Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(Number);
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    try {
      return blobToVec(value);
    } catch {
      return null;
    }
  }
  return null;
};

const isUsableEmbeddingVector = (value, dimensions) => {
  const vector = embeddingVectorFromValue(value);
  if (!Array.isArray(vector) || vector.length !== dimensions) return false;
  let nonZero = false;
  for (const item of vector) {
    if (!Number.isFinite(item)) return false;
    nonZero = nonZero || item !== 0;
  }
  return nonZero;
};

const isCompatibleEmbedding = (row = {}, identity = {}) => {
  if (!row || !identity) return false;
  return String(row.model || '').trim() === identity.model
    && Number(row.dims) === identity.dimensions
    && String(row.model_fingerprint || row.modelFingerprint || '').trim() === identity.fingerprint
    && isUsableEmbeddingVector(row.embedding, identity.dimensions);
};

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

/**
 * Fetch an embedding vector from Ollama (async, uses global fetch).
 * @param {string} text
 * @param {{ baseUrl?: string, identity?: object, model?: string, query?: boolean, timeoutMs?: number }} opts
 * @returns {Promise<number[] | null>}
 */
const getEmbedding = async (text, opts = {}) => {
  const baseUrl = opts.baseUrl || DEFAULT_OLLAMA_URL;
  const identity = opts.identity || null;
  const model = identity?.model || opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (!isSafeEmbeddingBaseUrl(baseUrl)) return null;
  const endpoint = new URL(DEFAULT_EMBEDDING_ENDPOINT);
  const input = opts.query === true ? formatEmbeddingQuery(text) : String(text || '');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const embedding = json?.data?.[0]?.embedding || null;
    if (identity && !isUsableEmbeddingVector(embedding, identity.dimensions)) return null;
    return embedding;
  } catch {
    return null;
  }
};

/**
 * Synchronous embedding fetch via curl (for recall-time hot path).
 * Falls back to null on any error so callers degrade gracefully.
 * @param {string} text
 * @param {{ baseUrl?: string, identity?: object, model?: string, query?: boolean, timeoutMs?: number }} opts
 * @returns {number[] | null}
 */
const getEmbeddingSync = (text, opts = {}) => {
  const baseUrl = opts.baseUrl || DEFAULT_OLLAMA_URL;
  const identity = opts.identity || null;
  const model = identity?.model || opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (!isSafeEmbeddingBaseUrl(baseUrl)) return null;
  const endpoint = new URL(DEFAULT_EMBEDDING_ENDPOINT);

  try {
    const body = JSON.stringify({ model, input: opts.query === true ? formatEmbeddingQuery(text) : String(text || '') });
    const result = execFileSync('curl', [
      '-s',
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-d', body,
      '--',
      endpoint.toString(),
    ], { encoding: 'utf8', timeout: timeoutMs + 2000 });
    const parsed = JSON.parse(result);
    const embedding = parsed?.data?.[0]?.embedding || null;
    if (identity && !isUsableEmbeddingVector(embedding, identity.dimensions)) return null;
    return embedding;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two equal-length numeric vectors.
 * Returns 0 on degenerate input.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
const cosineSimilarity = (a, b) => {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
};

// ---------------------------------------------------------------------------
// SQLite persistence (Float32Array <-> Buffer)
// ---------------------------------------------------------------------------

/**
 * Ensure the memory_embeddings table exists (additive migration).
 * @param {import('node:sqlite').DatabaseSync} db
 */
const ensureEmbeddingStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id   TEXT PRIMARY KEY,
      model       TEXT NOT NULL DEFAULT '${DEFAULT_MODEL}',
      embedding   BLOB NOT NULL,
      dims        INTEGER NOT NULL DEFAULT ${DEFAULT_DIMS},
      model_fingerprint TEXT,
      computed_at TEXT NOT NULL
    )
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(memory_embeddings)').all().map((row) => String(row.name || '')));
  if (!columns.has('model_fingerprint')) db.exec('ALTER TABLE memory_embeddings ADD COLUMN model_fingerprint TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_embeddings_identity ON memory_embeddings(model, dims, model_fingerprint)');
};

/**
 * Serialize a float array to a Buffer suitable for SQLite BLOB storage.
 * @param {number[]} vec
 * @returns {Buffer}
 */
const vecToBlob = (vec) => {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};

/**
 * Deserialize a Buffer/Uint8Array from SQLite back to a float array.
 * @param {Buffer | Uint8Array} buf
 * @returns {number[]}
 */
const blobToVec = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return Array.from(f32);
};

/**
 * Store an embedding for a memory in the DB.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ memoryId: string, model?: string, modelFingerprint?: string, identity?: object, embedding: number[], dims?: number }} params
 */
const storeEmbedding = (db, { memoryId, model, modelFingerprint, identity, embedding, dims }) => {
  ensureEmbeddingStore(db);
  const resolvedModel = identity?.model || model || DEFAULT_MODEL;
  const resolvedDims = Number(identity?.dimensions ?? dims ?? embedding?.length ?? 0);
  const resolvedFingerprint = identity?.fingerprint || modelFingerprint || null;
  if (identity && !isUsableEmbeddingVector(embedding, identity.dimensions)) {
    throw embeddingIdentityError('GIGABRAIN_EMBEDDING_VECTOR_INVALID');
  }
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO memory_embeddings (memory_id, model, embedding, dims, model_fingerprint, computed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    memoryId,
    resolvedModel,
    vecToBlob(embedding),
    resolvedDims,
    resolvedFingerprint,
    new Date().toISOString(),
  );
};

/**
 * Retrieve a stored embedding for a memory.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} memoryId
 * @returns {{ embedding: number[], model: string, dims: number, model_fingerprint: string | null, computed_at: string } | null}
 */
const getStoredEmbedding = (db, memoryId) => {
  const stmt = db.prepare(
    'SELECT model, embedding, dims, model_fingerprint, computed_at FROM memory_embeddings WHERE memory_id = ?',
  );
  const row = stmt.get(memoryId);
  if (!row) return null;
  return {
    embedding: blobToVec(row.embedding),
    model: row.model,
    dims: row.dims,
    model_fingerprint: row.model_fingerprint || null,
    computed_at: row.computed_at,
  };
};

// ---------------------------------------------------------------------------
// Dense retrieval + Borda-count rank aggregation (recall-time)
// ---------------------------------------------------------------------------

// U14-opt (borda-rank-aggregation): the fused ORDERING is a weighted Borda
// count over the COMMON fused pool. Each leg is a ballot that awards
// points = (poolSize - rank) / poolSize (rank 0 => 1.0); a candidate absent
// from a ballot gets HYBRID_BORDA_MISSING_LEG_POINTS. The common pool size is
// essential: per-leg normalization makes a SMALL lexical leg decay steeply
// while the corpus-wide dense leg decays shallowly, so mid-rank dense rows
// bury top lexical-only rows (incl. native chunks, which have no embeddings
// and can only ever appear on the lexical ballot). With a common scale and
// equal weights the two ballots interleave 1:1 at the head — the dynamics the
// 0.6140 raw-RRF fusion had — while Borda's LINEAR decay (vs RRF's
// hyperbolic) keeps mid-rank consensus rows separated at small k.
const HYBRID_LEXICAL_WEIGHT = 0.5;
const HYBRID_DENSE_WEIGHT = 0.5;
// Points a row receives FROM A LEG IT IS ABSENT FROM. Classic Borda is 0;
// a negative value penalizes single-leg rows, a positive one amnesties them.
const HYBRID_BORDA_MISSING_LEG_POINTS = 0;
// The fused _score channel is the Borda total scaled into the same small
// magnitude band as the pre-U14 raw-RRF scores (~0.03 max), so the
// strategy-rerank boosts in recall-service (±0.1..0.7) keep dominating ACROSS
// boost classes while the Borda consensus decides WITHIN a class — the same
// dynamics the 0.6140 raw-RRF fusion had. Strength labels never read this
// channel (they read _hybrid_strength, the leg-normalized percentile).
const HYBRID_BORDA_SCORE_SCALE = 0.04;
// U14-opt fix #2 (part 2): bounded intent-type-agreement bonus. The calibrated
// lexical scorer already encodes query-intent <-> row-type agreement
// (typeIntentBoost, +0.82/+0.9), but the fused ordering discards the
// calibrated channel — so on a preference query the only PREFERENCE row in
// scope lost to a wall of tangential entity rows that out-ranked it on BOTH
// ballots ('what are jordan's preferences': quinn-preference lex/dense
// mid-pack, fused #10). The bonus re-injects that one signal into the Borda
// total as bounded extra points: 0.15 of a ballot (tuned against the eval —
// 0.10 left the intent row exactly one slot outside top-8). Deliberately
// small: it lifts an intent-matched row PAST same-band consensus rows at the
// top-8 boundary, but can NOT carry a dense-only tail row (borda ~0.35) over
// the consensus head (~0.85+), and it never bypasses tier/liveness filters.
const HYBRID_INTENT_TYPE_BONUS = 0.15;

// Query-intent <-> row-type agreement (mirrors recall-service typeIntentBoost,
// positive arm only). querySignals arrive as a function parameter via
// options.querySignals — same threading rule as scope (U14: never via config).
const intentTypeBonus = (row, querySignals = {}) => {
  const type = String(row?.type || '').trim().toUpperCase();
  if (querySignals?.preferenceIntent === true && type === 'PREFERENCE') return HYBRID_INTENT_TYPE_BONUS;
  if (querySignals?.identityIntent === true && type === 'AGENT_IDENTITY') return HYBRID_INTENT_TYPE_BONUS;
  return 0;
};

// Common-pool Borda points: rank 0 => 1.0, decaying linearly by 1/poolSize.
const bordaPoints = (rank, poolSize) => (poolSize > 0 ? Math.max(0, poolSize - rank) / poolSize : 0);

// Cold-cache probe: the dense leg can contribute nothing without cached
// vectors, so skip it BEFORE embedding the query — saves a pointless Ollama
// round-trip per recall and keeps offline/CI runs network-free. Mirrors the
// stored-vectors-first ordering of capture's rankNeighborsByEmbedding (U10).
const hasCachedEmbeddings = (db, identity) => {
  if (!db) return false;
  try {
    const rows = db.prepare(
      'SELECT model, embedding, dims, model_fingerprint FROM memory_embeddings '
      + 'WHERE model = ? AND dims = ? AND model_fingerprint = ? LIMIT 8',
    ).all(identity.model, identity.dimensions, identity.fingerprint);
    return rows.some((row) => isCompatibleEmbedding(row, identity));
  } catch {
    return false;
  }
};

/**
 * Dense leg: rank ALL stored memory embeddings by cosine similarity to the query
 * vector. Uses cached embeddings (memory_embeddings, populated by the nightly
 * buildMissingEmbeddings); does NOT embed memories on the hot path. Scope is a
 * FUNCTION PARAMETER (U14 — no config mutation) and follows the same visibility
 * rule as the lexical leg: the predicate is pushed into SQL via
 * scopeWhereForRequested (the SQL twin of rowVisibleForRequestedScope), so only
 * in-scope embedding BLOBs are materialized — the pre-U14b version loaded EVERY
 * active row's BLOB (~40MB/recall at 10k rows) and filtered in JS. The ORDER BY
 * pins the exact iteration order of the old plan (index scan on
 * idx_memory_current_status_scope: scope ASC, then memory_current insertion
 * order) so equal-cosine ties rank identically. Returns [{ memory_id, score }]
 * sorted desc, capped at topN.
 */
const denseRankAll = (db, queryVec, {
  identity = null,
  topN = 50,
  scope = '',
  includeProfile = true,
  includeShared = true,
} = {}) => {
  if (!db || !identity || !isUsableEmbeddingVector(queryVec, identity.dimensions)) return [];
  const scopeWhere = scopeWhereForRequested(String(scope || '').trim(), {
    includeProfile,
    includeShared,
  });
  let rows;
  try {
    rows = db.prepare(
      'SELECT me.memory_id AS memory_id, me.embedding AS embedding, me.model AS model, '
      + 'me.dims AS dims, me.model_fingerprint AS model_fingerprint '
      + 'FROM memory_embeddings me JOIN memory_current ON memory_current.memory_id = me.memory_id '
      + "WHERE memory_current.status = 'active' AND me.model = ? AND me.dims = ? AND me.model_fingerprint = ?"
      + (scopeWhere.sql ? ` AND ${scopeWhere.sql}` : '')
      + ' ORDER BY memory_current.scope, memory_current.rowid',
    ).all(identity.model, identity.dimensions, identity.fingerprint, ...scopeWhere.params);
  } catch {
    return [];
  }
  const out = [];
  for (const row of rows) {
    if (!isCompatibleEmbedding(row, identity)) continue;
    const vec = blobToVec(row.embedding);
    out.push({ memory_id: row.memory_id, score: cosineSimilarity(queryVec, vec) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topN);
};

// Hydrate a dense-only hit from memory_current, carrying the liveness columns
// (valid_from/valid_until/superseded_by) and memory_tier (when memory_claims
// exists) so the post-fusion
// suppression + tier filters in recall-service apply to dense hits exactly as
// they do to lexical ones.
const hydrateDenseRow = (db, memoryId) => {
  const baseColumns = 'memory_current.memory_id, memory_current.type, memory_current.content, '
    + 'memory_current.normalized, memory_current.confidence, memory_current.scope, '
    + 'memory_current.status, memory_current.value_score, memory_current.value_label, '
    + 'memory_current.created_at, memory_current.updated_at, memory_current.content_time, '
    + 'memory_current.valid_from, memory_current.valid_until, memory_current.superseded_by';
  try {
    return db.prepare(
      `SELECT ${baseColumns}, c.memory_tier AS memory_tier `
      + 'FROM memory_current LEFT JOIN memory_claims c ON c.memory_id = memory_current.memory_id '
      + 'WHERE memory_current.memory_id = ?',
    ).get(memoryId) || null;
  } catch {
    // memory_claims may not exist on this DB — retry without the tier join.
    try {
      return db.prepare(
        `SELECT ${baseColumns} FROM memory_current WHERE memory_current.memory_id = ?`,
      ).get(memoryId) || null;
    } catch {
      return null;
    }
  }
};

/**
 * Hybrid fusion (U14-opt, borda-rank-aggregation): combine the lexical ranking
 * (the order candidates arrive in, by calibrated _score desc) with a dense
 * cosine ranking via WEIGHTED BORDA-COUNT rank aggregation.
 *
 * Contract:
 *  - Every returned row carries `_hybrid_strength` in [0,1]: the weighted Borda
 *    total, max-normalized across the fused set (leg-normalized percentile).
 *    Strength labels downstream read THIS, never the fused _score magnitude.
 *  - `_borda` is the raw weighted Borda total; `_score` becomes the fused
 *    ORDERING channel (HYBRID_BORDA_SCORE_SCALE * _borda) for every row, so
 *    the post-fusion sort and the strategy rerank both follow the Borda
 *    consensus. The pre-fusion calibrated score is preserved on lexical rows
 *    as `_lexical_score` for introspection.
 *  - Dense-only hits are hydrated WITH valid_until/superseded_by/memory_tier
 *    and marked `_source: 'dense'` — recall-service still runs them through
 *    the calibrated scorer for tier/liveness/entity metadata, but their
 *    ordering comes from the Borda channel like everyone else's.
 *  - Scope arrives as a function parameter via `options.scope` (never via
 *    config mutation) and gates both the dense ranking and the hydration.
 *  - Query signals (preference/identity intent) arrive the same way via
 *    `options.querySignals`; intent-matched row types earn the bounded
 *    HYBRID_INTENT_TYPE_BONUS on their Borda total (fix #2).
 *
 * Lexical-only passthrough (candidates returned unchanged, silently) when the
 * feature is off, no embeddings are cached, or the query embedding cannot be
 * obtained (Ollama down/offline) — CI and offline stay green and quiet.
 *
 * An EMPTY lexical candidate set does NOT skip fusion: the dense ballot still
 * runs and dense-only hits are returned (U14-opt) — cross-lingual and
 * zero-token-overlap queries are exactly where the dense leg earns its keep.
 */
const hybridFuseRecall = (candidates, query, config = {}, db = null, options = {}) => {
  const recall = config.recall || {};
  const safeCandidates = Array.isArray(candidates) ? candidates : [];
  if (!recall.semanticRerankEnabled) return safeCandidates;
  let identity;
  let transport;
  try {
    identity = resolveEmbeddingIdentity(config);
    transport = resolveEmbeddingTransport(config);
  } catch {
    return safeCandidates;
  }
  if (!hasCachedEmbeddings(db, identity)) return safeCandidates;

  const scope = String(options.scope || '').trim();
  const includeProfile = options.includeProfile !== false;
  const includeShared = options.includeShared !== false;
  const querySignals = options.querySignals && typeof options.querySignals === 'object'
    ? options.querySignals
    : {};
  const timeoutMs = recall.embeddingTimeoutMs || DEFAULT_TIMEOUT_MS;

  const queryVec = getEmbeddingSync(query, {
    baseUrl: transport.baseUrl,
    identity,
    query: true,
    timeoutMs,
  });
  if (!queryVec) return safeCandidates; // graceful degradation: keep lexical order

  // Lexical ballot: candidates are already sorted by calibrated _score desc.
  // The ballot may be EMPTY (zero lexical token overlap — e.g. cross-lingual
  // queries): fusion still runs as a dense-only election, which is the whole
  // point of the dense leg.
  const lexSorted = [...safeCandidates].sort((a, b) => Number(b._score || 0) - Number(a._score || 0));
  const lexRank = new Map();
  lexSorted.forEach((row, i) => {
    if (!lexRank.has(row.memory_id)) lexRank.set(row.memory_id, i);
  });

  // Dense ballot: cosine over cached embeddings (catches semantic /
  // cross-lingual matches the lexical leg misses), scope-filtered.
  const dense = denseRankAll(db, queryVec, {
    identity,
    topN: Math.max(50, safeCandidates.length * 2),
    scope,
    includeProfile,
    includeShared,
  });
  const denseRank = new Map();
  const semScore = new Map();
  dense.forEach((d, i) => {
    denseRank.set(d.memory_id, i);
    semScore.set(d.memory_id, d.score);
  });

  // Pull in dense-only hits that weren't lexical candidates, hydrating from DB.
  // denseRankAll already enforced scope; re-check on the hydrated row anyway so
  // a stale ranking can never leak an out-of-scope row.
  const byId = new Map(safeCandidates.map((c) => [c.memory_id, c]));
  for (const d of dense) {
    if (byId.has(d.memory_id) || !db) continue;
    const row = hydrateDenseRow(db, d.memory_id);
    if (!row) continue;
    if (scope && !rowVisibleForRequestedScope(row.scope, scope, { includeProfile, includeShared })) continue;
    byId.set(d.memory_id, { ...row, _source: 'dense' });
  }

  // Weighted Borda totals over the COMMON fused pool; rows absent from a
  // ballot receive HYBRID_BORDA_MISSING_LEG_POINTS (0 = classic Borda), and
  // intent-matched row types earn the bounded HYBRID_INTENT_TYPE_BONUS.
  const poolSize = byId.size || 1;
  const totals = new Map();
  let maxTotal = 0;
  for (const [id, row] of byId.entries()) {
    const lex = lexRank.has(id) ? bordaPoints(lexRank.get(id), poolSize) : HYBRID_BORDA_MISSING_LEG_POINTS;
    const den = denseRank.has(id) ? bordaPoints(denseRank.get(id), poolSize) : HYBRID_BORDA_MISSING_LEG_POINTS;
    const total = HYBRID_LEXICAL_WEIGHT * lex + HYBRID_DENSE_WEIGHT * den + intentTypeBonus(row, querySignals);
    totals.set(id, total);
    if (total > maxTotal) maxTotal = total;
  }
  if (maxTotal <= 0) maxTotal = 1;

  const fused = [...byId.values()].map((row) => {
    const total = totals.get(row.memory_id) || 0;
    const out = {
      ...row,
      _semantic_score: semScore.has(row.memory_id) ? semScore.get(row.memory_id) : (row._semantic_score ?? null),
      _hybrid_strength: Math.max(0, Math.min(1, total / maxTotal)),
      _borda: total,
      _score: HYBRID_BORDA_SCORE_SCALE * total,
      // Per-leg ballot ranks (0-based; null = absent from that ballot) for
      // introspection and the post-fusion head-rescue policy in recall-service.
      _lex_rank: lexRank.has(row.memory_id) ? lexRank.get(row.memory_id) : null,
      _dense_rank: denseRank.has(row.memory_id) ? denseRank.get(row.memory_id) : null,
    };
    if (row._source !== 'dense') out._lexical_score = Number(row._score || 0);
    return out;
  });
  fused.sort((a, b) => Number(b._borda || 0) - Number(a._borda || 0));
  return fused;
};

/**
 * U14(e): cross-encoder rerank SEAM over the fused candidate set. Gated by
 * recall.crossEncoderRerankEnabled (default OFF). Intentionally an identity
 * passthrough — no model is wired up; when a measured experiment justifies the
 * latency, the implementation replaces this body and the flag stays the only
 * switch callers know about.
 */
const crossEncoderRerank = (candidates, query, config = {}) => {
  if (config?.recall?.crossEncoderRerankEnabled !== true) return candidates;
  return candidates;
};

// ---------------------------------------------------------------------------
// Nightly batch: build missing embeddings
// ---------------------------------------------------------------------------

/**
 * Compute and store embeddings for active memories that don't have one yet.
 * Intended to run in the nightly maintenance pipeline.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [config]  Resolved gigabrain config (or partial)
 * @returns {{ enabled: boolean, computed: number, skipped: number, failed: number }}
 */
const buildMissingEmbeddings = (dbOrOptions, configArg = {}) => {
  const options = dbOrOptions && typeof dbOrOptions === 'object' && dbOrOptions.db
    ? dbOrOptions
    : { db: dbOrOptions, config: configArg };
  const db = options.db;
  const config = options.config || configArg || {};
  const forceRebuildActive = options.forceRebuildActive === true;
  const recall = config.recall || {};
  if (recall.semanticRerankEnabled === true || forceRebuildActive) {
    assertConfiguredCandidateOperation({ operation: 'embedding.model-change', config, db });
  }
  const base = {
    compatible: 0,
    computed: 0,
    dimensions: 0,
    enabled: recall.semanticRerankEnabled === true,
    failed: 0,
    fingerprint: '',
    missing: 0,
    model: '',
    replaced: 0,
    scanned: 0,
    skipped: 0,
  };
  if (recall.semanticRerankEnabled !== true) {
    return base;
  }
  let identity;
  let transport;
  try {
    identity = resolveEmbeddingIdentity(config);
    transport = resolveEmbeddingTransport(config);
  } catch (error) {
    return { ...base, failed: 0, identity_error: error.code || 'GIGABRAIN_EMBEDDING_IDENTITY_INVALID' };
  }
  const timeoutMs = recall.embeddingTimeoutMs || DEFAULT_TIMEOUT_MS;
  Object.assign(base, identity);

  ensureEmbeddingStore(db);

  // A normal backfill creates only truly missing vectors. It never replaces an
  // incompatible or unbound cache row; the explicit force flag is the sole
  // replacement authority during a reviewed model migration.
  const rows = db.prepare(`
    SELECT mc.memory_id, mc.content, me.embedding, me.model, me.dims, me.model_fingerprint
    FROM memory_current mc
    LEFT JOIN memory_embeddings me ON mc.memory_id = me.memory_id
    WHERE mc.status = 'active'
    ORDER BY mc.updated_at DESC
    LIMIT ?
  `).all(NIGHTLY_BATCH_SIZE);
  base.scanned = rows.length;

  if (rows.length === 0) {
    return base;
  }

  const candidates = [];
  for (const row of rows) {
    if (row.embedding && isCompatibleEmbedding(row, identity)) {
      base.compatible += 1;
      continue;
    }
    if (row.embedding && !forceRebuildActive) {
      base.skipped += 1;
      continue;
    }
    if (!row.embedding) base.missing += 1;
    candidates.push(row);
  }
  if (candidates.length === 0) return base;

  const probe = getEmbeddingSync('gigabrain semantic probe', {
    baseUrl: transport.baseUrl,
    identity,
    query: true,
    timeoutMs,
  });
  if (!probe) {
    return { ...base, failed: candidates.length, reachable: false };
  }

  for (const row of candidates) {
    const text = row.content;
    if (!text || text.length < 10) {
      base.skipped += 1;
      continue;
    }

    const vec = getEmbeddingSync(text, {
      baseUrl: transport.baseUrl,
      identity,
      timeoutMs,
    });
    if (!vec) {
      base.failed += 1;
      continue;
    }

    try {
      storeEmbedding(db, { memoryId: row.memory_id, identity, embedding: vec });
      if (row.embedding) base.replaced += 1;
      else base.computed += 1;
    } catch {
      base.failed += 1;
    }
  }

  return base;
};

const verifyAndBindLegacyEmbeddingFingerprint = ({
  apply = false,
  config = {},
  db,
  embedder = null,
  receiptPath = '',
} = {}) => {
  if (!db) throw embeddingIdentityError('GIGABRAIN_EMBEDDING_DB_REQUIRED');
  if (apply === true) assertConfiguredCandidateOperation({ operation: 'embedding.model-change', config, db });
  const identity = resolveEmbeddingIdentity(config);
  const transport = resolveEmbeddingTransport(config);
  ensureEmbeddingStore(db);
  const report = {
    bound: 0,
    byteExact: 0,
    dimensions: identity.dimensions,
    fingerprint: identity.fingerprint,
    mismatched: 0,
    model: identity.model,
    scanned: 0,
  };
  const rows = db.prepare(`
    SELECT me.memory_id, me.embedding, me.model, me.dims, me.model_fingerprint, mc.content
    FROM memory_embeddings me
    JOIN memory_current mc ON mc.memory_id = me.memory_id
    WHERE mc.status = 'active'
      AND me.model = ?
      AND me.dims = ?
      AND me.model_fingerprint IS NULL
    ORDER BY me.memory_id
  `).all(identity.model, identity.dimensions);
  report.scanned = rows.length;
  const reproduce = typeof embedder === 'function'
    ? embedder
    : (content) => getEmbeddingSync(content, {
      baseUrl: transport.baseUrl,
      identity,
      timeoutMs: Number(config?.recall?.embeddingTimeoutMs || DEFAULT_TIMEOUT_MS),
    });
  const bindable = [];
  for (const row of rows) {
    if (!isCompatibleEmbedding({ ...row, model_fingerprint: identity.fingerprint }, identity)) {
      report.mismatched += 1;
      continue;
    }
    let reproduced;
    try {
      reproduced = reproduce(String(row.content || ''), { identity, transport });
    } catch {
      reproduced = null;
    }
    if (!isUsableEmbeddingVector(reproduced, identity.dimensions)) {
      report.mismatched += 1;
      continue;
    }
    const actual = Buffer.from(row.embedding);
    const expected = vecToBlob(reproduced);
    if (actual.length !== expected.length || !actual.equals(expected)) {
      report.mismatched += 1;
      continue;
    }
    report.byteExact += 1;
    bindable.push(String(row.memory_id));
  }
  if (apply === true && report.mismatched === 0 && bindable.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const update = db.prepare(`
        UPDATE memory_embeddings
        SET model_fingerprint = ?
        WHERE memory_id = ?
          AND model = ?
          AND dims = ?
          AND model_fingerprint IS NULL
      `);
      for (const memoryId of bindable) {
        const result = update.run(identity.fingerprint, memoryId, identity.model, identity.dimensions);
        report.bound += Number(result.changes || 0);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* keep the original failure */ }
      throw error;
    }
  }
  if (receiptPath) {
    const receipt = {
      ...report,
      apply: apply === true,
      config_sha256: createHash('sha256').update(JSON.stringify({
        dimensions: identity.dimensions,
        fingerprint: identity.fingerprint,
        model: identity.model,
        provider: transport.provider,
      })).digest('hex'),
      generated_at: new Date().toISOString(),
    };
    const output = path.resolve(String(receiptPath));
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(output, 0o600);
  }
  return report;
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  hybridFuseRecall,
  denseRankAll,
  crossEncoderRerank,
  HYBRID_LEXICAL_WEIGHT,
  HYBRID_DENSE_WEIGHT,
  HYBRID_BORDA_MISSING_LEG_POINTS,
  HYBRID_BORDA_SCORE_SCALE,
  HYBRID_INTENT_TYPE_BONUS,
  DEFAULT_OLLAMA_URL,
  DEFAULT_MODEL,
  DEFAULT_DIMS,
  EMBEDDING_QUERY_INSTRUCTION,
  ensureEmbeddingStore,
  resolveEmbeddingIdentity,
  resolveEmbeddingTransport,
  formatEmbeddingQuery,
  isCompatibleEmbedding,
  getEmbedding,
  getEmbeddingSync,
  isSafeEmbeddingBaseUrl,
  buildEmbeddingEndpoint,
  cosineSimilarity,
  storeEmbedding,
  getStoredEmbedding,
  buildMissingEmbeddings,
  verifyAndBindLegacyEmbeddingFingerprint,
  vecToBlob,
  blobToVec,
};

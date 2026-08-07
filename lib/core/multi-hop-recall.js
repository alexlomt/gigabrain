// Iterative multi-hop recall expansion (R5). A single verdict-filtered recall
// returns ~topK rows keyed to the WHOLE question; multi-hop questions ("the
// citizenship of the spouse of the author of X") need a CHAIN of facts that a
// single whole-question query can miss even when the arbitrated store contains
// every required edge.
//
// This walks the entity edges: from the seed rows, pull the named entities,
// run a bounded recall per new entity, union the results, and repeat for a few
// hops. DETERMINISTIC (no LLM in the recall path), BOUNDED (entities/hop,
// rows/entity, total cap), and flag-gated OFF by default — the retriever is
// INJECTED so this module never imports recall-service (no cycle) and tests
// drive it with a stub. Precision-first: expansion only ADDS candidates to the
// pool; downstream ranking/budgeting still selects, and the recall gate must
// stay green with the flag on the default (off).

const DEFAULTS = Object.freeze({
  enabled: false,
  hops: 2,
  entitiesPerHop: 5,
  rowsPerEntity: 6,
  maxTotal: 40,
});

const resolveMultiHopSettings = (config = {}) => {
  const raw = config?.recall?.multiHop;
  const merged = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] === undefined) continue;
      if (key === 'enabled') merged.enabled = raw.enabled === true;
      else {
        const n = Number(raw[key]);
        if (Number.isFinite(n)) merged[key] = Math.max(0, Math.trunc(n));
      }
    }
  }
  return Object.freeze(merged);
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

// Stopwords for capitalized-phrase entity extraction: sentence-initial and
// filler words that capitalize incidentally. Kept small on purpose — over-
// filtering drops real entities; the bounds (entitiesPerHop, maxTotal) are the
// real flood control, not the stoplist.
const ENTITY_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
  'this', 'that', 'these', 'those', 'it', 'he', 'she', 'they', 'his', 'her', 'their', 'who', 'what',
  'when', 'where', 'which', 'country', 'city', 'user', 'person', 'note', 'memory', 'fact',
]);

// Extract candidate entity phrases: runs of capitalized words (people, places,
// works — "Charles Darwin", "Our Mutual Friend", "Soviet Union"). Language-
// agnostic on the surface form; the bounds keep it safe on noisy corpora.
const extractEntities = (text = '') => {
  const out = [];
  for (const m of String(text || '').matchAll(/\b[A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*){0,4}\b/gu)) {
    const phrase = m[0].trim();
    const words = phrase.split(/\s+/);
    // A single capitalized word that is a stopword (sentence start) is noise;
    // multi-word phrases are almost always real entities.
    if (words.length === 1 && ENTITY_STOPWORDS.has(norm(phrase))) continue;
    if (norm(phrase).length < 3) continue;
    out.push(phrase);
  }
  return out;
};

// Rank the entities found across the frontier rows by frequency (an entity
// mentioned in several retrieved facts is a stronger next hop), stable by first
// appearance. Returns distinct phrases, most-frequent first.
const rankFrontierEntities = (rows = []) => {
  const freq = new Map();
  const order = [];
  for (const row of rows) {
    const content = String(row?.content || row?.normalized || '');
    for (const ent of extractEntities(content)) {
      const key = norm(ent);
      if (!freq.has(key)) { freq.set(key, { phrase: ent, n: 0 }); order.push(key); }
      freq.get(key).n += 1;
    }
  }
  return order
    .map((k) => freq.get(k))
    .sort((a, b) => b.n - a.n)
    .map((e) => e.phrase);
};

// Expand a seed recall result set by walking entity edges for `hops` rounds.
// `retrieve(query) -> rows[]` is injected (usually a bound recallForQuery that
// returns {results}). Returns the unioned, deduped, capped row set.
const expandRecallMultiHop = ({ seedRows = [], query = '', retrieve, settings } = {}) => {
  const cfg = settings || DEFAULTS;
  if (cfg.enabled !== true || typeof retrieve !== 'function' || cfg.hops <= 0) {
    return Array.isArray(seedRows) ? seedRows.slice() : [];
  }
  const acc = new Map();
  for (const row of seedRows) {
    if (row && row.memory_id != null) acc.set(String(row.memory_id), row);
  }
  // Entities already covered by the seed query itself are not re-queried.
  const queried = new Set(extractEntities(query).map(norm));
  let frontier = seedRows;

  for (let hop = 0; hop < cfg.hops && acc.size < cfg.maxTotal; hop += 1) {
    const candidates = rankFrontierEntities(frontier)
      .filter((ent) => !queried.has(norm(ent)))
      .slice(0, cfg.entitiesPerHop);
    if (candidates.length === 0) break;

    const nextFrontier = [];
    for (const entity of candidates) {
      queried.add(norm(entity));
      let rows = [];
      try {
        const out = retrieve(entity);
        rows = Array.isArray(out) ? out : (out?.results || []);
      } catch {
        rows = [];
      }
      for (const row of rows.slice(0, cfg.rowsPerEntity)) {
        const id = row && row.memory_id != null ? String(row.memory_id) : null;
        if (!id || acc.has(id)) continue;
        acc.set(id, row);
        nextFrontier.push(row);
        if (acc.size >= cfg.maxTotal) break;
      }
      if (acc.size >= cfg.maxTotal) break;
    }
    frontier = nextFrontier;
    if (nextFrontier.length === 0) break;
  }
  return Array.from(acc.values()).slice(0, cfg.maxTotal);
};

// --- Directed decomposition (R5 attempt 2) --------------------------------
// Broad entity-expansion floods AWAY from the question's chain. Directed
// decomposition instead resolves a nested question inside-out: given an ordered
// chain of retrieval steps with placeholders ({STEP1}...), retrieve per step,
// pull the ANSWER entity from the top row, bind it, substitute into the next
// step, and union every step's rows. `retrieve(query) -> rows[]` is injected;
// the chain is produced upstream (an LLM decomposer). Deterministic resolution.

// The answer entity of a step: the strongest NEW named entity in the top
// retrieved row (the verdict-filtered current fact) not already in the query.
const answerEntityFromRows = (rows = [], stepQuery = '') => {
  const queryEnts = new Set(extractEntities(stepQuery).map(norm));
  for (const row of rows) {
    const fresh = extractEntities(String(row?.content || row?.normalized || ''))
      .find((e) => !queryEnts.has(norm(e)));
    if (fresh) return fresh;
  }
  return '';
};

const substitutePlaceholders = (query, bindings) => String(query || '')
  .replace(/\{(\w+)\}/g, (m, key) => (bindings[key] != null ? String(bindings[key]) : m));

// Resolve one decomposed chain into a unioned, deduped, capped row set.
const resolveDecomposedChain = ({ chain = [], retrieve, settings } = {}) => {
  const cfg = settings || DEFAULTS;
  if (typeof retrieve !== 'function' || !Array.isArray(chain) || chain.length === 0) return [];
  const acc = new Map();
  const bindings = {};
  for (const step of chain) {
    const q = substitutePlaceholders(step?.query, bindings);
    if (!q || /\{\w+\}/.test(q)) break; // unresolved placeholder — chain broke
    let rows = [];
    try {
      const out = retrieve(q);
      rows = Array.isArray(out) ? out : (out?.results || []);
    } catch { rows = []; }
    for (const row of rows.slice(0, cfg.rowsPerEntity)) {
      const id = row && row.memory_id != null ? String(row.memory_id) : null;
      if (id && !acc.has(id)) acc.set(id, row);
      if (acc.size >= cfg.maxTotal) break;
    }
    if (step?.bind) bindings[step.bind] = answerEntityFromRows(rows, q);
    if (acc.size >= cfg.maxTotal) break;
  }
  return Array.from(acc.values()).slice(0, cfg.maxTotal);
};

export {
  DEFAULTS as MULTI_HOP_DEFAULTS,
  resolveMultiHopSettings,
  extractEntities,
  rankFrontierEntities,
  expandRecallMultiHop,
  answerEntityFromRows,
  substitutePlaceholders,
  resolveDecomposedChain,
};

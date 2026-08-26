import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { appendEvent } from './event-store.js';
import { listCurrentMemories, upsertCurrentMemory, updateCurrentStatus, recordVerdict, recordAdjudication, getCurrentMemory, searchFTS5 } from './projection-store.js';
import { jaccardSimilarity, normalizeContent, resolvePolicy, detectJunk, detectPlausibility, resolveSemanticThresholds, classifyValue } from './policy.js';
import {
  getEmbeddingSync,
  cosineSimilarity,
  blobToVec,
  isCompatibleEmbedding,
  resolveEmbeddingIdentity,
  resolveEmbeddingTransport,
} from './embedding-service.js';
import { appendQueueRow } from './review-queue.js';
import { writeNativeMemoryEntry } from './native-memory.js';
import { applyMemoryActions, parseMemoryActions } from './memory-actions.js';
import { rebuildEntityMentions } from './person-service.js';
import { normalizeMemoryTier, projectArbitrationBeliefRows, rebuildWorldModel } from './world-model.js';
import { arbitratePositions, resolveArbiterSettings, runBeliefArbitration } from './belief-arbitration.js';
import {
  normalizeProvider,
  resolveTaskProfile,
  buildExtractionPrompt,
  parseExtraction,
  buildDecisionPrompt,
  parseCaptureDecision,
  normalizeStateAdjudication,
} from './llm-router.js';
import { hasSecretRisk, redactMemoryText } from './host-memory-sync.js';
import { buildHttpEndpoint } from './url-safety.js';
import { normalizeAgentScope } from '../compat/scope-policy.js';
import { assertWriteAllowed, resolveWriteMode } from '../compat/write-policy.js';

const createMemoryNoteRe = () => /<memory_note\b(?=[^>]*=)([^>]*)>([\s\S]*?)<\/memory_note>/gi;
const MEMORY_NOTE_ATTR_RE = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
const THINKING_BLOCK_RE = /<(?:thinking|anth?lr?:thinking|antlr:thinking)>[\s\S]*?<\/(?:thinking|anth?lr?:thinking|antlr:thinking)>/gi;

const stripModelThinkingBlocks = (text) => {
  const input = String(text || '');
  if (!/<(?:thinking|anth?lr?:thinking|antlr:thinking)>/i.test(input)) return input;
  return input.replace(THINKING_BLOCK_RE, '').trim();
};

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const normalizeType = (value) => {
  const key = String(value || '').trim().toUpperCase();
  if (!key) return 'CONTEXT';
  if (key === 'FACT' || key === 'USERFACT') return 'USER_FACT';
  if (['USER_FACT', 'PREFERENCE', 'DECISION', 'ENTITY', 'EPISODE', 'AGENT_IDENTITY', 'CONTEXT'].includes(key)) return key;
  return 'CONTEXT';
};

const inferTypeFromContent = (content) => {
  const text = String(content || '').trim();
  if (!text) return 'CONTEXT';
  if (/\b(?:user|owner)\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\b/i.test(text)) return 'PREFERENCE';
  if (/\b(?:my personality|agent identity|agent evolution)\b/i.test(text)) return 'AGENT_IDENTITY';
  if (/\b(?:decided|decision|we will|we should|always)\b/i.test(text)) return 'DECISION';
  if (/\b(?:met|happened|today|yesterday|tomorrow)\b/i.test(text)) return 'EPISODE';
  return 'USER_FACT';
};

const parseAttributes = (raw) => {
  const attrs = {};
  const source = String(raw || '');
  let match = MEMORY_NOTE_ATTR_RE.exec(source);
  while (match) {
    const key = String(match[1] || '').trim().toLowerCase();
    const value = String(match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (key) attrs[key] = value;
    match = MEMORY_NOTE_ATTR_RE.exec(source);
  }
  MEMORY_NOTE_ATTR_RE.lastIndex = 0;
  return attrs;
};

const DEFAULT_CONFIDENCE = 0.65;
const MEMORY_FLUSH_RE = /\b(?:pre-compaction memory flush|memory flush turn|session nearing compaction|store durable memories now|capture important facts from this conversation using <memory_note>)\b/i;
const REMEMBER_NATIVE_ONLY_RE = /\b(?:today|tonight|this morning|this afternoon|this evening|right now|currently|for now|temporary|temporarily|tired|hungry|busy)\b/i;

const parseConfidence = (raw) => {
  if (raw == null) return DEFAULT_CONFIDENCE;
  const value = String(raw).trim().toLowerCase();
  if (!value) return DEFAULT_CONFIDENCE;
  const num = Number(value);
  if (Number.isFinite(num)) return clamp01(num);
  if (value === 'high') return 0.9;
  if (value === 'medium') return 0.7;
  if (value === 'low') return 0.4;
  return DEFAULT_CONFIDENCE;
};

const normalizeDurability = (raw) => {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'durable') return 'durable';
  if (value === 'ephemeral') return 'ephemeral';
  return 'auto';
};

const parseMemoryNotes = (inputText, options = {}) => {
  const text = stripModelThinkingBlocks(String(inputText || ''));
  const notes = [];
  // Default cap protects PASSIVE transcript capture from swallowing blobs;
  // explicit remember-intents pass a higher cap (runbooks/decisions are long).
  const maxContentChars = Math.max(1, Number(options.maxContentChars ?? 1200) || 1200);
  const MEMORY_NOTE_RE = createMemoryNoteRe();
  let match = MEMORY_NOTE_RE.exec(text);
  while (match) {
    const attrs = parseAttributes(match[1] || '');
    if (String(attrs.action || '').trim()) {
      match = MEMORY_NOTE_RE.exec(text);
      continue;
    }
    const type = normalizeType(attrs.type || '');
    const content = String(match[2] || '').replace(/\s+/g, ' ').trim();
    const confidence = parseConfidence(attrs.confidence);
    const nestedTag = /<\/?memory_note\b/i.test(content);
    if (content && !nestedTag && content.length <= maxContentChars) {
      notes.push({
        type: type || inferTypeFromContent(content),
        content,
        confidence,
        scope: attrs.scope || null,
        durability: normalizeDurability(attrs.durability || attrs.store || ''),
      });
    } else if (content && !nestedTag && Array.isArray(options.oversized)) {
      // An over-cap note next to a surviving short note
      // used to vanish with no dead-letter (the missing-note park only fires
      // when NO notes survived). Hand oversized notes back so the caller can
      // park them individually with full content.
      options.oversized.push({
        type: type || inferTypeFromContent(content),
        content,
        confidence,
        scope: attrs.scope || null,
        durability: normalizeDurability(attrs.durability || attrs.store || ''),
      });
    }
    match = MEMORY_NOTE_RE.exec(text);
  }
  return notes;
};

const normalizeRememberText = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

const latestUserText = (event = {}) => {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    const role = String(msg?.role || msg?.author || '').toLowerCase();
    if (role !== 'user') continue;
    const text = valueToText(msg?.content ?? msg?.text ?? msg?.output).trim();
    if (text) return text;
  }
  return String(event?.prompt || '').trim();
};

const detectRememberIntent = (event = {}, config = {}) => {
  // Explicit marker set by the remember tool itself (runRemember): an MCP
  // remember call IS a remember intent by definition — it must not depend on
  // phrase heuristics (phrasesBase is empty in most configs, which silently
  // made every MCP remember a non-intent: no long-note cap relief, no
  // missing-note queue fallback).
  if (event?.remember_intent === true) return true;
  if (config?.capture?.rememberIntent?.enabled === false) return false;
  const phrases = Array.isArray(config?.capture?.rememberIntent?.phrasesBase)
    ? config.capture.rememberIntent.phrasesBase
    : [];
  if (phrases.length === 0) return false;
  const text = normalizeRememberText(latestUserText(event));
  if (!text) return false;
  return phrases.some((phrase) => {
    const needle = normalizeRememberText(phrase);
    return needle && text.includes(needle);
  });
};

const detectMemoryFlushTurn = (event = {}) => {
  const prompt = String(event?.prompt || '').trim();
  const sourceText = extractCandidateText(event);
  return MEMORY_FLUSH_RE.test(prompt) || MEMORY_FLUSH_RE.test(sourceText);
};

const scopeAllowsMemoryMd = (scope = '') => {
  const key = String(scope || '').trim().toLowerCase();
  if (!key || key === 'shared') return false;
  if (key.startsWith('profile:')) return true;
  return key.includes('main') || key.includes('dm') || key.includes('private');
};

const isDurableNote = ({ type, content, confidence, scope }, policy = {}) => {
  const normalizedType = normalizeType(type);
  if (['PREFERENCE', 'DECISION', 'AGENT_IDENTITY'].includes(normalizedType)) return true;
  if (normalizedType === 'CONTEXT' || normalizedType === 'EPISODE') return false;
  const classified = classifyValue({
    type: normalizedType,
    content,
    confidence,
    scope,
    status: 'active',
    updated_at: new Date().toISOString(),
  }, policy);
  const hasPlausibilityFlag = Boolean(
    classified?.plausibility?.flags?.token_anomaly
    || classified?.plausibility?.flags?.broken_phrase_pattern
    || classified?.plausibility?.flags?.entityless_numeric_fact
  );
  return classified?.action === 'keep' && hasPlausibilityFlag === false;
};

const resolveCaptureMode = ({
  note,
  noteScope,
  policy,
  rememberIntent,
  memoryFlushTurn,
  config,
}) => {
  const type = normalizeType(note?.type || inferTypeFromContent(note?.content || ''));
  const durable = isDurableNote({
    type,
    content: note?.content || '',
    confidence: note?.confidence,
    scope: noteScope,
  }, policy);
  const requestedDurability = normalizeDurability(note?.durability || '');
  const ephemeralRemember = Boolean(
    rememberIntent
    && (
      type === 'CONTEXT'
      || type === 'EPISODE'
      || REMEMBER_NATIVE_ONLY_RE.test(String(note?.content || ''))
    )
  );
  const nativeTrigger = rememberIntent || memoryFlushTurn;
  const writeNative = nativeTrigger && config?.capture?.rememberIntent?.writeNative !== false;
  if (requestedDurability === 'durable') {
    return {
      type,
      durable: true,
      nativeDurable: scopeAllowsMemoryMd(noteScope),
      writeNative,
      writeRegistry: config?.capture?.rememberIntent?.writeRegistry !== false,
    };
  }
  if (requestedDurability === 'ephemeral') {
    return {
      type,
      durable: false,
      nativeDurable: false,
      writeNative,
      writeRegistry: false,
    };
  }
  const nativeDurable = durable && scopeAllowsMemoryMd(noteScope);
  let writeRegistry = true;
  if (rememberIntent && config?.capture?.rememberIntent?.writeRegistry === false) {
    writeRegistry = false;
  }
  if ((rememberIntent || memoryFlushTurn) && (ephemeralRemember || durable === false && type === 'USER_FACT')) {
    writeRegistry = false;
  }
  return {
    type,
    durable,
    nativeDurable,
    writeNative,
    writeRegistry,
  };
};

const MAX_QUEUE_EXCERPT_CHARS = 280;

const valueToText = (value, depth = 0) => {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => valueToText(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const record = value;
    const preferredKeys = ['text', 'content', 'output_text', 'message', 'response', 'output', 'result', 'final'];
    const parts = [];
    for (const key of preferredKeys) {
      if (!(key in record)) continue;
      const piece = valueToText(record[key], depth + 1);
      if (piece) parts.push(piece);
    }
    if (parts.length > 0) return parts.join('\n');
    try {
      return JSON.stringify(record);
    } catch {
      return String(record);
    }
  }
  return '';
};

const extractCandidateText = (event = {}) => {
  const parts = [];
  const seen = new Set();
  const pushPart = (value) => {
    const text = valueToText(value)
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    parts.push(text);
  };

  pushPart(event?.text);
  pushPart(event?.output);
  pushPart(event?.response);
  pushPart(event?.result);
  pushPart(event?.final);

  if (Array.isArray(event?.messages)) {
    for (const msg of event.messages) {
      const role = String(msg?.role || msg?.author || '').toLowerCase();
      if (role && role !== 'assistant' && role !== 'model') continue;
      pushPart(msg?.content ?? msg?.text ?? msg?.output);
    }
  }

  return parts.join('\n').trim();
};

const shouldQueueNoNotes = (event = {}, sourceText = '') => {
  const text = String(sourceText || '');
  if (/\<memory_note\b/i.test(text)) return 'capture_note_parse_failed';

  const flags = [
    event?.llmUnavailable,
    event?.modelUnavailable,
    event?.memoryExtractionUnavailable,
    event?.meta?.llmUnavailable,
    event?.meta?.modelUnavailable,
    event?.metadata?.llmUnavailable,
    event?.metadata?.modelUnavailable,
  ];
  return flags.some((flag) => flag === true) ? 'llm_unavailable' : '';
};

const buildQueueExcerpt = (event = {}, sourceText = '') => {
  const compact = String(sourceText || '').replace(/\s+/g, ' ').trim();
  if (compact) return compact.slice(0, MAX_QUEUE_EXCERPT_CHARS);
  const fallback = valueToText(event).replace(/\s+/g, ' ').trim();
  return fallback.slice(0, MAX_QUEUE_EXCERPT_CHARS);
};

const findExactDuplicate = (existingRows, normalized, scope) => {
  const key = `${String(scope || 'shared')}|${normalized}`;
  for (const row of existingRows) {
    const rowKey = `${String(row.scope || 'shared')}|${String(row.normalized || '')}`;
    if (rowKey === key && String(row.status || 'active') === 'active') return row;
  }
  return null;
};

const findSemanticDuplicate = (existingRows, content, scope, type) => {
  let best = null;
  for (const row of existingRows) {
    if (String(row.scope || 'shared') !== String(scope || 'shared')) continue;
    if (String(row.type || 'CONTEXT') !== String(type || 'CONTEXT')) continue;
    if (String(row.status || 'active') !== 'active') continue;
    const similarity = jaccardSimilarity(content, row.content || row.normalized || '');
    if (!best || similarity > best.similarity) {
      best = { row, similarity };
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// Two-phase LLM capture (U8)
//
// Pipeline: (1) extraction distills atomic facts from a session so untagged
// facts are captured; (2) for each candidate, retrieve k-nearest existing
// memories and let the LLM emit exactly one of ADD/UPDATE/CONTRADICT/NOOP.
//
// CRITICAL local-first + determinism:
// - The LLM path is ENABLED only when config.llm.provider !== 'none' (default
//   'none'), or when a test/host injects sync hooks via event.__captureLlm.
//   When disabled, capture DEGRADES to the heuristic regex/jaccard path so the
//   suite stays green without Ollama.
// - A CLOUD provider (openai_compatible/openclaw) must only ever receive
//   locally-redacted, secrets-stripped candidate FACTS — never raw transcripts.
//   Extraction (which needs the transcript) therefore runs ONLY for local
//   providers (ollama) or injected hooks; cloud skips extraction entirely.
// ---------------------------------------------------------------------------

const CLOUD_PROVIDERS = new Set(['openai_compatible', 'openclaw']);

// CONTRADICT is destructive (supersedes an existing memory). Require this much
// decision confidence AND an exactly-resolved target before auto-superseding;
// anything weaker routes to the review queue instead of guessing.
const CONTRADICT_MIN_CONFIDENCE = 0.75;

// Cheap, correct secret pre-filter that runs BEFORE any LLM call. Mirrors the
// junk secret patterns (API_KEY=/SECRET=/PASSWORD=/tokens) so candidate facts
// carrying credentials are blocked locally and never embedded or sent anywhere.
const SECRET_PREFILTER_RE = /(?:api[_-]?key|secret|password|passwd|pwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]/i;
const containsSecret = (text) => SECRET_PREFILTER_RE.test(String(text || '')) || hasSecretRisk(String(text || ''));

// Synchronous sleep for the transport retry backoff (Node permits Atomics.wait
// on the main thread). Best-effort: a sleep failure must never fail the call.
const sleepSync = (ms) => {
  const waitMs = Number(ms);
  if (!(waitMs > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  } catch {
    // ignore — backoff is best-effort
  }
};

const TRANSPORT_RETRY_BACKOFF_MS = 250;

// One synchronous Ollama /api/generate attempt via curl, mirroring
// getEmbeddingSync. `-w` appends the HTTP status so a 5xx is distinguishable
// from transport-level failures (timeout/connection refused) and from 4xx.
const curlGenerateAttempt = ({ baseUrl, model, prompt, timeoutMs, options, think }) => {
  let endpoint;
  try {
    endpoint = buildHttpEndpoint(
      baseUrl || 'http://127.0.0.1:11434',
      '/api/generate',
      { localOnly: true, label: 'Ollama capture endpoint' },
    ).toString();
  } catch {
    return { ok: false, text: '', error: 'unsafe_base_url', retryable: false };
  }
  const body = JSON.stringify({
    model,
    prompt,
    format: 'json',
    stream: false,
    ...(options && typeof options === 'object' ? { options } : {}),
    ...(think === false ? { think: false } : {}),
  });
  try {
    const out = execFileSync('curl', [
      '-s', '-w', '\n%{http_code}', '--max-time', String(Math.ceil(Number(timeoutMs || 12000) / 1000)),
      '-X', 'POST', '-H', 'Content-Type: application/json', '-d', body, '--', endpoint,
    ], { encoding: 'utf8', timeout: Number(timeoutMs || 12000) + 2000 });
    const statusAt = out.lastIndexOf('\n');
    const status = Number(out.slice(statusAt + 1).trim());
    const payload = statusAt >= 0 ? out.slice(0, statusAt) : '';
    if (!Number.isFinite(status) || status < 100) return { ok: false, text: '', error: 'http_status_unknown', retryable: false };
    if (status >= 500) return { ok: false, text: '', error: `http_${status}`, retryable: true };
    if (status >= 400) return { ok: false, text: '', error: `http_${status}`, retryable: false };
    try {
      const parsed = JSON.parse(payload);
      return { ok: true, text: String(parsed?.response || parsed?.message?.content || ''), error: null, retryable: false };
    } catch {
      return { ok: false, text: '', error: 'unparseable_response', retryable: false };
    }
  } catch (err) {
    // curl exit 28 == --max-time exceeded; ETIMEDOUT/SIGTERM == execFileSync timeout.
    const timedOut = err?.status === 28 || err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM';
    const exitError = Number.isFinite(Number(err?.status)) ? `curl_exit_${err.status}` : 'curl_failed';
    return { ok: false, text: '', error: timedOut ? 'timeout' : exitError, retryable: timedOut };
  }
};

const runWithTimeoutCurl = ({ baseUrl, model, prompt, timeoutMs, options, think }) => {
  // Hardened transport: returns {ok, text, error} (never a bare '') so callers
  // can distinguish "Ollama down" from "no facts". Exactly one retry with a
  // short backoff on timeout/5xx; 4xx and connection failures fail immediately.
  const first = curlGenerateAttempt({ baseUrl, model, prompt, timeoutMs, options, think });
  if (first.ok || !first.retryable) return { ok: first.ok, text: first.text, error: first.error };
  sleepSync(TRANSPORT_RETRY_BACKOFF_MS);
  const second = curlGenerateAttempt({ baseUrl, model, prompt, timeoutMs, options, think });
  return { ok: second.ok, text: second.text, error: second.error };
};

/**
 * Resolve the capture LLM seam. Returns { enabled, provider, isCloud, extract, decide }.
 *
 * Contract for both paths (uniform, PARSED results):
 * - extract(transcript) -> Array<{type, content, confidence}> | throws on transport failure
 * - decide({candidate, neighbors}) -> {op:'ADD'|'UPDATE'|'CONTRADICT'|'NOOP', targetId, confidence, reason} | null | throws on transport failure
 *
 * A transport failure THROWS (instead of returning []/null) so captureFromEvent
 * can count llm_failed and route to the review queue — "Ollama down" must never
 * read as "no facts".
 *
 * Injected sync hooks (event.__captureLlm / config.__captureLlm) win and make
 * the path deterministic in tests (no network). Otherwise a real provider !==
 * 'none' enables a synchronous curl-backed local path.
 */
const resolveCaptureLlm = ({ config = {}, event = {} } = {}) => {
  const inject = event?.__captureLlm || config?.__captureLlm || null;
  const provider = normalizeProvider(config?.llm?.provider);
  if (inject && (typeof inject.extract === 'function' || typeof inject.decide === 'function')) {
    return {
      enabled: true,
      provider: provider === 'none' ? 'injected' : provider,
      isCloud: CLOUD_PROVIDERS.has(provider),
      extract: typeof inject.extract === 'function' ? inject.extract : null,
      decide: typeof inject.decide === 'function' ? inject.decide : null,
    };
  }
  if (provider === 'none') return { enabled: false };
  const llm = config.llm || {};
  if (CLOUD_PROVIDERS.has(provider)) {
    // The cloud capture transport (chat-completions + Authorization) is not
    // implemented: the old path POSTed an Ollama-shaped body to
    // <baseUrl>/api/generate with no auth (silent 404/401). Until a real cloud
    // transport exists, the decision pass is skipped EXPLICITLY (extraction is
    // already cloud-skipped for privacy) and captureFromEvent logs the reason;
    // capture degrades to the heuristic path instead of failing per-call.
    return {
      enabled: true,
      provider,
      isCloud: true,
      extract: null,
      decide: null,
      decideSkippedReason: 'cloud_capture_transport_unimplemented',
    };
  }
  // Real local provider path (ollama): drive the shared llm-router prompt
  // builders + parsers through the SYNCHRONOUS curl transport so
  // captureFromEvent stays sync for all existing callers. The tuned task
  // profiles (temperature/top_p/top_k/num_predict, think:false) ride along in
  // the request body instead of being dead code on this path.
  const profileFor = (profile) => resolveTaskProfile({
    taskProfiles: llm.taskProfiles,
    profile,
    model: llm.model,
  });
  const generate = (prompt, profile) => runWithTimeoutCurl({
    baseUrl: llm.baseUrl,
    model: profile.model,
    prompt,
    timeoutMs: llm.timeoutMs,
    options: {
      temperature: profile.temperature,
      top_p: profile.top_p,
      top_k: profile.top_k,
      num_predict: profile.max_tokens,
      // Profile seed (eval determinism): only present when a caller pinned it
      // — production profiles carry none, so the body is unchanged.
      ...(Number.isFinite(profile.seed) ? { seed: profile.seed } : {}),
    },
    think: profile.reasoning === 'off' ? false : undefined,
  });
  const extractionProfile = profileFor('capture_extraction');
  const decisionProfile = profileFor('capture_decision');
  return {
    enabled: true,
    provider,
    isCloud: false,
    extract: (transcript) => {
      const result = generate(buildExtractionPrompt(transcript), extractionProfile);
      if (!result.ok) throw new Error(`capture llm transport failed (extraction): ${result.error}`);
      return parseExtraction(result.text);
    },
    decide: ({ candidate, neighbors }) => {
      const result = generate(buildDecisionPrompt({ candidate, neighbors }), decisionProfile);
      if (!result.ok) throw new Error(`capture llm transport failed (decision): ${result.error}`);
      return parseCaptureDecision(result.text);
    },
  };
};

// RRF constant for fusing the dense (bge-m3 cosine) and lexical (FTS5 bm25)
// neighbor rankings — same k=60 as the recall-side hybridFuseRecall.
const NEIGHBOR_RRF_K = 60;

// Dense neighbor leg (R8a): cosine between the candidate's bge-m3 embedding and
// the CACHED vectors in memory_embeddings (populated nightly / by recall) for
// the eligible rows. Returns null — signalling "embeddings unavailable" — when
// the feature is off, the table/vectors are absent, or the query embedding
// cannot be obtained, so the caller can fall back to deterministic jaccard.
const rankNeighborsByEmbedding = (db, eligible, content, config = {}) => {
  const recall = config?.recall || {};
  if (recall.semanticRerankEnabled !== true || !db || eligible.length === 0) return null;
  let identity;
  let transport;
  try {
    identity = resolveEmbeddingIdentity(config);
    transport = resolveEmbeddingTransport(config);
  } catch {
    return null;
  }
  // U14b (#14): fetch ONLY the eligible rows' cached vectors via chunked
  // `WHERE memory_id IN (...)` — 200-id chunks, the same parameterisation
  // precedent as buildSelectedEntityMentionMemoryIds — instead of materializing
  // every embedding BLOB in the store per capture decision. The rowid sort
  // restores the old full-scan iteration order so equal-cosine ties rank
  // identically. Zero eligible vectors still means "embeddings unavailable"
  // (null), exactly as before — just decided BEFORE the query-embedding call.
  const stored = [];
  try {
    const chunkSize = 200;
    const eligibleIds = eligible.map((entry) => String(entry.id || ''));
    for (let index = 0; index < eligibleIds.length; index += chunkSize) {
      const chunk = eligibleIds.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      stored.push(...db.prepare(
        `SELECT rowid, memory_id, embedding, model, dims, model_fingerprint
         FROM memory_embeddings
         WHERE memory_id IN (${placeholders})
           AND model = ? AND dims = ? AND model_fingerprint = ?`,
      ).all(...chunk, identity.model, identity.dimensions, identity.fingerprint));
    }
  } catch {
    return null;
  }
  if (stored.length === 0) return null;
  stored.sort((a, b) => Number(a.rowid) - Number(b.rowid));
  const byId = new Map(eligible.map((entry) => [entry.id, entry]));
  const queryVec = getEmbeddingSync(content, {
    baseUrl: transport.baseUrl,
    identity,
    query: true,
    timeoutMs: recall.embeddingTimeoutMs,
  });
  if (!queryVec) return null;
  const dense = [];
  for (const row of stored) {
    const entry = byId.get(String(row.memory_id || ''));
    if (!entry) continue;
    if (!isCompatibleEmbedding(row, identity)) continue;
    let vec = null;
    try {
      vec = blobToVec(row.embedding);
    } catch {
      continue;
    }
    if (!vec || vec.length === 0) continue;
    dense.push({ id: entry.id, cosine: cosineSimilarity(queryVec, vec) });
  }
  if (dense.length === 0) return null;
  dense.sort((a, b) => b.cosine - a.cosine);
  return dense;
};

// Rank existing active rows for the candidate and return the top-k as decision
// neighbors. Embedding path (R8a): bge-m3 cosine over cached memory_embeddings
// RRF-fused with the FTS5 lexical ranking — mirroring the recall-side fusion —
// so paraphrases that share no tokens still surface as UPDATE/CONTRADICT
// targets. Jaccard fallback ONLY when embeddings are unavailable (feature off,
// Ollama down, no cached vectors), keeping tests/offline deterministic.
// Each neighbor carries { similarity, via: 'embedding' | 'jaccard' }.
const selectNeighbors = (existingRows, content, scope, { k = 5, db = null, config = {} } = {}) => {
  const eligible = existingRows
    .filter((row) => String(row.scope || 'shared') === String(scope || 'shared'))
    .filter((row) => String(row.status || 'active') === 'active')
    .map((row) => ({
      id: String(row.memory_id || row.id || ''),
      content: String(row.content || row.normalized || ''),
      row,
    }));
  const dense = rankNeighborsByEmbedding(db, eligible, content, config);
  if (!dense) {
    return eligible
      .map((entry) => ({
        ...entry,
        similarity: jaccardSimilarity(content, entry.content),
        via: 'jaccard',
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.max(1, k));
  }
  const rrf = new Map();
  const cosineById = new Map();
  dense.forEach((d, index) => {
    rrf.set(d.id, (rrf.get(d.id) || 0) + 1 / (NEIGHBOR_RRF_K + index + 1));
    cosineById.set(d.id, d.cosine);
  });
  let ftsHits = [];
  try {
    ftsHits = searchFTS5(db, content, { topK: Math.max(20, k * 4) }) || [];
  } catch {
    ftsHits = [];
  }
  const eligibleIds = new Set(eligible.map((entry) => entry.id));
  ftsHits
    .filter((hit) => eligibleIds.has(String(hit.memory_id || '')))
    .forEach((hit, index) => {
      const id = String(hit.memory_id);
      rrf.set(id, (rrf.get(id) || 0) + 1 / (NEIGHBOR_RRF_K + index + 1));
    });
  return eligible
    .filter((entry) => rrf.has(entry.id))
    .map((entry) => ({
      ...entry,
      similarity: cosineById.has(entry.id)
        ? cosineById.get(entry.id)
        : jaccardSimilarity(content, entry.content),
      via: cosineById.has(entry.id) ? 'embedding' : 'jaccard',
      _rrf: rrf.get(entry.id) || 0,
    }))
    .sort((a, b) => Number(b._rrf || 0) - Number(a._rrf || 0))
    .slice(0, Math.max(1, k));
};

// U13c (5c): a row's memory_tier as the rest of the product resolves it — the
// persisted memory_claims projection (the same join recall/embedding use).
// Rows without a claims row (no world-model rebuild yet) resolve to '' and are
// treated as non-durable by the tie guard.
const resolveMemoryClaimTier = (db, memoryId) => {
  try {
    const row = db.prepare('SELECT memory_tier FROM memory_claims WHERE memory_id = ? LIMIT 1')
      .get(String(memoryId || ''));
    return normalizeMemoryTier(row?.memory_tier || '', '');
  } catch {
    return '';
  }
};

const queueReasonCode = (reason) => {
  if (reason === 'llm_unavailable') return 'llm_unavailable';
  if (reason === 'capture_note_parse_failed') return 'capture_parse_failed';
  if (reason === 'remember_intent_missing_note') return 'capture_missing_note';
  if (reason === 'semantic_borderline') return 'duplicate_semantic';
  if (reason === 'capture_contradiction_unverified') return 'capture_contradiction_unverified';
  return 'capture_review_required';
};

// ---------------------------------------------------------------------------
// captureFromEvent helpers (U17 fold, review #9). captureFromEvent is the
// sequencing shell; the decision-phase sub-concerns live in the named helpers
// below. Each helper is behavior-identical to the inline block it replaced:
// same counters, same ledger events, same queue rows, same write_records.
// ---------------------------------------------------------------------------

const adjudicateCaptureStates = ({
  db,
  config,
  event,
  decision: decisionIn,
  neighbors,
  summary,
  content,
  type,
  noteScope,
  queuePath,
  nowIso,
  cleanupVersion,
  runId,
  reviewVersion,
  logger,
}) => {
  let decision = decisionIn;
  // U11 (R8b): write-time state adjudication. The SAME decision call emits
  // one KEEP/STALE/REPLACE/UNKNOWN verdict per neighbor. Every verdict that
  // resolves to a real neighbor is recorded on the ledger (KEEP included —
  // no-op but recorded); a malformed field or an unresolvable neighbor id
  // degrades to the safe default KEEP with a loud warning. When the op
  // channel did not act (ADD/NOOP), the strongest adjudication escalates
  // through the EXISTING op paths — STALE→CONTRADICT (the U4 confidence
  // gate + exact-target rule below keep applying), REPLACE→UPDATE,
  // UNKNOWN→review queue — so retrieved-but-unacted evidence gets an
  // explicit state verdict instead of silently riding along.
  const adjudication = normalizeStateAdjudication(
    decision ? (decision.state_adjudication ?? decision.stateAdjudication) : undefined,
  );
  const adjudicated = [];
  for (const entry of adjudication.entries) {
    const neighbor = neighbors.find((n) => n.id === entry.id) || null;
    if (!neighbor) {
      adjudication.malformed = true;
      continue;
    }
    adjudicated.push({ ...entry, neighbor });
  }
  if (adjudication.malformed || decision?.adjudicationMalformed === true) {
    logger?.warn?.(`[gigabrain] capture state adjudication malformed — unresolved entries default to KEEP scope=${noteScope}`);
  }
  for (const entry of adjudicated) {
    summary[`adjudicated_${entry.state.toLowerCase()}`] += 1;
    try {
      recordAdjudication(db, {
        memoryId: entry.neighbor.id,
        state: entry.state,
        candidateContent: content,
        decisionOp: decision ? String(decision.op || '').toUpperCase() : '',
        confidence: entry.confidence,
        reason: entry.reason,
        scope: noteScope,
        agentId: event.agentId || null,
        runId: runId || '',
        reviewVersion: reviewVersion || '',
        cleanupVersion,
      }, { timestamp: nowIso });
      entry.ledgerRecorded = true;
    } catch (err) {
      // Half-write guard (review #24): the ledger is the audit trail for
      // WHY a supersession happened — an entry that failed to record must
      // not escalate below (an unrecorded escalation is unauditable). Warn
      // loudly; the op channel is unaffected.
      entry.ledgerRecorded = false;
      logger?.warn?.(`[gigabrain] adjudication ledger write failed — escalation suppressed for ${entry.neighbor.id} (${entry.state}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let op = decision ? String(decision.op || '').toUpperCase() : '';
  if ((op === 'ADD' || op === 'NOOP') && adjudicated.length > 0) {
    // U13c (2): with multiple same-state entries the HIGHEST-CONFIDENCE
    // one escalates (ties: higher neighbor similarity, then LLM output
    // order) — never the LLM's output order alone, which let a weak first
    // entry shadow a strong later one. Non-escalated entries were already
    // ledger-recorded above. Only LEDGER-RECORDED entries are eligible
    // (review #24): a STALE/REPLACE whose recordAdjudication failed must
    // not drive a supersession the audit trail cannot explain.
    const strongest = (state) => adjudicated
      .filter((entry) => entry.state === state && entry.ledgerRecorded === true)
      .reduce((best, entry) => {
        if (!best) return entry;
        const byConfidence = Number(entry.confidence || 0) - Number(best.confidence || 0);
        if (byConfidence > 0) return entry;
        if (byConfidence === 0
          && Number(entry.neighbor?.similarity || 0) > Number(best.neighbor?.similarity || 0)) return entry;
        return best;
      }, null);
    const stale = strongest('STALE');
    const replace = stale ? null : strongest('REPLACE');
    const unknown = stale || replace ? null : adjudicated.find((entry) => entry.state === 'UNKNOWN') || null;
    if (stale) {
      decision = { ...decision, op: 'CONTRADICT', targetId: stale.neighbor.id, confidence: stale.confidence, reason: stale.reason || decision.reason || 'state_adjudication: stale', __viaAdjudication: true };
      op = 'CONTRADICT';
    } else if (replace) {
      decision = { ...decision, op: 'UPDATE', targetId: replace.neighbor.id, confidence: replace.confidence, reason: replace.reason || decision.reason || 'state_adjudication: replace', __viaAdjudication: true };
      op = 'UPDATE';
    } else if (unknown) {
      // UNKNOWN → review queue: nothing is mutated, and the candidate is
      // preserved in the queue payload (excerpt keeps the pending row past
      // queue retention). reason_code stays in the retention-relevant set.
      summary.queued_review += 1;
      appendQueueRow(queuePath, {
        timestamp: nowIso,
        status: 'pending',
        reason: 'capture_adjudication_unknown',
        reason_code: queueReasonCode('capture_adjudication_unknown'),
        action: 'capture_review',
        matched_memory_id: unknown.neighbor.id,
        payload: {
          type,
          content,
          excerpt: content,
          scope: noteScope,
          state: 'UNKNOWN',
          target_id: unknown.neighbor.id,
          decision_op: op,
          decision_confidence: unknown.confidence,
          reason: unknown.reason || '',
        },
      }, {
        retentionConfig: config?.runtime?.reviewQueueRetention,
      });
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_queued_review',
        reason_codes: ['capture_adjudication_unknown'],
        memory_id: unknown.neighbor.id,
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          candidate_content: content,
          scope: noteScope,
          target_id: unknown.neighbor.id,
          state: 'UNKNOWN',
        },
      });
      return { decision, op, queuedUnknown: true };
    }
  }
  return { decision, op, queuedUnknown: false };
};

// CONTRADICT enactment (U13(d) arbiter consult + U13c tie semantics + the
// U12 bi-temporal supersession write). Extracted from captureFromEvent
// (review #9); every path finishes the candidate: unverified → review queue,
// target outranks / disallowed tie → review queue with the arbiter's signals,
// otherwise the candidate wins and recordVerdict closes the loser.
const enactCaptureContradict = ({
  db,
  config,
  event,
  note,
  decision,
  target,
  summary,
  content,
  normalized,
  type,
  noteScope,
  captureMode,
  eventContentTime,
  existing,
  writeNative,
  queuePath,
  nowIso,
  cleanupVersion,
  runId,
  reviewVersion,
  logger,
}) => {
  const contradictConfidence = clamp01(decision?.confidence ?? 0);
  if (!target || contradictConfidence < CONTRADICT_MIN_CONFIDENCE) {
    // Unverified contradiction — hallucinated/missing targetId or weak
    // decision confidence. Never guess the loser: queue for human review
    // instead (the candidate survives in the queue payload; nothing is
    // superseded).
    summary.queued_review += 1;
    appendQueueRow(queuePath, {
      timestamp: nowIso,
      status: 'pending',
      reason: 'capture_contradiction_unverified',
      reason_code: queueReasonCode('capture_contradiction_unverified'),
      action: 'capture_review',
      matched_memory_id: target ? target.id : '',
      payload: {
        type,
        content,
        // excerpt keeps the pending row past queue retention
        // (requireExcerptForPending) so the candidate is never lost.
        excerpt: content,
        scope: noteScope,
        op: 'CONTRADICT',
        target_id: String(decision?.targetId || ''),
        target_matched: Boolean(target),
        decision_confidence: contradictConfidence,
        reason: decision?.reason || '',
      },
    }, {
      retentionConfig: config?.runtime?.reviewQueueRetention,
    });
    appendEvent(db, {
      timestamp: nowIso,
      component: 'capture',
      action: 'capture_queued_review',
      reason_codes: ['capture_contradiction_unverified'],
      memory_id: target ? target.id : `candidate:${randomUUID()}`,
      cleanup_version: cleanupVersion,
      run_id: runId || '',
      review_version: reviewVersion || '',
      payload: {
        candidate_content: content,
        scope: noteScope,
        target_id: String(decision?.targetId || ''),
        target_matched: Boolean(target),
        decision_confidence: contradictConfidence,
      },
    });
    return { superseded: false };
  }
  // U13(d): CONTRADICT consults the arbitration rule before superseding —
  // capture can no longer bypass the arbiter. Target and candidate are
  // arbitrated as positions (trust tier > corroboration > recency,
  // honoring config.hostTrust); the candidate may only supersede when the
  // target does NOT outrank it on tier or (tie) support. Recency never
  // routes to the queue here: the candidate is the in-band assertion the
  // LLM just judged with ≥0.75 confidence (U4 gate above), not an
  // independently clock-stamped rival, so the skew window does not apply.
  const arbiterSettings = resolveArbiterSettings(config);
  const targetRowFull = (target.row && typeof target.row === 'object' && target.row.memory_id)
    ? target.row
    : (getCurrentMemory(db, target.id) || {});
  // U13c (4): the capture candidate is HOST-ATTRIBUTED — no source_agent
  // on the consult. event.agentId is free text; an unregistered id
  // ('spark-bridge', scope strings) hit the U13(b) registry cap and made
  // identical first-party captures arbitrate at 0.4 on one surface and
  // 0.74 on another. The host stamp is our own ingest stamp, so every
  // first-party surface consults at the uniform own_agent tier; the
  // registry cap keeps protecting INGESTED rows (host-memory-sync),
  // which keep their source_agent. Provenance is NOT lost: event.agentId
  // still flows to the ledger events and verdict below, exactly as before.
  const candidateBelief = {
    belief_id: '__candidate__',
    content,
    source_host: 'gigabrain',
    source_kind: 'capture',
    created_at: nowIso,
    content_time: note.content_time || eventContentTime || null,
    payload: { claim_value: content },
  };
  const targetContent = String(targetRowFull.content || target.content || '');
  const targetBelief = {
    belief_id: '__target__',
    content: targetContent,
    source_host: targetRowFull.source_host || null,
    source_agent: targetRowFull.source_agent || null,
    source_kind: targetRowFull.source_kind || null,
    created_at: targetRowFull.created_at || null,
    content_time: targetRowFull.content_time || null,
    payload: { claim_value: targetContent },
  };
  const positions = arbitratePositions([targetBelief, candidateBelief], arbiterSettings);
  const candidatePosition = positions.find((p) => p.rows.includes(candidateBelief));
  const targetPosition = positions.find((p) => p.rows.includes(targetBelief));
  const samePosition = candidatePosition === targetPosition;
  const targetOutranks = !samePosition && (
    targetPosition.maxTrust > candidatePosition.maxTrust
    || (targetPosition.maxTrust === candidatePosition.maxTrust
      && targetPosition.support > candidatePosition.support)
  );
  // The REAL signals used (no hardcoded 'recency'): which dimension
  // decided, both sides' tier/support, and the clustering method.
  const decidedBy = samePosition ? 'clustered'
    : targetPosition.maxTrust !== candidatePosition.maxTrust ? 'trust'
      : targetPosition.support !== candidatePosition.support ? 'support'
        : 'recency';
  const arbiterSignals = {
    decided_by: decidedBy,
    candidate_tier: candidatePosition.maxTrust,
    target_tier: targetPosition.maxTrust,
    candidate_support: candidatePosition.support,
    target_support: targetPosition.support,
    clustering: candidatePosition.clustering,
  };
  // U13c (5): tie semantics. A bare tie on trust AND support used to fall
  // through to supersession on every channel — rival-influenced session
  // text past the 0.75 gate could replace a genuine user fact. Channels
  // differ in intent strength:
  //  (a) a tie reached via U11 STALE/REPLACE escalation queues — the
  //      adjudication channel fires on every retrieved neighbor and is
  //      the wide attack surface;
  //  (b) a tie from a DIRECT CONTRADICT op (>= the U4 0.75 gate above)
  //      keeps superseding — legitimate first-party updates ("I moved to
  //      Graz") are equal-tier ties and must keep working;
  //  (c) a durable_personal target NEVER falls to a bare tie regardless
  //      of channel — durable personal facts require strictly greater
  //      trust or support. Tier comes from the persisted memory_claims
  //      projection; an unresolvable tier is treated as non-durable so
  //      pre-rebuild rows keep first-party update semantics.
  const equalTierTie = !samePosition
    && targetPosition.maxTrust === candidatePosition.maxTrust
    && targetPosition.support === candidatePosition.support;
  const tieQueueReason = equalTierTie && resolveMemoryClaimTier(db, target.id) === 'durable_personal'
    ? 'capture_contradiction_durable_tie'
    : equalTierTie && decision?.__viaAdjudication === true
      ? 'capture_contradiction_adjudication_tie'
      : '';
  if (targetOutranks || tieQueueReason) {
    // The standing target outranks the candidate (or a bare tie is not
    // allowed to supersede on this channel/tier) — never auto-supersede;
    // queue for review with the arbiter's signals attached.
    const queueReason = tieQueueReason || 'capture_contradiction_target_stronger';
    summary.queued_review += 1;
    appendQueueRow(queuePath, {
      timestamp: nowIso,
      status: 'pending',
      reason: queueReason,
      reason_code: queueReasonCode(queueReason),
      action: 'capture_review',
      matched_memory_id: target.id,
      payload: {
        type,
        content,
        // excerpt keeps the pending row past queue retention
        // (requireExcerptForPending) so the candidate is never lost.
        excerpt: content,
        scope: noteScope,
        op: 'CONTRADICT',
        target_id: target.id,
        decision_confidence: contradictConfidence,
        reason: decision?.reason || '',
        arbiter: arbiterSignals,
      },
    }, {
      retentionConfig: config?.runtime?.reviewQueueRetention,
    });
    appendEvent(db, {
      timestamp: nowIso,
      component: 'capture',
      action: 'capture_queued_review',
      reason_codes: [queueReason],
      memory_id: target.id,
      cleanup_version: cleanupVersion,
      run_id: runId || '',
      review_version: reviewVersion || '',
      payload: {
        candidate_content: content,
        scope: noteScope,
        target_id: target.id,
        decision_confidence: contradictConfidence,
        arbiter: arbiterSignals,
      },
    });
    return { superseded: false };
  }
  // Bi-temporal supersession: the candidate wins; recordVerdict closes the
  // loser (valid_until) and opens the winner (valid_from) at the same
  // verdict instant, atomically inside its savepoint (U12) — no close
  // happens here, so a failed verdict moves neither side.
  summary.llm_contradicted += 1;
  const winnerId = randomUUID();
  const winnerNative = captureMode.writeNative
    ? writeNative({ memoryId: winnerId, type, content, durable: captureMode.nativeDurable, scope: noteScope })
    : null;
  const winnerRow = upsertCurrentMemory(db, {
    memory_id: winnerId,
    type,
    content,
    normalized,
    source: 'capture',
    source_agent: event.agentId || null,
    source_session: event.sessionKey || null,
    source_layer: winnerNative?.source_path ? 'native' : 'registry',
    source_path: winnerNative?.source_path || null,
    source_line: winnerNative?.source_line ?? null,
    confidence: Number.isFinite(Number(note.confidence)) ? clamp01(note.confidence) : Number(config?.capture?.minConfidence ?? 0.65),
    scope: noteScope,
    status: 'active',
    created_at: nowIso,
    updated_at: nowIso,
    // U12: content_time is event-time metadata; the winner's valid_from is
    // stamped to the verdict instant by recordVerdict below (the flip
    // moment wins over content_time for arbitration).
    content_time: note.content_time || eventContentTime || null,
  });
  try {
    recordVerdict(db, {
      winnerId,
      loserIds: [target.id],
      signals: {
        source: 'llm_capture',
        op: 'CONTRADICT',
        via: decision?.__viaAdjudication === true ? 'state_adjudication' : 'decision_op',
        reason: decision?.reason || '',
        // U13(d): the consulted arbiter's real signals, not a stub.
        arbiter: arbiterSignals,
      },
      agentId: event.agentId || null,
      reason: ['capture_contradiction', decidedBy],
    }, { timestamp: nowIso });
  } catch (err) {
    // The winner memory is already captured; a verdict failure must not abort
    // the capture batch. recordVerdict is atomic (savepoint), so on failure the
    // loser stays active and surfaces on the next world-model rebuild rather
    // than being silently dropped.
    logger?.warn?.(`[gigabrain] capture verdict failed (loser stays active): ${err instanceof Error ? err.message : String(err)}`);
  }
  existing.push(winnerRow);
  // Remove the superseded loser from the working set so later candidates
  // in this batch don't dedupe against a closed row.
  const loserIdx = existing.findIndex((r) => String(r.memory_id || r.id || '') === target.id);
  if (loserIdx >= 0) existing.splice(loserIdx, 1);
  summary.inserted += 1;
  summary.inserted_ids.push(winnerId);
  summary.write_records.push({
    memory_id: winnerId,
    type,
    scope: noteScope,
    inserted: true,
    duplicate: 'llm_contradict',
    superseded_memory_id: target.id,
    written_native: winnerNative?.written === true,
    written_registry: true,
    source_path: winnerNative?.source_path || '',
    source_line: winnerNative?.source_line ?? null,
    source_kind: winnerNative?.source_kind || '',
  });
  return { superseded: true };
};

// ADD near-duplicate check (R8a): an LLM that says ADD on a near-duplicate
// must not bypass semantic dedup. Extracted from captureFromEvent (review
// #9). Returns true when the candidate was dropped as a near-duplicate (the
// caller finishes the candidate); false when the ADD is authoritative.
const applyCaptureAddNearDuplicate = ({
  db,
  config,
  neighbors,
  summary,
  content,
  type,
  noteScope,
  captureMode,
  writeNative,
  nowIso,
  cleanupVersion,
  runId,
  reviewVersion,
}) => {
  summary.llm_added += 1;
  const dedupAuto = clamp01(Number(config?.dedupe?.autoThreshold ?? 0.92) || 0.92);
  const nearDuplicate = config?.dedupe?.semanticEnabled !== false
    ? neighbors
      .filter((n) => String(n.row?.type || 'CONTEXT') === String(type || 'CONTEXT'))
      .reduce((best, n) => (!best || Number(n.similarity || 0) > Number(best.similarity || 0) ? n : best), null)
    : null;
  if (nearDuplicate && Number(nearDuplicate.similarity || 0) >= dedupAuto) {
    if (captureMode.writeNative) {
      writeNative({
        memoryId: nearDuplicate.id,
        type,
        content,
        durable: captureMode.nativeDurable,
        scope: noteScope,
      });
    }
    summary.dropped_semantic_duplicate += 1;
    appendEvent(db, {
      timestamp: nowIso,
      component: 'capture',
      action: 'capture_dropped_semantic_duplicate',
      reason_codes: ['duplicate_semantic', 'llm_add_near_duplicate'],
      memory_id: nearDuplicate.id,
      cleanup_version: cleanupVersion,
      run_id: runId || '',
      review_version: reviewVersion || '',
      similarity: Number(nearDuplicate.similarity || 0),
      matched_memory_id: nearDuplicate.id,
      payload: {
        candidate_content: content,
        matched_content: nearDuplicate.content,
        scope: noteScope,
        via: nearDuplicate.via || 'jaccard',
      },
    });
    summary.write_records.push({
      memory_id: nearDuplicate.id,
      type,
      scope: noteScope,
      inserted: false,
      duplicate: 'semantic',
      written_native: captureMode.writeNative === true,
      written_registry: false,
      source_path: captureMode.writeNative ? String(nearDuplicate.row?.source_path || '') : '',
      source_line: captureMode.writeNative ? (Number.isFinite(Number(nearDuplicate.row?.source_line)) ? Number(nearDuplicate.row.source_line) : null) : null,
      source_kind: captureMode.nativeDurable ? 'memory_md' : 'daily_note',
    });
    return true;
  }
  return false;
};

const captureFromEvent = ({
  db,
  config,
  event = {},
  logger,
  runId,
  reviewVersion = '',
  refreshDerived = true,
}) => {
  assertWriteAllowed({
    mode: resolveWriteMode(config),
    operation: 'capture.capture_from_event',
  });
  const policy = resolvePolicy(config);
  const scope = normalizeAgentScope(event.scope || event.agentId || 'shared');
  const sourceText = extractCandidateText(event);
  const rememberIntent = detectRememberIntent(event, config);
  // Explicit remember-intents may carry long runbooks/decisions: the default
  // 1200-char parser cap exists to keep passive transcript capture from
  // swallowing blobs, not to reject deliberate writes.
  const oversizedNotes = [];
  const notes = parseMemoryNotes(sourceText, {
    maxContentChars: rememberIntent ? 8000 : undefined,
    oversized: oversizedNotes,
  });
  const actions = config?.control?.memoryActions?.enabled === false ? [] : parseMemoryActions(sourceText);
  const rememberNotes = actions
    .filter((action) => action.action === 'remember')
    .map((action) => ({
      type: action.type,
      content: action.content,
      confidence: action.confidence,
      scope: action.scope || null,
      durability: action.durability || 'auto',
    }))
    .filter((note) => String(note.content || '').trim());
  const allNotes = [...notes, ...rememberNotes];
  const nowIso = new Date().toISOString();
  // U12: an event-level content_time ("this session is about events of <date>")
  // seeds valid_from for every fact captured from it, unless a per-fact
  // content_time from extraction is more specific. Absent both, valid_from
  // defaults to created_at inside upsertCurrentMemory.
  const eventContentTime = String(event.content_time || '').trim() || null;
  const cleanupVersion = String(config?.runtime?.cleanupVersion || 'v3.0.0');
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
  const memoryFlushTurn = detectMemoryFlushTurn(event);
  const captureLlm = resolveCaptureLlm({ config, event });
  if (captureLlm.enabled && captureLlm.decideSkippedReason) {
    logger?.warn?.(`[gigabrain] capture llm decision pass skipped: provider=${captureLlm.provider} reason=${captureLlm.decideSkippedReason}`);
  }

  const summary = {
    processed: 0,
    inserted: 0,
    rejected_junk: 0,
    dropped_exact_duplicate: 0,
    dropped_semantic_duplicate: 0,
    queued_review: 0,
    native_written: 0,
    native_daily_writes: 0,
    native_memory_writes: 0,
    native_only: 0,
    extracted_facts: 0,
    llm_added: 0,
    llm_updated: 0,
    llm_contradicted: 0,
    llm_noop: 0,
    llm_failed: 0,
    adjudicated_keep: 0,
    adjudicated_stale: 0,
    adjudicated_replace: 0,
    adjudicated_unknown: 0,
    actions_processed: 0,
    actions_applied: 0,
    actions_queued_review: 0,
    actions_inserted: 0,
    actions_superseded: 0,
    actions_rejected: 0,
    actions_protected: 0,
    actions_reinstated: 0,
    actions_do_not_store: 0,
    inserted_ids: [],
    write_records: [],
  };
  let worldModelDirty = false;
  let llmTransportFailed = false;

  // Phase 1 — extraction. When no tagged <memory_note> is present and the LLM is
  // enabled, distill atomic facts from the session so untagged facts are not
  // lost. A cloud provider must NEVER see the raw transcript, so extraction runs
  // only for local/injected providers; cloud capture relies on tagged notes.
  if (allNotes.length === 0 && captureLlm.enabled && typeof captureLlm.extract === 'function' && !captureLlm.isCloud) {
    try {
      const facts = captureLlm.extract(sourceText) || [];
      for (const fact of facts) {
        const content = String(fact?.content || '').trim();
        if (!content) continue;
        // Cheap correct pre-filter: never extract/store secret-bearing facts.
        if (containsSecret(content)) {
          summary.rejected_junk += 1;
          continue;
        }
        allNotes.push({
          type: normalizeType(fact?.type || inferTypeFromContent(content)),
          content,
          confidence: clamp01(fact?.confidence ?? DEFAULT_CONFIDENCE),
          scope: null,
          durability: 'auto',
          // U12: extraction-time event date ("moved to Graz in March") becomes
          // the stored content_time and thus the valid_from of the new row.
          content_time: String(fact?.content_time || '').trim() || null,
          __fromExtraction: true,
        });
        summary.extracted_facts += 1;
      }
    } catch (err) {
      // Loud failure: an LLM/transport outage must be distinguishable from
      // "no facts" — count it and let the no-notes review-queue path fire.
      llmTransportFailed = true;
      summary.llm_failed += 1;
      logger?.warn?.(`[gigabrain] llm extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const writeNative = ({ memoryId = '', type, content, durable, scope: noteScope = '' }) => {
    try {
      const result = writeNativeMemoryEntry({
        config,
        memoryId,
        type,
        content,
        durable,
        timestamp: nowIso,
        scope: noteScope,
      });
      if (result?.written) {
        summary.native_written += 1;
        if (result.source_kind === 'memory_md') summary.native_memory_writes += 1;
        else summary.native_daily_writes += 1;
      }
      return result;
    } catch (err) {
      logger?.warn?.(`[gigabrain] native write failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const actionSummary = applyMemoryActions({
    db,
    config,
    event: {
      ...event,
      scope,
    },
    actions,
    logger,
    runId,
    reviewVersion,
  });
  summary.actions_processed = Number(actionSummary.processed || 0);
  summary.actions_applied = Number(actionSummary.applied || 0);
  summary.actions_queued_review = Number(actionSummary.queued_review || 0);
  summary.actions_inserted = Number(actionSummary.inserted || 0);
  summary.actions_superseded = Number(actionSummary.superseded || 0);
  summary.actions_rejected = Number(actionSummary.rejected || 0);
  summary.actions_protected = Number(actionSummary.protected || 0);
  summary.actions_reinstated = Number(actionSummary.reinstated || 0);
  summary.actions_do_not_store = Number(actionSummary.do_not_store || 0);
  summary.queued_review += Number(actionSummary.queued_review || 0);
  summary.native_written += Number(actionSummary.native_written || 0);
  summary.native_daily_writes += Number(actionSummary.native_daily_writes || 0);
  summary.native_memory_writes += Number(actionSummary.native_memory_writes || 0);
  if (Array.isArray(actionSummary.inserted_ids)) summary.inserted_ids.push(...actionSummary.inserted_ids);
  if (summary.actions_applied > 0) worldModelDirty = true;
  if (actionSummary.blocked) {
    logger?.info?.('[gigabrain] capture blocked by do_not_store action');
    return summary;
  }

  const existing = listCurrentMemories(db, { statuses: ['active'], scope, limit: 5000 });

  // Park oversized notes individually (full content preserved) — regardless
  // of whether sibling notes survived. Secret pre-filter applies before any
  // content is persisted to the queue.
  for (const oversized of oversizedNotes) {
    if (!queuePath) break;
    if (containsSecret(oversized.content)) {
      summary.rejected_junk += 1;
      continue;
    }
    appendQueueRow(queuePath, {
      timestamp: nowIso,
      status: 'pending',
      reason: 'memory_note_oversized',
      reason_code: 'capture_note_oversized',
      action: 'capture_review',
      payload: {
        source: 'agent_end',
        type: String(oversized.type || ''),
        excerpt: redactMemoryText(String(oversized.content)).slice(0, 240),
        full_text: redactMemoryText(String(oversized.content)).slice(0, 16000),
      },
    }, {
      retentionConfig: config?.runtime?.reviewQueueRetention,
    });
    summary.queued_review += 1;
    logger?.warn?.(`[gigabrain] capture queued oversized note chars=${oversized.content.length} scope=${scope}`);
  }

  if (allNotes.length === 0 && oversizedNotes.length === 0) {
    const missingReason = rememberIntent
      ? 'remember_intent_missing_note'
      : shouldQueueNoNotes(llmTransportFailed ? { ...event, llmUnavailable: true } : event, sourceText);
    if (missingReason && config?.capture?.queueOnModelUnavailable !== false) {
      // Security hardening: this park used to persist RAW source text
      // (excerpt + 16k full_text) with no secret screening — the only
      // pipeline path that skipped the filter, feeding a world-readable
      // JSONL, the review-queue MCP tool, and the HTTP bridge. Secret-bearing
      // turns are rejected outright (credentials never persist); everything
      // else is redacted before parking.
      if (containsSecret(sourceText)) {
        summary.rejected_junk += 1;
        appendEvent(db, {
          timestamp: nowIso,
          component: 'capture',
          action: 'capture_rejected',
          reason_codes: ['secret_prefilter'],
          memory_id: `candidate:${randomUUID()}`,
          cleanup_version: cleanupVersion,
          run_id: runId || '',
          review_version: reviewVersion || '',
          payload: { scope, reason: missingReason },
        });
        logger?.warn?.(`[gigabrain] capture park rejected by secret prefilter scope=${scope}`);
        return summary;
      }
      const redactedSource = redactMemoryText(sourceText);
      const row = {
        timestamp: nowIso,
        status: 'pending',
        reason: missingReason,
        reason_code: queueReasonCode(missingReason),
        action: 'capture_review',
        payload: {
          source: 'agent_end',
          excerpt: buildQueueExcerpt(event, redactedSource),
          // A parked remember-intent is the ONLY copy of the content; a short
          // excerpt would destroy the remaining detail. Keep the full
          // (redacted) text so the entry stays recoverable/promotable.
          full_text: String(redactedSource || '').slice(0, 16000),
        },
      };
      appendQueueRow(queuePath, row, {
        retentionConfig: config?.runtime?.reviewQueueRetention,
      });
      summary.queued_review += 1;
      logger?.warn?.(`[gigabrain] capture queued reason=${missingReason} scope=${scope}`);
    }
    return summary;
  }

  for (const note of allNotes) {
    summary.processed += 1;
    const content = String(note.content || '').trim();
    // The model-authored note/action body is untrusted content. Scope is an
    // authority decision supplied by the host event envelope and cannot be
    // redirected with a `scope=` attribute in model output.
    const noteScope = scope;

    // Cheap, correct secret pre-filter — runs before junk/dedupe/LLM so a
    // credential-bearing candidate (API_KEY=/SECRET=/PASSWORD=/token) is never
    // embedded, sent to any provider, or stored.
    if (containsSecret(content)) {
      summary.rejected_junk += 1;
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_rejected',
        reason_codes: ['secret_prefilter'],
        memory_id: `candidate:${randomUUID()}`,
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: { scope: noteScope, type: note.type || '' },
      });
      continue;
    }

    const captureMode = resolveCaptureMode({
      note,
      noteScope,
      policy,
      rememberIntent,
      memoryFlushTurn,
      config,
    });
    const type = captureMode.type;
    const normalized = normalizeContent(content);
    const junk = detectJunk(content, {
      minChars: Math.max(1, Number(config?.capture?.minContentChars ?? policy.minContentChars)),
      junkPatterns: policy.junkPatterns,
      highValueShortEnabled: policy.highValueShortEnabled,
      highValueShortPatterns: policy.highValueShortPatterns,
    });

    // Explicit remember-intents bypass the junk heuristics: they exist to keep
    // passive transcript noise out, and a deliberate remember of paths, commit
    // hashes, or metrics is not noise. The secret pre-filter above still
    // applies unconditionally.
    if (junk.junk && !rememberIntent && config?.quality?.junkFilterEnabled !== false) {
      summary.rejected_junk += 1;
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_rejected',
        reason_codes: [junk.reason || 'junk_system_prompt'],
        memory_id: `candidate:${randomUUID()}`,
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          content,
          matched_pattern: junk.matchedPattern || null,
          scope,
          type,
        },
      });
      continue;
    }

    const plausibility = detectPlausibility({
      type,
      content,
      confidence: note.confidence,
    }, policy);
    if (
      type === 'USER_FACT'
      && Number(note.confidence ?? config?.capture?.minConfidence ?? 0.65) < 0.7
      && plausibility.actionableCount > 0
    ) {
      summary.queued_review += 1;
      appendQueueRow(queuePath, {
        timestamp: nowIso,
        status: 'pending',
        reason: 'capture_review_required',
        reason_code: queueReasonCode('capture_review_required'),
        action: 'capture_review',
        payload: {
          type,
          content,
          scope: noteScope,
          plausibility_flags: plausibility.flags,
          matched_pattern: plausibility.matchedPattern,
        },
      }, {
        retentionConfig: config?.runtime?.reviewQueueRetention,
      });
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_queued_review',
        reason_codes: ['capture_review_required', 'plausibility_flag'],
        memory_id: `candidate:${randomUUID()}`,
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          type,
          scope: noteScope,
          content,
          plausibility_flags: plausibility.flags,
          matched_pattern: plausibility.matchedPattern,
        },
      });
      continue;
    }

    if (captureMode.writeNative && captureMode.writeRegistry === false) {
      const nativeResult = writeNative({
        type,
        content,
        durable: captureMode.nativeDurable,
        scope: noteScope,
      });
      summary.native_only += nativeResult?.written ? 1 : 0;
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_native_written_only',
        reason_codes: ['native_only'],
        memory_id: `candidate:${randomUUID()}`,
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          type,
          scope: noteScope,
          source_path: nativeResult?.source_path || null,
          source_line: nativeResult?.source_line ?? null,
          source_kind: nativeResult?.source_kind || null,
        },
      });
      summary.write_records.push({
        memory_id: '',
        type,
        scope: noteScope,
        inserted: false,
        duplicate: '',
        written_native: nativeResult?.written === true,
        written_registry: false,
        source_path: nativeResult?.source_path || '',
        source_line: nativeResult?.source_line ?? null,
        source_kind: nativeResult?.source_kind || '',
      });
      continue;
    }

    const exact = findExactDuplicate(existing, normalized, noteScope);
    if (exact) {
      if (captureMode.writeNative) {
        writeNative({
          memoryId: String(exact.memory_id || exact.id),
          type,
          content,
          durable: captureMode.nativeDurable,
          scope: noteScope,
        });
      }
      summary.dropped_exact_duplicate += 1;
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_dropped_exact_duplicate',
        reason_codes: ['duplicate_exact'],
        memory_id: String(exact.memory_id || exact.id),
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          candidate_content: content,
          matched_memory_id: String(exact.memory_id || exact.id),
        },
      });
      summary.write_records.push({
        memory_id: String(exact.memory_id || exact.id || ''),
        type,
        scope: noteScope,
        inserted: false,
        duplicate: 'exact',
        written_native: captureMode.writeNative === true,
        written_registry: false,
        source_path: captureMode.writeNative ? String(exact.source_path || '') : '',
        source_line: captureMode.writeNative ? (Number.isFinite(Number(exact.source_line)) ? Number(exact.source_line) : null) : null,
        source_kind: captureMode.nativeDurable ? 'memory_md' : 'daily_note',
      });
      continue;
    }

    // Phase 2 — decision. When the LLM is enabled, retrieve k-nearest existing
    // memories and let the model emit exactly one of ADD/UPDATE/CONTRADICT/NOOP.
    // Cloud providers only ever see locally-redacted candidate facts (never the
    // raw transcript) and never the neighbor secret-bearing content. On any
    // failure we fall through to the heuristic jaccard path below.
    let llmHandled = false;
    if (captureLlm.enabled && typeof captureLlm.decide === 'function' && !llmTransportFailed) {
      const neighbors = selectNeighbors(existing, content, noteScope, { k: 5, db, config });
      const redact = captureLlm.isCloud ? redactMemoryText : ((value) => String(value || ''));
      let decision = null;
      try {
        decision = captureLlm.decide({
          candidate: redact(content),
          neighbors: neighbors.map((n) => ({ id: n.id, content: redact(n.content) })),
        });
      } catch (err) {
        // Loud failure: count the outage, flag the transport (queue path + fail-fast
        // circuit breaker — remaining candidates skip the dead LLM instead of each
        // burning a timeout), then degrade to the heuristic path below so the
        // candidate is never silently dropped.
        summary.llm_failed += 1;
        llmTransportFailed = true;
        logger?.warn?.(`[gigabrain] llm decision failed: ${err instanceof Error ? err.message : String(err)}`);
        decision = null;
      }
      // U11 (R8b) + U13c (2): per-neighbor KEEP/STALE/REPLACE/UNKNOWN state
      // adjudication — ledger recording plus escalation through the existing
      // op channels — runs in adjudicateCaptureStates (extracted, review #9).
      const adjudicationOutcome = adjudicateCaptureStates({
        db,
        config,
        event,
        decision,
        neighbors,
        summary,
        content,
        type,
        noteScope,
        queuePath,
        nowIso,
        cleanupVersion,
        runId,
        reviewVersion,
        logger,
      });
      decision = adjudicationOutcome.decision;
      const op = adjudicationOutcome.op;
      if (adjudicationOutcome.queuedUnknown) {
        llmHandled = true;
        continue;
      }
      const exactTarget = op === 'UPDATE' || op === 'CONTRADICT'
        ? (neighbors.find((n) => n.id === String(decision.targetId || '')) || null)
        : null;
      // Both UPDATE and CONTRADICT must resolve the EXACT target: UPDATE now
      // persists content onto the target (a closest-neighbor fallback would
      // destructively rewrite the wrong memory), and CONTRADICT supersedes.
      // A hallucinated/empty targetId falls through: UPDATE -> ADD path
      // (non-destructive), CONTRADICT -> review queue.
      const target = exactTarget;

      if (op === 'NOOP') {
        llmHandled = true;
        summary.llm_noop += 1;
        if (captureMode.writeNative) {
          writeNative({ type, content, durable: captureMode.nativeDurable, scope: noteScope });
        }
        appendEvent(db, {
          timestamp: nowIso,
          component: 'capture',
          action: 'capture_llm_noop',
          reason_codes: ['llm_noop'],
          memory_id: target ? target.id : `candidate:${randomUUID()}`,
          cleanup_version: cleanupVersion,
          run_id: runId || '',
          review_version: reviewVersion || '',
          payload: { candidate_content: content, scope: noteScope, reason: decision?.reason || '' },
        });
        summary.dropped_semantic_duplicate += 1;
        continue;
      }

      if (op === 'UPDATE' && target) {
        // Deterministic NOOP guard: an UPDATE whose candidate adds NO token
        // the target lacks would replace detailed wording with an equal-or-
        // vaguer restatement (the eval's decision-noop class). Downgrade to
        // NOOP — the ledger event names the guard. Morphology variants
        // ("peanut"/"peanuts") stay with the LLM decision; this only catches
        // certainly-information-free updates.
        {
          const guardRow = (target.row && typeof target.row === 'object' && target.row.memory_id)
            ? target.row
            : (getCurrentMemory(db, target.id) || {});
          const guardTarget = String(guardRow.normalized || '') || normalizeContent(String(guardRow.content || ''));
          const guardTokens = new Set(guardTarget.split(/\s+/).filter(Boolean));
          const candidateTokens = String(normalized || '').split(/\s+/).filter(Boolean);
          if (candidateTokens.length > 0 && candidateTokens.every((token) => guardTokens.has(token))) {
            llmHandled = true;
            summary.llm_noop += 1;
            if (captureMode.writeNative) {
              writeNative({ type, content, durable: captureMode.nativeDurable, scope: noteScope });
            }
            appendEvent(db, {
              timestamp: nowIso,
              component: 'capture',
              action: 'capture_llm_noop',
              reason_codes: ['llm_noop', 'update_subset_guard'],
              memory_id: target.id,
              cleanup_version: cleanupVersion,
              run_id: runId || '',
              review_version: reviewVersion || '',
              payload: { candidate_content: content, scope: noteScope, reason: 'update candidate is a token subset of the target' },
            });
            summary.dropped_semantic_duplicate += 1;
            continue;
          }
        }
        llmHandled = true;
        summary.llm_updated += 1;
        if (captureMode.writeNative) {
          writeNative({ memoryId: target.id, type, content, durable: captureMode.nativeDurable, scope: noteScope });
        }
        // Persist the refined fact onto the target row (revision, NOT
        // supersession): content + normalized move together (normalized_hash is
        // recomputed inside upsertCurrentMemory) so future dedup matches the new
        // wording; confidence never decreases.
        const targetRow = (target.row && typeof target.row === 'object' && target.row.memory_id)
          ? target.row
          : (getCurrentMemory(db, target.id) || {});
        const revisedRow = upsertCurrentMemory(db, {
          ...targetRow,
          memory_id: target.id,
          content,
          normalized,
          confidence: Math.max(
            Number.isFinite(Number(targetRow.confidence)) ? Number(targetRow.confidence) : 0,
            Number.isFinite(Number(note.confidence)) ? clamp01(note.confidence) : 0,
          ),
          updated_at: nowIso,
        });
        // Keep the in-batch working set in sync so later candidates dedupe
        // against the revised wording, not the stale one.
        const revisedIdx = existing.findIndex((r) => String(r.memory_id || r.id || '') === target.id);
        if (revisedIdx >= 0) existing[revisedIdx] = revisedRow;
        worldModelDirty = true;
        appendEvent(db, {
          timestamp: nowIso,
          component: 'capture',
          action: 'capture_llm_update',
          reason_codes: ['llm_update', 'revision'],
          memory_id: target.id,
          matched_memory_id: target.id,
          cleanup_version: cleanupVersion,
          run_id: runId || '',
          review_version: reviewVersion || '',
          payload: { candidate_content: content, previous_content: target.content, scope: noteScope, reason: decision?.reason || '' },
        });
        summary.dropped_semantic_duplicate += 1;
        summary.write_records.push({
          memory_id: target.id,
          type,
          scope: noteScope,
          inserted: false,
          duplicate: 'llm_update',
          written_native: captureMode.writeNative === true,
          written_registry: false,
          source_path: '',
          source_line: null,
          source_kind: captureMode.nativeDurable ? 'memory_md' : 'daily_note',
        });
        continue;
      }

      if (op === 'CONTRADICT') {
        // CONTRADICT enactment (incl. arbiter consult + tie semantics) runs in
        // enactCaptureContradict (extracted, review #9). Every outcome —
        // unverified → queue, outranked/tie → queue, supersede — finishes the
        // candidate.
        llmHandled = true;
        const contradictOutcome = enactCaptureContradict({
          db,
          config,
          event,
          note,
          decision,
          target,
          summary,
          content,
          normalized,
          type,
          noteScope,
          captureMode,
          eventContentTime,
          existing,
          writeNative,
          queuePath,
          nowIso,
          cleanupVersion,
          runId,
          reviewVersion,
          logger,
        });
        if (contradictOutcome.superseded) worldModelDirty = true;
        continue;
      }

      // op === 'ADD' -> the high-threshold semantic dedup backstop runs in
      // applyCaptureAddNearDuplicate (extracted, review #9); below the auto
      // threshold the ADD is authoritative. Unparseable/no-decision falls
      // through to the heuristic jaccard path (graceful degradation).
      if (op === 'ADD') {
        if (applyCaptureAddNearDuplicate({
          db,
          config,
          neighbors,
          summary,
          content,
          type,
          noteScope,
          captureMode,
          writeNative,
          nowIso,
          cleanupVersion,
          runId,
          reviewVersion,
        })) {
          continue;
        }
        llmHandled = true;
      }
    }

    if (!llmHandled && config?.dedupe?.semanticEnabled !== false) {
      const semantic = findSemanticDuplicate(existing, content, noteScope, type);
      const semanticThresholds = resolveSemanticThresholds(type, config);
      if (semantic && semantic.similarity >= Number(semanticThresholds.auto)) {
        if (captureMode.writeNative) {
          writeNative({
            memoryId: String(semantic.row.memory_id || semantic.row.id),
            type,
            content,
            durable: captureMode.nativeDurable,
            scope: noteScope,
          });
        }
        summary.dropped_semantic_duplicate += 1;
        appendEvent(db, {
          timestamp: nowIso,
          component: 'capture',
          action: 'capture_dropped_semantic_duplicate',
          reason_codes: ['duplicate_semantic'],
          memory_id: String(semantic.row.memory_id || semantic.row.id),
          cleanup_version: cleanupVersion,
          run_id: runId || '',
          review_version: reviewVersion || '',
          similarity: semantic.similarity,
          matched_memory_id: String(semantic.row.memory_id || semantic.row.id),
          payload: {
            candidate_content: content,
            matched_content: semantic.row.content,
            scope: noteScope,
          },
        });
        summary.write_records.push({
          memory_id: String(semantic.row.memory_id || semantic.row.id || ''),
          type,
          scope: noteScope,
          inserted: false,
          duplicate: 'semantic',
          written_native: captureMode.writeNative === true,
          written_registry: false,
          source_path: captureMode.writeNative ? String(semantic.row.source_path || '') : '',
          source_line: captureMode.writeNative ? (Number.isFinite(Number(semantic.row.source_line)) ? Number(semantic.row.source_line) : null) : null,
          source_kind: captureMode.nativeDurable ? 'memory_md' : 'daily_note',
        });
        continue;
      }
      if (semantic && semantic.similarity >= Number(semanticThresholds.review)) {
        summary.queued_review += 1;
        appendQueueRow(queuePath, {
          timestamp: nowIso,
          status: 'auto_rejected',
          reason: 'semantic_borderline',
          reason_code: queueReasonCode('semantic_borderline'),
          action: 'capture_review',
          similarity: semantic.similarity,
          matched_memory_id: String(semantic.row.memory_id || semantic.row.id),
          payload: {
            type,
            content,
            scope,
          },
        }, {
          retentionConfig: config?.runtime?.reviewQueueRetention,
        });
        appendEvent(db, {
          timestamp: nowIso,
          component: 'capture',
          action: 'capture_queued_review',
          reason_codes: ['duplicate_semantic'],
          memory_id: String(semantic.row.memory_id || semantic.row.id),
          cleanup_version: cleanupVersion,
          run_id: runId || '',
          review_version: reviewVersion || '',
          similarity: semantic.similarity,
          matched_memory_id: String(semantic.row.memory_id || semantic.row.id),
          payload: {
            candidate_content: content,
            scope: noteScope,
          },
        });
        continue;
      }
    }

    const memoryId = randomUUID();
    const nativeResult = captureMode.writeNative
      ? writeNative({
        memoryId,
        type,
        content,
        durable: captureMode.nativeDurable,
        scope: noteScope,
      })
      : null;
    // Projection row and ledger event must commit
    // atomically — a crash between the two autocommitted statements left a
    // memory with no provenance event. (The native FILE write above lives
    // outside the DB and stays best-effort.)
    db.exec('SAVEPOINT capture_insert');
    let row;
    try {
      row = upsertCurrentMemory(db, {
        memory_id: memoryId,
        type,
        content,
        normalized,
        source: 'capture',
        source_agent: event.agentId || null,
        source_session: event.sessionKey || null,
        source_layer: nativeResult?.source_path ? 'native' : 'registry',
        source_path: nativeResult?.source_path || null,
        source_line: nativeResult?.source_line ?? null,
        confidence: Number.isFinite(Number(note.confidence))
          ? clamp01(note.confidence)
          : Number(config?.capture?.minConfidence ?? 0.65),
        scope: noteScope,
        status: 'active',
        created_at: nowIso,
        updated_at: nowIso,
        // U12: extraction/event content_time opens the row's event-time interval
        // (upsertCurrentMemory derives valid_from = content_time, else created_at).
        content_time: note.content_time || eventContentTime || null,
      });
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_inserted',
        reason_codes: ['capture_success'],
        memory_id: memoryId,
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          type,
          scope: noteScope,
          source: 'agent_end',
        },
      });
      db.exec('RELEASE SAVEPOINT capture_insert');
    } catch (error) {
      try {
        db.exec('ROLLBACK TO SAVEPOINT capture_insert');
        db.exec('RELEASE SAVEPOINT capture_insert');
      } catch { /* keep the original error */ }
      throw error;
    }
    existing.push(row);
    summary.inserted += 1;
    summary.inserted_ids.push(memoryId);
    worldModelDirty = true;
    summary.write_records.push({
      memory_id: memoryId,
      type,
      scope: noteScope,
      inserted: true,
      duplicate: '',
      written_native: nativeResult?.written === true,
      written_registry: true,
      source_path: nativeResult?.source_path || '',
      source_line: nativeResult?.source_line ?? null,
      source_kind: nativeResult?.source_kind || '',
    });
  }

  if (worldModelDirty && refreshDerived !== false) {
    try {
      rebuildEntityMentions(db);
      if (config?.worldModel?.enabled !== false) {
        rebuildWorldModel({ db, config });
      } else {
        // U17: worldModel.enabled gates the world-model SURFACES only —
        // verdicts keep flowing through the extracted arbiter when it is OFF.
        runBeliefArbitration({ db, config, projectBeliefRows: projectArbitrationBeliefRows });
      }
    } catch (err) {
      logger?.warn?.(`[gigabrain] post-capture world model refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger?.info?.(`[gigabrain] capture processed=${summary.processed} inserted=${summary.inserted} junk=${summary.rejected_junk} exact=${summary.dropped_exact_duplicate} semantic=${summary.dropped_semantic_duplicate} queued=${summary.queued_review} native=${summary.native_written} llm_failed=${summary.llm_failed} actions=${summary.actions_applied}/${summary.actions_processed}`);
  return summary;
};

export {
  parseMemoryNotes,
  inferTypeFromContent,
  captureFromEvent,
  // idea #1 (transcript CDC harvester) reuses the SAME local-only extractor
  // seam capture exposes, so raw-transcript extraction rides the identical
  // ollama/injected path and the identical cloud-skip guard (isCloud===false).
  resolveCaptureLlm,
};

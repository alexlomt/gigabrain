import { buildHttpEndpoint } from './url-safety.js';
import { hasSecretRisk, redactHandoffText } from './host-memory-sync.js';

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MODEL = 'qwen3.5:9b';
const DEFAULT_TASK_PROFILES = Object.freeze({
  memory_review: Object.freeze({
    model: DEFAULT_MODEL,
    temperature: 0.15,
    top_p: 0.8,
    top_k: 20,
    max_tokens: 180,
    reasoning: 'off',
  }),
  extraction_json: Object.freeze({
    model: DEFAULT_MODEL,
    temperature: 0.1,
    top_p: 0.75,
    top_k: 20,
    max_tokens: 220,
    reasoning: 'off',
  }),
  // Two-phase LLM capture (U8): phase 1 distills atomic facts from a session;
  // phase 2 decides ADD/UPDATE/CONTRADICT/NOOP for a candidate vs k-nearest.
  capture_extraction: Object.freeze({
    model: DEFAULT_MODEL,
    temperature: 0.1,
    top_p: 0.75,
    top_k: 20,
    max_tokens: 512,
    reasoning: 'off',
  }),
  capture_decision: Object.freeze({
    model: DEFAULT_MODEL,
    temperature: 0.1,
    top_p: 0.7,
    top_k: 20,
    // U11: the decision JSON now carries one state_adjudication entry per
    // neighbor (uuid ids are token-heavy); 160 would truncate the object and
    // null the WHOLE decision. num_predict is a cap, not a target.
    max_tokens: 512,
    reasoning: 'off',
  }),
  memory_canonicalize: Object.freeze({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    top_p: 0.85,
    top_k: 30,
    max_tokens: 220,
    reasoning: 'off',
  }),
  chat_general: Object.freeze({
    model: 'qwen3.5:latest',
    temperature: 1,
    top_p: 0.95,
    top_k: 40,
    max_tokens: 1200,
    reasoning: 'default',
  }),
});

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const clampInt = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
};

const normalizeProvider = (provider) => {
  const key = String(provider || '').trim().toLowerCase();
  if (['openclaw', 'openai_compatible', 'ollama', 'none'].includes(key)) return key;
  return 'none';
};

const CLOUD_REVIEW_PROVIDERS = new Set(['openai_compatible', 'openclaw']);

const prepareReviewMemory = ({ provider, memory } = {}) => {
  if (!CLOUD_REVIEW_PROVIDERS.has(provider)) return { memory, skipped: false };

  const rawContent = String(memory?.content || '');
  // A credential-shaped row is never eligible for cloud review. Redacting and
  // sending it would still disclose that a credential exists and could miss a
  // novel secret shape, so fail closed before the network request is built.
  if (hasSecretRisk(rawContent)) {
    return { memory: null, skipped: true, reason: 'secret-risk' };
  }

  const content = redactHandoffText(rawContent);
  if (!content || hasSecretRisk(content)) {
    return { memory: null, skipped: true, reason: 'redaction-empty-or-unsafe' };
  }

  return {
    skipped: false,
    memory: {
      type: String(memory?.type || 'CONTEXT'),
      // Scope names can encode project or profile identifiers and are not
      // needed for the retention-quality decision.
      scope: 'redacted',
      content,
    },
  };
};

const normalizeReasoningMode = (value, fallback = 'off') => {
  const key = String(value || fallback).trim().toLowerCase();
  if (['off', 'default'].includes(key)) return key;
  return fallback;
};

const normalizeTaskProfiles = (rawProfiles = {}) => {
  const out = {};
  for (const [key, defaults] of Object.entries(DEFAULT_TASK_PROFILES)) {
    const raw = rawProfiles && typeof rawProfiles === 'object' ? rawProfiles[key] : null;
    out[key] = {
      model: String(raw?.model || defaults.model || DEFAULT_MODEL),
      temperature: clamp01(raw?.temperature ?? defaults.temperature),
      top_p: clamp01(raw?.top_p ?? defaults.top_p),
      top_k: clampInt(raw?.top_k ?? defaults.top_k, 1, 200, defaults.top_k),
      max_tokens: clampInt(raw?.max_tokens ?? defaults.max_tokens, 32, 8192, defaults.max_tokens),
      reasoning: normalizeReasoningMode(raw?.reasoning ?? defaults.reasoning, defaults.reasoning),
      // Optional sampling seed (eval determinism): no default — when unset the
      // request body carries no seed, so production sampling is unchanged.
      ...(Number.isFinite(Number(raw?.seed)) ? { seed: Math.trunc(Number(raw.seed)) } : {}),
    };
  }
  return out;
};

const resolveTaskProfile = ({ taskProfiles, profile, model } = {}) => {
  const normalizedProfiles = normalizeTaskProfiles(taskProfiles);
  const key = String(profile || 'memory_review').trim();
  const resolved = normalizedProfiles[key] || normalizedProfiles.memory_review || DEFAULT_TASK_PROFILES.memory_review;
  return {
    ...resolved,
    model: String(model || resolved.model || DEFAULT_MODEL),
  };
};

const buildReviewPrompt = ({ memory, deterministic }) => {
  const content = String(memory?.content || '').trim();
  const type = String(memory?.type || 'CONTEXT').trim().toUpperCase();
  const scope = String(memory?.scope || 'shared');
  const score = Number.isFinite(Number(deterministic?.value_score)) ? Number(deterministic.value_score).toFixed(4) : '0.5000';
  return [
    'You are reviewing one memory item for retention quality.',
    'Return ONLY compact JSON with this schema:',
    '{"decision":"keep|archive|reject|merge_candidate","confidence":0..1,"reason":"short string","canonical_hint":"optional short rewrite"}',
    'Rules:',
    '- Prefer keep/archive over reject unless clearly junk/system-wrapper.',
    '- Preserve user preference, durable user facts, ongoing goals, communication preferences, relationship memories, and agent identity memories.',
    '- Do not archive a memory only because it is emotional, relational, identity-shaping, or important to continuity between user and agent.',
    '- Reject only hard junk/system artifacts.',
    '- Prefer archive for malformed wording, broken noun phrases, or corrupted paraphrases.',
    '- Use canonical_hint only when the content looks corrupted but the core fact is still inferable.',
    '',
    `type=${type}`,
    `scope=${scope}`,
    `deterministic_value_score=${score}`,
    `deterministic_action=${String(deterministic?.action || 'keep')}`,
    `content=${JSON.stringify(content)}`,
  ].join('\n');
};

const extractJsonObject = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
};

const parseDecision = (value) => {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'keep') return 'keep';
  if (key === 'archive') return 'archive';
  if (key === 'reject') return 'reject';
  if (key === 'merge_candidate' || key === 'merge-candidate' || key === 'merge candidate') return 'merge_candidate';
  return null;
};

const parseLlmReview = (payload) => {
  const parsed = payload && typeof payload === 'object'
    ? payload
    : extractJsonObject(payload);
  if (parsed && typeof parsed === 'object') {
    const decision = parseDecision(parsed.decision);
    if (decision) {
      return {
        decision,
        confidence: clamp01(parsed.confidence ?? parsed.score ?? 0.5),
        reason: String(parsed.reason || '').trim().slice(0, 240),
        canonical_hint: String(parsed.canonical_hint || '').trim().slice(0, 240),
      };
    }
  }
  const text = String(payload || '').trim();
  if (!text) return null;
  const loose = text.match(/\b(keep|archive|reject|merge[_\-\s]?candidate)\b/i);
  if (!loose) return null;
  const decision = parseDecision(loose[1]);
  if (!decision) return null;
  return {
    decision,
    confidence: clamp01(0.5),
    reason: text.replace(/\s+/g, ' ').slice(0, 240),
    canonical_hint: '',
  };
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const reviewViaOpenAiCompatible = async ({
  baseUrl,
  model,
  apiKey,
  prompt,
  timeoutMs,
  profile,
}) => {
  const endpoint = buildHttpEndpoint(baseUrl, '/chat/completions', {
    label: 'OpenAI-compatible review endpoint',
  }).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const payload = {
    model: String(model || profile.model || 'gpt-4o-mini'),
    messages: [
      { role: 'system', content: 'Return compact JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: profile.temperature,
    top_p: profile.top_p,
    max_tokens: profile.max_tokens,
  };
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }, timeoutMs);
  if (!res.ok) {
    throw new Error(`openai_compatible http=${res.status}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return parseLlmReview(content);
};

const reviewViaOllama = async ({
  baseUrl,
  model,
  prompt,
  timeoutMs,
  profile,
}) => {
  const endpoint = buildHttpEndpoint(baseUrl, '/api/generate', {
    localOnly: true,
    label: 'Ollama review endpoint',
  }).toString();
  const payload = {
    model: String(model || profile.model || DEFAULT_MODEL),
    prompt,
    format: 'json',
    stream: false,
    options: {
      temperature: profile.temperature,
      top_p: profile.top_p,
      top_k: profile.top_k,
      num_predict: profile.max_tokens,
    },
  };
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, timeoutMs);
  if (!res.ok) {
    throw new Error(`ollama http=${res.status}`);
  }
  const data = await res.json();
  return parseLlmReview(data?.response || data?.thinking || data?.message?.content || '');
};

const reviewViaOpenclaw = async ({
  baseUrl,
  model,
  apiKey,
  prompt,
  timeoutMs,
  profile,
}) => {
  return reviewViaOpenAiCompatible({
    baseUrl: baseUrl || '',
    model: model || 'kimi-k2-instruct',
    apiKey,
    prompt,
    timeoutMs,
    profile,
  });
};

const reviewWithLlm = async ({
  provider,
  baseUrl,
  model,
  apiKey,
  timeoutMs,
  memory,
  deterministic,
  taskProfiles,
  profile,
}) => {
  const resolvedProvider = normalizeProvider(provider);
  if (resolvedProvider === 'none') {
    return {
      ok: false,
      provider: 'none',
      error: 'llm-provider-none',
      decision: null,
      confidence: null,
      reason: '',
    };
  }

  const prepared = prepareReviewMemory({ provider: resolvedProvider, memory });
  if (prepared.skipped) {
    return {
      ok: false,
      skipped: true,
      skipped_reason: prepared.reason,
      provider: resolvedProvider,
      error: `llm-review-skipped-${prepared.reason}`,
      decision: null,
      confidence: null,
      reason: '',
    };
  }

  const prompt = buildReviewPrompt({ memory: prepared.memory, deterministic });
  const resolvedProfile = resolveTaskProfile({
    taskProfiles,
    profile,
    model,
  });
  try {
    let parsed = null;
    if (resolvedProvider === 'openai_compatible') {
      parsed = await reviewViaOpenAiCompatible({
        baseUrl,
        model,
        apiKey,
        prompt,
        timeoutMs,
        profile: resolvedProfile,
      });
    } else if (resolvedProvider === 'ollama') {
      parsed = await reviewViaOllama({
        baseUrl: baseUrl || 'http://127.0.0.1:11434',
        model: model || resolvedProfile.model || DEFAULT_MODEL,
        prompt,
        timeoutMs,
        profile: resolvedProfile,
      });
    } else if (resolvedProvider === 'openclaw') {
      parsed = await reviewViaOpenclaw({
        baseUrl,
        model,
        apiKey,
        prompt,
        timeoutMs,
        profile: resolvedProfile,
      });
    }

    if (!parsed) {
      return {
        ok: false,
        provider: resolvedProvider,
        error: 'llm-empty-or-unparseable',
        decision: null,
        confidence: null,
        reason: '',
      };
    }
    return {
      ok: true,
      provider: resolvedProvider,
      error: null,
      decision: parsed.decision,
      confidence: clamp01(parsed.confidence),
      reason: parsed.reason || '',
      canonical_hint: parsed.canonical_hint || '',
    };
  } catch (err) {
    return {
      ok: false,
      provider: resolvedProvider,
      error: err instanceof Error ? err.message : String(err),
      decision: null,
      confidence: null,
      reason: '',
      canonical_hint: '',
    };
  }
};

// ---------------------------------------------------------------------------
// Two-phase LLM capture (U8)
//
// Transport note: both phases reuse the same provider transports as the review
// path. They return RAW model text; callers parse it. A `generate` function can
// be injected (tests, or alternative routers) so the pipeline can be exercised
// deterministically WITHOUT a live model.
// ---------------------------------------------------------------------------

const generateRawText = async ({
  provider,
  baseUrl,
  model,
  apiKey,
  prompt,
  timeoutMs,
  profile,
}) => {
  const resolvedProvider = normalizeProvider(provider);
  if (resolvedProvider === 'ollama') {
    const endpoint = buildHttpEndpoint(baseUrl || 'http://127.0.0.1:11434', '/api/generate', {
      localOnly: true,
      label: 'Ollama generation endpoint',
    }).toString();
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: String(model || profile.model || DEFAULT_MODEL),
        prompt,
        format: 'json',
        stream: false,
        options: {
          temperature: profile.temperature,
          top_p: profile.top_p,
          top_k: profile.top_k,
          num_predict: profile.max_tokens,
          ...(Number.isFinite(profile.seed) ? { seed: profile.seed } : {}),
        },
      }),
    }, timeoutMs);
    if (!res.ok) throw new Error(`ollama http=${res.status}`);
    const data = await res.json();
    return data?.response || data?.message?.content || '';
  }
  // openai_compatible + openclaw share the chat-completions transport.
  const endpoint = buildHttpEndpoint(baseUrl, '/chat/completions', {
    label: 'OpenAI-compatible generation endpoint',
  }).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: String(model || profile.model || 'gpt-4o-mini'),
      messages: [
        { role: 'system', content: 'Return compact JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: profile.temperature,
      top_p: profile.top_p,
      max_tokens: profile.max_tokens,
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(`openai_compatible http=${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
};

const ALLOWED_CAPTURE_TYPES = new Set(['USER_FACT', 'PREFERENCE', 'DECISION', 'ENTITY', 'EPISODE', 'AGENT_IDENTITY', 'CONTEXT']);

const normalizeCaptureType = (value) => {
  const key = String(value || '').trim().toUpperCase();
  if (key === 'FACT' || key === 'USERFACT') return 'USER_FACT';
  return ALLOWED_CAPTURE_TYPES.has(key) ? key : 'USER_FACT';
};

const buildExtractionPrompt = (transcript) => [
  'You distill durable, atomic memory facts from an assistant/user session.',
  'Return ONLY compact JSON: {"facts":[{"type":"USER_FACT|PREFERENCE|DECISION|ENTITY|EPISODE|AGENT_IDENTITY|CONTEXT","content":"one self-contained fact","confidence":0..1}]}',
  'Rules:',
  '- One atomic fact per item; each must stand alone without the transcript.',
  '- Capture durable user facts, preferences, decisions, entities, and identity.',
  '- Skip transient chit-chat, system wrappers, and tool noise.',
  '- Never invent facts not present in the text. If nothing durable, return {"facts":[]}.',
  '',
  `transcript=${JSON.stringify(String(transcript || '').slice(0, 8000))}`,
].join('\n');

const parseExtraction = (raw) => {
  const parsed = raw && typeof raw === 'object' ? raw : extractJsonObject(raw);
  const list = Array.isArray(parsed?.facts) ? parsed.facts : (Array.isArray(parsed) ? parsed : []);
  const facts = [];
  for (const item of list) {
    const content = String(item?.content || item?.text || '').replace(/\s+/g, ' ').trim();
    if (!content || content.length > 1200) continue;
    facts.push({
      type: normalizeCaptureType(item?.type),
      content,
      confidence: clamp01(item?.confidence ?? 0.7),
    });
  }
  return facts;
};

// U11 (R8b): write-time state adjudication. The decision pass emits one
// KEEP/STALE/REPLACE/UNKNOWN verdict per retrieved neighbor in the SAME call
// (KTD5: one schema change, no second LLM call). This normalizer is shared by
// the raw-text parse path and capture-service's injected-hook seam: anything
// that is not a well-formed entry degrades to the safe default — the entry is
// dropped, i.e. KEEP — and flips `malformed` so the caller can warn loudly.
const ADJUDICATION_STATES = Object.freeze(['KEEP', 'STALE', 'REPLACE', 'UNKNOWN']);

const normalizeStateAdjudication = (raw) => {
  if (raw === undefined || raw === null) return { entries: [], malformed: false };
  if (!Array.isArray(raw)) return { entries: [], malformed: true };
  const entries = [];
  let malformed = false;
  const seen = new Set();
  for (const item of raw) {
    const id = String(item?.id || item?.target_id || item?.memory_id || '').trim();
    const state = String(item?.state || item?.adjudication || '').trim().toUpperCase();
    if (!id || !ADJUDICATION_STATES.includes(state) || seen.has(id)) {
      malformed = true;
      continue;
    }
    seen.add(id);
    entries.push({
      id,
      state,
      confidence: clamp01(item?.confidence ?? 0.6),
      reason: String(item?.reason || '').trim().slice(0, 240),
    });
  }
  return { entries, malformed };
};

const parseCaptureDecision = (raw) => {
  const parsed = raw && typeof raw === 'object' ? raw : extractJsonObject(raw);
  const opKey = String(parsed?.op || parsed?.operation || parsed?.decision || '').trim().toUpperCase();
  const op = ['ADD', 'UPDATE', 'CONTRADICT', 'NOOP'].includes(opKey) ? opKey : null;
  if (!op) return null;
  const adjudication = normalizeStateAdjudication(parsed?.state_adjudication ?? parsed?.stateAdjudication);
  return {
    op,
    targetId: String(parsed?.target_id || parsed?.targetId || parsed?.id || '').trim(),
    confidence: clamp01(parsed?.confidence ?? 0.6),
    reason: String(parsed?.reason || '').trim().slice(0, 240),
    stateAdjudication: adjudication.entries,
    adjudicationMalformed: adjudication.malformed,
  };
};

const buildDecisionPrompt = ({ candidate, neighbors }) => {
  const lines = (Array.isArray(neighbors) ? neighbors : []).map((n, index) => (
    `  ${index + 1}. id=${String(n.id || '')} :: ${JSON.stringify(String(n.content || '').slice(0, 280))}`
  ));
  return [
    'You maintain a memory store. Given a NEW candidate fact and the k most similar existing memories, choose exactly ONE operation, then adjudicate the state of EACH listed memory against the candidate.',
    'Return ONLY compact JSON: {"op":"ADD|UPDATE|CONTRADICT|NOOP","target_id":"<id when UPDATE/CONTRADICT>","confidence":0..1,"reason":"short","state_adjudication":[{"id":"<neighbor id>","state":"KEEP|STALE|REPLACE|UNKNOWN","confidence":0..1}]}',
    'Definitions:',
    '- ADD: genuinely new information, no existing memory covers it.',
    '- UPDATE: a paraphrase/refinement of an existing memory (same fact, better wording or more detail) — set target_id.',
    '- CONTRADICT: directly conflicts with an existing memory (the new fact supersedes the old) — set target_id.',
    '- NOOP: already fully captured by an existing memory; nothing to do.',
    'State adjudication (one entry per listed memory):',
    '- KEEP: still true; the candidate does not affect it.',
    '- STALE: no longer true given the candidate, even when nothing negates it explicitly (implicit invalidation, e.g. a new value for the same fact slot).',
    '- REPLACE: the candidate is a compatible refinement of it; the candidate wording should replace it.',
    '- UNKNOWN: cannot determine from the texts whether it still holds.',
    '',
    `candidate=${JSON.stringify(String(candidate || '').slice(0, 600))}`,
    'neighbors:',
    ...(lines.length > 0 ? lines : ['  (none)']),
  ].join('\n');
};

/**
 * Phase 1 — extraction. Distills atomic facts from a session transcript.
 * Returns { ok, provider, facts: [{type, content, confidence}], error }.
 * provider==='none' short-circuits with ok=false so callers degrade.
 */
const extractFactsWithLlm = async ({
  provider,
  baseUrl,
  model,
  apiKey,
  timeoutMs,
  transcript,
  taskProfiles,
  profile = 'capture_extraction',
  generate,
} = {}) => {
  const resolvedProvider = normalizeProvider(provider);
  if (resolvedProvider === 'none' && typeof generate !== 'function') {
    return { ok: false, provider: 'none', error: 'llm-provider-none', facts: [] };
  }
  const resolvedProfile = resolveTaskProfile({ taskProfiles, profile, model });
  const prompt = buildExtractionPrompt(transcript);
  try {
    const rawText = typeof generate === 'function'
      ? await generate({ phase: 'extraction', prompt, transcript, profile: resolvedProfile })
      : await generateRawText({ provider: resolvedProvider, baseUrl, model, apiKey, prompt, timeoutMs, profile: resolvedProfile });
    return { ok: true, provider: resolvedProvider, error: null, facts: parseExtraction(rawText) };
  } catch (err) {
    return { ok: false, provider: resolvedProvider, error: err instanceof Error ? err.message : String(err), facts: [] };
  }
};

/**
 * Phase 2 — decision. Emits exactly one of ADD | UPDATE | CONTRADICT | NOOP for
 * a candidate fact against its k-nearest neighbors.
 * Returns { ok, provider, op, targetId, confidence, reason, error }.
 */
const decideCaptureWithLlm = async ({
  provider,
  baseUrl,
  model,
  apiKey,
  timeoutMs,
  candidate,
  neighbors = [],
  taskProfiles,
  profile = 'capture_decision',
  generate,
} = {}) => {
  const resolvedProvider = normalizeProvider(provider);
  if (resolvedProvider === 'none' && typeof generate !== 'function') {
    return { ok: false, provider: 'none', error: 'llm-provider-none', op: null };
  }
  const resolvedProfile = resolveTaskProfile({ taskProfiles, profile, model });
  const prompt = buildDecisionPrompt({ candidate, neighbors });
  try {
    const rawText = typeof generate === 'function'
      ? await generate({ phase: 'decision', prompt, candidate, neighbors, profile: resolvedProfile })
      : await generateRawText({ provider: resolvedProvider, baseUrl, model, apiKey, prompt, timeoutMs, profile: resolvedProfile });
    const decision = parseCaptureDecision(rawText);
    if (!decision) {
      return { ok: false, provider: resolvedProvider, error: 'llm-empty-or-unparseable', op: null };
    }
    return { ok: true, provider: resolvedProvider, error: null, ...decision };
  } catch (err) {
    return { ok: false, provider: resolvedProvider, error: err instanceof Error ? err.message : String(err), op: null };
  }
};

export {
  DEFAULT_TASK_PROFILES,
  normalizeProvider,
  normalizeTaskProfiles,
  resolveTaskProfile,
  buildReviewPrompt,
  parseLlmReview,
  reviewWithLlm,
  buildExtractionPrompt,
  parseExtraction,
  extractFactsWithLlm,
  buildDecisionPrompt,
  parseCaptureDecision,
  normalizeStateAdjudication,
  decideCaptureWithLlm,
};

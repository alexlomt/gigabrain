import fs from 'node:fs';
import path from 'node:path';

import { captureFromEvent } from './capture-service.js';
import { appendEvent } from './event-store.js';
import { listCurrentMemories, normalizeProjectionScope, updateCurrentStatus } from './projection-store.js';
import { completeMemoryJson, rejectOpenClawMaintenanceFallback, resolveMemoryLlmConfig } from './memory-llm-client.js';
import { acquireQueueLock } from './review-queue.js';

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_ALLOWED_REASONS = Object.freeze([
  'capture_missing_note',
  'capture_review_required',
  'capture_parse_failed',
  'llm_unavailable',
  'duplicate_semantic',
]);
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([750, 2000, 5000]);
const QUEUE_REVIEW_MAX_ATTEMPTS = 3;
const CAPTURE_REASONS = new Set([
  'capture_missing_note',
  'capture_review_required',
  'capture_parse_failed',
  'llm_unavailable',
]);
const MEMORY_TYPES = new Set([
  'USER_FACT',
  'PREFERENCE',
  'DECISION',
  'ENTITY',
  'EPISODE',
  'AGENT_IDENTITY',
  'CONTEXT',
]);

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const normalizeProvider = (provider) => {
  const key = String(provider || '').trim().toLowerCase();
  if (['openclaw', 'openai_compatible', 'ollama', 'none'].includes(key)) return key;
  return 'none';
};
const normalizeStringArray = (value) => (
  Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []
);
const normalizeReasonCode = (row = {}) => {
  const raw = row.reason_code || row.reason || '';
  const normalized = String(raw || '').trim().toLowerCase();
  // Older capture rows used reason=semantic_borderline with the generic
  // capture_review_required reason_code. Treat those as duplicate review rows
  // so nightly resolves them as semantic duplicate decisions instead of trying
  // to re-store the candidate and appending another borderline row.
  if (normalized === 'capture_review_required'
    && String(row.reason || '').trim().toLowerCase() === 'semantic_borderline') {
    return 'duplicate_semantic';
  }
  if (normalized === 'semantic_borderline') return 'duplicate_semantic';
  return normalized;
};
const classifyQueueReviewError = (value = '') => {
  const text = String(value || '').toLowerCase();
  if (text.includes('429') || text.includes('quota') || text.includes('rate limit')) return 'provider_rate_limited';
  if (text.includes('timeout') || text.includes('abort')) return 'timeout_or_aborted';
  if (text.includes('fetch failed') || text.includes('econn') || text.includes('network')) return 'network';
  if (text.includes('missing_api_key') || text.includes('requires_stateless_memory_llm')) return 'configuration';
  if (text.includes('invalid') || text.includes('parse')) return 'invalid_payload';
  return text ? 'error' : '';
};
const nextQueueReviewRetryAt = (attempts = 1, now = Date.now()) => {
  const minutes = Math.min(60, Math.max(1, 2 ** Math.max(0, Number(attempts || 1) - 1)));
  return new Date(now + minutes * 60 * 1000).toISOString();
};
const isPendingRow = (row = {}, now = Date.now()) => {
  const status = String(row.status || 'pending').trim().toLowerCase();
  if (status === 'pending') return true;
  if (status !== 'failed_retryable') return false;
  const nextAttemptAt = Date.parse(String(row.next_attempt_at || ''));
  return !Number.isFinite(nextAttemptAt) || nextAttemptAt <= now;
};
const parseQueueRows = (raw = '') => String(raw || '').split(/\r?\n/).filter(Boolean).map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}).filter(Boolean);
const stableQueueRowKey = (row = {}) => JSON.stringify({
  queued_at: row?.queued_at || '',
  timestamp: row?.timestamp || '',
  reason: row?.reason || '',
  reason_code: row?.reason_code || '',
  action: row?.action || '',
  memory_id: row?.memory_id || '',
  matched_memory_id: row?.matched_memory_id || '',
  winner_memory_id: row?.winner_memory_id || '',
  loser_memory_id: row?.loser_memory_id || '',
  similarity: row?.similarity ?? '',
  payload: row?.payload || null,
});
const writeReviewedRowsWithoutClobberingAppends = ({ queuePath, originalRows = [], reviewedRows = [] } = {}) => {
  if (!queuePath) return { written: false, updated: 0, currentRows: 0 };
  const replacements = new Map();
  for (const row of reviewedRows) {
    const key = stableQueueRowKey(originalRows[row.__review_index] || row);
    if (key) replacements.set(key, { ...row });
  }
  const lock = acquireQueueLock(queuePath);
  try {
    const currentRows = fs.existsSync(queuePath) ? parseQueueRows(fs.readFileSync(queuePath, 'utf8')) : [];
    let updated = 0;
    const nextRows = currentRows.map((row) => {
      const key = stableQueueRowKey(row);
      const replacement = replacements.get(key);
      if (!replacement) return row;
      updated += 1;
      const { __review_index, ...clean } = replacement;
      return clean;
    });
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, `${nextRows.map((row) => JSON.stringify(row)).join('\n')}${nextRows.length > 0 ? '\n' : ''}`);
    return { written: true, updated, currentRows: currentRows.length };
  } finally {
    lock.release();
  }
};
const safeJson = (value) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ error: 'json_stringify_failed' });
  }
};
const truncate = (value, limit = 1200) => {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
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
const escapeXml = (value = '') => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');
const toTimestampSlug = (iso = new Date().toISOString()) => String(iso)
  .replaceAll(':', '')
  .replaceAll('-', '')
  .replace(/\.\d+Z$/, 'Z');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  const res = await fetch(url, {
    ...options,
    signal: controller.signal,
  });
  const clear = () => clearTimeout(timeout);
  const originalJson = res.json.bind(res);
  const originalText = res.text.bind(res);
  res.json = async () => {
    try {
      return await originalJson();
    } finally {
      clear();
    }
  };
  res.text = async () => {
    try {
      return await originalText();
    } finally {
      clear();
    }
  };
  return res;
};

const resolveTaskProfile = ({ taskProfiles, profile, model } = {}) => {
  const raw = taskProfiles && typeof taskProfiles === 'object' ? taskProfiles : {};
  const fallback = raw.memory_review && typeof raw.memory_review === 'object'
    ? raw.memory_review
    : {};
  const selected = raw[String(profile || 'memory_review').trim()] && typeof raw[String(profile || 'memory_review').trim()] === 'object'
    ? raw[String(profile || 'memory_review').trim()]
    : fallback;
  return {
    model: String(model || selected.model || fallback.model || ''),
    temperature: clamp01(selected.temperature ?? fallback.temperature ?? 0.15),
    top_p: clamp01(selected.top_p ?? fallback.top_p ?? 0.8),
    top_k: Math.max(1, Math.min(200, Math.round(Number(selected.top_k ?? fallback.top_k ?? 20) || 20))),
    max_tokens: Math.max(32, Math.min(8192, Math.round(Number(selected.max_tokens ?? fallback.max_tokens ?? 180) || 180))),
    reasoning: ['off', 'default'].includes(String(selected.reasoning ?? fallback.reasoning ?? 'off'))
      ? String(selected.reasoning ?? fallback.reasoning ?? 'off')
      : 'off',
  };
};

const requestJsonViaOpenAiCompatible = async ({
  baseUrl,
  apiKey,
  model,
  timeoutMs,
  prompt,
  profile,
}) => {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const payload = {
    model: String(model || profile.model || ''),
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
  if (!res.ok) throw new Error(`openai_compatible http=${res.status}`);
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
};

const requestJsonViaOllama = async ({
  baseUrl,
  model,
  timeoutMs,
  prompt,
  profile,
}) => {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/api/generate`;
  const payload = {
    model: String(model || profile.model || ''),
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
  if (!res.ok) throw new Error(`ollama http=${res.status}`);
  const data = await res.json();
  return String(data?.response ?? '').trim();
};

const parseQueueDecision = (payload) => {
  const parsed = payload && typeof payload === 'object' ? payload : extractJsonObject(payload);
  if (!parsed || typeof parsed !== 'object') return null;
  const rawDecision = String(parsed.decision || parsed.action || '').trim().toLowerCase();
  const aliases = {
    keep: 'store',
    create: 'store',
    create_memory: 'store',
    store_memory: 'store',
    ignore: 'dismiss',
    reject: 'dismiss',
    archive: 'dismiss',
    archive_duplicate: 'archive_loser',
    archive_loser_memory: 'archive_loser',
    keepboth: 'keep_both',
    keep_both: 'keep_both',
    'keep-both': 'keep_both',
  };
  const decision = ['store', 'dismiss', 'archive_loser', 'keep_both'].includes(rawDecision)
    ? rawDecision
    : (aliases[rawDecision] || null);
  if (!decision) return null;
  const type = String(parsed.type || parsed.memory_type || '').trim().toUpperCase();
  return {
    decision,
    confidence: clamp01(parsed.confidence ?? parsed.score ?? 0.5),
    reason: truncate(String(parsed.reason || '').replace(/\s+/g, ' ').trim(), 240),
    type: MEMORY_TYPES.has(type) ? type : '',
    content: truncate(String(parsed.content || parsed.memory_content || '').replace(/\s+/g, ' ').trim(), 240),
    scope: truncate(String(parsed.scope || '').trim(), 120),
  };
};

const buildCapturePrompt = ({ row, reasonCode, defaultScope }) => {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  return [
    'You are reviewing one pending Gigabrain memory-capture queue row for fully automatic nightly resolution.',
    'Return ONLY compact JSON with this schema:',
    '{"decision":"store|dismiss","confidence":0..1,"type":"USER_FACT|PREFERENCE|DECISION|ENTITY|EPISODE|AGENT_IDENTITY|CONTEXT","content":"short memory or empty","scope":"optional scope or empty","reason":"short string"}',
    'Rules:',
    '- Choose store only if exactly one short, concrete, durable memory is clearly inferable.',
    '- Choose dismiss for progress chatter, audit chatter, install summaries, transient tool output, partial logs, or ambiguous excerpts.',
    '- Never include secrets, credentials, API keys, tokens, or sensitive host posture.',
    '- content must be one fact only, under 220 chars, with no markdown or quotes.',
    '- Prefer PREFERENCE, DECISION, USER_FACT, or CONTEXT when applicable.',
    '- Use scope only if you are confident; otherwise leave it empty.',
    '',
    `reason_code=${reasonCode}`,
    `default_scope=${defaultScope}`,
    `row_status=${String(row?.status || 'pending')}`,
    `row_timestamp=${String(row?.timestamp || '')}`,
    `excerpt=${JSON.stringify(truncate(payload.excerpt || payload.content || row?.excerpt || '', 1200))}`,
    `content_hint=${JSON.stringify(truncate(payload.content || '', 400))}`,
    `type_hint=${JSON.stringify(String(payload.type || ''))}`,
    `plausibility_flags=${safeJson(payload.plausibility_flags || [])}`,
    `source=${JSON.stringify(String(payload.source || row?.source || ''))}`,
  ].join('\n');
};

const buildDuplicatePrompt = ({ row, winner, loser }) => {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  return [
    'You are reviewing one pending Gigabrain semantic-duplicate queue row for fully automatic nightly resolution.',
    'Return ONLY compact JSON with this schema:',
    '{"decision":"archive_loser|keep_both","confidence":0..1,"reason":"short string"}',
    'Rules:',
    '- Choose archive_loser only if winner and loser clearly express the same durable fact and the winner is at least as good.',
    '- If you are unsure, choose keep_both.',
    '',
    `similarity=${Number.isFinite(Number(row?.similarity)) ? Number(row.similarity).toFixed(4) : '0.0000'}`,
    `winner_memory_id=${JSON.stringify(String(payload.memory_id || row?.winner_memory_id || row?.memory_id || winner?.memory_id || ''))}`,
    `loser_memory_id=${JSON.stringify(String(payload.matched_memory_id || row?.loser_memory_id || row?.matched_memory_id || loser?.memory_id || ''))}`,
    `winner_content=${JSON.stringify(truncate(winner?.content || payload.content || '', 500))}`,
    `loser_content=${JSON.stringify(truncate(loser?.content || payload.matched_content || '', 500))}`,
  ].join('\n');
};

const buildPrompt = ({ row, reasonCode, winner, loser, defaultScope }) => {
  if (reasonCode === 'duplicate_semantic') return buildDuplicatePrompt({ row, winner, loser });
  return buildCapturePrompt({ row, reasonCode, defaultScope });
};

const resolveRowScope = (row = {}, decision = {}) => {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const raw = String(
    decision.scope
    || row.scope
    || payload.scope
    || payload.default_scope
    || 'shared',
  ).trim() || 'shared';
  return normalizeProjectionScope(raw, { allowEmpty: true }) || 'shared';
};

const buildMemoryNote = ({ type, content, confidence, scope }) => {
  const attrs = [`type="${escapeXml(type)}"`, `confidence="${String(Math.max(0.7, clamp01(confidence)).toFixed(2))}"`];
  if (scope) attrs.push(`scope="${escapeXml(scope)}"`);
  return `<memory_note ${attrs.join(' ')}>${escapeXml(content)}</memory_note>`;
};

const writeArtifact = ({ config, runId, summary, items }) => {
  const outputDir = String(config?.runtime?.paths?.outputDir || '').trim();
  if (!outputDir) return '';
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = toTimestampSlug(new Date().toISOString());
  const filePath = path.join(outputDir, `memory-queue-review-${stamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    ok: true,
    generated_at: new Date().toISOString(),
    run_id: runId || '',
    summary,
    items,
  }, null, 2));
  return filePath;
};

const reviewQueueRowWithLlm = async ({ row, config, winner, loser }) => {
  const reasonCode = normalizeReasonCode(row);
  const memoryLlm = resolveMemoryLlmConfig(config);
  const provider = normalizeProvider(config?.llm?.provider || 'none');
  if (!memoryLlm.enabled && provider === 'none') return { ok: false, error: 'llm_disabled' };
  const profileKey = String(config?.llm?.queueReview?.profile || 'memory_review').trim() || 'memory_review';
  const profile = resolveTaskProfile({
    taskProfiles: config?.llm?.taskProfiles,
    profile: profileKey,
    model: memoryLlm.enabled ? (memoryLlm.model || config?.llm?.model) : config?.llm?.model,
  });
  const timeoutMs = Math.max(1000, Number(config?.llm?.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const defaultScope = resolveRowScope(row, {});
  const prompt = buildPrompt({ row, reasonCode, winner, loser, defaultScope });
  let raw = '';
  if (memoryLlm.enabled) {
    raw = await completeMemoryJson({
      config,
      prompt,
      profile,
    });
  } else if (provider === 'openclaw' || provider === 'openai_compatible') {
    rejectOpenClawMaintenanceFallback({
      provider,
      baseUrl: config?.llm?.baseUrl,
      task: 'queue_review',
    });
    raw = await requestJsonViaOpenAiCompatible({
      baseUrl: config?.llm?.baseUrl,
      apiKey: config?.llm?.apiKey,
      model: config?.llm?.model,
      timeoutMs,
      prompt,
      profile,
    });
  } else if (provider === 'ollama') {
    raw = await requestJsonViaOllama({
      baseUrl: config?.llm?.baseUrl,
      model: config?.llm?.model,
      timeoutMs,
      prompt,
      profile,
    });
  } else {
    return { ok: false, error: `unsupported_provider:${provider}` };
  }
  const parsed = parseQueueDecision(raw);
  if (!parsed) {
    return { ok: false, error: 'invalid_llm_payload', raw };
  }
  return { ok: true, prompt, raw, parsed };
};

const isRetryableReviewError = (value) => {
  const text = String(value || '').toLowerCase();
  return text.includes('http=500')
    || text.includes('http=502')
    || text.includes('http=503')
    || text.includes('http=504')
    || text.includes('http=429')
    || text.includes('timeout')
    || text.includes('fetch failed')
    || text.includes('abort');
};

const withTimeout = async (promise, timeoutMs, label = 'operation') => {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), Math.max(1000, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const reviewWithRetries = async ({ reviewer, payload, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, logger = console }) => {
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [...DEFAULT_RETRY_DELAYS_MS];
  const queueReviewTimeoutMs = Math.max(
    1000,
    Number(payload?.config?.llm?.queueReview?.timeoutMs || payload?.config?.llm?.timeoutMs || 45000) || 45000,
  );
  let lastResult = null;
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const result = await withTimeout(reviewer(payload), queueReviewTimeoutMs, 'queue-review row');
      if (result?.ok === true) return { ...result, attempts: attempt + 1 };
      lastResult = result;
      if (!isRetryableReviewError(result?.error) || attempt >= delays.length) {
        return { ...(result || { ok: false, error: 'review_failed' }), attempts: attempt + 1 };
      }
    } catch (err) {
      lastError = err;
      if (!isRetryableReviewError(err instanceof Error ? err.message : String(err)) || attempt >= delays.length) {
        throw err;
      }
      if (logger?.warn) {
        logger.warn(`[gigabrain] queue-review retry attempt=${attempt + 1} reason=${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await sleep(delays[attempt]);
  }
  if (lastError) throw lastError;
  return { ...(lastResult || { ok: false, error: 'review_failed' }), attempts: delays.length + 1 };
};

const resolveDuplicateContext = (db, row = {}) => {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const active = listCurrentMemories(db, { statuses: ['active'] });
  const byId = new Map(active.map((item) => [String(item.memory_id), item]));
  const winner = byId.get(String(payload.memory_id || row?.winner_memory_id || row?.memory_id || '')) || null;
  const loser = byId.get(String(payload.matched_memory_id || row?.loser_memory_id || row?.matched_memory_id || '')) || null;
  return { winner, loser };
};

const defaultSummary = ({ queuePath, dryRun, runId }) => ({
  ok: true,
  enabled: false,
  dryRun,
  runId,
  queuePath,
  totalRows: 0,
  pendingRows: 0,
  reviewed: 0,
  stored: 0,
  duplicateArchived: 0,
  dismissed: 0,
  keptBoth: 0,
  failed: 0,
  skipped: 0,
  artifactPath: '',
  items: [],
});

const reviewPendingQueue = async ({
  db,
  config,
  dryRun = false,
  runId = '',
  reviewVersion = '',
  logger = console,
  reviewer = reviewQueueRowWithLlm,
} = {}) => {
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
  const summary = defaultSummary({ queuePath, dryRun, runId });
  const queueReview = config?.llm?.queueReview || {};
  if (queueReview?.enabled !== true) {
    return {
      ...summary,
      reason: 'disabled',
    };
  }
  summary.enabled = true;
  if (!queuePath || !fs.existsSync(queuePath)) {
    return {
      ...summary,
      reason: 'queue_missing',
    };
  }
  const rows = parseQueueRows(fs.readFileSync(queuePath, 'utf8'));
  const originalRows = rows.map((row) => JSON.parse(JSON.stringify(row)));
  summary.totalRows = rows.length;
  summary.pendingRows = rows.filter((row) => isPendingRow(row)).length;
  const allowedReasons = new Set(
    normalizeStringArray(queueReview.allowedReasons).length > 0
      ? normalizeStringArray(queueReview.allowedReasons).map((item) => item.toLowerCase())
      : [...DEFAULT_ALLOWED_REASONS],
  );
  const limit = Math.max(0, Math.min(5000, Number(queueReview.limit ?? 200) || 200));
  const minConfidence = clamp01(queueReview.minConfidence ?? 0.8);
  const resolveFailedAs = String(queueReview.resolveFailedAs || '').trim().toLowerCase();
  const resolveFailedReviews = resolveFailedAs === 'dismiss' || resolveFailedAs === 'keep_both';
  const retryDelaysMs = Array.isArray(queueReview.retryDelaysMs)
    ? queueReview.retryDelaysMs.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item >= 0)
    : undefined;
  const resolveFailedReview = ({ row, reasonCode, error }) => {
    if (!resolveFailedReviews) return false;
    const rowNow = new Date().toISOString();
    const isDuplicate = reasonCode === 'duplicate_semantic';
    row.status = 'resolved_auto';
    row.auto_resolved = true;
    row.resolved_at = rowNow;
    row.updated_at = rowNow;
    row.resolved_reason = isDuplicate ? 'queue_review_failed_keep_both' : 'queue_review_failed_dismiss';
    row.auto_review = {
      at: rowNow,
      confidence: 0,
      reason: `queue review failed closed: ${String(error || 'review_failed').slice(0, 180)}`,
      decision: isDuplicate ? 'keep_both' : 'dismiss',
      review_version: reviewVersion || '',
      run_id: runId || '',
      error: String(error || 'review_failed').slice(0, 240),
    };
    if (isDuplicate) summary.keptBoth += 1;
    else summary.dismissed += 1;
    summary.items.push({
      reasonCode,
      status: dryRun
        ? (isDuplicate ? 'would_keep_both_failed' : 'would_dismiss_failed')
        : (isDuplicate ? 'kept_both_failed' : 'dismissed_failed'),
      error: String(error || 'review_failed').slice(0, 240),
      dryRun,
    });
    return true;
  };
  const targetIndexes = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!isPendingRow(row)) continue;
    const reasonCode = normalizeReasonCode(row);
    if (!allowedReasons.has(reasonCode)) continue;
    targetIndexes.push(index);
    if (targetIndexes.length >= limit) break;
  }
  for (const index of targetIndexes) {
    const row = rows[index];
    row.__review_index = index;
    const reasonCode = normalizeReasonCode(row);
    let duplicateContext = { winner: null, loser: null };
    if (reasonCode === 'duplicate_semantic') duplicateContext = resolveDuplicateContext(db, row);
    let reviewed;
    try {
      reviewed = await reviewWithRetries({
        reviewer,
        payload: {
          row,
          config,
          winner: duplicateContext.winner,
          loser: duplicateContext.loser,
        },
        retryDelaysMs,
        logger,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (resolveFailedReview({ row, reasonCode, error })) continue;
      const attempts = Number(row.attempts || 0) + 1;
      const retryable = isRetryableReviewError(error) && attempts < QUEUE_REVIEW_MAX_ATTEMPTS;
      const rowNow = new Date().toISOString();
      row.status = retryable ? 'failed_retryable' : 'failed_terminal';
      row.attempts = attempts;
      row.updated_at = rowNow;
      row.error_class = classifyQueueReviewError(error);
      row.error_message = error;
      row.error = error;
      row.next_attempt_at = retryable ? nextQueueReviewRetryAt(attempts) : '';
      summary.failed += 1;
      summary.items.push({
        reasonCode,
        status: row.status,
        error,
      });
      continue;
    }
    if (!reviewed?.ok || !reviewed?.parsed) {
      const error = reviewed?.error || 'review_failed';
      if (resolveFailedReview({ row, reasonCode, error })) continue;
      const attempts = Number(row.attempts || 0) + 1;
      const retryable = isRetryableReviewError(error) && attempts < QUEUE_REVIEW_MAX_ATTEMPTS;
      const rowNow = new Date().toISOString();
      row.status = retryable ? 'failed_retryable' : 'failed_terminal';
      row.attempts = attempts;
      row.updated_at = rowNow;
      row.error_class = classifyQueueReviewError(error);
      row.error_message = error;
      row.error = error;
      row.next_attempt_at = retryable ? nextQueueReviewRetryAt(attempts) : '';
      summary.failed += 1;
      summary.items.push({
        reasonCode,
        status: row.status,
        error,
      });
      continue;
    }
    summary.reviewed += 1;
    const decision = reviewed.parsed;
    const rowNow = new Date().toISOString();
    const baseDecision = {
      at: rowNow,
      confidence: decision.confidence,
      reason: decision.reason,
      decision: decision.decision,
      review_version: reviewVersion || '',
      run_id: runId || '',
    };

    if (reasonCode === 'duplicate_semantic') {
      const loserId = String(row?.payload?.matched_memory_id || row?.loser_memory_id || row?.matched_memory_id || duplicateContext.loser?.memory_id || '').trim();
      const winnerId = String(row?.payload?.memory_id || row?.winner_memory_id || row?.memory_id || duplicateContext.winner?.memory_id || '').trim();
      const shouldArchive = decision.decision === 'archive_loser' && decision.confidence >= minConfidence && loserId && winnerId;
      if (shouldArchive && !dryRun) {
        updateCurrentStatus(db, loserId, 'archived', {
          archived_at: rowNow,
          last_reviewed_at: rowNow,
          superseded_by: winnerId,
        });
        appendEvent(db, {
          component: 'queue_review',
          action: 'auto_archive_duplicate',
          memory_id: loserId,
          matched_memory_id: winnerId,
          similarity: Number.isFinite(Number(row?.similarity)) ? Number(row.similarity) : null,
          payload: {
            source: 'nightly_queue_review',
            reason: decision.reason,
            confidence: decision.confidence,
          },
        }, {
          cleanup_version: config?.runtime?.cleanupVersion,
          run_id: runId,
          review_version: reviewVersion,
        });
      }
      row.status = 'resolved_auto';
      row.auto_resolved = true;
      row.resolved_at = rowNow;
      row.updated_at = rowNow;
      row.resolved_reason = shouldArchive ? 'queue_review_duplicate_archive' : 'queue_review_keep_both';
      row.auto_review = baseDecision;
      if (shouldArchive) summary.duplicateArchived += 1;
      else summary.keptBoth += 1;
      summary.items.push({
        reasonCode,
        status: shouldArchive ? 'duplicate_archived' : 'kept_both',
        confidence: decision.confidence,
        reason: decision.reason,
        memory_id: winnerId,
        matched_memory_id: loserId,
        dryRun,
      });
      continue;
    }

    const type = MEMORY_TYPES.has(String(decision.type || '').trim().toUpperCase())
      ? String(decision.type || '').trim().toUpperCase()
      : 'CONTEXT';
    const content = truncate(String(decision.content || '').replace(/\s+/g, ' ').trim(), 220);
    const shouldStore = CAPTURE_REASONS.has(reasonCode)
      && decision.decision === 'store'
      && decision.confidence >= minConfidence
      && content.length >= 8;
    const scope = resolveRowScope(row, decision);

    if (shouldStore && !dryRun) {
      const xml = buildMemoryNote({
        type,
        content,
        confidence: Math.max(minConfidence, decision.confidence),
        scope,
      });
      const captureSummary = captureFromEvent({
        db,
        config,
        event: {
          scope,
          source: 'nightly_queue_review',
          output: xml,
        },
        logger,
        runId,
        reviewVersion,
      });
      row.status = 'resolved_auto';
      row.auto_resolved = true;
      row.resolved_at = rowNow;
      row.updated_at = rowNow;
      row.resolved_reason = captureSummary.inserted > 0
        ? 'queue_review_store'
        : (captureSummary.dropped_exact_duplicate > 0 || captureSummary.dropped_semantic_duplicate > 0
          ? 'queue_review_duplicate_noop'
          : 'queue_review_store_noop');
      row.auto_review = {
        ...baseDecision,
        type,
        content,
        scope,
        capture: captureSummary,
      };
      if (captureSummary.inserted > 0) summary.stored += 1;
      else summary.dismissed += 1;
      summary.items.push({
        reasonCode,
        status: captureSummary.inserted > 0 ? 'stored' : 'store_noop',
        confidence: decision.confidence,
        reason: decision.reason,
        type,
        content,
        scope,
        capture: captureSummary,
        dryRun,
      });
      continue;
    }

    row.status = 'resolved_auto';
    row.auto_resolved = true;
    row.resolved_at = rowNow;
    row.updated_at = rowNow;
    row.resolved_reason = shouldStore ? 'queue_review_store_dry_run' : 'queue_review_dismiss';
    row.auto_review = {
      ...baseDecision,
      type: shouldStore ? type : '',
      content: shouldStore ? content : '',
      scope: shouldStore ? scope : '',
    };
    if (shouldStore) summary.stored += 1;
    else summary.dismissed += 1;
    summary.items.push({
      reasonCode,
      status: shouldStore ? 'would_store' : 'dismissed',
      confidence: decision.confidence,
      reason: decision.reason,
      type: shouldStore ? type : '',
      content: shouldStore ? content : '',
      scope: shouldStore ? scope : '',
      dryRun,
    });
  }

  if (!dryRun) {
    const reviewedRows = targetIndexes.map((index) => rows[index]).filter(Boolean);
    const writeSummary = writeReviewedRowsWithoutClobberingAppends({
      queuePath,
      originalRows,
      reviewedRows,
    });
    summary.skipped += Math.max(0, reviewedRows.length - Number(writeSummary.updated || 0));
  }
  summary.artifactPath = writeArtifact({
    config,
    runId,
    summary: {
      totalRows: summary.totalRows,
      pendingRows: summary.pendingRows,
      reviewed: summary.reviewed,
      stored: summary.stored,
      duplicateArchived: summary.duplicateArchived,
      dismissed: summary.dismissed,
      keptBoth: summary.keptBoth,
      failed: summary.failed,
      skipped: summary.skipped,
      dryRun,
    },
    items: summary.items,
  });
  return summary;
};

export {
  DEFAULT_ALLOWED_REASONS,
  parseQueueDecision,
  reviewPendingQueue,
  reviewQueueRowWithLlm,
};

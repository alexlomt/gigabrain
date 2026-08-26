import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { completeMemoryJson } from './memory-llm-client.js';
import { captureFromEvent } from '../core/capture-service.js';
import { updateCurrentStatus } from '../core/projection-store.js';
import { acquireQueueLock } from '../core/review-queue.js';
import { atomicWriteFileSync, readFileIfExistsSync } from '../core/safe-fs.js';

const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_ROWS = 20;
const MAX_ATTEMPTS = 3;
const DEFAULT_ALLOWED_REASONS = Object.freeze([
  'capture_missing_note',
  'capture_parse_failed',
  'capture_review_required',
  'duplicate_semantic',
  'llm_unavailable',
]);
const REVIEW_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    confidence: { maximum: 1, minimum: 0, type: 'number' },
    content: { maxLength: 1200, type: 'string' },
    decision: { enum: ['store', 'dismiss', 'archive_loser', 'keep_both'], type: 'string' },
    reason: { maxLength: 240, type: 'string' },
    scope: { maxLength: 256, type: 'string' },
    type: { maxLength: 64, type: 'string' },
  },
  required: ['confidence', 'decision', 'reason'],
  type: 'object',
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clean = (value, max = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const clampLimit = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(MAX_REVIEW_ROWS, Math.trunc(numeric))) : MAX_REVIEW_ROWS;
};
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const nowIso = (clock) => new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString();

const readQueue = (queuePath) => {
  const snapshot = readFileIfExistsSync(queuePath, 'utf8', { maxBytes: MAX_QUEUE_BYTES });
  if (!snapshot.exists) return { exists: false, raw: '', rows: [] };
  if (!snapshot.stat?.isFile?.() || Number(snapshot.stat.nlink) !== 1) {
    throw new Error('QUEUE_REVIEW_QUEUE_INVALID');
  }
  const rows = [];
  for (const line of snapshot.data.split(/\r?\n/).filter(Boolean)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error('QUEUE_REVIEW_QUEUE_INVALID');
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('QUEUE_REVIEW_QUEUE_INVALID');
    rows.push(row);
  }
  return { exists: true, raw: snapshot.data, rows };
};

const rowIdentity = (row = {}) => sha256(canonicalJson({
  action: row.action || '',
  id: row.id || '',
  memory_id: row.memory_id || '',
  payload: row.payload || null,
  queued_at: row.queued_at || '',
  reason: row.reason || '',
  reason_code: row.reason_code || '',
  timestamp: row.timestamp || '',
}));
const reasonCode = (row = {}) => {
  const code = String(row.reason_code || row.reason || '').trim().toLowerCase();
  if (code === 'semantic_borderline') return 'duplicate_semantic';
  if (code === 'capture_review_required' && String(row.reason || '').toLowerCase() === 'semantic_borderline') {
    return 'duplicate_semantic';
  }
  return code;
};
const isDue = (row, atMs) => {
  const status = String(row?.status || 'pending').trim().toLowerCase();
  if (status === 'pending') return true;
  if (status !== 'failed_retryable') return false;
  const due = Date.parse(String(row?.next_attempt_at || ''));
  return !Number.isFinite(due) || due <= atMs;
};

const parseDecision = (value) => {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error('QUEUE_REVIEW_MODEL_RESPONSE_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('QUEUE_REVIEW_MODEL_RESPONSE_INVALID');
  }
  const decision = String(parsed.decision || '').trim().toLowerCase();
  const confidence = Number(parsed.confidence);
  if (
    !['store', 'dismiss', 'archive_loser', 'keep_both'].includes(decision)
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
  ) throw new Error('QUEUE_REVIEW_MODEL_RESPONSE_INVALID');
  return {
    confidence,
    content: clean(parsed.content, 1200),
    decision,
    reason: clean(parsed.reason),
    scope: clean(parsed.scope, 256),
    type: clean(parsed.type, 64).toUpperCase(),
  };
};

const buildPrompt = (row) => {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  return [
    'Review one queued durable-memory candidate. Return JSON only.',
    'Choose store only for one atomic durable fact; dismiss transient or ambiguous chatter.',
    'For duplicate rows choose archive_loser only when both memories state the same fact; otherwise keep_both.',
    'Never return secrets, credentials, raw tool output, or host-security posture.',
    JSON.stringify({
      action: row.action || '',
      candidate: clean(payload.content || payload.excerpt || '', 1200),
      matched_memory_id: row.matched_memory_id || payload.matched_memory_id || '',
      memory_id: row.memory_id || payload.memory_id || '',
      reason_code: reasonCode(row),
      scope: payload.scope || row.scope || 'shared',
      type: payload.type || '',
    }),
  ].join('\n');
};

const defaultReviewer = async ({ config, row }) => {
  const profileName = String(config?.llm?.queueReview?.profile || 'memory_review');
  const profile = config?.llm?.taskProfiles?.[profileName] || config?.llm?.taskProfiles?.memory_review || {};
  const raw = await completeMemoryJson({
    config,
    jsonSchema: REVIEW_SCHEMA,
    profile,
    prompt: buildPrompt(row),
  });
  return parseDecision(raw);
};

const escapeXml = (value) => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const defaultApplyDecision = async ({ config, db, decision, row, runId }) => {
  if (decision.decision === 'dismiss') return { dismissed: 1 };
  if (decision.decision === 'keep_both') return { keptBoth: 1 };
  if (decision.decision === 'archive_loser') {
    const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
    const loser = String(row.loser_memory_id || row.matched_memory_id || payload.matched_memory_id || '').trim();
    const winner = String(row.winner_memory_id || row.memory_id || payload.memory_id || '').trim();
    if (!db || !loser || !winner || loser === winner) throw new Error('QUEUE_REVIEW_DUPLICATE_CONTEXT_INVALID');
    updateCurrentStatus(db, loser, 'archived', { superseded_by: winner, timestamp: new Date().toISOString() });
    return { duplicateArchived: 1 };
  }
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const content = clean(decision.content || payload.content || payload.excerpt || '', 1200);
  const type = decision.type || String(payload.type || 'CONTEXT').trim().toUpperCase();
  const scope = decision.scope || String(payload.scope || row.scope || 'shared').trim() || 'shared';
  if (!db || content.length < 1) throw new Error('QUEUE_REVIEW_STORE_CONTEXT_INVALID');
  const note = `<memory_note type="${escapeXml(type)}" confidence="${decision.confidence.toFixed(2)}" scope="${escapeXml(scope)}">${escapeXml(content)}</memory_note>`;
  const result = await captureFromEvent({
    config,
    db,
    event: { agentId: scope, output: note, scope, sessionKey: `queue-review:${scope}` },
    logger: { info() {}, warn() {} },
    runId,
  });
  return { stored: Number(result?.inserted || 0) };
};

const classifyError = (error) => {
  const text = String(error?.message || error || '').toLowerCase();
  if (/429|http_(?:500|502|503|504)|fetch failed|econn|network|timeout|abort/.test(text)) {
    return { errorClass: 'provider_unavailable', retryable: true };
  }
  if (/disabled|provider_rejected|loopback|required|recursion|configuration/.test(text)) {
    return { errorClass: 'configuration', retryable: false };
  }
  return { errorClass: 'invalid_payload', retryable: false };
};
const retryAt = (attempts, atMs) => new Date(atMs + Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000).toISOString();
const payloadHash = (row) => sha256(canonicalJson(row?.payload || null));
const terminalRow = ({ row, decision, at, runId }) => ({
  attempts: Number(row.attempts || 0) + 1,
  id: row.id || undefined,
  payload_hash: payloadHash(row),
  queued_at: row.queued_at || row.timestamp || '',
  reason_code: reasonCode(row),
  resolved_at: at,
  resolved_confidence: decision.confidence,
  resolved_decision: decision.decision,
  resolved_reason: clean(decision.reason || `queue_review_${decision.decision}`),
  run_id: String(runId || ''),
  status: 'resolved_auto',
});

const failureRow = ({ row, error, at, atMs }) => {
  const attempts = Number(row.attempts || 0) + 1;
  const classified = classifyError(error);
  const retryable = classified.retryable && attempts < MAX_ATTEMPTS;
  if (!retryable) {
    return {
      attempts,
      error_class: classified.errorClass,
      error_message: classified.errorClass,
      id: row.id || undefined,
      payload_hash: payloadHash(row),
      queued_at: row.queued_at || row.timestamp || '',
      reason_code: reasonCode(row),
      status: classified.retryable ? 'dead_lettered' : 'failed_terminal',
      terminal_at: at,
      updated_at: at,
    };
  }
  return {
    ...row,
    attempts,
    error_class: classified.errorClass,
    error_message: classified.errorClass,
    next_attempt_at: retryAt(attempts, atMs),
    status: 'failed_retryable',
    updated_at: at,
  };
};

const writeReplacements = ({ originalRows, queuePath, replacements }) => {
  if (replacements.size === 0) return 0;
  const lock = acquireQueueLock(queuePath);
  try {
    const current = readQueue(queuePath);
    let updated = 0;
    const next = current.rows.map((row) => {
      const replacement = replacements.get(rowIdentity(row));
      if (!replacement) return row;
      updated += 1;
      return replacement;
    });
    if (updated === 0) return 0;
    const body = next.length ? `${next.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
    if (body !== current.raw) atomicWriteFileSync(queuePath, body, { mode: 0o600 });
    return updated;
  } finally {
    lock.release();
  }
};

const baseResult = ({ enabled, dryRun }) => ({
  dismissed: 0,
  dryRun,
  duplicateArchived: 0,
  eligible: 0,
  enabled,
  inspected: 0,
  keptBoth: 0,
  mutatedRows: 0,
  ok: true,
  processed: 0,
  retryable: 0,
  stored: 0,
  terminal: 0,
});

const reviewQueuedCandidates = async ({
  applyDecision = defaultApplyDecision,
  clock,
  config = {},
  db,
  dryRun = false,
  limit,
  reviewer = defaultReviewer,
  runId = '',
} = {}) => {
  const enabled = config?.llm?.queueReview?.enabled === true;
  const result = baseResult({ dryRun: dryRun === true, enabled });
  if (!enabled) return result;
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
  if (!queuePath) return result;
  const snapshot = readQueue(queuePath);
  result.inspected = snapshot.rows.length;
  if (!snapshot.exists || snapshot.rows.length === 0) return result;
  const allowed = new Set((Array.isArray(config?.llm?.queueReview?.allowedReasons)
    && config.llm.queueReview.allowedReasons.length
    ? config.llm.queueReview.allowedReasons
    : DEFAULT_ALLOWED_REASONS).map((value) => String(value).trim().toLowerCase()));
  const atMs = typeof clock === 'function' ? Number(clock()) : Date.now();
  const eligible = snapshot.rows.filter((row) => allowed.has(reasonCode(row)) && isDue(row, atMs));
  result.eligible = eligible.length;
  if (dryRun || eligible.length === 0) return result;
  const maxRows = clampLimit(limit ?? config?.llm?.queueReview?.limit ?? MAX_REVIEW_ROWS);
  const replacements = new Map();
  for (const row of eligible.slice(0, maxRows)) {
    const identity = rowIdentity(row);
    const at = new Date(atMs).toISOString();
    result.processed += 1;
    try {
      const decision = parseDecision(await reviewer({ config, row }));
      const minimum = clamp01(config?.llm?.queueReview?.minConfidence ?? 0.8);
      if (decision.confidence < minimum) throw new Error('QUEUE_REVIEW_MODEL_RESPONSE_INVALID');
      const applied = await applyDecision({ config, db, decision, row, runId });
      result.dismissed += Number(applied?.dismissed || 0);
      result.duplicateArchived += Number(applied?.duplicateArchived || 0);
      result.keptBoth += Number(applied?.keptBoth || 0);
      result.stored += Number(applied?.stored || 0);
      replacements.set(identity, terminalRow({ at, decision, row, runId }));
    } catch (error) {
      const replacement = failureRow({ at, atMs, error, row });
      replacements.set(identity, replacement);
      if (replacement.status === 'failed_retryable') result.retryable += 1;
      else result.terminal += 1;
    }
  }
  result.mutatedRows = writeReplacements({ originalRows: snapshot.rows, queuePath, replacements });
  return result;
};

export {
  MAX_REVIEW_ROWS,
  REVIEW_SCHEMA,
  reviewQueuedCandidates,
};

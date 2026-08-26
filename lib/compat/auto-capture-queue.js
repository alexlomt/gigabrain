import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AUTO_CAPTURE_LIMITS, containsSensitiveAutoCaptureContent } from './auto-capture-policy.js';
import { resolveRuntimeDescriptor } from './runtime-descriptor.js';
import { assertWriteAllowed, resolveWriteMode } from './write-policy.js';
import { withNativeMemoryLock } from '../core/native-memory.js';
import { readFileIfExistsSync } from '../core/safe-fs.js';

const AUTO_CAPTURE_QUEUE_STATUSES = Object.freeze([
  'pending',
  'processing',
  'completed',
  'failed_retryable',
  'failed_terminal',
  'dead_lettered',
  'resolved_historical',
]);

const STATUS_SET = new Set(AUTO_CAPTURE_QUEUE_STATUSES);
const TERMINAL_STATUSES = new Set(['completed', 'failed_terminal', 'dead_lettered', 'resolved_historical']);
const ACTIVE_STATUSES = new Set(['pending', 'processing', 'failed_retryable']);
const PROVIDER_FAILURE_CLASSES = new Set(['provider_rate_limited', 'timeout_or_aborted', 'network', 'error']);
const RETRYABLE_ERROR_CLASSES = new Set(PROVIDER_FAILURE_CLASSES);
const STORED_ERROR_CLASSES = new Set([
  ...PROVIDER_FAILURE_CLASSES,
  'configuration',
  'invalid_payload',
  'missing_packet',
]);
const MAX_PENDING_JOBS = 100;
const MAX_QUEUE_ROWS = 250;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_QUEUE_ROW_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_PROVIDER_FAILURES = 3;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_WINDOW_MS = 5 * 60 * 1000;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const JOB_ID_RE = /^acq_[0-9a-f]{24}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PACKET_KEYS = Object.freeze(['decision', 'messages', 'mode', 'schemaVersion', 'scope', 'sessionKey', 'source']);
const ACTIVE_ROW_KEYS = new Set([
  'agent_id',
  'attempts',
  'created_at',
  'error_class',
  'error_message',
  'id',
  'next_attempt_at',
  'packet',
  'packet_hash',
  'processing_owner',
  'processing_started_at',
  'provider_failure_count',
  'provider_failure_timestamps',
  'run_id',
  'scope',
  'session_key',
  'status',
  'updated_at',
]);

const queueError = (code, detail = '') => {
  const error = new Error(`${code}${detail ? `: ${detail}` : ''}`);
  error.code = code;
  return error;
};

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const nowIso = (value = Date.now()) => new Date(value).toISOString();

const clampInt = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
};

const cleanText = (value, maxChars) => String(value ?? '')
  .replace(/\r\n?/g, '\n')
  .trim()
  .slice(0, maxChars)
  .trim();

const safeMetadataToken = (value, fallback = '') => {
  const token = String(value || '').trim().slice(0, 256).trim();
  if (!token || token.includes('\0') || /[\r\n]/.test(token)) return fallback;
  return token;
};

const isSafeMetadataToken = (value, { allowEmpty = false } = {}) => {
  if (typeof value !== 'string' || value.length > 256 || value.includes('\0') || /[\r\n]/.test(value)) return false;
  if (value !== value.trim()) return false;
  return allowEmpty || value.length > 0;
};

const isIsoTimestamp = (value) => {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === value;
};

const resolveAgentId = (scope) => {
  const value = String(scope || '').trim();
  if (value.startsWith('profile:')) return safeMetadataToken(value.slice('profile:'.length), 'main');
  return safeMetadataToken(value, 'shared');
};

const normalizeDecision = (value = {}) => {
  const action = ['save', 'review'].includes(String(value?.action || '').trim())
    ? String(value.action).trim()
    : 'review';
  return {
    action,
    reason: safeMetadataToken(value?.reason, action === 'save' ? 'explicit_durable_request' : 'candidate_review'),
  };
};

const normalizePacket = (event = {}) => {
  if (!isRecord(event)) return null;
  const scope = safeMetadataToken(event.scope, 'shared');
  const messages = (Array.isArray(event.messages) ? event.messages : [])
    .map((message) => {
      const role = String(message?.role || '').trim().toLowerCase();
      if (!['user', 'assistant'].includes(role)) return null;
      const content = cleanText(message?.content, AUTO_CAPTURE_LIMITS.maxCharsPerTurn);
      return content ? { role, content } : null;
    })
    .filter(Boolean)
    .slice(-AUTO_CAPTURE_LIMITS.maxTurns);
  if (messages.length === 0 || !messages.some((message) => message.role === 'user')) return null;
  return {
    schemaVersion: 1,
    source: 'openclaw.agent_end',
    scope,
    mode: ['shadow', 'review', 'auto'].includes(String(event.mode || '').trim())
      ? String(event.mode).trim()
      : 'review',
    sessionKey: safeMetadataToken(event.sessionKey),
    decision: normalizeDecision(event.decision),
    messages,
  };
};

const resolveQueueContext = (config = {}) => {
  const descriptor = resolveRuntimeDescriptor(config);
  const lockConfig = Object.freeze({
    lockPath: descriptor.nativeLockDir,
    staleMs: config?.nativeLock?.staleMs,
    timeoutMs: config?.nativeLock?.timeoutMs,
  });
  return Object.freeze({
    descriptor,
    lockConfig,
    queuePath: descriptor.autoCaptureQueuePath,
  });
};

const validateQueueFile = (snapshot, queuePath) => {
  if (!snapshot.exists) return;
  const stat = snapshot.stat;
  if (!stat?.isFile?.()) throw queueError('AUTO_CAPTURE_QUEUE_TYPE_INVALID');
  if (Number(stat.nlink) !== 1) throw queueError('AUTO_CAPTURE_QUEUE_HARDLINK_REJECTED');
  if ((stat.mode & 0o077) !== 0) throw queueError('AUTO_CAPTURE_QUEUE_MODE_INVALID');
  if (typeof process.getuid === 'function' && Number(stat.uid) !== Number(process.getuid())) {
    throw queueError('AUTO_CAPTURE_QUEUE_OWNER_INVALID');
  }
  if (Buffer.byteLength(snapshot.data, 'utf8') > MAX_QUEUE_BYTES) {
    throw queueError('AUTO_CAPTURE_QUEUE_SIZE_INVALID', queuePath);
  }
};

const validPacket = (packet, row) => {
  if (!isRecord(packet) || Object.keys(packet).sort().join('\0') !== PACKET_KEYS.join('\0')) return false;
  if (packet.schemaVersion !== 1 || packet.source !== 'openclaw.agent_end') return false;
  if (!['shadow', 'review', 'auto'].includes(String(packet.mode || ''))) return false;
  if (!isSafeMetadataToken(packet.scope) || !isSafeMetadataToken(packet.sessionKey, { allowEmpty: true })) return false;
  if (!isRecord(packet.decision)) return false;
  if (Object.keys(packet.decision).sort().join('\0') !== 'action\0reason') return false;
  if (!['save', 'review'].includes(String(packet.decision.action || ''))) return false;
  if (!isSafeMetadataToken(packet.decision.reason)) return false;
  if (!Array.isArray(packet.messages) || packet.messages.length < 1 || packet.messages.length > AUTO_CAPTURE_LIMITS.maxTurns) {
    return false;
  }
  let hasUser = false;
  for (const message of packet.messages) {
    if (!isRecord(message) || Object.keys(message).sort().join('\0') !== 'content\0role') return false;
    if (!['user', 'assistant'].includes(String(message.role || ''))) return false;
    if (message.role === 'user') hasUser = true;
    if (
      typeof message.content !== 'string'
      || message.content.length < 1
      || message.content.length > AUTO_CAPTURE_LIMITS.maxCharsPerTurn
      || message.content !== message.content.trim()
    ) return false;
  }
  if (!hasUser) return false;
  if (row.scope !== packet.scope || row.agent_id !== resolveAgentId(packet.scope) || row.session_key !== packet.sessionKey) return false;
  return sha256(canonicalJson(packet)) === row.packet_hash;
};

const validPacketSummary = (summary, row) => Boolean(
  isRecord(summary)
  && Object.keys(summary).sort().join('\0')
    === 'agent_id\0conversation_turns\0packet_hash\0packet_scrubbed\0scope\0session_key'
  && summary.agent_id === row.agent_id
  && Number.isInteger(summary.conversation_turns)
  && summary.conversation_turns >= 0
  && summary.conversation_turns <= AUTO_CAPTURE_LIMITS.maxTurns
  && summary.packet_hash === row.packet_hash
  && summary.packet_scrubbed === true
  && summary.scope === row.scope
  && summary.session_key === row.session_key
);

const validFailureWindow = (row) => {
  if (row.provider_failure_count === undefined && row.provider_failure_timestamps === undefined) return true;
  if (
    !Number.isInteger(row.provider_failure_count)
    || row.provider_failure_count < 0
    || row.provider_failure_count > MAX_PROVIDER_FAILURES
  ) return false;
  if (!Array.isArray(row.provider_failure_timestamps) || row.provider_failure_timestamps.length !== row.provider_failure_count) {
    return false;
  }
  return row.provider_failure_timestamps.every(isIsoTimestamp);
};

const validatePersistedRow = (row) => {
  if (!JOB_ID_RE.test(String(row.id || '')) || !SHA256_RE.test(String(row.packet_hash || ''))) {
    throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
  }
  if (row.id !== `acq_${row.packet_hash.slice(0, 24)}`) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
  if (!Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts > MAX_ATTEMPTS) {
    throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
  }
  if (!isIsoTimestamp(row.created_at) || !isIsoTimestamp(row.updated_at)) {
    throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
  }
  if (
    !isSafeMetadataToken(row.scope)
    || !isSafeMetadataToken(row.agent_id)
    || !isSafeMetadataToken(row.session_key, { allowEmpty: true })
    || !isSafeMetadataToken(row.run_id, { allowEmpty: true })
    || !validFailureWindow(row)
  ) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');

  const status = String(row.status || '');
  if (ACTIVE_STATUSES.has(status)) {
    if (Object.keys(row).some((key) => !ACTIVE_ROW_KEYS.has(key))) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
    if (!validPacket(row.packet, row)) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
  }
  if (status === 'pending' && (
    row.attempts !== 0
    || row.next_attempt_at !== ''
    || ![undefined, ''].includes(row.error_class)
    || ![undefined, ''].includes(row.error_message)
  )) {
    throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
  }
  if (status === 'processing' && (
    row.attempts < 1
    || row.next_attempt_at !== ''
    || !isIsoTimestamp(row.processing_started_at)
    || !isSafeMetadataToken(row.processing_owner)
    || row.error_class !== ''
    || row.error_message !== ''
  )) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
  if (status === 'failed_retryable' && (
    row.attempts < 1
    || row.attempts >= MAX_ATTEMPTS
    || !isIsoTimestamp(row.next_attempt_at)
    || !RETRYABLE_ERROR_CLASSES.has(row.error_class)
    || ![row.error_class, 'stale_processing_recovered'].includes(row.error_message)
  )) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
  if (TERMINAL_STATUSES.has(status)) {
    if (row.next_attempt_at !== '') throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
    if (status === 'completed' && !isIsoTimestamp(row.processed_at)) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
    if (!isRecord(row.packet) && !validPacketSummary(row.packet_summary, row)) {
      throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
    }
    if (isRecord(row.packet) && !validPacket(row.packet, row)) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
  }
  return row;
};

const parseQueueRows = (raw) => {
  const rows = [];
  const lines = String(raw || '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > MAX_QUEUE_ROWS) throw queueError('AUTO_CAPTURE_QUEUE_ROW_LIMIT');
  const ids = new Set();
  const hashes = new Set();
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > MAX_QUEUE_ROW_BYTES) {
      throw queueError('AUTO_CAPTURE_QUEUE_ROW_SIZE_INVALID');
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw queueError('AUTO_CAPTURE_QUEUE_JSON_INVALID');
    }
    if (!isRecord(row)) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
    const status = String(row.status || '');
    if (!STATUS_SET.has(status)) throw queueError('AUTO_CAPTURE_QUEUE_STATUS_INVALID', status || 'missing');
    validatePersistedRow(row);
    if (ids.has(row.id) || hashes.has(row.packet_hash)) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
    ids.add(row.id);
    hashes.add(row.packet_hash);
    rows.push(row);
  }
  if (rows.filter((row) => ACTIVE_STATUSES.has(row.status)).length > MAX_PENDING_JOBS) {
    throw queueError('AUTO_CAPTURE_QUEUE_ROW_LIMIT');
  }
  return rows;
};

const readQueue = (queuePath) => {
  const snapshot = readFileIfExistsSync(queuePath, 'utf8', { maxBytes: MAX_QUEUE_BYTES });
  validateQueueFile(snapshot, queuePath);
  return {
    exists: snapshot.exists,
    raw: snapshot.data,
    rows: snapshot.exists ? parseQueueRows(snapshot.data) : [],
  };
};

const summarizePacket = (packet = {}, packetHash = '') => ({
  agent_id: safeMetadataToken(packet?.scope ? resolveAgentId(packet.scope) : ''),
  conversation_turns: Array.isArray(packet?.messages) ? packet.messages.length : 0,
  packet_hash: packetHash || sha256(canonicalJson(packet)),
  packet_scrubbed: true,
  scope: safeMetadataToken(packet?.scope, 'shared'),
  session_key: safeMetadataToken(packet?.sessionKey),
});

const normalizeAggregateResult = (value = {}, packetHash = '') => {
  const aggregate = {
    auto_saved: clampInt(value?.autoSaved ?? value?.auto_saved, 0, 1000, 0),
    packet_hash: packetHash,
    queued_review: clampInt(value?.queuedReview ?? value?.queued_review, 0, 1000, 0),
  };
  return { ...aggregate, result_hash: sha256(canonicalJson(aggregate)) };
};

const normalizedPacketSummary = (row) => {
  if (isRecord(row.packet)) return summarizePacket(row.packet, String(row.packet_hash || ''));
  return {
    agent_id: row.agent_id,
    conversation_turns: clampInt(row?.packet_summary?.conversation_turns, 0, AUTO_CAPTURE_LIMITS.maxTurns, 0),
    packet_hash: row.packet_hash,
    packet_scrubbed: true,
    scope: row.scope,
    session_key: row.session_key,
  };
};

const scrubTerminalRow = (row = {}) => {
  if (!TERMINAL_STATUSES.has(String(row?.status || ''))) return row;
  const next = {
    id: row.id,
    packet_hash: row.packet_hash,
    status: row.status,
    attempts: row.attempts,
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_attempt_at: '',
    scope: row.scope,
    agent_id: row.agent_id,
    session_key: row.session_key,
    run_id: row.run_id,
    packet_summary: normalizedPacketSummary(row),
  };
  if (isIsoTimestamp(row.processed_at)) next.processed_at = row.processed_at;
  if (isIsoTimestamp(row.terminal_at)) next.terminal_at = row.terminal_at;
  if (row.status !== 'completed') {
    const errorClass = STORED_ERROR_CLASSES.has(row.error_class) ? row.error_class : 'error';
    next.error_class = errorClass;
    next.error_message = row.error_message === 'stale_processing_recovered'
      ? 'stale_processing_recovered'
      : errorClass;
  }
  if (isRecord(row.result)) next.result = normalizeAggregateResult(row.result, String(row.packet_hash || ''));
  if (validFailureWindow(row) && row.provider_failure_count !== undefined) {
    next.provider_failure_count = row.provider_failure_count;
    next.provider_failure_timestamps = [...row.provider_failure_timestamps];
  }
  return next;
};

const retainBoundedRows = (rows = []) => {
  const normalized = rows.map((row) => scrubTerminalRow(row));
  const activeIndexes = normalized
    .map((row, index) => ACTIVE_STATUSES.has(String(row?.status || '')) ? index : -1)
    .filter((index) => index >= 0);
  if (activeIndexes.length > MAX_QUEUE_ROWS) throw queueError('AUTO_CAPTURE_QUEUE_ACTIVE_OVERFLOW');
  const terminalBudget = MAX_QUEUE_ROWS - activeIndexes.length;
  const terminalIndexes = terminalBudget === 0 ? [] : normalized
    .map((row, index) => TERMINAL_STATUSES.has(String(row?.status || '')) ? index : -1)
    .filter((index) => index >= 0)
    .slice(-terminalBudget);
  const keep = new Set([...activeIndexes, ...terminalIndexes]);
  return normalized.filter((_row, index) => keep.has(index));
};

const renderQueue = (rows) => {
  const retained = retainBoundedRows(rows);
  return retained.length > 0 ? `${retained.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
};

const durableReplaceQueueFile = (queuePath, body) => {
  const directory = path.dirname(queuePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.gigabrain-auto-capture-${randomUUID()}.tmp`);
  const fileFlags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | Number(fs.constants.O_NOFOLLOW || 0);
  let fileDescriptor;
  let directoryDescriptor;
  try {
    fileDescriptor = fs.openSync(temporaryPath, fileFlags, 0o600);
    fs.writeFileSync(fileDescriptor, body, { encoding: 'utf8' });
    fs.fchmodSync(fileDescriptor, 0o600);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryPath, queuePath);
    directoryDescriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | Number(fs.constants.O_DIRECTORY || 0),
    );
    fs.fsyncSync(directoryDescriptor);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try { fs.closeSync(fileDescriptor); } catch { /* preserve the original failure */ }
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
  }
};

const persistQueue = (queuePath, rows, previousRaw = '') => {
  const body = renderQueue(rows);
  if (body === previousRaw) return false;
  parseQueueRows(body);
  durableReplaceQueueFile(queuePath, body);
  return true;
};

const processingStaleMs = (config = {}) => clampInt(
  config?.capture?.autoCapture?.processingStaleMs,
  1_000,
  86_400_000,
  AUTO_CAPTURE_LIMITS.processingStaleMs,
);

const rowTimestampMs = (row, ...keys) => {
  for (const key of keys) {
    const value = Date.parse(String(row?.[key] || ''));
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
};

const isStaleProcessing = (row, config, atMs) => {
  if (String(row?.status || '') !== 'processing') return false;
  const started = rowTimestampMs(row, 'processing_started_at', 'updated_at', 'created_at');
  return !Number.isFinite(started) || atMs - started >= processingStaleMs(config);
};

const isRetryDue = (row, atMs) => {
  if (String(row?.status || '') !== 'failed_retryable') return true;
  const due = Date.parse(String(row?.next_attempt_at || ''));
  return !Number.isFinite(due) || due <= atMs;
};

const retryAt = (attempts, atMs) => {
  const minutes = Math.min(60, 2 ** Math.max(0, Number(attempts || 1) - 1));
  return nowIso(atMs + minutes * 60 * 1000);
};

const classifyError = (error) => {
  const code = String(error?.code || '').toLowerCase();
  const text = `${code} ${String(error?.message || error || '')}`.toLowerCase();
  if (/memory_llm_ollama_http_(?:401|403|404)\b/.test(text)) return 'configuration';
  if (/memory_llm_ollama_http_400\b/.test(text)) return 'invalid_payload';
  if (/429|quota|rate.?limit/.test(text)) return 'provider_rate_limited';
  if (/timeout|abort/.test(text)) return 'timeout_or_aborted';
  if (/econn|enet|network|fetch failed|socket/.test(text)) return 'network';
  if (/invalid|malformed|parse|schema|payload/.test(text)) return 'invalid_payload';
  if (/config|missing.*provider|processor.*unavailable|requires.*llm/.test(text)) return 'configuration';
  return 'error';
};

const normalizeProcessorResult = (value) => {
  if (!isRecord(value)) throw queueError('AUTO_CAPTURE_PROCESSOR_RESULT_INVALID');
  const camel = Object.hasOwn(value, 'autoSaved') && Object.hasOwn(value, 'queuedReview');
  const snake = Object.hasOwn(value, 'auto_saved') && Object.hasOwn(value, 'queued_review');
  if (!camel && !snake) throw queueError('AUTO_CAPTURE_PROCESSOR_RESULT_INVALID');
  const autoSaved = camel ? value.autoSaved : value.auto_saved;
  const queuedReview = camel ? value.queuedReview : value.queued_review;
  if (
    !Number.isInteger(autoSaved)
    || autoSaved < 0
    || autoSaved > 1000
    || !Number.isInteger(queuedReview)
    || queuedReview < 0
    || queuedReview > 1000
  ) throw queueError('AUTO_CAPTURE_PROCESSOR_RESULT_INVALID');
  return { autoSaved, queuedReview };
};

const resolveCircuit = (rows, atMs) => {
  const failureAttempts = [];
  for (const row of rows) {
    if (!['failed_retryable', 'failed_terminal', 'dead_lettered'].includes(String(row?.status || ''))) continue;
    if (!PROVIDER_FAILURE_CLASSES.has(String(row?.error_class || ''))) continue;
    const persisted = Array.isArray(row.provider_failure_timestamps)
      ? row.provider_failure_timestamps.map((value) => Date.parse(value)).filter(Number.isFinite)
      : [];
    if (persisted.length > 0) failureAttempts.push(...persisted);
    else {
      const updated = rowTimestampMs(row, 'updated_at', 'processed_at', 'created_at');
      if (Number.isFinite(updated)) failureAttempts.push(updated);
    }
  }
  const recent = failureAttempts
    .filter((timestamp) => timestamp <= atMs && atMs - timestamp <= CIRCUIT_WINDOW_MS)
    .sort((left, right) => left - right);
  if (recent.length < CIRCUIT_FAILURE_THRESHOLD) {
    return { failureCount: recent.length, open: false, openUntil: '' };
  }
  const latestFailure = recent.at(-1);
  const nextAttempts = rows
    .map((row) => Date.parse(String(row?.next_attempt_at || '')))
    .filter(Number.isFinite);
  const openUntilMs = Math.max(latestFailure + CIRCUIT_COOLDOWN_MS, ...nextAttempts, 0);
  return {
    failureCount: recent.length,
    open: openUntilMs > atMs,
    openUntil: openUntilMs > atMs ? nowIso(openUntilMs) : '',
  };
};

const appendProviderFailure = (row, timestamp) => {
  const existing = Array.isArray(row?.provider_failure_timestamps)
    ? row.provider_failure_timestamps.filter(isIsoTimestamp)
    : [];
  const timestamps = [...existing, timestamp].slice(-MAX_PROVIDER_FAILURES);
  return {
    provider_failure_count: timestamps.length,
    provider_failure_timestamps: timestamps,
  };
};

const seedLegacyProviderFailures = (rows) => {
  let seeded = 0;
  for (const row of rows) {
    if (row.provider_failure_count !== undefined || row.provider_failure_timestamps !== undefined) continue;
    if (row.status === 'processing') {
      const priorFailures = Math.min(MAX_PROVIDER_FAILURES - 1, Math.max(0, Number(row.attempts || 0) - 1));
      if (priorFailures === 0) continue;
      const timestamp = [row.processing_started_at, row.updated_at, row.created_at].find(isIsoTimestamp);
      if (!timestamp) continue;
      Object.assign(row, {
        provider_failure_count: priorFailures,
        provider_failure_timestamps: Array(priorFailures).fill(timestamp),
      });
      seeded += 1;
      continue;
    }
    if (!['failed_retryable', 'failed_terminal', 'dead_lettered'].includes(String(row.status || ''))) continue;
    if (!PROVIDER_FAILURE_CLASSES.has(String(row.error_class || ''))) continue;
    const timestamp = [row.updated_at, row.processed_at, row.created_at].find(isIsoTimestamp);
    if (!timestamp) continue;
    Object.assign(row, {
      provider_failure_count: 1,
      provider_failure_timestamps: [timestamp],
    });
    seeded += 1;
  }
  return seeded;
};

const processableRows = (rows, config, atMs) => rows.filter((row) => {
  const status = String(row?.status || '');
  const attempts = Number(row?.attempts || 0);
  if (status === 'processing') return isStaleProcessing(row, config, atMs);
  if (!['pending', 'failed_retryable'].includes(status)) return false;
  if (attempts >= MAX_ATTEMPTS || !isRecord(row.packet)) return true;
  return status === 'pending' || isRetryDue(row, atMs);
});

const baseQueueResult = ({ inspected = 0, processable = 0, dryRun = false } = {}) => ({
  inspected,
  processed: 0,
  completed: 0,
  retryable: 0,
  terminal: 0,
  autoSaved: 0,
  queuedReview: 0,
  mutated: false,
  dryRun,
  processable,
  processingRecovered: 0,
  circuitOpen: false,
  circuitFailureCount: 0,
  circuitOpenUntil: '',
  reason: '',
});

const inactiveReason = (config = {}) => {
  if (config?.capture?.enabled === false) return 'disabled';
  const autoCapture = config?.capture?.autoCapture || {};
  if (autoCapture.enabled !== true || String(autoCapture.mode || '').trim() === 'off') return 'disabled';
  return '';
};

const enqueueAutoCaptureEvent = async ({ config = {}, event = {}, runId = '' } = {}) => {
  const disabled = inactiveReason(config);
  if (disabled) return { enqueued: false, jobId: null, reason: disabled };
  const packet = normalizePacket(event);
  if (!packet) return { enqueued: false, jobId: null, reason: 'invalid_event' };
  if (packet.messages.some((message) => containsSensitiveAutoCaptureContent(message.content))) {
    return { enqueued: false, jobId: null, reason: 'sensitive' };
  }
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'queue.append' });
  const context = resolveQueueContext(config);
  const { queuePath } = context;
  const packetHash = sha256(canonicalJson(packet));
  const jobId = `acq_${packetHash.slice(0, 24)}`;
  return withNativeMemoryLock(context.lockConfig, () => {
    const snapshot = readQueue(queuePath);
    const duplicate = snapshot.rows.find((row) => String(row?.packet_hash || '') === packetHash || String(row?.id || '') === jobId);
    if (duplicate) return { enqueued: false, jobId: String(duplicate.id || jobId), reason: 'duplicate' };
    const pendingCount = snapshot.rows.filter((row) => ACTIVE_STATUSES.has(String(row?.status || ''))).length;
    if (pendingCount >= MAX_PENDING_JOBS) return { enqueued: false, jobId: null, reason: 'queue_full' };
    const createdAt = nowIso();
    const row = {
      id: jobId,
      packet_hash: packetHash,
      status: 'pending',
      attempts: 0,
      created_at: createdAt,
      updated_at: createdAt,
      next_attempt_at: '',
      scope: packet.scope,
      agent_id: resolveAgentId(packet.scope),
      session_key: packet.sessionKey,
      run_id: safeMetadataToken(runId),
      packet,
    };
    persistQueue(queuePath, [...snapshot.rows, row], snapshot.raw);
    return { enqueued: true, jobId, reason: 'queued' };
  });
};

const applyRecoveryTransitions = ({ rows, config, atMs }) => {
  let recovered = 0;
  let retryable = 0;
  let terminal = 0;
  const updatedAt = nowIso(atMs);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!isStaleProcessing(row, config, atMs)) continue;
    const attempts = Number(row?.attempts || 0);
    const exhausted = attempts >= MAX_ATTEMPTS;
    const providerFailure = appendProviderFailure(row, updatedAt);
    const next = {
      ...row,
      ...providerFailure,
      status: exhausted ? 'dead_lettered' : 'failed_retryable',
      updated_at: updatedAt,
      next_attempt_at: exhausted ? '' : retryAt(attempts, atMs),
      error_class: 'timeout_or_aborted',
      error_message: 'stale_processing_recovered',
    };
    delete next.processing_owner;
    delete next.processing_started_at;
    rows[index] = exhausted ? scrubTerminalRow(next) : next;
    recovered += 1;
    if (exhausted) terminal += 1;
    else retryable += 1;
  }
  return { recovered, retryable, terminal };
};

const claimNextJob = async ({ config, context, allowDispatch, atMs }) => withNativeMemoryLock(context.lockConfig, () => {
  const { queuePath } = context;
  const snapshot = readQueue(queuePath);
  const rows = snapshot.rows;
  const seededFailures = seedLegacyProviderFailures(rows);
  const recovery = applyRecoveryTransitions({ rows, config, atMs });
  let changed = seededFailures > 0 || recovery.recovered > 0;
  const circuit = resolveCircuit(rows, atMs);
  let maintenanceTerminal = 0;
  let claim = null;

  if (!circuit.open) {
    const candidateIndex = rows.findIndex((row) => {
      const status = String(row?.status || '');
      if (!['pending', 'failed_retryable'].includes(status)) return false;
      if (Number(row?.attempts || 0) >= MAX_ATTEMPTS || !isRecord(row?.packet)) return true;
      return allowDispatch && (status === 'pending' || isRetryDue(row, atMs));
    });
    if (candidateIndex >= 0) {
      const row = rows[candidateIndex];
      const attempts = Number(row?.attempts || 0);
      if (!isRecord(row?.packet)) {
        rows[candidateIndex] = scrubTerminalRow({
          ...row,
          status: 'failed_terminal',
          updated_at: nowIso(atMs),
          next_attempt_at: '',
          error_class: 'missing_packet',
          error_message: 'missing_packet',
        });
        maintenanceTerminal = 1;
        changed = true;
      } else if (attempts >= MAX_ATTEMPTS) {
        rows[candidateIndex] = scrubTerminalRow({
          ...row,
          status: 'dead_lettered',
          updated_at: nowIso(atMs),
          next_attempt_at: '',
          error_class: safeMetadataToken(row.error_class, 'error'),
          error_message: safeMetadataToken(row.error_class, 'error'),
        });
        maintenanceTerminal = 1;
        changed = true;
      } else if (allowDispatch) {
        const owner = `acw_${randomUUID()}`;
        const startedAt = nowIso(atMs);
        rows[candidateIndex] = {
          ...row,
          status: 'processing',
          attempts: attempts + 1,
          updated_at: startedAt,
          next_attempt_at: '',
          processing_started_at: startedAt,
          processing_owner: owner,
          error_class: '',
          error_message: '',
        };
        claim = { job: rows[candidateIndex], owner };
        changed = true;
      }
    }
  }
  const wrote = changed ? persistQueue(queuePath, rows, snapshot.raw) : false;
  return { circuit, claim, maintenanceTerminal, mutated: wrote, recovery };
});

const finalizeClaim = async ({ context, claim, outcome, atMs }) => withNativeMemoryLock(context.lockConfig, () => {
  const { queuePath } = context;
  const snapshot = readQueue(queuePath);
  const index = snapshot.rows.findIndex((row) => String(row?.id || '') === String(claim.job.id || ''));
  if (index < 0) return { owned: false, mutated: false };
  const current = snapshot.rows[index];
  if (String(current?.status || '') !== 'processing' || String(current?.processing_owner || '') !== claim.owner) {
    return { owned: false, mutated: false };
  }
  const updatedAt = nowIso(atMs);
  let next;
  if (outcome.ok) {
    const aggregate = normalizeAggregateResult(outcome.value, String(current.packet_hash || ''));
    next = scrubTerminalRow({
      ...current,
      status: 'completed',
      processed_at: updatedAt,
      updated_at: updatedAt,
      next_attempt_at: '',
      error_class: '',
      error_message: '',
      result: aggregate,
    });
  } else {
    const errorClass = classifyError(outcome.error);
    const retryable = RETRYABLE_ERROR_CLASSES.has(errorClass) && Number(current.attempts || 0) < MAX_ATTEMPTS;
    const providerFailure = PROVIDER_FAILURE_CLASSES.has(errorClass)
      ? appendProviderFailure(current, updatedAt)
      : {};
    next = {
      ...current,
      ...providerFailure,
      status: retryable
        ? 'failed_retryable'
        : RETRYABLE_ERROR_CLASSES.has(errorClass) ? 'dead_lettered' : 'failed_terminal',
      updated_at: updatedAt,
      next_attempt_at: retryable ? retryAt(current.attempts, atMs) : '',
      error_class: errorClass,
      error_message: errorClass,
    };
    delete next.processing_owner;
    delete next.processing_started_at;
    if (!retryable) next = scrubTerminalRow(next);
  }
  snapshot.rows[index] = next;
  const mutated = persistQueue(queuePath, snapshot.rows, snapshot.raw);
  return {
    aggregate: outcome.ok ? next.result : null,
    owned: true,
    retryable: !outcome.ok && next.status === 'failed_retryable',
    terminal: !outcome.ok && TERMINAL_STATUSES.has(next.status),
    mutated,
  };
});

const processAutoCaptureQueue = async (options = {}) => {
  const config = options?.config || {};
  const limit = clampInt(options?.limit, 1, 20, 3);
  const dryRun = options?.dryRun === true;
  const processJob = typeof options?.processJob === 'function' ? options.processJob : null;
  const disabled = inactiveReason(config);
  if (disabled) {
    const result = baseQueueResult({ dryRun });
    result.reason = disabled;
    return result;
  }
  const context = resolveQueueContext(config);
  const { queuePath } = context;
  const initial = readQueue(queuePath);
  const startedAt = Date.now();
  const eligible = processableRows(initial.rows, config, startedAt);
  const result = baseQueueResult({ inspected: initial.rows.length, processable: eligible.length, dryRun });
  if (!initial.exists || initial.rows.length === 0) {
    result.reason = 'empty_queue';
    return result;
  }
  const initialCircuit = resolveCircuit(initial.rows, startedAt);
  result.circuitOpen = initialCircuit.open;
  result.circuitFailureCount = initialCircuit.failureCount;
  result.circuitOpenUntil = initialCircuit.openUntil;
  if (dryRun) {
    result.reason = eligible.length > 0 ? 'dry_run' : 'no_processable_rows';
    return result;
  }
  if (eligible.length === 0) {
    result.reason = 'no_processable_rows';
    return result;
  }
  const needsMaintenance = eligible.some((row) => (
    isStaleProcessing(row, config, startedAt)
    || Number(row?.attempts || 0) >= MAX_ATTEMPTS
    || (!isRecord(row?.packet) && String(row?.status || '') !== 'processing')
  ));
  if (initialCircuit.open && !needsMaintenance) {
    result.reason = 'circuit_open';
    return result;
  }
  if (!processJob && !needsMaintenance) {
    result.reason = 'processor_unavailable';
    return result;
  }
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'queue.review' });

  let stateTransitions = 0;
  while (stateTransitions < limit) {
    const claimAt = Date.now();
    const claimed = await claimNextJob({
      allowDispatch: Boolean(processJob),
      atMs: claimAt,
      config,
      context,
    });
    if (claimed.recovery.recovered > 0) {
      result.processingRecovered += claimed.recovery.recovered;
      result.retryable += claimed.recovery.retryable;
      result.terminal += claimed.recovery.terminal;
      stateTransitions += claimed.recovery.recovered;
    }
    if (claimed.maintenanceTerminal > 0) {
      result.terminal += claimed.maintenanceTerminal;
      stateTransitions += claimed.maintenanceTerminal;
    }
    result.mutated = result.mutated || claimed.mutated;
    result.circuitOpen = claimed.circuit.open;
    result.circuitFailureCount = claimed.circuit.failureCount;
    result.circuitOpenUntil = claimed.circuit.openUntil;
    if (claimed.circuit.open) {
      result.reason = 'circuit_open';
      break;
    }
    if (!claimed.claim) {
      if (!processJob && result.reason === '') result.reason = 'processor_unavailable';
      break;
    }
    stateTransitions += 1;
    result.processed += 1;
    let outcome;
    try {
      const value = await processJob({ job: claimed.claim.job, packet: claimed.claim.job.packet });
      if (value?.ok === false) {
        const error = new Error(String(value?.error || value?.errorClass || 'auto_capture_error'));
        error.code = String(value?.errorClass || value?.code || '');
        outcome = { error, ok: false };
      } else outcome = { ok: true, value: normalizeProcessorResult(value) };
    } catch (error) {
      outcome = { error, ok: false };
    }
    const finalized = await finalizeClaim({
      atMs: Date.now(),
      claim: claimed.claim,
      context,
      outcome,
    });
    result.mutated = result.mutated || finalized.mutated;
    if (!finalized.owned) {
      result.reason = 'ownership_lost';
      break;
    }
    if (outcome.ok) {
      result.completed += 1;
      result.autoSaved += Number(finalized.aggregate?.auto_saved || 0);
      result.queuedReview += Number(finalized.aggregate?.queued_review || 0);
    } else if (finalized.retryable) result.retryable += 1;
    else if (finalized.terminal) result.terminal += 1;
  }
  if (!result.reason) result.reason = result.processed > 0 ? 'processed' : 'no_processable_rows';
  return result;
};

export {
  AUTO_CAPTURE_QUEUE_STATUSES,
  enqueueAutoCaptureEvent,
  processAutoCaptureQueue,
};

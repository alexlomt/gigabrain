import { createHash, randomUUID } from 'node:crypto';

import { AUTO_CAPTURE_LIMITS } from './auto-capture-policy.js';
import { resolveRuntimeDescriptor } from './runtime-descriptor.js';
import { assertWriteAllowed, resolveWriteMode } from './write-policy.js';
import { withNativeMemoryLock } from '../core/native-memory.js';
import { atomicWriteFileSync, readFileIfExistsSync } from '../core/safe-fs.js';

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
const MAX_PENDING_JOBS = 100;
const MAX_QUEUE_ROWS = 250;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_WINDOW_MS = 5 * 60 * 1000;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

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
  .slice(0, maxChars);

const safeMetadataToken = (value, fallback = '') => {
  const token = String(value || '').trim().slice(0, 256);
  if (!token || token.includes('\0') || /[\r\n]/.test(token)) return fallback;
  return token;
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
  return Object.freeze({ descriptor, queuePath: descriptor.autoCaptureQueuePath });
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

const parseQueueRows = (raw) => {
  const rows = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw queueError('AUTO_CAPTURE_QUEUE_JSON_INVALID');
    }
    if (!isRecord(row)) throw queueError('AUTO_CAPTURE_QUEUE_ROW_INVALID');
    const status = String(row.status || '');
    if (!STATUS_SET.has(status)) throw queueError('AUTO_CAPTURE_QUEUE_STATUS_INVALID', status || 'missing');
    rows.push(row);
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

const scrubTerminalRow = (row = {}) => {
  if (!TERMINAL_STATUSES.has(String(row?.status || ''))) return row;
  const next = { ...row };
  if (isRecord(next.packet)) {
    const packetHash = String(next.packet_hash || sha256(canonicalJson(next.packet)));
    next.packet_hash = packetHash;
    next.packet_summary = summarizePacket(next.packet, packetHash);
  }
  if (isRecord(next.result)) next.result = normalizeAggregateResult(next.result, String(next.packet_hash || ''));
  for (const key of [
    'candidate',
    'candidates',
    'content',
    'packet',
    'processing_owner',
    'processing_started_at',
    'raw_packet',
    'raw_result',
    'rawPacket',
  ]) delete next[key];
  next.next_attempt_at = '';
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

const persistQueue = (queuePath, rows, previousRaw = '') => {
  const body = renderQueue(rows);
  if (body === previousRaw) return false;
  atomicWriteFileSync(queuePath, body, { mode: 0o600 });
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
  if (/429|quota|rate.?limit/.test(text)) return 'provider_rate_limited';
  if (/timeout|abort/.test(text)) return 'timeout_or_aborted';
  if (/econn|enet|network|fetch failed|socket/.test(text)) return 'network';
  if (/invalid|malformed|parse|schema|payload/.test(text)) return 'invalid_payload';
  if (/config|missing.*provider|processor.*unavailable|requires.*llm/.test(text)) return 'configuration';
  return 'error';
};

const resolveCircuit = (rows, atMs) => {
  const failures = rows.filter((row) => {
    if (!['failed_retryable', 'failed_terminal', 'dead_lettered'].includes(String(row?.status || ''))) return false;
    if (!PROVIDER_FAILURE_CLASSES.has(String(row?.error_class || ''))) return false;
    const updated = rowTimestampMs(row, 'updated_at', 'processed_at', 'created_at');
    return Number.isFinite(updated) && atMs - updated <= CIRCUIT_WINDOW_MS;
  });
  if (failures.length < CIRCUIT_FAILURE_THRESHOLD) {
    return { failureCount: failures.length, open: false, openUntil: '' };
  }
  let openUntilMs = 0;
  for (const row of failures) {
    const updated = rowTimestampMs(row, 'updated_at', 'processed_at', 'created_at');
    const nextAttempt = Date.parse(String(row?.next_attempt_at || ''));
    openUntilMs = Math.max(
      openUntilMs,
      Number.isFinite(updated) ? updated + CIRCUIT_COOLDOWN_MS : 0,
      Number.isFinite(nextAttempt) ? nextAttempt : 0,
    );
  }
  return {
    failureCount: failures.length,
    open: openUntilMs > atMs,
    openUntil: openUntilMs > atMs ? nowIso(openUntilMs) : '',
  };
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
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'queue.append' });
  const { queuePath } = resolveQueueContext(config);
  const packetHash = sha256(canonicalJson(packet));
  const jobId = `acq_${packetHash.slice(0, 24)}`;
  return withNativeMemoryLock(config, () => {
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
    const next = {
      ...row,
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

const claimNextJob = async ({ config, queuePath, allowDispatch, atMs }) => withNativeMemoryLock(config, () => {
  const snapshot = readQueue(queuePath);
  const rows = snapshot.rows;
  const recovery = applyRecoveryTransitions({ rows, config, atMs });
  let changed = recovery.recovered > 0;
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

const finalizeClaim = async ({ config, queuePath, claim, outcome, atMs }) => withNativeMemoryLock(config, () => {
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
    next = {
      ...current,
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
  const { queuePath } = resolveQueueContext(config);
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
  if (initialCircuit.open) {
    result.reason = 'circuit_open';
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
      queuePath,
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
      } else outcome = { ok: true, value: value || {} };
    } catch (error) {
      outcome = { error, ok: false };
    }
    const finalized = await finalizeClaim({
      atMs: Date.now(),
      claim: claimed.claim,
      config,
      outcome,
      queuePath,
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

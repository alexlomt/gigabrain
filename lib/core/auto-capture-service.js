import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { appendEvent } from './event-store.js';
import { listCurrentMemories, normalizeProjectionScope } from './projection-store.js';
import { appendQueueRow } from './review-queue.js';
import { normalizeProvider, resolveTaskProfile } from './llm-router.js';
import { completeMemoryJson, rejectOpenClawMaintenanceFallback, resolveMemoryLlmConfig } from './memory-llm-client.js';
import { captureFromEvent } from './capture-service.js';

const AUTO_CAPTURE_ACTIONS = new Set(['auto_save', 'queue_review', 'reject']);
const AUTO_CAPTURE_TYPES = new Set(['USER_FACT', 'PREFERENCE', 'DECISION', 'ENTITY', 'EPISODE', 'AGENT_IDENTITY', 'CONTEXT']);
const AUTO_SAVE_TYPES = new Set(['USER_FACT', 'PREFERENCE', 'DECISION', 'ENTITY', 'AGENT_IDENTITY', 'CONTEXT']);
const SENSITIVITY_LEVELS = new Set(['low', 'medium', 'high']);
const DEFAULT_MODE = 'off';
const DEFAULT_AUTO_CAPTURE_QUEUE_FILE = 'gigabrain-auto-capture-queue.jsonl';
const AUTO_CAPTURE_QUEUE_MAX_PENDING = 100;
const AUTO_CAPTURE_QUEUE_MAX_ROWS = 250;
const AUTO_CAPTURE_QUEUE_MAX_ATTEMPTS = 3;
const AUTO_CAPTURE_CIRCUIT_FAILURE_THRESHOLD = 3;
const AUTO_CAPTURE_CIRCUIT_WINDOW_MS = 5 * 60 * 1000;
const AUTO_CAPTURE_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const AUTO_CAPTURE_PROVIDER_FAILURE_CLASSES = new Set(['provider_rate_limited', 'timeout_or_aborted', 'network', 'error']);

const classifyAutoCaptureError = (value = '') => {
  const text = String(value || '').toLowerCase();
  if (text.includes('429') || text.includes('quota') || text.includes('rate limit')) return 'provider_rate_limited';
  if (text.includes('timeout') || text.includes('abort')) return 'timeout_or_aborted';
  if (text.includes('fetch failed') || text.includes('econn') || text.includes('network')) return 'network';
  if (text.includes('missing_api_key') || text.includes('requires_stateless_memory_llm')) return 'configuration';
  if (text.includes('invalid') || text.includes('parse')) return 'invalid_payload';
  return text ? 'error' : '';
};

const isRetryableAutoCaptureError = (value = '') => {
  const cls = classifyAutoCaptureError(value);
  return ['provider_rate_limited', 'timeout_or_aborted', 'network', 'error'].includes(cls);
};

const nextRetryAt = (attempts = 1, now = Date.now()) => {
  const minutes = Math.min(60, Math.max(1, 2 ** Math.max(0, Number(attempts || 1) - 1)));
  return new Date(now + minutes * 60 * 1000).toISOString();
};

const resolveAutoCaptureCircuit = (rows = [], now = Date.now()) => {
  const recentFailures = [];
  for (const row of rows) {
    const status = String(row?.status || '');
    if (!['failed_retryable', 'failed_terminal'].includes(status)) continue;
    const errorClass = String(row?.error_class || classifyAutoCaptureError(row?.error_message || row?.error || '') || '');
    if (!AUTO_CAPTURE_PROVIDER_FAILURE_CLASSES.has(errorClass)) continue;
    const updatedAtMs = Date.parse(String(row?.updated_at || row?.processed_at || row?.enqueued_at || ''));
    if (!Number.isFinite(updatedAtMs) || now - updatedAtMs > AUTO_CAPTURE_CIRCUIT_WINDOW_MS) continue;
    recentFailures.push({ row, updatedAtMs });
  }
  if (recentFailures.length < AUTO_CAPTURE_CIRCUIT_FAILURE_THRESHOLD) {
    return { open: false, failure_count: recentFailures.length };
  }
  let openUntilMs = 0;
  for (const failure of recentFailures) {
    const nextAttemptMs = Date.parse(String(failure.row?.next_attempt_at || ''));
    if (Number.isFinite(nextAttemptMs) && nextAttemptMs > openUntilMs) openUntilMs = nextAttemptMs;
    const cooldownMs = failure.updatedAtMs + AUTO_CAPTURE_CIRCUIT_COOLDOWN_MS;
    if (cooldownMs > openUntilMs) openUntilMs = cooldownMs;
  }
  if (openUntilMs <= now) return { open: false, failure_count: recentFailures.length };
  return {
    open: true,
    failure_count: recentFailures.length,
    open_until: new Date(openUntilMs).toISOString(),
  };
};

const shouldDeferAutoCaptureRow = (row = {}, now = Date.now()) => {
  if (String(row?.status || '') !== 'failed_retryable') return false;
  const nextAttemptMs = Date.parse(String(row?.next_attempt_at || ''));
  return Number.isFinite(nextAttemptMs) && nextAttemptMs > now;
};

const clamp01 = (value, fallback = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
};

const clampInt = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return fallback == null
    ? min
    : Math.max(min, Math.min(max, Math.round(num)));
};

const normalizeMode = (value) => {
  const key = String(value || DEFAULT_MODE).trim().toLowerCase();
  if (['off', 'shadow', 'review', 'auto'].includes(key)) return key;
  return DEFAULT_MODE;
};

const normalizeType = (value) => {
  const key = String(value || '').trim().toUpperCase().replace(/[^A-Z_]/g, '');
  if (key === 'FACT' || key === 'USERFACT') return 'USER_FACT';
  if (AUTO_CAPTURE_TYPES.has(key)) return key;
  return 'CONTEXT';
};

const normalizeAction = (value) => {
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return AUTO_CAPTURE_ACTIONS.has(key) ? key : 'reject';
};

const normalizeSensitivity = (value) => {
  const key = String(value || '').trim().toLowerCase();
  return SENSITIVITY_LEVELS.has(key) ? key : 'medium';
};

const estimateTokens = (value) => Math.ceil(String(value || '').length / 4);

const SECRET_VALUE_PATTERNS = [
  /\bauthorization\s*[:=]\s*bearer\s+[a-z0-9._\-+/=]{8,}/i,
  /\bbearer\s+[a-z0-9._\-+/=]{12,}/i,
  /\b(?:authorization|bearer)\s*[:=]\s*[a-z0-9._\-+/=]{12,}/i,
  /\b(?:api[_-]?key|token|secret|password|passwd|pwd|cookie|session)\s*[:=]\s*[^\s,;]{8,}/i,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_\-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
];

const SAFE_SECRET_VALUE_RE = /^(?:<@(?:\d{15,25}|USER_ID)>|\[REDACTED_[A-Z0-9_]+\])$/;

const SECRET_REDACTIONS = [
  [/\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, 'authorization=<redacted>'],
  [/\bbearer\s+[^\s,;]+/gi, 'bearer <redacted>'],
  [/\b(authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>'],
  [/\b(api[_-]?key|token|secret|password|passwd|pwd|cookie|session)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>'],
  [/-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE KEY-----/gi, '<redacted-private-key>'],
  [/\bsk-[A-Za-z0-9_\-]{16,}\b/g, '<redacted-openai-key>'],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '<redacted-github-token>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, '<redacted-slack-token>'],
];

const stripSafeSecretPunctuation = (value = '') => String(value || '').trim().replace(/^[`'".,;:!()]+|[`'".,;:!()]+$/g, '');

const secretMatchIsAllowlisted = (raw = '') => {
  const value = stripSafeSecretPunctuation(raw);
  if (SAFE_SECRET_VALUE_RE.test(value)) return true;
  if (raw.includes(':') || raw.includes('=')) {
    const tail = stripSafeSecretPunctuation(String(raw).split(/[:=]/).slice(1).join('='));
    return SAFE_SECRET_VALUE_RE.test(tail);
  }
  return false;
};

const containsSecretLikeValue = (value) => {
  const text = String(value || '');
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (!secretMatchIsAllowlisted(match[0])) return true;
      if (!pattern.global) break;
    }
    return false;
  });
};

const SENSITIVE_OPERATIONAL_POSTURE_RE = /\b(?:bank\s+account|sort\s+code|iban|swift|pin\s*(?:code)?|passport|national\s+insurance|ssn|social\s+security|medical\s+(?:record|condition)|diagnosis|private\s+key|seed\s+phrase|mnemonic|sudoers?|ssh\s+(?:key|config)|firewall\s+rule|iptables|ufw|open\s+port|listening\s+port|root\s+login|host\s+posture|credential|credentials|auth\s+header|session\s+cookie)\b/i;

const containsSensitiveOperationalPosture = (value) => SENSITIVE_OPERATIONAL_POSTURE_RE.test(String(value || ''));

const expandRegexReplacement = (replacement, args) => String(replacement || '').replace(/\$(\d+)/g, (_full, index) => {
  const value = args[Number(index)];
  return value == null ? '' : String(value);
});

const redactSensitiveText = (value) => {
  let text = String(value || '');
  for (const [pattern, replacement] of SECRET_REDACTIONS) {
    text = text.replace(pattern, (...args) => {
      const match = String(args[0] || '');
      return secretMatchIsAllowlisted(match) ? match : expandRegexReplacement(replacement, args);
    });
  }
  return text;
};

const valueToText = (value, depth = 0) => {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => valueToText(item, depth + 1)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const record = value;
    const type = String(record.type || '').toLowerCase();
    if (['toolcall', 'tool_call', 'toolresult', 'tool_result', 'thinking', 'reasoning', 'image', 'media', 'attachment'].includes(type)) {
      return '';
    }
    const keys = ['text', 'content', 'output_text', 'message', 'response', 'output', 'result', 'final'];
    const parts = [];
    for (const key of keys) {
      if (!(key in record)) continue;
      const piece = valueToText(record[key], depth + 1);
      if (piece) parts.push(piece);
    }
    return parts.join('\n');
  }
  return '';
};

const normalizeRole = (value) => {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'assistant' || role === 'user' || role === 'system') return role;
  if (role === 'ai' || role === 'agent') return 'assistant';
  return '';
};

const compactText = (value, maxChars = 4000) => {
  const text = redactSensitiveText(valueToText(value).replace(/\s+/g, ' ').trim());
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trim()}…[truncated]`;
};

const TOOLISH_TEXT_PATTERNS = [
  /\btool(?:Call|Result|Name|Use|_uses?)\b/i,
  /\btoolCallId\b/i,
  /\brecipient_name\s*[":=].*functions\./i,
  /\bfunctions\.(?:exec|read|write|edit|apply_patch|process|browser_harness_run|sessions_spawn)\b/i,
  /\braw_params=/i,
  /\bCommand (?:exited|still running)\b/i,
  /\bProcess exited with code\b/i,
  /\bworkdir\b.*\btimeout\b/i,
  /\bapply_patch failed\b/i,
  /\[tools\]/i,
  /<tool_output>/i,
  /\bnode --input-type=module\b/i,
  /\bmakeTempWorkspace\b/i,
  /\bautoCaptureFromEvent\b/i,
  /\bcaptureFromEvent\b/i,
  /\bloadResolvedConfig\b/i,
  /\bopenDb\b/i,
  /\bconst\s+event\s*=/i,
  /\bmessages\s*:\s*\[/i,
  /\bJSON\.stringify\b/i,
  /\bprocess\.exitCode\b/i,
  /\bassert\./i,
  /\bnpm\s+test\b/i,
  /\bgigabrainctl\b/i,
  /\bsqlite3\b/i,
  /\bmemory_id\b[\s\S]{0,300}\bcreated_at\b/i,
  /\bsource_layer\b/i,
  /\bsynthetic_active\b/i,
  /\bNORMAL\s*\{/i,
  /\bTOOL_FILTER\s*\{/i,
  /\blive-auto-capture-test\b/i,
  /\bauto-capture live test\b/i,
  /\bunit-auto-capture-service-test\b/i,
];

const isToolLikeText = (value) => {
  const text = String(value || '');
  if (!text) return false;
  return TOOLISH_TEXT_PATTERNS.some((pattern) => pattern.test(text));
};

const isToolLikeMessage = (message = {}, text = '') => {
  const role = String(message?.role || message?.author || '').trim().toLowerCase();
  const type = String(message?.type || message?.kind || '').trim().toLowerCase();
  if (role === 'tool' || role === 'function') return true;
  if (type.includes('tool') || type.includes('function')) return true;
  if (message?.toolCallId || message?.tool_call_id || message?.toolName || message?.tool_name || message?.name === 'tool') return true;
  return isToolLikeText(text);
};

const AUTO_CAPTURE_SIGNAL_PATTERNS = [
  /\bgoing forward\b/i,
  /\b(?:always|never)\b/i,
  /\bI\s+(?:prefer|want|need|decided|decide)\b/i,
  /\bwe\s+(?:decided|should|need|must|will use|are using)\b/i,
  /\b(?:decision|standing instruction|preference|remember|save this|note this|remind me|blocked by|blocker|follow up|open loop)\b/i,
  /\b(?:project|client|setup|configuration|config)\b.{0,80}\b(?:decided|blocked|needs|must|should|status|todo)\b/i,
];

const AUTO_CAPTURE_SKIP_PATTERNS = [
  /^\s*(?:hi|hello|hey|ok|okay|thanks|thank you|hows? it going|are you here|status\??)\s*[.!?]*\s*$/i,
  /\b(?:smoke tests?|live tests?|unit tests?|restart(?:ing)?|gateway|RAM|CPU|ps aux|free -h|journalctl|systemctl)\b/i,
  /\b(?:tool|synthetic|test fixture|mock|debug|log tail|trace|stack)\b/i,
];
const PAPERCLIP_WAKE_MARKER_RE = /paperclip wake event for a cloud adapter\./i;
const PAPERCLIP_WAKE_ISSUE_RE = /^- issue:\s*(.+)$/im;
const PAPERCLIP_WAKE_REASON_RE = /(?:^|\n)(?:- reason:\s*|wake_reason=)([^\n]+)/i;
const PAPERCLIP_WAKE_ISSUE_ID_RE = /(?:^|\n)issue_id=([^\n]+)/i;
const PAPERCLIP_WAKE_TASK_ID_RE = /(?:^|\n)task_id=([^\n]+)/i;

const buildSyntheticPaperclipWakeSummary = (text = '') => {
  const source = String(text || '');
  const issue = String(source.match(PAPERCLIP_WAKE_ISSUE_RE)?.[1] || '').trim();
  const reason = String(source.match(PAPERCLIP_WAKE_REASON_RE)?.[1] || '').trim();
  const taskId = String(source.match(PAPERCLIP_WAKE_TASK_ID_RE)?.[1] || source.match(PAPERCLIP_WAKE_ISSUE_ID_RE)?.[1] || '').trim();
  const parts = ['Paperclip issue wake'];
  if (issue) parts.push(issue);
  else if (taskId) parts.push(taskId);
  const summary = parts.join(': ');
  return reason ? `${summary} (${reason}).` : `${summary}.`;
};

const normalizeAutoCaptureUserText = (text = '') => {
  const source = String(text || '');
  if (!PAPERCLIP_WAKE_MARKER_RE.test(source)) {
    return {
      text: source,
      syntheticWakeDetected: false,
      syntheticWakeSummary: '',
    };
  }
  return {
    text: buildSyntheticPaperclipWakeSummary(source),
    syntheticWakeDetected: true,
    syntheticWakeSummary: buildSyntheticPaperclipWakeSummary(source),
  };
};

const buildTurnsContext = (event = {}, options = {}) => {
  const maxTurns = clampInt(options.maxTurns, 2, 32, 16);
  const maxCharsPerTurn = clampInt(options.maxCharsPerTurn, 500, 12000, 4000);
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const turns = [];
  let syntheticWakeDetected = false;
  let syntheticWakeSummary = '';
  for (const message of messages) {
    const role = normalizeRole(message?.role || message?.author);
    if (!role || role === 'system') continue;
    let rawText = valueToText(message?.content ?? message?.text ?? message?.output);
    if (role === 'user') {
      const normalized = normalizeAutoCaptureUserText(rawText);
      rawText = normalized.text;
      if (normalized.syntheticWakeDetected) {
        syntheticWakeDetected = true;
        syntheticWakeSummary = normalized.syntheticWakeSummary || syntheticWakeSummary;
      }
    }
    if (isToolLikeMessage(message, rawText)) continue;
    const content = compactText(rawText, maxCharsPerTurn);
    if (!content) continue;
    turns.push({ role, content });
  }
  const rawFinalText = valueToText(event.text || event.output || event.response || event.final || '');
  const finalText = isToolLikeText(rawFinalText) ? '' : compactText(rawFinalText, maxCharsPerTurn);
  if (finalText) {
    const last = turns.at(-1);
    if (!(last?.role === 'assistant' && last?.content === finalText)) {
      turns.push({ role: 'assistant', content: finalText });
    }
  }
  return {
    turns: turns.slice(-maxTurns),
    syntheticWakeDetected,
    syntheticWakeSummary,
  };
};

const buildTurns = (event = {}, options = {}) => buildTurnsContext(event, options).turns;
const hasAutoCaptureSignal = (text) => AUTO_CAPTURE_SIGNAL_PATTERNS.some((pattern) => pattern.test(String(text || '')));
const shouldSkipAutoCaptureText = (text) => AUTO_CAPTURE_SKIP_PATTERNS.some((pattern) => pattern.test(String(text || '')));

const shouldConsiderAutoCaptureEvent = ({ event = {}, config = {} } = {}) => {
  const autoConfig = config?.capture?.autoCapture || {};
  const mode = normalizeMode(autoConfig.mode || (autoConfig.enabled ? 'review' : 'off'));
  if (mode === 'off' || autoConfig.enabled === false || config?.capture?.enabled === false) {
    return { ok: false, reason: 'disabled', syntheticWakeDetected: false };
  }
  const prepared = buildTurnsContext(event, { ...autoConfig, maxTurns: Math.min(Number(autoConfig.maxTurns || 16), 8) });
  const turns = prepared.turns;
  if (turns.length === 0) return { ok: false, reason: 'no_user_visible_turns', syntheticWakeDetected: prepared.syntheticWakeDetected };
  const text = turns.map((turn) => `${turn.role}: ${turn.content}`).join('\n').trim();
  if (text.length < Math.max(60, Number(autoConfig.minTriggerChars || 80))) {
    return { ok: false, reason: 'too_short', syntheticWakeDetected: prepared.syntheticWakeDetected, turnCount: turns.length };
  }
  if (containsSecretLikeValue(text)) return { ok: false, reason: 'secret_like', syntheticWakeDetected: prepared.syntheticWakeDetected };
  if (isToolLikeText(text)) return { ok: false, reason: 'tool_like', syntheticWakeDetected: prepared.syntheticWakeDetected };
  const lastUser = [...turns].reverse().find((turn) => turn.role === 'user')?.content || '';
  if (!lastUser) return { ok: false, reason: 'no_user_message', syntheticWakeDetected: prepared.syntheticWakeDetected };
  const skipUser = shouldSkipAutoCaptureText(lastUser);
  const skipCombined = shouldSkipAutoCaptureText(text);
  if (skipUser || skipCombined) {
    return {
      ok: false,
      reason: 'skip_pattern',
      syntheticWakeDetected: prepared.syntheticWakeDetected,
      skipUser,
      skipCombined,
    };
  }
  const signalUser = hasAutoCaptureSignal(lastUser);
  const signalCombined = hasAutoCaptureSignal(text);
  if (!signalUser && !signalCombined) {
    return {
      ok: false,
      reason: 'no_memory_signal',
      syntheticWakeDetected: prepared.syntheticWakeDetected,
      signalUser,
      signalCombined,
      syntheticWakeSummary: prepared.syntheticWakeSummary,
    };
  }
  return {
    ok: true,
    reason: 'memory_signal',
    syntheticWakeDetected: prepared.syntheticWakeDetected,
    signalUser,
    signalCombined,
    syntheticWakeSummary: prepared.syntheticWakeSummary,
  };
};

const trimPacketToBudget = (packet, { targetTokens, hardMaxTokens }) => {
  const hardChars = Math.max(1000, Number(hardMaxTokens || 25000) * 4);
  let text = JSON.stringify(packet, null, 2);
  if (text.length <= hardChars) return packet;

  const next = {
    ...packet,
    existing_memories: Array.isArray(packet.existing_memories)
      ? packet.existing_memories.slice(0, Math.max(5, Math.floor(packet.existing_memories.length / 2)))
      : [],
  };
  text = JSON.stringify(next, null, 2);
  if (text.length <= hardChars) return next;

  next.conversation = Array.isArray(next.conversation)
    ? next.conversation.slice(-Math.max(4, Math.floor(next.conversation.length / 2)))
    : [];
  text = JSON.stringify(next, null, 2);
  if (text.length <= hardChars) return next;

  const targetChars = Math.max(1000, Number(targetTokens || 10000) * 4);
  next.conversation = next.conversation.map((turn) => ({
    ...turn,
    content: String(turn.content || '').slice(0, Math.floor(targetChars / Math.max(1, next.conversation.length))).trim(),
  }));
  return next;
};

const safeScope = (value, fallback) => {
  const scope = String(value || '').trim();
  const fallbackScope = normalizeProjectionScope(fallback || 'shared', { allowEmpty: true }) || 'shared';
  if (!scope) return fallbackScope;
  if (scope.length > 80) return fallbackScope;
  if (!/^[a-zA-Z0-9:_./-]+$/.test(scope)) return fallbackScope;
  try {
    return normalizeProjectionScope(scope, { allowEmpty: true }) || fallbackScope;
  } catch {
    return fallbackScope;
  }
};

const buildExistingMemories = (db, scope, options = {}) => {
  if (!db || options.includeExistingMemories === false) return [];
  const limit = clampInt(options.existingMemoryLimit, 0, 200, 80);
  if (limit <= 0) return [];
  try {
    return listCurrentMemories(db, { statuses: ['active'], scope, limit })
      .map((row) => ({
        type: String(row.type || 'CONTEXT'),
        scope: String(row.scope || ''),
        confidence: Number(row.confidence || 0),
        content: compactText(row.content || '', 600),
      }));
  } catch {
    return [];
  }
};

const buildAutoCapturePacket = ({ db, event = {}, config = {} }) => {
  const autoConfig = config?.capture?.autoCapture || {};
  const scope = safeScope(event.scope || event.agentId, 'shared');
  const packet = {
    scope,
    agent_id: String(event.agentId || '').trim() || 'main',
    session_key: String(event.sessionKey || '').trim(),
    rules: {
      save_only_high_signal: true,
      allowed_auto_save: [
        'stable user preferences',
        'explicit decisions',
        'standing instructions',
        'durable project state',
        'important open loops',
        'operationally useful people/entity facts',
      ],
      never_save: [
        'credentials or secret values',
        'raw transcripts',
        'temporary debug/test noise',
        'hypothetical maybes',
        'unconfirmed third-party claims as facts',
        'security-sensitive host posture',
      ],
    },
    conversation: buildTurns(event, autoConfig),
    existing_memories: buildExistingMemories(db, scope, autoConfig),
  };
  return trimPacketToBudget(packet, {
    targetTokens: autoConfig.targetTokens || 10000,
    hardMaxTokens: autoConfig.hardMaxTokens || 25000,
  });
};

const resolveAutoCaptureQueuePath = (config = {}) => {
  const configured = String(config?.runtime?.paths?.autoCaptureQueuePath || '').trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.resolve(configured);
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd()).trim() || process.cwd();
  const outputDir = String(config?.runtime?.paths?.outputDir || 'output').trim() || 'output';
  const resolvedOutputDir = path.isAbsolute(outputDir) ? outputDir : path.join(workspaceRoot, outputDir);
  return path.join(resolvedOutputDir, DEFAULT_AUTO_CAPTURE_QUEUE_FILE);
};

const stableJobHash = (packet = {}) => createHash('sha256')
  .update(JSON.stringify({
    scope: packet.scope,
    agent_id: packet.agent_id,
    session_key: packet.session_key,
    conversation: packet.conversation,
  }))
  .digest('hex');

const readAutoCaptureQueue = (queuePath) => {
  if (!queuePath || !fs.existsSync(queuePath)) return [];
  const rows = [];
  const text = fs.readFileSync(queuePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      // Ignore malformed JSONL rows. The worker rewrites only parsed rows.
    }
  }
  return rows;
};

const writeAutoCaptureQueue = (queuePath, rows = []) => {
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  const trimmedRows = rows.slice(-AUTO_CAPTURE_QUEUE_MAX_ROWS);
  const body = trimmedRows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(queuePath, body ? `${body}\n` : '', 'utf8');
};

const appendJsonlRow = (filePath, row) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
};

const enqueueAutoCaptureEvent = ({
  db,
  config = {},
  event = {},
  logger,
  runId = '',
} = {}) => {
  const autoConfig = config?.capture?.autoCapture || {};
  const mode = normalizeMode(autoConfig.mode || (autoConfig.enabled ? 'review' : 'off'));
  const provider = normalizeProvider(autoConfig.provider || config?.llm?.provider || 'none');
  const summary = {
    enabled: mode !== 'off',
    mode,
    attempted: false,
    provider,
    candidates: 0,
    auto_save_candidates: 0,
    queued_review: 0,
    rejected: 0,
    shadowed: 0,
    errors: 0,
    generated_text: '',
    decisions: [],
    queued_job: false,
    queue_reason: '',
    gate_reason: '',
    synthetic_wake_detected: false,
    synthetic_wake_summary: '',
    signal_user: false,
    signal_combined: false,
    skip_user: false,
    skip_combined: false,
  };
  if (mode === 'off' || autoConfig.enabled === false || config?.capture?.enabled === false) {
    summary.queue_reason = 'disabled';
    return summary;
  }
  const gate = shouldConsiderAutoCaptureEvent({ event, config });
  summary.gate_reason = String(gate.reason || '').trim();
  summary.synthetic_wake_detected = gate.syntheticWakeDetected === true;
  summary.synthetic_wake_summary = String(gate.syntheticWakeSummary || '').trim();
  summary.signal_user = gate.signalUser === true;
  summary.signal_combined = gate.signalCombined === true;
  summary.skip_user = gate.skipUser === true;
  summary.skip_combined = gate.skipCombined === true;
  if (!gate.ok) {
    summary.queue_reason = gate.reason;
    summary.decisions.push({ route: 'skip', reason: gate.reason, synthetic_wake_detected: summary.synthetic_wake_detected });
    return summary;
  }
  try {
    const scope = safeScope(event.scope || event.agentId, 'shared');
    const packet = buildAutoCapturePacket({ db, event: { ...event, scope }, config });
    if (!Array.isArray(packet.conversation) || packet.conversation.length === 0) {
      summary.queue_reason = 'empty_packet';
      summary.decisions.push({ route: 'skip', reason: 'empty_packet' });
      return summary;
    }
    const queuePath = resolveAutoCaptureQueuePath(config);
    const rows = readAutoCaptureQueue(queuePath);
    const pendingRows = rows.filter((row) => row?.status === 'pending' || row?.status === 'failed_retryable');
    if (pendingRows.length >= AUTO_CAPTURE_QUEUE_MAX_PENDING) {
      summary.queue_reason = 'queue_full';
      summary.decisions.push({ route: 'skip', reason: 'queue_full' });
      return summary;
    }
    const hash = stableJobHash(packet);
    const duplicate = rows.slice(-AUTO_CAPTURE_QUEUE_MAX_ROWS).some((row) => row?.hash === hash && ['pending', 'failed_retryable'].includes(String(row?.status || '')));
    if (duplicate) {
      summary.queue_reason = 'duplicate_pending';
      summary.decisions.push({ route: 'skip', reason: 'duplicate_pending' });
      return summary;
    }
    const nowIso = new Date().toISOString();
    appendJsonlRow(queuePath, {
      id: `acq_${hash.slice(0, 16)}`,
      hash,
      status: 'pending',
      attempts: 0,
      enqueued_at: nowIso,
      updated_at: nowIso,
      run_id: runId || '',
      synthetic_wake_detected: summary.synthetic_wake_detected,
      synthetic_wake_summary: summary.synthetic_wake_summary,
      gate_reason: summary.gate_reason,
      packet,
    });
    summary.queued_job = true;
    summary.queue_reason = 'queued';
    summary.decisions.push({ route: 'queued', reason: 'queued' });
    appendEvent(db, {
      timestamp: nowIso,
      component: 'auto_capture',
      action: 'auto_capture_queued',
      reason_codes: ['queued', mode],
      memory_id: `candidate:${runId || hash.slice(0, 16)}`,
      cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
      run_id: runId || '',
      review_version: '',
      payload: {
        mode,
        provider,
        queue_path: queuePath,
        packet_tokens_approx: estimateTokens(JSON.stringify(packet)),
      },
    });
    return summary;
  } catch (err) {
    summary.errors += 1;
    summary.queue_reason = 'enqueue_error';
    logger?.warn?.(`[gigabrain] auto-capture enqueue error: ${err instanceof Error ? err.message : String(err)}`);
    return summary;
  }
};

const AUTO_CAPTURE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['auto_save', 'queue_review', 'reject'] },
          type: { type: 'string', enum: ['PREFERENCE', 'DECISION', 'USER_FACT', 'ENTITY', 'EPISODE', 'AGENT_IDENTITY', 'CONTEXT'] },
          content: { type: 'string' },
          scope: { type: 'string' },
          confidence: { type: 'number' },
          importance: { type: 'number' },
          sensitivity: { type: 'string', enum: ['low', 'medium', 'high'] },
          reason: { type: 'string' },
        },
        required: ['action', 'type', 'content', 'scope', 'confidence', 'importance', 'sensitivity', 'reason'],
      },
    },
  },
  required: ['candidates'],
};

const buildAutoCapturePrompt = (packet) => {
  const targetScope = safeScope(packet?.scope || packet?.agent_id, 'shared');
  return [
    'You are Gigabrain automatic memory capture review.',
    'Review the provided recent conversation and existing memories.',
    'Return ONLY compact JSON matching the configured response schema. No markdown.',
    `The target memory scope for this packet is exactly "${targetScope}". Use that scope for every candidate. Do not choose another agent scope.`,
    'Automatic capture must not write to shared/global memory unless a separate admin promotion process approves it.',
    '',
    'Decision rules:',
    '- auto_save when the user or assistant states an explicit durable operating decision, stable preference, standing instruction, role boundary, or future-runs memory requirement, provided it is not duplicate or sensitive.',
    '- auto_save only when the fact is important, durable, unambiguous, and useful in future sessions.',
    '- queue_review when useful but uncertain, possibly conflicting, or needs human/admin review.',
    '- reject normal conversation, short-lived state, generic summaries, tool noise, hypotheticals, and already-covered duplicates.',
    '- Keep each candidate atomic. Do not create broad conversation summaries.',
    '- Use existing_memories to avoid duplicates and to detect conflicts.',
    '- Do not save credentials, secret values, raw auth headers, private keys, cookies, passwords, or concrete sensitive host/security posture.',
    '- Ordinary internal architecture decisions, role boundaries, routing policies, and non-secret configuration choices are low sensitivity.',
    '- Environment variable names and missing setup requirements may be saved only if no secret value is present.',
    '- Prefer content phrased directly: "Alex prefers...", "Alex decided...", "Project X is blocked by...".',
    '- If the packet says "remember this durable operating decision" or "for future runs", treat that as a strong auto_save signal unless sensitive or duplicate.',
    '- If nothing should be saved, return {"candidates":[]}.',
    '',
    'Review packet JSON:',
    JSON.stringify(packet),
  ].join('\n');
};

const extractJsonObject = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Try to recover a JSON object from a chatty response.
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

const callOpenAiCompatibleJson = async ({ baseUrl, apiKey, model, prompt, profile, timeoutMs }) => {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('auto-capture invalid llm baseUrl');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || 45000)));
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: String(model || profile?.model || 'openclaw/default'),
        messages: [
          { role: 'system', content: 'Return JSON only. No markdown.' },
          { role: 'user', content: prompt },
        ],
        temperature: Number(profile?.temperature ?? 0.1),
        top_p: Number(profile?.top_p ?? 0.75),
        max_tokens: Number(profile?.max_tokens ?? 900),
      }),
    });
    if (!res.ok) throw new Error(`auto-capture llm http=${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
};

const completeAutoCaptureJson = async ({ config = {}, prompt, completeJson }) => {
  if (typeof completeJson === 'function') return completeJson({ config, prompt });
  const autoConfig = config?.capture?.autoCapture || {};
  const llmConfig = config?.llm || {};
  const memoryLlm = resolveMemoryLlmConfig(config);
  const profile = resolveTaskProfile({
    taskProfiles: llmConfig.taskProfiles,
    profile: autoConfig.profile || 'auto_capture',
    model: memoryLlm.enabled
      ? (memoryLlm.model || autoConfig.model || llmConfig.model || 'gemini-2.5-flash-lite')
      : (autoConfig.model || llmConfig.model || 'openclaw/default'),
  });

  if (memoryLlm.enabled) {
    return completeMemoryJson({
      config,
      prompt,
      profile,
      jsonSchema: AUTO_CAPTURE_RESPONSE_SCHEMA,
    });
  }

  const provider = normalizeProvider(autoConfig.provider || llmConfig.provider || 'none');
  rejectOpenClawMaintenanceFallback({
    provider: autoConfig.provider || llmConfig.provider || 'none',
    baseUrl: autoConfig.baseUrl || llmConfig.baseUrl || '',
    task: 'auto_capture',
  });
  if (provider === 'none') {
    return JSON.stringify({ candidates: [] });
  }
  if (provider === 'ollama') throw new Error('auto-capture ollama provider is not supported yet');
  return callOpenAiCompatibleJson({
    baseUrl: autoConfig.baseUrl || llmConfig.baseUrl || '',
    apiKey: autoConfig.apiKey || llmConfig.apiKey || '',
    model: autoConfig.model || llmConfig.model || profile.model || 'openclaw/default',
    prompt,
    profile,
    timeoutMs: autoConfig.timeoutMs || llmConfig.timeoutMs || 45000,
  });
};

const parseAutoCaptureDecision = (payload) => {
  const parsed = payload && typeof payload === 'object' ? payload : extractJsonObject(payload);
  const rawCandidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  return rawCandidates.slice(0, 20).map((candidate) => ({
    action: normalizeAction(candidate?.action),
    type: normalizeType(candidate?.type),
    content: String(candidate?.content || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    scope: String(candidate?.scope || '').trim(),
    confidence: clamp01(candidate?.confidence, 0),
    importance: clamp01(candidate?.importance, 0),
    sensitivity: normalizeSensitivity(candidate?.sensitivity),
    reason: String(candidate?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  })).filter((candidate) => candidate.content);
};

const escapeMemoryNoteContent = (value) => String(value || '')
  .replace(/<\/?memory_note\b/gi, 'memory_note')
  .replace(/</g, '‹')
  .replace(/>/g, '›')
  .trim();

const escapeAttr = (value) => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').slice(0, 120);

const notesToMemoryNoteText = (notes = []) => notes.map((note) => (
  `<memory_note type="${escapeAttr(note.type)}" confidence="${Number(note.confidence || 0).toFixed(2)}" scope="${escapeAttr(note.scope)}">${escapeMemoryNoteContent(note.content)}</memory_note>`
)).join('\n');

const deterministicCandidateType = (content = '') => {
  const text = String(content || '').toLowerCase();
  if (text.includes('prefer') || text.includes('preference')) return 'PREFERENCE';
  if (text.includes('identity') || text.includes('role:') || text.includes('reports to')) return 'CONTEXT';
  return 'DECISION';
};

const normalizeDeterministicCandidateContent = (value = '') => String(value || '')
  .replace(/^confirmed\s+durable\s+decision(?:\s+for\s+future\s+runs)?\s*:\s*/i, '')
  .replace(/^decision\s*:\s*/i, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 1200);

const extractDeterministicAutoCaptureCandidates = (packet = {}, scope = 'shared') => {
  const turns = Array.isArray(packet?.conversation) ? packet.conversation : [];
  const candidates = [];
  const seen = new Set();
  const add = (rawContent, reason = 'deterministic_explicit_signal') => {
    const content = normalizeDeterministicCandidateContent(rawContent);
    if (!content || content.length < 25) return;
    const key = content.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      action: 'auto_save',
      type: deterministicCandidateType(content),
      content,
      scope,
      confidence: 0.97,
      importance: 0.9,
      sensitivity: 'low',
      reason,
    });
  };
  for (const turn of turns) {
    const text = String(turn?.content || '').trim();
    if (!text) continue;
    const explicit = text.match(/\b(?:remember|record|confirmed)\s+(?:this\s+)?durable\s+(?:operating\s+)?decision(?:\s+for\s+future\s+runs)?\s*:\s*([\s\S]+)$/i);
    if (explicit?.[1]) add(explicit[1], 'explicit_durable_decision_marker');
    const alexDecided = text.match(/\bAlex decided\b[\s\S]{0,900}?(?:[.!?](?:\s|$)|$)/i);
    if (alexDecided?.[0]) add(alexDecided[0], 'explicit_alex_decided_marker');
    for (const match of text.matchAll(/(?:^|\n)\s*(?:Decision|Final decision)\s*:\s*([^\n]{25,900})/gi)) {
      add(match[1], 'explicit_decision_line');
    }
    for (const match of text.matchAll(/(?:^|\n)\s*(?:Going forward|For future runs)\s*,\s*([^\n]{25,900})/gi)) {
      add(match[1], 'explicit_future_runs_line');
    }
  }
  return candidates;
};

const classifyCandidate = (candidate, config = {}, fallbackScope = 'shared') => {
  const autoConfig = config?.capture?.autoCapture || {};
  const minConfidence = clamp01(autoConfig.minConfidence ?? 0.88, 0.88);
  const minImportance = clamp01(autoConfig.minImportance ?? 0.75, 0.75);
  const queueMinConfidence = clamp01(autoConfig.queueMinConfidence ?? 0.65, 0.65);
  const queueMinImportance = clamp01(autoConfig.queueMinImportance ?? 0.5, 0.5);
  const content = String(candidate.content || '').trim();
  const scope = safeScope(candidate.scope, fallbackScope);
  const isDeterministicallySensitive = containsSecretLikeValue(content) || containsSensitiveOperationalPosture(content);
  const effectiveSensitivity = isDeterministicallySensitive
    ? 'high'
    : (candidate.sensitivity === 'high' ? 'low' : candidate.sensitivity);
  const effectiveCandidate = { ...candidate, scope, sensitivity: effectiveSensitivity };
  if (!content || content.length < Math.max(10, Number(autoConfig.minContentChars || 20))) {
    return { route: 'reject', candidate: effectiveCandidate, reason: 'too_short' };
  }
  if (effectiveSensitivity === 'high') {
    return { route: 'reject', candidate: effectiveCandidate, reason: 'sensitive' };
  }
  if (scope === 'shared' && autoConfig.allowSharedAutoSave !== true) {
    if ((candidate.action === 'auto_save' || candidate.action === 'queue_review')
      && candidate.confidence >= queueMinConfidence
      && candidate.importance >= queueMinImportance) {
      return { route: 'queue_review', candidate: effectiveCandidate, reason: 'shared_requires_review' };
    }
    return { route: 'reject', candidate: effectiveCandidate, reason: 'shared_auto_save_disabled' };
  }
  if (candidate.action === 'auto_save'
    && AUTO_SAVE_TYPES.has(candidate.type)
    && effectiveSensitivity === 'low'
    && candidate.confidence >= minConfidence
    && candidate.importance >= minImportance) {
    return { route: 'auto_save', candidate: effectiveCandidate, reason: 'passed_thresholds' };
  }
  if ((candidate.action === 'queue_review' || candidate.action === 'auto_save')
    && effectiveSensitivity !== 'high'
    && candidate.confidence >= queueMinConfidence
    && candidate.importance >= queueMinImportance) {
    return { route: 'queue_review', candidate: effectiveCandidate, reason: 'review_thresholds' };
  }
  return { route: 'reject', candidate: effectiveCandidate, reason: 'below_thresholds' };
};

const queueAutoCaptureCandidate = ({ queuePath, config, nowIso, candidate, reason }) => {
  appendQueueRow(queuePath, {
    timestamp: nowIso,
    status: 'pending',
    reason: 'auto_capture_review',
    reason_code: 'capture_review_required',
    action: 'capture_review',
    payload: {
      type: candidate.type,
      content: candidate.content,
      excerpt: candidate.content.slice(0, 280),
      scope: candidate.scope,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sensitivity: candidate.sensitivity,
      route_reason: reason,
      auto_capture_reason: candidate.reason,
    },
  }, {
    retentionConfig: config?.runtime?.reviewQueueRetention,
  });
};

const processAutoCapturePacket = async ({
  db,
  config = {},
  packet,
  logger,
  runId = '',
  reviewVersion = '',
  completeJson,
}) => {
  const autoConfig = config?.capture?.autoCapture || {};
  const mode = normalizeMode(autoConfig.mode || (autoConfig.enabled ? 'review' : 'off'));
  const summary = {
    enabled: mode !== 'off',
    mode,
    attempted: false,
    provider: resolveMemoryLlmConfig(config).enabled
      ? `memory_llm:${resolveMemoryLlmConfig(config).provider}`
      : normalizeProvider(autoConfig.provider || config?.llm?.provider || 'none'),
    candidates: 0,
    auto_save_candidates: 0,
    queued_review: 0,
    rejected: 0,
    shadowed: 0,
    errors: 0,
    error: '',
    generated_text: '',
    decisions: [],
  };
  if (mode === 'off' || config?.capture?.enabled === false) return summary;

  const nowIso = new Date().toISOString();
  const scope = safeScope(packet?.scope || packet?.agent_id, 'shared');
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
  try {
    const prompt = buildAutoCapturePrompt(packet);
    summary.attempted = true;
    const raw = await completeAutoCaptureJson({ config, prompt, completeJson });
    const maxCandidates = clampInt(autoConfig.maxCandidates, 0, 20, 5);
    const deterministicCandidates = extractDeterministicAutoCaptureCandidates(packet, scope);
    const parsedCandidates = parseAutoCaptureDecision(raw);
    const seenCandidates = new Set();
    const candidates = [];
    for (const candidate of [...deterministicCandidates, ...parsedCandidates]) {
      const key = `${String(candidate.type || '')}|${String(candidate.content || '').toLowerCase()}`;
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);
      candidates.push(candidate);
      if (candidates.length >= maxCandidates) break;
    }
    summary.candidates = candidates.length;

    const saveNotes = [];
    for (const candidate of candidates) {
      const scopedCandidate = { ...candidate, scope };
      const classified = classifyCandidate(scopedCandidate, config, scope);
      summary.decisions.push({
        route: classified.route,
        type: classified.candidate.type,
        scope: classified.candidate.scope,
        confidence: classified.candidate.confidence,
        importance: classified.candidate.importance,
        sensitivity: classified.candidate.sensitivity,
        reason: classified.reason,
      });
      if (mode === 'shadow') {
        summary.shadowed += 1;
        continue;
      }
      if (classified.route === 'auto_save' && mode === 'auto') {
        saveNotes.push(classified.candidate);
        summary.auto_save_candidates += 1;
        continue;
      }
      if ((classified.route === 'queue_review' || (classified.route === 'auto_save' && mode === 'review')) && queuePath) {
        queueAutoCaptureCandidate({
          queuePath,
          config,
          nowIso,
          candidate: classified.candidate,
          reason: classified.reason,
        });
        summary.queued_review += 1;
        continue;
      }
      summary.rejected += 1;
    }
    summary.generated_text = notesToMemoryNoteText(saveNotes);
    appendEvent(db, {
      timestamp: nowIso,
      component: 'auto_capture',
      action: 'auto_capture_decision',
      reason_codes: ['complete', mode],
      memory_id: `candidate:${runId || nowIso}`,
      cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
      run_id: runId || '',
      review_version: reviewVersion || '',
      payload: {
        mode,
        attempted: summary.attempted,
        candidates: summary.candidates,
        auto_save_candidates: summary.auto_save_candidates,
        queued_review: summary.queued_review,
        rejected: summary.rejected,
        shadowed: summary.shadowed,
        decisions: summary.decisions,
        packet_tokens_approx: estimateTokens(JSON.stringify(packet)),
      },
    });
    return summary;
  } catch (err) {
    summary.errors += 1;
    summary.error = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`[gigabrain] auto-capture error: ${summary.error}`);
    appendEvent(db, {
      timestamp: nowIso,
      component: 'auto_capture',
      action: 'auto_capture_error',
      reason_codes: ['error'],
      memory_id: `candidate:${runId || nowIso}`,
      cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
      run_id: runId || '',
      review_version: reviewVersion || '',
      payload: {
        mode,
        error: summary.error,
      },
    });
    return summary;
  }
};

const autoCaptureFromEvent = async ({
  db,
  config,
  event = {},
  logger,
  runId,
  reviewVersion = '',
  completeJson,
}) => {
  const autoConfig = config?.capture?.autoCapture || {};
  const mode = normalizeMode(autoConfig.mode || (autoConfig.enabled ? 'review' : 'off'));
  if (mode === 'off' || config?.capture?.enabled === false) {
    return {
      enabled: false,
      mode,
      attempted: false,
      provider: resolveMemoryLlmConfig(config).enabled
      ? `memory_llm:${resolveMemoryLlmConfig(config).provider}`
      : normalizeProvider(autoConfig.provider || config?.llm?.provider || 'none'),
      candidates: 0,
      auto_save_candidates: 0,
      queued_review: 0,
      rejected: 0,
      shadowed: 0,
      errors: 0,
      error: '',
      generated_text: '',
      decisions: [],
    };
  }
  const scope = safeScope(event.scope || event.agentId, 'shared');
  const packet = buildAutoCapturePacket({ db, event: { ...event, scope }, config });
  return processAutoCapturePacket({
    db,
    config,
    packet,
    logger,
    runId,
    reviewVersion,
    completeJson,
  });
};

const processAutoCaptureQueue = async ({
  db,
  config = {},
  queuePath = '',
  limit = 3,
  logger,
  completeJson,
  reviewVersion = '',
} = {}) => {
  const resolvedQueuePath = queuePath || resolveAutoCaptureQueuePath(config);
  const rows = readAutoCaptureQueue(resolvedQueuePath);
  const maxToProcess = clampInt(limit, 1, 20, 3);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const circuit = resolveAutoCaptureCircuit(rows, nowMs);
  let processed = 0;
  let completed = 0;
  let failed = 0;
  let autoSaved = 0;
  let queuedReview = 0;
  const results = [];

  if (circuit.open) {
    return {
      queuePath: resolvedQueuePath,
      rows: rows.length,
      processed,
      completed,
      failed,
      autoSaved,
      queuedReview,
      circuit_open: true,
      circuit_failure_count: circuit.failure_count,
      circuit_open_until: circuit.open_until,
      results,
    };
  }

  for (const row of rows) {
    if (processed >= maxToProcess) break;
    const status = String(row?.status || 'pending');
    const attempts = Number(row?.attempts || 0);
    if (!['pending', 'failed_retryable'].includes(status)) continue;
    if (attempts >= AUTO_CAPTURE_QUEUE_MAX_ATTEMPTS) continue;
    if (shouldDeferAutoCaptureRow(row, nowMs)) continue;
    if (!row?.packet || typeof row.packet !== 'object') {
      row.status = 'failed_terminal';
      row.updated_at = nowIso;
      row.error_class = 'missing_packet';
      row.error_message = 'missing_packet';
      row.error = 'missing_packet';
      failed += 1;
      continue;
    }
    processed += 1;
    row.status = 'processing';
    row.updated_at = nowIso;
    row.attempts = attempts + 1;
    try {
      const summary = await processAutoCapturePacket({
        db,
        config,
        packet: row.packet,
        logger,
        runId: row.run_id || row.id || '',
        reviewVersion,
        completeJson,
      });
      if (summary.generated_text) {
        const capture = captureFromEvent({
          db,
          config,
          event: {
            agentId: row.packet.agent_id || 'main',
            sessionKey: row.packet.session_key || '',
            scope: row.packet.scope || 'shared',
            text: summary.generated_text,
            prompt: '',
            messages: [],
          },
          logger,
          runId: `${row.run_id || row.id || 'auto-capture'}-save`,
          reviewVersion,
        });
        summary.capture = {
          inserted: capture.inserted || 0,
          queued_review: capture.queued_review || 0,
          inserted_ids: capture.inserted_ids || [],
          queued_ids: capture.queued_ids || [],
        };
      }
      row.result = {
        attempted: summary.attempted,
        provider: summary.provider,
        candidates: summary.candidates,
        auto_save_candidates: summary.auto_save_candidates,
        queued_review: summary.queued_review,
        rejected: summary.rejected,
        shadowed: summary.shadowed,
        errors: summary.errors,
        error: summary.error || '',
        decisions: summary.decisions || [],
        capture: summary.capture || null,
      };
      if (Number(summary.errors || 0) > 0) {
        const errorText = summary.error || 'auto_capture_error';
        const retryable = isRetryableAutoCaptureError(errorText) && row.attempts < AUTO_CAPTURE_QUEUE_MAX_ATTEMPTS;
        row.status = retryable ? 'failed_retryable' : 'failed_terminal';
        row.updated_at = new Date().toISOString();
        row.error_class = classifyAutoCaptureError(errorText);
        row.error_message = errorText;
        row.next_attempt_at = retryable ? nextRetryAt(row.attempts) : '';
        failed += 1;
        results.push({ id: row.id, status: row.status, error: row.error_message, result: row.result });
        continue;
      }
      row.status = 'completed';
      row.processed_at = new Date().toISOString();
      row.updated_at = row.processed_at;
      row.error_class = '';
      row.error_message = '';
      row.next_attempt_at = '';
      completed += 1;
      autoSaved += Number(summary.capture?.inserted || 0);
      queuedReview += Number(summary.queued_review || 0) + Number(summary.capture?.queued_review || 0);
      results.push({ id: row.id, status: row.status, result: row.result });
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      const retryable = isRetryableAutoCaptureError(errorText) && row.attempts < AUTO_CAPTURE_QUEUE_MAX_ATTEMPTS;
      row.status = retryable ? 'failed_retryable' : 'failed_terminal';
      row.updated_at = new Date().toISOString();
      row.error_class = classifyAutoCaptureError(errorText);
      row.error_message = errorText;
      row.error = errorText;
      row.next_attempt_at = retryable ? nextRetryAt(row.attempts) : '';
      failed += 1;
      results.push({ id: row.id, status: row.status, error: row.error });
    }
  }

  const retainedRows = rows
    .filter((row) => row?.status !== 'completed' || Date.parse(String(row?.processed_at || '')) > Date.now() - 24 * 60 * 60 * 1000)
    .slice(-AUTO_CAPTURE_QUEUE_MAX_ROWS);
  writeAutoCaptureQueue(resolvedQueuePath, retainedRows);
  return {
    queuePath: resolvedQueuePath,
    rows: rows.length,
    processed,
    completed,
    failed,
    autoSaved,
    queuedReview,
    results,
  };
};


export {
  redactSensitiveText,
  containsSecretLikeValue,
  isToolLikeText,
  shouldConsiderAutoCaptureEvent,
  resolveAutoCaptureQueuePath,
  enqueueAutoCaptureEvent,
  processAutoCaptureQueue,
  resolveAutoCaptureCircuit,
  shouldDeferAutoCaptureRow,
  buildAutoCapturePacket,
  buildAutoCapturePrompt,
  parseAutoCaptureDecision,
  classifyCandidate,
  notesToMemoryNoteText,
  autoCaptureFromEvent,
};

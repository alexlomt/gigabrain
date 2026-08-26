import { normalizeAgentScope } from './scope-policy.js';

const AUTO_CAPTURE_LIMITS = Object.freeze({
  timeoutMs: 30000,
  minConfidence: 0.90,
  minImportance: 0.78,
  queueMinConfidence: 0.70,
  queueMinImportance: 0.55,
  minContentChars: 25,
  maxCandidates: 3,
  maxTurns: 10,
  maxCharsPerTurn: 1500,
  targetTokens: 6000,
  softMaxTokens: 8000,
  hardMaxTokens: 12000,
  existingMemoryLimit: 20,
  minTriggerChars: 80,
  processingStaleMs: 180000,
});

const MEMORY_NOTE_RE = /<memory_note\b/i;
const MEMORY_FLUSH_RE = /\b(?:pre-compaction memory flush|memory flush turn|session nearing compaction|store durable memories now|capture important facts from this conversation using <memory_note>)\b/i;
const EXPLICIT_DURABLE_RE = /\b(?:remember(?:\s+that)?|save this|note this down|keep this in memory|we (?:have )?decided|decision\s*:|we will|we have chosen|approved\s*:)/i;
const SECRET_RE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:sk|rk|pk|sess|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}|\b[A-Za-z0-9_.-]*(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd|pwd|client[_ -]?secret)[A-Za-z0-9_.-]*\s*[:=]\s*["']?[^"'\s,;]+|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b)/i;
const HOST_POSTURE_RE = /(?:\b(?:host|security) posture\b|\/etc\/ssh\/sshd_config\b|\/proc\/(?:self|\d+)|\b(?:ufw|iptables|nftables)\s+(?:status|rules?|list)\b|\b(?:listening|open) ports?\b|\bsystemctl\s+status\b|\bpermissionMode\s*=\s*approve-all\b|\bpluginToolsMcpBridge\b)/i;
const REASONING_TAG_RE = /<(?:thinking|reasoning|analysis)\b[\s\S]*?<\/(?:thinking|reasoning|analysis)>/i;
const PAPERCLIP_WAKE_RE = /\bpaperclip\b[^\n]{0,80}\bwake\b|\bwake\b[^\n]{0,80}\bpaperclip\b/i;
const PAPERCLIP_SAFE_LINE_RE = /^(?:issue|title|objective|task|summary|acceptance criteria|priority|context|constraints?)\s*:/i;
const PAPERCLIP_ENVELOPE_LINE_RE = /^(?:paperclip\b.*\bwake\b|runtime metadata|timestamp|wake id|run id|session id|scheduler|status|assignee|agent)\s*:/i;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const cleanText = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const compactText = (value) => cleanText(value).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

const contentText = (value) => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return isRecord(value) && typeof value.text === 'string' ? value.text : '';
  return value
    .filter((part) => !isRecord(part) || !part.type || ['text', 'input_text', 'output_text'].includes(String(part.type)))
    .map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
};

const truncateText = (value, limit = AUTO_CAPTURE_LIMITS.maxCharsPerTurn) => {
  const text = compactText(value);
  if (text.length <= limit) return text;
  return text.slice(0, limit).trimEnd();
};

const sanitizePaperclipWake = (value) => {
  const text = compactText(value);
  if (!PAPERCLIP_WAKE_RE.test(text)) return text;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !PAPERCLIP_ENVELOPE_LINE_RE.test(line))
    .filter((line) => PAPERCLIP_SAFE_LINE_RE.test(line));
  return truncateText(lines.join('\n'));
};

const rawEventText = (event = {}) => {
  const parts = [];
  for (const key of ['prompt', 'text', 'output', 'response', 'result', 'final']) {
    const value = contentText(event?.[key]);
    if (value) parts.push(value);
  }
  for (const message of Array.isArray(event?.messages) ? event.messages : []) {
    const value = contentText(message?.content ?? message?.text ?? message?.output);
    if (value) parts.push(value);
  }
  return parts.join('\n');
};

const hasMedia = (event = {}) => Boolean(
  event?.media
  || event?.image
  || event?.audio
  || event?.video
  || (Array.isArray(event?.attachments) && event.attachments.length > 0)
  || (Array.isArray(event?.messages) && event.messages.some((message) => (
    Array.isArray(message?.content)
    && message.content.some((part) => isRecord(part) && part.type && !['text', 'input_text', 'output_text'].includes(String(part.type)))
  ))),
);

const hasReasoningMessage = (event = {}) => (
  Array.isArray(event?.messages)
  && event.messages.some((message) => {
    const role = String(message?.role || message?.author || '').trim().toLowerCase();
    const text = contentText(message?.content ?? message?.text ?? message?.output);
    return ['reasoning', 'thinking', 'analysis'].includes(role) || REASONING_TAG_RE.test(text);
  })
);

const isTestEvent = (event = {}) => Boolean(
  event?.test === true
  || event?.isTest === true
  || event?.metadata?.test === true
  || event?.meta?.test === true
  || String(event?.channel || event?.surface || '').trim().toLowerCase() === 'test'
);

const resolveTrustedAutoCaptureScope = (context = {}) => {
  const agentId = String(context?.agentId || '').trim();
  if (agentId) return normalizeAgentScope(agentId);
  const sessionKey = String(context?.sessionKey || '').trim();
  const parts = sessionKey.split(':');
  return normalizeAgentScope(parts[0] === 'agent' ? parts[1] : 'shared');
};

const classifyAutoCaptureCandidate = (candidate = {}) => {
  const role = String(candidate?.role || '').trim().toLowerCase();
  if (role === 'assistant' || role === 'model') {
    return { action: 'reject', reason: 'transient_or_assistant' };
  }
  if (
    !['user', 'human'].includes(role)
    || candidate?.reasoning === true
    || candidate?.media === true
    || candidate?.test === true
  ) {
    return { action: 'reject', reason: 'excluded_content' };
  }
  const content = compactText(candidate?.content);
  if (
    candidate?.containsSecret === true
    || SECRET_RE.test(content)
    || HOST_POSTURE_RE.test(content)
  ) {
    return { action: 'reject', reason: 'sensitive' };
  }
  if (content.length < AUTO_CAPTURE_LIMITS.minContentChars) {
    return { action: 'reject', reason: 'transient_or_assistant' };
  }
  const explicit = EXPLICIT_DURABLE_RE.test(content);
  if (normalizeAgentScope(candidate?.scope) === 'shared') {
    return { action: 'review', reason: 'shared_review_only' };
  }
  if (explicit) return { action: 'save', reason: 'explicit_durable_request' };
  return { action: 'review', reason: 'candidate_review' };
};

const collectTurns = (event = {}) => {
  const turns = [];
  const append = (role, value) => {
    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!['user', 'human', 'assistant', 'model'].includes(normalizedRole)) return;
    let content = contentText(value);
    if (normalizedRole === 'user' || normalizedRole === 'human') content = sanitizePaperclipWake(content);
    else content = truncateText(content);
    if (!content) return;
    const normalized = normalizedRole === 'human' ? 'user' : normalizedRole === 'model' ? 'assistant' : normalizedRole;
    if (turns.at(-1)?.role === normalized && turns.at(-1)?.content === content) return;
    turns.push({ role: normalized, content });
  };

  for (const message of Array.isArray(event?.messages) ? event.messages : []) {
    append(message?.role || message?.author, message?.content ?? message?.text ?? message?.output);
  }
  if (!turns.some((turn) => turn.role === 'user')) append('user', event?.prompt ?? event?.text);
  append('assistant', event?.output ?? event?.response ?? event?.result ?? event?.final);
  return turns.slice(-AUTO_CAPTURE_LIMITS.maxTurns);
};

const inactiveReason = (config = {}) => {
  if (config?.capture?.enabled === false) return 'capture_disabled';
  const autoCapture = config?.capture?.autoCapture || {};
  if (autoCapture.enabled !== true || String(autoCapture.mode || '').trim().toLowerCase() === 'off') {
    return 'auto_capture_disabled';
  }
  return '';
};

const prepareAutoCaptureEvent = ({ config = {}, context = {}, event = {} } = {}) => {
  const disabled = inactiveReason(config);
  if (disabled) return { eligible: false, reason: disabled };

  const rawText = rawEventText(event);
  if (MEMORY_NOTE_RE.test(rawText)) return { eligible: false, reason: 'explicit_memory_note' };
  if (MEMORY_FLUSH_RE.test(rawText)) return { eligible: false, reason: 'memory_flush' };
  if (isTestEvent(event)) return { eligible: false, reason: 'test_event' };
  if (hasMedia(event)) return { eligible: false, reason: 'media_event' };
  if (hasReasoningMessage(event)) return { eligible: false, reason: 'reasoning_event' };
  if (SECRET_RE.test(rawText) || HOST_POSTURE_RE.test(rawText)) return { eligible: false, reason: 'sensitive' };

  const messages = collectTurns(event);
  const userTurns = messages.filter((turn) => turn.role === 'user');
  if (userTurns.length === 0) return { eligible: false, reason: 'no_user_content' };
  const scope = resolveTrustedAutoCaptureScope(context);
  const configuredMode = String(config?.capture?.autoCapture?.mode || 'review').trim().toLowerCase();
  const mode = scope === 'shared' ? 'review' : configuredMode;
  let decision = classifyAutoCaptureCandidate({
    content: userTurns.at(-1).content,
    mode,
    role: 'user',
    scope,
  });
  if (decision.action === 'reject') return { eligible: false, reason: decision.reason };
  const explicit = decision.reason === 'explicit_durable_request' || decision.reason === 'shared_review_only';
  const triggerChars = userTurns.reduce((total, turn) => total + turn.content.length, 0);
  if (!explicit && triggerChars < AUTO_CAPTURE_LIMITS.minTriggerChars) {
    return { eligible: false, reason: 'insufficient_content' };
  }
  if (decision.action === 'save' && mode !== 'auto') {
    decision = { action: 'review', reason: mode === 'shadow' ? 'shadow_review_only' : 'configured_review_only' };
  }

  return {
    eligible: true,
    event: {
      schemaVersion: 1,
      source: 'openclaw.agent_end',
      scope,
      mode,
      sessionKey: String(context?.sessionKey || event?.sessionKey || '').trim().slice(0, 256),
      decision,
      messages,
    },
  };
};

const createAutoCaptureHook = ({
  config = {},
  enqueue,
  logger = {},
  runIdFactory = () => `auto-capture-${Date.now()}`,
} = {}) => (event = {}, context = {}) => {
  let prepared;
  try {
    prepared = prepareAutoCaptureEvent({ config, context, event });
  } catch {
    logger.warn?.('[gigabrain] auto-capture policy rejected an invalid event');
    return undefined;
  }
  if (!prepared.eligible) return undefined;
  queueMicrotask(() => {
    let pending;
    try {
      if (typeof enqueue !== 'function') throw new Error('AUTO_CAPTURE_ENQUEUE_UNAVAILABLE');
      pending = enqueue({ config, event: prepared.event, runId: String(runIdFactory() || '') });
    } catch {
      logger.warn?.('[gigabrain] auto-capture enqueue failed');
      return;
    }
    Promise.resolve(pending).catch(() => logger.warn?.('[gigabrain] auto-capture enqueue failed'));
  });
  return undefined;
};

export {
  AUTO_CAPTURE_LIMITS,
  classifyAutoCaptureCandidate,
  createAutoCaptureHook,
  prepareAutoCaptureEvent,
  resolveTrustedAutoCaptureScope,
  sanitizePaperclipWake,
};

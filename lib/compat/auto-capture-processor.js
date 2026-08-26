import { completeMemoryJson } from './memory-llm-client.js';
import { containsSensitiveAutoCaptureContent } from './auto-capture-policy.js';
import { resolveRuntimeDescriptor } from './runtime-descriptor.js';
import { captureFromEvent } from '../core/capture-service.js';
import { ensureProjectionStore, listCurrentMemories } from '../core/projection-store.js';
import { appendQueueRow } from '../core/review-queue.js';
import { openDatabase } from '../core/sqlite.js';

const MEMORY_TYPES = new Set([
  'AGENT_IDENTITY',
  'CONTEXT',
  'DECISION',
  'ENTITY',
  'EPISODE',
  'PREFERENCE',
  'USER_FACT',
]);
const ACTIONS = new Set(['auto_save', 'queue_review', 'reject']);
const SENSITIVITY = new Set(['low', 'medium', 'high']);
const MAX_CANDIDATES = 3;
const MAX_EXISTING = 20;

const AUTO_CAPTURE_RESPONSE_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    candidates: {
      items: {
        additionalProperties: false,
        properties: {
          action: { enum: [...ACTIONS], type: 'string' },
          confidence: { maximum: 1, minimum: 0, type: 'number' },
          content: { maxLength: 1200, minLength: 1, type: 'string' },
          importance: { maximum: 1, minimum: 0, type: 'number' },
          reason: { maxLength: 240, type: 'string' },
          scope: { type: 'string' },
          sensitivity: { enum: [...SENSITIVITY], type: 'string' },
          type: { enum: [...MEMORY_TYPES], type: 'string' },
        },
        required: ['action', 'confidence', 'content', 'importance', 'reason', 'scope', 'sensitivity', 'type'],
        type: 'object',
      },
      maxItems: MAX_CANDIDATES,
      type: 'array',
    },
  },
  required: ['candidates'],
  type: 'object',
});

const clamp = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
};
const clean = (value, max = 1200) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
const normalized = (value) => clean(value).normalize('NFKC').toLocaleLowerCase('en-US');
const safeScope = (value) => String(value || '').trim().slice(0, 256) || 'shared';

const parseCandidates = (value, scope) => {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error('AUTO_CAPTURE_MODEL_RESPONSE_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.candidates)) {
    throw new Error('AUTO_CAPTURE_MODEL_RESPONSE_INVALID');
  }
  const candidates = [];
  for (const raw of parsed.candidates.slice(0, MAX_CANDIDATES)) {
    const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw).sort() : [];
    if (keys.join('\0') !== 'action\0confidence\0content\0importance\0reason\0scope\0sensitivity\0type') {
      throw new Error('AUTO_CAPTURE_MODEL_RESPONSE_INVALID');
    }
    const action = String(raw.action || '').trim();
    const type = String(raw.type || '').trim().toUpperCase();
    const sensitivity = String(raw.sensitivity || '').trim().toLowerCase();
    const content = clean(raw.content);
    if (
      !ACTIONS.has(action)
      || !MEMORY_TYPES.has(type)
      || !SENSITIVITY.has(sensitivity)
      || !content
      || !Number.isFinite(Number(raw.confidence))
      || Number(raw.confidence) < 0
      || Number(raw.confidence) > 1
      || !Number.isFinite(Number(raw.importance))
      || Number(raw.importance) < 0
      || Number(raw.importance) > 1
    ) throw new Error('AUTO_CAPTURE_MODEL_RESPONSE_INVALID');
    candidates.push({
      action,
      confidence: Number(raw.confidence),
      content,
      importance: Number(raw.importance),
      reason: clean(raw.reason, 240),
      scope,
      sensitivity,
      type,
    });
  }
  return candidates;
};

const deterministicExplicitCandidate = (packet, scope) => {
  if (
    String(packet?.decision?.action || '') !== 'save'
    || String(packet?.decision?.reason || '') !== 'explicit_durable_request'
  ) return null;
  const userText = [...(Array.isArray(packet?.messages) ? packet.messages : [])]
    .reverse()
    .find((message) => String(message?.role || '') === 'user')?.content;
  let content = clean(userText);
  content = content
    .replace(/^decision\s*:\s*/i, '')
    .replace(/^(?:please\s+)?remember(?:\s+that)?\s+/i, '')
    .replace(/^note\s+this\s+down\s*:\s*/i, '')
    .trim();
  if (content.length < 25 || containsSensitiveAutoCaptureContent(content)) return null;
  const lower = content.toLowerCase();
  const type = /\bprefer(?:s|red|ence)?\b/.test(lower)
    ? 'PREFERENCE'
    : /\b(?:decision|decided|going forward|keep|must|will)\b/.test(lower)
      ? 'DECISION'
      : 'CONTEXT';
  return {
    action: 'auto_save',
    confidence: 0.99,
    content,
    importance: 0.9,
    reason: 'explicit_durable_request',
    scope,
    sensitivity: 'low',
    type,
  };
};

const buildPrompt = ({ packet, existing }) => [
  'Review one bounded conversation for durable memory candidates.',
  'Return compact JSON only, matching the supplied schema.',
  `Every candidate scope is fixed to ${JSON.stringify(packet.scope)}; never infer another scope.`,
  'Reject secrets, credentials, host-security posture, transient chatter, tests, tools, and duplicates.',
  'Use auto_save only for atomic durable facts; use queue_review when useful but uncertain.',
  JSON.stringify({
    existing_memories: existing.map((row) => ({
      content: clean(row?.content, 500),
      memory_id: clean(row?.memory_id, 128),
      scope: safeScope(row?.scope),
      type: String(row?.type || 'CONTEXT').trim().toUpperCase(),
    })),
    messages: packet.messages,
    mode: packet.mode,
    scope: packet.scope,
  }),
].join('\n');

const resolveRoute = (candidate, config, scope) => {
  const policy = config?.capture?.autoCapture || {};
  if (candidate.action === 'reject' || candidate.sensitivity === 'high') return 'reject';
  if (containsSensitiveAutoCaptureContent(candidate.content)) return 'reject';
  const minLength = Math.max(1, Number(policy.minContentChars || 25));
  if (candidate.content.length < minLength) return 'reject';
  const high = candidate.confidence >= clamp(policy.minConfidence, 0.90)
    && candidate.importance >= clamp(policy.minImportance, 0.78);
  const review = candidate.confidence >= clamp(policy.queueMinConfidence, 0.70)
    && candidate.importance >= clamp(policy.queueMinImportance, 0.55);
  if (scope === 'shared') return review ? 'queue_review' : 'reject';
  if (candidate.action === 'auto_save' && high) return 'auto_save';
  if (['auto_save', 'queue_review'].includes(candidate.action) && review) return 'queue_review';
  return 'reject';
};

const escapeXml = (value) => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const defaultCaptureCandidate = async ({ candidate, config, db, packet, runId }) => {
  const note = `<memory_note type="${escapeXml(candidate.type)}" confidence="${candidate.confidence.toFixed(2)}" scope="${escapeXml(candidate.scope)}">${escapeXml(candidate.content)}</memory_note>`;
  const result = await captureFromEvent({
    config,
    db,
    event: {
      agentId: candidate.scope.startsWith('profile:') ? candidate.scope.slice(8) : candidate.scope,
      output: note,
      scope: candidate.scope,
      sessionKey: packet.sessionKey,
    },
    logger: { info() {}, warn() {} },
    runId,
  });
  return Number(result?.inserted || 0);
};

const defaultQueueCandidate = async ({ candidate, config }) => {
  const result = appendQueueRow(config?.runtime?.paths?.reviewQueuePath, {
    action: 'capture_review',
    payload: {
      confidence: candidate.confidence,
      content: candidate.content,
      excerpt: candidate.content.slice(0, 280),
      importance: candidate.importance,
      scope: candidate.scope,
      sensitivity: candidate.sensitivity,
      type: candidate.type,
    },
    reason: 'auto_capture_review',
    reason_code: 'capture_review_required',
    status: 'pending',
    timestamp: new Date().toISOString(),
  }, { retentionConfig: config?.runtime?.reviewQueueRetention });
  return result?.appended ? 1 : 0;
};

const actionCount = (value) => {
  if (Number.isInteger(value)) return Math.max(0, value);
  if (value?.appended === true) return 1;
  if (Number.isInteger(value?.inserted)) return Math.max(0, value.inserted);
  return value === false ? 0 : 1;
};

const processAutoCaptureJob = async ({
  captureCandidate = defaultCaptureCandidate,
  completeJson,
  config = {},
  db,
  listExistingMemories,
  packet = {},
  queueCandidate = defaultQueueCandidate,
  runId = '',
} = {}) => {
  const scope = safeScope(packet.scope);
  const messages = Array.isArray(packet.messages) ? packet.messages : [];
  if (messages.some((message) => containsSensitiveAutoCaptureContent(message?.content))) {
    throw new Error('AUTO_CAPTURE_PACKET_SENSITIVE');
  }
  const mode = ['auto', 'review', 'shadow'].includes(String(packet.mode || ''))
    ? String(packet.mode)
    : String(config?.capture?.autoCapture?.mode || 'review');
  const list = listExistingMemories || (async ({ limit }) => listCurrentMemories(db, { statuses: ['active'] }).slice(0, limit));
  const existing = (await list({ db, limit: MAX_EXISTING, scope }))
    .filter((row) => safeScope(row?.scope) === scope)
    .slice(0, MAX_EXISTING);
  const known = new Set(existing.map((row) => normalized(row?.content)).filter(Boolean));
  const deterministic = deterministicExplicitCandidate(packet, scope);
  let candidates;
  if (deterministic) {
    candidates = [deterministic];
  } else {
    const profile = config?.llm?.taskProfiles?.auto_capture || {};
    const prompt = buildPrompt({ existing, packet: { ...packet, scope } });
    const response = completeJson
      ? await completeJson({ config, jsonSchema: AUTO_CAPTURE_RESPONSE_SCHEMA, profile, prompt })
      : await completeMemoryJson({ config, jsonSchema: AUTO_CAPTURE_RESPONSE_SCHEMA, profile, prompt });
    candidates = parseCandidates(response, scope);
  }
  let autoSaved = 0;
  let queuedReview = 0;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (known.has(normalized(candidate.content))) continue;
    const route = resolveRoute(candidate, config, scope);
    if (mode === 'shadow' || route === 'reject') continue;
    if (route === 'auto_save' && mode === 'auto') {
      autoSaved += actionCount(await captureCandidate({ candidate, config, db, packet, runId }));
      continue;
    }
    if (route === 'queue_review' || (route === 'auto_save' && mode === 'review')) {
      queuedReview += actionCount(await queueCandidate({ candidate, config, db, packet, runId }));
    }
  }
  return { autoSaved, queuedReview };
};

const createAutoCaptureJobProcessor = ({ config = {}, runId = '' } = {}) => async ({ job, packet }) => {
  const descriptor = resolveRuntimeDescriptor(config);
  const db = openDatabase(descriptor.dbPath);
  try {
    ensureProjectionStore(db);
    return await processAutoCaptureJob({ config, db, packet, runId: runId || job?.run_id || '' });
  } finally {
    db.close();
  }
};

export {
  AUTO_CAPTURE_RESPONSE_SCHEMA,
  createAutoCaptureJobProcessor,
  processAutoCaptureJob,
};

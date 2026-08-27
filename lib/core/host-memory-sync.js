import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendEvent } from './event-store.js';
import { hashNormalized, normalizeContent } from './policy.js';
import {
  ensureProjectionStore,
  getCurrentMemory,
  hasTable,
  listCurrentMemories,
  upsertCurrentMemory,
  withProjectionMutationBatch,
} from './projection-store.js';
import { ingestConfidence } from './host-trust.js';
import { runBeliefArbitration } from './belief-arbitration.js';
import { projectArbitrationBeliefRows } from './world-model.js';

const HOST_ALIASES = new Map([
  ['claude', 'claude_code'],
  ['claude-code', 'claude_code'],
  ['chatgpt', 'chatgpt_manual'],
  ['gemini', 'gemini_manual'],
  ['copilot', 'copilot_manual'],
]);

const ALLOWED_SOURCE_HOSTS = new Set([
  'codex',
  'claude_code',
  'openclaw',
  'hermes',
  'chatgpt_manual',
  'gemini_manual',
  'copilot_manual',
  'claude_manual',
  'windsurf',
  'cursor',
]);

const ALLOWED_SOURCE_KINDS = new Set([
  'native_memory',
  'instruction',
  'checkpoint',
  'manual_import',
  'rule',
  'chat_history_hint',
]);

const ALLOWED_SYNC_POLICIES = new Set([
  'read_only',
  'manual_export',
  'bidirectional_disallowed',
]);

const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.json', '.jsonl', '.yaml', '.yml']);
const CLOUD_MANUAL_HOSTS = new Set(['chatgpt_manual', 'gemini_manual', 'copilot_manual', 'claude_manual']);

// #6 cloud-inbox: the vendor sub-directories Gigabrain watches under the drop
// folder, each mapped to the manual cloud host it ingests as. These are the
// ONLY closed-cloud products bridged, and ONLY via the official user-initiated
// export each vendor sanctions — never a scrape, never an upload.
const CLOUD_INBOX_VENDORS = Object.freeze([
  { vendor: 'chatgpt', source_host: 'chatgpt_manual' },
  { vendor: 'gemini', source_host: 'gemini_manual' },
  { vendor: 'copilot', source_host: 'copilot_manual' },
]);
const CLOUD_INBOX_VENDOR_BY_HOST = new Map(CLOUD_INBOX_VENDORS.map((v) => [v.source_host, v.vendor]));
const BRIDGE_HOSTS = new Set(['hermes']);
const SECRET_RISK_PATTERNS = [
  /\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:sk|rk|pk|sess|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}/g,
  /\b([A-Za-z0-9_.-]*(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd|pwd|client[_ -]?secret)[A-Za-z0-9_.-]*)\b\s*[:=]\s*["']?[^"'\s,;]+["']?/gi,
  // Credential coverage includes AWS access-key IDs, PEM private-key
  // blocks, and JWTs slipped past the keyword-anchored patterns above.
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
];

const normalizeHost = (value = '') => {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  const aliased = HOST_ALIASES.get(key) || key;
  if (!ALLOWED_SOURCE_HOSTS.has(aliased)) {
    throw new Error(`unsupported memory source host: ${value || '(empty)'}`);
  }
  return aliased;
};

const normalizeKind = (value = 'native_memory') => {
  const key = String(value || '').trim().toLowerCase();
  return ALLOWED_SOURCE_KINDS.has(key) ? key : 'native_memory';
};

const normalizePolicy = (value = 'read_only') => {
  const key = String(value || '').trim().toLowerCase();
  return ALLOWED_SYNC_POLICIES.has(key) ? key : 'read_only';
};

const sha256 = (value = '') => crypto.createHash('sha256').update(String(value)).digest('hex');

const stableSourceOperationId = ({ prefix = 'host-sync', sourceHost = '', sourceKind = '', sourcePath = '', scope = '', contentHash = '' } = {}) => (
  `${String(prefix || 'host-sync')}-${String(sourceHost || 'source')}-${sha256(JSON.stringify({
    content_hash: String(contentHash || ''),
    scope: String(scope || ''),
    source_host: String(sourceHost || ''),
    source_kind: String(sourceKind || ''),
    source_path: path.resolve(String(sourcePath || '.')),
  })).slice(0, 24)}`
);

const invokeWriterFault = (faultInjector, stage, context = {}) => {
  if (typeof faultInjector === 'function') faultInjector(stage, context);
};

const hasSecretRisk = (value = '') => SECRET_RISK_PATTERNS.some((pattern) => {
  pattern.lastIndex = 0;
  return pattern.test(String(value || ''));
});

const pathExists = (filePath = '') => {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch {
    return false;
  }
};

const isDirectory = (filePath = '') => {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
};

const ensureHostMemoryStore = (db) => {
  ensureProjectionStore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_source_links (
      memory_id TEXT NOT NULL,
      source_host TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_line INTEGER,
      sync_policy TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY(memory_id, source_host, source_path, source_line)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_source_links_host_status
      ON memory_source_links(source_host, status);
    CREATE INDEX IF NOT EXISTS idx_memory_source_links_memory
      ON memory_source_links(memory_id);

    CREATE TABLE IF NOT EXISTS memory_host_sync_runs (
      run_id TEXT PRIMARY KEY,
      source_host TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      sync_policy TEXT NOT NULL,
      source_path TEXT NOT NULL,
      status TEXT NOT NULL,
      indexed_count INTEGER NOT NULL DEFAULT 0,
      linked_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_host_sync_runs_host_time
      ON memory_host_sync_runs(source_host, synced_at DESC);

    CREATE TABLE IF NOT EXISTS memory_host_sync_cursor (
      source_path TEXT PRIMARY KEY,
      source_host TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      hash TEXT NOT NULL,
      last_synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_host_sync_cursor_host
      ON memory_host_sync_cursor(source_host);

    CREATE TABLE IF NOT EXISTS memory_cloud_inbox_state (
      source_host TEXT NOT NULL,
      source_path TEXT NOT NULL,
      vendor TEXT NOT NULL,
      last_export_mtime_ms INTEGER NOT NULL,
      last_scanned_at TEXT NOT NULL,
      fact_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(source_host, source_path)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_cloud_inbox_state_host
      ON memory_cloud_inbox_state(source_host);
  `);
};

// Per-source incremental cursor (Feature #2). Mirrors memory_native_sync_state:
// a source file is re-parsed only when its (mtime_ms, size_bytes, hash) drifts
// from the last recorded value. A budgeted nightly host_sync therefore skips
// unchanged stores cheaply and idempotently. statSync failures (server-side
// stores with no on-disk file, races) degrade to "changed" so a parse still
// runs — never silently skips a real update.
const readCursor = (db, sourcePath) => {
  try {
    return db.prepare(`
      SELECT mtime_ms, size_bytes, hash
      FROM memory_host_sync_cursor
      WHERE source_path = ?
    `).get(String(sourcePath || '')) || null;
  } catch {
    return null;
  }
};

const sourceUnchanged = (cursor, stat, fileHash) => Boolean(
  cursor
  && Number(cursor.mtime_ms) === Number(stat.mtimeMs)
  && Number(cursor.size_bytes) === Number(stat.size)
  && String(cursor.hash || '') === String(fileHash || ''),
);

const writeCursor = (db, { sourcePath, sourceHost, stat, fileHash, nowIso } = {}) => {
  db.prepare(`
    INSERT INTO memory_host_sync_cursor (source_path, source_host, mtime_ms, size_bytes, hash, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      source_host = excluded.source_host,
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      hash = excluded.hash,
      last_synced_at = excluded.last_synced_at
  `).run(
    String(sourcePath || ''),
    normalizeHost(sourceHost),
    Number(stat.mtimeMs),
    Number(stat.size),
    String(fileHash || ''),
    String(nowIso || new Date().toISOString()),
  );
};

const statSourceFile = (sourcePath) => {
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) return null;
    return stat;
  } catch {
    return null;
  }
};

const redactMemoryText = (value = '') => {
  let text = String(value || '');
  text = text.replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED_SECRET]');
  text = text.replace(/\b(?:sk|rk|pk|sess|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}/g, '[REDACTED_SECRET]');
  text = text.replace(
    /\b([A-Za-z0-9_.-]*(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd|pwd|client[_ -]?secret)[A-Za-z0-9_.-]*)\b\s*[:=]\s*["']?[^"'\s,;]+["']?/gi,
    '$1=[REDACTED_SECRET]',
  );
  // Credential coverage for AWS key IDs, PEM blocks, and JWTs:
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]');
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_SECRET]');
  return text.trim();
};

// Handoff/brief surfaces move data OFF this machine (the user pastes the brief
// into a cloud product). redactMemoryText only masks credentials; for the
// off-machine surfaces we additionally mask common PII shapes — emails, IPv4s,
// and the username segment of absolute home paths — so a brief labelled
// "redacted" does not carry the user's identity verbatim. Kept OUT of the
// ingest path (redactMemoryText) on purpose: at ingest we must preserve the
// user's own name/paths inside their stored memory content.
const redactHandoffText = (value = '') => {
  let text = redactMemoryText(value);
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g, '[REDACTED_EMAIL]');
  text = text.replace(/(\/(?:Users|home)\/)[^/\s]+/g, '$1[REDACTED_USER]');
  text = text.replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, '[REDACTED_IP]');
  return text.trim();
};

const cleanMarkdownLine = (line = '') => String(line || '')
  .replace(/^\s{0,3}#{1,6}\s+/, '')
  .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
  .replace(/\s+/g, ' ')
  .trim();

const collectJsonStrings = (value, out = [], line = 1) => {
  if (typeof value === 'string') {
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (cleaned) out.push({ content: cleaned, source_line: out.length + 1 });
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, out, line);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectJsonStrings(item, out, line);
  }
  return out;
};

// A markdown bullet or numbered list item: `- foo`, `* foo`, `1. foo`, `2) foo`.
const BULLET_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const HEADING_LINE_RE = /^\s{0,3}#{1,6}\s+/;
const BARE_URL_RE = /^https?:\/\/\S+$/;

// Two-pass extraction lets heterogeneous autonomous stores parse cleanly:
// bullet-structured stores (Codex MEMORY.md) and prose
// stores (Hermes) both yield facts without prose stores collapsing to noise.
//   Pass 1: markdown bullets / numbered lists — the structured-store shape.
//   Pass 2 (fallback, only if pass 1 found nothing): substantial prose lines,
//           skipping headings and bare URLs — the prose-store shape.
const extractMemoryLines = (raw, source = {}) => {
  const lines = String(raw || '').split(/\r?\n/);
  let inFence = false;
  const rows = [];

  // Pass 1: bullets / numbered lists.
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (/^\s*```/.test(rawLine)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!BULLET_LINE_RE.test(rawLine)) continue;
    const cleaned = cleanMarkdownLine(rawLine);
    if (!cleaned || cleaned.length < 4 || BARE_URL_RE.test(cleaned)) continue;
    rows.push({ ...source, source_line: index + 1, content: redactMemoryText(cleaned) });
  }
  if (rows.length > 0) return rows.filter((item) => item.content);

  // Pass 2 (prose fallback): substantial non-heading, non-URL lines.
  inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (/^\s*```/.test(rawLine)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (HEADING_LINE_RE.test(rawLine)) continue;
    const trimmed = rawLine.trim();
    if (trimmed.length < 20 || BARE_URL_RE.test(trimmed)) continue;
    const cleaned = cleanMarkdownLine(rawLine);
    if (!cleaned || cleaned.length < 4) continue;
    rows.push({ ...source, source_line: index + 1, content: redactMemoryText(cleaned) });
  }
  return rows.filter((item) => item.content);
};

const parseMemoryFile = (filePath, source = {}) => {
  const ext = path.extname(filePath).toLowerCase();
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Absent/unreadable store (e.g. a server-side store with no on-disk file)
    // degrades to a no-op rather than throwing, so one bad source never aborts a sync.
    return [];
  }
  if (ext === '.json') {
    try {
      return collectJsonStrings(JSON.parse(raw)).map((item) => ({
        ...source,
        ...item,
        content: redactMemoryText(item.content),
      })).filter((item) => item.content);
    } catch {
      // Fall through to line parsing for non-standard JSON fragments.
    }
  }
  return extractMemoryLines(raw, source);
};

// ---------------------------------------------------------------------------
// #6 cloud-inbox parsers. Each takes the PARSED JSON of one official vendor
// export and returns plain candidate-fact strings (user+assistant turn text).
// They are intentionally tolerant: a vendor schema drift that doesn't match
// degrades to "no facts" rather than throwing, so one odd export never aborts
// a scan. NO secret handling here — every returned string passes through the
// SAME local-redaction prefilter (redactMemoryText + hasSecretRisk) the host
// sync uses before it is ever ingested.
// ---------------------------------------------------------------------------

// OpenAI ChatGPT `conversations.json`: a top-level ARRAY of conversations, each
// with a `mapping` object of message nodes. A node's text lives in
// message.content.parts (array of strings or {text}/{content} parts).
const partsToText = (parts) => {
  if (!Array.isArray(parts)) return [];
  const out = [];
  for (const part of parts) {
    if (typeof part === 'string') { const t = part.trim(); if (t) out.push(t); continue; }
    if (part && typeof part === 'object') {
      const t = String(part.text || part.content || '').trim();
      if (t) out.push(t);
    }
  }
  return out;
};

const parseOpenAiConversations = (data) => {
  const conversations = Array.isArray(data) ? data : (Array.isArray(data?.conversations) ? data.conversations : []);
  const texts = [];
  for (const convo of conversations) {
    const mapping = convo && typeof convo === 'object' ? convo.mapping : null;
    if (mapping && typeof mapping === 'object') {
      for (const node of Object.values(mapping)) {
        const message = node && typeof node === 'object' ? node.message : null;
        if (!message || typeof message !== 'object') continue;
        const role = String(message?.author?.role || '');
        if (role === 'system' || role === 'tool') continue;
        for (const t of partsToText(message?.content?.parts)) texts.push(t);
      }
      continue;
    }
    // Fallback: a flat {messages:[{role,content}]} convo shape.
    const messages = Array.isArray(convo?.messages) ? convo.messages : [];
    for (const msg of messages) {
      const role = String(msg?.role || '');
      if (role === 'system' || role === 'tool') continue;
      const content = msg?.content;
      if (typeof content === 'string') { const t = content.trim(); if (t) texts.push(t); }
      else for (const t of partsToText(content?.parts || content)) texts.push(t);
    }
  }
  return texts;
};

// Google Takeout / Gemini export. Takeout ships heterogeneous JSON; the
// sanctioned conversation shape is a list of items each carrying turn text.
// We accept either {conversations:[{messages|turns:[{text|content}]}]} or a
// flat array of {text}/{content} records, and degrade to deep string-collection
// for any other Takeout fragment.
const parseGeminiExport = (data) => {
  const texts = [];
  const pushTurnText = (turn) => {
    if (typeof turn === 'string') { const t = turn.trim(); if (t) texts.push(t); return; }
    if (turn && typeof turn === 'object') {
      const t = String(turn.text || turn.content || turn.message || '').trim();
      if (t) texts.push(t);
    }
  };
  const conversations = Array.isArray(data?.conversations) ? data.conversations
    : (Array.isArray(data) ? data : []);
  let matched = false;
  for (const convo of conversations) {
    const turns = Array.isArray(convo?.messages) ? convo.messages
      : (Array.isArray(convo?.turns) ? convo.turns : null);
    if (turns) { matched = true; for (const turn of turns) pushTurnText(turn); continue; }
    if (typeof convo === 'string' || (convo && typeof convo === 'object' && (convo.text || convo.content))) {
      matched = true; pushTurnText(convo);
    }
  }
  // Unknown Takeout fragment: fall back to deep string collection so a real
  // export still yields candidate facts rather than silently dropping.
  if (!matched) return collectJsonStrings(data).map((item) => item.content);
  return texts;
};

// Microsoft Copilot JSON, if/when a shape exists. We accept the same families
// as the others ({conversations:[{messages:[{content}]}]} or flat records) and
// degrade to deep string collection otherwise.
const parseCopilotExport = (data) => {
  const texts = [];
  const conversations = Array.isArray(data?.conversations) ? data.conversations
    : (Array.isArray(data) ? data : []);
  let matched = false;
  for (const convo of conversations) {
    const messages = Array.isArray(convo?.messages) ? convo.messages
      : (Array.isArray(convo?.turns) ? convo.turns : null);
    if (messages) {
      matched = true;
      for (const msg of messages) {
        const role = String(msg?.role || msg?.author || '');
        if (role === 'system' || role === 'tool') continue;
        const t = String(typeof msg === 'string' ? msg : (msg?.content || msg?.text || '')).trim();
        if (t) texts.push(t);
      }
      continue;
    }
    if (typeof convo === 'string' || (convo && typeof convo === 'object' && (convo.text || convo.content))) {
      matched = true;
      const t = String(typeof convo === 'string' ? convo : (convo.text || convo.content || '')).trim();
      if (t) texts.push(t);
    }
  }
  if (!matched) return collectJsonStrings(data).map((item) => item.content);
  return texts;
};

const CLOUD_INBOX_PARSERS = Object.freeze({
  chatgpt: parseOpenAiConversations,
  gemini: parseGeminiExport,
  copilot: parseCopilotExport,
});

// Turn one vendor export FILE into manual_import candidate rows. The raw export
// text is parsed locally, each turn is split into substantial lines, and EVERY
// line is run through the SAME local-redaction prefilter the host sync uses
// (redactMemoryText). A candidate that STILL trips hasSecretRisk after
// redaction is dropped entirely — a secret is stripped, never stored.
const parseCloudExportFile = (filePath, { vendor, source_host } = {}) => {
  const parser = CLOUD_INBOX_PARSERS[vendor];
  if (!parser) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cloud export JSON parse failed: ${path.basename(filePath)}`, { cause: error });
  }
  let texts = [];
  try {
    texts = parser(data) || [];
  } catch {
    texts = [];
  }
  const rows = [];
  let line = 0;
  for (const text of texts) {
    // Each turn may hold several sentence-lines; treat each substantial line as
    // a candidate fact (mirrors the prose-fallback shape of extractMemoryLines).
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const cleaned = cleanMarkdownLine(rawLine);
      if (!cleaned || cleaned.length < 4 || BARE_URL_RE.test(cleaned)) continue;
      const redacted = redactMemoryText(cleaned);
      // Defense in depth: a candidate that still trips the secret-risk pattern
      // after redaction is dropped — the secret is STRIPPED, never stored.
      if (!redacted || hasSecretRisk(redacted)) continue;
      line += 1;
      rows.push({
        source_host,
        source_kind: 'manual_import',
        sync_policy: 'bidirectional_disallowed',
        source_path: filePath,
        source_line: line,
        content: redacted,
      });
    }
  }
  return rows;
};

// The drop-folder export files for one vendor sub-dir. Only the file shapes
// vendors actually emit (JSON / JSONL) are considered.
const cloudExportFilesForVendor = (vendorDir) => walkTextFiles(vendorDir, { maxFiles: 200 })
  .filter((filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.json' || ext === '.jsonl';
  });

const readCloudInboxState = (db, { sourceHost, sourcePath } = {}) => {
  try {
    return db.prepare(`
      SELECT last_export_mtime_ms, last_scanned_at, fact_count
      FROM memory_cloud_inbox_state
      WHERE source_host = ? AND source_path = ?
    `).get(String(sourceHost || ''), String(sourcePath || '')) || null;
  } catch {
    return null;
  }
};

const writeCloudInboxState = (db, { sourceHost, sourcePath, vendor, mtimeMs, factCount, nowIso } = {}) => {
  db.prepare(`
    INSERT INTO memory_cloud_inbox_state (
      source_host, source_path, vendor, last_export_mtime_ms, last_scanned_at, fact_count
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_host, source_path) DO UPDATE SET
      vendor = excluded.vendor,
      last_export_mtime_ms = excluded.last_export_mtime_ms,
      last_scanned_at = excluded.last_scanned_at,
      fact_count = excluded.fact_count
  `).run(
    String(sourceHost || ''),
    String(sourcePath || ''),
    String(vendor || ''),
    Number(mtimeMs || 0),
    String(nowIso || new Date().toISOString()),
    Number(factCount || 0),
  );
};

// Scan the watched cloud-inbox drop folder ({chatgpt,gemini,copilot}/) for the
// official vendor exports, ingest their facts at the manual_import trust FLOOR
// with full cloud provenance, and stamp a `last_export_age` per source so the
// doctor can nudge on a stale source. Reuses the SAME per-source incremental
// cursor as host_sync, so an unchanged export file is a no-op. cloudInbox
// disabled OR an absent dir → an entire no-op at zero cost (the host_sync caller
// only invokes this when cloudInbox.enabled).
const scanCloudInbox = (options = {}) => {
  const db = options.db;
  if (!db) throw new Error('scanCloudInbox requires db');
  const config = options.config || {};
  const cloudInbox = config?.native?.cloudInbox || {};
  const summary = {
    enabled: cloudInbox.enabled === true,
    ok: true,
    dir: String(cloudInbox.dir || ''),
    vendor_dirs_scanned: 0,
    files_scanned: 0,
    files_unchanged: 0,
    indexed_count: 0,
    inserted_count: 0,
    skipped_count: 0,
    sources: [],
    touched_memory_ids: [],
  };
  if (cloudInbox.enabled !== true) return summary;
  ensureHostMemoryStore(db);
  const root = String(cloudInbox.dir || '').trim();
  if (!root || !pathExists(root)) return summary;
  const scope = resolveHostScope(config, options.scope);
  const incremental = options.incremental === true;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const touched = new Set();

  for (const { vendor, source_host: sourceHost } of CLOUD_INBOX_VENDORS) {
    const vendorDir = path.join(root, vendor);
    if (!pathExists(vendorDir) || !isDirectory(vendorDir)) continue;
    summary.vendor_dirs_scanned += 1;
    for (const filePath of cloudExportFilesForVendor(vendorDir)) {
      const stat = statSourceFile(filePath);
      if (!stat) continue;
      summary.files_scanned += 1;
      const mtimeMs = Number(stat.mtimeMs);
      // last_export_age stamp: ALWAYS refreshed (even on an unchanged file) so a
      // stale source is detectable by the doctor regardless of whether it was
      // re-parsed this run.
      const prevState = readCloudInboxState(db, { sourceHost, sourcePath: filePath });
      let fileHash = '';
      try { fileHash = sha256(fs.readFileSync(filePath, 'utf8')); } catch { fileHash = ''; }
      const operationId = stableSourceOperationId({
        contentHash: fileHash,
        prefix: 'cloud-inbox',
        scope,
        sourceHost,
        sourceKind: 'manual_import',
        sourcePath: filePath,
      });
      const faultContext = {
        operation_id: operationId,
        source_host: sourceHost,
        source_kind: 'manual_import',
        source_path: filePath,
        vendor,
      };
      // Reuse the SAME host_sync incremental cursor: an unchanged export skips.
      if (incremental && sourceUnchanged(readCursor(db, filePath), stat, fileHash)) {
        try {
          if (options.dryRun !== true) {
            withProjectionMutationBatch({ db, operationId }, () => {
              const factCount = Number(prevState?.fact_count || 0);
              writeCloudInboxState(db, {
                sourceHost, sourcePath: filePath, vendor, mtimeMs,
                factCount, nowIso,
              });
              invokeWriterFault(options.faultInjector, 'after_cloud_state', faultContext);
              recordSyncRun(db, {
                run_id: operationId,
                source_host: sourceHost,
                source_kind: 'manual_import',
                sync_policy: 'bidirectional_disallowed',
                source_path: filePath,
                status: 'ok',
                indexed_count: factCount,
                linked_count: factCount,
                skipped_count: 0,
                synced_at: nowIso,
              });
              invokeWriterFault(options.faultInjector, 'after_sync_run', faultContext);
            });
          }
          summary.files_unchanged += 1;
          summary.sources.push({
            source_host: sourceHost,
            vendor,
            source_path: filePath,
            status: 'unchanged',
            indexed_count: 0,
            last_export_mtime_ms: mtimeMs,
            operation_id: operationId,
          });
        } catch (err) {
          summary.ok = false;
          summary.sources.push({
            source_host: sourceHost,
            vendor,
            source_path: filePath,
            status: 'error',
            indexed_count: 0,
            last_export_mtime_ms: mtimeMs,
            operation_id: operationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      try {
        const items = parseCloudExportFile(filePath, { vendor, source_host: sourceHost });
        const applySource = (tx = null) => {
          const local = {
            indexed_count: 0,
            inserted_count: 0,
            skipped_count: 0,
            touched_memory_ids: new Set(),
          };
          for (const item of items) {
            const normalized = normalizeContent(item.content);
            if (!normalized || normalized.length < 4) {
              local.skipped_count += 1;
              continue;
            }
            const normalizedHash = hashNormalized(normalized);
            const existing = findCanonicalMemory(db, { normalizedHash, normalized, scope });
            const memoryId = existing?.memory_id || memoryIdForImport({
              sourceHost: item.source_host,
              sourcePath: item.source_path,
              sourceLine: item.source_line,
              normalizedHash,
              scope,
            });
            if (options.dryRun !== true && !existing) {
              upsertCurrentMemory(db, {
                memory_id: memoryId,
                type: 'USER_FACT',
                content: item.content,
                normalized,
                source: 'cloud_inbox',
                source_agent: item.source_host,
                source_layer: 'host_memory',
                source_path: item.source_path,
                source_line: item.source_line,
                source_host: item.source_host,
                source_kind: item.source_kind,
                sync_policy: item.sync_policy,
                confidence: ingestConfidence(item.source_host, item.source_kind, config),
                scope,
                status: 'active',
                tags: [
                  'cloud_inbox',
                  `source_host:${item.source_host}`,
                  'source_kind:manual_import',
                  `cloud_vendor:${vendor}`,
                  `last_export_age:${mtimeMs}`,
                ],
              }, {
                event: {
                  action: 'cloud_inbox_inserted',
                  component: 'host_sync',
                  payload: {
                    cloud_vendor: vendor,
                    content_hash: normalizedHash,
                    source_host: item.source_host,
                    source_line: item.source_line ?? null,
                    source_path: item.source_path,
                  },
                  reason_codes: ['cloud_export_import'],
                  run_id: operationId,
                },
                faultInjector: (stage) => invokeWriterFault(options.faultInjector, stage, faultContext),
                operationId,
                tx,
              });
              local.inserted_count += 1;
            }
            if (options.dryRun !== true) {
              linkMemorySource(db, {
                memory_id: memoryId,
                source_host: item.source_host,
                source_kind: item.source_kind,
                source_path: item.source_path,
                source_line: item.source_line,
                sync_policy: item.sync_policy,
                content_hash: normalizedHash,
              });
              invokeWriterFault(options.faultInjector, 'after_source_link', faultContext);
              local.touched_memory_ids.add(memoryId);
            }
            local.indexed_count += 1;
          }
          if (options.dryRun !== true) {
            writeCloudInboxState(db, {
              sourceHost,
              sourcePath: filePath,
              vendor,
              mtimeMs,
              factCount: local.indexed_count,
              nowIso,
            });
            invokeWriterFault(options.faultInjector, 'after_cloud_state', faultContext);
            writeCursor(db, { sourcePath: filePath, sourceHost, stat, fileHash, nowIso });
            invokeWriterFault(options.faultInjector, 'after_cursor', faultContext);
            recordSyncRun(db, {
              run_id: operationId,
              source_host: sourceHost,
              source_kind: 'manual_import',
              sync_policy: 'bidirectional_disallowed',
              source_path: filePath,
              status: 'ok',
              indexed_count: local.indexed_count,
              linked_count: local.indexed_count,
              skipped_count: local.skipped_count,
              synced_at: nowIso,
            });
            invokeWriterFault(options.faultInjector, 'after_sync_run', faultContext);
          }
          return local;
        };
        const committed = options.dryRun === true
          ? applySource()
          : withProjectionMutationBatch({ db, operationId }, (tx) => applySource(tx)).result;
        summary.indexed_count += committed.indexed_count;
        summary.inserted_count += committed.inserted_count;
        summary.skipped_count += committed.skipped_count;
        for (const memoryId of committed.touched_memory_ids) touched.add(memoryId);
        summary.sources.push({
          source_host: sourceHost,
          vendor,
          source_path: filePath,
          status: 'scanned',
          indexed_count: committed.indexed_count,
          last_export_mtime_ms: mtimeMs,
          operation_id: operationId,
        });
      } catch (err) {
        summary.ok = false;
        summary.sources.push({
          source_host: sourceHost,
          vendor,
          source_path: filePath,
          status: 'error',
          indexed_count: 0,
          last_export_mtime_ms: mtimeMs,
          operation_id: operationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  summary.touched_memory_ids = Array.from(touched);
  return summary;
};

// Staleness report for the doctor. For each configured cloud vendor, the NEWEST
// recorded export mtime is compared against staleDays. A vendor with a recorded
// source older than the threshold is flagged stale; a configured vendor whose
// sub-dir holds no recorded export is reported as `missing` (informational —
// not an error, the user may simply not use that cloud). Returns [] when
// cloudInbox is disabled. NO network, NO disk reads of the exports — reads only
// the local state table.
const cloudInboxStaleness = ({ db, config = {}, nowMs = Date.now() } = {}) => {
  const cloudInbox = config?.native?.cloudInbox || {};
  if (cloudInbox.enabled !== true) return [];
  if (!db) return [];
  const hasState = hasTable(db, 'memory_cloud_inbox_state');
  const staleDays = Math.max(1, Number(cloudInbox.staleDays || 30) || 30);
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  const out = [];
  for (const { vendor, source_host: sourceHost } of CLOUD_INBOX_VENDORS) {
    let row = null;
    try {
      if (!hasState) throw new Error('memory_cloud_inbox_state unavailable');
      row = db.prepare(`
        SELECT MAX(last_export_mtime_ms) AS newest_mtime, COUNT(*) AS source_count
        FROM memory_cloud_inbox_state
        WHERE source_host = ?
      `).get(sourceHost) || null;
    } catch {
      row = null;
    }
    const sourceCount = Number(row?.source_count || 0);
    if (sourceCount === 0) {
      out.push({ vendor, source_host: sourceHost, status: 'missing', newest_export_mtime_ms: null, age_days: null, stale_days: staleDays });
      continue;
    }
    const newest = Number(row?.newest_mtime || 0);
    const ageMs = Math.max(0, nowMs - newest);
    const ageDays = Math.round((ageMs / (24 * 60 * 60 * 1000)) * 10) / 10;
    out.push({
      vendor,
      source_host: sourceHost,
      status: ageMs > staleMs ? 'stale' : 'fresh',
      newest_export_mtime_ms: newest,
      age_days: ageDays,
      stale_days: staleDays,
    });
  }
  return out;
};

const walkTextFiles = (root, options = {}) => {
  if (!pathExists(root)) return [];
  const maxFiles = Math.max(1, Math.min(5000, Number(options.maxFiles || 750) || 750));
  const out = [];
  const visit = (current) => {
    if (out.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(fullPath);
      }
    }
  };
  if (isDirectory(root)) visit(root);
  else if (TEXT_EXTENSIONS.has(path.extname(root).toLowerCase())) out.push(root);
  return out;
};

const requestedHosts = (hosts = []) => (Array.isArray(hosts) && hosts.length > 0
  ? new Set(hosts.map((host) => normalizeHost(host)))
  : null);

const resolveHostRoots = (options = {}) => {
  const config = options.config || {};
  const codexHome = path.resolve(String(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
  const claudeHome = path.resolve(String(options.claudeHome || path.join(os.homedir(), '.claude')));
  const hermesHome = path.resolve(String(options.hermesHome || process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')));
  const workspaceRoot = path.resolve(String(options.workspaceRoot || config?.codex?.projectRoot || config?.runtime?.paths?.workspaceRoot || process.cwd()));
  const memoryMdPath = String(config?.native?.memoryMdPath || '').trim();
  const rows = [
    {
      source_host: 'codex',
      source_kind: 'native_memory',
      sync_policy: 'read_only',
      path: path.join(codexHome, 'memories'),
      required_for_sync: true,
    },
    {
      source_host: 'claude_code',
      source_kind: 'native_memory',
      sync_policy: 'read_only',
      path: path.join(claudeHome, 'projects'),
      required_for_sync: true,
    },
    {
      source_host: 'openclaw',
      source_kind: 'checkpoint',
      sync_policy: 'read_only',
      path: memoryMdPath ? path.resolve(memoryMdPath) : '',
      required_for_sync: Boolean(memoryMdPath),
    },
    {
      source_host: 'hermes',
      source_kind: 'native_memory',
      sync_policy: 'read_only',
      path: path.join(hermesHome, 'memories'),
      required_for_sync: true,
    },
    ...['cursor', 'windsurf'].flatMap((host) => {
      const folder = host === 'cursor' ? '.cursor' : '.windsurf';
      return ['rules', 'memories'].map((subdir) => ({
        source_host: host,
        source_kind: subdir === 'rules' ? 'rule' : 'native_memory',
        sync_policy: 'read_only',
        path: path.join(workspaceRoot, folder, subdir),
        required_for_sync: true,
      }));
    }),
  ];
  const manualImportPath = String(options.manualImportPath || '').trim();
  if (manualImportPath) {
    const host = normalizeHost(options.manualSourceHost || 'chatgpt_manual');
    rows.push({
      source_host: host,
      source_kind: 'manual_import',
      sync_policy: 'bidirectional_disallowed',
      path: path.resolve(manualImportPath),
      required_for_sync: true,
    });
  }
  return rows.map((row) => ({
    ...row,
    available: Boolean(row.path && pathExists(row.path)),
  }));
};

const missingHostWarnings = (options = {}) => {
  const requested = requestedHosts(options.hosts);
  const includeDefaultWarnings = requested && requested.size > 0;
  return resolveHostRoots(options)
    .filter((row) => row.required_for_sync && !row.available)
    .filter((row) => includeDefaultWarnings ? requested.has(row.source_host) : row.source_kind === 'manual_import')
    .map((row) => ({
      code: 'host_source_missing',
      source_host: row.source_host,
      source_kind: row.source_kind,
      path: row.path,
      message: `No readable ${row.source_host} ${row.source_kind} source found at ${row.path || '(empty path)'}`,
    }));
};

const sourceDescriptor = ({
  host,
  kind,
  syncPolicy,
  rootPath,
  filePath,
  available = true,
} = {}) => ({
  source_host: normalizeHost(host),
  source_kind: normalizeKind(kind),
  sync_policy: normalizePolicy(syncPolicy),
  root_path: String(rootPath || filePath || ''),
  source_path: String(filePath || rootPath || ''),
  available: available === true,
});

const discoverHostSources = (options = {}) => {
  const config = options.config || {};
  const hosts = requestedHosts(options.hosts);
  const wants = (host) => !hosts || hosts.has(host);
  const sources = [];
  const codexHome = path.resolve(String(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
  const claudeHome = path.resolve(String(options.claudeHome || path.join(os.homedir(), '.claude')));
  const hermesHome = path.resolve(String(options.hermesHome || process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')));
  const workspaceRoot = path.resolve(String(options.workspaceRoot || config?.codex?.projectRoot || config?.runtime?.paths?.workspaceRoot || process.cwd()));

  if (wants('codex')) {
    const root = path.join(codexHome, 'memories');
    for (const filePath of walkTextFiles(root)) {
      sources.push(sourceDescriptor({ host: 'codex', kind: 'native_memory', syncPolicy: 'read_only', rootPath: root, filePath }));
    }
  }

  if (wants('claude_code')) {
    const projectsRoot = path.join(claudeHome, 'projects');
    // Walk each <project>/memory dir directly instead of the whole projects
    // tree: projects/ can also hold many .json/.jsonl session transcripts,
    // which can exhaust walkTextFiles' file cap before the walk reaches memory
    // directories.
    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      projectDirs = [];
    }
    for (const dir of projectDirs) {
      const memoryRoot = path.join(projectsRoot, dir.name, 'memory');
      for (const filePath of walkTextFiles(memoryRoot)) {
        sources.push(sourceDescriptor({ host: 'claude_code', kind: 'native_memory', syncPolicy: 'read_only', rootPath: projectsRoot, filePath }));
      }
    }
  }

  if (wants('openclaw')) {
    const memoryMdPath = String(config?.native?.memoryMdPath || '').trim();
    const root = memoryMdPath ? path.resolve(memoryMdPath) : '';
    if (root && pathExists(root)) {
      sources.push(sourceDescriptor({ host: 'openclaw', kind: 'checkpoint', syncPolicy: 'read_only', rootPath: path.dirname(root), filePath: root }));
    }
  }

  if (wants('hermes')) {
    const root = path.join(hermesHome, 'memories');
    for (const filePath of walkTextFiles(root)) {
      sources.push(sourceDescriptor({ host: 'hermes', kind: 'native_memory', syncPolicy: 'read_only', rootPath: root, filePath }));
    }
  }

  for (const host of ['cursor', 'windsurf']) {
    if (!wants(host)) continue;
    const folder = host === 'cursor' ? '.cursor' : '.windsurf';
    for (const subdir of ['rules', 'memories']) {
      const root = path.join(workspaceRoot, folder, subdir);
      for (const filePath of walkTextFiles(root)) {
        sources.push(sourceDescriptor({ host, kind: subdir === 'rules' ? 'rule' : 'native_memory', syncPolicy: 'read_only', rootPath: root, filePath }));
      }
    }
  }

  const manualImportPath = String(options.manualImportPath || '').trim();
  if (manualImportPath) {
    const host = normalizeHost(options.manualSourceHost || 'chatgpt_manual');
    if (!CLOUD_MANUAL_HOSTS.has(host)) {
      throw new Error('--manual-source-host must be a manual cloud host');
    }
    if (wants(host)) {
      for (const filePath of walkTextFiles(path.resolve(manualImportPath), { maxFiles: 100 })) {
        sources.push(sourceDescriptor({ host, kind: 'manual_import', syncPolicy: 'bidirectional_disallowed', rootPath: manualImportPath, filePath }));
      }
    }
  }

  return sources;
};

// Resolve the canonical memory across ALL statuses (R1/KTD2). Limiting this to
// status='active' let re-sync miss a superseded arbitration loser and re-import
// the same source line as a fresh active row (deterministic memory_id), erasing
// the verdict. Active rows still win when one exists; otherwise the most
// recently updated non-active row is the canonical match.
const findCanonicalMemory = (db, { normalizedHash, normalized, scope } = {}) => {
  return db.prepare(`
    SELECT memory_id, status
    FROM memory_current
    WHERE (normalized_hash = ? OR normalized = ?) AND scope = ?
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `).get(String(normalizedHash || ''), String(normalized || ''), String(scope || 'shared')) || null;
};

const linkMemorySource = (db, link = {}) => {
  const nowIso = new Date().toISOString();
  const sourceLine = link.source_line === null || link.source_line === undefined || link.source_line === ''
    ? null
    : (Number.isFinite(Number(link.source_line)) ? Number(link.source_line) : null);
  db.prepare(`
    INSERT INTO memory_source_links (
      memory_id, source_host, source_kind, source_path, source_line, sync_policy,
      content_hash, first_seen_at, last_seen_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(memory_id, source_host, source_path, source_line) DO UPDATE SET
      source_kind = excluded.source_kind,
      sync_policy = excluded.sync_policy,
      content_hash = excluded.content_hash,
      last_seen_at = excluded.last_seen_at,
      status = 'active'
  `).run(
    String(link.memory_id || ''),
    normalizeHost(link.source_host),
    normalizeKind(link.source_kind),
    String(link.source_path || ''),
    sourceLine,
    normalizePolicy(link.sync_policy),
    String(link.content_hash || ''),
    nowIso,
    nowIso,
  );
};

const recordSyncRun = (db, run = {}) => {
  db.prepare(`
    INSERT INTO memory_host_sync_runs (
      run_id, source_host, source_kind, sync_policy, source_path, status,
      indexed_count, linked_count, skipped_count, error, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      source_host = excluded.source_host,
      source_kind = excluded.source_kind,
      sync_policy = excluded.sync_policy,
      source_path = excluded.source_path,
      status = excluded.status,
      indexed_count = excluded.indexed_count,
      linked_count = excluded.linked_count,
      skipped_count = excluded.skipped_count,
      error = excluded.error,
      synced_at = excluded.synced_at
  `).run(
    String(run.run_id || `host-sync:${sha256(JSON.stringify(run)).slice(0, 24)}`),
    normalizeHost(run.source_host),
    normalizeKind(run.source_kind),
    normalizePolicy(run.sync_policy),
    String(run.source_path || ''),
    String(run.status || 'ok'),
    Number(run.indexed_count || 0),
    Number(run.linked_count || 0),
    Number(run.skipped_count || 0),
    run.error ? String(run.error) : null,
    String(run.synced_at || new Date().toISOString()),
  );
};

const resolveHostScope = (config = {}, explicitScope = '') => {
  const scope = String(explicitScope || '').trim();
  if (scope) return scope;
  return 'profile:main';
};

const shouldRunAutomaticHostSync = (config = {}, trigger = '') => {
  const normalized = String(trigger || '').trim().toLowerCase();
  if (normalized === 'setup') return config?.hostSync?.autoOnSetup === true;
  if (normalized === 'nightly') return config?.hostSync?.autoNightly === true;
  return false;
};

const memoryIdForImport = ({ sourceHost, sourcePath, sourceLine, normalizedHash, scope } = {}) => {
  return `host:${sourceHost}:${sha256([scope, sourceHost, sourcePath, sourceLine || '', normalizedHash].join('\n')).slice(0, 32)}`;
};

// Scope a full belief projection down to ONLY the claim slots the current sync
// touched. The other side of a contradiction (a standing rival the sync did
// not re-touch) is kept by widening from the touched memory_ids to every belief
// sharing a touched (entity_id, claim_slot) — so the arbiter sees the full
// rivalry but never re-judges unrelated slots. Returns the SAME belief-row
// shape runBeliefArbitration expects, so recordVerdict's idempotence holds.
const scopeBeliefRowsToTouched = (beliefRows, touchedMemoryIds) => {
  const rows = Array.isArray(beliefRows) ? beliefRows : [];
  const slotKeyOf = (row) => `${String(row?.entity_id || '').trim()}|${String(row?.payload?.claim_slot || '').trim()}`;
  const touchedSlots = new Set();
  for (const row of rows) {
    if (touchedMemoryIds.has(String(row?.source_memory_id || ''))) {
      const slot = String(row?.payload?.claim_slot || '').trim();
      if (slot) touchedSlots.add(slotKeyOf(row));
    }
  }
  if (touchedSlots.size === 0) return [];
  return rows.filter((row) => touchedSlots.has(slotKeyOf(row)));
};

const scopedBeliefProjector = (touchedMemoryIds, baseProjector) => (args = {}) => {
  const base = typeof baseProjector === 'function' ? baseProjector : null;
  const all = base ? (base(args) || []) : [];
  return scopeBeliefRowsToTouched(all, touchedMemoryIds);
};

const isBusyError = (err) => {
  if (!err) return false;
  if (err.code === 'SQLITE_BUSY' || err.errcode === 5) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked|database is busy/i.test(msg);
};

const sleepSyncSpin = (ms) => {
  // Synchronous backoff — DatabaseSync is synchronous and these are short,
  // contention-only stalls. Spin on a deadline so we don't pull in deps.
  const deadline = Date.now() + Math.max(0, ms);
  while (Date.now() < deadline) { /* busy-wait small backoff */ }
};

const MAX_ARBITRATION_RETRIES = 3;

// Ingest-time arbitration over JUST the freshly-touched claim slots, wrapped in a
// retried BEGIN IMMEDIATE so two concurrent syncs never race a read-decide-write
// (mirrors capture-service's post-write arbitration). Shared by host_sync
// (Feature #3) and the transcript harvester (idea #1) so a freshly-mined fact
// that contradicts a standing belief is judged in-band rather than 24h later.
// Returns the summary fields the caller folds into its own report. Best-effort:
// a busy-exhausted arbitration is RECOVERABLE (the next sync / nightly
// re-arbitrates the same slot idempotently) — never data loss, never an abort.
const arbitrateTouchedSlots = ({ db, config = {}, touchedMemoryIds, projectBeliefRows, onBeforeArbitrationAttempt } = {}) => {
  const out = {};
  if (!touchedMemoryIds || touchedMemoryIds.size === 0) return out;
  const baseProjector = typeof projectBeliefRows === 'function'
    ? projectBeliefRows
    : projectArbitrationBeliefRows;
  const scopedProjector = scopedBeliefProjector(touchedMemoryIds, baseProjector);
  const beforeAttempt = typeof onBeforeArbitrationAttempt === 'function' ? onBeforeArbitrationAttempt : null;

  let arbitration = null;
  let lastBusyError = null;
  let succeeded = false;
  let busyRetries = 0;
  for (let attempt = 0; attempt <= MAX_ARBITRATION_RETRIES; attempt += 1) {
    if (beforeAttempt) {
      try { beforeAttempt(attempt); } catch { /* test hook must never break the sync */ }
    }
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (isBusyError(err)) {
        lastBusyError = err;
        if (attempt < MAX_ARBITRATION_RETRIES) {
          busyRetries += 1;
          sleepSyncSpin(10 * (attempt + 1));
          continue;
        }
        break;
      }
      out.arbitration_error = err instanceof Error ? err.message : String(err);
      succeeded = true;
      break;
    }
    try {
      arbitration = runBeliefArbitration({ db, config, projectBeliefRows: scopedProjector });
      db.exec('COMMIT');
      succeeded = true;
      break;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* tx already gone */ }
      if (isBusyError(err) && attempt < MAX_ARBITRATION_RETRIES) {
        lastBusyError = err;
        busyRetries += 1;
        sleepSyncSpin(10 * (attempt + 1));
        continue;
      }
      out.arbitration_error = err instanceof Error ? err.message : String(err);
      if (isBusyError(err)) lastBusyError = err;
      succeeded = true;
      break;
    }
  }

  if (busyRetries > 0) out.arbitration_busy_retries = busyRetries;
  if (succeeded && arbitration) {
    out.arbitration_verdicts = Number(arbitration?.counts?.verdicts || 0);
  } else if (!succeeded && lastBusyError) {
    out.arbitration_error = `arbitration deferred (SQLITE_BUSY after ${busyRetries} retries; recoverable on next sync): ${lastBusyError instanceof Error ? lastBusyError.message : String(lastBusyError)}`;
    out.arbitration_busy_exhausted = true;
  }
  return out;
};

const syncHostMemories = (options = {}) => {
  const db = options.db;
  if (!db) throw new Error('syncHostMemories requires db');
  const config = options.config || {};
  const scope = resolveHostScope(config, options.scope);
  const incremental = options.incremental === true;
  const automaticTrigger = String(options.automaticTrigger || '').trim().toLowerCase();
  if (automaticTrigger && !shouldRunAutomaticHostSync(config, automaticTrigger)) {
    return {
      ok: true,
      command: 'sync-hosts',
      dry_run: options.dryRun === true,
      incremental,
      scope,
      automatic_disabled: true,
      summary: {
        source_count: 0,
        indexed_count: 0,
        inserted_count: 0,
        linked_count: 0,
        skipped_count: 0,
        unchanged_sources: 0,
        arbitration_verdicts: 0,
      },
      source_count: 0,
      indexed_count: 0,
      inserted_count: 0,
      linked_count: 0,
      skipped_count: 0,
      unchanged_sources: 0,
      arbitration_verdicts: 0,
      touched_memory_ids: [],
      warnings: [],
      message: `Automatic host sync is disabled for ${automaticTrigger}.`,
    };
  }
  ensureHostMemoryStore(db);
  const sources = discoverHostSources(options);
  // Feature #2: budgeted incremental cursor. The nightly host_sync step passes
  // incremental:true so unchanged source files (same mtime/size/hash) are
  // skipped without re-parsing — cheap + idempotent. The force/debug CLI verb
  // leaves it off so a manual `sync-hosts` always re-indexes.
  // Feature #3: arbitrate at ingest-time (default ON). After new facts are
  // indexed/linked, JUST the touched claim slots are re-arbitrated through the
  // SAME belief-arbitration path the nightly rebuild uses, so a freshly-synced
  // contradicting fact is judged in seconds rather than waiting 24h.
  const arbitrate = options.arbitrate !== false && options.dryRun !== true;
  const summary = {
    ok: true,
    command: 'sync-hosts',
    dry_run: options.dryRun === true,
    incremental,
    scope,
    summary: {
      source_count: sources.length,
      indexed_count: 0,
      inserted_count: 0,
      linked_count: 0,
      skipped_count: 0,
      unchanged_sources: 0,
      arbitration_verdicts: 0,
    },
    source_count: sources.length,
    indexed_count: 0,
    inserted_count: 0,
    linked_count: 0,
    skipped_count: 0,
    unchanged_sources: 0,
    arbitration_verdicts: 0,
    touched_memory_ids: [],
    warnings: missingHostWarnings(options),
    message: sources.length === 0
      ? 'No local host memory sources were found. Use --host to target known local hosts or --manual-import for explicit cloud exports.'
      : '',
    sources: [],
    runs: [],
  };

  const touchedMemoryIds = new Set();
  for (const source of sources) {
    // Incremental cursor gate (Feature #2): a source file whose stat fingerprint
    // matches the recorded cursor is skipped before any parse. A non-file source
    // (no on-disk stat) degrades to a normal parse so server-side stores keep
    // working. Only meaningful when incremental:true (the nightly path).
    const stat = statSourceFile(source.source_path);
    let fileHash = '';
    if (stat) {
      let raw = '';
      try { raw = fs.readFileSync(source.source_path, 'utf8'); } catch { raw = ''; }
      fileHash = sha256(raw);
    }
    if (incremental && stat && sourceUnchanged(readCursor(db, source.source_path), stat, fileHash)) {
      summary.unchanged_sources += 1;
      summary.summary.unchanged_sources = summary.unchanged_sources;
      summary.sources.push({
        source_host: source.source_host,
        source_kind: source.source_kind,
        sync_policy: source.sync_policy,
        source_path: source.source_path,
        indexed_count: 0,
        linked_count: 0,
        skipped_count: 0,
        status: 'unchanged',
        error: '',
      });
      continue;
    }
    const operationId = stableSourceOperationId({
      contentHash: fileHash,
      prefix: 'host-sync',
      scope,
      sourceHost: source.source_host,
      sourceKind: source.source_kind,
      sourcePath: source.source_path,
    });
    const run = {
      run_id: operationId,
      source_host: source.source_host,
      source_kind: source.source_kind,
      sync_policy: source.sync_policy,
      source_path: source.source_path,
      status: 'ok',
      indexed_count: 0,
      linked_count: 0,
      skipped_count: 0,
      synced_at: new Date().toISOString(),
    };
    const faultContext = {
      operation_id: operationId,
      source_host: source.source_host,
      source_kind: source.source_kind,
      source_path: source.source_path,
    };
    let committed = null;
    try {
      const items = parseMemoryFile(source.source_path, source);
      const applySource = (tx = null) => {
        const local = {
          indexed_count: 0,
          inserted_count: 0,
          linked_count: 0,
          skipped_count: 0,
          touched_memory_ids: new Set(),
        };
        for (const item of items) {
          const normalized = normalizeContent(item.content);
          if (!normalized || normalized.length < 4) {
            local.skipped_count += 1;
            continue;
          }
          const normalizedHash = hashNormalized(normalized);
          const existing = findCanonicalMemory(db, { normalizedHash, normalized, scope });
          const memoryId = existing?.memory_id || memoryIdForImport({
            sourceHost: item.source_host,
            sourcePath: item.source_path,
            sourceLine: item.source_line,
            normalizedHash,
            scope,
          });
          if (options.dryRun !== true && !existing) {
            upsertCurrentMemory(db, {
              memory_id: memoryId,
              type: item.source_kind === 'rule' || item.source_kind === 'instruction' ? 'DECISION' : 'USER_FACT',
              content: item.content,
              normalized,
              source: 'host_sync',
              source_agent: item.source_host,
              source_layer: 'host_memory',
              source_path: item.source_path,
              source_line: item.source_line,
              source_host: item.source_host,
              source_kind: item.source_kind,
              sync_policy: item.sync_policy,
              confidence: ingestConfidence(item.source_host, item.source_kind, config),
              scope,
              status: 'active',
              tags: ['host_sync', `source_host:${item.source_host}`, `source_kind:${item.source_kind}`],
            }, {
              event: {
                action: 'host_sync_inserted',
                component: 'host_sync',
                payload: {
                  content_hash: normalizedHash,
                  source_host: item.source_host,
                  source_kind: item.source_kind,
                  source_line: item.source_line ?? null,
                  source_path: item.source_path,
                },
                reason_codes: ['host_source_import'],
                run_id: operationId,
              },
              faultInjector: (stage) => invokeWriterFault(options.faultInjector, stage, faultContext),
              operationId,
              tx,
            });
            local.inserted_count += 1;
          }
          if (options.dryRun !== true) {
            linkMemorySource(db, {
              memory_id: memoryId,
              source_host: item.source_host,
              source_kind: item.source_kind,
              source_path: item.source_path,
              source_line: item.source_line,
              sync_policy: item.sync_policy,
              content_hash: normalizedHash,
            });
            invokeWriterFault(options.faultInjector, 'after_source_link', faultContext);
            // A superseded/rejected canonical row keeps its verdict: provenance is
            // refreshed above, the upsert was skipped, and the skip lands on the
            // ledger (debug-level) so the audit trail explains the non-import.
            if (existing && (existing.status === 'superseded' || existing.status === 'rejected')) {
              const alreadyLedgered = db.prepare(`
                SELECT 1 FROM memory_events
                WHERE action = 'sync:skipped_superseded' AND memory_id = ?
                  AND json_extract(payload, '$.content_hash') = ?
                LIMIT 1
              `).get(memoryId, normalizedHash);
              if (!alreadyLedgered) {
                appendEvent(db, {
                  component: 'host_sync',
                  action: 'sync:skipped_superseded',
                  reason_codes: ['debug'],
                  memory_id: memoryId,
                  run_id: operationId,
                  payload: {
                    status: existing.status,
                    content_hash: normalizedHash,
                    source_host: item.source_host,
                    source_path: item.source_path,
                    source_line: item.source_line ?? null,
                  },
                });
              }
            }
            local.touched_memory_ids.add(memoryId);
          }
          local.indexed_count += 1;
          local.linked_count += 1;
        }
        if (incremental && options.dryRun !== true && stat) {
          writeCursor(db, {
            sourcePath: source.source_path,
            sourceHost: source.source_host,
            stat,
            fileHash,
            nowIso: run.synced_at,
          });
          invokeWriterFault(options.faultInjector, 'after_cursor', faultContext);
        }
        run.indexed_count = local.indexed_count;
        run.linked_count = local.linked_count;
        run.skipped_count = local.skipped_count;
        if (options.dryRun !== true) {
          recordSyncRun(db, run);
          invokeWriterFault(options.faultInjector, 'after_sync_run', faultContext);
        }
        return local;
      };

      if (options.dryRun === true) committed = applySource();
      else committed = withProjectionMutationBatch({ db, operationId }, (tx) => applySource(tx)).result;
    } catch (err) {
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
      run.indexed_count = 0;
      run.linked_count = 0;
      run.skipped_count = 0;
      summary.ok = false;
    }

    if (committed) {
      summary.indexed_count += committed.indexed_count;
      summary.inserted_count += committed.inserted_count;
      summary.linked_count += committed.linked_count;
      summary.skipped_count += committed.skipped_count;
      for (const memoryId of committed.touched_memory_ids) touchedMemoryIds.add(memoryId);
    }
    summary.summary.indexed_count = summary.indexed_count;
    summary.summary.inserted_count = summary.inserted_count;
    summary.summary.linked_count = summary.linked_count;
    summary.summary.skipped_count = summary.skipped_count;
    summary.sources.push({
      source_host: source.source_host,
      source_kind: source.source_kind,
      sync_policy: source.sync_policy,
      source_path: source.source_path,
      indexed_count: run.indexed_count,
      linked_count: run.linked_count,
      skipped_count: run.skipped_count,
      status: run.status,
      error: run.error || '',
      operation_id: operationId,
    });
    summary.runs.push(run);
  }

  // #6 cloud-inbox: scan the watched export drop folder when cloudInbox.enabled.
  // Disabled (the default) → an entire no-op at zero cost. Cloud facts are
  // ingested at the manual_import trust FLOOR with full cloud provenance, reuse
  // the SAME incremental cursor (unchanged export skips), and their touched
  // memory ids join the ingest-time arbitration set below so a cloud fact that
  // contradicts a local store is judged in-band. Best-effort: a cloud-inbox
  // failure must never abort the host sync.
  if (config?.native?.cloudInbox?.enabled === true) {
    try {
      const cloud = scanCloudInbox({
        db,
        config,
        scope,
        incremental,
        dryRun: options.dryRun === true,
      });
      summary.cloud_inbox = cloud;
      summary.summary.cloud_inbox_indexed = Number(cloud.indexed_count || 0);
      summary.summary.cloud_inbox_inserted = Number(cloud.inserted_count || 0);
      summary.cloud_inbox_inserted = Number(cloud.inserted_count || 0);
      summary.inserted_count += Number(cloud.inserted_count || 0);
      summary.indexed_count += Number(cloud.indexed_count || 0);
      summary.summary.inserted_count = summary.inserted_count;
      summary.summary.indexed_count = summary.indexed_count;
      for (const id of Array.isArray(cloud.touched_memory_ids) ? cloud.touched_memory_ids : []) {
        touchedMemoryIds.add(id);
      }
    } catch (cloudErr) {
      summary.cloud_inbox = { enabled: true, ok: false, error: String(cloudErr?.message || cloudErr).slice(0, 200) };
    }
  }

  summary.touched_memory_ids = Array.from(touchedMemoryIds);

  // Feature #3: arbitrate at ingest-time. After indexing/linking, re-arbitrate
  // the freshly-touched claim slots through the SAME belief-arbitration path the
  // nightly rebuild uses (trust > corroboration > recency), emitting any new
  // cross-store verdict to the append-only ledger. The contradiction then
  // surfaces on the next `watch` run as a new finding — latency 24h → seconds.
  //
  // CONCURRENCY (the main risk): two agents syncing the same slot must not race
  // an inline read-decide-write. We DO NOT invent a new lock — we SERIALIZE
  // through the SAME append-only event log capture-service uses. runBelief
  // Arbitration re-projects belief rows from the COMMITTED memory_current and
  // emits verdicts via recordVerdict, which is idempotent over the full
  // winner+loser set (it no-ops once the winner is active AND every loser is
  // already superseded_by it). Wrapping the arbitration in BEGIN IMMEDIATE
  // takes the single SQLite write lock for the duration: a second concurrent
  // sync blocks on busy_timeout, then re-reads the now-committed verdict and
  // finds nothing left to decide — no write-skew, no double-supersede. The
  // arbitrate-then-ledger ordering exactly mirrors capture-service's
  // post-write runBeliefArbitration; nothing here bypasses the arbiter.
  if (arbitrate && touchedMemoryIds.size > 0) {
    // CONCURRENCY: under real contention 'BEGIN IMMEDIATE' can throw SQLITE_BUSY
    // even after busy_timeout elapses (a rival sync held the write lock the whole
    // window). The shared arbitrateTouchedSlots helper RETRIES the whole
    // lock→project→verdict path with bounded backoff; a busy-exhausted result is
    // recoverable (the next sync / nightly re-arbitrates the same slot
    // idempotently). The optional onBeforeArbitrationAttempt hook (test-only) is
    // forwarded so a test can deterministically inject write-lock contention.
    const arb = arbitrateTouchedSlots({
      db,
      config,
      touchedMemoryIds,
      projectBeliefRows: options.projectBeliefRows,
      onBeforeArbitrationAttempt: options.onBeforeArbitrationAttempt,
    });
    if (arb.arbitration_busy_retries) {
      summary.arbitration_busy_retries = arb.arbitration_busy_retries;
      summary.summary.arbitration_busy_retries = arb.arbitration_busy_retries;
    }
    if (Object.prototype.hasOwnProperty.call(arb, 'arbitration_verdicts')) {
      summary.arbitration_verdicts = arb.arbitration_verdicts;
      summary.summary.arbitration_verdicts = arb.arbitration_verdicts;
    }
    if (arb.arbitration_error) summary.arbitration_error = arb.arbitration_error;
    if (arb.arbitration_busy_exhausted) {
      summary.arbitration_busy_exhausted = true;
      summary.summary.arbitration_busy_exhausted = true;
    }
  }

  return summary;
};

const listMemorySources = ({ db, config = {}, includeDiscovery = false, ...options } = {}) => {
  if (!db) throw new Error('listMemorySources requires db');
  const rows = hasTable(db, 'memory_source_links') ? db.prepare(`
    SELECT
      source_host,
      source_kind,
      sync_policy,
      source_path,
      COUNT(*) AS memory_count,
      MAX(last_seen_at) AS last_seen_at,
      status
    FROM memory_source_links
    GROUP BY source_host, source_kind, sync_policy, source_path, status
    ORDER BY source_host ASC, last_seen_at DESC
  `).all() : [];
  const sourceRows = rows.map((row) => ({
    ...row,
    memory_count: Number(row.memory_count || 0),
  }));
  const syncedPaths = new Set(sourceRows.map((row) => String(row.source_path || '')));
  const discovered = includeDiscovery
    ? discoverHostSources({ config, ...options }).map((source) => ({
      source_host: source.source_host,
      source_kind: source.source_kind,
      sync_policy: source.sync_policy,
      source_path: source.source_path,
      available: pathExists(source.source_path),
      synced: syncedPaths.has(String(source.source_path || '')),
    }))
    : [];
  return {
    ok: true,
    sources: sourceRows,
    discovered,
    warnings: missingHostWarnings({ config, ...options }),
  };
};

const groupHostStatus = (hosts = []) => {
  const groups = {
    ready: [],
    never_synced: [],
    manual_only: [],
    bridge: [],
  };
  for (const row of hosts) {
    const host = String(row.source_host || '');
    if (BRIDGE_HOSTS.has(host)) {
      groups.bridge.push(row);
    } else if (CLOUD_MANUAL_HOSTS.has(host)) {
      groups.manual_only.push(row);
    } else if (row.status === 'ok' || Number(row.local_sources_detected || 0) > 0) {
      groups.ready.push(row);
    } else {
      groups.never_synced.push(row);
    }
  }
  return groups;
};

const getSyncStatus = ({ db, config = {}, ...options } = {}) => {
  if (!db) throw new Error('getSyncStatus requires db');
  const runRows = hasTable(db, 'memory_host_sync_runs') ? db.prepare(`
    SELECT r.*
    FROM memory_host_sync_runs r
    INNER JOIN (
      SELECT source_host, MAX(synced_at) AS synced_at
      FROM memory_host_sync_runs
      GROUP BY source_host
    ) latest ON latest.source_host = r.source_host AND latest.synced_at = r.synced_at
    ORDER BY r.source_host ASC
  `).all() : [];
  const discovered = discoverHostSources({ config, ...options });
  const discoveredCounts = new Map();
  for (const source of discovered) {
    discoveredCounts.set(source.source_host, (discoveredCounts.get(source.source_host) || 0) + 1);
  }
  const hosts = Array.from(new Set([
    ...Array.from(ALLOWED_SOURCE_HOSTS),
    ...runRows.map((row) => String(row.source_host || '')),
  ])).filter(Boolean).sort();
  const hostRows = hosts.map((host) => {
    const run = runRows.find((row) => row.source_host === host) || null;
    return {
      source_host: host,
      local_sources_detected: Number(discoveredCounts.get(host) || 0),
      last_sync_at: String(run?.synced_at || ''),
      status: run ? String(run.status || 'unknown') : 'never_synced',
      indexed_count: Number(run?.indexed_count || 0),
      linked_count: Number(run?.linked_count || 0),
      skipped_count: Number(run?.skipped_count || 0),
      sync_policy: String(run?.sync_policy || (CLOUD_MANUAL_HOSTS.has(host) ? 'bidirectional_disallowed' : 'read_only')),
      error: String(run?.error || ''),
    };
  });
  return {
    ok: true,
    hosts: hostRows,
    groups: groupHostStatus(hostRows),
    warnings: missingHostWarnings({ config, ...options }),
    hermes_bridge: {
      mode: 'mcp_or_http_bridge',
      configured: config?.remoteBridge?.enabled === true,
      base_url: String(config?.remoteBridge?.baseUrl || ''),
    },
  };
};

const exportMemoryBrief = ({ db, config = {}, targetHost = 'agents', scope = '', limit = 25, allowAllScopes = false } = {}) => {
  if (!db) throw new Error('exportMemoryBrief requires db');
  ensureHostMemoryStore(db);
  const resolvedScope = String(scope || '').trim();
  // Deny-by-default: a handoff brief is pasted into OTHER agents/clouds, so an
  // empty scope (which selects every memory across all scopes) must be opted
  // into explicitly. Otherwise a brief silently leaks profile:*/project:* data.
  if (!resolvedScope && allowAllScopes !== true) {
    throw new Error(
      'exportMemoryBrief requires an explicit scope; pass allowAllScopes:true to intentionally export across all scopes',
    );
  }
  const rowLimit = Math.max(1, Math.min(100, Number(limit || 25) || 25));
  const rows = listCurrentMemories(db, {
    statuses: ['active'],
    scope: resolvedScope,
    limit: 10000,
  });
  const selected = [];
  let omittedSecretRisks = 0;
  for (const row of rows) {
    if (hasSecretRisk(row.content)) {
      omittedSecretRisks += 1;
      continue;
    }
    if (selected.length < rowLimit) selected.push(row);
  }
  const target = String(targetHost || 'agents').trim().toLowerCase();
  const header = target === 'claude_code' || target === 'claude'
    ? '# CLAUDE.md Memory Brief'
    : target === 'codex' || target === 'agents'
      ? '# AGENTS.md Memory Brief'
      : '# Gigabrain Memory Brief';
  const lines = [
    header,
    '',
    'Generated by Gigabrain for explicit manual export. Closed cloud memory systems require user-controlled paste/import; Gigabrain does not scrape them.',
    '',
  ];
  if (omittedSecretRisks > 0) {
    lines.push(`Safety: omitted ${omittedSecretRisks} secret-risk memory row${omittedSecretRisks === 1 ? '' : 's'} from this brief. Review the Memory Audit Secret Risk section instead of pasting redacted secrets into another host.`);
    lines.push('');
  }
  for (const row of selected) {
    const host = String(row.source_host || 'gigabrain');
    const kind = String(row.source_kind || 'registry');
    lines.push(`- [${host}/${kind}] ${redactHandoffText(row.content)}`);
  }
  const brief = `${lines.join('\n').trim()}\n`;
  return {
    ok: true,
    target_host: target,
    format: 'markdown',
    scope: resolvedScope,
    item_count: selected.length,
    omitted_secret_risks: omittedSecretRisks,
    brief,
    config_project_root: String(config?.codex?.projectRoot || ''),
  };
};

const sourceLinksForMemory = (db, memoryId = '') => {
  if (!hasTable(db, 'memory_source_links')) return [];
  return db.prepare(`
    SELECT source_host, source_kind, sync_policy, source_path, source_line, last_seen_at, status
    FROM memory_source_links
    WHERE memory_id = ? AND status = 'active'
    ORDER BY source_host ASC, source_path ASC, source_line ASC
  `).all(String(memoryId || ''));
};

const expandMemorySourceLinks = (db, memoryId = '') => {
  const row = getCurrentMemory(db, memoryId);
  if (!row) return [];
  return sourceLinksForMemory(db, memoryId);
};

export {
  ALLOWED_SOURCE_HOSTS,
  ALLOWED_SOURCE_KINDS,
  ALLOWED_SYNC_POLICIES,
  CLOUD_MANUAL_HOSTS,
  CLOUD_INBOX_VENDORS,
  arbitrateTouchedSlots,
  cloudInboxStaleness,
  discoverHostSources,
  ensureHostMemoryStore,
  expandMemorySourceLinks,
  exportMemoryBrief,
  findCanonicalMemory,
  groupHostStatus,
  getSyncStatus,
  hasSecretRisk,
  linkMemorySource,
  listMemorySources,
  memoryIdForImport,
  normalizeHost,
  normalizeKind,
  normalizePolicy,
  parseMemoryFile,
  parseCloudExportFile,
  recordSyncRun,
  redactHandoffText,
  redactMemoryText,
  resolveHostRoots,
  resolveHostScope,
  shouldRunAutomaticHostSync,
  scanCloudInbox,
  syncHostMemories,
};

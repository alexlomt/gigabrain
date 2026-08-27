// ============================================================================
// GigaBrain idea #1 — transcript / rollout CDC harvester (READ-ONLY).
//
// PROBLEM: host_sync walks ONLY curated /memories dirs — never the RAW session
// rollouts agents already write (~/.codex/sessions/**/*.jsonl,
// ~/.claude/projects/**/*.jsonl). Facts from a session that ended abruptly
// (crash, /clear, OOM) are otherwise lost forever. This is a Change-Data-Capture
// tail over those rollouts: each run reads ONLY the NEW bytes since a per-file
// byte-offset cursor, segments turns, salience-filters them, and feeds the
// survivors through the SAME local-only extractor capture-service exposes.
//
// HARD PRIVACY LINE (the reason this is opt-in + local-only):
//   - Raw transcript text NEVER leaves the machine. Extraction runs ONLY through
//     a LOCAL provider (ollama) or an injected test hook — asserted via
//     resolveCaptureLlm().isCloud === false. A cloud-only config → a loud,
//     graceful SKIP (no bytes read into an extractor, cursor untouched so the
//     same bytes are retried once a local provider is configured).
//   - A secret-risk line is dropped BEFORE extraction (the same prefilter the
//     host sync uses); extracted facts are redacted again at write time.
//
// COST / NOISE CONTROL (raw transcripts are ~100x curated volume):
//   - a cheap heuristic SALIENCE pre-filter feeds only turns likely to carry a
//     durable fact (user statements/preferences/decisions), dropping tool-result
//     spam and boilerplate, so the local LLM is invoked on a small slice;
//   - facts land at the LOW `transcript` trust tier (host-trust.js) via the
//     existing `chat_history_hint` source_kind, so a transcript fact can NEVER
//     outrank a deliberately-written memory of the same claim slot;
//   - a per-run BUDGET (maxFiles, maxTurns) hard-caps the work each run does.
//
// DEFAULT native.transcripts.enabled === false → an entire ZERO-COST no-op.
// ============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { assertWriteAllowed, resolveWriteMode } from '../compat/write-policy.js';
import path from 'node:path';

import { hashNormalized, normalizeContent } from './policy.js';
import { ensureProjectionStore, upsertCurrentMemory, withProjectionMutationBatch } from './projection-store.js';
import { ingestConfidence } from './host-trust.js';
import { resolveCaptureLlm } from './capture-service.js';
import { runBeliefArbitration } from './belief-arbitration.js';
import { projectArbitrationBeliefRows } from './world-model.js';
import {
  ensureHostMemoryStore,
  findCanonicalMemory,
  hasSecretRisk,
  linkMemorySource,
  memoryIdForImport,
  normalizeHost,
  redactMemoryText,
  resolveHostScope,
} from './host-memory-sync.js';

// idea #1: raw rollouts are read ONLY for the agents that write them. The
// source_host stamped on a mined fact is the agent the rollout belongs to.
const TRANSCRIPT_HOSTS = new Set(['codex', 'claude_code']);
const TRANSCRIPT_SOURCE_KIND = 'chat_history_hint';
const TRANSCRIPT_SYNC_POLICY = 'read_only';

// Per-run defaults (overridable via native.transcripts.{maxFiles,maxTurns}).
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_TURNS = 200;

const DEFAULT_GLOBS = Object.freeze([
  '~/.codex/sessions/**/*.jsonl',
  '~/.claude/projects/**/*.jsonl',
]);

const sha256 = (value = '') => crypto.createHash('sha256').update(String(value)).digest('hex');

const expandHome = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const home = os.homedir() || process.env.HOME || '';
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return raw;
};

// ---------------------------------------------------------------------------
// Glob walker. The declared globs are fixed-shape `<root>/**/<ext-pattern>` —
// a `**` recursive segment followed by a filename pattern (`*.jsonl`). We split
// on the FIRST glob segment, walk the static root recursively, and match each
// file's basename against the trailing pattern. No external dep; bounded by
// maxFiles so a huge sessions dir never blows the budget.
// ---------------------------------------------------------------------------

const basenameMatches = (name, pattern) => {
  // Only `*` is meaningful in the trailing filename pattern (e.g. `*.jsonl`).
  const escaped = String(pattern || '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(String(name || ''));
};

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

const walkGlob = (glob, { maxFiles = DEFAULT_MAX_FILES } = {}) => {
  const expanded = expandHome(glob);
  if (!expanded) return [];
  const segments = expanded.split(path.sep);
  const firstGlobIdx = segments.findIndex((seg) => seg.includes('*'));
  // A static path (no glob): match it directly if it exists.
  if (firstGlobIdx === -1) {
    return exists(expanded) && !isDir(expanded) ? [expanded] : [];
  }
  const staticRoot = segments.slice(0, firstGlobIdx).join(path.sep) || path.sep;
  const globTail = segments.slice(firstGlobIdx); // e.g. ['**','*.jsonl'] or ['*.jsonl']
  const recursive = globTail[0] === '**';
  const filePattern = globTail[globTail.length - 1];
  if (!exists(staticRoot) || !isDir(staticRoot)) return [];

  const out = [];
  const visit = (dir, depth) => {
    if (out.length >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Recurse only when the glob was recursive (`**`); otherwise the file
        // pattern is meant to match in `staticRoot` directly.
        if (recursive) visit(full, depth + 1);
        continue;
      }
      if (entry.isFile() && basenameMatches(entry.name, filePattern)) out.push(full);
    }
  };
  visit(staticRoot, 0);
  return out;
};

// Infer which first-party host a rollout file belongs to from its path. A path
// under `.codex` → codex; under `.claude` → claude_code. Unknown → null (the
// file is skipped: we only mine rollouts we can attribute to a known host).
const hostForRolloutPath = (filePath = '') => {
  const p = String(filePath || '');
  if (/[\\/]\.codex[\\/]/.test(p) || /[\\/]codex[\\/]/.test(p)) return 'codex';
  if (/[\\/]\.claude[\\/]/.test(p) || /[\\/]claude[\\/]/.test(p)) return 'claude_code';
  return null;
};

// ---------------------------------------------------------------------------
// Turn extraction from one JSONL line. Tolerant of the two real rollout shapes
// (and obvious variants), degrading to "no turn" rather than throwing so one
// malformed line never aborts a tail.
//
//   Codex rollout / history.jsonl:
//     {"type":"message","role":"user","content":"..."}            (flat)
//     {"type":"response_item","payload":{"role":"assistant",
//        "content":[{"type":"text","text":"..."}]}}               (nested)
//   Claude projects rollout:
//     {"type":"user","message":{"role":"user","content":"..."}}
//     {"type":"assistant","message":{"role":"assistant",
//        "content":[{"type":"text","text":"..."}]}}
// ---------------------------------------------------------------------------

const contentToText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') { parts.push(part); continue; }
      if (part && typeof part === 'object') {
        // tool_use / tool_result / image blocks carry no durable prose — skip.
        const type = String(part.type || '');
        if (type === 'tool_use' || type === 'tool_result' || type === 'image') continue;
        const t = part.text ?? part.content ?? part.value;
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.join('\n');
  }
  return '';
};

const parseTurn = (line) => {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const message = obj.message && typeof obj.message === 'object' ? obj.message : null;
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  const carrier = message || payload || obj;
  // Role can live on the carrier (role/author) or the envelope's `type`
  // (claude rollouts use type:"user"/"assistant").
  let role = String(carrier.role || carrier.author || '').trim().toLowerCase();
  if (!role) {
    const envType = String(obj.type || '').trim().toLowerCase();
    if (envType === 'user' || envType === 'assistant' || envType === 'system') role = envType;
  }
  if (role !== 'user' && role !== 'assistant') return null; // skip system/tool/unknown
  const text = contentToText(carrier.content ?? obj.content).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return { role, text };
};

// ---------------------------------------------------------------------------
// SALIENCE pre-filter. Cheap heuristics deciding whether a turn is LIKELY to
// carry a durable, atomic fact worth handing to the (more expensive) local
// extractor. The bar is intentionally conservative on the COST side — a turn
// that survives is merely a CANDIDATE; the extractor still decides if any
// durable fact exists. We mainly want to drop the long tail of tool-result
// spam, command echoes, and boilerplate that dominate raw transcripts.
// ---------------------------------------------------------------------------

// Boilerplate / control phrases that almost never contain a durable user fact.
const BOILERPLATE_RE = /^(?:ok(?:ay)?|sure|thanks?|thank you|got it|done|yes|no|yep|nope|sounds good|perfect|great|will do|np|y|n)[.! ]*$/i;
// Tool / system noise markers that leak into transcripts as plain text.
const TOOL_NOISE_RE = /\b(?:tool_result|tool_use|stdout|stderr|exit code|traceback \(most recent call last\)|npm warn|npm err!|\$\s+(?:git|npm|cd|ls|cat|node|python))\b/i;
// Durable-fact cues: first-person state, preference verbs, decision verbs.
const SALIENCE_CUE_RE = /\b(?:i (?:am|'m|prefer|like|love|hate|use|need|want|live|work|own|have|decided|chose|always|never)|my |we (?:decided|chose|will|should|use)|let'?s (?:use|go with|switch to)|the (?:plan|decision|rule) is|going forward|from now on|remember that|note that|important:|preference:)\b/i;

const looksLikeFenceDump = (text) => {
  // A turn that is mostly a code/diff/log dump: many lines, mostly non-prose.
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length < 6) return false;
  const isCodeLikeLine = (value) => {
    const line = String(value || '');
    if (!line) return false;
    if (line.startsWith('@@ ') || line.startsWith('+ ') || line.startsWith('- ')) return true;
    if ((line.startsWith('\t') || line.startsWith('  ')) && line.trim().length > 0) return true;
    let index = 0;
    while (index < line.length && [' ', '\t', '>', '+', '-'].includes(line[index])) index += 1;
    return index < line.length && '{}();<>'.includes(line[index]);
  };
  const codey = lines.filter(isCodeLikeLine).length;
  return codey / lines.length > 0.5;
};

// Returns { keep, reason }. A user turn carrying a durable cue is the strongest
// signal; assistant turns are kept only when they restate a decision/fact (cue),
// since assistant prose is mostly transient explanation.
const scoreTurnSalience = (turn) => {
  const text = String(turn?.text || '').trim();
  if (!text) return { keep: false, reason: 'empty' };
  if (text.length < 12) return { keep: false, reason: 'too_short' };
  if (BOILERPLATE_RE.test(text)) return { keep: false, reason: 'boilerplate' };
  if (TOOL_NOISE_RE.test(text)) return { keep: false, reason: 'tool_noise' };
  if (looksLikeFenceDump(text)) return { keep: false, reason: 'code_dump' };
  const hasCue = SALIENCE_CUE_RE.test(text);
  if (turn.role === 'user') {
    // A substantial user statement is a candidate even without an explicit cue
    // (a user rarely types tool spam), but require some length to clear chit-chat.
    if (hasCue) return { keep: true, reason: 'user_cue' };
    if (text.length >= 40) return { keep: true, reason: 'user_statement' };
    return { keep: false, reason: 'user_chitchat' };
  }
  // assistant
  if (hasCue) return { keep: true, reason: 'assistant_restated_decision' };
  return { keep: false, reason: 'assistant_transient' };
};

// ---------------------------------------------------------------------------
// Cursor store (CDC). Mirrors memory_host_sync_cursor / memory_native_sync_state
// but keyed by source_path + BYTE OFFSET so each run reads ONLY new bytes. inode
// + size guard against truncation/rotation: if the file shrank below the cursor
// offset (rotated/rewritten) or the inode changed, we reset the offset to 0 so a
// rewritten rollout is re-read from the top rather than silently skipped.
// ---------------------------------------------------------------------------

const ensureTranscriptStore = (db) => {
  ensureProjectionStore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_transcript_sync_cursor (
      source_path TEXT PRIMARY KEY,
      source_host TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      inode TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      turns_seen INTEGER NOT NULL DEFAULT 0,
      facts_seen INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_transcript_cursor_host
      ON memory_transcript_sync_cursor(source_host);
  `);
};

const readTranscriptCursor = (db, sourcePath) => {
  try {
    return db.prepare(`
      SELECT byte_offset, inode, size_bytes, mtime_ms, turns_seen, facts_seen
      FROM memory_transcript_sync_cursor WHERE source_path = ?
    `).get(String(sourcePath || '')) || null;
  } catch {
    return null;
  }
};

const writeTranscriptCursor = (db, { sourcePath, sourceHost, byteOffset, inode, sizeBytes, mtimeMs, turnsSeen, factsSeen, nowIso } = {}) => {
  db.prepare(`
    INSERT INTO memory_transcript_sync_cursor
      (source_path, source_host, byte_offset, inode, size_bytes, mtime_ms, turns_seen, facts_seen, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      source_host = excluded.source_host,
      byte_offset = excluded.byte_offset,
      inode = excluded.inode,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      turns_seen = excluded.turns_seen,
      facts_seen = excluded.facts_seen,
      last_synced_at = excluded.last_synced_at
  `).run(
    String(sourcePath || ''),
    normalizeHost(sourceHost),
    Math.max(0, Number(byteOffset || 0)),
    String(inode || ''),
    Math.max(0, Number(sizeBytes || 0)),
    Math.max(0, Number(mtimeMs || 0)),
    Math.max(0, Number(turnsSeen || 0)),
    Math.max(0, Number(factsSeen || 0)),
    String(nowIso || new Date().toISOString()),
  );
};

const scopedTranscriptBeliefProjector = (touchedMemoryIds, baseProjector) => (args = {}) => {
  const rows = (typeof baseProjector === 'function' ? baseProjector(args) : []) || [];
  const slotKeyOf = (row) => `${String(row?.entity_id || '').trim()}|${String(row?.payload?.claim_slot || '').trim()}`;
  const touchedSlots = new Set();
  for (const row of rows) {
    if (!touchedMemoryIds.has(String(row?.source_memory_id || ''))) continue;
    const slot = String(row?.payload?.claim_slot || '').trim();
    if (slot) touchedSlots.add(slotKeyOf(row));
  }
  if (touchedSlots.size === 0) return [];
  return rows.filter((row) => touchedSlots.has(slotKeyOf(row)));
};

// Read ONLY the bytes after `startOffset`, returning { text, endOffset }. We
// read to EOF (bounded later by the turn budget). A partial trailing line (no
// newline yet — the agent is still writing) is NOT consumed: endOffset is
// rewound to the last newline so the incomplete turn is re-read intact next run.
const readNewBytes = (filePath, startOffset, fileSize) => {
  if (fileSize <= startOffset) return { text: '', endOffset: startOffset };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const length = fileSize - startOffset;
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, startOffset);
    let chunk = buf.subarray(0, bytesRead);
    let endOffset = startOffset + bytesRead;
    // Rewind a partial trailing line so we never consume half a JSON object.
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1) {
      // No complete line yet — consume nothing.
      return { text: '', endOffset: startOffset };
    }
    if (lastNl < chunk.length - 1) {
      const consumed = lastNl + 1;
      endOffset = startOffset + consumed;
      chunk = chunk.subarray(0, consumed);
    }
    return { text: chunk.toString('utf8'), endOffset };
  } catch {
    return { text: '', endOffset: startOffset };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
};

// ---------------------------------------------------------------------------
// Main entry. READ-ONLY CDC tail over the configured rollout globs.
// ---------------------------------------------------------------------------

const harvestTranscripts = (options = {}) => {
  const db = options.db;
  if (!db) throw new Error('harvestTranscripts requires db');
  const config = options.config || {};
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'transcript.harvest' });
  const transcripts = config?.native?.transcripts || {};
  const scope = resolveHostScope(config, options.scope);

  const summary = {
    ok: true,
    command: 'transcript-sync',
    enabled: transcripts.enabled === true,
    dry_run: options.dryRun === true,
    scope,
    skipped_reason: '',
    files_scanned: 0,
    files_unchanged: 0,
    turns_segmented: 0,
    turns_salient: 0,
    turns_dropped: 0,
    facts_extracted: 0,
    inserted_count: 0,
    linked_count: 0,
    secret_dropped: 0,
    budget_files: 0,
    budget_turns: 0,
    arbitration_verdicts: 0,
    touched_memory_ids: [],
    sources: [],
  };

  // DEFAULT disabled → an entire ZERO-COST no-op (no store creation, no walk).
  if (transcripts.enabled !== true) {
    summary.skipped_reason = 'disabled';
    return summary;
  }

  // PRIVACY GUARD: resolve the capture LLM seam ONCE and assert it is LOCAL.
  // A cloud-only provider (or an injected hook flagged isCloud) must NEVER see
  // raw transcript text — so we SKIP extraction entirely (loud but safe) and
  // DO NOT advance the cursor, so the same bytes are retried once a local
  // provider is configured. A disabled LLM (provider 'none', no hook) likewise
  // skips: there is no local-only way to distil facts, so we no-op.
  const captureLlm = resolveCaptureLlm({ config, event: options.event || {} });
  if (!captureLlm.enabled || typeof captureLlm.extract !== 'function') {
    summary.ok = true;
    summary.skipped_reason = captureLlm.enabled ? 'no_local_extractor' : 'llm_disabled';
    summary.warning = `transcript harvest skipped: ${summary.skipped_reason} (raw transcripts are local-only; nothing read into an extractor)`;
    return summary;
  }
  if (captureLlm.isCloud === true) {
    summary.ok = true;
    summary.skipped_reason = 'cloud_provider';
    // LOUD-but-safe: a cloud provider must never receive raw transcript text.
    summary.warning = 'transcript harvest skipped: a CLOUD provider is configured; raw transcript text must never leave the machine. Configure a local provider (ollama) to harvest rollouts.';
    return summary;
  }

  ensureTranscriptStore(db);
  ensureHostMemoryStore(db);

  const rawGlobs = Array.isArray(transcripts.globs) && transcripts.globs.length > 0
    ? transcripts.globs
    : DEFAULT_GLOBS;
  const maxFiles = Math.max(1, Math.min(1000, Number(transcripts.maxFiles || DEFAULT_MAX_FILES) || DEFAULT_MAX_FILES));
  const maxTurns = Math.max(1, Math.min(20000, Number(transcripts.maxTurns || DEFAULT_MAX_TURNS) || DEFAULT_MAX_TURNS));
  summary.budget_files = maxFiles;
  summary.budget_turns = maxTurns;
  const incremental = options.incremental !== false; // default ON (CDC)
  const nowIso = new Date().toISOString();
  const touched = new Set();

  // Collect candidate files across all globs, dedup, attribute to a host.
  const seenPaths = new Set();
  const files = [];
  for (const glob of rawGlobs) {
    for (const filePath of walkGlob(glob, { maxFiles })) {
      if (files.length >= maxFiles) break;
      if (seenPaths.has(filePath)) continue;
      const host = hostForRolloutPath(filePath);
      if (!host || !TRANSCRIPT_HOSTS.has(host)) continue; // only attributable rollouts
      seenPaths.add(filePath);
      files.push({ filePath, host });
    }
    if (files.length >= maxFiles) break;
  }

  let turnBudget = maxTurns;
  const arbitrate = options.arbitrate !== false && options.dryRun !== true;

  for (const { filePath, host } of files) {
    if (turnBudget <= 0) break;
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    if (!stat.isFile()) continue;
    summary.files_scanned += 1;
    const sizeBytes = Number(stat.size);
    const mtimeMs = Number(stat.mtimeMs);
    const inode = String(stat.ino || '');

    const cursor = incremental ? readTranscriptCursor(db, filePath) : null;
    let startOffset = cursor ? Math.max(0, Number(cursor.byte_offset || 0)) : 0;
    // Truncation / rotation guard: a file smaller than our recorded offset, or
    // a changed inode, means the rollout was rewritten — re-read from the top.
    if (cursor) {
      if (sizeBytes < startOffset || (cursor.inode && inode && String(cursor.inode) !== inode)) {
        startOffset = 0;
      }
    }
    if (incremental && cursor && sizeBytes === startOffset && String(cursor.inode || '') === inode) {
      summary.files_unchanged += 1;
      summary.sources.push({ source_host: host, source_path: filePath, status: 'unchanged', turns: 0, facts: 0 });
      continue;
    }

    const { text: newText, endOffset } = readNewBytes(filePath, startOffset, sizeBytes);
    let fileTurns = 0;
    let consumedOffset = startOffset; // advance only over fully-processed lines
    let nextTurnBudget = turnBudget;
    const extractedFacts = [];
    const sourceSummary = {
      turns_segmented: 0,
      turns_salient: 0,
      turns_dropped: 0,
      secret_dropped: 0,
    };

    if (newText) {
      // Track byte position per line so the cursor advances exactly over the
      // lines we processed (so a turn-budget cutoff mid-file resumes cleanly).
      let lineStartByte = startOffset;
      const lines = newText.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const rawLine = lines[i];
        // Byte length of this line incl. its trailing '\n' (the split removed it,
        // except possibly the final element which had no newline — but readNewBytes
        // only ever returns whole lines, so every element here ended with '\n').
        const lineBytes = Buffer.byteLength(rawLine, 'utf8') + (i < lines.length - 1 ? 1 : 0);
        const lineEndByte = lineStartByte + lineBytes;
        if (!rawLine.trim()) { lineStartByte = lineEndByte; consumedOffset = Math.min(endOffset, lineEndByte); continue; }
        if (nextTurnBudget <= 0) break; // budget exhausted: stop BEFORE consuming this line

        const turn = parseTurn(rawLine);
        if (turn) {
          sourceSummary.turns_segmented += 1;
          fileTurns += 1;
          const salience = scoreTurnSalience(turn);
          if (!salience.keep) {
            sourceSummary.turns_dropped += 1;
          } else {
            sourceSummary.turns_salient += 1;
            nextTurnBudget -= 1;
            // SECRET prefilter BEFORE extraction: a turn carrying a credential is
            // dropped wholesale — the raw secret is never handed to the extractor.
            if (hasSecretRisk(turn.text)) {
              sourceSummary.secret_dropped += 1;
            } else {
              const sourceLine = (cursor?.turns_seen || 0) + fileTurns; // 1-based per-file turn index
              const facts = runExtractor({
                captureLlm,
                turnText: turn.text,
                summary: sourceSummary,
              });
              for (const fact of facts) {
                extractedFacts.push({ fact, sourceLine });
              }
            }
          }
        }
        // Whether or not the line yielded a turn/fact, it is fully processed.
        consumedOffset = Math.min(endOffset, lineEndByte);
        lineStartByte = lineEndByte;
      }
    }

    const operationId = `transcript-harvest-${host}-${sha256([
      scope,
      filePath,
      startOffset,
      consumedOffset,
      sha256(newText),
    ].join('\n')).slice(0, 24)}`;
    const faultContext = { operation_id: operationId, source_host: host, source_path: filePath };
    const inject = (stage) => {
      if (typeof options.faultInjector === 'function') options.faultInjector(stage, faultContext);
    };
    const applySource = (tx = null) => {
      const sourceTouched = new Set();
      let fileFacts = 0;
      let insertedCount = 0;
      let linkedCount = 0;
      for (const { fact, sourceLine } of extractedFacts) {
        const stored = storeFact({
          db, config, scope, host, filePath, sourceLine,
          content: fact.content,
          type: fact.type,
          dryRun: options.dryRun === true,
          faultInjector: inject,
          operationId,
          tx,
        });
        if (!stored) continue;
        fileFacts += 1;
        if (stored.inserted) insertedCount += 1;
        linkedCount += 1;
        if (options.dryRun !== true) sourceTouched.add(stored.memoryId);
      }
      // Advance the cursor over exactly the lines we consumed this run (CDC).
      if (incremental && options.dryRun !== true) {
        writeTranscriptCursor(db, {
          sourcePath: filePath,
          sourceHost: host,
          byteOffset: consumedOffset,
          inode,
          sizeBytes,
          mtimeMs,
          turnsSeen: (cursor?.turns_seen || 0) + fileTurns,
          factsSeen: (cursor?.facts_seen || 0) + fileFacts,
          nowIso,
        });
        inject('after_cursor');
      }
      let arbitrationVerdicts = 0;
      if (arbitrate && sourceTouched.size > 0) {
        if (typeof options.onBeforeArbitrationAttempt === 'function') {
          try { options.onBeforeArbitrationAttempt(0); } catch { /* test hook is observational */ }
        }
        const baseProjector = typeof options.projectBeliefRows === 'function'
          ? options.projectBeliefRows
          : projectArbitrationBeliefRows;
        const arbitration = runBeliefArbitration({
          db,
          config,
          faultInjector: inject,
          operationId,
          projectBeliefRows: scopedTranscriptBeliefProjector(sourceTouched, baseProjector),
          tx,
        });
        arbitrationVerdicts = Number(arbitration?.counts?.verdicts || 0);
      }
      return { arbitrationVerdicts, fileFacts, insertedCount, linkedCount, sourceTouched };
    };

    let committed;
    try {
      committed = options.dryRun === true
        ? applySource()
        : withProjectionMutationBatch({ db, operationId }, (tx) => applySource(tx)).result;
    } catch (error) {
      summary.ok = false;
      summary.sources.push({
        source_host: host,
        source_path: filePath,
        status: 'error',
        turns: 0,
        facts: 0,
        byte_offset: startOffset,
        operation_id: operationId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    turnBudget = nextTurnBudget;
    for (const key of ['turns_segmented', 'turns_salient', 'turns_dropped', 'secret_dropped']) {
      summary[key] += Number(sourceSummary[key] || 0);
    }
    if (sourceSummary.extractor_failures) {
      summary.extractor_failures = Number(summary.extractor_failures || 0) + Number(sourceSummary.extractor_failures);
      summary.extractor_last_error = sourceSummary.extractor_last_error;
    }
    summary.facts_extracted += committed.fileFacts;
    summary.inserted_count += committed.insertedCount;
    summary.linked_count += committed.linkedCount;
    summary.arbitration_verdicts += committed.arbitrationVerdicts;
    for (const memoryId of committed.sourceTouched) touched.add(memoryId);
    summary.sources.push({
      source_host: host,
      source_path: filePath,
      status: 'scanned',
      turns: fileTurns,
      facts: committed.fileFacts,
      byte_offset: consumedOffset,
      operation_id: operationId,
    });
  }

  summary.touched_memory_ids = Array.from(touched);

  return summary;
};

// Run the LOCAL extractor over one salient turn. A transport failure THROWS in
// the seam (Ollama down must never read as "no facts"); we catch it here, count
// it, and continue — a transcript harvest is best-effort and never aborts a
// nightly run over a transient local-LLM hiccup.
const runExtractor = ({ captureLlm, turnText, summary }) => {
  try {
    const facts = captureLlm.extract(turnText) || [];
    return Array.isArray(facts) ? facts : [];
  } catch (err) {
    summary.extractor_failures = Number(summary.extractor_failures || 0) + 1;
    summary.extractor_last_error = String(err?.message || err).slice(0, 200);
    return [];
  }
};

// Persist one extracted fact at the LOW transcript trust tier with per-line
// provenance. Mirrors the host_sync upsert+link, but with source_kind
// chat_history_hint so ingestConfidence caps it at the transcript FLOOR. Returns
// { memoryId, inserted } or null when the fact is empty/redacted-to-nothing.
const storeFact = ({
  db,
  config,
  scope,
  host,
  filePath,
  sourceLine,
  content,
  type,
  dryRun,
  faultInjector,
  operationId,
  tx,
}) => {
  // Redact again at write time (defense in depth) and drop if a secret survives.
  const redacted = redactMemoryText(String(content || ''));
  if (!redacted || hasSecretRisk(redacted)) return null;
  const normalized = normalizeContent(redacted);
  if (!normalized || normalized.length < 4) return null;
  const normalizedHash = hashNormalized(normalized);
  const existing = findCanonicalMemory(db, { normalizedHash, normalized, scope });
  const sourceHost = normalizeHost(host);
  const memoryId = existing?.memory_id || memoryIdForImport({
    sourceHost,
    sourcePath: filePath,
    sourceLine,
    normalizedHash,
    scope,
  });
  let inserted = false;
  if (dryRun !== true && !existing) {
    upsertCurrentMemory(db, {
      memory_id: memoryId,
      // Transcript-mined facts are USER_FACT-shaped by default; a decision/rule
      // cue maps to DECISION so it reads correctly in briefs (still trust-floored).
      type: (type === 'DECISION') ? 'DECISION' : 'USER_FACT',
      content: redacted,
      normalized,
      source: 'transcript_sync',
      source_agent: sourceHost,
      source_layer: 'host_memory',
      source_path: filePath,
      source_line: sourceLine,
      source_host: sourceHost,
      source_kind: TRANSCRIPT_SOURCE_KIND,
      sync_policy: TRANSCRIPT_SYNC_POLICY,
      // LOW transcript trust FLOOR (~0.32) via the SAME ingestConfidence path:
      // chat_history_hint caps confidence below every deliberate memory.
      confidence: ingestConfidence(sourceHost, TRANSCRIPT_SOURCE_KIND, config),
      scope,
      status: 'active',
      tags: [
        'transcript_sync',
        `source_host:${sourceHost}`,
        'source_kind:chat_history_hint',
        'trust_tier:transcript',
      ],
    }, {
      event: {
        action: 'transcript_harvest_inserted',
        component: 'transcript_harvest',
        payload: {
          content_hash: normalizedHash,
          source_host: sourceHost,
          source_line: sourceLine,
          source_path: filePath,
        },
        reason_codes: ['transcript_source_import'],
        run_id: operationId,
      },
      faultInjector,
      operationId,
      tx,
    });
    inserted = true;
  }
  if (dryRun !== true) {
    linkMemorySource(db, {
      memory_id: memoryId,
      source_host: sourceHost,
      source_kind: TRANSCRIPT_SOURCE_KIND,
      source_path: filePath,
      source_line: sourceLine,
      sync_policy: TRANSCRIPT_SYNC_POLICY,
      content_hash: normalizedHash,
    });
    if (typeof faultInjector === 'function') faultInjector('after_source_link');
  }
  return { memoryId, inserted };
};

// Read-only status rollup for the CLI `transcript status` verb. Mirrors vault
// status: per-source cursor offsets + turns/facts seen + last sync. NO walk, NO
// extraction, NO network — reads only the local cursor table.
const transcriptStatus = ({ db, config = {} } = {}) => {
  if (!db) throw new Error('transcriptStatus requires db');
  const transcripts = config?.native?.transcripts || {};
  const enabled = transcripts.enabled === true;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT source_path, source_host, byte_offset, size_bytes, turns_seen, facts_seen, last_synced_at
      FROM memory_transcript_sync_cursor
      ORDER BY last_synced_at DESC
    `).all();
  } catch {
    rows = [];
  }
  const sources = rows.map((row) => ({
    source_host: String(row.source_host || ''),
    source_path: String(row.source_path || ''),
    byte_offset: Number(row.byte_offset || 0),
    size_bytes: Number(row.size_bytes || 0),
    behind_bytes: Math.max(0, Number(row.size_bytes || 0) - Number(row.byte_offset || 0)),
    turns_seen: Number(row.turns_seen || 0),
    facts_seen: Number(row.facts_seen || 0),
    last_synced_at: String(row.last_synced_at || ''),
  }));
  return {
    ok: true,
    enabled,
    globs: Array.isArray(transcripts.globs) && transcripts.globs.length > 0 ? transcripts.globs : DEFAULT_GLOBS,
    maxFiles: Number(transcripts.maxFiles || DEFAULT_MAX_FILES),
    maxTurns: Number(transcripts.maxTurns || DEFAULT_MAX_TURNS),
    source_count: sources.length,
    total_facts_seen: sources.reduce((acc, s) => acc + s.facts_seen, 0),
    sources,
  };
};

export {
  DEFAULT_GLOBS,
  ensureTranscriptStore,
  harvestTranscripts,
  hostForRolloutPath,
  parseTurn,
  scoreTurnSalience,
  transcriptStatus,
  walkGlob,
};

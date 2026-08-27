import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { appendEvent, ensureEventStore } from './event-store.js';
import {
  ensureProjectionStore,
  listCurrentMemories,
  materializeProjectionFromMemories,
  updateCurrentStatus,
  withProjectionMutationBatch,
} from './projection-store.js';
import {
  classifyValue,
  jaccardSimilarity,
  resolvePolicy,
  resolveSemanticThresholds,
} from './policy.js';
import { reviewWithLlm } from './llm-router.js';
import { openDatabase } from './sqlite.js';
import { projectArbitrationBeliefRows } from './world-model.js';
import { runBeliefArbitration } from './belief-arbitration.js';
import { atomicWriteFileSync } from './safe-fs.js';

const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), '.gigabrain', 'output');

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const ensureDirFor = (filePath) => {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const writeJson = (filePath, payload) => {
  ensureDirFor(filePath);
  atomicWriteFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
};

const writeJsonl = (filePath, rows) => {
  ensureDirFor(filePath);
  const payload = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  atomicWriteFileSync(filePath, payload ? `${payload}\n` : '', { mode: 0o600 });
};

const writeMarkdown = (filePath, text) => {
  ensureDirFor(filePath);
  atomicWriteFileSync(filePath, text, { mode: 0o600 });
};

const ensureTableColumn = (db, tableName, columnName, columnSql) => {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (rows.some((row) => String(row.name || '') === String(columnName))) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
};

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

const buildReviewConfigFingerprint = ({ config = {}, llmConfig = {} } = {}) => {
  const payload = {
    policy: config?.policy || {},
    llm: {
      provider: String(llmConfig.provider || ''),
      model: String(llmConfig.model || ''),
      baseUrl: String(llmConfig.baseUrl || ''),
      enabled: llmConfig.enabled === true,
      minScore: Number(llmConfig.minScore ?? 0),
      maxScore: Number(llmConfig.maxScore ?? 0),
      minConfidence: Number(llmConfig.minConfidence ?? 0),
      limit: Number(llmConfig.limit ?? 0),
      profile: String(llmConfig.profile || ''),
    },
  };
  return createHash('sha1').update(stableStringify(payload)).digest('hex');
};

const ensureReviewLedger = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_quality_reviews (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      review_version TEXT NOT NULL,
      action TEXT NOT NULL,
      config_fingerprint TEXT,
      score REAL,
      reason_codes TEXT,
      before_status TEXT,
      after_status TEXT,
      features TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_quality_reviews_version ON memory_quality_reviews(review_version, action);
    CREATE INDEX IF NOT EXISTS idx_memory_quality_reviews_memory ON memory_quality_reviews(memory_id, reviewed_at);
  `);
  ensureTableColumn(db, 'memory_quality_reviews', 'config_fingerprint', 'TEXT');
};

const actionToStatus = (action, beforeStatus = 'active') => {
  const key = String(action || '').trim().toLowerCase();
  if (key === 'reject') return 'rejected';
  if (key === 'archive') return 'archived';
  if (key === 'keep') return 'active';
  if (key === 'merge_candidate') return beforeStatus;
  return beforeStatus;
};

const labelForAction = (action, fallback = 'situational') => {
  const key = String(action || '').trim().toLowerCase();
  if (key === 'reject') return 'junk';
  if (key === 'archive') return 'archive_candidate';
  if (key === 'keep') return 'core';
  if (key === 'merge_candidate') return 'situational';
  return fallback;
};

const parseJsonSafe = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const writeLedgerRow = (db, row) => {
  ensureReviewLedger(db);
  const stmt = db.prepare(`
    INSERT INTO memory_quality_reviews (
      id, memory_id, reviewed_at, review_version, action, score,
      config_fingerprint, reason_codes, before_status, after_status, features
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    randomUUID(),
    String(row.memory_id),
    String(row.reviewed_at),
    String(row.review_version),
    String(row.action),
    Number.isFinite(Number(row.score)) ? Number(row.score) : null,
    row.config_fingerprint ? String(row.config_fingerprint) : null,
    JSON.stringify(Array.isArray(row.reason_codes) ? row.reason_codes : []),
    row.before_status ? String(row.before_status) : null,
    row.after_status ? String(row.after_status) : null,
    JSON.stringify(row.features && typeof row.features === 'object' ? row.features : {}),
  );
};

const MAX_SCOPE_SIZE_FOR_SEMANTIC = 200;
const buildSemanticMap = (rows = [], config = {}) => {
  const byScope = new Map();
  for (const row of rows) {
    const scope = String(row.scope || 'shared').trim() || 'shared';
    const list = byScope.get(scope) || [];
    list.push(row);
    byScope.set(scope, list);
  }
  const map = new Map();
  for (const list of byScope.values()) {
    const capped = list.length > MAX_SCOPE_SIZE_FOR_SEMANTIC ? list.slice(0, MAX_SCOPE_SIZE_FOR_SEMANTIC) : list;
    for (let i = 0; i < capped.length; i += 1) {
      const a = capped[i];
      for (let j = i + 1; j < capped.length; j += 1) {
        const b = capped[j];
        if (String(a.type || 'CONTEXT') !== String(b.type || 'CONTEXT')) continue;
        const similarity = jaccardSimilarity(a.content || a.normalized || '', b.content || b.normalized || '');
        if (!Number.isFinite(similarity)) continue;
        const thresholds = resolveSemanticThresholds(a.type, config);
        if (similarity < Number(thresholds.review)) continue;
        const prevA = map.get(String(a.memory_id));
        if (!prevA || similarity > prevA.similarity) {
          map.set(String(a.memory_id), { similarity, matched: b });
        }
        const prevB = map.get(String(b.memory_id));
        if (!prevB || similarity > prevB.similarity) {
          map.set(String(b.memory_id), { similarity, matched: a });
        }
      }
    }
  }
  return map;
};

const shouldRunLlmReview = ({
  enabled,
  deterministic,
  llmConfig,
  semantic,
  action,
}) => {
  const provider = String(llmConfig?.provider || 'none').trim().toLowerCase();
  if (!enabled || provider === 'none') return false;
  const score = clamp01(deterministic?.value_score ?? 0);
  if (action === 'merge_candidate') return true;
  if (deterministic?.plausibility?.actionableCount > 0) return true;
  if (semantic && Number.isFinite(Number(semantic.similarity))) return true;
  return score >= clamp01(llmConfig?.minScore ?? 0.18) && score <= clamp01(llmConfig?.maxScore ?? 0.62);
};

const buildOutputPaths = (options = {}, config = undefined) => {
  // Default reports to the configured runtime outputDir (as watchRun does), so a
  // no-flag `gigabrainctl audit` honors runtime.paths.outputDir instead of the
  // homedir fallback — and reports land next to the local counters.
  const baseDir = resolveOutputDir(config);
  const out = path.resolve(options.out || path.join(baseDir, 'memory-audit-v3.jsonl'));
  const summary = path.resolve(options.summary || path.join(baseDir, 'memory-audit-v3-summary.json'));
  const samples = path.resolve(options.samples || path.join(baseDir, 'memory-audit-v3-samples.md'));
  return { out, summary, samples };
};

const summarizeRows = (rows = []) => {
  const summary = {
    total: rows.length,
    by_action: {},
    by_label: {},
    with_semantic_matches: 0,
  };
  for (const row of rows) {
    const action = String(row.action || 'unknown');
    const label = String(row.value_label || 'unknown');
    summary.by_action[action] = Number(summary.by_action[action] || 0) + 1;
    summary.by_label[label] = Number(summary.by_label[label] || 0) + 1;
    if (Number.isFinite(Number(row.similarity))) summary.with_semantic_matches += 1;
  }
  return summary;
};

const renderSamplesMarkdown = (rows = [], maxRows = 120) => {
  const lines = [];
  lines.push('# Gigabrain v3 Audit Samples');
  lines.push('');
  for (const row of rows.slice(0, maxRows)) {
    lines.push(`## ${row.action.toUpperCase()} - ${row.memory_id}`);
    lines.push(`- type: ${row.type}`);
    lines.push(`- scope: ${row.scope}`);
    lines.push(`- score: ${Number(row.score || 0).toFixed(4)}`);
    lines.push(`- reasons: ${(row.reason_codes || []).join(', ') || '(none)'}`);
    if (Number.isFinite(Number(row.similarity))) {
      lines.push(`- similarity: ${Number(row.similarity).toFixed(4)} (matched=${row.matched_memory_id || 'n/a'})`);
    }
    lines.push(`- content: ${String(row.content || '').trim()}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

// ---------------------------------------------------------------------------
// U16: opt-in LOCAL counters (wedge-metric instrumentation).
//
// Public telemetry policy is a hard constraint here: counters are plain
// aggregate event counts with no payload, no
// memory content, no ids, no hostnames, no reconciliation metadata. They are
// stored in a JSON file next to the audit reports (outputDir), default OFF
// (config telemetry.countersEnabled), and NOTHING ever auto-uploads them:
// the only egress is `gigabrain watch --export-counters` printing to stdout.
// ---------------------------------------------------------------------------
const COUNTERS_FILE_NAME = 'gigabrain-counters.json';
const COUNTER_KEYS = Object.freeze([
  'audit_runs',
  'watch_runs',
  'new_findings_surfaced',
  'verdicts_applied',
  'hook_installs',
]);

const resolveOutputDir = (config) => String(config?.runtime?.paths?.outputDir || '').trim() || DEFAULT_OUTPUT_DIR;

const localCountersEnabled = (config) => config?.telemetry?.countersEnabled === true;

const localCountersPath = (config) => path.join(resolveOutputDir(config), COUNTERS_FILE_NAME);

const emptyCounters = () => {
  const out = {};
  for (const key of COUNTER_KEYS) out[key] = 0;
  return out;
};

const readLocalCounters = (config) => {
  const filePath = localCountersPath(config);
  const counters = emptyCounters();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const key of COUNTER_KEYS) {
      const value = Number(parsed?.counters?.[key]);
      if (Number.isFinite(value) && value >= 0) counters[key] = Math.trunc(value);
    }
  } catch {
    // Missing or corrupt counters file reads as zeros.
  }
  return { enabled: localCountersEnabled(config), path: filePath, counters };
};

// verdicts_applied is DERIVED from ledger counts (recorded arbiter verdicts,
// incl. reinstatements — both are first-class verdicts per CONCEPTS.md),
// never incremented blind — the ledger is the source of truth.
const countLedgerVerdicts = (db) => {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM memory_events
      WHERE action IN ('arbiter:verdict', 'arbiter:reinstate')
    `).get();
    return Number(row?.c || 0);
  } catch {
    return null;
  }
};

const bumpLocalCounters = (config, increments = {}, { db = null } = {}) => {
  if (!localCountersEnabled(config)) return { written: false, reason: 'counters_disabled' };
  const state = readLocalCounters(config);
  for (const key of COUNTER_KEYS) {
    const inc = Number(increments?.[key]);
    if (Number.isFinite(inc) && inc > 0) state.counters[key] += Math.trunc(inc);
  }
  if (db) {
    const ledgerVerdicts = countLedgerVerdicts(db);
    if (ledgerVerdicts !== null) state.counters.verdicts_applied = ledgerVerdicts;
  }
  writeJson(state.path, {
    version: 1,
    updated_at: new Date().toISOString(),
    counters: state.counters,
  });
  return { written: true, path: state.path, counters: state.counters };
};

// Export = COUNTS ONLY. The shape is intentionally rigid (schema-asserted in
// tests: exactly schema_version + the five integer counters, nothing else) so
// a content/id/hostname field can never ride along unnoticed.
const exportLocalCounters = (config) => {
  const { counters } = readLocalCounters(config);
  const out = {};
  for (const key of COUNTER_KEYS) out[key] = Math.max(0, Math.trunc(Number(counters[key]) || 0));
  return { schema_version: 1, counters: out };
};

const runAudit = async ({
  dbPath,
  config,
  mode = 'shadow',
  reviewVersion = '',
  runId = '',
  out,
  summary,
  samples,
  llm = {},
  // U16 watch options. `since` is the snapshot cursor: only rows whose
  // created_at/updated_at is NEWER than the cursor are classified (the
  // semantic map still spans ALL active rows so a new row's duplicate or
  // contradiction against an OLD row is detected — only the new row is
  // reported). recordReviews=false skips ALL memory_quality_reviews writes
  // (shadow-only; watch's read-only guarantee). includeFindings returns the
  // classified rows on the summary payload. countAsAuditRun=false lets
  // watchRun count itself as a watch run instead of an audit run.
  since = '',
  recordReviews = true,
  includeFindings = false,
  countAsAuditRun = true,
  faultInjector = null,
  operationId = '',
}) => {
  const normalizedMode = String(mode || 'shadow').trim().toLowerCase();
  if (!['shadow', 'apply', 'restore'].includes(normalizedMode)) {
    throw new Error(`invalid audit mode=${mode}`);
  }
  if (normalizedMode === 'restore') {
    throw new Error('use runAuditRestore for mode=restore');
  }
  if (normalizedMode === 'apply' && recordReviews === false) {
    throw new Error('recordReviews=false is shadow-only (apply must keep the review ledger)');
  }
  const sinceRaw = String(since || '').trim();
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
  if (sinceRaw && !Number.isFinite(sinceMs)) {
    throw new Error(`invalid audit since cursor=${since} (parseable ISO timestamp required)`);
  }
  const hasSince = Number.isFinite(sinceMs);

  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureReviewLedger(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) {
      materializeProjectionFromMemories(db);
    }

    const activeRows = listCurrentMemories(db, {
      statuses: ['active'],
      limit: 200000,
    });
    const semanticMap = buildSemanticMap(activeRows, config);
    const policy = resolvePolicy(config);
    const cleanupVersion = String(config?.runtime?.cleanupVersion || 'v3.0.0');
    const nowIso = new Date().toISOString();
    const resolvedReviewVersion = String(reviewVersion || `rv-${nowIso.replace(/[:.]/g, '-')}`);
    const resolvedRunId = String(runId || `run-${nowIso.replace(/[:.]/g, '-')}`);

    const llmCfg = {
      provider: String(llm.provider || config?.llm?.provider || 'none'),
      baseUrl: String(llm.baseUrl || config?.llm?.baseUrl || ''),
      model: String(llm.model || config?.llm?.model || ''),
      apiKey: String(llm.apiKey || config?.llm?.apiKey || ''),
      timeoutMs: Number(llm.timeoutMs || config?.llm?.timeoutMs || 12000),
      taskProfiles: config?.llm?.taskProfiles || {},
      enabled: llm.enabled === true || config?.llm?.review?.enabled === true,
      minScore: Number(llm.minScore ?? config?.llm?.review?.minScore ?? 0.18),
      maxScore: Number(llm.maxScore ?? config?.llm?.review?.maxScore ?? 0.62),
      minConfidence: Number(llm.minConfidence ?? config?.llm?.review?.minConfidence ?? 0.8),
      limit: Math.max(0, Number(llm.limit ?? config?.llm?.review?.limit ?? 200)),
      profile: String(llm.profile || config?.llm?.review?.profile || 'memory_review'),
    };
    const reviewConfigFingerprint = buildReviewConfigFingerprint({
      config,
      llmConfig: llmCfg,
    });

    // --- Idempotency: load reviews from this version to skip unchanged ---
    const priorReviews = new Map();
    try {
      const priorRows = db.prepare(`
        SELECT memory_id, action, score
        FROM memory_quality_reviews
        WHERE review_version = ? AND COALESCE(config_fingerprint, '') = ?
        ORDER BY reviewed_at DESC
      `).all(resolvedReviewVersion, reviewConfigFingerprint);
      for (const pr of priorRows) {
        const mid = String(pr.memory_id);
        if (priorReviews.has(mid)) continue;
        priorReviews.set(mid, {
          action: String(pr.action || ''),
          score: Number.isFinite(Number(pr.score)) ? Number(pr.score) : 0,
        });
      }
    } catch (_) {
      // First run or missing table — review everything
    }

    const rows = [];
    const llmReviewActive = llmCfg.enabled && String(llmCfg.provider || 'none').trim().toLowerCase() !== 'none';
    const llmStats = {
      enabled: llmReviewActive,
      provider: llmCfg.provider,
      attempted: 0,
      accepted: 0,
      failed: 0,
      skipped_secret_risk: 0,
    };

    // Phase 1: classify all rows (including async LLM calls) outside transaction
    const classified = [];
    for (const memory of activeRows) {
      // U16: snapshot-cursor delta — rows at or before the cursor were covered
      // by the previous watch run and are not NEW findings.
      if (hasSince) {
        const rowMs = Math.max(
          Date.parse(String(memory.updated_at || '')) || 0,
          Date.parse(String(memory.created_at || '')) || 0,
        );
        if (rowMs <= sinceMs) continue;
      }
      const deterministic = classifyValue(memory, policy);
      const semantic = semanticMap.get(String(memory.memory_id));
      let action = deterministic.action;
      let reasons = Array.from(new Set(deterministic.reason_codes || []));

      const semanticThresholds = resolveSemanticThresholds(memory?.type, config);
      if (semantic && Number(semantic.similarity) >= Number(semanticThresholds.auto)) {
        action = 'merge_candidate';
        reasons = Array.from(new Set([...reasons, 'duplicate_semantic']));
      }

      const prior = priorReviews.get(String(memory.memory_id));
      if (prior
        && prior.action === action
        && Math.abs(prior.score - (Number.isFinite(Number(deterministic.value_score)) ? Number(deterministic.value_score) : 0)) < 0.001
      ) {
        continue;
      }

      const canLlmReview = shouldRunLlmReview({
        enabled: llmReviewActive && llmStats.attempted < llmCfg.limit,
        deterministic,
        llmConfig: llmCfg,
        semantic,
        action,
      });
      if (canLlmReview) {
        const llmResult = await reviewWithLlm({
          provider: llmCfg.provider,
          baseUrl: llmCfg.baseUrl,
          model: llmCfg.model,
          apiKey: llmCfg.apiKey,
          timeoutMs: llmCfg.timeoutMs,
          memory,
          deterministic,
          taskProfiles: llmCfg.taskProfiles,
          profile: llmCfg.profile,
        });
        if (llmResult.skipped) {
          llmStats.skipped_secret_risk += 1;
        } else {
          llmStats.attempted += 1;
        }
        if (llmResult.ok) {
          if (Number(llmResult.confidence || 0) >= Number(llmCfg.minConfidence || 0.8) && llmResult.decision) {
            action = llmResult.decision;
            llmStats.accepted += 1;
            reasons = Array.from(new Set([
              ...reasons,
              action === 'keep' ? 'llm_second_opinion_keep' : action === 'archive' ? 'llm_second_opinion_archive' : 'llm_second_opinion',
            ]));
          }
        } else if (!llmResult.skipped) {
          llmStats.failed += 1;
        }
        classified.push({ memory, deterministic, semantic, action, reasons, canonicalHint: llmResult.canonical_hint || '' });
        continue;
      }

      classified.push({ memory, deterministic, semantic, action, reasons, canonicalHint: '' });
    }

    // Phase 2: apply all results inside a single transaction.
    // U16: recordReviews=false (watch) builds the report rows WITHOUT touching
    // the review ledger — watch's only DB write is its snapshot event.
    const shouldWriteReviews = recordReviews !== false;
    const applyClassified = (tx = null) => {
      for (const { memory, deterministic, semantic, action, reasons, canonicalHint } of classified) {
        const beforeStatus = String(memory.status || 'active');
        const afterStatus = actionToStatus(action, beforeStatus);
        const row = {
          memory_id: String(memory.memory_id),
          type: String(memory.type || ''),
          scope: String(memory.scope || ''),
          content: String(memory.content || ''),
          score: Number.isFinite(Number(deterministic.value_score)) ? Number(deterministic.value_score) : 0,
          action,
          value_label: deterministic.value_label || labelForAction(action, 'situational'),
          reason_codes: reasons,
          before_status: beforeStatus,
          after_status: afterStatus,
          reviewed_at: nowIso,
          review_version: resolvedReviewVersion,
          config_fingerprint: reviewConfigFingerprint,
          similarity: semantic ? Number(semantic.similarity) : null,
          matched_memory_id: semantic?.matched?.memory_id ? String(semantic.matched.memory_id) : null,
          features: deterministic.features || {},
          canonical_hint: canonicalHint || '',
        };
        rows.push(row);

        if (shouldWriteReviews) writeLedgerRow(db, row);

        if (normalizedMode === 'apply') {
          if (afterStatus !== beforeStatus || row.value_label || Number.isFinite(Number(row.score))) {
            updateCurrentStatus(db, row.memory_id, afterStatus, {
              value_score: row.score,
              value_label: row.value_label,
              timestamp: row.reviewed_at,
              last_reviewed_at: row.reviewed_at,
              // KEEP verdicts refresh score/label/last_reviewed_at only; bumping
              // updated_at here stamped all 1.5k active rows nightly and killed
              // recency ranking store-wide.
              preserve_updated_at: afterStatus === beforeStatus,
            }, {
              tx,
              faultInjector,
              event: {
                timestamp: row.reviewed_at,
                component: 'review',
                action: `audit_${action}`,
                reason_codes: row.reason_codes,
                memory_id: row.memory_id,
                cleanup_version: cleanupVersion,
                run_id: resolvedRunId,
                review_version: resolvedReviewVersion,
                similarity: row.similarity,
                matched_memory_id: row.matched_memory_id,
                payload: {
                  before_status: row.before_status,
                  after_status: row.after_status,
                  value_score: row.score,
                  value_label: row.value_label,
                  features: row.features,
                  ...(row.canonical_hint ? { canonical_hint: row.canonical_hint } : {}),
                },
              },
            });
          }
        }
      }
    };
    if (normalizedMode === 'apply') {
      withProjectionMutationBatch({
        db,
        now: nowIso,
        operationId: operationId || resolvedRunId,
      }, (tx) => applyClassified(tx));
    } else if (shouldWriteReviews) {
      db.exec('BEGIN');
      try {
        applyClassified();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } else {
      applyClassified();
    }

    const outputPaths = buildOutputPaths({ out, summary, samples }, config);
    writeJsonl(outputPaths.out, rows);
    const summaryPayload = {
      ok: true,
      mode: normalizedMode,
      reviewVersion: resolvedReviewVersion,
      runId: resolvedRunId,
      since: hasSince ? new Date(sinceMs).toISOString() : null,
      rows: rows.length,
      summary: summarizeRows(rows),
      llmReview: llmStats,
      output: outputPaths,
    };
    writeJson(outputPaths.summary, summaryPayload);
    writeMarkdown(outputPaths.samples, renderSamplesMarkdown(rows));

    // U16: opt-in local counter (no-op unless telemetry.countersEnabled).
    if (countAsAuditRun !== false) {
      bumpLocalCounters(config, { audit_runs: 1 }, { db });
    }

    // Findings ride the RETURN value only (the jsonl report already persists
    // them; the summary file stays counts-shaped).
    return includeFindings === true ? { ...summaryPayload, findings: rows } : summaryPayload;
  } finally {
    db.close();
  }
};

// ---------------------------------------------------------------------------
// U16 (R13): `gigabrain watch` — the recurring governance surface.
//
// watchRun re-runs the audit against a ledger snapshot cursor and reports
// only NEW findings since the last snapshot. Write surface, in full:
// audit READS + exactly ONE watch:snapshot ledger event — the audit runs in
// shadow mode with review-ledger writes disabled, memory_current is never
// touched (pinned byte-identical in tests). First run (no prior snapshot)
// = full audit, labeled full_run.
// ---------------------------------------------------------------------------
const WATCH_SNAPSHOT_ACTION = 'watch:snapshot';
// Sentinel memory_id: the snapshot is about a RUN, not a memory row; the
// event store requires a non-empty memory_id, so snapshots self-namespace.
const WATCH_SNAPSHOT_MEMORY_ID = 'watch:snapshot';

const readLastWatchSnapshot = (db) => {
  try {
    const row = db.prepare(`
      SELECT event_id, timestamp, payload
      FROM memory_events
      WHERE action = ?
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `).get(WATCH_SNAPSHOT_ACTION);
    if (!row) return null;
    return {
      event_id: String(row.event_id || ''),
      timestamp: String(row.timestamp || ''),
      payload: parseJsonSafe(row.payload, {}),
    };
  } catch {
    // memory_events may not exist yet — first watch run on a fresh store.
    return null;
  }
};

// A watch FINDING is an audited row the audit flagged (reject / archive /
// merge_candidate). Healthy `keep` rows are audited but are not findings —
// the recurring surface reports problems, not inventory.
const isWatchFinding = (row) => String(row?.action || '').trim().toLowerCase() !== 'keep';

const watchRun = async ({
  dbPath,
  config,
  runId = '',
  out = '',
  summary = '',
  samples = '',
  // U17 OPT-IN escalation: arbitrate=true runs the extracted belief
  // arbitration (belief-arbitration.js, independent of worldModel.enabled)
  // BEFORE the audit read, so the findings reflect post-verdict state. This
  // is the ONLY watch mode that writes beyond the snapshot event (verdicts +
  // supersessions on the ledger) — the default stays read-only, exactly as
  // U16 pinned it.
  arbitrate = false,
}) => {
  let prior = null;
  let arbitration = null;
  {
    const db = openDatabase(dbPath);
    try {
      prior = readLastWatchSnapshot(db);
      if (arbitrate === true) {
        arbitration = runBeliefArbitration({
          db,
          config,
          projectBeliefRows: projectArbitrationBeliefRows,
        });
      }
    } finally {
      db.close();
    }
  }
  const priorTs = String(prior?.timestamp || '').trim();
  const sinceIso = priorTs && Number.isFinite(Date.parse(priorTs)) ? priorTs : '';
  const fullRun = !sinceIso;
  // The snapshot is stamped with the time the audit STARTED reading: a row
  // written while the audit runs may be double-checked next run, but can
  // never fall into a cursor gap and be missed.
  const runAt = new Date().toISOString();
  const resolvedRunId = String(runId || `watch-${runAt.replace(/[:.]/g, '-')}`);

  const outputDir = resolveOutputDir(config);
  const audit = await runAudit({
    dbPath,
    config,
    mode: 'shadow',
    runId: resolvedRunId,
    since: sinceIso,
    recordReviews: false,
    includeFindings: true,
    countAsAuditRun: false,
    out: out || path.join(outputDir, 'memory-watch-findings.jsonl'),
    summary: summary || path.join(outputDir, 'memory-watch-summary.json'),
    samples: samples || path.join(outputDir, 'memory-watch-samples.md'),
    // Watch findings are deterministic-only: no LLM second opinions on the
    // recurring surface (offline, repeatable, hook-safe).
    llm: { enabled: false, provider: 'none' },
  });

  const findings = (Array.isArray(audit.findings) ? audit.findings : []).filter(isWatchFinding);
  const findingsByAction = summarizeRows(findings).by_action;

  let snapshotEvent = null;
  {
    const db = openDatabase(dbPath);
    try {
      ensureEventStore(db);
      snapshotEvent = appendEvent(db, {
        timestamp: runAt,
        component: 'watch',
        action: WATCH_SNAPSHOT_ACTION,
        reason_codes: ['watch_snapshot'],
        memory_id: WATCH_SNAPSHOT_MEMORY_ID,
        cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
        run_id: resolvedRunId,
        review_version: '',
        payload: {
          run_at: runAt,
          since: sinceIso || null,
          full_run: fullRun,
          rows_audited: Number(audit.rows || 0),
          new_findings: findings.length,
          findings_by_action: findingsByAction,
          ...(arbitration ? { arbitration: arbitration.counts } : {}),
        },
      });
      // U16 counters (opt-in, local-only): one watch run, N new findings.
      bumpLocalCounters(config, {
        watch_runs: 1,
        new_findings_surfaced: findings.length,
      }, { db });
    } finally {
      db.close();
    }
  }

  return {
    ok: true,
    surface: 'watch',
    full_run: fullRun,
    arbitration: arbitration ? arbitration.counts : null,
    since: sinceIso || null,
    run_at: runAt,
    runId: resolvedRunId,
    snapshot_event_id: snapshotEvent.event_id,
    rows_audited: Number(audit.rows || 0),
    new_findings: findings.length,
    findings_by_action: findingsByAction,
    findings,
    output: audit.output,
  };
};

const runAuditRestore = ({
  dbPath,
  reviewVersion,
  runId = '',
  cleanupVersion = 'v3.0.0',
  faultInjector = null,
  operationId = '',
}) => {
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureReviewLedger(db);
    const version = String(reviewVersion || '').trim();
    if (!version) throw new Error('reviewVersion is required for restore');

    const rows = db.prepare(`
      SELECT
        memory_id, reviewed_at, action, before_status, after_status, score, reason_codes, features
      FROM memory_quality_reviews
      WHERE review_version = ?
      ORDER BY reviewed_at DESC
    `).all(version);
    if (!rows || rows.length === 0) {
      return { ok: true, restored: 0, reviewVersion: version };
    }
    const seen = new Set();
    let restored = 0;
    const nowIso = new Date().toISOString();
    withProjectionMutationBatch({
      db,
      now: nowIso,
      operationId: operationId || runId || `audit-restore-${version}`,
    }, (tx) => {
      for (const row of rows) {
        const memoryId = String(row.memory_id || '');
        if (!memoryId || seen.has(memoryId)) continue;
        seen.add(memoryId);
        const beforeStatus = String(row.before_status || 'active');
        updateCurrentStatus(db, memoryId, beforeStatus, {
          timestamp: nowIso,
          last_reviewed_at: nowIso,
        }, {
          tx,
          faultInjector,
          event: {
            timestamp: nowIso,
            component: 'review',
            action: 'audit_restore',
            reason_codes: ['restore'],
            memory_id: memoryId,
            cleanup_version: String(cleanupVersion || 'v3.0.0'),
            run_id: String(runId || `restore-${nowIso.replace(/[:.]/g, '-')}`),
            review_version: version,
            payload: {
              restored_to_status: beforeStatus,
            },
          },
        });
        restored += 1;
      }
    });
    return {
      ok: true,
      restored,
      reviewVersion: version,
    };
  } finally {
    db.close();
  }
};

const runAuditReport = ({
  dbPath,
  reviewVersion,
  out = '',
}) => {
  const db = openDatabase(dbPath);
  try {
    ensureReviewLedger(db);
    const version = String(reviewVersion || '').trim();
    if (!version) throw new Error('reviewVersion is required for report');

    const rows = db.prepare(`
      SELECT action, COUNT(*) AS count
      FROM memory_quality_reviews
      WHERE review_version = ?
      GROUP BY action
      ORDER BY count DESC
    `).all(version);
    const summary = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count || 0);
      summary[String(row.action || 'unknown')] = count;
      total += count;
    }

    const sampleRows = db.prepare(`
      SELECT memory_id, action, score, reason_codes, before_status, after_status
      FROM memory_quality_reviews
      WHERE review_version = ?
      ORDER BY reviewed_at DESC
      LIMIT 30
    `).all(version).map((row) => ({
      memory_id: String(row.memory_id || ''),
      action: String(row.action || ''),
      score: Number.isFinite(Number(row.score)) ? Number(row.score) : null,
      reason_codes: parseJsonSafe(row.reason_codes, []),
      before_status: row.before_status ? String(row.before_status) : null,
      after_status: row.after_status ? String(row.after_status) : null,
    }));

    const payload = {
      ok: true,
      reviewVersion: version,
      summary: {
        total_reviews: total,
        actions: summary,
      },
      samples: sampleRows,
    };
    if (out) writeJson(path.resolve(out), payload);
    return payload;
  } finally {
    db.close();
  }
};

/**
 * Remove no-op review rows where before_status === after_status,
 * keeping only the most recent no-op per memory (for audit trail).
 * Returns { ok, deleted, kept }.
 */
const purgeNoopReviews = ({ dbPath }) => {
  const db = openDatabase(dbPath);
  try {
    ensureReviewLedger(db);
    // Keep one latest no-op per memory, delete the rest
    const totalNoops = db.prepare(`
      SELECT COUNT(*) AS c FROM memory_quality_reviews
      WHERE before_status = after_status
    `).get()?.c || 0;
    const uniqueMemories = db.prepare(`
      SELECT COUNT(DISTINCT memory_id) AS c FROM memory_quality_reviews
      WHERE before_status = after_status
    `).get()?.c || 0;

    db.exec('BEGIN');
    try {
      db.exec(`
        DELETE FROM memory_quality_reviews
        WHERE before_status = after_status
          AND id NOT IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY memory_id ORDER BY reviewed_at DESC
              ) AS rn
              FROM memory_quality_reviews
              WHERE before_status = after_status
            ) WHERE rn = 1
          )
      `);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM memory_quality_reviews').get()?.c || 0;
    const deleted = totalNoops - uniqueMemories;
    return { ok: true, deleted, kept: remaining };
  } finally {
    db.close();
  }
};

export {
  ensureReviewLedger,
  runAudit,
  runAuditRestore,
  runAuditReport,
  purgeNoopReviews,
  // U16: watch surface + opt-in local counters
  watchRun,
  WATCH_SNAPSHOT_ACTION,
  readLocalCounters,
  bumpLocalCounters,
  exportLocalCounters,
};

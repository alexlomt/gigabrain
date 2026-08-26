import { randomUUID } from 'node:crypto';

import { inferTypeFromContent } from './capture-service.js';
import { listCurrentMemories, updateCurrentStatus, upsertCurrentMemory } from './projection-store.js';
import {
  classifyValue,
  detectPlausibility,
  jaccardSimilarity,
  normalizeContent,
  resolvePolicy,
  resolveSemanticThresholds,
} from './policy.js';

const SECTION_TYPE_RULES = Object.freeze([
  ['PREFERENCE', 'PREFERENCE'],
  ['DECISION', 'DECISION'],
  ['ENTITY', 'ENTITY'],
  ['EPISODE', 'EPISODE'],
  ['AGENT IDENTITY', 'AGENT_IDENTITY'],
  ['AGENT_IDENTITY', 'AGENT_IDENTITY'],
  ['USER FACT', 'USER_FACT'],
  ['USER_FACT', 'USER_FACT'],
  ['FACT', 'USER_FACT'],
]);

const DAILY_EPHEMERAL_RE = /\b(?:today|tonight|this morning|this afternoon|this evening|right now|currently|for now|temporary|temporarily|tired|hungry|busy)\b/i;

const inferChunkType = (chunk = {}) => {
  const explicit = String(chunk.memory_type || '').trim().toUpperCase();
  if (explicit) return explicit;
  const section = String(chunk.section || '').toUpperCase();
  for (const [needle, type] of SECTION_TYPE_RULES) {
    if (section.includes(needle)) return type;
  }
  return inferTypeFromContent(chunk.content || '');
};

const inferChunkScope = (chunk = {}) => {
  const explicitScope = String(chunk.scope || '').trim();
  if (explicitScope) return explicitScope;
  const sourceKind = String(chunk.source_kind || '');
  if (sourceKind === 'memory_md' || sourceKind === 'daily_note') return 'profile:main';
  if (sourceKind === 'curated') return 'shared';
  return 'shared';
};

const findExactDuplicate = (existingRows, normalized, scope) => {
  const key = `${String(scope || 'shared')}|${normalized}`;
  for (const row of existingRows) {
    const rowKey = `${String(row.scope || 'shared')}|${String(row.normalized || '')}`;
    if (rowKey === key && String(row.status || 'active') === 'active') return row;
  }
  return null;
};

const findSemanticDuplicate = (existingRows, content, scope, type, config) => {
  let best = null;
  for (const row of existingRows) {
    if (String(row.scope || 'shared') !== String(scope || 'shared')) continue;
    if (String(row.type || 'CONTEXT') !== String(type || 'CONTEXT')) continue;
    if (String(row.status || 'active') !== 'active') continue;
    const similarity = jaccardSimilarity(content, row.content || row.normalized || '');
    if (!best || similarity > best.similarity) best = { row, similarity };
  }
  if (!best) return null;
  return { ...best, thresholds: resolveSemanticThresholds(type, config) };
};

const promotionCheck = ({ chunk, type, scope, config, policy }) => {
  const sourceKind = String(chunk.source_kind || '');
  if (String(chunk.origin_kind || '') !== 'human_native') return { ok: false, reason: 'origin_excluded' };
  if (sourceKind === 'memory_md' && config?.nativePromotion?.promoteFromMemoryMd === false) {
    return { ok: false, reason: 'memory_md_disabled' };
  }
  if (sourceKind === 'daily_note' && config?.nativePromotion?.promoteFromDaily === false) {
    return { ok: false, reason: 'daily_disabled' };
  }
  if (!['memory_md', 'daily_note'].includes(sourceKind)) return { ok: false, reason: 'source_kind_excluded' };
  if (sourceKind === 'daily_note' && config?.nativePromotion?.requireDailyMetadata === true) {
    if (!String(chunk.memory_type || '').trim() || !String(chunk.scope || '').trim()) {
      return { ok: false, reason: 'daily_metadata_required' };
    }
  }
  if (!type || !scope) return { ok: false, reason: 'typed_scope_required' };
  if (type === 'CONTEXT' || type === 'EPISODE') return { ok: false, reason: 'situational_type' };
  if (sourceKind === 'daily_note' && DAILY_EPHEMERAL_RE.test(String(chunk.content || ''))) {
    return { ok: false, reason: 'situational_daily' };
  }

  const confidence = sourceKind === 'memory_md' ? 0.86 : 0.72;
  if (confidence < Number(config?.nativePromotion?.minConfidence ?? 0.72)) {
    return { ok: false, reason: 'confidence_below_threshold' };
  }
  const plausibility = detectPlausibility({
    type,
    content: chunk.content || '',
    confidence,
    scope,
  }, policy);
  if (plausibility.actionableCount > 0) return { ok: false, reason: 'plausibility_flag', plausibility };
  const value = classifyValue({
    type,
    content: chunk.content || '',
    confidence,
    scope,
    status: 'active',
    updated_at: chunk.last_seen_at || chunk.first_seen_at || new Date().toISOString(),
  }, policy);
  if (value.action !== 'keep') return { ok: false, reason: 'not_durable_enough', value };
  return { ok: true, confidence, value };
};

const isPromotionEligibleChunk = (chunk = {}, { config = {}, policy = resolvePolicy(config) } = {}) => {
  if (String(chunk.status || 'active') !== 'active') return false;
  const content = String(chunk.content || '').trim();
  if (!content || !normalizeContent(content)) return false;
  const type = inferChunkType(chunk);
  const scope = inferChunkScope(chunk);
  return promotionCheck({ chunk, type, scope, config, policy }).ok === true;
};

const normalizeSourcePaths = (sourcePaths = []) => [...new Set(
  (Array.isArray(sourcePaths) ? sourcePaths : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean),
)].sort();

const loadSourceChunks = (db, sourcePaths = []) => {
  const paths = normalizeSourcePaths(sourcePaths);
  if (paths.length === 0) return [];
  return db.prepare(`
    SELECT chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
           content, normalized, hash, scope, memory_type, origin_kind, linked_memory_id,
           first_seen_at, last_seen_at, status
    FROM memory_native_chunks
    WHERE source_path IN (${paths.map(() => '?').join(',')})
    ORDER BY source_path ASC, line_start ASC, chunk_id ASC
  `).all(...paths);
};

const currentMemory = (db, memoryId) => db.prepare(`
  SELECT * FROM memory_current WHERE memory_id = ? LIMIT 1
`).get(String(memoryId || '')) || null;

const desiredRow = (chunk, check, memoryId) => ({
  memory_id: memoryId,
  type: inferChunkType(chunk),
  content: String(chunk.content || '').trim(),
  normalized: normalizeContent(chunk.content || chunk.normalized || ''),
  source: 'promoted_native',
  source_layer: 'promoted_native',
  source_path: String(chunk.source_path || ''),
  source_line: Number(chunk.line_start || 0) || null,
  confidence: check.confidence,
  scope: inferChunkScope(chunk),
  status: 'active',
  value_score: Number(check?.value?.value_score ?? 0.82),
  value_label: String(check?.value?.value_label || 'core'),
  created_at: chunk.first_seen_at || new Date().toISOString(),
  updated_at: chunk.last_seen_at || new Date().toISOString(),
  valid_until: null,
});

const rowNeedsRepair = (row, desired) => !row
  || String(row.type || '') !== desired.type
  || String(row.content || '') !== desired.content
  || String(row.normalized || '') !== desired.normalized
  || String(row.scope || '') !== desired.scope
  || String(row.source_layer || '') !== 'promoted_native'
  || String(row.source_path || '') !== desired.source_path
  || Number(row.source_line || 0) !== Number(desired.source_line || 0)
  || String(row.status || '') !== 'active';

const promoteNativeChunks = ({ db, config, sourcePaths = [], dryRun = false } = {}) => {
  const paths = normalizeSourcePaths(sourcePaths);
  const summary = {
    scanned_chunks: 0,
    promoted_inserted: 0,
    linked_existing: 0,
    skipped_linked: 0,
    skipped_not_durable: 0,
    skipped_exact_duplicate: 0,
    skipped_semantic_duplicate: 0,
    repaired_links: 0,
    relinked: 0,
    rejected_or_unlinked: 0,
    changed_sources: paths,
    promoted_ids: [],
  };
  if (paths.length === 0 || config?.nativePromotion?.enabled === false) return summary;

  const policy = resolvePolicy(config);
  const chunks = loadSourceChunks(db, paths);
  summary.scanned_chunks = chunks.length;
  const checks = new Map();
  for (const chunk of chunks) {
    const type = inferChunkType(chunk);
    const scope = inferChunkScope(chunk);
    const content = String(chunk.content || '').trim();
    const check = content && normalizeContent(content)
      ? promotionCheck({ chunk, type, scope, config, policy })
      : { ok: false, reason: 'empty' };
    checks.set(String(chunk.chunk_id), check);
  }

  const linkChunk = db.prepare('UPDATE memory_native_chunks SET linked_memory_id = ? WHERE chunk_id = ?');
  const unlinkChunk = db.prepare('UPDATE memory_native_chunks SET linked_memory_id = NULL WHERE chunk_id = ?');
  const eligibleLinkedByMemory = new Map();
  for (const chunk of chunks) {
    if (!chunk.linked_memory_id || checks.get(String(chunk.chunk_id))?.ok !== true || chunk.status !== 'active') continue;
    const key = String(chunk.linked_memory_id);
    const list = eligibleLinkedByMemory.get(key) || [];
    list.push(chunk);
    eligibleLinkedByMemory.set(key, list);
  }

  for (const chunk of chunks) {
    const memoryId = String(chunk.linked_memory_id || '').trim();
    if (!memoryId) continue;
    const check = checks.get(String(chunk.chunk_id));
    const eligible = chunk.status === 'active' && check?.ok === true;
    const row = currentMemory(db, memoryId);
    if (!eligible || !row) {
      if (!dryRun) unlinkChunk.run(String(chunk.chunk_id));
      chunk.linked_memory_id = null;
      const otherValid = (eligibleLinkedByMemory.get(memoryId) || [])
        .some((candidate) => candidate.chunk_id !== chunk.chunk_id);
      if (row && !otherValid && String(row.source_layer || '') === 'promoted_native') {
        if (!dryRun) updateCurrentStatus(db, memoryId, 'rejected', { timestamp: new Date().toISOString() });
      }
      summary.rejected_or_unlinked += 1;
      continue;
    }
    const desired = desiredRow(chunk, check, memoryId);
    if (rowNeedsRepair(row, desired)) {
      if (!dryRun) upsertCurrentMemory(db, { ...row, ...desired, clear_valid_until: true });
      summary.repaired_links += 1;
    } else {
      summary.skipped_linked += 1;
    }
  }

  const activeByScope = new Map();
  const getExistingRows = (scope) => {
    if (!activeByScope.has(scope)) {
      activeByScope.set(scope, listCurrentMemories(db, {
        statuses: ['active'],
        scope,
        limit: 5000,
      }));
    }
    return activeByScope.get(scope);
  };

  for (const chunk of chunks) {
    if (chunk.status !== 'active' || chunk.linked_memory_id) continue;
    const check = checks.get(String(chunk.chunk_id));
    if (check?.ok !== true) {
      summary.skipped_not_durable += 1;
      continue;
    }
    const content = String(chunk.content || '').trim();
    const normalized = normalizeContent(content);
    const type = inferChunkType(chunk);
    const scope = inferChunkScope(chunk);

    const rejectedMatch = db.prepare(`
      SELECT * FROM memory_current
      WHERE normalized = ? AND scope = ? AND source_layer = 'promoted_native'
      ORDER BY CASE WHEN source_path = ? THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get(normalized, scope, String(chunk.source_path || ''));
    if (rejectedMatch && String(rejectedMatch.status || '') !== 'active') {
      const desired = desiredRow(chunk, check, String(rejectedMatch.memory_id));
      if (!dryRun) {
        upsertCurrentMemory(db, { ...rejectedMatch, ...desired });
        linkChunk.run(String(rejectedMatch.memory_id), String(chunk.chunk_id));
      }
      chunk.linked_memory_id = String(rejectedMatch.memory_id);
      summary.relinked += 1;
      summary.repaired_links += 1;
      getExistingRows(scope).push({ ...rejectedMatch, ...desired });
      continue;
    }

    const existing = getExistingRows(scope);
    const exact = findExactDuplicate(existing, normalized, scope);
    if (exact) {
      if (!dryRun) {
        const repaired = {
          ...exact,
          source_layer: exact.source_path ? String(exact.source_layer || 'native') : 'promoted_native',
          source_path: exact.source_path || String(chunk.source_path || ''),
          source_line: exact.source_line || Number(chunk.line_start || 0) || null,
          updated_at: exact.updated_at || chunk.last_seen_at || new Date().toISOString(),
        };
        upsertCurrentMemory(db, repaired);
        linkChunk.run(String(exact.memory_id || exact.id || ''), String(chunk.chunk_id));
      }
      chunk.linked_memory_id = String(exact.memory_id || exact.id || '');
      summary.linked_existing += 1;
      summary.skipped_exact_duplicate += 1;
      continue;
    }

    const semantic = findSemanticDuplicate(existing, content, scope, type, config);
    if (semantic && semantic.similarity >= Number(semantic.thresholds.auto)) {
      if (!dryRun) {
        upsertCurrentMemory(db, {
          ...semantic.row,
          source_layer: semantic.row.source_path ? String(semantic.row.source_layer || 'native') : 'promoted_native',
          source_path: semantic.row.source_path || String(chunk.source_path || ''),
          source_line: semantic.row.source_line || Number(chunk.line_start || 0) || null,
          updated_at: semantic.row.updated_at || chunk.last_seen_at || new Date().toISOString(),
        });
        linkChunk.run(String(semantic.row.memory_id || semantic.row.id || ''), String(chunk.chunk_id));
      }
      chunk.linked_memory_id = String(semantic.row.memory_id || semantic.row.id || '');
      summary.linked_existing += 1;
      summary.skipped_semantic_duplicate += 1;
      continue;
    }

    const memoryId = randomUUID();
    const payload = desiredRow(chunk, check, memoryId);
    const row = dryRun ? payload : upsertCurrentMemory(db, payload);
    if (!dryRun) linkChunk.run(memoryId, String(chunk.chunk_id));
    chunk.linked_memory_id = memoryId;
    existing.push(row);
    summary.promoted_inserted += 1;
    summary.promoted_ids.push(memoryId);
  }
  return summary;
};

export {
  inferChunkScope,
  inferChunkType,
  isPromotionEligibleChunk,
  promoteNativeChunks,
};

import crypto from 'node:crypto';

import {
  ensureProjectionStore,
  normalizeProjectionScope,
  upsertCurrentMemory,
  withProjectionMutationBatch,
} from './projection-store.js';
import {
  ALLOWED_SOURCE_HOSTS,
  ALLOWED_SOURCE_KINDS,
  ALLOWED_SYNC_POLICIES,
  ensureHostMemoryStore,
  linkMemorySource,
  normalizeHost,
  normalizeKind,
  normalizePolicy,
} from './host-memory-sync.js';
import { ensureEventStore, listTimeline } from './event-store.js';
import { hashNormalized, normalizeContent } from './policy.js';
import { VALID_MEMORY_TYPES } from '../compat/native-metadata.js';

// Handoff is a deliberately narrow transfer artifact. It carries current
// memory rows, source-link evidence, and (optionally) source event evidence. It
// does not claim to be a database backup or replay log.
const BUNDLE_KIND = 'gigabrain.handoff-bundle/2.0';
const SCHEMA_VERSION = '2.0';
const LEGACY_BUNDLE_KIND = 'gigabrain.memory-passport-bundle';
const LEGACY_SCHEMA_VERSION = '1.0';
const EMBEDDING_CONTRACT = 're-embed-on-import';
const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 10000;
const DEFAULT_EVENT_LIMIT_PER_MEMORY = 2000;
const VALID_MEMORY_TYPE_SET = new Set(VALID_MEMORY_TYPES);
const SECTION_ORDER = Object.freeze(['memories', 'source_links', 'events']);
const BUNDLE_KEYS = Object.freeze([
  'events', 'generated_at', 'kind', 'manifest', 'memories', 'schema_version', 'source_links',
]);
const MANIFEST_KEYS = Object.freeze([
  'complete', 'embedding_contract', 'embeddings_included', 'event_count',
  'event_limit_per_memory', 'events_included', 'excluded_state', 'memory_count',
  'root_sha256', 'scope', 'section_order', 'sections', 'source_events_replayed',
  'source_link_count', 'truncated', 'world_model_included',
]);
const EXCLUDED_STATE = Object.freeze([
  'embeddings',
  'world_model_entities_and_beliefs',
  'checkpoints_claim_proposals_and_receipts',
  'review_queue',
  'native_and_host_sync_cursors',
  'transcripts_and_wiki',
]);

const sha256 = (value = '') => crypto.createHash('sha256').update(String(value)).digest('hex');
const binaryCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// v1's historical content-hash field is kept only for read-only legacy
// inspection. valid_from was absent from that contract and must remain absent
// from this list so the inspection oracle stays byte-compatible.
const LEGACY_MEMORY_FIELDS = Object.freeze([
  'memory_id', 'type', 'content', 'normalized', 'normalized_hash',
  'source', 'source_agent', 'source_session', 'source_layer',
  'source_path', 'source_line', 'source_host', 'source_kind', 'sync_policy',
  'confidence', 'scope', 'status', 'value_score', 'value_label',
  'created_at', 'updated_at', 'archived_at', 'last_reviewed_at',
  'tags', 'superseded_by', 'content_time', 'valid_until',
]);

const MEMORY_FIELDS = Object.freeze([...LEGACY_MEMORY_FIELDS, 'valid_from']);
const SOURCE_LINK_FIELDS = Object.freeze([
  'memory_id', 'source_host', 'source_kind', 'sync_policy', 'source_path',
  'source_line', 'content_hash',
]);

const normalizeTags = (tags) => {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag));
  if (typeof tags !== 'string') return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.map((tag) => String(tag)) : [];
  } catch {
    return [];
  }
};

const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(String(value)); } catch { return fallback; }
};

const pickMemoryRecord = (row = {}) => Object.fromEntries(MEMORY_FIELDS.map((field) => [
  field,
  field === 'tags' ? normalizeTags(row.tags) : (row[field] === undefined ? null : row[field]),
]));

const pickSourceLinkRecord = (row = {}) => Object.fromEntries(SOURCE_LINK_FIELDS.map((field) => [
  field,
  field === 'source_line'
    ? (row[field] === null || row[field] === undefined || row[field] === ''
      ? null
      : (Number.isFinite(Number(row[field])) ? Number(row[field]) : null))
    : field === 'source_path'
      ? String(row[field] ?? '')
      : (row[field] === undefined ? null : row[field]),
]));

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort(binaryCompare).map((key) => [key, canonicalize(value[key])]),
  );
};

const sectionKey = (name, row = {}) => {
  if (name === 'memories') return String(row.memory_id || '');
  if (name === 'source_links') {
    return [row.memory_id, row.source_host, row.source_path, row.source_line]
      .map((value) => String(value ?? '')).join('\u0000');
  }
  return [row.memory_id, row.timestamp, row.event_id, row.action]
    .map((value) => String(value ?? '')).join('\u0000');
};

const canonicalSection = (name, records = []) => [...records]
  .map(canonicalize)
  .sort((left, right) => binaryCompare(sectionKey(name, left), sectionKey(name, right)));

const computeSectionHash = (name, records = []) => sha256(JSON.stringify({
  name,
  records: canonicalSection(name, records),
}));

const computeManifestRoot = (manifest) => {
  const { root_sha256: ignored, ...bound } = manifest;
  return sha256(JSON.stringify(canonicalize(bound)));
};

const computeContentHash = (records = []) => sha256(JSON.stringify([...records]
  .sort((left, right) => binaryCompare(String(left.memory_id || ''), String(right.memory_id || '')))
  .map((row) => Object.fromEntries(LEGACY_MEMORY_FIELDS.map((field) => [
    field,
    row[field] === undefined ? null : row[field],
  ])))));

const buildManifest = ({ eventLimitPerMemory, events, memories, scope, sourceLinks, truncated }) => {
  const order = events === null ? SECTION_ORDER.slice(0, 2) : [...SECTION_ORDER];
  const sections = Object.fromEntries(order.map((name) => {
    const records = name === 'memories' ? memories : name === 'source_links' ? sourceLinks : events;
    return [name, { count: records.length, sha256: computeSectionHash(name, records) }];
  }));
  const manifest = {
    scope: String(scope || '').trim() || null,
    complete: truncated !== true,
    truncated: truncated === true,
    events_included: events !== null,
    memory_count: memories.length,
    source_link_count: sourceLinks.length,
    event_count: events?.length || 0,
    section_order: order,
    sections,
    embeddings_included: false,
    embedding_contract: EMBEDDING_CONTRACT,
    world_model_included: false,
    source_events_replayed: 0,
    excluded_state: [...EXCLUDED_STATE],
    event_limit_per_memory: events === null ? null : eventLimitPerMemory,
  };
  manifest.root_sha256 = computeManifestRoot(manifest);
  return manifest;
};

const exportMemoryPages = (db, scope, pageSize) => {
  const records = [];
  let cursor = '';
  const whereScope = scope ? 'AND scope = ?' : '';
  const statement = db.prepare(`
    SELECT ${MEMORY_FIELDS.join(', ')}
    FROM memory_current
    WHERE memory_id > ? ${whereScope}
    ORDER BY memory_id ASC
    LIMIT ?
  `);
  while (true) {
    const rows = scope
      ? statement.all(cursor, scope, pageSize)
      : statement.all(cursor, pageSize);
    if (rows.length === 0) break;
    records.push(...rows.map(pickMemoryRecord));
    cursor = String(rows.at(-1).memory_id);
    if (rows.length < pageSize) break;
  }
  return records;
};

const exportSourceLinks = (db, memoryIds, pageSize) => {
  const records = [];
  for (let offset = 0; offset < memoryIds.length; offset += pageSize) {
    const ids = memoryIds.slice(offset, offset + pageSize);
    if (ids.length === 0) continue;
    const rows = db.prepare(`
      SELECT ${SOURCE_LINK_FIELDS.join(', ')}
      FROM memory_source_links
      WHERE status = 'active'
        AND memory_id IN (${ids.map(() => '?').join(', ')})
    `).all(...ids);
    records.push(...rows.map(pickSourceLinkRecord));
  }
  return canonicalSection('source_links', records);
};

const exportEventEvidence = (db, memoryIds, eventLimitPerMemory) => {
  const events = [];
  let truncated = false;
  const counts = [];
  for (let offset = 0; offset < memoryIds.length; offset += 500) {
    const ids = memoryIds.slice(offset, offset + 500);
    if (ids.length === 0) continue;
    counts.push(...db.prepare(`
      SELECT memory_id, COUNT(*) AS count
      FROM memory_events
      WHERE memory_id IN (${ids.map(() => '?').join(', ')})
      GROUP BY memory_id
    `).all(...ids));
  }
  for (const row of counts) {
    const memoryId = String(row.memory_id);
    if (Number(row.count) >= eventLimitPerMemory) truncated = true;
    events.push(...listTimeline(db, memoryId, { limit: eventLimitPerMemory }));
  }
  return { events: canonicalSection('events', events), truncated };
};

const exportHandoffBundle = ({
  db,
  eventLimitPerMemory = DEFAULT_EVENT_LIMIT_PER_MEMORY,
  generatedAt = null,
  includeEvents = false,
  pageSize = DEFAULT_PAGE_SIZE,
  scope = '',
} = {}) => {
  if (!db) throw new Error('exportHandoffBundle requires db');
  const resolvedPageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const resolvedEventLimit = Math.max(
    1,
    Math.min(DEFAULT_EVENT_LIMIT_PER_MEMORY, Number(eventLimitPerMemory) || DEFAULT_EVENT_LIMIT_PER_MEMORY),
  );
  const resolvedScope = String(scope || '').trim();
  ensureProjectionStore(db);
  ensureHostMemoryStore(db);
  if (includeEvents) ensureEventStore(db);

  const memories = canonicalSection('memories', exportMemoryPages(db, resolvedScope, resolvedPageSize));
  const memoryIdSet = validateMemoryRecords(memories);
  const memoryIds = [...memoryIdSet];
  const sourceLinks = exportSourceLinks(db, memoryIds, Math.min(resolvedPageSize, 500));
  validateSourceLinks(sourceLinks, new Set(memoryIds));
  assertCanonicalOrder('source_links', sourceLinks);
  const evidence = includeEvents
    ? exportEventEvidence(db, memoryIds, resolvedEventLimit)
    : { events: null, truncated: false };
  const manifest = buildManifest({
    eventLimitPerMemory: resolvedEventLimit,
    events: evidence.events,
    memories,
    scope: resolvedScope,
    sourceLinks,
    truncated: evidence.truncated,
  });

  return {
    kind: BUNDLE_KIND,
    schema_version: SCHEMA_VERSION,
    generated_at: String(generatedAt || new Date().toISOString()),
    manifest,
    memories,
    source_links: sourceLinks,
    events: evidence.events,
  };
};

const assertObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
};

const assertNonEmptyText = (value, label) => {
  if (!String(value || '').trim()) throw new Error(`${label} must be non-empty`);
};

const assertExactKeys = (value, expected, label) => {
  assertObject(value, label);
  const actual = Object.keys(value).sort(binaryCompare);
  const canonicalExpected = [...expected].sort(binaryCompare);
  if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) {
    throw new Error(`${label} has missing or unsupported keys`);
  }
};

const assertCanonicalOrder = (name, records) => {
  const keys = records.map((record) => sectionKey(name, record));
  for (let index = 1; index < keys.length; index += 1) {
    if (binaryCompare(keys[index - 1], keys[index]) >= 0) {
      throw new Error(`handoff ${name} records are not in canonical order or contain duplicate keys`);
    }
  }
};

const validateMemoryRecords = (records) => {
  const memoryIds = new Set();
  for (const [index, memory] of records.entries()) {
    const label = `handoff memories[${index}]`;
    assertExactKeys(memory, MEMORY_FIELDS, label);
    const canonicalRequiredText = (field) => {
      if (typeof memory[field] !== 'string' || !memory[field].trim() || memory[field] !== memory[field].trim()) {
        throw new Error(`${label}.${field} must be a canonical non-empty string`);
      }
    };
    const canonicalNullableText = (field) => {
      if (memory[field] === null) return;
      canonicalRequiredText(field);
    };
    const canonicalIso = (field, required = false) => {
      if (memory[field] === null && !required) return;
      if (typeof memory[field] !== 'string'
        || !Number.isFinite(Date.parse(memory[field]))
        || new Date(memory[field]).toISOString() !== memory[field]) {
        throw new Error(`${label}.${field} must be a canonical ISO timestamp${required ? '' : ' or null'}`);
      }
    };
    canonicalRequiredText('memory_id');
    canonicalRequiredText('type');
    if (!VALID_MEMORY_TYPE_SET.has(memory.type)) throw new Error(`${label}.type is not a canonical memory type`);
    canonicalRequiredText('content');
    if (memory.normalized !== normalizeContent(memory.content)
      || memory.normalized_hash !== hashNormalized(memory.normalized)) {
      throw new Error(`${label} normalized content/hash is not canonical`);
    }
    canonicalRequiredText('source');
    canonicalNullableText('source_agent');
    canonicalNullableText('source_session');
    canonicalRequiredText('source_layer');
    if (memory.source_path !== null) canonicalRequiredText('source_path');
    if (memory.source_line !== null && (!Number.isInteger(memory.source_line) || memory.source_line < 1)) {
      throw new Error(`${label}.source_line must be a positive integer or null`);
    }
    canonicalRequiredText('source_host');
    canonicalRequiredText('source_kind');
    canonicalRequiredText('sync_policy');
    if (typeof memory.confidence !== 'number' || !Number.isFinite(memory.confidence)) {
      throw new Error(`${label}.confidence must be a finite number`);
    }
    canonicalRequiredText('scope');
    if (normalizeProjectionScope(memory.scope) !== memory.scope) {
      throw new Error(`${label}.scope is not canonical`);
    }
    if (!['active', 'archived', 'pending', 'rejected', 'superseded'].includes(memory.status)) {
      throw new Error(`${label}.status is not canonical`);
    }
    if (memory.value_score !== null && (typeof memory.value_score !== 'number' || !Number.isFinite(memory.value_score))) {
      throw new Error(`${label}.value_score must be a finite number or null`);
    }
    canonicalNullableText('value_label');
    canonicalIso('created_at', true);
    canonicalIso('updated_at', true);
    canonicalIso('archived_at');
    canonicalIso('last_reviewed_at');
    if (!Array.isArray(memory.tags) || memory.tags.some((tag) => typeof tag !== 'string')) {
      throw new Error(`${label}.tags must be an array of strings`);
    }
    canonicalNullableText('superseded_by');
    if (memory.content_time !== null) {
      if (typeof memory.content_time !== 'string'
        || (!/^\d{4}-\d{2}-\d{2}$/.test(memory.content_time)
          && (!Number.isFinite(Date.parse(memory.content_time))
            || new Date(memory.content_time).toISOString() !== memory.content_time))) {
        throw new Error(`${label}.content_time must be a canonical date, timestamp, or null`);
      }
    }
    canonicalIso('valid_until');
    canonicalIso('valid_from', true);
    if (memoryIds.has(memory.memory_id)) throw new Error(`duplicate handoff memory_id: ${memory.memory_id}`);
    memoryIds.add(String(memory.memory_id));
  }
  return memoryIds;
};

const validateSourceLinks = (records, memoryIds) => {
  for (const [index, link] of records.entries()) {
    const label = `handoff source_links[${index}]`;
    assertExactKeys(link, SOURCE_LINK_FIELDS, label);
    if (typeof link.memory_id !== 'string' || !link.memory_id.trim() || link.memory_id !== link.memory_id.trim()) {
      throw new Error(`${label}.memory_id must be a canonical non-empty string`);
    }
    for (const field of ['source_host', 'source_kind', 'sync_policy']) {
      assertNonEmptyText(link[field], `handoff source_links[${index}].${field}`);
    }
    const sourceHost = String(link.source_host);
    const sourceKind = String(link.source_kind);
    const syncPolicy = String(link.sync_policy);
    if (!ALLOWED_SOURCE_HOSTS.has(sourceHost) || normalizeHost(sourceHost) !== sourceHost) {
      throw new Error(`unsupported handoff source_host: ${sourceHost}`);
    }
    if (!ALLOWED_SOURCE_KINDS.has(sourceKind) || normalizeKind(sourceKind) !== sourceKind) {
      throw new Error(`unsupported handoff source_kind: ${sourceKind}`);
    }
    if (!ALLOWED_SYNC_POLICIES.has(syncPolicy) || normalizePolicy(syncPolicy) !== syncPolicy) {
      throw new Error(`unsupported handoff sync_policy: ${syncPolicy}`);
    }
    if (!memoryIds.has(link.memory_id)) {
      throw new Error(`handoff source link references an uncarried memory: ${link.memory_id}`);
    }
    if (typeof link.source_path !== 'string') {
      throw new Error(`handoff source_links[${index}].source_path must use the canonical string representation`);
    }
    if (link.source_line !== null && (!Number.isInteger(link.source_line) || link.source_line < 1)) {
      throw new Error(`handoff source_links[${index}].source_line must be a positive integer or null`);
    }
    if (typeof link.content_hash !== 'string') {
      throw new Error(`handoff source_links[${index}].content_hash must be a string`);
    }
  }
};

const validateEvents = (records, memoryIds) => {
  for (const [index, event] of records.entries()) {
    assertObject(event, `handoff events[${index}]`);
    for (const field of ['event_id', 'memory_id', 'timestamp', 'action']) {
      assertNonEmptyText(event[field], `handoff events[${index}].${field}`);
    }
    if (!memoryIds.has(String(event.memory_id))) {
      throw new Error(`handoff event references an uncarried memory: ${event.memory_id}`);
    }
  }
};

const validateBundleShape = (bundle, { requireComplete = true } = {}) => {
  assertExactKeys(bundle, BUNDLE_KEYS, 'handoff bundle');
  if (bundle.kind !== BUNDLE_KIND || bundle.schema_version !== SCHEMA_VERSION) {
    throw new Error(`unsupported handoff bundle kind or schema version: ${bundle.kind || '(none)'} ${bundle.schema_version || '(none)'}`);
  }
  assertExactKeys(bundle.manifest, MANIFEST_KEYS, 'handoff bundle manifest');
  assertNonEmptyText(bundle.generated_at, 'handoff bundle generated_at');
  if (!Array.isArray(bundle.memories)) throw new Error('handoff bundle memories must be an array');
  if (!Array.isArray(bundle.source_links)) throw new Error('handoff bundle source_links must be an array');
  const eventsIncluded = bundle.events !== null && bundle.events !== undefined;
  if (eventsIncluded && !Array.isArray(bundle.events)) throw new Error('handoff bundle events must be an array or null');
  const expectedOrder = eventsIncluded ? [...SECTION_ORDER] : SECTION_ORDER.slice(0, 2);
  if (JSON.stringify(bundle.manifest.section_order) !== JSON.stringify(expectedOrder)) {
    throw new Error('handoff manifest section_order is not canonical');
  }
  if (bundle.manifest.events_included !== eventsIncluded) {
    throw new Error('handoff manifest events_included does not match the events section');
  }
  if (typeof bundle.manifest.complete !== 'boolean'
    || typeof bundle.manifest.truncated !== 'boolean'
    || bundle.manifest.complete === bundle.manifest.truncated) {
    throw new Error('handoff manifest completeness flags are invalid');
  }
  if (requireComplete && (bundle.manifest.complete !== true || bundle.manifest.truncated !== false)) {
    throw new Error('refusing to import an incomplete or truncated handoff bundle');
  }
  assertObject(bundle.manifest.sections, 'handoff manifest sections');
  if (JSON.stringify(Object.keys(bundle.manifest.sections).sort(binaryCompare))
    !== JSON.stringify([...expectedOrder].sort(binaryCompare))) {
    throw new Error('handoff manifest sections have missing or unsupported keys');
  }
  const eventLimit = bundle.manifest.event_limit_per_memory;
  if (eventsIncluded) {
    if (!Number.isInteger(eventLimit) || eventLimit < 1 || eventLimit > DEFAULT_EVENT_LIMIT_PER_MEMORY) {
      throw new Error('handoff manifest event_limit_per_memory is invalid');
    }
  } else if (eventLimit !== null) {
    throw new Error('handoff manifest event_limit_per_memory must be null without events');
  }
  if (bundle.manifest.embeddings_included !== false
    || bundle.manifest.embedding_contract !== EMBEDDING_CONTRACT
    || bundle.manifest.world_model_included !== false
    || bundle.manifest.source_events_replayed !== 0
    || JSON.stringify(bundle.manifest.excluded_state) !== JSON.stringify(EXCLUDED_STATE)) {
    throw new Error('handoff manifest portability contract is invalid');
  }

  const memoryIds = validateMemoryRecords(bundle.memories);
  validateSourceLinks(bundle.source_links, memoryIds);
  if (eventsIncluded) validateEvents(bundle.events, memoryIds);
  const manifestScope = bundle.manifest.scope;
  if (manifestScope !== null && (typeof manifestScope !== 'string' || !manifestScope.trim())) {
    throw new Error('handoff manifest scope must be a non-empty string or null');
  }
  if (manifestScope !== null && bundle.memories.some((memory) => memory.scope !== manifestScope)) {
    throw new Error('handoff manifest scope does not match carried memories');
  }
  if (!Number.isInteger(bundle.manifest.memory_count) || bundle.manifest.memory_count !== bundle.memories.length
    || !Number.isInteger(bundle.manifest.source_link_count) || bundle.manifest.source_link_count !== bundle.source_links.length
    || !Number.isInteger(bundle.manifest.event_count)
    || bundle.manifest.event_count !== (eventsIncluded ? bundle.events.length : 0)) {
    throw new Error('handoff manifest top-level count mismatch');
  }
  if (eventsIncluded) {
    const eventCounts = new Map();
    for (const event of bundle.events) {
      eventCounts.set(event.memory_id, Number(eventCounts.get(event.memory_id) || 0) + 1);
    }
    const observedTruncation = [...eventCounts.values()].some((count) => count >= eventLimit);
    if (observedTruncation !== bundle.manifest.truncated) {
      throw new Error('handoff manifest truncation flags do not match the per-memory event cap');
    }
  } else if (bundle.manifest.truncated) {
    throw new Error('handoff manifest cannot be truncated without event evidence');
  }
  for (const name of expectedOrder) {
    const records = bundle[name];
    assertCanonicalOrder(name, records);
    const section = bundle.manifest.sections[name];
    assertExactKeys(section, ['count', 'sha256'], `handoff manifest sections.${name}`);
    if (!Number.isInteger(section.count) || section.count !== records.length) {
      throw new Error(`handoff manifest count mismatch for ${name}`);
    }
    const recomputed = computeSectionHash(name, records);
    if (String(section.sha256 || '') !== recomputed) {
      throw new Error(`handoff integrity check failed for ${name}`);
    }
  }
  const root = computeManifestRoot(bundle.manifest);
  if (String(bundle.manifest.root_sha256 || '') !== root) {
    throw new Error('handoff manifest root integrity check failed');
  }
  return { eventsIncluded, memoryIds, root };
};

const sourceLinkExists = (db, link) => {
  const row = db.prepare(`
    SELECT source_kind, sync_policy, content_hash, status
    FROM memory_source_links
    WHERE memory_id = ? AND source_host = ? AND source_path = ?
      AND ((source_line IS NULL AND ? IS NULL) OR source_line = ?)
    LIMIT 1
  `).get(
    String(link.memory_id),
    String(link.source_host),
    String(link.source_path),
    link.source_line === null || link.source_line === undefined ? null : Number(link.source_line),
    link.source_line === null || link.source_line === undefined ? null : Number(link.source_line),
  );
  return Boolean(row
    && String(row.source_kind) === String(link.source_kind)
    && String(row.sync_policy) === String(link.sync_policy)
    && String(row.content_hash) === link.content_hash
    && String(row.status) === 'active');
};

const importHandoffBundle = ({
  bundle,
  db,
  faultInjector,
  operationId = '',
  runId = '',
  skipIntegrityCheck = false,
} = {}) => {
  if (!db) throw new Error('importHandoffBundle requires db');
  if (skipIntegrityCheck) throw new Error('handoff integrity checks cannot be bypassed');
  const validated = validateBundleShape(bundle, { requireComplete: true });

  // All shape/version/completeness/integrity checks above run before these
  // schema initializers, preserving the zero-write failure contract.
  ensureProjectionStore(db);
  ensureHostMemoryStore(db);
  ensureEventStore(db);
  const resolvedOperationId = String(
    operationId || runId || `handoff-import-${validated.root.slice(0, 24)}`,
  );
  const result = {
    ok: true,
    integrity_ok: true,
    integrity_skipped: false,
    imported_memories: 0,
    imported_source_links: 0,
    import_events_written: 0,
    imported_events: 0,
    source_events_replayed: 0,
    root_sha256: validated.root,
    world_model_rebuild_required: true,
  };

  const boundary = withProjectionMutationBatch({ db, operationId: resolvedOperationId }, (tx) => {
    for (const memory of bundle.memories) {
      upsertCurrentMemory(db, memory, {
        event: {
          action: 'handoff_import',
          component: 'handoff_import',
          payload: {
            generated_at: bundle.generated_at || null,
            root_sha256: validated.root,
            schema_version: SCHEMA_VERSION,
            source_events_replayed: 0,
          },
          reason_codes: ['handoff_v2_import'],
          run_id: resolvedOperationId,
        },
        faultInjector,
        operationId: resolvedOperationId,
        tx,
      });
      if (tx.lastMutationEvent) result.imported_memories += 1;
    }
    for (const link of bundle.source_links) {
      if (sourceLinkExists(db, link)) continue;
      linkMemorySource(db, {
        memory_id: link.memory_id,
        source_host: link.source_host,
        source_kind: link.source_kind,
        source_path: link.source_path,
        source_line: link.source_line,
        sync_policy: link.sync_policy,
        content_hash: link.content_hash,
      });
      if (typeof faultInjector === 'function') faultInjector('after_source_link');
      result.imported_source_links += 1;
    }
  });
  result.import_events_written = Number(boundary.receipt.events || 0);
  result.imported_events = result.import_events_written;
  return result;
};

const inspectLegacyV1Bundle = (bundle) => {
  assertObject(bundle, 'legacy v1 bundle');
  if (bundle.kind !== LEGACY_BUNDLE_KIND || bundle.schema_version !== LEGACY_SCHEMA_VERSION) {
    throw new Error('legacy v1 inspection requires gigabrain.memory-passport-bundle schema 1.0');
  }
  assertObject(bundle.manifest, 'legacy v1 manifest');
  if (!Array.isArray(bundle.memories)) throw new Error('legacy v1 memories must be an array');
  if (!Array.isArray(bundle.source_links)) throw new Error('legacy v1 source_links must be an array');
  if (bundle.events !== null && bundle.events !== undefined && !Array.isArray(bundle.events)) {
    throw new Error('legacy v1 events must be an array or null');
  }
  const eventsIncluded = bundle.events !== null && bundle.events !== undefined;
  const events = Array.isArray(bundle.events) ? bundle.events : [];
  if (bundle.manifest.events_included !== eventsIncluded) {
    throw new Error('legacy v1 manifest events_included mismatch');
  }
  if (Number(bundle.manifest.memory_count) !== bundle.memories.length
    || Number(bundle.manifest.source_link_count) !== bundle.source_links.length
    || Number(bundle.manifest.event_count) !== events.length) {
    throw new Error('legacy v1 manifest count mismatch');
  }
  const eventCounts = new Map();
  for (const event of events) {
    const memoryId = String(event?.memory_id || '');
    eventCounts.set(memoryId, Number(eventCounts.get(memoryId) || 0) + 1);
  }
  if ([...eventCounts.values()].some((count) => count >= DEFAULT_EVENT_LIMIT_PER_MEMORY)) {
    throw new Error('legacy v1 event evidence reaches the historical cap and may be truncated');
  }
  const recomputed = computeContentHash(bundle.memories);
  if (String(bundle.manifest.content_hash || '') !== recomputed) {
    throw new Error('legacy v1 manifest content_hash integrity check failed');
  }
  return {
    ok: true,
    kind: bundle.kind,
    schema_version: bundle.schema_version,
    inspect_only: true,
    importable: false,
    missing_valid_from: bundle.memories.some((memory) => !String(memory?.valid_from || '').trim()),
    memory_count: bundle.memories.length,
    source_link_count: bundle.source_links.length,
    event_count: events.length,
    source_events_replayed: 0,
    content_hash: recomputed,
    excluded_state: [...EXCLUDED_STATE],
    migration: 'Use physical database migration; legacy v1 bundles are inspection-only.',
  };
};

const exportPassportBundle = (options = {}) => exportHandoffBundle(options);
const importPassportBundle = (options = {}) => importHandoffBundle(options);

export {
  BUNDLE_KIND,
  SCHEMA_VERSION,
  EMBEDDING_CONTRACT,
  computeContentHash,
  exportHandoffBundle,
  exportPassportBundle,
  importHandoffBundle,
  importPassportBundle,
  inspectLegacyV1Bundle,
  validateBundleShape,
};

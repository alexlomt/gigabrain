const VALID_MEMORY_TYPES = Object.freeze([
  'AGENT_IDENTITY',
  'CONTEXT',
  'DECISION',
  'ENTITY',
  'EPISODE',
  'PREFERENCE',
  'USER_FACT',
]);

const VALID_MEMORY_TYPE_SET = new Set(VALID_MEMORY_TYPES);
const SCOPE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NATIVE_ORIGIN_KINDS = Object.freeze([
  'human_native',
  'structured_checkpoint',
  'legacy_checkpoint',
  'legacy_unclassified',
]);
const EXACT_METADATA_RE = /\s*<!-- gigabrain:scope=([^\s<>]+) type=([A-Z][A-Z0-9_]*) -->\s*$/;
const STRUCTURED_CHECKPOINT_RE = /<!-- gigabrain:origin=structured_checkpoint -->/;
const LEGACY_CHECKPOINT_RE = /<!-- gigabrain:origin=legacy_checkpoint -->/;
const ANY_GIGABRAIN_COMMENT_RE = /\s*<!--\s*gigabrain:[\s\S]*?-->\s*/g;
const LEGACY_CHECKPOINT_SECTION_RE = /(?:^| > )(?:Codex App|Claude|OpenClaw|Agent) Sessions$/i;

const metadataError = (detail) => {
  const error = new Error(`GIGABRAIN_NATIVE_METADATA_INVALID: ${detail}`);
  error.code = 'GIGABRAIN_NATIVE_METADATA_INVALID';
  return error;
};

const normalizeMemoryType = (value = '') => {
  const type = String(value || '').trim().toUpperCase();
  return VALID_MEMORY_TYPE_SET.has(type) ? type : '';
};

const normalizeOriginKind = (value = '') => {
  const origin = String(value || '').trim().toLowerCase();
  return NATIVE_ORIGIN_KINDS.includes(origin) ? origin : 'legacy_unclassified';
};

const normalizeNativeScope = (value = '') => {
  const scope = String(value || '').trim();
  if (!scope || scope.length > 256) return '';
  const segments = scope.split(':');
  return segments.every((segment) => SCOPE_SEGMENT_RE.test(segment)) ? scope : '';
};

const parseNativeMetadata = (line = '') => {
  const raw = String(line || '');
  const match = raw.match(EXACT_METADATA_RE);
  const scope = normalizeNativeScope(match?.[1] || '');
  const type = normalizeMemoryType(match?.[2] || '');
  let originKind = 'legacy_unclassified';
  if (STRUCTURED_CHECKPOINT_RE.test(raw)) originKind = 'structured_checkpoint';
  else if (LEGACY_CHECKPOINT_RE.test(raw)) originKind = 'legacy_checkpoint';
  else if (scope && type) originKind = 'human_native';
  return { scope: scope && type ? scope : '', type: scope && type ? type : '', originKind };
};

const renderNativeMetadata = ({ scope = '', type = '' } = {}) => {
  const normalizedScope = normalizeNativeScope(scope);
  const normalizedType = normalizeMemoryType(type);
  if (!normalizedScope) throw metadataError('scope');
  if (!normalizedType) throw metadataError('type');
  return `<!-- gigabrain:scope=${normalizedScope} type=${normalizedType} -->`;
};

const renderNativeOriginMarker = (originKind = '') => {
  const normalized = normalizeOriginKind(originKind);
  if (!['structured_checkpoint', 'legacy_checkpoint'].includes(normalized)) {
    throw metadataError('origin');
  }
  return `<!-- gigabrain:origin=${normalized} -->`;
};

const stripNativeMetadata = (line = '') => String(line || '')
  .replace(ANY_GIGABRAIN_COMMENT_RE, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const classifyNativeOrigin = ({ line = '', sourceKind = '', section = '' } = {}) => {
  const parsed = parseNativeMetadata(line);
  if (parsed.originKind !== 'legacy_unclassified') return parsed.originKind;
  if (LEGACY_CHECKPOINT_SECTION_RE.test(String(section || '').trim())) return 'legacy_checkpoint';
  if (['memory_md', 'curated'].includes(String(sourceKind || '').trim())) return 'human_native';
  return 'legacy_unclassified';
};

const appendGigabrainMetadata = (content = '', meta = {}) => (
  `${stripNativeMetadata(content)} ${renderNativeMetadata(meta)}`.trim()
);

const parseGigabrainMetadata = (line = '') => {
  const parsed = parseNativeMetadata(line);
  return {
    content: stripNativeMetadata(line).replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''),
    scope: parsed.scope,
    type: parsed.type,
    originKind: parsed.originKind,
  };
};

export {
  NATIVE_ORIGIN_KINDS,
  VALID_MEMORY_TYPES,
  appendGigabrainMetadata,
  classifyNativeOrigin,
  normalizeMemoryType,
  normalizeOriginKind,
  parseGigabrainMetadata,
  parseNativeMetadata,
  renderNativeMetadata,
  renderNativeOriginMarker,
  stripNativeMetadata,
};

const GIGABRAIN_META_COMMENT_RE = /\s*<!--\s*gigabrain:([\s\S]*?)\s*-->\s*$/i;
const GIGABRAIN_META_ATTR_RE = /([a-zA-Z_][\w-]*)=([^\s>]+)/g;

const normalizeMemoryType = (value = '') => {
  const key = String(value || '').trim().toUpperCase();
  if (!key) return '';
  if (key === 'FACT' || key === 'USERFACT') return 'USER_FACT';
  if (['USER_FACT', 'PREFERENCE', 'DECISION', 'ENTITY', 'EPISODE', 'AGENT_IDENTITY', 'CONTEXT'].includes(key)) return key;
  return '';
};

const parseGigabrainMetadata = (value = '') => {
  const raw = String(value || '');
  const match = raw.match(GIGABRAIN_META_COMMENT_RE);
  if (!match) {
    return {
      text: raw.trim(),
      scope: '',
      type: '',
      attrs: {},
    };
  }

  const attrs = {};
  const commentBody = String(match[1] || '');
  let attrMatch = GIGABRAIN_META_ATTR_RE.exec(commentBody);
  while (attrMatch) {
    const key = String(attrMatch[1] || '').trim().toLowerCase();
    const attrValue = String(attrMatch[2] || '').trim();
    if (key) attrs[key] = attrValue;
    attrMatch = GIGABRAIN_META_ATTR_RE.exec(commentBody);
  }
  GIGABRAIN_META_ATTR_RE.lastIndex = 0;

  return {
    text: raw.replace(GIGABRAIN_META_COMMENT_RE, '').trim(),
    scope: String(attrs.scope || '').trim(),
    type: normalizeMemoryType(attrs.type || attrs.memory_type || ''),
    attrs,
  };
};

const appendGigabrainMetadata = (value = '', { scope = '', type = '' } = {}) => {
  const text = String(value || '').trim();
  const normalizedScope = String(scope || '').trim();
  const normalizedType = normalizeMemoryType(type);
  const attrs = [];
  if (normalizedScope) attrs.push(`scope=${normalizedScope}`);
  if (normalizedType) attrs.push(`type=${normalizedType}`);
  if (attrs.length === 0) return text;
  return `${text} <!-- gigabrain:${attrs.join(' ')} -->`;
};

export {
  appendGigabrainMetadata,
  normalizeMemoryType,
  parseGigabrainMetadata,
};

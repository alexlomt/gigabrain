const MAIN_SCOPE = 'profile:main';
const SHARED_SCOPE = 'shared';

const NAMED_AGENT_SCOPES = Object.freeze([
  'paperclip-ceo',
  'scrapling-research-operator',
  'higgsfield-creator',
  'linkedin-public-evidence-operator',
]);
const SHARED_OVERLAY_SCOPES = new Set([MAIN_SCOPE, ...NAMED_AGENT_SCOPES]);

const cleanScope = (value) => String(value ?? '').trim();

const normalizeAgentScope = (value) => {
  const scope = cleanScope(value);
  if (!scope || scope === SHARED_SCOPE) return SHARED_SCOPE;
  if (scope === 'main' || scope === 'profile:user') return MAIN_SCOPE;
  return scope;
};

const uniqueScopes = (values) => {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const scope = normalizeAgentScope(value);
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  return out;
};

const resolveRemoteScopes = ({ requestedScope, remote }) => {
  const requestedValues = (Array.isArray(requestedScope) ? requestedScope : [requestedScope])
    .filter((value) => cleanScope(value));
  if (requestedValues.length === 0) return [];
  const requested = uniqueScopes(requestedValues);
  if (!Array.isArray(remote)) return requested;
  const allowed = new Set(uniqueScopes(remote));
  return requested.filter((scope) => allowed.has(scope));
};

const resolveVisibleScopes = ({ requestedScope = '', remote = false, includeShared = true } = {}) => {
  if (remote) return resolveRemoteScopes({ requestedScope, remote });
  const scope = normalizeAgentScope(Array.isArray(requestedScope) ? requestedScope[0] : requestedScope);
  if (scope === SHARED_SCOPE) return [SHARED_SCOPE];
  if (scope.startsWith('project:')) return [scope];
  if (includeShared === false) return [scope];
  if (SHARED_OVERLAY_SCOPES.has(scope)) return [scope, SHARED_SCOPE];
  return [scope];
};

const isAutomaticDedupeScopeMatch = (left, right) => (
  normalizeAgentScope(left) === normalizeAgentScope(right)
);

const deriveScopeFromWorkspaceDir = (workspaceDir = '') => {
  const value = String(workspaceDir || '').trim();
  if (!value) return '';
  const absolute = path.resolve(value);
  const slug = String(path.basename(absolute) || 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';
  const hash = createHash('sha1').update(absolute).digest('hex').slice(0, 8);
  return `project:${slug}:${hash}`;
};

export {
  MAIN_SCOPE,
  NAMED_AGENT_SCOPES,
  SHARED_SCOPE,
  deriveScopeFromWorkspaceDir,
  isAutomaticDedupeScopeMatch,
  normalizeAgentScope,
  resolveVisibleScopes,
};
import { createHash } from 'node:crypto';
import path from 'node:path';

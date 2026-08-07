import assert from 'node:assert/strict';

import {
  GIGABRAIN_HTTP_ROUTES,
  checkRateLimit,
  rateLimitKeyForRequest,
  requireToken,
  resolveRankSource,
} from '../lib/core/http-routes.js';

const routeRegistryCovers = (path) => GIGABRAIN_HTTP_ROUTES.some((route) => (
  route.match === 'prefix' ? path.startsWith(route.path) : path === route.path
));

const run = async () => {
  const baseEndpoint = `rate-limit-${Date.now()}`;
  for (let i = 0; i < 70; i += 1) {
    const allowed = checkRateLimit(`${baseEndpoint}-many-${i}`, 1);
    assert.equal(allowed, true, 'new endpoints should be admitted up to the cap');
  }
  assert.equal(checkRateLimit(`${baseEndpoint}-single`, 1), true, 'first request should pass');
  assert.equal(checkRateLimit(`${baseEndpoint}-single`, 1), false, 'second request in the same minute should be rate limited');
  assert.notEqual(
    rateLimitKeyForRequest({ socket: { remoteAddress: '192.0.2.10' } }, '/gb/recall'),
    rateLimitKeyForRequest({ socket: { remoteAddress: '192.0.2.11' } }, '/gb/recall'),
    'independent clients must not share one global endpoint bucket',
  );
  assert.equal(resolveRankSource({ _source: 'active' }), 'lexical');
  assert.equal(resolveRankSource({ _lex_rank: 0, _dense_rank: null }), 'lexical');
  assert.equal(resolveRankSource({ _source: 'dense', _lex_rank: null, _dense_rank: 0 }), 'vector');
  assert.equal(resolveRankSource({ _lex_rank: 0, _dense_rank: 1 }), 'hybrid');

  const expectedToken = 'abcd';
  assert.equal(
    requireToken({ headers: { 'x-gb-token': expectedToken } }, expectedToken),
    true,
    'matching UTF-8 token bytes authenticate',
  );
  assert.doesNotThrow(
    () => requireToken({ headers: { 'x-gb-token': 'éééé' } }, expectedToken),
    'equal UTF-16 lengths with different UTF-8 byte lengths must not reach timingSafeEqual',
  );
  assert.equal(
    requireToken({ headers: { 'x-gb-token': 'éééé' } }, expectedToken),
    false,
    'non-ASCII byte-length mismatch is rejected instead of throwing',
  );

  const handledPaths = [
    '/gb',
    '/gb/health',
    '/gb/bench/recall',
    '/gb/control/apply',
    '/gb/entities',
    '/gb/entities/example-entity',
    '/gb/beliefs',
    '/gb/episodes',
    '/gb/open-loops',
    '/gb/contradictions',
    '/gb/adjudications',
    '/gb/beliefs-as-of',
    '/gb/review-queue',
    '/gb/relationships',
    '/gb/evolution',
    '/gb/memory/example-memory/timeline',
    '/gb/recall',
    '/gb/recall/explain',
    '/gb/suggestions',
  ];
  for (const path of handledPaths) {
    assert.equal(routeRegistryCovers(path), true, `${path} must be registered with the host gateway`);
  }
};

export { run };

import assert from 'node:assert/strict';

import { GIGABRAIN_HTTP_ROUTES, checkRateLimit } from '../lib/core/http-routes.js';

const run = async () => {
  const registeredRoutes = new Set(GIGABRAIN_HTTP_ROUTES.map((route) => `${route.match}:${route.path}`));
  assert.equal(
    registeredRoutes.has('prefix:/gb/memory/'),
    true,
    'dynamic /gb/memory/* routes must be registered so timeline endpoints are reachable through OpenClaw route manifests',
  );

  const baseEndpoint = `rate-limit-${Date.now()}`;
  for (let i = 0; i < 70; i += 1) {
    const allowed = checkRateLimit(`${baseEndpoint}-many-${i}`, 1);
    assert.equal(allowed, true, 'new endpoints should be admitted up to the cap');
  }
  assert.equal(checkRateLimit(`${baseEndpoint}-single`, 1), true, 'first request should pass');
  assert.equal(checkRateLimit(`${baseEndpoint}-single`, 1), false, 'second request in the same minute should be rate limited');
};

export { run };

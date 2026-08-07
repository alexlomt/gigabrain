#!/usr/bin/env node
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/core/config.js';
import { resolvePolicy } from '../lib/core/policy.js';
import { GIGABRAIN_HTTP_ROUTES } from '../lib/core/http-routes.js';

const config = normalizeConfig({});
const policy = resolvePolicy({});

assert.ok(config && typeof config === 'object', 'default config must normalize');
assert.ok(policy && typeof policy === 'object', 'default policy must resolve');
assert.ok(Array.isArray(GIGABRAIN_HTTP_ROUTES) && GIGABRAIN_HTTP_ROUTES.length > 0,
  'HTTP route registry must load');

console.log(JSON.stringify({ ok: true, smoke: 'installed-package-runtime' }));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MIN_NODE_VERSION,
  ensureSupportedNodeRuntime,
  parseNodeVersion,
} from '../lib/core/runtime-guard.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const run = async () => {
  const parsed = parseNodeVersion('v22.3.4');
  assert.equal(parsed.major, 22, 'parser should extract the major version');
  assert.equal(parsed.ok, false, 'parser should reject Node versions without default TypeScript stripping');
  assert.equal(parseNodeVersion('v22.18.0').ok, true, 'parser should accept the minimum supported version');
  assert.equal(parseNodeVersion('v24.0.0').ok, true, 'parser should accept newer supported majors');
  assert.equal(parseNodeVersion('v21.9.0').ok, false, 'parser should reject unsupported versions');

  assert.doesNotThrow(() => {
    ensureSupportedNodeRuntime({
      component: 'Gigabrain test',
      version: `v${MIN_NODE_VERSION}`,
    });
  }, 'supported versions should pass the runtime guard');

  assert.throws(() => {
    ensureSupportedNodeRuntime({
      component: 'Gigabrain test',
      binary: '/tmp/node21',
      version: 'v21.9.0',
    });
  }, /requires Node\.js >= 22\.18\.0/i, 'unsupported versions should produce a friendly runtime error');

  const root = fs.mkdtempSync(path.join(process.env.GIGABRAIN_TEST_TMPDIR || os.tmpdir(), 'gb-runtime-guard-'));
  const dbPath = path.join(root, 'registry.sqlite');
  const versionShim = path.join(root, 'unsupported-node-version.mjs');
  fs.writeFileSync(
    versionShim,
    "Object.defineProperty(process, 'version', { value: 'v21.8.0' });\n",
  );
  const guardedCli = spawnSync(process.execPath, [
    '--import',
    versionShim,
    path.join('scripts', 'gigabrainctl.js'),
    'inventory',
    '--db',
    dbPath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(guardedCli.status, 0, 'CLI should fail under a mocked unsupported Node version');
  assert.match(
    `${guardedCli.stderr || ''}${guardedCli.stdout || ''}`,
    /requires Node\.js >= 22\.18\.0/i,
    'CLI should surface the friendly runtime guard message instead of a raw node:sqlite import failure',
  );
};

export { run };

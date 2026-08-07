import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  atomicWriteFileSync,
  createFileExclusiveSync,
  readFileIfExistsSync,
  readRegularFileNoFollowSync,
} from '../lib/core/safe-fs.js';
import {
  buildHttpEndpoint,
  isLoopbackHostname,
  trimTrailingSlashes,
} from '../lib/core/url-safety.js';

const run = async () => {
  const root = fs.mkdtempSync(path.join(process.env.GIGABRAIN_TEST_TMPDIR || os.tmpdir(), 'gb-safe-boundaries-'));
  try {
    const target = path.join(root, 'state', 'config.json');
    assert.equal(createFileExclusiveSync(target, 'first\n', { mode: 0o600 }), true);
    assert.equal(createFileExclusiveSync(target, 'clobber\n', { mode: 0o600 }), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'first\n', 'exclusive create must never clobber an existing file');

    atomicWriteFileSync(target, 'second\n', { mode: 0o600 });
    assert.equal(fs.readFileSync(target, 'utf8'), 'second\n', 'atomic replacement should publish the complete new payload');
    assert.equal(readRegularFileNoFollowSync(target, 'utf8'), 'second\n');

    const symlink = path.join(root, 'state', 'config-link.json');
    fs.symlinkSync(target, symlink);
    assert.throws(
      () => readRegularFileNoFollowSync(symlink, 'utf8'),
      (error) => error?.code === 'ELOOP',
      'security-sensitive reads must refuse a symlink final component',
    );
    assert.throws(
      () => readFileIfExistsSync(symlink, 'utf8'),
      (error) => error?.code === 'ELOOP',
      'optional reads must not turn a symlink into an implicit trust bypass',
    );

    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'outside stays intact\n', 'utf8');
    const replaceLink = path.join(root, 'state', 'replace-link.txt');
    fs.symlinkSync(outside, replaceLink);
    atomicWriteFileSync(replaceLink, 'safe replacement\n', { mode: 0o600 });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside stays intact\n');
    assert.equal(fs.lstatSync(replaceLink).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(replaceLink, 'utf8'), 'safe replacement\n');

    const nonCanonicalLoopback = ['127', '12', '34', '56'].join('.');
    assert.equal(isLoopbackHostname(nonCanonicalLoopback), true);
    assert.equal(isLoopbackHostname('[::1]'), true);
    assert.equal(isLoopbackHostname('example.com'), false);
    assert.equal(trimTrailingSlashes(`https://example.com${'/'.repeat(10_000)}`), 'https://example.com');
    assert.equal(
      buildHttpEndpoint('https://example.com/api/', '/chat/completions').toString(),
      'https://example.com/api/chat/completions',
    );
    assert.equal(
      buildHttpEndpoint('http://127.0.0.1:11434', '/api/generate', { localOnly: true }).toString(),
      'http://127.0.0.1:11434/api/generate',
    );
    assert.throws(
      () => buildHttpEndpoint('http://example.com', '/api', { label: 'test endpoint' }),
      /must use https unless it targets loopback/,
    );
    assert.throws(
      () => buildHttpEndpoint('https://example.com', '/api', { localOnly: true, label: 'test endpoint' }),
      /must use a loopback host/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('safe filesystem and URL boundaries: all assertions passed');
};

export { run };

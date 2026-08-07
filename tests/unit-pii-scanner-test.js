import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runScanner = (root) => spawnSync(
  process.execPath,
  ['scripts/check-no-pii.mjs'],
  { cwd: root, encoding: 'utf8' },
);

const outputOf = (result) => `${result.stdout}\n${result.stderr}`;

const run = async () => {
  const tempBase = path.resolve(process.env.GIGABRAIN_TEST_TMPDIR || os.tmpdir());
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'gigabrain-pii-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    for (const script of ['check-no-pii.mjs', 'privacy-policy.mjs']) {
      fs.copyFileSync(path.join(repoRoot, 'scripts', script), path.join(root, 'scripts', script));
    }

    // Inject only synthetic protected identifiers through the same source-only
    // module used by the private release workspace. The public policy stays
    // hash-free and no personal identifier enters the test.
    const syntheticProtectedIdentifier = 'crosslinetest';
    const syntheticProtectedHash = createHash('sha256')
      .update(syntheticProtectedIdentifier)
      .digest('hex');
    const syntheticProtectedToken = 'fixtureperson';
    const syntheticProtectedTokenHash = createHash('sha256')
      .update(syntheticProtectedToken)
      .digest('hex');
    fs.writeFileSync(
      path.join(root, 'scripts', 'private-scan-fixtures.mjs'),
      [
        'export const SOURCE_ONLY_SECRET_FIXTURES = Object.freeze([]);',
        `export const SOURCE_ONLY_BANNED_IDENTIFIER_HASHES = Object.freeze(['${syntheticProtectedHash}']);`,
        `export const SOURCE_ONLY_BANNED_TOKEN_HASHES = Object.freeze(['${syntheticProtectedTokenHash}']);`,
        'export const SOURCE_ONLY_REVIEWED_BINARY_SHA256 = Object.freeze([]);',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'gigabrain-pii-fixture',
      version: '1.0.0',
      private: true,
      files: ['docs/', 'scripts/'],
    }), 'utf8');
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);

    // Untracked npm content beyond the old 512 KiB boundary must still be read.
    // Split the fake signature so this test source remains scanner-safe.
    const fakeCredential = 'AK' + 'IA1234567890ABCDEF';
    fs.writeFileSync(
      path.join(root, 'docs', 'large-untracked.md'),
      `${'safe filler '.repeat(48_000)}\n${fakeCredential}\n`,
      'utf8',
    );
    const largeResult = runScanner(root);
    assert.notEqual(largeResult.status, 0, 'large untracked package text must be scanned');
    assert.match(outputOf(largeResult), /docs\/large-untracked\.md:\d+\s+secret-like-credential/);
    assert.equal(outputOf(largeResult).includes(fakeCredential.slice(0, 8)), false,
      'failure output must never echo a credential prefix');
    fs.rmSync(path.join(root, 'docs', 'large-untracked.md'));

    const markerCredential = 'sk-' + 'example' + 'A'.repeat(20);
    fs.writeFileSync(
      path.join(root, 'docs', 'marker-bypass.md'),
      `synthetic-looking marker inside a real-shaped credential: ${markerCredential}\n`,
      'utf8',
    );
    const markerResult = runScanner(root);
    assert.notEqual(markerResult.status, 0, 'marker substrings may not bypass signatures');
    assert.match(outputOf(markerResult), /docs\/marker-bypass\.md:1\s+secret-like-credential/);
    fs.rmSync(path.join(root, 'docs', 'marker-bypass.md'));

    fs.writeFileSync(
      path.join(root, 'docs', 'large-cross-line.md'),
      `${'safe filler '.repeat(48_000)}\ncrossline\ntest\n`,
      'utf8',
    );
    const crossLineResult = runScanner(root);
    assert.notEqual(crossLineResult.status, 0,
      'large-file protected identifiers split across lines must be scanned');
    assert.match(outputOf(crossLineResult), /docs\/large-cross-line\.md\s+banned-identifier/);
    fs.rmSync(path.join(root, 'docs', 'large-cross-line.md'));

    fs.writeFileSync(path.join(root, 'docs', 'protected-token.md'), `${syntheticProtectedToken}\n`, 'utf8');
    const protectedTokenResult = runScanner(root);
    assert.notEqual(protectedTokenResult.status, 0, 'exact protected name tokens must be scanned');
    assert.match(outputOf(protectedTokenResult), /docs\/protected-token\.md\s+banned-identifier/);
    assert.equal(outputOf(protectedTokenResult).includes(syntheticProtectedToken), false,
      'failure output must redact protected name tokens');
    fs.rmSync(path.join(root, 'docs', 'protected-token.md'));

    const personalEmail = ['someone', 'personal.invalid'].join('@');
    const personalPhone = ['+43', '660', '123', '4567'].join(' ');
    fs.writeFileSync(
      path.join(root, 'docs', 'contact.md'),
      `Maintainer: ${personalEmail}\nphone: ${personalPhone}\n`,
      'utf8',
    );
    const contactResult = runScanner(root);
    assert.notEqual(contactResult.status, 0, 'personal contact data must fail the scan');
    assert.match(outputOf(contactResult), /docs\/contact\.md:1\s+personal-email/);
    assert.match(outputOf(contactResult), /docs\/contact\.md:2\s+phone-number/);
    assert.equal(outputOf(contactResult).includes(personalEmail), false,
      'failure output must redact personal email values');
    assert.equal(outputOf(contactResult).includes(personalPhone), false,
      'failure output must redact phone values');
    fs.rmSync(path.join(root, 'docs', 'contact.md'));

    fs.mkdirSync(path.join(root, 'output', 'benchmarks'), { recursive: true });
    const trackedBenchmark = path.join(root, 'output', 'benchmarks', 'tracked.jsonl');
    fs.writeFileSync(
      trackedBenchmark,
      `${'safe commitment 0123456789abcdef '.repeat(20_000)}\n${fakeCredential}\n`,
      'utf8',
    );
    assert.equal(spawnSync('git', ['add', 'output/benchmarks/tracked.jsonl'], { cwd: root }).status, 0);
    const benchmarkResult = runScanner(root);
    assert.notEqual(benchmarkResult.status, 0, 'tracked benchmark evidence must be scanned');
    assert.match(outputOf(benchmarkResult), /output\/benchmarks\/tracked\.jsonl:\d+\s+secret-like-credential/);
    assert.equal(spawnSync('git', ['rm', '--cached', '--quiet', 'output/benchmarks/tracked.jsonl'], { cwd: root }).status, 0);
    fs.rmSync(trackedBenchmark);

    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {}, credential: fakeCredential }),
      'utf8',
    );
    const lockfileResult = runScanner(root);
    assert.notEqual(lockfileResult.status, 0, 'dependency lockfiles must be scanned');
    assert.match(outputOf(lockfileResult), /package-lock\.json:1\s+secret-like-credential/);
    fs.rmSync(path.join(root, 'package-lock.json'));

    for (const suffix of ['lock', 'map', 'bundle']) {
      const candidate = path.join(root, 'docs', `publishable.${suffix}`);
      fs.writeFileSync(candidate, `embedded credential: ${fakeCredential}\n`, 'utf8');
      const packagedTextResult = runScanner(root);
      assert.notEqual(packagedTextResult.status, 0, `packageable .${suffix} text must be scanned`);
      assert.match(
        outputOf(packagedTextResult),
        new RegExp(`docs/publishable\\.${suffix}:1\\s+secret-like-credential`),
      );
      fs.rmSync(candidate);
    }

    const binaryFixtures = [
      ['publishable.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])],
      ['publishable.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
      ['publishable.pdf', Buffer.from('%PDF-1.4\n', 'ascii')],
    ];
    for (const [name, prefix] of binaryFixtures) {
      const candidate = path.join(root, 'docs', name);
      fs.writeFileSync(candidate, Buffer.concat([prefix, Buffer.from(`embedded: ${fakeCredential}\n`)]));
      const binaryResult = runScanner(root);
      assert.notEqual(binaryResult.status, 0, `${name} must fail closed without a reviewed digest`);
      assert.match(outputOf(binaryResult), new RegExp(`docs/${name.replace('.', '\\.')}\\s+unreviewed-binary-file`));
      fs.rmSync(candidate);
    }

    fs.writeFileSync(path.join(root, '.gitignore'), 'docs/ignored.key\n', 'utf8');
    fs.writeFileSync(path.join(root, 'docs', 'ignored.key'), `${fakeCredential}\n`, 'utf8');
    const ignoredPackResult = runScanner(root);
    assert.notEqual(ignoredPackResult.status, 0,
      'gitignored but npm-packaged content must still be scanned');
    assert.match(outputOf(ignoredPackResult), /docs\/ignored\.key:1\s+secret-like-credential/);
    fs.rmSync(path.join(root, 'docs', 'ignored.key'));

    // An exact public-release inventory automatically enables the stricter
    // absolute-home-path and non-documentation IPv4 checks.
    const publicFiles = [
      '.gitignore',
      'docs/public-surface.md',
      'package.json',
      'public-release-manifest.json',
      'scripts/check-no-pii.mjs',
      'scripts/privacy-policy.mjs',
    ];
    const syntheticHomePath = `/${['Users', 'synthetic-owner', 'private-project'].join('/')}/`;
    const syntheticPublicIpv4 = ['11', '22', '33', '44'].join('.');
    const syntheticPrivateIpv4 = ['192', '168', '44', '19'].join('.');
    const syntheticMulticastIpv4 = ['224', '9', '8', '7'].join('.');
    const syntheticLoopbackRangeIpv4 = ['127', '9', '8', '7'].join('.');
    const syntheticUnspecifiedRangeIpv4 = ['0', '9', '8', '7'].join('.');
    const syntheticDeviceId = ['0x', '03c5314d'].join('');
    fs.writeFileSync(
      path.join(root, 'docs', 'public-surface.md'),
      [
        `private path: ${syntheticHomePath}`,
        `public address: ${syntheticPublicIpv4}`,
        `private address: ${syntheticPrivateIpv4}`,
        `multicast address: ${syntheticMulticastIpv4}`,
        `noncanonical loopback address: ${syntheticLoopbackRangeIpv4}`,
        `noncanonical unspecified address: ${syntheticUnspecifiedRangeIpv4}`,
        `device ID: ${syntheticDeviceId}`,
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'public-release-manifest.json'),
      JSON.stringify({ repository: { files: publicFiles } }),
      'utf8',
    );
    assert.equal(spawnSync('git', ['add', '-f', ...publicFiles], { cwd: root }).status, 0);
    const strictPublicResult = runScanner(root);
    assert.notEqual(strictPublicResult.status, 0, 'exact public mirrors must use strict surface checks');
    assert.match(outputOf(strictPublicResult), /docs\/public-surface\.md:1\s+absolute-home-path/);
    assert.match(outputOf(strictPublicResult), /docs\/public-surface\.md:2\s+non-documentation-ipv4-address/);
    assert.match(outputOf(strictPublicResult), /docs\/public-surface\.md:3\s+non-documentation-ipv4-address/);
    assert.match(outputOf(strictPublicResult), /docs\/public-surface\.md:4\s+non-documentation-ipv4-address/);
    assert.match(outputOf(strictPublicResult), /docs\/public-surface\.md:5\s+non-documentation-ipv4-address/);
    assert.match(outputOf(strictPublicResult), /docs\/public-surface\.md:6\s+non-documentation-ipv4-address/);
    assert.match(outputOf(strictPublicResult), /docs\/public-surface\.md:7\s+device-identifier/);
    assert.equal(outputOf(strictPublicResult).includes(syntheticHomePath), false,
      'failure output must redact absolute home paths');
    assert.equal(outputOf(strictPublicResult).includes(syntheticPublicIpv4), false,
      'failure output must redact public IP addresses');
    assert.equal(outputOf(strictPublicResult).includes(syntheticPrivateIpv4), false,
      'failure output must redact private IP addresses');
    assert.equal(outputOf(strictPublicResult).includes(syntheticMulticastIpv4), false,
      'failure output must redact multicast IP addresses');
    assert.equal(outputOf(strictPublicResult).includes(syntheticLoopbackRangeIpv4), false,
      'failure output must redact noncanonical loopback-range IP addresses');
    assert.equal(outputOf(strictPublicResult).includes(syntheticUnspecifiedRangeIpv4), false,
      'failure output must redact noncanonical unspecified-range IP addresses');
    assert.equal(outputOf(strictPublicResult).includes(syntheticDeviceId), false,
      'failure output must redact device identifiers');

    console.log('unit-pii-scanner-test: PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

export { run };

if (import.meta.url === `file://${process.argv[1]}`) await run();

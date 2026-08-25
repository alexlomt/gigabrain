#!/usr/bin/env node
// Hard rule: NO real personal data in this repo. The private release workspace
// injects source-only identifier hashes; the public package contains only the
// generic detectors and synthetic mechanism tests. Real-provider emails,
// contact ids, home paths, private/public IPs, device ids, and secret shapes are
// rejected. Synthetic placeholders (example.com, 1000000000, ...) are allowed.
// Run: node scripts/check-no-pii.mjs. Enforced server-side by the pii-scan GitHub Action.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseNpmPackInventory } from './npm-pack-inventory.mjs';

import {
  BANNED_IDENTIFIER_HASHES,
  BANNED_TOKEN_HASHES,
  decodeStrictText,
  formatFinding,
  scanText,
  sha256,
} from './privacy-policy.mjs';

const quiet = process.argv.includes('--quiet');

// These are exact digests of deliberately fake credential strings used to
// prove runtime redaction. File names alone or words such as "example" never
// bypass the scanner.
const REVIEWED_SECRET_FIXTURES = new Set([
  'scripts/demo-handoff.sh:6c8b9fdb4444fa8ecf6ac5b038d369b29f7bfaf1968cfff7de972acb6da033f9',
]);
const bannedIdentifierHashes = new Set(BANNED_IDENTIFIER_HASHES);
const bannedTokenHashes = new Set(BANNED_TOKEN_HASHES);
const REVIEWED_BINARY_SHA256 = new Map();
const sourceOnlyFixtureModule = new URL('./private-scan-fixtures.mjs', import.meta.url);
if (existsSync(sourceOnlyFixtureModule)) {
  const sourceOnly = await import(sourceOnlyFixtureModule.href);
  for (const fixture of sourceOnly.SOURCE_ONLY_SECRET_FIXTURES || []) {
    REVIEWED_SECRET_FIXTURES.add(String(fixture));
  }
  for (const hash of sourceOnly.SOURCE_ONLY_BANNED_IDENTIFIER_HASHES || []) {
    bannedIdentifierHashes.add(String(hash));
  }
  for (const hash of sourceOnly.SOURCE_ONLY_BANNED_TOKEN_HASHES || []) {
    bannedTokenHashes.add(String(hash));
  }
  for (const entry of sourceOnly.SOURCE_ONLY_REVIEWED_BINARY_SHA256 || []) {
    if (Array.isArray(entry) && entry.length === 2) {
      REVIEWED_BINARY_SHA256.set(String(entry[0]), String(entry[1]));
    }
  }
}

const npmPackFiles = () => {
  if (!statSync('package.json', { throwIfNoEntry: false })) return [];
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: process.env.npm_config_cache || join(tmpdir(), 'gigabrain-npm-cache'),
      npm_config_ignore_scripts: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseNpmPackInventory(output);
};

const gitFiles = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .sort((left, right) => left.localeCompare(right, 'en'));
const isPublicReleaseSurface = (() => {
  try {
    const manifest = JSON.parse(readFileSync('public-release-manifest.json', 'utf8'));
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const expected = [...new Set(manifest?.repository?.files || [])]
      .map(String)
      .sort((left, right) => left.localeCompare(right, 'en'));
    const exactInventory = expected.length > 0
      && expected.length === trackedFiles.length
      && expected.every((file, index) => file === trackedFiles[index]);
    const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object'
      ? packageJson.scripts
      : {};
    const carriesPrivateReleaseScripts = ['build:public-mirror', 'test:gates']
      .some((name) => Object.hasOwn(scripts, name));
    return expected.length > 0 && (exactInventory || !carriesPrivateReleaseScripts);
  } catch {
    return false;
  }
})();
const files = [...new Set([...gitFiles, ...npmPackFiles()])]
  .filter((file) => !file.startsWith('node_modules/'))
  .sort((left, right) => left.localeCompare(right, 'en'));

const findings = [];
for (const file of files) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    findings.push({ kind: 'unreadable-scan-input', location: file });
    continue;
  }
  const approvedDigest = REVIEWED_BINARY_SHA256.get(file);
  if (approvedDigest) {
    if (sha256(bytes) !== approvedDigest) findings.push({ kind: 'reviewed-binary-digest-mismatch', location: file });
    continue;
  }
  const text = decodeStrictText(bytes);
  if (text === null) {
    findings.push({ kind: 'unreviewed-binary-file', location: file });
    continue;
  }
  findings.push(...scanText({
    text,
    location: file,
    byteLength: bytes.length,
    reviewedSecretFixtures: REVIEWED_SECRET_FIXTURES,
    bannedIdentifierHashes,
    bannedTokenHashes,
    strictPublicPaths: isPublicReleaseSurface,
    publicIpv4: isPublicReleaseSurface,
  }));
}

if (findings.length > 0) {
  console.error('\nPII/SECRET CHECK FAILED — sensitive data must not be committed or packaged.');
  console.error('Only synthetic examples and digest-reviewed fixtures are permitted.\n');
  for (const finding of findings.slice(0, 60)) console.error(`  ${formatFinding(finding)}`);
  if (findings.length > 60) console.error(`  ...and ${findings.length - 60} more`);
  process.exit(1);
}
if (!quiet) console.log(`PII/secret check passed (${files.length} files scanned, 0 sensitive-data hits).`);

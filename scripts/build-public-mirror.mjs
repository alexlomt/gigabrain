#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { validateManifest } from './check-public-mirror.mjs';
import {
  atomicWriteFileSync,
  createFileExclusiveSync,
  readRegularFileWithStatNoFollowSync,
} from '../lib/core/safe-fs.js';

const RELEASE_NAME = 'Gigabrain Release';
const RELEASE_EMAIL = 'gigabrain@users.noreply.github.com';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

const fail = (message) => {
  throw new Error(message);
};

const run = (command, args, { cwd, env = process.env, capture = false } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error || result.status !== 0) fail(`${command} failed`);
  return capture ? String(result.stdout || '').trim() : '';
};

const parseArgs = (argv) => {
  const options = { source: process.cwd(), manifest: 'public-release-manifest.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      index += 1;
      if (!argv[index]) fail(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--source') options.source = take();
    else if (arg === '--destination') options.destination = take();
    else if (arg === '--manifest') options.manifest = take();
    else if (arg === '--commit-date') options.commitDate = take();
    else fail('unsupported argument');
  }
  if (!options.destination) fail('--destination is required');
  return options;
};

const assertCleanSource = (source) => {
  if (run('git', ['rev-parse', '--show-toplevel'], { cwd: source, capture: true }) !== source) {
    fail('source must be the repository root');
  }
  if (run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: source, capture: true })) {
    fail('source repository must be clean');
  }
};

const isPathInside = (root, candidate) => (
  candidate === root || candidate.startsWith(`${root}${path.sep}`)
);

const assertRegularSourceFile = (source, relativePath) => {
  const parts = relativePath.split('/');
  let cursor = source;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) fail('allowlisted source path contains a symbolic link');
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail('allowlisted source path contains a non-directory component');
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      fail('allowlisted source is not a regular file');
    }
  }
  const canonicalPath = fs.realpathSync(cursor);
  if (!isPathInside(source, canonicalPath)) fail('allowlisted source resolves outside the source repository');
  return { path: cursor, stat: fs.lstatSync(cursor) };
};

const assertSafeDestination = (source, destination) => {
  const destinationParent = fs.realpathSync(path.dirname(destination));
  const canonicalDestination = path.join(destinationParent, path.basename(destination));
  if (isPathInside(source, canonicalDestination)) {
    fail('destination must be outside the source repository');
  }
  try {
    fs.mkdirSync(destination, { mode: 0o700, recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('destination already exists');
    throw error;
  }
  const createdDestination = fs.realpathSync(destination);
  if (createdDestination !== canonicalDestination || isPathInside(source, createdDestination)) {
    fail('destination resolved to an unsafe location');
  }
  return createdDestination;
};

const copyAllowlistedFiles = ({ source, destination, files }) => {
  for (const relativePath of files) {
    const sourceFile = assertRegularSourceFile(source, relativePath);
    const sourcePath = sourceFile.path;
    const destinationPath = path.join(destination, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(destinationPath), { mode: 0o700, recursive: true });
    const snapshot = readRegularFileWithStatNoFollowSync(sourcePath, null);
    const mode = (snapshot.stat.mode & 0o111) === 0 ? 0o644 : 0o755;
    if (!createFileExclusiveSync(destinationPath, snapshot.data, { encoding: null, mode })) {
      fail('destination file already exists');
    }
  }
};

const applyTransforms = ({ destination, manifest }) => {
  const packagePath = path.join(destination, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!packageJson.scripts || typeof packageJson.scripts !== 'object' || Array.isArray(packageJson.scripts)) {
    fail('package.json scripts must be an object');
  }
  const omittedScripts = manifest.transforms.packageJson.omitScripts;
  const presentScripts = omittedScripts.filter((scriptName) => (
    Object.hasOwn(packageJson.scripts, scriptName)
  ));
  if (presentScripts.length !== 0 && presentScripts.length !== omittedScripts.length) {
    fail('package.json transform is partially applied');
  }
  if (presentScripts.length === omittedScripts.length) {
    for (const scriptName of omittedScripts) delete packageJson.scripts[scriptName];
  }
  for (const [scriptName, scriptValue] of Object.entries(manifest.transforms.packageJson.setScripts)) {
    packageJson.scripts[scriptName] = scriptValue;
  }
  atomicWriteFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o644 });
};

export const buildPublicMirror = ({
  source,
  destination,
  manifest = 'public-release-manifest.json',
  commitDate = new Date().toISOString(),
}) => {
  const resolvedSource = fs.realpathSync(path.resolve(source));
  const resolvedDestination = path.resolve(destination);
  const manifestPath = path.resolve(resolvedSource, manifest);
  const relativeManifest = path.relative(resolvedSource, manifestPath).split(path.sep).join('/');
  if (!relativeManifest || relativeManifest.startsWith('../') || path.isAbsolute(relativeManifest)) {
    fail('manifest must be inside the source repository');
  }
  assertRegularSourceFile(resolvedSource, relativeManifest);
  const parsed = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  if (!parsed.repository.files.includes(relativeManifest)) fail('manifest must allowlist itself');

  assertCleanSource(resolvedSource);
  const canonicalDestination = assertSafeDestination(resolvedSource, resolvedDestination);
  copyAllowlistedFiles({
    source: resolvedSource,
    destination: canonicalDestination,
    files: parsed.repository.files,
  });
  applyTransforms({ destination: canonicalDestination, manifest: parsed });

  const isolatedGitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  run('git', ['init', '--initial-branch=main', '--quiet'], {
    cwd: canonicalDestination,
    env: isolatedGitEnvironment,
  });
  run('git', ['-c', `core.hooksPath=${NULL_DEVICE}`, 'add', '--all'], {
    cwd: canonicalDestination,
    env: isolatedGitEnvironment,
  });
  const identityEnvironment = {
    ...isolatedGitEnvironment,
    GIT_AUTHOR_NAME: RELEASE_NAME,
    GIT_AUTHOR_EMAIL: RELEASE_EMAIL,
    GIT_COMMITTER_NAME: RELEASE_NAME,
    GIT_COMMITTER_EMAIL: RELEASE_EMAIL,
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_DATE: commitDate,
  };
  run('git', ['-c', `core.hooksPath=${NULL_DEVICE}`, 'commit', '--quiet', '--no-gpg-sign', '-m', 'Public release snapshot'], {
    cwd: canonicalDestination,
    env: identityEnvironment,
  });
  run(process.execPath, ['scripts/check-public-mirror.mjs', '--require-single-commit'], {
    cwd: canonicalDestination,
  });
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: canonicalDestination, capture: true });
  return { destination: canonicalDestination, head };
};

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = buildPublicMirror(options);
    fs.writeSync(1, `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch {
    fs.writeSync(2, 'PUBLIC_MIRROR_BUILD_FAILED\n');
    process.exitCode = 1;
  }
}

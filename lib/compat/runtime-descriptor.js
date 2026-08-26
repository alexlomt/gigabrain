import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPENCLAW_ROOT = path.resolve(process.env.OPENCLAW_ROOT || path.join(os.homedir(), '.openclaw'));
const DEFAULT_RUNTIME_DESCRIPTOR_PATH = path.join(OPENCLAW_ROOT, 'runtime', 'gigabrain-release.json');
const RUNTIME_DESCRIPTOR_KEYS = Object.freeze([
  'autoCaptureQueuePath',
  'codeRoot',
  'dbPath',
  'graphPath',
  'nativeLockDir',
  'operatorLogDir',
  'outputDir',
  'reviewQueuePath',
  'vaultPath',
]);
const MAX_DESCRIPTOR_BYTES = 64 * 1024;

const descriptorError = (code, detail = '') => {
  const error = new Error(`${code}${detail ? `: ${detail}` : ''}`);
  error.code = code;
  return error;
};

const assertNoSymlinkComponents = (targetPath, code) => {
  const parsed = path.parse(targetPath);
  let current = parsed.root;
  const segments = targetPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw descriptorError(code, current);
  }
};

const sameFileIdentity = (left, right) => Boolean(
  left && right && Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino),
);

const validateRuntimePath = (key, value) => {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw) || path.resolve(raw) !== raw || raw === path.parse(raw).root) {
    throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_PATH', key);
  }
  assertNoSymlinkComponents(raw, 'GIGABRAIN_RUNTIME_DESCRIPTOR_PATH_SYMLINK');
  return raw;
};

const loadRuntimeDescriptor = (descriptorPath = DEFAULT_RUNTIME_DESCRIPTOR_PATH) => {
  const rawPath = String(descriptorPath || DEFAULT_RUNTIME_DESCRIPTOR_PATH).trim();
  if (!path.isAbsolute(rawPath) || path.resolve(rawPath) !== rawPath) {
    throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_PATH', rawPath);
  }
  const resolved = rawPath;
  assertNoSymlinkComponents(resolved, 'GIGABRAIN_RUNTIME_DESCRIPTOR_SYMLINK');
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_MISSING', resolved);
    throw error;
  }
  if (stat.isSymbolicLink()) throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_SYMLINK', resolved);
  if (!stat.isFile()) throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_TYPE', resolved);
  if (typeof process.getuid === 'function' && Number(stat.uid) !== Number(process.getuid())) {
    throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_OWNER', resolved);
  }
  if (Number(stat.nlink) !== 1) throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_HARDLINK', resolved);
  if ((stat.mode & 0o777) !== 0o600) throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_MODE', resolved);
  if (stat.size <= 0 || stat.size > MAX_DESCRIPTOR_BYTES) throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_SIZE', resolved);
  let parsed;
  let descriptorFd;
  try {
    descriptorFd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedStat = fs.fstatSync(descriptorFd);
    if (!sameFileIdentity(stat, openedStat)) throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_IDENTITY', resolved);
    parsed = JSON.parse(fs.readFileSync(descriptorFd, 'utf8'));
  } catch (error) {
    if (String(error?.code || '').startsWith('GIGABRAIN_')) throw error;
    throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_JSON', resolved);
  } finally {
    if (descriptorFd !== undefined) fs.closeSync(descriptorFd);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_SCHEMA', resolved);
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== RUNTIME_DESCRIPTOR_KEYS.length
    || keys.some((key, index) => key !== RUNTIME_DESCRIPTOR_KEYS[index])) {
    throw descriptorError('GIGABRAIN_RUNTIME_DESCRIPTOR_SCHEMA', resolved);
  }
  const descriptor = {};
  for (const key of RUNTIME_DESCRIPTOR_KEYS) descriptor[key] = validateRuntimePath(key, parsed[key]);
  return Object.freeze(descriptor);
};

const resolveRuntimeDescriptor = (config = {}) => {
  if (config?.runtimeDescriptor && typeof config.runtimeDescriptor === 'object') {
    const descriptor = {};
    for (const key of RUNTIME_DESCRIPTOR_KEYS) descriptor[key] = validateRuntimePath(key, config.runtimeDescriptor[key]);
    return Object.freeze(descriptor);
  }
  const descriptorPath = String(
    config?.runtimeDescriptorPath
    || config?.runtime?.descriptorPath
    || process.env.GIGABRAIN_RUNTIME_DESCRIPTOR
    || DEFAULT_RUNTIME_DESCRIPTOR_PATH,
  ).trim();
  return loadRuntimeDescriptor(descriptorPath);
};

export {
  DEFAULT_RUNTIME_DESCRIPTOR_PATH,
  RUNTIME_DESCRIPTOR_KEYS,
  loadRuntimeDescriptor,
  resolveRuntimeDescriptor,
};

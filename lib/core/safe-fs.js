import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const noFollowFlag = Number(fs.constants.O_NOFOLLOW || 0);

const readRegularFileWithStatNoFollowSync = (filePath, encoding = 'utf8', { maxBytes = 0 } = {}) => {
  const flags = fs.constants.O_RDONLY | noFollowFlag;
  const handle = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw new Error(`Refusing to read a non-regular file: ${filePath}`);
    if (Number(maxBytes) > 0 && Number(stat.size) > Number(maxBytes)) {
      const error = new Error(`Refusing to read an oversized file: ${filePath}`);
      error.code = 'EFBIG';
      error.stat = stat;
      throw error;
    }
    return { data: fs.readFileSync(handle, encoding), stat };
  } finally {
    fs.closeSync(handle);
  }
};

const readFileIfExistsSync = (filePath, encoding = 'utf8', options = {}) => {
  try {
    const snapshot = readRegularFileWithStatNoFollowSync(filePath, encoding, options);
    return { exists: true, ...snapshot };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, data: encoding ? '' : Buffer.alloc(0), stat: null };
    throw error;
  }
};

const readRegularFileNoFollowSync = (filePath, encoding = 'utf8') => (
  readRegularFileWithStatNoFollowSync(filePath, encoding).data
);

const pathPolicyError = (message) => {
  const error = new Error(`GIGABRAIN_PATH_REJECTED: ${message}`);
  error.code = 'GIGABRAIN_PATH_REJECTED';
  return error;
};

const resolveContainedRegularFileNoFollowSync = (rootPath, relativePath) => {
  const root = String(rootPath || '').trim();
  const requested = String(relativePath || '').trim();
  if (!root || !requested || path.isAbsolute(requested) || requested.includes('\0')) {
    throw pathPolicyError('a non-empty relative path is required');
  }
  const segments = requested.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw pathPolicyError('path traversal is not allowed');
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    throw pathPolicyError('configured root does not exist');
  }
  let candidate = realRoot;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      throw pathPolicyError('path does not exist');
    }
    if (stat.isSymbolicLink()) throw pathPolicyError('symbolic links are not allowed');
  }
  const relative = path.relative(realRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw pathPolicyError('path escapes configured root');
  }
  const finalStat = fs.lstatSync(candidate);
  if (!finalStat.isFile()) throw pathPolicyError('path is not a regular file');
  return candidate;
};

const readContainedRegularFileNoFollowSync = (
  rootPath,
  relativePath,
  encoding = 'utf8',
  options = {},
) => {
  const absolutePath = resolveContainedRegularFileNoFollowSync(rootPath, relativePath);
  const snapshot = readRegularFileWithStatNoFollowSync(absolutePath, encoding, options);
  return { ...snapshot, absolutePath };
};

const createFileExclusiveSync = (filePath, data, { encoding = 'utf8', mode = 0o600 } = {}) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | noFollowFlag;
  let handle;
  try {
    handle = fs.openSync(filePath, flags, mode);
    fs.writeFileSync(handle, data, { encoding });
    fs.fsyncSync(handle);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* best-effort cleanup */ }
      handle = undefined;
    }
    try { fs.rmSync(filePath, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
};

const atomicWriteFileSync = (filePath, data, { encoding = 'utf8', mode = 0o600 } = {}) => {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.gigabrain-write-${randomUUID()}.tmp`);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | noFollowFlag;
  let handle;
  try {
    handle = fs.openSync(temporaryPath, flags, mode);
    fs.writeFileSync(handle, data, { encoding });
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, mode);
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* best-effort cleanup */ }
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
};

export {
  atomicWriteFileSync,
  createFileExclusiveSync,
  readContainedRegularFileNoFollowSync,
  readFileIfExistsSync,
  readRegularFileNoFollowSync,
  readRegularFileWithStatNoFollowSync,
  resolveContainedRegularFileNoFollowSync,
};

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
  readFileIfExistsSync,
  readRegularFileNoFollowSync,
  readRegularFileWithStatNoFollowSync,
};

#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[*?\[\]{}\\\0]).+$/;
const NOFOLLOW = constants.O_NOFOLLOW || 0;

function fail(code) {
  throw new Error(code);
}

function modeOf(stats) {
  return stats.mode & 0o777;
}

function lstatOrFail(targetPath, code) {
  try {
    return lstatSync(targetPath);
  } catch {
    fail(code);
  }
}

function assertDirectory(targetPath, { code, mode = 0o700 }) {
  const stats = lstatOrFail(targetPath, code);
  if (stats.isSymbolicLink()) fail(code);
  if (!stats.isDirectory()) fail(code);
  if (modeOf(stats) !== mode) fail(code);
  let canonical;
  try {
    canonical = realpathSync(targetPath);
  } catch {
    fail(code);
  }
  if (canonical !== path.resolve(targetPath)) fail(code);
}

function validateRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !SAFE_PATH.test(relativePath)) fail("RESTORE_INVALID_PATH");
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath) fail("RESTORE_INVALID_PATH");
  return relativePath.split("/");
}

function resolveInside(root, relativePath) {
  const parts = validateRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail("RESTORE_INVALID_PATH");
  return { parts, resolved, resolvedRoot };
}

function walkDirectories(root, parts, { code, create = false }) {
  assertDirectory(root, { code });
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (!create || error?.code !== "ENOENT") fail(code);
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") fail(code);
      }
      stats = lstatOrFail(current, code);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() || modeOf(stats) !== 0o700) fail(code);
    if (realpathSync(current) !== current) fail(code);
  }
  return current;
}

function readOwnerOnlyFile(filePath, { directoryCode, fileCode }) {
  const resolved = path.resolve(filePath);
  assertDirectory(path.dirname(resolved), { code: directoryCode });
  const before = lstatOrFail(resolved, fileCode);
  if (before.isSymbolicLink()) fail(fileCode);
  if (!before.isFile()) fail(fileCode);
  if (modeOf(before) !== 0o600) fail(fileCode);
  let descriptor;
  try {
    descriptor = openSync(resolved, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || modeOf(opened) !== 0o600) fail(fileCode);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail(fileCode);
    const bytes = readFileSync(descriptor);
    if (realpathSync(resolved) !== resolved) fail(fileCode);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === fileCode) throw error;
    fail(fileCode);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readProtectedSource(protectedRoot, sourcePath) {
  const { parts, resolved } = resolveInside(protectedRoot, sourcePath);
  walkDirectories(protectedRoot, parts.slice(0, -1), {
    code: "RESTORE_SOURCE_SYMLINK",
  });
  const before = lstatOrFail(resolved, "RESTORE_SOURCE_NOT_REGULAR");
  if (before.isSymbolicLink()) fail("RESTORE_SOURCE_SYMLINK");
  if (!before.isFile()) fail("RESTORE_SOURCE_NOT_REGULAR");
  if (modeOf(before) !== 0o600) fail("RESTORE_PROTECTED_MODE");
  let descriptor;
  try {
    descriptor = openSync(resolved, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) fail("RESTORE_SOURCE_NOT_REGULAR");
    if (modeOf(opened) !== 0o600) fail("RESTORE_PROTECTED_MODE");
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail("RESTORE_SOURCE_SYMLINK");
    const bytes = readFileSync(descriptor);
    if (realpathSync(resolved) !== resolved) fail("RESTORE_SOURCE_SYMLINK");
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("RESTORE_")) throw error;
    fail("RESTORE_SOURCE_SYMLINK");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicCreateOwnerOnly(targetRoot, relativePath, bytes) {
  const { parts, resolved } = resolveInside(targetRoot, relativePath);
  const parent = walkDirectories(targetRoot, parts.slice(0, -1), {
    code: "RESTORE_TARGET_SYMLINK",
    create: true,
  });
  try {
    lstatSync(resolved);
    fail("RESTORE_TARGET_EXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "RESTORE_TARGET_EXISTS") throw error;
    if (error?.code !== "ENOENT") fail("RESTORE_TARGET_EXISTS");
  }

  const temporary = path.join(parent, `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, resolved);
    } catch (error) {
      if (error?.code === "EEXIST") fail("RESTORE_TARGET_EXISTS");
      fail("RESTORE_ATOMIC_WRITE_FAILED");
    }
    let directoryDescriptor;
    try {
      directoryDescriptor = openSync(parent, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | NOFOLLOW);
      fsyncSync(directoryDescriptor);
    } catch {
      fail("RESTORE_ATOMIC_WRITE_FAILED");
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
    const target = lstatOrFail(resolved, "RESTORE_ATOMIC_WRITE_FAILED");
    if (!target.isFile() || target.isSymbolicLink() || modeOf(target) !== 0o600) {
      fail("RESTORE_ATOMIC_WRITE_FAILED");
    }
    if (realpathSync(resolved) !== resolved) fail("RESTORE_TARGET_SYMLINK");
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("RESTORE_")) throw error;
    fail("RESTORE_ATOMIC_WRITE_FAILED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary may already be gone; the final hard link is independent.
    }
  }
}

function validateReceipt(receiptPath) {
  if (typeof receiptPath !== "string" || !path.isAbsolute(receiptPath)) fail("RESTORE_RECEIPT_MODE");
  return readOwnerOnlyFile(receiptPath, {
    directoryCode: "RESTORE_RECEIPT_MODE",
    fileCode: "RESTORE_RECEIPT_MODE",
  });
}

export function restoreReviewedTests({
  inventory,
  protectedRoot,
  receiptPath,
  replacements,
  stagePaths,
  targetRoot,
}) {
  if (!Array.isArray(inventory) || !Array.isArray(replacements) || !Array.isArray(stagePaths)) {
    fail("RESTORE_INVALID_REVIEW_INPUT");
  }
  validateReceipt(receiptPath);
  assertDirectory(protectedRoot, { code: "RESTORE_PROTECTED_MODE" });
  assertDirectory(targetRoot, { code: "RESTORE_TARGET_MODE" });
  const staged = new Set(stagePaths);
  for (const row of inventory) {
    if (!staged.has(row.syntheticTarget)) fail("RESTORE_TARGET_NOT_STAGED");
    const sourceBytes = readProtectedSource(protectedRoot, row.sourcePath);
    if (sha256(sourceBytes) !== row.sourceSha256) fail("RESTORE_SOURCE_HASH_MISMATCH");
    let restored = sourceBytes.toString("utf8");
    for (const replacement of replacements) {
      if (
        !Array.isArray(replacement)
        || replacement.length !== 2
        || typeof replacement[0] !== "string"
        || replacement[0].length === 0
        || typeof replacement[1] !== "string"
      ) {
        fail("RESTORE_INVALID_REPLACEMENT");
      }
      restored = restored.split(replacement[0]).join(replacement[1]);
    }
    if (sha256(restored) !== row.syntheticSha256) fail("RESTORE_TARGET_HASH_MISMATCH");
    const targetPath = atomicCreateOwnerOnly(targetRoot, row.syntheticTarget, restored);
    const verified = readOwnerOnlyFile(targetPath, {
      directoryCode: "RESTORE_TARGET_MODE",
      fileCode: "RESTORE_ATOMIC_WRITE_FAILED",
    });
    if (sha256(verified) !== row.syntheticSha256) fail("RESTORE_ATOMIC_WRITE_FAILED");
  }
  return { restored: inventory.length };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) fail("RESTORE_USAGE");
    options[flag.slice(2)] = value;
  }
  for (const required of ["inventory", "protected-root", "receipt", "stage-paths", "target-root"]) {
    if (!options[required]) fail("RESTORE_USAGE");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inventoryDocument = JSON.parse(readFileSync(options.inventory, "utf8"));
  const receiptBytes = validateReceipt(path.resolve(options.receipt));
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const stagePaths = readFileSync(options["stage-paths"], "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const reviewedTargets = new Set(receipt.reviewedTargets || []);
  const inventory = (inventoryDocument.tests || [])
    .filter((row) => reviewedTargets.has(row.syntheticTarget))
    .map((row) => ({
      sourcePath: row.sourcePath,
      sourceSha256: row.sourceSha256,
      syntheticSha256: receipt.syntheticHashes?.[row.syntheticTarget],
      syntheticTarget: row.syntheticTarget,
    }));
  const result = restoreReviewedTests({
    inventory,
    protectedRoot: options["protected-root"],
    receiptPath: path.resolve(options.receipt),
    replacements: receipt.replacements || [],
    stagePaths,
    targetRoot: options["target-root"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

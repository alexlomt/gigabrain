import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const compareCanonicalUtf8 = (left, right) => Buffer.compare(
  Buffer.from(String(left), "utf8"),
  Buffer.from(String(right), "utf8"),
);

const RELEASE_PROVENANCE_FIELDS = Object.freeze([
  "packageVersion",
  "upstreamVersion",
  "codeSha",
  "immutableTag",
  "schemaId",
  "schemaChecksum",
  "payloadRoot",
  "manifestSha256",
  "dependencyRoot",
  "localIntegrityRoot",
]);

const RELEASE_FILE_FIELDS = Object.freeze({
  packageVersion: "package_version",
  upstreamVersion: "upstream_version",
  codeSha: "code_sha",
  immutableTag: "immutable_tag",
  schemaId: "schema_id",
  schemaChecksum: "schema_checksum",
  payloadRoot: "payload_root",
  manifestSha256: "manifest_sha256",
  dependencyRoot: "dependency_root",
  localIntegrityRoot: "local_integrity_root",
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const CODE_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const MANIFEST_ENTRY_KEYS = Object.freeze(["mode", "relative_path", "sha256", "type"]);
const MANIFEST_KEYS = Object.freeze(["entries", "schema_id"]);
// Task 15 intentionally pins the only reviewed pre-tag manifest schemas. A
// future schema requires an explicit versioned reader, not permissive fallback.
const RELEASE_MANIFEST_SCHEMA = "gigabrain-release-manifest.1";
const LOCAL_INTEGRITY_MANIFEST_SCHEMA = "gigabrain-local-integrity.1";
const LOCAL_INTEGRITY_MANIFEST_KEYS = Object.freeze(["entries", "schema_id"]);
const RELEASE_KEYS = Object.freeze(Object.values(RELEASE_FILE_FIELDS).sort(compareCanonicalUtf8));
const DEPENDENCY_MANIFEST_KEYS = Object.freeze([
  "index",
  "inventorySha256",
  "lockFile",
  "lockSha256",
  "packages",
  "platform",
  "python",
  "schema",
]);
const WHEEL_PACKAGE_KEYS = Object.freeze(["filename", "index", "name", "sha256", "version"]);
const DEFAULT_PYTHON_LOCK = "memory_api/requirements-prod-py310-linux-x86_64.lock";
const DEFAULT_WHEEL_MANIFEST = "memory_api/wheelhouse-py310-linux-x86_64.manifest.json";
const APPROVED_PYPI_INDEX = "https://pypi.org/simple";
const PAYLOAD_EXCLUDED_SEGMENTS = new Set([
  ".cache",
  ".git",
  ".venv",
  "__pycache__",
  "data",
  "node_modules",
  "output",
  "runtime",
  "venv",
]);
const PRODUCTION_VENV_PAYLOAD_ROOT = "memory_api/.venv-v0.11-prod";
const NO_FOLLOW = Number(fs.constants.O_NOFOLLOW || 0);
const NON_BLOCKING = Number(fs.constants.O_NONBLOCK || 0);
const STABLE_STAT_FIELDS = Object.freeze([
  "dev",
  "ino",
  "nlink",
  "mode",
  "size",
  "mtimeNs",
  "ctimeNs",
]);

const provenanceError = (code, detail) => {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
};

const PAYLOAD_FILE_CODES = Object.freeze({
  hardlink: "GIGABRAIN_RELEASE_PAYLOAD_HARDLINK",
  missing: "GIGABRAIN_RELEASE_PAYLOAD_MISSING",
  mode: "GIGABRAIN_RELEASE_PAYLOAD_MODE",
  symlink: "GIGABRAIN_RELEASE_PAYLOAD_SYMLINK",
  type: "GIGABRAIN_RELEASE_PAYLOAD_TYPE",
  unstable: "GIGABRAIN_RELEASE_PAYLOAD_UNSTABLE",
});
const LOCAL_INTEGRITY_FILE_CODES = Object.freeze({
  hardlink: "GIGABRAIN_RELEASE_LOCAL_INTEGRITY_HARDLINK",
  missing: "GIGABRAIN_RELEASE_LOCAL_INTEGRITY_MISSING",
  mode: "GIGABRAIN_RELEASE_LOCAL_INTEGRITY_MODE",
  symlink: "GIGABRAIN_RELEASE_LOCAL_INTEGRITY_SYMLINK",
  type: "GIGABRAIN_RELEASE_LOCAL_INTEGRITY_TYPE",
  unstable: "GIGABRAIN_RELEASE_LOCAL_INTEGRITY_UNSTABLE",
});
const PROVENANCE_FILE_CODES = Object.freeze({
  hardlink: "GIGABRAIN_RELEASE_PROVENANCE_INVALID",
  missing: "GIGABRAIN_RELEASE_PROVENANCE_MISSING",
  mode: "GIGABRAIN_RELEASE_PROVENANCE_INVALID",
  symlink: "GIGABRAIN_RELEASE_PAYLOAD_SYMLINK",
  type: "GIGABRAIN_RELEASE_PROVENANCE_INVALID",
  unstable: "GIGABRAIN_RELEASE_PROVENANCE_INVALID",
});

const defaultReleaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(compareCanonicalUtf8).map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const exactKeys = (value, expected) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareCanonicalUtf8);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isExcludedReleasePayloadPath = (relativePath) => {
  if (relativePath === "RELEASE.json" || relativePath === "RELEASE.manifest.json") return true;
  const value = String(relativePath || "");
  if (value === PRODUCTION_VENV_PAYLOAD_ROOT || value.startsWith(`${PRODUCTION_VENV_PAYLOAD_ROOT}/`)) return true;
  const segments = value.split("/");
  return segments.some((segment) => PAYLOAD_EXCLUDED_SEGMENTS.has(segment)) || value.endsWith(".pyc");
};

const validateRelativePayloadPath = (relativePath) => {
  const value = String(relativePath || "");
  if (
    typeof relativePath !== "string"
    || !value
    || value.trim() !== value
    || value.includes("\\")
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || isExcludedReleasePayloadPath(value)
  ) throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", value || "empty payload path");
  return value;
};

const validateRelativeLocalIntegrityPath = (relativePath) => {
  const value = String(relativePath || "");
  if (
    typeof relativePath !== "string"
    || !value
    || value.trim() !== value
    || value.includes("\\")
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID", value || "empty local path");
  return value;
};

const sameStableStat = (left, right) => STABLE_STAT_FIELDS.every((field) => left[field] === right[field]);

const modeBits = (fileStat) => Number(fileStat.mode & 0o7777n);

const requireCanonicalFileMode = (fileStat, code, relativePath) => {
  const bits = modeBits(fileStat);
  if (bits !== 0o644 && bits !== 0o755) throw provenanceError(code, relativePath);
  return `100${bits.toString(8).padStart(3, "0")}`;
};

const captureAncestorIdentities = (root, relativePath, codes) => {
  const snapshots = [];
  let cursor = root;
  const parentSegments = relativePath.split("/").slice(0, -1);
  for (const segment of ["", ...parentSegments]) {
    if (segment) cursor = path.join(cursor, segment);
    let directoryStat;
    try { directoryStat = fs.lstatSync(cursor, { bigint: true }); } catch {
      throw provenanceError(codes.unstable, relativePath);
    }
    if (directoryStat.isSymbolicLink()) throw provenanceError(codes.symlink, relativePath);
    if (!directoryStat.isDirectory()) throw provenanceError(codes.type, relativePath);
    snapshots.push({ absolutePath: cursor, stat: directoryStat });
  }
  return snapshots;
};

const assertStableAncestors = (before, after, code, relativePath) => {
  if (before.length !== after.length || before.some((entry, index) => (
    entry.absolutePath !== after[index].absolutePath || !sameStableStat(entry.stat, after[index].stat)
  ))) throw provenanceError(code, relativePath);
};

const readBoundedDescriptor = (handle, maxBytes, codes, relativePath) => {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw provenanceError(codes.type, relativePath);
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const remaining = limit + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) {
      const error = provenanceError(codes.type, relativePath);
      error.code = "EFBIG";
      throw error;
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
};

const readStableReleaseFile = ({ root, relativePath, maxBytes, codes, requireCanonicalMode = false }) => {
  const ancestorsBefore = captureAncestorIdentities(root, relativePath, codes);
  const absolutePath = path.join(root, ...relativePath.split("/"));
  let handle;
  let opened;
  let afterRead;
  let data;
  try {
    handle = fs.openSync(absolutePath, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
    opened = fs.fstatSync(handle, { bigint: true });
    if (!opened.isFile()) throw provenanceError(codes.type, relativePath);
    if (opened.nlink !== 1n) throw provenanceError(codes.hardlink, relativePath);
    if (requireCanonicalMode) requireCanonicalFileMode(opened, codes.mode, relativePath);
    if (Number(maxBytes) > 0 && opened.size > BigInt(maxBytes)) {
      const error = provenanceError(codes.type, relativePath);
      error.code = "EFBIG";
      throw error;
    }
    data = readBoundedDescriptor(handle, maxBytes, codes, relativePath);
    afterRead = fs.fstatSync(handle, { bigint: true });
  } catch (error) {
    if (error?.code === "ELOOP") throw provenanceError(codes.symlink, relativePath);
    if (error?.code === "ENOENT") throw provenanceError(codes.missing, relativePath);
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }

  let pathAfter;
  let ancestorsAfter;
  try {
    pathAfter = fs.lstatSync(absolutePath, { bigint: true });
    ancestorsAfter = captureAncestorIdentities(root, relativePath, codes);
  } catch {
    throw provenanceError(codes.unstable, relativePath);
  }
  if (!sameStableStat(opened, afterRead)
    || !sameStableStat(afterRead, pathAfter)
    || opened.size !== BigInt(data.length)) {
    throw provenanceError(codes.unstable, relativePath);
  }
  assertStableAncestors(ancestorsBefore, ancestorsAfter, codes.unstable, relativePath);
  return { data, stat: opened };
};

const normalizeDistributionName = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[-_.]+/g, "-");

const normalizeInstalledDistributions = (inventory) => {
  if (!Array.isArray(inventory)) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_INVENTORY_REQUIRED", "installedDistributions array");
  }
  const seen = new Set();
  const normalized = inventory.map((entry) => {
    if (!exactKeys(entry, ["name", "version"])) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_INVENTORY_INVALID", "installed distribution shape");
    }
    const name = normalizeDistributionName(entry.name);
    const version = String(entry.version || "").trim();
    if (!name || !version || seen.has(name)) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_INVENTORY_INVALID", name || "empty distribution");
    }
    seen.add(name);
    return { name, version };
  });
  return normalized.sort((left, right) => compareCanonicalUtf8(left.name, right.name));
};

const parsePythonLockInventory = (lockBytes) => {
  const rows = [];
  const seen = new Set();
  const source = Buffer.from(lockBytes).toString("utf8");
  let current = null;
  const finish = () => {
    if (!current) return;
    if (current.hashes.size === 0) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_LOCK_INVALID", `${current.name} has no SHA-256 hashes`);
    }
    rows.push({
      hashes: [...current.hashes].sort(compareCanonicalUtf8),
      name: current.name,
      version: current.version,
    });
    current = null;
  };
  for (const line of source.split(/\r?\n/)) {
    const requirement = line.match(/^([A-Za-z0-9_.-]+)==([^\s\\]+)(?:\s|\\|$)/);
    if (requirement) {
      finish();
      const name = normalizeDistributionName(requirement[1]);
      const version = String(requirement[2] || "").trim();
      if (!name || !version || seen.has(name)) {
        throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_LOCK_INVALID", name || "empty distribution");
      }
      seen.add(name);
      current = { hashes: new Set(), name, version };
    }
    if (current) {
      for (const hashMatch of line.matchAll(/--hash=sha256:([0-9a-f]{64})(?:\s|\\|$)/g)) {
        current.hashes.add(hashMatch[1]);
      }
    }
  }
  finish();
  if (rows.length === 0) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_LOCK_INVALID", "no pinned distributions");
  }
  return rows.sort((left, right) => compareCanonicalUtf8(left.name, right.name));
};

const normalizeWheelVersion = (value) => String(value || "").trim().toLowerCase().replace(/_/g, "-");

const validateWheelFilename = (filenameValue, declaredName, declaredVersion) => {
  if (typeof filenameValue !== "string"
    || filenameValue.trim() !== filenameValue
    || !filenameValue
    || /[\\/\x00-\x1f\x7f]/.test(filenameValue)
    || path.posix.basename(filenameValue) !== filenameValue
    || path.win32.basename(filenameValue) !== filenameValue
    || !filenameValue.endsWith(".whl")) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_FILENAME", String(filenameValue || "empty filename"));
  }
  const parts = filenameValue.slice(0, -4).split("-");
  // PEP 427 permits a sixth build-tag field; this release deliberately forbids
  // build-tag selection so a name/version maps to one reviewed artifact shape.
  if (parts.length !== 5) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_FILENAME", filenameValue);
  }
  const [wheelDistribution, wheelVersion, pythonTag, abiTag, platformTag] = parts;
  if (normalizeDistributionName(wheelDistribution) !== declaredName
    || normalizeWheelVersion(wheelVersion) !== normalizeWheelVersion(declaredVersion)) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_FILENAME", filenameValue);
  }
  const pythonTags = pythonTag.split(".");
  const abiTags = abiTag.split(".");
  const platformTags = platformTag.split(".");
  const pure = pythonTags.length > 0
    && pythonTags.every((tag) => tag === "py3")
    && abiTags.length === 1 && abiTags[0] === "none"
    && platformTags.length === 1 && platformTags[0] === "any";
  const binary = pythonTags.length > 0
    && pythonTags.every((tag) => tag === "cp310")
    && abiTags.length > 0 && abiTags.every((tag) => tag === "cp310")
    && platformTags.length > 0
    && platformTags.every((tag) => /^manylinux(?:[0-9]+|_[0-9]+_[0-9]+)_x86_64$/.test(tag));
  if (!pure && !binary) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_TAG", filenameValue);
  }
  return { abiTag, platformTag, pythonTag };
};

const sameDistributionSet = (left, right) => left.length === right.length
  && left.every((entry, index) => entry.name === right[index].name && entry.version === right[index].version);

const nodePackageName = (packagePath, entry) => {
  const explicit = normalizeDistributionName(entry?.name);
  if (explicit) return explicit;
  const marker = "node_modules/";
  const index = String(packagePath || "").lastIndexOf(marker);
  return normalizeDistributionName(index >= 0 ? String(packagePath).slice(index + marker.length) : packagePath);
};

const normalizeNodeLockInventory = (packageLock) => {
  if (!packageLock || typeof packageLock !== "object" || Array.isArray(packageLock)
    || !Number.isInteger(Number(packageLock.lockfileVersion))
    || !packageLock.packages || typeof packageLock.packages !== "object" || Array.isArray(packageLock.packages)) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_NODE_LOCK_INVALID", "package-lock shape");
  }
  const rows = [];
  for (const [packagePath, entry] of Object.entries(packageLock.packages)) {
    if (!packagePath) continue;
    const name = nodePackageName(packagePath, entry);
    const version = String(entry?.version || "").trim();
    const resolved = String(entry?.resolved || "").trim();
    const integrity = String(entry?.integrity || "").trim();
    let resolvedUrl;
    try { resolvedUrl = new URL(resolved); } catch {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_NODE_PROVENANCE", packagePath);
    }
    if (!name || !version || resolvedUrl.protocol !== "https:" || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity)) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_NODE_PROVENANCE", packagePath);
    }
    rows.push({
      dev: entry.dev === true,
      integrity,
      name,
      optional: entry.optional === true,
      packagePath,
      peer: entry.peer === true,
      resolved,
      version,
    });
  }
  return rows.sort((left, right) => compareCanonicalUtf8(left.packagePath, right.packagePath));
};

const readDependencyFile = (root, relativePath, maxBytes) => {
  const validatedPath = validateRelativePayloadPath(relativePath);
  return readStableReleaseFile({
    root,
    relativePath: validatedPath,
    maxBytes,
    codes: PAYLOAD_FILE_CODES,
  }).data;
};

const computeDependencyRoot = ({
  releaseRoot = defaultReleaseRoot,
  installedDistributions,
  expectedDependencyRoot = "",
  packageLockPath = "package-lock.json",
  pythonLockPath = DEFAULT_PYTHON_LOCK,
  wheelManifestPath = DEFAULT_WHEEL_MANIFEST,
} = {}) => {
  const root = path.resolve(String(releaseRoot || defaultReleaseRoot));
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_MISSING", root);
  }
  if (realRoot !== root || fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_INVALID_ROOT", root);
  }
  const packageLockBytes = readDependencyFile(root, packageLockPath, 32 * 1024 * 1024);
  const pythonLockBytes = readDependencyFile(root, pythonLockPath, 16 * 1024 * 1024);
  const wheelManifestBytes = readDependencyFile(root, wheelManifestPath, 16 * 1024 * 1024);
  let packageLock;
  let wheelManifest;
  try {
    packageLock = JSON.parse(packageLockBytes.toString("utf8"));
    wheelManifest = JSON.parse(wheelManifestBytes.toString("utf8"));
  } catch {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_INVALID_JSON", root);
  }
  const nodeInventory = normalizeNodeLockInventory(packageLock);
  const lockInventory = parsePythonLockInventory(pythonLockBytes);
  const installedInventory = normalizeInstalledDistributions(installedDistributions);
  if (!exactKeys(wheelManifest, DEPENDENCY_MANIFEST_KEYS)
    || wheelManifest.schema !== "gigabrain.memory-api-wheelhouse/1"
    || wheelManifest.python !== "3.10"
    || wheelManifest.platform !== "linux-x86_64"
    || wheelManifest.lockFile !== path.posix.basename(pythonLockPath)
    || !Array.isArray(wheelManifest.packages)
    || !SHA256_RE.test(String(wheelManifest.lockSha256 || ""))
    || !SHA256_RE.test(String(wheelManifest.inventorySha256 || ""))) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_MANIFEST", wheelManifestPath);
  }
  if (wheelManifest.index !== APPROVED_PYPI_INDEX) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE", "manifest index");
  }
  const wheelInventorySha256 = sha256(JSON.stringify(wheelManifest.packages));
  if (wheelInventorySha256 !== wheelManifest.inventorySha256) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_HASH", wheelManifestPath);
  }
  const wheelInventory = [];
  const lockByName = new Map(lockInventory.map((entry) => [entry.name, entry]));
  const seenWheels = new Set();
  let priorWheelName = "";
  for (const entry of wheelManifest.packages) {
    if (!exactKeys(entry, WHEEL_PACKAGE_KEYS)) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE", "wheel entry shape");
    }
    const name = normalizeDistributionName(entry.name);
    const version = String(entry.version || "").trim();
    const filename = entry.filename;
    const index = entry.index;
    const digest = String(entry.sha256 || "").trim();
    if (!name || !version || seenWheels.has(name) || (priorWheelName && compareCanonicalUtf8(priorWheelName, name) >= 0)
      || entry.name !== String(entry.name).trim() || entry.version !== version
      || index !== APPROVED_PYPI_INDEX || !SHA256_RE.test(digest)) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE", name || filename || "wheel entry");
    }
    validateWheelFilename(filename, name, version);
    const locked = lockByName.get(name);
    if (!locked || locked.version !== version || !locked.hashes.includes(digest)) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_LOCK_HASH", `${name}==${version}`);
    }
    seenWheels.add(name);
    priorWheelName = name;
    wheelInventory.push({ name, version });
  }
  const pythonLockSha256 = sha256(pythonLockBytes);
  if (pythonLockSha256 !== wheelManifest.lockSha256) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_LOCK_HASH", pythonLockPath);
  }
  if (!sameDistributionSet(lockInventory, wheelInventory)) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_LOCK_INVENTORY", pythonLockPath);
  }
  if (!sameDistributionSet(lockInventory, installedInventory)) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_INSTALLED_MISMATCH", "installed distribution set");
  }
  const packageLockSha256 = sha256(packageLockBytes);
  const installedInventorySha256 = sha256(JSON.stringify(installedInventory));
  const nodeRoot = sha256(canonicalJson({ packageLockSha256, packages: nodeInventory }));
  const pythonRoot = sha256(canonicalJson({
    index: String(wheelManifest.index),
    installedInventorySha256,
    python: wheelManifest.python,
    pythonLockSha256,
    platform: wheelManifest.platform,
    wheelInventorySha256,
    wheelManifestSha256: sha256(wheelManifestBytes),
  }));
  const dependencyRoot = sha256(canonicalJson({ nodeRoot, pythonRoot }));
  const expected = String(expectedDependencyRoot || "").trim();
  if (expected && (!SHA256_RE.test(expected) || expected !== dependencyRoot)) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_ROOT_MISMATCH", dependencyRoot);
  }
  return Object.freeze({
    dependencyRoot,
    nodeRoot,
    pythonRoot,
    packageLockSha256,
    pythonLockSha256,
    wheelInventorySha256,
    installedInventorySha256,
    nodePackages: nodeInventory.length,
    pythonDistributions: installedInventory.length,
  });
};

const resolveCanonicalReleaseRoot = (releaseRoot, missingCode, invalidCode) => {
  const root = path.resolve(String(releaseRoot || defaultReleaseRoot));
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch {
    throw provenanceError(missingCode, root);
  }
  const rootStat = fs.lstatSync(root);
  if (realRoot !== root || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw provenanceError(invalidCode, root);
  }
  return root;
};

const listUnexcludedPayloadFiles = (root) => {
  const files = [];
  const walk = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCanonicalUtf8(left.name, right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcludedReleasePayloadPath(relativePath)) continue;
      const absolutePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_SYMLINK", relativePath);
      if (stat.isDirectory()) walk(absolutePath, relativePath);
      else if (stat.isFile()) {
        if (stat.nlink !== 1) throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_HARDLINK", relativePath);
        files.push(relativePath);
      }
      else throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_TYPE", relativePath);
    }
  };
  walk(root);
  return files.sort(compareCanonicalUtf8);
};

const validateReleaseManifestShape = (manifest) => {
  if (!exactKeys(manifest, MANIFEST_KEYS) || manifest.schema_id !== RELEASE_MANIFEST_SCHEMA || !Array.isArray(manifest.entries)) {
    throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", "manifest shape");
  }
  const seen = new Set();
  let previousPath = "";
  for (const entry of manifest.entries) {
    if (!exactKeys(entry, MANIFEST_ENTRY_KEYS)) throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", "entry shape");
    const relativePath = validateRelativePayloadPath(entry.relative_path);
    if (seen.has(relativePath)) throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", `duplicate ${relativePath}`);
    if (previousPath && compareCanonicalUtf8(previousPath, relativePath) >= 0) {
      throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", "entries are not strictly sorted");
    }
    seen.add(relativePath);
    previousPath = relativePath;
    if (entry.type !== "file" || !["100644", "100755"].includes(entry.mode)
      || typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", relativePath);
    }
  }
  return { seen };
};

const serializeReleaseManifest = (manifest) => {
  validateReleaseManifestShape(manifest);
  return Buffer.from(canonicalJson(manifest));
};

const buildReleasePayloadManifest = ({ releaseRoot = defaultReleaseRoot } = {}) => {
  const root = resolveCanonicalReleaseRoot(
    releaseRoot,
    "GIGABRAIN_RELEASE_PROVENANCE_MISSING",
    "GIGABRAIN_RELEASE_PAYLOAD_SYMLINK",
  );
  const entries = listUnexcludedPayloadFiles(root).map((relativePath) => {
    const payload = readStableReleaseFile({
      root,
      relativePath,
      maxBytes: 256 * 1024 * 1024,
      codes: PAYLOAD_FILE_CODES,
      requireCanonicalMode: true,
    });
    const actualMode = requireCanonicalFileMode(payload.stat, PAYLOAD_FILE_CODES.mode, relativePath);
    return { mode: actualMode, relative_path: relativePath, sha256: sha256(payload.data), type: "file" };
  });
  const manifest = { entries, schema_id: RELEASE_MANIFEST_SCHEMA };
  validateReleaseManifestShape(manifest);
  return manifest;
};

const verifyReleasePayload = ({ manifest, manifestBytes, root }) => {
  const canonicalRoot = resolveCanonicalReleaseRoot(
    root,
    "GIGABRAIN_RELEASE_PROVENANCE_MISSING",
    "GIGABRAIN_RELEASE_PAYLOAD_SYMLINK",
  );
  const { seen } = validateReleaseManifestShape(manifest);
  if (serializeReleaseManifest(manifest).compare(Buffer.from(manifestBytes)) !== 0) {
    throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", "manifest is not canonical JSON");
  }
  for (const entry of manifest.entries) {
    const relativePath = entry.relative_path;
    const payload = readStableReleaseFile({
      root: canonicalRoot,
      relativePath,
      maxBytes: 256 * 1024 * 1024,
      codes: PAYLOAD_FILE_CODES,
      requireCanonicalMode: true,
    });
    const actualMode = requireCanonicalFileMode(payload.stat, PAYLOAD_FILE_CODES.mode, relativePath);
    if (actualMode !== entry.mode) throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_MODE", relativePath);
    if (sha256(payload.data) !== entry.sha256) throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_DIGEST", relativePath);
  }
  const actualFiles = listUnexcludedPayloadFiles(canonicalRoot);
  if (actualFiles.length !== seen.size || actualFiles.some((relativePath) => !seen.has(relativePath))) {
    const unmanifested = actualFiles.find((relativePath) => !seen.has(relativePath)) || "payload inventory mismatch";
    throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_UNMANIFESTED", unmanifested);
  }
  return { files: actualFiles.length, verified: true };
};

const validateLocalIntegrityManifestShape = (manifest) => {
  if (!exactKeys(manifest, LOCAL_INTEGRITY_MANIFEST_KEYS)
    || manifest.schema_id !== LOCAL_INTEGRITY_MANIFEST_SCHEMA
    || !Array.isArray(manifest.entries)) {
    throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID", "manifest shape");
  }
  const seen = new Set();
  let previousPath = "";
  for (const entry of manifest.entries) {
    if (!exactKeys(entry, MANIFEST_ENTRY_KEYS)) {
      throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID", "entry shape");
    }
    const relativePath = validateRelativeLocalIntegrityPath(entry.relative_path);
    if (seen.has(relativePath)) {
      throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID", `duplicate ${relativePath}`);
    }
    if (previousPath && compareCanonicalUtf8(previousPath, relativePath) >= 0) {
      throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID", "entries are not strictly sorted");
    }
    if (entry.type !== "file" || !["100644", "100755"].includes(entry.mode)
      || typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID", relativePath);
    }
    seen.add(relativePath);
    previousPath = relativePath;
  }
  return { seen };
};

const serializeLocalIntegrityManifest = (manifest) => {
  validateLocalIntegrityManifestShape(manifest);
  return Buffer.from(canonicalJson(manifest));
};

const computeLocalIntegrity = ({ releaseRoot = defaultReleaseRoot } = {}) => {
  const root = resolveCanonicalReleaseRoot(
    releaseRoot,
    "GIGABRAIN_RELEASE_LOCAL_INTEGRITY_MISSING",
    "GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID_ROOT",
  );
  const entries = [];
  const walk = (directory, prefix = "") => {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCanonicalUtf8(left.name, right.name));
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (relativePath === "RELEASE.json" || relativePath === "RELEASE.manifest.json") continue;
      validateRelativeLocalIntegrityPath(relativePath);
      const absolutePath = path.join(directory, child.name);
      let fileStat;
      try {
        fileStat = fs.lstatSync(absolutePath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_UNSTABLE", relativePath);
        }
        throw error;
      }
      if (fileStat.isSymbolicLink()) {
        throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_SYMLINK", relativePath);
      }
      if (fileStat.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!fileStat.isFile()) {
        throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_TYPE", relativePath);
      }
      if (fileStat.nlink !== 1) {
        throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_HARDLINK", relativePath);
      }
      const stableFile = readStableReleaseFile({
        root,
        relativePath,
        maxBytes: 256 * 1024 * 1024,
        codes: LOCAL_INTEGRITY_FILE_CODES,
        requireCanonicalMode: true,
      });
      const mode = requireCanonicalFileMode(stableFile.stat, LOCAL_INTEGRITY_FILE_CODES.mode, relativePath);
      entries.push({ mode, relative_path: relativePath, sha256: sha256(stableFile.data), type: "file" });
    }
  };
  walk(root);
  entries.sort((left, right) => compareCanonicalUtf8(left.relative_path, right.relative_path));
  const manifest = { entries, schema_id: LOCAL_INTEGRITY_MANIFEST_SCHEMA };
  const manifestBytes = serializeLocalIntegrityManifest(manifest);
  return Object.freeze({
    localIntegrityRoot: sha256(manifestBytes),
    manifest,
    manifestBytes,
  });
};

const verifyLocalIntegrity = ({
  manifest,
  manifestBytes,
  releaseRoot = defaultReleaseRoot,
  expectedLocalIntegrityRoot = "",
} = {}) => {
  const serialized = serializeLocalIntegrityManifest(manifest);
  let suppliedBytes;
  try { suppliedBytes = Buffer.from(manifestBytes); } catch {
    throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID", "manifest bytes");
  }
  if (serialized.compare(suppliedBytes) !== 0) {
    throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID", "manifest is not canonical JSON");
  }
  const localIntegrityRoot = sha256(suppliedBytes);
  const expected = String(expectedLocalIntegrityRoot || "").trim();
  if (expected && (!SHA256_RE.test(expected) || expected !== localIntegrityRoot)) {
    throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_ROOT_MISMATCH", localIntegrityRoot);
  }
  const actual = computeLocalIntegrity({ releaseRoot });
  if (actual.localIntegrityRoot !== localIntegrityRoot || actual.manifestBytes.compare(suppliedBytes) !== 0) {
    throw provenanceError("GIGABRAIN_RELEASE_LOCAL_INTEGRITY_ROOT_MISMATCH", actual.localIntegrityRoot);
  }
  return Object.freeze({
    files: manifest.entries.length,
    localIntegrityRoot,
    verified: true,
  });
};

const loadReleaseProvenance = (releaseRoot = defaultReleaseRoot) => {
  const root = resolveCanonicalReleaseRoot(
    releaseRoot,
    "GIGABRAIN_RELEASE_PROVENANCE_MISSING",
    "GIGABRAIN_RELEASE_PAYLOAD_SYMLINK",
  );
  const releasePath = path.join(root, "RELEASE.json");
  const manifestPath = path.join(root, "RELEASE.manifest.json");
  let release;
  let manifestBytes;
  try {
    const releaseBytes = readStableReleaseFile({
      root,
      relativePath: "RELEASE.json",
      maxBytes: 256 * 1024,
      codes: PROVENANCE_FILE_CODES,
    }).data;
    release = JSON.parse(releaseBytes.toString("utf8"));
    manifestBytes = readStableReleaseFile({
      root,
      relativePath: "RELEASE.manifest.json",
      maxBytes: 16 * 1024 * 1024,
      codes: PROVENANCE_FILE_CODES,
    }).data;
  } catch (error) {
    if (error?.code === "ENOENT") throw provenanceError("GIGABRAIN_RELEASE_PROVENANCE_MISSING", root);
    if (error instanceof SyntaxError) throw provenanceError("GIGABRAIN_RELEASE_PROVENANCE_INVALID", releasePath);
    throw error;
  }
  if (!exactKeys(release, RELEASE_KEYS)) {
    throw provenanceError("GIGABRAIN_RELEASE_PROVENANCE_INVALID", "release fields");
  }
  const provenance = {};
  for (const field of RELEASE_PROVENANCE_FIELDS) {
    const fileField = RELEASE_FILE_FIELDS[field];
    const value = String(release?.[fileField] || "").trim();
    if (!value) throw provenanceError("GIGABRAIN_RELEASE_PROVENANCE_INVALID", fileField);
    provenance[field] = value;
  }
  for (const field of [
    "schemaChecksum",
    "payloadRoot",
    "manifestSha256",
    "dependencyRoot",
    "localIntegrityRoot",
  ]) {
    if (!SHA256_RE.test(provenance[field])) {
      throw provenanceError("GIGABRAIN_RELEASE_PROVENANCE_INVALID", RELEASE_FILE_FIELDS[field]);
    }
  }
  if (!CODE_SHA_RE.test(provenance.codeSha)) {
    throw provenanceError("GIGABRAIN_RELEASE_PROVENANCE_INVALID", "code_sha");
  }
  const actualManifestHash = sha256(manifestBytes);
  if (actualManifestHash !== provenance.manifestSha256 || actualManifestHash !== provenance.payloadRoot) {
    throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_MISMATCH", manifestPath);
  }
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch {
    throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", manifestPath);
  }
  verifyReleasePayload({ manifest, manifestBytes, root });
  return Object.freeze(provenance);
};

const serializeReleaseProvenance = (provenance) => {
  const out = {};
  for (const field of RELEASE_PROVENANCE_FIELDS) {
    const value = String(provenance?.[field] || "").trim();
    if (!value) throw provenanceError("GIGABRAIN_RELEASE_PROVENANCE_INVALID", field);
    out[RELEASE_FILE_FIELDS[field]] = value;
  }
  return out;
};

const attachReleaseProvenance = (payload = {}, provenance) => ({
  ...(payload && typeof payload === "object" ? payload : {}),
  release: serializeReleaseProvenance(provenance),
});

const tryLoadReleaseProvenance = (releaseRoot = defaultReleaseRoot) => {
  if (!fs.existsSync(path.join(path.resolve(releaseRoot), "RELEASE.json"))) return null;
  return loadReleaseProvenance(releaseRoot);
};

export {
  RELEASE_PROVENANCE_FIELDS,
  attachReleaseProvenance,
  buildReleasePayloadManifest,
  compareCanonicalUtf8,
  computeDependencyRoot,
  computeLocalIntegrity,
  isExcludedReleasePayloadPath,
  loadReleaseProvenance,
  serializeLocalIntegrityManifest,
  serializeReleaseManifest,
  serializeReleaseProvenance,
  tryLoadReleaseProvenance,
  verifyLocalIntegrity,
  verifyReleasePayload,
};

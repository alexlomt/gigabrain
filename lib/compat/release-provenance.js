import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readRegularFileWithStatNoFollowSync } from "../core/safe-fs.js";

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
const RELEASE_KEYS = Object.freeze(Object.values(RELEASE_FILE_FIELDS).sort());
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

const provenanceError = (code, detail) => {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
};

const defaultReleaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const exactKeys = (value, expected) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isExcludedPayloadPath = (relativePath) => {
  if (relativePath === "RELEASE.json" || relativePath === "RELEASE.manifest.json") return true;
  const segments = String(relativePath || "").split("/");
  return segments.some((segment) => PAYLOAD_EXCLUDED_SEGMENTS.has(segment)) || relativePath.endsWith(".pyc");
};

const validateRelativePayloadPath = (relativePath) => {
  const value = String(relativePath || "");
  if (
    !value
    || value.trim() !== value
    || value.includes("\\")
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || isExcludedPayloadPath(value)
  ) throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", value || "empty payload path");
  return value;
};

const resolveNoFollowPayloadFile = (root, relativePath) => {
  let cursor = root;
  for (const segment of relativePath.split("/")) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch {
      throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_MISSING", relativePath);
    }
    if (stat.isSymbolicLink()) throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_SYMLINK", relativePath);
  }
  const stat = fs.lstatSync(cursor);
  if (!stat.isFile()) throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_TYPE", relativePath);
  return { absolutePath: cursor, stat };
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
  return normalized.sort((left, right) => left.name.localeCompare(right.name, "en"));
};

const parsePythonLockInventory = (lockBytes) => {
  const rows = [];
  const seen = new Set();
  const source = Buffer.from(lockBytes).toString("utf8");
  for (const match of source.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+)(?:\s|\\|$)/gm)) {
    const name = normalizeDistributionName(match[1]);
    const version = String(match[2] || "").trim();
    if (!name || !version || seen.has(name)) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_LOCK_INVALID", name || "empty distribution");
    }
    seen.add(name);
    rows.push({ name, version });
  }
  if (rows.length === 0) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_LOCK_INVALID", "no pinned distributions");
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name, "en"));
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
  return rows.sort((left, right) => left.packagePath.localeCompare(right.packagePath, "en"));
};

const readDependencyFile = (root, relativePath, maxBytes) => {
  const resolved = resolveNoFollowPayloadFile(root, relativePath);
  return readRegularFileWithStatNoFollowSync(resolved.absolutePath, null, { maxBytes }).data;
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
  let manifestIndex;
  try { manifestIndex = new URL(String(wheelManifest.index || "")); } catch {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE", "manifest index");
  }
  if (manifestIndex.protocol !== "https:") {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE", "manifest index");
  }
  const wheelInventory = [];
  const seenWheels = new Set();
  let priorWheelName = "";
  for (const entry of wheelManifest.packages) {
    if (!exactKeys(entry, WHEEL_PACKAGE_KEYS)) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE", "wheel entry shape");
    }
    const name = normalizeDistributionName(entry.name);
    const version = String(entry.version || "").trim();
    const filename = String(entry.filename || "").trim();
    const index = String(entry.index || "").trim();
    const digest = String(entry.sha256 || "").trim();
    if (!name || !version || seenWheels.has(name) || (priorWheelName && priorWheelName.localeCompare(name, "en") >= 0)
      || index !== String(wheelManifest.index) || !filename.endsWith(".whl") || !SHA256_RE.test(digest)) {
      throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE", name || filename || "wheel entry");
    }
    seenWheels.add(name);
    priorWheelName = name;
    wheelInventory.push({ name, version });
  }
  const pythonLockSha256 = sha256(pythonLockBytes);
  if (pythonLockSha256 !== wheelManifest.lockSha256) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_LOCK_HASH", pythonLockPath);
  }
  const wheelInventorySha256 = sha256(JSON.stringify(wheelManifest.packages));
  if (wheelInventorySha256 !== wheelManifest.inventorySha256) {
    throw provenanceError("GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_HASH", wheelManifestPath);
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

const listUnexcludedPayloadFiles = (root) => {
  const files = [];
  const walk = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcludedPayloadPath(relativePath)) continue;
      const absolutePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_SYMLINK", relativePath);
      if (stat.isDirectory()) walk(absolutePath, relativePath);
      else if (stat.isFile()) files.push(relativePath);
      else throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_TYPE", relativePath);
    }
  };
  walk(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
};

const verifyReleasePayload = ({ manifest, manifestBytes, root }) => {
  if (!exactKeys(manifest, MANIFEST_KEYS) || typeof manifest.schema_id !== "string" || !manifest.schema_id.trim() || !Array.isArray(manifest.entries)) {
    throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", "manifest shape");
  }
  if (Buffer.from(canonicalJson(manifest)).compare(Buffer.from(manifestBytes)) !== 0) {
    throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", "manifest is not canonical JSON");
  }
  const seen = new Set();
  let previousPath = "";
  for (const entry of manifest.entries) {
    if (!exactKeys(entry, MANIFEST_ENTRY_KEYS)) throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", "entry shape");
    const relativePath = validateRelativePayloadPath(entry.relative_path);
    if (seen.has(relativePath)) throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", `duplicate ${relativePath}`);
    if (previousPath && previousPath.localeCompare(relativePath, "en") >= 0) {
      throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", "entries are not strictly sorted");
    }
    seen.add(relativePath);
    previousPath = relativePath;
    if (entry.type !== "file" || !["100644", "100755"].includes(entry.mode) || !SHA256_RE.test(String(entry.sha256 || ""))) {
      throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", relativePath);
    }
    const payload = resolveNoFollowPayloadFile(root, relativePath);
    const actualMode = `100${(payload.stat.mode & 0o777).toString(8).padStart(3, "0")}`;
    if (actualMode !== entry.mode) throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_MODE", relativePath);
    const bytes = readRegularFileWithStatNoFollowSync(payload.absolutePath, null, { maxBytes: 256 * 1024 * 1024 }).data;
    if (sha256(bytes) !== entry.sha256) throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_DIGEST", relativePath);
  }
  const actualFiles = listUnexcludedPayloadFiles(root);
  if (actualFiles.length !== seen.size || actualFiles.some((relativePath) => !seen.has(relativePath))) {
    const unmanifested = actualFiles.find((relativePath) => !seen.has(relativePath)) || "payload inventory mismatch";
    throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_UNMANIFESTED", unmanifested);
  }
  return { files: actualFiles.length, verified: true };
};

const loadReleaseProvenance = (releaseRoot = defaultReleaseRoot) => {
  const root = path.resolve(String(releaseRoot || defaultReleaseRoot));
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch {
    throw provenanceError("GIGABRAIN_RELEASE_PROVENANCE_MISSING", root);
  }
  if (realRoot !== root || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw provenanceError("GIGABRAIN_RELEASE_PAYLOAD_SYMLINK", root);
  }
  const releasePath = path.join(root, "RELEASE.json");
  const manifestPath = path.join(root, "RELEASE.manifest.json");
  let release;
  let manifestBytes;
  try {
    release = JSON.parse(readRegularFileWithStatNoFollowSync(releasePath, "utf8", { maxBytes: 256 * 1024 }).data);
    manifestBytes = readRegularFileWithStatNoFollowSync(manifestPath, null, { maxBytes: 16 * 1024 * 1024 }).data;
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
  computeDependencyRoot,
  loadReleaseProvenance,
  serializeReleaseProvenance,
  tryLoadReleaseProvenance,
  verifyReleasePayload,
};

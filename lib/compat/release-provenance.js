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

const provenanceError = (code, detail) => {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
};

const defaultReleaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const loadReleaseProvenance = (releaseRoot = defaultReleaseRoot) => {
  const root = path.resolve(String(releaseRoot || defaultReleaseRoot));
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
  try {
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (!Array.isArray(manifest?.entries) || typeof manifest?.schema_id !== "string") {
      throw new Error("invalid manifest");
    }
  } catch {
    throw provenanceError("GIGABRAIN_RELEASE_MANIFEST_INVALID", manifestPath);
  }
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
  loadReleaseProvenance,
  serializeReleaseProvenance,
  tryLoadReleaseProvenance,
};

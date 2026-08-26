import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_RELEASE_PROVENANCE missing immutable release identity round-trip";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const makeRelease = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task5-release-"));
  mkdirSync(path.join(root, "lib"), { recursive: true });
  writeFileSync(path.join(root, "lib", "fixture.js"), "export const fixture = true;\n");
  const manifest = {
    entries: [{
      mode: "100644",
      relative_path: "lib/fixture.js",
      sha256: sha(readFileSync(path.join(root, "lib", "fixture.js"))),
      type: "file",
    }],
    schema_id: "gigabrain-release-manifest.1",
  };
  const manifestBytes = canonicalJson(manifest);
  writeFileSync(path.join(root, "RELEASE.manifest.json"), manifestBytes);
  const release = {
    code_sha: "0123456789abcdef0123456789abcdef01234567",
    dependency_root: sha("synthetic-dependencies"),
    immutable_tag: "gigabrain-v0.11.0-openclaw.1-rc.1",
    local_integrity_root: sha("synthetic-installed-tree"),
    manifest_sha256: sha(manifestBytes),
    package_version: "0.11.0-openclaw.1",
    payload_root: sha(manifestBytes),
    schema_checksum: sha("synthetic-schema"),
    schema_id: "gigabrain-schema.3",
    upstream_version: "0.11.0",
  };
  writeFileSync(path.join(root, "RELEASE.json"), canonicalJson(release));
  return { root, release };
};

export async function run() {
  const provenance = await importContractModule("lib/compat/release-provenance.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const load = requireCallable(provenance, "loadReleaseProvenance");
    const serialize = requireCallable(provenance, "serializeReleaseProvenance");
    const attach = requireCallable(provenance, "attachReleaseProvenance");
    const fixture = makeRelease();
    try {
      const loaded = load(fixture.root);
      assert.deepEqual(Object.keys(loaded), provenance.RELEASE_PROVENANCE_FIELDS);
      assert.deepEqual(loaded, {
        packageVersion: fixture.release.package_version,
        upstreamVersion: fixture.release.upstream_version,
        codeSha: fixture.release.code_sha,
        immutableTag: fixture.release.immutable_tag,
        schemaId: fixture.release.schema_id,
        schemaChecksum: fixture.release.schema_checksum,
        payloadRoot: fixture.release.payload_root,
        manifestSha256: fixture.release.manifest_sha256,
        dependencyRoot: fixture.release.dependency_root,
        localIntegrityRoot: fixture.release.local_integrity_root,
      });
      const serialized = serialize(loaded);
      assert.deepEqual(Object.keys(serialized), [
        "package_version", "upstream_version", "code_sha", "immutable_tag", "schema_id",
        "schema_checksum", "payload_root", "manifest_sha256", "dependency_root", "local_integrity_root",
      ]);
      for (const surface of ["status", "health", "doctor", "migration_receipt"]) {
        const roundTrip = attach({ ok: true, surface }, loaded);
        assert.deepEqual(roundTrip.release, serialized, `${surface} must preserve every release field`);
      }
      const manifestPath = path.join(fixture.root, "RELEASE.manifest.json");
      writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")} `);
      assert.throws(() => load(fixture.root), /GIGABRAIN_RELEASE_MANIFEST_MISMATCH/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

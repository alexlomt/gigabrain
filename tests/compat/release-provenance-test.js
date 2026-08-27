import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runMemoryStatus } from "../../lib/compat/openclaw-memory-cli.js";
import { runDoctor } from "../../lib/core/codex-service.js";
import { createMemoryHttpHandler } from "../../lib/core/http-routes.js";

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

const makeReleaseBinding = (immutableTag = "v0.11.0-openclaw.1-rc.7") => ({
  code_sha: "0123456789abcdef0123456789abcdef01234567",
  dependency_root: sha("canonical-dependencies"),
  immutable_tag: immutableTag,
  manifest_sha256: sha("canonical-payload"),
  package_version: "0.11.0-openclaw.1",
  payload_root: sha("canonical-payload"),
  schema_checksum: sha("canonical-schema"),
  schema_id: "gigabrain-schema-0.11-compat-v1",
  upstream_version: "0.11.0",
});

const makeInstalledRelease = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task15-installed-release-"));
  const files = new Map([
    ["lib/_a.js", "export const underscore = true;\n"],
    ["lib/-a.js", "export const dash = true;\n"],
    ["lib/a.js", "export const lower = true;\n"],
    ["lib/A.js", "export const upper = true;\n"],
    ["lib/ä.js", "export const nonAscii = true;\n"],
    ["scripts/run", "#!/usr/bin/env node\n"],
    ["node_modules/example/index.js", "module.exports = true;\n"],
    ["memory_api/.venv-v0.11-dev/probe.py", "dev_only = True\n"],
    ["memory_api/.venv-v0.11-prod/lib/python3.10/site-packages/example.py", "installed = True\n"],
    ["runtime/ignored.json", "{}\n"],
  ]);
  for (const [relativePath, body] of files) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, body, { mode: relativePath === "scripts/run" ? 0o755 : 0o644 });
    chmodSync(absolutePath, relativePath === "scripts/run" ? 0o755 : 0o644);
  }
  return { files, root };
};

const writeReleaseDocuments = (root, manifest, releaseOverrides = {}) => {
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
    ...releaseOverrides,
  };
  writeFileSync(path.join(root, "RELEASE.json"), canonicalJson(release));
  return release;
};

const makeRelease = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task5-release-"));
  mkdirSync(path.join(root, "lib"), { recursive: true });
  writeFileSync(path.join(root, "lib", "fixture.js"), "export const fixture = true;\n", { mode: 0o644 });
  chmodSync(path.join(root, "lib", "fixture.js"), 0o644);
  const manifest = {
    entries: [{
      mode: "100644",
      relative_path: "lib/fixture.js",
      sha256: sha(readFileSync(path.join(root, "lib", "fixture.js"))),
      type: "file",
    }],
    schema_id: "gigabrain-release-manifest.1",
  };
  const release = writeReleaseDocuments(root, manifest);
  return { manifest, root, release };
};

const writeDependencyManifest = (root, manifest) => {
  writeFileSync(
    path.join(root, "memory_api", "wheelhouse-py310-linux-x86_64.manifest.json"),
    canonicalJson(manifest),
  );
};

const makeDependencyFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task11-dependencies-"));
  mkdirSync(path.join(root, "memory_api"), { recursive: true });
  const nodeEntry = (packageName, byte) => ({
    version: "1.2.3",
    resolved: `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${encodeURIComponent(packageName)}-1.2.3.tgz`,
    integrity: `sha512-${Buffer.alloc(64, byte).toString("base64")}`,
  });
  const packageLock = {
    name: "synthetic-release",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "synthetic-release", version: "1.0.0", dependencies: { "node-alpha": "1.2.3" } },
      "node_modules/node-alpha": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/node-alpha/-/node-alpha-1.2.3.tgz",
        integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
      },
      "node_modules/-punctuation": nodeEntry("-punctuation", 8),
      "node_modules/A-case": nodeEntry("A-case", 9),
      "node_modules/_underscore": nodeEntry("_underscore", 10),
      "node_modules/a-case": nodeEntry("a-case", 11),
      "node_modules/ä-nonascii": nodeEntry("ä-nonascii", 12),
    },
  };
  writeFileSync(path.join(root, "package-lock.json"), canonicalJson(packageLock));
  const lockText = [
    "_leading==0.1.0 \\",
    `    --hash=sha256:${"c".repeat(64)}`,
    "alpha_py==1.0.0 \\",
    `    --hash=sha256:${"a".repeat(64)}`,
    "beta.pkg==2.0.0 \\",
    `    --hash=sha256:${"b".repeat(64)}`,
    "",
  ].join("\n");
  const lockPath = path.join(root, "memory_api", "requirements-prod-py310-linux-x86_64.lock");
  writeFileSync(lockPath, lockText);
  const packages = [
    {
      filename: "_leading-0.1.0-py3-none-any.whl",
      index: "https://pypi.org/simple",
      name: "-leading",
      sha256: "c".repeat(64),
      version: "0.1.0",
    },
    {
      filename: "alpha_py-1.0.0-py3-none-any.whl",
      index: "https://pypi.org/simple",
      name: "alpha-py",
      sha256: "a".repeat(64),
      version: "1.0.0",
    },
    {
      filename: "beta_pkg-2.0.0-py3-none-any.whl",
      index: "https://pypi.org/simple",
      name: "beta-pkg",
      sha256: "b".repeat(64),
      version: "2.0.0",
    },
  ];
  const manifest = {
    index: "https://pypi.org/simple",
    inventorySha256: sha(JSON.stringify(packages)),
    lockFile: "requirements-prod-py310-linux-x86_64.lock",
    lockSha256: sha(lockText),
    packages,
    platform: "linux-x86_64",
    python: "3.10",
    schema: "gigabrain.memory-api-wheelhouse/1",
  };
  writeDependencyManifest(root, manifest);
  return {
    installedDistributions: [
      { name: "Beta_Pkg", version: "2.0.0" },
      { name: "alpha.py", version: "1.0.0" },
      { name: "_leading", version: "0.1.0" },
    ],
    manifest,
    packageLock,
    root,
  };
};

export async function run() {
  const provenance = await importContractModule("lib/compat/release-provenance.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const load = requireCallable(provenance, "loadReleaseProvenance");
    const serialize = requireCallable(provenance, "serializeReleaseProvenance");
    const attach = requireCallable(provenance, "attachReleaseProvenance");
    const computeDependencyRoot = requireCallable(provenance, "computeDependencyRoot");
    const buildReleasePayloadManifest = requireCallable(provenance, "buildReleasePayloadManifest");
    const serializeReleaseManifest = requireCallable(provenance, "serializeReleaseManifest");
    const isExcludedReleasePayloadPath = requireCallable(provenance, "isExcludedReleasePayloadPath");
    const computeLocalIntegrity = requireCallable(provenance, "computeLocalIntegrity");
    const serializeLocalIntegrityManifest = requireCallable(provenance, "serializeLocalIntegrityManifest");
    const verifyLocalIntegrity = requireCallable(provenance, "verifyLocalIntegrity");
    const compareCanonicalUtf8 = requireCallable(provenance, "compareCanonicalUtf8");

    assert.deepEqual(
      ["ä", "A", "_", "-", "a"].sort(compareCanonicalUtf8),
      ["-", "A", "_", "a", "ä"],
      "cryptographic inventories must use canonical UTF-8 byte order across Node/ICU versions",
    );

    assert.equal(isExcludedReleasePayloadPath("memory_api/.venv-v0.11-prod"), true);
    assert.equal(isExcludedReleasePayloadPath("memory_api/.venv-v0.11-prod/bin/python"), true);
    assert.equal(isExcludedReleasePayloadPath("memory_api/.venv-v0.11-dev/bin/python"), false);
    assert.equal(isExcludedReleasePayloadPath("other/.venv-v0.11-prod/bin/python"), false);
    assert.equal(isExcludedReleasePayloadPath("memory_api/.venv-v0.11-prod-copy/bin/python"), false);

    const installedRelease = makeInstalledRelease();
    try {
      const manifest = buildReleasePayloadManifest({ releaseRoot: installedRelease.root });
      const expectedPayloadPaths = [
        "lib/-a.js",
        "lib/A.js",
        "lib/_a.js",
        "lib/a.js",
        "lib/ä.js",
        "memory_api/.venv-v0.11-dev/probe.py",
        "scripts/run",
      ];
      assert.deepEqual(manifest, {
        entries: expectedPayloadPaths.map((relativePath) => ({
          mode: relativePath === "scripts/run" ? "100755" : "100644",
          relative_path: relativePath,
          sha256: sha(installedRelease.files.get(relativePath)),
          type: "file",
        })),
        schema_id: "gigabrain-release-manifest.1",
      });
      const manifestBytes = serializeReleaseManifest(manifest);
      assert.ok(Buffer.isBuffer(manifestBytes));
      assert.equal(manifestBytes.toString("utf8"), canonicalJson(manifest));
      assert.equal(
        sha(manifestBytes),
        "e97994736874f79bfd7f75c8e2ae0540ca20bae576109d9b6fdc281737ffb002",
        "payload root must be byte-identical across Node 22/26 and ICU versions",
      );
      assert.throws(
        () => serializeReleaseManifest({ ...manifest, extra: true }),
        /GIGABRAIN_RELEASE_MANIFEST_INVALID/,
        "manifest serializer must reject extra top-level keys",
      );
      assert.throws(
        () => serializeReleaseManifest({
          ...manifest,
          entries: [{ ...manifest.entries[0], extra: true }, ...manifest.entries.slice(1)],
        }),
        /GIGABRAIN_RELEASE_MANIFEST_INVALID/,
        "manifest serializer must reject extra entry keys",
      );
      assert.throws(
        () => serializeReleaseManifest({ ...manifest, entries: [...manifest.entries].reverse() }),
        /GIGABRAIN_RELEASE_MANIFEST_INVALID/,
        "manifest serializer must reject noncanonical entry order",
      );
      assert.throws(
        () => serializeReleaseManifest({ ...manifest, schema_id: "unreviewed-release-manifest.1" }),
        /GIGABRAIN_RELEASE_MANIFEST_INVALID/,
        "Task 15 intentionally admits only the reviewed release-manifest schema",
      );
      assert.deepEqual(
        provenance.verifyReleasePayload({ manifest, manifestBytes, root: installedRelease.root }),
        { files: expectedPayloadPaths.length, verified: true },
      );

      const acceptedLocal = computeLocalIntegrity({ releaseRoot: installedRelease.root });
      assert.deepEqual(Object.keys(acceptedLocal), ["localIntegrityRoot", "manifest", "manifestBytes"]);
      assert.ok(Buffer.isBuffer(acceptedLocal.manifestBytes));
      assert.equal(sha(acceptedLocal.manifestBytes), acceptedLocal.localIntegrityRoot);
      assert.equal(
        acceptedLocal.localIntegrityRoot,
        "1dc1a6efe1eed0385d86c1329411e66c1da2899c0580c89da5b7589039028b55",
        "local root must be byte-identical across Node 22/26 and ICU versions",
      );
      assert.equal(acceptedLocal.manifestBytes.toString("utf8"), canonicalJson(acceptedLocal.manifest));
      assert.equal(
        serializeLocalIntegrityManifest(acceptedLocal.manifest).compare(acceptedLocal.manifestBytes),
        0,
      );
      const expectedLocalPaths = [
        "lib/-a.js",
        "lib/A.js",
        "lib/_a.js",
        "lib/a.js",
        "lib/ä.js",
        "memory_api/.venv-v0.11-dev/probe.py",
        "memory_api/.venv-v0.11-prod/lib/python3.10/site-packages/example.py",
        "node_modules/example/index.js",
        "runtime/ignored.json",
        "scripts/run",
      ];
      assert.deepEqual(acceptedLocal.manifest, {
        entries: expectedLocalPaths.map((relativePath) => ({
          mode: relativePath === "scripts/run" ? "100755" : "100644",
          relative_path: relativePath,
          sha256: sha(installedRelease.files.get(relativePath)),
          type: "file",
        })),
        schema_id: "gigabrain-local-integrity.1",
      });
      assert.deepEqual(
        verifyLocalIntegrity({
          manifest: acceptedLocal.manifest,
          manifestBytes: acceptedLocal.manifestBytes,
          releaseRoot: installedRelease.root,
          expectedLocalIntegrityRoot: acceptedLocal.localIntegrityRoot,
        }),
        {
          files: expectedLocalPaths.length,
          localIntegrityRoot: acceptedLocal.localIntegrityRoot,
          verified: true,
        },
      );
      const malformedLocalManifests = [
        { ...acceptedLocal.manifest, extra: true },
        { ...acceptedLocal.manifest, schema_id: "gigabrain-local-integrity.2" },
        {
          ...acceptedLocal.manifest,
          entries: [{ ...acceptedLocal.manifest.entries[0], extra: true }, ...acceptedLocal.manifest.entries.slice(1)],
        },
        { ...acceptedLocal.manifest, entries: [...acceptedLocal.manifest.entries].reverse() },
        {
          ...acceptedLocal.manifest,
          entries: [acceptedLocal.manifest.entries[0], ...acceptedLocal.manifest.entries],
        },
        {
          ...acceptedLocal.manifest,
          entries: [{ ...acceptedLocal.manifest.entries[0], relative_path: "../escape" }, ...acceptedLocal.manifest.entries.slice(1)],
        },
        {
          ...acceptedLocal.manifest,
          entries: [{ ...acceptedLocal.manifest.entries[0], relative_path: "lib\\escape" }, ...acceptedLocal.manifest.entries.slice(1)],
        },
        {
          ...acceptedLocal.manifest,
          entries: [{ ...acceptedLocal.manifest.entries[0], relative_path: " lib/a.js" }, ...acceptedLocal.manifest.entries.slice(1)],
        },
        {
          ...acceptedLocal.manifest,
          entries: [{ ...acceptedLocal.manifest.entries[0], mode: "100600" }, ...acceptedLocal.manifest.entries.slice(1)],
        },
        {
          ...acceptedLocal.manifest,
          entries: [{ ...acceptedLocal.manifest.entries[0], type: "symlink" }, ...acceptedLocal.manifest.entries.slice(1)],
        },
        {
          ...acceptedLocal.manifest,
          entries: [{ ...acceptedLocal.manifest.entries[0], sha256: "0".repeat(63) }, ...acceptedLocal.manifest.entries.slice(1)],
        },
      ];
      for (const malformed of malformedLocalManifests) {
        assert.throws(
          () => serializeLocalIntegrityManifest(malformed),
          /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID/,
        );
      }
      assert.throws(
        () => verifyLocalIntegrity({
          manifest: acceptedLocal.manifest,
          manifestBytes: Buffer.from(JSON.stringify(acceptedLocal.manifest)),
          releaseRoot: installedRelease.root,
        }),
        /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID/,
        "external local manifest must use exact canonical bytes",
      );
      assert.throws(
        () => verifyLocalIntegrity({
          manifest: acceptedLocal.manifest,
          manifestBytes: acceptedLocal.manifestBytes,
          releaseRoot: installedRelease.root,
          expectedLocalIntegrityRoot: "0".repeat(64),
        }),
        /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_ROOT_MISMATCH/,
      );
      assert.ok(
        acceptedLocal.manifest.entries.some(({ relative_path: relativePath }) => (
          relativePath === "memory_api/.venv-v0.11-prod/lib/python3.10/site-packages/example.py"
        )),
        "production venv must be excluded from the reproducible payload but covered by local integrity",
      );
      assert.ok(
        acceptedLocal.manifest.entries.some(({ relative_path: relativePath }) => relativePath.startsWith("node_modules/")),
        "installed Node dependencies must be covered by local integrity",
      );

      writeFileSync(
        path.join(installedRelease.root, "RELEASE.json"),
        canonicalJson({ ...makeReleaseBinding(), local_integrity_root: acceptedLocal.localIntegrityRoot }),
        { mode: 0o644 },
      );
      const rcLocal = computeLocalIntegrity({ releaseRoot: installedRelease.root });
      writeFileSync(
        path.join(installedRelease.root, "RELEASE.json"),
        canonicalJson({
          ...makeReleaseBinding("v0.11.0-openclaw.1"),
          local_integrity_root: acceptedLocal.localIntegrityRoot,
        }),
        { mode: 0o644 },
      );
      const finalLocal = computeLocalIntegrity({ releaseRoot: installedRelease.root });
      assert.deepEqual(finalLocal.manifest.entries, acceptedLocal.manifest.entries);
      assert.equal(
        finalLocal.localIntegrityRoot,
        rcLocal.localIntegrityRoot,
        "tag-only RC/final changes must not alter local integrity for a byte-identical tree",
      );

      const venvPath = path.join(
        installedRelease.root,
        "memory_api/.venv-v0.11-prod/lib/python3.10/site-packages/example.py",
      );
      writeFileSync(venvPath, "installed = False\n", { mode: 0o644 });
      const tamperedPayload = buildReleasePayloadManifest({ releaseRoot: installedRelease.root });
      const tamperedLocal = computeLocalIntegrity({ releaseRoot: installedRelease.root });
      assert.deepEqual(tamperedPayload, manifest, "venv-local drift must not change the application payload");
      assert.notEqual(tamperedLocal.localIntegrityRoot, acceptedLocal.localIntegrityRoot, "venv-local drift must change local integrity");
      assert.throws(
        () => verifyLocalIntegrity({
          manifest: acceptedLocal.manifest,
          manifestBytes: acceptedLocal.manifestBytes,
          releaseRoot: installedRelease.root,
          expectedLocalIntegrityRoot: acceptedLocal.localIntegrityRoot,
        }),
        /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_ROOT_MISMATCH/,
        "an external accepted manifest must fail against a drifted installed tree",
      );
    } finally {
      rmSync(installedRelease.root, { recursive: true, force: true });
    }

    const rejectInstalledTree = (label, mutate, expected) => {
      const candidate = makeInstalledRelease();
      try {
        mutate(candidate.root);
        assert.throws(
          () => buildReleasePayloadManifest({ releaseRoot: candidate.root }),
          expected.payload,
          `${label}: payload builder`,
        );
        assert.throws(
          () => computeLocalIntegrity({ releaseRoot: candidate.root }),
          expected.local,
          `${label}: local integrity`,
        );
      } finally {
        rmSync(candidate.root, { recursive: true, force: true });
      }
    };
    rejectInstalledTree("hard-linked file", (root) => {
      linkSync(path.join(root, "lib/a.js"), path.join(root, "lib/hardlink.js"));
    }, {
      payload: /GIGABRAIN_RELEASE_PAYLOAD_HARDLINK/,
      local: /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_HARDLINK/,
    });
    rejectInstalledTree("noncanonical mode", (root) => {
      chmodSync(path.join(root, "lib/a.js"), 0o600);
    }, {
      payload: /GIGABRAIN_RELEASE_PAYLOAD_MODE/,
      local: /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_MODE/,
    });
    for (const unsafeMode of [0o4755, 0o2755, 0o1755]) {
      rejectInstalledTree(`special permission bits ${unsafeMode.toString(8)}`, (root) => {
        chmodSync(path.join(root, "lib/a.js"), unsafeMode);
      }, {
        payload: /GIGABRAIN_RELEASE_PAYLOAD_MODE/,
        local: /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_MODE/,
      });
    }
    rejectInstalledTree("special filesystem object", (root) => {
      execFileSync("/usr/bin/mkfifo", [path.join(root, "lib/release.fifo")]);
    }, {
      payload: /GIGABRAIN_RELEASE_PAYLOAD_TYPE/,
      local: /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_TYPE/,
    });
    rejectInstalledTree("unsafe relative filename", (root) => {
      const unsafePath = path.join(root, "lib/trailing.js ");
      writeFileSync(unsafePath, "unsafe\n", { mode: 0o644 });
      chmodSync(unsafePath, 0o644);
    }, {
      payload: /GIGABRAIN_RELEASE_MANIFEST_INVALID/,
      local: /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_INVALID/,
    });

    const linkedVenv = makeInstalledRelease();
    try {
      const venvFile = path.join(
        linkedVenv.root,
        "memory_api/.venv-v0.11-prod/lib/python3.10/site-packages/example.py",
      );
      unlinkSync(venvFile);
      symlinkSync(path.join(linkedVenv.root, "lib/a.js"), venvFile);
      assert.doesNotThrow(
        () => buildReleasePayloadManifest({ releaseRoot: linkedVenv.root }),
        "reviewed production venv remains outside the reproducible payload",
      );
      assert.throws(
        () => computeLocalIntegrity({ releaseRoot: linkedVenv.root }),
        /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_SYMLINK/,
        "local integrity must reject links even inside payload-excluded installed dependencies",
      );
    } finally {
      rmSync(linkedVenv.root, { recursive: true, force: true });
    }

    const linkedRoot = makeInstalledRelease();
    const linkedRootPath = `${linkedRoot.root}-link`;
    try {
      const manifest = buildReleasePayloadManifest({ releaseRoot: linkedRoot.root });
      const manifestBytes = serializeReleaseManifest(manifest);
      symlinkSync(linkedRoot.root, linkedRootPath, "dir");
      assert.throws(
        () => provenance.verifyReleasePayload({ manifest, manifestBytes, root: linkedRootPath }),
        /GIGABRAIN_RELEASE_PAYLOAD_SYMLINK/,
        "the exported verifier must reject a symlink release root directly",
      );
    } finally {
      rmSync(linkedRootPath, { force: true });
      rmSync(linkedRoot.root, { recursive: true, force: true });
    }

    const assertReplacementRaceRejected = (operation, expected) => {
      const candidate = makeInstalledRelease();
      const target = path.join(candidate.root, "lib/a.js");
      const replacement = path.join(candidate.root, "lib/a.js.replacement");
      writeFileSync(replacement, "replacement inode\n", { mode: 0o644 });
      chmodSync(replacement, 0o644);
      const originalOpenSync = fs.openSync;
      let replaced = false;
      fs.openSync = function patchedOpenSync(filePath, ...args) {
        if (!replaced && path.resolve(String(filePath)) === target) {
          replaced = true;
          fs.renameSync(replacement, target);
        }
        return originalOpenSync.call(this, filePath, ...args);
      };
      try {
        assert.throws(
          () => operation(candidate.root),
          expected,
          "lstat metadata and opened content must be bound to one stable inode",
        );
        assert.equal(replaced, true, "replacement race hook must execute");
      } finally {
        fs.openSync = originalOpenSync;
        rmSync(candidate.root, { recursive: true, force: true });
      }
    };
    assertReplacementRaceRejected(
      (releaseRoot) => buildReleasePayloadManifest({ releaseRoot }),
      /GIGABRAIN_RELEASE_PAYLOAD_UNSTABLE/,
    );
    assertReplacementRaceRejected(
      (releaseRoot) => computeLocalIntegrity({ releaseRoot }),
      /GIGABRAIN_RELEASE_LOCAL_INTEGRITY_UNSTABLE/,
    );

    const dependencyFixture = makeDependencyFixture();
    try {
      const first = computeDependencyRoot({
        releaseRoot: dependencyFixture.root,
        installedDistributions: dependencyFixture.installedDistributions,
      });
      const second = computeDependencyRoot({
        releaseRoot: dependencyFixture.root,
        installedDistributions: [...dependencyFixture.installedDistributions].reverse(),
        expectedDependencyRoot: first.dependencyRoot,
      });
      assert.deepEqual(second, first, "dependency root must ignore installed-inventory ordering");
      assert.deepEqual(Object.keys(first), [
        "dependencyRoot",
        "nodeRoot",
        "pythonRoot",
        "packageLockSha256",
        "pythonLockSha256",
        "wheelInventorySha256",
        "installedInventorySha256",
        "nodePackages",
        "pythonDistributions",
      ]);
      for (const field of [
        "dependencyRoot", "nodeRoot", "pythonRoot", "packageLockSha256",
        "pythonLockSha256", "wheelInventorySha256", "installedInventorySha256",
      ]) assert.match(first[field], /^[0-9a-f]{64}$/);
      assert.equal(first.nodePackages, 6);
      assert.equal(first.pythonDistributions, 3);
      assert.equal(first.pythonLockSha256, dependencyFixture.manifest.lockSha256);
      assert.equal(first.wheelInventorySha256, dependencyFixture.manifest.inventorySha256);
      assert.equal(
        first.dependencyRoot,
        "3a8d7575e6fad9bb6e02808081c93b11c77453aad97bfaaf98827f9510d10870",
        "dependency root must be byte-identical across Node 22/26 and ICU versions",
      );
    } finally {
      rmSync(dependencyFixture.root, { recursive: true, force: true });
    }

    const rejectDependency = (label, mutate, expected = /GIGABRAIN_RELEASE_DEPENDENCY/) => {
      const candidate = makeDependencyFixture();
      try {
        const options = {
          releaseRoot: candidate.root,
          installedDistributions: candidate.installedDistributions,
        };
        mutate(candidate, options);
        assert.throws(() => computeDependencyRoot(options), expected, label);
      } finally {
        rmSync(candidate.root, { recursive: true, force: true });
      }
    };
    rejectDependency("inventory is mandatory", (_candidate, options) => {
      delete options.installedDistributions;
    }, /GIGABRAIN_RELEASE_DEPENDENCY_INVENTORY_REQUIRED/);
    rejectDependency("missing installed distribution", (candidate, options) => {
      options.installedDistributions = candidate.installedDistributions.slice(0, 1);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_INSTALLED_MISMATCH/);
    rejectDependency("extra installed distribution", (candidate, options) => {
      options.installedDistributions = [...candidate.installedDistributions, { name: "extra", version: "9.9.9" }];
    }, /GIGABRAIN_RELEASE_DEPENDENCY_INSTALLED_MISMATCH/);
    rejectDependency("installed version drift", (_candidate, options) => {
      options.installedDistributions = [{ name: "alpha-py", version: "1.0.1" }, { name: "beta-pkg", version: "2.0.0" }];
    }, /GIGABRAIN_RELEASE_DEPENDENCY_INSTALLED_MISMATCH/);
    rejectDependency("manifest lock hash drift", (candidate) => {
      candidate.manifest.lockSha256 = "0".repeat(64);
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_LOCK_HASH/);
    rejectDependency("wheel inventory hash drift", (candidate) => {
      candidate.manifest.packages.find((entry) => entry.name === "alpha-py").sha256 = "d".repeat(64);
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_HASH/);
    rejectDependency("wheel provenance drift", (candidate) => {
      candidate.manifest.packages[0].index = "https://mirror.invalid/simple";
      candidate.manifest.inventorySha256 = sha(JSON.stringify(candidate.manifest.packages));
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE/);
    rejectDependency("unauthorized wheel digest with recomputed inventory", (candidate) => {
      candidate.manifest.packages.find((entry) => entry.name === "alpha-py").sha256 = "d".repeat(64);
      candidate.manifest.inventorySha256 = sha(JSON.stringify(candidate.manifest.packages));
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_LOCK_HASH/);
    rejectDependency("arbitrary HTTPS mirror with recomputed inventory", (candidate) => {
      candidate.manifest.index = "https://mirror.invalid/simple";
      for (const entry of candidate.manifest.packages) entry.index = candidate.manifest.index;
      candidate.manifest.inventorySha256 = sha(JSON.stringify(candidate.manifest.packages));
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE/);
    const credentialUserinfoIndex = ["https://", "user", ":", "pass", "@", "pypi.org", "/simple"].join("");
    const credentialUserinfoUrl = new URL(credentialUserinfoIndex);
    assert.deepEqual(
      [credentialUserinfoUrl.username, credentialUserinfoUrl.password, credentialUserinfoUrl.host, credentialUserinfoUrl.pathname],
      ["user", "pass", "pypi.org", "/simple"],
      "credential userinfo fixture must retain its exact runtime URL semantics",
    );
    for (const invalidIndex of [
      credentialUserinfoIndex,
      "https://pypi.org/simple/",
      "https://pypi.org/simple?mirror=1",
      "https://pypi.org/simple#fragment",
    ]) rejectDependency(`noncanonical index ${invalidIndex}`, (candidate) => {
      candidate.manifest.index = invalidIndex;
      for (const entry of candidate.manifest.packages) entry.index = invalidIndex;
      candidate.manifest.inventorySha256 = sha(JSON.stringify(candidate.manifest.packages));
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE/);
    const rejectWheelFilename = (label, filename, expected) => rejectDependency(label, (candidate) => {
      candidate.manifest.packages.find((entry) => entry.name === "alpha-py").filename = filename;
      candidate.manifest.inventorySha256 = sha(JSON.stringify(candidate.manifest.packages));
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, expected);
    rejectWheelFilename(
      "wheel filename path traversal",
      "../alpha_py-1.0.0-py3-none-any.whl",
      /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_FILENAME/,
    );
    rejectWheelFilename(
      "wheel filename backslash path",
      "subdir\\alpha_py-1.0.0-py3-none-any.whl",
      /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_FILENAME/,
    );
    rejectWheelFilename(
      "wheel distribution mismatch",
      "wrong_name-1.0.0-py3-none-any.whl",
      /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_FILENAME/,
    );
    rejectWheelFilename(
      "wheel version mismatch",
      "alpha_py-9.9.9-py3-none-any.whl",
      /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_FILENAME/,
    );
    rejectWheelFilename(
      "wheel build tag is forbidden",
      "alpha_py-1.0.0-1-py3-none-any.whl",
      /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_FILENAME/,
    );
    rejectWheelFilename(
      "wheel Python tag mismatch",
      "alpha_py-1.0.0-cp311-cp311-manylinux_2_17_x86_64.whl",
      /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_TAG/,
    );
    rejectWheelFilename(
      "wheel ABI mismatch",
      "alpha_py-1.0.0-cp310-cp39-manylinux_2_17_x86_64.whl",
      /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_TAG/,
    );
    for (const [label, filename] of [
      ["Windows wheel", "alpha_py-1.0.0-cp310-cp310-win_amd64.whl"],
      ["macOS wheel", "alpha_py-1.0.0-cp310-cp310-macosx_12_0_x86_64.whl"],
      ["aarch64 wheel", "alpha_py-1.0.0-cp310-cp310-manylinux_2_17_aarch64.whl"],
    ]) rejectWheelFilename(label, filename, /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_TAG/);
    rejectDependency("lock and wheel set drift", (candidate) => {
      const alpha = candidate.manifest.packages.find((entry) => entry.name === "alpha-py");
      alpha.version = "1.0.1";
      alpha.filename = "alpha_py-1.0.1-py3-none-any.whl";
      candidate.manifest.inventorySha256 = sha(JSON.stringify(candidate.manifest.packages));
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_LOCK_HASH/);
    rejectDependency("node provenance drift", (candidate, options) => {
      const baseline = computeDependencyRoot(options);
      candidate.packageLock.packages["node_modules/node-alpha"].resolved = "https://mirror.invalid/node-alpha.tgz";
      writeFileSync(path.join(candidate.root, "package-lock.json"), canonicalJson(candidate.packageLock));
      options.expectedDependencyRoot = baseline.dependencyRoot;
    }, /GIGABRAIN_RELEASE_DEPENDENCY_ROOT_MISMATCH/);

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
      const workspace = `${fixture.root}-workspace`;
      mkdirSync(path.join(workspace, "memory"), { recursive: true });
      const config = {
        enabled: true,
        compat: { writeMode: "read_only" },
        releaseRoot: fixture.root,
        runtime: { paths: {
          workspaceRoot: workspace,
          memoryRoot: path.join(workspace, "memory"),
          registryPath: path.join(workspace, "memory", "registry.sqlite"),
          outputDir: path.join(workspace, "output"),
          reviewQueuePath: path.join(workspace, "output", "queue.jsonl"),
        } },
        native: { memoryMdPath: path.join(workspace, "MEMORY.md") },
        codex: { projectRoot: workspace, storeMode: "project", projectScope: "project:fixture" },
      };
      const io = { stdout: { write() {} } };
      const status = await runMemoryStatus({ config, io, options: { agent: "main" } });
      assert.deepEqual(status.release, serialized);
      const doctor = await runDoctor({ config, releaseRoot: fixture.root, target: "project", workspaceRoot: workspace });
      assert.deepEqual(doctor.release, serialized);
      let healthPayload = null;
      const handler = createMemoryHttpHandler({
        config,
        dbPath: config.runtime.paths.registryPath,
        token: "",
        allowNoAuth: true,
      });
      await handler(
        { headers: {}, method: "GET", url: "/gb/health" },
        {
          end(value) { healthPayload = JSON.parse(String(value)); },
          writeHead() {},
        },
      );
      assert.deepEqual(healthPayload.release, serialized);
      const codexMcpSource = readFileSync("lib/core/codex-mcp.js", "utf8");
      assert.match(codexMcpSource, /local_integrity_root/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(`${fixture.root}-workspace`, { recursive: true, force: true });
    }

    const rejectFixture = (label, mutate) => {
      const candidate = makeRelease();
      let extraCleanup = () => {};
      try {
        extraCleanup = mutate(candidate) || extraCleanup;
        assert.throws(
          () => load(candidate.root),
          /GIGABRAIN_RELEASE_(?:MANIFEST|PAYLOAD|PROVENANCE)/,
          label,
        );
      } finally {
        extraCleanup();
        rmSync(candidate.root, { recursive: true, force: true });
      }
    };

    rejectFixture("modified payload", ({ root }) => {
      writeFileSync(path.join(root, "lib", "fixture.js"), "tampered\n");
    });
    rejectFixture("missing payload", ({ root }) => {
      unlinkSync(path.join(root, "lib", "fixture.js"));
    });
    rejectFixture("chmod payload", ({ root }) => {
      chmodSync(path.join(root, "lib", "fixture.js"), 0o600);
    });
    rejectFixture("symlink payload", ({ root }) => {
      const outside = `${root}-outside`;
      writeFileSync(outside, "outside\n");
      unlinkSync(path.join(root, "lib", "fixture.js"));
      symlinkSync(outside, path.join(root, "lib", "fixture.js"));
      return () => rmSync(outside, { force: true });
    });
    rejectFixture("path traversal", ({ manifest, root }) => {
      manifest.entries[0].relative_path = "../outside.js";
      writeReleaseDocuments(root, manifest);
    });
    rejectFixture("absolute path", ({ manifest, root }) => {
      manifest.entries[0].relative_path = "/tmp/outside.js";
      writeReleaseDocuments(root, manifest);
    });
    rejectFixture("duplicate entry", ({ manifest, root }) => {
      manifest.entries.push({ ...manifest.entries[0] });
      writeReleaseDocuments(root, manifest);
    });
    rejectFixture("unsorted entries", ({ manifest, root }) => {
      writeFileSync(path.join(root, "lib", "aaa.js"), "export const aaa = true;\n", { mode: 0o644 });
      chmodSync(path.join(root, "lib", "aaa.js"), 0o644);
      manifest.entries.unshift({
        mode: "100644",
        relative_path: "lib/fixture.js",
        sha256: manifest.entries[0].sha256,
        type: "file",
      });
      manifest.entries[1] = {
        mode: "100644",
        relative_path: "lib/aaa.js",
        sha256: sha(readFileSync(path.join(root, "lib", "aaa.js"))),
        type: "file",
      };
      writeReleaseDocuments(root, manifest);
    });
    rejectFixture("invalid type", ({ manifest, root }) => {
      manifest.entries[0].type = "symlink";
      writeReleaseDocuments(root, manifest);
    });
    rejectFixture("invalid mode", ({ manifest, root }) => {
      manifest.entries[0].mode = "100777";
      writeReleaseDocuments(root, manifest);
    });
    rejectFixture("invalid digest", ({ manifest, root }) => {
      manifest.entries[0].sha256 = "0".repeat(64);
      writeReleaseDocuments(root, manifest);
    });
    rejectFixture("unmanifested payload", ({ root }) => {
      writeFileSync(path.join(root, "lib", "extra.js"), "unmanifested\n", { mode: 0o644 });
    });
    rejectFixture("removed manifest entry", ({ manifest, root }) => {
      manifest.entries = [];
      writeReleaseDocuments(root, manifest);
    });
    rejectFixture("unmanifested top-level payload", ({ root }) => {
      writeFileSync(path.join(root, "UNLISTED.txt"), "unmanifested\n", { mode: 0o644 });
    });

    const excluded = makeRelease();
    try {
      mkdirSync(path.join(excluded.root, "runtime"), { recursive: true });
      writeFileSync(path.join(excluded.root, "runtime", "ignored.json"), "{}\n");
      assert.doesNotThrow(() => load(excluded.root), "canonical runtime-data exclusions remain outside the payload");
    } finally {
      rmSync(excluded.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

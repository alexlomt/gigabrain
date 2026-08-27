import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
    },
  };
  writeFileSync(path.join(root, "package-lock.json"), canonicalJson(packageLock));
  const lockText = [
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
      assert.equal(first.nodePackages, 1);
      assert.equal(first.pythonDistributions, 2);
      assert.equal(first.pythonLockSha256, dependencyFixture.manifest.lockSha256);
      assert.equal(first.wheelInventorySha256, dependencyFixture.manifest.inventorySha256);
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
      candidate.manifest.packages[0].sha256 = "c".repeat(64);
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_HASH/);
    rejectDependency("wheel provenance drift", (candidate) => {
      candidate.manifest.packages[0].index = "https://mirror.invalid/simple";
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_WHEEL_PROVENANCE/);
    rejectDependency("lock and wheel set drift", (candidate) => {
      candidate.manifest.packages[0].version = "1.0.1";
      candidate.manifest.inventorySha256 = sha(JSON.stringify(candidate.manifest.packages));
      writeDependencyManifest(candidate.root, candidate.manifest);
    }, /GIGABRAIN_RELEASE_DEPENDENCY_LOCK_INVENTORY/);
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

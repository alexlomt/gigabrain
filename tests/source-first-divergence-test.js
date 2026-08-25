import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardPath = path.join(repoRoot, "scripts", "check-source-first-divergence.mjs");
const mapPath = path.join(repoRoot, "config", "migration", "source-first-port-map.json");
const allowlistPath = path.join(repoRoot, "config", "migration", "upstream-source-allowlist.json");

for (const [label, requiredPath] of [
  ["source-first guard", guardPath],
  ["source-first port map", mapPath],
  ["upstream source allowlist", allowlistPath],
]) {
  assert.doesNotThrow(
    () => readFileSync(requiredPath),
    `missing ${label}: ${path.relative(repoRoot, requiredPath)}`,
  );
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10_000,
  }).trim();
}

function commitAll(repo, message) {
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "-m", message]);
}

function blobIdentity(filePath) {
  return sha256(readFileSync(filePath));
}

function makeFixture(mutate = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-source-first-"));
  const fixtureRepo = path.join(root, "repo");
  const policyDir = path.join(root, "policy");
  mkdirSync(path.join(fixtureRepo, "lib"), { recursive: true });
  mkdirSync(policyDir, { recursive: true });

  git(fixtureRepo, ["init", "--quiet"]);
  git(fixtureRepo, ["config", "user.name", "Source First Test"]);
  git(fixtureRepo, ["config", "user.email", "source-first-test@example.invalid"]);
  writeFileSync(path.join(fixtureRepo, "lib", "upstream.js"), "export const upstream = true;\n");
  writeFileSync(path.join(fixtureRepo, "lib", "core.js"), "export const core = true;\n");
  commitAll(fixtureRepo, "fixture base");

  const base = git(fixtureRepo, ["rev-parse", "HEAD"]);
  const tree = git(fixtureRepo, ["rev-parse", "HEAD^{tree}"]);
  mkdirSync(path.join(fixtureRepo, "config"), { recursive: true });
  writeFileSync(path.join(fixtureRepo, "config", "meta.json"), "{\"fixture\":true}\n");
  commitAll(fixtureRepo, "allowed fixture delta");

  const legacyBytes = Buffer.from('export const legacy = "synthetic-obsolete-v0.7";\n');
  const deployedFiles = [
    {
      disposition: "retired",
      historicalDisposition: "Synthetic historical fixture; no candidate target.",
      ownerTasks: ["2A"],
      reason: "Exercises complete deployed-source manifest validation.",
      sourceBlob: "2".repeat(40),
      sourceMode: "100644",
      sourcePath: "legacy/source.js",
      testGate: "source-first divergence fixture gate",
    },
  ];
  const deployedCommits = [
    {
      commit: "1".repeat(40),
      contract: "Synthetic historical contract",
      disposition: "retired",
      historicalDisposition: "Synthetic fixture history only.",
      ownerTasks: ["2A"],
      reason: "Exercises complete deployed-commit ledger validation.",
      sequence: 1,
      testGate: "source-first divergence fixture gate",
    },
  ];
  const preTagTools = [
    {
      disposition: "private_dev_only",
      historicalDisposition: "Synthetic private development fixture.",
      id: "synthetic-pre-tag-tool",
      ownerTasks: ["2A"],
      reason: "Exercises explicit pre-tag disposition validation.",
      sourcePaths: ["legacy/tool.js"],
      testGate: "source-first divergence fixture gate",
    },
  ];
  const obsoleteSourceFingerprints = [
    {
      disposition: "retired",
      historicalDisposition: "Obsolete synthetic implementation must not be copied.",
      ownerTasks: ["2A"],
      reason: "Exercises byte-exact obsolete-source rejection.",
      sha256: sha256(legacyBytes),
      sourcePath: "legacy/obsolete.js",
      testGate: "source-first divergence fixture gate",
    },
  ];
  const candidateChanges = [
    {
      changeType: "added",
      contentSha256: blobIdentity(path.join(fixtureRepo, "config", "meta.json")),
      disposition: "operator_only",
      ownerTasks: ["2A"],
      reason: "Synthetic policy metadata owned by the fixture.",
      targetMode: "100644",
      targetPath: "config/meta.json",
      testGate: "source-first divergence fixture gate",
    },
  ];

  const baseRows = git(fixtureRepo, ["ls-tree", "-r", base])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(line);
      assert(match);
      return { blob: match[3], mode: match[1], path: match[4], type: match[2] };
    });

  const fixture = {
    allowlist: {
      auditedBase: { commit: base, tree },
      entries: baseRows,
      entryCount: baseRows.length,
      manifestSha256: sha256(canonicalJson(baseRows)),
      schemaVersion: 1,
    },
    map: {
      auditedBase: { commit: base, tree },
      candidateChanges,
      deployedCommits,
      deployedFiles,
      deployedSource: {
        commit: "3".repeat(40),
        commitCount: deployedCommits.length,
        commitManifestSha256: sha256(canonicalJson(deployedCommits)),
        fileCount: deployedFiles.length,
        fileManifestSha256: sha256(canonicalJson(deployedFiles)),
        tree: "4".repeat(40),
      },
      obsoleteSourceFingerprints,
      obsoleteSourceManifestSha256: sha256(canonicalJson(obsoleteSourceFingerprints)),
      preTagToolCount: preTagTools.length,
      preTagToolManifestSha256: sha256(canonicalJson(preTagTools)),
      preTagTools,
      schemaVersion: 1,
      upstreamAllowlist: "upstream-source-allowlist.json",
    },
    base,
    fixtureRepo,
    legacyBytes,
    policyDir,
    root,
  };

  mutate(fixture);

  fixture.allowlist.entryCount ??= fixture.allowlist.entries.length;
  fixture.allowlist.manifestSha256 ??= sha256(canonicalJson(fixture.allowlist.entries));
  writeFileSync(path.join(policyDir, "upstream-source-allowlist.json"), canonicalJson(fixture.allowlist));
  writeFileSync(path.join(policyDir, "source-first-port-map.json"), canonicalJson(fixture.map));
  return fixture;
}

function runGuard(fixture, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [guardPath, "--base", fixture.base, "--map", path.join(fixture.policyDir, "source-first-port-map.json"), ...extraArgs],
    {
      cwd: fixture.fixtureRepo,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 10_000,
    },
  );
}

function expectPass(name, mutate) {
  const fixture = makeFixture(mutate);
  try {
    const result = runGuard(fixture);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /SOURCE_FIRST_DIVERGENCE OK\b/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function expectFailure(name, code, mutate, extraArgs = []) {
  const fixture = makeFixture(mutate);
  try {
    const result = runGuard(fixture, extraArgs);
    assert.notEqual(result.status, 0, `${name}: guard unexpectedly passed`);
    assert.match(result.stderr, new RegExp(`SOURCE_FIRST_DIVERGENCE ${code}\\b`), name);
    assert.doesNotMatch(result.stderr, /synthetic-obsolete-v0\.7|SOURCE_FIRST_PRIVATE_LITERAL/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

expectPass("exact classified delta", () => {});

expectFailure("unclassified file", "UNCLASSIFIED_DIFF", ({ fixtureRepo }) => {
  writeFileSync(path.join(fixtureRepo, "unclassified.js"), "export default true;\n");
  commitAll(fixtureRepo, "unclassified delta");
});

expectFailure("upstream-owned edit", "UPSTREAM_OWNED_EDIT", ({ fixtureRepo }) => {
  writeFileSync(path.join(fixtureRepo, "lib", "upstream.js"), "export const upstream = false;\n");
  commitAll(fixtureRepo, "upstream edit");
});

expectFailure("core patch without test", "MISSING_TEST_GATE", ({ allowlist, fixtureRepo, map }) => {
  writeFileSync(path.join(fixtureRepo, "lib", "core.js"), "export const core = false;\n");
  commitAll(fixtureRepo, "untested core patch");
  allowlist.entries = allowlist.entries.filter((entry) => entry.path !== "lib/core.js");
  allowlist.entryCount = allowlist.entries.length;
  allowlist.manifestSha256 = sha256(canonicalJson(allowlist.entries));
  map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(path.join(fixtureRepo, "lib", "core.js")),
    disposition: "core_patch",
    ownerTasks: ["2A"],
    reason: "Synthetic core patch fixture.",
    targetMode: "100644",
    targetPath: "lib/core.js",
    testGate: "",
  });
});

expectFailure("private literal marker in source", "PRIVATE_LITERAL", ({ allowlist, fixtureRepo, map }) => {
  writeFileSync(
    path.join(fixtureRepo, "lib", "core.js"),
    'export const value = "SOURCE_FIRST_PRIVATE_LITERAL";\n',
  );
  commitAll(fixtureRepo, "private literal fixture");
  allowlist.entries = allowlist.entries.filter((entry) => entry.path !== "lib/core.js");
  allowlist.entryCount = allowlist.entries.length;
  allowlist.manifestSha256 = sha256(canonicalJson(allowlist.entries));
  map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(path.join(fixtureRepo, "lib", "core.js")),
    disposition: "compat_module",
    ownerTasks: ["2A"],
    reason: "Synthetic source scan fixture.",
    targetMode: "100644",
    targetPath: "lib/core.js",
    testGate: "source-first divergence fixture gate",
  });
});

expectFailure("obsolete implementation copied in", "OBSOLETE_SOURCE_COPY", ({ allowlist, fixtureRepo, legacyBytes, map }) => {
  writeFileSync(path.join(fixtureRepo, "lib", "core.js"), legacyBytes);
  commitAll(fixtureRepo, "obsolete source fixture");
  allowlist.entries = allowlist.entries.filter((entry) => entry.path !== "lib/core.js");
  allowlist.entryCount = allowlist.entries.length;
  allowlist.manifestSha256 = sha256(canonicalJson(allowlist.entries));
  map.candidateChanges.push({
    changeType: "modified",
    contentSha256: blobIdentity(path.join(fixtureRepo, "lib", "core.js")),
    disposition: "compat_module",
    ownerTasks: ["2A"],
    reason: "Synthetic obsolete-copy fixture.",
    targetMode: "100644",
    targetPath: "lib/core.js",
    testGate: "source-first divergence fixture gate",
  });
});

expectFailure("stale map row", "STALE_MAP_ROW", ({ map }) => {
  map.candidateChanges.push({
    changeType: "added",
    contentSha256: "5".repeat(64),
    disposition: "compat_module",
    ownerTasks: ["2A"],
    reason: "Synthetic stale row fixture.",
    targetMode: "100644",
    targetPath: "lib/not-present.js",
    testGate: "source-first divergence fixture gate",
  });
});

expectFailure("stale allowlist row", "STALE_ALLOWLIST_ROW", ({ allowlist }) => {
  allowlist.entries.push({
    blob: "6".repeat(40),
    mode: "100644",
    path: "lib/not-in-base.js",
    type: "blob",
  });
  allowlist.entryCount = allowlist.entries.length;
  allowlist.manifestSha256 = sha256(canonicalJson(allowlist.entries));
});

expectFailure("missing deployed source row", "DEPLOYED_FILE_MANIFEST", ({ map }) => {
  map.deployedFiles = [];
});

expectFailure("unknown disposition", "UNKNOWN_DISPOSITION", ({ map }) => {
  map.deployedFiles[0].disposition = "unknown";
});

expectFailure("wildcard source path", "WILDCARD_PATH", ({ map }) => {
  map.deployedFiles[0].sourcePath = "legacy/*.js";
});

expectFailure("unexpected bytes in a classified delta", "UNEXPECTED_DIFF", ({ fixtureRepo }) => {
  writeFileSync(path.join(fixtureRepo, "config", "meta.json"), "{\"fixture\":false}\n");
  commitAll(fixtureRepo, "unexpected classified delta");
});

{
  const fixture = makeFixture();
  try {
    const result = runGuard(fixture, ["--base", "HEAD"]);
    assert.notEqual(result.status, 0, "invalid base: guard unexpectedly passed");
    assert.match(result.stderr, /SOURCE_FIRST_DIVERGENCE INVALID_BASE\b/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

console.log("source-first-divergence-test: ok");

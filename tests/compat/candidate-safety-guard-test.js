import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { buildMissingEmbeddings } from "../../lib/core/embedding-service.js";
import { promoteNativeChunks } from "../../lib/core/native-promotion.js";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "14";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_CANDIDATE_SAFETY_GUARD missing receipt-bound candidate mutation guard";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const CODE_SHA = "0123456789abcdef0123456789abcdef01234567";
const SCHEMA_ID = "gigabrain-schema-0.11-compat-v1";
const SCHEMA_CHECKSUM = "a".repeat(64);
const FIXED_NOW = "2026-08-27T12:00:00.000Z";
const VALID_UNTIL = "2026-09-01T00:00:00.000Z";
const CANDIDATE_DB_MARKER = "CANDIDATE-DB-CONTENT-MUST-NOT-ENTER-RECEIPTS";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SOURCE_COHORT_IDENTITY = sha256("sealed-source-cohort-task14");
const binaryCompare = (left, right) => Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(binaryCompare).map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const OPERATION_REQUIREMENTS = Object.freeze({
  "embedding.model-change": Object.freeze(["embedding_identity"]),
  "host.sync": Object.freeze(["host_sync"]),
  "maintenance.mutate": Object.freeze([
    "schema_migration", "native_isolation", "host_sync", "embedding_identity", "world_shadow", "nightly_order",
  ]),
  "migrate-v3.apply": Object.freeze(["schema_migration"]),
  "native.promote": Object.freeze(["native_isolation"]),
  "plugin.register": Object.freeze(["schema_migration"]),
  "setup.apply": Object.freeze(["schema_migration"]),
  "world.rebuild": Object.freeze(["world_shadow"]),
});

const READ_ONLY_OPERATIONS = ["audit.read", "doctor.read", "status.read"];

const sealReceipt = (body) => ({
  ...body,
  receipt_sha256: sha256(canonicalJson(body)),
});

const buildReceipt = ({ artifactRoot, registryPath, phases = Object.values(OPERATION_REQUIREMENTS).flat(), overrides = {} } = {}) => {
  const stat = statSync(registryPath);
  const phaseReceipts = Object.fromEntries([...new Set(phases)].sort(binaryCompare).map((phase) => {
    const artifactPath = path.join(artifactRoot, `phase-${phase}.json`);
    const artifact = {
      code_sha: CODE_SHA,
      contract: "gigabrain-candidate-phase-artifact/1",
      database_identity: { dev: String(stat.dev), ino: String(stat.ino) },
      phase,
      schema_checksum: SCHEMA_CHECKSUM,
      schema_id: SCHEMA_ID,
      source_cohort_identity: SOURCE_COHORT_IDENTITY,
      status: "accepted",
    };
    writeFileSync(artifactPath, canonicalJson(artifact), { mode: 0o600 });
    chmodSync(artifactPath, 0o600);
    return [phase, {
      path: artifactPath,
      sha256: sha256(readFileSync(artifactPath)),
      status: "accepted",
    }];
  }));
  return sealReceipt({
    code_sha: CODE_SHA,
    database_identity: { dev: String(stat.dev), ino: String(stat.ino) },
    expires_at: VALID_UNTIL,
    phase_receipts: phaseReceipts,
    receipt_kind: "gigabrain.candidate-safety/1",
    schema_checksum: SCHEMA_CHECKSUM,
    schema_id: SCHEMA_ID,
    source_cohort_identity: SOURCE_COHORT_IDENTITY,
    ...overrides,
  });
};

const writeReceipt = (receiptPath, receipt) => {
  writeFileSync(receiptPath, canonicalJson(receipt), { mode: 0o600 });
  chmodSync(receiptPath, 0o600);
};

const writeRelease = (releasePath, overrides = {}) => {
  writeFileSync(releasePath, canonicalJson({
    code_sha: CODE_SHA,
    schema_checksum: SCHEMA_CHECKSUM,
    schema_id: SCHEMA_ID,
    source_cohort_identity: SOURCE_COHORT_IDENTITY,
    ...overrides,
  }), { mode: 0o600 });
};

const writeConfig = ({ configPath, receiptPath, registryPath, workspaceRoot }) => {
  writeFileSync(configPath, canonicalJson({
    plugins: { entries: { gigabrain: { enabled: true, config: {
      candidateSafety: { receiptPath },
      capture: { enabled: false },
      compat: { writeMode: "full" },
      enabled: true,
      recall: { autoInjectEnabled: false },
      runtime: { paths: {
        memoryRoot: path.join(workspaceRoot, "memory"),
        outputDir: path.join(workspaceRoot, "output"),
        registryPath,
        reviewQueuePath: path.join(workspaceRoot, "output", "review.jsonl"),
        workspaceRoot,
      } },
    } } } },
  }), { mode: 0o600 });
};

const snapshotTree = (root) => {
  const rows = [];
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort(binaryCompare)) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        rows.push({ mode: stat.mode & 0o777, path: relative, type: "directory" });
        walk(absolute, relative);
      } else if (stat.isFile()) {
        rows.push({ hash: sha256(readFileSync(absolute)), mode: stat.mode & 0o777, path: relative, type: "file" });
      } else {
        rows.push({ mode: stat.mode & 0o777, path: relative, type: "special" });
      }
    }
  };
  walk(root);
  return rows;
};

const withCandidateEnvironment = (values, fn) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const spawnNode = (script, args, env) => spawnSync(process.execPath, [path.join(repoRoot, script), ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C", TZ: "UTC", ...env },
  maxBuffer: 8 * 1024 * 1024,
  timeout: 30_000,
});

const assertGuardFailure = (fn, phase) => assert.throws(fn, (error) => {
  const message = String(error?.message || error);
  assert.match(message, /GIGABRAIN_CANDIDATE_(?:PHASE_REQUIRED|RECEIPT|IDENTITY|PROVENANCE)/);
  if (phase) assert.equal(message.includes(phase), true, `guard error must identify required phase ${phase}`);
  return true;
});

export async function run() {
  const guard = await importContractModule("lib/compat/candidate-safety-guard.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const assertCandidateOperationAllowed = requireCallable(guard, "assertCandidateOperationAllowed");
    const classifyCandidateOperation = requireCallable(guard, "classifyCandidateOperation");

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task14-guard-"));
    chmodSync(root, 0o700);
    try {
      const workspaceRoot = path.join(root, "workspace");
      mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
      const registryPath = path.join(root, "candidate.sqlite");
      const db = new DatabaseSync(registryPath);
      db.exec("CREATE TABLE sentinel(id INTEGER PRIMARY KEY,note TEXT)");
      db.prepare("INSERT INTO sentinel VALUES(1,?)").run(CANDIDATE_DB_MARKER);
      db.close();
      chmodSync(registryPath, 0o600);
      const originalRegistryIdentity = {
        dev: statSync(registryPath).dev,
        ino: statSync(registryPath).ino,
      };
      const releasePath = path.join(root, "RELEASE.json");
      writeRelease(releasePath);
      const missingReceiptPath = path.join(root, "missing-candidate.receipt.json");
      const validReceiptPath = path.join(root, "candidate.receipt.json");
      writeReceipt(validReceiptPath, buildReceipt({ artifactRoot: root, registryPath }));
      const validReceipt = JSON.parse(readFileSync(validReceiptPath, "utf8"));
      assert.equal(JSON.stringify(validReceipt).includes(CANDIDATE_DB_MARKER), false);
      assert.deepEqual(Object.keys(validReceipt), [
        "code_sha", "database_identity", "expires_at", "phase_receipts", "receipt_kind",
        "receipt_sha256", "schema_checksum", "schema_id", "source_cohort_identity",
      ]);
      const validReceiptBody = { ...validReceipt };
      delete validReceiptBody.receipt_sha256;
      assert.equal(validReceipt.receipt_sha256, sha256(canonicalJson(validReceiptBody)));
      assert.equal(lstatSync(validReceiptPath).mode & 0o777, 0o600);
      assert.equal(lstatSync(validReceiptPath).nlink, 1);

      for (const operation of READ_ONLY_OPERATIONS) {
        const result = assertCandidateOperationAllowed({
          now: FIXED_NOW,
          operation,
          receiptPath: missingReceiptPath,
          registryPath,
          releasePath,
        });
        assert.equal(result.allowed, true);
        assert.equal(result.access, "read");
      }

      for (const [operation, requiredPhases] of Object.entries(OPERATION_REQUIREMENTS)) {
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW,
          operation,
          receiptPath: missingReceiptPath,
          registryPath,
          releasePath,
        }), requiredPhases[0]);
        for (const missingPhase of requiredPhases) {
          const wrongPhasePath = path.join(root, `wrong-${operation.replaceAll(".", "-")}-${missingPhase}.json`);
          writeReceipt(wrongPhasePath, buildReceipt({
            artifactRoot: root,
            registryPath,
            phases: requiredPhases.filter((phase) => phase !== missingPhase),
          }));
          assertGuardFailure(() => assertCandidateOperationAllowed({
            now: FIXED_NOW,
            operation,
            receiptPath: wrongPhasePath,
            registryPath,
            releasePath,
          }), missingPhase);
        }
        const exactPhasePath = path.join(root, `valid-${operation.replaceAll(".", "-")}.json`);
        writeReceipt(exactPhasePath, buildReceipt({ artifactRoot: root, registryPath, phases: requiredPhases }));
        const allowed = assertCandidateOperationAllowed({
          now: FIXED_NOW,
          operation,
          receiptPath: exactPhasePath,
          registryPath,
          releasePath,
        });
        assert.equal(allowed.allowed, true);
        assert.deepEqual(allowed.requiredPhases, requiredPhases);
      }

      const protectedReceipt = JSON.parse(readFileSync(validReceiptPath, "utf8"));
      for (const [phase, artifact] of Object.entries(protectedReceipt.phase_receipts)) {
        assert.deepEqual(Object.keys(artifact), ["path", "sha256", "status"]);
        const stat = lstatSync(artifact.path);
        assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, phase);
        assert.equal(stat.mode & 0o777, 0o600, phase);
        assert.equal(stat.nlink, 1, phase);
        assert.equal(artifact.sha256, sha256(readFileSync(artifact.path)), phase);
        const phaseArtifact = JSON.parse(readFileSync(artifact.path, "utf8"));
        assert.deepEqual(Object.keys(phaseArtifact), [
          "code_sha", "contract", "database_identity", "phase", "schema_checksum", "schema_id",
          "source_cohort_identity", "status",
        ]);
        assert.deepEqual(phaseArtifact, {
          code_sha: CODE_SHA,
          contract: "gigabrain-candidate-phase-artifact/1",
          database_identity: validReceipt.database_identity,
          phase,
          schema_checksum: SCHEMA_CHECKSUM,
          schema_id: SCHEMA_ID,
          source_cohort_identity: SOURCE_COHORT_IDENTITY,
          status: "accepted",
        });
      }
      const artifactPhase = "schema_migration";
      const artifactRecord = protectedReceipt.phase_receipts[artifactPhase];
      const artifactBytes = readFileSync(artifactRecord.path);
      writeFileSync(artifactRecord.path, Buffer.concat([artifactBytes, Buffer.from("tampered")]), { mode: 0o600 });
      assertGuardFailure(() => assertCandidateOperationAllowed({
        now: FIXED_NOW, operation: "plugin.register", receiptPath: validReceiptPath, registryPath, releasePath,
      }));
      writeFileSync(artifactRecord.path, artifactBytes, { mode: 0o600 });
      chmodSync(artifactRecord.path, 0o644);
      assertGuardFailure(() => assertCandidateOperationAllowed({
        now: FIXED_NOW, operation: "plugin.register", receiptPath: validReceiptPath, registryPath, releasePath,
      }));
      chmodSync(artifactRecord.path, 0o600);
      const artifactHardlink = path.join(root, `phase-hardlink-${artifactPhase}.json`);
      linkSync(artifactRecord.path, artifactHardlink);
      try {
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW, operation: "plugin.register", receiptPath: validReceiptPath, registryPath, releasePath,
        }));
      } finally {
        unlinkSync(artifactHardlink);
      }
      for (const [label, mutate] of [
        ["phase", (artifact) => { artifact.phase = "wrong_phase"; }],
        ["status", (artifact) => { artifact.status = "rejected"; }],
        ["code", (artifact) => { artifact.code_sha = "f".repeat(40); }],
        ["schema-id", (artifact) => { artifact.schema_id = "wrong-schema"; }],
        ["schema-checksum", (artifact) => { artifact.schema_checksum = "f".repeat(64); }],
        ["database", (artifact) => { artifact.database_identity = { dev: "0", ino: "0" }; }],
        ["source-cohort", (artifact) => { artifact.source_cohort_identity = "f".repeat(64); }],
      ]) {
        const invalidArtifactPath = path.join(root, `phase-schema_migration-${label}.json`);
        const invalidArtifact = JSON.parse(artifactBytes.toString("utf8"));
        mutate(invalidArtifact);
        writeFileSync(invalidArtifactPath, canonicalJson(invalidArtifact), { mode: 0o600 });
        const invalidReceiptBody = structuredClone(validReceipt);
        delete invalidReceiptBody.receipt_sha256;
        invalidReceiptBody.phase_receipts.schema_migration = {
          path: invalidArtifactPath,
          sha256: sha256(readFileSync(invalidArtifactPath)),
          status: "accepted",
        };
        const invalidReceiptPath = path.join(root, `candidate-semantic-${label}.json`);
        writeReceipt(invalidReceiptPath, sealReceipt(invalidReceiptBody));
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW, operation: "plugin.register", receiptPath: invalidReceiptPath, registryPath, releasePath,
        }));
      }

      const legacyReceiptPath = path.join(root, "legacy-drop-never.json");
      writeReceipt(legacyReceiptPath, buildReceipt({ artifactRoot: root, registryPath, phases: ["legacy_drop_authorized"] }));
      assert.throws(() => assertCandidateOperationAllowed({
        now: FIXED_NOW,
        operation: "legacy.drop",
        receiptPath: legacyReceiptPath,
        registryPath,
        releasePath,
      }), /LEGACY_DROP_BLOCKED_COMPAT/);
      assert.throws(() => assertCandidateOperationAllowed({
        now: FIXED_NOW,
        operation: "unknown.mutation",
        receiptPath: validReceiptPath,
        registryPath,
        releasePath,
      }), /UNKNOWN.*OPERATION|OPERATION.*UNKNOWN/i);
      assert.throws(() => classifyCandidateOperation({ argv: ["unknown-mutator"], entrypoint: "gigabrainctl" }), /UNKNOWN|UNCLASSIFIED/i);

      const aliases = [
        [{ argv: ["--apply"], entrypoint: "setup-first-run" }, "setup.apply"],
        [{ argv: ["--apply"], entrypoint: "migrate-v3" }, "migrate-v3.apply"],
        [{ argv: ["world", "rebuild"], entrypoint: "gigabrainctl" }, "world.rebuild"],
        [{ argv: ["world"], entrypoint: "gigabrainctl" }, "world.rebuild"],
        [{ argv: ["sync-hosts"], entrypoint: "gigabrainctl" }, "host.sync"],
        [{ argv: ["migrate", "legacy-drop"], entrypoint: "gigabrainctl" }, "legacy.drop"],
        [{ argv: ["maintain"], entrypoint: "gigabrainctl" }, "maintenance.mutate"],
        [{ argv: ["nightly"], entrypoint: "gigabrainctl" }, "maintenance.mutate"],
        [{ argv: ["doctor"], entrypoint: "gigabrainctl" }, "doctor.read"],
        [{ argv: ["sync-hosts", "status"], entrypoint: "gigabrainctl" }, "status.read"],
      ];
      for (const [input, operation] of aliases) {
        const classified = classifyCandidateOperation(input);
        assert.equal(classified.operation, operation);
        assert.equal(classified.access, operation.endsWith(".read") ? "read" : "write");
      }

      const tamperedPath = path.join(root, "tampered.json");
      const tampered = buildReceipt({ artifactRoot: root, registryPath });
      tampered.code_sha = "f".repeat(40);
      writeReceipt(tamperedPath, tampered);
      assertGuardFailure(() => assertCandidateOperationAllowed({
        now: FIXED_NOW,
        operation: "setup.apply",
        receiptPath: tamperedPath,
        registryPath,
        releasePath,
      }));

      const mismatchedRegistryPath = path.join(root, "config-mismatch.sqlite");
      const mismatchedDb = new DatabaseSync(mismatchedRegistryPath);
      mismatchedDb.exec("CREATE TABLE mismatch(id INTEGER PRIMARY KEY)");
      mismatchedDb.close();
      chmodSync(mismatchedRegistryPath, 0o600);
      assertGuardFailure(() => assertCandidateOperationAllowed({
        now: FIXED_NOW,
        operation: "setup.apply",
        receiptPath: validReceiptPath,
        registryPath: mismatchedRegistryPath,
        releasePath,
      }));
      for (const [label, receiptOverrides, releaseOverrides] of [
        ["wrong-code", { code_sha: "f".repeat(40) }, {}],
        ["wrong-schema", { schema_checksum: "b".repeat(64) }, {}],
        ["expired", { expires_at: "2026-08-26T00:00:00.000Z" }, {}],
        ["release-code", {}, { code_sha: "e".repeat(40) }],
      ]) {
        const candidateReceiptPath = path.join(root, `${label}.json`);
        const candidateReleasePath = path.join(root, `${label}-RELEASE.json`);
        writeReceipt(candidateReceiptPath, buildReceipt({ artifactRoot: root, registryPath, overrides: receiptOverrides }));
        writeRelease(candidateReleasePath, releaseOverrides);
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW,
          operation: "setup.apply",
          receiptPath: candidateReceiptPath,
          registryPath,
          releasePath: candidateReleasePath,
        }));
      }

      const wrongIdentityPath = path.join(root, "wrong-identity.json");
      writeReceipt(wrongIdentityPath, buildReceipt({
        artifactRoot: root,
        registryPath,
        overrides: { database_identity: { dev: "0", ino: "0" } },
      }));
      assertGuardFailure(() => assertCandidateOperationAllowed({
        now: FIXED_NOW,
        operation: "setup.apply",
        receiptPath: wrongIdentityPath,
        registryPath,
        releasePath,
      }));

      const registrySymlink = path.join(root, "candidate-symlink.sqlite");
      symlinkSync(registryPath, registrySymlink);
      try {
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW, operation: "setup.apply", receiptPath: validReceiptPath,
          registryPath: registrySymlink, releasePath,
        }));
      } finally { unlinkSync(registrySymlink); }
      const registryHardlink = path.join(root, "candidate-hardlink.sqlite");
      linkSync(registryPath, registryHardlink);
      try {
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW, operation: "setup.apply", receiptPath: validReceiptPath, registryPath, releasePath,
        }));
      } finally { unlinkSync(registryHardlink); }
      chmodSync(registryPath, 0o644);
      assertGuardFailure(() => assertCandidateOperationAllowed({
        now: FIXED_NOW, operation: "setup.apply", receiptPath: validReceiptPath, registryPath, releasePath,
      }));
      chmodSync(registryPath, 0o600);
      assertGuardFailure(() => assertCandidateOperationAllowed({
        now: FIXED_NOW, operation: "setup.apply", receiptPath: validReceiptPath, registryPath, releasePath,
        operatorUid: Number(process.getuid?.() || 0) + 1,
      }));
      const registryParentAlias = path.join(root, "registry-parent-alias");
      symlinkSync(root, registryParentAlias);
      try {
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW, operation: "setup.apply", receiptPath: validReceiptPath,
          registryPath: path.join(registryParentAlias, path.basename(registryPath)), releasePath,
        }));
      } finally { unlinkSync(registryParentAlias); }
      const receiptedRegistrySaved = path.join(root, "receipted-candidate-saved.sqlite");
      renameSync(registryPath, receiptedRegistrySaved);
      const swappedDb = new DatabaseSync(registryPath);
      swappedDb.exec("CREATE TABLE swapped(id INTEGER PRIMARY KEY)");
      swappedDb.close();
      chmodSync(registryPath, 0o600);
      try {
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW, operation: "setup.apply", receiptPath: validReceiptPath, registryPath, releasePath,
        }));
      } finally {
        unlinkSync(registryPath);
        renameSync(receiptedRegistrySaved, registryPath);
      }

      const insecureModePath = path.join(root, "insecure-mode.json");
      writeReceipt(insecureModePath, buildReceipt({ artifactRoot: root, registryPath }));
      chmodSync(insecureModePath, 0o644);
      assertGuardFailure(() => assertCandidateOperationAllowed({
        now: FIXED_NOW,
        operation: "setup.apply",
        receiptPath: insecureModePath,
        registryPath,
        releasePath,
      }));
      const hardlinkReceipt = path.join(root, "receipt-hardlink.json");
      linkSync(validReceiptPath, hardlinkReceipt);
      try {
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW,
          operation: "setup.apply",
          receiptPath: validReceiptPath,
          registryPath,
          releasePath,
        }));
      } finally {
        unlinkSync(hardlinkReceipt);
      }
      const symlinkReceipt = path.join(root, "receipt-symlink.json");
      symlinkSync(validReceiptPath, symlinkReceipt);
      try {
        assertGuardFailure(() => assertCandidateOperationAllowed({
          now: FIXED_NOW,
          operation: "setup.apply",
          receiptPath: symlinkReceipt,
          registryPath,
          releasePath,
        }));
      } finally {
        unlinkSync(symlinkReceipt);
      }

      const configPath = path.join(root, "openclaw.json");
      writeConfig({ configPath, receiptPath: missingReceiptPath, registryPath, workspaceRoot });
      const guardEnv = {
        GIGABRAIN_CANDIDATE_RECEIPT_PATH: missingReceiptPath,
        GIGABRAIN_CANDIDATE_REGISTRY_PATH: registryPath,
        GIGABRAIN_RELEASE_PATH: releasePath,
      };
      const partialNightlyReceiptPath = path.join(root, "partial-nightly.receipt.json");
      writeReceipt(partialNightlyReceiptPath, buildReceipt({
        artifactRoot: root, registryPath, phases: ["nightly_order"],
      }));
      const partialNightlyConfigPath = path.join(root, "partial-nightly-openclaw.json");
      writeConfig({ configPath: partialNightlyConfigPath, receiptPath: partialNightlyReceiptPath, registryPath, workspaceRoot });
      const partialNightlyBefore = snapshotTree(root);
      const partialNightly = spawnNode("scripts/gigabrainctl.js", ["maintain", "--config", partialNightlyConfigPath], {
        ...guardEnv,
        GIGABRAIN_CANDIDATE_RECEIPT_PATH: partialNightlyReceiptPath,
      });
      assert.notEqual(partialNightly.status, 0);
      assert.match(`${partialNightly.stderr}${partialNightly.stdout}`, /schema_migration|native_isolation|host_sync|embedding_identity|world_shadow/);
      assert.deepEqual(snapshotTree(root), partialNightlyBefore, "nightly composite gate must block before any substage write");
      const blockedCommands = [
        ["scripts/setup-first-run.js", ["--apply", "--config", configPath, "--workspace", workspaceRoot, "--skip-agents", "--skip-restart"], /GIGABRAIN_CANDIDATE_(?:PHASE_REQUIRED|RECEIPT)/],
        ["scripts/migrate-v3.js", ["--apply", "--config", configPath], /GIGABRAIN_CANDIDATE_(?:PHASE_REQUIRED|RECEIPT)/],
        ["scripts/gigabrainctl.js", ["world", "rebuild", "--config", configPath], /GIGABRAIN_CANDIDATE_(?:PHASE_REQUIRED|RECEIPT)/],
        ["scripts/gigabrainctl.js", ["sync-hosts", "--config", configPath], /GIGABRAIN_CANDIDATE_(?:PHASE_REQUIRED|RECEIPT)/],
        ["scripts/gigabrainctl.js", ["maintain", "--config", configPath], /GIGABRAIN_CANDIDATE_(?:PHASE_REQUIRED|RECEIPT)/],
        ["scripts/gigabrainctl.js", ["migrate", "legacy-drop", "--config", configPath], /LEGACY_DROP_BLOCKED_COMPAT/],
      ];
      for (const [script, args, expectedError] of blockedCommands) {
        const before = snapshotTree(root);
        const result = spawnNode(script, args, guardEnv);
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.notEqual(result.status, 0, `${script} ${args.join(" ")} must be blocked`);
        assert.match(`${result.stderr}${result.stdout}`, expectedError);
        assert.deepEqual(snapshotTree(root), before, `${script} must guard before filesystem/DB writes`);
      }

      const boundaryConfig = JSON.parse(readFileSync(configPath, "utf8")).plugins.entries.gigabrain.config;
      boundaryConfig.nativePromotion = { enabled: true };
      boundaryConfig.recall = {
        semanticRerankEnabled: true,
        embeddingDimensions: 2560,
        embeddingModel: "qwen3-embedding:4b",
        embeddingProvider: "ollama",
      };
      const beforeDirectBoundaries = snapshotTree(root);
      const boundaryDb = new DatabaseSync(registryPath);
      try {
        withCandidateEnvironment(guardEnv, () => {
          assertGuardFailure(() => promoteNativeChunks({
            db: boundaryDb,
            config: boundaryConfig,
            sourcePaths: [path.join(workspaceRoot, "memory", "seed.md")],
          }), "native_isolation");
          assertGuardFailure(() => buildMissingEmbeddings({
            db: boundaryDb,
            config: boundaryConfig,
            forceRebuildActive: true,
          }), "embedding_identity");
        });
      } finally {
        boundaryDb.close();
      }
      assert.deepEqual(snapshotTree(root), beforeDirectBoundaries, "native/embedding boundaries must guard before schema or data writes");

      for (const args of [["doctor", "--config", configPath], ["sync-hosts", "status", "--config", configPath]]) {
        const before = snapshotTree(root);
        const result = spawnNode("scripts/gigabrainctl.js", args, guardEnv);
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(snapshotTree(root), before, `${args.join(" ")} must remain observational without receipts`);
      }

      const entryPath = path.join(repoRoot, "index.js");
      const check = spawnSync(process.execPath, ["--check", entryPath], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
      assert.equal(check.status, 0, check.stderr);
      const entry = await import(`${pathToFileURL(entryPath).href}?task14-guard=${Date.now()}`);
      const calls = [];
      const api = {
        config: JSON.parse(readFileSync(configPath, "utf8")).plugins.entries.gigabrain.config,
        logger: { error() {}, info() {}, warn() {} },
        on: (name) => calls.push(["hook", name]),
        registerCli: () => calls.push(["cli"]),
        registerMemoryCapability: () => calls.push(["capability"]),
      };
      const beforeRegister = snapshotTree(root);
      withCandidateEnvironment(guardEnv, () => {
        assertGuardFailure(() => entry.default.register(api), "schema_migration");
      });
      assert.deepEqual(calls, [], "built entry must guard before capability/CLI/hook registration");
      assert.deepEqual(snapshotTree(root), beforeRegister);

      const mismatchPluginConfig = structuredClone(api.config);
      mismatchPluginConfig.candidateSafety.receiptPath = validReceiptPath;
      mismatchPluginConfig.runtime.paths.registryPath = mismatchedRegistryPath;
      api.config = mismatchPluginConfig;
      withCandidateEnvironment({ ...guardEnv, GIGABRAIN_CANDIDATE_RECEIPT_PATH: validReceiptPath }, () => {
        assertGuardFailure(() => entry.default.register(api));
      });
      assert.deepEqual(calls, [], "config/receipt registry mismatch must block before registration");

      writeConfig({ configPath, receiptPath: validReceiptPath, registryPath, workspaceRoot });
      api.config = JSON.parse(readFileSync(configPath, "utf8")).plugins.entries.gigabrain.config;
      const validEnv = { ...guardEnv, GIGABRAIN_CANDIDATE_RECEIPT_PATH: validReceiptPath };
      withCandidateEnvironment(validEnv, () => entry.default.register(api));
      assert.equal(calls.filter(([kind]) => kind === "capability").length, 1);
      assert.equal(calls.filter(([kind]) => kind === "cli").length, 1);
      assert.equal(calls.some(([, name]) => name === "before_prompt_build"), true);
      assert.deepEqual({
        dev: statSync(registryPath).dev,
        ino: statSync(registryPath).ino,
      }, originalRegistryIdentity, "registration must not replace the receipted candidate database");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

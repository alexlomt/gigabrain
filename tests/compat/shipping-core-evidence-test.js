import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveGigabrainFlushPlan } from "../../lib/compat/flush-plan.js";
import { extractPromptQuery } from "../../lib/compat/openclaw-adapter.js";
import { createGigabrainMemoryCliRegistrar } from "../../lib/compat/openclaw-memory-cli.js";
import { parseVirtualPath } from "../../lib/compat/openclaw-memory-runtime.js";
import { serializeReleaseProvenance } from "../../lib/compat/release-provenance.js";
import { normalizeAgentScope } from "../../lib/compat/scope-policy.js";
import { resolveWriteMode } from "../../lib/compat/write-policy.js";
import { runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_SHIPPING_CORE_EVIDENCE missing direct shipping/build contracts";

export async function run() {
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    assert.equal(resolveGigabrainFlushPlan({}, { nowMs: 0, timezone: "UTC" }).softThresholdTokens, 4_000);
    assert.equal(extractPromptQuery({ prompt: "  synthetic shipping query  " }), "synthetic shipping query");
    assert.equal(typeof createGigabrainMemoryCliRegistrar({}), "function");
    assert.deepEqual(parseVirtualPath("gigabrain://memory/synthetic-id"), {
      id: "synthetic-id",
      kind: "memory",
      path: "gigabrain://memory/synthetic-id",
    });
    assert.deepEqual(serializeReleaseProvenance({
      codeSha: "a".repeat(40),
      dependencyRoot: "b".repeat(64),
      immutableTag: "v0.11.0-openclaw.1",
      localIntegrityRoot: "c".repeat(64),
      manifestSha256: "d".repeat(64),
      packageVersion: "0.11.0-openclaw.1",
      payloadRoot: "e".repeat(64),
      schemaChecksum: "f".repeat(64),
      schemaId: "gigabrain-schema-test",
      upstreamVersion: "0.11.0",
    }).package_version, "0.11.0-openclaw.1");
    assert.equal(normalizeAgentScope("main"), "profile:main");
    assert.equal(resolveWriteMode({ compat: { writeMode: "read_only" } }), "read_only");

    const packageLockSource = readFileSync("package-lock.json", "utf8");
    assert.equal(JSON.parse(packageLockSource).version, "0.11.0-openclaw.1");
    const packageLock = JSON.parse(packageLockSource);
    assert.equal(packageLock.packages[""].devDependencies.acorn, "8.18.0");
    assert.equal(packageLock.packages["node_modules/acorn"].dev, true);
    const publicReleaseManifestSource = readFileSync("public-release-manifest.json", "utf8");
    assert.equal(JSON.parse(publicReleaseManifestSource).schemaVersion, 1);
    const buildSchemaSource = readFileSync("scripts/build-openclaw-config-schema.mjs", "utf8");
    assert.match(buildSchemaSource, /openclaw\.plugin\.json/);
    const piiScannerSource = readFileSync("scripts/check-no-pii.mjs", "utf8");
    assert.match(piiScannerSource, /npm-pack-inventory/);
    const publicMirrorSource = readFileSync("scripts/check-public-mirror.mjs", "utf8");
    assert.match(publicMirrorSource, /public-release-manifest\.json/);
  });
}

runDirect(import.meta.url, run);

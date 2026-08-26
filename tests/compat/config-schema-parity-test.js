import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "4";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_CONFIG_SCHEMA_PARITY missing canonical generated configuration schema";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const SCHEMA_BUILDER_PATH = "scripts/build-openclaw-config-schema.mjs";

async function loadRealOpenClawValidator() {
  try {
    const runtime = await import("openclaw/plugin-sdk/json-schema-runtime");
    if (typeof runtime.validateJsonSchemaValue === "function") return runtime.validateJsonSchemaValue;
  } catch {
    // The compatibility checkout intentionally keeps OpenClaw a peer dependency.
  }
  const toolsRoot = path.join(os.homedir(), ".openclaw", "tools");
  let versions = [];
  try {
    versions = readdirSync(toolsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("node-"))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, "en"));
  } catch {
    versions = [];
  }
  for (const version of versions) {
    const modulePath = path.join(
      toolsRoot,
      version,
      "lib",
      "node_modules",
      "openclaw",
      "dist",
      "plugin-sdk",
      "json-schema-runtime.js",
    );
    try {
      const runtime = await import(pathToFileURL(modulePath).href);
      if (typeof runtime.validateJsonSchemaValue === "function") return runtime.validateJsonSchemaValue;
    } catch {
      // Try the next installed OpenClaw runtime.
    }
  }
  throw new Error("real OpenClaw JSON-schema validator is unavailable");
}

function collectPropertyPaths(schema, prefix = "") {
  const paths = [];
  for (const [key, child] of Object.entries(schema?.properties || {})) {
    const current = prefix ? `${prefix}.${key}` : key;
    paths.push(current, ...collectPropertyPaths(child, current));
  }
  return paths.sort((left, right) => left.localeCompare(right, "en"));
}

function collectObjectPaths(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    paths.push(current, ...collectObjectPaths(child, current));
  }
  return paths.sort((left, right) => left.localeCompare(right, "en"));
}

function productionShapedFixture() {
  return {
    enabled: true,
    compat: { writeMode: "full" },
    runtime: {
      timezone: "UTC",
      cleanupVersion: "synthetic-v3",
      paths: {
        workspaceRoot: "/synthetic/workspace",
        memoryRoot: "memory",
        registryPath: "/synthetic/registry.sqlite",
        outputDir: "output",
        reviewQueuePath: "output/review.jsonl",
      },
      reviewQueueRetention: { enabled: true },
    },
    capture: {
      enabled: true,
      requireMemoryNote: true,
      autoCapture: {
        enabled: false,
        mode: "off",
        provider: "none",
        baseUrl: "",
        model: "",
        apiKey: "",
        profile: "auto_capture",
        timeoutMs: 45000,
        minConfidence: 0.88,
        minImportance: 0.75,
        queueMinConfidence: 0.65,
        queueMinImportance: 0.5,
        minContentChars: 20,
        maxCandidates: 5,
        maxTurns: 16,
        maxCharsPerTurn: 4000,
        targetTokens: 10000,
        softMaxTokens: 15000,
        hardMaxTokens: 25000,
        includeExistingMemories: true,
        existingMemoryLimit: 80,
        minTriggerChars: 80,
        processingStaleMs: 300000,
      },
    },
    dedupe: { exactEnabled: true, semanticEnabled: true, crossScopeGlobal: false },
    recall: {
      autoInjectEnabled: true,
      embeddingProvider: "openai_compatible",
      embeddingBaseUrl: "https://synthetic.invalid/v1",
      embeddingApiKey: "",
      embeddingModel: "synthetic-embedding-model",
      embeddingDimensions: 2560,
      embeddingModelFingerprint: `sha256:${"a".repeat(64)}`,
      embeddingTimeoutMs: 5000,
      semanticRerankAlpha: 0.65,
      minScore: 0,
    },
    worldModel: {
      enabled: true,
      customSlotRules: [{ pattern: "synthetic project", flags: "i", slot: "project.synthetic.status" }],
    },
    operatorRules: {
      entity: { rejectTerms: [], nonPersonTerms: [], rejectPatterns: [], nonPersonPatterns: [] },
      memoryTier: {
        tierValues: [], durableTiers: [], opsPatterns: [], workingReferencePatterns: [],
        personalMemoryPatterns: [], projectMemoryPatterns: [], projectEpisodePatterns: [],
        projectIdentityPatterns: [], personalGoalPatterns: [], projectReferencePatterns: [],
        contactInfoPatterns: [], healthMemoryPatterns: [],
      },
      surface: {
        beliefNoisePatterns: [], beliefMetaPatterns: [], summaryWeakPatterns: [],
        personPreferredPatterns: [], projectPreferredPatterns: [], personCueTerms: [], projectCueTerms: [],
      },
      sessionBrief: { excludePatterns: [] },
    },
    agentRegistry: ["synthetic-agent"],
    synthesis: { briefing: { includeSessionPrelude: true } },
    llm: {
      provider: "none",
      apiKeyEnv: "SYNTHETIC_LLM_KEY",
      queueReview: { enabled: false, limit: 200, minConfidence: 0.8, profile: "memory_review", allowedReasons: [] },
      taskProfiles: { auto_capture: { model: "", temperature: 0.1, top_p: 0.8, top_k: 20, max_tokens: 512, reasoning: "off" } },
    },
    memoryLlm: { enabled: false, provider: "none", baseUrl: "", model: "", apiKey: "", apiKeyEnv: "", timeoutMs: 15000, maxRetries: 1 },
    native: {
      cloudInbox: { enabled: false },
      transcripts: { enabled: false },
      wiki: { enabled: false },
      vaults: [],
    },
    nativePromotion: { requireDailyMetadata: true },
    hostSync: { autoOnSetup: false, autoNightly: false },
    lifecycleHooks: { enabled: false },
    remoteMcp: { enabled: false },
    urlImport: { enabled: false, allowedHosts: [] },
    telemetry: { countersEnabled: false },
    vault: {
      enabled: false,
      path: "",
      subdir: "",
      homeNoteName: "",
      clean: false,
      exportActiveNodes: false,
      exportRecentArchivesLimit: 0,
      manualFolders: [],
      views: { enabled: false },
      reports: { enabled: false },
      inbox: { enabled: false },
    },
    remoteBridge: { enabled: false },
  };
}

export async function run() {
  const configModule = await importContractModule("lib/core/config.js", EXPECTED_SIGNATURE);
  const generator = await importContractModule("scripts/build-openclaw-config-schema.mjs", EXPECTED_SIGNATURE);
  const hostSyncModule = await importContractModule("lib/core/host-memory-sync.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const buildSchema = requireCallable(configModule, "buildOpenClawConfigSchema");
    const renderManifest = requireCallable(generator, "renderOpenClawPluginManifest");
    const schema = buildSchema();
    const manifestText = readFileSync(path.join(repoRoot, "openclaw.plugin.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.doesNotMatch(manifestText, /\/(?:home|Users)\/[A-Za-z0-9._-]+\//, "public manifest must not contain machine-specific home paths");
    assert.deepEqual(schema, configModule.V3_CONFIG_SCHEMA);
    assert.deepEqual(manifest.configSchema, schema);
    assert.equal(renderManifest(), `${JSON.stringify(manifest, null, 2)}\n`);

    const schemaPaths = new Set(collectPropertyPaths(schema));
    for (const configPath of collectObjectPaths(configModule.DEFAULT_CONFIG)) {
      assert.equal(schemaPaths.has(configPath), true, `default key missing from schema: ${configPath}`);
    }
    for (const requiredPath of [
      "compat.writeMode",
      "recall.embeddingDimensions",
      "recall.embeddingModelFingerprint",
      "hostSync.autoOnSetup",
      "hostSync.autoNightly",
      "capture.autoCapture.processingStaleMs",
      "memoryLlm.maxRetries",
      "llm.queueReview.allowedReasons",
      "nativePromotion.requireDailyMetadata",
      "vault.views.enabled",
      "agentRegistry",
      "worldModel.customSlotRules",
      "operatorRules.sessionBrief.excludePatterns",
    ]) assert.equal(schemaPaths.has(requiredPath), true, `required schema key missing: ${requiredPath}`);

    const validate = await loadRealOpenClawValidator();
    const validateValue = (value) => validate({
      schema,
      cacheKey: `gigabrain-task4-${JSON.stringify(value).length}`,
      value,
      cache: false,
    });
    assert.equal(validateValue(productionShapedFixture()).ok, true, "production-shaped redacted fixture must validate");
    for (const writeMode of ["read_only", "native_only", "full"]) {
      assert.equal(validateValue({ compat: { writeMode } }).ok, true, `${writeMode} must validate`);
    }
    assert.equal(validateValue({ compat: { writeMode: "unsafe" } }).ok, false);
    assert.equal(validateValue({ recall: { embeddingModelFingerprint: "sha256:not-a-digest" } }).ok, false);

    const docs = readFileSync(path.join(repoRoot, "docs/configuration.md"), "utf8");
    assert.match(docs, /Configuration Reference/);
    const examples = [...docs.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
    assert.ok(examples.length >= 10, "configuration docs must retain executable JSON examples");
    for (const example of examples) assert.equal(validateValue(example).ok, true, "documentation JSON must validate");

    const defaults = configModule.DEFAULT_CONFIG;
    assert.equal(defaults.hostSync.autoOnSetup, false);
    assert.equal(defaults.hostSync.autoNightly, false);
    assert.equal(defaults.native.cloudInbox.enabled, false);
    assert.equal(defaults.native.transcripts.enabled, false);
    assert.equal(defaults.native.wiki.enabled, false);
    assert.deepEqual(defaults.native.vaults, []);
    assert.equal(defaults.vault.enabled, false);
    assert.equal(defaults.remoteMcp.enabled, false);
    assert.equal(defaults.urlImport.enabled, false);
    assert.equal(defaults.telemetry.countersEnabled, false);
    assert.equal(defaults.lifecycleHooks.enabled, false);
    assert.deepEqual(defaults.agentRegistry, []);
    assert.deepEqual(defaults.worldModel.customSlotRules, []);

    const invalidOperatorConfigs = [
      { operatorRules: [] },
      { operatorRules: { entity: [] } },
      { operatorRules: { unknownFamily: {} } },
      { operatorRules: { entity: { unknownRule: [] } } },
      { operatorRules: { entity: { rejectTerms: "not-an-array" } } },
      { operatorRules: { entity: { rejectPatterns: {} } } },
      { operatorRules: { entity: { rejectPatterns: [{ pattern: "synthetic", flags: "i", extra: true }] } } },
      { operatorRules: { entity: { rejectPatterns: [{ pattern: "[", flags: "i" }] } } },
    ];
    for (const invalid of invalidOperatorConfigs) {
      assert.throws(() => configModule.normalizeConfig(invalid), /OPERATOR_RULES_(?:SCHEMA|INVALID_REGEX)/);
      assert.throws(
        () => configModule.loadResolvedConfig({ config: invalid, mode: "standalone", workspaceRoot: repoRoot }),
        /OPERATOR_RULES_(?:SCHEMA|INVALID_REGEX)/,
      );
    }

    const shouldAutoSync = requireCallable(hostSyncModule, "shouldRunAutomaticHostSync");
    const resolveHostScope = requireCallable(hostSyncModule, "resolveHostScope");
    assert.equal(shouldAutoSync(defaults, "setup"), false);
    assert.equal(shouldAutoSync(defaults, "nightly"), false);
    assert.equal(shouldAutoSync({ hostSync: { autoOnSetup: true } }, "setup"), true);
    assert.equal(shouldAutoSync({ hostSync: { autoNightly: true } }, "nightly"), true);
    assert.equal(shouldAutoSync({ hostSync: { autoOnSetup: true, autoNightly: true } }, "unknown"), false);
    assert.equal(resolveHostScope(defaults, ""), "profile:main");
    assert.equal(resolveHostScope(defaults, "project:synthetic"), "project:synthetic");

    const temp = mkdtempSync(path.join(os.tmpdir(), "gigabrain-config-schema-"));
    const first = path.join(temp, "first.json");
    const second = path.join(temp, "second.json");
    execFileSync(process.execPath, [path.join(repoRoot, SCHEMA_BUILDER_PATH), "--output", first]);
    execFileSync(process.execPath, [path.join(repoRoot, SCHEMA_BUILDER_PATH), "--output", second]);
    assert.deepEqual(readFileSync(first), readFileSync(second));

    const setupRoot = mkdtempSync(path.join(os.tmpdir(), "gigabrain-task4-setup-"));
    const setupConfig = path.join(setupRoot, "openclaw.json");
    const setupWorkspace = path.join(setupRoot, "workspace");
    writeFileSync(setupConfig, "{}\n");
    const setup = JSON.parse(execFileSync(process.execPath, [
      path.join(repoRoot, "scripts/setup-first-run.js"),
      "--config", setupConfig,
      "--workspace", setupWorkspace,
      "--skip-agents",
      "--skip-restart",
    ], {
      encoding: "utf8",
      env: { ...process.env, HOME: setupRoot, OPENCLAW_CONFIG: setupConfig },
      timeout: 30_000,
    }));
    assert.equal(setup.bootstrap.hostSync.ran, false, "setup must not auto-sync hosts by default");
    assert.equal(setup.sessionHook, "disabled", "setup must not install lifecycle hooks by default");
    rmSync(temp, { force: true, recursive: true });
    rmSync(setupRoot, { force: true, recursive: true });
  });
}

runDirect(import.meta.url, run);

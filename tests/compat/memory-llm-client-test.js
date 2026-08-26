import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { normalizeConfig, V3_CONFIG_SCHEMA } from "../../lib/core/config.js";
import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "9";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_MEMORY_LLM_CLIENT missing loopback-only stateless memory LLM";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const withMockFetch = async (handler, callback) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ options, url: String(url) });
    return handler(url, options, calls.length);
  };
  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = original;
  }
};

const activeConfig = (overrides = {}) => ({
  llm: {
    taskProfiles: {
      memory_review: {
        max_tokens: 96,
        reasoning: "off",
        temperature: 0.15,
        top_k: 20,
        top_p: 0.8,
      },
    },
  },
  memoryLlm: {
    baseUrl: "http://127.0.0.1:11434",
    enabled: true,
    maxRetries: 1,
    model: "qwen3.5:9b",
    provider: "ollama",
    timeoutMs: 15000,
    ...overrides,
  },
});

export async function run() {
  const client = await importContractModule(
    "lib/compat/memory-llm-client.js",
    EXPECTED_SIGNATURE,
  );
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const complete = requireCallable(client, "completeMemoryJson");
    const isGateway = requireCallable(client, "isOpenClawGatewayCompletionBaseUrl");
    const resolve = requireCallable(client, "resolveMemoryLlmConfig");

    assert.deepEqual(
      V3_CONFIG_SCHEMA.properties.memoryLlm.properties.provider.enum,
      ["ollama", "none"],
    );
    assert.equal("apiKey" in V3_CONFIG_SCHEMA.properties.memoryLlm.properties, false);
    assert.equal("apiKeyEnv" in V3_CONFIG_SCHEMA.properties.memoryLlm.properties, false);
    assert.equal(normalizeConfig({ memoryLlm: { provider: "openai_compatible" } }).memoryLlm.provider, "none");
    assert.equal(normalizeConfig({ memoryLlm: { provider: "openclaw" } }).memoryLlm.provider, "none");
    const releaseManifest = JSON.parse(readFileSync(path.join(repoRoot, "public-release-manifest.json"), "utf8"));
    for (const fileList of [releaseManifest.repository.files, releaseManifest.npm.files]) {
      assert.equal(fileList.includes("lib/compat/memory-llm-client.js"), true);
    }

    assert.equal(isGateway("http://127.0.0.1:18789/v1"), true);
    assert.equal(isGateway("http://localhost:18789/v1/chat/completions"), true);
    assert.equal(isGateway("http://127.0.0.1:11434"), false);

    assert.deepEqual(resolve({}), {
      baseUrl: "",
      enabled: false,
      maxRetries: 1,
      model: "",
      provider: "none",
      timeoutMs: 15000,
    });
    assert.deepEqual(resolve(activeConfig()), {
      baseUrl: "http://127.0.0.1:11434",
      enabled: true,
      maxRetries: 1,
      model: "qwen3.5:9b",
      provider: "ollama",
      timeoutMs: 15000,
    });

    for (const memoryLlm of [
      { baseUrl: "https://memory.example", enabled: true, model: "remote", provider: "ollama" },
      { baseUrl: "http://192.0.2.10:11434", enabled: true, model: "remote", provider: "ollama" },
      { baseUrl: "http://127.0.0.1:18789/v1", enabled: true, model: "recursive", provider: "ollama" },
      { baseUrl: "https://memory.example/v1", enabled: true, model: "remote", provider: "openai_compatible" },
      { baseUrl: "http://127.0.0.1:18789/v1", enabled: true, model: "recursive", provider: "openclaw" },
    ]) {
      assert.throws(
        () => resolve({ memoryLlm }),
        /MEMORY_LLM_(LOOPBACK_REQUIRED|OPENCLAW_RECURSION_REJECTED|PROVIDER_REJECTED)/,
      );
    }

    await withMockFetch(
      () => new Response(JSON.stringify({ response: "{\"decision\":\"dismiss\"}" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
      async (calls) => {
        const response = await complete({
          config: activeConfig(),
          jsonSchema: {
            additionalProperties: false,
            properties: { decision: { type: "string" } },
            required: ["decision"],
            type: "object",
          },
          profile: activeConfig().llm.taskProfiles.memory_review,
          prompt: "Return one synthetic review decision as JSON.",
        });
        assert.equal(response, "{\"decision\":\"dismiss\"}");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "http://127.0.0.1:11434/api/generate");
        assert.equal("Authorization" in (calls[0].options.headers || {}), false);
        const body = JSON.parse(String(calls[0].options.body || "{}"));
        assert.equal(body.model, "qwen3.5:9b");
        assert.equal(body.stream, false);
        assert.equal(body.think, false);
        assert.equal(body.options.num_predict, 96);
        assert.equal(body.options.temperature, 0.15);
        assert.equal(typeof body.format, "object");
        assert.equal(body.prompt.includes("synthetic review decision"), true);
      },
    );

    await withMockFetch(
      (_url, _options, callNumber) => callNumber === 1
        ? new Response("synthetic private provider body", { status: 503 })
        : new Response(JSON.stringify({ response: "{}" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      async (calls) => {
        assert.equal(await complete({ config: activeConfig(), prompt: "Return JSON." }), "{}");
        assert.equal(calls.length, 2, "one retry is allowed for a retryable local provider failure");
      },
    );

    await withMockFetch(
      () => new Response("synthetic private provider body", { status: 400 }),
      async (calls) => {
        await assert.rejects(
          () => complete({ config: activeConfig(), prompt: "Return JSON." }),
          (error) => {
            assert.match(String(error?.message || error), /memory_llm_ollama_http_400/);
            assert.equal(String(error?.message || error).includes("synthetic private provider body"), false);
            return true;
          },
        );
        assert.equal(calls.length, 1, "non-retryable failures must not be retried");
      },
    );

    let contacted = false;
    await withMockFetch(
      () => {
        contacted = true;
        return new Response(JSON.stringify({ response: "{}" }), { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => complete({ config: activeConfig({ baseUrl: "http://127.0.0.1:18789/v1" }), prompt: "Return JSON." }),
          /MEMORY_LLM_OPENCLAW_RECURSION_REJECTED/,
        );
      },
    );
    assert.equal(contacted, false, "recursive OpenClaw endpoints must fail before network access");
  });
}

runDirect(import.meta.url, run);

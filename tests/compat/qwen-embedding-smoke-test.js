import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "7";

export async function run() {
  const embeddings = await importContractModule(
    "lib/core/embedding-service.js",
    "COMPAT_QWEN_EMBEDDING_SMOKE missing local Qwen embedding transport",
  );
  const fingerprint = `sha256:${"0".repeat(64)}`;
  const config = {
    recall: {
      embeddingBaseUrl: "http://127.0.0.1:11434",
      embeddingDimensions: 2_560,
      embeddingModel: "qwen3-embedding:4b",
      embeddingModelFingerprint: fingerprint,
      embeddingProvider: "ollama",
      embeddingTimeoutMs: 60_000,
    },
  };
  const getEmbedding = requireCallable(embeddings, "getEmbedding");
  const resolveEmbeddingIdentity = requireCallable(embeddings, "resolveEmbeddingIdentity");
  const resolveEmbeddingTransport = requireCallable(embeddings, "resolveEmbeddingTransport");
  const identity = resolveEmbeddingIdentity(config);
  const transport = resolveEmbeddingTransport(config);
  assert.deepEqual(transport, { baseUrl: "http://127.0.0.1:11434", provider: "ollama" });
  const vector = await getEmbedding("synthetic Qwen smoke query", {
    baseUrl: transport.baseUrl,
    identity,
    query: true,
    timeoutMs: 60_000,
  });
  assert.equal(Array.isArray(vector), true);
  assert.equal(vector.length, identity.dimensions);
  assert.equal(vector.every(Number.isFinite), true);
  assert.equal(vector.some((value) => value !== 0), true);
}

runDirect(import.meta.url, run);

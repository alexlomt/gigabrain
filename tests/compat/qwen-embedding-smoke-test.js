import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  importContractModule,
  requireCallable,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "7";

const startSyntheticOllama = async () => {
  let observed = null;
  const embedding = Array.from({ length: 2_560 }, (_, index) => index === 0 ? 0.5 : 0.001);
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      observed = {
        body: JSON.parse(body),
        method: request.method,
        path: request.url,
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ embedding }] }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(11_434, "127.0.0.1", resolve);
  });
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    observed: () => observed,
  };
};

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
  const synthetic = process.env.CI === "true" ? await startSyntheticOllama() : null;
  let vector;
  try {
    vector = await getEmbedding("synthetic Qwen smoke query", {
      baseUrl: transport.baseUrl,
      identity,
      query: true,
      timeoutMs: 60_000,
    });
  } finally {
    if (synthetic) await synthetic.close();
  }
  assert.equal(Array.isArray(vector), true);
  assert.equal(vector.length, identity.dimensions);
  assert.equal(vector.every(Number.isFinite), true);
  assert.equal(vector.some((value) => value !== 0), true);
  if (synthetic) {
    assert.equal(synthetic.observed()?.method, "POST");
    assert.equal(synthetic.observed()?.path, "/v1/embeddings");
    assert.equal(synthetic.observed()?.body?.model, "qwen3-embedding:4b");
    assert.equal(
      synthetic.observed()?.body?.input,
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:\nsynthetic Qwen smoke query",
    );
  }
}

runDirect(import.meta.url, run);

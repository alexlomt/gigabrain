import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "7";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_EMBEDDING_IDENTITY missing model/dimension/query identity";

export async function run() {
  const configModule = await importContractModule("lib/core/config.js", EXPECTED_SIGNATURE);
  const embeddings = await importContractModule("lib/core/embedding-service.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const config = {
      recall: {
        embeddingBaseUrl: "http://127.0.0.1:11434",
        embeddingDimensions: 2_560,
        embeddingModel: "qwen3-embedding:4b",
        embeddingModelFingerprint: fingerprint,
        embeddingProvider: "ollama",
      },
    };
    const resolveIdentity = requireCallable(embeddings, "resolveEmbeddingIdentity");
    const resolveTransport = requireCallable(embeddings, "resolveEmbeddingTransport");
    const formatEmbeddingQuery = requireCallable(embeddings, "formatEmbeddingQuery");
    const isCompatibleEmbedding = requireCallable(embeddings, "isCompatibleEmbedding");
    const ensureEmbeddingStore = requireCallable(embeddings, "ensureEmbeddingStore");
    const storeEmbedding = requireCallable(embeddings, "storeEmbedding");
    const verifyAndBindLegacyEmbeddingFingerprint = requireCallable(
      embeddings,
      "verifyAndBindLegacyEmbeddingFingerprint",
    );
    assert.equal(configModule.DEFAULT_CONFIG.recall.embeddingModel, "qwen3-embedding:4b");
    assert.equal(configModule.DEFAULT_CONFIG.recall.embeddingDimensions, 2_560);
    const identity = resolveIdentity(config);
    assert.deepEqual(identity, {
      dimensions: 2_560,
      fingerprint,
      model: "qwen3-embedding:4b",
    });
    assert.deepEqual(resolveTransport(config), {
      baseUrl: "http://127.0.0.1:11434",
      provider: "ollama",
    });
    assert.equal(
      formatEmbeddingQuery("synthetic identity query"),
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:\nsynthetic identity query",
    );
    const compatible = {
      dims: 2_560,
      embedding: new Float32Array(2_560).fill(0.25),
      model: "qwen3-embedding:4b",
      model_fingerprint: fingerprint,
    };
    assert.equal(isCompatibleEmbedding(compatible, identity), true);
    assert.equal(isCompatibleEmbedding({ ...compatible, model: "bge-m3" }, identity), false);
    assert.equal(isCompatibleEmbedding({ ...compatible, dims: 1_024 }, identity), false);
    assert.equal(isCompatibleEmbedding({ ...compatible, model_fingerprint: `sha256:${"b".repeat(64)}` }, identity), false);
    assert.equal(isCompatibleEmbedding({ ...compatible, model_fingerprint: null }, identity), false);
    assert.equal(isCompatibleEmbedding({ ...compatible, embedding: Buffer.from([1, 2, 3]) }, identity), false);
    assert.equal(isCompatibleEmbedding({ ...compatible, embedding: new Float32Array(2_560) }, identity), false);
    assert.throws(
      () => resolveIdentity({ recall: { ...config.recall, embeddingDimensions: 1_024 } }),
      /identity|dimension/i,
    );
    assert.throws(
      () => resolveIdentity({ recall: { ...config.recall, embeddingModel: "bge-m3" } }),
      /identity|model/i,
    );
    assert.throws(
      () => resolveTransport({ recall: { ...config.recall, embeddingBaseUrl: "https://example.invalid" } }),
      /transport|loopback/i,
    );

    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE memory_current (memory_id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL)");
      db.prepare("INSERT INTO memory_current(memory_id, content, status) VALUES (?, ?, 'active')")
        .run("exact", "A synthetic memory used for exact embedding provenance.");
      db.prepare("INSERT INTO memory_current(memory_id, content, status) VALUES (?, ?, 'active')")
        .run("mismatch", "A synthetic memory with a cache mismatch.");
      ensureEmbeddingStore(db);
      storeEmbedding(db, {
        dims: identity.dimensions,
        embedding: compatible.embedding,
        memoryId: "exact",
        model: identity.model,
      });
      storeEmbedding(db, {
        dims: identity.dimensions,
        embedding: new Float32Array(identity.dimensions).fill(0.5),
        memoryId: "mismatch",
        model: identity.model,
      });
      const report = verifyAndBindLegacyEmbeddingFingerprint({
        apply: true,
        config,
        db,
        embedder: (content) => String(content).startsWith("A synthetic memory used")
          ? compatible.embedding
          : new Float32Array(identity.dimensions).fill(0.75),
      });
      assert.deepEqual(
        {
          bound: report.bound,
          byteExact: report.byteExact,
          mismatched: report.mismatched,
          scanned: report.scanned,
        },
        { bound: 0, byteExact: 1, mismatched: 1, scanned: 2 },
        "a single cache mismatch must prevent all legacy fingerprint binding",
      );
      assert.equal(
        db.prepare("SELECT model_fingerprint FROM memory_embeddings WHERE memory_id = ?").get("exact").model_fingerprint,
        null,
      );
      db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run("mismatch");
      const bound = verifyAndBindLegacyEmbeddingFingerprint({
        apply: true,
        config,
        db,
        embedder: () => compatible.embedding,
      });
      assert.equal(bound.bound, 1);
      assert.equal(
        db.prepare("SELECT model_fingerprint FROM memory_embeddings WHERE memory_id = ?").get("exact").model_fingerprint,
        fingerprint,
      );
    } finally {
      db.close();
    }
  });
}

runDirect(import.meta.url, run);

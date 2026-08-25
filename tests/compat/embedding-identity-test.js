import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "7";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_EMBEDDING_IDENTITY missing model/dimension/query identity";

export async function run() {
  const embeddings = await importContractModule("lib/core/embedding-service.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const resolveIdentity = requireCallable(embeddings, "resolveEmbeddingIdentity");
    const identity = resolveIdentity({
      dimensions: 2_560,
      model: "synthetic-embedding-model",
      provider: "ollama",
      queryInstruction: "Represent this query for retrieval",
    });
    assert.deepEqual(identity, {
      dimensions: 2_560,
      key: "ollama:synthetic-embedding-model:2560:Represent this query for retrieval",
      model: "synthetic-embedding-model",
      provider: "ollama",
      queryInstruction: "Represent this query for retrieval",
    });
    assert.throws(
      () => resolveIdentity({ ...identity, dimensions: 768, storedDimensions: 2_560 }),
      /dimension/i,
    );
  });
}

runDirect(import.meta.url, run);

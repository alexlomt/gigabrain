import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "11";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_MEMORY_API_PROJECTION missing projection sync contract";

export async function run() {
  const projection = await importContractModule("lib/compat/memory-api-projection.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const project = requireCallable(projection, "projectMemoryForApi");
    const row = {
      content: "Synthetic visible memory",
      memory_id: "synthetic-id",
      normalized: "synthetic visible memory",
      raw_payload: "must stay private",
      scope: "profile:synthetic",
      source_path: "/protected/source.md",
      status: "active",
    };
    assert.deepEqual(project(row, { allowedScopes: ["profile:synthetic"] }), {
      content: "Synthetic visible memory",
      memory_id: "synthetic-id",
      scope: "profile:synthetic",
      status: "active",
    });
    assert.equal(project(row, { allowedScopes: ["shared"] }), null);
  });
}

runDirect(import.meta.url, run);

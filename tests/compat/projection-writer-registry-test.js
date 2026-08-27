import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { importContractModule, requireCallable, runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "11";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_PROJECTION_WRITER_REGISTRY missing centralized projection authority";
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export async function run() {
  const projection = await importContractModule("lib/core/projection-store.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    requireCallable(projection, "mutateCurrentMemoryWithLegacyProjection");
    requireCallable(projection, "withProjectionMutationBatch");
    assert.throws(() => projection.dropLegacyMemoriesTable(null), /LEGACY_DROP_BLOCKED_COMPAT/);
    const paths = [
      ...readdirSync(path.join(repoRoot, "lib", "core"), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
        .map((entry) => `lib/core/${entry.name}`),
      "lib/compat/queue-review-service.js",
      "scripts/gigabrainctl.js",
    ].sort();
    const directWrite = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:memory_current|memories)\b/i;
    const offenders = paths.filter((relative) => relative !== "lib/core/projection-store.js"
      && directWrite.test(readFileSync(path.join(repoRoot, relative), "utf8")));
    assert.deepEqual(offenders, [], `projection writers bypassed the authority: ${offenders.join(",")}`);
    const projectionSource = readFileSync("lib/core/projection-store.js", "utf8");
    for (const required of ["withProjectionMutationBatch", "mutateCurrentMemoryWithLegacyProjection", "memory_console_metadata", "BEGIN IMMEDIATE", "SAVEPOINT", "projection:upsert", "projection:status"]) {
      assert.equal(projectionSource.includes(required), true, `projection authority omitted ${required}`);
    }
  });
}

runDirect(import.meta.url, run);

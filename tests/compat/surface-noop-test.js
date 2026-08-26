import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "10";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_SURFACE_NOOP missing mutation-gated surface refresh";

export async function run() {
  const refresh = await importContractModule("lib/operator/surface-refresh-service.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const runRefresh = requireCallable(refresh, "refreshGeneratedSurfaceAfterMutation");
    let builds = 0;
    let embeddings = 0;
    let graphs = 0;
    const callbacks = {
      buildSurface: async () => { builds += 1; return { mutationCount: 4, ok: true }; },
      buildEmbeddings: async () => { embeddings += 1; return { computed: 2, ok: true }; },
      buildGraph: async () => { graphs += 1; return { edges: 2, nodes: 3, ok: true }; },
    };
    const noop = await runRefresh({ ...callbacks, config: {}, mutationCount: 0 });
    assert.deepEqual(noop, {
      mutationCount: 0,
      ok: true,
      reason: "no_mutations",
      skipped: true,
    });
    assert.deepEqual({ builds, embeddings, graphs }, { builds: 0, embeddings: 0, graphs: 0 });

    const changed = await runRefresh({ ...callbacks, config: {}, mutationCount: 2 });
    assert.equal(changed.ok, true);
    assert.equal(changed.skipped, false);
    assert.equal(changed.inputMutationCount, 2);
    assert.deepEqual({ builds, embeddings, graphs }, { builds: 1, embeddings: 1, graphs: 1 });

    const failed = await runRefresh({
      ...callbacks,
      buildGraph: async () => ({ error: "synthetic graph failure", ok: false }),
      config: {},
      mutationCount: 1,
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.graph.ok, false);

    const maintenanceSource = readFileSync("lib/core/maintenance-service.js", "utf8");
    assert.match(maintenanceSource, /deferred_to_surface_refresh/);
    assert.doesNotMatch(maintenanceSource, /execFileSync\(process\.execPath, graphArgs/);
    const workerSource = readFileSync("scripts/auto-capture-worker.js", "utf8");
    assert.match(workerSource, /refreshGeneratedSurfaceAfterMutation/);
    assert.match(workerSource, /mutationCount:\s*Number\(result\.autoSaved/);
  });
}

runDirect(import.meta.url, run);

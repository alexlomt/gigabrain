import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { normalizeConfig } from "../lib/core/config.js";
import { runMaintenance } from "../lib/core/maintenance-service.js";
import {
  buildSupportingMemoryLines,
  classifyQueryIntent,
  orchestrateRecall,
} from "../lib/core/orchestrator.js";
import { rebuildEntityMentions } from "../lib/core/person-service.js";
import { makeConfigObject, makeTempWorkspace, openDb } from "./helpers.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.deepEqual(classifyQueryIntent("Where is the exact wording written?"), {
    reason: "source_or_exactness",
    requiresDeepLookup: true,
    strategy: "verification_lookup",
  });
  assert.equal(classifyQueryIntent("Tell me about Synthetic Project").strategy, "entity_brief");
  const lines = buildSupportingMemoryLines([{ content: "Synthetic fact", source_layer: "native", type: "CONTEXT" }]);
  assert.match(lines[0], /CONTEXT\|native/);

  const workspace = makeTempWorkspace("gb-orchestrator-explicit-entity-");
  let db;
  try {
    writeFileSync(path.join(workspace.workspace, "MEMORY.md"), [
      "# MEMORY",
      "",
      "- Riley is Jordan's partner.",
      "",
    ].join("\n"), "utf8");
    const config = normalizeConfig(
      makeConfigObject(workspace.workspace).plugins.entries.gigabrain.config,
    );
    const maintenance = runMaintenance({
      dbPath: workspace.dbPath,
      config,
      dryRun: false,
      runId: "unit-explicit-entity",
      reviewVersion: "unit-explicit-entity",
    });
    assert.equal(maintenance?.ok, true);
    db = openDb(workspace.dbPath);
    rebuildEntityMentions(db);
    const result = orchestrateRecall({
      db,
      config,
      query: "wer ist riley?",
      scope: "shared",
    });
    assert.equal(result.strategy, "entity_brief");
    assert.equal(result.deepLookupAllowed, false);
  } finally {
    db?.close();
    rmSync(workspace.root, { recursive: true, force: true });
  }
}
runDirect(import.meta.url, run);

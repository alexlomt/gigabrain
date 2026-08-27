import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { normalizeConfig } from "../lib/core/config.js";
import { DAILY_SEQUENCE, runMaintenance } from "../lib/core/maintenance-service.js";
import { makeConfigObject, makeTempWorkspace, openDb } from "./helpers.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(new Set(DAILY_SEQUENCE).size, DAILY_SEQUENCE.length);
  assert.ok(DAILY_SEQUENCE.indexOf("10 wiki_reconcile_optional") < DAILY_SEQUENCE.indexOf("13 belief_arbitration"));
  assert.ok(DAILY_SEQUENCE.indexOf("13 belief_arbitration") < DAILY_SEQUENCE.indexOf("22 wiki_projection_optional"));
  assert.equal(DAILY_SEQUENCE.at(-1), "24 final_integrity_and_run_receipt");

  const temp = makeTempWorkspace("gb-maintenance-host-gate-");
  const codexHome = path.join(temp.root, "codex-home");
  fs.mkdirSync(path.join(codexHome, "memories"), { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "memories", "synthetic.md"),
    "- Synthetic host memory that must not be auto-imported.\n",
  );
  const config = normalizeConfig(makeConfigObject(temp.workspace).plugins.entries.gigabrain.config);
  const initial = openDb(temp.dbPath);
  initial.close();
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const result = runMaintenance({
      config,
      dbPath: temp.dbPath,
      dryRun: true,
      runId: "task4-maintenance-host-gate",
      reviewVersion: "task4-fix-round-1",
    });
    assert.equal(result.eventCounts.host_sync_sources, 0);
    assert.equal(result.eventCounts.host_sync_inserted, 0);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(temp.root, { force: true, recursive: true });
  }
}
runDirect(import.meta.url, run);

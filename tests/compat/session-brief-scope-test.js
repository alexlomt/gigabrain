import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { normalizeConfig } from "../../lib/core/config.js";
import { rebuildEntityMentions } from "../../lib/core/person-service.js";
import { listSyntheses, rebuildWorldModel } from "../../lib/core/world-model.js";
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from "../helpers.js";
import { runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "8";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_SESSION_BRIEF_SCOPE missing exact-scope session syntheses";

const NOW = "2026-08-26T00:00:00.000Z";

const preference = (memoryId, content, scope) => ({
  memory_id: memoryId,
  type: "PREFERENCE",
  content,
  scope,
  confidence: 0.96,
  value_score: 0.92,
  value_label: "core",
  source_path: "MEMORY.md",
  created_at: NOW,
  updated_at: NOW,
});

const assertContainsOnly = (brief, included, excluded) => {
  for (const value of included) assert.match(brief.content, new RegExp(value, "i"));
  for (const value of excluded) assert.doesNotMatch(brief.content, new RegExp(value, "i"));
};

export async function run() {
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const workspace = makeTempWorkspace("gigabrain-task8-session-brief-");
    const db = openDb(workspace.dbPath);
    try {
      const config = normalizeConfig(makeConfigObject(workspace.workspace).plugins.entries.gigabrain.config);
      config.operatorRules.sessionBrief.excludePatterns = [{ pattern: "forbidden beacon", flags: "i" }];
      seedMemoryCurrent(db, [
        preference("shared", "The user prefers shared compass mode.", "shared"),
        preference("profile", "The user prefers private cedar mode.", "profile:synthetic"),
        preference("agent", "The user prefers agent amber mode.", "synthetic-agent"),
        preference("agent-excluded", "The user prefers forbidden beacon mode.", "synthetic-agent"),
        preference("project", "The user prefers project violet mode.", "project:synthetic"),
      ]);
      rebuildEntityMentions(db);
      rebuildWorldModel({ db, config, now: NOW });

      const rows = listSyntheses(db, { kind: "session_brief", limit: 50 });
      assert.equal(rows.some((row) => row.subject_type === "global"), false, "a mixed global brief is unsafe");
      const byScope = new Map(rows.map((row) => [String(row.payload?.scope || row.subject_id), row]));
      assert.deepEqual(
        [...byScope.keys()].sort(),
        ["profile:synthetic", "project:synthetic", "shared", "synthetic-agent"],
      );

      assertContainsOnly(byScope.get("shared"), ["shared compass"], ["private cedar", "agent amber", "project violet", "forbidden beacon"]);
      assertContainsOnly(byScope.get("profile:synthetic"), ["shared compass", "private cedar"], ["agent amber", "project violet", "forbidden beacon"]);
      assertContainsOnly(byScope.get("synthetic-agent"), ["shared compass", "agent amber"], ["private cedar", "project violet", "forbidden beacon"]);
      assertContainsOnly(byScope.get("project:synthetic"), ["project violet"], ["shared compass", "private cedar", "agent amber", "forbidden beacon"]);
    } finally {
      db.close();
      rmSync(workspace.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { normalizeConfig } from "../lib/core/config.js";
import { applyMemoryActions, parseMemoryActions } from "../lib/core/memory-actions.js";
import { runDirect } from "./restored-private-test-helpers.js";
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from "./helpers.js";

const ACTION_SCOPES = Object.freeze([
  "profile:main",
  "paperclip-ceo",
  "scrapling-research-operator",
  "higgsfield-creator",
  "linkedin-public-evidence-operator",
  "shared",
]);

const ACTION_FIXTURES = Object.freeze([
  { action: "forget", status: "active" },
  { action: "update", content: "Updated synthetic foreign fact.", status: "active" },
  { action: "replace", content: "Replacement synthetic foreign fact.", status: "active" },
  { action: "protect", status: "active" },
  { action: "reinstate", status: "superseded" },
]);

const assertCrossScopeActionsAreIsolated = () => {
  let pair = 0;
  for (const actorScope of ACTION_SCOPES) {
    for (const foreignScope of ACTION_SCOPES) {
      if (foreignScope === actorScope) continue;
      pair += 1;
      const temp = makeTempWorkspace(`gb-action-scope-${pair}-`);
      const db = openDb(temp.dbPath);
      const config = normalizeConfig(makeConfigObject(temp.workspace).plugins.entries.gigabrain.config);
      try {
        const rows = [];
        const actions = [];
        for (const fixture of ACTION_FIXTURES) {
          const memoryId = `foreign-${pair}-${fixture.action}`;
          const content = `Foreign ${fixture.action} fact for pair ${pair}.`;
          rows.push({
            memory_id: memoryId,
            content,
            scope: foreignScope,
            status: fixture.status,
            type: "USER_FACT",
          });
          actions.push({
            action: fixture.action,
            confidence: 0.95,
            content: fixture.content || "",
            scope: foreignScope,
            target_memory_id: memoryId,
            target: "",
            type: "USER_FACT",
          });
          if (fixture.action !== "reinstate") {
            const fuzzyId = `foreign-${pair}-${fixture.action}-fuzzy`;
            const fuzzyContent = `Foreign fuzzy ${fixture.action} fact for pair ${pair}.`;
            rows.push({
              memory_id: fuzzyId,
              content: fuzzyContent,
              scope: foreignScope,
              status: "active",
              type: "USER_FACT",
            });
            actions.push({
              action: fixture.action,
              confidence: 0.95,
              content: fixture.content || "",
              scope: foreignScope,
              target_memory_id: "",
              target: fuzzyContent,
              type: "USER_FACT",
            });
          }
        }
        seedMemoryCurrent(db, rows);
        const summary = applyMemoryActions({
          db,
          config,
          event: {
            agentId: actorScope === "profile:main" ? "main" : actorScope,
            scope: actorScope,
            sessionKey: `agent:synthetic:${pair}`,
          },
          actions,
          logger: { info: () => {}, warn: () => {} },
          runId: `action-scope-${pair}`,
          reviewVersion: "task4-fix-round-1",
        });

        assert.equal(summary.applied, 0, `${actorScope} must not mutate ${foreignScope}`);
        for (const seeded of rows) {
          const stored = db.prepare(`
            SELECT content, scope, status, superseded_by, tags
            FROM memory_current
            WHERE memory_id = ?
          `).get(seeded.memory_id);
          assert.equal(stored?.scope, foreignScope);
          assert.equal(stored?.content, seeded.content);
          assert.equal(stored?.status, seeded.status);
          assert.equal(stored?.superseded_by || null, seeded.superseded_by || null);
          assert.doesNotMatch(String(stored?.tags || ""), /protected/i);
        }
        assert.equal(
          Number(db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE source = 'memory_action'").get()?.c || 0),
          0,
          "foreign updates/replacements must not insert a local replacement",
        );
        const queuePath = path.join(temp.outputRoot, "memory-review-queue.jsonl");
        if (fs.existsSync(queuePath)) {
          const queued = fs.readFileSync(queuePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
          const surfacedCandidates = queued.flatMap((row) => row?.payload?.candidates || []);
          assert.equal(
            surfacedCandidates.some((candidate) => rows.some((row) => row.memory_id === candidate.memory_id)),
            false,
            "foreign-scope candidates must not be surfaced for review",
          );
        }
      } finally {
        db.close();
        fs.rmSync(temp.root, { force: true, recursive: true });
      }
    }
  }
};

export async function run() {
  const actions = parseMemoryActions('<memory_action action="remember" type="DECISION" confidence="high" scope="profile:synthetic">Use the harbour plan.</memory_action>');
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    action: "remember",
    confidence: 0.9,
    content: "Use the harbour plan.",
    durability: "auto",
    raw_tag: "memory_action",
    reason: "",
    scope: "profile:synthetic",
    target: "",
    target_memory_id: "",
    type: "DECISION",
  });
  assert.deepEqual(parseMemoryActions("<memory_action action=invalid>ignored</memory_action>"), []);
  assertCrossScopeActionsAreIsolated();
}
runDirect(import.meta.url, run);

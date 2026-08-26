import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "4";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_DEDUPE_SCOPE_ISOLATION missing same-scope automatic dedupe isolation";

export async function run() {
  const policy = await importContractModule("lib/compat/scope-policy.js", EXPECTED_SIGNATURE);
  const captureModule = await importContractModule("lib/core/capture-service.js", EXPECTED_SIGNATURE);
  const configModule = await importContractModule("lib/core/config.js", EXPECTED_SIGNATURE);
  const helpers = await importContractModule("tests/helpers.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const sameScope = requireCallable(policy, "isAutomaticDedupeScopeMatch");
    const capture = requireCallable(captureModule, "captureFromEvent");
    const normalizeConfig = requireCallable(configModule, "normalizeConfig");
    const makeTempWorkspace = requireCallable(helpers, "makeTempWorkspace");
    const makeConfigObject = requireCallable(helpers, "makeConfigObject");
    const openDb = requireCallable(helpers, "openDb");

    assert.equal(sameScope("shared", "shared"), true);
    assert.equal(sameScope("main", "profile:main"), true);
    assert.equal(sameScope("shared", "profile:main"), false);
    assert.equal(sameScope("paperclip-ceo", "higgsfield-creator"), false);

    const temp = makeTempWorkspace("gb-task4-dedupe-");
    const config = normalizeConfig(makeConfigObject(temp.workspace).plugins.entries.gigabrain.config);
    const db = openDb(temp.dbPath);
    const remember = (scope, content) => capture({
      db,
      config,
      event: {
        agentId: "synthetic-agent",
        scope,
        sessionKey: `agent:synthetic:${scope}`,
        text: `<memory_note type="USER_FACT" confidence="0.95">${content}</memory_note>`,
      },
      logger: { info: () => {}, warn: () => {} },
      reviewVersion: "task4-synthetic",
      runId: "task4-synthetic",
    });

    try {
      const content = "The synthetic operator prefers deterministic fixtures.";
      assert.equal(remember("shared", content).inserted, 1);
      assert.equal(remember("paperclip-ceo", content).inserted, 1, "shared to named must not auto-dedupe");
      assert.equal(remember("higgsfield-creator", content).inserted, 1, "named to named must not auto-dedupe");
      const sameScopeDuplicate = remember("paperclip-ceo", content);
      assert.equal(sameScopeDuplicate.inserted, 0);
      assert.equal(sameScopeDuplicate.dropped_exact_duplicate, 1, "same exact scope must auto-dedupe");

      const rows = db.prepare(`
        SELECT scope, status, superseded_by
        FROM memory_current
        WHERE content = ?
        ORDER BY scope ASC
      `).all(content);
      assert.deepEqual(rows.map((row) => row.scope), ["higgsfield-creator", "paperclip-ceo", "shared"]);
      assert.equal(rows.every((row) => row.status === "active" && row.superseded_by == null), true);
    } finally {
      db.close();
    }
  });
}

runDirect(import.meta.url, run);

import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "4";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_SCOPE_VISIBILITY missing fail-closed scope visibility matrix";

const NAMED_SCOPES = Object.freeze([
  "profile:main",
  "paperclip-ceo",
  "scrapling-research-operator",
  "higgsfield-creator",
  "linkedin-public-evidence-operator",
]);

export async function run() {
  const policy = await importContractModule("lib/compat/scope-policy.js", EXPECTED_SIGNATURE);
  const captureModule = await importContractModule("lib/core/capture-service.js", EXPECTED_SIGNATURE);
  const configModule = await importContractModule("lib/core/config.js", EXPECTED_SIGNATURE);
  const helpers = await importContractModule("tests/helpers.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const normalize = requireCallable(policy, "normalizeAgentScope");
    const resolve = requireCallable(policy, "resolveVisibleScopes");

    assert.equal(normalize("main"), "profile:main");
    assert.equal(normalize(" profile:main "), "profile:main");
    assert.equal(normalize(""), "shared");
    assert.equal(normalize("project:oasis"), "project:oasis");

    assert.deepEqual(resolve({ requestedScope: "main" }), ["profile:main", "shared"]);
    assert.deepEqual(resolve({ requestedScope: "paperclip-ceo" }), ["paperclip-ceo", "shared"]);
    assert.deepEqual(resolve({ requestedScope: "scrapling-research-operator" }), [
      "scrapling-research-operator",
      "shared",
    ]);
    assert.deepEqual(resolve({ requestedScope: "higgsfield-creator" }), ["higgsfield-creator", "shared"]);
    assert.deepEqual(resolve({ requestedScope: "linkedin-public-evidence-operator" }), [
      "linkedin-public-evidence-operator",
      "shared",
    ]);
    assert.deepEqual(resolve({ requestedScope: "project:oasis" }), ["project:oasis"]);
    assert.deepEqual(resolve({ requestedScope: "", remote: false }), ["shared"]);
    assert.deepEqual(resolve({ requestedScope: "profile:main", includeShared: false }), ["profile:main"]);
    assert.deepEqual(resolve({ requestedScope: "paperclip-ceo-lookalike" }), ["paperclip-ceo-lookalike"]);
    assert.deepEqual(resolve({ requestedScope: "unregistered-local-agent" }), ["unregistered-local-agent"]);
    assert.deepEqual(resolve({ requestedScope: "profile:unregistered" }), ["profile:unregistered"]);

    // A remote authority supplies exact scopes only. Local shared/profile
    // overlays are never inferred across that trust boundary.
    assert.deepEqual(resolve({ requestedScope: "main", remote: true }), ["profile:main"]);
    assert.deepEqual(resolve({ requestedScope: "paperclip-ceo", remote: true }), ["paperclip-ceo"]);
    assert.deepEqual(resolve({ requestedScope: "", remote: true }), []);
    assert.deepEqual(resolve({
      requestedScope: ["profile:main", "shared"],
      remote: ["shared", "project:oasis"],
    }), ["shared"]);

    for (const requested of NAMED_SCOPES) {
      const visible = new Set(resolve({ requestedScope: requested }));
      for (const other of NAMED_SCOPES) {
        if (other === requested) continue;
        assert.equal(visible.has(other), false, `${requested} must not see ${other}`);
      }
    }

    // Scope comes from the trusted event envelope. A model-authored scope
    // attribute is untrusted content and cannot redirect a write.
    const temp = requireCallable(helpers, "makeTempWorkspace")("gb-task4-scope-authority-");
    const db = requireCallable(helpers, "openDb")(temp.dbPath);
    const config = requireCallable(configModule, "normalizeConfig")(
      requireCallable(helpers, "makeConfigObject")(temp.workspace).plugins.entries.gigabrain.config,
    );
    try {
      const summary = requireCallable(captureModule, "captureFromEvent")({
        db,
        config,
        event: {
          agentId: "main",
          scope: "main",
          sessionKey: "agent:main:synthetic",
          text: '<memory_note type="USER_FACT" scope="paperclip-ceo" confidence="0.95">Synthetic trusted-scope fact.</memory_note>',
        },
        logger: { info: () => {}, warn: () => {} },
      });
      assert.equal(summary.inserted, 1);
      const row = db.prepare("SELECT scope FROM memory_current WHERE content = ? LIMIT 1")
        .get("Synthetic trusted-scope fact.");
      assert.equal(row?.scope, "profile:main");
    } finally {
      db.close();
    }
  });
}

runDirect(import.meta.url, run);

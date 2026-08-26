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

    // A remote authority supplies exact scopes only. Local shared/profile
    // overlays are never inferred across that trust boundary.
    assert.deepEqual(resolve({ requestedScope: "main", remote: true }), ["profile:main"]);
    assert.deepEqual(resolve({ requestedScope: "paperclip-ceo", remote: true }), ["paperclip-ceo"]);
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
  });
}

runDirect(import.meta.url, run);

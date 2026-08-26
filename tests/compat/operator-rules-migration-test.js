import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "4";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OPERATOR_RULES_MIGRATION missing protected deterministic operator rules migration";

export async function run() {
  const migration = await importContractModule("scripts/build-operator-rules-migration.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const build = requireCallable(migration, "buildOperatorRulesMigration");
    const fixture = {
      customSlotRules: [{
        flags: "i",
        operation: "update",
        pattern: "synthetic\\s+project",
        slot: "project.synthetic.status",
        subtopic: "status",
        topic: "project",
      }],
      operatorRules: {
        entity: {
          nonPersonPatterns: [{ flags: "i", pattern: "synthetic-tool" }],
          nonPersonTerms: ["synthetic-tool"],
          rejectPatterns: [],
          rejectTerms: ["synthetic-noise"],
        },
        memoryTier: {
          contactInfoPatterns: [], durableTiers: ["durable"], healthMemoryPatterns: [],
          opsPatterns: [], personalGoalPatterns: [], personalMemoryPatterns: [],
          projectEpisodePatterns: [], projectIdentityPatterns: [], projectMemoryPatterns: [],
          projectReferencePatterns: [], tierValues: ["durable"], workingReferencePatterns: [],
        },
        sessionBrief: { excludePatterns: [{ flags: "i", pattern: "synthetic-noise" }] },
        surface: {
          beliefMetaPatterns: [], beliefNoisePatterns: [], personCueTerms: [],
          personPreferredPatterns: [], projectCueTerms: [], projectPreferredPatterns: [], summaryWeakPatterns: [],
        },
      },
      sourceBindings: [{
        fileSha256: "a".repeat(64),
        path: "lib/core/synthetic.js",
        symbol: "SYNTHETIC_RULES",
        symbolSha256: "b".repeat(64),
      }],
    };
    const input = {
      canary: { configOnly: true, ok: true, secretStripped: true, validator: "openclaw-json-schema" },
      deployedSource: { commit: "c".repeat(40), tree: "d".repeat(40) },
      finalProtectedConfigSha256: "e".repeat(64),
      handoffSha256: "f".repeat(64),
      reviewerApprovals: [],
      sourceProtectedConfigSha256: "1".repeat(64),
      ...fixture,
    };
    const first = build(input);
    const second = build(input);
    assert.deepEqual(first, second, "migration payload must be deterministic");
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.artifactKind, "operator-rules-migration");
    assert.equal(first.mechanicalReview.status, "mechanical_only");
    assert.equal(first.privateRulePayloadSha256.length, 64);
    assert.equal(first.valueArtifactSha256, first.privateRulePayloadSha256);
    assert.deepEqual(first.customSlotRules, fixture.customSlotRules);
    assert.deepEqual(first.operatorRules, fixture.operatorRules);
    assert.throws(
      () => build({ ...input, customSlotRules: [{ ...fixture.customSlotRules[0], pattern: "[" }] }),
      /OPERATOR_RULES_INVALID_REGEX/,
    );
    assert.throws(
      () => build({ ...input, nonMechanicalChoices: ["invent a semantic mapping"] }),
      /OPERATOR_RULES_NON_MECHANICAL_REVIEW_REQUIRED/,
    );
    assert.doesNotMatch(JSON.stringify(first), /api[_-]?key|auth[_-]?token|credential/i);
  });
}

runDirect(import.meta.url, run);

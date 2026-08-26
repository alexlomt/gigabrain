import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";

import { normalizeConfig } from "../../lib/core/config.js";
import { rebuildEntityMentions, splitNameCandidates } from "../../lib/core/person-service.js";
import { listEntities, rebuildWorldModel } from "../../lib/core/world-model.js";
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from "../helpers.js";
import { runBehaviorContract, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "8";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_ENTITY_TAXONOMY missing compound, title, and non-person entity contracts";

const NOW = "2026-08-26T00:00:00.000Z";

const memoryRow = (memoryId, type, content, scope = "shared") => ({
  memory_id: memoryId,
  type,
  content,
  scope,
  confidence: 0.96,
  value_score: 0.92,
  value_label: "core",
  source_path: "MEMORY.md",
  created_at: NOW,
  updated_at: NOW,
});

const entityNames = (rows) => new Set(rows.map((row) => String(row.normalized_name || "")));

export async function run() {
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const titleFixture = splitNameCandidates(
      "Chief Operating Officer Mira Vexley leads Project Synthetic Harbour.",
    );
    assert.ok(titleFixture.includes("mira vexley"));
    assert.ok(titleFixture.includes("synthetic harbour"));
    for (const falseEntity of ["chief", "operating", "officer", "chief operating officer"]) {
      assert.equal(titleFixture.includes(falseEntity), false, `${falseEntity} is a title, not an entity`);
    }

    const organizationFixture = splitNameCandidates(
      "Organization Aurora Signal Labs coordinates the research programme.",
    );
    assert.ok(organizationFixture.includes("aurora signal labs"));
    for (const fragment of ["aurora", "signal", "labs"]) {
      assert.equal(organizationFixture.includes(fragment), false, `${fragment} must not fragment the organization`);
    }

    const verificationFixture = splitNameCandidates(
      "Research operator Indigo Quill uses Verification Token ZXQ-491.",
    );
    assert.ok(verificationFixture.includes("indigo quill"));
    for (const falseEntity of ["research", "operator", "verification", "token"]) {
      assert.equal(verificationFixture.includes(falseEntity), false, `${falseEntity} is operational vocabulary`);
    }

    const workspace = makeTempWorkspace("gigabrain-task8-entity-taxonomy-");
    writeFileSync(
      `${workspace.workspace}/IDENTITY.md`,
      "# Identity\n\n- **Name:** Harbor Wren\n",
      "utf8",
    );
    writeFileSync(
      `${workspace.workspace}/USER.md`,
      "# User\n\n- **Name:** Casey Vale\n- **What to call them:** Casey\n",
      "utf8",
    );
    const db = openDb(workspace.dbPath);
    try {
      const config = normalizeConfig(makeConfigObject(workspace.workspace).plugins.entries.gigabrain.config);
      config.operatorRules.entity.rejectTerms = ["synthetic noise"];
      config.operatorRules.entity.nonPersonTerms = ["synthetic runtime", "verification token"];
      seedMemoryCurrent(db, [
        memoryRow("agent-main", "AGENT_IDENTITY", "Harbor Wren is the main agent.", "profile:synthetic"),
        memoryRow("agent-ceo", "AGENT_IDENTITY", "Chief Executive Officer Mira Vexley is the executive agent.", "synthetic-ceo"),
        memoryRow("agent-research", "AGENT_IDENTITY", "Research operator Indigo Quill is the research agent.", "synthetic-research"),
        memoryRow("agent-creative", "AGENT_IDENTITY", "Creative operator Sable North is the creative agent.", "synthetic-creative"),
        memoryRow("agent-evidence", "AGENT_IDENTITY", "Evidence operator Rowan Pike is the evidence agent.", "synthetic-evidence"),
        memoryRow("project-1", "CONTEXT", "Project Synthetic Harbour coordinates the rollout."),
        memoryRow("project-2", "DECISION", "Project Synthetic Harbour owns the release decision."),
        memoryRow("org-1", "CONTEXT", "Organization Aurora Signal Labs provides research."),
        memoryRow("org-2", "CONTEXT", "Organization Aurora Signal Labs maintains the service."),
        memoryRow("non-person-1", "AGENT_IDENTITY", "Synthetic Runtime is a system agent, not a person."),
        memoryRow("non-person-2", "AGENT_IDENTITY", "Verification Token is a system identity, not a person."),
        memoryRow("rejected", "ENTITY", "Synthetic Noise is an explicit rejected entity."),
      ]);

      rebuildEntityMentions(db);
      const rebuilt = rebuildWorldModel({ db, config, now: NOW });
      assert.equal(rebuilt.ok, true);
      assert.ok(rebuilt.counts.entities >= 7);
      const entities = listEntities(db, { includeHidden: true, limit: 200 });
      const names = entityNames(entities);
      const byName = new Map(entities.map((row) => [row.normalized_name, row]));

      for (const name of ["harbor wren", "mira vexley", "indigo quill", "sable north", "rowan pike"]) {
        assert.equal(byName.get(name)?.kind, "person", `${name} must remain a compound person entity`);
      }
      assert.equal(byName.get("synthetic harbour")?.kind, "project");
      assert.equal(byName.get("aurora signal labs")?.kind, "organization");

      for (const fragment of [
        "harbor", "wren", "mira", "vexley", "indigo", "quill", "sable", "north", "rowan", "pike",
        "synthetic", "harbour", "aurora", "signal", "labs",
      ]) {
        assert.equal(names.has(fragment), false, `${fragment} must not survive as a fragmented entity`);
      }
      for (const rejected of ["chief executive officer", "synthetic noise"]) {
        assert.equal(names.has(rejected), false, `${rejected} must not enter the entity graph`);
      }
      for (const nonPerson of ["synthetic runtime", "verification token"]) {
        assert.notEqual(byName.get(nonPerson)?.kind, "person", `${nonPerson} must never become a person`);
      }
    } finally {
      db.close();
      rmSync(workspace.root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

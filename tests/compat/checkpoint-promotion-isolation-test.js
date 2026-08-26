import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  appendCheckpointEpisode,
  getClaimProposal,
  listClaimProposals,
} from "../../lib/core/control-plane.js";
import { parseLegacyCheckpointMarkdown } from "../../lib/core/checkpoint-migration.js";
import { ensureProjectionStore } from "../../lib/core/projection-store.js";
import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "6";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_CHECKPOINT_ISOLATION missing metadata-gated checkpoint promotion";

export async function run() {
  const metadata = await importContractModule("lib/compat/native-metadata.js", EXPECTED_SIGNATURE);
  const nativeMemory = await importContractModule("lib/core/native-memory.js", EXPECTED_SIGNATURE);
  const nativeSync = await importContractModule("lib/core/native-sync.js", EXPECTED_SIGNATURE);
  const promotion = await importContractModule("lib/core/native-promotion.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const parseNativeMetadata = requireCallable(metadata, "parseNativeMetadata");
    const writeNativeSessionCheckpoint = requireCallable(nativeMemory, "writeNativeSessionCheckpoint");
    const ensureNativeStore = requireCallable(nativeSync, "ensureNativeStore");
    const syncNativeMemory = requireCallable(nativeSync, "syncNativeMemory");
    const isPromotionEligibleChunk = requireCallable(promotion, "isPromotionEligibleChunk");
    const promoteNativeChunks = requireCallable(promotion, "promoteNativeChunks");

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-checkpoint-isolation-contract-"));
    const memoryRoot = path.join(root, "memory");
    const filePath = path.join(memoryRoot, "2026-08-25.md");
    mkdirSync(memoryRoot, { recursive: true });
    const config = {
      compat: { writeMode: "full" },
      runtime: { paths: {
        workspaceRoot: root,
        memoryRoot,
        nativeLockDir: path.join(root, "runtime", "native-memory.lockdir"),
      } },
      native: {
        enabled: true,
        memoryMdPath: path.join(root, "MEMORY.md"),
        dailyNotesGlob: "memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md",
        includeFiles: [],
        excludeGlobs: [],
      },
      nativePromotion: {
        enabled: true,
        promoteFromDaily: true,
        promoteFromMemoryMd: true,
        requireDailyMetadata: true,
        minConfidence: 0.72,
      },
      quality: {
        durableEnabled: true,
        durablePatternsAppend: ["always", "decision"],
        valueThresholds: { keep: 0.5, archive: 0.3, reject: 0.18 },
      },
      dedupe: { semanticEnabled: true, autoThreshold: 0.92, reviewThreshold: 0.85 },
    };

    try {
      const first = writeNativeSessionCheckpoint({
        config,
        timestamp: "2026-08-25T12:00:00.000Z",
        surface: "codex",
        sessionLabel: "synthetic-session",
        summary: "Implemented the synthetic checkpoint isolation contract.",
        decisions: ["Always preserve checkpoint origin isolation."],
        openLoops: ["Verify the synthetic checkpoint stress fixture."],
        touchedFiles: ["lib/core/native-memory.js"],
        durableCandidates: ["Always keep this candidate pending explicit owner review."],
        scope: "project:synthetic",
      });
      assert.equal(first.written, true);
      const second = writeNativeSessionCheckpoint({
        config,
        timestamp: "2026-08-25T12:01:00.000Z",
        surface: "codex",
        sessionLabel: "synthetic-session",
        summary: "Implemented the synthetic checkpoint isolation contract.",
        decisions: ["Always preserve checkpoint origin isolation."],
        openLoops: ["Verify the synthetic checkpoint stress fixture."],
        touchedFiles: ["lib/core/native-memory.js"],
        durableCandidates: ["Always keep this candidate pending explicit owner review."],
        scope: "project:synthetic",
      });
      assert.equal(second.written, false, "same-session checkpoint material must stay duplicate-free before Task 13 DB uniqueness");

      writeFileSync(
        filePath,
        `${readFileSync(filePath, "utf8")}\n## Codex App Sessions\n\n- Codex App session (legacy-mixed): Imported one coexisting legacy checkpoint. <!-- gigabrain:scope=project:legacy -->\n\n## Decisions\n\n- Decision: Always retain this ordinary human decision. <!-- gigabrain:scope=project:synthetic type=DECISION -->\n- Decision: Preserve the coexisting legacy checkpoint decision. <!-- gigabrain:scope=project:legacy -->\n`,
      );
      const text = readFileSync(filePath, "utf8");
      assert.match(text, /gigabrain:origin=structured_checkpoint/);
      const checkpointBullets = text.split("\n").filter((line) => line.startsWith("-") && line.includes("structured_checkpoint"));
      assert.equal(checkpointBullets.length, 5);
      for (const line of checkpointBullets) {
        const parsed = parseNativeMetadata(line);
        assert.equal(parsed.originKind, "structured_checkpoint");
        assert.equal(parsed.scope, "project:synthetic");
        assert.ok(parsed.type);
      }
      const mixedLegacy = parseLegacyCheckpointMarkdown(text, { defaultScope: "project:fallback" });
      assert.equal(mixedLegacy.length, 1, "a structured marker must not discard coexisting legacy checkpoint bullets");
      assert.deepEqual(
        {
          decisions: mixedLegacy[0].decisions,
          scope: mixedLegacy[0].scope,
          summary: mixedLegacy[0].summary,
        },
        {
          decisions: ["Preserve the coexisting legacy checkpoint decision."],
          scope: "project:legacy",
          summary: "Imported one coexisting legacy checkpoint.",
        },
      );
      assert.equal(
        JSON.stringify(mixedLegacy).includes("ordinary human decision"),
        false,
        "typed human-native bullets must not enter the legacy importer",
      );
      assert.equal(
        JSON.stringify(mixedLegacy).includes("synthetic checkpoint isolation contract"),
        false,
        "structured checkpoint bullets must not re-enter the legacy importer",
      );

      const db = new DatabaseSync(path.join(memoryRoot, "registry.sqlite"));
      try {
        ensureProjectionStore(db);
        ensureNativeStore(db);
        syncNativeMemory({ db, config, sourcePaths: [filePath], dryRun: false });
        const chunks = db.prepare(`
          SELECT content, memory_type, origin_kind, linked_memory_id, section,
                 source_kind, scope, status, first_seen_at, last_seen_at
          FROM memory_native_chunks
          WHERE source_path=? AND status='active'
          ORDER BY line_start
        `).all(filePath);
        const checkpointChunks = chunks.filter((row) => row.origin_kind === "structured_checkpoint");
        const ordinary = chunks.find((row) => row.content.includes("ordinary human decision"));
        assert.equal(checkpointChunks.length, 5);
        assert.equal(checkpointChunks.every((row) => isPromotionEligibleChunk(row, { config }) === false), true);
        assert.equal(ordinary.origin_kind, "human_native");
        assert.equal(ordinary.memory_type, "DECISION");
        assert.equal(isPromotionEligibleChunk(ordinary, { config }), true, "ordinary annotated Decisions sections remain eligible");

        const promoted = promoteNativeChunks({ db, config, sourcePaths: [filePath], dryRun: false });
        assert.equal(promoted.promoted_inserted, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_current").get().n, 1);
        assert.equal(
          db.prepare("SELECT COUNT(*) AS n FROM memory_native_chunks WHERE origin_kind='structured_checkpoint' AND linked_memory_id IS NOT NULL").get().n,
          0,
        );

        const episode = appendCheckpointEpisode(db, {
          timestamp: "2026-08-25T13:00:00.000Z",
          sessionId: "ses_checkpoint_contract",
          scope: "project:synthetic",
          sourceAgent: "codex",
          sourceClient: "codex",
          sourceHost: "fixture-host",
          summary: "Checkpoint candidate remains a proposal.",
          durableCandidates: ["Always keep one synthetic checkpoint candidate pending review."],
          evidence: ["test:checkpoint-isolation"],
        });
        assert.equal(episode.checkpoint.proposal_ids.length, 1);
        assert.equal(listClaimProposals(db, { status: "proposed" }).length, 1);
        const proposal = getClaimProposal(db, episode.checkpoint.proposal_ids[0]);
        assert.equal(proposal.status, "proposed");
        assert.equal(proposal.memory_id, null);
        assert.equal(episode.checkpoint.payload.origin_kind, "structured_checkpoint");
        assert.equal(proposal.payload.origin_kind, "structured_checkpoint");
        const structuredItemPayloads = db.prepare(`
          SELECT payload FROM memory_checkpoint_items WHERE checkpoint_id=? ORDER BY position
        `).all(episode.checkpoint.checkpoint_id).map((row) => JSON.parse(row.payload));
        assert.equal(structuredItemPayloads.length > 0, true);
        assert.equal(structuredItemPayloads.every((payload) => payload.origin_kind === "structured_checkpoint"), true);
        assert.equal(
          JSON.parse(db.prepare("SELECT payload FROM memory_receipts WHERE receipt_id=?").get(episode.receipt_id).payload).origin_kind,
          "structured_checkpoint",
        );

        const legacyEpisode = appendCheckpointEpisode(db, {
          timestamp: "2026-08-25T13:05:00.000Z",
          sessionId: "ses_legacy_checkpoint_contract",
          scope: "project:legacy",
          sourceAgent: "legacy_import",
          sourceClient: "legacy_import",
          sourceHost: "fixture-host",
          sourceKind: "daily_note",
          sourcePath: filePath,
          sourceLine: 1,
          summary: "Imported a coarse legacy checkpoint.",
          decisions: ["Preserve legacy origin evidence."],
          durableCandidates: ["Keep legacy candidates non-promoting."],
          evidence: ["test:legacy-checkpoint-origin"],
          legacyUntyped: true,
        });
        assert.equal(legacyEpisode.checkpoint.payload.origin_kind, "legacy_checkpoint");
        assert.deepEqual(legacyEpisode.checkpoint.proposal_ids, []);
        const legacyItemPayloads = db.prepare(`
          SELECT payload FROM memory_checkpoint_items WHERE checkpoint_id=? ORDER BY position
        `).all(legacyEpisode.checkpoint.checkpoint_id).map((row) => JSON.parse(row.payload));
        assert.equal(legacyItemPayloads.length > 0, true);
        assert.equal(legacyItemPayloads.every((payload) => payload.origin_kind === "legacy_checkpoint"), true);
        assert.equal(
          JSON.parse(db.prepare("SELECT payload FROM memory_receipts WHERE receipt_id=?").get(legacyEpisode.receipt_id).payload).origin_kind,
          "legacy_checkpoint",
        );
        assert.equal(
          db.prepare("SELECT COUNT(*) AS n FROM memory_claim_proposals WHERE checkpoint_id=?").get(
            legacyEpisode.checkpoint.checkpoint_id,
          ).n,
          0,
        );
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_current WHERE content LIKE '%pending review%'").get().n, 0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

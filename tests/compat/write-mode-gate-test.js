import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_WRITE_MODE_GATE missing complete fail-closed writer policy";

const EXPECTED_WRITERS = [
  "actions.apply",
  "capture.capture_from_event",
  "cli.audit",
  "cli.claim_decide",
  "cli.claim_propose",
  "cli.control_apply",
  "cli.export_bundle",
  "cli.handoff",
  "cli.import",
  "cli.import_bundle",
  "cli.import_openclaw",
  "cli.index",
  "cli.maintain",
  "cli.migrate",
  "cli.nightly",
  "cli.review_apply",
  "cli.session_hook",
  "cli.setup",
  "cli.sync_hosts",
  "cli.synthesis_build",
  "cli.transcript_sync",
  "cli.vault_sync",
  "cli.watch",
  "cli.watch_hook",
  "cli.wiki_project",
  "cli.wiki_reconcile",
  "cli.world_rebuild",
  "codex.arbitrate",
  "codex.bootstrap",
  "codex.checkpoint",
  "codex.claim_decide",
  "codex.claim_propose",
  "codex.receipt_write",
  "codex.remember",
  "control.checkpoint_append",
  "control.claim_decision_append",
  "control.claim_proposal_append",
  "control.receipt_append",
  "host.sync",
  "http.control_apply",
  "http.suggestions",
  "maintenance.run",
  "mcp.local.arbitrate",
  "mcp.local.checkpoint",
  "mcp.local.claim_decide",
  "mcp.local.claim_propose",
  "mcp.local.receipt_write",
  "mcp.local.remember",
  "mcp.remote.arbitrate",
  "mcp.remote.checkpoint",
  "mcp.remote.claim_decide",
  "mcp.remote.claim_propose",
  "mcp.remote.receipt_write",
  "mcp.remote.remember",
  "native.checkpoint",
  "native.entry",
  "openclaw.agent_end.full_capture",
  "openclaw.native_explicit_remember",
  "projection.materialize",
  "queue.append",
  "queue.review",
  "setup.first_run",
  "transcript.harvest",
  "wiki.project",
  "wiki.reconcile",
];

export async function run() {
  const policy = await importContractModule("lib/compat/write-policy.js", EXPECTED_SIGNATURE);
  const runtime = await importContractModule("lib/compat/openclaw-memory-runtime.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const assertWriteAllowed = requireCallable(policy, "assertWriteAllowed");
    const assertWriterRegistryComplete = requireCallable(policy, "assertWriterRegistryComplete");
    const captureNative = requireCallable(runtime, "captureNativeExplicitRemember");
    const registry = policy.WRITER_REGISTRY;
    assert.deepEqual(Object.keys(registry).sort(), EXPECTED_WRITERS);
    assert.equal(assertWriterRegistryComplete(EXPECTED_WRITERS), true);
    assert.throws(() => assertWriterRegistryComplete([...EXPECTED_WRITERS, "future.unclassified_writer"]), /GIGABRAIN_UNCLASSIFIED_WRITER/);
    for (const operation of EXPECTED_WRITERS) {
      assert.throws(() => assertWriteAllowed({ mode: "read_only", operation }), /GIGABRAIN_WRITE_FORBIDDEN/);
      assert.doesNotThrow(() => assertWriteAllowed({ mode: "full", operation }));
      if (operation === "openclaw.native_explicit_remember") {
        assert.doesNotThrow(() => assertWriteAllowed({ mode: "native_only", operation }));
      } else {
        assert.throws(() => assertWriteAllowed({ mode: "native_only", operation }), /GIGABRAIN_WRITE_FORBIDDEN/);
      }
    }
    assert.throws(() => assertWriteAllowed({ mode: "full", operation: "future.unclassified_writer" }), /GIGABRAIN_UNCLASSIFIED_WRITER/);
    assert.throws(() => assertWriteAllowed({ mode: "unexpected", operation: EXPECTED_WRITERS[0] }), /GIGABRAIN_INVALID_WRITE_MODE/);

    const [capture, actions, transcripts, wiki, maintenance] = await Promise.all([
      import("../../lib/core/capture-service.js"),
      import("../../lib/core/memory-actions.js"),
      import("../../lib/core/transcript-harvester.js"),
      import("../../lib/core/wiki-project.js"),
      import("../../lib/core/maintenance-service.js"),
    ]);
    const readOnlyConfig = {
      compat: { writeMode: "read_only" },
      native: { transcripts: { enabled: false }, wiki: { enabled: false } },
      runtime: { paths: {} },
    };
    assert.throws(() => capture.captureFromEvent({ config: readOnlyConfig, db: null }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => actions.applyMemoryActions({
      config: readOnlyConfig,
      db: null,
      actions: [{ action: "forget" }],
    }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => transcripts.harvestTranscripts({ config: readOnlyConfig, db: {} }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => wiki.projectWiki({ config: readOnlyConfig, db: null }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => wiki.reconcileWiki({ config: readOnlyConfig, db: null }), /GIGABRAIN_WRITE_FORBIDDEN/);
    assert.throws(() => maintenance.runMaintenance({ config: readOnlyConfig, dbPath: "" }), /GIGABRAIN_WRITE_FORBIDDEN/);

    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task5-native-only-"));
    try {
      const workspace = path.join(root, "workspace");
      const memoryRoot = path.join(workspace, "memory");
      const config = {
        compat: { writeMode: "native_only" },
        runtime: { paths: {
          workspaceRoot: workspace,
          memoryRoot,
          registryPath: path.join(memoryRoot, "registry.sqlite"),
          reviewQueuePath: path.join(workspace, "output", "memory-review-queue.jsonl"),
          outputDir: path.join(workspace, "output"),
        } },
        native: { memoryMdPath: path.join(workspace, "MEMORY.md") },
      };
      const result = captureNative({
        config,
        event: {
          output: '<memory_note type="PREFERENCE" confidence="0.93">Use synthetic harbour fixtures.</memory_note>',
          agentId: "main",
          sessionKey: "agent:main:test",
        },
        scope: "profile:main",
        now: "2026-08-25T12:00:00.000Z",
      });
      assert.equal(result.written, 1);
      const nativeText = readFileSync(path.join(memoryRoot, "2026-08-25.md"), "utf8");
      assert.match(nativeText, /Remembered Today/);
      assert.match(nativeText, /Use synthetic harbour fixtures/);
      assert.match(nativeText, /gigabrain:scope=profile:main/);
      assert.equal(existsSync(config.runtime.paths.registryPath), false, "native_only must not create a registry");
      assert.equal(existsSync(config.runtime.paths.reviewQueuePath), false, "native_only must not create a queue");
      assert.throws(() => captureNative({
        config,
        event: { output: "Use synthetic harbour fixtures." },
        scope: "profile:main",
        now: "2026-08-25T12:00:00.000Z",
      }), /GIGABRAIN_NATIVE_NOTE_METADATA_REQUIRED/);
      assert.throws(() => captureNative({
        config,
        event: { output: '<memory_note type="PREFERENCE">Missing confidence.</memory_note>' },
        scope: "profile:main",
        now: "2026-08-25T12:00:00.000Z",
      }), /GIGABRAIN_NATIVE_NOTE_METADATA_REQUIRED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

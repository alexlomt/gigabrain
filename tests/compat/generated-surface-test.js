import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureProjectionStore, upsertCurrentMemory } from "../../lib/core/projection-store.js";
import { openDatabase } from "../../lib/core/sqlite.js";
import { ensureWorldModelStore } from "../../lib/core/world-model.js";
import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "10";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_GENERATED_SURFACE missing deterministic generated runtime surface";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const treeVector = (root) => {
  if (!existsSync(root)) return [];
  const rows = [];
  const visit = (current, relative) => {
    const stat = lstatSync(current);
    rows.push({ mode: stat.mode & 0o777, path: relative, sha256: stat.isFile() ? hash(readFileSync(current)) : "directory" });
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) visit(path.join(current, name), path.join(relative, name));
    }
  };
  visit(root, ".");
  return rows;
};
const seed = (db, id, content, type = "CONTEXT", status = "active") => upsertCurrentMemory(db, {
  confidence: 0.95,
  content,
  created_at: `2026-08-26T12:00:0${id}.000Z`,
  memory_id: `surface-${id}`,
  normalized: content.toLowerCase(),
  scope: "profile:main",
  source: "synthetic",
  status,
  type,
  updated_at: `2026-08-26T12:00:0${id}.000Z`,
});

export async function run() {
  const surface = await importContractModule("lib/operator/generated-surface.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const build = requireCallable(surface, "buildGeneratedSurface");
    const inspect = requireCallable(surface, "inspectGeneratedSurface");
    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-task10-surface-"));
    const workspace = path.join(root, "workspace");
    const output = path.join(root, "output");
    const vault = path.join(root, "vault");
    const mirror = path.join(vault, "Gigabrain");
    const reviewQueuePath = path.join(output, "memory-review-queue.jsonl");
    const dbPath = path.join(root, "registry.sqlite");
    mkdirSync(path.join(mirror, "Inbox"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(mirror, "Manual", "Nested"), { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(mirror, "Inbox", "operator.md"), "operator-owned inbox bytes\n", { mode: 0o600 });
    writeFileSync(path.join(mirror, "Manual", "Nested", "operator.md"), "operator-owned manual bytes\n", { mode: 0o600 });
    writeFileSync(path.join(mirror, ".obsidian-marker"), "operator config must survive\n", { mode: 0o600 });
    writeFileSync(path.join(workspace, "MEMORY.md"), "# Synthetic Native Memory\n\n- Curated source bytes.\n", { mode: 0o600 });
    writeFileSync(reviewQueuePath, `${JSON.stringify({
      id: "surface-review-1",
      payload: { excerpt: "synthetic pending review" },
      reason_code: "capture_review_required",
      status: "pending",
    })}\n`, { mode: 0o600 });
    const manualBefore = treeVector(mirror).filter((row) => /(?:Inbox|Manual|obsidian-marker)/.test(row.path));
    const db = openDatabase(dbPath);
    try {
      ensureProjectionStore(db);
      ensureWorldModelStore(db);
      seed(db, 1, "Alex decided the synthetic surface refresh runs only after real mutations.", "DECISION");
      seed(db, 2, "The synthetic operator surface preserves manual folders byte-for-byte.", "CONTEXT");
      db.prepare(`INSERT INTO memory_entities (
        entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, 'active', 0.95, '[]', ?, ?, '{}')`).run(
        "entity-surface-project",
        "project",
        "Synthetic Surface Project",
        "synthetic surface project",
        "2026-08-26T12:00:00.000Z",
        "2026-08-26T12:00:00.000Z",
      );
      const config = {
        runtime: { paths: { outputDir: output, reviewQueuePath, workspaceRoot: workspace } },
        surface: { obsidian: { entityPages: true, exportEntityPages: "all", mode: "curated" } },
        vault: {
          clean: true,
          enabled: true,
          homeNoteName: "Home",
          manualFolders: ["Inbox", "Manual"],
          path: vault,
          reports: { enabled: true },
          subdir: "Gigabrain",
          views: { enabled: true },
        },
      };
      const first = await build({ config, db, outputDir: mirror, force: false, runId: "surface-first" });
      assert.equal(first.ok, true);
      assert.equal(first.skipped, false);
      assert.ok(first.mutationCount >= 10);
      assert.equal(first.counts.active, 2);
      assert.equal(first.counts.pendingReview, 1);
      for (const relative of [
        "00 Home/Home.md",
        "10 Native/MEMORY.md",
        "20 Entities/projects/entity-surface-project.md",
        "30 Views/Current State.md",
        "30 Views/Important People.md",
        "30 Views/Important Projects.md",
        "30 Views/Native Notes.md",
        "30 Views/What Changed.md",
        "40 Reports/surface-summary.json",
        "40 Reports/vault-build-summary.json",
        "40 Reports/vault-build-summary.md",
        "40 Reports/vault-freshness.json",
        "40 Reports/vault-manifest.json",
        "50 Briefings/Session Brief.md",
        "vault-index.md",
      ]) assert.equal(existsSync(path.join(mirror, relative)), true, `missing generated file ${relative}`);
      for (const row of treeVector(mirror)) {
        if (row.path === ".") assert.equal(row.mode, 0o700);
        else if (row.sha256 === "directory") assert.equal(row.mode, 0o700, `directory mode: ${row.path}`);
        else assert.equal(row.mode, 0o600, `file mode: ${row.path}`);
      }
      assert.deepEqual(
        treeVector(mirror).filter((row) => /(?:Inbox|Manual|obsidian-marker)/.test(row.path)),
        manualBefore,
        "manual and operator-owned files must remain byte-identical",
      );
      const manifest = JSON.parse(readFileSync(path.join(mirror, "40 Reports", "vault-manifest.json"), "utf8"));
      assert.equal(manifest.generated_files.some((value) => /^(?:Inbox|Manual)\//.test(value)), false);
      const beforeSecond = treeVector(mirror);
      const second = await build({ config, db, outputDir: mirror, force: false, runId: "surface-second" });
      assert.equal(second.skipped, true);
      assert.equal(second.reason, "surface_current");
      assert.equal(second.mutationCount, 0);
      assert.deepEqual(treeVector(mirror), beforeSecond, "current surface build must write zero bytes");

      seed(db, 3, "A third synthetic memory makes the generated surface stale.", "CONTEXT");
      const third = await build({ config, db, outputDir: mirror, force: false, runId: "surface-third" });
      assert.equal(third.skipped, false);
      assert.ok(third.mutationCount > 0);
      assert.equal(third.counts.active, 3);
      const health = await inspect({ config, db, outputDir: mirror });
      assert.equal(health.healthy, true);
      assert.equal(health.counts.active, 3);
      assert.equal(health.manualProtection.ok, true);
      assert.equal(statSync(path.join(mirror, "Inbox", "operator.md")).mode & 0o777, 0o600);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

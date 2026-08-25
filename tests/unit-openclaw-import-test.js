import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { loadLegacyRows } from "../lib/core/openclaw-import.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE memories (id TEXT, content TEXT, scope TEXT, created_at TEXT)");
    db.prepare("INSERT INTO memories VALUES (?, ?, ?, ?)").run("m1", "Synthetic imported memory", "shared", "2026-08-25T00:00:00Z");
    const rows = loadLegacyRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "Synthetic imported memory");
    assert.equal(rows[0].scope, "shared");
  } finally {
    db.close();
  }
}
runDirect(import.meta.url, run);

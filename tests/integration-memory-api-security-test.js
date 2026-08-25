import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot, runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const source = readFileSync(path.join(repoRoot, "memory_api", "app.py"), "utf8");
  const routeCount = (source.match(/@app\.(?:get|post|put|delete)\(/g) || []).length;
  const authCount = (source.match(/Depends\(require_token\)/g) || []).length;
  assert.ok(routeCount > 20);
  assert.ok(authCount >= routeCount - 1, `route/auth drift: ${routeCount}/${authCount}`);
  assert.match(source, /MAX_JSON_BODY_BYTES/);
  assert.match(source, /MAX_MULTIPART_BODY_BYTES/);
}
runDirect(import.meta.url, run);

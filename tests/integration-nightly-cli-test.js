import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { repoRoot, runDirect, withTempRoot } from "./restored-private-test-helpers.js";

export async function run() {
  await withTempRoot("gigabrain-nightly-help-", async (root) => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "gigabrainctl.js"), "--help"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HOME: root },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nightly|maintain/);
    assert.deepEqual(readdirSync(root), []);
  });
}
runDirect(import.meta.url, run);

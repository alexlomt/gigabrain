import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readVaultFileSafe, walkVault } from "../lib/core/vault-sync.js";
import { runDirect, withTempRoot } from "./restored-private-test-helpers.js";

export async function run() {
  await withTempRoot("gigabrain-vault-mirror-", async (root) => {
    mkdirSync(path.join(root, "nested"));
    const notePath = path.join(root, "nested", "synthetic.md");
    writeFileSync(notePath, "# Synthetic\nHarbour reference content.\n");
    writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
    assert.deepEqual(walkVault(root, "**/*.md"), [notePath]);
    assert.match(readVaultFileSafe(notePath, { maxFileBytes: 1024 }).text, /Harbour reference/);
    assert.equal(readVaultFileSafe(notePath, { maxFileBytes: 4 }).tooLarge, true);
  });
}
runDirect(import.meta.url, run);

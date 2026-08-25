import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findDefaultStandaloneConfigPath } from "../lib/core/config.js";
import { runDirect, withTempRoot } from "./restored-private-test-helpers.js";

export async function run() {
  await withTempRoot("gigabrain-codex-setup-", async (root) => {
    const expected = path.join(root, ".gigabrain", "config.json");
    mkdirSync(path.dirname(expected), { recursive: true });
    writeFileSync(expected, "{}\n");
    assert.equal(findDefaultStandaloneConfigPath(root), expected);
    assert.equal(findDefaultStandaloneConfigPath(path.join(root, "missing")), "");
  });
}
runDirect(import.meta.url, run);

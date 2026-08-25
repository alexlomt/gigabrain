import assert from "node:assert/strict";
import { buildFindingsDigest, resolveVaultInboxSettings } from "../lib/core/vault-inbox.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const settings = resolveVaultInboxSettings({ vault: { inbox: { enabled: true, maxFindings: 500, notePath: "Synthetic/Findings.md" } } });
  assert.equal(settings.enabled, true);
  assert.equal(settings.notePath, "Synthetic/Findings.md");
  assert.equal(settings.maxFindings, 100);
  assert.throws(() => buildFindingsDigest(), /requires db/);
}
runDirect(import.meta.url, run);

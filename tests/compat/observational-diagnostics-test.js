import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "12";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OBSERVATIONAL_DIAGNOSTICS missing zero-write diagnostics guard";

export async function run() {
  const diagnostics = await importContractModule("lib/compat/observational-diagnostics.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const inspect = requireCallable(diagnostics, "runObservationalDiagnostic");
    const root = mkdtempSync(path.join(tmpdir(), "gigabrain-diagnostic-contract-"));
    const statePath = path.join(root, "state.json");
    writeFileSync(statePath, "{\"count\":1}\n");
    try {
      const before = readFileSync(statePath);
      const result = await inspect({
        readState: () => JSON.parse(readFileSync(statePath, "utf8")),
        root,
      });
      const after = readFileSync(statePath);
      assert.deepEqual(result, { count: 1, observational: true });
      assert.deepEqual(after, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

runDirect(import.meta.url, run);

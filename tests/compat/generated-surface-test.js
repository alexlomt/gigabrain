import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_GENERATED_SURFACE missing deterministic generated runtime surface";

export async function run() {
  const builder = await importContractModule("scripts/build-runtime-js.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const render = requireCallable(builder, "renderRuntimeSurface");
    const source = "export const syntheticValue: string = 'ok';\n";
    const first = await render({ source, sourcePath: "index.ts" });
    const second = await render({ source, sourcePath: "index.ts" });
    assert.equal(first, second);
    assert.match(first, /export const syntheticValue\s+= ['\"]ok['\"]/);
    assert.doesNotMatch(first, /: string/);
    assert.match(first, /generated from index\.ts/i);
  });
}

runDirect(import.meta.url, run);

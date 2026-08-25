import assert from "node:assert/strict";

import {
  importContractModule,
  requireCallable,
  runBehaviorContract,
  runDirect,
} from "./contract-test-helpers.js";

export const OWNER_TASK = "6";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_NATIVE_METADATA missing typed native metadata parser";

export async function run() {
  const metadata = await importContractModule("lib/compat/native-metadata.js", EXPECTED_SIGNATURE);
  await runBehaviorContract(EXPECTED_SIGNATURE, async () => {
    const append = requireCallable(metadata, "appendGigabrainMetadata");
    const parse = requireCallable(metadata, "parseGigabrainMetadata");
    const rendered = append("Synthetic durable fact", { scope: "profile:synthetic", type: "DECISION" });
    assert.match(rendered, /Synthetic durable fact/);
    assert.deepEqual(parse(rendered), {
      content: "Synthetic durable fact",
      scope: "profile:synthetic",
      type: "DECISION",
    });
    assert.deepEqual(parse("Plain untyped note"), {
      content: "Plain untyped note",
      scope: "",
      type: "CONTEXT",
    });
  });
}

runDirect(import.meta.url, run);

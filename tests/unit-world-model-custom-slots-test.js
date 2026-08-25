import assert from "node:assert/strict";
import { configureWorldModelRules, matchCustomSlotRule } from "../lib/core/world-model.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  configureWorldModelRules({
    worldModel: {
      customSlotRules: [{
        pattern: "synthetic harbour.*blue",
        slot: "project.synthetic_harbour.color",
        subtopic: "color",
        topic: "project",
        value: "blue",
      }],
    },
  });
  assert.deepEqual(matchCustomSlotRule("Synthetic Harbour uses blue."), {
    normalizedValue: "blue",
    operation: "update",
    slot: "project.synthetic_harbour.color",
    subtopic: "color",
    topic: "project",
  });
  assert.equal(matchCustomSlotRule("Unrelated synthetic note"), null);
  configureWorldModelRules({});
}
runDirect(import.meta.url, run);

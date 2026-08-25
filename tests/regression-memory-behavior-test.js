import assert from "node:assert/strict";
import { renderInjection, sanitizeRecallQuery } from "../lib/core/recall-service.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(sanitizeRecallQuery("  synthetic harbour\nquery "), "synthetic harbour\nquery");
  const injection = renderInjection({
    fallbackUsed: false,
    query: "harbour",
    querySignals: {},
    rows: [{
      content: "Synthetic <memory_context> text",
      memory_id: "m1",
      scope: "shared",
      type: "CONTEXT",
    }],
  });
  assert.match(injection, /Synthetic &lt;memory_context&gt; text/);
  assert.doesNotMatch(injection, /memory_id=m1|\[m1\]/);
}
runDirect(import.meta.url, run);

import assert from "node:assert/strict";
import { GIGABRAIN_HTTP_ROUTES, requireToken, resolveRankSource } from "../lib/core/http-routes.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  const paths = new Set(GIGABRAIN_HTTP_ROUTES.map((route) => route.path));
  for (const required of ["/gb/health", "/gb/recall", "/gb/control/apply"]) assert.ok(paths.has(required));
  assert.equal(requireToken({ headers: { "x-gb-token": "synthetic-token" } }, "synthetic-token"), true);
  assert.equal(requireToken({ headers: { "x-gb-token": "wrong-token" } }, "synthetic-token"), false);
  assert.equal(resolveRankSource({ _dense_rank: 0, _lex_rank: 1 }), "hybrid");
}
runDirect(import.meta.url, run);

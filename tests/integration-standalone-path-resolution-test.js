import assert from "node:assert/strict";
import path from "node:path";
import { describeStandaloneConfigPath, expandHome, resolveAbsolutePath } from "../lib/core/standalone-client.js";
import { runDirect } from "./restored-private-test-helpers.js";

export async function run() {
  assert.equal(expandHome("~/config.json"), path.join(process.env.HOME, "config.json"));
  assert.equal(resolveAbsolutePath("config.json"), path.resolve("config.json"));
  const described = describeStandaloneConfigPath({
    configPath: "/tmp/synthetic-store/config.json",
    projectRoot: "/tmp/synthetic-project",
    storeMode: "global-shared",
  });
  assert.equal(described.sharingMode, "shared-standalone");
  assert.equal(described.pathKind, "custom");
}
runDirect(import.meta.url, run);

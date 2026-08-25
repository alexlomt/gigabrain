import { requireSourceMarkers, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OPENCLAW_HOOKS missing prompt-build and compaction-flush hooks";
export async function run() {
  requireSourceMarkers("index.ts", ["before_prompt_build", "flushPlanResolver"], EXPECTED_SIGNATURE);
}
runDirect(import.meta.url, run);

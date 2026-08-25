import { requireSourceMarkers, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_GENERATED_SURFACE missing deterministic generated runtime surface";
export async function run() {
  requireSourceMarkers(
    "scripts/build-runtime-js.js",
    ["source-first-generated-surface", "index.js"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

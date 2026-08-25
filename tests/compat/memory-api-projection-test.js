import { requireSourceMarkers, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "11";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_MEMORY_API_PROJECTION missing projection sync contract";
export async function run() {
  requireSourceMarkers(
    "memory_api/app.py",
    ["projection_sync_receipt", "refresh_generated_surface"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

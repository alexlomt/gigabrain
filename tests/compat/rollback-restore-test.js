import { requireSourceMarkers, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "4";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_ROLLBACK_RESTORE missing verified rollback restoration";
export async function run() {
  requireSourceMarkers(
    "scripts/gigabrainctl.js",
    ["source_first_rollback_receipt", "verifyRollbackRestore"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

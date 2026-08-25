import { requireSourceMarkers, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "4";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_FULL_MIGRATION missing source-first registry migration receipt";
export async function run() {
  requireSourceMarkers(
    "scripts/migrate-v3.js",
    ["source_first_registry_migration", "migrationReceipt"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

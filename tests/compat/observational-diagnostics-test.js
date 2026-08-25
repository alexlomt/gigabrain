import { requireSourceMarkers, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "12";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OBSERVATIONAL_DIAGNOSTICS missing zero-write diagnostics guard";
export async function run() {
  requireSourceMarkers(
    "scripts/gigabrainctl.js",
    ["observational_diagnostics", "assertNoDiagnosticWrites"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

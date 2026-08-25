import { requireSourceMarkers, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "6";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_CHECKPOINT_ISOLATION missing metadata-gated checkpoint promotion";
export async function run() {
  requireSourceMarkers(
    "lib/core/native-promotion.js",
    ["parseGigabrainMetadata", "checkpoint_promotion_isolation"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

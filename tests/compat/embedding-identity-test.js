import { requireSourceMarkers, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "7";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_EMBEDDING_IDENTITY missing model/dimension/query identity";
export async function run() {
  requireSourceMarkers(
    "lib/core/embedding-service.js",
    ["2560", "queryInstruction", "embeddingIdentity"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

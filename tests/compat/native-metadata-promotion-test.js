import { requireModuleExports, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "6";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_NATIVE_METADATA missing typed native metadata parser";
export async function run() {
  await requireModuleExports(
    "lib/compat/native-metadata.js",
    ["appendGigabrainMetadata", "parseGigabrainMetadata", "normalizeMemoryType"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

import { requireModuleExports, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "6";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_NATIVE_LOCK missing cross-process native-memory lock";
export async function run() {
  await requireModuleExports(
    "lib/core/native-memory.js",
    ["withNativeMemoryLock"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

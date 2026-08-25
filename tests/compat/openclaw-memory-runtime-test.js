import { requireModuleExports, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_OPENCLAW_MEMORY_RUNTIME missing governed OpenClaw runtime adapter";
export async function run() {
  await requireModuleExports(
    "lib/compat/openclaw-memory-runtime.js",
    ["createGigabrainMemoryManager", "gigabrainMemoryRuntime"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

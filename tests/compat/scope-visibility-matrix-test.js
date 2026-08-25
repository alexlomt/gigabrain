import { requireModuleExports, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "5";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_SCOPE_VISIBILITY missing fail-closed scope visibility matrix";
export async function run() {
  await requireModuleExports(
    "lib/compat/openclaw-memory-runtime.js",
    ["resolveScopeVisibility"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

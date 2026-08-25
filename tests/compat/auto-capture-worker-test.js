import { requireModuleExports, runDirect } from "./contract-test-helpers.js";

export const OWNER_TASK = "9";
export const EXPECTED_SIGNATURE = "COMPAT_EXPECTED_AUTO_CAPTURE missing durable bounded capture worker";
export async function run() {
  await requireModuleExports(
    "lib/compat/auto-capture-policy.js",
    ["buildAutoCapturePacket", "processAutoCaptureQueue"],
    EXPECTED_SIGNATURE,
  );
}
runDirect(import.meta.url, run);

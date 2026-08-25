import { verifyIsolatedCanaryReceipt } from "./isolated-release-live-helpers.js";

export const OWNER_TASK = "14";
export async function run() {
  verifyIsolatedCanaryReceipt("release-live-codex-cli");
}

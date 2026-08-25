import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "..");

export async function withTempRoot(prefix, callback) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runDirect(importMeta, run) {
  if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(importMeta).pathname)) {
    run().then(
      () => process.stdout.write(`${path.basename(process.argv[1])}: ok\n`),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  }
}

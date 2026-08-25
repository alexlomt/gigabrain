import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export async function importContractModule(relativePath, signature) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) throw new Error(signature);
  try {
    return await import(`${pathToFileURL(absolutePath).href}?compat-contract=${Date.now()}`);
  } catch {
    throw new Error(signature);
  }
}

export function requireCallable(module, name) {
  assert.equal(typeof module[name], "function", `${name} must be callable`);
  return module[name];
}

export async function runBehaviorContract(signature, behavior) {
  try {
    await behavior();
  } catch (error) {
    if (error instanceof Error && error.message === signature) throw error;
    throw new Error(signature);
  }
}

export function runDirect(importMeta, run) {
  if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(importMeta).pathname)) {
    run().then(
      () => process.stdout.write(`${path.basename(process.argv[1])}: ok\n`),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  }
}

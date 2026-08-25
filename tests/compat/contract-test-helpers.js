import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export async function requireModuleExports(relativePath, exportNames, signature) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) throw new Error(signature);
  let module;
  try {
    module = await import(`${pathToFileURL(absolutePath).href}?compat-contract=${Date.now()}`);
  } catch {
    throw new Error(signature);
  }
  if (exportNames.some((name) => typeof module[name] === "undefined")) throw new Error(signature);
}

export function requireSourceMarkers(relativePath, markers, signature) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) throw new Error(signature);
  const source = readFileSync(absolutePath, "utf8");
  if (markers.some((marker) => !source.includes(marker))) throw new Error(signature);
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

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const GENERATED_HEADER = "// Generated from index.ts deterministically by scripts/build-runtime-js.js.\n";

const renderRuntimeSurface = async ({ source, sourcePath = "index.ts" } = {}) => {
  const input = String(source || "");
  const transformed = stripTypeScriptTypes(input, { mode: "strip", sourceUrl: sourcePath });
  const normalized = transformed.replace(/^\s+/, "").replace(/[ \t]+$/gm, "");
  return `${GENERATED_HEADER}${normalized}`;
};

const buildRuntimeSurface = async ({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") } = {}) => {
  const sourcePath = path.join(root, "index.ts");
  const outputPath = path.join(root, "index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = await renderRuntimeSurface({ source, sourcePath: "index.ts" });
  fs.writeFileSync(outputPath, output, { encoding: "utf8", mode: 0o644 });
  return { bytes: Buffer.byteLength(output), outputPath, sourcePath };
};

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  buildRuntimeSurface().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

export { buildRuntimeSurface, renderRuntimeSurface };

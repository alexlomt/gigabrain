#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[*?\[\]{}\\\0]).+$/;

function resolveInside(root, relativePath) {
  if (typeof relativePath !== "string" || !SAFE_PATH.test(relativePath)) {
    throw new Error("RESTORE_INVALID_PATH");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("RESTORE_INVALID_PATH");
  }
  return resolved;
}

export function restoreReviewedTests({
  inventory,
  protectedRoot,
  replacements,
  stagePaths,
  targetRoot,
}) {
  if (!Array.isArray(inventory) || !Array.isArray(replacements) || !Array.isArray(stagePaths)) {
    throw new Error("RESTORE_INVALID_REVIEW_INPUT");
  }
  const staged = new Set(stagePaths);
  for (const row of inventory) {
    if (!staged.has(row.syntheticTarget)) throw new Error("RESTORE_TARGET_NOT_STAGED");
    const sourcePath = resolveInside(protectedRoot, row.sourcePath);
    const targetPath = resolveInside(targetRoot, row.syntheticTarget);
    const sourceBytes = readFileSync(sourcePath);
    if (sha256(sourceBytes) !== row.sourceSha256) throw new Error("RESTORE_SOURCE_HASH_MISMATCH");
    let restored = sourceBytes.toString("utf8");
    for (const replacement of replacements) {
      if (
        !Array.isArray(replacement) ||
        replacement.length !== 2 ||
        typeof replacement[0] !== "string" ||
        replacement[0].length === 0 ||
        typeof replacement[1] !== "string"
      ) {
        throw new Error("RESTORE_INVALID_REPLACEMENT");
      }
      restored = restored.split(replacement[0]).join(replacement[1]);
    }
    if (sha256(restored) !== row.syntheticSha256) throw new Error("RESTORE_TARGET_HASH_MISMATCH");
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, restored, { mode: 0o600, flag: "wx" });
  }
  return { restored: inventory.length };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error("RESTORE_USAGE");
    options[flag.slice(2)] = value;
  }
  for (const required of ["inventory", "protected-root", "receipt", "stage-paths", "target-root"]) {
    if (!options[required]) throw new Error("RESTORE_USAGE");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inventoryDocument = JSON.parse(readFileSync(options.inventory, "utf8"));
  const receipt = JSON.parse(readFileSync(options.receipt, "utf8"));
  const stagePaths = readFileSync(options["stage-paths"], "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const reviewedTargets = new Set(receipt.reviewedTargets || []);
  const inventory = (inventoryDocument.tests || [])
    .filter((row) => reviewedTargets.has(row.syntheticTarget))
    .map((row) => ({
      sourcePath: row.sourcePath,
      sourceSha256: row.sourceSha256,
      syntheticSha256: receipt.syntheticHashes?.[row.syntheticTarget],
      syntheticTarget: row.syntheticTarget,
    }));
  const result = restoreReviewedTests({
    inventory,
    protectedRoot: options["protected-root"],
    replacements: receipt.replacements || [],
    stagePaths,
    targetRoot: options["target-root"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

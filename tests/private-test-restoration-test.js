import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OWNER_TASK = "2B";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function run() {
  const restorerPath = path.join(import.meta.dirname, "..", "scripts", "restore-private-tests.mjs");
  let restorer;
  try {
    restorer = await import(`${pathToFileURL(restorerPath).href}?contract=${Date.now()}`);
  } catch {
    throw new Error("TASK2_RESTORE_RED missing reviewed private-test restorer");
  }
  const root = mkdtempSync(path.join(tmpdir(), "gigabrain-private-restore-"));
  try {
    const protectedRoot = path.join(root, "protected");
    const targetRoot = path.join(root, "candidate");
    mkdirSync(path.join(protectedRoot, "tests"), { recursive: true });
    mkdirSync(path.join(targetRoot, "tests", "compat"), { recursive: true });
    const oldBytes = "assert.equal(scope, 'OperatorFixtureAlpha');\n";
    const newBytes = "assert.equal(scope, 'SyntheticFixtureAlpha');\n";
    writeFileSync(path.join(protectedRoot, "tests", "old-test.js"), oldBytes, { mode: 0o600 });
    const inventory = [{
      sourcePath: "tests/old-test.js",
      sourceSha256: sha256(oldBytes),
      syntheticTarget: "tests/compat/new-test.js",
      syntheticSha256: sha256(newBytes),
    }];
    restorer.restoreReviewedTests({
      inventory,
      replacements: [["OperatorFixtureAlpha", "SyntheticFixtureAlpha"]],
      protectedRoot,
      stagePaths: ["tests/compat/new-test.js"],
      targetRoot,
    });
    assert.equal(readFileSync(path.join(targetRoot, "tests", "compat", "new-test.js"), "utf8"), newBytes);
    assert.throws(
      () => restorer.restoreReviewedTests({
        inventory,
        replacements: [],
        protectedRoot,
        stagePaths: [],
        targetRoot,
      }),
      /RESTORE_TARGET_NOT_STAGED/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  run().then(
    () => process.stdout.write("private-test-restoration-test: ok\n"),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OWNER_TASK = "2B";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const oldBytes = "assert.equal(scope, 'OperatorFixtureAlpha');\n";
const newBytes = "assert.equal(scope, 'SyntheticFixtureAlpha');\n";

function makeScenario(root, name) {
  const scenarioRoot = path.join(root, name);
  const protectedRoot = path.join(scenarioRoot, "protected");
  const targetRoot = path.join(scenarioRoot, "candidate");
  const receiptPath = path.join(scenarioRoot, "receipt.json");
  mkdirSync(path.join(protectedRoot, "tests"), { recursive: true, mode: 0o700 });
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  chmodSync(scenarioRoot, 0o700);
  chmodSync(protectedRoot, 0o700);
  chmodSync(path.join(protectedRoot, "tests"), 0o700);
  chmodSync(targetRoot, 0o700);
  writeFileSync(path.join(protectedRoot, "tests", "old-test.js"), oldBytes, { mode: 0o600 });
  writeFileSync(receiptPath, "{\"schemaVersion\":1}\n", { mode: 0o600 });
  return {
    inventory: [{
      sourcePath: "tests/old-test.js",
      sourceSha256: sha256(oldBytes),
      syntheticTarget: "tests/compat/new-test.js",
      syntheticSha256: sha256(newBytes),
    }],
    protectedRoot,
    receiptPath,
    replacements: [["OperatorFixtureAlpha", "SyntheticFixtureAlpha"]],
    stagePaths: ["tests/compat/new-test.js"],
    targetRoot,
  };
}

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
    const valid = makeScenario(root, "valid");
    restorer.restoreReviewedTests(valid);
    const restoredPath = path.join(valid.targetRoot, "tests", "compat", "new-test.js");
    assert.equal(readFileSync(restoredPath, "utf8"), newBytes);
    assert.equal(lstatSync(restoredPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.dirname(restoredPath)).mode & 0o777, 0o700);
    assert.throws(
      () => restorer.restoreReviewedTests({ ...valid, stagePaths: [] }),
      /RESTORE_TARGET_NOT_STAGED/,
    );

    const sourceSymlink = makeScenario(root, "source-symlink");
    const externalSource = path.join(root, "external-source.js");
    writeFileSync(externalSource, oldBytes, { mode: 0o600 });
    rmSync(path.join(sourceSymlink.protectedRoot, "tests", "old-test.js"));
    symlinkSync(externalSource, path.join(sourceSymlink.protectedRoot, "tests", "old-test.js"));
    assert.throws(
      () => restorer.restoreReviewedTests(sourceSymlink),
      /RESTORE_SOURCE_SYMLINK/,
    );

    const sourceParentSymlink = makeScenario(root, "source-parent-symlink");
    const externalSourceDir = path.join(root, "external-source-dir");
    mkdirSync(externalSourceDir, { mode: 0o700 });
    writeFileSync(path.join(externalSourceDir, "old-test.js"), oldBytes, { mode: 0o600 });
    rmSync(path.join(sourceParentSymlink.protectedRoot, "tests"), { recursive: true });
    symlinkSync(externalSourceDir, path.join(sourceParentSymlink.protectedRoot, "tests"));
    assert.throws(
      () => restorer.restoreReviewedTests(sourceParentSymlink),
      /RESTORE_SOURCE_SYMLINK/,
    );

    const targetParentSymlink = makeScenario(root, "target-parent-symlink");
    const escapedTarget = path.join(root, "escaped-target");
    mkdirSync(escapedTarget, { mode: 0o700 });
    symlinkSync(escapedTarget, path.join(targetParentSymlink.targetRoot, "tests"));
    assert.throws(
      () => restorer.restoreReviewedTests(targetParentSymlink),
      /RESTORE_TARGET_SYMLINK/,
    );
    assert.equal(existsSync(path.join(escapedTarget, "compat", "new-test.js")), false);

    const targetFileSymlink = makeScenario(root, "target-file-symlink");
    mkdirSync(path.join(targetFileSymlink.targetRoot, "tests", "compat"), { recursive: true, mode: 0o700 });
    const escapedFile = path.join(root, "escaped-file.js");
    writeFileSync(escapedFile, "unchanged\n", { mode: 0o600 });
    symlinkSync(escapedFile, path.join(targetFileSymlink.targetRoot, "tests", "compat", "new-test.js"));
    assert.throws(
      () => restorer.restoreReviewedTests(targetFileSymlink),
      /RESTORE_TARGET_EXISTS/,
    );
    assert.equal(readFileSync(escapedFile, "utf8"), "unchanged\n");

    for (const [name, mutate, signature] of [
      ["protected-mode", (fixture) => chmodSync(fixture.protectedRoot, 0o755), /RESTORE_PROTECTED_MODE/],
      ["source-mode", (fixture) => chmodSync(path.join(fixture.protectedRoot, "tests", "old-test.js"), 0o644), /RESTORE_PROTECTED_MODE/],
      ["receipt-mode", (fixture) => chmodSync(fixture.receiptPath, 0o644), /RESTORE_RECEIPT_MODE/],
    ]) {
      const fixture = makeScenario(root, name);
      mutate(fixture);
      assert.throws(() => restorer.restoreReviewedTests(fixture), signature);
    }

    const nonRegular = makeScenario(root, "source-not-regular");
    rmSync(path.join(nonRegular.protectedRoot, "tests", "old-test.js"));
    mkdirSync(path.join(nonRegular.protectedRoot, "tests", "old-test.js"), { mode: 0o700 });
    assert.throws(
      () => restorer.restoreReviewedTests(nonRegular),
      /RESTORE_SOURCE_NOT_REGULAR/,
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

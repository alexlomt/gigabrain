import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OWNER_TASK = "2B";

export async function run() {
  const parserPath = path.join(import.meta.dirname, "..", "scripts", "npm-pack-inventory.mjs");
  let parser;
  try {
    parser = await import(`${pathToFileURL(parserPath).href}?contract=${Date.now()}`);
  } catch {
    throw new Error("TASK2_NPM_PACK_RED missing npm 10/12 fail-closed parser");
  }
  const fixture = (name) => readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");
  assert.deepEqual(parser.parseNpmPackInventory(fixture("npm-pack-npm10.json")), ["index.js", "package.json"]);
  assert.deepEqual(parser.parseNpmPackInventory(fixture("npm-pack-npm12.json")), ["index.js", "package.json"]);
  assert.throws(
    () => parser.parseNpmPackInventory('[{"files":[{"path":"index.js"}]}]'),
    /npm pack report name is required/,
  );
  assert.throws(
    () => parser.parseNpmPackInventory('{"synthetic-key":{"name":"different-name","files":[{"path":"index.js"}]}}'),
    /npm 12 package key did not match report name/,
  );
  assert.throws(
    () => parser.parseNpmPackInventory('[{"name":"one","files":[{"path":"index.js"}]},{"name":"two"}]'),
    /npm pack inventory did not contain a file list for every report/,
  );
  assert.throws(
    () => parser.parseNpmPackInventory('{"synthetic-package":true}'),
    /npm pack report was not an object/,
  );
  for (const pathValue of [123, true, {}, null, ["index.js"]]) {
    assert.throws(
      () => parser.parseNpmPackInventory(JSON.stringify([{
        files: [{ path: pathValue }],
        name: "synthetic-package",
      }])),
      /npm pack file path must be a string/,
      `non-string npm pack path must fail closed: ${JSON.stringify(pathValue)}`,
    );
  }
  assert.throws(
    () => parser.parseNpmPackInventory(fixture("npm-pack-invalid.json")),
    /npm pack inventory did not contain a file list/,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  run().then(
    () => process.stdout.write("npm-pack-parser-test: ok\n"),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

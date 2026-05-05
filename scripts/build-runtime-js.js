#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'index.ts');
const outputPath = path.join(root, 'index.js');

const source = fs.readFileSync(sourcePath, 'utf8');
const output = stripTypeScriptTypes(source, { mode: 'transform' });
fs.writeFileSync(outputPath, output);
console.log(JSON.stringify({ ok: true, sourcePath, outputPath, bytes: output.length }, null, 2));

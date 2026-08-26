#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenClawConfigSchema } from '../lib/core/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutputPath = path.join(repoRoot, 'openclaw.plugin.json');

const renderOpenClawPluginManifest = () => `${JSON.stringify({
  id: 'gigabrain',
  kind: 'memory',
  configSchema: buildOpenClawConfigSchema(),
}, null, 2)}\n`;

const readOutputArg = (args) => {
  const index = args.indexOf('--output');
  if (index !== -1) {
    if (!args[index + 1] || String(args[index + 1]).startsWith('--')) throw new Error('CONFIG_SCHEMA_OUTPUT_REQUIRED');
    return path.resolve(String(args[index + 1]));
  }
  const inline = args.find((arg) => String(arg).startsWith('--output='));
  return inline ? path.resolve(String(inline).slice('--output='.length)) : defaultOutputPath;
};

const writeAtomic = (targetPath, bytes) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tempPath, bytes, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tempPath, targetPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* already renamed or never created */ }
  }
};

const main = (args = process.argv.slice(2)) => {
  const outputPath = readOutputArg(args);
  const bytes = renderOpenClawPluginManifest();
  if (args.includes('--check')) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (existing !== bytes) throw new Error('OPENCLAW_CONFIG_SCHEMA_STALE');
    return;
  }
  writeAtomic(outputPath, bytes);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export {
  main,
  renderOpenClawPluginManifest,
};

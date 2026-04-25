#!/usr/bin/env node
import { loadResolvedConfig } from '../lib/core/config.js';
import { runHygieneMigration } from '../lib/core/hygiene-migration.js';
import { openDatabase } from '../lib/core/sqlite.js';

const args = process.argv.slice(2);
const readFlag = (name, fallback = '') => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
};
const readBool = (name, fallback = false) => args.includes(name) ? true : fallback;

const printHelp = () => {
  console.log(`Gigabrain hygiene migration 2026-04-25\n\nUsage:\n  node scripts/gigabrain-hygiene-20260425.js --config /path/to/openclaw.json [--apply]\n\nDefault is dry-run. --apply snapshots first, then mutates registry/native files/queue and refreshes surfaces.`);
};

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const configPath = readFlag('--config', process.env.OPENCLAW_CONFIG || `${process.env.HOME || ''}/.openclaw/openclaw.json`);
const apply = readBool('--apply', false);
const refresh = !args.includes('--skip-refresh');

try {
  const { config } = loadResolvedConfig({ configPath, mode: 'openclaw' });
  const dbPath = config.runtime.paths.registryPath;
  const db = openDatabase(dbPath);
  try {
    const result = runHygieneMigration({
      db,
      dbPath,
      config,
      apply,
      refresh,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}

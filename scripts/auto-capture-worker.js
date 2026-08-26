#!/usr/bin/env node

const USAGE = `Usage: auto-capture-worker --config <path> [options]

Process bounded Gigabrain auto-capture queue jobs from the configured runtime descriptor.

Options:
  --config <path>   Candidate config file (required outside --help)
  --limit <1-20>    Maximum jobs to dispatch (default: 3)
  --dry-run         Inspect eligible jobs without state transitions
  --help            Show this help without loading config or runtime state
`;

const cliError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const parseArgs = (args = []) => {
  if (args.includes('--help')) return { help: true };
  const parsed = { configPath: '', dryRun: false, help: false, limit: 3 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--config' || arg === '--limit') {
      const value = String(args[index + 1] || '');
      if (!value || value.startsWith('--')) {
        throw cliError(arg === '--config' ? 'AUTO_CAPTURE_WORKER_CONFIG_REQUIRED' : 'AUTO_CAPTURE_WORKER_LIMIT_INVALID');
      }
      index += 1;
      if (arg === '--config') parsed.configPath = value;
      else {
        const numeric = Number(value);
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > 20) {
          throw cliError('AUTO_CAPTURE_WORKER_LIMIT_INVALID');
        }
        parsed.limit = numeric;
      }
      continue;
    }
    throw cliError('AUTO_CAPTURE_WORKER_ARGUMENT_INVALID');
  }
  if (!parsed.configPath) throw cliError('AUTO_CAPTURE_WORKER_CONFIG_REQUIRED');
  return parsed;
};

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  const [{ loadResolvedConfig }, { processAutoCaptureQueue }, { createAutoCaptureJobProcessor }] = await Promise.all([
    import('../lib/core/config.js'),
    import('../lib/compat/auto-capture-queue.js'),
    import('../lib/compat/auto-capture-processor.js'),
  ]);
  const loaded = loadResolvedConfig({ configPath: parsed.configPath });
  const result = await processAutoCaptureQueue({
    config: loaded.config,
    dryRun: parsed.dryRun,
    limit: parsed.limit,
    processJob: parsed.dryRun ? undefined : createAutoCaptureJobProcessor({ config: loaded.config }),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
};

main().catch((error) => {
  const code = String(error?.code || error?.message || 'AUTO_CAPTURE_WORKER_FAILED').split(':')[0];
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});

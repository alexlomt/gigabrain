import path from "node:path";

import {
  createGigabrainMemoryManager,
  readOperatorNativeFile,
} from "./openclaw-memory-runtime.js";
import {
  attachReleaseProvenance,
  tryLoadReleaseProvenance,
} from "./release-provenance.js";

const writeOutput = (value, io = process) => {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  io.stdout?.write?.(`${text}\n`);
  return value;
};

const resolveScope = (options = {}) => String(options.agent || options.scope || "shared").trim() || "shared";

const runMemoryStatus = async ({ config, options = {}, io } = {}) => {
  const manager = createGigabrainMemoryManager({ config, scope: resolveScope(options) });
  const provenance = tryLoadReleaseProvenance(config?.releaseRoot || path.resolve(import.meta.dirname, "..", ".."));
  const payload = provenance
    ? attachReleaseProvenance({ ok: true, observational: true, status: manager.status() }, provenance)
    : { ok: true, observational: true, release: null, status: manager.status() };
  return writeOutput(payload, io);
};

const runMemorySearch = async ({ config, query, options = {}, io } = {}) => {
  const resolvedQuery = String(query || options.query || "").trim();
  if (!resolvedQuery) throw new Error("GIGABRAIN_MEMORY_QUERY_REQUIRED");
  const manager = createGigabrainMemoryManager({ config, scope: resolveScope(options) });
  const results = await manager.search(resolvedQuery, { maxResults: options.maxResults });
  return writeOutput({ ok: true, observational: true, query: resolvedQuery, results }, io);
};

const runMemoryGet = async ({ config, lookup, options = {}, io } = {}) => {
  const relPath = String(lookup || options.path || "").trim();
  if (!relPath) throw new Error("GIGABRAIN_MEMORY_LOOKUP_REQUIRED");
  const result = options.raw === true
    ? readOperatorNativeFile({
      config,
      relativePath: relPath,
      authority: "operator-admin",
      transport: "loopback",
      pathSource: "cli",
    })
    : await createGigabrainMemoryManager({ config, scope: resolveScope(options) }).readFile({
      relPath,
      from: options.from,
      lines: options.lines,
    });
  return writeOutput({ ok: true, observational: true, ...result }, io);
};

const runMemoryDoctorRead = async ({ config, options = {}, io } = {}) => {
  const status = await runMemoryStatus({
    config,
    options,
    io: { stdout: { write() {} } },
  });
  return writeOutput({ ...status, doctor_mode: "read", observational: true }, io);
};

const registerGigabrainMemoryCli = (program, { config, io = process } = {}) => {
  const memory = program.command("memory").description("Search and inspect Gigabrain memory observationally");
  memory.command("status")
    .description("Show observational Gigabrain memory status")
    .option("--agent <id>", "Trusted local agent scope")
    .option("--json", "Print JSON")
    .action((options) => runMemoryStatus({ config, options, io }));
  memory.command("search")
    .description("Search authorized Gigabrain virtual memory documents")
    .argument("[query]", "Search query")
    .option("--query <text>", "Search query")
    .option("--agent <id>", "Trusted local agent scope")
    .option("--max-results <n>", "Maximum results", (value) => Number(value))
    .option("--json", "Print JSON")
    .action((query, options) => runMemorySearch({ config, query, options, io }));
  memory.command("get")
    .description("Read an authorized virtual memory id; raw native reads are local operator-only")
    .argument("<path>", "gigabrain:// virtual id or raw relative path")
    .option("--agent <id>", "Trusted local agent scope")
    .option("--from <line>", "First line", (value) => Number(value))
    .option("--lines <count>", "Line count", (value) => Number(value))
    .option("--raw", "Read a configured native file as the local operator", false)
    .option("--json", "Print JSON")
    .action((lookup, options) => runMemoryGet({ config, lookup, options, io }));
  memory.command("doctor-read")
    .description("Inspect memory health without repair, sync, indexing, promotion, or rebuild")
    .option("--agent <id>", "Trusted local agent scope")
    .option("--json", "Print JSON")
    .action((options) => runMemoryDoctorRead({ config, options, io }));
};

const createGigabrainMemoryCliRegistrar = (config, io = process) => async ({ program }) => {
  registerGigabrainMemoryCli(program, { config, io });
};

export {
  createGigabrainMemoryCliRegistrar,
  registerGigabrainMemoryCli,
  runMemoryDoctorRead,
  runMemoryGet,
  runMemorySearch,
  runMemoryStatus,
};

import fs from "node:fs";
import path from "node:path";

const WRITE_MODES = Object.freeze(["read_only", "native_only", "full"]);

const registryRows = [
  ["actions.apply", "actions", false],
  ["capture.capture_from_event", "capture", false],
  ["cli.audit", "cli", false],
  ["cli.claim_decide", "cli", false],
  ["cli.claim_propose", "cli", false],
  ["cli.control_apply", "cli", false],
  ["cli.export_bundle", "cli", false],
  ["cli.handoff", "cli", false],
  ["cli.import", "cli", false],
  ["cli.import_bundle", "cli", false],
  ["cli.import_openclaw", "cli", false],
  ["cli.inventory", "cli", false, true, "read"],
  ["cli.index", "cli", false],
  ["cli.maintain", "cli", false],
  ["cli.migrate", "cli", false],
  ["cli.nightly", "cli", false],
  ["cli.review_apply", "cli", false],
  ["cli.session_hook", "cli", false],
  ["cli.setup", "setup", false],
  ["cli.sync_hosts", "cli", false],
  ["cli.synthesis_build", "cli", false],
  ["cli.transcript_sync", "cli", false],
  ["cli.vault_sync", "cli", false],
  ["cli.watch", "cli", false],
  ["cli.watch_hook", "cli", false],
  ["cli.wiki_project", "cli", false],
  ["cli.wiki_reconcile", "cli", false],
  ["cli.world_rebuild", "cli", false],
  ["codex.arbitrate", "codex", false],
  ["codex.bootstrap", "codex", false],
  ["codex.checkpoint", "codex", false],
  ["codex.claim_decide", "codex", false],
  ["codex.claim_propose", "codex", false],
  ["codex.receipt_write", "codex", false],
  ["codex.remember", "codex", false],
  ["control.checkpoint_append", "control", false],
  ["control.claim_decision_append", "control", false],
  ["control.claim_proposal_append", "control", false],
  ["control.receipt_append", "control", false],
  ["host.sync", "host-sync", false],
  ["http.control_apply", "http", false],
  ["http.suggestions", "http", false],
  ["internal.audit.purge", "internal", false],
  ["internal.checkpoint.migrate", "internal", false],
  ["internal.entity.rebuild", "internal", false],
  ["internal.event.append", "internal", false],
  ["internal.handoff.import", "internal", false],
  ["internal.host.record-sync", "internal", false],
  ["internal.native.sync", "internal", false],
  ["internal.openclaw.import", "internal", false],
  ["internal.passport.write", "internal", false],
  ["internal.projection.adjudicate", "internal", false],
  ["internal.projection.drop-legacy", "internal", false],
  ["internal.projection.rebuild-fts", "internal", false],
  ["internal.projection.update", "internal", false],
  ["internal.projection.upsert", "internal", false],
  ["internal.projection.verdict", "internal", false],
  ["internal.queue.retention", "internal", false],
  ["internal.setup.claude", "internal", false],
  ["internal.setup.codex", "internal", false],
  ["internal.setup.standalone", "internal", false],
  ["internal.vault.sync", "internal", false],
  ["internal.world.project", "internal", false],
  ["internal.world.rebuild", "internal", false],
  ["maintenance.run", "maintenance", false],
  ["mcp.local.checkpoint", "local-mcp", false],
  ["mcp.local.arbitrate", "local-mcp", false],
  ["mcp.local.claim_decide", "local-mcp", false],
  ["mcp.local.claim_propose", "local-mcp", false],
  ["mcp.local.receipt_write", "local-mcp", false],
  ["mcp.local.remember", "local-mcp", false],
  ["mcp.remote.checkpoint", "remote-mcp", false, false],
  ["mcp.remote.arbitrate", "remote-mcp", false, false],
  ["mcp.remote.claim_decide", "remote-mcp", false, false],
  ["mcp.remote.claim_propose", "remote-mcp", false, false],
  ["mcp.remote.receipt_write", "remote-mcp", false, false],
  ["mcp.remote.remember", "remote-mcp", false, false],
  ["native.checkpoint", "native", false],
  ["native.entry", "native", false],
  ["openclaw.agent_end.full_capture", "openclaw", false],
  ["openclaw.native_explicit_remember", "openclaw", true],
  ["package.harmonize", "package-script", false],
  ["package.migrate-v3", "package-script", false],
  ["projection.materialize", "projection", false],
  ["queue.append", "queue", false],
  ["queue.review", "queue", false],
  ["setup.first_run", "setup", false],
  ["transcript.harvest", "transcript", false, false],
  ["wiki.project", "wiki", false, false],
  ["wiki.reconcile", "wiki", false, false],
];

const WRITER_REGISTRY = Object.freeze(Object.fromEntries(registryRows.map(([
  operation,
  surface,
  nativeOnly,
  enabled = true,
  access = "write",
]) => [operation, Object.freeze({
  access,
  allowedModes: Object.freeze(access === "read"
    ? ["read_only", "native_only", "full"]
    : nativeOnly ? ["native_only", "full"] : ["full"]),
  enabled,
  operation,
  surface,
})])));

const policyError = (code, message) => {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
};

const resolveWriteMode = (configOrMode = "full") => {
  const raw = typeof configOrMode === "string"
    ? configOrMode
    : configOrMode?.compat?.writeMode;
  const mode = String(raw || "full").trim().toLowerCase();
  if (!WRITE_MODES.includes(mode)) {
    throw policyError("GIGABRAIN_INVALID_WRITE_MODE", `unsupported write mode '${mode}'`);
  }
  return mode;
};

const assertWriteAllowed = ({ mode = "full", operation = "" } = {}) => {
  const normalizedMode = resolveWriteMode(mode);
  const normalizedOperation = String(operation || "").trim();
  const classification = WRITER_REGISTRY[normalizedOperation];
  if (!classification) {
    throw policyError("GIGABRAIN_UNCLASSIFIED_WRITER", normalizedOperation || "missing operation");
  }
  if (classification.access !== "write") {
    throw policyError("GIGABRAIN_NOT_A_WRITE_OPERATION", normalizedOperation);
  }
  if (!classification.allowedModes.includes(normalizedMode)) {
    throw policyError(
      "GIGABRAIN_WRITE_FORBIDDEN",
      `${normalizedOperation} is disabled in ${normalizedMode}`,
    );
  }
  return classification;
};

const assertEntrypointAllowed = ({ mode = "full", operation = "" } = {}) => {
  const normalizedMode = resolveWriteMode(mode);
  const normalizedOperation = String(operation || "").trim();
  const classification = WRITER_REGISTRY[normalizedOperation];
  if (!classification) throw policyError("GIGABRAIN_UNCLASSIFIED_WRITER", normalizedOperation || "missing operation");
  if (!classification.allowedModes.includes(normalizedMode)) {
    throw policyError("GIGABRAIN_WRITE_FORBIDDEN", `${normalizedOperation} is disabled in ${normalizedMode}`);
  }
  return classification;
};

const MUTATION_PRIMITIVE_RE = /\b(?:appendFileSync|atomicWriteFileSync|backupFile|backupIfExists|captureFromEvent|chmodSync|copyFileSync|createFileExclusiveSync|dropLegacy|ensureDir|ensure[A-Z][A-Za-z]+Store|harvestTranscripts|import[A-Z]|installSessionHook|materializeProjectionFromMemories|mkdirSync|openDatabase|projectWiki|rebuild[A-Z]|renameSync|rmSync|runAudit|runMaintenance|sync[A-Z]|uninstallSessionHook|updateCurrentStatus|upsertCurrentMemory|writeFileSync|writeMemoryPassport|writeNative)\b/;

const normalizeOperationToken = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[:/]+/g, "-")
  .replace(/[^a-z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "");

const extractBalancedFunctionBody = (source, functionName) => {
  const escaped = String(functionName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\b(?:const\\s+${escaped}\\s*=|(?:async\\s+)?function\\s+${escaped}\\b)`).exec(source);
  if (!declaration) return "";
  const start = source.indexOf("{", declaration.index + declaration[0].length);
  if (start < 0) return "";
  let depth = 0;
  let quote = "";
  let escapedChar = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escapedChar) escapedChar = false;
      else if (char === "\\") escapedChar = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  return "";
};

const discoverPackageEntrypoints = (repoRoot) => {
  const packagePath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packagePath)) return [];
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const rows = [];
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    const match = String(command || "").match(/(?:^|\s)node\s+(?:--[^\s]+\s+)*([A-Za-z0-9_./-]+\.m?js)\b/);
    if (!match) continue;
    const scriptPath = path.resolve(repoRoot, match[1]);
    let source = "";
    try { source = fs.readFileSync(scriptPath, "utf8"); } catch { /* missing is diagnosed elsewhere */ }
    const normalizedName = normalizeOperationToken(name);
    const operation = `package.${normalizedName}`;
    const ignoredTooling = /^(?:audit|build|demo|pack|prepack|test)(?:[.:-]|$)/.test(normalizedName)
      || path.posix.basename(match[1]).startsWith("build-");
    const explicitlyGuarded = source.includes("assertWriteAllowed") || source.includes("assertEntrypointAllowed");
    const criticalDirectWriter = name === "migrate:v3" || name === "harmonize";
    rows.push({
      access: criticalDirectWriter || (!ignoredTooling && !explicitlyGuarded && MUTATION_PRIMITIVE_RE.test(source)) ? "write" : "read",
      command: String(command || ""),
      operation,
      sourcePath: match[1],
      surface: "package-script",
    });
  }
  return rows;
};

const discoverCliEntrypoints = (repoRoot) => {
  const cliPath = path.join(repoRoot, "scripts", "gigabrainctl.js");
  if (!fs.existsSync(cliPath)) return [];
  const source = fs.readFileSync(cliPath, "utf8");
  const rows = [];
  const seen = new Set();
  const policyBody = extractBalancedFunctionBody(source, "resolveCliWriteOperation");
  const declaredWriteOperations = new Set(
    [...policyBody.matchAll(/['"](cli\.[a-z0-9_.-]+)['"]/g)].map((match) => match[1]),
  );
  for (const operation of declaredWriteOperations) {
    rows.push({ access: "write", operation, sourcePath: "scripts/gigabrainctl.js", surface: "cli" });
  }
  for (const match of source.matchAll(/\bcommand\s*===\s*['"]([^'"]+)['"][\s\S]{0,180}?await\s+(command[A-Za-z0-9_]+)\s*\(/g)) {
    const commandName = String(match[1]);
    if (seen.has(commandName)) continue;
    seen.add(commandName);
    const operation = `cli.${normalizeOperationToken(commandName).replaceAll("-", "_")}`;
    if (declaredWriteOperations.has(operation)) continue;
    rows.push({
      access: "read",
      operation,
      sourcePath: "scripts/gigabrainctl.js",
      surface: "cli",
    });
  }
  return rows;
};

const discoverHttpEntrypoints = (repoRoot) => {
  const sourcePath = path.join(repoRoot, "lib", "core", "http-routes.js");
  if (!fs.existsSync(sourcePath)) return [];
  const source = fs.readFileSync(sourcePath, "utf8");
  const rows = [];
  for (const match of source.matchAll(/pathname\s*===\s*['"]([^'"]+)['"]\s*&&\s*method\s*===\s*['"]([^'"]+)['"]/g)) {
    const pathname = match[1];
    const method = match[2].toUpperCase();
    const operation = pathname === "/gb/control/apply"
      ? "http.control_apply"
      : pathname === "/gb/suggestions" ? "http.suggestions" : `http.${method.toLowerCase()}:${pathname}`;
    const knownReadPost = new Set(["/gb/bench/recall", "/gb/recall", "/gb/recall/explain"]);
    rows.push({
      access: pathname === "/gb/control/apply" || pathname === "/gb/suggestions"
        ? "write"
        : method === "GET" || knownReadPost.has(pathname) ? "read" : "write",
      operation,
      sourcePath: "lib/core/http-routes.js",
      surface: "http",
    });
  }
  return rows;
};

const discoverMcpEntrypoints = (repoRoot) => {
  const sourcePath = path.join(repoRoot, "lib", "core", "codex-mcp.js");
  if (!fs.existsSync(sourcePath)) return [];
  const source = fs.readFileSync(sourcePath, "utf8");
  const rows = [];
  const writeToolOperations = {
    gigabrain_arbitrate: "mcp.local.arbitrate",
    gigabrain_checkpoint: "mcp.local.checkpoint",
    gigabrain_claim_decide: "mcp.local.claim_decide",
    gigabrain_claim_propose: "mcp.local.claim_propose",
    gigabrain_receipt_write: "mcp.local.receipt_write",
    gigabrain_remember: "mcp.local.remember",
  };
  const matches = [...source.matchAll(/server\.registerTool\(['"]([^'"]+)['"],\s*\{/g)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const end = matches[index + 1]?.index ?? source.length;
    const block = source.slice(match.index, end);
    rows.push({
      access: block.includes("additiveWriteAnnotations") ? "write" : "read",
      operation: writeToolOperations[match[1]] || `mcp.tool.${normalizeOperationToken(match[1])}`,
      sourcePath: "lib/core/codex-mcp.js",
      surface: "mcp-tool",
    });
  }
  return rows;
};

const EXPORTED_WRITER_OPERATION_BY_SYMBOL = Object.freeze({
  "lib/compat/openclaw-memory-runtime.js#captureNativeExplicitRemember": "openclaw.native_explicit_remember",
  "lib/core/audit-service.js#purgeNoopReviews": "internal.audit.purge",
  "lib/core/checkpoint-migration.js#migrateLegacyCheckpoints": "internal.checkpoint.migrate",
  "lib/core/claude-project.js#upsertClaudeMarkdownBlock": "internal.setup.claude",
  "lib/core/claude-project.js#upsertClaudeMcpConfig": "internal.setup.claude",
  "lib/core/claude-project.js#writeClaudeSupportFiles": "internal.setup.claude",
  "lib/core/capture-service.js#captureFromEvent": "capture.capture_from_event",
  "lib/core/codex-service.js#bootstrapStandaloneStore": "codex.bootstrap",
  "lib/core/codex-service.js#runCheckpoint": "codex.checkpoint",
  "lib/core/codex-service.js#runClaimDecide": "codex.claim_decide",
  "lib/core/codex-service.js#runClaimPropose": "codex.claim_propose",
  "lib/core/codex-service.js#runReceiptWrite": "codex.receipt_write",
  "lib/core/codex-service.js#runRemember": "codex.remember",
  "lib/core/control-plane.js#appendCheckpointEpisode": "control.checkpoint_append",
  "lib/core/control-plane.js#appendClaimDecision": "control.claim_decision_append",
  "lib/core/control-plane.js#appendClaimProposal": "control.claim_proposal_append",
  "lib/core/control-plane.js#appendMemoryReceipt": "control.receipt_append",
  "lib/core/codex-project.js#upsertCodexAgentsBlock": "internal.setup.codex",
  "lib/core/codex-project.js#upsertMarkedBlock": "internal.setup.codex",
  "lib/core/codex-project.js#writeCodexSupportFiles": "internal.setup.codex",
  "lib/core/event-store.js#appendEvent": "internal.event.append",
  "lib/core/event-store.js#appendEvents": "internal.event.append",
  "lib/core/handoff-bundle.js#importPassportBundle": "internal.handoff.import",
  "lib/core/handoff-record.js#writeMemoryPassport": "internal.passport.write",
  "lib/core/host-memory-sync.js#recordSyncRun": "internal.host.record-sync",
  "lib/core/host-memory-sync.js#syncHostMemories": "host.sync",
  "lib/core/maintenance-service.js#runMaintenance": "maintenance.run",
  "lib/core/memory-actions.js#applyMemoryActions": "actions.apply",
  "lib/core/native-memory.js#writeNativeMemoryEntry": "native.entry",
  "lib/core/native-memory.js#writeNativeSessionCheckpoint": "native.checkpoint",
  "lib/core/native-sync.js#syncNativeMemory": "internal.native.sync",
  "lib/core/openclaw-import.js#importOpenClawRegistry": "internal.openclaw.import",
  "lib/core/person-service.js#rebuildEntityMentions": "internal.entity.rebuild",
  "lib/core/projection-store.js#dropLegacyMemoriesTable": "internal.projection.drop-legacy",
  "lib/core/projection-store.js#materializeProjectionFromMemories": "projection.materialize",
  "lib/core/projection-store.js#rebuildFTS5": "internal.projection.rebuild-fts",
  "lib/core/projection-store.js#recordAdjudication": "internal.projection.adjudicate",
  "lib/core/projection-store.js#recordVerdict": "internal.projection.verdict",
  "lib/core/projection-store.js#updateCurrentStatus": "internal.projection.update",
  "lib/core/projection-store.js#upsertCurrentMemory": "internal.projection.upsert",
  "lib/core/review-queue.js#applyQueueRetention": "internal.queue.retention",
  "lib/core/review-queue.js#appendQueueRow": "queue.append",
  "lib/core/standalone-client.js#upsertMarkedBlock": "internal.setup.standalone",
  "lib/core/standalone-client.js#upsertMcpServerEntry": "internal.setup.standalone",
  "lib/core/standalone-client.js#writeExecutableFile": "internal.setup.standalone",
  "lib/core/standalone-client.js#writeJsonPretty": "internal.setup.standalone",
  "lib/core/transcript-harvester.js#harvestTranscripts": "transcript.harvest",
  "lib/core/wiki-project.js#projectWiki": "wiki.project",
  "lib/core/wiki-project.js#reconcileWiki": "wiki.reconcile",
  "lib/core/vault-sync.js#syncVaultMemory": "internal.vault.sync",
  "lib/core/world-model.js#projectArbitrationBeliefRows": "internal.world.project",
  "lib/core/world-model.js#rebuildWorldModel": "internal.world.rebuild",
});

const WRITER_EXPORT_NAME_RE = /^(?:append|apply|bootstrap|capture|drop|harvest|import|install|materialize|migrate|project|purge|rebuild|record|refresh|run(?:Checkpoint|Claim|Maintenance|Receipt|Remember)|sync|uninstall|update|upsert|write)[A-Z0-9_]/;
const NON_PERSISTENT_EXPORTS = new Set([
  "captureSnapshotMetrics",
  "recordRecallLatency",
  "runCheckpointGet",
  "runCheckpointList",
  "runClaimReview",
  "runReceiptGet",
]);

const discoverExportedWriterEntrypoints = (repoRoot) => {
  const roots = [path.join(repoRoot, "lib", "core"), path.join(repoRoot, "lib", "compat")];
  const rows = [];
  for (const directory of roots) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(repoRoot, absolutePath).replaceAll(path.sep, "/");
      const source = fs.readFileSync(absolutePath, "utf8");
      const exported = new Set();
      for (const block of source.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*;/g)) {
        for (const part of block[1].split(",")) {
          const symbol = String(part || "").trim().split(/\s+as\s+/i)[0].trim();
          if (WRITER_EXPORT_NAME_RE.test(symbol) && !NON_PERSISTENT_EXPORTS.has(symbol)) exported.add(symbol);
        }
      }
      for (const symbol of exported) {
        const key = `${relativePath}#${symbol}`;
        const operation = EXPORTED_WRITER_OPERATION_BY_SYMBOL[key] || `export.${key}`;
        rows.push({ access: "write", operation, sourcePath: relativePath, surface: "exported-writer", symbol });
      }
    }
  }
  return rows;
};

const discoverWriterEntrypoints = ({ repoRoot = path.resolve(import.meta.dirname, "..", "..") } = {}) => {
  const rows = [
    ...discoverPackageEntrypoints(repoRoot),
    ...discoverCliEntrypoints(repoRoot),
    ...discoverHttpEntrypoints(repoRoot),
    ...discoverMcpEntrypoints(repoRoot),
    ...discoverExportedWriterEntrypoints(repoRoot),
  ];
  const byOperation = new Map();
  for (const row of rows) {
    const previous = byOperation.get(row.operation);
    if (!previous || (previous.access === "read" && row.access === "write")) byOperation.set(row.operation, row);
  }
  return [...byOperation.values()].sort((left, right) => left.operation.localeCompare(right.operation, "en"));
};

const assertWriterRegistryComplete = (discoveredOperations = []) => {
  const discovered = (Array.isArray(discoveredOperations) && discoveredOperations.length > 0
    ? discoveredOperations
    : discoverWriterEntrypoints()).map((item) => typeof item === "string"
      ? { access: "write", operation: item }
      : item);
  for (const entry of discovered) {
    const operation = String(entry?.operation || "").trim();
    const classification = WRITER_REGISTRY[operation];
    if (entry?.access === "write" && !classification) {
      throw policyError("GIGABRAIN_UNCLASSIFIED_WRITER", operation);
    }
    if (classification && classification.access !== entry.access) {
      throw policyError("GIGABRAIN_WRITER_CLASSIFICATION_MISMATCH", operation);
    }
  }
  for (const operation of Object.keys(WRITER_REGISTRY)) {
    const row = WRITER_REGISTRY[operation];
    if (row.operation !== operation || !row.allowedModes.includes("full")) {
      throw policyError("GIGABRAIN_WRITER_REGISTRY_INVALID", operation);
    }
  }
  return true;
};

export {
  WRITE_MODES,
  WRITER_REGISTRY,
  assertEntrypointAllowed,
  assertWriteAllowed,
  assertWriterRegistryComplete,
  discoverWriterEntrypoints,
  resolveWriteMode,
};

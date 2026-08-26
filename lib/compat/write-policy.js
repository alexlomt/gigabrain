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
]) => [operation, Object.freeze({
  allowedModes: Object.freeze(nativeOnly ? ["native_only", "full"] : ["full"]),
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
  if (!classification.allowedModes.includes(normalizedMode)) {
    throw policyError(
      "GIGABRAIN_WRITE_FORBIDDEN",
      `${normalizedOperation} is disabled in ${normalizedMode}`,
    );
  }
  return classification;
};

const assertWriterRegistryComplete = (discoveredOperations = []) => {
  const discovered = [...new Set((Array.isArray(discoveredOperations) ? discoveredOperations : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
  for (const operation of discovered) {
    if (!WRITER_REGISTRY[operation]) {
      throw policyError("GIGABRAIN_UNCLASSIFIED_WRITER", operation);
    }
  }
  const discoveredSet = new Set(discovered);
  for (const operation of Object.keys(WRITER_REGISTRY)) {
    const row = WRITER_REGISTRY[operation];
    if (row.operation !== operation || !WRITE_MODES.includes("full") || !row.allowedModes.includes("full")) {
      throw policyError("GIGABRAIN_WRITER_REGISTRY_INVALID", operation);
    }
    if (discovered.length > 0 && !discoveredSet.has(operation)) {
      throw policyError("GIGABRAIN_WRITER_REGISTRY_STALE", operation);
    }
  }
  return true;
};

export {
  WRITE_MODES,
  WRITER_REGISTRY,
  assertWriteAllowed,
  assertWriterRegistryComplete,
  resolveWriteMode,
};

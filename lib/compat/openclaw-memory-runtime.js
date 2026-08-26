import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeAgentScope, resolveVisibleScopes } from "./scope-policy.js";
import { assertWriteAllowed, resolveWriteMode } from "./write-policy.js";
import { writeNativeMemoryEntry } from "../core/native-memory.js";
import { readContainedRegularFileNoFollowSync } from "../core/safe-fs.js";

const GIGABRAIN_VIRTUAL_SCHEME = "gigabrain:";
const VIRTUAL_KINDS = new Set(["entity", "memory", "native", "timeline"]);
const MEMORY_TYPES = new Set([
  "USER_FACT",
  "PREFERENCE",
  "DECISION",
  "ENTITY",
  "EPISODE",
  "AGENT_IDENTITY",
  "CONTEXT",
]);

const runtimeError = (code, detail = "") => {
  const error = new Error(`${code}${detail ? `: ${detail}` : ""}`);
  error.code = code;
  return error;
};

const resolveRuntimeConfig = (input = {}) => input?.config || input;

const resolveRegistryPath = (config = {}) => String(
  config?.runtime?.paths?.registryPath || "",
).trim();

const withReadRegistry = (dbPath, fn) => {
  const resolvedPath = String(dbPath || "").trim();
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw runtimeError("GIGABRAIN_REGISTRY_UNAVAILABLE", resolvedPath || "registry path is missing");
  }
  const db = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    try { db.exec("PRAGMA query_only = ON"); } catch { /* connection-local hardening */ }
    try { db.exec("PRAGMA busy_timeout = 5000"); } catch { /* best effort */ }
    return fn(db);
  } finally {
    db.close();
  }
};

const tableExists = (db, name) => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
).get(String(name || "")));

const visibleScopePredicate = (visibleScopes, column = "scope") => {
  const scopes = [...new Set((visibleScopes || []).map((scope) => String(scope || "").trim()).filter(Boolean))];
  if (scopes.length === 0) return { sql: "0 = 1", params: [] };
  return {
    sql: `COALESCE(${column}, 'shared') IN (${scopes.map(() => "?").join(",")})`,
    params: scopes,
  };
};

const parseVirtualPath = (relPath) => {
  const raw = String(relPath || "").trim();
  if (!raw.startsWith("gigabrain://")) {
    throw runtimeError("GIGABRAIN_VIRTUAL_PATH_REQUIRED", "agent reads require a virtual id");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw runtimeError("GIGABRAIN_INVALID_VIRTUAL_PATH", raw);
  }
  const kind = String(parsed.hostname || "").toLowerCase();
  const encodedId = parsed.pathname.replace(/^\/+/, "");
  let id = "";
  try { id = decodeURIComponent(encodedId); } catch { /* rejected below */ }
  if (
    parsed.protocol !== GIGABRAIN_VIRTUAL_SCHEME
    || !VIRTUAL_KINDS.has(kind)
    || !id
    || id.includes("/")
    || id.includes("\\")
    || id === "."
    || id === ".."
    || parsed.search
    || parsed.hash
  ) {
    throw runtimeError("GIGABRAIN_INVALID_VIRTUAL_PATH", raw);
  }
  return { id, kind, path: `gigabrain://${kind}/${encodeURIComponent(id)}` };
};

const conceal = () => {
  throw runtimeError("GIGABRAIN_MEMORY_NOT_FOUND", "memory was not found");
};

const paginateText = (text, relPath, from = 1, lines = 200) => {
  const allLines = String(text || "").split(/\r?\n/);
  const safeFrom = Math.max(1, Number(from || 1) || 1);
  const safeLines = Math.max(1, Math.min(2_000, Number(lines || 200) || 200));
  const selected = allLines.slice(safeFrom - 1, safeFrom - 1 + safeLines);
  const nextFrom = safeFrom - 1 + selected.length < allLines.length
    ? safeFrom + selected.length
    : undefined;
  return {
    text: selected.join("\n"),
    path: relPath,
    truncated: nextFrom !== undefined,
    from: safeFrom,
    lines: selected.length,
    ...(nextFrom ? { nextFrom } : {}),
  };
};

const readMemoryDocument = (db, id, visibleScopes) => {
  if (!tableExists(db, "memory_current")) conceal();
  const scope = visibleScopePredicate(visibleScopes, "scope");
  const row = db.prepare(`
    SELECT memory_id, type, content, confidence, scope, status, source_layer,
           source_path, source_line, created_at, updated_at, content_time, valid_from, valid_until
    FROM memory_current
    WHERE memory_id = ? AND status = 'active' AND ${scope.sql}
    LIMIT 1
  `).get(id, ...scope.params);
  if (!row) conceal();
  return [
    `# ${row.type || "MEMORY"} ${row.memory_id}`,
    "",
    String(row.content || ""),
    "",
    `scope: ${row.scope || "shared"}`,
    `confidence: ${Number(row.confidence || 0)}`,
    `source_layer: ${row.source_layer || "registry"}`,
    `created_at: ${row.created_at || ""}`,
    `updated_at: ${row.updated_at || ""}`,
  ].join("\n");
};

const assertMemoryVisible = (db, id, visibleScopes) => {
  if (!tableExists(db, "memory_current")) conceal();
  const scope = visibleScopePredicate(visibleScopes, "scope");
  const row = db.prepare(`
    SELECT memory_id FROM memory_current
    WHERE memory_id = ? AND status = 'active' AND ${scope.sql}
    LIMIT 1
  `).get(id, ...scope.params);
  if (!row) conceal();
};

const readTimelineDocument = (db, id, visibleScopes) => {
  assertMemoryVisible(db, id, visibleScopes);
  if (!tableExists(db, "memory_events")) return `# Timeline ${id}\n`;
  const events = db.prepare(`
    SELECT event_id, timestamp, component, action, reason_codes, memory_id,
           cleanup_version, run_id, review_version, similarity, matched_memory_id, agent_id, payload
    FROM memory_events WHERE memory_id = ? ORDER BY timestamp, event_id LIMIT 2000
  `).all(id);
  return `# Timeline ${id}\n\n${JSON.stringify(events, null, 2)}\n`;
};

const readNativeDocument = (db, id, visibleScopes) => {
  if (!tableExists(db, "memory_native_chunks")) conceal();
  const scope = visibleScopePredicate(visibleScopes, "scope");
  const row = db.prepare(`
    SELECT chunk_id, source_kind, source_date, section, line_start, line_end,
           content, scope, linked_memory_id
    FROM memory_native_chunks
    WHERE chunk_id = ? AND status = 'active' AND ${scope.sql}
    LIMIT 1
  `).get(id, ...scope.params);
  if (!row) conceal();
  return [
    `# Native chunk ${row.chunk_id}`,
    "",
    String(row.content || ""),
    "",
    `scope: ${row.scope || "shared"}`,
    `source_kind: ${row.source_kind || ""}`,
    `source_date: ${row.source_date || ""}`,
    `lines: ${row.line_start || 0}-${row.line_end || 0}`,
  ].join("\n");
};

const readEntityDocument = (db, id, visibleScopes) => {
  if (!tableExists(db, "memory_entities") || !tableExists(db, "memory_beliefs") || !tableExists(db, "memory_current")) {
    conceal();
  }
  const entity = db.prepare(`
    SELECT entity_id, kind, display_name, confidence, aliases, created_at, updated_at
    FROM memory_entities WHERE entity_id = ? AND status = 'active' LIMIT 1
  `).get(id);
  if (!entity) conceal();
  const scope = visibleScopePredicate(visibleScopes, "current.scope");
  const beliefs = db.prepare(`
    SELECT belief.belief_id, belief.type, belief.content, belief.status,
           belief.confidence, belief.valid_from, belief.valid_to, belief.source_memory_id,
           current.scope
    FROM memory_beliefs AS belief
    JOIN memory_current AS current ON current.memory_id = belief.source_memory_id
    WHERE belief.entity_id = ? AND current.status = 'active' AND ${scope.sql}
    ORDER BY belief.belief_id
  `).all(id, ...scope.params);
  if (beliefs.length === 0) conceal();
  return `# ${entity.display_name || entity.entity_id}\n\n${JSON.stringify({ entity, beliefs }, null, 2)}\n`;
};

const readVirtualDocument = (db, virtual, visibleScopes) => {
  if (virtual.kind === "memory") return readMemoryDocument(db, virtual.id, visibleScopes);
  if (virtual.kind === "timeline") return readTimelineDocument(db, virtual.id, visibleScopes);
  if (virtual.kind === "native") return readNativeDocument(db, virtual.id, visibleScopes);
  if (virtual.kind === "entity") return readEntityDocument(db, virtual.id, visibleScopes);
  conceal();
};

const searchRegistry = (db, query, visibleScopes, maxResults) => {
  const terms = String(query || "").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  if (terms.length === 0) return [];
  const scope = visibleScopePredicate(visibleScopes, "scope");
  const limit = Math.max(1, Math.min(100, Number(maxResults || 8) || 8));
  const rows = [];
  if (tableExists(db, "memory_current")) {
    const clauses = terms.map(() => "lower(content) LIKE ? ESCAPE '\\'");
    const values = terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    const current = db.prepare(`
      SELECT memory_id AS id, type, content, scope, source_line, updated_at
      FROM memory_current
      WHERE status = 'active' AND ${scope.sql} AND (${clauses.join(" OR ")})
      ORDER BY updated_at DESC, memory_id LIMIT ?
    `).all(...scope.params, ...values, limit);
    for (const row of current) {
      const matches = terms.filter((term) => String(row.content || "").toLowerCase().includes(term)).length;
      rows.push({
        path: `gigabrain://memory/${encodeURIComponent(row.id)}`,
        startLine: 1,
        endLine: 1,
        score: matches / terms.length,
        textScore: matches / terms.length,
        snippet: String(row.content || ""),
        source: "memory",
        citation: `gigabrain://memory/${encodeURIComponent(row.id)}`,
        scope: String(row.scope || "shared"),
        type: String(row.type || "CONTEXT"),
      });
    }
  }
  if (tableExists(db, "memory_native_chunks") && rows.length < limit) {
    const nativeScope = visibleScopePredicate(visibleScopes, "scope");
    const clauses = terms.map(() => "lower(content) LIKE ? ESCAPE '\\'");
    const values = terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    const native = db.prepare(`
      SELECT chunk_id AS id, content, scope, line_start, line_end, last_seen_at
      FROM memory_native_chunks
      WHERE status = 'active' AND ${nativeScope.sql} AND (${clauses.join(" OR ")})
      ORDER BY last_seen_at DESC, chunk_id LIMIT ?
    `).all(...nativeScope.params, ...values, limit - rows.length);
    for (const row of native) {
      const matches = terms.filter((term) => String(row.content || "").toLowerCase().includes(term)).length;
      rows.push({
        path: `gigabrain://native/${encodeURIComponent(row.id)}`,
        startLine: Number(row.line_start || 1),
        endLine: Number(row.line_end || row.line_start || 1),
        score: matches / terms.length,
        textScore: matches / terms.length,
        snippet: String(row.content || ""),
        source: "memory",
        citation: `gigabrain://native/${encodeURIComponent(row.id)}`,
        scope: String(row.scope || "shared"),
        type: "CONTEXT",
      });
    }
  }
  return rows.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, "en")).slice(0, limit);
};

const readScopedSessionPrelude = ({ config, scope, limit = 6 } = {}) => {
  const normalizedScope = normalizeAgentScope(scope || "shared");
  const visibleScopes = resolveVisibleScopes({ requestedScope: normalizedScope, includeShared: true });
  const dbPath = resolveRegistryPath(config);
  try {
    return withReadRegistry(dbPath, (db) => {
      if (!tableExists(db, "memory_current")) return "";
      const filter = visibleScopePredicate(visibleScopes, "scope");
      const rows = db.prepare(`
        SELECT type, content, scope
        FROM memory_current
        WHERE status = 'active' AND ${filter.sql}
        ORDER BY COALESCE(content_time, updated_at, created_at) DESC, memory_id
        LIMIT ?
      `).all(...filter.params, Math.max(1, Math.min(20, Number(limit || 6) || 6)));
      if (rows.length === 0) return "";
      const lines = [
        "<gigabrain-session-brief>",
        "instruction: This is the latest scope-specific Gigabrain session prelude. Use it silently as grounding.",
        `scope: ${normalizedScope}`,
        ...rows.map((row) => `- [${row.type || "CONTEXT"}] ${String(row.content || "")} (scope:${row.scope || "shared"})`),
        "</gigabrain-session-brief>",
      ];
      return lines.join("\n");
    });
  } catch (error) {
    if (error?.code === "GIGABRAIN_REGISTRY_UNAVAILABLE") return "";
    throw error;
  }
};

const createGigabrainMemoryManager = (input = {}) => {
  const config = resolveRuntimeConfig(input);
  const scope = normalizeAgentScope(input.scope || input.agentId || "shared");
  const visibleScopes = resolveVisibleScopes({ requestedScope: scope, includeShared: true });
  const dbPath = resolveRegistryPath(config);
  return Object.freeze({
    scope,
    async search(query, options = {}) {
      try {
        return withReadRegistry(dbPath, (db) => searchRegistry(db, query, visibleScopes, options.maxResults));
      } catch (error) {
        if (error?.code === "GIGABRAIN_REGISTRY_UNAVAILABLE") return [];
        throw error;
      }
    },
    async readFile({ relPath, from, lines } = {}) {
      const virtual = parseVirtualPath(relPath);
      return withReadRegistry(dbPath, (db) => paginateText(
        readVirtualDocument(db, virtual, visibleScopes),
        virtual.path,
        from,
        lines,
      ));
    },
    status() {
      let files = 0;
      let chunks = 0;
      let registryMemories = 0;
      try {
        withReadRegistry(dbPath, (db) => {
          if (tableExists(db, "memory_native_chunks")) {
            chunks = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_native_chunks WHERE status='active'").get()?.count || 0);
            files = Number(db.prepare("SELECT COUNT(DISTINCT source_path) AS count FROM memory_native_chunks WHERE status='active'").get()?.count || 0);
          }
          if (tableExists(db, "memory_current")) {
            registryMemories = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_current WHERE status='active'").get()?.count || 0);
          }
        });
      } catch (error) {
        if (error?.code !== "GIGABRAIN_REGISTRY_UNAVAILABLE") throw error;
      }
      return {
        backend: "qmd",
        provider: "gigabrain",
        files,
        chunks: chunks + registryMemories,
        dirty: false,
        dbPath,
        sources: ["memory"],
        custom: { registryMemories, scope, visibleScopes: [...visibleScopes] },
      };
    },
    getCachedEmbeddingAvailability() {
      return { ok: false, checked: true, error: "managed by Gigabrain recall" };
    },
    async probeEmbeddingAvailability() {
      return { ok: false, checked: true, error: "managed by Gigabrain recall" };
    },
    async probeVectorStoreAvailability() { return false; },
    async probeVectorAvailability() { return false; },
    async close() {},
  });
};

const createGigabrainMemoryRuntime = (config = {}) => Object.freeze({
  async getMemorySearchManager({ agentId, purpose = "default" } = {}) {
    try {
      return {
        manager: createGigabrainMemoryManager({ config, scope: normalizeAgentScope(agentId || "shared") }),
        debug: { backend: "qmd", purpose, managerCacheState: purpose === "status" ? "transient-status" : purpose === "cli" ? "transient-cli" : "cached-full-hit" },
      };
    } catch (error) {
      return { manager: null, error: error instanceof Error ? error.message : String(error) };
    }
  },
  resolveMemoryBackendConfig() {
    return { backend: "qmd", qmd: { command: "gigabrain" } };
  },
  async closeMemorySearchManager() {},
  async closeAllMemorySearchManagers() {},
});

const readOperatorNativeFile = ({
  config,
  relativePath,
  authority,
  transport,
  pathSource,
  scopeOverride,
} = {}) => {
  if (
    authority !== "operator-admin"
    || transport !== "loopback"
    || pathSource !== "cli"
    || scopeOverride !== undefined
  ) {
    throw runtimeError("GIGABRAIN_RAW_READ_FORBIDDEN", "raw files require loopback operator-admin CLI authority");
  }
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || "").trim();
  const snapshot = readContainedRegularFileNoFollowSync(workspaceRoot, relativePath, "utf8", {
    maxBytes: 16 * 1024 * 1024,
  });
  const memoryRoot = path.resolve(String(config?.runtime?.paths?.memoryRoot || ""));
  const memoryMdPath = path.resolve(String(config?.native?.memoryMdPath || path.join(workspaceRoot, "MEMORY.md")));
  const includeFiles = (Array.isArray(config?.native?.includeFiles) ? config.native.includeFiles : [])
    .map((item) => path.resolve(String(item)));
  const candidate = path.resolve(snapshot.absolutePath);
  const memoryRelative = path.relative(memoryRoot, candidate);
  const allowed = candidate === memoryMdPath
    || includeFiles.includes(candidate)
    || (memoryRelative && !memoryRelative.startsWith("..") && !path.isAbsolute(memoryRelative));
  if (!allowed) throw runtimeError("GIGABRAIN_PATH_REJECTED", "path is outside configured native roots");
  return { path: relativePath, text: snapshot.data, bytes: snapshot.stat.size };
};

const noteAttributes = (raw = "") => {
  const attrs = {};
  const pattern = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(String(raw || "")))) {
    attrs[String(match[1]).toLowerCase()] = String(match[2] ?? match[3] ?? "").trim();
  }
  return attrs;
};

const captureNativeExplicitRemember = ({ config, event = {}, scope = "shared", now } = {}) => {
  assertWriteAllowed({
    mode: resolveWriteMode(config),
    operation: "openclaw.native_explicit_remember",
  });
  const text = String(event.output || event.result || event.response || event.final || "");
  const pattern = /<memory_note\b([^>]*)>([\s\S]*?)<\/memory_note>/gi;
  const notes = [];
  let match;
  while ((match = pattern.exec(text))) {
    const attrs = noteAttributes(match[1]);
    const type = String(attrs.type || "").trim().toUpperCase();
    const confidence = Number(attrs.confidence);
    const content = String(match[2] || "").replace(/\s+/g, " ").trim();
    if (
      !MEMORY_TYPES.has(type)
      || !Object.hasOwn(attrs, "confidence")
      || !Number.isFinite(confidence)
      || confidence < 0
      || confidence > 1
      || !content
      || content.length > 8_000
    ) {
      throw runtimeError("GIGABRAIN_NATIVE_NOTE_METADATA_REQUIRED", "type, confidence and bounded content are required");
    }
    if (Object.hasOwn(attrs, "scope")) {
      throw runtimeError("GIGABRAIN_SCOPE_OVERRIDE_FORBIDDEN", "note scope comes from the trusted event envelope");
    }
    notes.push({ content, type });
  }
  if (notes.length === 0) {
    throw runtimeError("GIGABRAIN_NATIVE_NOTE_METADATA_REQUIRED", "an explicit typed memory_note is required");
  }
  fs.mkdirSync(String(config?.runtime?.paths?.memoryRoot || ''), { recursive: true, mode: 0o700 });
  const timestamp = String(now || new Date().toISOString());
  const results = notes.map((note) => writeNativeMemoryEntry({
    config,
    content: note.content,
    durable: false,
    scope: normalizeAgentScope(scope),
    timestamp,
    type: note.type,
    policyOperation: "openclaw.native_explicit_remember",
  }));
  return {
    written: results.filter((result) => result?.written).length,
    records: results,
  };
};

export {
  GIGABRAIN_VIRTUAL_SCHEME,
  captureNativeExplicitRemember,
  createGigabrainMemoryManager,
  createGigabrainMemoryRuntime,
  parseVirtualPath,
  readOperatorNativeFile,
  readScopedSessionPrelude,
  withReadRegistry,
};

import fs from "node:fs";
import path from "node:path";

import { resolveGigabrainFlushPlan } from "./flush-plan.js";
import { createGigabrainMemoryCliRegistrar } from "./openclaw-memory-cli.js";
import {
  captureNativeExplicitRemember,
  createGigabrainMemoryManager,
  createGigabrainMemoryRuntime,
  readScopedSessionPrelude,
} from "./openclaw-memory-runtime.js";
import { assertWriteAllowed, resolveWriteMode } from "./write-policy.js";
import { normalizeAgentScope } from "./scope-policy.js";
import { captureFromEvent } from "../core/capture-service.js";
import { ensureControlPlaneStore } from "../core/control-plane.js";
import { ensureEventStore } from "../core/event-store.js";
import { GIGABRAIN_HTTP_ROUTES, createMemoryHttpHandler } from "../core/http-routes.js";
import { ensureNativeStore } from "../core/native-sync.js";
import { ensurePersonStore } from "../core/person-service.js";
import { ensureProjectionStore } from "../core/projection-store.js";
import { openDatabase } from "../core/sqlite.js";
import { ensureWorldModelStore } from "../core/world-model.js";

const BRIEFED_SESSION_LIMIT = 2_048;
const BRIEFED_SESSION_RETAIN = 1_536;

const hasSessionPrelude = (cache, sessionKey) => Boolean(cache?.has?.(String(sessionKey || '').trim()));
const markSessionBriefed = (cache, sessionKey, now = Date.now()) => {
  const key = String(sessionKey || '').trim();
  if (!key || !cache?.set) return;
  cache.set(key, now);
  if (cache.size <= BRIEFED_SESSION_LIMIT) return;
  const retained = [...cache.entries()]
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))
    .slice(0, BRIEFED_SESSION_RETAIN);
  cache.clear();
  for (const entry of retained) cache.set(...entry);
};

const adapterError = (code, detail) => {
  const error = new Error(`${code}${detail ? `: ${detail}` : ""}`);
  error.code = code;
  return error;
};

const stableSessionKey = (event = {}, ctx = {}) => String(
  ctx?.sessionKey
  || event?.sessionKey
  || event?.metadata?.sessionKey
  || event?.meta?.sessionKey
  || "",
).trim();

const scopeFromTrustedContext = (ctx = {}) => {
  const explicit = String(ctx?.agentId || "").trim();
  if (explicit) return normalizeAgentScope(explicit);
  const sessionKey = stableSessionKey({}, ctx);
  const parts = sessionKey.split(":");
  return normalizeAgentScope(parts[0] === "agent" ? parts[1] : "shared");
};

const messageText = (message = {}) => {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
};

const extractPromptQuery = (event = {}) => {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role || "").toLowerCase() !== "user") continue;
    const text = messageText(messages[index]).replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 1_000);
  }
  return String(event?.prompt || "").replace(/\s+/g, " ").trim().slice(0, 1_000);
};

const formatRecallInjection = (query, scope, results = []) => {
  if (!Array.isArray(results) || results.length === 0) return "";
  return [
    "<gigabrain-context>",
    `query: ${query}`,
    `scope: ${scope}`,
    "instruction: Use these caller-authorized memories as grounding.",
    "memories:",
    ...results.map((row) => `- ${String(row.snippet || "")} [${row.path}]`),
    "</gigabrain-context>",
  ].join("\n");
};

const createPromptBuildHandler = ({
  config = {},
  logger = {},
  recall,
  getSessionPrelude,
} = {}) => {
  const briefedSessions = new Map();
  const markBriefed = (sessionKey) => {
    if (!sessionKey) return;
    briefedSessions.set(sessionKey, Date.now());
    if (briefedSessions.size <= BRIEFED_SESSION_LIMIT) return;
    const retained = [...briefedSessions.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, BRIEFED_SESSION_RETAIN);
    briefedSessions.clear();
    for (const entry of retained) briefedSessions.set(...entry);
  };
  const recallFn = recall || (async ({ query, scope }) => {
    const manager = createGigabrainMemoryManager({ config, scope });
    const results = await manager.search(query, { maxResults: config?.recall?.topK || 8 });
    return formatRecallInjection(query, scope, results);
  });
  const preludeFn = getSessionPrelude || (async ({ scope }) => readScopedSessionPrelude({ config, scope }));

  return async (event = {}, ctx = {}) => {
    if (config?.recall?.autoInjectEnabled !== true) return undefined;
    const query = extractPromptQuery(event);
    if (!query || /<memory_note\b|^NO_REPLY[.!]?$/i.test(query)) return undefined;
    const scope = scopeFromTrustedContext(ctx);
    const sessionKey = stableSessionKey(event, ctx);
    try {
      const recallText = String(await recallFn({ query, scope, sessionKey }) || "").trim();
      let preludeText = "";
      const preludeEnabled = config?.synthesis?.enabled !== false
        && config?.synthesis?.briefing?.enabled !== false
        && config?.synthesis?.briefing?.includeSessionPrelude !== false;
      if (preludeEnabled && sessionKey && !briefedSessions.has(sessionKey)) {
        preludeText = String(await preludeFn({ scope, sessionKey }) || "").trim();
        if (preludeText) markBriefed(sessionKey);
      }
      const prependContext = [preludeText, recallText].filter(Boolean).join("\n\n");
      return prependContext ? { prependContext } : undefined;
    } catch (error) {
      logger.warn?.(`[gigabrain] observational recall failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
};

const withWriteRegistry = (config, fn) => {
  const dbPath = String(config?.runtime?.paths?.registryPath || "").trim();
  if (!dbPath) throw adapterError("GIGABRAIN_REGISTRY_PATH_REQUIRED", "write requires a configured registry");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureEventStore(db);
    ensureNativeStore(db);
    ensurePersonStore(db);
    ensureWorldModelStore(db);
    ensureControlPlaneStore(db);
    return fn(db);
  } finally {
    db.close();
  }
};

const createCaptureHandler = ({ config = {}, logger = {} } = {}) => async (event = {}, ctx = {}) => {
  if (config?.capture?.enabled === false) return undefined;
  const output = String(event?.output || event?.result || event?.response || event?.final || "");
  if (!output) return undefined;
  const scope = scopeFromTrustedContext(ctx);
  const mode = resolveWriteMode(config);
  try {
    if (mode === "native_only") {
      if (!/<memory_note\b/i.test(output)) return undefined;
      return captureNativeExplicitRemember({ config, event: { ...event, output }, scope });
    }
    assertWriteAllowed({ mode, operation: "openclaw.agent_end.full_capture" });
    return withWriteRegistry(config, (db) => captureFromEvent({
      db,
      config,
      event: {
        ...event,
        agentId: String(ctx?.agentId || ""),
        scope,
        sessionKey: stableSessionKey(event, ctx),
        output,
      },
      logger,
      refreshDerived: false,
      reviewVersion: "",
      runId: `openclaw-capture-${Date.now()}`,
    }));
  } catch (error) {
    logger.warn?.(`[gigabrain] capture rejected: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

const registerHttpCompatibility = (api, config, logger) => {
  if (typeof api.registerHttpRoute !== "function") {
    if (typeof api.registerHttpHandler === "function") {
      logger.warn?.("[gigabrain] HTTP routes require OpenClaw registerHttpRoute gateway authentication; deprecated registerHttpHandler fallback is disabled");
    }
    return;
  }
  const handler = createMemoryHttpHandler({
    allowNoAuth: true,
    config,
    dbPath: String(config?.runtime?.paths?.registryPath || ""),
    logger,
    token: "",
    writeMode: resolveWriteMode(config),
  });
  for (const route of GIGABRAIN_HTTP_ROUTES) {
    api.registerHttpRoute({
      path: route.path,
      auth: "gateway",
      match: route.match,
      handler: async (req, res) => {
        const handled = await handler(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.end("Not Found");
        }
      },
    });
  }
};

const registerOpenClawCompatibility = (api = {}, config = {}) => {
  if (config?.enabled === false) return;
  if (typeof api.registerMemoryCapability !== "function") {
    throw adapterError(
      "GIGABRAIN_UNSUPPORTED_OPENCLAW_MEMORY_CAPABILITY",
      "OpenClaw 2026.7.1-2 registerMemoryCapability({ runtime, flushPlanResolver }) is required",
    );
  }
  if (typeof api.registerCli !== "function") {
    throw adapterError(
      "GIGABRAIN_UNSUPPORTED_OPENCLAW_CLI",
      "OpenClaw 2026.7.1-2 registerCli is required",
    );
  }
  if (typeof api.on !== "function") {
    throw adapterError("GIGABRAIN_UNSUPPORTED_OPENCLAW_HOOKS", "OpenClaw lifecycle hooks are required");
  }
  const logger = api.logger || {};
  const runtime = createGigabrainMemoryRuntime(config);
  const flushPlanResolver = (params = {}) => resolveGigabrainFlushPlan(config, params);
  const cliRegistrar = createGigabrainMemoryCliRegistrar(config);
  const promptHandler = createPromptBuildHandler({ config, logger });
  const captureHandler = createCaptureHandler({ config, logger });

  api.registerMemoryCapability({ runtime, flushPlanResolver });
  api.registerCli(cliRegistrar, {
    descriptors: [{ name: "memory", description: "Search and inspect Gigabrain memory", hasSubcommands: true }],
  });
  api.on("before_prompt_build", promptHandler);
  api.on("agent_end", captureHandler);
  registerHttpCompatibility(api, config, logger);
};

export {
  createCaptureHandler,
  createPromptBuildHandler,
  extractPromptQuery,
  hasSessionPrelude,
  markSessionBriefed,
  registerOpenClawCompatibility,
  scopeFromTrustedContext,
};

// Per-host trust model for ingested / cross-host memories.
//
// Closes the auto-trust hole (MINJA / AgentPoison attack class): a writable
// native file (e.g. a .cursor/.windsurf rules file dropped by a cloned repo) or
// a manual cloud paste must NOT be stamped with the same confidence as the
// agent's own first-party memory. Trust flows into the confidence assigned at
// ingest, and the world model already weights that (`beliefPriorityScore` uses
// confidence), so a low-trust source can no longer win a claim slot on recency
// alone and supersede a correct, high-trust belief.
//
// Tiers are decided by host family, not a giant enum, so a new/unknown host
// inherits a conservative floor instead of silently defaulting to "trusted".

// The agent's own first-party memory surfaces.
const OWN_AGENT = new Set([
  'codex', 'claude_code', 'openclaw', 'hermes',
  'gigabrain', 'gigabrain_native', 'registry', 'host_sync', 'native',
  'host_memory', 'codex_app', 'codex_cli', 'claude_desktop', 'openclaw_native',
]);

// Repo/workspace rule files: legitimate, but user/repo-editable and therefore a
// realistic injection vector when a repo is cloned, so trusted below own memory.
const WORKSPACE = new Set(['cursor', 'windsurf']);

// GigaBrain idea #5: facts a human typed into the git wiki round-trip under
// this host. It is OURS-stamped at reconcile time (never attacker-supplied free
// text), so it carries the top `human` tier deliberately.
const HUMAN = new Set(['human_wiki']);

// Cloud products that only arrive via explicit manual paste/import.
const CLOUD = new Set([
  'chatgpt', 'chatgpt_manual', 'gemini', 'gemini_manual', 'copilot',
  'copilot_manual', 'claude_ai', 'claude_manual', 'openai', 'gpt',
]);

const TRUST = Object.freeze({
  // GigaBrain idea #5 (git-versioned LLM-wiki). A fact a HUMAN typed into the
  // git wiki (a commit NOT authored by GigaBrain) is the most-deliberate
  // correction surface there is: the operator looked at the projected belief
  // and rewrote it by hand. It sits strictly ABOVE every agent tier
  // (own_agent 0.74) so a human wiki correction WINS arbitration over an agent
  // fact of the same claim slot — the steer surface overrides the machine.
  // Stays under the 0.85 ingest cap so it remains a sane confidence, not a veto.
  human: 0.85,
  own_agent: 0.74, // preserves prior default for first-party native memory
  workspace: 0.6,
  manual_import: 0.5,
  unknown: 0.4, // was silently 0.74 before — the actual poisoning hole
  // GigaBrain idea #1 (transcript CDC harvester). Facts mined from RAW session
  // rollouts (~/.codex/sessions, ~/.claude/projects) are the LEAST-deliberate
  // capture surface: the user never chose to write them down, and a heuristic
  // salience filter + a local LLM guessed they were durable. They sit BELOW
  // every deliberately-authored memory so a transcript fact can NEVER win a
  // claim slot against a real memory of the same slot on recency alone.
  transcript: 0.32,
});

const norm = (host) => String(host || '').trim().toLowerCase();

const classifyHostTier = (host) => {
  const h = norm(host);
  if (!h) return 'unknown';
  // idea #5: a human wiki edit is the top tier, checked first so it can never
  // be down-classed by a substring rule below.
  if (HUMAN.has(h)) return 'human';
  // Manual/cloud first, so e.g. `cursor_manual` is treated as a manual import.
  if (h.includes('manual') || CLOUD.has(h)) return 'manual_import';
  if (WORKSPACE.has(h)) return 'workspace';
  if (OWN_AGENT.has(h)) return 'own_agent';
  // Runtime/legacy variants of a first-party host keep first-party trust.
  for (const base of OWN_AGENT) {
    if (h === base || h.startsWith(`${base}_`)) return 'own_agent';
  }
  return 'unknown';
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// U13 identity registry (R10): `source_agent` is free text in rival stores and
// therefore a sock-puppet vector — an invented agent name must not carry host
// trust into corroboration or tier comparisons. Registration is EXACT-name
// membership only: the host prefix rule above ("codex_fake9000" → own_agent)
// classifies HOSTS we stamped ourselves and must not vouch for agent identity.
// Seeded from the built-in host families plus config: `config.agentRegistry`
// (explicit operator list) and the ARBITRATION host-trust pins (a pinned
// identity is a registered identity). 'main' is the first-party runtime's
// default agent id.
const REGISTERED_AGENT_BASE = new Set([...OWN_AGENT, ...WORKSPACE, ...CLOUD, ...HUMAN, 'main']);

const isPlainObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));

// Pick a host-trust override map with migration precedence: the explicit
// (canonical) map when it is a NON-EMPTY object, else the legacy map. Applied
// identically at every read site (resolver, arbiter, adaptive) so behavior is
// the same whether a caller passes a fully resolved config (canonical
// populated) or a raw/legacy-shaped one. The non-empty test matters: a resolved
// config always carries an EMPTY canonical default (`trust.arbitrationHostTrust
// = {}`), and a caller may spread that and then add a legacy `hostTrust` pin on
// top — the empty canonical must not shadow that pin.
const pickHostTrustMap = (canonical, legacy) => {
  if (isPlainObject(canonical) && Object.keys(canonical).length > 0) return canonical;
  return isPlainObject(legacy) ? legacy : {};
};

// The ARBITRATION host-trust override map: canonical `config.trust
// .arbitrationHostTrust` first, legacy top-level `config.hostTrust` as fallback.
const arbitrationTrustOverrides = (config) => (
  config && typeof config === 'object'
    ? pickHostTrustMap(config?.trust?.arbitrationHostTrust, config.hostTrust)
    : {}
);

const isRegisteredAgent = (agent, config = {}) => {
  const a = norm(agent);
  if (!a) return false;
  if (REGISTERED_AGENT_BASE.has(a)) return true;
  const overrides = arbitrationTrustOverrides(config);
  if (Object.prototype.hasOwnProperty.call(overrides, a)) return true;
  const registry = Array.isArray(config?.agentRegistry) ? config.agentRegistry : [];
  return registry.some((entry) => norm(entry) === a);
};

// Trust score in [0,1]. The arbitration host-trust pins (`config.trust
// .arbitrationHostTrust[host]`, legacy `config.hostTrust[host]`) override the
// tiered default, so an operator can pin a specific host without code changes.
const hostTrustScore = (host, config = {}) => {
  const h = norm(host);
  const overrides = arbitrationTrustOverrides(config);
  if (h && Object.prototype.hasOwnProperty.call(overrides, h)) {
    const v = Number(overrides[h]);
    if (Number.isFinite(v)) return clamp01(v);
  }
  return TRUST[classifyHostTier(h)];
};

// Confidence stamped at ingest. `source_kind` nudges within the host band:
// a manual_import is the least trustworthy kind regardless of which host it
// claims to come from. Floored/capped to keep the value a sane confidence.
const ingestConfidence = (sourceHost, sourceKind, config = {}) => {
  let conf = hostTrustScore(sourceHost, config);
  if (norm(sourceKind) === 'manual_import') conf = Math.min(conf, TRUST.manual_import);
  // idea #1: a raw-transcript fact (source_kind=chat_history_hint) is capped at
  // the transcript FLOOR regardless of which first-party host produced the
  // rollout, so it cannot ride codex/claude_code own-agent trust (0.74) up past
  // a deliberate memory. The 0.3 hard floor below still applies, and the
  // transcript tier (0.32) deliberately clears it by a hair.
  if (norm(sourceKind) === 'chat_history_hint') conf = Math.min(conf, TRUST.transcript);
  return Math.max(0.3, Math.min(0.85, conf));
};

export {
  classifyHostTier,
  hostTrustScore,
  ingestConfidence,
  isRegisteredAgent,
  pickHostTrustMap,
  arbitrationTrustOverrides,
  TRUST,
  OWN_AGENT,
  WORKSPACE,
  CLOUD,
  HUMAN,
};

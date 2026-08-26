const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4_000;
const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MEMORY_FLUSH_RESERVE_TOKENS_FLOOR = 20_000;

const normalizeNonNegativeInteger = (value, fallback) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
};

const resolveTimezone = (config = {}, params = {}) => {
  const timezone = String(
    params.timezone
    || config?.runtime?.timezone
    || config?.agents?.defaults?.userTimezone
    || "UTC",
  ).trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    return "UTC";
  }
};

const dateStamp = (nowMs, timezone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(nowMs));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

const resolveGigabrainFlushPlan = (config = {}, params = {}) => {
  const hostConfig = params?.cfg || config;
  const settings = hostConfig?.agents?.defaults?.compaction?.memoryFlush || {};
  if (settings.enabled === false) return null;
  const nowMs = Number.isFinite(Number(params.nowMs)) ? Number(params.nowMs) : Date.now();
  const timezone = resolveTimezone(config, params);
  const date = dateStamp(nowMs, timezone);
  const relativePath = `memory/${date}.md`;
  const typedGuidance = [
    "Capture only reviewed durable facts as typed metadata-bearing notes:",
    '<memory_note type="USER_FACT|PREFERENCE|DECISION|ENTITY|EPISODE|AGENT_IDENTITY|CONTEXT" confidence="0.0-1.0">fact</memory_note>.',
    `Store them only in ${relativePath}.`,
    `If ${relativePath} exists, append new bullet blocks only.`,
    "Do not overwrite, edit, replace, truncate, rename, or delete any existing memory or workspace file.",
    "Do not create timestamped variants; use the canonical dated file.",
    "Use only the host's append-only memory-flush write mechanism; all other tools are read-only for this turn.",
    "If there is nothing durable to store, reply NO_REPLY.",
  ].join(" ");
  return {
    softThresholdTokens: normalizeNonNegativeInteger(
      settings.softThresholdTokens,
      DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
    ),
    forceFlushTranscriptBytes: normalizeNonNegativeInteger(
      settings.forceFlushTranscriptBytes,
      DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
    ),
    reserveTokensFloor: normalizeNonNegativeInteger(
      hostConfig?.agents?.defaults?.compaction?.reserveTokensFloor,
      DEFAULT_MEMORY_FLUSH_RESERVE_TOKENS_FLOOR,
    ),
    model: String(settings.model || "").trim() || undefined,
    prompt: typedGuidance,
    systemPrompt: `Pre-compaction append-only memory flush. ${typedGuidance}`,
    relativePath,
  };
};

export {
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_RESERVE_TOKENS_FLOOR,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  resolveGigabrainFlushPlan,
};

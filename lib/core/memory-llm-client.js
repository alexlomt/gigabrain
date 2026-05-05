const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

const clamp01 = (value, fallback = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
};

const clampInt = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
};

const normalizeProvider = (provider) => {
  const key = String(provider || '').trim().toLowerCase();
  if (['openai_compatible', 'ollama', 'none'].includes(key)) return key;
  // Intentionally do not support `openclaw` here: the memory maintenance LLM
  // client must stay stateless and must not recurse through the OpenClaw
  // session pipeline.
  return 'none';
};

const normalizeHostname = (value = '') => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1);
  return raw;
};

const isLoopbackHost = (value = '') => {
  const host = normalizeHostname(value);
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
};

const isOpenClawGatewayCompletionBaseUrl = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (!isLoopbackHost(parsed.hostname)) return false;
    if (String(parsed.port || '') !== '18789') return false;
    const normalizedPath = String(parsed.pathname || '').replace(/\/+$/, '');
    return normalizedPath === '/v1' || normalizedPath === '/v1/chat/completions';
  } catch {
    return false;
  }
};

const rejectOpenClawMaintenanceFallback = ({ provider = '', baseUrl = '', task = 'memory_maintenance' } = {}) => {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (normalizedProvider === 'openclaw' || isOpenClawGatewayCompletionBaseUrl(baseUrl)) {
    throw new Error(`${task}_requires_stateless_memory_llm`);
  }
};

const resolveMemoryLlmConfig = (config = {}) => {
  const raw = config?.memoryLlm && typeof config.memoryLlm === 'object'
    ? config.memoryLlm
    : {};
  const provider = normalizeProvider(raw.provider || 'none');
  const baseUrl = String(raw.baseUrl || (provider === 'openai_compatible' ? DEFAULT_BASE_URL : '')).trim();
  const model = String(raw.model || DEFAULT_MODEL).trim();
  const apiKeyEnv = String(raw.apiKeyEnv || 'GIGABRAIN_MEMORY_LLM_API_KEY').trim();
  const apiKey = String(
    raw.apiKey
    || (apiKeyEnv ? process.env[apiKeyEnv] : '')
    // Transitional compatibility: existing deployments may already have a
    // Gemini/OpenAI-compatible key for recall embeddings. Reuse it rather than
    // duplicating secrets in config. New deployments should prefer apiKeyEnv.
    || config?.recall?.embeddingApiKey
    || '',
  ).trim();
  return {
    enabled: raw.enabled === true && provider !== 'none',
    provider,
    baseUrl,
    model,
    apiKey,
    apiKeyEnv,
    timeoutMs: clampInt(raw.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS),
    maxRetries: clampInt(raw.maxRetries, 0, 5, 1),
  };
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const isRetryableMemoryLlmError = (value) => {
  const text = String(value || '').toLowerCase();
  return text.includes('http=429')
    || text.includes('http=500')
    || text.includes('http=502')
    || text.includes('http=503')
    || text.includes('http=504')
    || text.includes('timeout')
    || text.includes('fetch failed')
    || text.includes('abort');
};

const buildOpenAiCompatiblePayload = ({ prompt, profile = {}, memoryConfig = {} }) => ({
  model: String(memoryConfig.model || profile.model || DEFAULT_MODEL),
  messages: [
    { role: 'system', content: 'Return compact JSON only. No markdown.' },
    { role: 'user', content: prompt },
  ],
  temperature: clamp01(profile.temperature ?? 0.1, 0.1),
  top_p: clamp01(profile.top_p ?? 0.75, 0.75),
  max_tokens: clampInt(profile.max_tokens, 32, 8192, 512),
});

const completeOpenAiCompatibleJson = async ({ prompt, profile, memoryConfig }) => {
  const endpoint = `${String(memoryConfig.baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('memory_llm invalid baseUrl');
  if (!memoryConfig.apiKey) {
    const envName = String(memoryConfig.apiKeyEnv || 'GIGABRAIN_MEMORY_LLM_API_KEY').trim();
    throw new Error(`memory_llm_missing_api_key:${envName}`);
  }
  const headers = { 'Content-Type': 'application/json' };
  headers.Authorization = `Bearer ${memoryConfig.apiKey}`;
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildOpenAiCompatiblePayload({ prompt, profile, memoryConfig })),
  }, memoryConfig.timeoutMs);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`memory_llm http=${res.status}${body ? ` ${body.slice(0, 180)}` : ''}`);
  }
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
};

const completeOllamaJson = async ({ prompt, profile, memoryConfig, jsonSchema }) => {
  const endpoint = `${String(memoryConfig.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/generate`;
  const format = jsonSchema && typeof jsonSchema === 'object' ? jsonSchema : 'json';
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: String(memoryConfig.model || profile?.model || 'qwen3.5:9b'),
      prompt,
      format,
      stream: false,
      options: {
        temperature: clamp01(profile?.temperature ?? 0.1, 0.1),
        top_p: clamp01(profile?.top_p ?? 0.75, 0.75),
        top_k: clampInt(profile?.top_k, 1, 200, 20),
        num_predict: clampInt(profile?.max_tokens, 32, 8192, 512),
      },
    }),
  }, memoryConfig.timeoutMs);
  if (!res.ok) throw new Error(`memory_llm ollama http=${res.status}`);
  const data = await res.json();
  return String(data?.response ?? '').trim();
};

const completeMemoryJson = async ({ config = {}, prompt, profile = {}, jsonSchema } = {}) => {
  const memoryConfig = resolveMemoryLlmConfig(config);
  if (!memoryConfig.enabled) {
    throw new Error('memory_llm_disabled');
  }
  let lastError = null;
  for (let attempt = 0; attempt <= memoryConfig.maxRetries; attempt += 1) {
    try {
      if (memoryConfig.provider === 'openai_compatible') {
        return await completeOpenAiCompatibleJson({ prompt, profile, memoryConfig });
      }
      if (memoryConfig.provider === 'ollama') {
        return await completeOllamaJson({ prompt, profile, memoryConfig, jsonSchema });
      }
      throw new Error(`memory_llm unsupported_provider:${memoryConfig.provider}`);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryableMemoryLlmError(message) || attempt >= memoryConfig.maxRetries) break;
      await sleep(750 * (attempt + 1));
    }
  }
  throw lastError || new Error('memory_llm_failed');
};

export {
  completeMemoryJson,
  isOpenClawGatewayCompletionBaseUrl,
  isRetryableMemoryLlmError,
  rejectOpenClawMaintenanceFallback,
  resolveMemoryLlmConfig,
};

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MODEL = 'qwen3.5:9b';
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

const clamp01 = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
};

const clampInt = (value, min, max, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(min, Math.min(max, Math.round(numeric)))
    : fallback;
};

const normalizeHostname = (value = '') => {
  const hostname = String(value || '').trim().toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
};

const isLoopbackHost = (value = '') => ['127.0.0.1', 'localhost', '::1'].includes(
  normalizeHostname(value),
);

const isOpenClawGatewayCompletionBaseUrl = (value = '') => {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackHost(parsed.hostname)) return false;
    if (String(parsed.port || '') !== '18789') return false;
    const pathname = String(parsed.pathname || '').replace(/\/+$/, '');
    return pathname === '/v1' || pathname === '/v1/chat/completions';
  } catch {
    return false;
  }
};

const normalizeOllamaBaseUrl = (value = DEFAULT_BASE_URL) => {
  let parsed;
  try {
    parsed = new URL(String(value || DEFAULT_BASE_URL).trim());
  } catch {
    throw new Error('MEMORY_LLM_LOOPBACK_REQUIRED');
  }
  if (isOpenClawGatewayCompletionBaseUrl(parsed.href) || String(parsed.port || '') === '18789') {
    throw new Error('MEMORY_LLM_OPENCLAW_RECURSION_REJECTED');
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) {
    throw new Error('MEMORY_LLM_LOOPBACK_REQUIRED');
  }
  if (!['', '/'].includes(String(parsed.pathname || '')) || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('MEMORY_LLM_LOOPBACK_REQUIRED');
  }
  return parsed.href.replace(/\/+$/, '');
};

const resolveMemoryLlmConfig = (config = {}) => {
  const raw = config?.memoryLlm && typeof config.memoryLlm === 'object'
    ? config.memoryLlm
    : {};
  const enabled = raw.enabled === true;
  const provider = String(raw.provider || 'none').trim().toLowerCase();
  if (!enabled || provider === 'none') {
    return Object.freeze({
      baseUrl: '',
      enabled: false,
      maxRetries: clampInt(raw.maxRetries, 0, 5, 1),
      model: '',
      provider: 'none',
      timeoutMs: clampInt(raw.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS),
    });
  }
  if (provider !== 'ollama') throw new Error('MEMORY_LLM_PROVIDER_REJECTED');
  const model = String(raw.model || DEFAULT_MODEL).trim();
  if (!model || /[\r\n\0]/.test(model)) throw new Error('MEMORY_LLM_MODEL_INVALID');
  return Object.freeze({
    baseUrl: normalizeOllamaBaseUrl(raw.baseUrl || DEFAULT_BASE_URL),
    enabled: true,
    maxRetries: clampInt(raw.maxRetries, 0, 5, 1),
    model,
    provider: 'ollama',
    timeoutMs: clampInt(raw.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS),
  });
};

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const retryableStatus = (status) => status === 429 || (status >= 500 && status <= 599);
const retryableError = (error) => {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return error?.name === 'AbortError'
    || /econn|enet|socket|fetch failed|network|timeout|abort/.test(`${code} ${message}`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const completeMemoryJson = async ({ config = {}, prompt = '', profile = {}, jsonSchema } = {}) => {
  const memoryConfig = resolveMemoryLlmConfig(config);
  if (!memoryConfig.enabled) throw new Error('memory_llm_disabled');
  const endpoint = `${memoryConfig.baseUrl}/api/generate`;
  let lastError;
  for (let attempt = 0; attempt <= memoryConfig.maxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        body: JSON.stringify({
          format: jsonSchema && typeof jsonSchema === 'object' ? jsonSchema : 'json',
          model: memoryConfig.model,
          options: {
            num_predict: clampInt(profile?.max_tokens, 32, 8192, 512),
            temperature: clamp01(profile?.temperature, 0.1),
            top_k: clampInt(profile?.top_k, 1, 200, 20),
            top_p: clamp01(profile?.top_p, 0.8),
          },
          prompt: String(prompt || ''),
          stream: false,
          think: false,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }, memoryConfig.timeoutMs);
      if (!response.ok) {
        const error = new Error(`memory_llm_ollama_http_${response.status}`);
        error.retryable = retryableStatus(response.status);
        throw error;
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error('memory_llm_ollama_response_invalid');
      }
      if (typeof payload?.response !== 'string') throw new Error('memory_llm_ollama_response_invalid');
      return payload.response.trim();
    } catch (error) {
      lastError = error;
      const shouldRetry = error?.retryable === true || retryableError(error);
      if (!shouldRetry || attempt >= memoryConfig.maxRetries) break;
      await wait(100 * (attempt + 1));
    }
  }
  throw lastError || new Error('memory_llm_failed');
};

export {
  completeMemoryJson,
  isOpenClawGatewayCompletionBaseUrl,
  resolveMemoryLlmConfig,
};

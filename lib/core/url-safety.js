const trimTrailingSlashes = (value = '') => {
  const text = String(value || '');
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end -= 1;
  return text.slice(0, end);
};

const normalizeHostname = (value = '') => {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
};

const isLoopbackHostname = (value = '') => {
  const hostname = normalizeHostname(value);
  if (hostname === 'localhost' || hostname === '::1') return true;
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => {
    if (!part || part.length > 3) return false;
    for (const char of part) {
      const code = char.charCodeAt(0);
      if (code < 48 || code > 57) return false;
    }
    const number = Number(part);
    return Number.isInteger(number) && number >= 0 && number <= 255;
  });
};

const buildHttpEndpoint = (baseUrl, endpointPath, { localOnly = false, label = 'endpoint' } = {}) => {
  const rawBase = String(baseUrl || '').trim();
  const suffix = String(endpointPath || '');
  if (!rawBase) throw new Error(`${label} base URL is required`);
  if (!suffix.startsWith('/') || suffix.startsWith('//')) {
    throw new Error(`${label} path must be an absolute single-origin path`);
  }

  let target;
  try {
    target = new URL(rawBase);
  } catch {
    throw new Error(`${label} base URL is invalid`);
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
  if (target.username || target.password || target.search || target.hash) {
    throw new Error(`${label} base URL must not contain credentials, query parameters, or a fragment`);
  }
  const loopback = isLoopbackHostname(target.hostname);
  if (localOnly && !loopback) throw new Error(`${label} must use a loopback host`);
  if (target.protocol === 'http:' && !loopback) {
    throw new Error(`${label} must use https unless it targets loopback`);
  }

  const basePath = trimTrailingSlashes(target.pathname);
  target.pathname = `${basePath}${suffix}`;
  target.search = '';
  target.hash = '';
  return target;
};

export {
  buildHttpEndpoint,
  isLoopbackHostname,
  normalizeHostname,
  trimTrailingSlashes,
};

import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { listContradictions } from './world-model.js';
import { readRegularFileWithStatNoFollowSync } from './safe-fs.js';
import { buildHttpEndpoint, isLoopbackHostname } from './url-safety.js';

// ---------------------------------------------------------------------------
// C2 (narrowest slice) — governed vault write-back: a findings INBOX note.
//
// GigaBrain appends dated finding digests (open contradiction groups, with
// provenance) to ONE GigaBrain-owned note in the operator's vault via the
// Obsidian Local REST API. Deliberately bounded:
//  - PROPOSALS-ONLY: append-only (HTTP POST = append) to the single configured
//    inbox note. Existing human notes are NEVER touched, nothing is ever
//    edited or deleted, and the vault stays the human-authored layer
//    (neutrality invariant — this is not agent write-back into a rival store).
//  - DISABLED BY DEFAULT (`vault.inbox.enabled: false`), CLI-triggered only
//    (`gigabrainctl vault inbox`); no nightly wiring until the slice has
//    demonstrated precision.
//  - Local-first: talks only to the loopback REST API. TLS verification stays
//    enabled; self-signed deployments provide their certificate via `caPath`.
// ---------------------------------------------------------------------------

const VAULT_INBOX_DEFAULTS = Object.freeze({
  enabled: false,
  apiUrl: 'https://127.0.0.1:27124',
  notePath: 'GigaBrain/Findings.md',
  apiKey: '',
  apiKeyPath: '',
  caPath: '',
  maxFindings: 20,
});

const expandHome = (value = '') => {
  const raw = String(value || '').trim();
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
};

const resolveVaultInboxSettings = (config = {}) => {
  const raw = config?.vault?.inbox;
  const merged = { ...VAULT_INBOX_DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(VAULT_INBOX_DEFAULTS)) {
      if (raw[key] === undefined) continue;
      if (key === 'enabled') merged.enabled = raw.enabled === true;
      else if (key === 'maxFindings') {
        const n = Number(raw.maxFindings);
        if (Number.isFinite(n)) merged.maxFindings = Math.max(1, Math.min(100, Math.trunc(n)));
      } else merged[key] = String(raw[key]);
    }
  }
  return Object.freeze(merged);
};

const resolveApiKey = (settings) => {
  if (settings.apiKey) return settings.apiKey;
  if (settings.apiKeyPath) {
    try {
      return String(readRegularFileWithStatNoFollowSync(
        expandHome(settings.apiKeyPath),
        'utf8',
        { maxBytes: 16_384 },
      ).data).trim();
    } catch {
      return '';
    }
  }
  return '';
};

const resolveTlsCa = (settings) => {
  if (!settings.caPath) return undefined;
  const value = readRegularFileWithStatNoFollowSync(
    expandHome(settings.caPath),
    null,
    { maxBytes: 1024 * 1024 },
  ).data;
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new Error('vault.inbox.caPath must contain a non-empty certificate no larger than 1 MB');
  }
  return value;
};

const buildVaultInboxUrl = (settings) => {
  const notePath = String(settings.notePath || '').trim();
  if (!notePath || notePath.length > 512 || notePath.startsWith('/') || /[\0-\x1f\x7f]/u.test(notePath)) {
    throw new Error('vault.inbox.notePath must be a bounded relative note path');
  }
  const segments = notePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('vault.inbox.notePath contains an invalid path segment');
  }
  const suffix = `/vault/${segments.map(encodeURIComponent).join('/')}`;
  const target = buildHttpEndpoint(settings.apiUrl, suffix, {
    localOnly: true,
    label: 'vault inbox endpoint',
  });
  if (target.protocol !== 'https:' || !isLoopbackHostname(target.hostname)) {
    throw new Error('vault.inbox.apiUrl must use HTTPS on a loopback host');
  }
  return target;
};

// Dated digest of what the arbiter currently wants a human to look at.
// Contradiction groups only for this slice — they are the product's core
// finding and each carries its source memory ids as provenance.
const buildFindingsDigest = ({ db, config, now = new Date().toISOString() } = {}) => {
  if (!db) throw new Error('buildFindingsDigest requires db');
  const settings = resolveVaultInboxSettings(config);
  const contradictions = listContradictions(db, { limit: settings.maxFindings });
  const lines = [];
  lines.push(`## GigaBrain findings — ${now}`);
  lines.push('');
  if (contradictions.length === 0) {
    lines.push('No open contradiction groups.');
  } else {
    lines.push(`${contradictions.length} open contradiction group(s):`);
    lines.push('');
    for (const item of contradictions) {
      const title = String(item.title || item.loop_id || 'contradiction');
      const sources = Array.isArray(item.source_memory_ids) ? item.source_memory_ids : [];
      lines.push(`- **${title}** (priority ${Number(item.priority ?? 0).toFixed(2)})`);
      lines.push(`  - sources: ${sources.slice(0, 6).map((id) => `\`${id}\``).join(', ')}${sources.length > 6 ? ` +${sources.length - 6} more` : ''}`);
    }
  }
  lines.push('');
  return { markdown: `${lines.join('\n')}\n`, finding_count: contradictions.length };
};

// Append via the Local REST API: POST /vault/<path> appends to the note
// (creating it if missing). Transport is injectable so tests never need a
// running Obsidian.
const defaultTransport = ({ url, apiKey, body, ca }) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const request = https.request({
    method: 'POST',
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'text/markdown',
      'Content-Length': Buffer.byteLength(body),
    },
    ...(ca ? { ca } : {}),
    timeout: 10000,
  }, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: data }));
  });
  request.on('error', reject);
  request.on('timeout', () => request.destroy(new Error('vault inbox request timed out')));
  request.write(body);
  request.end();
});

const proposeToVaultInbox = async ({ db, config, now = new Date().toISOString(), dryRun = false, transport = defaultTransport } = {}) => {
  const settings = resolveVaultInboxSettings(config);
  if (settings.enabled !== true) {
    return { ok: true, enabled: false, skipped: 'vault.inbox.enabled is false (default)' };
  }
  const digest = buildFindingsDigest({ db, config, now });
  const result = {
    ok: true,
    enabled: true,
    dry_run: dryRun === true,
    note_path: settings.notePath,
    finding_count: digest.finding_count,
    markdown: digest.markdown,
  };
  if (dryRun) return result;
  const apiKey = resolveApiKey(settings);
  if (!apiKey) {
    return { ...result, ok: false, error: 'no API key: set vault.inbox.apiKey or vault.inbox.apiKeyPath' };
  }
  let url;
  let ca;
  try {
    url = buildVaultInboxUrl(settings).toString();
    ca = resolveTlsCa(settings);
  } catch (error) {
    return { ...result, ok: false, error: String(error?.message || error).slice(0, 200) };
  }
  const response = await transport({ url, apiKey, body: digest.markdown, ca });
  const accepted = Number(response.status) >= 200 && Number(response.status) < 300;
  return { ...result, ok: accepted, status: response.status, ...(accepted ? {} : { error: String(response.body || '').slice(0, 200) }) };
};

export {
  VAULT_INBOX_DEFAULTS,
  resolveVaultInboxSettings,
  buildFindingsDigest,
  proposeToVaultInbox,
};

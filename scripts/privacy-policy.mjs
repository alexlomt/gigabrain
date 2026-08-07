import { createHash } from 'node:crypto';
import net from 'node:net';

// Public defaults are intentionally empty. The private release workspace can
// inject one-way identifiers from a source-only module, while public tests add
// only synthetic values. This keeps even guessable hashes of private names out
// of the public package.
export const BANNED_IDENTIFIER_HASHES = new Set([
]);
// Exact normalized token hashes use a separate injected set so short
// identifiers can be checked without substring false positives.
export const BANNED_TOKEN_HASHES = new Set([
]);

const IDENTIFIER_LENGTHS = [7, 8, 9, 10, 11, 13, 14, 15];
const MAX_IDENTIFIER_LENGTH = Math.max(...IDENTIFIER_LENGTHS);
const MAX_EXHAUSTIVE_HASH_BYTES = 512 * 1024;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;
const ALLOWED_EMAIL_DOMAINS = new Set([
  'example.com', 'example.net', 'example.org', 'example.test',
  'noreply.github.com', 'users.noreply.github.com',
]);
const CONTACT_ID_RE = /\b(?:telegram|chat[_ ]?id|chatid)\b[^\n]{0,40}?\b\d{8,12}\b/giu;
const PHONE_NEAR_LABEL_RE = /\b(?:phone(?:\s+number)?|mobile(?:\s+number)?|telephone(?:\s+number)?|telefon(?:nummer)?|handy(?:nummer)?)\b["']?\s*[:=]\s*["']?\s*\+?\d[\d .()/-]{7,}\d/giu;
const DEVICE_ID_RE = /\b(?:device[_ -]?id|hardware[_ -]?id|serial(?:\s+number)?)\b[^\n]{0,32}?\b(?:0x)?[0-9a-f]{8,}\b/giu;
const SYNTHETIC_ID_RE = /^(?:1000000000|1234567890|123456789|0{8,12}|1{8,12}|5{8,12}|9{8,12})$/u;
const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{30,}\b/gu,
  /\bgh[pousr]_[0-9A-Za-z]{24,}\b/gu,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  /\bsk-[0-9A-Za-z_-]{20,}\b/gu,
];
const HOME_PATH_PATTERNS = [
  /(?:^|[\s"'=(])\/(?:Users|home)\/[^\s/"'<>]+\//gmu,
  /(?:^|[\s"'=(])\/root\//gmu,
  /\b[A-Za-z]:[\\/]Users[\\/][^\s\\/"'<>]+[\\/]/gmu,
];
const BINARY_MAGIC_HEX = [
  '255044462d', '504b0304', '1f8b08', '425a68', 'fd377a585a00',
  '377abcaf271c', '526172211a07', '89504e470d0a1a0a', 'ffd8ff',
  '474946383761', '474946383961', '7f454c46', '0061736d',
  '53514c69746520666f726d6174203300',
];

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalizeIdentifier = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/gu, '');

const candidateHasBannedIdentifier = (candidate, bannedIdentifierHashes = BANNED_IDENTIFIER_HASHES) => {
  if (!candidate) return false;
  for (const length of IDENTIFIER_LENGTHS) {
    if (candidate.length < length) continue;
    for (let index = 0; index + length <= candidate.length; index += 1) {
      if (bannedIdentifierHashes.has(sha256(candidate.slice(index, index + length)))) return true;
    }
  }
  return false;
};

const hasBannedIdentifier = (
  raw,
  exhaustive = true,
  bannedIdentifierHashes = BANNED_IDENTIFIER_HASHES,
) => {
  if (exhaustive) return candidateHasBannedIdentifier(normalizeIdentifier(raw), bannedIdentifierHashes);
  let previousSuffix = '';
  for (const line of String(raw).split('\n')) {
    const tokens = line.toLowerCase().match(/[a-z0-9]+/gu) || [];
    const useful = tokens.filter((token) => !/^[0-9a-f]{32,}$/iu.test(token));
    const prefix = useful.join('').slice(0, MAX_IDENTIFIER_LENGTH);
    if (previousSuffix && prefix
      && candidateHasBannedIdentifier(previousSuffix + prefix, bannedIdentifierHashes)) return true;
    for (let index = 0; index < useful.length; index += 1) {
      let joined = '';
      for (let cursor = index; cursor < useful.length; cursor += 1) {
        joined += useful[cursor];
        if (joined.length > MAX_IDENTIFIER_LENGTH) break;
        if (candidateHasBannedIdentifier(joined, bannedIdentifierHashes)) return true;
      }
    }
    previousSuffix = useful.join('').slice(-MAX_IDENTIFIER_LENGTH);
  }
  return false;
};

const hasBannedToken = (raw, bannedTokenHashes = BANNED_TOKEN_HASHES) => {
  const tokens = String(raw || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.some((token) => bannedTokenHashes.has(sha256(normalizeIdentifier(token))));
};

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const isAllowedEmailDomain = (domain) => {
  const normalized = String(domain || '').toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.has(normalized) || normalized.endsWith('.example');
};
const isAllowedIpv4 = (value) => {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return value === '0.0.0.0' || value === '127.0.0.1'
    || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
};

export const decodeStrictText = (bytes) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const prefix = buffer.subarray(0, 16).toString('hex');
  if (BINARY_MAGIC_HEX.some((magic) => prefix.startsWith(magic)) || buffer.includes(0)) return null;
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; }
  let controls = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 32 && ![9, 10, 13].includes(code)) controls += 1;
  }
  return controls > Math.max(2, value.length * 0.005) ? null : value;
};

export const scanText = ({
  text,
  location,
  byteLength = Buffer.byteLength(String(text || '')),
  reviewedSecretFixtures = new Set(),
  bannedIdentifierHashes = BANNED_IDENTIFIER_HASHES,
  bannedTokenHashes = BANNED_TOKEN_HASHES,
  strictPublicPaths = false,
  publicIpv4 = false,
}) => {
  const raw = String(text || '');
  const findings = [];
  const add = (kind, line = undefined) => findings.push({ kind, location, ...(line ? { line } : {}) });
  if (hasBannedIdentifier(raw, byteLength <= MAX_EXHAUSTIVE_HASH_BYTES, bannedIdentifierHashes)
      || hasBannedToken(raw, bannedTokenHashes)) {
    add('banned-identifier');
  }
  EMAIL_RE.lastIndex = 0;
  for (const match of raw.matchAll(EMAIL_RE)) {
    if (!isAllowedEmailDomain(match[1])) add('personal-email', lineAt(raw, match.index || 0));
  }
  CONTACT_ID_RE.lastIndex = 0;
  for (const match of raw.matchAll(CONTACT_ID_RE)) {
    const numeric = String(match[0]).match(/\b\d{8,12}\b/u)?.[0] || '';
    if (numeric && !SYNTHETIC_ID_RE.test(numeric)) add('contact-id', lineAt(raw, match.index || 0));
  }
  PHONE_NEAR_LABEL_RE.lastIndex = 0;
  for (const match of raw.matchAll(PHONE_NEAR_LABEL_RE)) add('phone-number', lineAt(raw, match.index || 0));
  DEVICE_ID_RE.lastIndex = 0;
  for (const match of raw.matchAll(DEVICE_ID_RE)) add('device-identifier', lineAt(raw, match.index || 0));
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      if (!reviewedSecretFixtures.has(`${location}:${sha256(match[0])}`)) {
        add('secret-like-credential', lineAt(raw, match.index || 0));
      }
    }
  }
  if (strictPublicPaths) {
    for (const pattern of HOME_PATH_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of raw.matchAll(pattern)) add('absolute-home-path', lineAt(raw, match.index || 0));
    }
  }
  if (publicIpv4) {
    const ipv4Re = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
    for (const match of raw.matchAll(ipv4Re)) {
      if (net.isIP(match[0]) === 4 && !isAllowedIpv4(match[0])) add('non-documentation-ipv4-address', lineAt(raw, match.index || 0));
    }
  }
  return findings;
};

export const formatFinding = (finding) => (
  `${finding.location}${finding.line ? `:${finding.line}` : ''}  ${finding.kind} (redacted)`
);

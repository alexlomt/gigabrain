#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readRegularFileNoFollowSync } from '../lib/core/safe-fs.js';
import { parseNpmPackReports } from './npm-pack-inventory.mjs';

const MANIFEST_SCHEMA_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const ALLOWED_RUNTIME_IGNORES = new Set([
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/__pycache__/**',
  '**/*.pyc',
  '.venv/**',
  'node_modules/**',
]);
const ALLOWED_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.net',
  'example.org',
  'noreply.github.com',
  'users.noreply.github.com',
]);
const ALLOWED_HISTORY_EMAIL_DOMAINS = new Set([
  'noreply.github.com',
  'users.noreply.github.com',
]);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'repository',
  'npm',
  'benchmarkEvidence',
  'transforms',
]);
const REPOSITORY_KEYS = new Set([
  'files',
  'requiredFiles',
  'runtimeIgnores',
  'binaryFiles',
  'contentExceptions',
]);
const NPM_KEYS = new Set(['packageName', 'packageFiles', 'files']);
const TRANSFORM_KEYS = new Set(['packageJson']);
const PACKAGE_JSON_TRANSFORM_KEYS = new Set(['omitScripts', 'setScripts']);
const EVIDENCE_KEYS = new Set(['path', 'schema', 'sha256']);
const HASHED_PATH_KEYS = new Set(['path', 'sha256']);
const CONTENT_EXCEPTION_KEYS = new Set(['path', 'sha256', 'classes']);
const CONTENT_CLASSES = new Set(['ABSOLUTE_HOME_PATH', 'EMAIL', 'SECRET']);
const PRIVATE_SEGMENTS = new Set([
  'answer',
  'answers',
  'dataset',
  'datasets',
  'gold',
  'judgment',
  'judgments',
  'output',
  'outputs',
  'raw-export',
  'raw-exports',
  'raw_export',
  'raw_exports',
  'task',
  'tasks',
]);
const PRIVATE_DATA_NAME_RE = /(?:^|[-_.])(answers?|datasets?|gold|judgments?|questions?|raw[-_]?exports?)(?:[-_.]|$)/iu;
const FROZEN_CONTRACT_RE = /(?:^|\/)(?:bench|eval)\/.*(?:contract|model|split[-_]?manifest).*\.(?:json|jsonl|yaml|yml)$/iu;
const RAW_BENCHMARK_RE = /(?:^|\/)(?:bench|eval)\/.*\.(?:jsonl|log|ndjson)$/iu;
const PRIVATE_PREFIXES = [
  'config/',
  'data/',
  'docs/audits/',
  'docs/brainstorms/',
  'docs/ideation/',
  'docs/plans/',
  'output/',
  'outputs/',
  'tasks/',
];
const PRIVATE_PATH_PATTERNS = [
  /^bench\/[^/]+\/results\//u,
  /^docs\/benchmarks\/frontier-(?:checkpoint|cloud-protocol|results)/u,
  /^eval\/(?:results\/|.*(?:baseline|cases?|fixture).*\.(?:json|jsonl|log)$)/u,
  /^release-notes\/unreleased-hardening\.md$/u,
  /(?:^|\/)memory-studio(?:[-_.]|\/)/u,
  /(?:^|\/)(?:host[-_]?attestation|frozen[-_]?contract)(?:[-_.]|\/)/u,
  /^bench\/.*(?:answerer|judge|score(?:r|-answers))(?:[-_.]|\/).*$/u,
  /^tests\/fixtures\//u,
  /^tests\/.*(?:a[5-8]|benchmark-provenance|claude-answerer|frontier|hybrid-eval|longmemeval|paired-score|prior-response-intent|recall-ablation|retrieval-metrics|role-pair|structured-memory-envelope|versioned-evidence).*\.(?:js|json|jsonl)$/u,
];
const FORBIDDEN_EVIDENCE_KEYS = new Set([
  'answer',
  'answers',
  'gold',
  'gold_answer',
  'judgment',
  'judgments',
  'memory_text',
  'prompt',
  'question',
  'questions',
  'raw_export',
  'raw_exports',
]);

export class PublicMirrorError extends Error {
  constructor(findings) {
    const normalized = [...findings]
      .map((finding) => ({
        class: String(finding.class || 'INVALID'),
        path: finding.path ? normalizeDisplayPath(finding.path) : undefined,
        line: Number.isInteger(finding.line) ? finding.line : undefined,
        detail: finding.detail ? String(finding.detail) : undefined,
      }))
      .sort(compareFindings);
    super(`${normalized.length} public mirror violation(s)`);
    this.name = 'PublicMirrorError';
    this.findings = normalized;
  }
}

const compareFindings = (left, right) => {
  const leftKey = `${left.class}\0${left.path || ''}\0${String(left.line || 0).padStart(12, '0')}\0${left.detail || ''}`;
  const rightKey = `${right.class}\0${right.path || ''}\0${String(right.line || 0).padStart(12, '0')}\0${right.detail || ''}`;
  return leftKey.localeCompare(rightKey, 'en');
};

const normalizeDisplayPath = (value) => String(value).split(path.sep).join('/');

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);

const ownKeysOnly = (value, allowed, context, findings) => {
  if (!isPlainObject(value)) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'must be an object' });
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: `unknown key ${key}` });
    }
  }
  return true;
};

const validateRelativePath = (value, context, findings) => {
  if (typeof value !== 'string' || value.length === 0) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'path must be a non-empty string' });
    return false;
  }
  if (value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:\//u.test(value)) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'path must be portable and relative' });
    return false;
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value === '.' || value.startsWith('../') || value.includes('/../')) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'path must be normalized and contained' });
    return false;
  }
  return true;
};

const validateSortedUniqueStrings = (
  value,
  context,
  findings,
  validateItem = undefined,
  requireSorted = true,
) => {
  if (!Array.isArray(value)) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'must be an array' });
    return [];
  }
  const validStrings = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.length === 0) {
      findings.push({ class: 'MANIFEST_SCHEMA', path: `${context}[${index}]`, detail: 'must be a non-empty string' });
      continue;
    }
    if (!validateItem || validateItem(item, `${context}[${index}]`, findings)) validStrings.push(item);
  }
  if (new Set(validStrings).size !== validStrings.length) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'must not contain duplicates' });
  }
  const sorted = [...validStrings].sort((a, b) => a.localeCompare(b, 'en'));
  if (requireSorted && sorted.some((item, index) => item !== validStrings[index])) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'must be sorted' });
  }
  return validStrings;
};

const validateHashedPathEntries = (value, context, findings, allowedKeys = HASHED_PATH_KEYS) => {
  if (!Array.isArray(value)) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'must be an array' });
    return [];
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryContext = `${context}[${index}]`;
    if (!ownKeysOnly(entry, allowedKeys, entryContext, findings)) continue;
    if (!validateRelativePath(entry.path, `${entryContext}.path`, findings)) continue;
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) {
      findings.push({ class: 'MANIFEST_SCHEMA', path: `${entryContext}.sha256`, detail: 'must be a lowercase SHA-256' });
      continue;
    }
    entries.push(entry);
  }
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'paths must be unique' });
  }
  const sorted = [...paths].sort((a, b) => a.localeCompare(b, 'en'));
  if (sorted.some((item, index) => item !== paths[index])) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: context, detail: 'must be sorted by path' });
  }
  return entries;
};

export const validateManifest = (manifest) => {
  const findings = [];
  if (!ownKeysOnly(manifest, TOP_LEVEL_KEYS, 'manifest', findings)) {
    throw new PublicMirrorError(findings);
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: 'schemaVersion', detail: `must equal ${MANIFEST_SCHEMA_VERSION}` });
  }
  if (ownKeysOnly(manifest.repository, REPOSITORY_KEYS, 'repository', findings)) {
    validateSortedUniqueStrings(manifest.repository.files, 'repository.files', findings, validateRelativePath);
    validateSortedUniqueStrings(manifest.repository.requiredFiles, 'repository.requiredFiles', findings, validateRelativePath);
    const ignores = validateSortedUniqueStrings(manifest.repository.runtimeIgnores, 'repository.runtimeIgnores', findings);
    for (const ignore of ignores) {
      if (!ALLOWED_RUNTIME_IGNORES.has(ignore)) {
        findings.push({ class: 'MANIFEST_SCHEMA', path: 'repository.runtimeIgnores', detail: `unapproved ignore ${ignore}` });
      }
    }
    validateHashedPathEntries(manifest.repository.binaryFiles, 'repository.binaryFiles', findings);
    const exceptions = validateHashedPathEntries(
      manifest.repository.contentExceptions,
      'repository.contentExceptions',
      findings,
      CONTENT_EXCEPTION_KEYS,
    );
    for (const [index, exception] of exceptions.entries()) {
      const classes = validateSortedUniqueStrings(
        exception.classes,
        `repository.contentExceptions[${index}].classes`,
        findings,
      );
      for (const className of classes) {
        if (!CONTENT_CLASSES.has(className)) {
          findings.push({ class: 'MANIFEST_SCHEMA', path: `repository.contentExceptions[${index}].classes`, detail: `unknown class ${className}` });
        }
      }
    }
  }
  if (ownKeysOnly(manifest.npm, NPM_KEYS, 'npm', findings)) {
    if (typeof manifest.npm.packageName !== 'string' || manifest.npm.packageName.length === 0) {
      findings.push({ class: 'MANIFEST_SCHEMA', path: 'npm.packageName', detail: 'must be a non-empty string' });
    }
    validateSortedUniqueStrings(
      manifest.npm.packageFiles,
      'npm.packageFiles',
      findings,
      validateRelativePath,
      false,
    );
    validateSortedUniqueStrings(manifest.npm.files, 'npm.files', findings, validateRelativePath);
  }
  if (ownKeysOnly(manifest.transforms, TRANSFORM_KEYS, 'transforms', findings)
      && ownKeysOnly(
        manifest.transforms.packageJson,
        PACKAGE_JSON_TRANSFORM_KEYS,
        'transforms.packageJson',
        findings,
      )) {
    const omittedScripts = validateSortedUniqueStrings(
      manifest.transforms.packageJson.omitScripts,
      'transforms.packageJson.omitScripts',
      findings,
    );
    const setScripts = manifest.transforms.packageJson.setScripts;
    if (!isPlainObject(setScripts)) {
      findings.push({
        class: 'MANIFEST_SCHEMA',
        path: 'transforms.packageJson.setScripts',
        detail: 'must be an object',
      });
    } else {
      for (const [scriptName, scriptValue] of Object.entries(setScripts)) {
        if (!scriptName || typeof scriptValue !== 'string' || scriptValue.length === 0) {
          findings.push({
            class: 'MANIFEST_SCHEMA',
            path: `transforms.packageJson.setScripts.${scriptName || '<empty>'}`,
            detail: 'script names and values must be non-empty strings',
          });
        }
        if (omittedScripts.includes(scriptName)) {
          findings.push({
            class: 'MANIFEST_SCHEMA',
            path: `transforms.packageJson.setScripts.${scriptName}`,
            detail: 'script cannot also be omitted',
          });
        }
      }
    }
  }
  if (!Array.isArray(manifest.benchmarkEvidence)) {
    findings.push({ class: 'MANIFEST_SCHEMA', path: 'benchmarkEvidence', detail: 'must be an array' });
  } else {
    const paths = [];
    for (let index = 0; index < manifest.benchmarkEvidence.length; index += 1) {
      const entry = manifest.benchmarkEvidence[index];
      const context = `benchmarkEvidence[${index}]`;
      if (!ownKeysOnly(entry, EVIDENCE_KEYS, context, findings)) continue;
      if (validateRelativePath(entry.path, `${context}.path`, findings)) paths.push(entry.path);
      if (entry.schema !== 'sanitized-public-aggregate-v1') {
        findings.push({ class: 'MANIFEST_SCHEMA', path: `${context}.schema`, detail: 'unsupported evidence schema' });
      }
      if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) {
        findings.push({ class: 'MANIFEST_SCHEMA', path: `${context}.sha256`, detail: 'must be a lowercase SHA-256' });
      }
    }
    if (new Set(paths).size !== paths.length) {
      findings.push({ class: 'MANIFEST_SCHEMA', path: 'benchmarkEvidence', detail: 'paths must be unique' });
    }
    const sorted = [...paths].sort((a, b) => a.localeCompare(b, 'en'));
    if (sorted.some((item, index) => item !== paths[index])) {
      findings.push({ class: 'MANIFEST_SCHEMA', path: 'benchmarkEvidence', detail: 'must be sorted by path' });
    }
  }
  if (findings.length > 0) throw new PublicMirrorError(findings);

  const repositoryFiles = new Set(manifest.repository.files);
  for (const required of manifest.repository.requiredFiles) {
    if (!repositoryFiles.has(required)) {
      findings.push({ class: 'MANIFEST_SCHEMA', path: 'repository.requiredFiles', detail: 'required file is not repository-allowlisted' });
    }
  }
  for (const entry of [
    ...manifest.repository.binaryFiles,
    ...manifest.repository.contentExceptions,
    ...manifest.benchmarkEvidence,
  ]) {
    if (!repositoryFiles.has(entry.path)) {
      findings.push({ class: 'MANIFEST_SCHEMA', path: entry.path, detail: 'entry path is not repository-allowlisted' });
    }
  }
  for (const relativePath of manifest.npm.files) {
    if (!repositoryFiles.has(relativePath)) {
      findings.push({ class: 'MANIFEST_SCHEMA', path: relativePath, detail: 'npm file is not repository-allowlisted' });
    }
  }
  if (findings.length > 0) throw new PublicMirrorError(findings);
  return manifest;
};

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const globToRegExp = (glob) => {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      pattern += '.*';
      index += 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`, 'u');
};

const createIgnoreMatcher = (globs) => {
  const patterns = globs.map((glob) => ({ glob, regex: globToRegExp(glob) }));
  return (relativePath, isDirectory = false) => {
    const normalized = normalizeDisplayPath(relativePath);
    return patterns.some(({ glob, regex }) => (
      regex.test(normalized)
      || (isDirectory && glob.endsWith('/**') && normalized === glob.slice(0, -3))
      || (isDirectory && glob.startsWith('**/') && normalized.endsWith(glob.slice(3, -3)))
    ));
  };
};

const walkRepository = (root, shouldIgnore) => {
  const files = [];
  const symlinks = [];
  const walk = (directory, relativeDirectory = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relativePath === '.git' || relativePath.startsWith('.git/')) continue;
      if (entry.isSymbolicLink()) {
        if (!shouldIgnore(relativePath, false)) symlinks.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) {
        if (!shouldIgnore(relativePath, true)) walk(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && !shouldIgnore(relativePath, false)) {
        files.push(relativePath);
      } else if (!entry.isFile() && !shouldIgnore(relativePath, false)) {
        symlinks.push(relativePath);
      }
    }
  };
  walk(root);
  return { files, symlinks };
};

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env || process.env,
    maxBuffer: MAX_COMMAND_OUTPUT,
    shell: false,
    timeout: options.timeout || 120_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${options.label || command} failed`);
  }
  return result.stdout;
};

const readTrackedFiles = (root) => runCommand(
  'git',
  ['ls-files', '-z', '--cached'],
  { cwd: root, label: 'git inventory' },
).split('\0').filter(Boolean).map(normalizeDisplayPath).sort((a, b) => a.localeCompare(b, 'en'));

const lineAt = (text, offset) => {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
};

const contentFindings = (relativePath, text) => {
  const findings = [];
  const addMatches = (className, regex) => {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      findings.push({ class: className, path: relativePath, line: lineAt(text, match.index || 0) });
    }
  };
  addMatches('ABSOLUTE_HOME_PATH', /(?:^|[\s"'=(])\/(?:Users|home)\/[^\s/"'<>]+\//gmu);
  addMatches('ABSOLUTE_HOME_PATH', /(?:^|[\s"'=(])\/root\//gmu);
  addMatches('ABSOLUTE_HOME_PATH', /\b[A-Za-z]:[\\/]Users[\\/][^\s\\/"'<>]+[\\/]/gmu);

  EMAIL_RE.lastIndex = 0;
  for (const match of text.matchAll(EMAIL_RE)) {
    const domain = String(match[1] || '').toLowerCase();
    if (!ALLOWED_EMAIL_DOMAINS.has(domain)) {
      findings.push({ class: 'EMAIL', path: relativePath, line: lineAt(text, match.index || 0) });
    }
  }

  const secretPatterns = [
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gmu,
    /\bA(?:KI|SI)A[0-9A-Z]{16}\b/gmu,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/gmu,
    /\bgh[pousr]_[A-Za-z0-9]{32,}\b/gmu,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gmu,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gmu,
    /\bAIza[0-9A-Za-z_-]{35}\b/gmu,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gmu,
    /\b(?:api[_-]?key|client[_-]?secret|password|secret|token)\s*[:=]\s*["']?(?=[A-Za-z0-9_+./=-]{0,127}\d)[A-Za-z0-9_+./=-]{24,}["']?/gimu,
  ];
  for (const regex of secretPatterns) addMatches('SECRET', regex);
  return findings;
};

const internalLinkFindings = (
  relativePath,
  text,
  allowlisted,
  findingClass = 'BROKEN_PUBLIC_LINK',
) => {
  const isMarkdown = relativePath.toLowerCase().endsWith('.md');
  const isHtml = relativePath.toLowerCase().endsWith('.html');
  if (!isMarkdown && !isHtml) return [];
  const findings = [];
  const patterns = isMarkdown
    ? [/\[[^\]]*\]\(([^)]+)\)/gmu]
    : [/(?:href|src)\s*=\s*["']([^"']+)["']/gimu];
  for (const linkPattern of patterns) {
    for (const match of text.matchAll(linkPattern)) {
      const rawTarget = String(match[1] || '').trim().replace(/^<|>$/gu, '');
      if (!rawTarget
        || rawTarget.startsWith('#')
        || /^(?:data:|https?:|mailto:)/iu.test(rawTarget)) continue;
      const withoutFragment = rawTarget.split('#', 1)[0].split('?', 1)[0];
      let decoded;
      try {
        decoded = decodeURIComponent(withoutFragment);
      } catch {
        findings.push({ class: findingClass, path: relativePath, line: lineAt(text, match.index || 0) });
        continue;
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), decoded));
      if (resolved.startsWith('../') || path.posix.isAbsolute(resolved) || !allowlisted.has(resolved)) {
        findings.push({ class: findingClass, path: relativePath, line: lineAt(text, match.index || 0) });
      }
    }
  }
  return findings;
};

const isPrivateArtifactPath = (relativePath) => {
  const normalized = normalizeDisplayPath(relativePath);
  if (PRIVATE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  if (PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  const segments = normalized.toLowerCase().split('/');
  if (segments.some((segment) => PRIVATE_SEGMENTS.has(segment))) return true;
  const basename = segments.at(-1) || '';
  const dataExtension = /\.(?:csv|json|jsonl|log|ndjson|parquet|tsv|yaml|yml)$/iu.test(basename);
  if (dataExtension && PRIVATE_DATA_NAME_RE.test(basename)) return true;
  return FROZEN_CONTRACT_RE.test(normalized) || RAW_BENCHMARK_RE.test(normalized);
};

const validateAggregateEvidence = (relativePath, value, findings) => {
  if (!isPlainObject(value)) {
    findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'root must be an object' });
    return;
  }
  if (!Number.isInteger(value.schema_version) || value.schema_version < 1) {
    findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid schema_version' });
  }
  if (value.evidence_kind !== 'sanitized-public-aggregate') {
    findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid evidence_kind' });
  }
  if (typeof value.generated_at !== 'string' || Number.isNaN(Date.parse(value.generated_at))) {
    findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid generated_at' });
  }
  if (!Array.isArray(value.evidence_sets) || value.evidence_sets.length === 0) {
    findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid evidence_sets' });
  } else {
    const ids = new Set();
    const statuses = new Set(['development', 'historical', 'pre-score', 'scored']);
    for (const entry of value.evidence_sets) {
      if (!isPlainObject(entry)) {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'evidence set must be an object' });
        continue;
      }
      const allowed = new Set(['denominator', 'id', 'limitations', 'metrics', 'status']);
      if (Object.keys(entry).some((key) => !allowed.has(key))) {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'evidence set has unknown keys' });
      }
      if (typeof entry.id !== 'string' || !/^[a-z0-9-]+$/u.test(entry.id) || ids.has(entry.id)) {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid evidence set id' });
      } else {
        ids.add(entry.id);
      }
      if (!statuses.has(entry.status)) {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid evidence set status' });
      }
      if (!Number.isInteger(entry.denominator) || entry.denominator < 1) {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid evidence set denominator' });
      }
      if (!isPlainObject(entry.metrics) || Object.values(entry.metrics).some((metric) => (
        typeof metric !== 'number' || !Number.isFinite(metric)
      ))) {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid aggregate metrics' });
      }
      if (!Array.isArray(entry.limitations) || entry.limitations.some((item) => typeof item !== 'string' || item.length === 0)) {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid evidence set limitations' });
      }
    }
  }
  if (!isPlainObject(value.claims)
    || typeof value.claims.public_sota !== 'boolean'
    || typeof value.claims.held_out_score !== 'boolean') {
    findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid claims' });
  }
  const visit = (node, keyPath = []) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, keyPath);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_EVIDENCE_KEYS.has(key.toLowerCase())) {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: `content-bearing key ${keyPath.concat(key).join('.')}` });
      }
      if (key.toLowerCase().endsWith('sha256') && (typeof child !== 'string' || !SHA256_RE.test(child))) {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: `invalid digest at ${keyPath.concat(key).join('.')}` });
      }
      visit(child, keyPath.concat(key));
    }
  };
  visit(value);
};

const readNpmInventory = (root) => {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gigabrain-public-pack-'));
  try {
    const stdout = runCommand(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: root,
        label: 'npm package inventory',
        timeout: 180_000,
        env: {
          ...process.env,
          npm_config_audit: 'false',
          npm_config_cache: cacheDirectory,
          npm_config_fund: 'false',
          npm_config_ignore_scripts: 'true',
          npm_config_update_notifier: 'false',
        },
      },
    );
    let parsed;
    try {
      parsed = parseNpmPackReports(stdout);
    } catch {
      throw new Error('npm package inventory returned invalid JSON');
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].files)) {
      throw new Error('npm package inventory returned an invalid shape');
    }
    return {
      name: parsed[0].name,
      files: parsed[0].files
        .map((entry) => normalizeDisplayPath(entry.path))
        .sort((a, b) => a.localeCompare(b, 'en')),
    };
  } finally {
    fs.rmSync(cacheDirectory, { force: true, recursive: true });
  }
};

const checkHistory = (root, findings, requireSingleCommit) => {
  const raw = runCommand(
    'git',
    ['log', '--format=%ae%x00%ce%x00'],
    { cwd: root, label: 'git history metadata' },
  );
  const emails = raw.split('\0').map((value) => value.trim()).filter(Boolean);
  const rejected = emails.filter((email) => {
    const match = email.match(/@([^@]+)$/u);
    return !match || !ALLOWED_HISTORY_EMAIL_DOMAINS.has(match[1].toLowerCase());
  });
  if (rejected.length > 0) {
    findings.push({ class: 'GIT_HISTORY_EMAIL', detail: `${rejected.length} non-noreply metadata field(s)` });
  }
  if (requireSingleCommit) {
    const countText = runCommand('git', ['rev-list', '--count', 'HEAD'], { cwd: root, label: 'git history count' }).trim();
    if (countText !== '1') findings.push({ class: 'GIT_HISTORY_NOT_FRESH_ROOT' });
  }
};

export const checkPublicMirror = ({
  root = process.cwd(),
  manifestPath = 'public-release-manifest.json',
  checkNpm = true,
  checkHistory: shouldCheckHistory = true,
  requireSingleCommit = false,
} = {}) => {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const resolvedManifest = path.resolve(resolvedRoot, manifestPath);
  const relativeManifest = normalizeDisplayPath(path.relative(resolvedRoot, resolvedManifest));
  if (!relativeManifest
    || relativeManifest.startsWith('../')
    || path.posix.isAbsolute(relativeManifest)) {
    throw new PublicMirrorError([{ class: 'MANIFEST_PATH', detail: 'manifest must be inside the repository' }]);
  }
  const manifestStat = fs.lstatSync(resolvedManifest, { throwIfNoEntry: false });
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    throw new PublicMirrorError([{ class: 'MANIFEST_PATH', path: relativeManifest, detail: 'manifest must be a regular file' }]);
  }
  const canonicalManifest = fs.realpathSync(resolvedManifest);
  if (canonicalManifest !== resolvedManifest) {
    throw new PublicMirrorError([{ class: 'MANIFEST_PATH', path: relativeManifest, detail: 'manifest path must not contain symbolic links' }]);
  }
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(readRegularFileNoFollowSync(resolvedManifest, 'utf8')));
  } catch (error) {
    if (error instanceof PublicMirrorError) throw error;
    throw new PublicMirrorError([{ class: 'MANIFEST_PARSE', path: normalizeDisplayPath(path.relative(resolvedRoot, resolvedManifest)) }]);
  }
  if (!manifest.repository.files.includes(relativeManifest)) {
    throw new PublicMirrorError([{ class: 'MANIFEST_PATH', path: relativeManifest, detail: 'manifest must allowlist itself' }]);
  }

  const findings = [];
  const allowlisted = new Set(manifest.repository.files);
  const required = new Set(manifest.repository.requiredFiles);
  const binaryByPath = new Map(manifest.repository.binaryFiles.map((entry) => [entry.path, entry.sha256]));
  const exceptionByPath = new Map(manifest.repository.contentExceptions.map((entry) => [entry.path, entry]));
  const evidenceByPath = new Map(manifest.benchmarkEvidence.map((entry) => [entry.path, entry]));
  const shouldIgnore = createIgnoreMatcher(manifest.repository.runtimeIgnores);
  const inventory = walkRepository(resolvedRoot, shouldIgnore);
  const actual = new Set(inventory.files);
  const textByPath = new Map();

  for (const symlink of inventory.symlinks) findings.push({ class: 'SYMLINK_OR_SPECIAL_FILE', path: symlink });
  for (const relativePath of inventory.files) {
    if (!allowlisted.has(relativePath)) findings.push({ class: 'UNEXPECTED_FILE', path: relativePath });
  }
  for (const relativePath of allowlisted) {
    if (!actual.has(relativePath)) findings.push({ class: 'MISSING_ALLOWLISTED_FILE', path: relativePath });
    if (isPrivateArtifactPath(relativePath)) findings.push({ class: 'PRIVATE_ARTIFACT_PATH', path: relativePath });
  }
  for (const relativePath of required) {
    if (!actual.has(relativePath)) findings.push({ class: 'MISSING_REQUIRED_FILE', path: relativePath });
  }

  let tracked = [];
  try {
    tracked = readTrackedFiles(resolvedRoot);
  } catch {
    findings.push({ class: 'GIT_INVENTORY_FAILED' });
  }
  for (const relativePath of tracked) {
    if (!allowlisted.has(relativePath)) findings.push({ class: 'UNEXPECTED_TRACKED_FILE', path: relativePath });
  }

  for (const relativePath of inventory.files) {
    if (!allowlisted.has(relativePath)) continue;
    const absolutePath = path.join(resolvedRoot, ...relativePath.split('/'));
    const buffer = readRegularFileNoFollowSync(absolutePath, null);
    const digest = sha256(buffer);
    if (binaryByPath.has(relativePath)) {
      if (binaryByPath.get(relativePath) !== digest) findings.push({ class: 'BINARY_DIGEST_DRIFT', path: relativePath });
      continue;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      findings.push({ class: 'UNREVIEWED_BINARY_FILE', path: relativePath });
      continue;
    }
    if (text.includes('\0')) {
      findings.push({ class: 'UNREVIEWED_BINARY_FILE', path: relativePath });
      continue;
    }
    textByPath.set(relativePath, text);
    const exception = exceptionByPath.get(relativePath);
    const exceptionActive = exception && exception.sha256 === digest;
    for (const finding of contentFindings(relativePath, text)) {
      if (!exceptionActive || !exception.classes.includes(finding.class)) findings.push(finding);
    }
    findings.push(...internalLinkFindings(relativePath, text, allowlisted));
    const evidence = evidenceByPath.get(relativePath);
    if (evidence) {
      if (evidence.sha256 !== digest) findings.push({ class: 'BENCHMARK_EVIDENCE_DIGEST_DRIFT', path: relativePath });
      try {
        validateAggregateEvidence(relativePath, JSON.parse(text), findings);
      } catch {
        findings.push({ class: 'BENCHMARK_EVIDENCE_SCHEMA', path: relativePath, detail: 'invalid JSON' });
      }
    }
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readRegularFileNoFollowSync(path.join(resolvedRoot, 'package.json'), 'utf8'));
  } catch {
    findings.push({ class: 'PACKAGE_JSON_INVALID', path: 'package.json' });
  }
  if (packageJson) {
    const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
    if (JSON.stringify(packageFiles) !== JSON.stringify(manifest.npm.packageFiles)) {
      findings.push({ class: 'PACKAGE_FILES_ALLOWLIST_DRIFT', path: 'package.json' });
    }
    const packageScripts = isPlainObject(packageJson.scripts) ? packageJson.scripts : {};
    for (const scriptName of manifest.transforms.packageJson.omitScripts) {
      if (Object.hasOwn(packageScripts, scriptName)) {
        findings.push({
          class: 'PUBLIC_PACKAGE_SCRIPT_NOT_OMITTED',
          path: 'package.json',
          detail: `private script remains: ${scriptName}`,
        });
      }
    }
    for (const [scriptName, expectedValue] of Object.entries(manifest.transforms.packageJson.setScripts)) {
      if (packageScripts[scriptName] !== expectedValue) {
        findings.push({
          class: 'PUBLIC_PACKAGE_SCRIPT_TRANSFORM_DRIFT',
          path: 'package.json',
          detail: `public script differs: ${scriptName}`,
        });
      }
    }
  }

  if (checkNpm) {
    try {
      const npmInventory = readNpmInventory(resolvedRoot);
      if (npmInventory.name !== manifest.npm.packageName) findings.push({ class: 'NPM_PACKAGE_NAME_DRIFT', path: 'package.json' });
      const expectedFiles = manifest.npm.files;
      const expectedSet = new Set(expectedFiles);
      const actualSet = new Set(npmInventory.files);
      for (const relativePath of npmInventory.files) {
        if (!expectedSet.has(relativePath)) findings.push({ class: 'UNEXPECTED_NPM_FILE', path: relativePath });
        if (isPrivateArtifactPath(relativePath)) findings.push({ class: 'PRIVATE_NPM_ARTIFACT', path: relativePath });
      }
      for (const relativePath of expectedFiles) {
        if (!actualSet.has(relativePath)) findings.push({ class: 'MISSING_NPM_FILE', path: relativePath });
      }
      for (const relativePath of npmInventory.files) {
        const text = textByPath.get(relativePath);
        if (text !== undefined) {
          findings.push(...internalLinkFindings(relativePath, text, actualSet, 'BROKEN_NPM_LINK'));
        }
      }
    } catch {
      findings.push({ class: 'NPM_PACK_FAILED' });
    }
  }

  if (shouldCheckHistory) {
    try {
      checkHistory(resolvedRoot, findings, requireSingleCommit);
    } catch {
      findings.push({ class: 'GIT_HISTORY_CHECK_FAILED' });
    }
  }

  if (findings.length > 0) throw new PublicMirrorError(findings);
  return {
    ok: true,
    repositoryFiles: inventory.files.length,
    npmFiles: manifest.npm.files.length,
    benchmarkEvidenceFiles: manifest.benchmarkEvidence.length,
  };
};

const parseCli = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root' && argv[index + 1]) options.root = argv[++index];
    else if (arg === '--manifest' && argv[index + 1]) options.manifestPath = argv[++index];
    else if (arg === '--require-single-commit') options.requireSingleCommit = true;
    else throw new Error('unsupported argument');
  }
  return options;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = checkPublicMirror(parseCli(process.argv.slice(2)));
    fs.writeSync(1, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    fs.writeSync(2, 'PUBLIC_MIRROR_CHECK_FAILED\n');
    if (error instanceof PublicMirrorError) {
      for (const finding of error.findings) {
        const location = finding.path ? ` ${finding.path}${finding.line ? `:${finding.line}` : ''}` : '';
        const detail = finding.detail ? ` (${finding.detail})` : '';
        fs.writeSync(2, `[${finding.class}]${location}${detail}\n`);
      }
    } else {
      fs.writeSync(2, '[CHECKER_INTERNAL_ERROR]\n');
    }
    process.exitCode = 1;
  }
}

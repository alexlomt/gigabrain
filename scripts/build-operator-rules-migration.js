#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { V3_CONFIG_SCHEMA } from '../lib/core/config.js';

const TASK3_HANDOFF_SHA256 = 'beb9c8cc05c18dc47f0c86ad91c277682dc1f2404e6313eabc1692d6cac84a0d';
const DEPLOYED_COMMIT = '43cd4b41518b5e35b3872722fcceaac535a1ff64';
const DEPLOYED_TREE = '2ea1117367407f87e5b9702ba65f7346f2c6390f';
const CUSTOM_RULES_REFACTOR = 'e5a95b09594f29f3e04b09c0708cb8ff8c932adf';
const CUSTOM_RULES_SOURCE_COMMIT = '83943806904a888f6d4151953dc8671e2a620df3';

const DEFAULTS = Object.freeze({
  deployedRepo: '/home/alex/.openclaw/vendor/gigabrain',
  handoffPath: '/home/alex/.openclaw/runtime/gigabrain-v0.11-audit/operator-rules-migration-task3-handoff.json',
  outputPath: '/home/alex/.openclaw/runtime/gigabrain-v0.11-audit/operator-rules-migration.json',
  protectedConfigPath: '/home/alex/.openclaw/openclaw.json',
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const fail = (code) => {
  throw new Error(code);
};

const assertSha256 = (value, code) => {
  if (!/^[0-9a-f]{64}$/.test(String(value || ''))) fail(code);
};

const assertSha1 = (value, code) => {
  if (!/^[0-9a-f]{40}$/.test(String(value || ''))) fail(code);
};

const validateRegexRule = (rule, family) => {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail(`OPERATOR_RULES_SCHEMA ${family}`);
  const pattern = String(rule.pattern || '');
  const flags = String(rule.flags ?? 'i');
  if (!pattern || !/^[dgimsuvy]*$/.test(flags)) fail(`OPERATOR_RULES_INVALID_REGEX ${family}`);
  try {
    new RegExp(pattern, flags);
  } catch {
    fail(`OPERATOR_RULES_INVALID_REGEX ${family}`);
  }
};

const REGEX_ARRAY_PATHS = Object.freeze([
  ['entity', 'rejectPatterns'],
  ['entity', 'nonPersonPatterns'],
  ['memoryTier', 'opsPatterns'],
  ['memoryTier', 'workingReferencePatterns'],
  ['memoryTier', 'personalMemoryPatterns'],
  ['memoryTier', 'projectMemoryPatterns'],
  ['memoryTier', 'projectEpisodePatterns'],
  ['memoryTier', 'projectIdentityPatterns'],
  ['memoryTier', 'personalGoalPatterns'],
  ['memoryTier', 'projectReferencePatterns'],
  ['memoryTier', 'contactInfoPatterns'],
  ['memoryTier', 'healthMemoryPatterns'],
  ['surface', 'beliefNoisePatterns'],
  ['surface', 'beliefMetaPatterns'],
  ['surface', 'summaryWeakPatterns'],
  ['surface', 'personPreferredPatterns'],
  ['surface', 'projectPreferredPatterns'],
  ['sessionBrief', 'excludePatterns'],
]);

const validateRulePayload = ({ customSlotRules, operatorRules }) => {
  if (!Array.isArray(customSlotRules) || !operatorRules || typeof operatorRules !== 'object') {
    fail('OPERATOR_RULES_SCHEMA');
  }
  for (const rule of customSlotRules) {
    validateRegexRule(rule, 'worldModel.customSlotRules');
    if (!String(rule.slot || '').trim()) fail('CUSTOM_SLOT_RULES_SCHEMA');
    if (!['update', 'remember'].includes(String(rule.operation || 'update'))) fail('CUSTOM_SLOT_RULES_SCHEMA');
  }
  for (const [family, name] of REGEX_ARRAY_PATHS) {
    const rules = operatorRules?.[family]?.[name];
    if (!Array.isArray(rules)) fail(`OPERATOR_RULES_SCHEMA operatorRules.${family}.${name}`);
    for (const rule of rules) validateRegexRule(rule, `operatorRules.${family}.${name}`);
  }
};

const buildOperatorRulesMigration = (input = {}) => {
  if (Array.isArray(input.nonMechanicalChoices) && input.nonMechanicalChoices.length > 0) {
    fail('OPERATOR_RULES_NON_MECHANICAL_REVIEW_REQUIRED');
  }
  assertSha1(input?.deployedSource?.commit, 'OPERATOR_RULES_DEPLOYED_COMMIT');
  assertSha1(input?.deployedSource?.tree, 'OPERATOR_RULES_DEPLOYED_TREE');
  assertSha256(input.handoffSha256, 'OPERATOR_RULES_HANDOFF_HASH');
  assertSha256(input.sourceProtectedConfigSha256, 'OPERATOR_RULES_SOURCE_CONFIG_HASH');
  assertSha256(input.finalProtectedConfigSha256, 'OPERATOR_RULES_FINAL_CONFIG_HASH');
  if (!Array.isArray(input.sourceBindings) || input.sourceBindings.length === 0) {
    fail('OPERATOR_RULES_SOURCE_BINDINGS');
  }
  for (const binding of input.sourceBindings) {
    assertSha256(binding.fileSha256, 'OPERATOR_RULES_SOURCE_FILE_HASH');
    assertSha256(binding.symbolSha256, 'OPERATOR_RULES_SOURCE_SYMBOL_HASH');
  }
  if (input?.canary?.ok !== true || input?.canary?.configOnly !== true || input?.canary?.secretStripped !== true) {
    fail('OPERATOR_RULES_CANARY_VALIDATION_FAILED');
  }
  validateRulePayload(input);
  const privateRulePayloadSha256 = sha256(canonicalJson({
    customSlotRules: input.customSlotRules,
    operatorRules: input.operatorRules,
  }));
  return canonicalize({
    artifactKind: 'operator-rules-migration',
    canary: input.canary,
    customSlotRules: input.customSlotRules,
    deployedSource: input.deployedSource,
    finalProtectedConfigSha256: input.finalProtectedConfigSha256,
    handoffSha256: input.handoffSha256,
    mechanicalReview: {
      nonMechanicalChoiceCount: 0,
      status: 'mechanical_only',
    },
    operatorRules: input.operatorRules,
    privateRulePayloadSha256,
    reviewerApprovals: Array.isArray(input.reviewerApprovals) ? input.reviewerApprovals : [],
    schemaVersion: 1,
    sourceBindings: input.sourceBindings,
    sourceProtectedConfigSha256: input.sourceProtectedConfigSha256,
    valueArtifactSha256: privateRulePayloadSha256,
  });
};

const git = (repo, args) => {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
    }).trimEnd();
  } catch {
    fail('OPERATOR_RULES_GIT_EVIDENCE');
  }
};

const readInitializer = (source, symbol) => {
  const declaration = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:const|let)\\s+${symbol}\\s*=\\s*`, 'm');
  const match = declaration.exec(source);
  if (!match) fail('OPERATOR_RULES_SOURCE_SYMBOL_MISSING');
  const start = match.index + match[0].length;
  let depth = 0;
  let quote = '';
  let regex = false;
  let regexClass = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '[') regexClass = true;
      else if (char === ']') regexClass = false;
      else if (char === '/' && !regexClass) regex = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && next !== '/' && next !== '*') {
      regex = true;
      continue;
    }
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ';' && depth === 0) return source.slice(start, index).trim();
  }
  fail('OPERATOR_RULES_SOURCE_SYMBOL_UNTERMINATED');
};

const evaluateInitializer = (initializer) => {
  try {
    return vm.runInNewContext(`(${initializer})`, Object.create(null), { timeout: 1000 });
  } catch {
    fail('OPERATOR_RULES_SOURCE_SYMBOL_NON_LITERAL');
  }
};

const readBalancedObject = (source, start) => {
  if (source[start] !== '{') fail('OPERATOR_RULES_CUSTOM_RULE_OBJECT');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  fail('OPERATOR_RULES_CUSTOM_RULE_OBJECT');
};

const extractCustomRuleObject = (source, symbol) => {
  const matcher = new RegExp(`if\\s*\\(\\s*${symbol}\\.test\\(content\\)\\s*\\)\\s*\\{\\s*return\\s*`, 'g');
  const rows = [];
  let match = matcher.exec(source);
  while (match) {
    const objectStart = source.indexOf('{', match.index + match[0].length - 1);
    const objectSource = readBalancedObject(source, objectStart);
    let value;
    try {
      value = vm.runInNewContext(`(${objectSource})`, {
        content: 'synthetic',
        summarizeContent: () => '__DERIVED_FROM_MATCH__',
      }, { timeout: 1000 });
    } catch {
      fail('OPERATOR_RULES_CUSTOM_RULE_NON_LITERAL');
    }
    rows.push(value);
    matcher.lastIndex = objectStart + objectSource.length;
    match = matcher.exec(source);
  }
  if (rows.length === 0) fail('OPERATOR_RULES_CUSTOM_RULE_MISSING');
  const normalized = rows.map((row) => ({
    operation: String(row.operation || 'update'),
    slot: String(row.slot || ''),
    subtopic: String(row.subtopic || ''),
    topic: String(row.topic || ''),
    ...(row.normalizedValue === '__DERIVED_FROM_MATCH__' ? {} : { value: String(row.normalizedValue || '') }),
  }));
  const first = canonicalJson(normalized[0]);
  if (normalized.some((row) => canonicalJson(row) !== first)) fail('OPERATOR_RULES_NON_MECHANICAL_REVIEW_REQUIRED');
  return normalized[0];
};

const toRegexRule = (value) => {
  if (!(value instanceof RegExp) && Object.prototype.toString.call(value) !== '[object RegExp]') {
    fail('OPERATOR_RULES_SOURCE_SYMBOL_TYPE');
  }
  return { pattern: String(value.source), flags: String(value.flags) };
};

const toStringList = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value && typeof value[Symbol.iterator] === 'function') return [...value].map((item) => String(item));
  fail('OPERATOR_RULES_SOURCE_SYMBOL_TYPE');
};

const unique = (values) => values.filter((value, index, list) => list.indexOf(value) === index);

const sourceFile = (repo, commit, sourcePath) => git(repo, ['show', `${commit}:${sourcePath}`]);
const sourceBlob = (repo, commit, sourcePath) => git(repo, ['rev-parse', `${commit}:${sourcePath}`]);

const extractRules = ({ deployedRepo, deployedCommit }) => {
  const worldPath = 'lib/core/world-model.js';
  const personPath = 'lib/core/person-service.js';
  const worldSource = sourceFile(deployedRepo, deployedCommit, worldPath);
  const personSource = sourceFile(deployedRepo, deployedCommit, personPath);
  const historicalWorldSource = sourceFile(deployedRepo, CUSTOM_RULES_SOURCE_COMMIT, worldPath);
  const sources = new Map([
    [`${deployedCommit}:${worldPath}`, worldSource],
    [`${deployedCommit}:${personPath}`, personSource],
    [`${CUSTOM_RULES_SOURCE_COMMIT}:${worldPath}`, historicalWorldSource],
  ]);
  const bindings = [];
  const read = (commit, sourcePath, symbol) => {
    const source = sources.get(`${commit}:${sourcePath}`);
    if (!source) fail('OPERATOR_RULES_SOURCE_FILE_MISSING');
    const initializer = readInitializer(source, symbol);
    bindings.push({
      commit,
      fileSha256: sha256(source),
      path: sourcePath,
      sourceBlob: sourceBlob(deployedRepo, commit, sourcePath),
      symbol,
      symbolSha256: sha256(initializer),
    });
    return evaluateInitializer(initializer);
  };
  const currentWorld = (symbol) => read(deployedCommit, worldPath, symbol);
  const currentPerson = (symbol) => read(deployedCommit, personPath, symbol);
  const historicalWorld = (symbol) => read(CUSTOM_RULES_SOURCE_COMMIT, worldPath, symbol);

  const customSlotRules = [
    'RELATIONAL_NIMBUS_RE',
    'KIMI_FOOD_IMAGE_RE',
    'FLINT_RESPONSE_RE',
  ].map((symbol) => ({
    ...toRegexRule(historicalWorld(symbol)),
    ...extractCustomRuleObject(historicalWorldSource, symbol),
  }));

  const operatorRules = {
    entity: {
      rejectTerms: unique([
        ...toStringList(currentWorld('ENTITY_ALIAS_STOPWORDS')),
        ...toStringList(currentWorld('CURATED_PROJECT_SURFACE_STOPWORDS')),
        ...toStringList(currentWorld('CURATED_ORGANIZATION_SURFACE_STOPWORDS')),
        ...toStringList(currentPerson('ENTITY_NOISE_STOPWORDS')),
      ]),
      nonPersonTerms: unique(toStringList(currentWorld('NON_PERSON_ALIAS_HINTS'))),
      rejectPatterns: [],
      nonPersonPatterns: [
        toRegexRule(currentPerson('OPS_NOISE_RE')),
        toRegexRule(currentPerson('PLACEISH_TOKEN_RE')),
        toRegexRule(currentPerson('TECHISH_TOKEN_RE')),
      ],
    },
    memoryTier: {
      tierValues: toStringList(currentWorld('MEMORY_TIER_VALUES')),
      durableTiers: toStringList(currentWorld('DURABLE_MEMORY_TIERS')),
      opsPatterns: [toRegexRule(currentWorld('OPS_RUNBOOK_RE'))],
      workingReferencePatterns: [toRegexRule(currentWorld('WORKING_REFERENCE_RE'))],
      personalMemoryPatterns: [toRegexRule(currentWorld('PERSONAL_MEMORY_RE'))],
      projectMemoryPatterns: [toRegexRule(currentWorld('PROJECT_MEMORY_RE'))],
      projectEpisodePatterns: [toRegexRule(currentWorld('PROJECT_EPISODE_RE'))],
      projectIdentityPatterns: [toRegexRule(currentWorld('PROJECT_IDENTITY_RE'))],
      personalGoalPatterns: [toRegexRule(currentWorld('PERSONAL_GOAL_RE'))],
      projectReferencePatterns: [toRegexRule(currentWorld('PROJECT_REFERENCE_RE'))],
      contactInfoPatterns: [toRegexRule(currentWorld('CONTACT_INFO_RE'))],
      healthMemoryPatterns: [toRegexRule(currentWorld('HEALTH_MEMORY_RE'))],
    },
    surface: {
      beliefNoisePatterns: [toRegexRule(currentWorld('SURFACE_BELIEF_NOISE_RE'))],
      beliefMetaPatterns: [toRegexRule(currentWorld('SURFACE_BELIEF_META_RE'))],
      summaryWeakPatterns: [toRegexRule(currentWorld('SURFACE_SUMMARY_WEAK_RE'))],
      personPreferredPatterns: [toRegexRule(currentWorld('SURFACE_PERSON_PREFERRED_RE'))],
      projectPreferredPatterns: [toRegexRule(currentWorld('SURFACE_PROJECT_PREFERRED_RE'))],
      personCueTerms: toStringList(currentWorld('PERSON_SURFACE_CUE_TOKENS')),
      projectCueTerms: toStringList(currentWorld('PROJECT_SURFACE_CUE_TOKENS')),
    },
    sessionBrief: {
      excludePatterns: [toRegexRule(currentWorld('SESSION_BRIEF_NOISE_RE'))],
    },
  };
  validateRulePayload({ customSlotRules, operatorRules });
  return {
    customSlotRules,
    operatorRules,
    sourceBindings: bindings.sort((left, right) => (
      `${left.commit}\0${left.path}\0${left.symbol}`.localeCompare(
        `${right.commit}\0${right.path}\0${right.symbol}`,
        'en',
      )
    )),
  };
};

const stripSecrets = (value, key = '') => {
  if (/api.?key|auth.?token|credential|password|secret/i.test(key)) return '';
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, stripSecrets(child, name)]));
  }
  return value;
};

const loadOpenClawValidator = async () => {
  try {
    const runtime = await import('openclaw/plugin-sdk/json-schema-runtime');
    if (typeof runtime.validateJsonSchemaValue === 'function') return runtime.validateJsonSchemaValue;
  } catch {
    // OpenClaw is an optional peer for the compatibility checkout.
  }
  const toolsRoot = path.join(os.homedir(), '.openclaw', 'tools');
  let versions = [];
  try {
    versions = fs.readdirSync(toolsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('node-'))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, 'en'));
  } catch {
    versions = [];
  }
  for (const version of versions) {
    const modulePath = path.join(
      toolsRoot,
      version,
      'lib',
      'node_modules',
      'openclaw',
      'dist',
      'plugin-sdk',
      'json-schema-runtime.js',
    );
    try {
      const runtime = await import(pathToFileURL(modulePath).href);
      if (typeof runtime.validateJsonSchemaValue === 'function') return runtime.validateJsonSchemaValue;
    } catch {
      // Try the next installed version.
    }
  }
  fail('OPERATOR_RULES_OPENCLAW_VALIDATOR_MISSING');
};

const parseArgs = (args) => {
  const parsed = { ...DEFAULTS };
  const names = new Map([
    ['--deployed-repo', 'deployedRepo'],
    ['--handoff', 'handoffPath'],
    ['--output', 'outputPath'],
    ['--protected-config', 'protectedConfigPath'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const raw = String(args[index]);
    const inline = [...names.keys()].find((name) => raw.startsWith(`${name}=`));
    if (inline) {
      parsed[names.get(inline)] = path.resolve(raw.slice(inline.length + 1));
      continue;
    }
    if (!names.has(raw) || !args[index + 1] || String(args[index + 1]).startsWith('--')) {
      fail('OPERATOR_RULES_ARGUMENTS');
    }
    parsed[names.get(raw)] = path.resolve(String(args[index + 1]));
    index += 1;
  }
  return parsed;
};

const writeProtectedAtomic = (outputPath, bytes) => {
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const tempPath = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tempPath, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, outputPath);
    fs.chmodSync(outputPath, 0o600);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* atomically renamed or never created */ }
  }
};

const buildFromProtectedSources = async (options) => {
  const handoffBytes = fs.readFileSync(options.handoffPath);
  if (sha256(handoffBytes) !== TASK3_HANDOFF_SHA256) fail('OPERATOR_RULES_HANDOFF_HASH_MISMATCH');
  let handoff;
  try {
    handoff = JSON.parse(handoffBytes.toString('utf8'));
  } catch {
    fail('OPERATOR_RULES_HANDOFF_JSON');
  }
  if (
    handoff?.schemaVersion !== 1
    || handoff?.artifactKind !== 'operator-rules-migration-task3-handoff'
    || handoff?.containsOperatorRuleValues !== false
    || handoff?.deployedSource?.commit !== DEPLOYED_COMMIT
    || handoff?.deployedSource?.tree !== DEPLOYED_TREE
    || canonicalJson(handoff?.requiredRuleFamilies) !== canonicalJson([
      'custom_slot_rules',
      'entity_rules',
      'noise_rules',
    ])
    || canonicalJson(handoff?.task4RequiredBindings) !== canonicalJson([
      'deployed_source_commit',
      'deployed_source_tree',
      'reviewer_approvals',
      'source_symbol_hashes',
      'value_artifact_sha256',
    ])
  ) fail('OPERATOR_RULES_HANDOFF_SCHEMA');

  if (git(options.deployedRepo, ['rev-parse', 'HEAD']) !== DEPLOYED_COMMIT) fail('OPERATOR_RULES_DEPLOYED_HEAD');
  if (git(options.deployedRepo, ['rev-parse', 'HEAD^{tree}']) !== DEPLOYED_TREE) fail('OPERATOR_RULES_DEPLOYED_TREE');
  if (git(options.deployedRepo, ['rev-parse', `${CUSTOM_RULES_REFACTOR}^`]) !== CUSTOM_RULES_SOURCE_COMMIT) {
    fail('OPERATOR_RULES_CUSTOM_RULE_HISTORY');
  }
  git(options.deployedRepo, ['merge-base', '--is-ancestor', CUSTOM_RULES_REFACTOR, DEPLOYED_COMMIT]);

  const rules = extractRules({ deployedRepo: options.deployedRepo, deployedCommit: DEPLOYED_COMMIT });
  const sourceConfigBytes = fs.readFileSync(options.protectedConfigPath);
  let protectedConfig;
  try {
    protectedConfig = JSON.parse(sourceConfigBytes.toString('utf8'));
  } catch {
    fail('OPERATOR_RULES_PROTECTED_CONFIG_JSON');
  }
  const pluginConfig = protectedConfig?.plugins?.entries?.gigabrain?.config;
  if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) {
    fail('OPERATOR_RULES_PROTECTED_CONFIG_MISSING');
  }
  const finalConfig = structuredClone(protectedConfig);
  const finalPluginConfig = finalConfig.plugins.entries.gigabrain.config;
  finalPluginConfig.worldModel = {
    ...(finalPluginConfig.worldModel || {}),
    customSlotRules: rules.customSlotRules,
  };
  finalPluginConfig.operatorRules = rules.operatorRules;
  const finalConfigBytes = `${JSON.stringify(finalConfig, null, 2)}\n`;

  const validator = await loadOpenClawValidator();
  const canaryResult = validator({
    schema: V3_CONFIG_SCHEMA,
    cacheKey: 'gigabrain-task4-operator-rules-canary',
    value: stripSecrets(finalPluginConfig),
    cache: false,
  });
  if (canaryResult.ok !== true) fail('OPERATOR_RULES_CANARY_VALIDATION_FAILED');

  return buildOperatorRulesMigration({
    canary: {
      configOnly: true,
      ok: true,
      secretStripped: true,
      validator: 'openclaw-json-schema',
    },
    customSlotRules: rules.customSlotRules,
    deployedSource: { commit: DEPLOYED_COMMIT, tree: DEPLOYED_TREE },
    finalProtectedConfigSha256: sha256(finalConfigBytes),
    handoffSha256: TASK3_HANDOFF_SHA256,
    operatorRules: rules.operatorRules,
    reviewerApprovals: [],
    sourceBindings: rules.sourceBindings,
    sourceProtectedConfigSha256: sha256(sourceConfigBytes),
  });
};

const main = async (args = process.argv.slice(2)) => {
  const options = parseArgs(args);
  const artifact = await buildFromProtectedSources(options);
  writeProtectedAtomic(options.outputPath, canonicalJson(artifact));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof Error && /^[A-Z0-9_ .-]+$/.test(error.message)
      ? error.message
      : 'OPERATOR_RULES_MIGRATION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

export {
  buildFromProtectedSources,
  buildOperatorRulesMigration,
  canonicalJson,
  extractRules,
  main,
};

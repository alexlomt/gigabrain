import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadReleaseProvenance } from './release-provenance.js';

const OPERATION_REQUIREMENTS = Object.freeze({
  'candidate.write': Object.freeze(['schema_migration']),
  'embedding.model-change': Object.freeze(['embedding_identity']),
  'host.sync': Object.freeze(['host_sync']),
  'maintenance.mutate': Object.freeze([
    'schema_migration', 'native_isolation', 'host_sync', 'embedding_identity', 'world_shadow', 'nightly_order',
  ]),
  'migrate-v3.apply': Object.freeze(['schema_migration']),
  'native.promote': Object.freeze(['native_isolation']),
  'plugin.register': Object.freeze(['schema_migration']),
  'setup.apply': Object.freeze(['schema_migration']),
  'world.rebuild': Object.freeze(['world_shadow']),
});
const READ_OPERATIONS = new Set(['audit.read', 'doctor.read', 'status.read']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const binaryCompare = (left, right) => Buffer.compare(
  Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'),
);
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort(binaryCompare).map((key) => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const fail = (code, detail = '') => {
  throw new Error(`${code}${detail ? ` ${detail}` : ''}`);
};
const assertNoProc = (filePath, label) => {
  const value = String(filePath || '');
  if (value.startsWith('/proc/') || value.includes('/proc/self/fd')) fail(`GIGABRAIN_CANDIDATE_${label}_PROC_DESCRIPTOR`);
};
const assertNoSymlinkAncestors = (targetPath, label) => {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) fail(`GIGABRAIN_CANDIDATE_${label}_SYMLINK_ANCESTOR`);
  }
};
const assertProtectedFile = (filePath, label, operatorUid = process.getuid?.()) => {
  assertNoProc(filePath, label);
  assertNoSymlinkAncestors(filePath, label);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`GIGABRAIN_CANDIDATE_${label}_INVALID`);
  if ((stat.mode & 0o777) !== 0o600) fail(`GIGABRAIN_CANDIDATE_${label}_MODE`);
  if (stat.nlink !== 1) fail(`GIGABRAIN_CANDIDATE_${label}_NLINK`);
  if (operatorUid !== undefined && stat.uid !== operatorUid) fail(`GIGABRAIN_CANDIDATE_${label}_OWNER_UID`);
  return stat;
};
const exactKeys = (value, expected) => (
  value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
);
const readCanonical = (filePath, label, operatorUid) => {
  assertProtectedFile(filePath, label, operatorUid);
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail(`GIGABRAIN_CANDIDATE_${label}_JSON`); }
  if (raw !== canonicalJson(parsed)) fail(`GIGABRAIN_CANDIDATE_${label}_NONCANONICAL`);
  return parsed;
};
const sameIdentity = (actual, expected) => (
  String(actual.dev) === String(expected?.dev) && String(actual.ino) === String(expected?.ino)
);

const assertCandidateOperationAllowed = ({
  operation,
  receiptPath,
  registryPath,
  releaseRoot,
  now = new Date().toISOString(),
  operatorUid = process.getuid?.(),
} = {}) => {
  const normalizedOperation = String(operation || '').trim();
  if (READ_OPERATIONS.has(normalizedOperation)) return Object.freeze({ access: 'read', allowed: true, operation: normalizedOperation });
  if (normalizedOperation === 'legacy.drop') fail('LEGACY_DROP_BLOCKED_COMPAT');
  const requiredPhases = OPERATION_REQUIREMENTS[normalizedOperation];
  if (!requiredPhases) fail('GIGABRAIN_CANDIDATE_UNKNOWN_OPERATION', normalizedOperation);
  if (!receiptPath || !registryPath || !releaseRoot) {
    fail('GIGABRAIN_CANDIDATE_RECEIPT_REQUIRED', requiredPhases[0]);
  }
  if (!fs.existsSync(receiptPath)) fail('GIGABRAIN_CANDIDATE_RECEIPT_REQUIRED', requiredPhases[0]);
  let registryStat;
  try {
    registryStat = assertProtectedFile(registryPath, 'REGISTRY', operatorUid);
  } catch {
    fail('GIGABRAIN_CANDIDATE_IDENTITY_PROTECTION');
  }
  const receipt = readCanonical(receiptPath, 'RECEIPT', operatorUid);
  const release = loadReleaseProvenance(releaseRoot);
  if (!exactKeys(receipt, [
    'code_sha', 'database_identity', 'expires_at', 'phase_receipts', 'receipt_kind',
    'receipt_sha256', 'schema_checksum', 'schema_id', 'source_cohort_identity',
  ])) fail('GIGABRAIN_CANDIDATE_RECEIPT_CONTRACT');
  const receiptBody = { ...receipt };
  delete receiptBody.receipt_sha256;
  if (receipt.receipt_sha256 !== sha256(canonicalJson(receiptBody))) fail('GIGABRAIN_CANDIDATE_RECEIPT_HASH');
  if (receipt.receipt_kind !== 'gigabrain.candidate-safety/1') fail('GIGABRAIN_CANDIDATE_RECEIPT_CONTRACT');
  if (!sameIdentity(registryStat, receipt.database_identity)) fail('GIGABRAIN_CANDIDATE_IDENTITY_MISMATCH');
  if (
    receipt.code_sha !== release.codeSha
    || receipt.schema_id !== release.schemaId
    || receipt.schema_checksum !== release.schemaChecksum
  ) fail('GIGABRAIN_CANDIDATE_PROVENANCE_MISMATCH');
  if (!Number.isFinite(Date.parse(receipt.expires_at)) || Date.parse(receipt.expires_at) <= Date.parse(now)) {
    fail('GIGABRAIN_CANDIDATE_RECEIPT_EXPIRED');
  }
  for (const phase of requiredPhases) {
    const phaseRef = receipt.phase_receipts?.[phase];
    if (!exactKeys(phaseRef, ['path', 'sha256', 'status']) || phaseRef.status !== 'accepted') {
      fail('GIGABRAIN_CANDIDATE_PHASE_REQUIRED', phase);
    }
    let artifact;
    try {
      artifact = readCanonical(phaseRef.path, 'PHASE_ARTIFACT', operatorUid);
    } catch {
      fail('GIGABRAIN_CANDIDATE_RECEIPT_PHASE_ARTIFACT', phase);
    }
    if (sha256(fs.readFileSync(phaseRef.path)) !== phaseRef.sha256) fail('GIGABRAIN_CANDIDATE_RECEIPT_PHASE_ARTIFACT_HASH', phase);
    if (!exactKeys(artifact, [
      'code_sha', 'contract', 'database_identity', 'phase', 'schema_checksum', 'schema_id',
      'source_cohort_identity', 'status',
    ])) fail('GIGABRAIN_CANDIDATE_RECEIPT_PHASE_ARTIFACT_CONTRACT', phase);
    if (
      artifact.contract !== 'gigabrain-candidate-phase-artifact/1'
      || artifact.phase !== phase
      || artifact.status !== 'accepted'
      || artifact.code_sha !== release.codeSha
      || artifact.schema_id !== release.schemaId
      || artifact.schema_checksum !== release.schemaChecksum
      || artifact.source_cohort_identity !== receipt.source_cohort_identity
      || !sameIdentity(registryStat, artifact.database_identity)
    ) fail('GIGABRAIN_CANDIDATE_RECEIPT_PHASE_ARTIFACT_SEMANTICS', phase);
  }
  return Object.freeze({ access: 'write', allowed: true, operation: normalizedOperation, requiredPhases: [...requiredPhases] });
};

const classifyCandidateOperation = ({ entrypoint = '', argv = [] } = {}) => {
  const entry = String(entrypoint || '').trim().toLowerCase();
  const args = Array.isArray(argv) ? argv.map((value) => String(value).trim().toLowerCase()) : [];
  let operation = '';
  if (entry === 'setup-first-run') operation = args.includes('--apply') ? 'setup.apply' : 'status.read';
  else if (entry === 'migrate-v3') operation = args.includes('--apply') ? 'migrate-v3.apply' : 'status.read';
  else if (entry === 'gigabrainctl') {
    const command = args[0] || '';
    const subcommand = args[1] || '';
    if (['doctor', 'inventory', 'orchestrator', 'briefing', 'review'].includes(command)) operation = 'doctor.read';
    else if (command === 'sync-hosts' && subcommand === 'status') operation = 'status.read';
    else if (command === 'sync-hosts') operation = 'host.sync';
    else if (command === 'world' && subcommand === 'entities') operation = 'status.read';
    else if (command === 'world' && (!subcommand || subcommand === 'rebuild')) operation = 'world.rebuild';
    else if (['maintain', 'nightly'].includes(command)) operation = 'maintenance.mutate';
    else if (command === 'migrate' && subcommand === 'legacy-drop') operation = 'legacy.drop';
    else if (command === 'handoff' && subcommand === 'inspect') operation = 'status.read';
    else if (
      ['snapshot', 'audit', 'watch', 'import-openclaw', 'import-bundle', 'export-bundle', 'handoff', 'passport'].includes(command)
      || (command === 'control' && subcommand === 'apply')
      || (command === 'surface' && subcommand === 'build')
      || (command === 'synthesis' && (!subcommand || subcommand === 'build'))
      || (command === 'transcript' && subcommand === 'sync')
      || (command === 'vault' && ['sync', 'inbox'].includes(subcommand))
      || (command === 'wiki' && ['project', 'reconcile'].includes(subcommand))
      || (command === 'migrate' && Boolean(subcommand))
    ) operation = 'candidate.write';
    else if (
      ['surface', 'transcript', 'vault', 'wiki'].includes(command)
      || (command === 'synthesis' && !subcommand)
    ) operation = 'status.read';
  }
  if (!operation) fail('GIGABRAIN_CANDIDATE_UNKNOWN_OPERATION', `${entry}:${args.join(' ')}`);
  return Object.freeze({ access: READ_OPERATIONS.has(operation) ? 'read' : 'write', operation });
};

const candidateSignalsPresent = (config = {}) => Boolean(
  process.env.GIGABRAIN_CANDIDATE_RECEIPT_PATH
  || process.env.GIGABRAIN_RELEASE_ROOT
  || process.env.GIGABRAIN_CANDIDATE_REGISTRY_PATH
);

const databaseLocation = (db) => {
  try {
    const value = typeof db?.location === 'function' ? db.location() : '';
    return value && value !== ':memory:' ? path.resolve(String(value)) : '';
  } catch {
    return '';
  }
};

const assertConfiguredCandidateOperation = ({ operation, config = {}, registryPath = '', db = null, now, operatorUid } = {}) => {
  if (!candidateSignalsPresent(config)) return Object.freeze({ allowed: true, bypassed: true, operation });
  const configRegistry = path.resolve(String(config?.runtime?.paths?.registryPath || ''));
  const effectiveRegistry = registryPath ? path.resolve(registryPath) : databaseLocation(db) || configRegistry;
  const envRegistry = process.env.GIGABRAIN_CANDIDATE_REGISTRY_PATH
    ? path.resolve(process.env.GIGABRAIN_CANDIDATE_REGISTRY_PATH) : '';
  if (
    !process.env.GIGABRAIN_CANDIDATE_RECEIPT_PATH
    || !fs.existsSync(process.env.GIGABRAIN_CANDIDATE_RECEIPT_PATH)
  ) {
    return assertCandidateOperationAllowed({
      operation,
      receiptPath: '',
      registryPath: effectiveRegistry || envRegistry,
      releaseRoot: process.env.GIGABRAIN_RELEASE_ROOT,
      now,
      operatorUid,
    });
  }
  if (!envRegistry || !effectiveRegistry || effectiveRegistry !== envRegistry) {
    fail('GIGABRAIN_CANDIDATE_IDENTITY_CONFIG_REGISTRY_MISMATCH');
  }
  return assertCandidateOperationAllowed({
    operation,
    receiptPath: process.env.GIGABRAIN_CANDIDATE_RECEIPT_PATH,
    registryPath: effectiveRegistry,
    releaseRoot: process.env.GIGABRAIN_RELEASE_ROOT,
    now,
    operatorUid,
  });
};

export {
  OPERATION_REQUIREMENTS,
  assertCandidateOperationAllowed,
  assertConfiguredCandidateOperation,
  classifyCandidateOperation,
};

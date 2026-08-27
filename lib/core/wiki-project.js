/**
 * GigaBrain idea #5 — git-versioned LLM-wiki projection of the ledger +
 * human-edit round-trip ("the learning leg").
 *
 * The SQLite ledger stays the SOURCE OF TRUTH. This module maintains a
 * git-tracked markdown PROJECTION of the arbitrated CURRENT belief set (one
 * file per scope/topic, with [src/trust/since] provenance footers) and a
 * HUMAN-EDIT ROUND-TRIP that ingests operator corrections back into the ledger
 * at a trust tier ABOVE any agent, through the existing adjudication path.
 *
 * Two nightly steps, ordered RECONCILE → PROJECT each cycle:
 *
 *   wiki_reconcile (FIRST): detect human edits = git commits to the wiki tree
 *     NOT authored by GigaBrain, since the last GENERATED commit. Round-trip
 *     each edited fact as a new `human_wiki` source (trust above own_agent),
 *     recording a REPLACE adjudication against the agent fact it overrides and
 *     re-arbitrating the touched slot so the human correction WINS.
 *
 *   wiki_project (SECOND): materialize the now-updated arbitrated CURRENT
 *     belief set into the markdown tree DETERMINISTICALLY (stable key ordering
 *     so diffs are meaningful), then git-commit as a GigaBrain-authored commit.
 *     `git log` becomes the consolidation history; `git blame` a second audit
 *     trail beside the ledger.
 *
 * ORDERING — the main correctness risk (a human edit must NEVER be clobbered by
 * a regeneration before it is reconciled). Defenses, START-SAFE (prefer
 * preserving the human edit over a clean regeneration):
 *   1. reconcile runs BEFORE project every cycle: human edits are ingested into
 *      the ledger FIRST, so the subsequent regeneration projects the
 *      now-corrected belief set — the regeneration reproduces the human's fact
 *      rather than overwriting it.
 *   2. project tracks the last-GENERATED SHA (the commit GigaBrain itself last
 *      wrote, recorded in .gigabrain-wiki-state.json). If HEAD has moved past
 *      that SHA via a NON-GigaBrain commit, there is an UN-RECONCILED human
 *      edit; project REFUSES to regenerate (returns skipped: 'unreconciled')
 *      rather than overwrite it. The caller runs reconcile first; only once HEAD
 *      is back at a GigaBrain commit (or reconcile advanced it) does project run.
 *   3. native.wiki.enabled:false (DEFAULT) → both steps are a zero-cost no-op:
 *      no git repo is created, no disk is touched.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertWriteAllowed, resolveWriteMode } from '../compat/write-policy.js';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  listCurrentMemories,
  upsertCurrentMemory,
  updateCurrentStatus,
  recordAdjudication,
  getCurrentMemory,
  withProjectionMutationBatch,
} from './projection-store.js';
import { runBeliefArbitration } from './belief-arbitration.js';
import { projectArbitrationBeliefRows } from './world-model.js';
import { ingestConfidence } from './host-trust.js';
import { sha1 } from './native-sync.js';

// GigaBrain's commit identity. A commit authored by THIS name/email is a
// machine-generated projection; ANY OTHER author on the wiki tree is a human
// edit. The marker also rides the commit message for belt-and-braces detection.
const WIKI_AUTHOR_NAME = 'GigaBrain';
const WIKI_AUTHOR_EMAIL = 'gigabrain@localhost';
const WIKI_COMMIT_MARKER = '[gigabrain-wiki]';
// The human-edit round-trip stamps facts under this host so host-trust's `human`
// tier (above every agent) decides arbitration in the operator's favor.
const HUMAN_WIKI_HOST = 'human_wiki';
// State file (git-tracked sibling of the markdown tree) recording the last
// GigaBrain-generated commit SHA + the projection fingerprint, so a re-projection
// with no belief change is a byte-stable no-op and the ordering guard can tell a
// human commit from its own.
const STATE_FILE = '.gigabrain-wiki-state.json';

// --- config -----------------------------------------------------------------

const expandHome = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return value;
  const home = os.homedir() || process.env.HOME || '';
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
};

const resolveWikiConfig = (config) => {
  const wiki = config?.native?.wiki && typeof config.native.wiki === 'object'
    ? config.native.wiki
    : {};
  return {
    enabled: wiki.enabled === true,
    dir: expandHome(wiki.dir || '~/.gigabrain/wiki'),
  };
};

// --- git (thin, deterministic, never throws across the no-op boundary) -------

const git = (dir, args, { allowFail = false } = {}) => {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Deterministic, hermetic identity for the GENERATED commit. Author AND
        // committer are pinned so detection (`git log --format=%ae`) is exact
        // and reproducible regardless of the operator's global git config.
        GIT_AUTHOR_NAME: WIKI_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: WIKI_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: WIKI_AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: WIKI_AUTHOR_EMAIL,
      },
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
};

const isGitRepo = (dir) => {
  if (!fs.existsSync(dir)) return false;
  const root = git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!root) return false;
  try {
    // A configured wiki directory nested inside an unrelated worktree must not
    // inherit or commit into that parent repository. It is a wiki repository
    // only when its own canonical path is the Git top-level.
    return fs.realpathSync(root) === fs.realpathSync(dir);
  } catch {
    return false;
  }
};

const ensureGitRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  if (!isGitRepo(dir)) {
    git(dir, ['init', '--quiet']);
  }
  // The state file is LOCAL projection metadata, not part of the co-owned wiki.
  // Ignoring it keeps it out of human commits AND out of reconcile's markdown
  // diff, so its churn never looks like a human edit and never pollutes blame.
  const gitignore = path.join(dir, '.gitignore');
  let ignored = '';
  try { ignored = fs.readFileSync(gitignore, 'utf8'); } catch { ignored = ''; }
  if (!ignored.split('\n').some((l) => l.trim() === STATE_FILE)) {
    fs.writeFileSync(gitignore, `${ignored}${ignored && !ignored.endsWith('\n') ? '\n' : ''}${STATE_FILE}\n`, 'utf8');
  }
  return dir;
};

const headSha = (dir) => git(dir, ['rev-parse', 'HEAD'], { allowFail: true });

const hasCommits = (dir) => Boolean(headSha(dir));

// Author email of a commit; one half of GigaBrain-commit detection. Empty/unknown
// → treated as human (start-safe: an unattributable commit is assumed to be a
// human edit so it is never silently overwritten).
const commitAuthorEmail = (dir, sha) => {
  const out = git(dir, ['log', '-1', '--format=%ae', String(sha)], { allowFail: true });
  return String(out || '').trim();
};

// Full commit subject+body; the OTHER half of detection. The marker
// ('[gigabrain-wiki]') must be present, NOT just the author email. Author email
// alone is forgeable (any human can `git config`/`--author` to gigabrain@localhost),
// and a spoofed author silently treated as GigaBrain would let projectWiki
// regenerate OVER the human edit while reconcile never ingests it = silent
// human-edit loss (CLOBBER). Empty/unknown message → '' (no marker → HUMAN).
const commitMessage = (dir, sha) => {
  const out = git(dir, ['log', '-1', '--format=%B', String(sha)], { allowFail: true });
  return String(out || '');
};

// A commit is GigaBrain's OWN projection commit ONLY if BOTH the pinned author
// email AND the projection marker are present. Either missing (or any git
// log/parse failure → both come back '') ⇒ treat as HUMAN. START-SAFE: when
// unsure we (a) do NOT regenerate over the commit and (b) DO ingest it, so a
// human edit — even one author-spoofed as gigabrain@localhost — is never
// clobbered and never silently dropped.
const isGigabrainCommit = (dir, sha) => {
  const authoredByGigabrain = commitAuthorEmail(dir, sha) === WIKI_AUTHOR_EMAIL;
  if (!authoredByGigabrain) return false;
  return commitMessage(dir, sha).includes(WIKI_COMMIT_MARKER);
};

// --- state -------------------------------------------------------------------

const readStateDocument = (dir) => {
  const file = path.join(dir, STATE_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, state: {}, valid: false };
    }
    return { exists: true, state: parsed, valid: true };
  } catch (error) {
    return { exists: fs.existsSync(file), state: {}, valid: false, error };
  }
};

const readState = (dir) => readStateDocument(dir).state;

const writeStateFile = (dir, state, { faultInjector } = {}) => {
  const statePath = path.join(dir, STATE_FILE);
  const tempPath = path.join(dir, `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const context = { statePath, tempPath };
  const inject = (stage) => {
    if (typeof faultInjector === 'function') faultInjector(stage, context);
  };
  let fileDescriptor = null;
  let directoryDescriptor = null;
  try {
    fileDescriptor = fs.openSync(
      tempPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    inject('after_temp_open');
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    inject('after_temp_write');
    fs.fsyncSync(fileDescriptor);
    inject('after_temp_fsync');
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    fs.renameSync(tempPath, statePath);
    inject('after_state_rename');
    directoryDescriptor = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(directoryDescriptor);
    inject('after_directory_fsync');
  } finally {
    if (fileDescriptor !== null) {
      try { fs.closeSync(fileDescriptor); } catch { /* already closed */ }
    }
    if (directoryDescriptor !== null) {
      try { fs.closeSync(directoryDescriptor); } catch { /* already closed */ }
    }
    try { fs.rmSync(tempPath, { force: true }); } catch { /* cleanup must not mask the original failure */ }
  }
};

const ensureWikiReconcileReceiptStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_wiki_reconcile_receipts (
      operation_id TEXT PRIMARY KEY,
      wiki_dir TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      state_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_wiki_reconcile_head
      ON memory_wiki_reconcile_receipts(wiki_dir, base_sha, head_sha);
  `);
};

const discoverWikiReconcileReceipt = (db, wikiDir, headShaValue) => {
  const exists = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='memory_wiki_reconcile_receipts'
  `).get();
  if (!exists) return { hasReceipts: false, receipt: null };
  const canonicalDir = path.resolve(wikiDir);
  const rows = db.prepare(`
    SELECT operation_id, wiki_dir, base_sha, head_sha, created_at, summary_json, state_json
    FROM memory_wiki_reconcile_receipts
    WHERE wiki_dir=?
    ORDER BY created_at DESC, rowid DESC
  `).all(canonicalDir);
  const matches = rows.filter((row) => String(row.head_sha || '') === String(headShaValue || ''));
  if (matches.length > 1) {
    throw new Error(`WIKI_RECEIPT_AMBIGUOUS:${canonicalDir}:${headShaValue}`);
  }
  if (matches.length === 0) return { hasReceipts: rows.length > 0, receipt: null };
  const receipt = matches[0];
  const expectedOperationId = `wiki-reconcile-${sha1(`${canonicalDir}\n${receipt.base_sha}\n${receipt.head_sha}`)}`;
  let storedSummary;
  let storedState;
  try {
    storedSummary = JSON.parse(String(receipt.summary_json || ''));
    storedState = JSON.parse(String(receipt.state_json || ''));
  } catch {
    throw new Error(`WIKI_RECEIPT_MISMATCH:${canonicalDir}:${headShaValue}`);
  }
  const valid = String(receipt.operation_id || '') === expectedOperationId
    && path.resolve(String(receipt.wiki_dir || '')) === canonicalDir
    && String(receipt.head_sha || '') === String(headShaValue || '')
    && storedSummary && typeof storedSummary === 'object' && !Array.isArray(storedSummary)
    && String(storedSummary.operation_id || '') === String(receipt.operation_id || '')
    && storedState && typeof storedState === 'object' && !Array.isArray(storedState)
    && String(storedState.generatedSha || '') === String(headShaValue || '');
  if (!valid) throw new Error(`WIKI_RECEIPT_MISMATCH:${canonicalDir}:${headShaValue}`);
  return { hasReceipts: true, receipt: { ...receipt, storedSummary, storedState } };
};

const scopedWikiBeliefProjector = (touchedMemoryIds, baseProjector) => (args = {}) => {
  const rows = (typeof baseProjector === 'function' ? baseProjector(args) : []) || [];
  const slotKeyOf = (row) => `${String(row?.entity_id || '').trim()}|${String(row?.payload?.claim_slot || '').trim()}`;
  const touchedSlots = new Set();
  for (const row of rows) {
    if (!touchedMemoryIds.has(String(row?.source_memory_id || ''))) continue;
    const slot = String(row?.payload?.claim_slot || '').trim();
    if (slot) touchedSlots.add(slotKeyOf(row));
  }
  if (touchedSlots.size === 0) return [];
  return rows.filter((row) => touchedSlots.has(slotKeyOf(row)));
};

// --- projection (deterministic markdown materialization) ---------------------

// One belief → one stable provenance footer. Trust tier is the ingest band the
// source maps to (legible without re-deriving arbitration). `since` is the
// event/assertion time the fact has been believed from.
const trustLabel = (row) => {
  const host = String(row.source_host || row.source_agent || '').trim().toLowerCase();
  if (host === HUMAN_WIKI_HOST) return 'human';
  // ingestConfidence is the band the arbiter weighs; surface it rounded so the
  // footer is human-legible and stable.
  const conf = ingestConfidence(host, String(row.source_kind || ''), {});
  return conf.toFixed(2);
};

const provenanceFooter = (row) => {
  const src = String(row.source_host || row.source_agent || row.source || 'unknown').trim() || 'unknown';
  const since = String(row.valid_from || row.content_time || row.created_at || '').slice(0, 10) || 'unknown';
  return `  _[src:${src} · trust:${trustLabel(row)} · since:${since}]_`;
};

// DETERMINISTIC grouping key. Scope is the natural topic partition of the
// arbitrated belief set (shared / profile:user / project scopes); one file per
// scope keeps the tree legible AND fully reproducible without depending on the
// heavyweight entity-mention pipeline. The filename is a slugged, collision-safe
// projection of the scope so the tree is git- and filesystem-portable.
const groupKeyForRow = (row) => String(row.scope || 'shared').trim() || 'shared';

const slugForGroup = (groupKey) => {
  const slug = String(groupKey)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'shared';
};

// Render ONE group's markdown. Beliefs are sorted by (content, memory_id) so the
// output is BYTE-STABLE across runs with no belief change — the diff-meaningful
// invariant. The file body never embeds a timestamp or run id; the only volatile
// state lives in STATE_FILE, so an unchanged belief set produces identical bytes.
const renderGroupMarkdown = (groupKey, rows) => {
  const sorted = rows.slice().sort((a, b) => {
    const ca = String(a.content || '');
    const cb = String(b.content || '');
    if (ca !== cb) return ca < cb ? -1 : 1;
    const ia = String(a.memory_id || '');
    const ib = String(b.memory_id || '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
  const lines = [`# ${groupKey}`, ''];
  for (const row of sorted) {
    lines.push(`- ${String(row.content || '').trim()}`);
    lines.push(provenanceFooter(row));
  }
  lines.push('');
  return lines.join('\n');
};

// Compute the desired markdown tree (relativePath → content) from the active
// belief set. Pure function of the ledger rows: same rows → same bytes.
const computeProjectionTree = (db) => {
  const rows = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
  const groups = new Map();
  for (const row of rows) {
    const key = groupKeyForRow(row);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  const tree = new Map();
  // Stable file ordering by group key so the directory listing is reproducible.
  const sortedKeys = Array.from(groups.keys()).sort();
  for (const key of sortedKeys) {
    const rel = path.join('entities', `${slugForGroup(key)}.md`);
    tree.set(rel, renderGroupMarkdown(key, groups.get(key)));
  }
  return tree;
};

// Fingerprint of the desired tree — drives the byte-stable no-op: if it equals
// the fingerprint of the last GENERATED commit, project is a no-op.
const fingerprintTree = (tree) => {
  const parts = [];
  for (const rel of Array.from(tree.keys()).sort()) {
    parts.push(`${rel}\u0000${sha1(tree.get(rel))}`);
  }
  return sha1(parts.join('\u0001'));
};

// List the wiki's CURRENTLY-tracked generated markdown files (so a group that
// disappeared from the belief set is removed from the tree, not orphaned).
const listTrackedMarkdown = (dir) => {
  const out = git(dir, ['ls-files', 'entities'], { allowFail: true });
  if (!out) return [];
  return out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.md'));
};

// --- PROJECT step ------------------------------------------------------------

/**
 * Materialize the arbitrated CURRENT belief set into the git wiki tree and
 * commit it as a GigaBrain-authored commit. DETERMINISTIC + byte-stable: a
 * re-projection with no belief change makes no commit.
 *
 * ORDERING GUARD: if HEAD is a NON-GigaBrain commit (an un-reconciled human
 * edit), project REFUSES (skipped:'unreconciled') so it never clobbers a human
 * edit before reconcile has ingested it.
 *
 * @returns {object} summary
 */
const projectWiki = ({ db, config, dryRun = false, stateFaultInjector } = {}) => {
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'wiki.project' });
  const wiki = resolveWikiConfig(config);
  const summary = {
    step: 'wiki_project',
    enabled: wiki.enabled,
    committed: false,
    changed: false,
    files: 0,
    removed: 0,
    sha: null,
    skipped: null,
  };
  // DEFAULT disabled → zero-cost no-op. No repo, no disk.
  if (!wiki.enabled) return summary;

  const dir = wiki.dir;
  const tree = computeProjectionTree(db);
  summary.files = tree.size;
  const fingerprint = fingerprintTree(tree);

  if (dryRun) {
    summary.fingerprint = fingerprint;
    return summary;
  }

  ensureGitRepo(dir);

  // ORDERING GUARD (start-safe): if HEAD is a NON-GigaBrain commit that we have
  // NOT yet reconciled (HEAD !== the SHA reconcile last marked ingested), there
  // is an un-reconciled human edit. Do NOT regenerate over it — defer to
  // reconcile, which ingests the edit and advances `generatedSha` to HEAD. Once
  // reconcile has marked HEAD ingested (generatedSha === HEAD), regeneration is
  // SAFE: the human's fact is already in the ledger and will be reproduced.
  if (hasCommits(dir)) {
    const head = headSha(dir);
    const reconciledSha = String(readState(dir).generatedSha || '');
    if (!isGigabrainCommit(dir, head) && reconciledSha !== head) {
      summary.skipped = 'unreconciled';
      summary.sha = head;
      return summary;
    }
  }

  const state = readState(dir);
  // Byte-stable no-op: the desired belief-set fingerprint is unchanged since the
  // last GigaBrain projection. We reach here only when HEAD is GigaBrain-authored
  // (the ordering guard above), so an unchanged fingerprint means there is
  // nothing new to project → no spurious commit. (A human edit would have been
  // a NON-GigaBrain HEAD and short-circuited at the guard.)
  if (state.fingerprint === fingerprint && state.generatedSha) {
    summary.fingerprint = fingerprint;
    summary.skipped = 'unchanged';
    return summary;
  }

  // Reconcile the on-disk tree to the desired tree: write/overwrite generated
  // files, remove generated files whose group disappeared.
  const entitiesDir = path.join(dir, 'entities');
  fs.mkdirSync(entitiesDir, { recursive: true });
  const desiredRel = new Set(tree.keys());
  const tracked = listTrackedMarkdown(dir);
  for (const rel of tracked) {
    if (!desiredRel.has(rel)) {
      const full = path.join(dir, rel);
      try { fs.rmSync(full, { force: true }); } catch { /* best-effort */ }
      summary.removed += 1;
    }
  }
  for (const [rel, content] of tree.entries()) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  // Stage everything (markdown + .gitignore). The state file is gitignored, so
  // it never enters the commit and never noises reconcile's diff.
  git(dir, ['add', '-A']);
  const statusOut = git(dir, ['status', '--porcelain'], { allowFail: true }) || '';
  if (statusOut.trim() === '' && hasCommits(dir)) {
    // Byte-stable no-op safety net: desired markdown matches HEAD's tree exactly
    // (the fingerprint guard was bypassed, e.g. a fresh/cleared state file). Just
    // record state pointing at HEAD; no markdown commit.
    summary.fingerprint = fingerprint;
    summary.skipped = 'unchanged';
    writeStateFile(dir, { fingerprint, generatedSha: headSha(dir) }, { faultInjector: stateFaultInjector });
    return summary;
  }

  // ONE GigaBrain-authored projection commit holds the markdown. `generatedSha`
  // = this commit; reconcile diffs FROM it to HEAD to find human edits made
  // afterward ("everything since the last GigaBrain projection is a human
  // edit"). The state file (gitignored, local metadata) records it on disk and
  // is authoritative for reconcile's diff base.
  git(dir, ['commit', '--quiet', '-m', `${WIKI_COMMIT_MARKER} project ${tree.size} group(s)`]);
  summary.sha = headSha(dir);
  writeStateFile(dir, { fingerprint, generatedSha: summary.sha }, { faultInjector: stateFaultInjector });
  summary.committed = true;
  summary.changed = true;
  summary.projectionSha = summary.sha;
  return summary;
};

// --- RECONCILE step ----------------------------------------------------------

// Parse a generated markdown group file into { content, src, since } facts.
// Footer format mirrors provenanceFooter; a `- ` bullet followed by its footer.
const parseGroupFacts = (text) => {
  const lines = String(text || '').split('\n');
  const facts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const bullet = line.match(/^- (.+)$/);
    if (!bullet) continue;
    const content = bullet[1].trim();
    if (!content) continue;
    let src = '';
    const footer = (lines[i + 1] || '').match(/_\[src:([^·\]]+)/);
    if (footer) src = footer[1].trim();
    facts.push({ content, src });
  }
  return facts;
};

// Read a tree path's content at a given git ref (or null if absent).
const fileAtRef = (dir, ref, rel) => git(dir, ['show', `${ref}:${rel}`], { allowFail: true });

// Read a tree path's content from the working tree (HEAD checkout), or null.
const fileFromDisk = (dir, rel) => {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
};

// Map a group file's relative path back to its scope group key. Reverse of
// slugForGroup is lossy, so reconcile derives the scope from the active belief
// set: it matches the human-edited content against the ledger by scope. We pass
// the slug through and resolve the scope from existing rows in that file.

/**
 * Detect human edits to the wiki tree and round-trip them into the ledger.
 *
 * Human edit = the diff of the generated markdown tree between the last
 * GigaBrain-generated commit (state.generatedSha) and HEAD, where HEAD (or an
 * intervening commit) is NOT authored by GigaBrain. Each NEW/CHANGED bullet
 * whose source is not already human_wiki is ingested as a `human_wiki` fact
 * (trust above any agent), a REPLACE adjudication is recorded against the agent
 * fact it overrides (same scope), and the touched slot is re-arbitrated so the
 * human correction WINS.
 *
 * @returns {object} summary
 */
const reconcileWiki = ({
  db,
  config,
  dryRun = false,
  faultInjector,
  completionFaultInjector,
  stateFaultInjector,
} = {}) => {
  assertWriteAllowed({ mode: resolveWriteMode(config), operation: 'wiki.reconcile' });
  const wiki = resolveWikiConfig(config);
  const summary = {
    step: 'wiki_reconcile',
    enabled: wiki.enabled,
    human_edits: 0,
    ingested: 0,
    adjudicated: 0,
    superseded: 0,
    // Pure human DELETIONS (a fact removed from the wiki with nothing replacing
    // it). Each is recorded as a high-trust STALE adjudication + supersession
    // (a tombstone) — the human's removal is an explicit operator decision, not
    // a silent drop.
    deleted: 0,
    tombstoned: 0,
    arbitration_verdicts: 0,
    skipped: null,
  };
  if (!wiki.enabled) return summary;

  const dir = wiki.dir;
  if (!isGitRepo(dir) || !hasCommits(dir)) {
    summary.skipped = 'no_repo_or_commits';
    return summary;
  }

  const stateDocument = readStateDocument(dir);
  const state = stateDocument.state;
  const baseSha = String(state.generatedSha || '').trim();
  const head = headSha(dir);
  const completeExternalState = (result, statePayload) => {
    if (db.isTransaction === true) {
      return { ...result, completion_deferred: true };
    }
    if (typeof completionFaultInjector === 'function') {
      completionFaultInjector('before_wiki_state_completion');
    }
    writeStateFile(dir, statePayload, { faultInjector: stateFaultInjector });
    return result;
  };
  if (stateDocument.valid && baseSha === head) {
    summary.skipped = 'head_is_generated';
    return summary;
  }
  const discovered = discoverWikiReconcileReceipt(db, dir, head);
  if (discovered.receipt) {
    const resumed = {
      ...discovered.receipt.storedSummary,
      operation_id: discovered.receipt.operation_id,
      resumed: true,
    };
    return dryRun
      ? { ...resumed, completion_deferred: true }
      : completeExternalState(resumed, discovered.receipt.storedState);
  }
  if (!stateDocument.valid) {
    if (discovered.hasReceipts) {
      throw new Error(`WIKI_RECEIPT_MISMATCH:${path.resolve(dir)}:${head}`);
    }
    if (stateDocument.exists) {
      throw new Error(`WIKI_STATE_UNRECOVERABLE:${path.resolve(dir)}:${head}`);
    }
  }
  // No generated baseline yet, or HEAD IS the generated commit → nothing a human
  // could have edited since we last wrote. (Start-safe: if baseSha is unknown we
  // do not guess — the next project run sets it.)
  if (!baseSha) {
    summary.skipped = 'no_generated_baseline';
    return summary;
  }
  // HEAD authored by GigaBrain AND no human commit in between → no human edit.
  // Detect any NON-GigaBrain commit in (baseSha, HEAD].
  const revs = git(dir, ['rev-list', `${baseSha}..${head}`], { allowFail: true });
  const revList = revs ? revs.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const humanCommits = revList.filter((sha) => !isGigabrainCommit(dir, sha));
  if (humanCommits.length === 0) {
    summary.skipped = 'no_human_commits';
    return summary;
  }

  // Diff the generated markdown files between baseSha and HEAD. A file that
  // changed carries the human's edited facts.
  const changedOut = git(dir, ['diff', '--name-only', baseSha, head, '--', 'entities'], { allowFail: true });
  const changedFiles = changedOut
    ? changedOut.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.md'))
    : [];

  const operationId = `wiki-reconcile-${sha1(`${path.resolve(dir)}\n${baseSha}\n${head}`)}`;
  summary.operation_id = operationId;

  const editPlans = [];
  for (const rel of changedFiles) {
    const beforeText = fileAtRef(dir, baseSha, rel);
    const afterText = fileFromDisk(dir, rel) ?? fileAtRef(dir, head, rel);
    const beforeFacts = parseGroupFacts(beforeText || '');
    const afterFacts = parseGroupFacts(afterText || '');
    const beforeContents = new Set(beforeFacts.map((f) => f.content));
    const afterContents = new Set(afterFacts.map((f) => f.content));

    const slug = path.basename(rel, '.md');
    const added = afterFacts.filter(
      (f) => !beforeContents.has(f.content)
        && String(f.src || '').toLowerCase() !== HUMAN_WIKI_HOST,
    );
    const removedContents = beforeFacts
      .map((f) => f.content)
      .filter((c) => !afterContents.has(c));

    summary.human_edits += added.length;
    editPlans.push({ added, removedContents, slug });
  }
  if (dryRun) return summary;

  ensureWikiReconcileReceiptStore(db);
  const nowIso = new Date().toISOString();
  const touched = new Set();
  const inject = (stage) => {
    if (typeof faultInjector === 'function') faultInjector(stage, { operation_id: operationId, wiki_dir: dir });
  };
  const stateAfter = { ...state, generatedSha: head, fingerprint: null };
  const callerOwned = db.isTransaction === true;
  withProjectionMutationBatch({ db, operationId }, (tx) => {
    const findRemovedTarget = (removedContent, scope, rows) => rows.find(
      (row) => String(row.content || '').trim() === removedContent
        && groupKeyForRow(row) === scope
        && String(row.source_host || row.source_agent || '').toLowerCase() !== HUMAN_WIKI_HOST,
    );
    const ingestHumanFact = (content, scope, slug) => {
      const memoryId = `human_wiki:${sha1(`${scope} ${content}`)}`;
      if (!getCurrentMemory(db, memoryId)) {
        upsertCurrentMemory(db, {
          memory_id: memoryId,
          type: 'USER_FACT',
          content,
          source: 'wiki_reconcile',
          source_agent: HUMAN_WIKI_HOST,
          source_host: HUMAN_WIKI_HOST,
          source_layer: 'host_memory',
          source_kind: 'human_edit',
          confidence: ingestConfidence(HUMAN_WIKI_HOST, 'human_edit', config),
          scope,
          status: 'active',
          content_time: nowIso,
          tags: ['human_wiki', `wiki_file:${slug}`, 'source_kind:human_edit'],
        }, {
          event: {
            action: 'wiki_reconcile_ingested',
            component: 'wiki_reconcile',
            payload: { scope, wiki_file: slug },
            reason_codes: ['human_wiki_ingest'],
            run_id: operationId,
          },
          faultInjector,
          operationId,
          tx,
        });
        summary.ingested += 1;
      }
      return memoryId;
    };

    for (const plan of editPlans) {
      const activeRows = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
      const scopeForFile = (() => {
        for (const row of activeRows) {
          if (slugForGroup(groupKeyForRow(row)) === plan.slug) return groupKeyForRow(row);
        }
        return 'shared';
      })();
      const unpairedRemoved = plan.removedContents.map((content) => ({
        content,
        target: findRemovedTarget(content, scopeForFile, activeRows),
      }));
      const takeRemovedPartner = (addedFact) => {
        const addedSlot = String(addedFact.slot || '').trim();
        if (addedSlot) {
          const index = unpairedRemoved.findIndex(
            (entry) => String(entry.target?.claim_slot || '').trim() === addedSlot,
          );
          if (index >= 0) return unpairedRemoved.splice(index, 1)[0];
        }
        return unpairedRemoved.length > 0 ? unpairedRemoved.shift() : null;
      };

      for (const fact of plan.added) {
        const content = fact.content;
        const memoryId = ingestHumanFact(content, scopeForFile, plan.slug);
        touched.add(memoryId);
        const target = takeRemovedPartner(fact)?.target;
        if (!target) continue;
        recordAdjudication(db, {
          memoryId: target.memory_id,
          state: 'REPLACE',
          candidateContent: content,
          decisionOp: 'UPDATE',
          confidence: ingestConfidence(HUMAN_WIKI_HOST, 'human_edit', config),
          reason: 'human_wiki edit overrides agent fact',
          scope: scopeForFile,
          agentId: HUMAN_WIKI_HOST,
          runId: operationId,
        });
        inject('after_adjudication');
        summary.adjudicated += 1;
        updateCurrentStatus(db, target.memory_id, 'superseded', {
          superseded_by: memoryId,
          timestamp: nowIso,
        }, {
          event: {
            action: 'wiki_reconcile_superseded',
            component: 'wiki_reconcile',
            payload: { human_memory_id: memoryId, scope: scopeForFile },
            reason_codes: ['human_wiki_replace'],
            run_id: operationId,
          },
          faultInjector,
          operationId,
          tx,
        });
        summary.superseded += 1;
        touched.add(target.memory_id);
      }

      for (const entry of unpairedRemoved) {
        summary.deleted += 1;
        const target = entry.target;
        if (!target) continue;
        recordAdjudication(db, {
          memoryId: target.memory_id,
          state: 'STALE',
          candidateContent: '',
          decisionOp: 'RETIRE',
          confidence: ingestConfidence(HUMAN_WIKI_HOST, 'human_edit', config),
          reason: 'human_wiki deletion retires agent fact',
          scope: scopeForFile,
          agentId: HUMAN_WIKI_HOST,
          runId: operationId,
        });
        inject('after_adjudication');
        summary.adjudicated += 1;
        updateCurrentStatus(db, target.memory_id, 'superseded', {
          timestamp: nowIso,
        }, {
          event: {
            action: 'wiki_reconcile_tombstoned',
            component: 'wiki_reconcile',
            payload: { scope: scopeForFile },
            reason_codes: ['human_wiki_delete'],
            run_id: operationId,
          },
          faultInjector,
          operationId,
          tx,
        });
        summary.superseded += 1;
        summary.tombstoned += 1;
        touched.add(target.memory_id);
      }
    }

    if (touched.size > 0) {
      const arbitration = runBeliefArbitration({
        db,
        config,
        faultInjector,
        operationId,
        projectBeliefRows: scopedWikiBeliefProjector(touched, projectArbitrationBeliefRows),
        tx,
      });
      summary.arbitration_verdicts = Number(arbitration?.counts?.verdicts || 0);
    }
    summary.reconciledSha = head;
    if (summary.human_edits === 0 && summary.deleted === 0) summary.reconciledEmpty = true;
    db.prepare(`
      INSERT INTO memory_wiki_reconcile_receipts (
        operation_id, wiki_dir, base_sha, head_sha, created_at, summary_json, state_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      operationId,
      path.resolve(dir),
      baseSha,
      head,
      nowIso,
      JSON.stringify(summary),
      JSON.stringify(stateAfter),
    );
    inject('after_wiki_baseline');
  });

  if (callerOwned) return { ...summary, completion_deferred: true };
  return completeExternalState(summary, stateAfter);
};

export {
  resolveWikiConfig,
  projectWiki,
  reconcileWiki,
  computeProjectionTree,
  fingerprintTree,
  parseGroupFacts,
  groupKeyForRow,
  slugForGroup,
  WIKI_AUTHOR_NAME,
  WIKI_AUTHOR_EMAIL,
  WIKI_COMMIT_MARKER,
  HUMAN_WIKI_HOST,
  STATE_FILE,
};

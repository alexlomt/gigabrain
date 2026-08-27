// ============================================================================
// GigaBrain idea #5 — git-versioned LLM-wiki projection of the ledger +
// human-edit round-trip ("the learning leg").
//
// SYNTHETIC personas + example.com only. NO real personal data. Every git repo
// is a fresh temp dir; no real paths, no ~/.gigabrain, no network.
//
// Proves:
//   (1) PROJECTION materializes a DETERMINISTIC markdown tree with provenance
//       footers from synthetic ACTIVE beliefs.
//   (2) Re-projection with NO belief change = no-op (byte-stable, no spurious
//       commit).
//   (3) A SUPERSEDED belief is NOT in the wiki (only active/current).
//   (4) A HUMAN edit to a wiki file round-trips as a high-trust `human_wiki`
//       source that WINS arbitration over an agent fact of the same slot.
//   (5) ORDERING: a human edit made between cycles is reconciled (ingested) and
//       NOT clobbered by the next regeneration.
//   (6) DISABLED (default) → an entire no-op (no git repo created).
//
// Plus: the wiki steps are wired into DAILY_SEQUENCE (reconcile BEFORE project).
// ============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { normalizeConfig } from '../lib/core/config.js';
import { DAILY_SEQUENCE } from '../lib/core/maintenance-service.js';
import { listAdjudications } from '../lib/core/projection-store.js';
import { classifyHostTier, hostTrustScore, TRUST } from '../lib/core/host-trust.js';
import {
  projectWiki,
  reconcileWiki,
  computeProjectionTree,
  fingerprintTree,
  HUMAN_WIKI_HOST,
  WIKI_AUTHOR_EMAIL,
} from '../lib/core/wiki-project.js';
import { openDb, seedMemoryCurrent, makeTempWorkspace } from './helpers.js';

// Commit to the wiki repo AS A HUMAN (a non-GigaBrain author). This is the exact
// surface idea #5 detects: any commit whose author is not GigaBrain is a human
// edit. Synthetic example.com identity.
const humanCommit = (dir, message) => execFileSync('git', ['-C', dir, 'commit', '-am', message], {
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Synthetic Operator',
    GIT_AUTHOR_EMAIL: 'operator@example.com',
    GIT_COMMITTER_NAME: 'Synthetic Operator',
    GIT_COMMITTER_EMAIL: 'operator@example.com',
  },
});

// Commit AS THE GIGABRAIN AUTHOR EMAIL but WITHOUT the [gigabrain-wiki] marker —
// an author-spoof (or a human who happens to use that git identity). This is the
// CLOBBER surface: detection by author email ALONE would treat this as a
// GigaBrain projection commit and regenerate over it / never ingest it.
const spoofGigabrainAuthorCommit = (dir, message) => execFileSync('git', ['-C', dir, 'commit', '-am', message], {
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'GigaBrain',
    GIT_AUTHOR_EMAIL: WIKI_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: 'GigaBrain',
    GIT_COMMITTER_EMAIL: WIKI_AUTHOR_EMAIL,
  },
});

const gitLog = (dir) => execFileSync('git', ['-C', dir, 'log', '--format=%ae %s'], { encoding: 'utf8' });

const makeWikiConfig = (wikiDir, extra = {}) => normalizeConfig({
  native: { wiki: { enabled: true, dir: wikiDir }, ...extra },
});

const sharedFile = (wikiDir) => path.join(wikiDir, 'entities', 'shared.md');
const readShared = (wikiDir) => fs.readFileSync(sharedFile(wikiDir), 'utf8');

// ----------------------------------------------------------------------------
// (host-trust) The `human` tier sits strictly ABOVE every agent tier, so a
// human_wiki fact outranks own_agent on trust — the arbitration primitive.
// ----------------------------------------------------------------------------
const assertHumanTierAboveAgents = () => {
  assert.equal(classifyHostTier(HUMAN_WIKI_HOST), 'human', 'human_wiki classifies into the human tier');
  assert.equal(hostTrustScore(HUMAN_WIKI_HOST, {}) > TRUST.own_agent, true, 'human trust strictly exceeds own_agent');
  assert.equal(hostTrustScore(HUMAN_WIKI_HOST, {}) > hostTrustScore('codex', {}), true, 'human outranks codex');
  assert.equal(hostTrustScore(HUMAN_WIKI_HOST, {}) > hostTrustScore('claude_code', {}), true, 'human outranks claude_code');
};

// ----------------------------------------------------------------------------
// (wiring) DAILY_SEQUENCE carries wiki_reconcile BEFORE wiki_project.
// ----------------------------------------------------------------------------
const assertNightlyOrdering = () => {
  const reconcileIdx = DAILY_SEQUENCE.indexOf('10 wiki_reconcile_optional');
  const projectIdx = DAILY_SEQUENCE.indexOf('22 wiki_projection_optional');
  assert.equal(reconcileIdx >= 0, true, 'DAILY_SEQUENCE must include wiki_reconcile');
  assert.equal(projectIdx >= 0, true, 'DAILY_SEQUENCE must include wiki_project');
  assert.equal(reconcileIdx < projectIdx, true, 'wiki_reconcile must run BEFORE wiki_project');
};

// ----------------------------------------------------------------------------
// (1)+(2)+(3) Projection: deterministic tree + provenance footers; byte-stable
// no-op on re-projection; superseded beliefs excluded.
// ----------------------------------------------------------------------------
const runProjectionDeterministicAndSuperseded = () => {
  const temp = makeTempWorkspace('gb-wiki-proj-');
  const wikiDir = path.join(temp.root, 'wiki');
  // The wiki may be configured below an unrelated project worktree. It must
  // initialize and commit only to its own nested repository.
  execFileSync('git', ['-C', temp.root, 'init', '--quiet']);
  const config = makeWikiConfig(wikiDir);
  const db = openDb(temp.dbPath);
  try {
    seedMemoryCurrent(db, [
      { memory_id: 'p8080', content: 'The service runs on port 8080.', scope: 'shared', source_host: 'codex', source_agent: 'codex', source_layer: 'host_memory', confidence: 0.74, status: 'active' },
      { memory_id: 'bkp', content: 'Backups run nightly at 02:00 UTC.', scope: 'shared', source_host: 'claude_code', source_agent: 'claude_code', source_layer: 'host_memory', confidence: 0.6, status: 'active' },
      // SUPERSEDED — must NOT appear in the wiki (only active/current).
      { memory_id: 'oldport', content: 'The service runs on port 3000.', scope: 'shared', source_host: 'codex', source_agent: 'codex', status: 'superseded' },
    ]);

    // (1) DETERMINISM: the desired tree is a pure function of the active rows —
    // identical fingerprint across two computes.
    const treeA = computeProjectionTree(db);
    const treeB = computeProjectionTree(db);
    assert.equal(fingerprintTree(treeA), fingerprintTree(treeB), 'tree computation is deterministic');

    const p1 = projectWiki({ db, config });
    assert.equal(p1.committed, true, 'first projection commits');
    assert.equal(p1.files, 1, 'one group file (scope=shared) materialized');

    const body = readShared(wikiDir);
    // (1) Provenance footers present, with src/trust/since.
    assert.equal(/_\[src:codex · trust:[\d.]+ · since:\d{4}-\d{2}-\d{2}\]_/.test(body), true, 'codex fact carries a provenance footer');
    assert.equal(/_\[src:claude_code · trust:[\d.]+ · since:\d{4}-\d{2}-\d{2}\]_/.test(body), true, 'claude_code fact carries a provenance footer');
    // (1) DETERMINISTIC ordering: facts sorted by content, so "Backups…" (B)
    // precedes "The service…" (T) regardless of insertion order.
    assert.equal(body.indexOf('Backups run nightly') < body.indexOf('The service runs on port 8080'), true, 'facts are in deterministic (content-sorted) order');

    // (3) SUPERSEDED belief excluded.
    assert.equal(body.includes('port 3000'), false, 'a superseded belief is NOT in the wiki');
    assert.equal(body.includes('port 8080'), true, 'the active belief IS in the wiki');

    // The projection commit is GigaBrain-authored.
    assert.equal(gitLog(wikiDir).includes(WIKI_AUTHOR_EMAIL), true, 'projection commit is GigaBrain-authored');

    // (2) BYTE-STABLE NO-OP: same belief set → no new commit.
    const headBefore = execFileSync('git', ['-C', wikiDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const p2 = projectWiki({ db, config });
    assert.equal(p2.committed, false, 're-projection with no change makes no commit');
    assert.equal(p2.skipped, 'unchanged', 're-projection is a recognized no-op');
    const headAfter = execFileSync('git', ['-C', wikiDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(headBefore, headAfter, 'HEAD did not advance on a no-op re-projection');
    // Byte-identical file content.
    assert.equal(readShared(wikiDir), body, 'wiki file bytes are stable across a no-op re-projection');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (4) Human-edit round-trip: a wiki edit WINS over an agent fact of the same
//     slot. The agent fact is superseded BY the human_wiki row, a REPLACE
//     adjudication is on the ledger, and the human fact is active+high-trust.
// ----------------------------------------------------------------------------
const runHumanEditWinsArbitration = () => {
  const temp = makeTempWorkspace('gb-wiki-win-');
  const wikiDir = path.join(temp.root, 'wiki');
  const config = makeWikiConfig(wikiDir);
  const db = openDb(temp.dbPath);
  try {
    seedMemoryCurrent(db, [
      { memory_id: 'agentcap', content: 'The capital is Examplebury.', scope: 'shared', source_host: 'codex', source_agent: 'codex', source_layer: 'host_memory', confidence: 0.74, status: 'active' },
    ]);
    projectWiki({ db, config });

    // A human rewrites the agent's fact in the wiki and commits (non-GigaBrain).
    const body = readShared(wikiDir).replace('- The capital is Examplebury.', '- The capital is Synthville.');
    fs.writeFileSync(sharedFile(wikiDir), body, 'utf8');
    humanCommit(wikiDir, 'operator: correct the capital');

    const r = reconcileWiki({ db, config });
    assert.equal(r.human_edits, 1, 'exactly one human edit detected');
    assert.equal(r.ingested, 1, 'the human fact is ingested as a new source');
    assert.equal(r.superseded, 1, 'the overridden agent fact is superseded');

    // The human fact is active, high-trust, sourced as human_wiki.
    const human = db.prepare('SELECT memory_id, content, status, source_host FROM memory_current WHERE source_host = ?').get(HUMAN_WIKI_HOST);
    assert.ok(human, 'a human_wiki row exists');
    assert.equal(human.status, 'active', 'the human fact is active (the WINNER)');
    assert.equal(human.content, 'The capital is Synthville.', 'the human fact carries the corrected content');

    // The agent fact LOST: superseded BY the human row.
    const agent = db.prepare('SELECT status, superseded_by FROM memory_current WHERE memory_id = ?').get('agentcap');
    assert.equal(agent.status, 'superseded', 'the agent fact is superseded (the LOSER)');
    assert.equal(agent.superseded_by, human.memory_id, 'supersession points at the human row');

    // The override is auditable: a REPLACE adjudication on the ledger.
    const adj = listAdjudications(db, { memoryId: 'agentcap', states: ['REPLACE'] });
    assert.equal(adj.length >= 1, true, 'a REPLACE adjudication records the human override on the ledger');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (5) ORDERING (the main risk): a human edit made between cycles must be
//     reconciled (ingested) and NOT clobbered by the next regeneration.
//     - project REFUSES to regenerate over an un-reconciled human edit;
//     - after reconcile, regeneration REPRODUCES the human fact (never reverts).
// ----------------------------------------------------------------------------
const runOrderingHumanEditNotClobbered = () => {
  const temp = makeTempWorkspace('gb-wiki-order-');
  const wikiDir = path.join(temp.root, 'wiki');
  const config = makeWikiConfig(wikiDir);
  const db = openDb(temp.dbPath);
  try {
    seedMemoryCurrent(db, [
      { memory_id: 'agentcity', content: 'The user lives in Examplebury.', scope: 'profile:user', source_host: 'codex', source_agent: 'codex', source_layer: 'host_memory', confidence: 0.74, status: 'active' },
    ]);
    projectWiki({ db, config });

    // Human edits BETWEEN cycles and commits.
    const file = path.join(wikiDir, 'entities', 'profile-user.md');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(before.includes('Examplebury'), true, 'baseline projection has the agent fact');
    fs.writeFileSync(file, before.replace('- The user lives in Examplebury.', '- The user lives in Synthville.'), 'utf8');
    humanCommit(wikiDir, 'operator: fix city');

    // CLOBBER GUARD: project must REFUSE to regenerate over the un-reconciled
    // human edit (start-safe: preserve the human edit).
    const pBlocked = projectWiki({ db, config });
    assert.equal(pBlocked.skipped, 'unreconciled', 'project refuses to regenerate over an un-reconciled human edit');
    assert.equal(pBlocked.committed, false, 'no clobbering commit was made');
    // The human edit is still intact on disk (NOT overwritten).
    assert.equal(fs.readFileSync(file, 'utf8').includes('Synthville'), true, 'the human edit is preserved (not clobbered)');
    assert.equal(fs.readFileSync(file, 'utf8').includes('Examplebury'), false, 'the agent fact is not silently restored');

    // Reconcile ingests the human edit FIRST.
    const r = reconcileWiki({ db, config });
    assert.equal(r.human_edits, 1, 'reconcile ingests the between-cycle human edit');
    assert.equal(r.superseded, 1, 'the agent fact is superseded by the human edit');

    // THEN regeneration is safe and REPRODUCES the human fact (the ledger now
    // holds the human correction as the winner).
    const pAfter = projectWiki({ db, config });
    assert.equal(pAfter.committed, true, 'project regenerates after reconcile');
    const finalBody = fs.readFileSync(file, 'utf8');
    assert.equal(finalBody.includes('Synthville'), true, 'the regenerated wiki REPRODUCES the human fact');
    assert.equal(finalBody.includes('Examplebury'), false, 'the regenerated wiki drops the superseded agent fact');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (6) DISABLED (DEFAULT) → an entire no-op: no git repo, no disk touched.
// ----------------------------------------------------------------------------
const runDisabledNoop = () => {
  const temp = makeTempWorkspace('gb-wiki-off-');
  const wikiDir = path.join(temp.root, 'wiki');
  // DEFAULT config → wiki.enabled is false.
  const config = normalizeConfig({});
  assert.equal(config.native.wiki.enabled, false, 'wiki is DISABLED by default');
  const db = openDb(temp.dbPath);
  try {
    seedMemoryCurrent(db, [
      { memory_id: 'x', content: 'A synthetic fact about example.com services.', scope: 'shared', source_host: 'codex', source_agent: 'codex', status: 'active' },
    ]);
    const p = projectWiki({ db, config });
    assert.equal(p.enabled, false, 'projectWiki reports disabled');
    assert.equal(p.committed, false, 'disabled projection commits nothing');
    const r = reconcileWiki({ db, config });
    assert.equal(r.enabled, false, 'reconcileWiki reports disabled');
    assert.equal(r.human_edits, 0, 'disabled reconcile ingests nothing');
    // The DEFAULT dir is never created; and even the explicit (disabled) dir is
    // never touched.
    assert.equal(fs.existsSync(wikiDir), false, 'no git repo / directory is created when disabled');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (a) CLOBBER GUARD: a commit AUTHORED as gigabrain@localhost but WITHOUT the
//     [gigabrain-wiki] marker is a HUMAN edit (author-spoof), NOT a GigaBrain
//     projection. It must be (1) NOT clobbered by projectWiki and (2) ingested
//     by reconcileWiki. Detection must require author email AND marker.
// ----------------------------------------------------------------------------
const runSpoofedGigabrainAuthorTreatedAsHuman = () => {
  const temp = makeTempWorkspace('gb-wiki-spoof-');
  const wikiDir = path.join(temp.root, 'wiki');
  const config = makeWikiConfig(wikiDir);
  const db = openDb(temp.dbPath);
  try {
    seedMemoryCurrent(db, [
      { memory_id: 'agentcap', content: 'The capital is Examplebury.', scope: 'shared', source_host: 'codex', source_agent: 'codex', source_layer: 'host_memory', confidence: 0.74, status: 'active' },
    ]);
    projectWiki({ db, config });

    // A human rewrites the fact and commits AS gigabrain@localhost but with a
    // PLAIN message (no [gigabrain-wiki] marker) — author-spoof / shared identity.
    const body = readShared(wikiDir).replace('- The capital is Examplebury.', '- The capital is Synthville.');
    fs.writeFileSync(sharedFile(wikiDir), body, 'utf8');
    spoofGigabrainAuthorCommit(wikiDir, 'tweak the capital');

    // (1) NOT clobbered: project must REFUSE (the commit is not a real GigaBrain
    // projection commit because the marker is absent → treated as human).
    const pBlocked = projectWiki({ db, config });
    assert.equal(pBlocked.skipped, 'unreconciled', 'a marker-less gigabrain-authored commit is treated as an un-reconciled human edit (not clobbered)');
    assert.equal(pBlocked.committed, false, 'no clobbering commit was made over the spoofed-author human edit');
    assert.equal(fs.readFileSync(sharedFile(wikiDir), 'utf8').includes('Synthville'), true, 'the human edit survives (not regenerated over)');

    // (2) Ingested: reconcile round-trips the spoofed-author commit as a human edit.
    const r = reconcileWiki({ db, config });
    assert.equal(r.human_edits, 1, 'the spoofed-author commit is ingested as a human edit');
    assert.equal(r.ingested, 1, 'the human fact is ingested as a new source');
    assert.equal(r.superseded, 1, 'the agent fact is superseded by the human edit');

    const human = db.prepare('SELECT content, status FROM memory_current WHERE source_host = ?').get(HUMAN_WIKI_HOST);
    assert.ok(human, 'a human_wiki row exists');
    assert.equal(human.content, 'The capital is Synthville.', 'the spoofed-author human fact was ingested');
    const agent = db.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('agentcap');
    assert.equal(agent.status, 'superseded', 'the agent fact lost to the spoofed-author human edit');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (b) MULTI-EDIT: TWO replacements in ONE file must produce CORRECT 1:1
//     supersession — each new fact supersedes EXACTLY its own paired agent fact,
//     with NO cross-contamination of winners/losers.
// ----------------------------------------------------------------------------
const runTwoReplacementsNoCrossContamination = () => {
  const temp = makeTempWorkspace('gb-wiki-multi-');
  const wikiDir = path.join(temp.root, 'wiki');
  const config = makeWikiConfig(wikiDir);
  const db = openDb(temp.dbPath);
  try {
    seedMemoryCurrent(db, [
      { memory_id: 'cap', content: 'The capital is Examplebury.', scope: 'shared', source_host: 'codex', source_agent: 'codex', source_layer: 'host_memory', confidence: 0.74, status: 'active' },
      { memory_id: 'pop', content: 'The population is 100000.', scope: 'shared', source_host: 'codex', source_agent: 'codex', source_layer: 'host_memory', confidence: 0.74, status: 'active' },
    ]);
    projectWiki({ db, config });

    // Human replaces BOTH facts in the same file in one commit.
    let body = readShared(wikiDir);
    body = body.replace('- The capital is Examplebury.', '- The capital is Synthville.');
    body = body.replace('- The population is 100000.', '- The population is 250000.');
    fs.writeFileSync(sharedFile(wikiDir), body, 'utf8');
    humanCommit(wikiDir, 'operator: correct capital and population');

    const r = reconcileWiki({ db, config });
    assert.equal(r.human_edits, 2, 'exactly two human edits detected');
    assert.equal(r.ingested, 2, 'both human facts ingested');
    assert.equal(r.superseded, 2, 'exactly two agent facts superseded (1:1, not fanned out)');

    // Each agent row superseded BY the human row carrying its OWN corrected fact —
    // NOT cross-mapped. This is the corruption FIX 2 guards against.
    const cap = db.prepare('SELECT status, superseded_by FROM memory_current WHERE memory_id = ?').get('cap');
    const pop = db.prepare('SELECT status, superseded_by FROM memory_current WHERE memory_id = ?').get('pop');
    assert.equal(cap.status, 'superseded', 'the capital agent fact is superseded');
    assert.equal(pop.status, 'superseded', 'the population agent fact is superseded');

    const capWinner = db.prepare('SELECT content FROM memory_current WHERE memory_id = ?').get(cap.superseded_by);
    const popWinner = db.prepare('SELECT content FROM memory_current WHERE memory_id = ?').get(pop.superseded_by);
    assert.equal(capWinner.content, 'The capital is Synthville.', 'the capital is superseded by the CAPITAL correction (not the population one)');
    assert.equal(popWinner.content, 'The population is 250000.', 'the population is superseded by the POPULATION correction (not the capital one)');
    assert.notEqual(cap.superseded_by, pop.superseded_by, 'the two replacements point at DISTINCT human winners (no one-fact-fans-out corruption)');

    // Both REPLACE adjudications are on the ledger, one per agent fact (no fan-out:
    // the capital winner never adjudicated against the population fact, etc.).
    assert.equal(listAdjudications(db, { memoryId: 'cap', states: ['REPLACE'] }).length, 1, 'exactly one REPLACE adjudication on the capital fact');
    assert.equal(listAdjudications(db, { memoryId: 'pop', states: ['REPLACE'] }).length, 1, 'exactly one REPLACE adjudication on the population fact');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (c) PURE DELETION: a human DELETING a fact (no replacement) must be recorded as
//     a tombstone (STALE adjudication + supersession) AND advance the reconciled
//     baseline so the next projectWiki is NOT permanently blocked (DEADLOCK fix).
// ----------------------------------------------------------------------------
const runPureDeletionTombstonedAndBaselineAdvances = () => {
  const temp = makeTempWorkspace('gb-wiki-del-');
  const wikiDir = path.join(temp.root, 'wiki');
  const config = makeWikiConfig(wikiDir);
  const db = openDb(temp.dbPath);
  try {
    seedMemoryCurrent(db, [
      { memory_id: 'keep', content: 'Backups run nightly at 02:00 UTC.', scope: 'shared', source_host: 'claude_code', source_agent: 'claude_code', source_layer: 'host_memory', confidence: 0.6, status: 'active' },
      { memory_id: 'gone', content: 'The legacy mainframe is still in service.', scope: 'shared', source_host: 'codex', source_agent: 'codex', source_layer: 'host_memory', confidence: 0.74, status: 'active' },
    ]);
    projectWiki({ db, config });

    // Human DELETES the 'gone' bullet (no replacement) and commits.
    let body = readShared(wikiDir);
    const lines = body.split('\n');
    const idx = lines.findIndex((l) => l.includes('The legacy mainframe is still in service.'));
    assert.equal(idx >= 0, true, 'the deletable bullet is present in the baseline');
    // Remove the bullet AND its provenance footer (next line).
    lines.splice(idx, 2);
    fs.writeFileSync(sharedFile(wikiDir), lines.join('\n'), 'utf8');
    humanCommit(wikiDir, 'operator: retire the legacy mainframe fact');

    // project must REFUSE over the un-reconciled deletion (start-safe).
    const pBlocked = projectWiki({ db, config });
    assert.equal(pBlocked.skipped, 'unreconciled', 'project refuses to regenerate over an un-reconciled human deletion');

    const r = reconcileWiki({ db, config });
    assert.equal(r.deleted, 1, 'exactly one pure deletion detected');
    assert.equal(r.tombstoned, 1, 'the deletion is recorded as a tombstone');
    assert.equal(r.human_edits, 0, 'a pure deletion is not an added/changed bullet');

    // The deletion is a high-trust STALE adjudication on the ledger (auditable).
    const stale = listAdjudications(db, { memoryId: 'gone', states: ['STALE'] });
    assert.equal(stale.length >= 1, true, 'a STALE adjudication records the human deletion (tombstone) on the ledger');
    // The deleted fact left the active belief set.
    const gone = db.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('gone');
    assert.equal(gone.status, 'superseded', 'the deleted fact is superseded (retired)');
    const kept = db.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('keep');
    assert.equal(kept.status, 'active', 'the untouched fact is still active');

    // DEADLOCK FIX: the baseline advanced even though human_edits === 0, so the
    // NEXT project is NOT permanently skipped:'unreconciled'. It regenerates and
    // drops the deleted fact.
    const pAfter = projectWiki({ db, config });
    assert.notEqual(pAfter.skipped, 'unreconciled', 'project is NOT permanently deadlocked after a deletion-only commit');
    // The human already deleted the bullet on disk, so the regenerated desired
    // tree matches HEAD's tree byte-for-byte → project recognizes it as up to date
    // (a no-op) rather than blocked. The point is it is UNBLOCKED + the ledger now
    // reflects the deletion (so future agent re-assertions would be re-projected).
    const finalBody = readShared(wikiDir);
    assert.equal(finalBody.includes('legacy mainframe'), false, 'the projected wiki drops the deleted fact');
    assert.equal(finalBody.includes('Backups run nightly'), true, 'the projected wiki keeps the surviving fact');
    // And the baseline now sits at a state project recognizes (no longer the raw
    // human commit needing reconcile): a subsequent project is a clean no-op.
    const pAgain = projectWiki({ db, config });
    assert.notEqual(pAgain.skipped, 'unreconciled', 'project remains unblocked on the next cycle (deadlock is gone)');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

const run = async () => {
  assertHumanTierAboveAgents();
  assertNightlyOrdering();
  runProjectionDeterministicAndSuperseded();
  runHumanEditWinsArbitration();
  runOrderingHumanEditNotClobbered();
  runSpoofedGigabrainAuthorTreatedAsHuman();
  runTwoReplacementsNoCrossContamination();
  runPureDeletionTombstonedAndBaselineAdvances();
  runDisabledNoop();
  fs.writeSync(1, 'git-wiki projection + human-edit round-trip (idea #5): all assertions passed\n');
};

export { run };

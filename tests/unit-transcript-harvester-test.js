// ============================================================================
// GigaBrain idea #1 — transcript / rollout CDC harvester.
//
// SYNTHETIC ONLY. Every rollout line here is INVENTED (synthetic personas +
// example.com). This test NEVER reads ~/.codex or ~/.claude — it builds temp
// synthetic .jsonl rollout files and points the config globs at them. NO real
// transcript content is committed.
//
// Asserts:
//   (1) synthetic codex + claude rollout jsonl → facts at the LOW transcript
//       trust tier with per-line provenance (source_kind=chat_history_hint);
//   (2) cursor incremental — a clean re-run reads no new bytes; an APPENDED
//       turn is picked up on the next run;
//   (3) an embedded secret is STRIPPED (never handed to the extractor / stored);
//   (4) the salience filter drops tool-result spam / boilerplate;
//   (5) a transcript fact does NOT outrank a deliberate memory of the same slot;
//   (6) disabled (default) → an entire no-op;
//   (7) offline / cloud-only provider → a graceful, loud-but-safe SKIP (no
//       extraction runs, the cursor is untouched).
//   (NET) NO network — global fetch + http(s).request are trapped + asserted
//         unused across every harvest (raw transcripts are local-only).
// ============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { harvestTranscripts, transcriptStatus, scoreTurnSalience, parseTurn } from '../lib/core/transcript-harvester.js';
import { ingestConfidence, TRUST } from '../lib/core/host-trust.js';
import { runBeliefArbitration } from '../lib/core/belief-arbitration.js';
import { projectArbitrationBeliefRows } from '../lib/core/world-model.js';
import { upsertCurrentMemory, listCurrentMemories } from '../lib/core/projection-store.js';
import { hashNormalized, normalizeContent } from '../lib/core/policy.js';
import { makeConfigObject, makeTempWorkspace, openDb } from './helpers.js';

// ----------------------------------------------------------------------------
// Synthetic rollout writers. A codex `.codex/sessions/<id>/rollout.jsonl` and a
// claude `.claude/projects/<proj>/<id>.jsonl`. Distinct envelope shapes on
// purpose, to prove the tolerant turn parser handles both.
// ----------------------------------------------------------------------------

const writeLines = (filePath, objects) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, objects.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
};
const appendLines = (filePath, objects) => {
  fs.appendFileSync(filePath, objects.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
};

// Codex rollout shape: flat {type:'message', role, content} + a nested
// {type:'response_item', payload:{role, content:[{type:'text',text}]}}.
const codexRollout = (extra = []) => ([
  { type: 'session_meta', payload: { id: 'sess-synthetic-1' } },
  { type: 'message', role: 'user', content: 'I always deploy the staging app to the eu-central-1 region.' },
  { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'text', text: 'Understood, I will target eu-central-1 for staging.' }] } },
  // tool noise — must be salience-dropped
  { type: 'message', role: 'assistant', content: 'tool_result: {"stdout":"ok","exit code":0}' },
  ...extra,
]);

// Claude projects shape: {type:'user'|'assistant', message:{role, content}}.
const claudeRollout = (extra = []) => ([
  { type: 'user', message: { role: 'user', content: 'My preferred database for new services is Postgres, never MySQL.' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] } },
  ...extra,
]);

// Deterministic LOCAL extractor hook: returns the turn text verbatim as one
// USER_FACT (mirrors the capture extract() contract). This is what makes the
// test hermetic — no Ollama, no network. isCloud derives from config.llm.provider.
const makeInjectedLlm = ({ calls } = {}) => ({
  extract: (transcript) => {
    if (calls) calls.push(String(transcript || ''));
    const content = String(transcript || '').replace(/\s+/g, ' ').trim();
    if (!content) return [];
    return [{ type: 'USER_FACT', content, confidence: 0.7 }];
  },
});

// Build a normalized config whose transcript globs point ONLY at our temp
// synthetic rollout root (so we never touch the real ~/.codex / ~/.claude).
const makeTranscriptConfig = (workspace, root, { enabled = true, globs, maxFiles = 50, maxTurns = 200, provider = 'none' } = {}) => {
  const base = normalizeConfig(makeConfigObject(workspace).plugins.entries.gigabrain.config);
  return {
    ...base,
    llm: { ...base.llm, provider },
    codex: { ...base.codex, projectRoot: workspace, defaultUserScope: 'profile:user' },
    native: {
      ...base.native,
      transcripts: {
        enabled,
        globs: globs || [
          path.join(root, '.codex', 'sessions', '**', '*.jsonl'),
          path.join(root, '.claude', 'projects', '**', '*.jsonl'),
        ],
        maxFiles,
        maxTurns,
      },
    },
  };
};

const factsForKind = (db, sourceKind) => db.prepare(`
  SELECT content, confidence, source_host, source_kind, source_path, source_line, tags
  FROM memory_current
  WHERE source_kind = ? AND status = 'active'
  ORDER BY content ASC
`).all(String(sourceKind));

// ----------------------------------------------------------------------------
// Network trap: a transcript harvest must make ZERO network calls.
// ----------------------------------------------------------------------------
const withNetworkTrap = async (fn) => {
  const calls = [];
  const origFetch = globalThis.fetch;
  const origHttp = http.request;
  const origHttps = https.request;
  globalThis.fetch = (...a) => { calls.push(['fetch', String(a[0])]); throw new Error('network call in transcript test'); };
  http.request = (...a) => { calls.push(['http', String(a[0])]); throw new Error('http.request in transcript test'); };
  https.request = (...a) => { calls.push(['https', String(a[0])]); throw new Error('https.request in transcript test'); };
  try {
    await fn();
  } finally {
    globalThis.fetch = origFetch;
    http.request = origHttp;
    https.request = origHttps;
  }
  assert.equal(calls.length, 0, `transcript harvest must make ZERO network calls; saw ${JSON.stringify(calls)}`);
};

// ----------------------------------------------------------------------------
// (1) codex + claude rollouts → transcript-tier facts with per-line provenance.
// ----------------------------------------------------------------------------
const runBasicHarvest = async () => {
  const temp = makeTempWorkspace('gb-transcript-basic-');
  const root = path.join(temp.root, 'home');
  const codexPath = path.join(root, '.codex', 'sessions', '2026', 'rollout-1.jsonl');
  const claudePath = path.join(root, '.claude', 'projects', 'demo', 'sess-2.jsonl');
  writeLines(codexPath, codexRollout());
  writeLines(claudePath, claudeRollout());

  const calls = [];
  const config = makeTranscriptConfig(temp.workspace, root);
  const db = openDb(temp.dbPath);
  try {
    const summary = harvestTranscripts({
      db, config, scope: 'profile:user', incremental: true,
      event: { __captureLlm: makeInjectedLlm({ calls }) },
      projectBeliefRows: projectArbitrationBeliefRows,
    });
    assert.equal(summary.enabled, true, 'harvest runs when enabled');
    assert.equal(summary.ok, true, 'harvest ok');
    assert.equal(summary.files_scanned >= 2, true, 'both rollout files scanned');
    assert.equal(summary.facts_extracted >= 2, true, 'facts mined from both rollouts');

    const rows = factsForKind(db, 'chat_history_hint');
    assert.equal(rows.length >= 2, true, 'transcript-tier facts present');
    const byContent = rows.map((r) => r.content);
    assert.equal(byContent.some((c) => c.includes('eu-central-1')), true, 'codex user fact stored');
    assert.equal(byContent.some((c) => c.includes('Postgres')), true, 'claude user fact stored');

    for (const row of rows) {
      assert.equal(row.source_kind, 'chat_history_hint', 'source_kind = chat_history_hint');
      assert.ok(['codex', 'claude_code'].includes(row.source_host), 'attributable host provenance');
      assert.ok(String(row.source_path).endsWith('.jsonl'), 'per-FILE provenance path');
      assert.equal(Number.isFinite(Number(row.source_line)) && Number(row.source_line) >= 1, true, 'per-LINE provenance');
      // LOW transcript trust tier: confidence at/below the transcript floor.
      assert.equal(Number(row.confidence) <= TRUST.transcript + 1e-9, true, `confidence at/below transcript floor (got ${row.confidence})`);
      const tags = JSON.parse(row.tags || '[]');
      assert.equal(tags.includes('transcript_sync'), true, 'tagged transcript_sync');
      assert.equal(tags.includes('trust_tier:transcript'), true, 'tagged trust_tier:transcript');
    }

    // The tool-noise assistant turn was salience-dropped → never extracted.
    assert.equal(calls.some((t) => /tool_result/.test(t)), false, 'tool-result spam never reached the extractor');

    // status rollup reflects the two scanned sources.
    const status = transcriptStatus({ db, config });
    assert.equal(status.enabled, true, 'status reports enabled');
    assert.equal(status.source_count >= 2, true, 'status lists both sources');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (2) cursor incremental — clean re-run reads nothing; an appended turn is
//     picked up next run.
// ----------------------------------------------------------------------------
const runCursorIncremental = async () => {
  const temp = makeTempWorkspace('gb-transcript-cursor-');
  const root = path.join(temp.root, 'home');
  const codexPath = path.join(root, '.codex', 'sessions', 'a', 'rollout.jsonl');
  writeLines(codexPath, codexRollout());
  const config = makeTranscriptConfig(temp.workspace, root);
  const db = openDb(temp.dbPath);
  try {
    const llm = { __captureLlm: makeInjectedLlm() };
    const first = harvestTranscripts({ db, config, scope: 'profile:user', incremental: true, event: llm, projectBeliefRows: projectArbitrationBeliefRows });
    assert.equal(first.facts_extracted >= 1, true, 'first run mines facts');
    const afterFirst = factsForKind(db, 'chat_history_hint').length;

    // Clean re-run: same bytes → the file is unchanged, no new facts.
    const second = harvestTranscripts({ db, config, scope: 'profile:user', incremental: true, event: llm, projectBeliefRows: projectArbitrationBeliefRows });
    assert.equal(second.files_unchanged >= 1, true, 'unchanged file skips via byte-offset cursor');
    assert.equal(second.facts_extracted, 0, 'clean re-run mines nothing new');
    assert.equal(factsForKind(db, 'chat_history_hint').length, afterFirst, 'no duplicate facts on re-run');

    // Append a NEW user turn — only the new bytes are read.
    appendLines(codexPath, [{ type: 'message', role: 'user', content: 'I prefer dark mode in every editor I use.' }]);
    const third = harvestTranscripts({ db, config, scope: 'profile:user', incremental: true, event: llm, projectBeliefRows: projectArbitrationBeliefRows });
    assert.equal(third.facts_extracted >= 1, true, 'appended turn is picked up');
    const rows = factsForKind(db, 'chat_history_hint');
    assert.equal(rows.some((r) => r.content.includes('dark mode')), true, 'the appended fact is stored');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (3) embedded secret is STRIPPED — never extracted, never stored.
// ----------------------------------------------------------------------------
const runSecretStripped = async () => {
  const temp = makeTempWorkspace('gb-transcript-secret-');
  const root = path.join(temp.root, 'home');
  const codexPath = path.join(root, '.codex', 'sessions', 'b', 'rollout.jsonl');
  writeLines(codexPath, codexRollout([
    { type: 'message', role: 'user', content: 'My deploy api_key=topsecretvalue123 must never reach the pipeline.' },
  ]));
  const config = makeTranscriptConfig(temp.workspace, root);
  const calls = [];
  const db = openDb(temp.dbPath);
  try {
    harvestTranscripts({ db, config, scope: 'profile:user', incremental: true, event: { __captureLlm: makeInjectedLlm({ calls }) }, projectBeliefRows: projectArbitrationBeliefRows });
    // The secret never reached the extractor (dropped pre-extraction).
    assert.equal(calls.some((t) => /topsecretvalue123/.test(t)), false, 'secret turn never reached the extractor');
    // And the literal secret appears NOWHERE in stored memory.
    const leaked = db.prepare(`
      SELECT COUNT(*) AS c FROM memory_current
      WHERE content LIKE '%topsecretvalue123%'
    `).get();
    assert.equal(Number(leaked.c), 0, 'secret is STRIPPED, never stored');
    // The non-secret facts in the same rollout still made it in.
    const ok = db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content LIKE '%eu-central-1%'").get();
    assert.equal(Number(ok.c) >= 1, true, 'non-secret facts in the same rollout are still ingested');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (4) salience filter drops tool-result spam + boilerplate.
// ----------------------------------------------------------------------------
const runSalienceFilter = async () => {
  // Unit-level assertions on the scorer directly.
  assert.equal(scoreTurnSalience({ role: 'assistant', text: 'tool_result: {"stdout":"done"}' }).keep, false, 'tool noise dropped');
  assert.equal(scoreTurnSalience({ role: 'user', text: 'ok' }).keep, false, 'boilerplate dropped');
  assert.equal(scoreTurnSalience({ role: 'user', text: 'thanks!' }).keep, false, 'thanks dropped');
  assert.equal(scoreTurnSalience({ role: 'user', text: 'I prefer window seats on long flights.' }).keep, true, 'durable user fact kept');
  assert.equal(scoreTurnSalience({ role: 'assistant', text: 'Here is a long explanation about how HTTP works in general, with lots of transient detail and no decision.' }).keep, false, 'transient assistant prose dropped');
  assert.equal(scoreTurnSalience({ role: 'assistant', text: 'Going forward we will always use Postgres for new services.' }).keep, true, 'assistant decision restatement kept');

  // Integration: a rollout that is MOSTLY spam yields only the salient facts.
  const temp = makeTempWorkspace('gb-transcript-salience-');
  const root = path.join(temp.root, 'home');
  const codexPath = path.join(root, '.codex', 'sessions', 'c', 'rollout.jsonl');
  writeLines(codexPath, [
    { type: 'message', role: 'assistant', content: 'tool_result: {"exit code":0}' },
    { type: 'message', role: 'user', content: 'ok' },
    { type: 'message', role: 'assistant', content: '$ git status' },
    { type: 'message', role: 'user', content: 'I live in Vienna and work as a backend engineer.' },
    { type: 'message', role: 'assistant', content: 'npm warn deprecated foo@1.0.0' },
  ]);
  const config = makeTranscriptConfig(temp.workspace, root);
  const calls = [];
  const db = openDb(temp.dbPath);
  try {
    const summary = harvestTranscripts({ db, config, scope: 'profile:user', incremental: true, event: { __captureLlm: makeInjectedLlm({ calls }) }, projectBeliefRows: projectArbitrationBeliefRows });
    assert.equal(summary.turns_dropped >= 3, true, 'most spam turns dropped by salience');
    assert.equal(calls.length, 1, 'only the single salient user turn reached the extractor');
    assert.equal(calls[0].includes('Vienna'), true, 'the salient turn is the durable user fact');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (5) a transcript fact does NOT outrank a deliberate memory of the same slot.
//     A deliberate, higher-trust memory ("user lives in Berlin") and a freshly-
//     mined contradicting transcript fact ("user lives in Vienna") are arbitrated
//     over the same user-anchored slot: the deliberate memory must WIN.
// ----------------------------------------------------------------------------
const runTranscriptNeverOutranks = async () => {
  const temp = makeTempWorkspace('gb-transcript-trust-');
  const root = path.join(temp.root, 'home');
  const scope = 'profile:user';
  const db = openDb(temp.dbPath);
  try {
    // Seed a DELIBERATE memory at own-agent trust (codex native_memory).
    const deliberateContent = 'I live in Berlin.';
    const dNorm = normalizeContent(deliberateContent);
    upsertCurrentMemory(db, {
      memory_id: 'deliberate:berlin',
      type: 'USER_FACT',
      content: deliberateContent,
      normalized: dNorm,
      source: 'host_sync',
      source_agent: 'codex',
      source_layer: 'host_memory',
      source_host: 'codex',
      source_kind: 'native_memory',
      sync_policy: 'read_only',
      confidence: ingestConfidence('codex', 'native_memory'),
      scope,
      status: 'active',
      tags: ['host_sync'],
    });

    // A contradicting transcript fact, mined now.
    const codexPath = path.join(root, '.codex', 'sessions', 'd', 'rollout.jsonl');
    writeLines(codexPath, [
      { type: 'message', role: 'user', content: 'I live in Vienna now, actually.' },
    ]);
    const config = makeTranscriptConfig(temp.workspace, root);
    const summary = harvestTranscripts({
      db, config, scope, incremental: true,
      event: { __captureLlm: makeInjectedLlm() },
      projectBeliefRows: projectArbitrationBeliefRows,
    });
    // The transcript fact was stored at the LOW floor.
    assert.equal(summary.facts_extracted >= 1, true, 'transcript fact mined');
    const transcriptRow = db.prepare("SELECT confidence FROM memory_current WHERE content LIKE '%Vienna%'").get();
    assert.ok(transcriptRow, 'transcript fact stored');
    assert.equal(Number(transcriptRow.confidence) <= TRUST.transcript + 1e-9, true, 'transcript fact at the low floor');

    // Arbitrate the shared slot directly (deterministic) and assert the
    // deliberate memory is NOT superseded by the lower-trust transcript fact.
    // conflict_groups>=1 proves the two are recognized as RIVALS over the same
    // user-anchored slot (so the no-supersession below is a real trust win, not
    // a vacuous pass where the arbiter never saw them as related).
    const arb = runBeliefArbitration({ db, config, projectBeliefRows: projectArbitrationBeliefRows });
    assert.equal(Number(arb?.counts?.conflict_groups || 0) >= 1, true, 'the deliberate + transcript facts are recognized as same-slot rivals');
    const deliberate = db.prepare("SELECT status FROM memory_current WHERE memory_id = 'deliberate:berlin'").get();
    assert.notEqual(deliberate.status, 'superseded', 'deliberate memory is NOT superseded by a transcript fact');
    assert.equal(deliberate.status, 'active', 'deliberate memory stays active (wins the slot on trust)');
    // The harvest summary should not have produced a verdict that flipped it.
    assert.ok(Number(summary.arbitration_verdicts) >= 0, 'arbitration ran without error');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (6) disabled (DEFAULT) → an entire no-op.
// ----------------------------------------------------------------------------
const runDisabledNoop = async () => {
  const temp = makeTempWorkspace('gb-transcript-disabled-');
  const root = path.join(temp.root, 'home');
  const codexPath = path.join(root, '.codex', 'sessions', 'e', 'rollout.jsonl');
  writeLines(codexPath, codexRollout());
  const config = makeTranscriptConfig(temp.workspace, root, { enabled: false });
  const calls = [];
  const db = openDb(temp.dbPath);
  try {
    const summary = harvestTranscripts({ db, config, scope: 'profile:user', incremental: true, event: { __captureLlm: makeInjectedLlm({ calls }) } });
    assert.equal(summary.enabled, false, 'disabled');
    assert.equal(summary.skipped_reason, 'disabled', 'reported as a disabled no-op');
    assert.equal(summary.files_scanned, 0, 'no files walked when disabled');
    assert.equal(calls.length, 0, 'extractor never invoked when disabled');
    assert.equal(factsForKind(db, 'chat_history_hint').length, 0, 'no facts stored when disabled');
    // The cursor table must not even exist (zero store creation).
    const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_transcript_sync_cursor'").get();
    assert.equal(tbl, undefined, 'disabled harvest creates no store (zero cost)');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (7) cloud-only provider → a graceful, loud-but-safe SKIP. No extraction runs,
//     the cursor is untouched (so the same bytes retry once local is available).
// ----------------------------------------------------------------------------
const runCloudOnlySkip = async () => {
  const temp = makeTempWorkspace('gb-transcript-cloud-');
  const root = path.join(temp.root, 'home');
  const codexPath = path.join(root, '.codex', 'sessions', 'f', 'rollout.jsonl');
  writeLines(codexPath, codexRollout());
  // A CLOUD provider configured — AND an injected hook (which would otherwise
  // extract). resolveCaptureLlm marks isCloud:true from the provider, so the
  // harvester MUST refuse to run the extractor over raw transcript text.
  const config = makeTranscriptConfig(temp.workspace, root, { provider: 'openclaw' });
  const calls = [];
  const db = openDb(temp.dbPath);
  try {
    const summary = harvestTranscripts({
      db, config, scope: 'profile:user', incremental: true,
      event: { __captureLlm: makeInjectedLlm({ calls }) },
    });
    assert.equal(summary.skipped_reason, 'cloud_provider', 'cloud provider → cloud_provider skip');
    assert.equal(summary.ok, true, 'cloud skip is graceful (ok), not an error');
    assert.ok(String(summary.warning || '').toLowerCase().includes('cloud'), 'loud warning names the cloud provider');
    assert.equal(calls.length, 0, 'extractor NEVER invoked under a cloud provider');
    assert.equal(summary.facts_extracted, 0, 'no facts mined under a cloud provider');
    assert.equal(factsForKind(db, 'chat_history_hint').length, 0, 'nothing stored under a cloud provider');

    // Offline / no-extractor case: provider 'none', no hook → llm_disabled skip.
    const offlineConfig = makeTranscriptConfig(temp.workspace, root, { provider: 'none' });
    const offline = harvestTranscripts({ db, config: offlineConfig, scope: 'profile:user', incremental: true, event: {} });
    assert.equal(offline.skipped_reason, 'llm_disabled', 'no local extractor → llm_disabled skip');
    assert.equal(offline.facts_extracted, 0, 'offline mines nothing');
    assert.equal(factsForKind(db, 'chat_history_hint').length, 0, 'offline stores nothing');
  } finally {
    db.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// parseTurn sanity (both shapes + reject system/tool).
const runParseTurnSanity = async () => {
  assert.deepEqual(parseTurn(JSON.stringify({ type: 'message', role: 'user', content: 'hi there' })), { role: 'user', text: 'hi there' });
  assert.deepEqual(parseTurn(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } })), { role: 'assistant', text: 'reply' });
  assert.equal(parseTurn(JSON.stringify({ type: 'message', role: 'system', content: 'sys' })), null, 'system turn rejected');
  assert.equal(parseTurn('not json'), null, 'malformed line → null (never throws)');
  assert.equal(parseTurn(JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'tool_use', name: 'bash' }] })), null, 'tool_use-only turn → no prose');
};

const run = async () => {
  await withNetworkTrap(async () => {
    await runBasicHarvest();
    await runCursorIncremental();
    await runSecretStripped();
    await runSalienceFilter();
    await runTranscriptNeverOutranks();
    await runDisabledNoop();
    await runCloudOnlySkip();
    await runParseTurnSanity();
  });
  console.log('unit-transcript-harvester-test: OK');
};

export default run;
export { run };

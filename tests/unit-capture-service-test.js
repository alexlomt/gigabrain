import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { parseMemoryNotes, captureFromEvent } from '../lib/core/capture-service.js';
import { normalizeContent, hashNormalized } from '../lib/core/policy.js';
import { ensureWorldModelStore } from '../lib/core/world-model.js';
import { makeTempWorkspace, makeConfigObject, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const notes = parseMemoryNotes(`
<memory_note type="FACT" confidence="0.93">Riley ist Jordan Partner.</memory_note>
<memory_note type="USERFACT" confidence="high">Jordan likes mozzarella.</memory_note>
  `);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].type, 'USER_FACT', 'FACT alias must map to USER_FACT');
  assert.equal(Number(notes[0].confidence || 0).toFixed(2), '0.93', 'numeric confidence must be parsed');
  assert.equal(notes[1].type, 'USER_FACT', 'USERFACT alias must map to USER_FACT');
  assert.equal(Number(notes[1].confidence || 0).toFixed(2), '0.90', 'symbolic confidence must be parsed');

  const ws = makeTempWorkspace('gb-v3-unit-capture-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    const summary = captureFromEvent({
      db,
      config,
      event: {
        scope: 'example-main',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        messages: [{ role: 'user', content: 'remember that Riley is Jordan partner.' }],
        text: '<memory_note type="FACT" confidence="0.88">Riley is Jordan partner.</memory_note>',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(summary.inserted, 1);
    const row = db.prepare(`
      SELECT type, content, confidence, source_layer, source_path, source_line
      FROM memory_current
      WHERE content LIKE '%Riley is Jordan partner.%'
      LIMIT 1
    `).get();
    assert.equal(String(row?.type || ''), 'USER_FACT');
    assert.equal(Number(row?.confidence || 0).toFixed(2), '0.88', 'captured confidence should respect note attribute');
    assert.equal(String(row?.source_layer || ''), 'native', 'explicit remember should link registry memory back to native markdown');
    assert.match(String(row?.source_path || ''), /MEMORY\.md$/, 'durable explicit remember in private scope should write to MEMORY.md');
    assert.equal(Number(row?.source_line || 0) > 0, true, 'native source line should be recorded');
    const memoryMd = fs.readFileSync(path.join(ws.workspace, 'MEMORY.md'), 'utf8');
    assert.match(memoryMd, /\[m:[0-9a-f-]{8,}\] Riley is Jordan partner\./i, 'MEMORY.md should contain linked dual-write entry');

    const sharedDurable = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'main',
        sessionKey: 'agent:main:group',
        messages: [{ role: 'user', content: 'remember that Jordan prefers peppermint tea.' }],
        text: '<memory_note type="PREFERENCE" confidence="0.9">Jordan prefers peppermint tea.</memory_note>',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(sharedDurable.inserted, 1, 'shared durable remember should still enter the registry');
    const sharedRow = db.prepare(`
      SELECT source_path, source_line
      FROM memory_current
      WHERE content = 'Jordan prefers peppermint tea.'
      LIMIT 1
    `).get();
    assert.match(String(sharedRow?.source_path || ''), /memory\/\d{4}-\d{2}-\d{2}\.md$/, 'shared durable remember should stay in the daily note instead of MEMORY.md');
    assert.equal(Number(sharedRow?.source_line || 0) > 0, true, 'shared durable remember should still record native provenance');

    const noisy = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        text: '<memory_note type="USER_FACT" confidence="0.5">User started a jabber on the 11th at 90kg</memory_note>',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(noisy.queued_review, 1, 'malformed low-confidence facts should be queued for review');
    const queued = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_current
      WHERE content LIKE '%jabber%'
    `).get();
    assert.equal(Number(queued?.c || 0), 0, 'malformed low-confidence fact should not be inserted as active memory');

    const nativeOnly = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        messages: [{ role: 'user', content: 'remember that I am travelling today and tired.' }],
        text: '<memory_note type="CONTEXT" confidence="0.84">User is travelling today and tired.</memory_note>',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(nativeOnly.inserted, 0, 'ephemeral remember intent should stay out of the durable registry');
    assert.equal(nativeOnly.native_only, 1, 'ephemeral remember intent should still write a native note');
    const dailyPath = path.join(ws.memoryRoot, `${new Date().toISOString().slice(0, 10)}.md`);
    assert.equal(fs.existsSync(dailyPath), true, "ephemeral remember intent should create today's daily note");
    const dailyBody = fs.readFileSync(dailyPath, 'utf8');
    assert.match(dailyBody, /User is travelling today and tired\./, 'daily note should contain the remembered ephemeral context');

    const missingNote = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        messages: [{ role: 'user', content: 'remember that I prefer herbal tea.' }],
        text: 'Okay, I will remember that.',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(missingNote.queued_review, 1, 'explicit remember without an internal memory note should be queued instead of being silently lost');
    const queuePath = path.join(ws.outputRoot, 'memory-review-queue.jsonl');
    assert.equal(fs.existsSync(queuePath), true, 'missing remember note should create a review queue row');
    const queueText = fs.readFileSync(queuePath, 'utf8');
    assert.match(queueText, /remember_intent_missing_note/, 'review queue should record the explicit remember failure reason');

    // Phase 0A: Thinking block contamination must be stripped before parsing
    const thinkingContaminated = parseMemoryNotes(`
<thinking>I should store a memory about the user's pet.</thinking>
<memory_note type="USER_FACT" confidence="0.9">User has a cat named Whiskers.</memory_note>
    `);
    assert.equal(thinkingContaminated.length, 1, 'thinking blocks must be stripped — note should still be parsed');
    assert.equal(thinkingContaminated[0].content, 'User has a cat named Whiskers.');

    const antlrThinking = parseMemoryNotes(`
<antlr:thinking>Let me consider what to store...</antlr:thinking>
<memory_note type="PREFERENCE" confidence="high">User prefers dark mode.</memory_note>
    `);
    assert.equal(antlrThinking.length, 1, 'antlr:thinking blocks must also be stripped');
    assert.equal(antlrThinking[0].content, 'User prefers dark mode.');

    const nestedThinkingNotes = parseMemoryNotes(`
<thinking>
The user mentioned something important.
<memory_note type="USER_FACT" confidence="0.8">Nested inside thinking — should be stripped.</memory_note>
</thinking>
<memory_note type="USER_FACT" confidence="0.85">Outside thinking — should be captured.</memory_note>
    `);
    assert.equal(nestedThinkingNotes.length, 1, 'memory_notes nested inside thinking blocks must be discarded');
    assert.match(nestedThinkingNotes[0].content, /Outside thinking/, 'only non-thinking memory_notes should survive');

    // -----------------------------------------------------------------------
    // U8: two-phase LLM capture. The LLM is MOCKED via event.__captureLlm (sync
    // hooks); no real Ollama is contacted, so this stays deterministic in CI.
    // -----------------------------------------------------------------------
    const verdictCount = () => Number(db.prepare(
      "SELECT COUNT(*) AS c FROM memory_events WHERE action = 'arbiter:verdict'",
    ).get()?.c || 0);
    const activeCount = (like) => Number(db.prepare(
      "SELECT COUNT(*) AS c FROM memory_current WHERE status = 'active' AND content LIKE ?",
    ).get(like)?.c || 0);

    // (1) Extraction: an UNTAGGED fact (no <memory_note>) is captured because the
    // extraction pass distills it. Heuristic capture would have lost it.
    const extracted = captureFromEvent({
      db,
      config,
      event: {
        scope: 'llmscope',
        agentId: 'main',
        sessionKey: 'agent:main:llm',
        messages: [{ role: 'assistant', content: 'The user mentioned they relocated to Lisbon last spring.' }],
        text: 'The user mentioned they relocated to Lisbon last spring.',
        __captureLlm: {
          extract: () => [{ type: 'USER_FACT', content: 'User relocated to Lisbon in spring.', confidence: 0.86 }],
          decide: () => ({ op: 'ADD', confidence: 0.86 }),
        },
      },
      runId: 'capture-unit-llm',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(extracted.extracted_facts, 1, 'extraction pass should distill one atomic fact from an untagged session');
    assert.equal(extracted.inserted, 1, 'extracted untagged fact should be inserted');
    assert.equal(extracted.llm_added, 1, 'ADD decision should be recorded');
    assert.equal(activeCount('%relocated to Lisbon%'), 1, 'extracted fact should be active in the store');

    // (2) Paraphrase -> UPDATE (not ADD). A reworded version of the existing
    // fact resolves to the existing memory id, so nothing new is inserted.
    const target = db.prepare(
      "SELECT memory_id FROM memory_current WHERE content LIKE '%relocated to Lisbon%' AND status = 'active' LIMIT 1",
    ).get();
    const beforeUpdate = activeCount('%Lisbon%');
    const updated = captureFromEvent({
      db,
      config,
      event: {
        scope: 'llmscope',
        agentId: 'main',
        sessionKey: 'agent:main:llm',
        text: '<memory_note type="USER_FACT" confidence="0.9">The user moved to Lisbon this past spring.</memory_note>',
        __captureLlm: {
          decide: () => ({ op: 'UPDATE', targetId: String(target.memory_id), confidence: 0.9 }),
        },
      },
      runId: 'capture-unit-llm',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(updated.llm_updated, 1, 'a paraphrase should resolve to UPDATE');
    assert.equal(updated.inserted, 0, 'UPDATE must NOT insert a new memory');
    assert.equal(activeCount('%Lisbon%'), beforeUpdate, 'UPDATE should not increase active Lisbon memories');
    // U4: UPDATE must PERSIST the refined fact onto the target row — content,
    // normalized/normalized_hash in sync, confidence=max(old,new), still active
    // (revision, not supersession), with a revision-marked ledger event.
    const revisedContent = 'The user moved to Lisbon this past spring.';
    const revised = db.prepare(
      'SELECT content, normalized, normalized_hash, status, confidence, updated_at FROM memory_current WHERE memory_id = ? LIMIT 1',
    ).get(String(target.memory_id));
    assert.equal(String(revised?.content || ''), revisedContent, 'UPDATE must persist the refined content onto the target row');
    assert.equal(String(revised?.status || ''), 'active', 'UPDATE is a revision — the target must NOT be superseded');
    assert.equal(String(revised?.normalized || ''), normalizeContent(revisedContent), 'normalized must follow the revised content');
    assert.equal(String(revised?.normalized_hash || ''), hashNormalized(normalizeContent(revisedContent)), 'normalized_hash must stay in sync with normalized');
    assert.equal(Number(revised?.confidence || 0).toFixed(2), '0.90', 'revision confidence should be max(old 0.86, new 0.9)');
    assert.equal(Boolean(revised?.updated_at), true, 'revision must refresh updated_at');
    const revisionEvent = db.prepare(
      "SELECT reason_codes FROM memory_events WHERE action = 'capture_llm_update' ORDER BY rowid DESC LIMIT 1",
    ).get();
    assert.match(String(revisionEvent?.reason_codes || ''), /revision/, 'UPDATE should emit a revision-marked event');

    // U4: the revised wording must dedupe as an EXACT duplicate on re-capture —
    // proves normalized/normalized_hash were kept consistent for future dedup.
    const dedupAfterUpdate = captureFromEvent({
      db,
      config,
      event: {
        scope: 'llmscope',
        agentId: 'main',
        sessionKey: 'agent:main:llm',
        text: `<memory_note type="USER_FACT" confidence="0.9">${revisedContent}</memory_note>`,
      },
      runId: 'capture-unit-llm',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(dedupAfterUpdate.dropped_exact_duplicate, 1, 'revised wording must hit exact dedup on re-capture');
    assert.equal(dedupAfterUpdate.inserted, 0, 'revised wording re-capture must not insert a new memory');

    // (3) Contradiction -> CONTRADICT + bi-temporal supersession (valid_until on
    // the loser) + an arbiter verdict event in the ledger.
    const verdictsBefore = verdictCount();
    const contradicted = captureFromEvent({
      db,
      config,
      event: {
        scope: 'llmscope',
        agentId: 'main',
        sessionKey: 'agent:main:llm',
        text: '<memory_note type="USER_FACT" confidence="0.95">The user has since moved from Lisbon to Berlin.</memory_note>',
        __captureLlm: {
          decide: () => ({ op: 'CONTRADICT', targetId: String(target.memory_id), confidence: 0.95 }),
        },
      },
      runId: 'capture-unit-llm',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(contradicted.llm_contradicted, 1, 'a conflicting fact should resolve to CONTRADICT');
    assert.equal(contradicted.inserted, 1, 'CONTRADICT should insert the winning (new) fact');
    const loser = db.prepare(
      'SELECT status, valid_until, superseded_by FROM memory_current WHERE memory_id = ? LIMIT 1',
    ).get(String(target.memory_id));
    assert.equal(String(loser?.status || ''), 'superseded', 'contradicted loser should be superseded');
    assert.equal(Boolean(loser?.valid_until), true, 'contradicted loser should have a valid_until (bi-temporal close)');
    assert.equal(Boolean(loser?.superseded_by), true, 'contradicted loser should point at its winner');
    assert.equal(verdictCount(), verdictsBefore + 1, 'CONTRADICT should emit exactly one arbiter verdict event');

    // (4) Secret pre-filter blocks an API_KEY candidate BEFORE any LLM call,
    // even when a decision hook is injected.
    let decideCalledForSecret = false;
    const syntheticSecret = ['sk', 'supersecret1234567890abcdef'].join('-');
    const secretBlocked = captureFromEvent({
      db,
      config,
      event: {
        scope: 'llmscope',
        agentId: 'main',
        sessionKey: 'agent:main:llm',
        text: `<memory_note type="USER_FACT" confidence="0.9">API_KEY=${syntheticSecret}</memory_note>`,
        __captureLlm: {
          decide: () => { decideCalledForSecret = true; return { op: 'ADD', confidence: 0.9 }; },
        },
      },
      runId: 'capture-unit-llm',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(secretBlocked.inserted, 0, 'a secret-bearing candidate must not be inserted');
    assert.equal(secretBlocked.rejected_junk >= 1, true, 'secret pre-filter should reject the candidate');
    assert.equal(decideCalledForSecret, false, 'secret pre-filter must run BEFORE the LLM decision');
    assert.equal(activeCount('%sk-supersecret%'), 0, 'secret value must never be stored');

    // -----------------------------------------------------------------------
    // U4: CONTRADICT must never misfire. A hallucinated targetId or a weak
    // decision routes to the review queue — neighbors[0] is never superseded.
    // -----------------------------------------------------------------------
    const berlin = db.prepare(
      "SELECT memory_id FROM memory_current WHERE content LIKE '%Berlin%' AND status = 'active' LIMIT 1",
    ).get();
    assert.equal(Boolean(berlin?.memory_id), true, 'CONTRADICT winner from (3) should be active');

    // (5) CONTRADICT with a hallucinated targetId -> review queue; the closest
    // neighbor stays active, no verdict, and the candidate is NOT lost.
    const verdictsBeforeHallucinated = verdictCount();
    const hallucinated = captureFromEvent({
      db,
      config,
      event: {
        scope: 'llmscope',
        agentId: 'main',
        sessionKey: 'agent:main:llm',
        text: '<memory_note type="USER_FACT" confidence="0.95">The user actually lives in Porto these days.</memory_note>',
        __captureLlm: {
          decide: () => ({ op: 'CONTRADICT', targetId: 'no-such-memory-id', confidence: 0.95 }),
        },
      },
      runId: 'capture-unit-llm',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(hallucinated.llm_contradicted, 0, 'hallucinated targetId must not count as a contradiction');
    assert.equal(hallucinated.inserted, 0, 'unverified contradiction must not insert a winner');
    assert.equal(hallucinated.queued_review, 1, 'unverified contradiction must be queued for review');
    assert.equal(verdictCount(), verdictsBeforeHallucinated, 'hallucinated targetId must not emit a verdict');
    const berlinAfterHallucinated = db.prepare(
      'SELECT status FROM memory_current WHERE memory_id = ? LIMIT 1',
    ).get(String(berlin.memory_id));
    assert.equal(String(berlinAfterHallucinated?.status || ''), 'active', 'neighbors[0] must NEVER be superseded on a hallucinated targetId');
    const queueAfterHallucinated = fs.readFileSync(queuePath, 'utf8');
    assert.match(queueAfterHallucinated, /capture_contradiction_unverified/, 'queue should carry the capture_contradiction_unverified reason code');
    assert.match(queueAfterHallucinated, /lives in Porto/, 'queued candidate content must be preserved (not lost)');

    // (6) CONTRADICT below the 0.75 confidence gate — even with a VALID
    // targetId — must queue for review instead of superseding.
    const verdictsBeforeWeak = verdictCount();
    const weak = captureFromEvent({
      db,
      config,
      event: {
        scope: 'llmscope',
        agentId: 'main',
        sessionKey: 'agent:main:llm',
        text: '<memory_note type="USER_FACT" confidence="0.9">The user is relocating to Madrid soon.</memory_note>',
        __captureLlm: {
          decide: () => ({ op: 'CONTRADICT', targetId: String(berlin.memory_id), confidence: 0.5 }),
        },
      },
      runId: 'capture-unit-llm',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(weak.llm_contradicted, 0, 'low-confidence CONTRADICT must not supersede');
    assert.equal(weak.inserted, 0, 'low-confidence CONTRADICT must not insert a winner');
    assert.equal(weak.queued_review, 1, 'low-confidence CONTRADICT must be queued for review');
    assert.equal(verdictCount(), verdictsBeforeWeak, 'low-confidence CONTRADICT must not emit a verdict');
    const berlinAfterWeak = db.prepare(
      'SELECT status FROM memory_current WHERE memory_id = ? LIMIT 1',
    ).get(String(berlin.memory_id));
    assert.equal(String(berlinAfterWeak?.status || ''), 'active', 'valid target must stay active below the confidence gate');

    // (7) Decision-phase transport failure: the candidate degrades to the
    // heuristic path (never silently dropped), llm_failed is counted, and the
    // circuit breaker stops further decide() calls in the same run (a dead
    // LLM must not burn one timeout per candidate). Review findings P2.
    let decideCalls = 0;
    const outage = captureFromEvent({
      db,
      config,
      event: {
        scope: 'llmscope',
        agentId: 'main',
        sessionKey: 'agent:main:llm',
        text: [
          '<memory_note type="USER_FACT" confidence="0.9">The user adopted a greyhound named Pixel.</memory_note>',
          '<memory_note type="USER_FACT" confidence="0.9">The user is training Pixel for agility trials.</memory_note>',
        ].join('\n'),
        __captureLlm: {
          decide: () => { decideCalls += 1; throw new Error('connection refused'); },
        },
      },
      runId: 'capture-unit-llm',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(decideCalls, 1, 'circuit breaker: after one transport failure, later candidates must skip decide()');
    assert.equal(outage.llm_failed, 1, 'decision transport failure must be counted');
    assert.equal(outage.inserted, 2, 'both candidates must still be captured via the heuristic path (never dropped)');

    // (8) UPDATE with a hallucinated targetId must NOT rewrite the closest
    // neighbor (UPDATE persists content now); it falls through to ADD.
    const pixelBefore = db.prepare(
      "SELECT memory_id, content FROM memory_current WHERE content LIKE '%greyhound named Pixel%' AND status='active' LIMIT 1",
    ).get();
    const halluUpdate = captureFromEvent({
      db,
      config,
      event: {
        scope: 'llmscope',
        agentId: 'main',
        sessionKey: 'agent:main:llm',
        text: '<memory_note type="USER_FACT" confidence="0.9">The user volunteers at an animal shelter on weekends.</memory_note>',
        __captureLlm: {
          decide: () => ({ op: 'UPDATE', targetId: 'no-such-memory-id', confidence: 0.9 }),
        },
      },
      runId: 'capture-unit-llm',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(halluUpdate.llm_updated, 0, 'hallucinated UPDATE target must not count as an update');
    assert.equal(halluUpdate.inserted, 1, 'hallucinated UPDATE falls through to ADD (non-destructive)');
    const pixelAfter = db.prepare(
      'SELECT content FROM memory_current WHERE memory_id = ? LIMIT 1',
    ).get(String(pixelBefore.memory_id));
    assert.equal(pixelAfter.content, pixelBefore.content, 'closest neighbor content must NOT be rewritten by a hallucinated UPDATE');
  } finally {
    db.close();
  }

  // ---------------------------------------------------------------------------
  // U13c (4) + (5b/5c): capture candidates are HOST-ATTRIBUTED on the arbiter
  // consult, and direct-op tie semantics. Fresh workspace per scenario; the
  // decision LLM is mocked via event.__captureLlm.
  // ---------------------------------------------------------------------------
  const OLD_ISO = '2026-01-01T00:00:00.000Z';
  const tieCtx = (prefix) => {
    const tws = makeTempWorkspace(prefix);
    const tconfig = normalizeConfig(makeConfigObject(tws.workspace).plugins.entries.gigabrain.config);
    const tdb = openDb(tws.dbPath);
    return { tws, tconfig, tdb };
  };
  const contradict = ({ tdb, tconfig, agentId, content, targetId }) => captureFromEvent({
    db: tdb,
    config: tconfig,
    event: {
      scope: 'u13cscope',
      agentId,
      sessionKey: `agent:${agentId}:u13c`,
      text: `<memory_note type="USER_FACT" confidence="0.9">${content}</memory_note>`,
      __captureLlm: { decide: () => ({ op: 'CONTRADICT', targetId, confidence: 0.95 }) },
    },
    runId: 'capture-unit-u13c',
    reviewVersion: 'rv-capture-unit',
    logger: { info: () => {}, warn: () => {} },
  });
  const verdictRow = (tdb) => tdb.prepare(
    "SELECT agent_id FROM memory_events WHERE action = 'arbiter:verdict' ORDER BY rowid DESC LIMIT 1",
  ).get();

  // (4) An equal-tier direct CONTRADICT behaves IDENTICALLY for the registered
  // default agent id ('main') and a free-text first-party id ('spark-bridge'):
  // the consult is host-attributed, so the U13(b) registry cap no longer drags
  // one surface to the 0.4 floor and queues it. Provenance is NOT lost — the
  // verdict still carries event.agentId.
  for (const agentId of ['main', 'spark-bridge']) {
    const { tconfig, tdb } = tieCtx(`gb-u13c-host-attr-`);
    try {
      seedMemoryCurrent(tdb, [{
        memory_id: 'deploy-ecs',
        type: 'USER_FACT',
        content: 'The deploy target is AWS ECS for production deployments.',
        scope: 'u13cscope',
        confidence: 0.8,
        created_at: OLD_ISO,
        updated_at: OLD_ISO,
      }]);
      const summary = contradict({
        tdb,
        tconfig,
        agentId,
        content: 'The deploy target moved to Fly.io for production.',
        targetId: 'deploy-ecs',
      });
      assert.equal(summary.llm_contradicted, 1, `agentId '${agentId}': an equal-tier direct CONTRADICT supersedes (no accidental 0.4 cap)`);
      assert.equal(summary.queued_review, 0, `agentId '${agentId}': nothing routes to review`);
      const loserRow = tdb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('deploy-ecs');
      assert.equal(String(loserRow?.status || ''), 'superseded', `agentId '${agentId}': the rival is superseded`);
      assert.equal(String(verdictRow(tdb)?.agent_id || ''), agentId, 'the verdict keeps the real event.agentId provenance');
    } finally {
      tdb.close();
    }
  }

  // (5c) A durable_personal target NEVER falls to a bare equal-tier tie, even
  // on the direct CONTRADICT channel — strictly greater trust or support is
  // required; the tie routes to review with its own reason.
  {
    const { tws, tconfig, tdb } = tieCtx('gb-u13c-durable-tie-');
    try {
      seedMemoryCurrent(tdb, [{
        memory_id: 'partner-city',
        type: 'USER_FACT',
        content: 'The user lives in Lisbon with their partner.',
        scope: 'u13cscope',
        confidence: 0.8,
        created_at: OLD_ISO,
        updated_at: OLD_ISO,
      }]);
      ensureWorldModelStore(tdb);
      tdb.prepare(`
        INSERT INTO memory_claims (memory_id, memory_tier, claim_slot, consolidation_op, source_strength, surface_candidate, updated_at, payload)
        VALUES (?, 'durable_personal', 'location.current_city', 'remember', 'strong', 1, ?, '{}')
      `).run('partner-city', OLD_ISO);
      const summary = contradict({
        tdb,
        tconfig,
        agentId: 'main',
        content: 'The user moved to Porto with their partner.',
        targetId: 'partner-city',
      });
      assert.equal(summary.llm_contradicted, 0, 'a durable_personal target must not fall to a bare tie');
      assert.equal(summary.inserted, 0, 'no winner row is inserted on a durable tie');
      assert.equal(summary.queued_review, 1, 'the durable tie routes to the review queue');
      const target = tdb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('partner-city');
      assert.equal(String(target?.status || ''), 'active', 'the durable personal fact stays active');
      assert.equal(Boolean(verdictRow(tdb)), false, 'no verdict is recorded for a queued durable tie');
      const queueText = fs.readFileSync(path.join(tws.outputRoot, 'memory-review-queue.jsonl'), 'utf8');
      assert.match(queueText, /capture_contradiction_durable_tie/, 'queue row carries the durable-tie reason');
      assert.match(queueText, /Porto/, 'queued candidate content must be preserved (not lost)');
    } finally {
      tdb.close();
    }
  }
};

export { run };

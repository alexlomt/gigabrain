import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { ensurePersonStore, rebuildEntityMentions } from '../lib/core/person-service.js';
import { recordVerdict } from '../lib/core/projection-store.js';
import { ensureWorldModelStore } from '../lib/core/world-model.js';
import { recallForQuery } from '../lib/core/recall-service.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v6-unit-recall-service-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  config.recall.maxTokens = 2000;
  config.recall.topK = 5;
  config.recall.adaptiveBudgeting = { enabled: true };

  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'bm25-strong',
        type: 'DECISION',
        content: 'Graph rollout rollout checklist for the nightly graph pipeline stabilization.',
        scope: 'shared',
        confidence: 0.96,
        value_score: 0.74,
        value_label: 'core',
      },
      {
        memory_id: 'bm25-weak',
        type: 'DECISION',
        content: 'Graph note for later follow-up.',
        scope: 'shared',
        confidence: 0.52,
        value_score: 0.18,
        value_label: 'situational',
      },
      {
        memory_id: 'situational-row',
        type: 'CONTEXT',
        content: 'Nightly graph pipeline follow-up and rollout owner reminder.',
        scope: 'shared',
        confidence: 0.64,
        value_score: 0.45,
        value_label: 'situational',
      },
      {
        memory_id: 'shared-mira',
        type: 'USER_FACT',
        content: 'Mira appears in the public release checklist template.',
        scope: 'shared',
        confidence: 0.81,
        value_score: 0.76,
        value_label: 'core',
      },
      {
        memory_id: 'alpha-mira',
        type: 'USER_FACT',
        content: 'Mira coordinates the alpha launch and owns the rollout.',
        scope: 'project:alpha',
        confidence: 0.92,
        value_score: 0.88,
        value_label: 'core',
      },
      {
        memory_id: 'beta-mira',
        type: 'USER_FACT',
        content: 'Mira coordinates the beta launch for another workspace.',
        scope: 'project:beta',
        confidence: 0.9,
        value_score: 0.82,
        value_label: 'core',
      },
      {
        memory_id: 'quinn-robin-together',
        type: 'CONTEXT',
        content: 'Quinn and Robin planned the release together and aligned the rollout.',
        scope: 'shared',
        confidence: 0.93,
        value_score: 0.86,
        value_label: 'core',
      },
      {
        memory_id: 'quinn-solo',
        type: 'CONTEXT',
        content: 'Quinn planned the release checklist alone.',
        scope: 'shared',
        confidence: 0.81,
        value_score: 0.62,
        value_label: 'situational',
      },
      {
        memory_id: 'robin-solo',
        type: 'CONTEXT',
        content: 'Robin reviewed the release notes before launch.',
        scope: 'shared',
        confidence: 0.8,
        value_score: 0.6,
        value_label: 'situational',
      },
      {
        memory_id: 'telegram-chat-id',
        type: 'PREFERENCE',
        content: 'Quinn: use numeric Telegram chat id 1234567890 instead of @example_user to avoid chat not found.',
        scope: 'shared',
        confidence: 0.6,
        value_score: 0,
        value_label: 'situational',
      },
      {
        memory_id: 'telegram-general',
        type: 'CONTEXT',
        content: 'Telegram is used for the fictional Atlas staging and gateway status updates.',
        scope: 'shared',
        confidence: 0.98,
        value_score: 0.65,
        value_label: 'core',
      },
      {
        memory_id: 'orion-duration-preference',
        type: 'PREFERENCE',
        content: 'I prefer to work with Orion on long certification programs.',
        scope: 'shared',
        confidence: 0.95,
        value_score: 0.9,
        value_label: 'core',
      },
      {
        memory_id: 'orion-duration-fact',
        type: 'USER_FACT',
        content: 'I worked with Orion for five years.',
        scope: 'shared',
        confidence: 0.85,
        value_score: 0.55,
        value_label: 'core',
      },
    ]);
    ensurePersonStore(db);
    rebuildEntityMentions(db);

    const quickResult = recallForQuery({
      db,
      config,
      query: 'graph rollout',
      scope: 'shared',
      strategyContext: { strategy: 'quick_context' },
    });

    assert.equal(quickResult.results[0]?.memory_id, 'bm25-strong', 'recall should rank the denser BM25 match ahead of weaker lexical rows');
    assert.equal(quickResult.budget.maxTokens, 800, 'quick_context recall should use the adaptive quick-context token budget');
    assert.match(quickResult.injection, /recall_confidence:/, 'rendered injection should include confidence metadata');
    assert.match(quickResult.injection, /coverage: (high|medium|low)/, 'rendered injection should include coverage metadata');
    assert.match(quickResult.injection, /- \[(strong|medium|weak)\]/, 'rendered injection should annotate recalled rows with strength labels');

    const verificationResult = recallForQuery({
      db,
      config,
      query: 'graph rollout provenance',
      scope: 'shared',
      strategyContext: { strategy: 'verification_lookup' },
    });
    assert.equal(
      verificationResult.budget.maxTokens,
      1600,
      'verification_lookup recall should use the larger adaptive verification budget',
    );

    const semanticFallbackResult = recallForQuery({
      db,
      config: {
        ...config,
        recall: {
          ...config.recall,
          semanticRerankEnabled: true,
          ollamaUrl: 'http://127.0.0.1:9',
          embeddingTimeoutMs: 100,
        },
      },
      query: 'graph rollout',
      scope: 'shared',
      strategyContext: { strategy: 'quick_context' },
    });
    assert.equal(
      semanticFallbackResult.results[0]?.memory_id,
      'bm25-strong',
      'recall should gracefully keep BM25 order when semantic reranking is enabled but unavailable',
    );

    const alphaEntityResult = recallForQuery({
      db,
      config,
      query: 'who is mira',
      scope: 'project:alpha',
      strategyContext: { strategy: 'entity_brief' },
    });
    assert.equal(
      alphaEntityResult.results[0]?.memory_id,
      'alpha-mira',
      'entity recall should prioritize same-scope entity memories for project-scoped queries',
    );
    assert.equal(
      alphaEntityResult.results.some((row) => row.memory_id === 'beta-mira'),
      false,
      'entity recall should not leak foreign project entity rows into another project scope',
    );

    const sharedEntityResult = recallForQuery({
      db,
      config,
      query: 'who is mira',
      scope: 'shared',
      strategyContext: { strategy: 'entity_brief' },
    });
    assert.equal(
      sharedEntityResult.results.some((row) => row.memory_id === 'alpha-mira'),
      false,
      'shared-scope entity recall should not surface project-local entity memories',
    );
    assert.equal(
      sharedEntityResult.injection.includes('bootstrap_mode: true') || sharedEntityResult.results.every((row) => row.memory_id !== 'alpha-mira'),
      true,
      'shared-scope entity recall should fail closed to shared/bootstrap behavior instead of leaking project-local entity context',
    );

    const multiEntityResult = recallForQuery({
      db,
      config,
      query: 'how do quinn and robin work together',
      scope: 'shared',
      strategyContext: {
        strategy: 'multi_entity_brief',
        entityIds: ['person:quinn', 'person:robin'],
        multiEntities: [
          { entity_id: 'person:quinn', kind: 'person', display_name: 'Quinn', aliases: ['Quinn'] },
          { entity_id: 'person:robin', kind: 'person', display_name: 'Robin', aliases: ['Robin'] },
        ],
      },
    });
    assert.equal(
      multiEntityResult.results[0]?.memory_id,
      'quinn-robin-together',
      'multi-entity reranking should boost memories that mention both selected entities instead of looking for opaque internal entity ids',
    );

    const numericExactResult = recallForQuery({
      db,
      config,
      query: '1234567890 Telegram Atlas',
      scope: 'shared',
      strategyContext: { strategy: 'quick_context' },
    });
    assert.equal(
      numericExactResult.results[0]?.memory_id,
      'telegram-chat-id',
      'recall should prioritize exact numeric identifier memories over general high-value context',
    );

    const durationFactResult = recallForQuery({
      db,
      config,
      query: 'how long did I work with Orion',
      scope: 'shared',
      strategyContext: { strategy: 'quick_context' },
    });
    assert.equal(
      durationFactResult.results[0]?.memory_id,
      'orion-duration-fact',
      'duration questions should prefer a matching fact over a superficially stronger preference',
    );
    assert.equal(durationFactResult.querySignals.answerIntent.duration, true, 'duration intent must be exposed for diagnostics');
    assert.equal(durationFactResult.results[0]?._answer_intent_boost > 0, true, 'the factual duration answer should receive the bounded answer-shape boost');
    assert.equal(durationFactResult.results[0]?._factual_answer_type_boost > 0, true, 'the factual duration answer should receive the verified type boost');

    // ------------------------------------------------------------------
    // U15: provenance-stamped recall (compact suffix, fields, token budget)
    // ------------------------------------------------------------------
    const provenanceTop = quickResult.results[0];
    assert.equal(provenanceTop.source_agent, 'main', 'recall rows must carry source_agent');
    assert.equal(provenanceTop.trust_tier, 'own_agent', 'recall rows must carry the host-trust tier class');
    assert.equal(provenanceTop.trust_score, 0.74, 'recall rows must carry the host-trust score');
    assert.equal(provenanceTop.verdict_ref, null, 'rows without a recorded verdict carry verdict_ref null');
    assert.equal(Boolean(provenanceTop.valid_window?.from), true, 'recall rows must carry the validity window start');
    assert.equal(provenanceTop.unresolved_conflict, false, 'non-conflicted rows are not flagged');

    const memoryLines = quickResult.injection.split('\n').filter((line) => line.startsWith('- ['));
    assert.equal(memoryLines.length > 0, true, 'injection must render memory lines');
    for (const line of memoryLines) {
      assert.match(
        line,
        /\[src:[^\]\s]+ t:\d\.\d{2} since:\d{4}-\d{2}(?: v:[0-9a-f-]{1,8})?\](?: \[unresolved-conflict\])?$/,
        `every injected memory line must end with the compact provenance suffix: ${line}`,
      );
      const suffix = line.slice(line.indexOf(' [src:'));
      assert.equal(suffix.length <= 80, true, `provenance suffix must stay compact (token budget): ${suffix}`);
    }
    assert.equal(
      quickResult.budget.totalTokens <= quickResult.budget.maxTokens,
      true,
      'token budget must hold with provenance enabled',
    );
    assert.match(
      quickResult.injection,
      /instruction: Use these memories\. Each memory line ends with compact provenance/,
      'injection instruction must explain the provenance stamp instead of hiding sources',
    );
    assert.equal(
      quickResult.injection.includes('Use these memories silently'),
      false,
      'the old hide-sources instruction must be gone',
    );
    assert.equal(
      /Never mention file paths/.test(quickResult.injection),
      true,
      'the path privacy boundary stays in the instruction',
    );

    // U15 scenario 1: a recorded verdict stamps verdict_ref on the winner and
    // the loser stays suppressed (no silent resurrect, no missing receipt).
    seedMemoryCurrent(db, [
      {
        memory_id: 'verdict-winner',
        type: 'USER_FACT',
        content: 'Devon lives in Porto near the riverside market.',
        scope: 'shared',
        source_agent: 'hermes',
        confidence: 0.9,
        value_score: 0.8,
        value_label: 'core',
      },
      {
        memory_id: 'verdict-loser',
        type: 'USER_FACT',
        content: 'Devon lives in Lisbon near the old aqueduct.',
        scope: 'shared',
        source_agent: 'codex',
        confidence: 0.9,
        value_score: 0.8,
        value_label: 'core',
      },
    ]);
    const verdictReceipt = recordVerdict(db, {
      winnerId: 'verdict-winner',
      loserIds: ['verdict-loser'],
      signals: { decided_by: 'recency' },
      agentId: 'hermes',
      reason: ['arbiter:belief_resolution'],
    });
    const verdictRecall = recallForQuery({
      db,
      config,
      query: 'where does devon live',
      scope: 'shared',
      strategyContext: { strategy: 'quick_context' },
    });
    const verdictWinnerRow = verdictRecall.results.find((row) => row.memory_id === 'verdict-winner');
    assert.ok(verdictWinnerRow, 'the verdict winner must be recalled');
    assert.equal(
      verdictWinnerRow.verdict_ref,
      verdictReceipt.verdictEvent.event_id,
      'the winner row must reference the exact arbitration-ledger verdict event',
    );
    assert.equal(verdictWinnerRow.source_agent, 'hermes', 'winner provenance names the source agent');
    assert.equal(
      verdictRecall.results.some((row) => row.memory_id === 'verdict-loser'),
      false,
      'the superseded loser must stay out of recall',
    );
    assert.match(
      verdictRecall.injection,
      new RegExp(` v:${verdictReceipt.verdictEvent.event_id.slice(0, 8)}\\]`),
      'the injection stamps the verdict-ref prefix on the winner line',
    );

    // U15 scenario 4 (uncertain conflict group): rows inside an OPEN
    // contradiction_review loop are flagged, both rivals stay visible.
    ensureWorldModelStore(db);
    seedMemoryCurrent(db, [
      {
        memory_id: 'conflict-a',
        type: 'USER_FACT',
        content: 'Jordan commutes from Lisbon on weekdays.',
        scope: 'shared',
        confidence: 0.85,
        value_score: 0.7,
        value_label: 'core',
      },
      {
        memory_id: 'conflict-b',
        type: 'USER_FACT',
        content: 'Jordan commutes from Porto on weekdays.',
        scope: 'shared',
        confidence: 0.85,
        value_score: 0.7,
        value_label: 'core',
      },
    ]);
    db.prepare(`
      INSERT INTO memory_open_loops (
        loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload
      ) VALUES (?, 'contradiction_review', ?, 'open', 0.8, ?, ?, '{}')
    `).run(
      'loop:test-jordan-commute',
      'Potential commute conflict for Jordan',
      'person:jordan',
      JSON.stringify(['conflict-a', 'conflict-b']),
    );
    const conflictRecall = recallForQuery({
      db,
      config,
      query: 'jordan commutes weekdays',
      scope: 'shared',
      strategyContext: { strategy: 'quick_context' },
    });
    const conflictRows = conflictRecall.results.filter((row) => ['conflict-a', 'conflict-b'].includes(row.memory_id));
    assert.equal(conflictRows.length, 2, 'BOTH rivals of an unresolved conflict must surface (neither silently dropped)');
    assert.equal(
      conflictRows.every((row) => row.unresolved_conflict === true),
      true,
      'both rivals must be flagged unresolved_conflict',
    );
    assert.equal(
      (conflictRecall.injection.match(/\[unresolved-conflict\]/g) || []).length >= 2,
      true,
      'the injection must mark both rival lines [unresolved-conflict]',
    );
    assert.match(
      conflictRecall.injection,
      /conflict_instruction: Memories marked \[unresolved-conflict\]/,
      'the injection must instruct the agent not to silently pick a side',
    );

    // U15 scenario 4 (review-queue leg): a pending capture_contradiction_*
    // queue entry flags its target memory at recall time.
    seedMemoryCurrent(db, [
      {
        memory_id: 'queue-conflict-target',
        type: 'DECISION',
        content: 'The deploy cadence is weekly on Thursdays.',
        scope: 'shared',
        confidence: 0.9,
        value_score: 0.75,
        value_label: 'core',
      },
    ]);
    const queuePath = config.runtime.paths.reviewQueuePath;
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      status: 'pending',
      reason: 'capture_contradiction_unverified',
      action: 'capture_review',
      matched_memory_id: 'queue-conflict-target',
      payload: { excerpt: 'The deploy cadence moved to daily.' },
    })}\n`, 'utf8');
    const queueConflictRecall = recallForQuery({
      db,
      config,
      query: 'deploy cadence',
      scope: 'shared',
      strategyContext: { strategy: 'quick_context' },
    });
    const queueTargetRow = queueConflictRecall.results.find((row) => row.memory_id === 'queue-conflict-target');
    assert.ok(queueTargetRow, 'the review-queued target must still be recalled');
    assert.equal(queueTargetRow.unresolved_conflict, true, 'a pending capture_contradiction_* queue entry flags its target');
    fs.rmSync(queuePath, { force: true });
  } finally {
    db.close();
  }
};

export { run };

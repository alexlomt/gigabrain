import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { captureFromEvent } from '../lib/core/capture-service.js';
import {
  autoCaptureFromEvent,
  buildAutoCapturePacket,
  containsSecretLikeValue,
  enqueueAutoCaptureEvent,
  isToolLikeText,
  processAutoCaptureQueue,
  resolveAutoCaptureCircuit,
  shouldConsiderAutoCaptureEvent,
  redactSensitiveText,
  resolveAutoCaptureQueuePath,
} from '../lib/core/auto-capture-service.js';
import { makeTempWorkspace, makeConfigObject, openDb } from './helpers.js';

const makeAutoConfig = (workspace, overrides = {}) => {
  const raw = makeConfigObject(workspace).plugins.entries.gigabrain.config;
  raw.capture.autoCapture = {
    enabled: true,
    mode: 'auto',
    provider: 'openclaw',
    profile: 'auto_capture',
    minConfidence: 0.88,
    minImportance: 0.75,
    queueMinConfidence: 0.65,
    queueMinImportance: 0.5,
    maxCandidates: 5,
    maxTurns: 16,
    targetTokens: 10000,
    softMaxTokens: 15000,
    hardMaxTokens: 25000,
    includeExistingMemories: true,
    existingMemoryLimit: 80,
    ...overrides,
  };
  raw.llm.provider = 'openclaw';
  raw.llm.baseUrl = 'http://127.0.0.1:18789/v1';
  raw.llm.apiKey = 'test-token';
  raw.llm.model = 'openclaw/default';
  return normalizeConfig(raw);
};

const run = async () => {
  assert.equal(containsSecretLikeValue('Authorization: Bearer abcdefghijklmnop'), true);
  assert.equal(redactSensitiveText('api_key=abcdef1234567890 keep this').includes('abcdef1234567890'), false);
  assert.equal(containsSecretLikeValue('mention token: <@1495942904731009196>'), false);
  assert.equal(redactSensitiveText('mention token: <@1495942904731009196>'), 'mention token: <@1495942904731009196>');
  assert.equal(containsSecretLikeValue('api_key=[REDACTED_SECRET]'), false);

  const ws = makeTempWorkspace('gb-v3-unit-auto-capture-');
  const config = makeAutoConfig(ws.workspace);
  const db = openDb(ws.dbPath);
  try {
    const event = {
      scope: 'profile:main',
      agentId: 'main',
      sessionKey: 'agent:main:auto-capture',
      messages: [
        { role: 'user', content: 'Going forward, automatically save important project decisions without me explicitly saying remember this.' },
        { role: 'assistant', content: 'Agreed. I will implement a conservative automatic memory capture step.' },
      ],
      text: 'Agreed. I will implement a conservative automatic memory capture step.',
    };
    const auto = await autoCaptureFromEvent({
      db,
      config,
      event,
      runId: 'auto-capture-unit',
      reviewVersion: 'rv-auto-capture-unit',
      completeJson: async () => JSON.stringify({
        candidates: [
          {
            action: 'auto_save',
            type: 'PREFERENCE',
            content: 'Alex wants important project decisions to be saved automatically without explicit remember requests.',
            scope: 'profile:main',
            confidence: 0.94,
            importance: 0.9,
            sensitivity: 'low',
            reason: 'stable memory automation preference',
          },
          {
            action: 'queue_review',
            type: 'CONTEXT',
            content: 'Alex may want broader automatic capture later after testing.',
            scope: 'profile:main',
            confidence: 0.72,
            importance: 0.55,
            sensitivity: 'low',
            reason: 'useful but tentative',
          },
          {
            action: 'auto_save',
            type: 'USER_FACT',
            content: 'Alex API token is token=abcdef1234567890.',
            scope: 'profile:main',
            confidence: 0.99,
            importance: 0.99,
            sensitivity: 'low',
            reason: 'should be rejected by deterministic filter',
          },
        ],
      }),
    });

    assert.equal(auto.enabled, true);
    assert.equal(auto.mode, 'auto');
    assert.equal(auto.candidates, 4);
    assert.equal(auto.auto_save_candidates, 2, 'safe high-confidence and deterministic explicit future-run candidates should be prepared for save');
    assert.equal(auto.queued_review, 1, 'medium-confidence candidate should be queued');
    assert.equal(auto.rejected, 1, 'secret-like candidate should be rejected');
    assert.match(auto.generated_text, /Alex wants important project decisions/i);
    assert.doesNotMatch(auto.generated_text, /abcdef1234567890/);

    const scopedAuto = await autoCaptureFromEvent({
      db,
      config,
      event: {
        scope: 'scrapling-research-operator',
        agentId: 'scrapling-research-operator',
        sessionKey: 'agent:scrapling-research-operator:paperclip:issue:scope-test',
        messages: [
          { role: 'user', content: 'Decide the worker memory boundary.' },
          { role: 'assistant', content: 'Decision: Scrapling keeps web evidence memory in the Scrapling worker scope only.' },
        ],
        text: 'Decision: Scrapling keeps web evidence memory in the Scrapling worker scope only.',
      },
      runId: 'auto-capture-scope-unit',
      reviewVersion: 'rv-auto-capture-unit',
      completeJson: async () => JSON.stringify({
        candidates: [{
          action: 'auto_save',
          type: 'DECISION',
          content: 'Scrapling keeps web evidence memory in the Scrapling worker scope only.',
          scope: 'paperclip-ceo',
          confidence: 0.96,
          importance: 0.9,
          sensitivity: 'low',
          reason: 'model attempted the wrong scope; runtime must override it',
        }],
      }),
    });
    assert.equal(scopedAuto.auto_save_candidates, 1);
    assert.match(scopedAuto.generated_text, /scope="scrapling-research-operator"/, 'auto-capture must force event scope over model-selected scope');
    assert.doesNotMatch(scopedAuto.generated_text, /scope="paperclip-ceo"/);

    const scopedCapture = captureFromEvent({
      db,
      config,
      event: {
        agentId: 'scrapling-research-operator',
        sessionKey: 'agent:scrapling-research-operator:paperclip:issue:scope-test',
        scope: 'scrapling-research-operator',
        text: scopedAuto.generated_text,
        prompt: '',
        messages: [],
      },
      runId: 'auto-capture-scope-unit',
      reviewVersion: 'rv-auto-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(scopedCapture.inserted, 1, 'forced-scope auto memory note should be captured');
    const scopedStored = db.prepare(`
      SELECT scope
      FROM memory_current
      WHERE content LIKE '%Scrapling keeps web evidence memory%'
      LIMIT 1
    `).get();
    assert.equal(String(scopedStored?.scope || ''), 'scrapling-research-operator');

    const sharedConfig = makeAutoConfig(ws.workspace);
    sharedConfig.runtime.paths.reviewQueuePath = path.join(ws.outputRoot, 'shared-auto-capture-review.jsonl');
    fs.rmSync(sharedConfig.runtime.paths.reviewQueuePath, { force: true });
    const sharedAuto = await autoCaptureFromEvent({
      db,
      config: sharedConfig,
      event: {
        scope: 'shared',
        agentId: 'shared',
        sessionKey: 'agent:shared:auto-capture',
        messages: [
          { role: 'user', content: 'Save a global fact automatically.' },
          { role: 'assistant', content: 'Decision: global memory should require explicit promotion.' },
        ],
        text: 'Decision: global memory should require explicit promotion.',
      },
      runId: 'auto-capture-shared-unit',
      reviewVersion: 'rv-auto-capture-unit',
      completeJson: async () => JSON.stringify({
        candidates: [{
          action: 'auto_save',
          type: 'DECISION',
          content: 'Global memory should require explicit promotion.',
          scope: 'shared',
          confidence: 0.96,
          importance: 0.9,
          sensitivity: 'low',
          reason: 'shared memory promotion guard',
        }],
      }),
    });
    assert.equal(sharedAuto.auto_save_candidates, 0, 'shared scope must not auto-save without explicit promotion');
    assert.equal(sharedAuto.queued_review, 1, 'shared auto-save candidates should be routed to review');
    assert.equal(sharedAuto.generated_text, '');

    const capture = captureFromEvent({
      db,
      config,
      event: {
        agentId: event.agentId,
        sessionKey: event.sessionKey,
        scope: event.scope,
        text: auto.generated_text,
        prompt: '',
        messages: [],
      },
      runId: 'auto-capture-unit',
      reviewVersion: 'rv-auto-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(capture.inserted, 2, 'generated auto memory notes should be captured');
    const stored = db.prepare(`
      SELECT type, content, scope, source_layer
      FROM memory_current
      WHERE content LIKE 'Alex wants important project decisions%'
      LIMIT 1
    `).get();
    assert.equal(String(stored?.type || ''), 'PREFERENCE');
    assert.equal(String(stored?.scope || ''), 'profile:main');
    assert.equal(String(stored?.source_layer || ''), 'registry', 'auto-capture should not pollute native MEMORY.md by default');

    const secretCount = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_current
      WHERE content LIKE '%abcdef1234567890%'
    `).get();
    assert.equal(Number(secretCount?.c || 0), 0, 'secret-like candidate must never be stored');

    const queuePath = path.join(ws.outputRoot, 'memory-review-queue.jsonl');
    assert.equal(fs.existsSync(queuePath), true, 'review candidate should create queue file');
    const queueText = fs.readFileSync(queuePath, 'utf8');
    assert.match(queueText, /auto_capture_review/);
    assert.match(queueText, /broader automatic capture/);

    const shadowConfig = makeAutoConfig(ws.workspace, { mode: 'shadow' });
    const shadow = await autoCaptureFromEvent({
      db,
      config: shadowConfig,
      event,
      runId: 'auto-capture-shadow-unit',
      reviewVersion: 'rv-auto-capture-unit',
      completeJson: async () => JSON.stringify({
        candidates: [{
          action: 'auto_save',
          type: 'DECISION',
          content: 'Alex decided shadow candidates should not be written.',
          scope: 'profile:main',
          confidence: 0.95,
          importance: 0.9,
          sensitivity: 'low',
          reason: 'shadow mode test',
        }],
      }),
    });
    assert.equal(shadow.shadowed, 2);
    assert.equal(shadow.generated_text, '', 'shadow mode must not generate save notes');

    const packet = buildAutoCapturePacket({
      db,
      config,
      event: {
        ...event,
        messages: [{ role: 'user', content: 'Here is a token: token=abcdef1234567890' }],
      },
    });
    assert.equal(JSON.stringify(packet).includes('abcdef1234567890'), false, 'review packet should redact secret-looking values');

    assert.equal(shouldConsiderAutoCaptureEvent({ config, event: { messages: [{ role: 'user', content: 'Hows it going' }] } }).ok, false);
    assert.equal(shouldConsiderAutoCaptureEvent({ config, event: { messages: [{ role: 'user', content: 'Going forward, I prefer that high-confidence stable preferences are captured automatically.' }] } }).ok, true);
    assert.equal(shouldConsiderAutoCaptureEvent({ config, event: { messages: [{ role: 'user', content: 'Status?' }, { role: 'assistant', content: 'Running smoke tests and systemctl checks.' }] } }).ok, false);
    assert.equal(
      shouldConsiderAutoCaptureEvent({
        config,
        event: { messages: [{ role: 'user', content: 'Execution summary: Going forward, I want production verification failures to be called out plainly.' }] },
      }).ok,
      false,
      'execution-summary chatter should not enter auto-capture even when it contains memory-like text',
    );
    const syntheticWakeDecisionGate = shouldConsiderAutoCaptureEvent({
      config,
      event: {
        agentId: 'linkedin-public-evidence-operator',
        scope: 'linkedin-public-evidence-operator',
        sessionKey: 'agent:linkedin-public-evidence-operator:paperclip:issue:test',
        messages: [
          { role: 'user', content: '[Tue 2026-05-12 00:37 UTC] You are the LinkedIn Public Evidence Operator.\n\nPaperclip wake event for a cloud adapter.\n\nSet these values in your run context:\nPAPERCLIP_RUN_ID=test-run\nPAPERCLIP_AGENT_ID=test-agent\nPAPERCLIP_API_URL=http://127.0.0.1:3100/\n\nHTTP rules:\n- Use Authorization: Bearer $PAPERCLIP_API_KEY\n\nWorkflow:\n1) GET /api/agents/me\n\n- issue: ADR-411 LinkedIn validation\n- reason: issue_assigned' },
          { role: 'assistant', content: 'Decision: Going forward, the LinkedIn Public Evidence Operator should keep durable operating memory only in its own scope.' },
        ],
        text: 'Decision: Going forward, the LinkedIn Public Evidence Operator should keep durable operating memory only in its own scope.',
      },
    });
    assert.equal(syntheticWakeDecisionGate.ok, true, 'synthetic Paperclip wakes should not block durable assistant memory signals');
    assert.equal(syntheticWakeDecisionGate.syntheticWakeDetected, true, 'synthetic Paperclip wakes should be detected');
    const syntheticWakeNoSignalGate = shouldConsiderAutoCaptureEvent({
      config,
      event: {
        agentId: 'linkedin-public-evidence-operator',
        scope: 'linkedin-public-evidence-operator',
        sessionKey: 'agent:linkedin-public-evidence-operator:paperclip:issue:test',
        messages: [
          { role: 'user', content: '[Tue 2026-05-12 00:37 UTC] Paperclip wake event for a cloud adapter.\n\nSet these values in your run context:\nPAPERCLIP_RUN_ID=test-run\nPAPERCLIP_AGENT_ID=test-agent\n\nHTTP rules:\n- Use Authorization: Bearer $PAPERCLIP_API_KEY\n\n- issue: ADR-411 LinkedIn validation\n- reason: issue_assigned' },
          { role: 'assistant', content: 'Done. The extractor ran successfully and QA passed.' },
        ],
        text: 'Done. The extractor ran successfully and QA passed.',
      },
    });
    assert.equal(syntheticWakeNoSignalGate.ok, false, 'synthetic wakes without a durable signal should still be skipped');
    assert.equal(syntheticWakeNoSignalGate.reason, 'no_memory_signal');
    assert.equal(isToolLikeText('functions.exec raw_params={"command":"node --input-type=module"}'), true);
    const toolPacket = buildAutoCapturePacket({
      db,
      config,
      event: {
        agentId: 'main',
        scope: 'profile:main',
        messages: [
          { role: 'user', content: 'How is it going?' },
          {
            role: 'assistant',
            toolCallId: 'call_live_auto_capture',
            content: 'node --input-type=module live-auto-capture-test: Going forward, I want production verification failures to be called out plainly before you say a task is complete.',
          },
          {
            role: 'assistant',
            content: '[tools] functions.exec raw_params={"command":"Going forward, I want production verification failures to be called out plainly"}',
          },
          { role: 'assistant', content: 'Smoke tests are green; live verification is still running.' },
        ],
        text: 'Smoke tests are green; live verification is still running.',
      },
    });
    assert.equal(
      JSON.stringify(toolPacket).includes('production verification failures'),
      false,
      'auto-capture packet must exclude tool/synthetic live-test content',
    );
    assert.equal(JSON.stringify(toolPacket).includes('Smoke tests are green'), true, 'normal assistant progress text remains available');

    const syntheticWakePacket = buildAutoCapturePacket({
      db,
      config,
      event: {
        agentId: 'linkedin-public-evidence-operator',
        scope: 'linkedin-public-evidence-operator',
        sessionKey: 'agent:linkedin-public-evidence-operator:paperclip:issue:test',
        messages: [
          { role: 'user', content: '[Tue 2026-05-12 00:37 UTC] Paperclip wake event for a cloud adapter.\n\nSet these values in your run context:\nPAPERCLIP_RUN_ID=test-run\nPAPERCLIP_AGENT_ID=test-agent\nPAPERCLIP_API_URL=http://127.0.0.1:3100/\n\nHTTP rules:\n- Use Authorization: Bearer $PAPERCLIP_API_KEY\n\nWorkflow:\n1) GET /api/agents/me\n\n- issue: ADR-411 LinkedIn validation\n- reason: issue_assigned' },
          { role: 'assistant', content: 'Decision: Going forward, the LinkedIn Public Evidence Operator should keep durable operating memory only in its own scope.' },
        ],
        text: 'Decision: Going forward, the LinkedIn Public Evidence Operator should keep durable operating memory only in its own scope.',
      },
    });
    assert.equal(JSON.stringify(syntheticWakePacket).includes('PAPERCLIP_RUN_ID'), false, 'synthetic Paperclip wake scaffolding should not be copied into auto-capture packets');
    assert.equal(JSON.stringify(syntheticWakePacket).includes('HTTP rules'), false, 'synthetic Paperclip wake HTTP boilerplate should be stripped from auto-capture packets');
    assert.match(JSON.stringify(syntheticWakePacket), /Paperclip issue wake: ADR-411 LinkedIn validation \(issue_assigned\)/, 'synthetic wakes should be summarized compactly in auto-capture packets');

    const queueConfig = makeAutoConfig(ws.workspace, {
      mode: 'auto',
      provider: 'openclaw',
      maxCandidates: 2,
      maxTurns: 8,
      maxCharsPerTurn: 1200,
      includeExistingMemories: false,
      existingMemoryLimit: 0,
    });
    const autoQueuePath = resolveAutoCaptureQueuePath(queueConfig);
    fs.rmSync(autoQueuePath, { force: true });
    const queued = enqueueAutoCaptureEvent({
      db,
      config: queueConfig,
      event,
      runId: 'auto-capture-queue-unit',
      logger: { warn: () => {} },
    });
    assert.equal(queued.queued_job, true, 'gateway hook should enqueue instead of calling the LLM synchronously');
    assert.equal(fs.existsSync(autoQueuePath), true, 'auto-capture queue should be created');
    const queuedRows = fs.readFileSync(autoQueuePath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(queuedRows.length, 1);

    const processed = await processAutoCaptureQueue({
      db,
      config: queueConfig,
      limit: 1,
      logger: { warn: () => {} },
      completeJson: async () => JSON.stringify({
        candidates: [{
          action: 'auto_save',
          type: 'DECISION',
          content: 'Alex decided Gigabrain automatic memory capture should run asynchronously from a bounded worker.',
          scope: 'profile:main',
          confidence: 0.96,
          importance: 0.9,
          sensitivity: 'low',
          reason: 'durable architecture decision',
        }],
      }),
    });
    assert.equal(processed.processed, 1);
    assert.equal(processed.completed, 1);
    assert.equal(processed.autoSaved, 1, 'worker should capture high-confidence auto-save candidates');
    const asyncStored = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_current
      WHERE content LIKE '%asynchronously from a bounded worker%'
        AND status = 'active'
    `).get();
    assert.equal(Number(asyncStored?.c || 0), 1);

    const failingQueueConfig = makeAutoConfig(ws.workspace, {
      mode: 'auto',
      provider: 'openclaw',
      maxCandidates: 2,
      maxTurns: 8,
      maxCharsPerTurn: 1200,
      includeExistingMemories: false,
      existingMemoryLimit: 0,
    });
    const failingQueuePath = resolveAutoCaptureQueuePath(failingQueueConfig);
    fs.rmSync(failingQueuePath, { force: true });
    const failingQueued = enqueueAutoCaptureEvent({
      db,
      config: failingQueueConfig,
      event,
      runId: 'auto-capture-queue-failure-unit',
      logger: { warn: () => {} },
    });
    assert.equal(failingQueued.queued_job, true, 'failure test should enqueue a packet');
    const failedProcessed = await processAutoCaptureQueue({
      db,
      config: failingQueueConfig,
      limit: 1,
      logger: { warn: () => {} },
      completeJson: async () => { throw new Error('fetch failed'); },
    });
    assert.equal(failedProcessed.processed, 1);
    assert.equal(failedProcessed.completed, 0, 'worker must not mark errored packets completed');
    assert.equal(failedProcessed.failed, 1);
    const failedRows = fs.readFileSync(failingQueuePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(failedRows.length, 1);
    assert.equal(failedRows[0].status, 'failed_retryable');
    assert.equal(failedRows[0].error_class, 'network');
    assert.match(String(failedRows[0].next_attempt_at || ''), /^\d{4}-\d{2}-\d{2}T/);

    const deferredProcessed = await processAutoCaptureQueue({
      db,
      config: failingQueueConfig,
      limit: 1,
      logger: { warn: () => {} },
      completeJson: async () => { throw new Error('should not run before next_attempt_at'); },
    });
    assert.equal(deferredProcessed.processed, 0, 'retryable failures should respect next_attempt_at');

    const nowIso = new Date().toISOString();
    const circuitRows = [
      ...failedRows,
      {
        ...failedRows[0],
        id: 'acq_circuit_1',
        hash: 'acq_circuit_1',
        updated_at: nowIso,
        next_attempt_at: new Date(Date.now() + 120000).toISOString(),
      },
      {
        ...failedRows[0],
        id: 'acq_circuit_2',
        hash: 'acq_circuit_2',
        updated_at: nowIso,
        next_attempt_at: new Date(Date.now() + 120000).toISOString(),
      },
      {
        id: 'acq_circuit_pending',
        hash: 'acq_circuit_pending',
        status: 'pending',
        attempts: 0,
        enqueued_at: nowIso,
        updated_at: nowIso,
        packet: failedRows[0].packet,
      },
    ];
    fs.writeFileSync(failingQueuePath, `${circuitRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const circuit = resolveAutoCaptureCircuit(circuitRows);
    assert.equal(circuit.open, true, 'recent provider failures should open a bounded circuit');
    const circuitProcessed = await processAutoCaptureQueue({
      db,
      config: failingQueueConfig,
      limit: 1,
      logger: { warn: () => {} },
      completeJson: async () => { throw new Error('should not run while circuit open'); },
    });
    assert.equal(circuitProcessed.circuit_open, true);
    assert.equal(circuitProcessed.processed, 0, 'provider circuit should prevent burning new pending rows');

    const staleQueueConfig = makeAutoConfig(ws.workspace, {
      mode: 'auto',
      provider: 'openclaw',
      maxCandidates: 2,
      maxTurns: 8,
      maxCharsPerTurn: 1200,
      includeExistingMemories: false,
      existingMemoryLimit: 0,
    });
    const staleQueuePath = resolveAutoCaptureQueuePath(staleQueueConfig);
    const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(staleQueuePath, `${JSON.stringify({
      id: 'acq_stale_processing',
      hash: 'acq_stale_processing',
      status: 'processing',
      attempts: 1,
      enqueued_at: staleAt,
      updated_at: staleAt,
      processing_started_at: staleAt,
      packet: failedRows[0].packet,
    })}\n`, 'utf8');
    const staleProcessed = await processAutoCaptureQueue({
      db,
      config: staleQueueConfig,
      limit: 1,
      logger: { warn: () => {} },
      completeJson: async () => { throw new Error('should not run while recovered row is deferred'); },
    });
    assert.equal(staleProcessed.processingRecovered, 1, 'stale processing rows should be recovered before processing');
    assert.equal(staleProcessed.processed, 0, 'recovered rows should honor retry backoff instead of immediately burning the LLM again');
    const staleRows = fs.readFileSync(staleQueuePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(staleRows[0].status, 'failed_retryable');
    assert.equal(staleRows[0].error_class, 'timeout_or_aborted');
    assert.equal(staleRows[0].error_message, 'stale_processing_recovered');
    assert.match(String(staleRows[0].next_attempt_at || ''), /^\d{4}-\d{2}-\d{2}T/);

  } finally {
    db.close();
  }
};

export { run };

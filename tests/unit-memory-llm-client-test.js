import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { completeMemoryJson, isOpenClawGatewayCompletionBaseUrl, resolveMemoryLlmConfig } from '../lib/core/memory-llm-client.js';
import { autoCaptureFromEvent } from '../lib/core/auto-capture-service.js';
import { reviewPendingQueue } from '../lib/core/queue-review-service.js';
import {
  makeTempWorkspace,
  makeConfigObject,
  openDb,
  writeConfigFile,
} from './helpers.js';
import { loadResolvedConfig } from '../lib/core/config.js';

const writeQueue = (queuePath, rows) => {
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
};

const withMockFetch = async (handler, fn) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(url, options);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const openAiCompatibleResponse = (content) => new Response(JSON.stringify({
  choices: [
    {
      message: {
        content,
      },
    },
  ],
}), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const run = async () => {
  assert.equal(isOpenClawGatewayCompletionBaseUrl('http://127.0.0.1:18789/v1'), true);
  assert.equal(isOpenClawGatewayCompletionBaseUrl('http://localhost:18789/v1/chat/completions'), true);
  assert.equal(isOpenClawGatewayCompletionBaseUrl('https://memory-llm.example/v1'), false);

  {
    const config = {
      memoryLlm: {
        enabled: true,
        provider: 'openai_compatible',
        baseUrl: 'https://memory-llm.example/v1',
        model: 'memory-json-model',
        apiKey: 'test-key',
      },
    };
    const resolved = resolveMemoryLlmConfig(config);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.provider, 'openai_compatible');
    await withMockFetch(
      () => openAiCompatibleResponse('{"ok":true}'),
      async (calls) => {
        const raw = await completeMemoryJson({
          config,
          prompt: 'Return {"ok":true}',
          profile: { temperature: 0, top_p: 1, max_tokens: 64 },
        });
        assert.match(raw, /"ok"/);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://memory-llm.example/v1/chat/completions');
        assert.equal(JSON.parse(calls[0].options.body).model, 'memory-json-model');
      },
    );
  }

  {
    await assert.rejects(
      () => completeMemoryJson({
        config: {
          memoryLlm: {
            enabled: true,
            provider: 'openai_compatible',
            baseUrl: 'https://memory-llm.example/v1',
            model: 'memory-json-model',
            apiKeyEnv: 'MISSING_MEMORY_LLM_KEY_FOR_TEST',
          },
        },
        prompt: 'Return JSON',
        profile: { max_tokens: 64 },
      }),
      /memory_llm_missing_api_key:MISSING_MEMORY_LLM_KEY_FOR_TEST/,
      'OpenAI-compatible memory LLM must fail before sending unauthenticated requests',
    );
  }

  {
    const temp = makeTempWorkspace('gb-v3-memory-llm-autocapture-');
    const raw = makeConfigObject(temp.workspace);
    const gb = raw.plugins.entries.gigabrain.config;
    gb.memoryLlm = {
      enabled: true,
      provider: 'openai_compatible',
      baseUrl: 'https://memory-llm.example/v1',
      model: 'memory-json-model',
      apiKey: 'test-key',
    };
    gb.capture.autoCapture = {
      enabled: true,
      mode: 'review',
      profile: 'auto_capture',
      minTriggerChars: 20,
    };
    gb.llm.provider = 'openclaw';
    gb.llm.baseUrl = 'http://127.0.0.1:18789/v1';
    gb.llm.model = 'openclaw/default';
    writeConfigFile(temp.configPath, raw);
    const { config } = loadResolvedConfig({ configPath: temp.configPath, mode: 'openclaw' });
    const db = openDb(temp.dbPath);
    try {
      await withMockFetch(
        () => openAiCompatibleResponse('{"candidates":[]}'),
        async (calls) => {
          const result = await autoCaptureFromEvent({
            db,
            config,
            event: {
              agentId: 'main',
              scope: 'profile:main',
              sessionKey: 'test-session',
              messages: [
                { role: 'user', content: 'Remember that production memory maintenance must avoid recursive OpenClaw sessions.' },
              ],
            },
            logger: { warn() {}, info() {} },
            runId: 'memory-llm-autocapture-test',
          });
          assert.equal(result.attempted, true);
          assert.equal(result.errors, 0);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].url.startsWith('https://memory-llm.example/v1/'), true, 'auto-capture must use stateless memory LLM endpoint');
          assert.equal(calls[0].url.includes('127.0.0.1:18789'), false, 'auto-capture must not call OpenClaw gateway');
        },
      );
    } finally {
      db.close();
    }
  }

  {
    const temp = makeTempWorkspace('gb-v3-memory-llm-autocapture-no-fallback-');
    const raw = makeConfigObject(temp.workspace);
    const gb = raw.plugins.entries.gigabrain.config;
    gb.memoryLlm = { enabled: false, provider: 'none' };
    gb.capture.autoCapture = {
      enabled: true,
      mode: 'review',
      provider: 'openclaw',
      profile: 'auto_capture',
      minTriggerChars: 20,
    };
    gb.llm.provider = 'openclaw';
    gb.llm.baseUrl = 'http://127.0.0.1:18789/v1';
    gb.llm.model = 'openclaw/default';
    writeConfigFile(temp.configPath, raw);
    const { config } = loadResolvedConfig({ configPath: temp.configPath, mode: 'openclaw' });
    const db = openDb(temp.dbPath);
    try {
      const result = await autoCaptureFromEvent({
        db,
        config,
        event: {
          agentId: 'main',
          scope: 'profile:main',
          sessionKey: 'test-session',
          messages: [
            { role: 'user', content: 'Remember that background memory maintenance must never recurse through OpenClaw.' },
          ],
        },
        logger: { warn() {}, info() {} },
        runId: 'memory-llm-autocapture-no-fallback-test',
      });
      assert.equal(result.errors, 1);
      assert.match(String(result.error), /auto_capture_requires_stateless_memory_llm/);
    } finally {
      db.close();
    }
  }

  {
    const temp = makeTempWorkspace('gb-v3-memory-llm-queue-review-');
    const raw = makeConfigObject(temp.workspace);
    const gb = raw.plugins.entries.gigabrain.config;
    gb.memoryLlm = {
      enabled: true,
      provider: 'openai_compatible',
      baseUrl: 'https://memory-llm.example/v1',
      model: 'memory-json-model',
      apiKey: 'test-key',
    };
    gb.llm.provider = 'openclaw';
    gb.llm.baseUrl = 'http://127.0.0.1:18789/v1';
    gb.llm.model = 'openclaw/default';
    gb.llm.queueReview = {
      enabled: true,
      limit: 10,
      minConfidence: 0.8,
      profile: 'memory_review',
      allowedReasons: ['capture_review_required'],
    };
    writeConfigFile(temp.configPath, raw);
    const { config } = loadResolvedConfig({ configPath: temp.configPath, mode: 'openclaw' });
    const queuePath = config.runtime.paths.reviewQueuePath;
    writeQueue(queuePath, [{
      status: 'pending',
      reason_code: 'capture_review_required',
      timestamp: '2026-04-28T00:00:00.000Z',
      payload: {
        type: 'DECISION',
        content: 'A transient fact that should not be stored.',
        excerpt: 'A transient fact that should not be stored.',
        scope: 'profile:main',
      },
    }]);
    const db = openDb(temp.dbPath);
    try {
      await withMockFetch(
        () => openAiCompatibleResponse('{"decision":"dismiss","confidence":0.95,"reason":"transient"}'),
        async (calls) => {
          const result = await reviewPendingQueue({
            db,
            config,
            dryRun: false,
            runId: 'memory-llm-queue-review-test',
            logger: { warn() {}, info() {} },
          });
          assert.equal(result.ok, true);
          assert.equal(result.dismissed, 1);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].url.startsWith('https://memory-llm.example/v1/'), true, 'queue review must use stateless memory LLM endpoint');
          assert.equal(calls[0].url.includes('127.0.0.1:18789'), false, 'queue review must not call OpenClaw gateway');
          const queueRows = fs.readFileSync(queuePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
          assert.equal(String(queueRows[0].status), 'resolved_auto');
        },
      );
    } finally {
      db.close();
    }
  }

  {
    const temp = makeTempWorkspace('gb-v3-memory-llm-queue-review-no-fallback-');
    const raw = makeConfigObject(temp.workspace);
    const gb = raw.plugins.entries.gigabrain.config;
    gb.memoryLlm = { enabled: false, provider: 'none' };
    gb.llm.provider = 'openclaw';
    gb.llm.baseUrl = 'http://127.0.0.1:18789/v1';
    gb.llm.model = 'openclaw/default';
    gb.llm.queueReview = {
      enabled: true,
      limit: 10,
      minConfidence: 0.8,
      profile: 'memory_review',
      allowedReasons: ['capture_review_required'],
    };
    writeConfigFile(temp.configPath, raw);
    const { config } = loadResolvedConfig({ configPath: temp.configPath, mode: 'openclaw' });
    const queuePath = config.runtime.paths.reviewQueuePath;
    writeQueue(queuePath, [{
      status: 'pending',
      reason_code: 'capture_review_required',
      timestamp: '2026-04-28T00:00:00.000Z',
      payload: {
        type: 'DECISION',
        content: 'A transient fact that should not be stored.',
        excerpt: 'A transient fact that should not be stored.',
        scope: 'profile:main',
      },
    }]);
    const db = openDb(temp.dbPath);
    try {
      const result = await reviewPendingQueue({
        db,
        config,
        dryRun: false,
        runId: 'memory-llm-queue-review-no-fallback-test',
        logger: { warn() {}, info() {} },
      });
      assert.equal(result.ok, true);
      assert.equal(result.failed, 1);
      const queueRows = fs.readFileSync(queuePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(String(queueRows[0].status), 'failed_terminal');
      assert.equal(String(queueRows[0].error_class), 'configuration');
      assert.match(String(queueRows[0].error || queueRows[0].error_message || ''), /queue_review_requires_stateless_memory_llm/);
    } finally {
      db.close();
    }
  }
};

export {
  run,
};

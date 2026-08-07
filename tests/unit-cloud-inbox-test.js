// ============================================================================
// #6 — cloud-agent ingest via watched export DROP-FOLDER.
//
// SYNTHETIC ONLY. Every conversation/turn here is invented; the only "real"
// strings are example.com URLs and placeholder names. NO personal data.
//
// Closed cloud products (ChatGPT/Gemini/Copilot) are CLOUD_MANUAL_HOSTS,
// reachable ONLY via the official user-initiated export each vendor sanctions.
// This bridges them HONESTLY: NO scraping, NO upload, raw export text never
// leaves the machine — it passes through the SAME local-redaction prefilter as
// host_sync and is ingested at the manual_import trust FLOOR.
//
// Assertions:
//   (1) synthetic OpenAI conversations.json in chatgpt/ → facts at the
//       manual_import floor with chatgpt_manual provenance;
//   (2) synthetic Google Takeout / Gemini export → gemini_manual;
//   (3) a secret embedded in an export is STRIPPED (never stored);
//   (4) last_export_age is stamped + the doctor flags a stale source;
//   (5) empty / disabled inbox → an entire no-op.
//   (NET) NO network / NO upload — global fetch + http(s).request are trapped
//         and asserted unused across every scan.
// ============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import {
  cloudInboxStaleness,
  scanCloudInbox,
  syncHostMemories,
} from '../lib/core/host-memory-sync.js';
import { projectArbitrationBeliefRows } from '../lib/core/world-model.js';
import { makeConfigObject, makeTempWorkspace, openDb } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
};

// Build a normalized config with the cloud-inbox pointed at `dir`. We override
// the ALREADY-normalized native block (dir is pre-resolved absolute) so the
// scanner watches exactly our synthetic drop folder.
const makeCloudConfig = (workspace, dir, { enabled = true, staleDays = 30 } = {}) => {
  const base = normalizeConfig(makeConfigObject(workspace).plugins.entries.gigabrain.config);
  return {
    ...base,
    codex: { ...base.codex, projectRoot: workspace, defaultUserScope: 'profile:user' },
    native: { ...base.native, cloudInbox: { enabled, dir, staleDays } },
  };
};

// A SYNTHETIC OpenAI conversations.json: top-level array, each conversation a
// `mapping` of message nodes (the official export shape). Invented turns only.
const syntheticOpenAiExport = ({ extraUserText } = {}) => ([
  {
    title: 'Trip planning',
    create_time: 1700000000,
    mapping: {
      n1: { message: { author: { role: 'system' }, content: { parts: ['You are a helpful assistant.'] } } },
      n2: { message: { author: { role: 'user' }, content: { parts: ['The user prefers window seats on long flights.'] } } },
      n3: { message: { author: { role: 'assistant' }, content: { parts: ['Noted, I will prioritize window seats.'] } } },
      ...(extraUserText
        ? { n4: { message: { author: { role: 'user' }, content: { parts: [extraUserText] } } } }
        : {}),
    },
  },
]);

// A SYNTHETIC Google Takeout / Gemini export: {conversations:[{messages:[...]}]}.
const syntheticGeminiExport = () => ({
  conversations: [
    {
      messages: [
        { role: 'user', text: 'The user is allergic to shellfish and avoids it entirely.' },
        { role: 'model', text: 'Understood, I will flag shellfish in any recipe.' },
      ],
    },
  ],
});

const factsForHost = (db, sourceHost) => db.prepare(`
  SELECT m.content, m.confidence, m.source_host, m.source_kind, m.tags
  FROM memory_current m
  WHERE m.source_host = ? AND m.status = 'active'
  ORDER BY m.content ASC
`).all(String(sourceHost));

// ----------------------------------------------------------------------------
// Network trap: assert NO scan ever opens a socket or calls fetch.
// ----------------------------------------------------------------------------
const withNetworkTrap = async (fn) => {
  const calls = [];
  const origFetch = globalThis.fetch;
  const origHttp = http.request;
  const origHttps = https.request;
  globalThis.fetch = (...args) => { calls.push(['fetch', String(args[0])]); throw new Error('network call attempted in cloud-inbox test'); };
  http.request = (...args) => { calls.push(['http', String(args[0])]); throw new Error('http.request attempted in cloud-inbox test'); };
  https.request = (...args) => { calls.push(['https', String(args[0])]); throw new Error('https.request attempted in cloud-inbox test'); };
  try {
    await fn();
  } finally {
    globalThis.fetch = origFetch;
    http.request = origHttp;
    https.request = origHttps;
  }
  assert.equal(calls.length, 0, `cloud-inbox must make ZERO network calls; saw: ${JSON.stringify(calls)}`);
};

// ----------------------------------------------------------------------------
// (1) Synthetic OpenAI conversations.json → chatgpt_manual facts at the floor.
// ----------------------------------------------------------------------------
const runOpenAiIngest = async () => {
  const temp = makeTempWorkspace('gb-cloud-chatgpt-');
  const dir = path.join(temp.root, 'cloud-inbox');
  writeJson(path.join(dir, 'chatgpt', 'conversations.json'), syntheticOpenAiExport());
  const config = makeCloudConfig(temp.workspace, dir);
  try {
    const db = openDb(temp.dbPath);
    let summary;
    try {
      summary = scanCloudInbox({ db, config, scope: 'profile:user', incremental: true });
      assert.equal(summary.enabled, true, 'scan runs when cloudInbox.enabled');
      assert.equal(summary.inserted_count >= 2, true, 'both synthetic chatgpt turns ingested');

      const rows = factsForHost(db, 'chatgpt_manual');
      assert.equal(rows.length >= 2, true, 'chatgpt_manual facts present');
      for (const row of rows) {
        assert.equal(row.source_host, 'chatgpt_manual', 'provenance source_host = chatgpt_manual');
        assert.equal(row.source_kind, 'manual_import', 'ingested at the manual_import kind (trust floor)');
        // manual_import floor: ingestConfidence caps cloud manual at ~0.5.
        assert.equal(Number(row.confidence) <= 0.5 + 1e-9, true, `confidence at/below manual_import floor (got ${row.confidence})`);
        const tags = JSON.parse(row.tags || '[]');
        assert.equal(tags.includes('cloud_inbox'), true, 'tagged cloud_inbox');
        assert.equal(tags.includes('cloud_vendor:chatgpt'), true, 'tagged with vendor');
        assert.equal(tags.some((t) => String(t).startsWith('last_export_age:')), true, 'carries a last_export_age stamp');
      }
      // The system turn ("You are a helpful assistant.") is NOT ingested.
      const sys = db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content LIKE '%helpful assistant%'").get();
      assert.equal(Number(sys.c), 0, 'system-role turns are not ingested');

      // (incremental) A clean re-scan touches the same file as unchanged.
      const second = scanCloudInbox({ db, config, scope: 'profile:user', incremental: true });
      assert.equal(second.files_unchanged >= 1, true, 'unchanged export skips via the shared incremental cursor');
      assert.equal(second.inserted_count, 0, 'clean re-scan inserts nothing');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (2) Synthetic Google Takeout / Gemini export → gemini_manual provenance.
// ----------------------------------------------------------------------------
const runGeminiIngest = async () => {
  const temp = makeTempWorkspace('gb-cloud-gemini-');
  const dir = path.join(temp.root, 'cloud-inbox');
  writeJson(path.join(dir, 'gemini', 'MyActivity.json'), syntheticGeminiExport());
  const config = makeCloudConfig(temp.workspace, dir);
  try {
    const db = openDb(temp.dbPath);
    try {
      const summary = scanCloudInbox({ db, config, scope: 'profile:user', incremental: true });
      assert.equal(summary.inserted_count >= 1, true, 'gemini export ingested');
      const rows = factsForHost(db, 'gemini_manual');
      assert.equal(rows.length >= 1, true, 'gemini_manual facts present');
      assert.equal(rows.every((r) => r.source_host === 'gemini_manual'), true, 'provenance source_host = gemini_manual');
      assert.equal(rows.every((r) => r.source_kind === 'manual_import'), true, 'gemini facts at manual_import floor');
      assert.equal(rows.some((r) => r.content.includes('allergic to shellfish')), true, 'the synthetic gemini fact is stored');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (3) A secret embedded in an export is STRIPPED — never stored.
// ----------------------------------------------------------------------------
const runSecretStripped = async () => {
  const temp = makeTempWorkspace('gb-cloud-secret-');
  const dir = path.join(temp.root, 'cloud-inbox');
  // A synthetic API key in a user turn using an explicit secret label.
  const secretLine = 'My deploy api_key=topsecretvalue123 must never be retained';
  writeJson(path.join(dir, 'chatgpt', 'conversations.json'), syntheticOpenAiExport({ extraUserText: secretLine }));
  const config = makeCloudConfig(temp.workspace, dir);
  try {
    const db = openDb(temp.dbPath);
    try {
      scanCloudInbox({ db, config, scope: 'profile:user', incremental: true });
      // The literal secret tokens must appear NOWHERE in stored memory.
      const leaked = db.prepare(`
        SELECT COUNT(*) AS c FROM memory_current
        WHERE content LIKE '%topsecretvalue123%'
      `).get();
      assert.equal(Number(leaked.c), 0, 'the synthetic secret is STRIPPED and never stored');
      // The non-secret turns still made it in (redaction is surgical, not a drop-all).
      const ok = db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content LIKE '%window seats%'").get();
      assert.equal(Number(ok.c) >= 1, true, 'non-secret facts in the same export are still ingested');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (4) last_export_age stamped + the doctor flags a STALE source.
// ----------------------------------------------------------------------------
const runStalenessAndDoctorNudge = async () => {
  const temp = makeTempWorkspace('gb-cloud-stale-');
  const dir = path.join(temp.root, 'cloud-inbox');
  const exportPath = path.join(dir, 'chatgpt', 'conversations.json');
  writeJson(exportPath, syntheticOpenAiExport());
  // Backdate the export file 45 days so it is older than the 30-day threshold.
  const oldMs = Date.now() - 45 * DAY_MS;
  fs.utimesSync(exportPath, new Date(oldMs), new Date(oldMs));
  const config = makeCloudConfig(temp.workspace, dir, { staleDays: 30 });
  try {
    const db = openDb(temp.dbPath);
    try {
      const summary = scanCloudInbox({ db, config, scope: 'profile:user', incremental: true });
      // last_export_age is stamped from the (backdated) file mtime.
      const stamped = summary.sources.find((s) => s.vendor === 'chatgpt');
      assert.ok(stamped, 'a chatgpt source was recorded');
      assert.equal(Math.abs(Number(stamped.last_export_mtime_ms) - oldMs) < 2000, true, 'last_export_age reflects the file mtime');

      // The doctor staleness report flags chatgpt as stale and leaves the
      // unused vendors as missing (informational, not stale).
      const report = cloudInboxStaleness({ db, config });
      const chatgpt = report.find((r) => r.vendor === 'chatgpt');
      assert.equal(chatgpt.status, 'stale', 'a 45-day-old export is flagged stale at staleDays=30');
      assert.equal(chatgpt.age_days >= 30, true, 'reported age exceeds the threshold');
      const gemini = report.find((r) => r.vendor === 'gemini');
      assert.equal(gemini.status, 'missing', 'an unused vendor reports missing, not stale');

      // A FRESH export (mtime now) is NOT flagged stale.
      const freshDir = path.join(temp.root, 'cloud-inbox-fresh');
      const freshPath = path.join(freshDir, 'chatgpt', 'conversations.json');
      writeJson(freshPath, syntheticOpenAiExport());
      const freshConfig = makeCloudConfig(temp.workspace, freshDir, { staleDays: 30 });
      const db2 = openDb(path.join(temp.memoryRoot, 'fresh.sqlite'));
      try {
        scanCloudInbox({ db: db2, config: freshConfig, scope: 'profile:user', incremental: true });
        const freshReport = cloudInboxStaleness({ db: db2, config: freshConfig });
        assert.equal(freshReport.find((r) => r.vendor === 'chatgpt').status, 'fresh', 'a just-written export is fresh');
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (5) Empty / disabled inbox → an entire no-op.
// ----------------------------------------------------------------------------
const runDisabledAndEmptyNoop = async () => {
  const temp = makeTempWorkspace('gb-cloud-noop-');
  const dir = path.join(temp.root, 'cloud-inbox');
  // Even with a populated drop folder, enabled:false → no-op.
  writeJson(path.join(dir, 'chatgpt', 'conversations.json'), syntheticOpenAiExport());

  const disabledConfig = makeCloudConfig(temp.workspace, dir, { enabled: false });
  try {
    const db = openDb(temp.dbPath);
    try {
      const disabled = scanCloudInbox({ db, config: disabledConfig, scope: 'profile:user', incremental: true });
      assert.equal(disabled.enabled, false, 'disabled cloudInbox reports enabled:false');
      assert.equal(disabled.inserted_count, 0, 'disabled inbox ingests nothing');
      assert.equal(disabled.files_scanned, 0, 'disabled inbox touches no files');
      assert.equal(cloudInboxStaleness({ db, config: disabledConfig }).length, 0, 'disabled inbox yields no staleness rows');

      // Enabled but EMPTY drop folder → no-op (no vendor sub-dirs present).
      const emptyDir = path.join(temp.root, 'empty-inbox');
      fs.mkdirSync(emptyDir, { recursive: true });
      const emptyConfig = makeCloudConfig(temp.workspace, emptyDir, { enabled: true });
      const empty = scanCloudInbox({ db, config: emptyConfig, scope: 'profile:user', incremental: true });
      assert.equal(empty.enabled, true, 'empty inbox is enabled');
      assert.equal(empty.files_scanned, 0, 'empty inbox finds no export files');
      assert.equal(empty.inserted_count, 0, 'empty inbox ingests nothing');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

// ----------------------------------------------------------------------------
// (6) host_sync integration: syncHostMemories drives the cloud-inbox scan when
//     enabled, and remains a no-op when disabled (no local hosts present).
// ----------------------------------------------------------------------------
const runHostSyncDrivesScan = async () => {
  const temp = makeTempWorkspace('gb-cloud-hostsync-');
  const dir = path.join(temp.root, 'cloud-inbox');
  writeJson(path.join(dir, 'chatgpt', 'conversations.json'), syntheticOpenAiExport());
  const config = makeCloudConfig(temp.workspace, dir);
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  // Repoint host discovery at empty scratch dirs so the ONLY ingest is cloud.
  const emptyHome = path.join(temp.root, 'empty-home');
  fs.mkdirSync(emptyHome, { recursive: true });
  process.env.HOME = emptyHome;
  process.env.CODEX_HOME = path.join(emptyHome, '.codex');
  try {
    const db = openDb(temp.dbPath);
    try {
      const summary = syncHostMemories({
        db,
        config,
        incremental: true,
        arbitrate: true,
        projectBeliefRows: projectArbitrationBeliefRows,
      });
      assert.equal(summary.ok, true, 'host sync with cloud inbox succeeds');
      assert.ok(summary.cloud_inbox, 'host sync surfaces a cloud_inbox section');
      assert.equal(summary.cloud_inbox.inserted_count >= 2, true, 'host sync drove the cloud-inbox scan');
      assert.equal(factsForHost(db, 'chatgpt_manual').length >= 2, true, 'cloud facts ingested via host sync');
    } finally {
      db.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
};

const run = async () => {
  await withNetworkTrap(async () => {
    await runOpenAiIngest();
    await runGeminiIngest();
    await runSecretStripped();
    await runStalenessAndDoctorNudge();
    await runDisabledAndEmptyNoop();
    await runHostSyncDrivesScan();
  });
  fs.writeSync(1, 'cloud-inbox drop-folder ingest (#6): all assertions passed (NO network, secrets stripped, manual_import floor)\n');
};

export { run };

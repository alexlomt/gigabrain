import crypto from 'node:crypto';

import { appendEvent, ensureEventStore } from './event-store.js';
import { hostTrustScore, arbitrationTrustOverrides } from './host-trust.js';

// ---------------------------------------------------------------------------
// Adaptive host trust (B1) — SHADOW-FIRST.
//
// A host whose facts keep losing clean, independently-witnessed verdicts
// drifts DOWN; trust heals passively via evidence decay and wins. The drift is
// a projection over the append-only ledger (arbiter:verdict /
// arbiter:reinstate / operator:reinstate): recomputation from the ledger
// reproduces the target exactly, and the per-cycle path is itself receipted as
// trust:drift events. Nothing here mutates arbitration unless
// `worldModel.arbiter.adaptiveTrust.enabled === true` — the default nightly
// step only computes, persists, and logs (the U16 shadow pattern).
//
// Safety properties encoded from adversarial regression findings:
//  - CLEANLINESS GATE: only verdicts whose ledger signals carry a slot, whose
//    slot is NOT a cue-gated user.topic.* group, and whose winner/loser sit on
//    DIFFERENT hosts contribute. Cross-topic residue can produce a false
//    supersession; feeding that into a trust loop would amplify a
//    clustering bug into a poisoned referee.
//  - REVERSALS COUNT AGAINST THE WINNER: an operator:reinstate (a human said
//    the verdict was wrong) voids the verdict's contribution and penalizes the
//    winning host at double weight; an arbiter:reinstate (the slot flipped)
//    voids the original contribution.
//  - OPERATOR OVERRIDES ARE ABSOLUTE: an arbitration host-trust pin
//    (config.trust.arbitrationHostTrust, legacy config.hostTrust) stops drift
//    consumption for that host; when the adaptive view disagrees by > 0.1 a
//    trust:shadowed event says so instead of silently fighting it.
// ---------------------------------------------------------------------------

const ADAPTIVE_TRUST_DEFAULTS = Object.freeze({
  enabled: false,
  witnessMin: 3,
  maxDriftPerCycle: 0.02,
  trustFloor: 0.35,
  trustCeil: 0.95,
  evidenceHalfLifeDays: 90,
  // Shadow-phase scoring heuristics (revisit at the enable gate): one clean
  // witnessed loss moves the target by −0.02, one clean win by +0.005, an
  // operator reversal by −0.04 — all decayed by evidence age.
  lossStep: 0.02,
  winStep: 0.005,
  reversalStep: 0.04,
  // The target itself is bounded so no evidence pile can drag a host outside
  // a ±0.15 band around its base tier before floor/ceil clamping.
  maxTargetMagnitude: 0.15,
});

const resolveAdaptiveTrustSettings = (config = {}) => {
  const raw = config?.worldModel?.arbiter?.adaptiveTrust;
  const merged = { ...ADAPTIVE_TRUST_DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(ADAPTIVE_TRUST_DEFAULTS)) {
      if (raw[key] === undefined) continue;
      if (key === 'enabled') merged.enabled = raw.enabled === true;
      else {
        const n = Number(raw[key]);
        if (Number.isFinite(n)) merged[key] = n;
      }
    }
  }
  return Object.freeze(merged);
};

const ensureAdaptiveTrustStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_host_trust (
      host TEXT PRIMARY KEY,
      delta REAL NOT NULL DEFAULT 0,
      target REAL NOT NULL DEFAULT 0,
      evidence TEXT,
      computed_at TEXT,
      input_fingerprint TEXT
    )
  `);
};

const HOST_MEMORY_ID_RE = /^host:([a-z0-9_]+):/i;

const sha256 = (value = '') => crypto.createHash('sha256').update(String(value)).digest('hex');

// Resolve the host a memory id belongs to: the deterministic host-sync id
// prefix first, then memory_current provenance. Rows the store no longer
// knows return null and are excluded (cleanliness over coverage).
const makeHostResolver = (db) => {
  const stmt = db.prepare('SELECT source_host FROM memory_current WHERE memory_id = ?');
  const cache = new Map();
  return (memoryId) => {
    const id = String(memoryId || '');
    if (!id) return null;
    if (cache.has(id)) return cache.get(id);
    let host = null;
    const prefixed = HOST_MEMORY_ID_RE.exec(id);
    if (prefixed) host = prefixed[1].toLowerCase();
    else {
      const row = stmt.get(id);
      host = row?.source_host ? String(row.source_host).trim().toLowerCase() : null;
    }
    cache.set(id, host || null);
    return host || null;
  };
};

const parsePayload = (raw) => {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

// Pure fold: ledger → per-host evidence + drift target. No writes.
const computeAdaptiveTrustTargets = ({ db, config, now = new Date().toISOString(), ensure = true } = {}) => {
  if (!db) throw new Error('computeAdaptiveTrustTargets requires db');
  if (ensure !== false) ensureEventStore(db);
  const settings = resolveAdaptiveTrustSettings(config);
  const hostOf = makeHostResolver(db);
  const nowMs = Date.parse(now) || Date.now();
  const halfLifeMs = Math.max(1, settings.evidenceHalfLifeDays) * 24 * 60 * 60 * 1000;

  const events = db.prepare(`
    SELECT event_id, action, memory_id, payload, timestamp
    FROM memory_events
    WHERE action IN ('arbiter:verdict', 'arbiter:reinstate', 'operator:reinstate')
    ORDER BY timestamp ASC, rowid ASC
  `).all();

  // Rows later reinstated void every verdict that superseded them; operator
  // reinstatements additionally penalize the verdict's winner.
  const arbiterReinstated = new Set();
  const operatorReinstated = new Set();
  for (const event of events) {
    if (event.action === 'arbiter:reinstate') arbiterReinstated.add(String(event.memory_id || ''));
    if (event.action === 'operator:reinstate') operatorReinstated.add(String(event.memory_id || ''));
  }

  const hosts = new Map();
  const hostEntry = (host) => {
    if (!hosts.has(host)) {
      hosts.set(host, {
        winScore: 0,
        lossScore: 0,
        reversalScore: 0,
        losses: [],
        contributingEvents: [],
        excluded: { no_slot: 0, topic_slot: 0, same_host: 0, unresolvable_host: 0, voided: 0 },
      });
    }
    return hosts.get(host);
  };

  for (const event of events) {
    if (event.action !== 'arbiter:verdict') continue;
    const payload = parsePayload(event.payload);
    const winnerId = String(payload.winnerId || '');
    const loserIds = Array.isArray(payload.loserIds) ? payload.loserIds.map(String) : [];
    const winnerHost = hostOf(winnerId);
    if (!winnerHost) continue;
    const entry = hostEntry(winnerHost);
    const slot = String(payload.signals?.slot || '');
    if (!slot) {
      entry.excluded.no_slot += 1;
      continue;
    }
    if (slot.startsWith('user.topic.')) {
      entry.excluded.topic_slot += 1;
      continue;
    }
    const eventMs = Date.parse(String(event.timestamp || '')) || nowMs;
    const weight = 0.5 ** (Math.max(0, nowMs - eventMs) / halfLifeMs);

    const operatorVoided = loserIds.some((id) => operatorReinstated.has(id));
    const arbiterVoided = !operatorVoided && loserIds.some((id) => arbiterReinstated.has(id));
    if (operatorVoided) {
      entry.reversalScore += weight;
      entry.contributingEvents.push(event.event_id);
      continue;
    }
    if (arbiterVoided) {
      entry.excluded.voided += 1;
      continue;
    }

    let counted = false;
    for (const loserId of loserIds) {
      const loserHost = hostOf(loserId);
      if (!loserHost) {
        entry.excluded.unresolvable_host += 1;
        continue;
      }
      if (loserHost === winnerHost) {
        entry.excluded.same_host += 1;
        continue;
      }
      hostEntry(loserHost).losses.push({ winnerHost, weight, ts: eventMs, eventId: event.event_id });
      counted = true;
    }
    if (counted) {
      entry.winScore += weight;
      entry.contributingEvents.push(event.event_id);
    }
  }

  const independenceWindowMs = Number(config?.worldModel?.arbiter?.independenceWindowMs) || 10 * 60 * 1000;
  const results = {};
  const fingerprintParts = [];
  for (const [host, entry] of hosts.entries()) {
    // Witness gate (T3, shadow heuristic — refine before enable): downward
    // evidence needs witnessMin losses from distinct winning hosts, or — when
    // a single host supplies all wins — losses spread wider than the
    // independence window (one burst is one witness, not many).
    const distinctWinners = new Set(entry.losses.map((l) => l.winnerHost));
    const spanMs = entry.losses.length > 1
      ? Math.max(...entry.losses.map((l) => l.ts)) - Math.min(...entry.losses.map((l) => l.ts))
      : 0;
    const witnessed = entry.losses.length >= Math.trunc(settings.witnessMin)
      && (distinctWinners.size >= 2 || spanMs > independenceWindowMs);
    const lossScore = witnessed ? entry.losses.reduce((sum, l) => sum + l.weight, 0) : 0;
    const rawTarget = settings.winStep * entry.winScore
      - settings.lossStep * lossScore
      - settings.reversalStep * entry.reversalScore;
    const target = Math.max(-settings.maxTargetMagnitude, Math.min(settings.maxTargetMagnitude, rawTarget));
    const evidence = {
      wins_weighted: Number(entry.winScore.toFixed(6)),
      losses_weighted: Number(lossScore.toFixed(6)),
      losses_total: entry.losses.length,
      distinct_witnesses: distinctWinners.size,
      witnessed,
      operator_reversals_weighted: Number(entry.reversalScore.toFixed(6)),
      excluded: entry.excluded,
    };
    results[host] = { target: Number(target.toFixed(6)), evidence };
    fingerprintParts.push(`${host}:${entry.contributingEvents.sort().join(',')}:${entry.losses.map((l) => l.eventId).sort().join(',')}`);
  }
  const fingerprint = sha256(fingerprintParts.sort().join('|') + JSON.stringify(settings));
  return { hosts: results, fingerprint, settings };
};

// Nightly step: recompute targets, move stored deltas by at most
// maxDriftPerCycle, receipt every change as a trust:drift ledger event.
// Shadow by default — nothing reads the deltas unless the enable flag is on.
const runAdaptiveTrust = ({ db, config, now = new Date().toISOString(), dryRun = false, ensure = true } = {}) => {
  if (!db) throw new Error('runAdaptiveTrust requires db');
  if (ensure !== false) ensureAdaptiveTrustStore(db);
  const { hosts, fingerprint, settings } = computeAdaptiveTrustTargets({ db, config, now, ensure });
  const operatorOverrides = arbitrationTrustOverrides(config);
  const summary = { ok: true, shadow: settings.enabled !== true, dry_run: dryRun === true, hosts: [], drifted: [], fingerprint };

  // Evidence decay moves the target a hair on every recompute; below this
  // epsilon the host counts as settled — no delta movement, no drift event
  // (otherwise every nightly would append a microscopic receipt forever).
  const DRIFT_EPSILON = 0.001;
  for (const [host, { target, evidence }] of Object.entries(hosts)) {
    const stored = db.prepare('SELECT delta FROM memory_host_trust WHERE host = ?').get(host);
    const previous = Number(stored?.delta || 0);
    const settled = Math.abs(target - previous) <= DRIFT_EPSILON;
    const step = settled ? 0 : Math.max(-settings.maxDriftPerCycle, Math.min(settings.maxDriftPerCycle, target - previous));
    const next = Number((previous + step).toFixed(6));
    const base = hostTrustScore(host, {});
    const overridden = Object.prototype.hasOwnProperty.call(operatorOverrides, host);
    const effective = overridden
      ? Number(operatorOverrides[host])
      : Math.max(settings.trustFloor, Math.min(settings.trustCeil, base + next));
    summary.hosts.push({ host, base, delta: next, target, effective, overridden, evidence });

    if (dryRun) continue;
    if (Math.abs(next - previous) > 1e-9) {
      db.prepare(`
        INSERT INTO memory_host_trust (host, delta, target, evidence, computed_at, input_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
          delta = excluded.delta,
          target = excluded.target,
          evidence = excluded.evidence,
          computed_at = excluded.computed_at,
          input_fingerprint = excluded.input_fingerprint
      `).run(host, next, target, JSON.stringify(evidence), now, fingerprint);
      appendEvent(db, {
        component: 'adaptive_trust',
        action: 'trust:drift',
        memory_id: `host:${host}`,
        reason_codes: ['adaptive_trust_recompute'],
        timestamp: now,
        payload: { host, from: previous, to: next, target, shadow: settings.enabled !== true, fingerprint, evidence },
      });
      summary.drifted.push({ host, from: previous, to: next });
      if (overridden && Math.abs((base + next) - Number(operatorOverrides[host])) > 0.1) {
        appendEvent(db, {
          component: 'adaptive_trust',
          action: 'trust:shadowed',
          memory_id: `host:${host}`,
          reason_codes: ['operator_override_disagrees'],
          timestamp: now,
          payload: { host, operator: Number(operatorOverrides[host]), adaptive: base + next },
        });
      }
    } else {
      db.prepare(`
        INSERT INTO memory_host_trust (host, delta, target, evidence, computed_at, input_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
          target = excluded.target,
          evidence = excluded.evidence,
          computed_at = excluded.computed_at,
          input_fingerprint = excluded.input_fingerprint
      `).run(host, next, target, JSON.stringify(evidence), now, fingerprint);
    }
  }
  return summary;
};

// Consumption hook for runBeliefArbitration: when (and only when) the enable
// flag is on, stored deltas become arbitration host-trust overrides for hosts
// the operator has NOT pinned (operator precedence is absolute). Returns null
// in shadow.
const loadAdaptiveTrustOverrides = ({ db, config } = {}) => {
  const settings = resolveAdaptiveTrustSettings(config);
  if (settings.enabled !== true || !db) return null;
  ensureAdaptiveTrustStore(db);
  const operatorOverrides = arbitrationTrustOverrides(config);
  const rows = db.prepare('SELECT host, delta FROM memory_host_trust').all();
  const overrides = {};
  for (const row of rows) {
    const host = String(row.host || '');
    if (!host || Object.prototype.hasOwnProperty.call(operatorOverrides, host)) continue;
    const base = hostTrustScore(host, {});
    overrides[host] = Math.max(settings.trustFloor, Math.min(settings.trustCeil, base + Number(row.delta || 0)));
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
};

export {
  ADAPTIVE_TRUST_DEFAULTS,
  resolveAdaptiveTrustSettings,
  ensureAdaptiveTrustStore,
  computeAdaptiveTrustTargets,
  runAdaptiveTrust,
  loadAdaptiveTrustOverrides,
};

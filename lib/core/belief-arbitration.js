// ============================================================================
// BELIEF ARBITRATION (U17) — the arbiter, extracted from world-model.js
// ============================================================================
//
// The extraction boundary: GIVEN BELIEF ROWS, cluster → rule → verdicts.
//
//   - Position clustering (U13a): exact-value buckets merged by token-set
//     similarity with negation/digit zero-guards, optional flag-gated LLM
//     refinement.
//   - The arbitration rule (U2/U13): trust tier > distinct-agent corroboration
//     > recency, with identity defenses (sock-puppet cap, independence
//     window), clock defenses (content-time floor, recency-ambiguity window),
//     change-cue gating + bounded collateral for user.topic.* domain groups
//     (U13b/U13c), same-scope-only verdicts with a cross-scope review surface.
//   - recordVerdict orchestration: idempotent ledger emission inside the
//     caller-supplied db (pure callers get the same winner/loser marks with
//     no side effects).
//
// Belief PROJECTION (memory_current rows → belief rows with claim slots) does
// NOT live here — it shares the entity/claim machinery and stays in
// world-model.js (`projectArbitrationBeliefRows`). `runBeliefArbitration`
// takes the projector as a parameter, so arbitration runs with
// `worldModel.enabled = false`: the toggle gates the world-model SURFACES
// (entities, briefs, syntheses), never the verdicts.
//
// NO MODULE-GLOBAL STATE (U17 fold): the former configureBeliefTrust globals
// (BELIEF_ARBITER / BELIEF_HOST_TRUST / BELIEF_TRUST_CONFIG) are a frozen
// settings object produced by `resolveArbiterSettings(config)` and passed as
// a parameter. Config flows in; nothing mutates the module.
// ============================================================================

import { normalizeContent } from './policy.js';
import { getCurrentMemory, recordVerdict } from './projection-store.js';
import {
  hostTrustScore, isRegisteredAgent, TRUST, pickHostTrustMap, arbitrationTrustOverrides,
} from './host-trust.js';
import { loadAdaptiveTrustOverrides } from './adaptive-trust.js';

const parseJsonSafe = (value, fallback) => {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

// U13 (R10) arbiter robustness knobs. Bounds are re-clamped in
// resolveArbiterSettings because callers pass raw (un-normalized) configs in
// tests and standalone paths.
const DEFAULT_BELIEF_ARBITER = Object.freeze({
  clusterThreshold: 0.55, // token-set similarity gate for merging claim values
  recencyAmbiguityWindowMs: 5 * 60 * 1000, // equal tier+support inside → ambiguous
  independenceWindowMs: 10 * 60 * 1000, // same-host near-identical text inside → one witness
  supportCapPerSource: 1, // max witnesses per (source_host, source_kind)
  refine: null, // optional local-LLM cluster refiner (flag-gated, default OFF)
});

// Pure replacement for the former configureBeliefTrust module mutation: turn a
// raw config into the frozen settings the arbitration functions consume.
//  - trustConfig  → host-trust.js#hostTrustScore overrides: the ARBITRATION
//                   host-trust map (config.trust.arbitrationHostTrust, legacy
//                   config.hostTrust) + the agent registry for the sock-puppet cap.
//  - hostTrust    → per-host belief-SCORE weighting: the SCORING host-trust map
//                   (config.trust.scoringHostTrust, legacy config.worldModel.hostTrust).
//  - the four U13 knobs + the flag-gated refiner.
// The two maps are distinct policies that historically shared the name
// "hostTrust"; the explicit trust policy keeps them separate (see config.js).
const resolveArbiterSettings = (config = {}) => {
  const arbMap = arbitrationTrustOverrides(config);
  const trustConfig = Object.keys(arbMap).length > 0 ? { hostTrust: arbMap } : {};
  if (Array.isArray(config?.agentRegistry)) trustConfig.agentRegistry = config.agentRegistry;
  const arb = config?.worldModel?.arbiter && typeof config.worldModel.arbiter === 'object'
    ? config.worldModel.arbiter
    : {};
  const bounded = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  const scoreMap = pickHostTrustMap(config?.trust?.scoringHostTrust, config?.worldModel?.hostTrust);
  const raw = Object.keys(scoreMap).length > 0 ? scoreMap : null;
  let hostTrust = null;
  if (raw) {
    const map = {};
    for (const [host, weight] of Object.entries(raw)) {
      const w = Number(weight);
      if (!host || !Number.isFinite(w)) continue;
      map[String(host).trim().toLowerCase()] = Math.max(0, Math.min(1, w));
    }
    hostTrust = Object.keys(map).length > 0 ? map : null;
  }
  return Object.freeze({
    trustConfig: Object.freeze(trustConfig),
    hostTrust: hostTrust ? Object.freeze(hostTrust) : null,
    clusterThreshold: bounded(arb.clusterThreshold, 0.05, 1, DEFAULT_BELIEF_ARBITER.clusterThreshold),
    recencyAmbiguityWindowMs: bounded(arb.recencyAmbiguityWindowMs, 0, 60 * 60 * 1000, DEFAULT_BELIEF_ARBITER.recencyAmbiguityWindowMs),
    independenceWindowMs: bounded(arb.independenceWindowMs, 0, 24 * 60 * 60 * 1000, DEFAULT_BELIEF_ARBITER.independenceWindowMs),
    supportCapPerSource: Math.trunc(bounded(arb.supportCapPerSource, 1, 100, DEFAULT_BELIEF_ARBITER.supportCapPerSource)),
    // Deterministic clustering is the tested path; the refiner only engages
    // when the flag is ON and a callable was injected (no network by default).
    refine: arb.clusterLlmRefinement === true && typeof arb.__clusterRefine === 'function'
      ? arb.__clusterRefine
      : null,
  });
};

const DEFAULT_ARBITER_SETTINGS = resolveArbiterSettings({});

const resolveBeliefTemporalScope = (belief = {}) => {
  const status = String(belief.status || '').trim().toLowerCase();
  const validTo = String(belief.valid_to || '').trim();
  if (status === 'stale' || status === 'superseded') return 'historical';
  if (validTo) {
    const parsed = Date.parse(validTo);
    if (Number.isFinite(parsed) && parsed < Date.now()) return 'historical';
  }
  return 'currentish';
};

const resolveBeliefSourceStrength = (belief = {}) => {
  if (String(belief?.payload?.source_strength || '').trim()) {
    return String(belief.payload.source_strength).trim();
  }
  const confidence = Number(belief.confidence || 0);
  if (String(belief.source_layer || '').trim().toLowerCase() === 'registry') {
    return confidence >= 0.85 ? 'strong' : 'medium';
  }
  return confidence >= 0.9 ? 'strong' : confidence >= 0.8 ? 'medium' : 'weak';
};

const beliefRecencyBoost = (belief = {}) => {
  const ts = Date.parse(String(belief.valid_from || belief.updated_at || belief.created_at || ''));
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (ageDays <= 7) return 0.08;
  if (ageDays <= 30) return 0.05;
  if (ageDays <= 90) return 0.03;
  if (ageDays <= 365) return 0.01;
  return 0;
};

// Per-host trust weighting for belief-slot winner selection. When two agents
// write contradictory beliefs into the same claim slot, the winner must not be
// decided by recency alone — a fresher belief from a low-trust source could
// otherwise supersede a correct, high-trust one (the MINJA/AgentPoison drift
// risk). Trust weights come from the SCORING host-trust map
// (config.trust.scoringHostTrust, legacy config.worldModel.hostTrust) ({ host:
// 0..1 }), resolved into settings. Empty/absent → no term, scoring unchanged.
// Bounded additive term, centered at 0.5 → [-0.1,+0.1]: beats the recency boost
// (max 0.08) so a high-trust source overcomes a fresher low-trust belief, but
// stays under any real confidence gap — tie-breaker, not veto.
const beliefHostTrustBonus = (belief = {}, settings = DEFAULT_ARBITER_SETTINGS) => {
  if (!settings.hostTrust) return 0;
  const host = String(belief.source_host || belief.source_agent || '').trim().toLowerCase();
  if (!host) return 0;
  const w = settings.hostTrust[host];
  if (!Number.isFinite(w)) return 0;
  return Math.max(-0.1, Math.min(0.1, (w - 0.5) * 0.2));
};

const beliefPriorityScore = (belief = {}, settings = DEFAULT_ARBITER_SETTINGS) => {
  let score = Number(belief.confidence || 0);
  score += beliefRecencyBoost(belief);
  if (String(belief.source_layer || '').trim().toLowerCase() === 'registry') score += 0.03;
  score += beliefHostTrustBonus(belief, settings);
  return score;
};

// --- Arbiter (U2): trust > corroboration > recency belief resolution ----------
// The store records a JUDGMENT about rival facts; the winner is decided by
// source-trust tier first (poisoning
// resistance), then distinct-agent corroboration, then recency — not recency
// alone. Trust tiers come from host-trust.js (own_agent > workspace >
// manual_import > unknown), honoring the operator arbitration host-trust
// overrides (config.trust.arbitrationHostTrust, legacy config.hostTrust).
const beliefTrustTier = (belief = {}, settings = DEFAULT_ARBITER_SETTINGS) => {
  const host = String(belief.source_host || belief.source_agent || '').trim();
  // hostTrustScore already returns a tier-ordered numeric in [0,1] and respects
  // config.hostTrust overrides; an empty host falls to the unknown floor.
  const tier = hostTrustScore(host, settings.trustConfig);
  // U13(b): a free-text agent identity that resolves to no registered agent
  // cannot carry host trust into the arbitration — a sock-puppet name caps at
  // the unknown floor. Rows without an agent are host-attributed (no cap: the
  // host string is our own ingest stamp, not attacker-supplied free text).
  const agent = String(belief.source_agent || '').trim();
  if (agent && !isRegisteredAgent(agent, settings.trustConfig)) return Math.min(tier, TRUST.unknown);
  return tier;
};

// Arbiter recency = when the fact was ASSERTED (content/creation time), never
// the projection row's `updated_at`. A supersession write bumps `updated_at`, so
// trusting it would make a just-superseded loser look freshest and flip the
// verdict on the next rebuild. Assertion time keeps the verdict stable/idempotent.
// U13(c): the asserted time is capped at the row's ingest time (created_at) —
// a future-dated content_time (clock gaming / skew) must not win recency. The
// write path also clamps (projection-store), this guards pre-clamp rows.
const beliefRecencyValue = (belief = {}) => {
  const asserted = Date.parse(
    String(belief.content_time || belief.created_at || belief.updated_at || ''),
  ) || 0;
  const ingest = Date.parse(String(belief.created_at || '')) || Date.now();
  return Math.min(asserted, ingest);
};

const beliefSupportAgent = (belief = {}) => String(
  belief.source_agent || belief.source_host || '',
).trim().toLowerCase();

// --- U13(a): deterministic claim-value clustering -----------------------------
// Paraphrased claim values must merge into ONE position before the rule runs,
// or corroboration is undercounted and one paraphrase falsely supersedes the
// other. Token-set similarity over normalized content tokens; guards keep
// genuine rivals apart: a negation-marker mismatch or differing numeric tokens
// never merge ("Berlin" vs "not Berlin", "port 8080" vs "port 3000").
const CLAIM_VALUE_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'in', 'on', 'at', 'to', 'for', 'it', 'its', 'this', 'that', 'now',
  'der', 'die', 'das', 'ist', 'ein', 'eine', 'und', 'im', 'am',
]);
const CLAIM_VALUE_NEGATIONS = new Set([
  'no', 'not', 'never', 'none', 'nor', 'without',
  'nicht', 'kein', 'keine', 'nie', 'ohne',
]);

const claimValueTokenSet = (value) => new Set(
  normalizeContent(value).split(/\s+/).filter((token) => token && !CLAIM_VALUE_STOPWORDS.has(token)),
);

const claimValueSimilarity = (aTokens, bTokens) => {
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  const negationOf = (tokens) => Array.from(tokens).some((t) => CLAIM_VALUE_NEGATIONS.has(t));
  if (negationOf(aTokens) !== negationOf(bTokens)) return 0;
  const digitsOf = (tokens) => Array.from(tokens).filter((t) => /\d/.test(t)).sort().join('|');
  if (digitsOf(aTokens) !== digitsOf(bTokens)) return 0;
  let inter = 0;
  for (const token of aTokens) if (bTokens.has(token)) inter += 1;
  // Containment ("Berlin" ⊆ "Berlin Kreuzberg") is a paraphrase signal the
  // plain Jaccard would dilute.
  if (inter === aTokens.size || inter === bTokens.size) return 1;
  const union = aTokens.size + bTokens.size - inter;
  return union > 0 ? inter / union : 0;
};

// U17 (s20-class fix): rival SELECTION similarity. claimValueSimilarity's
// zero-guards (digit mismatch / negation-marker mismatch) are POSITION
// SEPARATION safety properties — but a change assertion almost always carries
// a negation or different digits than the very rival it replaces ("never had
// celiac … cleared to eat wheat, barley, and rye" vs "strict gluten-free diet
// … avoids all wheat, barley, and rye"). Under the strict metric every losing
// position ties at 0 and the single-rival pick degrades to pure recency,
// superseding a stale CO-FACT instead of the graded rival (the U7 s20 miss).
// For SELECTION ONLY, similarity runs on digit-stripped, negation-neutral
// token sets; clustering keeps the strict zeroing untouched.
const neutralValueTokenSet = (value) => new Set(
  Array.from(claimValueTokenSet(value))
    .filter((token) => !CLAIM_VALUE_NEGATIONS.has(token) && !/\d/.test(token)),
);

const rivalSelectionSimilarity = (aTokens, bTokens) => {
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let inter = 0;
  for (const token of aTokens) if (bTokens.has(token)) inter += 1;
  if (inter === aTokens.size || inter === bTokens.size) return 1;
  const union = aTokens.size + bTokens.size - inter;
  return union > 0 ? inter / union : 0;
};

// U13(b): corroboration with identity defenses. Witnesses are distinct agents,
// BUT (1) near-identical text from the same host inside the independence
// window is one witness (copy-paste echoes / sock-puppet bursts), and (2) each
// (source_host, source_kind) pair contributes at most supportCapPerSource
// witnesses, so one writable surface can never out-vote independent stores.
const positionSupport = (rows = [], settings = DEFAULT_ARBITER_SETTINGS) => {
  const ordered = rows
    .slice()
    .sort((a, b) => (beliefRecencyValue(a) - beliefRecencyValue(b))
      || (beliefSupportAgent(a) < beliefSupportAgent(b) ? -1 : 1));
  const accepted = [];
  const perSource = new Map();
  for (const row of ordered) {
    const agent = beliefSupportAgent(row);
    if (!agent) continue;
    if (accepted.some((w) => w.agent === agent)) continue;
    const host = String(row.source_host || row.source_agent || '').trim().toLowerCase();
    const recency = beliefRecencyValue(row);
    const tokens = claimValueTokenSet(row.content || '');
    const echo = accepted.some((w) => w.host === host
      && Math.abs(w.recency - recency) <= settings.independenceWindowMs
      && claimValueSimilarity(w.tokens, tokens) >= 0.9);
    if (echo) continue;
    const sourceKey = `${host}|${String(row.source_kind || '').trim().toLowerCase()}`;
    const used = perSource.get(sourceKey) || 0;
    if (used >= settings.supportCapPerSource) continue;
    perSource.set(sourceKey, used + 1);
    accepted.push({ agent, host, recency, tokens });
  }
  return accepted.length;
};

// A user-topic slot groups by life DOMAIN, not by a typed value — co-facts in
// one domain are normal, not rivals. Arbitration of such a group additionally
// requires an explicit state-change/incapacity cue on some row; without one
// the group is left untouched (no verdict, no supersession). Curated
// value-typed slots (location.current_city, …) keep full arbitration.
// Coverage expansion added GENERIC change language only — state transitions a
// personal fact can undergo (upgrade/downgrade, payoff/clearing a balance,
// trade-in, relocation/settling in/vacating, breakup, layoff/resignation,
// retirement, graduation, medical clearance, data migration) — never a
// fixture sentence. The "now <verb>" family stays an explicit MODE-verb list:
// generalizing to any "now <verb>" turns progress updates ("can now solve the
// cube in five minutes") into false change cues on co-fact groups.
const USER_TOPIC_CHANGE_CUE_RE = /\b(?:sold|switch(?:ed|ing)|swapp(?:ed|ing)|no longer|anymore|stopp(?:ed|ing)|quit|gave up|giving up|cancel(?:l)?(?:ed|ing)|replac(?:ed|ing)|mov(?:ed|ing) (?:[a-z]+ ){0,3}?(?:to|into|out|in)\b|relocat(?:ed|ing|ion)|settl(?:ed|ing) in(?:to)?|vacat(?:ed|ing)|closed on (?:a|an|the)|instead of|now (?:relies|relying|using|uses|takes|taking|rides|riding|works|working|lives|living|rents?|renting|drives|driving|owns?|attends?|attending|eats?|eating|subscrib(?:es|ing))|requir(?:es|ing) [a-z]+ing|surgery|injur(?:y|ies|ed)|(?:doctor|surgeon) (?:said|ordered)|signed off on|clear(?:ed|s) (?:the user |the patient |them |him |her )?(?:to|for)\b|clear(?:ed|ing) (?:the |their |a )?[a-z -]{0,30}?(?:loan|debt|balance|card)\b|no [a-z]+(?:[- ][a-z]+)? activit(?:y|ies)|upgrad(?:ed|ing) to|downgrad(?:ed|ing)|paid off|trad(?:ed|ing) in|got rid of|migrat(?:ed|ing)|offer letter|accepted (?:a|an|the) [a-z -]{0,40}?(?:offer|role|position|job)\b|new (?:job|role|employer)|lateral move|divorc(?:ed|ing)|broke up|resign(?:ed|ing)|laid off|retir(?:ed|ing) from|graduated from|dropped out)\b/i;

// Cluster candidate beliefs into positions keyed by asserted value, compute
// per-position signals (maxTrust, distinct-agent support, latest recency), and
// return the winning position's rows ordered winner-first. The winning row is
// the highest-trust then newest within the winning position.
// U13(a): exact-value buckets are merged by claimValueSimilarity (threshold
// from worldModel.arbiter.clusterThreshold) before scoring; the method used is
// recorded on every position so verdict signals can carry it.
const arbitratePositions = (beliefs = [], settings = DEFAULT_ARBITER_SETTINGS) => {
  const buckets = new Map();
  for (const belief of beliefs) {
    const valueKey = String(belief?.payload?.claim_value || buildBeliefContentKey(belief)).trim();
    const list = buckets.get(valueKey) || [];
    list.push(belief);
    buckets.set(valueKey, list);
  }
  // Deterministic greedy merge over lexicographically ordered value keys; the
  // first key of a cluster stays its representative.
  const clusters = [];
  const orderedKeys = Array.from(buckets.keys()).sort();
  for (const key of orderedKeys) {
    const tokens = claimValueTokenSet(key);
    const home = clusters.find((cluster) => claimValueSimilarity(cluster.tokens, tokens) >= settings.clusterThreshold);
    if (home) {
      home.values.push(key);
      home.rows.push(...buckets.get(key));
    } else {
      clusters.push({ valueKey: key, values: [key], tokens, rows: buckets.get(key).slice() });
    }
  }
  let method = clusters.some((cluster) => cluster.values.length > 1) ? 'token_set' : 'exact';
  // Optional flag-gated refinement (default OFF): a local-LLM groups the
  // surviving representatives; any failure leaves the deterministic result.
  if (settings.refine && clusters.length > 1) {
    try {
      const groups = settings.refine({ values: clusters.map((c) => c.valueKey) });
      if (Array.isArray(groups)) {
        for (const group of groups) {
          const members = clusters.filter((c) => Array.isArray(group) && group.includes(c.valueKey));
          for (const member of members.slice(1)) {
            members[0].values.push(...member.values);
            members[0].rows.push(...member.rows);
            clusters.splice(clusters.indexOf(member), 1);
            method = 'llm_refined';
          }
        }
      }
    } catch { /* deterministic clustering stands */ }
  }
  const scored = clusters.map(({ valueKey, values, rows }) => ({
    valueKey,
    values,
    rows,
    maxTrust: Math.max(...rows.map((r) => beliefTrustTier(r, settings))),
    support: positionSupport(rows, settings),
    latest: Math.max(...rows.map((r) => beliefRecencyValue(r))),
    clustering: { method, threshold: settings.clusterThreshold },
  }));
  // trust tier desc, then distinct-agent support desc, then recency desc.
  scored.sort((a, b) => (b.maxTrust - a.maxTrust) || (b.support - a.support) || (b.latest - a.latest));
  return scored;
};

// Order rows within a single position: highest trust, then newest.
const orderPositionRows = (rows = [], settings = DEFAULT_ARBITER_SETTINGS) => rows
  .slice()
  .sort((a, b) => (beliefTrustTier(b, settings) - beliefTrustTier(a, settings))
    || (beliefRecencyValue(b) - beliefRecencyValue(a)));

const buildBeliefContentKey = (belief = {}) => normalizeContent(String(belief.content || '').trim());

// Map a belief row back to the memory_current row it was derived from. The
// ledger (recordVerdict) operates on memory_id, not the synthetic belief_id.
const beliefMemoryId = (belief = {}) => String(belief?.source_memory_id || '').trim();

// Best-effort provenance key for the verdict (null-safe): the winning belief's
// originating agent/host. Defers a real person_id/host_id (R6).
const beliefAgentId = (belief = {}) => {
  const agent = String(belief?.source_agent || belief?.source_host || '').trim();
  return agent || null;
};

const consolidateBeliefRows = (beliefRows = [], options = {}) => {
  const db = options && options.db ? options.db : null;
  // Settings precedence: explicit settings object > raw config > defaults.
  // (Pure callers — unit tests of the resolution rule — pass nothing and get
  // the same defaults the former configureBeliefTrust({}) produced.)
  const settings = options && options.settings
    ? options.settings
    : resolveArbiterSettings(options ? options.config : undefined);
  // Verdict intents collected during resolution; emitted to the ledger only
  // when a db is supplied (the live rebuild path). Pure callers (unit tests of
  // the resolution rule) pass no db and get the same winner/loser marks with
  // no side effects.
  const verdictIntents = [];
  const rows = beliefRows.map((belief) => ({
    ...belief,
    payload: belief?.payload && typeof belief.payload === 'object'
      ? { ...belief.payload }
      : {
        ...parseJsonSafe(belief.payload, {}),
      },
  }));
  // U13c (3): a belief's visibility scope; empty/null normalizes to 'shared'
  // (rows built by pure callers carry no payload.scope and stay one group).
  const beliefScopeOf = (belief = {}) => String(belief?.payload?.scope || '').trim() || 'shared';

  const groups = new Map();
  // entity|slot → all slot rows across scopes, for the cross-scope conflict
  // surface below (same-scope groups never see each other's rows).
  const slotRows = new Map();
  for (const belief of rows) {
    const slot = String(belief?.payload?.claim_slot || '').trim();
    if (!slot) continue;
    const slotKey = `${String(belief.entity_id || '').trim()}|${slot}`;
    // U13c (3): arbitration groups are SAME-SCOPE only — the consolidation key
    // carries the row's scope for entity-bearing AND user:self beliefs alike.
    // Supersession is global state but conflict is scope-relative: a fresher
    // profile:user rival (own_agent tier via host sync) must never silently
    // supersede the user's project:work fact across a visibility boundary.
    const key = `${slotKey}|${beliefScopeOf(belief)}`;
    const list = groups.get(key) || [];
    list.push(belief);
    groups.set(key, list);
    const slotList = slotRows.get(slotKey) || [];
    slotList.push(belief);
    slotRows.set(slotKey, slotList);
  }

  const conflictGroups = [];
  for (const [, group] of groups.entries()) {
    if (group.length <= 1) continue;

    // U13b: a user-topic slot groups by life DOMAIN — co-facts in one domain
    // are normal, not rivals. Without an explicit state-change/incapacity cue
    // somewhere in the group, skip arbitration entirely (no verdict, no
    // supersession). Value-typed slots keep full arbitration.
    const groupSlot = String(group[0]?.payload?.claim_slot || '');
    if (groupSlot.startsWith('user.topic.')
      && !group.some((b) => USER_TOPIC_CHANGE_CUE_RE.test(String(b.content || '')))) {
      continue;
    }

    // Arbiter (U2): cluster into positions by asserted value, then rank by
    // trust > corroboration > recency. Replaces the prior recency-primary
    // beliefPriorityScore sort and the 0.08 ambiguity shortcut.
    const positions = arbitratePositions(group, settings);
    if (positions.length === 0) continue;

    const winningPosition = positions[0];
    const winnerRows = orderPositionRows(winningPosition.rows, settings);
    const winner = winnerRows[0];
    winner.payload = {
      ...winner.payload,
      consolidation_operation: winner.payload?.consolidation_operation || 'remember',
    };

    // Same-value duplicates within the winning position: merged into the winner.
    for (const dup of winnerRows.slice(1)) {
      dup.status = 'superseded';
      dup.supersedes_belief_id = winner.belief_id;
      dup.payload = {
        ...dup.payload,
        consolidation_operation: 'extend',
        auto_resolution: 'duplicate_merged',
      };
    }

    // Single position → no rival value, nothing to arbitrate beyond the merge.
    if (positions.length <= 1) continue;

    // Ambiguity per the arbiter rule: the top two positions are indistinguishable
    // on trust AND corroboration AND recency. Otherwise the rule resolves cleanly.
    // U13(c): recency "equality" is the ambiguity window, not exact-ms ordering —
    // cross-host clock skew inside the window must not auto-pick a winner.
    const runnerUpPosition = positions[1];
    const ambiguous = winningPosition.maxTrust === runnerUpPosition.maxTrust
      && winningPosition.support === runnerUpPosition.support
      && Math.abs(winningPosition.latest - runnerUpPosition.latest) <= settings.recencyAmbiguityWindowMs;

    winner.payload = {
      ...winner.payload,
      slot_uncertain: ambiguous,
      consolidation_operation: winner.payload?.consolidation_operation || 'update',
    };

    // Losing positions: every row in them loses to the winning position —
    // EXCEPT in cue-gated user.topic.* domain groups (U13c (1)). A domain slot
    // holds separate-position co-facts ("carpools on Fridays") next to the
    // genuine rival ("drives a car"), so winner-take-all turned one mode change
    // into collateral deletion of co-facts (the U7 s18 SR misses). There the
    // winner supersedes ONLY the rival position representing the replaced
    // mode, picked deterministically: highest claim-value similarity to the
    // winner (the change-cue assertion names what it replaces — "sold the
    // car" → the car position), ties broken by next-most-recent recency at or
    // below the winner, then arbitration order. U17: SELECTION similarity is
    // the digit-stripped, negation-neutral variant (rivalSelectionSimilarity)
    // — the strict zero-guards stay where they belong, in position
    // SEPARATION. Every spared position stays ACTIVE and the group surfaces
    // on the conflict channel below — bounded and reviewed, never silent.
    // Value-typed slots keep winner-vs-all: they are single-value slots where
    // every losing position is a genuine rival.
    const losingPositions = positions.slice(1);
    let supersededPositions = losingPositions;
    let sparedPositions = [];
    if (!ambiguous && groupSlot.startsWith('user.topic.')) {
      const winnerTokens = neutralValueTokenSet(winningPosition.valueKey);
      const rivalRank = (position) => [
        rivalSelectionSimilarity(winnerTokens, neutralValueTokenSet(position.valueKey)),
        // Recency tie-break: prefer the next-most-recent position at or below
        // the winner (the mode being replaced predates the change assertion).
        position.latest <= winningPosition.latest ? 1 : 0,
        position.latest <= winningPosition.latest ? position.latest : -position.latest,
        -losingPositions.indexOf(position),
      ];
      const rivalPosition = losingPositions.slice().sort((a, b) => {
        const ra = rivalRank(a);
        const rb = rivalRank(b);
        for (let i = 0; i < ra.length; i += 1) {
          if (ra[i] !== rb[i]) return rb[i] - ra[i];
        }
        return 0;
      })[0];
      // A resolution-side heterogeneity floor (require
      // shared non-anchor tokens between winner and rival) was tried here and
      // REVERTED — genuine rivalries routinely share zero content tokens
      // ("works at a small accounting firm" vs "hired at a fintech startup"),
      // so any token floor kills more real conflicts than residue. Cross-
      // topic residue is instead blocked at PROJECTION (USER_TOPIC_META_RE in
      // world-model.js): rows that never enter a slot can never be collateral.
      supersededPositions = [rivalPosition];
      sparedPositions = losingPositions.filter((position) => position !== rivalPosition);
    }
    const losingRows = supersededPositions.flatMap((position) => position.rows);
    for (const belief of losingRows) {
      const historical = resolveBeliefTemporalScope(belief) === 'historical';
      belief.status = ambiguous ? 'uncertain' : historical ? 'stale' : 'superseded';
      belief.supersedes_belief_id = ambiguous ? null : winner.belief_id;
      belief.payload = {
        ...belief.payload,
        auto_resolution: ambiguous ? 'degraded_conflict' : 'superseded_by_slot_winner',
        consolidation_operation: ambiguous ? 'ignore' : 'update',
      };
    }

    // Ledger receipt (F1): a clean (non-ambiguous) resolution where the winner
    // beat distinct rival memories produces a verdict event + supersession.
    // Ambiguous conflicts surface for review instead of auto-superseding, so no
    // verdict is recorded for them.
    if (!ambiguous) {
      const winnerId = beliefMemoryId(winner);
      const loserIds = Array.from(new Set(
        losingRows.map((belief) => beliefMemoryId(belief)).filter(Boolean),
      )).filter((id) => id && id !== winnerId);
      if (winnerId && loserIds.length > 0) {
        // U13: signals carry the REAL deciding dimension and the clustering
        // method used to form the positions (extends the payload; the
        // recordVerdict savepoint shape is unchanged).
        const decidedBy = winningPosition.maxTrust !== runnerUpPosition.maxTrust ? 'trust'
          : winningPosition.support !== runnerUpPosition.support ? 'support'
            : 'recency';
        verdictIntents.push({
          winnerId,
          loserIds,
          agentId: beliefAgentId(winner),
          signals: {
            maxTrust: winningPosition.maxTrust,
            support: winningPosition.support,
            recency: winningPosition.latest,
            decided_by: decidedBy,
            clustering: winningPosition.clustering,
            // Adaptive trust (B1) reads the slot from the ledger to apply its
            // cleanliness gate; legacy verdicts without it are simply excluded.
            slot: groupSlot,
          },
        });
      }
    }

    if (ambiguous) {
      // One representative belief per position for the conflict surface.
      const representatives = positions.map((position) => orderPositionRows(position.rows, settings)[0]);
      conflictGroups.push({
        entity_id: String(winner.entity_id || ''),
        slot: String(winner.payload?.claim_slot || ''),
        topic: String(winner.payload?.claim_topic || ''),
        subtopic: String(winner.payload?.claim_subtopic || ''),
        beliefs: representatives.map((belief) => ({
          belief_id: belief.belief_id,
          content: belief.content,
          normalized_value: belief.payload?.claim_value || '',
          temporal_scope: resolveBeliefTemporalScope(belief),
          confidence: Number(belief.confidence || 0),
          source_strength: resolveBeliefSourceStrength(belief),
          source_memory_id: belief.source_memory_id || '',
        })),
        suggested_winner_belief_id: winner.belief_id,
      });
    }

    // U13c (1): spared co-fact positions are never silently ignored — the
    // bounded cue-gated resolution flags the group on the same review surface
    // the ambiguous path uses (winner first, then the spared positions).
    if (!ambiguous && sparedPositions.length > 0) {
      const representatives = [winningPosition, ...sparedPositions]
        .map((position) => orderPositionRows(position.rows, settings)[0]);
      conflictGroups.push({
        entity_id: String(winner.entity_id || ''),
        slot: String(winner.payload?.claim_slot || ''),
        topic: String(winner.payload?.claim_topic || ''),
        subtopic: String(winner.payload?.claim_subtopic || ''),
        beliefs: representatives.map((belief) => ({
          belief_id: belief.belief_id,
          content: belief.content,
          normalized_value: belief.payload?.claim_value || '',
          temporal_scope: resolveBeliefTemporalScope(belief),
          confidence: Number(belief.confidence || 0),
          source_strength: resolveBeliefSourceStrength(belief),
          source_memory_id: belief.source_memory_id || '',
        })),
        suggested_winner_belief_id: winner.belief_id,
      });
    }
  }

  // U13c (3): cross-scope value conflicts never auto-supersede. When the same
  // entity|slot still holds rival positions in DIFFERENT scopes after the
  // same-scope passes above, the pair surfaces on the conflict/uncertain
  // channel for review instead of acquiring a verdict — silently resolving
  // across a visibility boundary is the validated attack. user.topic.* domain
  // groups keep the change-cue gate (cross-scope co-facts are normal).
  for (const [, slotGroup] of slotRows.entries()) {
    const alive = slotGroup.filter((belief) => !belief.status || belief.status === 'current');
    if (alive.length <= 1) continue;
    if (new Set(alive.map((belief) => beliefScopeOf(belief))).size <= 1) continue;
    const slot = String(alive[0]?.payload?.claim_slot || '');
    if (slot.startsWith('user.topic.')
      && !alive.some((b) => USER_TOPIC_CHANGE_CUE_RE.test(String(b.content || '')))) {
      continue;
    }
    const positions = arbitratePositions(alive, settings);
    if (positions.length <= 1) continue;
    // Rival pair across scopes: two rows in DIFFERENT positions and DIFFERENT
    // scopes (two scopes agreeing on one value are corroboration, not conflict).
    let crossScopeRival = false;
    for (let i = 0; i < positions.length && !crossScopeRival; i += 1) {
      for (let j = i + 1; j < positions.length && !crossScopeRival; j += 1) {
        const jScopes = new Set(positions[j].rows.map((row) => beliefScopeOf(row)));
        crossScopeRival = positions[i].rows.some((row) => {
          const scope = beliefScopeOf(row);
          return Array.from(jScopes).some((other) => other !== scope);
        });
      }
    }
    if (!crossScopeRival) continue;
    const representatives = positions.map((position) => orderPositionRows(position.rows, settings)[0]);
    const suggested = representatives[0];
    conflictGroups.push({
      entity_id: String(suggested.entity_id || ''),
      slot,
      topic: String(suggested.payload?.claim_topic || ''),
      subtopic: String(suggested.payload?.claim_subtopic || ''),
      beliefs: representatives.map((belief) => ({
        belief_id: belief.belief_id,
        content: belief.content,
        normalized_value: belief.payload?.claim_value || '',
        temporal_scope: resolveBeliefTemporalScope(belief),
        confidence: Number(belief.confidence || 0),
        source_strength: resolveBeliefSourceStrength(belief),
        source_memory_id: belief.source_memory_id || '',
        scope: beliefScopeOf(belief),
      })),
      suggested_winner_belief_id: suggested.belief_id,
      cross_scope: true,
    });
  }

  const seenContent = new Map();
  for (const belief of rows) {
    const key = `${String(belief.entity_id || '').trim()}|${String(belief.type || '').trim()}|${buildBeliefContentKey(belief)}`;
    const existing = seenContent.get(key);
    if (!existing) {
      seenContent.set(key, belief);
      continue;
    }
    // U13: never let an already-superseded duplicate beat a still-active row —
    // that superseded the slot winner with its own merged duplicate (a
    // supersession cycle leaving the slot with NO active row, surfaced by the
    // Gate-B in-engine parity run on identical-text corroboration).
    const existingActive = !existing.status;
    const beliefActive = !belief.status;
    const winner = existingActive !== beliefActive
      ? (existingActive ? existing : belief)
      : (beliefPriorityScore(existing, settings) >= beliefPriorityScore(belief, settings) ? existing : belief);
    const loser = winner === existing ? belief : existing;
    loser.status = 'superseded';
    loser.supersedes_belief_id = winner.belief_id;
    loser.payload = {
      ...loser.payload,
      consolidation_operation: 'extend',
      auto_resolution: 'duplicate_content_merged',
    };
    seenContent.set(key, winner);
  }

  // Emit collected verdicts to the arbitration ledger (F1). Idempotent over the
  // FULL winner+losers set (R2): a verdict is settled only when the winner is
  // active AND every loser is already superseded by it, so repeated rebuilds do
  // not append duplicate verdict/supersede events. A superseded winner means the
  // slot flipped since the last verdict (or a cycle stranded both rivals), so
  // the verdict is re-recorded and recordVerdict reinstates the winner.
  const verdicts = [];
  if (db && verdictIntents.length > 0) {
    for (const intent of verdictIntents) {
      const winnerRow = getCurrentMemory(db, intent.winnerId);
      if (!winnerRow) continue;
      const winnerSuperseded = String(winnerRow.status || '').toLowerCase() === 'superseded';
      const pendingLosers = intent.loserIds.filter((loserId) => {
        const current = getCurrentMemory(db, loserId);
        if (!current) return false;
        const alreadyResolved = String(current.status || '').toLowerCase() === 'superseded'
          && String(current.superseded_by || '') === intent.winnerId;
        return !alreadyResolved;
      });
      if (pendingLosers.length === 0 && !winnerSuperseded) continue;
      verdicts.push(recordVerdict(db, {
        winnerId: intent.winnerId,
        loserIds: pendingLosers,
        signals: intent.signals,
        agentId: intent.agentId,
        reason: 'arbiter:belief_resolution',
      }));
    }
  }

  return {
    rows,
    conflictGroups,
    verdicts,
  };
};

// ---------------------------------------------------------------------------
// Entry point (U17): db-level arbitration independent of worldModel.enabled.
//
// The projector is a PARAMETER (usually world-model.js's
// `projectArbitrationBeliefRows`) so this module never imports world-model —
// the dependency points one way and the eval can drive arbitration with any
// projector. Verdicts, supersessions, and the conflict surfaces ride the same
// consolidate → recordVerdict path the world-model rebuild uses; the
// world-model TABLES are not touched here.
// ---------------------------------------------------------------------------
const runBeliefArbitration = ({
  db,
  config,
  now = new Date().toISOString(),
  projectBeliefRows,
} = {}) => {
  if (typeof projectBeliefRows !== 'function') {
    throw new Error('belief-arbitration: projectBeliefRows projector is required (e.g. world-model.js#projectArbitrationBeliefRows)');
  }
  const beliefRows = projectBeliefRows({ db, config, now }) || [];
  // Adaptive trust (B1): flag-gated, shadow-safe. Returns null unless
  // worldModel.arbiter.adaptiveTrust.enabled is true; operator arbitration pins
  // always win over adaptive values (spread order below). Adaptive drift feeds
  // the ARBITRATION host-trust map, so it lands on the canonical
  // trust.arbitrationHostTrust path (resolveArbiterSettings reads it there).
  let effectiveConfig = config;
  const adaptiveOverrides = loadAdaptiveTrustOverrides({ db, config });
  if (adaptiveOverrides) {
    const operatorArb = arbitrationTrustOverrides(config);
    effectiveConfig = {
      ...config,
      trust: { ...config?.trust, arbitrationHostTrust: { ...adaptiveOverrides, ...operatorArb } },
    };
  }
  const settings = resolveArbiterSettings(effectiveConfig);
  const { rows, conflictGroups, verdicts } = consolidateBeliefRows(beliefRows, { db, settings });
  return {
    ok: true,
    arbitrated: true,
    counts: {
      beliefs: rows.length,
      conflict_groups: conflictGroups.length,
      verdicts: verdicts.length,
    },
    conflictGroups,
    verdicts,
  };
};

export {
  DEFAULT_BELIEF_ARBITER,
  resolveArbiterSettings,
  resolveBeliefTemporalScope,
  resolveBeliefSourceStrength,
  beliefRecencyBoost,
  beliefHostTrustBonus,
  beliefPriorityScore,
  beliefTrustTier,
  beliefRecencyValue,
  beliefSupportAgent,
  claimValueTokenSet,
  claimValueSimilarity,
  neutralValueTokenSet,
  rivalSelectionSimilarity,
  positionSupport,
  USER_TOPIC_CHANGE_CUE_RE,
  arbitratePositions,
  orderPositionRows,
  buildBeliefContentKey,
  beliefMemoryId,
  beliefAgentId,
  consolidateBeliefRows,
  runBeliefArbitration,
};

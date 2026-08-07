# Concepts

Canonical vocabulary for Gigabrain.

- **Arbitration ledger** — GigaBrain's first-party store: an append-only record (`memory_events`) of verdicts, supersession edges, provenance, and trust signals ABOUT rival agents' facts. A referee's record, never a competing copy of the facts themselves; it never solicits the user's primary writes.
- **Memory arbiter** — the resolution mechanism (and the product's positioning noun): given conflicting beliefs, decide who is right by **trust tier > corroboration > recency** and record the verdict.
- **Belief** — a normalized fact row in `memory_current` attributed to a source agent/store, keyed by entity+slot for arbitration purposes.
- **Position** — within one conflict, the cluster of beliefs asserting the same value. Corroboration counts distinct supporting agents per position; paraphrases must cluster into one position (semantic clustering) or support is undercounted.
- **Verdict** — the arbiter's recorded decision: winner position, loser rows superseded (`status='superseded'`, `superseded_by=winner`), signals used, agent attribution — appended to the ledger inside a savepoint. A **reinstatement** (`arbiter:reinstate`) is the first-class verdict that reactivates a previously superseded winner when a later arbitration flips the outcome.
- **Supersession** — the loser lifecycle: a superseded belief stays stored (audit) but must be suppressed at every recall surface and must NOT be resurrected by re-ingestion (status-aware sync).
- **Trust tier** — per-source-host credibility class (`lib/core/host-trust.js`), the first arbitration signal; `agent_id`/`source_agent` is the provenance key. Free-text agent identity is a sock-puppet risk; identity must resolve against a registry.
- **Bi-temporal validity** — two timelines per belief: event time (`valid_from`/`valid_until` — when the fact was true in the world) vs transaction time (`created_at` / supersession events — when we learned it). Lets the ledger answer both "what was true at T?" and "when did we learn it stopped being true?".
- **Cross-store ingestion** — reading rival agents' memory stores in place (read-only, no migration): Codex `~/.codex/memories/`, Claude `/memories`, Cursor, Windsurf, Gemini; Copilot is server-side and unreadable (the access ceiling). Implemented in `lib/core/host-memory-sync.js`.
- **Two-phase capture** — extraction pass (atomic candidate facts from session text, local LLM) then decision pass (ADD/UPDATE/CONTRADICT/NOOP against embedded neighbors). **Write-time state adjudication** (KEEP/STALE/REPLACE/UNKNOWN) is the per-neighbor state verdict layered onto the decision pass.
- **Hybrid recall** — FTS5-primary lexical retrieval with optional locally generated dense embeddings and rank fusion. The dense leg degrades cleanly when its local embedding service is unavailable.
- **Product-in-the-loop eval** — an eval that exercises the real pipeline (seed stores → ingest → arbitrate → retrieve → answer). Anything that only compares prompt framings is a **prompt proxy** and must be labeled as such; only product-in-the-loop numbers may be tracked or published.
- **Memory Audit** — the one-shot scan report surface (`gigabrain audit`): secrets, staleness, contradictions. The acquisition hook.
- **Handoff Record** — the safe, redacted context-pass artifact (formerly "Passport" — that name is retired; MemoryLake owns the phrase). Also the propagation carrier for verdicts toward AGENTS.md / human-approvable writes.
- **Watch** — the recurring governance surface (`gigabrain watch`): re-runs the audit against a ledger snapshot cursor and reports only new findings; its install/retention conversion is the wedge metric.
- **World model** — the surface and projection layer (`lib/core/world-model.js`) for entities, briefs, syntheses, and normalized claim slots. Deterministic arbitration lives separately in `lib/core/belief-arbitration.js`, so it does not depend on the world-model surface being enabled.

# Task 11 Node core authority fix report

## Scope

Owned and changed only:

- `lib/core/projection-store.js`
- `lib/core/memory-actions.js`
- `tests/compat/memory-api-projection-test.js`
- `tests/compat/projection-writer-registry-test.js`
- this report

Python, dependency locks, source maps, manifests, other Node writers, production,
and services were not changed in this slice.

## RED evidence

Before production edits, both expanded Task 11 contracts failed with their
stable expected-failure signatures:

```text
timeout 120 node tests/compat/memory-api-projection-test.js
exit 1: COMPAT_EXPECTED_MEMORY_API_PROJECTION missing projection sync contract

timeout 120 node tests/compat/projection-writer-registry-test.js
exit 1: COMPAT_EXPECTED_PROJECTION_WRITER_REGISTRY missing centralized projection authority
```

Narrow real-database reproductions recorded the underlying defects:

```json
{"missing":["concept","last_confirmed_at","last_injected_at","pinned","review_reason","review_version","source_message_id","ttl_days"]}
{"before":1,"after":2}
{"threw":false,"seen":0,"rows":2}
{"threw":true,"current":"rejected","legacy":"rejected","events":1}
{"directCurrentDml":true}
```

These respectively prove the old legacy additive columns were absent, an
identical upsert emitted a second event, the FTS fault stage was absent, a
failed `memory_action_forget` domain event left current/legacy committed with a
generic event, and `recordVerdict` directly updated `memory_current`.

## Implementation

- Added the eight legacy additive metadata columns idempotently.
- Added one transaction-aware projection authority supporting upsert, status,
  and an allowlisted temporal/status patch.
- Top-level operations use `BEGIN IMMEDIATE`; nested operations use unique
  savepoints; a supplied caller transaction is reused and never committed.
- Current, final-current-derived legacy, optional sidecar, FTS, and the sole
  caller domain row event share one rollback boundary.
- Fault hooks cover current, legacy, metadata, FTS, and event writes.
- Normalization is always derived from content. Timestamps serialize to UTC
  `Z`; exact date-only `content_time` retains date precision while its
  `valid_from` is canonical ISO.
- True no-ops write nothing and append no row event.
- Row events carry `projection_event_kind=row`; verdict-only summaries carry
  `projection_event_kind=operation_summary`.
- `recordVerdict` now uses one projection batch for the winner and all unique
  losers, with no direct current DML or generic duplicate row events.
- Forget, protect, reinstate, update/replace, and replacement supersession now
  supply their domain event inside the same mutation batch.
- Legacy drop remains blocked during the compatibility rollback window.
- Normal startup creates the sidecar schema but deliberately performs no
  legacy-to-sidecar data backfill; the separately receipted migration owns that.

## GREEN evidence

Fresh final verification:

```text
node --check lib/core/projection-store.js \
  && node --check lib/core/memory-actions.js \
  && node --check tests/compat/memory-api-projection-test.js \
  && node --check tests/compat/projection-writer-registry-test.js
exit 0

git diff --check -- lib/core/projection-store.js lib/core/memory-actions.js \
  tests/compat/memory-api-projection-test.js \
  tests/compat/projection-writer-registry-test.js
exit 0

timeout 120 node tests/compat/memory-api-projection-test.js
exit 0: memory-api-projection-test.js: ok

timeout 120 node tests/compat/projection-writer-registry-test.js
exit 0: projection-writer-registry-test.js: ok

timeout 120 node tests/unit-projection-store-test.js
exit 0

timeout 120 node tests/unit-memory-actions-test.js
exit 0: unit-memory-actions-test.js: ok

timeout 120 node tests/unit-bitemporal-test.js
exit 0: bi-temporal completion (U12): all assertions passed

timeout 120 node tests/unit-belief-trust-test.js
exit 0: unit-belief-trust-test.js: ok

timeout 120 node tests/unit-event-store-test.js
exit 0
```

## Self-review and remaining concerns

- This is intentionally the core-authority slice. Capture, audit, maintenance,
  native/host/OpenClaw/Handoff import, queue review, transcript, wiki, Codex,
  and control-plane call-site routing remain for their owned Task 11 slices.
- Filesystem side effects from native memory actions still precede the SQLite
  batch, matching existing semantics; cross-filesystem recovery is outside this
  core SQLite authority slice.
- Exact date-only `content_time` is preserved because it encodes source
  precision, while timestamp-shaped values and all interval boundaries are
  canonicalized.
- Unrelated pre-existing dirty files were preserved and excluded from staging.

## Commit

This report is committed atomically with the owned implementation and tests.
The immutable commit SHA is recorded in the parent handoff response.

---

## Round 1B — trusted ingest clock

### RED evidence

Two public `upsertCurrentMemory` regressions were added before the fix. The
focused contract failed with its stable signature:

```text
timeout 120 node tests/compat/memory-api-projection-test.js
exit 1: COMPAT_EXPECTED_MEMORY_API_PROJECTION missing projection sync contract
```

The narrow real-database reproduction exposed both incorrect clock decisions:

```json
{
  "future": {
    "content_time": "2997-12-31T23:00:00.000Z",
    "updated_at": "2998-12-31T23:00:00.000Z"
  },
  "historical": {
    "content_time": "2000-01-02T02:04:05.000Z",
    "updated_at": "2000-01-02T02:04:05.000Z"
  }
}
```

The future caller timestamp permitted future content instead of clamping it to
ingest time. The historical caller timestamp incorrectly pulled a legitimate
later historical `content_time` backward to `updated_at`.

### Fix

`upsertCurrentMemory` no longer derives the transaction ingest clock from
caller-controlled `memory.updated_at`. The batch now uses actual wall time by
default, or the explicit trusted `options.now` override used by deterministic
tests and migrations. `updated_at` remains canonical caller data in the stored
current and legacy rows.

### GREEN evidence

Fresh bounded verification:

```text
node --check lib/core/projection-store.js \
  && node --check tests/compat/memory-api-projection-test.js
exit 0

git diff --check -- lib/core/projection-store.js \
  tests/compat/memory-api-projection-test.js
exit 0

timeout 120 node tests/compat/memory-api-projection-test.js
exit 0: memory-api-projection-test.js: ok

timeout 120 node tests/compat/projection-writer-registry-test.js
exit 0: projection-writer-registry-test.js: ok

timeout 120 node tests/unit-projection-store-test.js
exit 0

timeout 120 node tests/unit-bitemporal-test.js
exit 0: bi-temporal completion (U12): all assertions passed

timeout 120 node tests/unit-memory-actions-test.js
exit 0: unit-memory-actions-test.js: ok
```

Round 1B is committed separately; its immutable SHA is recorded in the parent
handoff response.

# Task 11 writer slice A report

## Scope

Changed only the owned writer slice:

- `lib/core/capture-service.js`
- `lib/core/audit-service.js`
- `lib/core/maintenance-service.js`
- `lib/core/native-promotion.js`
- `lib/compat/queue-review-service.js`
- `tests/compat/projection-writer-registry-test.js`
- this report

Projection-store, memory-actions, Python, imports/host/transcript/wiki/Codex/
control-plane files, source maps, locks, manifests, production, and services
were not changed.

## RED evidence

The expanded executable writer registry failed before writer changes:

```text
timeout 180 node tests/compat/projection-writer-registry-test.js
exit 1: COMPAT_EXPECTED_PROJECTION_WRITER_REGISTRY missing centralized projection authority
```

The first real-DB reproduction showed capture emitted two row events for one
insert:

```json
[
  {"action":"projection:upsert"},
  {"action":"capture_inserted"}
]
```

After capture was routed, the registry remained RED while the next writer
adapters were still unimplemented. The maintenance reproduction showed the
same duplicate-event defect for exact dedupe:

```json
[
  {"id":"b","action":"projection:status","kind":"row"},
  {"id":"b","action":"dedupe_exact_archive"}
]
```

The executable RED matrix additionally planted domain-event failures for audit,
maintenance, native promotion, and queue review, and required unchanged
current/legacy state plus unadvanced output/queue completion.

## Implementation

### Capture

- Final insert and LLM revision supply `capture_inserted` and
  `capture_llm_update` directly to the reviewed authority.
- Contradiction winner insertion and `recordVerdict` share one operation batch;
  verdict/event/FTS failure now rolls back the winner and loser changes instead
  of being logged and swallowed.
- A caller transaction and fault injector propagate through capture and memory
  actions. Existing capture policy, extraction, dedupe, and arbitration choices
  are unchanged.

### Audit

- Audit apply uses one `BEGIN IMMEDIATE` projection batch for review-ledger rows,
  current/legacy status, FTS, and the sole `audit_*` domain row event.
- Audit restore likewise uses one operation batch and sole `audit_restore` row
  events. Scoring/classification and report generation remain unchanged.
- Output files are written only after the DB batch succeeds.

### Maintenance

- Quality, exact-dedupe, semantic-dedupe, and auto-resolve mutation phases use
  reviewed projection batches with their domain row events.
- Row-event JSONL writes happen after the corresponding DB phase commits.
- Semantic review queue writes and summaries are deferred until after the DB
  phase. Auto-resolve queue completion is written only after its DB phase.
- DB/event faults propagate; malformed queue JSON remains isolated as before.
  `DAILY_SEQUENCE` and all scoring/dedupe decisions are unchanged.

### Native promotion

- Promotion, repair, relink, rejection, and exact/semantic reconciliation run
  inside one batch with native chunk links/unlinks.
- Each changed memory supplies one `native_promotion_*` domain row event.
- Dry-run/disabled paths remain zero-write. Caller savepoints and fault hooks
  are supported.

### Queue review

- Review/model calls complete before the default DB decision batch begins.
- Default archive/store decisions share one projection batch with stable
  `queue-review:*` operation identity.
- Queue completion is rewritten only after DB success; DB/event failure
  propagates and leaves the original queue row retryable.
- Custom async `applyDecision` test seams retain their existing per-row failure
  isolation semantics.

## Executable registry coverage

The registry now executes real adapters for all five owned writers and checks:

- successful current/legacy parity and one domain row event;
- capture current/legacy/FTS/event faults at top-level and under an active
  caller transaction;
- audit apply/restore and event-failure rollback with no output completion;
- maintenance exact-dedupe success and phase rollback with no row JSONL event;
- native promotion success, link rollback, event failure, and caller savepoint;
- queue archive success, stable operation identity, DB failure with unchanged
  queue completion, and disabled zero-write behavior.

## GREEN evidence

Fresh final verification:

```text
node --check <all five owned writer files and registry test>
exit 0

git diff --check -- <all five owned writer files and registry test>
exit 0

timeout 120 node tests/compat/memory-api-projection-test.js
exit 0: memory-api-projection-test.js: ok

timeout 240 node tests/compat/projection-writer-registry-test.js
exit 0: projection-writer-registry-test.js: ok

timeout 180 node tests/unit-capture-service-test.js
exit 0

timeout 180 node tests/integration-audit-maintenance-test.js
exit 0: integration-audit-maintenance-test.js: ok

timeout 120 node tests/unit-native-promotion-test.js
exit 0: unit-native-promotion-test.js: ok

timeout 180 node tests/unit-queue-review-service-test.js
exit 0: unit-queue-review-service-test.js: ok

timeout 180 node tests/compat/queue-review-service-test.js
exit 0: queue-review-service-test.js: ok

timeout 180 node tests/compat/nightly-review-integration-test.js
exit 0: nightly-review-integration-test.js: ok

timeout 180 node tests/regression-native-promotion-reconcile-test.js
exit 0: regression-native-promotion-reconcile-test.js: ok

timeout 180 node tests/unit-memory-actions-test.js
exit 0: unit-memory-actions-test.js: ok
```

## Self-review and concerns

- Native markdown/JSONL cannot share a SQLite commit. Capture native writes are
  content/scope-idempotent and carry stable memory/operation identities, so a DB
  failure remains retryable; this slice does not claim cross-filesystem atomicity.
- Maintenance row JSONL can fail after the DB commit. Such failure aborts the
  run before later completion artifacts; reruns see the already-terminal row and
  do not duplicate the row mutation.
- Audit and maintenance own their database connections, so caller-owned active
  transaction coverage is not applicable to those public entrypoints; capture
  and native promotion cover both boundary modes.
- Remaining Task 11 writer families are intentionally outside this slice.

## Commit

This report is committed atomically with the implementation and tests. The
immutable SHA is recorded in the parent handoff response.

---

## Fix round A1 — capture operation atomicity and resumable completion

### RED evidence

New real fault-and-retry cases were added before production changes. The
executable writer contract failed:

```text
timeout 300 node tests/compat/projection-writer-registry-test.js
exit 1: COMPAT_EXPECTED_PROJECTION_WRITER_REGISTRY missing centralized projection authority
```

The RED cases demonstrated:

- a later third current/FTS/event fault left the earlier memory action and first
  note committed in a two-note capture;
- an injected `arbiter:verdict` failure was caught as a warning while the new
  capture row remained committed;
- completion-fault injectors after audit, maintenance, auto-resolve, and queue
  DB commits were not honored, so there was no retry path proving one DB event
  and unchanged timestamps.

### Implementation

#### Whole capture operation

- Public `captureFromEvent` now creates one default projection batch and reuses
  a supplied caller transaction.
- Memory actions and every note mutation share that batch. A later
  current/legacy/FTS/event failure rolls back all earlier note/action DB changes
  and row events.
- Projection-writing `runBeliefArbitration` runs inside the capture batch.
  Arbitration write/event/FTS failures propagate and roll back the capture.
- Derived entity/world refresh runs only after an owned capture batch commits;
  its mutating failures propagate rather than being mislabeled as observational
  warnings. Caller-owned transactions defer that post-commit refresh to their
  caller/maintenance path.

#### Small completion-resume protocol

No filesystem/SQLite transaction abstraction was added. Existing content-free
row events (`payload.operation_id`, `projection_event_kind=row`) are the durable
DB receipt:

- Queue review normalizes a stable `queue-review:*` operation ID. If its row
  event already exists, retry skips DB application and resumes the queue rewrite.
- Audit retry reconstructs the already-applied review rows from
  `memory_quality_reviews`, `memory_current`, and the operation event, then
  resumes output generation without touching memory timestamps/events.
- Maintenance mutation phases scan their stable phase operation events and
  append only missing row JSONL evidence by `event_id`.
- Auto-resolve detects its existing row event and completes/prunes the still-
  pending queue row as `resolved_auto` without repeating the archive mutation.

Completion fault seams run after DB commit and immediately before the external
write. Tests retry the same operation ID and require unchanged current/legacy
state and timestamps, exactly one domain row event, and successful external
completion.

### GREEN evidence

Fresh final verification:

```text
node --check <owned writer files and executable registry>
exit 0

git diff --check -- <owned writer files and executable registry>
exit 0

timeout 120 node tests/compat/memory-api-projection-test.js
exit 0: memory-api-projection-test.js: ok

timeout 360 node tests/compat/projection-writer-registry-test.js
exit 0: projection-writer-registry-test.js: ok

timeout 180 node tests/unit-capture-service-test.js
exit 0

timeout 180 node tests/integration-audit-maintenance-test.js
exit 0: integration-audit-maintenance-test.js: ok

timeout 120 node tests/unit-native-promotion-test.js
exit 0: unit-native-promotion-test.js: ok

timeout 180 node tests/unit-queue-review-service-test.js
exit 0: unit-queue-review-service-test.js: ok

timeout 180 node tests/compat/queue-review-service-test.js
exit 0: queue-review-service-test.js: ok

timeout 180 node tests/compat/nightly-review-integration-test.js
exit 0: nightly-review-integration-test.js: ok

timeout 180 node tests/regression-native-promotion-reconcile-test.js
exit 0: regression-native-promotion-reconcile-test.js: ok

timeout 180 node tests/unit-memory-actions-test.js
exit 0: unit-memory-actions-test.js: ok
```

### Self-review

- This protocol resumes external completion; it does not claim atomicity across
  SQLite and files.
- Capture native markdown remains content/scope-idempotent and retryable. The
  authoritative DB operation now rolls back atomically, while native repair is
  still a separate filesystem concern.
- Operation receipts are content-free: IDs, action/type, timestamps, hashes,
  status metadata, and bounded numeric evidence only.
- No Task 12 sequencing, other writer family, projection core, or production
  service was changed.

Round A1 is committed separately; its immutable SHA is recorded in the parent
handoff response.

---

## Fix round A2 — decision-bound receipts and run-independent recovery

### RED evidence

The new receipt-binding regressions failed before production changes:

```text
timeout 360 node tests/compat/projection-writer-registry-test.js
exit 1: COMPAT_EXPECTED_PROJECTION_WRITER_REGISTRY missing centralized projection authority
```

The RED cases changed reviewer/model output and generated fresh retry run IDs.
They required receipt lookup before any model call, original committed decision
reconstruction, and external completion without new memory events/timestamps.
Existing recovery still consulted the reviewer first and maintenance recovery
depended on the original run-derived operation ID.

### Implementation

#### Queue decision receipts

- Default queue decisions append a separate content-free
  `queue_review_decision_receipt` operation-summary event in the same DB batch.
- The receipt is bound directly to the stable queue-row identity and records the
  original decision, confidence, reason, scope/type, loser/winner IDs, and result
  status—never candidate content.
- Retry loads per-row receipts before any reviewer/model call, reconstructs the
  original decision, skips already-applied DB rows, and rewrites external queue
  completion. Newly appended rows are reviewed independently; their presence
  cannot invalidate an older row receipt.
- Default batch identity is a fixed hash of receipt-missing stable queue-row
  identities, never `runId`.

#### Audit receipts

- Audit row events carry a stable `audit_receipt_id` derived from review version
  plus fixed schema version and are inherently bound to `memory_id`.
- Completed receipts are loaded before classification/LLM review. Retry with a
  changed model/config skips model execution and reconstructs the committed
  action/review from the row event, `memory_quality_reviews`, and current row.
- Default DB operation identity derives from the stable audit receipt, not run
  timestamp.

#### Maintenance receipts

- Each maintenance row event carries content-free `maintenance_stage` and a
  stable `completion_id` derived from stage, memory ID, matched memory ID, and
  fixed version.
- Missing row JSONL evidence is discovered by stable stage/event identity across
  fresh run IDs and appended once by `event_id`.
- Auto-resolve queue retry finds the original stable pair receipt, reconstructs
  `resolved_auto`, and completes/prunes the queue without repeating archive,
  timestamps, or events.

### Exact assertions added

- Queue retry returns changed model output but reviewer call count remains one;
  external completion uses the original archived decision and receipt fields.
- Audit first commits an LLM `archive`; retry supplies `keep` from a changed
  model, but no second model call occurs and output remains `archive`.
- Maintenance exact-dedupe and auto-resolve retries use new timestamped run IDs
  with no explicit operation ID; state/timestamps and one event remain exact.

### GREEN evidence

Fresh final verification reran the complete writer-A suite:

```text
node --check <owned writer files and executable registry>
exit 0

git diff --check -- <owned writer files and executable registry>
exit 0

timeout 120 node tests/compat/memory-api-projection-test.js
exit 0: memory-api-projection-test.js: ok

timeout 360 node tests/compat/projection-writer-registry-test.js
exit 0: projection-writer-registry-test.js: ok

timeout 180 node tests/unit-capture-service-test.js
exit 0

timeout 180 node tests/integration-audit-maintenance-test.js
exit 0: integration-audit-maintenance-test.js: ok

timeout 120 node tests/unit-native-promotion-test.js
exit 0: unit-native-promotion-test.js: ok

timeout 180 node tests/unit-queue-review-service-test.js
exit 0: unit-queue-review-service-test.js: ok

timeout 180 node tests/compat/queue-review-service-test.js
exit 0: queue-review-service-test.js: ok

timeout 180 node tests/compat/nightly-review-integration-test.js
exit 0: nightly-review-integration-test.js: ok

timeout 180 node tests/regression-native-promotion-reconcile-test.js
exit 0: regression-native-promotion-reconcile-test.js: ok

timeout 180 node tests/unit-memory-actions-test.js
exit 0: unit-memory-actions-test.js: ok
```

### Self-review

- Receipts are append-only SQLite evidence used solely to resume an external
  write; this remains an idempotent completion protocol, not cross-filesystem
  atomicity.
- Queue receipt lookup is per stable row identity, so concurrent append does not
  cause a completed row to be re-reviewed.
- Audit retry authority is the committed event/review row, never fresh model
  output or changed model configuration.
- Maintenance recovery may backfill any missing row-event JSONL evidence for the
  same stable stage; `event_id` prevents duplicates.
- No Task 12 ordering or out-of-scope writer files were changed.

Round A2 is committed separately; its immutable SHA is recorded in the parent
handoff response.

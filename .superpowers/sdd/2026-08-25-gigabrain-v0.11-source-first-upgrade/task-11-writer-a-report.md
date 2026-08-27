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

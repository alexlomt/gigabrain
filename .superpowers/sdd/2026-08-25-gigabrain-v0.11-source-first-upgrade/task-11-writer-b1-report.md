# Task 11 writer slice B1 report

## Scope

Changed only the owned imports/host slice:

- `lib/core/host-memory-sync.js`
- `lib/core/openclaw-import.js`
- `lib/core/handoff-bundle.js`
- `tests/compat/projection-writer-registry-test.js`
- this report

Handoff remains schema v1. Task 13/v2 behavior, projection-store, source maps,
test registries, expected-failure manifests, locks, Python, production state,
and services were not changed.

## RED evidence

The executable registry was expanded before production edits with real SQLite
success, parity, caller-savepoint, late-fault, retry, and disabled-mode cases.
The current B1 writers failed the contract with the stable Task 11 signature:

```text
node tests/compat/projection-writer-registry-test.js
exit 1: COMPAT_EXPECTED_PROJECTION_WRITER_REGISTRY missing centralized projection authority
```

The RED matrix required:

- OpenClaw legacy-only metadata in both sidecar and legacy projection;
- one caller-domain row event instead of a generic projection event;
- whole-import rollback on the second current, legacy, metadata, FTS, event,
  source-link, or evidence fault;
- caller-owned transaction preservation;
- Handoff v1 memory/link/event atomicity without post-commit event swallowing;
- per-host-source rows, links, cursor, and receipt in one boundary;
- stable operation identity and zero completion counters after a DB fault;
- isolated cloud-source failure with another cloud source still committing; and
- automatic-host and disabled-cloud modes initializing no tables.

## Implementation

### OpenClaw import

- Added `last_injected_at` and `ttl_days` to legacy loading and supplied all
  eight legacy-only metadata fields to the reviewed projection authority.
- Each changed row now emits the sole `openclaw_import_upsert` row event while
  current, legacy, sidecar, FTS, source links, evidence, and the sync receipt
  share one `BEGIN IMMEDIATE` or caller savepoint.
- Import identity is deterministic over source path, label, host, rows, and
  evidence; an explicit operation ID remains supported for controlled callers.
- Source-link, evidence, and receipt fault seams prove late failure rolls back
  the complete bulk import and every row event.

### Handoff import

- Kept the bundle kind, schema version `1.0`, integrity hash, and re-embed
  contract unchanged.
- Routed all memory rows through one reviewed batch with the sole
  `handoff_import` row event, followed by source links in that same boundary.
- Removed the post-commit best-effort event loop. An event or link failure now
  rolls back the complete v1 import; an active caller transaction receives one
  nested savepoint and is never committed.

### Host and cloud ingest

- Each discovered host source now owns one reviewed projection batch containing
  row events, current/legacy/FTS writes, provenance links, incremental cursor,
  and sync receipt.
- Source operation IDs are stable over host, kind, path, scope, and content
  hash. Receipts upsert by that identity, making a failed exact retry
  idempotent.
- Failed source batches report zero indexed/inserted/linked completion and add
  no touched IDs, so cursor movement and post-ingest arbitration cannot advance
  over rolled-back rows.
- Existing deliberate source isolation remains: one host source failure is
  reported while later sources continue.
- Each cloud export file now has the same atomic source boundary. Cloud state,
  shared cursor, receipt, row/link writes, and `cloud_inbox_inserted` events
  commit together; a failed file does not roll back an independently successful
  file.
- Automatic host sync returns before schema/discovery when disabled, and a
  disabled cloud inbox returns before schema, filesystem, or network access.

## Executable coverage

The owned registry section executes:

- two-row OpenClaw success with exact eight-field sidecar/legacy parity;
- OpenClaw second-write faults at current, legacy, metadata, FTS, event,
  source-link, and evidence stages;
- OpenClaw repeat receipt idempotence and caller rollback;
- two-row Handoff v1 parity, one event per changed row, five late-fault stages,
  and caller rollback;
- host success, current/legacy parity, one domain row event, cursor/receipt
  creation, unchanged retry, seven DB fault stages, stable retry, and zero
  completion after failure;
- disabled host/cloud zero-store behavior; and
- two-file cloud isolation, failed-source retry identity, cursor/state parity,
  and exactly one domain row event per inserted row.

## GREEN evidence

Verification used Node `26.7.0` (the only installed Node binary):

```text
node --check lib/core/host-memory-sync.js
node --check lib/core/openclaw-import.js
node --check lib/core/handoff-bundle.js
node --check tests/compat/projection-writer-registry-test.js
exit 0

git diff --check -- <all four owned implementation/test files>
exit 0

node --input-type=module -e '<run only runTask11WriterB1>'
task11-b1: ok

node tests/compat/projection-writer-registry-test.js
projection-writer-registry-test.js: ok

<invoke exported run() for unit-host-memory-sync-test.js>
tests/unit-host-memory-sync-test.js: ok

<invoke exported run() for unit-cloud-inbox-test.js>
cloud-inbox drop-folder ingest (#6): all assertions passed (NO network, secrets stripped, manual_import floor)
unit-cloud-inbox-test.js: ok

<invoke exported run() for the remaining requested tests>
tests/unit-openclaw-import-test.js: ok
tests/unit-memory-passport-test.js: ok
tests/unit-passport-bundle-test.js: ok
tests/integration-packaged-passport-test.js: ok
tests/integration-migration-and-api-test.js: ok

npm test
{"ok":true,"smoke":"installed-package-runtime"}
```

The broader `npm run test:full` was also attempted. It passed through the owned
registry and host tests, then stopped at the unrelated unfinished Task 14
`compat/upstream-adoption-test.js` contract:

```text
COMPAT_EXPECTED_UPSTREAM_ADOPTION missing hash-bound adoption and retirement contract
```

No Task 14 file or expected-failure manifest was changed to hide that gate.

## Self-review and remaining concerns

- SQLite atomicity is complete within each documented source/import boundary;
  no claim is made that independent source files form one global transaction.
- Host arbitration remains a deliberately separate post-source phase and sees
  only committed touched IDs.
- Stable receipts intentionally collapse exact same-content retries into one
  receipt row instead of manufacturing timestamped duplicate operations.
- Handoff metadata/schema expansion is intentionally deferred to Task 13; this
  slice changes only v1 projection and event fidelity.
- Unrelated pre-existing dirty files were preserved and excluded from staging.

## Commit

This report is committed atomically with the owned implementation and tests.
The immutable SHA is recorded in the parent handoff response.

---

## Fix 1.1 — malformed cloud export source isolation

### RED evidence

The executable B1 registry first added a directory with malformed
`a-malformed.json` followed by valid `b-valid.json`. Before the production
change, malformed JSON was converted to an empty successful parse outside the
per-file error boundary:

```text
AssertionError [ERR_ASSERTION]: one malformed source must be reported without aborting the directory scan
true !== false
exit 1
```

That behavior incorrectly marked the malformed file `scanned` and advanced its
cloud state, incremental cursor, and sync receipt.

### Fix

- Malformed JSON now raises a content-free, filename-only parse error.
- `parseCloudExportFile` runs inside the existing per-file `try` boundary.
- A malformed independent export is recorded as a source-level error and the
  directory scan continues to the next export.
- No row, link, cursor, cloud-state row, receipt, or event is written for the
  malformed source. The valid following source commits all six exactly once.
- Repeating the scan reports the malformed source again, treats the valid
  source as unchanged, and does not duplicate its row event or receipt.
- Global setup/configuration errors remain outside this per-source catch.

### GREEN evidence

```text
node --input-type=module -e '<run only runTask11WriterB1>'
task11-writer-b1: ok

node tests/compat/projection-writer-registry-test.js
projection-writer-registry-test.js: ok

<invoke exported run() for unit-cloud-inbox-test.js and unit-host-memory-sync-test.js>
cloud-inbox drop-folder ingest (#6): all assertions passed (NO network, secrets stripped, manual_import floor)
tests/unit-cloud-inbox-test.js: ok
tests/unit-host-memory-sync-test.js: ok
```

Fix 1.1 is committed separately; its immutable SHA is recorded in the parent
handoff response.

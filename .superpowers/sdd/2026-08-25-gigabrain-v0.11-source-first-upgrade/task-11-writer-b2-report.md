# Task 11 writer slice B2 report

## Scope

Changed only the final semantic writer slice:

- `lib/core/control-plane.js`
- `lib/core/codex-service.js`
- `lib/core/belief-arbitration.js`
- `lib/core/transcript-harvester.js`
- `lib/core/wiki-project.js`
- `tests/compat/projection-writer-registry-test.js`
- this report

Projection-store, capture, host/import writers, source maps, test registries,
locks, Python, production state, and services were not changed. Arbitration
resolution/trust, transcript parsing/salience/privacy, wiki diff pairing and
resolution, lifecycle policy, and enable defaults remain unchanged.

## RED evidence

Executable tests were added and observed failing before each production change.

### Belief arbitration

Two independent conflict intents resolved correctly in memory, but each used a
separate `verdict-*` transaction and operation identity:

```text
actual:   verdict-belief-location-winner
expected: task11-belief-two-intents
exit 1
```

The added top-level and caller-owned fourth-event faults required both intent
groups and every event to roll back together.

### Control-plane and Codex acceptance

The terminal proposal event carried no stable identity:

```text
actual:   undefined
expected: task11-control-decision-stable
exit 1
```

After the control-plane boundary was routed, Codex acceptance remained RED:

```text
AssertionError: Missing expected exception
expected: /codex synthetic after_event/
exit 1
```

This demonstrated the existing close/reopen split: the accepted memory could
commit on one connection before the terminal proposal decision on another.

### Transcript harvesting

The per-source success fixture exposed the generic projection event:

```text
actual:   ["projection:upsert"]
expected: ["transcript_harvest_inserted"]
exit 1
```

The RED matrix also injected row, source-link, cursor, nested-savepoint, and
scoped-arbitration failures and required zero source completion on failure.

### Wiki reconciliation

The first Nth-row-event rollback fixture did not throw:

```text
AssertionError: Missing expected exception
expected: /wiki top nth row event/
exit 1
```

The existing per-row best-effort path could retain an ingested human fact while
swallowing adjudication/status failure, and its state-file baseline had no
database receipt for post-commit recovery.

## Implementation

### Belief arbitration

- Winner selection, clustering, trust, corroboration, recency, ambiguity, and
  cross-scope behavior are untouched.
- All collected verdict intents now share one deterministic operation ID and
  one reviewed `BEGIN IMMEDIATE`, caller savepoint, or supplied parent batch.
- Every `recordVerdict` reuses that batch, so a later current/legacy/FTS/event
  fault rolls back earlier intent groups and their events.

### Control-plane and Codex

- `appendClaimDecision` now uses the reviewed batch authority, supports a
  supplied parent transaction, and derives stable receipt/event IDs from its
  operation identity.
- Terminal proposal payloads and receipts carry `operation_id`; decision receipt
  and event fault seams remain in the same boundary.
- Proposal/checkpoint creation remains proposal-only and retains its policy and
  schema behavior. Restricted proposal entrypoints still reject before schema.
- Codex accepted-claim processing now keeps one prepared database connection
  open. The capture memory mutation and terminal claim decision run in one
  projection batch.
- A capture row/event fault or a terminal receipt/event fault leaves the
  proposal proposed and the accepted memory absent. Exact retry then commits
  one memory row event and one terminal decision.
- Rejected/superseded proposal-only decisions continue through the same
  control-plane policy path without a memory write.

### Transcript harvester

- Raw JSONL parsing, turn segmentation, salience, secret filtering, local-only
  extraction, trust floor, budgets, and defaults are unchanged.
- Extraction is completed before the database boundary. Each source file then
  applies its fact rows, source links, byte cursor, scoped arbitration and sole
  `transcript_harvest_inserted` row events in one reviewed batch.
- The operation identity is stable over scope, host, path, byte range and source
  bytes. A DB/arbitration failure reports that source as error, advances no
  cursor/output completion and leaves no touched IDs; exact retry is safe.
- Arbitration uses the same claim-slot scoping and unchanged arbitration engine,
  now inside the source transaction.
- Disabled and restricted-write paths return/reject before store creation,
  filesystem walking, extraction or network access.

### Wiki reconciliation

- Human commit detection, markdown parsing, per-file scope resolution, stable
  1:1 replacement pairing, pure-deletion tombstones, trust and project ordering
  are unchanged.
- Human fact insertion, adjudication events, agent status changes, scoped
  arbitration, row events, and a new database baseline receipt now share one
  reviewed batch.
- Changed memories emit only `wiki_reconcile_ingested`,
  `wiki_reconcile_superseded`, or `wiki_reconcile_tombstoned` row events.
- `memory_wiki_reconcile_receipts` binds a deterministic operation ID to wiki
  directory, generated base SHA, human HEAD, result summary, and intended state
  file payload in the same database transaction.
- The state-file update happens only after an owned DB commit. If it fails,
  retry finds the receipt and resumes only external completion without repeating
  row/adjudication/arbitration decisions or changing timestamps/events.
- Caller-owned success defers external completion until the caller commits and
  invokes reconciliation again. Disabled/read-only entrypoints create no
  tables or wiki directories.

## Executable registry coverage

The B2 registry section now executes real adapters for:

- two-intent belief success plus top-level/caller-owned Nth-event rollback;
- control-plane stable terminal IDs, decision receipt/event rollback, nested
  savepoints, and restricted proposal zero-store behavior;
- Codex accepted-memory success and independent memory-event/terminal-decision
  failure rollback followed by exact retry;
- transcript success/parity/one-event, unchanged retry, top/nested row/link/
  cursor faults, arbitration-event rollback, and disabled/restricted zero-store;
- wiki top/nested Nth-event rollback, current/legacy/event parity, atomic DB
  baseline receipt, failed external completion and receipt-only resume, and
  disabled/read-only zero-store/disk behavior.

## GREEN evidence

Verification used Node `26.7.0`:

```text
node --input-type=module -e '<run only runTask11WriterB2>'
writer-b2: ok

node tests/compat/projection-writer-registry-test.js
projection-writer-registry-test.js: ok

<invoke exported run() for requested and affected tests>
tests/unit-control-plane-test.js: ok
tests/unit-codex-service-test.js: ok
tests/unit-belief-trust-test.js: ok
tests/unit-transcript-harvester-test.js: ok
tests/unit-git-wiki-test.js: ok
tests/unit-checkpoint-migration-test.js: ok
tests/unit-claim-promotion-auth-test.js: ok
tests/compat/checkpoint-promotion-isolation-test.js: ok
tests/integration-remote-mcp-test.js: ok
```

## Additional bounded regression finding

An extra `unit-capture-service-test.js` run (not part of the requested B2
suite) fails its pre-existing expectation that a direct CONTRADICT emits an
`arbiter:verdict` operation summary. Database inspection shows the capture
winner and loser row events commit, including `arbiter:supersede`, but no
summary is emitted because the just-inserted winner's `valid_from` patch in
`projection-store.js#recordVerdict` is a true no-op. That core code dates to
`02861db`, is outside B2 ownership, and was not changed here. B2 does not hide or
waive the failure. Fix 2.1 below closes this finding after projection-store was
explicitly added to the owned scope.

## Self-review and remaining concerns

- SQLite coherence is complete for the specified operations. Native capture and
  wiki state files cannot share a SQLite commit; wiki now has a durable resume
  receipt, while accepted-claim native capture retains its existing external
  write semantics.
- Transcript arbitration is now source-local as required. The arbitration
  algorithm and slot filter are unchanged, but independent source files remain
  independent transactions rather than one directory-wide transaction.
- Wiki receipt rows intentionally remain as immutable completion evidence; the
  local state file makes later reconciliations a normal no-op once completed.
- Unrelated pre-existing dirty files were preserved and excluded from staging.

## Commit

This report is committed atomically with the owned implementation and tests.
The immutable SHA is recorded in the parent handoff response.

---

## Fix 2.1 — mandatory verdict summary and durable wiki completion

### RED evidence

The true-no-op verdict case and existing capture contradiction regression were
run before the projection-store change:

```text
node tests/compat/projection-writer-registry-test.js
exit 1: COMPAT_EXPECTED_PROJECTION_WRITER_REGISTRY missing centralized projection authority

unit-capture-service-test.js
CONTRADICT should emit exactly one arbiter verdict event
0 !== 1
```

The wiki durability fixture then failed before production edits because the
plain state writer exposed none of the required atomic-write stages:

```text
actual:   []
expected: [after_temp_open, after_temp_write, after_temp_fsync,
           after_state_rename, after_directory_fsync]
exit 1
```

Additional RED cases committed the DB receipt, replaced the state file with an
empty/truncated document, partial JSON, or corrupt text, and required receipt-
only recovery. The prior implementation trusted the state file for `baseSha`,
returned `no_generated_baseline`, and could not discover the committed receipt.

### Verdict fix

- `recordVerdict` now appends exactly one content-free `arbiter:verdict`
  operation-summary event before any row mutation. Its payload carries only
  winner ID, unique loser IDs, signals and projection operation metadata.
- A real winner temporal change may still emit its row event. A true no-op
  winner emits no fake row event; loser mutations retain one
  `arbiter:supersede` row event each.
- Reinstatement links to the mandatory summary event as before.
- Summary insertion and all winner/loser current, legacy, FTS and row events
  remain in the same projection batch. A summary trigger failure leaves every
  row and event unchanged.

### Wiki durability and recovery fix

- Every state write now creates an adjacent exclusive temp file with mode
  `0600`, writes the complete JSON document, flushes and fsyncs the file,
  atomically renames it over the state path, fsyncs the containing directory,
  and removes any leftover temp on every exit path.
- Project and reconcile surfaces pass a narrow state fault seam used to prove
  temp mode, exact stage order, pre-rename preservation and cleanup.
- Reconciliation parses state with explicit validity instead of silently
  treating corrupt JSON as an empty trusted document.
- Before relying on `baseSha`, reconciliation queries durable receipts by the
  canonical wiki directory and current Git HEAD. A single matching receipt is
  validated against its deterministic operation ID, summary identity and
  intended `generatedSha`, then resumes only atomic state-file completion.
- Empty, partial and corrupt state recovery preserves memory/adjudication/event
  counts and timestamps. Multiple receipts matching one HEAD fail with
  `WIKI_RECEIPT_AMBIGUOUS`; corrupt state plus only non-matching receipts fails
  with `WIKI_RECEIPT_MISMATCH`. No candidate is guessed.

### GREEN evidence

```text
node --input-type=module -e '<run only runTask11WriterB2>'
writer-b2-fix21: ok

node tests/compat/projection-writer-registry-test.js
projection-writer-registry-test.js: ok

tests/unit-capture-service-test.js: ok
tests/unit-projection-store-test.js: ok
tests/unit-belief-trust-test.js: ok
tests/unit-git-wiki-test.js: ok
tests/unit-bitemporal-test.js: ok
tests/compat/memory-api-projection-test.js: ok
```

An extra `unit-event-store-test.js` run remains outside the authorized test
paths and asserts a pre-Task11 raw event sequence that omits projection seed
events. It now also observes the required verdict summary beside a genuine
winner temporal row event. The failure is recorded rather than hidden; that
test file was not changed.

Fix 2.1 is committed separately. Its immutable SHA is recorded in the parent
handoff response.

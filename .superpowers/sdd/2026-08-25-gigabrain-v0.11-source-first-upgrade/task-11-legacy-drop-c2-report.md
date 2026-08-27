# Task 11 legacy-drop closure C2 report

Date: 2026-08-27
Base: `93b2ae1d2e9019ebb2ff99fdbd012e623eb3617a`
Branch: `upgrade/v0.11-openclaw-compat-task11-impl`

## Scope

Changed only:

- `scripts/gigabrainctl.js`
- `tests/compat/memory-api-projection-test.js`
- this report

No config maps, lock files, production databases, snapshots, or services were changed. `docs/maintenance.md` did not require a correction because the CLI help and machine-readable doctor result are the authoritative surfaces changed by this slice.

## Behavior delivered

- `migrate legacy-drop` and every supplied flag combination, including `--dry-run` and `--snapshot`, invoke the retained low-level `LEGACY_DROP_BLOCKED_COMPAT` guard before config resolution, database access, parent-directory creation, or snapshot materialization.
- The previous CLI containment/drop apply implementation and its successful help examples are removed. Both global and migrate-specific help mark the operation blocked.
- The residual migrate path is also bound to the same unconditionally blocked low-level helper, preserving fail-closed writer discovery without retaining a reachable drop implementation.
- `doctor` reports `legacyRequired`, `legacyDropBlocked`, the compatibility reason, authoritative `memory_current`, the legacy-only `memory_console_metadata` sidecar, preservation state for `memories`, and observational Task 14 sidecar readiness.
- A missing registry is an ordinary exit-zero doctor result with pending readiness and no filesystem creation.
- Existing registries without pre-existing SQLite WAL coordination sidecars are not opened by doctor, preventing an observational command from materializing `-wal`/`-shm` files.

## TDD evidence

RED was established first by extending `tests/compat/memory-api-projection-test.js`; before implementation, `node tests/compat/memory-api-projection-test.js` failed with its stable compatibility signature.

The GREEN contract now proves:

- all four legacy-drop apply/dry-run/snapshot variants fail with `LEGACY_DROP_BLOCKED_COMPAT`;
- missing config/database parents remain absent;
- database bytes, stable sidecars, and the complete fixture file tree remain unchanged;
- help contains no runnable legacy-drop success example;
- ready and pending doctor compatibility payloads are exact;
- doctor preserves the database hash and stable file tree.

## Verification

Fresh verification on this branch:

| Command | Result |
| --- | --- |
| `node --check scripts/gigabrainctl.js` | PASS |
| `node tests/compat/memory-api-projection-test.js` | PASS (`memory-api-projection-test.js: ok`) |
| `node tests/compat/projection-writer-registry-test.js` | PASS (`projection-writer-registry-test.js: ok`) |
| `node tests/compat/observational-diagnostics-test.js` | PASS (`observational-diagnostics-test.js: ok`) |
| `node tests/unit-projection-store-test.js` | PASS |
| `node tests/integration-nightly-cli-test.js` | PASS (`integration-nightly-cli-test.js: ok`) |
| `node tests/unit-runtime-guard-test.js` | PASS |
| `node scripts/package-smoke.js` | PASS (`{"ok":true,"smoke":"installed-package-runtime"}`) |
| `node tests/compat/write-mode-gate-test.js` | **RED** |

The remaining RED is precise and not waived: after all legacy-drop writer-inventory assertions pass, the test reaches `captureFromEvent({ config: readOnlyConfig, db: null })` and receives `captureFromEvent requires db`; it expected `GIGABRAIN_WRITE_FORBIDDEN`. This is a fail-closed ordering regression for a separate bounded Task 11 round, not part of the owned C2 CLI/projection-test files.

## Disposition

C2 is suitable for review as a narrow commit. Task 11 as a whole remains gated on the separately scoped write-mode ordering fix above.

## C2 fix 2.1

Date: 2026-08-27
Base: `189f5e3794f5528fa219615330bc89ab10c54e7e`

### Review findings closed

- Standalone/Codex doctor now inspects only the first 20 SQLite header bytes before deciding whether any SQLite-backed health path may run. A WAL-format registry requires both pre-existing `-wal` and `-shm` paths. Missing, WAL-only, and SHM-only states bypass `runDoctor` and therefore bypass `readLocalStoreHealth` and every SQLite open; they return exit-zero observational compatibility diagnostics and a pending store-health record instead.
- The unsafe-path tests use valid WAL-mode registries, assert the exact pre-existing file tree and every file hash remain unchanged, and prove no missing sidecar is materialized. A fully coordinated WAL fixture proves the safe path still reaches normal Codex doctor health.
- Task 14 readiness no longer follows schema/index presence. The exact exported and reported migration identity is `gigabrain-schema-0.11-compat-v1:memory-console-metadata-backfill`.
- The read-only ledger contract is table `memory_schema_migrations`, exact columns `migration_id`, `status`, `receipt_hash`, and `schema_hash`, exact status `completed`, and lowercase 64-hex receipt/schema hashes. Readiness additionally requires `memory_console_metadata` and `idx_memory_console_metadata_concept_pinned`.
- Missing ledger, missing exact row, incomplete status, case-mismatched status, `schema_only`, invalid receipt hash, and invalid schema hash all remain pending with stable content-free reason codes. Doctor does not create the Task 14 ledger, schema, or receipt and does not expose either hash.

### TDD evidence

The expanded compatibility test was RED before production changes:

- Initial RED: the ready payload lacked the migration identity, ledger/status contract, receipt presence, content-free reasons, and compatibility diagnostic.
- Exactness RED: a ledger row with status `COMPLETED` was incorrectly accepted after normalization; the implementation now accepts only the exact value `completed`.

After the minimal CLI changes, `node tests/compat/memory-api-projection-test.js` reports `memory-api-projection-test.js: ok` across the ready fixture, every pending ledger variant, three unsafe Codex sidecar states, and the coordinated safe Codex fixture.

### Fix 2.1 verification

| Command | Result |
| --- | --- |
| `node tests/compat/memory-api-projection-test.js` | PASS (`memory-api-projection-test.js: ok`) |
| `node tests/compat/projection-writer-registry-test.js` | PASS (`projection-writer-registry-test.js: ok`) |
| `node tests/compat/observational-diagnostics-test.js` | PASS (`observational-diagnostics-test.js: ok`) |
| `node tests/compat/observational-core-patches-test.js` | PASS (`observational-core-patches-test.js: ok`) |
| `node tests/unit-runtime-guard-test.js` | PASS |
| `node tests/unit-codex-service-test.js` | PASS (`unit-codex-service-test.js: ok`) |
| `node tests/compat/release-provenance-test.js` | PASS (`release-provenance-test.js: ok`) |
| `node tests/integration-codex-mcp-test.js` | PASS (`integration-codex-mcp-test.js: ok`) |
| `node tests/release-live-codex-cli-test.js` | PASS |
| `node tests/unit-standalone-client-test.js` | PASS |
| `node scripts/package-smoke.js` | PASS (`{"ok":true,"smoke":"installed-package-runtime"}`) |
| `node tests/compat/write-mode-gate-test.js` | **RED, unchanged and not waived** |

The unwaived write-mode RED remains the previously isolated `captureFromEvent` ordering issue (`captureFromEvent requires db` instead of `GIGABRAIN_WRITE_FORBIDDEN`). It is outside the three files owned by C2 fix 2.1 and remains a separate bounded Task 11 round.

## C2 fix 2.2

Date: 2026-08-27
Base: `5b8f1a2872af596c6dbc78d0cb6578efc566b53d`

### Selected-store pre-open closure

- Standalone doctor now uses the authoritative exported `loadCodexContext` resolver to obtain the normalized project and user store configurations used by `runDoctor`; it does not synthesize or scan broader paths.
- Every store selected by `--target project|user|both` is header/sidecar-preflighted before `runDoctor`. If one configured store is unsafe, `runDoctor` is not called and no selected SQLite database is opened. Each selected store receives a pending, content-free diagnostic: its own safety reason, `selected_store_preopen_blocked` for a safe peer, or `store_not_configured` when applicable.
- TDD fixtures cover safe-project/unsafe-user and unsafe-project/safe-user under `--target both`. They require exact hashes for the main DB, WAL, SHM, config, and every other path to remain unchanged. A both-safe fixture proves normal two-store Codex doctor health still runs; only pre-existing SHM lock bytes are treated as volatile on that allowed path.

### Exact Task 14 evidence contract

Fix 2.2 supersedes the provisional four-column ledger check documented in fix 2.1. The exported contract now requires exactly these ordered ledger columns:

```text
migration_id,status,receipt_hash,schema_hash,receipt_json
```

The canonical receipt is one-line UTF-8 JSON with keys in this exact order and no extras:

```json
{"contract":"gigabrain-memory-console-metadata-receipt-v1","migration_id":"gigabrain-schema-0.11-compat-v1:memory-console-metadata-backfill","status":"completed","schema_hash":"<64-lower-hex>","counts":{"legacy_metadata_rows":0,"sidecar_metadata_rows":0},"metadata_roots":{"legacy_sha256":"<64-lower-hex>","sidecar_sha256":"<64-lower-hex>"}}
```

- Both counts must be safe integers from zero through `10000000`, equal each other, and equal the current read-only database counts.
- Both metadata roots must be lowercase SHA-256, equal each other, and equal freshly computed roots over fixed-key metadata rows ordered by binary memory ID. The logical-root envelope is `gigabrain-memory-console-metadata-logical-root-v1`.
- `receipt_hash` is recomputed from the exact canonical `receipt_json` bytes.
- The schema hash is recomputed from canonical `gigabrain-memory-console-metadata-schema-v1` JSON containing the exact `sqlite_master.sql`, ordered `PRAGMA table_info(memory_console_metadata)` fields, exact index SQL, and ordered `PRAGMA index_info(idx_memory_console_metadata_concept_pinned)` fields. The recomputed value must match both the ledger row and canonical receipt.
- The exact receipt and schema definitions are exported as `TASK14_MEMORY_CONSOLE_METADATA_RECEIPT_CONTRACT` and `TASK14_MEMORY_CONSOLE_METADATA_SCHEMA_CONTRACT` for the Task 14 implementation. Doctor creates or mutates none of this evidence and returns only stable reason codes, never receipt JSON, hashes, or metadata.

### TDD evidence

- Multi-store RED: the project-only safety branch returned only the unsafe project record and did not resolve/report the selected user store; the inverse direction could reach `runDoctor` through a safe project preflight.
- Cryptographic RED: arbitrary 64-hex values and schema presence were sufficient for `ready`; the payload lacked the exported receipt/schema contract identifiers.
- GREEN covers exact ready evidence plus missing/extra ledger columns, missing row, incomplete/case-mismatched/`schema_only` status, malformed and arbitrary hashes, invalid/noncanonical/extra-field JSON, receipt/schema disagreement, bounded/mismatched counts, altered table/index contracts, and unequal logical counts/roots.

### Fix 2.2 verification

| Command | Result |
| --- | --- |
| `node tests/compat/memory-api-projection-test.js` | PASS (`memory-api-projection-test.js: ok`) |
| `node tests/compat/projection-writer-registry-test.js` | PASS (`projection-writer-registry-test.js: ok`) |
| `node tests/compat/observational-diagnostics-test.js` | PASS (`observational-diagnostics-test.js: ok`) |
| `node tests/compat/observational-core-patches-test.js` | PASS (`observational-core-patches-test.js: ok`) |
| `node tests/unit-codex-service-test.js` | PASS (`unit-codex-service-test.js: ok`) |
| `node tests/integration-codex-mcp-test.js` | PASS (`integration-codex-mcp-test.js: ok`) |
| `node tests/unit-runtime-guard-test.js` | PASS |
| `node tests/compat/release-provenance-test.js` | PASS (`release-provenance-test.js: ok`) |
| `node tests/release-live-codex-cli-test.js` | PASS |
| `node tests/unit-standalone-client-test.js` | PASS |
| `node scripts/package-smoke.js` | PASS (`{"ok":true,"smoke":"installed-package-runtime"}`) |
| `node tests/compat/write-mode-gate-test.js` | **RED, unchanged and not waived** |

The remaining write-mode RED is still the separately scoped `captureFromEvent` DB-vs-policy ordering issue; fix 2.2 does not conceal or waive it.

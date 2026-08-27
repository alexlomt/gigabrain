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

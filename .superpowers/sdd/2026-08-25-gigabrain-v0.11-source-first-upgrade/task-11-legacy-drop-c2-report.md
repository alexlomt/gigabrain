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

# Task 11 write-mode C2.3 report

Date: 2026-08-27
Base: `f30b502f10f4ca2ed77ad090e6817d7729a5899d`
Branch: `upgrade/v0.11-openclaw-compat-task11-impl`

## Scope

Changed only:

- `lib/core/capture-service.js`
- this report

`tests/compat/write-mode-gate-test.js` required no edit because its existing assertion exactly covered the regression. No config maps, expected-failure manifests, locks, production databases, services, or other capture behavior were changed.

## Root cause and fix

`captureFromEventInBatch` already enforced `capture.capture_from_event` through `resolveWriteMode(config)` and `assertWriteAllowed`, but the public `captureFromEvent` wrapper rejected a missing database first. Consequently, a read-only call with `db: null` returned `captureFromEvent requires db` instead of the stable fail-closed policy code.

The public entry now normalizes the configured write mode and asserts the existing capture operation before reading or validating `db`, generating an operation ID, entering a projection transaction, inspecting schema/tables, touching native/filesystem state, invoking a model, or performing any other side effect. The in-batch guard remains as defense in depth.

- `read_only` now always fails first with `GIGABRAIN_WRITE_FORBIDDEN`, independent of missing or malformed DB input.
- `native_only` retains the existing capture-operation policy denial.
- `full` retains the existing `captureFromEvent requires db` validation and all subsequent behavior.

## TDD evidence

Before the production edit:

```text
$ node tests/compat/write-mode-gate-test.js
COMPAT_EXPECTED_WRITE_MODE_GATE missing complete fail-closed writer policy
```

The underlying existing assertion expected `/GIGABRAIN_WRITE_FORBIDDEN/` from `captureFromEvent({ config: readOnlyConfig, db: null })` and received `Error: captureFromEvent requires db`.

After the single ordering change:

```text
$ node tests/compat/write-mode-gate-test.js
write-mode-gate-test.js: ok
```

The gate exposed no additional Task 11 ordering regression, so scope was not widened.

## Verification

| Command | Result |
| --- | --- |
| `node tests/compat/write-mode-gate-test.js` | PASS (`write-mode-gate-test.js: ok`) |
| `node tests/unit-capture-service-test.js` | PASS |
| `node tests/compat/projection-writer-registry-test.js` | PASS (`projection-writer-registry-test.js: ok`) |
| `node tests/compat/memory-api-projection-test.js` | PASS (`memory-api-projection-test.js: ok`) |
| `node tests/compat/auto-capture-policy-test.js` | PASS (`auto-capture-policy-test.js: ok`) |

The auto-capture policy test emitted Node's existing experimental `stripTypeScriptTypes` warning; the command exited zero and the warning is unrelated to this change.

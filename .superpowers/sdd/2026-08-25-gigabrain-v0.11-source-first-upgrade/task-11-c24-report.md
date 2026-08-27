# Task 11 quality cleanup C2.4 report

Date: 2026-08-27
Base: `783c4f3bd66ef159a9b1f2f5e2b22b3ac2141bd3`
Branch: `upgrade/v0.11-openclaw-compat-task11-impl`

## Scope

Changed only:

- `lib/core/openclaw-import.js`
- `tests/compat/projection-writer-registry-test.js`
- `tests/compat/packed-entry-smoke-test.js`
- this report

No package inventory, manifest, source-first map, lock, production database, or service was changed.

## Canonical OpenClaw import dedupe

The legacy importer previously trusted `row.normalized` when present. Old ASCII-era or otherwise incorrect normalized text could therefore miss an existing Unicode canonical target and create a duplicate.

The import lookup and write payload now always derive `normalized` from `normalizeContent(row.content)` and hash that canonical value. A normalized/hash match is resolved back to the complete current-memory row, and both same-ID and different-ID matches update the canonical target through the existing transactional projection writer.

The TDD fixture uses `Grüße 東京 — Café １２３`, a deliberately wrong legacy normalized value, and a pre-existing canonical target. Before the fix it reported `imported_count = 1`; after the fix it reports zero imports, one update, one duplicate/reuse, one current row, preserved source metadata, the source link bound to the canonical ID, and exactly one `openclaw_import_upsert` event.

## Collision-safe packed fixture

The packed-entry smoke previously created and recursively removed fixed paths under `memory_api`, allowing concurrent runs to interfere with each other or delete another invocation's fixture.

Each worker now creates one mkdtemp-owned root under `memory_api`, nests its synthetic versioned venv and cache bytes inside that root, and recursively removes only that exact owned root. The npm cache remains a separate unique temp directory. The main smoke launches two worker processes concurrently; both independently prove the reviewed npm inventory and required/excluded runtime files. Fixed fixture names are statically rejected.

## TDD evidence

- Unicode import RED: the compatibility registry test expected `imported_count = 0` but received `1`, proving the stale legacy normalized field bypassed canonical dedupe.
- Packed fixture RED: the packed-entry contract failed while the fixed `.venv`/cache fixture names remained in the test source.
- Both focused tests passed after their respective minimal changes.

## Verification

| Command | Result |
| --- | --- |
| `node tests/unit-openclaw-import-test.js` | PASS (`unit-openclaw-import-test.js: ok`) |
| `node tests/compat/projection-writer-registry-test.js` | PASS (`projection-writer-registry-test.js: ok`) |
| `node tests/compat/packed-entry-smoke-test.js` | PASS (`packed-entry-smoke-test.js: ok`) |
| `node scripts/package-smoke.js` | PASS (`{"ok":true,"smoke":"installed-package-runtime"}`) |
| `node tests/unit-public-mirror-test.js` | PASS (`{"ok":true,"test":"unit-public-mirror-test.js"}`) |

The public-mirror counts and reviewed package inventory remain unchanged.

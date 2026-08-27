# Task 11 release closure C1 report

## Scope

Changed only the reviewed release-closure paths, plus the explicitly authorized
nested npm boundary and scanner-safe synthetic fixtures:

- `lib/compat/release-provenance.js`
- `tests/compat/release-provenance-test.js`
- `.github/workflows/ci.yml`
- `.npmignore`
- `memory_api/.npmignore`
- `public-release-manifest.json`
- `tests/unit-public-mirror-test.js`
- `tests/compat/packed-entry-smoke-test.js`
- `memory_api/README.md`
- `memory_api/requirements-prod-py310-linux-x86_64.lock`
- `memory_api/requirements-dev.lock`
- `memory_api/wheelhouse-py310-linux-x86_64.manifest.json`
- `tests/compat/auto-capture-policy-test.js`
- `tests/compat/auto-capture-queue-test.js`
- `tests/compat/auto-capture-worker-test.js`
- this report

Writer code, Python application code, package.json, migration/source-first maps,
test registry, expected failures, production/runtime wheelhouses and venvs were
not changed.

## Protected input preservation

The pre-existing Task 11 README/lock/manifest work was treated as protected
input. The locks and wheel manifest remain byte-identical to intake:

```text
35cbdccce52844b0c0807f16c0290f62cca25e78d035960953865fc6aa010833  requirements-prod-py310-linux-x86_64.lock
85884affe10287baad6f99dfddc18fd8a9f61561f48431aa3fe4b6b72a28dadb  requirements-dev.lock
698cdfb724f020c8b8fc297b4c99afa63a3c40a49fc76e2a277982f6d73c538d  wheelhouse-py310-linux-x86_64.manifest.json
```

The existing README changes were preserved and extended only with the reviewed
CI-versus-Task-15 wheel-source distinction.

## RED evidence

### Dependency identity

The release provenance contract first required the new API before production
edits and failed with its stable signature:

```text
COMPAT_EXPECTED_RELEASE_PROVENANCE missing immutable release identity round-trip
exit 1
```

The RED matrix covered missing/extra/version-drifted installed distributions,
missing explicit inventory, production-lock hash drift, wheel-inventory hash
drift, wheel index provenance drift, lock/wheel set mismatch and Node lock
provenance drift against an expected combined root.

### Npm/public inventory

The behavioral packed-entry test ran real `npm pack --dry-run --json` and failed
because versioned venvs, bytecode, cache and the dev lock entered the package.
The pre-fix inventory was:

```text
4,437 files
112,453,501 unpacked bytes
memory_api/.venv-v0.11-dev/**
memory_api/.venv-v0.11-prod/**
memory_api/__pycache__/**
memory_api/requirements-dev.lock
```

The public mirror unit also failed because the production lock, development
lock, wheel manifest and Python projection suite were absent from the reviewed
public required set.

A synthetic npm fixture established the key root cause: a root `.npmignore`
cannot override an explicitly allowlisted `package.json.files: ["memory_api/"]`
directory. A nested `memory_api/.npmignore` was authorized and proved to enforce
the boundary without changing package.json.

### Lifecycle prepack scanner

After package inventory was fixed, lifecycle-enabled `npm pack --dry-run`
correctly stopped on five source-level synthetic credential URLs in the three
auto-capture compatibility tests. The literals were assembled from
non-matching source fragments; runtime strings and policy assertions are
unchanged. No scanner rule or production auto-capture code was weakened.

## Deterministic dependency-root API

`computeDependencyRoot` is a synchronous, no-subprocess API. The release builder
must pass `installedDistributions` explicitly; omitting it fails closed.
Status, health, doctor and normal provenance loads remain file-only and never
invoke Python.

The API:

- reads package-lock, the Python 3.10 production lock and wheel manifest through
  no-follow regular-file boundaries;
- normalizes Python distribution names with PEP 503 spelling and sorts the
  caller inventory deterministically;
- verifies exact installed name/version equality with both lock and wheel sets;
- verifies the manifest production-lock SHA-256 and exact JSON wheel-inventory
  SHA-256;
- validates one sorted wheel per distribution, exact version, lowercase SHA-256,
  HTTPS index provenance and exact manifest index agreement;
- binds each Node package path, name, version, resolved HTTPS URL, integrity,
  and dependency flags into `nodeRoot` together with the raw package-lock hash;
- binds Python lock, wheel-manifest, installed-inventory, platform, Python and
  index hashes into `pythonRoot`;
- derives `dependencyRoot` from both component roots and optionally verifies an
  expected release root.

The reviewed live inputs produce:

```text
dependencyRoot             dd35394b92d91737119e035e6ffa94e93187a94ea9da529936c1030a33b0df2a
nodeRoot                   29c33c6a3067f9e3fcdff63ff7f2fb252e61e01f3867e650f7b8fc0104aaa230
pythonRoot                 80074b43430e71e51781b3e4f2f44ac23c1543bcf2a41e7723b91a341b358331
packageLockSha256          c642c7fe9fa2ba785d07370981cae96d4822d2ed887386b5a6c58a52b97ecfae
pythonLockSha256           35cbdccce52844b0c0807f16c0290f62cca25e78d035960953865fc6aa010833
wheelInventorySha256       259dd19416266abac4969caaeb504292d39ad8838240382a7ad2592e6fa66a60
installedInventorySha256   b7ebde4a381ea0f96769104a1cd8198239be3579b529d0219e4d002c063cd253
nodePackages               94
pythonDistributions        27
```

## CI closure

- Python is pinned to `3.10.12` and verified before use.
- Production dependencies install into `.venv-ci-prod` from the production lock
  with `--require-hashes`; CI may download only matching artifacts.
- Both `tests.memory_api_security_test` and
  `tests.memory_api_projection_test` run in the production environment.
- Ruff and pip-audit install separately into `.venv-ci-dev` from the development
  hash lock.
- Ruff checks app plus both Python suites. pip-audit audits the production lock
  with hashes and pip resolution disabled.
- Task 15 remains responsible for the protected offline wheelhouse used by
  final release/canary builds.

## Package and public inventory closure

- Root and nested npm ignores exclude all `.venv*`/`venv*`, Python cache and
  bytecode, local env/runtime/data/output/secret/database/log artifacts and the
  development lock.
- Npm includes exactly app, README, `.env.example`, static UI,
  `requirements.txt`, production lock and wheel manifest for the Memory API.
- Public source additionally includes the development lock, nested npm boundary
  and Python projection test.
- The manifest is exact and reviewed at 179 repository files, 43 required
  files, 56 package-file selectors and 128 npm files.
- The packed-entry contract creates an actual versioned venv/cache fixture,
  executes a bounded real pack, compares every packed path with the reviewed
  manifest, and proves all private/runtime artifacts absent.

## GREEN evidence

```text
node tests/compat/release-provenance-test.js
release-provenance-test.js: ok

node tests/unit-public-mirror-test.js
{"ok":true,"test":"unit-public-mirror-test.js"}

node tests/compat/packed-entry-smoke-test.js
packed-entry-smoke-test.js: ok

node tests/compat/auto-capture-policy-test.js
auto-capture-policy-test.js: ok
node tests/compat/auto-capture-queue-test.js
auto-capture-queue-test.js: ok
node tests/compat/auto-capture-worker-test.js
auto-capture-worker-test.js: ok

node scripts/check-no-pii.mjs
PII/secret check passed (305 files scanned, 0 sensitive-data hits).

Python 3.10.12 production install --require-hashes
hash-locked-prod-install: ok
Python 3.10.12 development install --require-hashes
ruff 0.12.12
pip-audit 2.9.0

production Python unittest suites
Ran 29 tests ... OK
Ruff
All checks passed!
pip-audit production lock
No known vulnerabilities found

npm 12.0.2 lifecycle npm pack --dry-run
128 files; 619.8 kB packed; 2.5 MB unpacked; exit 0
npm 10.9.4 lifecycle npm pack --dry-run
128 files; 619.8 kB packed; 2.5 MB unpacked; exit 0
```

## Concerns and handoff

- The current development venv emits no audit or lint finding. The production
  tests emit one upstream Starlette/httpx deprecation warning; all 29 tests pass.
- Task 15 must read back the protected wheelhouse files against the committed
  manifest before final build; C1 intentionally does not create or modify a
  runtime wheelhouse.
- New owned release files (locks, wheel manifest and `memory_api/.npmignore`)
  are public-manifest registered here. The controller still needs to update the
  separately owned source-first maps/hashes after this exact commit.
- Unrelated pre-existing dirty files were preserved and excluded from staging.

## Commit

This report is committed atomically with the owned release implementation,
artifacts and tests. The immutable SHA is recorded in the parent handoff.

---

## Fix 1.1 — bind selected wheels to lock hashes and Python 3.10 tags

### RED evidence

Negative fixtures first recomputed the manifest inventory hash after replacing
an authorized wheel digest, switching to an arbitrary HTTPS mirror, or changing
the wheel filename/tags. The prior verifier accepted those self-consistent but
unauthorized manifests:

```text
node tests/compat/release-provenance-test.js
COMPAT_EXPECTED_RELEASE_PROVENANCE missing immutable release identity round-trip
exit 1
```

The RED matrix covered unauthorized digest, mirror, credentials, trailing slash,
query and fragment provenance; slash/backslash paths; distribution/version/build
drift; cp311 and mismatched ABI; Windows, macOS and aarch64 platforms.

### Implementation

- The production lock parser now retains the exact sorted set of SHA-256 hashes
  for every normalized distribution/version and rejects unhashed requirements.
- Every selected manifest wheel digest must belong to the matching requirement's
  lock hash set. Recomputing `inventorySha256` cannot authorize a new artifact.
- The manifest and every wheel entry must use the exact canonical index
  `https://pypi.org/simple`; mirrors, userinfo, query, fragment and slash drift
  fail closed.
- Wheel filenames must be plain trimmed basenames with no slash, backslash or
  control byte. The release accepts the five-field no-build PEP 427 shape only.
- Filename distribution and version must match the declared normalized values.
- Pure wheels must be `py3-none-any`. Binary wheels must be
  `cp310-cp310` and every compressed platform tag must be manylinux x86_64.
  Windows, macOS, generic Linux, aarch64, other Python/ABI tags and build-tag
  variants are rejected.
- The committed 27-wheel manifest was not changed.

### GREEN evidence

```text
node tests/compat/release-provenance-test.js
release-provenance-test.js: ok

node tests/compat/packed-entry-smoke-test.js
packed-entry-smoke-test.js: ok

node tests/unit-public-mirror-test.js
{"ok":true,"test":"unit-public-mirror-test.js"}
```

The reviewed live inventory still produces the exact C1 roots:

```text
dependencyRoot  dd35394b92d91737119e035e6ffa94e93187a94ea9da529936c1030a33b0df2a
nodeRoot        29c33c6a3067f9e3fcdff63ff7f2fb252e61e01f3867e650f7b8fc0104aaa230
pythonRoot      80074b43430e71e51781b3e4f2f44ac23c1543bcf2a41e7723b91a341b358331
Node packages   94
Python dists    27
```

Fix 1.1 is committed separately. Its immutable SHA is recorded in the parent
handoff response.

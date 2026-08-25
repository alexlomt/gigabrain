# Retired local implementations

Task 3 adopts audited upstream `v0.11.0` commit
`ef624f97cc616a9e00b6df653eded455fbd30e01` as the implementation authority.
The deployed fork remains evidence only. No implementation in this document is
an approved source-port target.

## Source-first disposition

| Retired local implementation | Disposition | Upstream replacement | Enforced evidence |
| --- | --- | --- | --- |
| host-trust implementation | Retired bytes; same public module path is upstream-owned | `lib/core/host-trust.js`, `lib/core/adaptive-trust.js` | `host-trust` retirement contract plus `trust-arbitration` byte-identity contract |
| belief-trust scoring in the old world model | Retired bytes; arbitration remains upstream-owned | `lib/core/belief-arbitration.js`, `lib/core/adaptive-trust.js`, upstream `world-model.js` | `belief-trust` retirement contract plus trust/custom-slot byte identity |
| workspace-identity implementation | Retired as local ownership; the adopted bytes already equal upstream | `lib/core/workspace-identity.js` | `workspace-identity` upstream-identity retirement and adoption contracts |
| Passport implementation | Retired modules; the command name may survive only as a tested Handoff alias | `lib/core/handoff-bundle.js`, `lib/core/handoff-record.js` | `passport` forbidden-byte/path contract and `handoff-v2` byte identity |
| broad vault mirror | Retired module | upstream read-only `lib/core/vault-sync.js`; the later generated operator surface is separately owned | `broad-vault-mirror` forbidden-byte/path contract and `vault-read-only` byte identity |
| remote embedding provider | Retired provider implementation | loopback-only Ollama endpoint behavior in `lib/core/embedding-service.js` | `remote-embedding-provider` forbidden-byte contract plus live URL-policy assertions |
| hand-edited generated runtime blob | Retired bytes; a future `index.js` is valid only when produced by the deterministic build task | upstream `index.ts` source entry | `hand-edited-runtime-blob` forbidden-byte contract and `runtime-source-entry` byte identity |
| one-time hygiene migration and cleanup script | Retired modules | active upstream maintenance and native-promotion boundaries | `one-time-hygiene` forbidden-byte/path contract and `active-boundary-retention` byte identity |

The custom-slot framework, all-scope guard, safe filesystem/URL boundaries,
observational recall and ranking pipeline, relevance floor, timeline route,
Handoff v2, read-only vault support, and dependency graph remain the upstream
implementations. `tests/compat/upstream-adoption-test.js` compares every named
adoption path byte-for-byte with the audited tag. It also normalizes only the
two compatibility-version fields in `package-lock.json` before comparing the
complete dependency tree.

## Package and release exclusion

The same test builds a real lifecycle-disabled npm tarball and a real
`git archive` release tree. It rejects every forbidden production path and
every hash-bound retired implementation byte sequence in:

- tracked candidate source;
- the Git release archive;
- the extracted npm package and npm-reported inventory; and
- the public repository/npm inventory in `public-release-manifest.json`.

This is byte/path/package behavior, not a source comment or marker check. The
source-first divergence gate independently applies the hash-bound adoption and
retirement contracts to every committed tree.

## Private operator semantics

Operator-specific slot, entity, and noise semantics are not public defaults or
fixtures. Task 3 leaves a protected, value-free `operator-rules-migration.json`
handoff contract. Task 4 owns deterministic source/symbol extraction, reviewed
rule values, approvals, and the final artifact hash. Until that work is done,
the protected contract explicitly records that values are pending; it is not a
migration payload and must not be applied.

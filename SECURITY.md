# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.9.x   | :white_check_mark: |
| < 0.9   | :x:                |

Only the latest published `0.9.x` release receives security fixes. Upgrade before reporting behavior that may already be fixed.

## Reporting a vulnerability

**Please do not open public issues for security vulnerabilities.**

Instead, use [GitHub Security Advisories](https://github.com/legendaryvibecoder/gigabrain/security/advisories/new) to report vulnerabilities privately.

Include:

- affected version and installation mode
- a minimal reproduction without real user data or credentials
- likely impact and required attacker access
- a suggested fix, if you have one

We aim to acknowledge a report within three business days and provide an initial triage status within seven business days. Timelines for a fix depend on severity and release risk.

## Security boundary

Gigabrain is local-first software that processes potentially sensitive memory. It is not a multi-tenant hosted service and does not make an untrusted local account safe. The operator is responsible for host access, disk encryption, backups, file permissions, model-provider configuration, and any network exposure.

The default standalone configuration uses local SQLite and no LLM provider. Optional features can expand the boundary:

- a configured cloud review provider never receives raw transcripts through capture; audit review skips credential-risk rows, masks supported PII shapes locally, and omits the original scope
- the remote bridge sends recall requests to the endpoint you configure
- manual exports and Handoff Records leave the store when you copy them
- `gigabrain.handoff-bundle/2.0` imports verify exact manifest/section keys, canonical source-link semantics, section counts and hashes, and a root binding every manifest field before opening a destination; integrity bypasses, truncated bundles, legacy v1, and future schemas fail closed
- the Python console URL importer is disabled unless explicitly enabled and allowlisted

See [the privacy model](docs/public/privacy-model.md) for the complete data-flow description.

## Security controls

Gigabrain enforces the following security controls:

- **Authentication**: data-bearing HTTP routes use token auth and fail closed; landing and health routes expose no memory data
- **Timing-safe comparison**: All token checks use `crypto.timingSafeEqual` / `hmac.compare_digest`
- **Scope enforcement**: scoped tokens cannot read unrelated project or user memories
- **Input and output bounds**: request bodies, uploads, URL responses, PDF pages, extracted text, and rate-limit state have explicit limits
- **Path and file guards**: document identifiers become fixed-size hashes; sensitive reads reject symlinks; generated artifacts use private, exclusive, atomic writes
- **SSRF reduction**: URL import is off by default; when enabled it requires an exact host allowlist, rejects userinfo/nonstandard ports/private peers, pins a validated public address for the socket, disables redirects and ambient proxies, retains TLS hostname verification, and streams through a byte cap
- **Outbound transport**: remote HTTP is rejected for networked LLM/bridge endpoints; Ollama is loopback-only; the Obsidian findings inbox requires verified loopback HTTPS and supports a custom CA
- **Secret handling**: cloud audit rejects credential-shaped rows before transport and masks supported PII shapes in other candidates; capture prefilters block credential-shaped facts before optional model calls; public-release scanners redact findings and fail closed on unknown binary files
- **Release isolation**: public releases are built from an explicit file allowlist into a fresh, single-commit repository

Security controls reduce risk; they do not prove that every remembered statement is true or safe to disclose. Review recalls and exports before using them in consequential workflows.

Handoff v2 is a transfer artifact rather than a backup. It excludes embeddings,
world-model entities and beliefs, checkpoints/claim proposals/receipts, the
review queue, native and host sync cursors, transcripts, and wiki projections.
Source events are carried only as evidence and are never replayed into the
destination event ledger.

### Unsafe development bypass

The Node/OpenClaw integration recognizes `GB_ALLOW_NO_AUTH=1` only as an explicit local-development escape hatch when no API or gateway token is configured. In that state every `/gb` data route accepts unauthenticated requests and Gigabrain logs a prominent warning. Never use the bypass on a network-facing, shared, or long-lived process; configure a token instead. The optional Python console has no equivalent bypass.

## Current review status

The dated dependency, static-analysis, route-authentication, privacy, and residual-risk results are published in [docs/public/security-review.md](docs/public/security-review.md). A passing audit is a point-in-time result, not a warranty.

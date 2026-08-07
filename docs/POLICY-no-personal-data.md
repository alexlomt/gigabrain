# Hard rule: no real personal data in this repository

Real personal data must never be committed to this repository — not in source, tests, eval fixtures, docs, comments, or commit messages. This applies to the maintainer's own data and, especially, to **any third party's data** (names, contact handles, addresses, relationships, health). A public repo is cloned, forked, indexed, and cached; once personal data lands in history it is effectively permanent.

## What counts as personal data
Real names, email addresses, phone/chat ids, usernames/handles, street addresses, employer/partner/relationship details, health data, or anything that identifies a real individual.

## Use synthetic data only
Fixtures, tests, and docs must use clearly-synthetic stand-ins:
- Names: invented (e.g. `Dana Mercer`, `Priya`), never a real person's name.
- Emails: `@example.com` / `@example.test` only.
- Ids/handles: obvious placeholders (`1000000000`, `@example_user`).
- Places/domains: `Lakeside`, `examplecoop.example`, never a real address or live domain.

## Enforcement (the hard rule)
- `scripts/check-no-pii.mjs` scans every tracked and publishable file with generic path, IP, device, contact, email, and credential detectors. The private release workspace additionally injects one-way blocked-identifier regression fixtures; those hashes and fixtures never ship. The scanner exits non-zero on any hit.
- The **`pii-scan` GitHub Action** runs it on every push and pull request and fails the build. This is server-side and cannot be skipped with local git config.
- Run it locally before committing: `node scripts/check-no-pii.mjs`.
- Optional local pre-commit hook:
  ```sh
  printf '#!/bin/sh\nnode scripts/check-no-pii.mjs || exit 1\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
  ```

## If personal data is ever committed again
1. Stop publication and revoke or rotate any exposed credential immediately.
2. Remove the data from every public ref and artifact; do not rely on a follow-up commit.
3. Contact GitHub/npm support for cache or package removal when applicable.
4. Rebuild the public mirror from a reviewed clean source and rerun every release gate.

This policy is intentionally strict because public repositories and packages are cloned, cached, forked, and indexed beyond the maintainer's control.

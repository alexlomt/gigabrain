# Contributing to Gigabrain

Thanks for contributing to Gigabrain.

Gigabrain is a local memory control plane for multiple agent hosts. The project mixes storage behavior, recall policy, privacy boundaries, and operational workflows, so small changes can have outsized user impact.

## Good First Contribution Areas

- Docs, setup UX, and onboarding
- Tests for memory behavior, recall quality, and vault generation
- Web console usability fixes
- Performance improvements with benchmarks
- Small bug fixes with clear reproduction steps

If you want to work on a larger behavior change, open an issue or discussion first so we can align on product intent before you spend time implementing it.

## Before You Start

1. Read the main [README](README.md) for the current architecture and workflows.
2. Check [SECURITY.md](SECURITY.md) if your change touches auth, recall injection, file access, or the web console.
3. Look for existing issues or discussions before starting duplicate work.

## Development Setup

Prerequisites:

- Node.js 22.18.0 or newer
- OpenClaw only if you want to test the plugin end-to-end
- Python 3.10+ only if you want to run the optional `memory_api`

Typical local setup:

```bash
git clone https://github.com/legendaryvibecoder/gigabrain.git
cd gigabrain
npm install
node tests/run-all.js
```

Useful commands:

```bash
node tests/run-all.js
npm run setup -- --help
node scripts/gigabrainctl.js doctor --config ~/.gigabrain/config.json --target both
node scripts/gigabrainctl.js sync-hosts status --config ~/.gigabrain/config.json
node scripts/check-no-pii.mjs
```

## Change Guidelines

- Keep changes narrow and reversible when possible.
- Prefer config- and test-backed changes over behavior drift hidden in prompts.
- Preserve the intentional memory contract:
  - native markdown is the human-readable layer
  - registry memory is the structured recall layer
  - explicit remember intent is treated as meaningful product behavior
- Avoid introducing user- or machine-specific paths, hostnames, or private runtime artifacts into docs, fixtures, tests, or release notes.
- Use `example.com`, documentation IP ranges, and obviously synthetic identities in fixtures.
- Never weaken a privacy gate with a filename or directory exemption. Reviewed binary/test fixtures require exact digests.
- The public test runner uses an exact allowlist. Add or remove a public `*-test.js` file and update `PUBLIC_TEST_FILES` in `tests/run-all.js` in the same change.

## Tests

Run the baseline before opening a PR:

```bash
node tests/run-all.js
node scripts/check-no-pii.mjs
npm audit --audit-level=high
```

Changes to `memory_api/` should also run:

```bash
python -m pip install -r memory_api/requirements.txt
python -m unittest tests/memory_api_security_test.py
```

If your change is focused, mention exactly what you tested in the PR description. For example:

- unit tests only
- full `node tests/run-all.js`
- manual remote-host/OpenClaw verification
- vault build / recall smoke test

Do not include real memories, raw transcripts, private benchmark rows, home-directory paths, access tokens, or screenshots in an issue or pull request. Reduce a reproduction to synthetic data first.

## Pull Requests

Please include:

- what changed
- why it changed
- how you verified it
- any behavior, migration, or rollout risk

Small PRs are easier to review than large mixed refactors.

## Security

Do not open public issues for vulnerabilities. Use the private reporting flow in [SECURITY.md](SECURITY.md).

## Questions

- Use GitHub Discussions for ideas, design questions, or usage help
- Use Issues for concrete bugs, regressions, or scoped feature requests

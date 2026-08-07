# How Sharing Works

Gigabrain supports multiple sharing modes depending on your host surface and config paths.

“Shared” means two clients are opening the same configured store. It does not mean that stores on two computers synchronize automatically.

## Sharing modes

| Mode | Default path | What is shared | What stays isolated |
| --- | --- | --- | --- |
| OpenClaw plugin | `~/.openclaw/openclaw.json` + plugin-managed paths | Nothing automatically with standalone hosts | OpenClaw plugin runtime and memory config |
| Codex shared standalone | `~/.gigabrain/config.json` | Shared standalone registry + shared user store with Claude when they point at the same config | Repo memory stays separated by `project:<repo>:<hash>` scope |
| Claude shared standalone | `~/.gigabrain/config.json` | Same standalone registry + same user store with Codex when they point at the same config | Repo memory stays separated by `project:<repo>:<hash>` scope |
| Project-local standalone | `<repo>/.gigabrain/config.json` | Nothing outside the repo unless you explicitly reuse that config elsewhere | Repo store and user overlay stay local to that repo |

## Key principles

- **OpenClaw is isolated by default**: The OpenClaw plugin path has its own config and does not silently share standalone Codex/Claude memory.
- **Codex + Claude share when pointed at the same config**: Fresh installs of both use `~/.gigabrain/config.json`, so they share the registry and user store.
- **Repo memory is always scoped**: Regardless of sharing mode, repo memory stays separated by `project:<repo>:<hash>`.
- **Personal memory follows the user store**: Both Codex and Claude read/write personal memory through the shared user store under `~/.gigabrain/profile/`.
- **Project-local is opt-in**: Use `--store-mode project-local` during setup for strict per-repo isolation.

## Sharing between computers

Treat code, configuration, and data as three separate layers:

- the same Git commit gives you code parity
- the same config values give you behavior parity
- only a deliberate store transfer or remote bridge gives you data continuity

For a reviewed one-time transfer:

```bash
npx gigabrainctl export-bundle --config ~/.gigabrain/config.json --out ./memory-bundle.json
npx gigabrainctl import-bundle --config ~/.gigabrain/config.json --in ./memory-bundle.json
```

The bundle is integrity-checked, but it is not encrypted and may contain sensitive memory. Transport and delete it according to your own secure-file policy.

For ongoing remote recall, configure `remoteBridge` with HTTPS and an auth token on the client store. The bridge is off by default. It does not merge two concurrently written SQLite files; it adds an explicit remote recall source.

Do not use generic cloud-drive synchronization to create two concurrent writers for one SQLite database.

## Scope rules

- **Private/main sessions** (direct chat): recall from all sources including `MEMORY.md` and private scopes
- **Shared contexts** (group chats, other users): only curated shared memories, never private data

Configure scope behavior in `openclaw.json` under the agent's memory settings.

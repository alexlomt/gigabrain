# Gigabrain Web Console

Optional FastAPI dashboard for browsing, editing, and managing a Gigabrain memory registry. Run it on loopback unless you have an authenticated private-network proxy.

This is the operational companion to the optional Obsidian memory surface and world-model layer:

- Use Obsidian for the human-readable curated memory view (`00 Home`, `30 Views`, `50 Briefings`, `10 Native`)
- Use the web console for operations, inspection, graph debugging, and audit workflows

## Features

- **Memory browser** — search, filter, paginate, edit, confirm/reject memories
- **Surface landing view** — shared vault summary with freshness, current state, important people/projects, and recent archives
- **Concept dedup** — group by concept, select duplicates, bulk merge/reject
- **Diagnostics** — internal explainability and maintenance diagnostics for advanced operators
- **Document store** — add text/URL/file documents, search, delete
- **Profile viewer** — static + dynamic profile facts at a glance
- **Knowledge graph** — interactive force-directed graph visualization
- **Metrics** — registry stats, scope breakdown, quality distribution

## Setup

1. Create a `.env` file (or copy `.env.example`):

```bash
cp .env.example .env
# Edit .env with your paths
```

2. For development only, install dependencies from the human-readable input:

```bash
pip install -r requirements.txt
```

Release and canary environments must be built offline from the reviewed
Python 3.10 lock and protected wheelhouse:

```bash
python3.10 -m venv --without-pip .venv-v0.11-prod
/path/to/bootstrap/pip --python .venv-v0.11-prod/bin/python install \
  --no-index --find-links /path/to/wheelhouse-py310-linux-x86_64 \
  --require-hashes --no-deps \
  --requirement requirements-prod-py310-linux-x86_64.lock
```

Ruff and pip-audit use the separate `requirements-dev.lock` and development
wheelhouse; they are not installed in the production environment.

CI runs on exact Python 3.10 with both hash locks and may download only artifacts
whose hashes are already pinned. Task 15 release/canary builds instead consume
the reviewed production lock from the protected offline wheelhouse.

3. Start the server:

```bash
uvicorn app:app --host 127.0.0.1 --port 7077
```

The UI is served at `http://127.0.0.1:7077/`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GB_REGISTRY_PATH` | Yes | Path to the Gigabrain SQLite database |
| `GB_OUTPUT_DIR` | No | Output directory for nightly/vault artifacts (default: sibling `output/` next to the registry) |
| `GB_SURFACE_SUMMARY_PATH` | No | Path to `memory-surface-summary.json` if you want to override auto-discovery |
| `GB_DOCS_PATH` | No | Directory for document store files |
| `GB_DOC_INDEX_AGENT` | No | Agent ID for doc indexing (default: `shared-docs`) |
| `GB_UI_TOKEN` | Yes | Admin auth token for every data-bearing API request |
| `GB_UI_SCOPE_TOKENS` | No | JSON object mapping one memory scope to one scoped token |
| `GB_API_RATE_LIMIT_PER_MIN` | No | Per-principal/path request limit (default: 120) |
| `GB_API_MAX_RATE_BUCKETS` | No | Maximum in-memory rate-limit buckets (default: 10000) |
| `GB_API_READ_ONLY` | No | Set to `1` for rollback-safe read-only startup. No schema/path/background writes occur and every mutating route returns HTTP 503. |
| `GB_ENABLE_API_DOCS` | No | Enable `/_docs`, `/_redoc`, and `/openapi.json` (off by default) |
| `GB_ENABLE_URL_IMPORT` | No | Enable URL import (off by default) |
| `GB_URL_IMPORT_ALLOWLIST` | No | Exact comma-separated URL host allowlist; required when URL import is enabled |
| `GB_ALLOW_PRIVATE_URLS` | No | Permit allowlisted private hosts; unsafe for exposed deployments and off by default |
| `GB_RECALL_EXPLAIN_URL` | No | Optional recall-diagnostics proxy; only loopback HTTP(S) URLs are accepted |
| `GB_MAX_JSON_BODY_BYTES` | No | Hard cap for JSON request bodies (default: 2500000 bytes) |
| `GB_MAX_MULTIPART_BODY_BYTES` | No | Hard cap before multipart parsing (default: 11534336 bytes) |
| `GB_MAX_PDF_PAGES` | No | PDF page limit (default: 200) |
| `GB_MAX_EXTRACTED_CHARS` | No | Extracted document character limit (default: 2000000) |

## Auth

All data-bearing endpoints require the `X-GB-Token` header. `/` serves the static login shell; optional API documentation routes contain schema only.

- `GB_UI_TOKEN` grants admin access.
- `GB_UI_SCOPE_TOKENS` can provide scoped read/write access for specific memory scopes.

If neither an admin token nor scoped tokens are configured, protected requests are rejected. The UI keeps the entered token in memory for the current page session.

For `POST /recall/explain`:

- admin tokens may omit `scope`
- single-scope tokens may omit `scope` and the server will derive it
- multi-scope tokens should send an explicit concrete scope such as `shared` or `profile:main`
- the optional diagnostics proxy is contacted only on loopback; non-loopback URLs are ignored and the local fallback is used

## Remote access

The server binds to `127.0.0.1` (loopback only). For remote access, use one of:

- **Tailscale serve** (recommended): `tailscale serve --bg 7077`
- **SSH tunnel**: `ssh -L 7077:127.0.0.1:7077 user@host`

Do not bind to a non-loopback interface without a private-network ACL, TLS termination, and a deliberate threat review.

## macOS (launchd)

Create a plist at `~/Library/LaunchAgents/com.gigabrain.memory-api.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gigabrain.memory-api</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/venv/bin/uvicorn</string>
    <string>app:app</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>7077</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/gigabrain/memory_api</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GB_REGISTRY_PATH</key>
    <string>/path/to/memory.db</string>
    <key>GB_UI_TOKEN</key>
    <string>REPLACE_AT_INSTALL_TIME</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gigabrain.memory-api.plist
```

## Linux (systemd)

```ini
[Unit]
Description=Gigabrain Memory API
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/gigabrain/memory_api
EnvironmentFile=/path/to/.env
ExecStart=/path/to/venv/bin/uvicorn app:app --host 127.0.0.1 --port 7077
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/memories` | List memories (query, status, scope, sort, limit, offset) |
| `GET` | `/memories/{id}` | Get single memory |
| `GET` | `/memories/{id}/relations` | List relations visible from one memory |
| `POST` | `/memories` | Create memory |
| `PATCH` | `/memories/{id}` | Update memory |
| `POST` | `/memories/{id}/confirm` | Confirm pending memory |
| `POST` | `/memories/{id}/reject` | Reject memory |
| `POST` | `/memories/merge` | Merge duplicate memories |
| `GET` | `/relations` | List relations (scoped tokens must anchor with `from` or `to`) |
| `GET` | `/concepts` | List concept groups |
| `GET` | `/audit` | List audit-flagged items |
| `GET` | `/docs` | List documents |
| `GET` | `/docs/{id}` | Get document |
| `POST` | `/docs` | Create document (text) |
| `POST` | `/docs/url` | Create document from an enabled, exactly allowlisted URL |
| `POST` | `/docs/file` | Create document (file upload, max 10 MB) |
| `PATCH` | `/docs/{id}` | Update document |
| `DELETE` | `/docs/{id}` | Delete document |
| `GET` | `/profile` | Get agent profile |
| `POST` | `/recall/explain` | Recall with debug info (explicit scope required for multi-scope tokens) |
| `GET` | `/graph` | Knowledge graph data |
| `GET` | `/surface` | Shared Obsidian/web surface summary, including native vs registry source-layer counts |
| `GET` | `/world/summary` | Admin-only world-model counts and latest briefing |
| `GET` | `/world/entities` | Admin-only entity list |
| `GET` | `/world/entities/{id}` | Admin-only entity detail |
| `GET` | `/world/beliefs` | Admin-only belief list |
| `GET` | `/world/open-loops` | Admin-only open-loop list |
| `GET` | `/world/contradictions` | Admin-only contradiction-review list |
| `GET` | `/world/briefings` | Admin-only synthesized briefings |
| `GET` | `/metrics` | Registry statistics |

Interactive API docs at `/_docs` (Swagger) and `/_redoc` (ReDoc) are disabled by default. Set `GB_ENABLE_API_DOCS=true` only when needed.

## Size limits

- File uploads: 10 MB max
- Raw multipart request bodies: 11,534,336 bytes max by default, enforced before multipart parsing
- JSON request bodies: 2,500,000 bytes by default
- URL fetch: 5 MB max
- PDF pages: 200 by default
- Extracted document text: 2,000,000 characters by default

URL import does not follow redirects or use ambient proxies, rejects userinfo,
fragments and nonstandard ports, resolves every allowlisted hostname once and
pins the validated address into the request socket (closing DNS-rebinding gaps),
keeps normal HTTPS certificate/hostname verification, accepts HTML/plain text
only, and streams through the byte cap. It remains off until both
`GB_ENABLE_URL_IMPORT=true` and `GB_URL_IMPORT_ALLOWLIST` are configured.

The console UI uses system fonts and a built-in SVG graph renderer. It loads no third-party browser scripts, fonts, styles, or images. Its single-file CSP permits the page's own inline script and style blocks while restricting scripts, connections, fonts, and images to the same origin (plus data images); dynamic memory text is escaped or assigned through text-only DOM APIs.

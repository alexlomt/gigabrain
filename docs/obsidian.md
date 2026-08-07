# Obsidian and Gigabrain

There are **three** distinct Obsidian relationships in Gigabrain's history. This
page disambiguates them so the boundary is
unmistakable:

1. **The vault REFERENCE leg (supported).** An Obsidian vault → Gigabrain,
   **read-only**. Notes are surfaced as neutral reference material in recall and
   **never become beliefs**. Configured via `config.native.vaults[]`.
2. **The findings INBOX (supported, opt-in).** Gigabrain → one
   Gigabrain-owned note, append-only, manually triggered and disabled by default.
3. **The broad Obsidian-EXPORT surface (retired).** Gigabrain → an Obsidian vault,
   writing generated dashboards/entity pages out for visual browsing. This is the
   opposite arrow and is **not** what `config.native.vaults[]` does.

If you only read one section, read the first.

## 1. The vault REFERENCE leg (the supported integration)

A "vault" here is a directory of Markdown notes (an Obsidian vault, or any
Obsidian-style folder) that you want Gigabrain to **read from** and surface as
neutral reference snippets inside recall. It is configured per store under
`config.native.vaults[]`:

```jsonc
{
  "native": {
    "vaults": [
      { "path": "~/Notes/example-vault" },
      { "path": "~/Notes/research-vault", "glob": "**/*.md", "maxFileKB": 512 }
    ]
  }
}
```

(Paths above are synthetic examples — point `path` at your own vault.)

What the reference leg does, and — more importantly — what it never does:

- **Read-only.** Gigabrain only ever reads vault files. It never writes back into
  the vault, never renames notes, never creates files in it.
- **Ingested into native chunks.** Each note is chunked by the same native chunker
  used for curated notes and stored in `memory_native_chunks` with
  `source_kind='vault'`. The ingest is eviction-safe for iCloud vaults (dataless
  `.icloud` placeholders and 0-byte stubs are counted as skipped, never errors).
- **Surfaced through recall, labeled and neutral.** Vault chunks appear in the
  unified recall surface (MCP `gigabrain_recall`, HTTP `POST /gb/recall`) as
  clearly-labeled reference snippets.
- **NEVER becomes a belief.** This is the hard invariant (the "R2 keystone"). A
  vault chunk has no `memory_current` row, never feeds `promoteNativeChunks`,
  never enters belief arbitration, and carries **zero arbitration participation**.
  It is reference, not a claim Gigabrain holds. The keystone is enforced at the
  write boundary in `lib/core/vault-sync.js` by construction (that module imports
  nothing from promotion / capture / world-model).
- **No-op by default.** `config.native.vaults[]` defaults to `[]`, so vault-sync
  and the `vault` CLI verbs are graceful, zero-cost no-ops until you configure a
  vault.

### Operating it

```bash
# (Re)ingest configured vaults. --dry-run reports without writing.
node scripts/gigabrainctl.js vault sync --config ~/.gigabrain/config.json

# Per-vault chunk counts, last sync timestamp, and skipped-evicted counts.
node scripts/gigabrainctl.js vault status --config ~/.gigabrain/config.json
```

- The **nightly** maintenance run also performs a **budgeted** vault-sync
  (`config.native.vaultSyncMaxFiles`, default 2000 changed files per run; any
  excess defers to the next run). The nightly summary reports
  `vault_sync_changed_files` and `vault_sync_skipped_evicted`.
- Both verbs print
  `{ "ok": true, "enabled": false, "reason": "no vaults configured" }` when
  `vaults[]` is empty.

See `docs/coverage-matrix.md` for how the vault capability maps across MCP / CLI /
HTTP.

## 2. The findings INBOX (supported, narrow write boundary)

The optional findings inbox appends a dated contradiction digest to exactly one
Gigabrain-owned note through the Obsidian Local REST API. It is separate from
`native.vaults[]`, never edits human-authored notes, never deletes anything and is
not part of nightly maintenance.

It is disabled until the operator explicitly configures and invokes it:

```jsonc
{
  "vault": {
    "inbox": {
      "enabled": true,
      "apiUrl": "https://127.0.0.1:27124",
      "notePath": "GigaBrain/Findings.md",
      "apiKeyPath": "~/.config/obsidian-local-rest-api/key",
      "caPath": "~/.config/obsidian-local-rest-api/cert.pem",
      "maxFindings": 20
    }
  }
}
```

The paths are examples. `apiKeyPath` must contain only the Local REST API bearer
key, and `caPath` must point to the PEM certificate that should be trusted for
that local server. Gigabrain requires HTTPS on a loopback address and keeps TLS
certificate verification enabled; there is no insecure certificate-bypass mode.

```bash
# Render the exact append payload without contacting Obsidian.
node scripts/gigabrainctl.js vault inbox --dry-run --config ~/.gigabrain/config.json

# Append once to the configured Gigabrain-owned note.
node scripts/gigabrainctl.js vault inbox --config ~/.gigabrain/config.json
```

Inline `apiKey` remains supported for compatibility, but `apiKeyPath` in a
user-private directory is preferred so the secret does not enter a committed
configuration file.

## 3. The broad Obsidian-EXPORT surface (retired)

Historically Gigabrain could **export its own memory state out into** an Obsidian
vault — generated `Home`, `Views/`, `Entities/`, `Briefings/` notes, etc. — under
a `config.vault.*` block, driven by `vault build` / `vault doctor` / `vault report`
/ `vault pull` verbs.

That direction — Gigabrain as a **writer/publisher** into a vault — is **retired**
and is **not** the integration documented above. In particular:

- It used `config.vault.*` (a top-level export config), **not**
  `config.native.vaults[]`.
- The current `vault` CLI verb implements `sync` and `status` for the read-only
  reference leg plus the narrowly bounded `inbox` append described above. The
  old `build` / `doctor` / `report` / `pull` subcommands are not part of this
  surface.

If you are looking for the export/publish behavior, treat it as out of scope here:
this page covers the read-only reference corpus and the single-note findings
inbox. The runtime store remains the source of truth either way.

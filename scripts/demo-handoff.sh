#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/gigabrain-handoff-demo.XXXXXX")}"
PROJECT_ROOT="$ROOT/project"
HOME_ROOT="$ROOT/home"
CODEX_HOME="$HOME_ROOT/.codex"
CLAUDE_HOME="$HOME_ROOT/.claude"
HANDOFF_DIR="$ROOT/handoff"

mkdir -p "$PROJECT_ROOT" "$CODEX_HOME/memories" "$CLAUDE_HOME/projects/demo/memory"
printf '{"name":"gigabrain-handoff-demo","private":true}\n' > "$PROJECT_ROOT/package.json"
# Deliberately fake secret-shaped fixture. Its exact digest is reviewed in the
# public PII scanner so the demo cannot teach contributors to evade detection
# by assembling credential-shaped strings at runtime.
DEMO_SECRET='sk-demo-handoff-redacted-1234567890'
printf '%s\n' \
  '- User prefers launch notes with concrete verification evidence.' \
  "- API_KEY=$DEMO_SECRET" > "$CODEX_HOME/memories/preferences.md"
cat > "$CLAUDE_HOME/projects/demo/memory/preferences.md" <<'EOF'
- User prefers launch notes with concrete verification evidence.
- Demo handoffs should be short enough to paste manually.
EOF

export HOME="$HOME_ROOT"
export CODEX_HOME

node scripts/gigabrain-codex-setup.js --project-root "$PROJECT_ROOT" >/dev/null
CONFIG_PATH="$HOME_ROOT/.gigabrain/config.json"

node scripts/gigabrainctl.js sync-hosts \
  --config "$CONFIG_PATH" \
  --codex-home "$CODEX_HOME" \
  --claude-home "$CLAUDE_HOME" \
  --host codex,claude_code \
  --scope profile:user >/dev/null

node scripts/gigabrainctl.js handoff \
  --config "$CONFIG_PATH" \
  --codex-home "$CODEX_HOME" \
  --claude-home "$CLAUDE_HOME" \
  --scope profile:user \
  --output-dir "$HANDOFF_DIR"

printf '\nMemory Audit + Handoff Records demo written to:\n%s\n' "$HANDOFF_DIR"

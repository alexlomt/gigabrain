# World-model custom slot rules (operator-specific claim slots)

The world-model claim-slot detectors that ship in the engine are **generic**: they
recognise category-level vocabulary (a relationship, a location, a birthday, a
weight/fitness goal, generic credential/transport ops terms) but carry **zero
operator-specific tokens**. A particular host's runbook phrasing (its gateway,
launch-agent, messaging RPC, browser-debug or login-code wording), a personal
health program or a hard target like `target: 72kg`, and any named partner / city
are deliberately **not** hardcoded — baking them in would overfit the engine to one
operator and leak that operator's footprint into a shipped default.

The private engineering release suite enforces this before a public mirror can
be built: operator-specific literals may not be hardcoded back into named
personal-slot detectors. The shipped defaults remain directly inspectable in
`lib/core/world-model.js` and `lib/core/policy.js`.

Operators add their own durable slots through
`config.worldModel.customSlotRules`. Each rule maps a regex over the memory text
to a slot, and is applied **before** the generic detectors, so a custom rule always
wins for text it matches. Invalid regexes are skipped (never thrown). Defaults to
`[]` (generic detectors only). See also
[`docs/configuration.md`](configuration.md#worldmodelcustomslotrules).

| Field | Required | Purpose |
| --- | --- | --- |
| `pattern` | yes | Regex matched against the memory content |
| `flags` | no | Regex flags (default `i`) |
| `slot` | yes | Dotted slot id, e.g. `ops.runbook.gateway` |
| `topic` | no | Coarse topic used by recall reranking and tiering (`ops` → `ops_runbook`, `health`/`relationship` → `durable_personal`) |
| `subtopic` | no | Finer label within the topic |
| `value` | no | Fixed normalized value; omit to summarise the matched text |
| `operation` | no | `update` (default) or `remember` |

## Re-adding migrated ops / health routing

The two examples below restore exactly the kind of routing that was previously
hardcoded — an operator's runbook phrase routing to `ops_runbook`, and a personal
weight target routing to `durable_personal` (via topic `health`). Replace the
synthetic patterns with your own deployment's vocabulary.

```json
{
  "worldModel": {
    "customSlotRules": [
      {
        "pattern": "gateway restart|launch-?agent kickstart|messaging rpc",
        "slot": "ops.runbook.gateway",
        "topic": "ops",
        "subtopic": "runbook"
      },
      {
        "pattern": "target:\\s*\\d+kg",
        "slot": "health.weight_goal",
        "topic": "health",
        "subtopic": "weight_goal"
      }
    ]
  }
}
```

With these rules configured, content matching the patterns slots and tiers just as
the old hardcoded constants did — but the engine's default stays generic and
operator-agnostic.

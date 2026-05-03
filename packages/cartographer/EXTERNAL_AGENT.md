# External Agent Handoff

Cartographer v1 is a CLI-skill layer with a browser fallback recorder. Use the
generated site CLI first. The CLI preloads the site skill registry before
execution. Use fallback recording when the generated CLI has no suitable
command, an action fails, or final postconditions fail. Drift alone is
diagnostic and is not a failure when postconditions pass.

## Start Here

Available repo-exposed skills:

- `packages/cartographer/skills/instagram.com/SKILL.md`

Runtime-local skills are also emitted to:

- `~/.cartographer/sites/instagram.com/SKILL.md`

Refresh the repo-exposed skill file after promotion review:

```bash
pnpm --filter @cartographer/core build
node packages/cartographer/dist/cli.js expose-skills instagram.com
```

Project tracking docs:

- `architecture.md`: current system architecture and gaps
- `agent-handoff.md`: latest operational handoff for implementation sessions
- `ubiquitous_language.md`: shared product vocabulary
- `packages/cartographer/EXTERNAL_AGENT.md`: compact guide for external agents

## Instagram v1 Flow

The external agent does the reasoning. Read `SKILL.md`, choose an explicit
command, and run it. Cartographer does not map natural-language intents to
commands in v1.

Inspect available commands:

```bash
~/.cartographer/bin/instagram-com-cli --help
```

Run write-capable commands with `--dry-run` first:

```bash
~/.cartographer/bin/instagram-com-cli send-message --message "hello" --dry-run
```

Actually write only when explicitly approved:

```bash
~/.cartographer/bin/instagram-com-cli send-message --message "hello" --confirm-write
```

Read commands return JSON. If a command declares outputs in `SKILL.md`, consume
the `outputs` object:

```json
{
  "success": true,
  "processName": "open_inbox",
  "outputs": {
    "visibleText": "..."
  }
}
```

## Fallback Status

Fallback is explicit and Playwright-based in v1.

If no skill fits, enter the deterministic browser fallback path:

```bash
node packages/cartographer/dist/cli.js fallback instagram.com --intent "new task"
```

That opens local Chrome through Playwright and starts the fallback prompt. The
external agent or user records fallback steps:

```text
goto <url>
goto-inbox
click <selector>
fill <selector> <value>
fill-arg <selector> <arg-name> <value>
text [selector]
screenshot <label>
record-step <step-name> [--write]
save-fallback [--write] [--arg message]
quit
```

Use `fill-arg` for values that should become future CLI arguments. It types the
real value into the browser but records `%argName%` in the fallback tape.

The saved fallback tape stores deterministic session facts:

- session id and recording timestamps
- operation log for browser commands
- replayable steps selected by `record-step`
- explicit screenshots/text evidence
- selector diagnostics and write flags

After the fallback session, finish the user task. Then run end-of-task review:

```bash
node packages/cartographer/dist/cli.js end-task-review instagram.com --since "<taskStartedAt>"
```

For lower-level inspection, list unpromoted fallback tapes:

```bash
node packages/cartographer/dist/cli.js review-fallbacks instagram.com
```

This command emits review packets and writes `REVIEW.md` files under the
fallback directory. Inspect a specific fallback and its evidence previews:

```bash
node packages/cartographer/dist/cli.js inspect-fallback instagram.com <fallback-id>
```

Normal promotion uses a typed decision. Create review artifacts:

```bash
node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>
```

Read `review-request.json`, `decision-schema.json`, `decision-template.json`,
and `REVIEW.md`. Return one flat `PromotionDecision` JSON, then let
Cartographer apply it:

```bash
node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>
```

After a successful promote decision, the result includes
top-level `agentContractDelta` and `reusableCommand.command`. Patch your working
command list with `agentContractDelta` immediately, then use that exact command
for future matching tasks.

Manual promotion remains available as an escape hatch:

```bash
node packages/cartographer/dist/cli.js promote-fallback instagram.com <fallback-id> --command-name <snake_case> --description "what the tape actually does" --output visibleText:body:"visible text returned after replay"
```

If it is too task-specific or low quality, reject it:

```bash
node packages/cartographer/dist/cli.js reject-fallback instagram.com <fallback-id> --reason "too task-specific"
```

Delete fallback storage when it should not remain in the review set:

```bash
node packages/cartographer/dist/cli.js delete-fallback instagram.com <fallback-id>
```

## How Stagehand Is Hidden

External agents do not need to call Stagehand directly for known skills.

For known skills:

- `instagram-com-cli` loads a process tape.
- The emitted CLI preloads the site catalog and process tapes.
- The process tape replays recorded Stagehand `Action[]`.
- Cartographer validates each step with explicit validators plus its state/action cache.
- Writes require `--confirm-write`.

For missing skills:

- `cartographer fallback instagram.com --intent <task>` launches local Chrome through Playwright.
- The agent or user drives deterministic browser commands and records steps.
- End-of-task review happens after the user task is complete.
- Explicit promotion turns reusable fallback tapes into new CLI commands and
  SKILL.md entries.

Stagehand can still be used later as a smart fallback when API keys are
available, but it is not the default fallback path. The V1 default fallback path
must work locally without external model/API keys.

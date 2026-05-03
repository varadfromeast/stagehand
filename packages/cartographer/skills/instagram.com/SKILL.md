---
name: instagram-com-cli
description: Use deterministic instagram.com CLI skills first, inspect structured outputs, and record browser fallback when no listed command fits or a command fails.
---

# instagram.com CLI Skill

Use the emitted CLI before browser automation. Fall back to the browser recorder only when no listed command directly covers the task or a command fails.

## Runtime Contract

- The external agent does the reasoning. Read this file, choose an explicit command, then run it.
- Tool selection is model-controlled: the agent decides whether one listed command directly fits the task.
- The CLI never infers broad user intent. It only executes the named command it was asked to run.
- The emitted CLI preloads the site skill registry before command execution.
- Prefer `instagram-com-cli` commands listed below when one directly fits the task.
- Use `--dry-run` first when inspecting a write-capable command.
- Commands that write to Instagram require `--confirm-write`.
- Command success is deterministic: actions must execute and final postconditions must pass. Hash drift is diagnostic unless a postcondition fails.
- Read commands return JSON. If a command has outputs, consume the `outputs` object instead of rendering the full page.
- Inspect `manifest.json` beside this file when you need the machine-readable command contract.
- Start substantial tasks with `node packages/cartographer/dist/cli.js begin-task instagram.com --intent <task>` so fallback review can be scoped.
- If no listed command directly covers the task, use `node packages/cartographer/dist/cli.js fallback instagram.com --intent <task>` to record fallback steps.
- If a CLI command returns `success:false`, inspect `failure`, `execution.actionFailures`, `postconditions`, and `drift`, then use fallback recording when needed.
- If fallback recording is used, the task is not complete until you run end-of-task review and promote, reject, or delete each reviewed fallback.
- Promotion is policy-gated in V1: promoted commands need explicit identity, correct write protection, and deterministic final postconditions.
- Normal promotion workflow: create a promotion review, reason over the review packet, return PromotionDecision JSON, then let Cartographer apply it with `apply-promotion-decision`.
- Do not run `promote-fallback` directly in normal agent workflow. It is a manual escape hatch; the typed decision path keeps reasoning separate from deterministic mutation.
- At end of task, run `node packages/cartographer/dist/cli.js end-task-review instagram.com --since <taskStartedAt>`, inspect evidence with `node packages/cartographer/dist/cli.js inspect-fallback instagram.com <fallback-id>`, create a review with `node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>`, then apply the completed decision with `node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>`.
- Reject or delete fallback tapes that are too specific with `node packages/cartographer/dist/cli.js reject-fallback ...` or `node packages/cartographer/dist/cli.js delete-fallback ...`.

## Output Contract

Every CLI command prints JSON:

```json
{"success":true,"processName":"example","execution":{"completed":true},"postconditions":{"required":true,"passed":true},"drift":{"detected":false},"outputs":{"name":"value"},"message":"..."}
```

- `success:true` means command execution completed and final postconditions passed.
- `success:false` means the named command failed mechanically or its final postconditions failed.
- `drift.detected:true` is a warning that the page fingerprint changed. Do not treat drift alone as failure when `success:true`.
- For read skills, prefer named values under `outputs`. Treat empty `outputs` as navigation-only or a sign that the command needs a better promoted output contract.

## Task Lifecycle

For multi-step or unfamiliar tasks, create a task envelope first:

```bash
node packages/cartographer/dist/cli.js begin-task instagram.com --intent "task description"
```

Keep the returned `taskStartedAt`. If fallback is used at any point, the required closeout is:

```bash
node packages/cartographer/dist/cli.js end-task-review instagram.com --since "<taskStartedAt>"
```

For every reviewed fallback from the task, make an explicit typed decision. Use `decision-template.json` as the starting shape when present:

- Promote when the tape is generic, repeatable, safe, and has deterministic postconditions.
- Reject when the tape is too task-specific, brittle, unsafe, or low quality.
- Delete only when the tape should not be retained.

Promotion decision JSON is the reasoning handoff. The agent supplies judgment in a flat PromotionDecision object; Cartographer validates and applies deterministic changes.

## Fallback And Skill Acquisition

Use fallback when no listed command directly matches the task, or when a command fails and the task can still be completed manually with browser operations.

```bash
node packages/cartographer/dist/cli.js fallback instagram.com --intent "task description"
```

Fallback is local Playwright capture by default; it does not require Stagehand/model API keys. The prompt accepts:

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

`record-step` selects replayable steps. Other operations remain deterministic review context in the fallback tape. Use `fill-arg` when a real value should become a future CLI argument; it records `%argName%` instead of the literal value.

Fallback is the organic acquisition path. After the user task is complete, review fallback tapes and promote reusable ones so the CLI acquires new skills:

```bash
node packages/cartographer/dist/cli.js end-task-review instagram.com --since "<taskStartedAt>"
node packages/cartographer/dist/cli.js inspect-fallback instagram.com <fallback-id>
node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>
node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>
```

After successful promotion, the apply result includes top-level `agentContractDelta`, plus `cliCommandName` and `reusableCommand.command`. Treat `agentContractDelta` as an immediate patch to your working command list, then use the regenerated CLI command for matching future tasks.

Promotion review prompt:

```text
You are reviewing a Cartographer browser fallback tape for CLI skill promotion.

Your job is reasoning only. Do not run promotion, rejection, deletion, browser, or shell commands yourself.

Return exactly one JSON object matching PromotionDecision.

Promote only if:
- the tape captures a reusable operation, not a one-off user task
- the command name describes the actual repeatable operation
- the tape is repeatable from its recorded entry state
- final postconditions deterministically prove success
- write behavior is correctly marked and safe behind --confirm-write
- read/data commands declare explicit outputs

Reject if:
- the tape depends on transient content, private accidental state, or brittle DOM position
- the broader user task was completed but the reusable operation is unclear
- postconditions or outputs are insufficient
- write behavior does not have a clear safety boundary

Delete only if:
- the tape is noise or should not be retained.

Cartographer will validate your JSON decision with PromotionPolicy and apply all deterministic mutations.
```

## Commands

### open-explore

open Instagram Explore page

```bash
instagram-com-cli open-explore
```

Expected JSON outputs: none declared. Use this as a navigation skill, not a read skill, until it is promoted with `--output`.

Final postconditions:
- `url_contains`: `/explore`

### open-inbox

open Instagram direct messages inbox

```bash
instagram-com-cli open-inbox
```

Expected JSON outputs: none declared. Use this as a navigation skill, not a read skill, until it is promoted with `--output`.

Final postconditions:
- `url_contains`: `/direct/inbox`

### send-message

send message in current Instagram direct thread

```bash
instagram-com-cli send-message --message <message> --confirm-write
```

Requires `--confirm-write` because it writes to Instagram.

Final postconditions:
- `text_contains`: `body` includes `%message%`

### send-test-dm

send a test DM to va_rad_

```bash
instagram-com-cli send-test-dm --message <message> --confirm-write
```

Requires `--confirm-write` because it writes to Instagram.

Final postconditions:
- `text_contains`: `body` includes `%message%`


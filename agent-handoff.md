# Agent Handoff - Cartographer V1

Cartographer is a CLI skill layer built in this Stagehand fork. The product
shape is:

1. External agents read the generated `SKILL.md` and optional `manifest.json`.
2. For substantial or unfamiliar tasks, the agent calls `begin-task` to get a
   scoped `taskStartedAt` and required review command.
3. The agent chooses a deterministic per-site CLI command when one directly
   fits the user task.
4. The CLI executes only the named command. It does not infer broad intent.
5. Runtime replays the recorded process tape and validates final
   postconditions.
6. Command JSON returns structured execution, postcondition, drift, output, and
   failure data.
7. If no listed command fits, or a command fails, the agent explicitly enters
   browser fallback recording.
8. Saving a fallback creates learning debt and prints a scoped review command.
9. After the user task is complete, fallback tapes are reviewed.
10. Reusable fallbacks are promoted into new CLI commands, regenerated
   `SKILL.md`, and regenerated `manifest.json`.

The key boundary is MCP-like: tool selection is agent-controlled, command
execution is CLI-controlled.

Use `ubiquitous_language.md` for shared domain vocabulary. In particular,
fallback creates learning debt: after a fallback is used, the agent must run
end-of-task review and either promote, reject, or delete each reviewed fallback.

## Current Status

Implemented package:

```text
packages/cartographer/
```

Current site:

```text
instagram.com
```

Generated agent contract files:

```text
packages/cartographer/skills/instagram.com/SKILL.md
packages/cartographer/skills/instagram.com/manifest.json
~/.cartographer/sites/instagram.com/SKILL.md
~/.cartographer/sites/instagram.com/manifest.json
```

Generated local CLI:

```text
~/.cartographer/bin/instagram-com-cli
```

Current commands in the local catalog:

```text
open-explore
open-inbox
send-message
send-test-dm
```

`open-explore` was acquired through a fallback/promotion run. The broader
delegated Explore search/click-profile test was interrupted before final
assessment, so only the promoted `open_explore` skill should be treated as
validated state from that run.

Current lifecycle support:

```text
begin-task returns taskStartedAt, fallback command, required review command
fallback save prints scoped end-task-review and promotion-review commands
generated SKILL.md and manifest.json mark fallback closeout as required
promotion review emits review-request.json, decision-schema.json, and REVIEW.md
apply-promotion-decision applies agent reasoning through deterministic code
```

Logs are enabled by default and written to stderr so JSON stdout remains
parseable. Use `CARTOGRAPHER_LOG=0` to silence logs and
`CARTOGRAPHER_LOG_LEVEL=debug` for selector/action-level detail.

Useful commands:

```bash
pnpm --filter @cartographer/core typecheck
pnpm --filter @cartographer/core build
node packages/cartographer/dist/cli.js begin-task instagram.com --intent "task description"
node packages/cartographer/dist/cli.js expose-skills instagram.com
node packages/cartographer/dist/cli.js review-fallbacks instagram.com
node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>
node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>
```

## Agent Contract

The generated `SKILL.md` is the human-readable operating contract. The generated
`manifest.json` is the machine-readable command contract.

The contract tells the agent:

- what commands exist
- which commands write to Instagram
- what arguments each command accepts
- what outputs each command declares
- what final postconditions decide command success
- how to interpret `success`, `execution`, `postconditions`, `drift`, and
  `failure`
- how to enter fallback recording
- how to review and promote fallback tapes so the CLI acquires skills
- that fallback-created learning debt must be closed before the task is
  considered complete

There is no hidden natural-language router in V1. The external agent decides
whether a listed command directly fits the user task.

## Success Model

Old behavior treated hash drift as command failure. That was too strict for
dynamic sites like Instagram.

Current behavior:

```text
success = no action failures && final postconditions passed
```

Hash drift is diagnostic only. A command can return `success:true` with
`drift.detected:true` if final postconditions passed.

Supported postconditions reuse `StepValidator`:

```ts
{ type: "url_equals"; value: string }
{ type: "url_contains"; value: string }
{ type: "selector_exists"; selector: string }
{ type: "text_contains"; selector: string; value: string }
```

Example result shape:

```json
{
  "success": true,
  "processName": "open_inbox",
  "execution": {
    "completed": true,
    "stepCount": 2,
    "executedStepCount": 2,
    "actionFailures": []
  },
  "postconditions": {
    "required": true,
    "passed": true,
    "checks": [
      {
        "type": "url_contains",
        "passed": true,
        "expected": "/direct/inbox",
        "observed": "https://www.instagram.com/direct/inbox/"
      }
    ]
  },
  "drift": {
    "detected": false,
    "severity": "none",
    "steps": []
  },
  "outputs": {},
  "message": "Replayed 2 step(s); postconditions passed."
}
```

## Happy Path

### 1. Agent Reads The Contract

Start from:

```text
packages/cartographer/skills/instagram.com/SKILL.md
packages/cartographer/skills/instagram.com/manifest.json
```

For substantial or unfamiliar tasks, create a task envelope:

```bash
node packages/cartographer/dist/cli.js begin-task instagram.com --intent "task description"
```

Keep the returned `taskStartedAt`. If fallback is used, close the task with the
returned `requiredReviewCommand`.

The agent should choose a listed command only when it directly fits. If no
listed command fits, use fallback recording.

### 2. Agent Runs A Known CLI Skill

If the task matches an available command:

```bash
~/.cartographer/bin/instagram-com-cli <command> [args]
```

For write commands:

```bash
--confirm-write
```

For read commands, consume declared values under `outputs` when present.
Navigation-only commands can have no outputs but must still have deterministic
postconditions.

### 3. Runtime Replays And Validates

Runtime path:

```text
NodeCliEmitter output
  -> createPreloadedRuntime(domain)
  -> SkillRegistry.preload(domain)
  -> ProcessTapeRuntime.runProcess()
  -> SkillRegistry.getProcess()
  -> BrowserSessionFactory.launchInstagram()
  -> BrowserSession.actRaw(Action) or BrowserSession.goto(url)
  -> StateIdentity.capture()
  -> ReplayValidator.validate(step.validators) for drift diagnostics
  -> ReplayValidator.validate(process.postconditions) for final success
  -> read declared ProcessOutput selectors
  -> JSON result
```

Important interfaces:

- `ProcessTape`: recorded command, args, steps, outputs, postconditions, write
  flag.
- `SkillRegistry`: preloads the site catalog and process tapes for command
  lookup.
- `TapeStore`: persists process tapes behind the registry.
- `BrowserSessionFactory`: opens the browser.
- `BrowserSession`: abstracts Stagehand/browser actions.
- `StateActionCache`: stores structural action cache entries by state/atom.
- `StateIdentity`: captures and normalizes state fingerprints.
- `ReplayValidator`: validates step expectations and final postconditions.
- `CartographerLogger`: emits live-run diagnostics to stderr.
- `CartographerRuntime`: narrow interface exposed to emitted CLIs.

### 4. Agent Uses Fallback When No Skill Fits

If no command directly fits:

```bash
node packages/cartographer/dist/cli.js fallback instagram.com --intent "task description"
```

This opens a local Chrome session and starts a deterministic fallback prompt:

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

Fallback creates a `FallbackTape` with deterministic session facts:

- `sessionId` and `recordingStartedAt`
- replayable `TapeStep[]`
- an operation log covering `goto`, `click`, `fill`, `text`, `screenshot`,
  and `record_step`
- screenshots/text evidence captured explicitly during the fallback
- selectors, selector diagnostics, arguments, validators, and write flags

Only `record-step` entries become replayable command steps. Earlier operations
are review context. This keeps capture deterministic while still giving the
reviewing agent enough session history to decide whether promotion is justified.

Use `fill-arg` when a real value should become a future CLI argument. It types
the real value into the browser but stores `%argName%` in the tape.

After `save-fallback`, the prompt prints a scoped review command. Running that
review is mandatory if fallback was used.

Current fallback implementation is Playwright-based because V1 does not assume
external API keys. `FallbackEngine` remains the future boundary for choosing an
optional Stagehand fallback in API-key environments, but local Playwright
fallback is the product default.

### 5. Agent Reviews The Fallback

After the user task is complete:

```bash
node packages/cartographer/dist/cli.js end-task-review instagram.com --since "<taskStartedAt>"
```

Scope review to a task start time when useful:

```bash
node packages/cartographer/dist/cli.js end-task-review instagram.com --since "2026-05-02T10:00:00.000Z"
```

Lower-level inspection:

```bash
node packages/cartographer/dist/cli.js review-fallbacks instagram.com
node packages/cartographer/dist/cli.js inspect-fallback instagram.com <fallback-id>
```

Review produces a compact packet and `REVIEW.md` with intent, steps, selectors,
validators, deterministic summary, operation log, evidence previews, and
promote/reject/apply-decision commands.

### 6. Agent Promotes Or Rejects

Normal workflow uses typed promotion decisions. Create the review artifacts:

```bash
node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>
```

The agent reads `review-request.json`, `decision-schema.json`, and `REVIEW.md`,
or starts from `decision-template.json`, then returns one flat
`PromotionDecision` JSON:

```json
{
  "action": "promote",
  "fallbackTapeId": "<fallback-id>",
  "reasoning": "Reusable navigation with stable final URL.",
  "confidence": "medium",
  "commandName": "open_example",
  "description": "open example page",
  "postconditions": [{ "type": "url_contains", "value": "/example" }]
}
```

Apply that decision through deterministic code:

```bash
node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>
```

Manual promotion remains available as an escape hatch:

```bash
node packages/cartographer/dist/cli.js promote-fallback instagram.com <fallback-id> \
  --command-name <snake_case> \
  --description "what this command actually does" \
  --postcondition url_contains:/path \
  --output visibleText:body:"visible text returned after replay"
```

`--output` is optional. Read skills should declare outputs when the task needs
data extraction.

`--postcondition` is optional only when the fallback already has useful final
validators. Promoted commands should have deterministic postconditions whenever
possible.

Reject or delete non-reusable fallbacks:

```bash
node packages/cartographer/dist/cli.js reject-fallback instagram.com <fallback-id> --reason "too specific"
node packages/cartographer/dist/cli.js delete-fallback instagram.com <fallback-id>
```

Promotion writes a new `ProcessTape`, regenerates the CLI, regenerates
`SKILL.md`, regenerates `manifest.json`, and marks the fallback as promoted.
`PromotionPolicy` gates the mutation before any process is written.
The apply result includes a top-level `agentContractDelta`, plus
`cliCommandName` and `reusableCommand.command`. A long-running agent should
treat `agentContractDelta` as an immediate patch to its working command list and
use that command for future matching tasks instead of falling back again.
The regenerated CLI also supports `instagram-com-cli --help` and
`instagram-com-cli <command> --help` with descriptions, args, outputs,
postconditions, and write flags.

## Current Interfaces

Core contracts live in:

```text
packages/cartographer/src/contracts.ts
```

Main interfaces:

- `CartographerRuntime`: run a named process.
- `RunProcessResult`: structured command result with execution,
  postconditions, drift, failure, outputs, and message.
- `ProcessTape`: persisted command contract.
- `Postcondition`: final success criteria, currently an alias of
  `StepValidator`.
- `FallbackOperation`: deterministic event recorded during fallback capture.
- `FallbackPromotionSummary`: deterministic review summary created from a
  fallback tape and evidence previews.
- `PromotionDecision`: typed agent reasoning output for promote/reject/delete.
- `PromotionDecisionApplier`: validates and applies the typed decision.
- `PromotionPolicy`: deterministic promotion gate.
- `Learning Debt`: obligation created by fallback use; closed by promotion,
  rejection, or deletion after review.
- `SkillRegistry`: preload and serve a site's process catalog in memory.
- `TapeStore`: load/save process tapes and catalogs.
- `BrowserSessionFactory`: create browser sessions.
- `BrowserSession`: navigate, act, read, screenshot, validate selectors.
- `StateIdentity`: capture a normalized state fingerprint.
- `StateActionCache`: structural state/atom action cache.
- `ReplayValidator`: validate URLs, selectors, and text.
- `BrowserFallbackRecorder`: record fallback browser operations.
- `FallbackEngine`: future boundary for Stagehand vs Playwright fallback.
- `ElementLocatorStrategy`: generate replay selectors.
- `SelectorPolicy`: pick the best selector candidate.
- `EvidenceStore`: write screenshots/text evidence.
- `FallbackTapeStore`: save, reject, delete, and mark fallback tapes.
- `FallbackReviewer`: produce review packets.
- `SkillPromoter`: turn reviewed fallback tapes into process tapes.
- `EndOfTaskReviewer`: run post-task fallback review and apply explicit
  decisions.
- `CliEmitter`: emit the per-site CLI.
- `emitSkillMd` and `emitSkillManifest`: emit agent contracts.

## Stagehand Boundary

Known skills store and replay Stagehand-shaped `Action[]`.
`BrowserSession.actRaw(action)` delegates to Stagehand `act(Action)`.

Stagehand cache is instruction-based. Cartographer cache is structural:

```text
(state_id, atom_id) -> Action[]
```

Raw Playwright fallback does not populate Stagehand's own cache. It records
Cartographer fallback tapes. Promotion turns those tapes into deterministic
Cartographer skills. Stagehand remains hidden behind `BrowserSession` for known
skill replay, while default fallback capture stays local and API-key-free.

## Verification Commands

```bash
pnpm --filter @cartographer/core typecheck
pnpm --filter @cartographer/core build
node packages/cartographer/dist/cli.js expose-skills instagram.com
~/.cartographer/bin/instagram-com-cli open-inbox --dry-run
```

Live read-only smoke:

```bash
CARTOGRAPHER_LOG_LEVEL=debug ~/.cartographer/bin/instagram-com-cli open-inbox
```

Recent smoke result:

```text
success:true
postconditions.required:true
postconditions.passed:true
drift.detected:false
```

## Current Gaps

- Browser lifecycle is still process-bound. The CLI closes Chrome after each
  run. A `--close-browser` or long-lived session model is still pending.
- Task envelopes are currently lightweight JSON responses, not persisted task
  records.
- `open-inbox` and `open-explore` are navigation-only. They have deterministic
  URL postconditions but no read outputs.
- Selector generation is deterministic but young.
- Existing old fallback tapes may not have operation logs or selector
  diagnostics. New Playwright fallback tapes do.
- Text evidence is explicit. If the operator does not run `text`, review will
  flag `no_text_evidence`.
- `FallbackEngine` exists as an interface, but only local Playwright fallback is
  implemented today. Stagehand fallback should stay optional because it needs
  external model/API configuration.
- There is no MCP emitter yet.
- There is no visual sitemap/graph viewer yet.

## What Not To Do

- Do not add hidden intent routing or fuzzy command matching inside
  Cartographer V1.
- Do not treat hash drift as command failure when final postconditions pass.
- Do not silently promote fallback tapes.
- Do not infer read outputs magically from evidence. Promotion should declare
  outputs explicitly with `--output`.
- Do not modify `packages/core/` unless there is a specific Stagehand
  integration reason.
- Do not treat write actions as normal reads. Writes require `--confirm-write`.

## Caution

Cartographer drives a real browser against real accounts. Treat writes as
high-risk. Keep fallback/promotion explicit, keep write confirmation mandatory,
and prefer read-only skills until the command contract is clear.

# Cartographer Architecture

Cartographer V1 is a tool-contract and skill-acquisition layer for browser
automation. It is intentionally small:

```text
agent reads SKILL.md / manifest.json
  -> agent starts a task envelope for unfamiliar/substantial tasks
  -> agent chooses a listed CLI command when one directly fits
  -> CLI executes that named command
  -> runtime validates final postconditions
  -> JSON result returns to agent

if no command fits or command fails:
  -> agent records local Playwright browser fallback
  -> fallback tape stores deterministic session facts and replayable steps
  -> fallback save creates learning debt and prints scoped review command
  -> user task completes
  -> agent reviews deterministic packet and reasons over promotion
  -> agent returns typed PromotionDecision JSON
  -> Cartographer validates and applies promote/reject/delete deterministically
  -> CLI, SKILL.md, and manifest.json regenerate after promotion
```

The design principle is interface-first. Cartographer provides stable contracts
and deterministic storage. The external agent controls tool selection and
promotion decisions. The CLI controls execution and command-level validation.

Domain terms are kept in `ubiquitous_language.md`. The most important product
term is learning debt: fallback recording creates an obligation to review the
tape and promote, reject, or delete it before the task is considered complete.

Logs are enabled by default for live runs. Logs go to stderr and command
results stay on stdout as JSON.

## Layer 1: Agent Contract

The agent-facing contract has two generated files:

```text
packages/cartographer/skills/instagram.com/SKILL.md
packages/cartographer/skills/instagram.com/manifest.json
~/.cartographer/sites/instagram.com/SKILL.md
~/.cartographer/sites/instagram.com/manifest.json
```

`SKILL.md` is readable operating guidance. `manifest.json` is the
machine-readable command contract.

The contract says:

- what commands exist
- how to run them
- whether they write to the platform
- what arguments each command accepts
- what outputs each command returns
- what final postconditions determine success
- how to interpret execution, postcondition, drift, and failure fields
- how to record fallback when no command fits
- how to inspect, promote, reject, or delete fallback tapes
- that fallback-created learning debt must be closed through end-of-task review

There is no hidden natural-language router in V1. The agent reads the contract
and decides whether a listed command directly fits.

Current local Instagram commands:

```text
open-explore
open-inbox
send-message
send-test-dm
```

`open-explore` was acquired through fallback promotion.

Current lifecycle support:

```text
begin-task: implemented as a lightweight JSON envelope
fallback save: prints scoped end-task-review and promotion-review commands
learning debt: represented in SKILL.md, manifest.json, handoff, architecture,
and ubiquitous_language.md
promotion review: emits review-request.json, decision-schema.json, and REVIEW.md
promotion application: PromotionDecisionApplier validates typed agent decisions
```

## Layer 2: Emitted CLI

`CliEmitter` emits:

```text
~/.cartographer/bin/instagram-com-cli
```

The emitted CLI is thin. It parses args and calls:

```text
createPreloadedRuntime(domain)
  -> SkillRegistry.preload(domain)
  -> CartographerRuntime.runProcess()
```

It does not decide whether a command is semantically appropriate. That is the
agent's job.

For substantial tasks, the agent can create a lightweight task envelope:

```bash
node packages/cartographer/dist/cli.js begin-task instagram.com --intent "task description"
```

This returns `taskStartedAt`, a fallback command, and a scoped required review
command. The task envelope is currently a JSON convenience, not a persisted task
record.

## Layer 3: Process Contract

The persisted command unit is `ProcessTape`.

Important fields:

```ts
interface ProcessTape {
  name: ProcessName;
  description: string;
  domain: Domain;
  entry: State;
  steps: TapeStep[];
  args: ProcessArg[];
  outputs?: ProcessOutput[];
  postconditions?: Postcondition[];
  writesToPlatform: boolean;
  createdAt: string;
  updatedAt: string;
}
```

`postconditions` are the deterministic final success contract. They currently
reuse `StepValidator`:

```ts
{ type: "url_equals"; value: string }
{ type: "url_contains"; value: string }
{ type: "selector_exists"; selector: string }
{ type: "text_contains"; selector: string; value: string }
```

Postconditions are process-level. Step validators still exist, but they are
used for drift diagnostics rather than final command success.

## Layer 4: Process Runtime

`ProcessTapeRuntime` is the replay engine.

Happy path:

```text
runProcess(domain, processName, args)
  -> SkillRegistry.getProcess(domain, processName)
  -> reject write command without --confirm-write
  -> BrowserSessionFactory.launchInstagram()
  -> goto process.entry.url
  -> for each TapeStep:
       StateActionCache.get(state_id, atom_id)
       BrowserSession.goto(url) or BrowserSession.actRaw(Action)
       StateIdentity.capture()
       ReplayValidator.validate(step.validators)
       record drift diagnostics
  -> ReplayValidator.validate(process.postconditions)
  -> read declared ProcessOutput selectors
  -> return RunProcessResult JSON
```

Command success is:

```text
success = actionFailures.length === 0 && postconditions.passed
```

Hash drift does not fail a command by itself. Drift is returned as diagnostic
context:

```json
{
  "drift": {
    "detected": true,
    "severity": "warning",
    "steps": []
  }
}
```

Primary interfaces:

- `CartographerRuntime`: one method, `runProcess`.
- `RunProcessResult`: structured command result.
- `SkillRegistry`: preloaded in-memory process lookup.
- `TapeStore`: process tape persistence behind the registry.
- `BrowserSessionFactory`: browser construction.
- `BrowserSession`: browser actions and reads.
- `StateActionCache`: structural action cache.
- `StateIdentity`: normalized state fingerprinting.
- `ReplayValidator`: URL, selector, and text checks.
- `CartographerLogger`: live-run diagnostics.

## Layer 5: Run Result Shape

Every command returns JSON on stdout. Logs go to stderr.

Important result fields:

```ts
interface RunProcessResult {
  success: boolean;
  processName: ProcessName;
  executedStepIds: StepId[];
  driftedStepIds: StepId[];
  outputs?: Record<string, string>;
  execution?: RunExecutionResult;
  postconditions?: PostconditionResult;
  drift?: DriftReport;
  failure?: RunFailure;
  message: string;
}
```

Interpretation:

- `success:true`: actions completed and final postconditions passed.
- `success:false`: action execution failed or final postconditions failed.
- `execution.actionFailures`: mechanical action failures.
- `postconditions.checks`: final success checks and observed values.
- `drift.steps`: fingerprint/step-validator diagnostics.
- `outputs`: declared read outputs.

## Layer 6: Browser Session

`BrowserSession` hides Stagehand/browser details:

```ts
currentUrl()
goto(url)
observe(instruction)
act(candidate)
actRaw(action)
exists(selector)
readText(selector)
screenshot(label)
waitForUser(label)
close()
```

Current implementation:

```text
StagehandBrowserSession
```

Known process replay uses Stagehand-shaped `Action[]` through
`BrowserSession.actRaw(action)`.

### Stagehand is configured in noLlm mode

`StagehandBrowserSessionFactory.launchInstagram` constructs Stagehand with
two flags that lock the runtime hot path to deterministic replay:

```ts
new Stagehand({
  env: "LOCAL",
  selfHeal: false,   // selector misses fail loudly, no LLM re-resolution
  noLlm: true,       // skip API key load + LLM client construction
  localBrowserLaunchOptions: {
    userDataDir: <cacheDir>/chrome-profile,
    preserveUserDataDir: true,   // keeps IG session cookies between runs
    ...
  },
});
```

`noLlm: true` is a fork-local Stagehand option (see `apply-nollm-patch.mjs`).
With it set, Stagehand's constructor skips `loadApiKeyFromEnv` entirely and
`this.llmClient` stays unassigned. `act(Action)` deterministic replay still
works because `takeDeterministicAction` only invokes the client during
self-heal, which is gated by `selfHeal: true`.

Cartographer therefore needs **no `OPENAI_API_KEY` (or any provider key)**
for the runtime hot path. Methods that would invoke an LLM —
`act(string)`, `observe()`, `agent()`, self-heal — throw a clear error if
called. Pure replay paths produce zero LLM calls, confirmed in live runs by
the `noLlm:true` log line on init and `cacheHit: true, actionCount: 1` on
each step.

### Stagehand methods cartographer actually calls

Of Stagehand's public surface, the runtime uses only:

- `new Stagehand(opts)` + `stagehand.init()` — once per CLI command.
- `stagehand.context.pages()[0]` — get the active Page.
- `stagehand.act(action, {variables})` — `act(Action)` overload, no LLM.
- `page.goto(url)` (via Stagehand's understudy Page) — for `navigate` steps.
- `stagehand.close()` — once per CLI command.

`stagehand.observe(instruction)` is wired in `BrowserSession.observe()` for
fallback/teach paths but **must not fire during runtime replay**. With
`noLlm: true`, accidental invocation throws.

What this gets cartographer for free, beyond raw Playwright:

- Chrome launch + CDP attach + persistent profile management (`launch/local.ts`)
- `V3Context` + frame registry + iframe traversal
- Stagehand's `Locator` engine with shadow-DOM piercing
- `resolveLocatorWithHops` — iframe-aware XPath traversal (`iframe#x >> #btn`
  and deep XPath `/html/body/iframe[1]/...` are split at iframe boundaries
  automatically)
- `performUnderstudyMethod` dispatcher (`click`, `fill`, `type`, `press`,
  `scroll`, `hover`, `selectOption`, etc.) backed by raw CDP
- `lifecycleWatcher` + `networkManager` for "page settled" detection

Net: ~2,400 LOC of browser/CDP infrastructure that cartographer does not
have to write or maintain. As Stagehand evolves the substrate, cartographer
inherits the upgrades.

## Layer 7: Validation And Drift

`ReplayValidator` validates:

- `url_equals`
- `url_contains`
- `selector_exists`
- `text_contains`

There are two validation scopes:

1. Step validators: run after each step. Failures contribute to drift reports.
2. Process postconditions: run once after all steps. These decide command
   success.

`StateIdentity` captures a fingerprint from normalized URL shape, state kind,
and observed atom IDs. The runtime normalizes old and new URL shapes before
comparing fingerprints so harmless protocol-format differences do not trigger
drift.

## Layer 8: Fallback Recording

Fallback is explicit. The agent enters fallback when no listed command directly
fits, or when an invoked command fails and the task can still be completed.

```bash
node packages/cartographer/dist/cli.js fallback instagram.com --intent "task"
```

Current implementation:

```text
PlaywrightFallbackRecorder
```

It records:

- deterministic fallback operations
- replayable browser steps
- Stagehand-shaped `Action[]` for promoted replay
- before/after state snapshots
- screenshots and text evidence when explicitly requested
- arguments
- write flags
- validators where available
- selector diagnostics where available

`FallbackTape` now separates two concepts:

- `operations`: chronological session facts such as `goto`, `click`, `fill`,
  `text`, `screenshot`, and `record_step`.
- `steps`: replayable `TapeStep[]` selected by explicit `record-step`.

This separation matters because not every browser operation should become a
CLI skill step. The operation log gives the reviewing agent context, while
promotion only replays recorded steps.

Fallback prompt:

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

`fill-arg` is the safe parameterization path. It types the real value into the
browser but stores `%argName%` in the replay action, allowing promotion to
declare a required CLI argument without leaking a one-off literal into the
future skill.

Primary interfaces:

- `BrowserFallbackRecorder`
- `FallbackEngine`
- `ElementLocatorStrategy`
- `SelectorPolicy`
- `EvidenceStore`
- `FallbackTapeStore`

`FallbackEngine` is the future boundary for choosing fallback implementations.
Today only local Playwright fallback is implemented because V1 does not assume
external API keys. A Stagehand-backed fallback can be added later for
environments that already provide model/API configuration, but it should not be
the default product path.

Fallback recording is still part of task execution. Learning from fallback is
not. The user task should finish first, then learning debt must be closed by
end-of-task review.

## Layer 9: Selector Generation

`ElementLocatorStrategy` converts a selector used during fallback into a
selector suitable for replay.

Current policy:

1. If the agent provides XPath, preserve it.
2. Generate candidates from stable attributes:
   `id`, `data-testid`, `aria-label`, `name`, `placeholder`, `title`, `role`.
3. Generate short normalized text XPath when useful.
4. Count matches for each candidate.
5. `SelectorPolicy` chooses the strongest unique candidate.
6. Absolute XPath is kept as the last fallback.

Absolute XPath is brittle because it depends on full DOM position. Relative
XPath is better when anchored to a stable attribute or visible text.

Selector quality is surfaced, not hidden. New fallback steps carry
`selectorDiagnostics` with the selected selector, selector kind, stability,
reason, optional match count, and alternatives when available. Review summaries
derive deterministic warnings such as `absolute_xpath`, `body_selector`,
`weak_selected_selector`, and `non_unique_selected_selector`.

## Layer 10: Evidence And Review

`EvidenceStore` writes screenshots and text artifacts.

`FallbackReviewer` turns fallback tapes into review packets and `REVIEW.md`
files. The packet gives the agent enough information to decide:

- promote this into a reusable command
- reject it as too specific
- delete it

Review packets include a deterministic `fallbackSummary`:

- session id and recording timestamps
- entry/final URL
- step count and operation count
- operation log
- step action summaries
- selector diagnostics and warnings
- suggested deterministic postconditions
- risk flags such as `no_text_evidence`, `steps_missing_validators`,
  `has_absolute_xpath`, and `operation_log_has_unrecorded_context`

These fields are derived by code. They are not inferred by the agent.

End-of-task review is the orchestration layer:

```text
EndOfTaskReviewer.reviewCompletedTask()
  -> FallbackReviewer.review()
  -> optional explicit promote/reject/delete decisions
  -> SkillPromoter.promote() for promote decisions
```

It should run after the user task is complete. It must not silently promote
anything.

If fallback was used, review is required. Each reviewed fallback should receive
one explicit decision:

- promote reusable generic behavior
- reject brittle, unsafe, or task-specific behavior
- delete retained noise

The agent's reasoning boundary is typed:

```text
review-request.json + decision-schema.json + decision-template.json + REVIEW.md
  -> agent returns PromotionDecision JSON
  -> PromotionDecisionApplier normalizes and validates the decision
  -> PromotionPolicy gates promotion
  -> deterministic mutation happens in code
```

This is the MCP sampling-style pattern Cartographer is using in V1 without
shipping an MCP server yet: the harness asks the agent for judgment, then code
applies only schema-checked decisions.

## Layer 11: Promotion

`SkillPromoter` turns a reviewed fallback into a process:

```text
FallbackTape
  -> PromotionDecision
  -> PromotionPolicy
  -> ProcessTape
  -> emitted CLI
  -> regenerated SKILL.md
  -> regenerated manifest.json
```

Promotion requires, through policy:

- explicit command name
- explicit description
- unique snake_case command identity
- succeeded, unpromoted fallback tape
- nonempty replayable steps
- correct write protection
- explicit deterministic postconditions for write-capable commands
- declared runtime placeholders
- valid declared outputs when outputs are supplied

Normal promotion workflow:

```bash
node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>
node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>
```

Manual promotion command, kept as an escape hatch:

```bash
node packages/cartographer/dist/cli.js promote-fallback instagram.com <fallback-id> \
  --command-name <snake_case> \
  --description "what this command actually does" \
  --postcondition url_contains:/path \
  --output visibleText:body:"visible text returned after replay"
```

If no explicit postcondition is passed, promotion falls back to useful final
validators from the fallback tape when present.

Read skills should declare outputs:

```bash
--output visibleText:body:"visible text returned after replay"
```

This prevents Cartographer from guessing what the agent wants.

The important boundary: the agent decides whether the fallback is reusable and
what command contract it deserves. Cartographer decides whether that proposal is
valid and performs all writes.

After successful promotion, the result includes a reuse pointer:

```text
agentContractDelta
cliCommandName
reusableCommand.command
reusableCommand.dryRunCommand
reusableCommand.skillPath
reusableCommand.manifestPath
```

This closes the loop for agents: the acquired skill is immediately present in
the regenerated CLI and contract, and the apply result tells the agent the exact
command to use next time. `agentContractDelta` is the in-context patch for
long-running agents that have not reread the regenerated `SKILL.md`.

The emitted CLI also exposes discovery metadata:

```bash
instagram-com-cli --help
instagram-com-cli <command> --help
```

Top-level help lists command descriptions and write flags. Command-specific
help lists args, outputs, and postconditions.

## Layer 12: Generated Manifest

`emitSkillManifest()` writes:

```text
manifest.json
```

Current manifest shape:

```json
{
  "schemaVersion": 1,
  "domain": "instagram.com",
  "agentContract": {
    "toolSelection": "agent-controlled",
    "commandExecution": "cli-controlled",
    "successRule": "success is true only when actions complete and final postconditions pass",
    "driftRule": "hash drift is diagnostic and does not fail a command by itself",
    "fallbackRule": "use fallback recording when no listed command fits or an invoked command fails",
    "learningRule": "if fallback is used, end-task review is required and every reusable fallback should be promoted into a CLI command"
  },
  "taskLifecycle": {
    "fallbackCreatesLearningDebt": true,
    "closeoutRequiredWhenFallbackUsed": true
  },
  "commands": []
}
```

Each command entry includes name, process name, args, outputs, postconditions,
write flag, success policy, and failure fields.

## Layer 13: Logging

`CartographerLogger` is intentionally small:

```ts
log(level, event, context)
```

Current implementation:

```text
ConsoleCartographerLogger
```

It writes compact structured log lines to stderr:

```text
[cartographer] info runtime.start {"domain":"instagram.com","processName":"open_inbox"}
```

Default behavior:

- enabled unless `CARTOGRAPHER_LOG=0`
- default level is `info`
- use `CARTOGRAPHER_LOG_LEVEL=debug` for cache/action details
- stdout remains reserved for JSON command results

Logged areas:

- registry preload/refresh
- runtime start/dry-run/step/cache/drift/postconditions/output/done
- fallback review
- end-of-task review
- skill promotion

## Storage Model

Runtime-local state lives under:

```text
~/.cartographer/
```

Important folders:

```text
~/.cartographer/bin/
~/.cartographer/sites/instagram.com/
~/.cartographer/sites/instagram.com/tapes/
~/.cartographer/sites/instagram.com/skills/
~/.cartographer/sites/instagram.com/fallbacks/
~/.cartographer/sites/instagram.com/evidence/
~/.cartographer/sites/instagram.com/promotions/
~/.cartographer/sites/instagram.com/state-action-cache/
```

Repo-exposed contracts live at:

```text
packages/cartographer/skills/instagram.com/SKILL.md
packages/cartographer/skills/instagram.com/manifest.json
```

JSON files are enough for V1. SQLite can wait until lookup volume, concurrent
writes, or query complexity makes file storage painful.

## Stagehand Cache Versus Cartographer Cache

Stagehand cache (`ActCache`, `AgentCache`):

- keyed by instruction, URL, variables, and config
- populated by successful `act("...")` and `agent.execute(...)` calls
- useful for Stagehand natural-language actions

**Cartographer does not use Stagehand's cache at all.** With `noLlm: true`
the actCache/agentCache callbacks throw if invoked, but they're never
consulted because `act(Action)` skips the cache path entirely (it routes
straight to `takeDeterministicAction`).

Cartographer cache (`StateActionCache`):

- keyed structurally by `(state_id, atom_id)`
- stores replayable Stagehand-shaped `Action[]`
- used by named process tapes
- benefits from cross-process edge reuse — different Processes traversing
  the same `(from_state → atom → to_state)` triple share a single entry

Raw Playwright fallback does not populate Stagehand cache. It records
Cartographer fallback tapes. Promotion turns those tapes into deterministic
Cartographer skills.

Stagehand remains the runtime substrate for known-skill replay because
process tapes store Stagehand-shaped `Action[]`. It is not the default
fallback recorder because that would require external model/API setup.
The V1 acquisition path works locally with Playwright; the V1 replay path
works locally with Stagehand in `noLlm: true` mode.

## Current Happy Path Example

Task:

```text
Open Instagram Inbox.
```

Live-verified path (smoke 2026-05-03):

1. Agent reads `SKILL.md` or `manifest.json`.
2. Agent sees `open-inbox`.
3. Agent runs:

   ```bash
   ~/.cartographer/bin/instagram-com-cli open-inbox
   ```

4. CLI calls `createPreloadedRuntime` → `ProcessTapeRuntime`.
5. `StagehandBrowserSessionFactory.launchInstagram` constructs Stagehand
   with `noLlm:true`, `selfHeal:false`. Init log:
   `noLlm:true — LLM-dependent methods will throw if invoked. Deterministic act(Action) replay works.`
6. Runtime replays the saved 2-step process (`goto-inbox`, `open_inbox`).
   Both steps log `cacheHit: true, actionCount: 1`. Zero LLM calls.
7. Browser ends at `https://www.instagram.com/direct/inbox/`. Login
   persisted from prior session via `userDataDir + preserveUserDataDir`.
8. Final postcondition `url_contains:/direct/inbox` passes against observed
   URL. `drift.detected: false`.
9. Agent receives `success:true`.

Verified result:

```json
{
  "success": true,
  "processName": "open_inbox",
  "executedStepIds": ["34dea10a09d1...", "21cdea9ae864..."],
  "driftedStepIds": [],
  "outputs": {},
  "execution": {
    "completed": true,
    "stepCount": 2,
    "executedStepCount": 2,
    "actionFailures": []
  },
  "postconditions": {
    "required": true,
    "passed": true,
    "checks": [{
      "type": "url_contains",
      "passed": true,
      "expected": "/direct/inbox",
      "observed": "https://www.instagram.com/direct/inbox/"
    }]
  },
  "drift": { "detected": false, "severity": "none", "steps": [] },
  "message": "Replayed 2 step(s); postconditions passed."
}
```

This run validates the full architectural claim end-to-end:

- Stagehand initialized with no API key
- StateActionCache hit on every step
- Login persisted via Stagehand's user data dir
- Postconditions decided success (drift was diagnostic only)
- JSON contract returned cleanly on stdout

The other listed read command (`open-explore`) follows the same pattern.
Write commands (`send-message`, `send-test-dm`) are gated behind
`--confirm-write` and have a known postcondition tightening pending
(see "What Comes Next").

## What Comes Next

Best next steps, ordered by leverage:

1. **Tighten write postconditions.** `send-message` / `send-test-dm`
   currently use `text_contains: body, %message%` which passes the moment
   the message text appears anywhere in the page body — including the
   compose textarea before the send button is clicked. This is a
   false-positive trap for silent send failures (rate limits, blocks). Scope
   the postcondition to a selector inside the rendered conversation thread,
   not the page body. Re-promote affected tapes after fixing.
2. **Add browser lifecycle control:** `--close-browser` / `--keep-alive`
   or a long-lived session model. Current runtime closes Chrome after each
   CLI run. Cheap commands feel slow because each one boots Chrome.
3. **Persist task envelopes** so learning debt can be listed and enforced.
4. **Create real read skills with explicit outputs**, not just navigation
   skills. `view_profile`, `list_recent_posts`, `read_post_detail` would
   produce structured `outputs` blocks instead of empty objects.
5. **Improve default Playwright fallback** with automatic text evidence
   prompts and stronger selector repair.
6. **Add richer fallback commands** for search/profile browsing workflows.
7. **Add richer dry-run/replay plans.**
8. **Add MCP emitter** after the CLI contract stabilizes.
9. **Add compact page inspection** only as supporting observability, not as
   the core success model.

Login persistence is no longer pending — Stagehand's
`localBrowserLaunchOptions.userDataDir + preserveUserDataDir: true` keeps
Instagram session cookies between CLI runs. Verified in the 2026-05-03
smoke.

The immediate product win is better command contracts: clear args, outputs,
postconditions, and failure packets.

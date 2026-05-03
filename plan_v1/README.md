# Cartographer v1 Plan — Instagram Manual Teach to CLI Emitter

## Goal

Build the narrow v1 tracer bullet for Cartographer on top of this Stagehand
fork. Per [`DECISION.md`](./DECISION.md), v1 is **CLI-emitter first**, not
graph-first:

1. Launch a real Chrome session through Stagehand.
2. Let the user log in to Instagram manually.
3. Record a small set of user-demonstrated Instagram transitions:
   - profile navigation
   - opening posts
   - opening messages
   - sending a DM
   - following someone
   - messaging that person
4. Persist each taught flow as a named `ProcessTape`.
5. Store deterministic replay actions in a structural action cache.
6. Emit an Instagram CLI where each named process is a subcommand.

The point is not full proactive exploration yet. The point is to prove that a
taught process can be replayed and packaged as a CLI command.

This v1 should be built **interface first**. Define the domain contracts,
runtime contracts, and CLI-facing commands before filling in implementation
details. Implementations can change; the interfaces are the product surface we
need to understand and validate.

## Non-Goals

- No autonomous Instagram exploration in v1.
- No LLM-generated process names.
- No MCP emitter yet.
- No viewer yet.
- No graph/path-planning dependency yet.
- No bulk campaign sender yet.
- No bypassing platform limits, captchas, or account protections.
- No hidden/automatic send behavior. Any write action such as follow or DM must
  come from a user-demonstrated flow and remain visibly auditable.

## Core Bet

Stagehand already exposes the two primitives this v1 needs:

- `stagehand.observe(...)` returns cacheable `Action[]`.
- `stagehand.act(action)` executes an `Action` through deterministic replay when
  possible.

So v1 should avoid reaching into `ActHandler.takeDeterministicAction` directly.
If `act(action)` works for recorded actions, that is the stable replay API.
Deep imports are allowed only behind a small adapter if we later need snapshot
data that public APIs do not expose.

## Proposed Package Layout

Add these packages to `pnpm-workspace.yaml` only when implementation starts:

```text
packages/
  cartographer/
    src/
      instagram-teach.ts
      manual-recorder.ts
      state-identity/
  tapes/
  cache/
  runtime/
  emitters/
    src/
      cli-emitter.ts
      templates/
```

For the first pass, keep everything in `packages/cartographer` if that is
faster. Split `emitters` only once a working tape can replay.

The implementation should be organized around the interfaces in
[`INTERFACES.md`](./INTERFACES.md). Each module should depend on those contracts
instead of reaching into neighboring implementation details.

## v1 Data Model

### Atom

Derived from a Stagehand `Action`.

```ts
type Atom = {
  id: AtomId;
  role?: string;
  accessibleName: string;
  description: string;
  selector: string;
  method?: string;
  xpathShape: string;
  surfaceContext?: string;
};
```

`AtomId` should start as:

```text
sha256(domain + state_kind + surface_context + accessible_name + method + xpath_shape)
```

This is intentionally stronger than the earlier
`role + accessible_name + xpath_shape` formula because Instagram repeats
actions like Follow, Message, Like, and Send across cards, posts, profiles, and
modals.

### State

```ts
type State = {
  id: StateId;
  domain: "instagram.com";
  url: string;
  kind: "page" | "modal" | "panel" | "list" | "form" | "thread" | "unknown";
  fingerprint: StateFingerprint;
  atoms: Atom[];
  observedAt: string;
};
```

`StateId` should be produced from a canonical atom-set, but v1 should store the
full fingerprint beside it so we can debug instability.

```ts
type StateFingerprint = {
  hash: string;
  atomIds: AtomId[];
  urlShape: string;
  title?: string;
  atomCount: number;
};
```

### TapeStep

```ts
type TapeStep = {
  id: StepId;
  type: "click" | "fill" | "submit" | "navigate";
  before: State;
  after: State;
  atomId: AtomId;
  instruction: string;
  actions: Action[];
  validationHash: string;
  writesToPlatform: boolean;
  createdAt: string;
};
```

For v1, do not discard steps whose broad state hash does not change.
Instagram often reveals UI inside the same URL or surface. Mark these with
same-hash before/after checkpoints only after recording a visible UI/evidence
delta.

### ProcessTape

```ts
type ProcessTape = {
  name: string;
  description: string;
  entry: State;
  steps: TapeStep[];
  args: ProcessArg[];
  writesToPlatform: boolean;
};
```

Initial hand-authored process names:

- `open_profile`
- `open_recent_post`
- `open_messages`
- `send_dm`
- `follow_profile`
- `message_profile_after_follow`

## Recording Strategy

Use a manual teach loop rather than autonomous exploration.

The recorder launches Stagehand, opens Instagram, and waits for user commands
in the terminal. The user performs navigation in the browser. At each checkpoint,
the user tells the recorder what just happened or what should be captured next.

### Stagehand Launch

Default to local Chrome:

```ts
const stagehand = new Stagehand({
  env: "LOCAL",
  verbose: 2,
  cacheDir: ".cartographer-stagehand-cache",
  localBrowserLaunchOptions: {
    viewport: { width: 1288, height: 900 },
    deviceScaleFactor: 1,
  },
});

await stagehand.init();
const page = stagehand.context.pages()[0];
await page.goto("https://www.instagram.com/");
```

Browserbase can be a later option if local Instagram login becomes unreliable.

### Manual Checkpoints

The CLI should support:

```text
cartographer teach instagram
  snapshot <label>
  observe <instruction>
  act <observed-action-index>
  record-step <name>
  name-process <process-name> --from <state-label> --to <state-label>
  save
```

For the first implementation, this can be an interactive prompt:

```text
[s] snapshot current state
[o] observe candidate actions
[a] act one observed action
[e] record last action as step
[p] name process from selected steps
[q] save and quit
```

### Demonstration Flow

1. Launch `cartographer teach instagram`.
2. Stagehand opens Chrome at `https://www.instagram.com/`.
3. User logs in manually.
4. User navigates to their own profile.
5. Recorder captures `profile_home`.
6. User/recorder observes and records opening one or more posts.
7. User navigates to messages.
8. Recorder captures `messages_home`.
9. User demonstrates sending a DM to a safe test/consenting recipient.
10. Recorder records the DM operation as `writesToPlatform: true`.
11. User navigates to a safe target profile.
12. User demonstrates follow.
13. Recorder records follow as `writesToPlatform: true`.
14. User demonstrates message-after-follow to the same safe target.
15. Recorder saves process tapes.

## Important Safety Rule for This v1

Use a test account and consenting/test recipients for DM/follow operations.

For write operations, the emitted CLI should default to dry-run unless passed:

```text
--confirm-write
```

For `send_dm`, require the message as an argument and echo a final confirmation
before the Stagehand action is performed:

```text
instagram-com-cli send-dm --recipient alice --message "..." --confirm-write
```

## Structural Action Cache

Cache key:

```text
sha256(domain + before_state_id + atom_id)
```

Cache entry:

```ts
type StateActionCacheEntry = {
  version: 1;
  domain: "instagram.com";
  beforeStateId: StateId;
  afterStateId: StateId;
  atomId: AtomId;
  instruction: string;
  actions: Action[];
  validationHash: string;
  writesToPlatform: boolean;
  updatedAt: string;
};
```

Replay algorithm:

1. Compute current state fingerprint.
2. Confirm it is compatible with the tape entry checkpoint.
3. For each tape step:
   - load cache entry by `(before_state_id, atom_id)`
   - execute each cached `Action` with `stagehand.act(action)`
   - snapshot/fingerprint resulting state
   - compare to `validationHash`
4. On mismatch:
   - mark drift
   - do not auto-self-heal write actions
   - for read-only actions, optionally call `stagehand.act(operation.instruction)`
     and write back if it lands in the expected state

## CLI Emitter Scope

Input:

```text
~/.cartographer/sites/instagram.com/tapes/*.json
```

Output:

```text
~/.cartographer/bin/instagram-com-cli
```

Generated commands:

```text
instagram-com-cli open-profile
instagram-com-cli open-recent-post --index 1
instagram-com-cli open-messages
instagram-com-cli send-dm --recipient <handle> --message <text> --confirm-write
instagram-com-cli follow-profile --handle <handle> --confirm-write
instagram-com-cli message-profile-after-follow --handle <handle> --message <text> --confirm-write
```

The first emitted CLI can be a Node script using Commander. It should import the
Cartographer runtime from the workspace rather than embedding all runtime code.

## Milestones

### M0 — Repo Setup

- Add `packages/cartographer`.
- Add it to `pnpm-workspace.yaml`.
- Add TypeScript config matching the repo style.
- Depend on `@browserbasehq/stagehand` via `workspace:*`.

Exit criterion: `pnpm --filter @cartographer/core build` passes.

### M1 — Stagehand Instagram Launcher

- Implement `cartographer teach instagram`.
- Launch local Chrome through Stagehand.
- Navigate to Instagram.
- Keep process alive while user logs in manually.
- Provide terminal command to snapshot the current page.

Exit criterion: user can log in, move around Instagram, and save a raw snapshot
artifact.

### M2 — State Identity Spike

- Implement `observeAllInteractive()` using `stagehand.observe(...)`.
- Implement `canonicalizeActionsToAtoms()`.
- Implement `fingerprintState()`.
- Capture the same Instagram profile/messages state twice.

Exit criterion: same logical state produces the same hash twice, or the diff
explains exactly what must be filtered.

### M3 — Manual Tape Recorder

- Add `observe <instruction>`.
- Let user select one observed action.
- Execute with `stagehand.act(action)`.
- Snapshot before and after.
- Persist a `TapeStep`.

Exit criterion: one profile/post/messages step records with before/after
checkpoints and cached actions.

### M4 — StateActionCache

- Implement read/write cache entries by `(before_state_id, atom_id)`.
- Store tape-step actions into the cache.
- Replay one recorded step from cache using `stagehand.act(action)`.

Exit criterion: replay performs with no new `observe()` call for that step.

### M5 — Runtime Tape Replay

- Implement `runProcess(name, args)` as sequential tape replay.
- Support dry-run and write confirmation checks.

Exit criterion: a hand-named `open_messages` process tape replays from its
recorded entry checkpoint.

### M6 — CLI Emitter

- Implement `emit-cli instagram.com`.
- Generate Commander subcommands from hand-authored process tapes.
- Bundle or write a runnable Node script.

Exit criterion: `instagram-com-cli open-messages` loads a process tape and
replays it.

### M7 — Instagram Write Flow Validation

- Record `send_dm`, `follow_profile`, and `message_profile_after_follow` using
safe test targets.
- Ensure all write processes require `--confirm-write`.
- Ensure replay logs every write action to an audit file.

Exit criterion: CLI can perform the taught write flow only with explicit
confirmation flags.

## Files to Produce During v1

```text
~/.cartographer/
  sites/
    instagram.com/
      tapes/
        <process-name>.json
      state-action-cache/
        <cache-key>.json
      evidence/
        <timestamp>-<label>.png
      audit.jsonl
  bin/
    instagram-com-cli
```

Inside the repo:

```text
packages/cartographer/src/
  cli.ts
  instagram-teach.ts
  manual-recorder.ts
  state-identity/canonicalize.ts
  state-identity/fingerprint.ts
  tapes/schema.ts
  tapes/store.ts
  cache/state-action-cache.ts
  runtime/run-process.ts
  emitters/cli-emitter.ts
```

## Open Questions Before Execution

1. Which Instagram account should be used: a test account or your real account?
   Strong recommendation: test account for the first write-flow validation.
2. Who is the safe DM/follow target for the first run?
3. Should the first Chrome session use local Chrome only, or should we allow a
   Browserbase fallback if login or session persistence is painful?
4. For messages, should v1 parameterize the message text, recipient, or both?
   Recommendation: parameterize message text first, keep recipient path
   hand-taught until repeated-recipient selection is reliable.

## Implementation Notes From Current Repo

- The workspace currently includes only upstream packages in
  `pnpm-workspace.yaml`; Cartographer packages must be added.
- `Stagehand` is exported from `packages/core/lib/v3/index.ts`.
- Local Chrome launch is supported by `env: "LOCAL"` and
  `localBrowserLaunchOptions`.
- `stagehand.act(action)` already routes deterministic `Action` replay through
  the internal act handler.
- Stagehand `cacheDir` exists, but Cartographer should maintain its own
  structural cache rather than rely on Stagehand's instruction-keyed cache.

## Recommended First Coding Order

1. Create `packages/cartographer` skeleton and write `src/contracts.ts`.
2. Add compile-only stubs for each interface in `INTERFACES.md`.
3. Implement local Stagehand launch and manual login pause behind
   `BrowserSession`.
4. Implement snapshot/fingerprint JSON writes behind `StateIdentity`.
5. Run the state stability spike on Instagram profile and messages.
6. Implement manual observe/select/act recording behind `ManualRecorder`.
7. Implement tape persistence and one hand-authored process behind
   `TapeStore`.
8. Implement structural cache replay behind `StateActionCache`.
9. Emit the first `instagram-com-cli` behind `CliEmitter`.

Stop after step 4 if state identity is unstable in a way we cannot normalize.
That is the only load-bearing risk worth resolving before building the rest.

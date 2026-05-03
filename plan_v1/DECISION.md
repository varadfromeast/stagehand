# Decision — Narrow v1 to CLI Emitter

## Decision

For v1, Cartographer should **not** be graph-first.

Build the CLI emitter around recorded named processes first. A visual sitemap or
graph can be generated later as a derived artifact from successful process
recordings, but it should not be a dependency of v1 replay.

## Why

The Instagram flow is not a clean graph-discovery problem yet. It is a
stateful, authenticated, user-specific workflow with repeated surfaces:

- many buttons have the same names (`Message`, `Follow`, `Send`, `Like`)
- URLs do not fully identify state
- modals and panels often change without meaningful URL changes
- feed/profile/thread content changes constantly
- write actions require much stricter safety than read actions
- a manually taught run produces a sparse graph, not a useful sitemap

A graph would be visually appealing, but in v1 it risks becoming a misleading
abstraction. The real proof is simpler:

1. Teach a named process.
2. Persist its deterministic Stagehand actions.
3. Replay it from a known entry surface.
4. Emit a CLI command for it.

If this works, graphing can come later as a visualization of known processes.

## Revised v1 Shape

Use a `ProcessTape` as the source of truth.

```ts
type ProcessTape = {
  name: string;
  domain: "instagram.com";
  entry: StateCheckpoint;
  steps: TapeStep[];
  args: ProcessArg[];
  writesToPlatform: boolean;
};
```

Each `TapeStep` stores:

- the user-facing instruction
- the observed Stagehand `Action[]`
- a before checkpoint
- an after checkpoint
- whether it writes to the platform
- optional runtime argument bindings

This is still compatible with a future graph. A graph can be derived by treating
each checkpoint as a node and each tape step as an edge. But v1 does not need
path planning, clustering, or graph exploration.

## What Stays

- Interface-first implementation.
- Stagehand launches local Chrome.
- Manual login/session setup.
- Manual teaching loop.
- Structural action cache.
- CLI emitter.
- Explicit confirmation for write actions.

## What Moves Later

- Proactive exploration.
- BFS path planning across independently discovered states.
- 2D/3D graph viewer.
- GitNexus-inspired visual sitemap.
- MCP emitter.
- Campaigns.

## Revised Milestone Order

1. `contracts.ts`: define stable interfaces.
2. `BrowserSession`: Stagehand local Chrome wrapper.
3. `ProcessTapeRecorder`: manual observe/select/act recorder.
4. `TapeStore`: JSON persistence under `~/.cartographer/sites/instagram.com/`.
5. `ProcessRuntime`: replay one named tape sequentially.
6. `CliEmitter`: generate `instagram-com-cli`.
7. Optional: static `process-map.html` derived from tapes, only after replay is
   working.

## Success Criterion

The first success is not a graph.

The first success is:

```text
instagram-com-cli open-messages
```

or:

```text
instagram-com-cli send-test-dm --message "testing this" --confirm-write
```

loading a taught process and replaying it through Stagehand without needing a
new `observe()` call for every step.

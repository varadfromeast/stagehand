# Cartographer v1 Interfaces

This document defines the v1 contracts before implementation. The goal is that
the code reads like the domain:

```ts
const session = await browserSession.launchInstagram();
const before = await stateIdentity.capture(session);
const candidate = await recorder.observe(session, "open messages");
const step = await recorder.recordStep(session, before, candidate);
await tapeStore.saveStep(step);
await emitter.emitCli("instagram.com");
```

Implementation details such as Stagehand, JSON files, hashing, screenshots, and
Commander should sit behind these interfaces.

## Public CLI Surface

These are the commands a user should understand first.

```text
cartographer teach instagram
cartographer snapshot <label>
cartographer observe "<instruction>"
cartographer act <candidate-id>
cartographer record-step <step-name>
cartographer name-process <process-name> --steps <step-id...>
cartographer emit-cli instagram.com

instagram-com-cli open-profile
instagram-com-cli open-recent-post --index 1
instagram-com-cli open-messages
instagram-com-cli send-dm --message <text> --confirm-write
instagram-com-cli follow-profile --confirm-write
instagram-com-cli message-profile-after-follow --message <text> --confirm-write
```

v1 can implement these as an interactive prompt first, but the internal API
should preserve this command shape.

## Domain Types

```ts
export type Domain = "instagram.com";
export type StateId = string;
export type AtomId = string;
export type StepId = string;
export type ProcessName = string;

export type StateKind =
  | "page"
  | "modal"
  | "panel"
  | "list"
  | "form"
  | "thread"
  | "unknown";

export type OpType = "click" | "fill" | "submit" | "navigate";

export type StepStatus = "recorded" | "replayed" | "self_healed" | "drifted";
```

Stagehand's `Action` remains the substrate action type. Cartographer wraps it
but does not redefine browser action semantics.

```ts
import type { Action } from "@browserbasehq/stagehand";

export interface Atom {
  id: AtomId;
  description: string;
  accessibleName: string;
  selector: string;
  method?: string;
  xpathShape: string;
  surfaceContext?: string;
}

export interface StateFingerprint {
  hash: string;
  atomIds: AtomId[];
  urlShape: string;
  title?: string;
  atomCount: number;
}

export interface State {
  id: StateId;
  domain: Domain;
  url: string;
  kind: StateKind;
  fingerprint: StateFingerprint;
  atoms: Atom[];
  observedAt: string;
  evidencePath?: string;
}

export interface TapeStep {
  id: StepId;
  type: OpType;
  before: State;
  after: State;
  atomId: AtomId;
  instruction: string;
  actions: Action[];
  status: StepStatus;
  validationHash: string;
  writesToPlatform: boolean;
  createdAt: string;
}

export interface ProcessArg {
  name: string;
  required: boolean;
  description: string;
}

export interface ProcessTape {
  name: ProcessName;
  description: string;
  entry: State;
  steps: TapeStep[];
  args: ProcessArg[];
  writesToPlatform: boolean;
}

export interface TapeCatalog {
  domain: Domain;
  version: 1;
  processes: Record<ProcessName, ProcessTape>;
  updatedAt: string;
}
```

## Browser Session

Stagehand should be hidden behind `BrowserSession`. If v1 later switches from
local Chrome to Browserbase, only this implementation changes.

```ts
export interface BrowserSession {
  domain: Domain;
  currentUrl(): Promise<string>;
  goto(url: string): Promise<void>;
  observe(instruction: string): Promise<ObservedCandidate[]>;
  act(candidate: ObservedCandidate, args?: RuntimeArgs): Promise<ActOutcome>;
  actRaw(action: Action, args?: RuntimeArgs): Promise<ActOutcome>;
  screenshot(label: string): Promise<string>;
  waitForUser(label: string): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserSessionFactory {
  launchInstagram(options: LaunchOptions): Promise<BrowserSession>;
}

export interface LaunchOptions {
  browser: "local" | "browserbase";
  cacheDir: string;
  headless: boolean;
  viewport: { width: number; height: number };
}

export interface ObservedCandidate {
  id: string;
  instruction: string;
  action: Action;
  atom: Atom;
  risk: "read" | "write";
}

export interface ActOutcome {
  success: boolean;
  message: string;
  actions: Action[];
}

export type RuntimeArgs = Record<string, string | number | boolean>;
```

## State Identity

This is the first load-bearing interface. The implementation can use
`observe()`, snapshots, or a deep import later, but callers should only see this.

```ts
export interface StateIdentity {
  capture(session: BrowserSession, label?: string): Promise<State>;
  fingerprint(atoms: Atom[], url: string, kind?: StateKind): StateFingerprint;
  canonicalize(candidates: ObservedCandidate[]): Atom[];
  diff(a: StateFingerprint, b: StateFingerprint): StateDiff;
}

export interface StateDiff {
  sameHash: boolean;
  addedAtomIds: AtomId[];
  removedAtomIds: AtomId[];
  stableAtomRatio: number;
}
```

## Manual Recorder

The manual recorder is the v1 substitute for autonomous Cartographer.

```ts
export interface ManualRecorder {
  snapshot(label: string): Promise<State>;
  observe(instruction: string): Promise<ObservedCandidate[]>;
  act(candidateId: string, args?: RuntimeArgs): Promise<ActOutcome>;
  recordLastStep(stepName: string, options?: RecordStepOptions): Promise<TapeStep>;
  nameProcess(input: NameProcessInput): Promise<ProcessTape>;
  save(): Promise<TapeCatalog>;
}

export interface RecordStepOptions {
  writesToPlatform: boolean;
  type?: OpType;
}

export interface NameProcessInput {
  name: ProcessName;
  description: string;
  stepIds: StepId[];
  args?: ProcessArg[];
  writesToPlatform?: boolean;
}
```

## Tape Store

Keep the persistence boring: JSON first.

```ts
export interface TapeStore {
  loadCatalog(domain: Domain): Promise<TapeCatalog | null>;
  loadProcess(domain: Domain, name: ProcessName): Promise<ProcessTape | null>;
  saveCatalog(catalog: TapeCatalog): Promise<void>;
  saveProcess(process: ProcessTape): Promise<void>;
}
```

## State Action Cache

This is the structural cache, separate from Stagehand's instruction cache.

```ts
export interface StateActionCache {
  get(key: StateActionCacheKey): Promise<StateActionCacheEntry | null>;
  put(entry: StateActionCacheEntry): Promise<void>;
  markDrifted(key: StateActionCacheKey, reason: string): Promise<void>;
}

export interface StateActionCacheKey {
  domain: Domain;
  beforeStateId: StateId;
  atomId: AtomId;
}

export interface StateActionCacheEntry extends StateActionCacheKey {
  version: 1;
  afterStateId: StateId;
  instruction: string;
  actions: Action[];
  validationHash: string;
  status: StepStatus;
  writesToPlatform: boolean;
  updatedAt: string;
}
```

## Runtime

The runtime executes named processes. It should not know how teaching works.

```ts
export interface CartographerRuntime {
  runProcess(input: RunProcessInput): Promise<RunProcessResult>;
}

export interface RunProcessInput {
  domain: Domain;
  processName: ProcessName;
  args?: RuntimeArgs;
  confirmWrite: boolean;
  dryRun: boolean;
}

export interface RunProcessResult {
  success: boolean;
  processName: ProcessName;
  executedStepIds: StepId[];
  driftedStepIds: StepId[];
  message: string;
}
```

Runtime write rule:

```ts
if (process.writesToPlatform && !input.confirmWrite) {
  throw new Error("Refusing to run write process without --confirm-write");
}
```

## CLI Emitter

The emitter compiles process tape metadata to a thin CLI wrapper.

```ts
export interface CliEmitter {
  emit(input: CliEmitterInput): Promise<CliEmitterResult>;
}

export interface CliEmitterInput {
  domain: Domain;
  tapeDir: string;
  outputPath: string;
  binName: string;
}

export interface CliEmitterResult {
  outputPath: string;
  commandCount: number;
  commands: string[];
}
```

The generated CLI should only:

1. Parse args.
2. Load the process tape.
3. Call `CartographerRuntime.runProcess(...)`.
4. Print a concise result.

## Implementation Boundary

Allowed dependencies by layer:

```text
manual-recorder -> BrowserSession, StateIdentity, TapeStore, StateActionCache
runtime         -> BrowserSession, TapeStore, StateActionCache
cli-emitter     -> TapeStore metadata only
state-identity  -> no tape/runtime imports
cache           -> no Stagehand imports except Action type
tape-store      -> no Stagehand imports
```

This keeps the system understandable: Stagehand is the browser substrate, the
tape is the memory, the runtime is replay, and the emitter is just packaging.

## First Compile Target

Before implementation, create:

```text
packages/cartographer/src/contracts.ts
packages/cartographer/src/stubs.ts
```

`contracts.ts` should contain the interfaces above.

`stubs.ts` should export placeholder implementations that throw
`new Error("not implemented")`.

Exit criterion:

```text
pnpm --filter @cartographer/core typecheck
```

passes with the contracts in place. Only after that should implementation begin.

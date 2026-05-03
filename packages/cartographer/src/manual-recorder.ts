import type {
  ActOutcome,
  BrowserSession,
  ManualRecorder,
  NameProcessInput,
  ObservedCandidate,
  ProcessTape,
  RecordStepOptions,
  State,
  StateIdentity,
  TapeCatalog,
  TapeStep,
  TapeStore,
} from "./contracts.js";
import { sha256 } from "./hash.js";

interface LastActionRecord {
  before: State;
  candidate: ObservedCandidate;
  outcome: ActOutcome;
  after: State;
}

export class ProcessTapeRecorder implements ManualRecorder {
  private candidates = new Map<string, ObservedCandidate>();
  private steps = new Map<string, TapeStep>();
  private processes = new Map<string, ProcessTape>();
  private beforeObserve: State | null = null;
  private lastAction: LastActionRecord | null = null;

  constructor(
    private readonly session: BrowserSession,
    private readonly identity: StateIdentity,
    private readonly tapeStore: TapeStore,
  ) {}

  async snapshot(label: string): Promise<State> {
    return await this.identity.capture(this.session, label);
  }

  async observe(instruction: string): Promise<ObservedCandidate[]> {
    this.beforeObserve = await this.identity.capture(this.session, "before-observe");
    const observed = await this.session.observe(instruction);
    this.candidates.clear();
    for (const candidate of observed) {
      this.candidates.set(candidate.id, candidate);
    }
    return observed;
  }

  async act(candidateId: string): Promise<ActOutcome> {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      throw new Error(`Unknown candidate id: ${candidateId}`);
    }
    const before = this.beforeObserve || (await this.identity.capture(this.session, "before-act"));
    const outcome = await this.session.act(candidate);
    const after = await this.identity.capture(this.session, "after-act");
    this.lastAction = { before, candidate, outcome, after };
    return outcome;
  }

  async recordLastStep(stepName: string, options?: RecordStepOptions): Promise<TapeStep> {
    if (!this.lastAction) {
      throw new Error("No action has been executed. Run observe and act first.");
    }

    const { before, candidate, outcome, after } = this.lastAction;
    const now = new Date().toISOString();
    const writesToPlatform = options?.writesToPlatform ?? false;
    const step: TapeStep = {
      id: sha256({
        stepName,
        before: before.id,
        after: after.id,
        atomId: candidate.atom.id,
        createdAt: now,
      }),
      name: stepName,
      type: options?.type || opTypeFromActionMethod(candidate.action.method),
      before,
      after,
      atomId: candidate.atom.id,
      instruction: candidate.instruction,
      actions: outcome.actions.length > 0 ? outcome.actions : [candidate.action],
      status: "recorded",
      validationHash: after.fingerprint.hash,
      writesToPlatform,
      createdAt: now,
    };

    this.steps.set(step.id, step);
    return step;
  }

  async nameProcess(input: NameProcessInput): Promise<ProcessTape> {
    const selectedSteps = input.stepIds.map((stepId) => {
      const step = this.steps.get(stepId);
      if (!step) throw new Error(`Unknown step id: ${stepId}`);
      return step;
    });
    if (selectedSteps.length === 0) {
      throw new Error("A process needs at least one step.");
    }

    const now = new Date().toISOString();
    const process: ProcessTape = {
      name: input.name,
      description: input.description,
      domain: selectedSteps[0].before.domain,
      entry: selectedSteps[0].before,
      steps: selectedSteps,
      args: input.args || [],
      postconditions: selectedSteps[selectedSteps.length - 1].validators,
      writesToPlatform:
        input.writesToPlatform ?? selectedSteps.some((step) => step.writesToPlatform),
      createdAt: now,
      updatedAt: now,
    };
    this.processes.set(process.name, process);
    await this.tapeStore.saveProcess(process);
    return process;
  }

  getRecordedSteps(stepIds: string[]): TapeStep[] {
    const selectedSteps = stepIds.map((stepId) => {
      const step = this.steps.get(stepId);
      if (!step) throw new Error(`Unknown step id: ${stepId}`);
      return step;
    });
    if (selectedSteps.length === 0) {
      throw new Error("A fallback tape needs at least one step.");
    }
    return selectedSteps;
  }

  async save(): Promise<TapeCatalog> {
    for (const process of this.processes.values()) {
      await this.tapeStore.saveProcess(process);
    }
    const catalog = await this.tapeStore.loadCatalog("instagram.com");
    return (
      catalog || {
        domain: "instagram.com",
        version: 1,
        processes: {},
        updatedAt: new Date().toISOString(),
      }
    );
  }
}

function opTypeFromActionMethod(method?: string): TapeStep["type"] {
  if (!method) return "click";
  if (method === "fill" || method === "type") return "fill";
  if (method === "press") return "submit";
  return "click";
}

import type { Action } from "@browserbasehq/stagehand";

export type Domain = "instagram.com";
export type StateId = string;
export type AtomId = string;
export type StepId = string;
export type ProcessName = string;
export type FallbackTapeId = string;
export type PromotionProposalId = string;

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
export type EvidenceKind = "screenshot" | "text";
export type FallbackStatus = "succeeded" | "failed" | "rejected";
export type FallbackOperationKind = "goto" | "click" | "fill" | "text" | "screenshot" | "record_step";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CartographerLogger {
  log(level: LogLevel, event: string, context?: Record<string, unknown>): void;
}

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

export interface EvidenceArtifact {
  kind: EvidenceKind;
  label: string;
  path: string;
  selector?: string;
  createdAt: string;
}

export interface TapeStep {
  id: StepId;
  name: string;
  type: OpType;
  before: State;
  after: State;
  atomId: AtomId;
  instruction: string;
  actions: Action[];
  status: StepStatus;
  validationHash: string;
  validators?: StepValidator[];
  selectorDiagnostics?: StepSelectorDiagnostics;
  writesToPlatform: boolean;
  createdAt: string;
}

export interface SelectorDiagnosticCandidate {
  selector: string;
  selectorKind: "xpath" | "css" | "url";
  stability: "strong" | "medium" | "weak";
  reason: string;
  matchCount?: number;
}

export interface StepSelectorDiagnostics {
  selected: SelectorDiagnosticCandidate;
  alternatives?: SelectorDiagnosticCandidate[];
}

export type StepValidator =
  | { type: "url_equals"; value: string }
  | { type: "url_contains"; value: string }
  | { type: "selector_exists"; selector: string }
  | { type: "text_contains"; selector: string; value: string };

export interface ProcessOutput {
  name: string;
  source: "text";
  selector: string;
  description: string;
}

export type Postcondition = StepValidator;

export interface FallbackTape {
  id: FallbackTapeId;
  domain: Domain;
  intent: string;
  sessionId?: string;
  source: "playwright_fallback" | "stagehand_fallback" | "imported_process";
  status: FallbackStatus;
  entry: State;
  steps: TapeStep[];
  operations?: FallbackOperation[];
  evidence: EvidenceArtifact[];
  args: ProcessArg[];
  writesToPlatform: boolean;
  recordingStartedAt?: string;
  createdAt: string;
  completedAt: string;
  rejectedAt?: string;
  rejectedReason?: string;
  promotedAt?: string;
  promotedProcessName?: ProcessName;
}

export interface FallbackOperation {
  id: string;
  kind: FallbackOperationKind;
  instruction: string;
  urlBefore?: string;
  urlAfter?: string;
  selector?: string;
  selectorKind?: "xpath" | "css" | "url" | "unknown";
  valuePlaceholder?: string;
  evidencePath?: string;
  stepId?: StepId;
  writesToPlatform?: boolean;
  createdAt: string;
}

export interface FallbackReviewPacket {
  id: FallbackTapeId;
  domain: Domain;
  intent: string;
  status: FallbackStatus;
  stepCount: number;
  writesToPlatform: boolean;
  args: ProcessArg[];
  evidence: EvidenceArtifact[];
  evidencePreview: EvidencePreview[];
  reviewPath?: string;
  reviewRequestPath?: string;
  decisionSchemaPath?: string;
  decisionTemplatePath?: string;
  promoteCommand: string;
  rejectCommand: string;
  applyDecisionCommand?: string;
}

export interface FallbackPromotionSummary {
  fallbackTapeId: FallbackTapeId;
  domain: Domain;
  intent: string;
  status: FallbackStatus;
  source: FallbackTape["source"];
  sessionId?: string;
  writesToPlatform: boolean;
  args: ProcessArg[];
  recordingStartedAt?: string;
  completedAt: string;
  entryUrl: string;
  finalUrl: string;
  stepCount: number;
  operationCount: number;
  steps: FallbackStepSummary[];
  operations: FallbackOperation[];
  evidence: EvidencePreview[];
  mechanicalHints: MechanicalPromotionHints;
}

export interface FallbackStepSummary {
  id: StepId;
  name: string;
  type: OpType;
  instruction: string;
  beforeUrl: string;
  afterUrl: string;
  writesToPlatform: boolean;
  actions: FallbackActionSummary[];
  validators: StepValidator[];
  selectorDiagnostics?: StepSelectorDiagnostics;
  selectorWarnings: string[];
}

export interface FallbackActionSummary {
  method?: string;
  selector: string;
  selectorKind: "xpath" | "css" | "url" | "unknown";
  arguments: string[];
}

export interface MechanicalPromotionHints {
  suggestedPostconditions: Postcondition[];
  riskFlags: string[];
  selectorWarnings: string[];
  textEvidenceSelectors: string[];
}

export interface EvidencePreview {
  kind: EvidenceKind;
  label: string;
  path: string;
  selector?: string;
  preview?: string;
}

export interface PromotionProposal {
  id: PromotionProposalId;
  fallbackTapeId: FallbackTapeId;
  domain: Domain;
  decision: "promote" | "reject";
  commandName?: ProcessName;
  description?: string;
  args?: ProcessArg[];
  outputs?: ProcessOutput[];
  postconditions?: Postcondition[];
  writesToPlatform?: boolean;
  reason: string;
  reviewer: "agent" | "model";
  policyFindings?: PromotionPolicyFinding[];
  createdAt: string;
  appliedAt?: string;
}

export interface FallbackTapeStore {
  list(domain: Domain): Promise<FallbackTape[]>;
  load(domain: Domain, id: FallbackTapeId): Promise<FallbackTape | null>;
  save(tape: FallbackTape): Promise<void>;
  markPromoted(domain: Domain, id: FallbackTapeId, processName: ProcessName): Promise<void>;
  reject(domain: Domain, id: FallbackTapeId, reason: string): Promise<void>;
  delete(domain: Domain, id: FallbackTapeId): Promise<void>;
}

export interface PromotionStore {
  list(domain: Domain): Promise<PromotionProposal[]>;
  save(proposal: PromotionProposal): Promise<void>;
  markApplied(domain: Domain, id: PromotionProposalId): Promise<void>;
}

export interface ProcessArg {
  name: string;
  required: boolean;
  description: string;
}

export interface ProcessTape {
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

export interface TapeCatalog {
  domain: Domain;
  version: 1;
  processes: Record<ProcessName, ProcessTapeSummary>;
  updatedAt: string;
}

export interface ProcessTapeSummary {
  name: ProcessName;
  description: string;
  stepCount: number;
  writesToPlatform: boolean;
  args: ProcessArg[];
  outputs?: ProcessOutput[];
  postconditions?: Postcondition[];
  updatedAt: string;
}

export type RuntimeArgs = Record<string, string | number | boolean>;

export interface BrowserSession {
  domain: Domain;
  currentUrl(): Promise<string>;
  goto(url: string): Promise<void>;
  observe(instruction: string): Promise<ObservedCandidate[]>;
  act(candidate: ObservedCandidate, args?: RuntimeArgs): Promise<ActOutcome>;
  actRaw(action: Action, args?: RuntimeArgs): Promise<ActOutcome>;
  exists(selector: string): Promise<boolean>;
  readText(selector?: string): Promise<string>;
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
  risk: "unknown";
}

export interface ActOutcome {
  success: boolean;
  message: string;
  actions: Action[];
}

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

export interface TapeStore {
  loadCatalog(domain: Domain): Promise<TapeCatalog | null>;
  loadProcess(domain: Domain, name: ProcessName): Promise<ProcessTape | null>;
  saveCatalog(catalog: TapeCatalog): Promise<void>;
  saveProcess(process: ProcessTape): Promise<void>;
}

export interface LoadedSkillset {
  domain: Domain;
  catalog: TapeCatalog;
  processes: Record<ProcessName, ProcessTape>;
  loadedAt: string;
}

export interface SkillRegistry {
  preload(domain: Domain): Promise<LoadedSkillset>;
  refresh(domain: Domain): Promise<LoadedSkillset>;
  getProcess(domain: Domain, name: ProcessName): Promise<ProcessTape | null>;
  listProcesses(domain: Domain): Promise<ProcessTapeSummary[]>;
}

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

export interface BrowserFallbackRecorder {
  open(): Promise<void>;
  close(): Promise<void>;
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string, argName?: string): Promise<void>;
  text(selector?: string): Promise<string>;
  screenshot(label: string): Promise<string>;
  recordLastStep(name: string, options: RecordStepOptions): Promise<TapeStep>;
  createFallbackTape(input: CreateFallbackTapeInput): Promise<FallbackTape>;
}

export type FallbackEngineName = "stagehand" | "playwright";

export interface FallbackEngine {
  name: FallbackEngineName;
  record(input: FallbackEngineRecordInput): Promise<FallbackTape>;
}

export interface FallbackEngineRecordInput {
  domain: Domain;
  intent: string;
  args?: ProcessArg[];
  writesToPlatform: boolean;
}

export interface CreateFallbackTapeInput {
  intent: string;
  argNames: string[];
  writesToPlatform: boolean;
}

export interface ElementLocatorStrategy {
  locate(input: LocateElementInput): Promise<LocatedElement>;
}

export interface LocateElementInput {
  selector: string;
  actionDescription: string;
}

export interface LocatedElement {
  selector: string;
  selectorKind: "xpath" | "css" | "url";
  description: string;
  alternatives?: SelectorCandidate[];
}

export interface SelectorCandidate {
  selector: string;
  selectorKind: "xpath" | "css";
  stability: "strong" | "medium" | "weak";
  reason: string;
  matchCount?: number;
}

export interface SelectorPolicy {
  choose(candidates: SelectorCandidate[]): SelectorCandidate;
}

export interface ValidationResult {
  passed: boolean;
  failures: string[];
  checks?: ValidationCheck[];
}

export interface ValidationCheck {
  type: StepValidator["type"];
  passed: boolean;
  expected: string;
  observed?: string;
  selector?: string;
}

export interface ReplayValidator {
  validate(session: BrowserSession, validators?: StepValidator[]): Promise<ValidationResult>;
}

export interface EvidenceStore {
  captureScreenshot(input: CaptureScreenshotInput): Promise<EvidenceArtifact>;
  captureText(input: CaptureTextInput): Promise<EvidenceArtifact>;
}

export interface CaptureScreenshotInput {
  domain: Domain;
  label: string;
  screenshot: () => Promise<Buffer>;
}

export interface CaptureTextInput {
  domain: Domain;
  label: string;
  selector: string;
  text: string;
}

export interface FallbackReviewer {
  review(domain: Domain): Promise<FallbackReviewResult>;
  inspect(domain: Domain, id: FallbackTapeId): Promise<FallbackReviewPacket>;
}

export interface FallbackReviewResult {
  existingProcesses: ProcessName[];
  unpromotedFallbacks: FallbackReviewPacket[];
}

export type PromotionPolicyFindingSeverity = "error" | "warning";

export interface PromotionPolicyFinding {
  severity: PromotionPolicyFindingSeverity;
  code: string;
  message: string;
}

export interface PromotionPolicyInput {
  tape: FallbackTape;
  commandName: ProcessName;
  description: string;
  outputs?: ProcessOutput[];
  postconditions?: Postcondition[];
  existingProcessNames: ProcessName[];
}

export interface PromotionPolicyDecision {
  accepted: boolean;
  writesToPlatform: boolean;
  effectivePostconditions?: Postcondition[];
  findings: PromotionPolicyFinding[];
  reason: string;
}

export interface PromotionPolicy {
  evaluate(input: PromotionPolicyInput): PromotionPolicyDecision;
}

export type PromotionDecisionConfidence = "low" | "medium" | "high";

export type PromotionDecision =
  | {
      action: "promote";
      fallbackTapeId: FallbackTapeId;
      reasoning: string;
      confidence: PromotionDecisionConfidence;
      commandName: ProcessName;
      description: string;
      postconditions: Postcondition[];
      outputs?: ProcessOutput[];
    }
  | {
      action: "reject";
      fallbackTapeId: FallbackTapeId;
      reasoning: string;
      confidence: PromotionDecisionConfidence;
      rejectReason: string;
    }
  | {
      action: "delete";
      fallbackTapeId: FallbackTapeId;
      reasoning: string;
      confidence: PromotionDecisionConfidence;
    };

export interface PromotionDecisionSchema {
  schemaVersion: 1;
  schema: Record<string, unknown>;
}

export interface PromotionReviewRequest {
  schemaVersion: 1;
  domain: Domain;
  fallbackTapeId: FallbackTapeId;
  prompt: string;
  decisionSchemaPath: string;
  decisionTemplatePath: string;
  reviewPath: string;
  reviewPacket: FallbackReviewPacket;
  fallbackSummary: FallbackPromotionSummary;
  existingCommands: ProcessTapeSummary[];
  policy: {
    name: "v1";
    hardRules: string[];
    advisoryRules: string[];
  };
}

export interface PromotionReviewArtifacts {
  reviewPath: string;
  reviewRequestPath: string;
  decisionSchemaPath: string;
  decisionTemplatePath: string;
  request: PromotionReviewRequest;
  decisionSchema: PromotionDecisionSchema;
  decisionTemplate: PromotionDecision;
}

export interface PromotionDecisionApplyResult {
  decision: PromotionDecision;
  agentContractDelta?: AgentContractDelta;
  result:
    | { action: "promote"; promotion: PromotionResult }
    | { action: "reject"; rejected: FallbackTapeId; reason: string }
    | { action: "delete"; deleted: FallbackTapeId };
}

export interface PromotionDecisionApplier {
  apply(domain: Domain, decision: PromotionDecision): Promise<PromotionDecisionApplyResult>;
}

export interface PromotionOptions {
  commandName: ProcessName;
  description: string;
  outputs?: ProcessOutput[];
  postconditions?: Postcondition[];
}

export interface ReusableCommandReference {
  cliPath: string;
  command: string;
  dryRunCommand?: string;
  helpCommand: string;
  skillPath: string;
  manifestPath?: string;
}

export interface AgentContractDelta {
  schemaVersion: 1;
  kind: "command_added";
  domain: Domain;
  commandName: string;
  processName: ProcessName;
  description: string;
  writesToPlatform: boolean;
  args: ProcessArg[];
  outputs: ProcessOutput[];
  postconditions: Postcondition[];
  reusableCommand: ReusableCommandReference;
  refreshCommands: string[];
  agentInstruction: string;
}

export interface PromotionResult {
  proposal: PromotionProposal;
  processName: ProcessName;
  cliCommandName: string;
  reusableCommand: ReusableCommandReference;
  agentContractDelta: AgentContractDelta;
  policy: PromotionPolicyDecision;
  emittedCli: CliEmitterResult;
  emittedSkillPath: string;
  emittedManifestPath?: string;
  exposedSkillPath: string;
  exposedManifestPath?: string;
}

export interface SkillPromoter {
  promote(domain: Domain, fallbackTapeId: FallbackTapeId, options: PromotionOptions): Promise<PromotionResult>;
}

export type EndOfTaskDecision =
  | {
      action: "promote";
      fallbackTapeId: FallbackTapeId;
      commandName: ProcessName;
      description: string;
      outputs?: ProcessOutput[];
      postconditions?: Postcondition[];
    }
  | { action: "reject"; fallbackTapeId: FallbackTapeId; reason: string }
  | { action: "delete"; fallbackTapeId: FallbackTapeId };

export interface EndOfTaskReviewInput {
  domain: Domain;
  taskStartedAt?: string;
  decisions?: EndOfTaskDecision[];
}

export interface EndOfTaskReviewResult {
  review: FallbackReviewResult;
  appliedDecisions: EndOfTaskDecision[];
  promotions: PromotionResult[];
}

export interface EndOfTaskReviewer {
  reviewCompletedTask(input: EndOfTaskReviewInput): Promise<EndOfTaskReviewResult>;
}

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
  outputs?: Record<string, string>;
  execution?: RunExecutionResult;
  postconditions?: PostconditionResult;
  drift?: DriftReport;
  failure?: RunFailure;
  message: string;
}

export interface RunExecutionResult {
  completed: boolean;
  stepCount: number;
  executedStepCount: number;
  actionFailures: ActionFailure[];
}

export interface ActionFailure {
  stepId: StepId;
  stepName: string;
  method?: string;
  selector: string;
  message: string;
}

export interface PostconditionResult {
  required: boolean;
  passed: boolean;
  checks: ValidationCheck[];
}

export interface DriftReport {
  detected: boolean;
  severity: "none" | "warning";
  steps: DriftStepReport[];
}

export interface DriftStepReport {
  stepId: StepId;
  stepName: string;
  expected: StateFingerprint;
  observed: StateFingerprint;
  stableAtomRatio: number;
  validationFailures: string[];
  validationChecks: ValidationCheck[];
}

export type RunFailure =
  | { kind: "action_failed"; reason: string }
  | { kind: "postcondition_failed"; reason: string }
  | { kind: "missing_args"; reason: string }
  | { kind: "write_confirmation_required"; reason: string }
  | { kind: "unknown_process"; reason: string };

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

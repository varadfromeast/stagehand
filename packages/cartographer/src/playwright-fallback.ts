import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Action } from "@browserbasehq/stagehand";
import type {
  BrowserFallbackRecorder,
  CreateFallbackTapeInput,
  Domain,
  ElementLocatorStrategy,
  EvidenceArtifact,
  EvidenceStore,
  FallbackOperation,
  FallbackTape,
  LocatedElement,
  LocateElementInput,
  OpType,
  ProcessArg,
  RecordStepOptions,
  SelectorCandidate,
  SelectorPolicy,
  State,
  StateActionCache,
  StepSelectorDiagnostics,
  StepValidator,
  TapeStep,
} from "./contracts.js";
import { ensureDir } from "./fs-json.js";
import { actionToAtom, shapeUrl } from "./state-identity.js";
import { cartographerHome } from "./paths.js";
import { sha256 } from "./hash.js";
import { FileEvidenceStore } from "./evidence-store.js";

interface LastBrowserStep {
  before: State;
  after: State;
  action: Action;
  instruction: string;
  type: OpType;
  atomId: string;
  validators: StepValidator[];
  selectorDiagnostics?: StepSelectorDiagnostics;
}

export class StabilityFirstSelectorPolicy implements SelectorPolicy {
  choose(candidates: SelectorCandidate[]): SelectorCandidate {
    const ranked = [...candidates].sort((a, b) => score(b) - score(a));
    const selected = ranked.find((candidate) => candidate.matchCount === 1) || ranked[0];
    if (!selected) throw new Error("No selector candidates were generated.");
    return selected;
  }
}

export class PlaywrightElementLocatorStrategy implements ElementLocatorStrategy {
  constructor(
    private readonly page: Page,
    private readonly selectorPolicy: SelectorPolicy = new StabilityFirstSelectorPolicy(),
  ) {}

  async locate(input: LocateElementInput): Promise<LocatedElement> {
    if (input.selector.startsWith("xpath=") || input.selector.startsWith("/")) {
      const selector = input.selector.startsWith("xpath=") ? input.selector : `xpath=${input.selector}`;
      return {
        selector,
        selectorKind: "xpath",
        description: input.actionDescription,
        alternatives: [
          {
            selector,
            selectorKind: "xpath",
            stability: selector.startsWith("xpath=/html") ? "weak" : "medium",
            reason: "agent-provided xpath",
          },
        ],
      };
    }
    const locator = this.page.locator(input.selector).first();
    const handle = await locator.elementHandle({ timeout: 10000 });
    if (!handle) throw new Error(`Could not resolve selector: ${input.selector}`);
    const candidates = await handle.evaluate((element) => {
      type Candidate = {
        selector: string;
        selectorKind: "xpath" | "css";
        stability: "strong" | "medium" | "weak";
        reason: string;
      };

      function quote(value: string): string {
        if (!value.includes("'")) return `'${value}'`;
        if (!value.includes('"')) return `"${value}"`;
        return `concat(${value.split("'").map((part) => `'${part}'`).join(`, "'", `)})`;
      }

      function cssEscape(value: string): string {
        return CSS.escape(value);
      }

      function absoluteXPath(node: Element): string {
        function stepFor(currentNode: Element): string {
          const tag = currentNode.tagName.toLowerCase();
          let index = 1;
          let sibling = currentNode.previousElementSibling;
          while (sibling) {
            if (sibling.tagName.toLowerCase() === tag) index += 1;
            sibling = sibling.previousElementSibling;
          }
          return `${tag}[${index}]`;
        }

        const steps: string[] = [];
        let current: Element | null = node;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          steps.unshift(stepFor(current));
          current = current.parentElement;
        }
        return `/${steps.join("/")}`;
      }

      function textCandidate(node: Element): string | null {
        const text = node.textContent?.replace(/\s+/g, " ").trim();
        if (!text || text.length > 80) return null;
        return `//${node.tagName.toLowerCase()}[normalize-space()=${quote(text)}]`;
      }

      const tag = element.tagName.toLowerCase();
      const candidates: Candidate[] = [];
      if (element.id) {
        candidates.push({
          selector: `xpath=//*[@id=${quote(element.id)}]`,
          selectorKind: "xpath",
          stability: "strong",
          reason: "id attribute",
        });
        candidates.push({
          selector: `#${cssEscape(element.id)}`,
          selectorKind: "css",
          stability: "strong",
          reason: "id css selector",
        });
      }

      for (const attr of ["data-testid", "aria-label", "name", "placeholder", "title", "role"]) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        candidates.push({
          selector: `xpath=//${tag}[@${attr}=${quote(value)}]`,
          selectorKind: "xpath",
          stability: attr === "data-testid" || attr === "aria-label" ? "strong" : "medium",
          reason: `${attr} attribute`,
        });
      }

      const byText = textCandidate(element);
      if (byText) {
        candidates.push({
          selector: `xpath=${byText}`,
          selectorKind: "xpath",
          stability: "medium",
          reason: "short normalized text",
        });
      }

      candidates.push({
        selector: `xpath=${absoluteXPath(element)}`,
        selectorKind: "xpath",
        stability: "weak",
        reason: "absolute fallback path",
      });

      return candidates;
    });
    const withCounts = await Promise.all(
      candidates.map(async (candidate) => ({
        ...candidate,
        matchCount: await this.countMatches(candidate.selector),
      })),
    );
    const selected = this.selectorPolicy.choose(withCounts);
    return {
      selector: selected.selector,
      selectorKind: selected.selectorKind,
      description: input.actionDescription,
      alternatives: withCounts,
    };
  }

  private async countMatches(selector: string): Promise<number> {
    try {
      return await this.page.locator(selector).count();
    } catch {
      return 0;
    }
  }
}

export class PlaywrightFallbackRecorder implements BrowserFallbackRecorder {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private locatorStrategy: ElementLocatorStrategy | null = null;
  private lastStep: LastBrowserStep | null = null;
  private steps: TapeStep[] = [];
  private evidence: EvidenceArtifact[] = [];
  private operations: FallbackOperation[] = [];
  private readonly sessionId: string;
  private readonly recordingStartedAt: string;

  constructor(
    private readonly domain: Domain,
    private readonly actionCache: StateActionCache,
    private readonly evidenceStore: EvidenceStore = new FileEvidenceStore(),
  ) {
    this.recordingStartedAt = new Date().toISOString();
    this.sessionId = sha256({
      domain,
      source: "playwright_fallback",
      startedAt: this.recordingStartedAt,
    });
  }

  async open(): Promise<void> {
    const profileDir = path.join(cartographerHome(), "stagehand-cache", "chrome-profile");
    await ensureDir(profileDir);
    this.context = await chromium.launchPersistentContext(profileDir, {
      executablePath: process.env.CARTOGRAPHER_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      viewport: { width: 1288, height: 900 },
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.locatorStrategy = new PlaywrightElementLocatorStrategy(this.page);
    await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  }

  async close(): Promise<void> {
    await this.context?.close();
  }

  async goto(url: string): Promise<void> {
    const before = await this.capture("before-goto");
    await this.getPage().goto(url, { waitUntil: "domcontentloaded" });
    const after = await this.capture("after-goto");
    this.lastStep = this.toLastStep({
      before,
      after,
      instruction: `goto ${url}`,
      selector: url,
      method: "goto",
      type: "navigate",
      arguments_: [],
      validators: [{ type: "url_equals", value: url }],
      selectorDiagnostics: {
        selected: {
          selector: url,
          selectorKind: "url",
          stability: "strong",
          reason: "direct navigation URL",
          matchCount: 1,
        },
      },
    });
    this.recordOperation({
      kind: "goto",
      instruction: `goto ${url}`,
      urlBefore: before.url,
      urlAfter: after.url,
      selector: url,
      selectorKind: "url",
      writesToPlatform: false,
    });
  }

  async gotoInbox(): Promise<void> {
    await this.goto("https://www.instagram.com/direct/inbox/");
  }

  async click(selector: string): Promise<void> {
    const before = await this.capture("before-click");
    const located = await this.getLocatorStrategy().locate({
      selector,
      actionDescription: `click ${selector}`,
    });
    await this.getPage().locator(located.selector).first().click();
    const after = await this.capture("after-click");
    this.lastStep = this.toLastStep({
      before,
      after,
      instruction: located.description,
      selector: located.selector,
      method: "click",
      type: "click",
      arguments_: [],
      validators: [],
      selectorDiagnostics: selectorDiagnosticsFromLocated(located),
    });
    this.recordOperation({
      kind: "click",
      instruction: located.description,
      urlBefore: before.url,
      urlAfter: after.url,
      selector: located.selector,
      selectorKind: located.selectorKind,
    });
  }

  async fill(selector: string, value: string, argName?: string): Promise<void> {
    const before = await this.capture("before-fill");
    const located = await this.getLocatorStrategy().locate({
      selector,
      actionDescription: `fill ${selector}`,
    });
    await this.getPage().locator(located.selector).first().fill(value);
    const after = await this.capture("after-fill");
    this.lastStep = this.toLastStep({
      before,
      after,
      instruction: located.description,
      selector: located.selector,
      method: "fill",
      type: "fill",
      arguments_: [argName ? `%${argName}%` : value],
      validators: [],
      selectorDiagnostics: selectorDiagnosticsFromLocated(located),
    });
    this.recordOperation({
      kind: "fill",
      instruction: located.description,
      urlBefore: before.url,
      urlAfter: after.url,
      selector: located.selector,
      selectorKind: located.selectorKind,
      valuePlaceholder: argName ? `%${argName}%` : placeholderForValue(value),
    });
  }

  async text(selector = "body"): Promise<string> {
    const text = await this.getPage().locator(selector).first().innerText({ timeout: 10000 });
    const evidencePath = await this.captureText(selector, text);
    this.recordOperation({
      kind: "text",
      instruction: `text ${selector}`,
      urlBefore: this.getPage().url(),
      urlAfter: this.getPage().url(),
      selector,
      selectorKind: selectorKind(selector),
      evidencePath,
    });
    return text;
  }

  async screenshot(label: string): Promise<string> {
    const evidencePath = await this.captureScreenshot(label);
    this.recordOperation({
      kind: "screenshot",
      instruction: `screenshot ${label}`,
      urlBefore: this.getPage().url(),
      urlAfter: this.getPage().url(),
      evidencePath,
    });
    return evidencePath;
  }

  async recordLastStep(name: string, options: RecordStepOptions): Promise<TapeStep> {
    if (!this.lastStep) throw new Error("No browser operation has been executed.");
    const now = new Date().toISOString();
    const step: TapeStep = {
      id: sha256({
        name,
        before: this.lastStep.before.id,
        after: this.lastStep.after.id,
        atomId: this.lastStep.atomId,
        createdAt: now,
      }),
      name,
      type: this.lastStep.type,
      before: this.lastStep.before,
      after: this.lastStep.after,
      atomId: this.lastStep.atomId,
      instruction: this.lastStep.instruction,
      actions: [this.lastStep.action],
      status: "recorded",
      validationHash: this.lastStep.after.fingerprint.hash,
      validators: this.lastStep.validators,
      selectorDiagnostics: this.lastStep.selectorDiagnostics,
      writesToPlatform: options.writesToPlatform,
      createdAt: now,
    };
    this.steps.push(step);
    this.recordOperation({
      kind: "record_step",
      instruction: `record-step ${name}`,
      urlBefore: step.before.url,
      urlAfter: step.after.url,
      selector: step.actions[0]?.selector,
      selectorKind: step.actions[0]?.selector ? selectorKind(step.actions[0].selector) : undefined,
      stepId: step.id,
      writesToPlatform: step.writesToPlatform,
    });
    await this.actionCache.put({
      version: 1,
      domain: this.domain,
      beforeStateId: step.before.id,
      afterStateId: step.after.id,
      atomId: step.atomId,
      instruction: step.instruction,
      actions: step.actions,
      validationHash: step.validationHash,
      status: "recorded",
      writesToPlatform: step.writesToPlatform,
      updatedAt: now,
    });
    return step;
  }

  async createFallbackTape(input: CreateFallbackTapeInput): Promise<FallbackTape> {
    if (this.steps.length === 0) throw new Error("A fallback tape needs at least one recorded step.");
    const now = new Date().toISOString();
    const argNames = unique([...input.argNames, ...placeholderArgNames(this.steps)]);
    const args: ProcessArg[] = argNames.map((argName) => ({
      name: argName,
      required: true,
      description: `${argName} argument`,
    }));
    return {
      id: sha256({
        domain: this.domain,
        intent: input.intent,
        stepIds: this.steps.map((step) => step.id),
        createdAt: now,
      }),
      domain: this.domain,
      intent: input.intent,
      sessionId: this.sessionId,
      source: "playwright_fallback",
      status: "succeeded",
      entry: this.steps[0].before,
      steps: this.steps,
      operations: this.operations,
      evidence: this.evidence,
      args,
      writesToPlatform: input.writesToPlatform || this.steps.some((step) => step.writesToPlatform),
      recordingStartedAt: this.recordingStartedAt,
      createdAt: now,
      completedAt: now,
    };
  }

  private toLastStep(input: {
    before: State;
    after: State;
    instruction: string;
    selector: string;
    method: string;
    type: OpType;
    arguments_: string[];
    validators: StepValidator[];
    selectorDiagnostics?: StepSelectorDiagnostics;
  }): LastBrowserStep {
    const action: Action = {
      selector: input.selector,
      method: input.method,
      description: input.instruction,
      arguments: input.arguments_,
    };
    const atom = actionToAtom(action, input.instruction, this.domain);
    return {
      before: input.before,
      after: input.after,
      action,
      instruction: input.instruction,
      type: input.type,
      atomId: atom.id,
      validators: input.validators,
      selectorDiagnostics: input.selectorDiagnostics,
    };
  }

  private async capture(label: string): Promise<State> {
    const url = this.getPage().url();
    const evidencePath = await this.captureScreenshot(label);
    const urlShape = shapeUrl(url);
    const hash = sha256({ atomIds: [], kind: "unknown", urlShape });
    return {
      id: hash,
      domain: this.domain,
      url,
      kind: "unknown",
      fingerprint: {
        hash,
        atomIds: [],
        urlShape,
        atomCount: 0,
      },
      atoms: [],
      observedAt: new Date().toISOString(),
      evidencePath,
    };
  }

  private async captureScreenshot(label: string): Promise<string> {
    const artifact = await this.evidenceStore.captureScreenshot({
      domain: this.domain,
      label,
      screenshot: () => this.getPage().screenshot(),
    });
    this.evidence.push(artifact);
    return artifact.path;
  }

  private async captureText(selector: string, text: string): Promise<string> {
    const artifact = await this.evidenceStore.captureText({
      domain: this.domain,
      label: "text",
      selector,
      text,
    });
    this.evidence.push(artifact);
    return artifact.path;
  }

  private getPage(): Page {
    if (!this.page) throw new Error("Playwright fallback recorder is not open.");
    return this.page;
  }

  private getLocatorStrategy(): ElementLocatorStrategy {
    if (!this.locatorStrategy) throw new Error("Playwright fallback recorder is not open.");
    return this.locatorStrategy;
  }

  private recordOperation(input: Omit<FallbackOperation, "id" | "createdAt">): void {
    const createdAt = new Date().toISOString();
    this.operations.push({
      id: sha256({
        sessionId: this.sessionId,
        index: this.operations.length,
        kind: input.kind,
        instruction: input.instruction,
        createdAt,
      }),
      createdAt,
      ...input,
    });
  }
}

function score(candidate: SelectorCandidate): number {
  const stabilityScore = candidate.stability === "strong" ? 300 : candidate.stability === "medium" ? 200 : 100;
  const uniquenessScore = candidate.matchCount === 1 ? 50 : candidate.matchCount === 0 ? -50 : 0;
  return stabilityScore + uniquenessScore;
}

function selectorDiagnosticsFromLocated(located: LocatedElement): StepSelectorDiagnostics {
  const selectedAlternative = located.alternatives?.find((candidate) => candidate.selector === located.selector);
  return {
    selected: {
      selector: located.selector,
      selectorKind: located.selectorKind,
      stability: selectedAlternative?.stability || "medium",
      reason: selectedAlternative?.reason || "selected replay selector",
      matchCount: selectedAlternative?.matchCount,
    },
    alternatives: located.alternatives?.map((candidate) => ({
      selector: candidate.selector,
      selectorKind: candidate.selectorKind,
      stability: candidate.stability,
      reason: candidate.reason,
      matchCount: candidate.matchCount,
    })),
  };
}

function selectorKind(selector: string): FallbackOperation["selectorKind"] {
  if (selector.startsWith("http://") || selector.startsWith("https://")) return "url";
  if (selector.startsWith("xpath=") || selector.startsWith("/")) return "xpath";
  if (selector.trim()) return "css";
  return "unknown";
}

function placeholderForValue(value: string): string | undefined {
  const match = value.match(/^%[a-zA-Z][a-zA-Z0-9_]*%$/);
  return match ? match[0] : undefined;
}

function placeholderArgNames(steps: TapeStep[]): string[] {
  return steps.flatMap((step) =>
    step.actions.flatMap((action) =>
      (action.arguments || []).flatMap((arg) =>
        [...arg.matchAll(/%([a-zA-Z][a-zA-Z0-9_]*)%/g)].map((match) => match[1]),
      ),
    ),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export async function runPlaywrightFallbackPrompt(inputOptions: {
  domain: Domain;
  intent: string;
  actionCache: StateActionCache;
  saveFallback: (tape: FallbackTape) => Promise<void>;
}): Promise<void> {
  const recorder = new PlaywrightFallbackRecorder(inputOptions.domain, inputOptions.actionCache);
  await recorder.open();
  console.log("Opened Instagram in a Playwright Chrome session.");
  console.log(`Fallback intent: ${inputOptions.intent}`);
  printPlaywrightFallbackHelp();

  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const line = (await rl.question("cartographer:fallback> ")).trim();
      if (!line) continue;
      const [cmd, ...rest] = splitCommandLine(line);

      if (cmd === "help") {
        printPlaywrightFallbackHelp();
      } else if (cmd === "goto") {
        const url = rest.join(" ");
        if (!url) {
          console.log("Usage: goto <url>");
          continue;
        }
        await recorder.goto(url);
        console.log(`ok goto ${url}`);
      } else if (cmd === "goto-inbox") {
        await recorder.gotoInbox();
        console.log("ok goto inbox");
      } else if (cmd === "click") {
        const selector = rest.join(" ");
        if (!selector) {
          console.log("Usage: click <selector>");
          continue;
        }
        await recorder.click(selector);
        console.log(`ok click ${selector}`);
      } else if (cmd === "fill") {
        const selector = rest[0];
        const value = rest.slice(1).join(" ");
        if (!selector || !value) {
          console.log("Usage: fill <selector> <value>");
          continue;
        }
        await recorder.fill(selector, value);
        console.log(`ok fill ${selector}`);
      } else if (cmd === "fill-arg") {
        const selector = rest[0];
        const argName = rest[1];
        const value = rest.slice(2).join(" ");
        if (!selector || !argName || !value) {
          console.log("Usage: fill-arg <selector> <arg-name> <value>");
          continue;
        }
        await recorder.fill(selector, value, argName);
        console.log(`ok fill ${selector} as %${argName}%`);
      } else if (cmd === "text") {
        const text = await recorder.text(rest.join(" ") || "body");
        console.log(text);
      } else if (cmd === "screenshot") {
        const label = rest.join("-") || "fallback";
        console.log(await recorder.screenshot(label));
      } else if (cmd === "record-step") {
        const name = rest.find((part) => !part.startsWith("--"));
        if (!name) {
          console.log("Usage: record-step <name> [--write]");
          continue;
        }
        const step = await recorder.recordLastStep(name, {
          writesToPlatform: rest.includes("--write"),
        });
        console.log(`step ${step.name} ${step.id.slice(0, 10)} write=${step.writesToPlatform}`);
      } else if (cmd === "save-fallback") {
        const tape = await recorder.createFallbackTape({
          intent: inputOptions.intent,
          argNames: collectFlagValues(rest, "--arg"),
          writesToPlatform: rest.includes("--write"),
        });
        await inputOptions.saveFallback(tape);
        console.log(`fallback ${tape.id.slice(0, 10)} steps=${tape.steps.length} write=${tape.writesToPlatform}`);
        console.log(
          `review node packages/cartographer/dist/cli.js end-task-review ${inputOptions.domain} --since ${JSON.stringify(tape.createdAt)}`,
        );
        console.log(
          `promotion-review node packages/cartographer/dist/cli.js create-promotion-review ${inputOptions.domain} ${tape.id}`,
        );
      } else if (cmd === "quit" || cmd === "exit") {
        break;
      } else {
        console.log(`Unknown fallback command: ${cmd}`);
      }
    }
  } finally {
    rl.close();
    await recorder.close();
  }
}

function printPlaywrightFallbackHelp(): void {
  console.log(`fallback commands:
  goto <url>
  goto-inbox
  click <selector>
  fill <selector> <value>
  fill-arg <selector> <arg-name> <value>
  text [selector]
  screenshot <label>
  record-step <name> [--write]
  save-fallback [--write] [--arg message]
  quit`);
}

function splitCommandLine(line: string): string[] {
  const matches = line.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}

function collectFlagValues(parts: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === flag && parts[index + 1]) {
      values.push(parts[index + 1]);
      index += 1;
    }
  }
  return values;
}

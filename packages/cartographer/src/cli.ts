#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { StagehandBrowserSessionFactory } from "./browser-session.js";
import { NodeCliEmitter } from "./cli-emitter.js";
import type { Domain, Postcondition, ProcessArg } from "./contracts.js";
import { createPreloadedRuntime, parseRuntimeArgs } from "./factory.js";
import { BasicStateIdentity } from "./state-identity.js";
import { JsonStateActionCache } from "./state-action-cache.js";
import { JsonTapeStore } from "./tape-store.js";
import { ProcessTapeRecorder } from "./manual-recorder.js";
import { binDir, cartographerHome, tapeDir } from "./paths.js";
import { recordScriptedInstagramDm } from "./instagram-scripted.js";
import { JsonFallbackTapeStore, JsonPromotionStore } from "./fallback-store.js";
import { emitSkillManifest, emitSkillMd } from "./skill-emitter.js";
import { sha256 } from "./hash.js";
import type { EvidenceArtifact, ProcessOutput, TapeStep } from "./contracts.js";
import { runPlaywrightFallbackPrompt } from "./playwright-fallback.js";
import { DefaultFallbackReviewer } from "./fallback-reviewer.js";
import { DefaultSkillPromoter } from "./skill-promoter.js";
import { DefaultEndOfTaskReviewer, createEndOfTaskDecisionFromCli } from "./end-of-task-reviewer.js";
import { ConsoleCartographerLogger } from "./logger.js";
import {
  createPromotionReviewArtifacts,
  DefaultPromotionDecisionApplier,
  readPromotionDecisionFile,
} from "./promotion-decision.js";

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
  const [command, ...args] = cliArgs;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  if (command === "teach" && args[0] === "instagram") {
    await teachInstagram();
    return;
  }

  if (command === "begin-task") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const intent = String(parsed.args.intent || "");
    const taskStartedAt = new Date().toISOString();
    console.log(
      JSON.stringify(
        {
          domain,
          intent: intent || undefined,
          taskStartedAt,
          contractPaths: [
            `packages/cartographer/skills/${domain}/SKILL.md`,
            `packages/cartographer/skills/${domain}/manifest.json`,
          ],
          fallbackCommand: `node packages/cartographer/dist/cli.js fallback ${domain} --intent ${JSON.stringify(intent || "<task>")}`,
          requiredReviewCommand: `node packages/cartographer/dist/cli.js end-task-review ${domain} --since ${JSON.stringify(taskStartedAt)}`,
          acquisitionPolicy:
            "If fallback recording is used, the task is not complete until end-task-review runs and each reusable fallback is promoted or explicitly rejected/deleted.",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "fallback") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const intent = String(parsed.args.intent || "");
    if (!intent) {
      throw new Error("Usage: cartographer fallback instagram.com --intent <task>");
    }
    await runPlaywrightFallbackPrompt({
      domain,
      intent,
      actionCache: new JsonStateActionCache(),
      saveFallback: async (tape) => {
        await new JsonFallbackTapeStore().save(tape);
      },
    });
    return;
  }

  if (command === "teach-stagehand" && args[0] === "instagram") {
    await teachInstagram();
    return;
  }

  if (command === "emit-cli") {
    const domain = parseDomain(args[0]);
    const result = await emitCli(domain);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "emit-skill") {
    const domain = parseDomain(args[0]);
    const outputPath = await emitSkillMd(domain);
    const manifestOutputPath = await emitSkillManifest(domain);
    console.log(JSON.stringify({ outputPath, manifestOutputPath }, null, 2));
    return;
  }

  if (command === "emit-manifest") {
    const domain = parseDomain(args[0]);
    const outputPath = await emitSkillManifest(domain);
    console.log(JSON.stringify({ outputPath }, null, 2));
    return;
  }

  if (command === "expose-skills") {
    const domain = parseDomain(args[0]);
    const homeOnly = args.includes("--home-only");
    const outputPath = homeOnly
      ? await emitSkillMd(domain)
      : await emitSkillMd(domain, path.resolve(process.cwd(), "packages", "cartographer", "skills", domain, "SKILL.md"));
    const manifestOutputPath = homeOnly
      ? await emitSkillManifest(domain)
      : await emitSkillManifest(
          domain,
          path.resolve(process.cwd(), "packages", "cartographer", "skills", domain, "manifest.json"),
        );
    console.log(JSON.stringify({ outputPath, manifestOutputPath }, null, 2));
    return;
  }

  if (command === "capture-fallback") {
    const domain = parseDomain(args[0]);
    const processName = args[1];
    if (!processName) {
      throw new Error("Usage: cartographer capture-fallback instagram.com <process> --intent <intent>");
    }
    const parsed = parseRuntimeArgs(args.slice(2));
    const intent = String(parsed.args.intent || "");
    if (!intent) {
      throw new Error("Usage: cartographer capture-fallback instagram.com <process> --intent <intent>");
    }
    const process = await new JsonTapeStore().loadProcess(domain, processName);
    if (!process) throw new Error(`Unknown process: ${processName}`);
    const now = new Date().toISOString();
    const tape = {
      id: sha256({ domain, processName, intent, createdAt: now }),
      domain,
      intent,
      source: "imported_process" as const,
      status: "succeeded" as const,
      entry: process.entry,
      steps: process.steps,
      operations: process.steps.map((step, index) => ({
        id: sha256({ domain, processName, stepId: step.id, operationIndex: index, createdAt: now }),
        kind: "record_step" as const,
        instruction: `import process step ${step.name}`,
        urlBefore: step.before.url,
        urlAfter: step.after.url,
        selector: step.actions[0]?.selector,
        selectorKind: classifySelector(step.actions[0]?.selector || ""),
        stepId: step.id,
        writesToPlatform: step.writesToPlatform,
        createdAt: now,
      })),
      evidence: [] as EvidenceArtifact[],
      args: process.args,
      writesToPlatform: process.writesToPlatform,
      recordingStartedAt: now,
      createdAt: now,
      completedAt: now,
    };
    await new JsonFallbackTapeStore().save(tape);
    console.log(JSON.stringify({ fallbackTapeId: tape.id, stepCount: tape.steps.length }, null, 2));
    return;
  }

  if (command === "review-fallbacks") {
    const domain = parseDomain(args[0]);
    const result = await createFallbackReviewer().review(domain);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "end-task-review") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const decisionAction = String(parsed.args.decision || "");
    const decisions = decisionAction
      ? [
          {
            ...createEndOfTaskDecisionFromCli({
              action: decisionAction,
              fallbackTapeId: String(parsed.args.fallbackId || ""),
              commandName: parsed.args.commandName ? String(parsed.args.commandName) : undefined,
              description: parsed.args.description ? String(parsed.args.description) : undefined,
              reason: parsed.args.reason ? String(parsed.args.reason) : undefined,
            }),
            ...(decisionAction === "promote"
              ? {
                  outputs: parseOutputs(args.slice(1)),
                  postconditions: parsePostconditions(args.slice(1)),
                }
              : {}),
          },
        ]
      : undefined;
    const result = await createEndOfTaskReviewer().reviewCompletedTask({
      domain,
      taskStartedAt: parsed.args.since ? String(parsed.args.since) : undefined,
      decisions,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "inspect-fallback") {
    const domain = parseDomain(args[0]);
    const fallbackTapeId = args[1];
    if (!fallbackTapeId) {
      throw new Error("Usage: cartographer inspect-fallback instagram.com <fallback-id>");
    }
    const result = await createFallbackReviewer().inspect(domain, fallbackTapeId);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "create-promotion-review") {
    const domain = parseDomain(args[0]);
    const fallbackTapeId = args[1];
    if (!fallbackTapeId) {
      throw new Error("Usage: cartographer create-promotion-review instagram.com <fallback-id>");
    }
    const artifacts = await createPromotionReviewArtifacts({
      domain,
      fallbackTapeId,
      fallbackStore: new JsonFallbackTapeStore(),
      tapeStore: new JsonTapeStore(),
    });
    console.log(JSON.stringify({
      reviewPath: artifacts.reviewPath,
      reviewRequestPath: artifacts.reviewRequestPath,
      decisionSchemaPath: artifacts.decisionSchemaPath,
      decisionTemplatePath: artifacts.decisionTemplatePath,
      applyDecisionCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
    }, null, 2));
    return;
  }

  if (command === "apply-promotion-decision") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const decisionFile = String(parsed.args.decisionFile || "");
    if (!decisionFile) {
      throw new Error("Usage: cartographer apply-promotion-decision instagram.com --decision-file <decision.json>");
    }
    const decision = await readPromotionDecisionFile(path.resolve(process.cwd(), decisionFile));
    const result = await createPromotionDecisionApplier().apply(domain, decision);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "promote-fallback") {
    const domain = parseDomain(args[0]);
    const fallbackTapeId = args[1];
    if (!fallbackTapeId) {
      throw new Error("Usage: cartographer promote-fallback instagram.com <fallback-id> --command-name <snake_case> --description <text> [--output name:selector:description]");
    }
    const parsed = parseRuntimeArgs(args.slice(2));
    const commandName = String(parsed.args.commandName || "");
    const description = String(parsed.args.description || "");
    if (!commandName || !description) {
      throw new Error("Usage: cartographer promote-fallback instagram.com <fallback-id> --command-name <snake_case> --description <text> [--output name:selector:description]");
    }
    const result = await createSkillPromoter().promote(domain, fallbackTapeId, {
      commandName,
      description,
      outputs: parseOutputs(args.slice(2)),
      postconditions: parsePostconditions(args.slice(2)),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "reject-fallback") {
    const domain = parseDomain(args[0]);
    const fallbackTapeId = args[1];
    if (!fallbackTapeId) {
      throw new Error("Usage: cartographer reject-fallback instagram.com <fallback-id> --reason <reason>");
    }
    const parsed = parseRuntimeArgs(args.slice(2));
    const reason = String(parsed.args.reason || "");
    if (!reason) {
      throw new Error("Usage: cartographer reject-fallback instagram.com <fallback-id> --reason <reason>");
    }
    await new JsonFallbackTapeStore().reject(domain, fallbackTapeId, reason);
    console.log(JSON.stringify({ rejected: fallbackTapeId, reason }, null, 2));
    return;
  }

  if (command === "delete-fallback") {
    const domain = parseDomain(args[0]);
    const fallbackTapeId = args[1];
    if (!fallbackTapeId) {
      throw new Error("Usage: cartographer delete-fallback instagram.com <fallback-id>");
    }
    await new JsonFallbackTapeStore().delete(domain, fallbackTapeId);
    console.log(JSON.stringify({ deleted: fallbackTapeId }, null, 2));
    return;
  }

  if (command === "scripted-dm") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const recipient = String(parsed.args.recipient || "va_rad_");
    if (recipient !== "va_rad_") {
      throw new Error("V1 safety gate only allows --recipient va_rad_");
    }
    const message = String(parsed.args.message || "");
    if (!message) {
      throw new Error("Usage: cartographer scripted-dm instagram.com --recipient va_rad_ --message <text> --confirm-write");
    }
    const assumeLoggedIn = parsed.args.assumeLoggedIn === true;
    const username = assumeLoggedIn ? undefined : process.env.INSTAGRAM_USERNAME;
    const password = assumeLoggedIn ? undefined : process.env.INSTAGRAM_PASSWORD;
    if (!assumeLoggedIn && (!username || !password)) {
      throw new Error("Set INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD in the environment.");
    }
    const session = await new StagehandBrowserSessionFactory().launchInstagram({
      browser: "local",
      cacheDir: `${cartographerHome()}/stagehand-cache`,
      headless: false,
      viewport: { width: 1288, height: 900 },
    });
    try {
      const process = await recordScriptedInstagramDm(
        session,
        new BasicStateIdentity(),
        new JsonTapeStore(),
        new JsonStateActionCache(),
        {
          username,
          password,
          recipient,
          message,
          confirmWrite: parsed.confirmWrite,
          assumeLoggedIn,
        },
      );
      console.log(`recorded ${domain} process ${process.name} with ${process.steps.length} step(s)`);
    } finally {
      await session.close();
    }
    return;
  }

  if (command === "run") {
    const domain = parseDomain(args[0]);
    const processName = args[1];
    if (!processName) throw new Error("Usage: cartographer run instagram.com <process>");
    const parsed = parseRuntimeArgs(args.slice(2));
    const runtime = await createPreloadedRuntime(domain);
    const result = await runtime.runProcess({
      domain,
      processName,
      args: parsed.args,
      confirmWrite: parsed.confirmWrite,
      dryRun: parsed.dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function teachInstagram(options?: { domain?: Domain; fallbackIntent?: string; reviewAtEnd?: boolean }): Promise<void> {
  const domain = options?.domain || "instagram.com";
  const factory = new StagehandBrowserSessionFactory();
  const session = await factory.launchInstagram({
    browser: "local",
    cacheDir: `${cartographerHome()}/stagehand-cache`,
    headless: false,
    viewport: { width: 1288, height: 900 },
  });
  const recorder = new ProcessTapeRecorder(
    session,
    new BasicStateIdentity(),
    new JsonTapeStore(),
    new JsonStateActionCache(),
  );

  console.log("Opened Instagram in a Stagehand local Chrome session.");
  console.log("Log in manually if needed, then use commands below.");
  if (options?.fallbackIntent) {
    console.log(`Fallback intent: ${options.fallbackIntent}`);
    console.log(`After recording steps, run: save-fallback [--write] [--arg message]`);
  }
  printTeachHelp();

  const rl = readline.createInterface({ input, output });
  const recordedStepIds: string[] = [];
  try {
    for (;;) {
      const line = (await rl.question("cartographer> ")).trim();
      if (!line) continue;
      const [cmd, ...rest] = splitCommandLine(line);

      if (cmd === "help") {
        printTeachHelp();
      } else if (cmd === "snapshot") {
        const label = rest.join("-") || "snapshot";
        const state = await recorder.snapshot(label);
        console.log(`state ${state.id.slice(0, 10)} atoms=${state.atoms.length} url=${state.url}`);
      } else if (cmd === "observe") {
        const instruction = rest.join(" ");
        if (!instruction) {
          console.log("Usage: observe <instruction>");
          continue;
        }
        const candidates = await recorder.observe(instruction);
        for (const candidate of candidates) {
          console.log(
            `${candidate.id} [${candidate.risk}] ${candidate.action.method || "?"} ${candidate.action.description}`,
          );
        }
      } else if (cmd === "act") {
        const candidateId = rest[0];
        if (!candidateId) {
          console.log("Usage: act <candidate-id>");
          continue;
        }
        const result = await recorder.act(candidateId);
        console.log(`${result.success ? "ok" : "failed"} ${result.message}`);
      } else if (cmd === "record-step") {
        const name = rest.find((part) => !part.startsWith("--"));
        if (!name) {
          console.log("Usage: record-step <name> [--write]");
          continue;
        }
        const step = await recorder.recordLastStep(name, {
          writesToPlatform: rest.includes("--write"),
        });
        recordedStepIds.push(step.id);
        console.log(`step ${step.name} ${step.id.slice(0, 10)} write=${step.writesToPlatform}`);
      } else if (cmd === "name-process") {
        const name = rest[0];
        if (!name) {
          console.log("Usage: name-process <name> [step-id ...] [--write] [--arg message]");
          continue;
        }
        const stepIds = rest.filter((part) => /^[a-f0-9]{64}$/.test(part));
        const argNames = collectFlagValues(rest, "--arg");
        const process = await recorder.nameProcess({
          name,
          description: name.replace(/_/g, " "),
          stepIds: stepIds.length ? stepIds : recordedStepIds,
          args: argNames.map((argName): ProcessArg => ({
            name: argName,
            required: true,
            description: `${argName} argument`,
          })),
          writesToPlatform: rest.includes("--write"),
        });
        console.log(`process ${process.name} steps=${process.steps.length} write=${process.writesToPlatform}`);
      } else if (cmd === "save-fallback") {
        const argNames = collectFlagValues(rest, "--arg");
        const intent = collectFreeText(rest, ["--arg", "--write"]) || options?.fallbackIntent;
        if (!intent) {
          console.log("Usage: save-fallback <intent> [step-id ...] [--write] [--arg message]");
          continue;
        }
        const stepIds = rest.filter((part) => /^[a-f0-9]{64}$/.test(part));
        const steps = recorder.getRecordedSteps(stepIds.length ? stepIds : recordedStepIds);
        const fallback = await saveFallbackTape({
          domain,
          intent,
          steps,
          argNames,
          writesToPlatform: rest.includes("--write") || steps.some((step) => step.writesToPlatform),
        });
        console.log(`fallback ${fallback.id.slice(0, 10)} steps=${fallback.steps.length} write=${fallback.writesToPlatform}`);
      } else if (cmd === "save") {
        const catalog = await recorder.save();
        console.log(`saved ${Object.keys(catalog.processes).length} process(es)`);
      } else if (cmd === "emit-cli") {
        const result = await new NodeCliEmitter().emit({
          domain: "instagram.com",
          tapeDir: tapeDir("instagram.com"),
          outputPath: `${binDir()}/instagram-com-cli`,
          binName: "instagram-com-cli",
        });
        console.log(`emitted ${result.outputPath}`);
      } else if (cmd === "quit" || cmd === "exit") {
        break;
      } else {
        console.log(`Unknown teach command: ${cmd}`);
      }
    }
  } finally {
    rl.close();
    await session.close();
  }

  if (options?.reviewAtEnd) {
    const result = await createFallbackReviewer().review(domain);
    console.log(JSON.stringify({ endOfTaskReview: result }, null, 2));
  }
}

function printHelp(): void {
  console.log(`cartographer commands:
  cartographer begin-task instagram.com --intent <task>
  cartographer fallback instagram.com --intent <task>
  cartographer teach-stagehand instagram
  cartographer scripted-dm instagram.com --recipient va_rad_ --message "testing this" --confirm-write [--assume-logged-in]
  cartographer emit-cli instagram.com
  cartographer emit-skill instagram.com
  cartographer emit-manifest instagram.com
  cartographer expose-skills instagram.com [--home-only]
  cartographer capture-fallback instagram.com <process> --intent <intent>
  cartographer review-fallbacks instagram.com
  cartographer end-task-review instagram.com [--since <iso>] [--decision promote|reject|delete --fallback-id <id> ...]
  cartographer inspect-fallback instagram.com <fallback-id>
  cartographer create-promotion-review instagram.com <fallback-id>
  cartographer apply-promotion-decision instagram.com --decision-file <decision.json>
  cartographer promote-fallback instagram.com <fallback-id> --command-name <snake_case> --description <text> [--output name:selector:description] [--postcondition type:value]
  cartographer reject-fallback instagram.com <fallback-id> --reason <reason>
  cartographer delete-fallback instagram.com <fallback-id>
  cartographer run instagram.com <process> [--dry-run] [--confirm-write]`);
}

function printTeachHelp(): void {
  console.log(`teach commands:
  snapshot <label>
  observe <instruction>
  act <candidate-id>
  record-step <name> [--write]
  name-process <name> [step-id ...] [--write] [--arg message]
  save-fallback <intent> [step-id ...] [--write] [--arg message]
  save
  emit-cli
  quit`);
}

function parseDomain(value: string | undefined): Domain {
  if (value === "instagram.com") return value;
  throw new Error("Only instagram.com is supported in v1.");
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

function collectFreeText(parts: string[], flagsWithValue: string[]): string {
  const values: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.startsWith("--")) {
      if (flagsWithValue.includes(part)) index += 1;
      continue;
    }
    if (/^[a-f0-9]{64}$/.test(part)) continue;
    values.push(part);
  }
  return values.join(" ").trim();
}

async function emitCli(domain: Domain) {
  return await new NodeCliEmitter().emit({
    domain,
    tapeDir: tapeDir(domain),
    outputPath: `${binDir()}/instagram-com-cli`,
    binName: "instagram-com-cli",
  });
}

function createFallbackReviewer(): DefaultFallbackReviewer {
  return new DefaultFallbackReviewer(new JsonFallbackTapeStore(), new JsonTapeStore(), new ConsoleCartographerLogger());
}

function createSkillPromoter(): DefaultSkillPromoter {
  const logger = new ConsoleCartographerLogger();
  return new DefaultSkillPromoter(
    new JsonFallbackTapeStore(),
    new JsonPromotionStore(),
    new JsonTapeStore(),
    logger,
  );
}

function createEndOfTaskReviewer(): DefaultEndOfTaskReviewer {
  const fallbackStore = new JsonFallbackTapeStore();
  const logger = new ConsoleCartographerLogger();
  return new DefaultEndOfTaskReviewer(
    new DefaultFallbackReviewer(fallbackStore, new JsonTapeStore(), logger),
    fallbackStore,
    new DefaultSkillPromoter(fallbackStore, new JsonPromotionStore(), new JsonTapeStore(), logger),
    logger,
  );
}

function createPromotionDecisionApplier(): DefaultPromotionDecisionApplier {
  const fallbackStore = new JsonFallbackTapeStore();
  return new DefaultPromotionDecisionApplier(
    fallbackStore,
    new DefaultSkillPromoter(
      fallbackStore,
      new JsonPromotionStore(),
      new JsonTapeStore(),
      new ConsoleCartographerLogger(),
    ),
  );
}

function parseOutputs(parts: string[]): ProcessOutput[] | undefined {
  const values = collectFlagValues(parts, "--output");
  if (!values.length) return undefined;
  return values.map((value) => {
    const [name, selector, ...descriptionParts] = value.split(":");
    const description = descriptionParts.join(":").trim();
    if (!name || !selector || !description) {
      throw new Error("--output must use name:selector:description");
    }
    return {
      name,
      source: "text",
      selector,
      description,
    };
  });
}

function parsePostconditions(parts: string[]): Postcondition[] | undefined {
  const values = collectFlagValues(parts, "--postcondition");
  if (!values.length) return undefined;
  return values.map((value) => {
    const [type, ...rest] = value.split(":");
    const payload = rest.join(":").trim();
    if (!type || !payload) {
      throw new Error("--postcondition must use type:value");
    }
    if (type === "url_equals" || type === "url_contains") {
      return { type, value: payload };
    }
    if (type === "selector_exists") {
      return { type, selector: payload };
    }
    if (type === "text_contains") {
      const [selector, ...textParts] = payload.split("=");
      const text = textParts.join("=").trim();
      if (!selector || !text) {
        throw new Error("--postcondition text_contains must use text_contains:selector=value");
      }
      return { type, selector, value: text };
    }
    throw new Error(`Unsupported --postcondition type: ${type}`);
  });
}

async function saveFallbackTape(input: {
  domain: Domain;
  intent: string;
  steps: TapeStep[];
  argNames: string[];
  writesToPlatform: boolean;
}) {
  const now = new Date().toISOString();
  const argNames = unique([...input.argNames, ...placeholderArgNames(input.steps)]);
  const tape = {
    id: sha256({
      domain: input.domain,
      intent: input.intent,
      stepIds: input.steps.map((step) => step.id),
      createdAt: now,
    }),
    domain: input.domain,
    intent: input.intent,
    source: "stagehand_fallback" as const,
    status: "succeeded" as const,
    entry: input.steps[0].before,
    steps: input.steps,
    operations: input.steps.map((step, index) => ({
      id: sha256({ domain: input.domain, intent: input.intent, stepId: step.id, operationIndex: index, createdAt: now }),
      kind: "record_step" as const,
      instruction: `record-step ${step.name}`,
      urlBefore: step.before.url,
      urlAfter: step.after.url,
      selector: step.actions[0]?.selector,
      selectorKind: classifySelector(step.actions[0]?.selector || ""),
      stepId: step.id,
      writesToPlatform: step.writesToPlatform,
      createdAt: now,
    })),
    evidence: [] as EvidenceArtifact[],
    args: argNames.map((argName) => ({
      name: argName,
      required: true,
      description: `${argName} argument`,
    })),
    writesToPlatform: input.writesToPlatform,
    recordingStartedAt: now,
    createdAt: now,
    completedAt: now,
  };
  await new JsonFallbackTapeStore().save(tape);
  return tape;
}

function classifySelector(selector: string): "xpath" | "css" | "url" | "unknown" {
  if (selector.startsWith("http://") || selector.startsWith("https://")) return "url";
  if (selector.startsWith("xpath=") || selector.startsWith("/")) return "xpath";
  if (selector.trim()) return "css";
  return "unknown";
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

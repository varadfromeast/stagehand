import path from "node:path";
import type {
  AgentContractDelta,
  CartographerLogger,
  Domain,
  FallbackTapeId,
  FallbackTapeStore,
  PromotionOptions,
  PromotionPolicy,
  PromotionResult,
  PromotionStore,
  ReusableCommandReference,
  SkillPromoter,
  TapeStore,
} from "./contracts.js";
import { NodeCliEmitter } from "./cli-emitter.js";
import { applyPromotion, createPromotionProposal } from "./promotion-reviewer.js";
import { V1PromotionPolicy } from "./promotion-policy.js";
import { emitSkillManifest, emitSkillMd } from "./skill-emitter.js";
import { binDir, slugifyName, tapeDir } from "./paths.js";
import { ConsoleCartographerLogger } from "./logger.js";

export class DefaultSkillPromoter implements SkillPromoter {
  constructor(
    private readonly fallbackStore: FallbackTapeStore,
    private readonly promotionStore: PromotionStore,
    private readonly tapeStore: TapeStore,
    private readonly logger: CartographerLogger = new ConsoleCartographerLogger(),
    private readonly promotionPolicy: PromotionPolicy = new V1PromotionPolicy(),
  ) {}

  async promote(
    domain: Domain,
    fallbackTapeId: FallbackTapeId,
    options: PromotionOptions,
  ): Promise<PromotionResult> {
    this.logger.log("info", "skill_promoter.start", {
      domain,
      fallbackTapeId,
      commandName: options.commandName,
    });
    const tape = await this.fallbackStore.load(domain, fallbackTapeId);
    if (!tape) throw new Error(`Unknown fallback tape: ${fallbackTapeId}`);
    const catalog = await this.tapeStore.loadCatalog(domain);
    const policy = this.promotionPolicy.evaluate({
      tape,
      commandName: options.commandName,
      description: options.description,
      outputs: options.outputs,
      postconditions: options.postconditions,
      existingProcessNames: Object.keys(catalog?.processes || {}),
    });
    if (!policy.accepted) {
      const summary = policy.findings
        .filter((finding) => finding.severity === "error")
        .map((finding) => `${finding.code}: ${finding.message}`)
        .join("; ");
      throw new Error(`Promotion rejected by V1 policy. ${summary}`);
    }
    const proposal = createPromotionProposal({
      tape,
      commandName: options.commandName,
      description: options.description,
      outputs: options.outputs,
      postconditions: policy.effectivePostconditions,
      writesToPlatform: policy.writesToPlatform,
      existingProcessNames: Object.keys(catalog?.processes || {}),
      policyDecision: policy,
    });
    await this.promotionStore.save(proposal);
    const promotedProcess = await applyPromotion(
      proposal,
      tape,
      this.tapeStore,
      this.promotionStore,
    );
    await this.fallbackStore.markPromoted(domain, tape.id, promotedProcess.name);
    const emittedCli = await new NodeCliEmitter().emit({
      domain,
      tapeDir: tapeDir(domain),
      outputPath: `${binDir()}/instagram-com-cli`,
      binName: "instagram-com-cli",
    });
    const emittedSkillPath = await emitSkillMd(domain);
    const emittedManifestPath = await emitSkillManifest(domain);
    const exposedSkillPath = await emitSkillMd(
      domain,
      path.resolve(process.cwd(), "packages", "cartographer", "skills", domain, "SKILL.md"),
    );
    const exposedManifestPath = await emitSkillManifest(
      domain,
      path.resolve(process.cwd(), "packages", "cartographer", "skills", domain, "manifest.json"),
    );
    const cliCommandName = slugifyName(promotedProcess.name);
    const argPattern = promotedProcess.args
      .map((arg) => ` --${toCliFlag(arg.name)} <${arg.name}>`)
      .join("");
    const command = `${emittedCli.outputPath} ${cliCommandName}${argPattern}${
      promotedProcess.writesToPlatform ? " --confirm-write" : ""
    }`;
    const dryRunCommand = promotedProcess.writesToPlatform
      ? `${emittedCli.outputPath} ${cliCommandName}${argPattern} --dry-run`
      : undefined;
    const reusableCommand: ReusableCommandReference = {
      cliPath: emittedCli.outputPath,
      command,
      dryRunCommand,
      helpCommand: `${emittedCli.outputPath} ${cliCommandName} --help`,
      skillPath: exposedSkillPath,
      manifestPath: exposedManifestPath,
    };
    const agentContractDelta: AgentContractDelta = {
      schemaVersion: 1,
      kind: "command_added",
      domain,
      commandName: cliCommandName,
      processName: promotedProcess.name,
      description: promotedProcess.description,
      writesToPlatform: promotedProcess.writesToPlatform,
      args: promotedProcess.args,
      outputs: promotedProcess.outputs || [],
      postconditions: promotedProcess.postconditions || [],
      reusableCommand,
      refreshCommands: [
        `node packages/cartographer/dist/cli.js expose-skills ${domain}`,
        `${emittedCli.outputPath} --help`,
        `${emittedCli.outputPath} ${cliCommandName} --help`,
      ],
      agentInstruction:
        "Update your working command contract with this added command immediately. Prefer reusableCommand.command for future matching tasks instead of entering fallback again.",
    };
    this.logger.log("info", "skill_promoter.done", {
      domain,
      processName: promotedProcess.name,
      cliCommandName,
      emittedCli: emittedCli.outputPath,
      emittedSkillPath,
      emittedManifestPath,
      exposedSkillPath,
      exposedManifestPath,
    });
    return {
      proposal,
      processName: promotedProcess.name,
      cliCommandName,
      reusableCommand,
      agentContractDelta,
      policy,
      emittedCli,
      emittedSkillPath,
      emittedManifestPath,
      exposedSkillPath,
      exposedManifestPath,
    };
  }
}

function toCliFlag(argName: string): string {
  return argName.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

import type {
  FallbackTape,
  ProcessTape,
  PromotionProposal,
  PromotionPolicyDecision,
  PromotionStore,
  TapeStore,
} from "./contracts.js";
import { sha256 } from "./hash.js";
import { deriveWritesToPlatform, inferPostconditionsFromTape } from "./promotion-policy.js";

export function createPromotionProposal(input: {
  tape: FallbackTape;
  commandName: string;
  description: string;
  outputs?: ProcessTape["outputs"];
  postconditions?: ProcessTape["postconditions"];
  writesToPlatform?: boolean;
  existingProcessNames: string[];
  policyDecision?: PromotionPolicyDecision;
}): PromotionProposal {
  const now = new Date().toISOString();
  const commandName = input.commandName.trim();
  const description = input.description.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(commandName)) {
    throw new Error("Command name must be snake_case, for example send_message.");
  }
  if (!description) {
    throw new Error("Promotion requires an explicit --description so SKILL.md does not overstate what the tape does.");
  }
  if (input.tape.status !== "succeeded") {
    throw new Error("Cannot promote a failed fallback tape.");
  }
  if (input.tape.promotedAt) {
    throw new Error("Fallback tape has already been promoted.");
  }
  if (input.existingProcessNames.includes(commandName)) {
    throw new Error(`Command already exists: ${commandName}`);
  }

  return {
    id: sha256({
      tapeId: input.tape.id,
      commandName,
      createdAt: now,
    }),
    fallbackTapeId: input.tape.id,
    domain: input.tape.domain,
    decision: "promote",
    commandName,
    description,
    args: input.tape.args,
    outputs: input.outputs,
    postconditions: input.postconditions,
    writesToPlatform: input.writesToPlatform ?? deriveWritesToPlatform(input.tape),
    reason: input.policyDecision?.reason || "Explicit promotion requested by the calling agent.",
    reviewer: "agent",
    policyFindings: input.policyDecision?.findings,
    createdAt: now,
  };
}

export async function applyPromotion(
  proposal: PromotionProposal,
  tape: FallbackTape,
  tapeStore: TapeStore,
  promotionStore: PromotionStore,
): Promise<ProcessTape> {
  if (proposal.decision !== "promote" || !proposal.commandName) {
    throw new Error(`Promotion proposal is not promotable: ${proposal.reason}`);
  }

  const now = new Date().toISOString();
  const process: ProcessTape = {
    name: proposal.commandName,
    description: proposal.description || tape.intent,
    domain: tape.domain,
    entry: tape.entry,
    steps: tape.steps,
    args: proposal.args || tape.args,
    outputs: proposal.outputs,
    postconditions: proposal.postconditions || inferPostconditionsFromTape(tape),
    writesToPlatform: proposal.writesToPlatform ?? deriveWritesToPlatform(tape),
    createdAt: now,
    updatedAt: now,
  };
  await tapeStore.saveProcess(process);
  await promotionStore.markApplied(proposal.domain, proposal.id);
  return process;
}

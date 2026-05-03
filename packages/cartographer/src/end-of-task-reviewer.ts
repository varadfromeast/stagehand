import type {
  CartographerLogger,
  Domain,
  EndOfTaskDecision,
  EndOfTaskReviewInput,
  EndOfTaskReviewer,
  EndOfTaskReviewResult,
  FallbackReviewer,
  FallbackTapeStore,
  SkillPromoter,
} from "./contracts.js";
import { ConsoleCartographerLogger } from "./logger.js";

export class DefaultEndOfTaskReviewer implements EndOfTaskReviewer {
  constructor(
    private readonly fallbackReviewer: FallbackReviewer,
    private readonly fallbackStore: FallbackTapeStore,
    private readonly skillPromoter: SkillPromoter,
    private readonly logger: CartographerLogger = new ConsoleCartographerLogger(),
  ) {}

  async reviewCompletedTask(input: EndOfTaskReviewInput): Promise<EndOfTaskReviewResult> {
    this.logger.log("info", "end_task_review.start", {
      domain: input.domain,
      taskStartedAt: input.taskStartedAt,
      decisionCount: input.decisions?.length || 0,
    });
    const review = await this.fallbackReviewer.review(input.domain);
    const scopedReview = input.taskStartedAt
      ? {
          ...review,
          unpromotedFallbacks: await filterPacketsCreatedAfter(
            input.domain,
            input.taskStartedAt,
            review.unpromotedFallbacks,
            this.fallbackStore,
          ),
        }
      : review;

    const promotions = [];
    const appliedDecisions: EndOfTaskDecision[] = [];
    for (const decision of input.decisions || []) {
      this.logger.log("info", "end_task_review.decision", {
        action: decision.action,
        fallbackTapeId: decision.fallbackTapeId,
      });
      if (decision.action === "promote") {
        promotions.push(
          await this.skillPromoter.promote(input.domain, decision.fallbackTapeId, {
            commandName: decision.commandName,
            description: decision.description,
            outputs: decision.outputs,
            postconditions: decision.postconditions,
          }),
        );
        appliedDecisions.push(decision);
      } else if (decision.action === "reject") {
        await this.fallbackStore.reject(input.domain, decision.fallbackTapeId, decision.reason);
        appliedDecisions.push(decision);
      } else if (decision.action === "delete") {
        await this.fallbackStore.delete(input.domain, decision.fallbackTapeId);
        appliedDecisions.push(decision);
      }
    }

    return {
      review: scopedReview,
      appliedDecisions,
      promotions,
    };
  }
}

async function filterPacketsCreatedAfter(
  domain: Domain,
  taskStartedAt: string,
  packets: EndOfTaskReviewResult["review"]["unpromotedFallbacks"],
  fallbackStore: FallbackTapeStore,
): Promise<EndOfTaskReviewResult["review"]["unpromotedFallbacks"]> {
  const startedAtMs = Date.parse(taskStartedAt);
  if (Number.isNaN(startedAtMs)) throw new Error(`Invalid taskStartedAt: ${taskStartedAt}`);
  const scoped = [];
  for (const packet of packets) {
    const tape = await fallbackStore.load(domain, packet.id);
    if (!tape) continue;
    if (Date.parse(tape.createdAt) >= startedAtMs) scoped.push(packet);
  }
  return scoped;
}

export function createEndOfTaskDecisionFromCli(input: {
  action: string;
  fallbackTapeId: string;
  commandName?: string;
  description?: string;
  reason?: string;
}): EndOfTaskDecision {
  if (!input.fallbackTapeId) throw new Error("End-of-task decisions require --fallback-id.");
  if (input.action === "promote") {
    if (!input.commandName || !input.description) {
      throw new Error("Promote decisions require --command-name and --description.");
    }
    return {
      action: "promote",
      fallbackTapeId: input.fallbackTapeId,
      commandName: input.commandName,
      description: input.description,
    };
  }
  if (input.action === "reject") {
    if (!input.reason) throw new Error("Reject decisions require --reason.");
    return {
      action: "reject",
      fallbackTapeId: input.fallbackTapeId,
      reason: input.reason,
    };
  }
  if (input.action === "delete") {
    return {
      action: "delete",
      fallbackTapeId: input.fallbackTapeId,
    };
  }
  throw new Error(`Unknown end-of-task decision action: ${input.action}`);
}

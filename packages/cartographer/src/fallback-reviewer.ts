import type {
  CartographerLogger,
  Domain,
  FallbackReviewPacket,
  FallbackReviewResult,
  FallbackReviewer,
  FallbackTapeStore,
  TapeStore,
} from "./contracts.js";
import { createPromotionReviewArtifacts } from "./promotion-decision.js";
import { ConsoleCartographerLogger } from "./logger.js";

export class DefaultFallbackReviewer implements FallbackReviewer {
  constructor(
    private readonly fallbackStore: FallbackTapeStore,
    private readonly tapeStore: TapeStore,
    private readonly logger: CartographerLogger = new ConsoleCartographerLogger(),
  ) {}

  async review(domain: Domain): Promise<FallbackReviewResult> {
    this.logger.log("info", "fallback_review.start", { domain });
    const catalog = await this.tapeStore.loadCatalog(domain);
    const tapes = (await this.fallbackStore.list(domain)).filter(
      (tape) => !tape.promotedAt && tape.status !== "rejected",
    );
    const packets: FallbackReviewPacket[] = [];
    for (const tape of tapes) {
      const artifacts = await createPromotionReviewArtifacts({
        domain,
        fallbackTapeId: tape.id,
        fallbackStore: this.fallbackStore,
        tapeStore: this.tapeStore,
      });
      packets.push(artifacts.request.reviewPacket);
    }
    this.logger.log("info", "fallback_review.done", {
      domain,
      existingProcessCount: Object.keys(catalog?.processes || {}).length,
      unpromotedFallbackCount: packets.length,
    });
    return {
      existingProcesses: Object.keys(catalog?.processes || {}).sort(),
      unpromotedFallbacks: packets,
    };
  }

  async inspect(domain: Domain, id: string): Promise<FallbackReviewPacket> {
    this.logger.log("info", "fallback_review.inspect", { domain, id });
    const tape = await this.fallbackStore.load(domain, id);
    if (!tape) throw new Error(`Unknown fallback tape: ${id}`);
    const artifacts = await createPromotionReviewArtifacts({
      domain,
      fallbackTapeId: tape.id,
      fallbackStore: this.fallbackStore,
      tapeStore: this.tapeStore,
    });
    return artifacts.request.reviewPacket;
  }
}

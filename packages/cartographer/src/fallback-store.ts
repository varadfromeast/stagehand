import type {
  Domain,
  FallbackTape,
  FallbackTapeId,
  FallbackTapeStore,
  ProcessName,
  PromotionProposal,
  PromotionProposalId,
  PromotionStore,
} from "./contracts.js";
import fs from "node:fs/promises";
import {
  fallbackDir,
  fallbackReviewPath,
  fallbackTapeDir,
  fallbackTapeJsonPath,
  fallbackTapePath,
  promotionDir,
  promotionProposalPath,
} from "./paths.js";
import { ensureDir, listDirEntries, listJsonFiles, readJsonFile, writeJsonFile } from "./fs-json.js";
import { writeFallbackReviewMarkdown } from "./review-packet.js";

export class JsonFallbackTapeStore implements FallbackTapeStore {
  async list(domain: Domain): Promise<FallbackTape[]> {
    const flat = await listJsonFiles<FallbackTape>(fallbackDir(domain));
    const structured: FallbackTape[] = [];
    for (const entry of await listDirEntries(fallbackDir(domain))) {
      const tape = await readJsonFile<FallbackTape>(fallbackTapeJsonPath(domain, entry));
      if (tape) structured.push(tape);
    }
    const byId = new Map<string, FallbackTape>();
    for (const tape of [...flat, ...structured]) byId.set(tape.id, normalizeTape(tape));
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async load(domain: Domain, id: FallbackTapeId): Promise<FallbackTape | null> {
    const structured = await readJsonFile<FallbackTape>(fallbackTapeJsonPath(domain, id));
    if (structured) return normalizeTape(structured);
    const flat = await readJsonFile<FallbackTape>(fallbackTapePath(domain, id));
    return flat ? normalizeTape(flat) : null;
  }

  async save(tape: FallbackTape): Promise<void> {
    const normalized = normalizeTape(tape);
    await ensureDir(fallbackDir(normalized.domain));
    await ensureDir(fallbackTapeDir(normalized.domain, normalized.id));
    await writeJsonFile(fallbackTapePath(normalized.domain, normalized.id), normalized);
    await writeJsonFile(fallbackTapeJsonPath(normalized.domain, normalized.id), normalized);
    await writeFallbackReviewMarkdown(normalized.domain, normalized);
  }

  async markPromoted(domain: Domain, id: FallbackTapeId, processName: ProcessName): Promise<void> {
    const tape = await this.load(domain, id);
    if (!tape) throw new Error(`Unknown fallback tape: ${id}`);
    await this.save({
      ...tape,
      promotedAt: new Date().toISOString(),
      promotedProcessName: processName,
    });
  }

  async reject(domain: Domain, id: FallbackTapeId, reason: string): Promise<void> {
    const tape = await this.load(domain, id);
    if (!tape) throw new Error(`Unknown fallback tape: ${id}`);
    await this.save({
      ...tape,
      status: "rejected",
      rejectedAt: new Date().toISOString(),
      rejectedReason: reason,
    });
  }

  async delete(domain: Domain, id: FallbackTapeId): Promise<void> {
    await fs.rm(fallbackTapePath(domain, id), { force: true });
    await fs.rm(fallbackReviewPath(domain, id), { force: true });
    await fs.rm(fallbackTapeDir(domain, id), { recursive: true, force: true });
  }
}

export class JsonPromotionStore implements PromotionStore {
  async list(domain: Domain): Promise<PromotionProposal[]> {
    return await listJsonFiles<PromotionProposal>(promotionDir(domain));
  }

  async save(proposal: PromotionProposal): Promise<void> {
    await ensureDir(promotionDir(proposal.domain));
    await writeJsonFile(promotionProposalPath(proposal.domain, proposal.id), proposal);
  }

  async markApplied(domain: Domain, id: PromotionProposalId): Promise<void> {
    const proposal = await readJsonFile<PromotionProposal>(promotionProposalPath(domain, id));
    if (!proposal) throw new Error(`Unknown promotion proposal: ${id}`);
    await this.save({
      ...proposal,
      appliedAt: new Date().toISOString(),
    });
  }
}

function normalizeTape(tape: FallbackTape): FallbackTape {
  return {
    ...tape,
    evidence: tape.evidence || [],
    operations: tape.operations || [],
  };
}

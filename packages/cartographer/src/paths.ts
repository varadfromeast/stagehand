import os from "node:os";
import path from "node:path";
import type { Domain, ProcessName } from "./contracts.js";

export function cartographerHome(): string {
  return process.env.CARTOGRAPHER_HOME || path.join(os.homedir(), ".cartographer");
}

export function siteDir(domain: Domain): string {
  return path.join(cartographerHome(), "sites", domain);
}

export function tapeDir(domain: Domain): string {
  return path.join(siteDir(domain), "tapes");
}

export function processTapePath(domain: Domain, name: ProcessName): string {
  return path.join(tapeDir(domain), `${slugifyName(name)}.json`);
}

export function catalogPath(domain: Domain): string {
  return path.join(siteDir(domain), "catalog.json");
}

export function stateActionCacheDir(domain: Domain): string {
  return path.join(siteDir(domain), "state-action-cache");
}

export function evidenceDir(domain: Domain): string {
  return path.join(siteDir(domain), "evidence");
}

export function fallbackDir(domain: Domain): string {
  return path.join(siteDir(domain), "fallbacks");
}

export function fallbackTapePath(domain: Domain, id: string): string {
  return path.join(fallbackDir(domain), `${slugifyName(id)}.json`);
}

export function fallbackTapeDir(domain: Domain, id: string): string {
  return path.join(fallbackDir(domain), slugifyName(id));
}

export function fallbackTapeJsonPath(domain: Domain, id: string): string {
  return path.join(fallbackTapeDir(domain, id), "fallback.json");
}

export function fallbackReviewPath(domain: Domain, id: string): string {
  return path.join(fallbackTapeDir(domain, id), "REVIEW.md");
}

export function fallbackReviewRequestPath(domain: Domain, id: string): string {
  return path.join(fallbackTapeDir(domain, id), "review-request.json");
}

export function fallbackDecisionSchemaPath(domain: Domain, id: string): string {
  return path.join(fallbackTapeDir(domain, id), "decision-schema.json");
}

export function fallbackDecisionTemplatePath(domain: Domain, id: string): string {
  return path.join(fallbackTapeDir(domain, id), "decision-template.json");
}

export function promotionDir(domain: Domain): string {
  return path.join(siteDir(domain), "promotions");
}

export function promotionProposalPath(domain: Domain, id: string): string {
  return path.join(promotionDir(domain), `${slugifyName(id)}.json`);
}

export function skillDir(domain: Domain, name: ProcessName): string {
  return path.join(siteDir(domain), "skills", slugifyName(name));
}

export function skillProcessPath(domain: Domain, name: ProcessName): string {
  return path.join(skillDir(domain, name), "process.json");
}

export function skillReadmePath(domain: Domain, name: ProcessName): string {
  return path.join(skillDir(domain, name), "SKILL.md");
}

export function skillPath(domain: Domain): string {
  return path.join(siteDir(domain), "SKILL.md");
}

export function manifestPath(domain: Domain): string {
  return path.join(siteDir(domain), "manifest.json");
}

export function auditPath(domain: Domain): string {
  return path.join(siteDir(domain), "audit.jsonl");
}

export function binDir(): string {
  return path.join(cartographerHome(), "bin");
}

export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

import fs from "node:fs/promises";
import path from "node:path";
import type {
  Domain,
  EvidenceArtifact,
  EvidencePreview,
  FallbackReviewPacket,
  FallbackTape,
} from "./contracts.js";
import { createFallbackPromotionSummary } from "./fallback-summary.js";
import {
  fallbackDecisionTemplatePath,
  fallbackDecisionSchemaPath,
  fallbackReviewPath,
  fallbackReviewRequestPath,
} from "./paths.js";
import { ensureDir } from "./fs-json.js";
import { PROMOTION_REVIEW_PROMPT } from "./promotion-review-prompt.js";

export async function createFallbackReviewPacket(
  domain: Domain,
  tape: FallbackTape,
): Promise<FallbackReviewPacket> {
  const evidencePreview = await Promise.all(tape.evidence.map(previewEvidence));
  return {
    id: tape.id,
    domain,
    intent: tape.intent,
    status: tape.status,
    stepCount: tape.steps.length,
    writesToPlatform: tape.writesToPlatform,
    args: tape.args,
    evidence: tape.evidence,
    evidencePreview,
    reviewPath: fallbackReviewPath(domain, tape.id),
    reviewRequestPath: fallbackReviewRequestPath(domain, tape.id),
    decisionSchemaPath: fallbackDecisionSchemaPath(domain, tape.id),
    decisionTemplatePath: fallbackDecisionTemplatePath(domain, tape.id),
    promoteCommand: `node packages/cartographer/dist/cli.js promote-fallback ${domain} ${tape.id} --command-name <snake_case> --description <what-the-tape-does> --output visibleText:body:<what-the-command-returns>`,
    rejectCommand: `node packages/cartographer/dist/cli.js reject-fallback ${domain} ${tape.id} --reason <reason>`,
    applyDecisionCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
  };
}

export async function writeFallbackReviewMarkdown(
  domain: Domain,
  tape: FallbackTape,
): Promise<string> {
  const packet = await createFallbackReviewPacket(domain, tape);
  const outputPath = fallbackReviewPath(domain, tape.id);
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, renderFallbackReview(packet, tape), "utf8");
  return outputPath;
}

function renderFallbackReview(packet: FallbackReviewPacket, tape: FallbackTape): string {
  const summary = createFallbackPromotionSummary(tape, packet.evidencePreview);
  const lines = [
    `# Fallback Review: ${packet.id}`,
    "",
    `- Domain: ${packet.domain}`,
    `- Intent: ${packet.intent}`,
    `- Status: ${packet.status}`,
    `- Writes: ${String(packet.writesToPlatform)}`,
    `- Steps: ${String(packet.stepCount)}`,
    "",
    "## Steps",
    "",
  ];

  for (const [index, step] of tape.steps.entries()) {
    lines.push(`${index + 1}. ${step.name}`);
    lines.push(`   - Type: ${step.type}`);
    lines.push(`   - Instruction: ${step.instruction}`);
    lines.push(`   - Selectors: ${step.actions.map((action) => action.selector).join(", ")}`);
    if (step.validators?.length) {
      lines.push(`   - Validators: ${JSON.stringify(step.validators)}`);
    }
  }

  lines.push("", "## Deterministic Summary", "");
  lines.push(`- Entry URL: ${summary.entryUrl}`);
  lines.push(`- Final URL: ${summary.finalUrl}`);
  if (summary.sessionId) lines.push(`- Session ID: ${summary.sessionId}`);
  if (summary.recordingStartedAt) lines.push(`- Recording started: ${summary.recordingStartedAt}`);
  lines.push(`- Operations logged: ${summary.operationCount}`);
  lines.push(`- Risk flags: ${summary.mechanicalHints.riskFlags.join(", ") || "none"}`);
  lines.push(`- Selector warnings: ${summary.mechanicalHints.selectorWarnings.join(", ") || "none"}`);
  if (summary.mechanicalHints.suggestedPostconditions.length) {
    lines.push("- Suggested postconditions:");
    for (const postcondition of summary.mechanicalHints.suggestedPostconditions) {
      lines.push(`  - ${JSON.stringify(postcondition)}`);
    }
  } else {
    lines.push("- Suggested postconditions: none");
  }
  if (summary.mechanicalHints.textEvidenceSelectors.length) {
    lines.push(`- Text evidence selectors: ${summary.mechanicalHints.textEvidenceSelectors.join(", ")}`);
  }

  if (summary.operations.length) {
    lines.push("", "## Operation Log", "");
    for (const [index, operation] of summary.operations.entries()) {
      const details = [
        operation.selector ? `selector=${operation.selector}` : undefined,
        operation.urlAfter ? `after=${operation.urlAfter}` : undefined,
        operation.evidencePath ? `evidence=${operation.evidencePath}` : undefined,
        operation.stepId ? `step=${operation.stepId.slice(0, 10)}` : undefined,
        operation.writesToPlatform ? "write=true" : undefined,
      ].filter(Boolean);
      lines.push(`${index + 1}. ${operation.kind}: ${operation.instruction}${details.length ? ` (${details.join("; ")})` : ""}`);
    }
  }

  lines.push("", "## Evidence", "");
  for (const evidence of packet.evidencePreview) {
    lines.push(`### ${evidence.kind}: ${evidence.label}`);
    lines.push("");
    lines.push(`Path: ${evidence.path}`);
    if (evidence.selector) lines.push(`Selector: ${evidence.selector}`);
    if (evidence.preview) {
      lines.push("", "```text", evidence.preview, "```");
    }
    lines.push("");
  }

  lines.push("## Agent Promotion Review", "");
  lines.push("Use this prompt for the reasoning step. Return a PromotionDecision JSON object; do not run promotion commands yourself.");
  lines.push("", "```text", PROMOTION_REVIEW_PROMPT, "```", "");
  if (packet.reviewRequestPath) lines.push(`Review request JSON: ${packet.reviewRequestPath}`);
  if (packet.decisionSchemaPath) lines.push(`Decision schema JSON: ${packet.decisionSchemaPath}`);
  if (packet.decisionTemplatePath) lines.push(`Decision template JSON: ${packet.decisionTemplatePath}`);
  if (packet.applyDecisionCommand) {
    lines.push("", "Apply a completed decision with:");
    lines.push("", "```bash", packet.applyDecisionCommand, "```", "");
  }

  lines.push("## Manual Escape Hatch", "");
  lines.push("Use these only for direct/manual operation. Normal agent workflow should produce a decision JSON and let Cartographer apply it.");
  lines.push("");
  lines.push("Promote manually only if this tape is reusable:");
  lines.push("");
  lines.push("```bash", packet.promoteCommand, "```", "");
  lines.push("Reject manually if it is too specific or low quality:");
  lines.push("");
  lines.push("```bash", packet.rejectCommand, "```", "");
  return `${lines.join("\n")}\n`;
}

async function previewEvidence(evidence: EvidenceArtifact): Promise<EvidencePreview> {
  if (evidence.kind !== "text") {
    return {
      kind: evidence.kind,
      label: evidence.label,
      path: evidence.path,
      selector: evidence.selector,
    };
  }
  const raw = await fs.readFile(evidence.path, "utf8").catch(() => "");
  return {
    kind: evidence.kind,
    label: evidence.label,
    path: evidence.path,
    selector: evidence.selector,
    preview: raw.slice(0, 1000),
  };
}

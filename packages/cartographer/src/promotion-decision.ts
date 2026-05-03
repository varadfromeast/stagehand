import fs from "node:fs/promises";
import path from "node:path";
import type {
  Domain,
  FallbackTapeId,
  FallbackTapeStore,
  Postcondition,
  ProcessOutput,
  PromotionDecision,
  PromotionDecisionApplier,
  PromotionDecisionApplyResult,
  PromotionDecisionConfidence,
  PromotionDecisionSchema,
  PromotionReviewArtifacts,
  PromotionReviewRequest,
  SkillPromoter,
  TapeStore,
} from "./contracts.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs-json.js";
import {
  fallbackDecisionTemplatePath,
  fallbackDecisionSchemaPath,
  fallbackReviewPath,
  fallbackReviewRequestPath,
} from "./paths.js";
import { createFallbackReviewPacket, writeFallbackReviewMarkdown } from "./review-packet.js";
import { createFallbackPromotionSummary } from "./fallback-summary.js";
import {
  PROMOTION_POLICY_ADVISORY_RULES,
  PROMOTION_POLICY_HARD_RULES,
  PROMOTION_REVIEW_PROMPT,
} from "./promotion-review-prompt.js";

export async function createPromotionReviewArtifacts(input: {
  domain: Domain;
  fallbackTapeId: FallbackTapeId;
  fallbackStore: FallbackTapeStore;
  tapeStore: TapeStore;
}): Promise<PromotionReviewArtifacts> {
  const tape = await input.fallbackStore.load(input.domain, input.fallbackTapeId);
  if (!tape) throw new Error(`Unknown fallback tape: ${input.fallbackTapeId}`);
  const catalog = await input.tapeStore.loadCatalog(input.domain);
  const reviewPath = await writeFallbackReviewMarkdown(input.domain, tape);
  const reviewPacket = await createFallbackReviewPacket(input.domain, tape);
  const reviewRequestPath = fallbackReviewRequestPath(input.domain, tape.id);
  const decisionSchemaPath = fallbackDecisionSchemaPath(input.domain, tape.id);
  const decisionTemplatePath = fallbackDecisionTemplatePath(input.domain, tape.id);
  const fallbackSummary = createFallbackPromotionSummary(tape, reviewPacket.evidencePreview);
  const request: PromotionReviewRequest = {
    schemaVersion: 1,
    domain: input.domain,
    fallbackTapeId: tape.id,
    prompt: PROMOTION_REVIEW_PROMPT,
    decisionSchemaPath,
    decisionTemplatePath,
    reviewPath,
    reviewPacket,
    fallbackSummary,
    existingCommands: Object.values(catalog?.processes || {}).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    policy: {
      name: "v1",
      hardRules: PROMOTION_POLICY_HARD_RULES,
      advisoryRules: PROMOTION_POLICY_ADVISORY_RULES,
    },
  };
  const decisionSchema = createPromotionDecisionSchema();
  const decisionTemplate = createPromotionDecisionTemplate(tape.id, tape.intent, fallbackSummary.mechanicalHints.suggestedPostconditions);
  await ensureDir(path.dirname(reviewRequestPath));
  await writeJsonFile(reviewRequestPath, request);
  await writeJsonFile(decisionSchemaPath, decisionSchema);
  await writeJsonFile(decisionTemplatePath, decisionTemplate);
  return {
    reviewPath,
    reviewRequestPath,
    decisionSchemaPath,
    decisionTemplatePath,
    request,
    decisionSchema,
    decisionTemplate,
  };
}

export class DefaultPromotionDecisionApplier implements PromotionDecisionApplier {
  constructor(
    private readonly fallbackStore: FallbackTapeStore,
    private readonly skillPromoter: SkillPromoter,
  ) {}

  async apply(domain: Domain, decision: PromotionDecision): Promise<PromotionDecisionApplyResult> {
    const normalized = normalizePromotionDecision(decision);
    const tape = await this.fallbackStore.load(domain, normalized.fallbackTapeId);
    if (!tape) throw new Error(`Unknown fallback tape: ${normalized.fallbackTapeId}`);
    if (tape.domain !== domain) throw new Error(`Decision domain mismatch for fallback ${tape.id}.`);

    if (normalized.action === "promote") {
      const promotion = await this.skillPromoter.promote(domain, normalized.fallbackTapeId, {
        commandName: normalized.commandName,
        description: normalized.description,
        outputs: normalized.outputs,
        postconditions: normalized.postconditions,
      });
      return {
        decision: normalized,
        agentContractDelta: promotion.agentContractDelta,
        result: {
          action: "promote",
          promotion,
        },
      };
    }

    if (normalized.action === "reject") {
      await this.fallbackStore.reject(domain, normalized.fallbackTapeId, normalized.rejectReason);
      return {
        decision: normalized,
        result: {
          action: "reject",
          rejected: normalized.fallbackTapeId,
          reason: normalized.rejectReason,
        },
      };
    }

    await this.fallbackStore.delete(domain, normalized.fallbackTapeId);
    return {
      decision: normalized,
      result: {
        action: "delete",
        deleted: normalized.fallbackTapeId,
      },
    };
  }
}

export async function readPromotionDecisionFile(filePath: string): Promise<PromotionDecision> {
  const decision = await readJsonFile<unknown>(filePath);
  if (!decision) throw new Error(`Decision file not found or empty: ${filePath}`);
  return normalizePromotionDecision(decision);
}

export function normalizePromotionDecision(input: unknown): PromotionDecision {
  if (!isRecord(input)) throw new Error("Promotion decision must be a JSON object.");
  const action = stringField(input, "action");
  const fallbackTapeId = stringField(input, "fallbackTapeId");
  const reasoning = stringField(input, "reasoning");
  const confidence = confidenceField(input, "confidence");

  if (action === "promote") {
    const postconditions = postconditionsField(input, "postconditions");
    if (!postconditions.length) throw new Error("Promote decisions require at least one postcondition.");
    return {
      action,
      fallbackTapeId,
      reasoning,
      confidence,
      commandName: stringField(input, "commandName"),
      description: stringField(input, "description"),
      postconditions,
      outputs: optionalOutputsField(input, "outputs"),
    };
  }

  if (action === "reject") {
    return {
      action,
      fallbackTapeId,
      reasoning,
      confidence,
      rejectReason: stringField(input, "rejectReason"),
    };
  }

  if (action === "delete") {
    return {
      action,
      fallbackTapeId,
      reasoning,
      confidence,
    };
  }

  throw new Error(`Unsupported promotion decision action: ${action}`);
}

export function createPromotionDecisionSchema(): PromotionDecisionSchema {
  return {
    schemaVersion: 1,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "fallbackTapeId", "reasoning", "confidence"],
      properties: {
        action: { enum: ["promote", "reject", "delete"] },
        fallbackTapeId: { type: "string", minLength: 1 },
        reasoning: { type: "string", minLength: 1 },
        confidence: { enum: ["low", "medium", "high"] },
        commandName: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        description: { type: "string", minLength: 1 },
        postconditions: {
          type: "array",
          minItems: 1,
          items: {
            oneOf: [
              {
                type: "object",
                required: ["type", "value"],
                additionalProperties: false,
                properties: {
                  type: { enum: ["url_equals", "url_contains"] },
                  value: { type: "string", minLength: 1 },
                },
              },
              {
                type: "object",
                required: ["type", "selector"],
                additionalProperties: false,
                properties: {
                  type: { const: "selector_exists" },
                  selector: { type: "string", minLength: 1 },
                },
              },
              {
                type: "object",
                required: ["type", "selector", "value"],
                additionalProperties: false,
                properties: {
                  type: { const: "text_contains" },
                  selector: { type: "string", minLength: 1 },
                  value: { type: "string", minLength: 1 },
                },
              },
            ],
          },
        },
        outputs: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "source", "selector", "description"],
            additionalProperties: false,
            properties: {
              name: { type: "string", pattern: "^[a-z][a-zA-Z0-9_]*$" },
              source: { const: "text" },
              selector: { type: "string", minLength: 1 },
              description: { type: "string", minLength: 1 },
            },
          },
        },
        rejectReason: { type: "string", minLength: 1 },
      },
      allOf: [
        {
          if: { properties: { action: { const: "promote" } } },
          then: { required: ["commandName", "description", "postconditions"] },
        },
        {
          if: { properties: { action: { const: "reject" } } },
          then: { required: ["rejectReason"] },
        },
      ],
    },
  };
}

function createPromotionDecisionTemplate(
  fallbackTapeId: FallbackTapeId,
  intent: string,
  suggestedPostconditions: Postcondition[],
): PromotionDecision {
  return {
    action: "promote",
    fallbackTapeId,
    reasoning: "Replace this with why the fallback is generic, repeatable, and safe to reuse.",
    confidence: "medium",
    commandName: intentToCommandName(intent),
    description: intent.trim() || "describe the reusable command",
    postconditions: suggestedPostconditions.length
      ? suggestedPostconditions
      : [{ type: "selector_exists", selector: "body" }],
  };
}

function intentToCommandName(intent: string): string {
  const normalized = intent
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  const withAlphaStart = /^[a-z]/.test(normalized) ? normalized : `skill_${normalized}`;
  return (withAlphaStart || "new_skill").slice(0, 64).replace(/_+$/g, "") || "new_skill";
}

export async function writePromotionDecisionExample(filePath: string, decision: PromotionDecision): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
}

function stringField(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Promotion decision requires ${field}.`);
  return value.trim();
}

function confidenceField(input: Record<string, unknown>, field: string): PromotionDecisionConfidence {
  const value = stringField(input, field);
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error("Promotion decision confidence must be low, medium, or high.");
}

function postconditionsField(input: Record<string, unknown>, field: string): Postcondition[] {
  const value = input[field];
  if (!Array.isArray(value)) throw new Error(`Promotion decision requires ${field}.`);
  return value.map(normalizePostcondition);
}

function optionalOutputsField(input: Record<string, unknown>, field: string): ProcessOutput[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array when provided.`);
  return value.map(normalizeOutput);
}

function normalizePostcondition(input: unknown): Postcondition {
  if (!isRecord(input)) throw new Error("Postcondition must be an object.");
  const type = stringField(input, "type");
  if (type === "url_equals" || type === "url_contains") {
    return { type, value: stringField(input, "value") };
  }
  if (type === "selector_exists") {
    return { type, selector: stringField(input, "selector") };
  }
  if (type === "text_contains") {
    return {
      type,
      selector: stringField(input, "selector"),
      value: stringField(input, "value"),
    };
  }
  throw new Error(`Unsupported postcondition type: ${type}`);
}

function normalizeOutput(input: unknown): ProcessOutput {
  if (!isRecord(input)) throw new Error("Output must be an object.");
  const source = stringField(input, "source");
  if (source !== "text") throw new Error(`Unsupported output source: ${source}`);
  return {
    name: stringField(input, "name"),
    source,
    selector: stringField(input, "selector"),
    description: stringField(input, "description"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

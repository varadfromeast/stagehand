import type {
  EvidencePreview,
  FallbackActionSummary,
  FallbackPromotionSummary,
  FallbackStepSummary,
  FallbackTape,
  MechanicalPromotionHints,
  Postcondition,
  StepValidator,
} from "./contracts.js";
import { shapeUrl } from "./state-identity.js";

export function createFallbackPromotionSummary(
  tape: FallbackTape,
  evidencePreview: EvidencePreview[],
): FallbackPromotionSummary {
  const steps = tape.steps.map(toStepSummary);
  const mechanicalHints = createMechanicalHints(tape, steps, evidencePreview);
  return {
    fallbackTapeId: tape.id,
    domain: tape.domain,
    intent: tape.intent,
    status: tape.status,
    source: tape.source,
    sessionId: tape.sessionId,
    writesToPlatform: tape.writesToPlatform,
    args: tape.args,
    recordingStartedAt: tape.recordingStartedAt,
    completedAt: tape.completedAt,
    entryUrl: tape.entry.url,
    finalUrl: tape.steps[tape.steps.length - 1]?.after.url || tape.entry.url,
    stepCount: tape.steps.length,
    operationCount: tape.operations?.length || 0,
    steps,
    operations: tape.operations || [],
    evidence: evidencePreview,
    mechanicalHints,
  };
}

function toStepSummary(step: FallbackTape["steps"][number]): FallbackStepSummary {
  const actions = step.actions.map((action): FallbackActionSummary => ({
    method: action.method,
    selector: action.selector,
    selectorKind: selectorKind(action.selector),
    arguments: action.arguments || [],
  }));
  return {
    id: step.id,
    name: step.name,
    type: step.type,
    instruction: step.instruction,
    beforeUrl: step.before.url,
    afterUrl: step.after.url,
    writesToPlatform: step.writesToPlatform,
    actions,
    validators: step.validators || [],
    selectorDiagnostics: step.selectorDiagnostics,
    selectorWarnings: selectorWarningsForStep(actions, step.selectorDiagnostics),
  };
}

function createMechanicalHints(
  tape: FallbackTape,
  steps: FallbackStepSummary[],
  evidencePreview: EvidencePreview[],
): MechanicalPromotionHints {
  const selectorWarnings = unique(steps.flatMap((step) => step.selectorWarnings));
  const riskFlags = new Set<string>();
  if (tape.status !== "succeeded") riskFlags.add("fallback_not_succeeded");
  if (tape.writesToPlatform || tape.steps.some((step) => step.writesToPlatform)) {
    riskFlags.add("writes_to_platform");
  }
  if (!steps.length) riskFlags.add("empty_fallback");
  if (!tape.operations?.length) riskFlags.add("no_operation_log");
  if ((tape.operations?.length || 0) > steps.length) riskFlags.add("operation_log_has_unrecorded_context");
  if (steps.some((step) => !step.validators.length)) riskFlags.add("steps_missing_validators");
  if (selectorWarnings.includes("absolute_xpath")) riskFlags.add("has_absolute_xpath");
  if (selectorWarnings.includes("body_selector")) riskFlags.add("has_body_selector");
  if (evidencePreview.every((evidence) => evidence.kind !== "text")) riskFlags.add("no_text_evidence");
  if (!tape.args.length && usesRuntimePlaceholders(tape)) riskFlags.add("placeholders_without_declared_args");

  return {
    suggestedPostconditions: suggestedPostconditions(tape),
    riskFlags: [...riskFlags].sort(),
    selectorWarnings,
    textEvidenceSelectors: unique(
      evidencePreview
        .filter((evidence) => evidence.kind === "text" && evidence.selector)
        .map((evidence) => evidence.selector || ""),
    ),
  };
}

function suggestedPostconditions(tape: FallbackTape): Postcondition[] {
  const suggestions: Postcondition[] = [];
  const finalStep = tape.steps[tape.steps.length - 1];
  for (const validator of finalStep?.validators || []) suggestions.push(validator);

  const finalUrl = finalStep?.after.url;
  if (finalUrl) {
    const path = pathFromUrl(finalUrl);
    if (path && path !== "/") {
      suggestions.push({ type: "url_contains", value: path });
    }
  }
  return dedupePostconditions(suggestions);
}

function selectorWarningsForStep(
  actions: FallbackActionSummary[],
  diagnostics: FallbackStepSummary["selectorDiagnostics"],
): string[] {
  const warnings = new Set<string>();
  for (const action of actions) {
    if (action.selectorKind === "xpath" && action.selector.startsWith("xpath=/html")) {
      warnings.add("absolute_xpath");
    }
    if (action.selectorKind === "xpath" && action.selector.startsWith("/html")) {
      warnings.add("absolute_xpath");
    }
    if (action.selector === "body") warnings.add("body_selector");
    if (action.selectorKind === "unknown") warnings.add("unknown_selector_kind");
    if (!action.selector.trim()) warnings.add("empty_selector");
  }
  if (diagnostics?.selected.stability === "weak") warnings.add("weak_selected_selector");
  if (diagnostics?.selected.matchCount && diagnostics.selected.matchCount > 1) {
    warnings.add("non_unique_selected_selector");
  }
  return [...warnings].sort();
}

function selectorKind(selector: string): FallbackActionSummary["selectorKind"] {
  if (selector.startsWith("http://") || selector.startsWith("https://")) return "url";
  if (selector.startsWith("xpath=") || selector.startsWith("/")) return "xpath";
  if (selector.trim()) return "css";
  return "unknown";
}

function usesRuntimePlaceholders(tape: FallbackTape): boolean {
  return tape.steps.some((step) =>
    step.actions.some((action) => (action.arguments || []).some((arg) => /%[a-zA-Z][a-zA-Z0-9_]*%/.test(arg))),
  );
}

function pathFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    const shaped = shapeUrl(url);
    const slash = shaped.indexOf("/");
    return slash >= 0 ? shaped.slice(slash) : undefined;
  }
}

function dedupePostconditions(postconditions: StepValidator[]): StepValidator[] {
  const seen = new Set<string>();
  const deduped: StepValidator[] = [];
  for (const postcondition of postconditions) {
    const key = JSON.stringify(postcondition);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(postcondition);
  }
  return deduped;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

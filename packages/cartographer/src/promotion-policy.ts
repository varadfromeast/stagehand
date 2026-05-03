import type {
  FallbackTape,
  Postcondition,
  ProcessOutput,
  PromotionPolicy,
  PromotionPolicyDecision,
  PromotionPolicyFinding,
  PromotionPolicyInput,
  StepValidator,
} from "./contracts.js";

export class V1PromotionPolicy implements PromotionPolicy {
  evaluate(input: PromotionPolicyInput): PromotionPolicyDecision {
    const findings: PromotionPolicyFinding[] = [];
    const commandName = input.commandName.trim();
    const description = input.description.trim();
    const writesToPlatform = deriveWritesToPlatform(input.tape);
    const effectivePostconditions = input.postconditions?.length
      ? input.postconditions
      : inferPostconditionsFromTape(input.tape);

    if (!/^[a-z][a-z0-9_]*$/.test(commandName)) {
      addError(findings, "invalid_command_name", "Command name must be snake_case, for example send_message.");
    }
    if (!description) {
      addError(findings, "missing_description", "Promotion requires an explicit description.");
    }
    if (input.tape.status !== "succeeded") {
      addError(findings, "failed_fallback", "Only succeeded fallback tapes can be promoted.");
    }
    if (input.tape.promotedAt) {
      addError(findings, "already_promoted", "Fallback tape has already been promoted.");
    }
    if (input.existingProcessNames.includes(commandName)) {
      addError(findings, "duplicate_command", `Command already exists: ${commandName}.`);
    }
    if (!input.tape.steps.length) {
      addError(findings, "empty_tape", "Promotion requires at least one recorded step.");
    }

    if (input.tape.steps.some((step) => step.writesToPlatform) && !input.tape.writesToPlatform) {
      addWarning(
        findings,
        "write_flag_repaired",
        "Step-level writes were detected; promoted command will be write-protected.",
      );
    }
    if (input.tape.writesToPlatform && !input.tape.steps.some((step) => step.writesToPlatform)) {
      addWarning(
        findings,
        "tape_write_without_step_write",
        "Fallback tape is marked as a write, but no individual step is marked as a write.",
      );
    }

    if (!effectivePostconditions?.length) {
      addError(
        findings,
        "missing_postconditions",
        "Promotion requires deterministic final postconditions in V1.",
      );
    }
    if (writesToPlatform && !input.postconditions?.length) {
      addError(
        findings,
        "write_requires_explicit_postconditions",
        "Write promotions require explicit postconditions; inferred validators are not enough.",
      );
    }

    validateOutputs(input.outputs, findings);
    validatePostconditions(effectivePostconditions, findings);
    validatePlaceholders(input.tape, effectivePostconditions, findings);

    if (
      !writesToPlatform &&
      !input.outputs?.length &&
      !isNavigationOnly(input.tape) &&
      effectivePostconditions?.length
    ) {
      addWarning(
        findings,
        "read_command_without_outputs",
        "Non-write command has no declared outputs; it will be useful only as a state-changing/navigation command.",
      );
    }

    const accepted = !findings.some((finding) => finding.severity === "error");
    return {
      accepted,
      writesToPlatform,
      effectivePostconditions,
      findings,
      reason: accepted
        ? "Accepted by V1 promotion policy: explicit command identity, write classification, and deterministic postconditions are present."
        : "Rejected by V1 promotion policy.",
    };
  }
}

export function deriveWritesToPlatform(tape: FallbackTape): boolean {
  return tape.writesToPlatform || tape.steps.some((step) => step.writesToPlatform);
}

export function inferPostconditionsFromTape(tape: FallbackTape): Postcondition[] | undefined {
  const finalStep = tape.steps[tape.steps.length - 1];
  return finalStep?.validators?.length ? finalStep.validators : undefined;
}

function validateOutputs(outputs: ProcessOutput[] | undefined, findings: PromotionPolicyFinding[]): void {
  if (!outputs?.length) return;
  const names = new Set<string>();
  for (const output of outputs) {
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(output.name)) {
      addError(findings, "invalid_output_name", `Invalid output name: ${output.name}.`);
    }
    if (names.has(output.name)) {
      addError(findings, "duplicate_output_name", `Duplicate output name: ${output.name}.`);
    }
    names.add(output.name);
    if (output.source !== "text") {
      addError(findings, "unsupported_output_source", `Unsupported output source: ${output.source}.`);
    }
    if (!output.selector.trim()) {
      addError(findings, "missing_output_selector", `Output ${output.name} requires a selector.`);
    }
    if (!output.description.trim()) {
      addError(findings, "missing_output_description", `Output ${output.name} requires a description.`);
    }
  }
}

function validatePostconditions(
  postconditions: Postcondition[] | undefined,
  findings: PromotionPolicyFinding[],
): void {
  for (const postcondition of postconditions || []) {
    if (postcondition.type === "url_equals" || postcondition.type === "url_contains") {
      if (!postcondition.value.trim()) {
        addError(findings, "empty_url_postcondition", `${postcondition.type} requires a value.`);
      }
    } else if (postcondition.type === "selector_exists") {
      if (!postcondition.selector.trim()) {
        addError(findings, "empty_selector_postcondition", "selector_exists requires a selector.");
      }
    } else if (postcondition.type === "text_contains") {
      if (!postcondition.selector.trim() || !postcondition.value.trim()) {
        addError(findings, "empty_text_postcondition", "text_contains requires a selector and value.");
      }
    } else {
      const exhaustive: never = postcondition;
      addError(findings, "unsupported_postcondition", `Unsupported postcondition: ${String(exhaustive)}.`);
    }
  }
}

function validatePlaceholders(
  tape: FallbackTape,
  postconditions: Postcondition[] | undefined,
  findings: PromotionPolicyFinding[],
): void {
  const argNames = new Set(tape.args.map((arg) => arg.name));
  const placeholders = new Set<string>();
  for (const step of tape.steps) {
    for (const action of step.actions) {
      for (const value of action.arguments || []) {
        for (const placeholder of extractPlaceholders(value)) placeholders.add(placeholder);
      }
    }
  }
  for (const postcondition of postconditions || []) {
    if ("value" in postcondition) {
      for (const placeholder of extractPlaceholders(postcondition.value)) placeholders.add(placeholder);
    }
  }
  for (const placeholder of placeholders) {
    if (!argNames.has(placeholder)) {
      addError(
        findings,
        "undeclared_placeholder_arg",
        `Placeholder %${placeholder}% is used but no process arg named ${placeholder} is declared.`,
      );
    }
  }
}

function extractPlaceholders(value: string): string[] {
  return [...value.matchAll(/%([a-zA-Z][a-zA-Z0-9_]*)%/g)].map((match) => match[1]);
}

function isNavigationOnly(tape: FallbackTape): boolean {
  return tape.steps.length > 0 && tape.steps.every((step) => step.type === "navigate");
}

function addError(findings: PromotionPolicyFinding[], code: string, message: string): void {
  findings.push({ severity: "error", code, message });
}

function addWarning(findings: PromotionPolicyFinding[], code: string, message: string): void {
  findings.push({ severity: "warning", code, message });
}

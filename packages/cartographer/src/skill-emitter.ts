import fs from "node:fs/promises";
import path from "node:path";
import type { Domain, Postcondition, ProcessTapeSummary, TapeCatalog } from "./contracts.js";
import { readJsonFile } from "./fs-json.js";
import { catalogPath, manifestPath, skillPath, slugifyName } from "./paths.js";
import {
  PROMOTION_POLICY_ADVISORY_RULES,
  PROMOTION_POLICY_HARD_RULES,
  PROMOTION_REVIEW_PROMPT,
} from "./promotion-review-prompt.js";

export async function emitSkillMd(domain: Domain, outputPath = skillPath(domain)): Promise<string> {
  const catalog = await readJsonFile<TapeCatalog>(catalogPath(domain));
  if (!catalog) throw new Error(`No tape catalog found for ${domain}`);

  const lines = [
    "---",
    `name: ${domain.replace(/\./g, "-")}-cli`,
    `description: Use deterministic ${domain} CLI skills first, inspect structured outputs, and record browser fallback when no listed command fits or a command fails.`,
    "---",
    "",
    `# ${domain} CLI Skill`,
    "",
    "Use the emitted CLI before browser automation. Fall back to the browser recorder only when no listed command directly covers the task or a command fails.",
    "",
    "## Runtime Contract",
    "",
    "- The external agent does the reasoning. Read this file, choose an explicit command, then run it.",
    "- Tool selection is model-controlled: the agent decides whether one listed command directly fits the task.",
    "- The CLI never infers broad user intent. It only executes the named command it was asked to run.",
    "- The emitted CLI preloads the site skill registry before command execution.",
    "- Prefer `instagram-com-cli` commands listed below when one directly fits the task.",
    "- Use `--dry-run` first when inspecting a write-capable command.",
    "- Commands that write to Instagram require `--confirm-write`.",
    "- Command success is deterministic: actions must execute and final postconditions must pass. Hash drift is diagnostic unless a postcondition fails.",
    "- Read commands return JSON. If a command has outputs, consume the `outputs` object instead of rendering the full page.",
    "- Inspect `manifest.json` beside this file when you need the machine-readable command contract.",
    "- Start substantial tasks with `node packages/cartographer/dist/cli.js begin-task instagram.com --intent <task>` so fallback review can be scoped.",
    "- If no listed command directly covers the task, use `node packages/cartographer/dist/cli.js fallback instagram.com --intent <task>` to record fallback steps.",
    "- If a CLI command returns `success:false`, inspect `failure`, `execution.actionFailures`, `postconditions`, and `drift`, then use fallback recording when needed.",
    "- If fallback recording is used, the task is not complete until you run end-of-task review and promote, reject, or delete each reviewed fallback.",
    "- Promotion is policy-gated in V1: promoted commands need explicit identity, correct write protection, and deterministic final postconditions.",
    "- Normal promotion workflow: create a promotion review, reason over the review packet, return PromotionDecision JSON, then let Cartographer apply it with `apply-promotion-decision`.",
    "- Do not run `promote-fallback` directly in normal agent workflow. It is a manual escape hatch; the typed decision path keeps reasoning separate from deterministic mutation.",
    "- At end of task, run `node packages/cartographer/dist/cli.js end-task-review instagram.com --since <taskStartedAt>`, inspect evidence with `node packages/cartographer/dist/cli.js inspect-fallback instagram.com <fallback-id>`, create a review with `node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>`, then apply the completed decision with `node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>`.",
    "- Reject or delete fallback tapes that are too specific with `node packages/cartographer/dist/cli.js reject-fallback ...` or `node packages/cartographer/dist/cli.js delete-fallback ...`.",
    "",
    "## Output Contract",
    "",
    "Every CLI command prints JSON:",
    "",
    "```json",
    `{"success":true,"processName":"example","execution":{"completed":true},"postconditions":{"required":true,"passed":true},"drift":{"detected":false},"outputs":{"name":"value"},"message":"..."}`,
    "```",
    "",
    "- `success:true` means command execution completed and final postconditions passed.",
    "- `success:false` means the named command failed mechanically or its final postconditions failed.",
    "- `drift.detected:true` is a warning that the page fingerprint changed. Do not treat drift alone as failure when `success:true`.",
    "- For read skills, prefer named values under `outputs`. Treat empty `outputs` as navigation-only or a sign that the command needs a better promoted output contract.",
    "",
    "## Task Lifecycle",
    "",
    "For multi-step or unfamiliar tasks, create a task envelope first:",
    "",
    "```bash",
    "node packages/cartographer/dist/cli.js begin-task instagram.com --intent \"task description\"",
    "```",
    "",
    "Keep the returned `taskStartedAt`. If fallback is used at any point, the required closeout is:",
    "",
    "```bash",
    "node packages/cartographer/dist/cli.js end-task-review instagram.com --since \"<taskStartedAt>\"",
    "```",
    "",
    "For every reviewed fallback from the task, make an explicit typed decision. Use `decision-template.json` as the starting shape when present:",
    "",
    "- Promote when the tape is generic, repeatable, safe, and has deterministic postconditions.",
    "- Reject when the tape is too task-specific, brittle, unsafe, or low quality.",
    "- Delete only when the tape should not be retained.",
    "",
    "Promotion decision JSON is the reasoning handoff. The agent supplies judgment in a flat PromotionDecision object; Cartographer validates and applies deterministic changes.",
    "",
    "## Fallback And Skill Acquisition",
    "",
    "Use fallback when no listed command directly matches the task, or when a command fails and the task can still be completed manually with browser operations.",
    "",
    "```bash",
    "node packages/cartographer/dist/cli.js fallback instagram.com --intent \"task description\"",
    "```",
    "",
    "Fallback is local Playwright capture by default; it does not require Stagehand/model API keys. The prompt accepts:",
    "",
    "```text",
    "goto <url>",
    "goto-inbox",
    "click <selector>",
    "fill <selector> <value>",
    "fill-arg <selector> <arg-name> <value>",
    "text [selector]",
    "screenshot <label>",
    "record-step <step-name> [--write]",
    "save-fallback [--write] [--arg message]",
    "quit",
    "```",
    "",
    "`record-step` selects replayable steps. Other operations remain deterministic review context in the fallback tape. Use `fill-arg` when a real value should become a future CLI argument; it records `%argName%` instead of the literal value.",
    "",
    "Fallback is the organic acquisition path. After the user task is complete, review fallback tapes and promote reusable ones so the CLI acquires new skills:",
    "",
    "```bash",
    "node packages/cartographer/dist/cli.js end-task-review instagram.com --since \"<taskStartedAt>\"",
    "node packages/cartographer/dist/cli.js inspect-fallback instagram.com <fallback-id>",
    "node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>",
    "node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>",
    "```",
    "",
    "After successful promotion, the apply result includes top-level `agentContractDelta`, plus `cliCommandName` and `reusableCommand.command`. Treat `agentContractDelta` as an immediate patch to your working command list, then use the regenerated CLI command for matching future tasks.",
    "",
    "Promotion review prompt:",
    "",
    "```text",
    PROMOTION_REVIEW_PROMPT,
    "```",
    "",
    "## Commands",
    "",
  ];

  for (const process of Object.values(catalog.processes).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const command = slugifyName(process.name);
    const args = process.args
      .map((arg) => ` --${arg.name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} <${arg.name}>`)
      .join("");
    const confirm = process.writesToPlatform ? " --confirm-write" : "";
    lines.push(`### ${command}`);
    lines.push("");
    lines.push(process.description || process.name);
    lines.push("");
    lines.push("```bash");
    lines.push(`instagram-com-cli ${command}${args}${confirm}`);
    lines.push("```");
    if (process.writesToPlatform) {
      lines.push("");
      lines.push("Requires `--confirm-write` because it writes to Instagram.");
    }
    if (process.outputs?.length) {
      lines.push("");
      lines.push("Expected JSON outputs:");
      for (const output of process.outputs) {
        lines.push(`- \`outputs.${output.name}\`: ${output.description}; source selector \`${output.selector}\`.`);
      }
    } else if (!process.writesToPlatform) {
      lines.push("");
      lines.push("Expected JSON outputs: none declared. Use this as a navigation skill, not a read skill, until it is promoted with `--output`.");
    }
    if (process.postconditions?.length) {
      lines.push("");
      lines.push("Final postconditions:");
      for (const postcondition of process.postconditions) {
        lines.push(`- ${formatPostcondition(postcondition)}`);
      }
    } else {
      lines.push("");
      lines.push("Final postconditions: none declared. The CLI can only confirm action execution for this command until postconditions are added.");
    }
    lines.push("");
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  return outputPath;
}

export async function emitSkillManifest(domain: Domain, outputPath = manifestPath(domain)): Promise<string> {
  const catalog = await readJsonFile<TapeCatalog>(catalogPath(domain));
  if (!catalog) throw new Error(`No tape catalog found for ${domain}`);

  const manifest = {
    schemaVersion: 1,
    domain,
    generatedAt: new Date().toISOString(),
    agentContract: {
      toolSelection: "agent-controlled",
      commandExecution: "cli-controlled",
      successRule: "success is true only when actions complete and final postconditions pass",
      driftRule: "hash drift is diagnostic and does not fail a command by itself",
      fallbackRule: "use fallback recording when no listed command fits or an invoked command fails",
      learningRule: "if fallback is used, end-task review is required and every reusable fallback should be promoted into a CLI command",
    },
    taskLifecycle: {
      beginTaskCommand: `node packages/cartographer/dist/cli.js begin-task ${domain} --intent <task>`,
      fallbackCreatesLearningDebt: true,
      closeoutRequiredWhenFallbackUsed: true,
      reviewCommandPattern: `node packages/cartographer/dist/cli.js end-task-review ${domain} --since <taskStartedAt>`,
      decisions: ["promote", "reject", "delete"],
      promotionCriteria: [
        "generic",
        "repeatable",
        "safe",
        "deterministic-postconditions",
      ],
      promotionPolicy: {
        name: "v1",
        enforced: PROMOTION_POLICY_HARD_RULES,
        advisory: PROMOTION_POLICY_ADVISORY_RULES,
      },
      promotionDecisionWorkflow: {
        createReviewCommand: `node packages/cartographer/dist/cli.js create-promotion-review ${domain} <fallback-id>`,
        applyDecisionCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
        agentInstruction:
          "Reason over review-request.json, use decision-template.json as the starting shape when useful, and return one flat PromotionDecision JSON. Do not run promotion commands directly in normal workflow.",
        decisionActions: ["promote", "reject", "delete"],
        afterPromotion:
          "Treat agentContractDelta from the apply result as an immediate patch to the working command contract. Use reusableCommand.command, or refresh SKILL.md/manifest.json, to reuse the acquired CLI skill.",
      },
    },
    cli: {
      binName: "instagram-com-cli",
      commandPattern: "instagram-com-cli <command> [--dry-run] [--confirm-write] [--key value]",
      fallbackCommand: `node packages/cartographer/dist/cli.js fallback ${domain} --intent <task>`,
      reviewCommand: `node packages/cartographer/dist/cli.js end-task-review ${domain}`,
    },
    commands: Object.values(catalog.processes)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((process) => toManifestCommand(process)),
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return outputPath;
}

function toManifestCommand(process: ProcessTapeSummary) {
  return {
    name: slugifyName(process.name),
    processName: process.name,
    description: process.description,
    writesToPlatform: process.writesToPlatform,
    args: process.args,
    outputs: process.outputs || [],
    postconditions: process.postconditions || [],
    success: {
      actionFailuresFailCommand: true,
      postconditionsMustPass: Boolean(process.postconditions?.length),
      driftOnlyFailsCommand: false,
    },
    failureFields: ["failure", "execution.actionFailures", "postconditions.checks", "drift.steps"],
  };
}

function formatPostcondition(postcondition: Postcondition): string {
  if (postcondition.type === "selector_exists") {
    return `\`selector_exists\`: \`${postcondition.selector}\``;
  }
  if (postcondition.type === "text_contains") {
    return `\`text_contains\`: \`${postcondition.selector}\` includes \`${postcondition.value}\``;
  }
  return `\`${postcondition.type}\`: \`${postcondition.value}\``;
}

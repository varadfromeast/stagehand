# Cartographer Ubiquitous Language

Cartographer uses these terms consistently across code, docs, prompts, and
agent instructions.

## Core Terms

- **Agent**: the external reasoning system. It reads the contract, chooses a
  command, decides when fallback is needed, and decides whether a fallback is
  reusable.
- **Command**: a named CLI capability exposed by the site CLI, for example
  `open-inbox`.
- **Contract**: the generated `SKILL.md` and `manifest.json` pair that tells an
  agent how to use the CLI.
- **Manifest**: the machine-readable command contract. It lists args, outputs,
  postconditions, write flags, and failure fields.
- **Process Tape**: the persisted replay plan behind a command.
- **Step**: one recorded browser operation inside a process tape.
- **Postcondition**: a deterministic final-state check that decides command
  success.
- **Output**: structured data intentionally returned by a command.
- **Drift**: diagnostic evidence that replayed page shape differed from the
  recorded shape. Drift alone is not failure.
- **Fallback**: explicit local browser recording used when no command fits or a
  command fails.
- **Fallback Operation**: a deterministic event from a fallback session, such as
  `goto`, `click`, `fill`, `text`, `screenshot`, or `record_step`.
- **Fallback Tape**: a saved fallback recording with session metadata,
  operation log, replayable steps, evidence, selectors, args, validators, and
  write flags.
- **Replayable Step**: a fallback step explicitly selected with `record-step`.
  Operations provide review context; replayable steps become process tape steps
  after promotion.
- **Selector Diagnostics**: deterministic selector metadata captured for review:
  selector kind, stability, reason, match count, and alternatives when
  available.
- **Promotion Decision**: typed JSON returned by the agent after reviewing a
  fallback. It chooses exactly one action: promote, reject, or delete.
- **Promotion Policy**: deterministic code gate that validates a promotion
  decision before Cartographer writes a new command.
- **Acquisition**: promotion of a reusable fallback tape into a new command.
- **Learning Debt**: the obligation created when fallback is used. The agent
  must run end-of-task review and promote, reject, or delete reviewed fallbacks.
- **Promotion**: converting a reviewed fallback tape into a process tape, then
  regenerating the CLI, `SKILL.md`, and `manifest.json`.

## Boundaries

- Agent controls tool selection.
- CLI controls command execution.
- Postconditions control command success.
- Fallback controls new task execution when no command fits.
- Agent reasoning controls promotion judgment through `PromotionDecision`.
- Promotion policy and code control deterministic skill mutation.
- Review and promotion control organic skill growth.

## Rules

- Do not route natural language inside Cartographer V1.
- Do not treat hash drift as failure when postconditions pass.
- Do not silently acquire skills. Acquisition requires an explicit agent
  decision after fallback review.
- Do not ask Stagehand/model APIs for the default fallback path in V1. Default
  fallback must work locally without external API keys.
- Do not promote writes without clear write flags and `--confirm-write` runtime
  enforcement.

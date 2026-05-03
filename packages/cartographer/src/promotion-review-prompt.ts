export const PROMOTION_REVIEW_PROMPT = `You are reviewing a Cartographer browser fallback tape for CLI skill promotion.

Your job is reasoning only. Do not run promotion, rejection, deletion, browser, or shell commands yourself.

Return exactly one JSON object matching PromotionDecision.

Promote only if:
- the tape captures a reusable operation, not a one-off user task
- the command name describes the actual repeatable operation
- the tape is repeatable from its recorded entry state
- final postconditions deterministically prove success
- write behavior is correctly marked and safe behind --confirm-write
- read/data commands declare explicit outputs

Reject if:
- the tape depends on transient content, private accidental state, or brittle DOM position
- the broader user task was completed but the reusable operation is unclear
- postconditions or outputs are insufficient
- write behavior does not have a clear safety boundary

Delete only if:
- the tape is noise or should not be retained.

Cartographer will validate your JSON decision with PromotionPolicy and apply all deterministic mutations.`;

export const PROMOTION_POLICY_HARD_RULES = [
  "command name must be snake_case and unique",
  "fallback tape must have succeeded and must not already be promoted",
  "fallback tape must contain at least one recorded step",
  "description must explicitly describe what the command does",
  "write commands are write-protected if the tape or any step writes",
  "deterministic final postconditions are required",
  "write promotions require explicit postconditions",
  "runtime placeholders must have declared args",
  "output contracts must have valid names, selectors, and descriptions",
];

export const PROMOTION_POLICY_ADVISORY_RULES = [
  "the agent is responsible for deciding whether the tape is semantically generic and reusable",
  "non-write commands without outputs are navigation/state commands only",
  "prefer rejecting a broad task fallback and promoting only a smaller reusable sub-operation",
];

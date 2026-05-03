#!/usr/bin/env node
/**
 * apply-nollm-patch.mjs
 *
 * Applies the upstream `noLlm` Stagehand patch to packages/core/lib/v3/v3.ts
 * in this fork. Idempotent — running it twice is a no-op.
 *
 * What it changes (4 hunks):
 *   1. Constructor: adds `else if (opts.noLlm)` branch that skips API key
 *      load + LLM client construction. (~12 lines)
 *   2. resolveLlmClient: throws a clear error when invoked without a
 *      configured LLM client (e.g., in noLlm mode). (~7 lines)
 *   3. act(Action) path: skips `resolveLlmClient()` when `opts.noLlm` is
 *      true, passes undefined to `takeDeterministicAction`. Self-heal is
 *      gated by `selfHeal:true` so the undefined client is never invoked
 *      on the deterministic replay path. (~6 lines)
 *   4. agent() log: safe optional access on `this.llmClient?.modelName`
 *      with a fallback so the log doesn't crash in noLlm mode. (~3 lines)
 *
 * The companion patch in `packages/core/lib/v3/types/public/options.ts`
 * (adding the `noLlm?: boolean` field) and the cartographer-side
 * `noLlm:true` switch in `packages/cartographer/src/browser-session.ts` are
 * already committed directly via the integration push (no script needed
 * for those).
 *
 * Run from repo root:
 *
 *   node apply-nollm-patch.mjs
 *
 * Then verify:
 *
 *   pnpm --filter @browserbasehq/stagehand typecheck
 *   pnpm --filter @cartographer/core typecheck
 *
 * Safe to re-run.
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const v3Path = path.join(repoRoot, "packages/core/lib/v3/v3.ts");

if (!fs.existsSync(v3Path)) {
  console.error(`fatal: ${v3Path} not found. Run from the repo root.`);
  process.exit(1);
}

let src = fs.readFileSync(v3Path, "utf8");
const before = src;

const edits = [
  {
    name: "Hunk 1 — constructor noLlm branch",
    sentinel: "else if (opts.noLlm) {",
    find: `    if (opts.llmClient) {
      this.llmClient = opts.llmClient;
      this.modelClientOptions = baseClientOptions;
      this.disableAPI = true;
    } else {
      // Ensure API key is set
      let apiKey = (baseClientOptions as { apiKey?: string }).apiKey;`,
    replace: `    if (opts.llmClient) {
      this.llmClient = opts.llmClient;
      this.modelClientOptions = baseClientOptions;
      this.disableAPI = true;
    } else if (opts.noLlm) {
      // noLlm mode: skip API key load and LLM client construction entirely.
      // \`this.llmClient\` stays unassigned. \`resolveLlmClient()\` throws if
      // invoked, and \`act(Action)\` with \`selfHeal:false\` never invokes it.
      // See V3Options.noLlm docs.
      this.modelClientOptions = baseClientOptions;
      this.logger({
        category: "init",
        message:
          "noLlm:true — LLM-dependent methods (act(string), observe, agent, self-heal) will throw if invoked. Deterministic act(Action) replay works.",
        level: 1,
      });
    } else {
      // Ensure API key is set
      let apiKey = (baseClientOptions as { apiKey?: string }).apiKey;`,
  },
  {
    name: "Hunk 2 — resolveLlmClient guard",
    sentinel: "LLM client not configured (noLlm:true",
    find: `  private resolveLlmClient(model?: ModelConfiguration): LLMClient {
    if (!model) {
      return this.llmClient;
    }`,
    replace: `  private resolveLlmClient(model?: ModelConfiguration): LLMClient {
    if (!model) {
      if (!this.llmClient) {
        throw new Error(
          "[Stagehand] LLM client not configured (noLlm:true or missing API key). " +
            "act(string), observe(), agent(), and self-heal require an LLM client. " +
            "Use act(Action) with selfHeal:false for deterministic replay only.",
        );
      }
      return this.llmClient;
    }`,
  },
  {
    name: "Hunk 3 — act(Action) skip resolveLlmClient",
    sentinel: "llmClientForReplay = this.opts.noLlm",
    find: `          actResult = await this.actHandler.takeDeterministicAction(
            { ...input, selector },
            v3Page,
            this.domSettleTimeoutMs,
            this.resolveLlmClient(options?.model),
            ensureTimeRemaining,
            options?.variables,
          );`,
    replace: `          // In noLlm mode, skip resolveLlmClient() — it would throw, and
          // takeDeterministicAction only uses the client during self-heal,
          // which is gated by \`selfHeal:true\` (not enabled in noLlm flows).
          const llmClientForReplay = this.opts.noLlm
            ? (undefined as unknown as LLMClient)
            : this.resolveLlmClient(options?.model);
          actResult = await this.actHandler.takeDeterministicAction(
            { ...input, selector },
            v3Page,
            this.domSettleTimeoutMs,
            llmClientForReplay,
            ensureTimeRemaining,
            options?.variables,
          );`,
  },
  {
    name: "Hunk 4 — agent() log safe model access",
    sentinel: "this.llmClient?.modelName ??",
    find: `          value: extractModelName(options?.model) ?? this.llmClient.modelName,`,
    replace: `          value:
            extractModelName(options?.model) ??
            this.llmClient?.modelName ??
            "<not-configured>",`,
  },
];

let appliedCount = 0;
let alreadyAppliedCount = 0;

for (const edit of edits) {
  if (src.includes(edit.sentinel)) {
    console.log(`✓ ${edit.name}: already applied`);
    alreadyAppliedCount++;
    continue;
  }
  if (!src.includes(edit.find)) {
    console.error(`✗ ${edit.name}: source pattern not found`);
    console.error(`  Looked for:`);
    console.error(`  ${edit.find.split("\n")[0]}`);
    console.error(
      `  Has the file changed since this script was written? Aborting without writing.`,
    );
    process.exit(2);
  }
  src = src.replace(edit.find, edit.replace);
  console.log(`✓ ${edit.name}: applied`);
  appliedCount++;
}

if (appliedCount === 0) {
  console.log(
    `\nNo changes needed (${alreadyAppliedCount}/${edits.length} hunks already present).`,
  );
  process.exit(0);
}

if (src === before) {
  console.error(
    "\nfatal: edits reported applied but file content unchanged. Aborting.",
  );
  process.exit(3);
}

fs.writeFileSync(v3Path, src, "utf8");
console.log(
  `\nWrote ${v3Path} (${appliedCount} hunk(s) applied, ${alreadyAppliedCount} already present).`,
);
console.log("\nNext steps:");
console.log("  pnpm --filter @browserbasehq/stagehand typecheck");
console.log("  pnpm --filter @cartographer/core typecheck");
console.log("  git add packages/core/lib/v3/v3.ts");
console.log(
  '  git commit -m "feat(v3): apply noLlm patch via apply-nollm-patch.mjs"',
);
console.log("  git push");

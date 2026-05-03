import type { CartographerRuntime, Domain } from "./contracts.js";
import { StagehandBrowserSessionFactory } from "./browser-session.js";
import { JsonStateActionCache } from "./state-action-cache.js";
import { BasicStateIdentity } from "./state-identity.js";
import { JsonTapeStore } from "./tape-store.js";
import { ProcessTapeRuntime } from "./runtime.js";
import { PreloadedSkillRegistry } from "./skill-registry.js";
import { ConsoleCartographerLogger } from "./logger.js";

export function createRuntime(): CartographerRuntime {
  const logger = new ConsoleCartographerLogger();
  const registry = new PreloadedSkillRegistry(new JsonTapeStore(), logger);
  return new ProcessTapeRuntime(
    new StagehandBrowserSessionFactory(),
    new BasicStateIdentity(),
    registry,
    new JsonStateActionCache(),
    undefined,
    logger,
  );
}

export async function createPreloadedRuntime(domain: Domain): Promise<CartographerRuntime> {
  const logger = new ConsoleCartographerLogger();
  const registry = new PreloadedSkillRegistry(new JsonTapeStore(), logger);
  await registry.preload(domain);
  return new ProcessTapeRuntime(
    new StagehandBrowserSessionFactory(),
    new BasicStateIdentity(),
    registry,
    new JsonStateActionCache(),
    undefined,
    logger,
  );
}

export function parseRuntimeArgs(argv: string[]): {
  args: Record<string, string | boolean>;
  confirmWrite: boolean;
  dryRun: boolean;
} {
  const args: Record<string, string | boolean> = {};
  let confirmWrite = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--confirm-write") {
      confirmWrite = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    }
  }
  return { args, confirmWrite, dryRun };
}

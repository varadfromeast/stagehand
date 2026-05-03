import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Stagehand } from "@browserbasehq/stagehand";
import type { Action } from "@browserbasehq/stagehand";
import type {
  ActOutcome,
  BrowserSession,
  BrowserSessionFactory,
  Domain,
  LaunchOptions,
  ObservedCandidate,
  RuntimeArgs,
} from "./contracts.js";
import { ensureDir } from "./fs-json.js";
import { actionToAtom } from "./state-identity.js";
import { evidenceDir } from "./paths.js";

export class StagehandBrowserSessionFactory implements BrowserSessionFactory {
  async launchInstagram(options: LaunchOptions): Promise<BrowserSession> {
    await ensureDir(options.cacheDir);
    await ensureDir(path.join(options.cacheDir, "chrome-profile"));
    const stagehand = new Stagehand({
      env: options.browser === "browserbase" ? "BROWSERBASE" : "LOCAL",
      verbose: 1,
      cacheDir: options.cacheDir,
      selfHeal: false,
      localBrowserLaunchOptions:
        options.browser === "local"
          ? {
              headless: options.headless,
              viewport: options.viewport,
              deviceScaleFactor: 1,
              userDataDir: path.join(options.cacheDir, "chrome-profile"),
              preserveUserDataDir: true,
            }
          : undefined,
    });
    await stagehand.init();
    const session = new StagehandBrowserSession("instagram.com", stagehand);
    await session.goto("https://www.instagram.com/");
    return session;
  }
}

export class StagehandBrowserSession implements BrowserSession {
  constructor(
    public readonly domain: Domain,
    private readonly stagehand: Stagehand,
  ) {}

  async currentUrl(): Promise<string> {
    return this.page().url();
  }

  async goto(url: string): Promise<void> {
    await this.page().goto(url);
  }

  async observe(instruction: string): Promise<ObservedCandidate[]> {
    const actions = await this.stagehand.observe(instruction);
    return actions.map((action, index) => ({
      id: `candidate_${index + 1}`,
      instruction,
      action,
      atom: actionToAtom(action, instruction, this.domain),
      risk: "unknown",
    }));
  }

  async act(candidate: ObservedCandidate, args?: RuntimeArgs): Promise<ActOutcome> {
    return await this.actRaw(candidate.action, args);
  }

  async actRaw(action: Action, args?: RuntimeArgs): Promise<ActOutcome> {
    const result = await this.stagehand.act(action, {
      variables: stringifyRuntimeArgs(args),
    });
    return {
      success: result.success,
      message: result.message,
      actions: result.actions || [],
    };
  }

  async exists(selector: string): Promise<boolean> {
    return (await this.page().locator(selector).count()) > 0;
  }

  async readText(selector = "body"): Promise<string> {
    const locator = this.page().locator(selector);
    return await locator.innerText();
  }

  async screenshot(label: string): Promise<string> {
    const dir = evidenceDir(this.domain);
    await ensureDir(dir);
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
    const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeLabel}.png`);
    const buffer = await this.page().screenshot();
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async waitForUser(label: string): Promise<void> {
    const rl = readline.createInterface({ input, output });
    try {
      await rl.question(`${label} Press Enter to continue... `);
    } finally {
      rl.close();
    }
  }

  async close(): Promise<void> {
    await this.stagehand.close();
  }

  private page() {
    return this.stagehand.context.pages()[0];
  }
}

function stringifyRuntimeArgs(args?: RuntimeArgs): Record<string, string> | undefined {
  if (!args) return undefined;
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)]));
}

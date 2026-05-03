import type { Action } from "@browserbasehq/stagehand";
import type {
  BrowserSession,
  ProcessArg,
  ProcessTape,
  State,
  StateActionCache,
  StateIdentity,
  TapeStep,
  TapeStore,
} from "./contracts.js";
import { sha256 } from "./hash.js";
import { actionToAtom } from "./state-identity.js";

export interface ScriptedInstagramDmOptions {
  username?: string;
  password?: string;
  recipient: "va_rad_";
  message: string;
  confirmWrite: boolean;
  assumeLoggedIn?: boolean;
}

export async function recordScriptedInstagramDm(
  session: BrowserSession,
  identity: StateIdentity,
  tapeStore: TapeStore,
  actionCache: StateActionCache,
  options: ScriptedInstagramDmOptions,
): Promise<ProcessTape> {
  if (!options.confirmWrite) {
    throw new Error("Refusing to run Instagram DM script without --confirm-write");
  }
  if (options.recipient !== "va_rad_") {
    throw new Error("V1 safety gate only allows DM recipient va_rad_.");
  }

  const steps: TapeStep[] = [];
  if (!options.assumeLoggedIn) {
    if (!options.username || !options.password) {
      throw new Error("username/password are required unless assumeLoggedIn is true.");
    }
    await session.goto("https://www.instagram.com/");
    await delay(2500);
    maybePush(
      steps,
      await runStep(session, identity, actionCache, {
        name: "fill_username",
        instruction: "fill Instagram username",
        action: {
          selector:
            "input[aria-label*='username' i], input[autocomplete='username'], input[type='text']",
          method: "fill",
          description: "fill username field",
          arguments: [options.username],
        },
        writesToPlatform: false,
        optionalIfMissing: true,
      }),
    );
    maybePush(
      steps,
      await runStep(session, identity, actionCache, {
        name: "fill_password",
        instruction: "fill Instagram password",
        action: {
          selector:
            "input[aria-label='Password'], input[autocomplete='current-password'], input[type='password']",
          method: "fill",
          description: "fill password field",
          arguments: [options.password],
        },
        writesToPlatform: false,
        optionalIfMissing: true,
      }),
    );
    maybePush(
      steps,
      await runStep(session, identity, actionCache, {
        name: "submit_login",
        instruction: "submit Instagram login",
        action: {
          selector: "//*[normalize-space()='Log in' and (self::div or self::span or self::button)]",
          method: "click",
          description: "click login submit button",
          arguments: [],
        },
        writesToPlatform: false,
        optionalIfMissing: true,
      }),
    );

    await session.waitForUser("Complete any Instagram login challenge or 2FA if shown.");
  }

  await session.goto(`https://www.instagram.com/${options.recipient}/`);
  await delay(8000);
  if (options.assumeLoggedIn) {
    await session.waitForUser(
      `Confirm the ${options.recipient} profile is loaded and the Message button is visible.`,
    );
  }
  steps.push(
    await runStep(session, identity, actionCache, {
      name: "open_recipient_profile",
      instruction: `open Instagram profile ${options.recipient}`,
      action: {
        selector: "body",
        method: "click",
        description: `arrived at profile ${options.recipient}`,
        arguments: [],
      },
      writesToPlatform: false,
    }),
  );
  steps.push(
    await runStep(session, identity, actionCache, {
      name: "open_message_thread",
      instruction: "open profile message thread",
      action: {
        selector:
          "//*[normalize-space()='Message' and (self::div or self::span or self::button or self::a)]",
        method: "click",
        description: "click Message on the profile",
        arguments: [],
      },
      writesToPlatform: false,
    }),
  );
  await delay(2000);
  steps.push(
    await runStep(session, identity, actionCache, {
      name: "fill_dm_message",
      instruction: "fill Instagram DM message",
      action: {
        selector:
          "div[contenteditable='true']",
        method: "fill",
        description: "fill the direct message composer",
        arguments: ["%message%"],
      },
      args: { message: options.message },
      writesToPlatform: true,
    }),
  );
  await delay(500);
  steps.push(
    await runStep(session, identity, actionCache, {
      name: "send_dm",
      instruction: "send Instagram DM",
      action: {
        selector: "//*[normalize-space()='Send' and (self::div or self::span or self::button)]",
        method: "click",
        description: "click Send in the direct message composer",
        arguments: [],
      },
      writesToPlatform: true,
    }),
  );

  const now = new Date().toISOString();
  const args: ProcessArg[] = [
    { name: "message", required: true, description: "DM message text" },
  ];
  const process: ProcessTape = {
    name: "send_test_dm",
    description: "send a test DM to va_rad_",
    domain: "instagram.com",
    entry: steps[0].before,
    steps,
    args,
    postconditions: [{ type: "text_contains", selector: "body", value: "%message%" }],
    writesToPlatform: true,
    createdAt: now,
    updatedAt: now,
  };
  await tapeStore.saveProcess(process);
  return process;
}

async function runStep(
  session: BrowserSession,
  identity: StateIdentity,
  actionCache: StateActionCache,
  input: {
    name: string;
    instruction: string;
    action: Action;
    args?: Record<string, string>;
    writesToPlatform: boolean;
    optionalIfMissing?: boolean;
  },
): Promise<TapeStep | null> {
  const before = await identity.capture(session, `before-${input.name}`);
  const atom = actionToAtom(input.action, input.instruction, session.domain);
  const outcome = await session.actRaw(input.action, input.args);
  if (!outcome.success) {
    if (input.optionalIfMissing && /could not find an element/i.test(outcome.message)) {
      return null;
    }
    throw new Error(`Step ${input.name} failed: ${outcome.message}`);
  }
  const after = await identity.capture(session, `after-${input.name}`);
  const now = new Date().toISOString();
  const step: TapeStep = {
    id: sha256({
      name: input.name,
      before: before.id,
      after: after.id,
      atomId: atom.id,
      at: now,
    }),
    name: input.name,
    type: input.action.method === "fill" || input.action.method === "type" ? "fill" : "click",
    before,
    after,
    atomId: atom.id,
    instruction: input.instruction,
    actions: outcome.actions.length > 0 ? outcome.actions : [input.action],
    status: "recorded",
    validationHash: after.fingerprint.hash,
    writesToPlatform: input.writesToPlatform,
    createdAt: now,
  };
  await actionCache.put({
    version: 1,
    domain: session.domain,
    beforeStateId: before.id,
    afterStateId: after.id,
    atomId: atom.id,
    instruction: input.instruction,
    actions: step.actions,
    validationHash: step.validationHash,
    status: "recorded",
    writesToPlatform: input.writesToPlatform,
    updatedAt: now,
  });
  return step;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybePush<T>(items: T[], item: T | null): void {
  if (item) items.push(item);
}

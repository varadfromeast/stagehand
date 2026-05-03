import type { CartographerLogger, LogLevel } from "./contracts.js";

export class ConsoleCartographerLogger implements CartographerLogger {
  constructor(
    private readonly enabled = process.env.CARTOGRAPHER_LOG !== "0",
    private readonly minLevel: LogLevel = parseLogLevel(process.env.CARTOGRAPHER_LOG_LEVEL),
  ) {}

  log(level: LogLevel, event: string, context: Record<string, unknown> = {}): void {
    if (!this.enabled || weight(level) < weight(this.minLevel)) return;
    const payload = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
    process.stderr.write(`[cartographer] ${level} ${event}${payload}\n`);
  }
}

export class NoopCartographerLogger implements CartographerLogger {
  log(): void {}
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function weight(level: LogLevel): number {
  if (level === "debug") return 10;
  if (level === "info") return 20;
  if (level === "warn") return 30;
  return 40;
}

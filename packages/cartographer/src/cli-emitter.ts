import fs from "node:fs/promises";
import path from "node:path";
import type { CliEmitter, CliEmitterInput, CliEmitterResult, TapeCatalog } from "./contracts.js";
import { ensureDir, readJsonFile } from "./fs-json.js";
import { catalogPath, slugifyName } from "./paths.js";

export class NodeCliEmitter implements CliEmitter {
  async emit(input: CliEmitterInput): Promise<CliEmitterResult> {
    const catalog = await readJsonFile<TapeCatalog>(catalogPath(input.domain));
    if (!catalog) throw new Error(`No tape catalog found for ${input.domain}`);

    const commandInfo = Object.fromEntries(
      Object.values(catalog.processes).map((process) => [
        slugifyName(process.name),
        {
          processName: process.name,
          description: process.description,
          args: process.args,
          outputs: process.outputs || [],
          postconditions: process.postconditions || [],
          writesToPlatform: process.writesToPlatform,
        },
      ]),
    );
    const runtimeModuleUrl = new URL("./index.js", import.meta.url).href;
    await ensureDir(path.dirname(input.outputPath));
    await fs.writeFile(input.outputPath, renderCli(input.binName, input.domain, commandInfo, runtimeModuleUrl), {
      encoding: "utf8",
      mode: 0o755,
    });
    await fs.chmod(input.outputPath, 0o755);
    return {
      outputPath: input.outputPath,
      commandCount: Object.keys(commandInfo).length,
      commands: Object.keys(commandInfo),
    };
  }
}

function renderCli(
  binName: string,
  domain: string,
  commandInfo: Record<string, unknown>,
  runtimeModuleUrl: string,
): string {
  const commandInfoJson = JSON.stringify(commandInfo, null, 2);
  return `#!/usr/bin/env node
const { createPreloadedRuntime, parseRuntimeArgs } = await import(${JSON.stringify(runtimeModuleUrl)});

const binName = ${JSON.stringify(binName)};
const commandInfo = ${commandInfoJson};
const [, , command, ...rest] = process.argv;

if (!command || command === "--help" || command === "-h") {
  console.log(\`${binName} <command> [--confirm-write] [--dry-run] [--key value]\`);
  console.log("");
  console.log("Commands:");
  for (const [name, info] of Object.entries(commandInfo)) {
    const write = info.writesToPlatform ? " [writes]" : "";
    console.log(\`  \${name}\${write} - \${info.description || info.processName}\`);
  }
  console.log("");
  console.log(\`Use \${binName} <command> --help for command-specific args, outputs, and postconditions.\`);
  process.exit(command ? 0 : 1);
}

if (!commandInfo[command]) {
  console.error(\`Unknown command: \${command}\`);
  process.exit(1);
}

if (rest.includes("--help") || rest.includes("-h")) {
  const info = commandInfo[command];
  console.log(\`${binName} \${command}\${info.args.map((arg) => \` --\${toCliFlag(arg.name)} <\${arg.name}>\`).join("")}\${info.writesToPlatform ? " --confirm-write" : ""}\`);
  console.log("");
  console.log(info.description || info.processName);
  if (info.writesToPlatform) {
    console.log("");
    console.log("Writes to platform: yes. Use --dry-run first and --confirm-write to execute.");
  }
  if (info.args.length) {
    console.log("");
    console.log("Args:");
    for (const arg of info.args) console.log(\`  --\${toCliFlag(arg.name)} <\${arg.name}>  \${arg.description || ""}\${arg.required ? " (required)" : ""}\`);
  }
  if (info.outputs.length) {
    console.log("");
    console.log("Outputs:");
    for (const output of info.outputs) console.log(\`  outputs.\${output.name}  \${output.description} [\${output.selector}]\`);
  }
  if (info.postconditions.length) {
    console.log("");
    console.log("Postconditions:");
    for (const postcondition of info.postconditions) console.log(\`  \${formatPostcondition(postcondition)}\`);
  }
  process.exit(0);
}

const parsed = parseRuntimeArgs(rest);
const runtime = await createPreloadedRuntime(${JSON.stringify(domain)});
const result = await runtime.runProcess({
  domain: ${JSON.stringify(domain)},
  processName: commandInfo[command].processName,
  args: parsed.args,
  confirmWrite: parsed.confirmWrite,
  dryRun: parsed.dryRun,
});
console.log(JSON.stringify(result, null, 2));
if (!result.success) process.exitCode = 1;

function toCliFlag(argName) {
  return argName.replace(/[A-Z]/g, (match) => \`-\${match.toLowerCase()}\`);
}

function formatPostcondition(postcondition) {
  if (postcondition.type === "selector_exists") return \`selector_exists \${postcondition.selector}\`;
  if (postcondition.type === "text_contains") return \`text_contains \${postcondition.selector} includes \${JSON.stringify(postcondition.value)}\`;
  return \`\${postcondition.type} \${postcondition.value}\`;
}
`;
}

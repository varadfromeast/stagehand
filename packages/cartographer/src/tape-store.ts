import fs from "node:fs/promises";
import path from "node:path";
import type {
  Domain,
  ProcessName,
  ProcessTape,
  ProcessTapeSummary,
  TapeCatalog,
  TapeStore,
} from "./contracts.js";
import { catalogPath, processTapePath, skillProcessPath, skillReadmePath, tapeDir } from "./paths.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs-json.js";

export class JsonTapeStore implements TapeStore {
  async loadCatalog(domain: Domain): Promise<TapeCatalog | null> {
    return await readJsonFile<TapeCatalog>(catalogPath(domain));
  }

  async loadProcess(domain: Domain, name: ProcessName): Promise<ProcessTape | null> {
    return await readJsonFile<ProcessTape>(processTapePath(domain, name));
  }

  async saveCatalog(catalog: TapeCatalog): Promise<void> {
    await writeJsonFile(catalogPath(catalog.domain), catalog);
  }

  async saveProcess(process: ProcessTape): Promise<void> {
    await ensureDir(tapeDir(process.domain));
    await writeJsonFile(processTapePath(process.domain, process.name), process);
    await writeJsonFile(skillProcessPath(process.domain, process.name), process);
    await writeSkillReadme(process);

    const existing = await this.loadCatalog(process.domain);
    const catalog: TapeCatalog = existing || {
      domain: process.domain,
      version: 1,
      processes: {},
      updatedAt: new Date().toISOString(),
    };
    catalog.processes[process.name] = summarizeProcess(process);
    catalog.updatedAt = new Date().toISOString();
    await this.saveCatalog(catalog);
  }
}

function summarizeProcess(process: ProcessTape): ProcessTapeSummary {
  return {
    name: process.name,
    description: process.description,
    stepCount: process.steps.length,
    writesToPlatform: process.writesToPlatform,
    args: process.args,
    outputs: process.outputs,
    postconditions: process.postconditions,
    updatedAt: process.updatedAt,
  };
}

async function writeSkillReadme(process: ProcessTape): Promise<void> {
  const lines = [
    `# ${process.name}`,
    "",
    process.description,
    "",
    `- Domain: ${process.domain}`,
    `- Steps: ${process.steps.length}`,
    `- Writes: ${String(process.writesToPlatform)}`,
  ];
  if (process.args.length) {
    lines.push("", "## Arguments", "");
    for (const arg of process.args) {
      lines.push(`- \`${arg.name}\`: ${arg.description}${arg.required ? " (required)" : ""}`);
    }
  }
  if (process.outputs?.length) {
    lines.push("", "## Outputs", "");
    for (const output of process.outputs) {
      lines.push(`- \`${output.name}\`: ${output.description} from \`${output.selector}\``);
    }
  }
  if (process.postconditions?.length) {
    lines.push("", "## Postconditions", "");
    for (const postcondition of process.postconditions) {
      if (postcondition.type === "selector_exists") {
        lines.push(`- \`selector_exists\`: \`${postcondition.selector}\``);
      } else if (postcondition.type === "text_contains") {
        lines.push(`- \`text_contains\`: \`${postcondition.selector}\` includes \`${postcondition.value}\``);
      } else {
        lines.push(`- \`${postcondition.type}\`: \`${postcondition.value}\``);
      }
    }
  }
  const outputPath = skillReadmePath(process.domain, process.name);
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

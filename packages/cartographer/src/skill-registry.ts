import type {
  Domain,
  CartographerLogger,
  LoadedSkillset,
  ProcessName,
  ProcessTape,
  ProcessTapeSummary,
  SkillRegistry,
  TapeStore,
} from "./contracts.js";
import { ConsoleCartographerLogger } from "./logger.js";

export class PreloadedSkillRegistry implements SkillRegistry {
  private readonly loaded = new Map<Domain, LoadedSkillset>();

  constructor(
    private readonly tapeStore: TapeStore,
    private readonly logger: CartographerLogger = new ConsoleCartographerLogger(),
  ) {}

  async preload(domain: Domain): Promise<LoadedSkillset> {
    const existing = this.loaded.get(domain);
    if (existing) {
      this.logger.log("debug", "registry.preload.hit", {
        domain,
        processCount: Object.keys(existing.processes).length,
      });
      return existing;
    }
    this.logger.log("info", "registry.preload.miss", { domain });
    return await this.refresh(domain);
  }

  async refresh(domain: Domain): Promise<LoadedSkillset> {
    this.logger.log("info", "registry.refresh.start", { domain });
    const catalog = await this.tapeStore.loadCatalog(domain);
    if (!catalog) throw new Error(`No tape catalog found for ${domain}`);

    const processes: Record<ProcessName, ProcessTape> = {};
    for (const name of Object.keys(catalog.processes)) {
      const process = await this.tapeStore.loadProcess(domain, name);
      if (!process) {
        throw new Error(`Catalog references missing process tape: ${name}`);
      }
      processes[name] = process;
    }

    const skillset: LoadedSkillset = {
      domain,
      catalog,
      processes,
      loadedAt: new Date().toISOString(),
    };
    this.loaded.set(domain, skillset);
    this.logger.log("info", "registry.refresh.done", {
      domain,
      processCount: Object.keys(processes).length,
    });
    return skillset;
  }

  async getProcess(domain: Domain, name: ProcessName): Promise<ProcessTape | null> {
    const skillset = await this.preload(domain);
    this.logger.log("debug", "registry.get_process", {
      domain,
      name,
      found: Boolean(skillset.processes[name]),
    });
    return skillset.processes[name] || null;
  }

  async listProcesses(domain: Domain): Promise<ProcessTapeSummary[]> {
    const skillset = await this.preload(domain);
    return Object.values(skillset.catalog.processes).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
}

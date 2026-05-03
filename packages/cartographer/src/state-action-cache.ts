import type {
  StateActionCache,
  StateActionCacheEntry,
  StateActionCacheKey,
} from "./contracts.js";
import { readJsonFile, writeJsonFile } from "./fs-json.js";
import { sha256 } from "./hash.js";
import { stateActionCacheDir } from "./paths.js";
import path from "node:path";

export class JsonStateActionCache implements StateActionCache {
  async get(key: StateActionCacheKey): Promise<StateActionCacheEntry | null> {
    return await readJsonFile<StateActionCacheEntry>(this.pathFor(key));
  }

  async put(entry: StateActionCacheEntry): Promise<void> {
    await writeJsonFile(this.pathFor(entry), entry);
  }

  async markDrifted(key: StateActionCacheKey, reason: string): Promise<void> {
    const existing = await this.get(key);
    if (!existing) return;
    await this.put({
      ...existing,
      status: "drifted",
      updatedAt: new Date().toISOString(),
      instruction: `${existing.instruction}\n\nDrift reason: ${reason}`,
    });
  }

  private pathFor(key: StateActionCacheKey): string {
    const cacheKey = sha256({
      domain: key.domain,
      beforeStateId: key.beforeStateId,
      atomId: key.atomId,
    });
    return path.join(stateActionCacheDir(key.domain), `${cacheKey}.json`);
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import type {
  CaptureScreenshotInput,
  CaptureTextInput,
  EvidenceArtifact,
  EvidenceStore,
} from "./contracts.js";
import { ensureDir } from "./fs-json.js";
import { evidenceDir } from "./paths.js";

export class FileEvidenceStore implements EvidenceStore {
  async captureScreenshot(input: CaptureScreenshotInput): Promise<EvidenceArtifact> {
    const dir = evidenceDir(input.domain);
    await ensureDir(dir);
    const filePath = path.join(dir, `${timestamp()}-${safeLabel(input.label)}.png`);
    await fs.writeFile(filePath, await input.screenshot());
    return {
      kind: "screenshot",
      label: input.label,
      path: filePath,
      createdAt: new Date().toISOString(),
    };
  }

  async captureText(input: CaptureTextInput): Promise<EvidenceArtifact> {
    const dir = evidenceDir(input.domain);
    await ensureDir(dir);
    const filePath = path.join(dir, `${timestamp()}-${safeLabel(input.label)}.txt`);
    await fs.writeFile(filePath, input.text, "utf8");
    return {
      kind: "text",
      label: input.label,
      path: filePath,
      selector: input.selector,
      createdAt: new Date().toISOString(),
    };
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeLabel(label: string): string {
  return label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "evidence";
}

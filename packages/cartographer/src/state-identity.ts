import type { Action } from "@browserbasehq/stagehand";
import type {
  Atom,
  BrowserSession,
  ObservedCandidate,
  State,
  StateDiff,
  StateFingerprint,
  StateIdentity,
  StateKind,
} from "./contracts.js";
import { sha256 } from "./hash.js";

const SNAPSHOT_INSTRUCTION =
  "Find all visible interactive elements and controls on this page, including buttons, links, inputs, tabs, menu items, and message controls.";

export class BasicStateIdentity implements StateIdentity {
  async capture(session: BrowserSession, label?: string): Promise<State> {
    const url = await session.currentUrl();
    let candidates: ObservedCandidate[] = [];
    if (process.env.CARTOGRAPHER_SNAPSHOT_OBSERVE === "1") {
      try {
        candidates = await session.observe(SNAPSHOT_INSTRUCTION);
      } catch {
        candidates = [];
      }
    }
    const atoms = this.canonicalize(candidates);
    const kind: StateKind = "unknown";
    const fingerprint = this.fingerprint(atoms, url, kind);
    const evidencePath = label ? await session.screenshot(label) : undefined;

    return {
      id: fingerprint.hash,
      domain: session.domain,
      url,
      kind,
      fingerprint,
      atoms,
      observedAt: new Date().toISOString(),
      evidencePath,
    };
  }

  fingerprint(atoms: Atom[], url: string, kind: StateKind = "unknown"): StateFingerprint {
    const atomIds = atoms.map((atom) => atom.id).sort();
    const urlShape = shapeUrl(url);
    const hash = sha256({ atomIds, kind, urlShape });
    return {
      hash,
      atomIds,
      urlShape,
      atomCount: atomIds.length,
    };
  }

  canonicalize(candidates: ObservedCandidate[]): Atom[] {
    const byId = new Map<string, Atom>();
    for (const candidate of candidates) {
      byId.set(candidate.atom.id, candidate.atom);
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  diff(a: StateFingerprint, b: StateFingerprint): StateDiff {
    const aSet = new Set(a.atomIds);
    const bSet = new Set(b.atomIds);
    const addedAtomIds = b.atomIds.filter((id) => !aSet.has(id));
    const removedAtomIds = a.atomIds.filter((id) => !bSet.has(id));
    const stableCount = a.atomIds.filter((id) => bSet.has(id)).length;
    const denominator = Math.max(a.atomIds.length, b.atomIds.length, 1);
    return {
      sameHash: a.hash === b.hash,
      addedAtomIds,
      removedAtomIds,
      stableAtomRatio: stableCount / denominator,
    };
  }
}

export function actionToAtom(action: Action, instruction: string, domain = "instagram.com"): Atom {
  const description = normalizeText(action.description || instruction || "action");
  const accessibleName = extractAccessibleName(action, description);
  const method = action.method?.trim() || "unknown";
  const xpathShape = shapeSelector(action.selector);
  const id = sha256({
    domain,
    accessibleName,
    description,
    method,
    xpathShape,
  });

  return {
    id,
    description,
    accessibleName,
    selector: action.selector,
    method: action.method,
    xpathShape,
  };
}

export function shapeSelector(selector: string): string {
  return selector
    .replace(/\[\d+\]/g, "[]")
    .replace(/@[a-zA-Z:-]+=['\"][^'\"]+['\"]/g, "@attr")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAccessibleName(action: Action, fallback: string): string {
  const args = action.arguments?.filter(Boolean).join(" ");
  const source = args || action.description || fallback;
  return normalizeText(source).slice(0, 120);
}

export function shapeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

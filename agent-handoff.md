# Agent Handoff — Cartographer (Stagehand fork)

## Current State

This is a fork of [`browserbase/stagehand`](https://github.com/browserbase/stagehand)
created on 2026-05-01 to host the **Cartographer** project.

Cartographer is the successor to `siteforge` (now abandoned). The siteforge
experiment validated that an agent's per-site navigation cost can be cached
into a state-graph and replayed deterministically — but it tried to rebuild
Stagehand's substrate from scratch (atom extraction, XPath resolution,
self-healing replay, etc.). That was the wrong layer. **Stagehand has already
shipped 60–70% of what siteforge was rebuilding.** This fork is the pivot:
build the graph + emitter layer on top of Stagehand instead of replacing it.

The arc is:

```
fork upstream stagehand
    ↓
add 4 new packages alongside packages/core
    ↓
state identity layer over Stagehand snapshots
    ↓
state-keyed cache (cross-instruction reuse — Stagehand's blind spot)
    ↓
proactive cartographer (active exploration, safety-gated)
    ↓
path planner + runtime (replay paths through Stagehand)
    ↓
emit per-site CLI + MCP + 2D viewer (3D toggle later)
    ↓
agents browse known sites by traversing cached graphs
```

End goal: **make navigating known websites for agents as cheap as querying a
GitNexus-indexed codebase.**

## Why fork instead of build a separate package?

We chose fork because we want:
- Easy `git pull upstream main` to track Stagehand's fast-moving work
- Visibility into Stagehand's internals (`understudy/a11y/snapshot/`, `ActCache.ts`,
  `flowlogger/`) when the consumer API isn't enough
- Future option to upstream parts of the cartographer as PRs

We are **not** modifying `packages/core/`. All cartographer work lives in new
packages alongside it.

## Repo Layout

```
stagehand/
  packages/
    core/             ← upstream — never modified
    docs/             ← upstream
    cli/              ← upstream Stagehand CLI
    server-v3/        ← upstream
    server-v4/        ← upstream
    evals/            ← upstream
    cartographer/     ← NEW — exploration + map recording
    runtime-graph/    ← NEW — state-keyed cache + planner + replayer
    emitters/         ← NEW — CLI + MCP generators
    viewer/           ← NEW — 2D graph UI (3D toggle planned)
```

Each new package depends on `@browserbasehq/stagehand` like any external
consumer. No source-level coupling to `packages/core/`.

## What Stagehand Already Provides (use, don't rebuild)

After deep-reading `lib/v3/`:

- **`Stagehand.observe(instruction)`** → `Action[]` with full XPath. This is
  the atom-enumeration primitive. **Replaces siteforge's broken atom
  extractor** — XPaths are populated for free.
- **`Stagehand.act(action | instruction)`** → executes one action; the cached
  `ActCache.replayCachedActions` already runs `takeDeterministicAction` per
  action with self-heal write-back.
- **`Stagehand.agent(config)`** → autonomous CUA loop with `AgentCache` that
  records `AgentReplayStep[]` and replays without LLM tokens (see
  `examples/cua-replay.ts`).
- **`captureHybridSnapshot(page)`** (in `understudy/a11y/snapshot/`) →
  `combinedTree` (text a11y) + `combinedXpathMap` (encodedId → XPath).
- **`CacheStorage`** → pluggable JSON-on-disk cache primitive. Pattern shown
  in `cache/ActCache.ts` and `cache/AgentCache.ts`.
- **`FlowLogger.EventStore`** → query `(sessionId, eventType, limit)` to walk
  all events. Subscribe for graph recording, drift detection.
- **`takeDeterministicAction(action, page, ...)`** → executes a cached
  `Action` without LLM. Used internally by `ActCache`. Public-ish via
  `ActHandler`.
- **Browserbase + local Chrome session management, viewport handling,
  iframe traversal, shadow-root piercing** — all done.

## What Stagehand Does NOT Do (the gap = our novelty)

Stagehand's `ActCache` and `AgentCache` are both keyed by
`sha256(instruction, url, options, configSig, variableKeys)`. That means:

1. **No cross-instruction cache reuse.** `act("open inbox")` and
   `act("go to messages")` get separate cache entries even if the underlying
   click sequence is identical.
2. **No graph / state model.** No "I'm in state X, here are the available
   transitions." Just opaque cache entries hashed by inputs.
3. **No proactive exploration.** Cache is populated reactively; first run of
   each new instruction pays full LLM cost.
4. **No path planning.** Can't ask "shortest cached path from current state
   to target state."
5. **No emitted artifacts.** `cacheDir` is dev-side; no per-site CLI binary,
   no MCP server *generated* from the cache.
6. **No site-level drift signal.** Self-heal happens per-edge but isn't
   aggregated into "this site changed, time to re-explore."

These are exactly the layers Cartographer adds.

## Workstreams

### A — State Identity Layer (foundational)

Take Stagehand's hybrid snapshot (or `observe()` results) and produce a
stable `StateId` (sha256 of canonicalized atom-set). Two visits to the same
logical screen → same id, even when content differs.

**Stagehand provides:** `combinedTree`, `combinedXpathMap`, `Action[]` from
`observe()`.

**You build:** `canonicalizeAtoms()` (filter noise), `surfaceFilter` plugin
hook (per-site predicates), `hashAtomSet()` (sha256).

**Doability: HIGH.** ~300–500 LOC. Most of `siteforge/src/core/canonicalize.ts`
and `hash.ts` ports directly.

**Risk:** State hash stability across sessions is the load-bearing assumption.
**Mitigation: build the cross-session-stability test FIRST (week 1 spike).**

### B — State-Keyed Cache (the actual novelty)

A new cache class `StateActionCache` keyed by `(state_id, atom_id)` — "from
this logical state, executing this atom yields these `Action[]` and lands at
that state."

**Stagehand provides:** `CacheStorage` is pluggable; `ActCache.ts` shows the
shape (read/write JSON, self-heal write-back, variables).

**You build:** A new cache class with `(from_state, atom_id) → action_list`
keying. Self-heal falls back to `Stagehand.act(atom.description)` and writes
back the new actions.

**Why this is the win:** Two different user instructions sharing the same
underlying state→atom→state transition share one cache entry. Stagehand
cannot do this today.

**Doability: HIGH.** ~400–600 LOC. Mirrors `ActCache.ts` (387 LOC) with
different keying.

**Risk:** Atom IDs need to disambiguate "like button on home" vs "like button
in reels modal." Use `atom_id = sha256(role + accessible_name + xpath_shape)`
where `xpath_shape` is a path-template (drop indices, keep tag names).

### C — Cartographer (proactive exploration)

The site cartographer plan from siteforge's `SITE_CARTOGRAPHER_PLAN.md`,
rebuilt on Stagehand primitives. Drives `observe()` to enumerate, `act()` to
validate, records edges into the graph.

**Stagehand provides:** `observe()` for ENUMERATE, `act()` for VALIDATE,
`bus.emit('screenshot', ...)` for evidence, session management for SETUP.

**You build:** `Cartographer` class wrapping a Stagehand instance.
`Policy` interface with implementations (`RulePolicy`, later `PromptPolicy`,
`LlmPolicy`, `HybridPolicy`). `SafetyGate` with default-deny verb list.
`MapRecorder` writing `graph.json` via `FlowLogger` event subscription.

**Doability: HIGH for Phase 1, MEDIUM for Phase 3.** Phase 1 (RulePolicy with
hardcoded patterns + safety gate + recorder): ~1000 LOC. Phase 2
(prompt-aware): +500. Phase 3 (LLM policy): +500.

**Risks:**
- Anti-detection during automated exploration → use Browserbase tier or
  rate-limit + jitter on local. Min 1s throttle.
- Backtracking via `page.goBack()` works ~80%; maintain anchor URLs as
  fallback.
- Phase 3 (what should the LLM policy decide?) is genuinely hard — punt to
  v2; ship Phase 1 with rule-based discovery.

### D — Path Planner + Runtime

BFS over the graph for shortest path; replay edges via
`takeDeterministicAction`; self-heal via `act()` with write-back.

**Stagehand provides:** `ActHandler.takeDeterministicAction(action, page, ...)`
is the public-ish "execute without LLM" API. Confirm via week-1 spike #2.

**You build:** `planPath(graph, from, to)` (BFS — siteforge's `core/plan-path.ts`
ports as-is), `replayEdge(operation)` wrapping `takeDeterministicAction`,
fallback to `act(operation.instruction)` on failure, write-back on heal.

**Doability: HIGH.** ~400 LOC.

### E — CLI Emitter

Compile a `SiteGraph` into a per-site CLI binary. Each `Process` becomes a
subcommand. Args from `Process.args`. Subcommand internally: load graph →
planPath → replay.

**Stagehand provides:** Nothing specific.

**You build:** Template-based generator. Read graph → for each Process, emit
a Commander subcommand → bundle with esbuild → ship as
`~/.cartographer/bin/<domain>-cli`.

**Doability: HIGH.** ~400–600 LOC. Hard part isn't emit — it's having
well-named Processes (Workstream C Phase 4 / hand-curated v1).

### F — MCP Emitter

Generate a per-site MCP server exposing the graph as resources
(`site://<domain>/states`, `site://<domain>/processes`, etc.) and tools
(`run_process`, `find_path`, `validate`, `explore`).

**Stagehand provides:** `@modelcontextprotocol/sdk` is already a peer dep;
`lib/v3/mcp/connection.ts` shows MCP client patterns.

**You build:** Template-based generator producing a Node script that loads
the graph, exposes resources via MCP SDK (each ≤500 tokens), exposes tools
backed by your runtime.

**Doability: HIGH.** ~500 LOC.

### G — Drift Signal at the Site Level

Aggregate per-edge drift events (when self-heal fires) into a per-site
`drift_score`. Surface via `cartographer status <domain>` or as MCP resource.

**Stagehand provides:** `FlowLogger.EventStore.query()` — subscribe to
events, including replay misses and self-heals, with `sessionId` and
`eventType` filters.

**You build:** A subscriber that watches FlowLogger for `StateActionCache`
misses and self-heal events, increments per-edge `drift_score`, persists to
graph metadata.

**Doability: HIGH.** ~200 LOC.

### H — 2D Graph Viewer (3D toggle later)

Visualize the site graph. Force-directed, cluster-coloured, hover for state
preview, click to play replay.

**Stagehand provides:** Nothing.

**You build:** A small web app using `react-force-graph-2d` (same author has
a drop-in 3D variant). Reads `graph.json`, renders force layout, surfaces
drift.

**Doability:**
- 2D: HIGH. ~600–1000 LOC. `react-force-graph-2d` does most of the work.
- 3D: MEDIUM. Same library has `react-force-graph-3d` — drop-in swap, same
  data shape. The hard part isn't 3D rendering, it's whether 3D adds value
  for sparse graphs (it doesn't, for ≤50 nodes).

**Recommendation:** Build 2D first. Add 3D as a `--3d` toggle in v1.5 once
the graph is dense enough (50+ states across multiple sites) for 3D to be
useful and not just decorative.

GitNexus uses **Sigma.js + Graphology** (also 2D). Their stack is a fine
reference; we use `react-force-graph-2d` because it's friendlier for our
size and gives a free 3D upgrade path.

## What NOT to Do

- ❌ Reimplement Stagehand's atom extractor / XPath resolver / a11y handling.
  Use `observe()` and `captureHybridSnapshot`.
- ❌ Build a new browser harness. V3 already abstracts CDP/Playwright/Puppeteer.
- ❌ Reimplement `takeDeterministicAction`. Wrap Stagehand's.
- ❌ Build session/auth persistence. Stagehand has it.
- ❌ Auto-name processes via LLM in v1. Hand-curate via
  `cartographer name-process --name X --from <state> --to <state>`.
- ❌ Run Leiden clustering until graph is dense (50+ states). Flat process
  list for v1.
- ❌ Build a graph DB. JSON files. Move to SQLite if a graph exceeds ~5k
  states.
- ❌ Modify `packages/core/`. All work lives in new packages.

## Spikes to Run Before Committing 6+ Weeks

Two 1-day spikes in week 1. If either fails, revisit the plan before
continuing.

### Spike 1 — State hash stability across sessions

50-line script:

1. Launch Stagehand, navigate to `instagram.com`, `waitForLoadState("networkidle")`.
2. Call `observe("find all interactive elements")` → `Action[]`.
3. Canonicalize names + roles + xpath-shape, hash → `StateId_a`.
4. Close browser. Wait. Reopen. Same flow → `StateId_b`.
5. Print `StateId_a === StateId_b`.

**Pass criterion:** identical hashes for the same logged-in home view across
two sessions. Acceptable to require minor canonicalization to pass (drop
trailing-time content, handle account-name variants).

**Fail mode:** if hashes differ wildly, atom canonicalization needs more
work *or* Stagehand's a11y tree is non-deterministic at our resolution. We
re-scope before continuing.

### Spike 2 — Direct `takeDeterministicAction` call

30-line script:

1. Launch Stagehand on a known page.
2. Call `observe("find the Sign in button")` → `Action[]`. Save first action.
3. Reload the page.
4. Call `actHandler.takeDeterministicAction(savedAction, page, ...)` directly.
5. Confirm the click happens without an LLM call.

**Pass criterion:** action executes, no LLM token spent.

**Fail mode:** the function isn't accessible outside `ActCache`. Then our
runtime calls `act(action.description)` instead — slower (LLM-driven on
miss), but still works. Plan adjusts: runtime always pays LLM cost on
*first* call per edge (write-back populates cache for subsequent calls).

## Recommended Order

| # | Workstream | Effort | Why this order |
|---|---|---|---|
| 0 | Spikes 1 + 2 | 2 days | De-risk before committing. |
| 1 | A — State Identity | 3–5 days | Foundation. |
| 2 | B — State-Keyed Cache | 4–6 days | The actual novelty win. |
| 3 | D — Path Planner + Runtime (narrow) | 2–3 days | Tracer-bullet through the whole pipe with a hand-authored 2-state graph. |
| 4 | E — CLI Emitter (narrow) | 2–3 days | Continue the tracer: emit one CLI subcommand. |
| 5 | C — Cartographer Phase 1 | 7–10 days | Replace the hand-authored graph with explored output. |
| 6 | H — 2D Viewer | 5–7 days | Visualize what you've built. |
| 7 | G — Drift Signal | 2–3 days | Subscribe to FlowLogger; aggregate. |
| 8 | F — MCP Emitter | 3–5 days | Last; CLI works first. |
| 9 | C Phase 2/3 — Prompt + LLM Policy | 2–3 weeks | Optional. |
| 10 | H 3D toggle | 3–5 days | Optional, after 2D is useful. |

**Total minimum-viable v1: ~6–8 weeks.**

## Day 1 Setup (literal commands)

```bash
git clone https://github.com/varadfromeast/stagehand.git
cd stagehand
git remote add upstream https://github.com/browserbase/stagehand.git
git fetch upstream

pnpm install
pnpm --filter @browserbasehq/stagehand build

# create the cartographer skeleton
mkdir -p packages/cartographer/src
cd packages/cartographer
pnpm init  # name: @cartographer/core; private: true
# add @browserbasehq/stagehand as a workspace dep
```

Push the skeleton, run Spike 1 the same day.

## Naming

Project: **Cartographer** (or **stagehand-cartographer** for the package
name). Reasons:
- Mirrors the existing `SITE_CARTOGRAPHER_PLAN.md` framing
- Signals "extension to Stagehand," not competitor
- Maps cleanly to GitNexus's "graph index" but for sites, not code

The CLI binary, when emitted, is named per site:
`~/.cartographer/bin/<domain>-cli`.

## What Was Built (so far in this fork)

Nothing. Just the fork itself and these handoff docs. Day 1 work is the
spikes + package skeleton.

## References

- Upstream: https://github.com/browserbase/stagehand
- Fork: https://github.com/varadfromeast/stagehand
- siteforge (abandoned): https://github.com/varadfromeast/siteforge
- Stagehand caching docs: https://docs.stagehand.dev/v3/best-practices/caching
- Stagehand cua-replay example: `packages/core/examples/cua-replay.ts`
- GitNexus (the inspiration for the graph + emitter pattern):
  https://github.com/abhigyanpatwari/GitNexus

## Verification Status

At handoff time, the following are true:

- ✅ Fork created at `varadfromeast/stagehand`, default branch `main`
- ✅ `agent-handoff.md` (this file) committed
- ✅ `UBIQUITOUS_LANGUAGE.md` committed
- ⏳ Spikes 1 + 2 not yet run
- ⏳ No `packages/cartographer/` skeleton yet
- ⏳ No code

## Caution

- Cartographer drives a real browser against real sites. **Do not run
  cartographer's exploration phase against accounts you can't afford to
  lose.** Use throwaway accounts for any aggressive exploration. The safety
  gate is the first line of defense, not the last.
- Anti-bot detection is real. Throttle (min 1s, jitter to 3s). Use existing
  user sessions instead of fresh logins where possible.
- We are using a fork. Upstream Stagehand changes fast. Pull weekly:
  `git fetch upstream && git rebase upstream/main` (or merge if rebase
  conflicts get hairy).

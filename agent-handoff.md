# Agent Handoff — Cartographer (Stagehand fork)

## Current State

This is a fork of [`browserbase/stagehand`](https://github.com/browserbase/stagehand)
created on 2026-05-01 to host the **Cartographer** project.

Cartographer is the successor to `siteforge` (now abandoned). The siteforge
experiment validated the core thesis — an agent's per-site navigation cost can
be cached into a state-graph and replayed deterministically — but tried to
rebuild Stagehand's substrate from scratch (atom extraction, XPath resolution,
self-healing replay, etc.). That was the wrong layer. **Stagehand has already
shipped 60–70% of what siteforge was rebuilding.** This fork is the pivot:
build the graph + emitter + workflow layer on top of Stagehand instead of
replacing it.

The arc is:

```
fork upstream stagehand
    ↓
add 5 new packages alongside packages/core
    ↓
state identity layer over Stagehand snapshots
    ↓
state-keyed cache (cross-process edge reuse — Stagehand's blind spot)
    ↓
proactive cartographer (active exploration, safety-gated)
    ↓
path planner + runtime (replay paths through Stagehand)
    ↓
emit per-site CLI + MCP + 2D viewer
    ↓
campaigns package (build → review → send pipeline)
    ↓
agents browse known sites → build qualified lists → send carefully
```

**End goal:** make navigating known sites for agents as cheap as querying a
GitNexus-indexed codebase, **and** turn that into actionable bulk-workflow
tooling (lead lists, outbound campaigns, research artifacts, recruiting,
competitive intel) where one indexed site benefits every workflow built on it.

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
    campaigns/        ← NEW — platform-agnostic build / review / send pipeline
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
`sha256(instruction, url, options, configSig, variableKeys)` — the natural-
language instruction string is part of the cache key. That means:

1. **No cross-process edge reuse.** Two named Processes that traverse the
   same `(from_state → atom → to_state)` edge cannot share a cache entry,
   because Stagehand keys by the literal instruction wording. Cartographer's
   `StateActionCache` keys by `(state_id, atom_id)` — pure graph position —
   so any Process passing through that edge benefits, regardless of how the
   user phrased the request.
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
7. **No campaign tooling.** No list-building, no human-review queue, no
   paced send loop. Stagehand stops at "execute one task." Real bulk
   workflows (outbound, enrichment, research) need the workflow layer above.

These are exactly the layers Cartographer adds.

## Cache Semantics — Be Precise

The `StateActionCache` is **structural, not semantic**. The cache key is
`(state_id, atom_id)` — a pure function of graph position. The natural-
language instruction never enters the cache key. There is no embedding, no
LLM similarity check, no synonym detection.

**Worked example.** After Cartographer indexes Instagram, two Processes:

```
Process "open_inbox"
  edges: [home_state → inbox_btn → inbox_state]

Process "send_dm_to_alice"
  edges: [home_state → inbox_btn → inbox_state,
          inbox_state → alice_thread_btn → thread_state,
          thread_state → message_textbox → thread_filled,
          thread_filled → send_btn → thread_sent]
```

First call: `cartographer.run("open_inbox")`
- Compute current state_id = sha256(canonicalized atoms) → "home_state".
- Look up `(home_state, inbox_btn_atom_id)` in StateActionCache → **MISS**.
- Fall back: `stagehand.act("click the inbox button")` resolves the selector
  via LLM, executes via `takeDeterministicAction`.
- Write result to cache: `(home_state, inbox_btn_atom_id) → cached Action[]`.

Second call: `cartographer.run("send_dm_to_alice")`
- Compute current state_id → "home_state" (back at home).
- First edge: look up `(home_state, inbox_btn_atom_id)` → **HIT**.
- Replay cached Action via `takeDeterministicAction`. **No LLM call.**
- Subsequent edges resolve the same way (hit if seen, miss if new).

The reuse is between **Processes**, not between phrasings. Two completely
different goals (`open_inbox` and `send_dm_to_alice`) share the same first
edge by graph structure, not by linguistic similarity.

If a future use case requires "user types free-form, system finds the right
process," that's a separate **Process Resolver** layer above the cache —
optional, deferred to v2. The cache itself stays structural.

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
**Mitigation: build the cross-session-stability test FIRST (Spike 1).**

### B — State-Keyed Cache (the actual novelty)

A new cache class `StateActionCache` keyed by `(state_id, atom_id)` — "from
this logical state, executing this atom yields these `Action[]` and lands at
that state."

**Stagehand provides:** `CacheStorage` is pluggable; `ActCache.ts` shows the
shape (read/write JSON, self-heal write-back, variables).

**You build:** A new cache class with `(from_state, atom_id) → action_list`
keying. Self-heal falls back to `Stagehand.act(atom.description)` and writes
back the new actions.

**Why this is the win:** structural key → cross-process edge reuse. Stagehand
cannot do this today (instruction-keyed). See "Cache Semantics" above for
worked example.

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
is the public-ish "execute without LLM" API. Confirm via Spike 2.

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

### I — Campaigns Package (the workflow layer)

Platform-agnostic list-building + human-review + paced-send pipeline. Sits
ON TOP of the per-site CLI/MCP that emitters produce. Turns "indexed graph"
into "actionable bulk workflow." This is what makes Cartographer a product
rather than plumbing.

Three phases, each with its own risk profile:

| Phase | Activity | Platform risk | Throttle |
|---|---|---|---|
| 1: Build | hashtag walks, profile views, post reads, LLM reasoning, draft DMs | LOW (reads only) | Light: 1–3s between actions |
| 2: Review | none — local file inspection by human | NONE | n/a |
| 3: Send | DMs / outbound writes | HIGH | Heavy: ≤5–10/day, randomized 30–90m delays |

**Critical insight: discovery (Phase 1) and sending (Phase 3) are completely
uncoupled.** Phase 1 can run at full Cartographer speed against 500
candidates in a single day. Phase 3 sends 10/day for weeks afterward. This
is the right pattern for outbound, lead enrichment, competitive intel,
recruiting — any site-based bulk task.

**Stagehand provides:** nothing specific. Sits on top of cartographer + emitters.

**You build:**
- CLI subcommands: `cartographer-campaign new/build/review/send/status`
- File schemas under `~/.cartographer/campaigns/<name>/`:
  - `config.yaml` — seed source, filters, qualify prompt, draft prompt,
    safety caps
  - `prospects.jsonl` — Phase 1 output, one Prospect per line
  - `approved.jsonl` — Phase 2 output, ApprovedProspect with optional edits
  - `rejected.jsonl` — explicit rejections, never re-shown
  - `sent.jsonl` — Phase 3 audit log, one SentRecord per line
  - `notes/` — per-prospect screenshots from cartographer evidence
- Resumable build loop with progressive jsonl writes (kill mid-run, restart picks up)
- Human-review interface (TUI v1, web UI v1.5) with approve/edit/reject
- Paced sender with daily caps, randomized jitter, account isolation, audit log
- Multi-account support (run different campaigns from different sessions)

**Doability: HIGH.** ~600–1000 LOC for the package. Build loop ~150 LOC,
review TUI ~200, sender ~150, schemas + glue ~300.

**Risk:** None within Cartographer code. Platform-risk lives in the
*deployment* of Phase 3 — daily caps and human review handle it. The tooling
itself is straightforward jsonl + scheduling.

**Why include in v1:** without campaigns, Cartographer is a navigation cache
with no user-facing payoff. With campaigns, Cartographer is a tool the user
can run an outbound campaign on tonight. The campaigns package is the
delta between "neat infrastructure" and "real product."

**Generalization beyond outbound:**
- Lead enrichment (visit company pages, extract employees, push to CRM)
- Competitive intel (weekly product page scrapes, change reports)
- Content research (hashtag walks, trending post lists)
- Recruiting outreach (candidate profile review, drafted messages)
- All share the build/review/send shape; campaigns serves them all.

## Canonical Use Case (anchors design conversations)

To anchor design discussions, the user's stated business workflow is:

> A marketing-agency outbound pipeline targeting fitness creators on Instagram
> (and eventually LinkedIn) who are below 50K followers and offering 1:1
> coaching services. The agent qualifies each prospect by reading pinned
> posts + 15 recent posts, drafts a personalized DM referencing specific
> content, queues to a list for human review, then sends approved DMs at
> 5–10/day with randomized delays.

Pipeline:
1. **Discover candidates** via hashtag/explore walks (Phase 1, full speed)
2. **Per candidate**: view profile, check_pinned_posts, list_recent_posts,
   LLM reasons "is this a fit?"
3. **For each fit**: LLM drafts personalized DM, append to `prospects.jsonl`
4. **Human reviews** the list, approves selections (Phase 2)
5. **Paced sender** emits ≤10 DMs/day with 30–90m randomized delays (Phase 3)

This generalizes beyond IG to LinkedIn, Twitter/X, Reddit, custom CRMs,
recruiting platforms, content research workflows — same shape, different
indexed graph.

**Optimization metric** (per-prospect cost):
- Without Cartographer + campaigns: ~5 LLM calls × $0.10 + ~3 min navigation
  = $0.50 / prospect
- With: ~2 LLM calls (analysis + DM gen) × $0.10 + ~45s cached navigation
  = $0.20 / prospect
- **4× faster, 2.5× cheaper** at 100/day. Bigger gains as N scales (cache
  amortizes; LLM cost stays per-prospect).

This is the workflow Cartographer is designed to optimize end-to-end. Every
architectural decision — structural cache key, named processes, hand-curated
process names, paced send caps — feeds back to making this workflow faster,
safer, and more leveraged.

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
- ❌ Add semantic process resolution to the cache. The cache stays structural;
  a Process Resolver above the cache is optional v2 work.
- ❌ Conflate Phase 1 (discovery, low risk) with Phase 3 (send, high risk).
  Tune them independently.
- ❌ Skip the human-review step (Phase 2). Even with great LLM drafts, the
  review queue is the line between "useful tool" and "spam cannon."

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
| 8 | F — MCP Emitter | 3–5 days | CLI works first; MCP is shape-variant. |
| **9** | **I — Campaigns Package** | **5–7 days** | **The user-facing payoff. Without this, Cartographer is plumbing. Validates the whole stack against the canonical use case.** |
| 10 | C Phase 2/3 — Prompt + LLM Policy | 2–3 weeks | Optional. |
| 11 | H 3D toggle | 3–5 days | Optional, after 2D is useful. |

**Total minimum-viable v1: ~7–9 weeks** to "indexed IG with working CLI +
2D viewer + drift detection + campaigns package running a real end-to-end
prospect pipeline."

A focused 12-hour MVP can deliver workstreams A, B, D narrow, E narrow with
a hand-authored 2-state graph as a tracer-bullet — proves the architecture.
Cartographer (C), Viewer (H), Drift (G), MCP (F), Campaigns (I) are
multi-day to multi-week each beyond that.

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

The campaigns package is named **stagehand-cartographer-campaigns** (or
`@cartographer/campaigns`). Platform-agnostic — works on top of any
indexed site.

Campaign artifacts live under `~/.cartographer/campaigns/<campaign-name>/`.

## What Was Built (so far in this fork)

- ✅ Fork created at `varadfromeast/stagehand`, default branch `main`
- ✅ `agent-handoff.md` v2 (this file) committed — adds Workstream I
  (campaigns), cache semantics clarification, canonical use case anchor
- ✅ `UBIQUITOUS_LANGUAGE.md` v2 committed — adds campaigns vocabulary,
  cache clarification
- ⏳ Spikes 1 + 2 not yet run
- ⏳ No `packages/cartographer/` skeleton yet
- ⏳ No code

## References

- Upstream: https://github.com/browserbase/stagehand
- Fork: https://github.com/varadfromeast/stagehand
- siteforge (abandoned): https://github.com/varadfromeast/siteforge
- Stagehand caching docs: https://docs.stagehand.dev/v3/best-practices/caching
- Stagehand cua-replay example: `packages/core/examples/cua-replay.ts`
- GitNexus (the inspiration for the graph + emitter pattern):
  https://github.com/abhigyanpatwari/GitNexus

## Caution

- Cartographer drives a real browser against real sites. **Do not run
  cartographer's exploration phase against accounts you can't afford to
  lose.** Use throwaway accounts for any aggressive exploration. The safety
  gate is the first line of defense, not the last.
- Anti-bot detection is real. Throttle (min 1s, jitter to 3s). Use existing
  user sessions instead of fresh logins where possible.
- **Phase 3 (sending) is the only high-risk phase** of the campaigns
  workflow. Phase 1 (discovery) and Phase 2 (review) carry minimal platform
  risk. Tune their pacing independently — full speed on Phase 1, hard caps
  on Phase 3.
- Bulk DM workflows on Instagram violate ToS in many cases. The tool is
  platform-neutral; use it where outbound is legitimate (LinkedIn Sales
  Navigator workflows, recruiting on opt-in platforms, your own CRM lists).
  We are not the layer that makes a non-compliant campaign compliant.
- We are using a fork. Upstream Stagehand changes fast. Pull weekly:
  `git fetch upstream && git rebase upstream/main` (or merge if rebase
  conflicts get hairy).

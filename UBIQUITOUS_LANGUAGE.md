# Ubiquitous Language — Cartographer

This document defines every domain term used across the Cartographer project.
The DDD principle: **one term, one meaning, used consistently in code, docs,
PR descriptions, and discussion.**

When you find ambiguity in a PR review, fix it here first.

This is the per-fork extension language. Stagehand's own vocabulary
(`Page`, `Action`, `agent`, `observe`, `act`, `extract`) is **borrowed
unchanged** from upstream. Cartographer-specific concepts are defined below.

---

## Substrate (borrowed from Stagehand)

Defined here only to clarify how Cartographer uses them, not to redefine.

### Stagehand
The upstream framework: `@browserbasehq/stagehand`. Provides browser
control, a11y snapshot, `act/observe/extract/agent`, instruction-keyed
caching, self-heal. We build on it.

### Action
Stagehand's interactable atom shape:
`{ selector: string, description: string, method?: string, arguments?: string[] }`.
Returned by `observe()` and used by `act()` / `takeDeterministicAction()`.
Carries a populated XPath. **Cartographer's `Atom` is derived from this.**

### Observe / Act / Agent
Stagehand's three primitives. We use them as our enumeration, validation,
and autonomous-loop substrate respectively. We do not reimplement them.

### takeDeterministicAction
Stagehand's `ActHandler.takeDeterministicAction(action, page, ...)` —
executes a cached `Action` without an LLM call. **Cartographer's runtime
hot-path replays `Operation`s by calling this.**

### CacheStorage
Stagehand's pluggable JSON-on-disk cache primitive. Cartographer's
`StateActionCache` extends this pattern with a different key shape.

### FlowLogger
Stagehand's event bus + EventStore. Cartographer subscribes for graph
recording, drift detection, and replay observability.

---

## Core Cartographer Domain

### Atom
Cartographer's narrowed view of a Stagehand `Action`: the smallest
interactable affordance on a page, identified by
`(role, accessible_name, xpath_shape)`. We always derive an Atom from a
Stagehand `Action` — never from raw DOM.

We deliberately do **not** call them "elements" — that conflates with DOM
nodes. Stagehand calls them `Action`. Cartographer keeps "Atom" because it's
graph-vocabulary aligned with State, Operation, etc.

> **Source vocabulary:** GitNexus calls its leaf "Symbol." We use a
> different term to keep the model decoupled.

### State
A logical screen of a site. Two visits to the same logical screen — even
with different content (5 vs 6 unread DMs) — produce the same `StateId`.

A State is **identified** by the hash of its canonicalized atom-set, not by
URL. Two URLs can be the same State; one URL can be multiple States (e.g.
`/` and `/` with the search modal open).

### StateId
SHA-256 of a canonicalized atom-set. Content-addressed identity of a State.
Stable across sessions for the same logical screen — this is the
load-bearing invariant; **always test before assuming.**

### StateKind
Coarse classification: `page | modal | panel | list | form | error`. Used
by the planner to decide which transitions are sensible (you don't "submit"
a list).

### Operation
A typed transition between two States. Executing an Operation moves the
browser from `from_state` to `to_state` deterministically (modulo drift).
Identified by synthetic `OpId`.

> **Distinction:** an Operation is **not** a verb on a single element — it's
> a typed edge with a known endpoint State, recorded only after validated
> execution. A click that doesn't change state isn't an Operation; it's a
> no-op transition we may discard.

> **Mapping:** `Operation` wraps Stagehand's `Action[]` (one or more) plus
> graph metadata. Replay = call `takeDeterministicAction` on each contained
> action.

### OpType
The verb of an Operation: `click | fill | submit | navigate | hover | scroll`.
Mirrors Stagehand's action methods.

### Process
A named, ordered list of `OpId`s forming a user journey from an entry State
to a target State. **Each Process becomes a CLI subcommand and an MCP tool.**

> **Source vocabulary:** GitNexus uses "Process" the same way (execution
> flow from entry point). Same term, same meaning, different substrate.

### ProcessName
The CLI-friendly name of a Process. v1: hand-authored
(`open_direct_inbox`, `send_dm`, `view_profile`, `list_recent_posts`).
v2: LLM-suggested with human approval.

### SiteGraph
The full model of a site. One per `Domain`. Persisted as a single
`graph.json` per indexed site under `~/.cartographer/sites/<domain>/`.

### Domain
The site identifier (`instagram.com`, `github.com`). Primary key for
SiteGraphs and Sessions.

### Cluster
A Leiden community of densely-connected States.

> **Deferred for v1.** With ≤50 nodes Leiden produces 1–2 trivial clusters.
> We track cluster membership in the schema but skip computation until
> graph is dense enough.

### Registry
The global index at `~/.cartographer/registry.json` listing every site
indexed on this machine. Maps `Domain → RegistryEntry`.

---

## Cartographer Pipeline (Active Exploration)

### Cartographer
The harness that drives Stagehand under a budget + safety contract,
records observed transitions into a SiteGraph, and respects user-supplied
cartography prompts.

**The Cartographer is not an agent.** It is a controlled runner. Reasoning
is a pluggable Policy; execution authority stays with the harness.

### Policy
The pluggable strategy that proposes candidate Atoms to validate next.
Implementations:
- `RulePolicy` — deterministic, pattern-matched defaults. v1.
- `PromptPolicy` — interprets the user's cartography prompt as priorities,
  taboos, dummy values. v1.5.
- `LlmPolicy` — calls an LLM to propose ranked candidates given an
  `ExplorerContext`. v2.
- `HybridPolicy` — rules first, LLM for ambiguity. v2.

The Policy proposes; the SafetyGate filters; the harness validates; the
MapRecorder writes.

### CandidateAction
A potential `Operation` proposed by a Policy but not yet executed:
`{ id, from_state, atom, op_type, instruction, args?, expected_result?,
risk, source, priority }`.

Becomes a real `Operation` only after VALIDATE successfully executes it
and observes a state transition.

### SafetyGate
Validates every CandidateAction before Stagehand touches the browser.
Default-deny verb list: `delete remove unfollow block report buy checkout
"place order" publish post send "submit with non-empty content" upload
payment "account/security changes"`. Site-specific extensions come from the
cartography prompt.

Skipped CandidateActions are **recorded** with `status: "skipped",
reason: "dangerous_action"` so the emitter knows not to expose them as
tools without explicit user opt-in.

### MapRecorder
Writes State nodes and Operation edges into the SiteGraph as the
Cartographer observes them. Refuses to record 0-atom loading shells —
retries the snapshot until canonical/surface atoms are non-empty.

### Frontier
Set of States discovered but not yet fully explored. Bounded by
`max_depth`. Drained during VALIDATE.

### AnchorState
A "safe" State the Cartographer can navigate back to (typically the home
page). Used when `page.goBack()` won't work. Configured manually in v1.

### Backtrack
Returning the browser to a target State after validating one CandidateAction.
v1 strategy: `page.goBack()`, then `page.goto(anchor.url)` as fallback.

### Throttle
Randomized delay between operations during VALIDATE (default 1–3s,
jittered). **Anti-detection. Enforced even on fast hardware. Min 1s.**

### CartographyPrompt
The user's structured exploration contract:
```
{
  priorities: string[],
  stop_before: string[],
  safe_inputs: Record<string,string>,
  dangerous_actions: string[],
  success: string
}
```
Becomes inputs to `PromptPolicy` (priorities, dummy values) and the
SafetyGate (stop_before, dangerous_actions).

### TeachLoop
The full proactive-exploration pipeline run from
`cartographer teach <url>`: SETUP → SNAPSHOT → CLASSIFY → ENUMERATE →
VALIDATE → CLUSTER → TRACE → SAVE.

---

## Runtime (Replay Path)

### RunLoop
The execution pipeline invoked when an agent calls a CLI subcommand or MCP
tool: RESOLVE → CURRENT-STATE → PLAN → EXECUTE → SELF-HEAL → RETURN.

### PlanPath
BFS over the SiteGraph's edges to find a shortest path between two States.
Filters by `min_confidence`. Returns `PlanResult | NoPathResult` — never
throws.

### Replayer
The component that executes a single Operation by calling Stagehand's
`takeDeterministicAction` with the Operation's cached `Action[]`. No LLM
call on the hot path.

### SelfHealer
Cartographer's wrapper around Stagehand's `act()`. Triggered when the
Replayer fails (Playwright exception or atom-set drift). Calls
`Stagehand.act(operation.instruction)` → re-resolves selector → retries →
on success **writes back** the updated `Action[]` into the StateActionCache.

### StateActionCache
The novel cache. Keyed by `(state_id, atom_id)` instead of Stagehand's
`(instruction, url)`. Two different Processes whose paths share the same
`(from_state → atom → to_state)` triple share one cache entry — this is
**the central composability win** vs Stagehand's per-task ActCache.

**Important: the key is structural, not semantic.** No embedding, no LLM
similarity, no synonym detection. Different Processes hit the same cache
entry because their *graph paths overlap*, not because their *names mean
similar things*. See "CrossProcessEdgeReuse" below.

### AtomId
SHA-256 of `(role, accessible_name, xpath_shape)` where `xpath_shape` is
the XPath template (drop indices, keep tags). Disambiguates "like button on
home" from "like button in reels modal."

### CrossProcessEdgeReuse
The phenomenon that makes `StateActionCache` valuable: when two named
Processes traverse the same graph edge (same `from_state` and same
`atom_id`), they share one cache entry.

**Worked example.** Process `open_inbox` has 1 edge:
`home → inbox_btn → inbox_state`. Process `send_dm_to_alice` has 4 edges,
the first of which is also `home → inbox_btn → inbox_state`. The first
time either Process runs, the LLM resolves the edge once. Every subsequent
run of *either* Process — regardless of name, args, or surrounding context
— hits the cache for that edge.

This is the architectural delta vs Stagehand. Stagehand's `ActCache` keys
by `(instruction, url)` — the literal phrasing. Two different Processes
that happen to traverse the same edge can never share a cache entry there.
We can.

> **Out of scope:** "user types `go to my dms` and the system figures out
> they meant `open_inbox`" is *not* what CrossProcessEdgeReuse means. That's
> ProcessResolver — a separate, optional v2 concept.

### ProcessResolver (v2 only)
A *future* layer above the cache that maps free-form natural-language user
requests onto known `ProcessName`s using embeddings or LLM matching.
**Not v1.** Process selection in v1 is by exact name. ProcessResolver is
optional sugar that would re-introduce per-instruction LLM cost; only build
it if there's a concrete reason callers can't pass process names directly.

### ValidationHash
Hash of the expected `to_state.atoms` for an Operation. After replay we
hash the observed page and compare. Mismatch = drift; triggers SelfHealer.

> **First-principles parallel:** DOM-as-body, atom-set-as-ETag analog of
> HTTP's conditional GET / Last-Modified validation.

### Drift
The condition where a cached Operation's `validation_hash` no longer
matches the observed `to_state.atoms` after replay. Caused by site changes.

### DriftScore
Per-SiteGraph metric: fraction of recent replays that hit drift. Surfaced
in `SiteGraphMeta`. High drift → user prompted to re-explore.

### Confidence
Per-Operation reliability score, 0..1:
- `dom-direct` 0.95 — observed by Cartographer, executed successfully.
- `llm-inferred-validated` 0.85 — Stagehand `act()` resolved it, executed OK.
- `llm-inferred-untested` 0.7 — proposed but not yet validated.
- `self-healed` 0.8 — updated after a drift event; provisional until next
  successful replay.

> **Source vocabulary:** mirrors GitNexus's tier confidence
> (same-file 0.95 → import-scoped 0.9 → global 0.5).

---

## Emission

### Emitter
A read-only compiler from a SiteGraph to an agent-facing artifact. Three
shapes share one input:

### CliEmitter
Generates `~/.cartographer/bin/<domain>-cli` — a Node script with one
Commander subcommand per Process. Each subcommand calls the Runtime's
`runProcess(name, args)`.

### McpEmitter
Generates an MCP server exposing the SiteGraph as **resources** (cheap
reads, ≤500 tokens each: `site://<domain>/{context, states, state/<id>,
process/<name>, clusters}`) and **tools** (expensive: `find_path`,
`run_action`, `explore`, `validate`).

### SkillMdEmitter
Renders a markdown skill document. v1: flat list of Processes per site.
v2 (when graphs are dense): one section per Cluster.

> **Source vocabulary:** GitNexus emits per-cluster `SKILL.md`. Same shape,
> deferred until cluster computation is meaningful.

---

## Viewer

### Viewer
The web app under `packages/viewer/` that renders a SiteGraph as a
force-directed graph. v1: 2D via `react-force-graph-2d`. v1.5: 3D toggle
via `react-force-graph-3d` (drop-in swap, same data shape).

### GraphView
The data shape the Viewer consumes: `{ nodes, links }` where each node is
`{ id, label, kind, color, size }` and each link is
`{ source, target, op_type, confidence, drift_score }`.

### ReplayMode
Viewer feature: click a Process, watch the Viewer animate the path through
the graph (highlight active edge per step).

---

## Campaigns (the workflow layer)

The campaigns package is platform-agnostic — it works on top of any per-site
CLI/MCP that emitters produce. Vocabulary scoped to bulk-workflow operations
(outbound, lead enrichment, recruiting, content research, competitive
intel).

### Campaign
A named bulk workflow with a `CampaignConfig`, output artifacts under
`~/.cartographer/campaigns/<name>/`, and a three-phase lifecycle
(Build → Review → Send). Each Campaign targets exactly one indexed site
(or one logical surface — e.g. "instagram-coaches", "linkedin-fitness").

### CampaignConfig
The user-authored YAML / JSON describing the Campaign:
- `seed` — where prospects come from (hashtag, search query, manual list,
  CSV import, audience-overlap export)
- `filter` — qualification thresholds (`max_followers`, `bio_keywords`,
  `must_have_pinned`, etc.)
- `qualify_prompt` — LLM prompt that produces the `Qualification` per
  prospect
- `draft_prompt` — LLM prompt that produces the `DraftDm` per qualified
  prospect
- `send_caps` — `{ max_per_day, jitter_minutes, account_id }`
- `evidence_capture` — whether to save screenshots per prospect

### CampaignDir
The on-disk artifact directory: `~/.cartographer/campaigns/<name>/` with
`config.yaml`, `prospects.jsonl`, `approved.jsonl`, `rejected.jsonl`,
`sent.jsonl`, `notes/`. Treated as the canonical source of truth for the
campaign's state — resumable, auditable, version-controllable.

### Phase 1 / Build
The proactive discovery + qualification + drafting phase. Drives the
emitted per-site MCP tools to navigate, extract structured data, qualify
prospects against the `CampaignConfig.filter`, and draft DMs.
**Risk: LOW** — reads only, no writes to the platform. Throttle is light
(Cartographer's standard 1–3s).

### Phase 2 / Review
The human-in-the-loop approval phase. No platform interaction — purely
local. The reviewer goes through `prospects.jsonl` entries in a TUI/web UI
and emits `approved.jsonl` (with optional edits) or `rejected.jsonl`.
**Risk: NONE.**

### Phase 3 / Send
The paced sending phase. Loads `approved.jsonl`, sends one DM at a time
using the per-site MCP `send_dm` tool, with randomized inter-send delay
(see `Jitter`) and a hard daily cap (see `SendCap`).
**Risk: HIGH** — write activity, bot-detection-flagged. Caps and jitter
are the defense.

### Prospect
A candidate identified during Phase 1:
```
{
  handle, qualified_at,
  profile: ProfileSummary,
  qualification: { is_fit, creator_type, services_offered,
                   strongest_signal, personalization_hooks },
  draft_dm: string
}
```
Lives one-per-line in `prospects.jsonl`. Append-only during Phase 1.

### ApprovedProspect
A `Prospect` that passed human review, with optional edits to `draft_dm`:
```
{
  handle, approved_at, approved_by,
  prospect: Prospect,
  edits: { draft_dm?: string },           // null if no edits
  scheduled_for?: ISO8601                  // optional manual scheduling
}
```
Lives one-per-line in `approved.jsonl`.

### RejectedProspect
A `Prospect` explicitly rejected during review:
```
{ handle, rejected_at, rejected_by, reason: string }
```
Lives one-per-line in `rejected.jsonl`. **Never re-shown** in subsequent
reviews of the same campaign.

### SentRecord
The audit log entry for one DM dispatch:
```
{
  handle, sent_at, account_id,
  message_actually_sent: string,
  send_result: { success, platform_response?, error? },
  duration_ms
}
```
Lives one-per-line in `sent.jsonl`. Source of truth for "was it sent?"
when resuming a paused campaign.

### SendCap
The hard daily limit on Phase 3 sends, per `(campaign, account_id)`. Default
≤10/day for outbound. Configurable per `CampaignConfig.send_caps.max_per_day`.
Cap is enforced at the campaign level — even if you ran `send` twice in a
day, you don't exceed it.

### Jitter
Randomized inter-send delay drawn from a configured range. Default 30–90
minutes for outbound DMs. Configurable per `CampaignConfig.send_caps.jitter_minutes`.
Anti-detection: regular intervals are easier to flag than randomized ones.

### Qualification
The LLM-produced structured judgment of a prospect:
```
{
  is_fit: boolean,
  creator_type: string,
  services_offered: string[],
  strongest_signal: string,
  personalization_hooks: string[]
}
```
Output of `CampaignConfig.qualify_prompt` evaluated against the prospect's
`profile + pinned posts + recent posts`.

### DraftDm
The LLM-produced personalized message for a qualified prospect.
String, conversational, ≤280 chars in the default config, references at
least one of `Qualification.personalization_hooks`.

### EvidenceCapture
Per-prospect screenshots + atom snapshots saved to
`<campaign-dir>/notes/<handle>/` during Phase 1. Useful for review and
audit. Optional via `CampaignConfig.evidence_capture`.

### CampaignStatus
A computed view: `{ phase: 'building'|'review'|'sending'|'paused'|'done',
counts: {...}, last_action_at, sends_today, sends_this_run }`.
Surfaced via `cartographer-campaign status <name>`.

---

## Algorithms

### Frontier (BFS)
Search frontier during VALIDATE. Pulls from set, expands one State, pushes
neighbors. Bounded by `max_depth`.

### EntryPoint
A State scored as a likely starting point. Heuristics: URL `/`, `main` role
with brand-name accessible-name, high out-degree, low in-degree. Top-N
become Process trace starts.

### Leiden (deferred)
Community detection over the edge graph for clustering. Skipped until
graph density supports meaningful clusters (≥50 states).

### EntryPointScore
Heuristic 0..100 score on each State during TRACE. Inputs: URL pattern,
`main` role + brand match, out-degree, in-degree.

---

## Cache Strategy (mapped to first principles)

### L1 (hot, in-memory)
`Map<Domain, SiteGraph>` cache in the Runtime. LRU evict after 5 min idle.

### L2 (cold, on disk)
JSON files at `~/.cartographer/sites/<domain>/graph.json`. Source of truth
between sessions.

### L3 (origin)
Live LLM call via Stagehand `act()`. Slow path; only on miss or drift.

### Write-back
Self-heal updates accumulate in L1 and flush to L2 on session end or every
N changes. Contrasts with write-through (per-change disk write).

### Single-flight
A lock on `(domain, op_id)` ensuring concurrent agent calls for the same
operation queue rather than double-execute. Critical because executing
"send DM" twice could send two messages.

### Stale-while-revalidate
Serve cached path immediately, validate observed state in the background;
mark edges drifted on mismatch but the user already got their answer.

### NegativeCache
Short-TTL record (5 min) asserting "no path from State S to Intent I."
Prevents the planner from re-trying paths it just learned don't work.

---

## Out-of-scope terms (deliberately not used)

| We don't say | Why |
|---|---|
| "Element" | Conflates with DOM. Use `Atom`. |
| "Page" alone | Ambiguous (URL? logical screen?). Use `State` + `kind`. |
| "Action" alone (in Cartographer-only docs) | Stagehand's substrate term; in graph context use `Operation`. In Stagehand-bridge code, `Action` is fine. |
| "Workflow" | Skyvern's term. Use `Process` for graph-level journey, `Campaign` for cross-site bulk operations. |
| "Skill" alone | Anthropic-overloaded. Use `Process` for executable, `skill.md` for the doc. |
| "Crawl" | Implies SEO-style URL discovery. Use `explore` because we discover atoms and transitions, not URLs. |
| "Map" alone | Ambiguous. Be specific: `SiteGraph`, `MapRecorder`, `cartography prompt`. |
| "Site" alone | Use `Domain` for the identifier, `SiteGraph` for the model. |
| "Robot" / "bot" | Carries automation-evasion connotations we don't want. We're a cartographer. |
| "Cross-instruction cache reuse" | Misleading — implies cache hits depend on phrasing similarity. Use `CrossProcessEdgeReuse`. |
| "Semantic cache" | Our cache is structural, not semantic. Don't suggest otherwise. |
| "Cold contact" / "spam" | Use `Prospect` and `Campaign`. We're describing platform-neutral bulk workflows. |
| "Drip" | Overloaded marketing term. Use `Phase 3` or `paced send`. |
| "Funnel" | Overloaded. Be specific about which phase. |

---

## Naming conventions

- Types are `PascalCase`: `State`, `Operation`, `SiteGraph`, `Campaign`,
  `Prospect`, `ApprovedProspect`.
- IDs are `<Type>Id`: `StateId`, `OpId`, `AtomId`, `CampaignId`.
- Function names are `camelCase` and verb-led: `canonicalizeAtoms`, `planPath`,
  `runCampaign`, `pacedSend`.
- File names are `kebab-case`: `canonicalize.ts`, `plan-path.ts`,
  `state-action-cache.ts`, `campaign-config.ts`.
- Module folders are nouns: `cartographer/`, `runtime-graph/`, `emitters/`,
  `viewer/`, `campaigns/`.
- Cartographer CLI subcommands are `kebab-case`: `cartographer teach`,
  `cartographer name-process`, `cartographer status`, `cartographer emit-cli`.
- Campaign CLI subcommands are `kebab-case`: `cartographer-campaign new`,
  `cartographer-campaign build`, `cartographer-campaign review`,
  `cartographer-campaign send`, `cartographer-campaign status`.
- Emitted per-site CLIs are named `<domain>-cli`:
  `instagram-com-cli`, `github-cli`. Domain dots become hyphens.

---

## Decision Records

When language changes, record the rationale here.

### 2026-05-01 — Initial vocabulary

- Borrowed `Action`, `Page`, `observe`, `act`, `agent` from Stagehand;
  introduced `Atom`, `State`, `Operation`, `Process`, `Cluster`, `SiteGraph`
  for graph-vocabulary.
- Renamed prior project's `surface_atoms` to "canonicalized atoms" — same
  concept, less site-specific connotation.
- Adopted `StateActionCache` (vs Stagehand's `ActCache`) to make the
  contrast explicit: ours is keyed by graph position, theirs by instruction
  string.
- Decided "Process" for executable user journey, "skill.md" for the doc
  (matches GitNexus naming, avoids Anthropic skill-as-thread overload).
- Cartographer is a *cartographer*, not an *agent*. Reasoning is pluggable
  via `Policy`; the cartographer keeps execution authority.

### 2026-05-01 (later) — Cache clarification + Campaigns vocabulary

- **Renamed "cross-instruction cache reuse" → `CrossProcessEdgeReuse`.**
  The original phrasing was misleading: it suggested two different user
  *phrasings* could hit the same cache entry (semantic matching), which is
  not what the cache does. The cache is structural — keyed by `(state_id,
  atom_id)`. Two *Processes* (graph paths) sharing an edge benefit; two
  free-form phrasings of the same intent do not, unless explicitly mapped
  to the same `ProcessName`.
- Added explicit `ProcessResolver` term as v2-only future work, separated
  from the cache layer to keep the architecture clean.
- Added "Campaigns" section as the workflow layer above per-site emitters.
  The campaigns package is platform-agnostic and turns "indexed graph"
  into "actionable bulk workflow." Vocabulary added: `Campaign`,
  `CampaignConfig`, `CampaignDir`, `Phase 1/2/3`, `Prospect`,
  `ApprovedProspect`, `RejectedProspect`, `SentRecord`, `SendCap`, `Jitter`,
  `Qualification`, `DraftDm`, `EvidenceCapture`, `CampaignStatus`.
- Added "Build / Review / Send" three-phase pipeline as the canonical
  shape for any bulk-workflow campaign. Each phase has its own risk
  profile; **discovery (Phase 1) and sending (Phase 3) are explicitly
  decoupled** so they can be tuned independently.
- Out-of-scope additions: "Cross-instruction cache reuse", "Semantic
  cache", "Cold contact", "spam", "Drip", "Funnel" — clarifying
  vocabulary boundaries.

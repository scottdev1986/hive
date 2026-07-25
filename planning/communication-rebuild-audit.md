# Communication rebuild audit — de-Hiving and C6 cleanup

Audit date: **2026-07-24**. Read-only: no code was modified.
Spec: `docs/design/hive-communication.html` §7 Process control, §10 Provider capability contract
(closing paragraph), §11 Context economy (Bootstrap diet, Communication diet), §13 C6 · Cleanup.

**The one test applied to every item below:** *would this still be correct if Hive were installed on an
unrelated project owned by a different user?* An item fails the test when its behavior depends on the
repository happening to be Hive's own source, on this machine, or on this user.

## Ranking — act on any single row without reading the rest

| # | Item | file:line | Removal |
|---|---|---|---|
| 1.1 | Build-freshness module (producer) | `src/daemon/build-freshness.ts:1-152` | **mechanical** |
| 1.2 | `hive_status` freshness note | `src/daemon/server.ts:5500`, `:5509`, `:5525` | **mechanical** |
| 1.3 | `hive_spawn` freshness note | `src/daemon/server.ts:6139-6144` | **mechanical** |
| 1.4 | Daemon wiring + test seam | `src/daemon/server.ts:68,603-604,781,1178-1179` | **mechanical** |
| 1.5 | Freshness tests | `test/daemon/build-freshness.test.ts:1-111` | **mechanical** |
| 2.1 | `CODE_REVIEW_RULES` hardcodes `main` | `src/daemon/spawner-impl.ts:1174` | **mechanical** |
| 2.2 | `SEARCH_HYGIENE` names `src/` | `src/daemon/spawner-impl.ts:1161` | **mechanical** |
| 2.3 | Hardcoded model id in prose | `src/cli/orchestrator-brief.ts:7` | **mechanical** |
| 3.3b | Duplicate memory-delta lines | `src/daemon/memory-delta.ts:184-193` | **mechanical** |
| 3.2 | Hand-written provider lists | `orchestrator-turn-monitor.ts:156`, `recovery.ts:695-812`, `spawner-impl.ts:1603-2756` | **needs decision** |
| 3.3a | Pitfalls re-injected every wake | `src/daemon/memory-delta.ts:161-181` | **needs decision** |
| 3.3c | Spawn-prompt prose volume | `src/daemon/spawner-impl.ts:1012-1179` | **needs decision** |
| 3.1 | Kill breadth vs §7 targets | `hive-terminal-host.ts:321`, `teardown.ts:1-15` | **needs decision** |

Findings 1 and 2 are mechanical deletions or one-word edits. Finding 3 is where the judgment sits.

---

# Finding 1 — "is the running build up to date with its git branch"

**Verdict: delete the whole mechanism. It is the clearest de-Hive item in the codebase, and its blast
radius is small and fully enumerated below.**

## 1.1 The producer

`src/daemon/build-freshness.ts` — the entire 152-line file, one exported pair
(`checkBuildFreshness`, `runningBuildProvenance`) plus `BuildFreshness` / `BuildProvenance` / `GitRunner`.

What it does today: takes `HIVE_COMMIT` (inlined at release-build time) and asks git three questions
against the repo Hive is *running in*:

- `:97` — `git rev-parse main`
- `:106` — `git cat-file -e <buildCommit>^{commit}` — "is the commit I was built from in this repository?"
- `:114` — `git rev-list --count <buildCommit>..main` — the commit count the running code lacks

Then reports `state: "current" | "stale" | "unknown"` with a prose `message`.

**Why it must go.** Every one of those three git calls presumes the working repository is the repository
Hive was *built from*. On an unrelated project:

- `main` may not exist (`:98-104` → `unknown`), or may exist and be **someone else's** `main`, unrelated
  to Hive's history.
- `cat-file -e <buildCommit>` **cannot** succeed — Hive's build commit is not an object in a stranger's
  repo (`:107-113` → `unknown`).

So for every user who is not developing Hive itself, this module has exactly one reachable answer:
`unknown`. It is not merely useless off Hive's source tree — per its own design (`:22-25`, "Never
'fresh'") it is *load-bearingly* useless, because it deliberately refuses to say "fine" when it cannot
tell. The module is honest; the concept is repo-bound.

The module's own docstring (`:2`, "Is the running binary older than main?") states the coupling outright.
Its stated motivating bug (`:4-7`) — "a feature landed green and `hive_spawn --tool grok` still failed,
because the daemon was executing yesterday's code" — is a **Hive-developer** workflow problem, not a
product concern. It belongs to `bun run build:release`, not to the daemon's runtime surface.

**Minimal change:** delete the file.

## 1.2 Consumer — `hive_status`

`src/daemon/server.ts:5500` computes `const build = await this.buildFreshness();` and both return paths,
`:5509` and `:5525`, pass `build.message` as `toolResult`'s third argument.

`toolResult` (`src/daemon/server.ts:727-736`) appends a `note` as a **second text content block**. So the
freshness paragraph rides **every `hive_status` response**.

**This is the sharpest instance of the problem, and it is also a §11 Context-economy violation.** The call
is **unconditional** — unlike `hive_spawn` (1.3), there is no `build.state` check. On any repo that is not
Hive's source, every single `hive_status` reply therefore carries this permanent, unchanging paragraph:

> "Hive cannot tell whether the running binary is up to date with main: the commit it was built from (…)
> is not in this repository. Code landed on main may or may not be live in this daemon."

§11's Bootstrap diet says *"Remove repeated prose when the rule is already daemon-enforced"* and its
success condition requires *"routine observation consumes zero provider tokens."* A fixed paragraph
appended to the fleet's most-called observation tool is the opposite: pure repeated prose, billed to the
orchestrator's context on every poll, conveying nothing that changes.

The comment at `:5497-5499` ("Status says so unasked — the failure mode is precisely that nobody thinks to
ask") is a fair argument *inside Hive's own repo*. Outside it, the tool is unasked *and* unable to answer.

**Minimal change:** drop the third argument at `:5509` and `:5525`; delete the `build` computation at
`:5500`.

## 1.3 Consumer — `hive_spawn`

`src/daemon/server.ts:6139` computes freshness; `:6142-6144` passes
`build.state === "current" ? null : build.message`.

Better behaved than 1.2 — it is conditional. But the condition is `!== "current"`, and off Hive's source
tree the state is *always* `unknown`, so the warning fires on **every spawn, forever**, telling a user who
has never built Hive from source that their daemon might be stale. The comment at `:6136-6138` ("An agent
spawned to test a fix that is not in the running binary is wasted money") is again a Hive-developer
concern.

**Minimal change:** pass `null`; delete the `build` computation at `:6139`.

## 1.4 Wiring and test seam

- `src/daemon/server.ts:68` — `import { type BuildFreshness, checkBuildFreshness }`
- `:603-604` — the `buildFreshness?: () => Promise<BuildFreshness>` constructor option (a test seam,
  per the comment at `:603`: "exercise a stale release without building one")
- `:781` — the private field
- `:1178-1179` — the default `() => checkBuildFreshness(this.repoRoot)`

**Minimal change:** delete all four. Removing the option is a **public-shape change to
`HiveDaemon`'s options**; anything constructing a daemon with `buildFreshness` must drop it. Only tests do
(1.5), so it is contained.

## 1.5 Tests

`test/daemon/build-freshness.test.ts:1-111` — tests only this module (`:38` `commitsBehind`, `:39`
`buildCommit`, `:110-111` `runningBuildProvenance`). Delete the file with the module.

## What breaks if it is deleted

Nothing functional. Precisely:

1. `hive_status` and `hive_spawn` stop emitting a build-staleness note. No caller *parses* it — it rides
   the human-readable `note` block, never `structuredContent` (`toolResult:734` puts only `value` under
   the key). Machine consumers of `hive_status` read `structuredContent.agents`, which is untouched.
2. A Hive developer loses the automatic "your daemon predates main" nudge. **This is the only real loss.**
   It is a development-workflow signal and belongs in the release/build tooling. Note it is already
   partially available: `hive update` prints `commit:` and `release build:` (`src/cli/update.ts:157-159`),
   which stays.
3. The `HiveDaemon` `buildFreshness` option disappears (1.4).

## Explicitly NOT part of this deletion

`IS_RELEASE_BUILD` / `HIVE_COMMIT` / `HIVE_VERSION` (`src/version.ts:28,66,75`) have **many legitimate,
repo-neutral consumers** and must stay:

- `src/update/paths.ts:21,72` and `src/update/check.ts:20,163` — install-ownership and update checks.
  `docs/release/versioning-and-release.md:96` records the rule deliberately: a source checkout is
  identified *by what it is* (`IS_RELEASE_BUILD`), not by where it sits.
- `src/cli/orchestrator.ts:127`, `src/daemon/spawner-impl.ts:1726,2781`, `src/daemon/recovery.ts:716` —
  `hiveCliSpawnArgv(IS_RELEASE_BUILD, process.execPath)`, so installed lifecycle hooks invoke the exact
  running binary. `docs/providers/launch-mechanics.md:204` records the 127-exit defect this fixed.
- `src/daemon/lifecycle.ts:483`, `src/daemon/sessiond-broker.ts:83`, `src/cli/workspace.ts:145`.

Only the **comparison against a git branch** is repo-bound. Conflating the two would break spawning.
`src/version.ts:11` carries a comment referring to "the stale-daemon check"; update the wording when the
module goes (comment only, no behavior).

---

# Finding 2 — other repo-, user-, or Hive-source-specific assumptions

Scope audited: communication, spawn-prompt, status, observation, and launch paths.

## Clean — verified negatives (with positive controls)

Per protocol rule 3, a negative is only worth reporting if the reader can see a positive:

- **No hardcoded absolute user paths.** `grep -rn '/Users/scottkellar\|/Users/[a-z]*/Projects\|kellar'`
  over `src/` and `native/` (tests excluded): **zero** hits.
- **No "am I working on Hive" branching.** No `isHiveRepo`, no repo-name equality test. The one hit for
  `=== "hive"` is `src/daemon/tool-telemetry.ts:419`, testing an **MCP server name** (`invocation.server`),
  not a repository. *Positive control:* the pattern did match that line, so the search works.
- **Doc discovery is genuinely repo-neutral.** `buildOrchestratorDocGuidance`
  (`src/cli/orchestrator.ts:176-185`) calls `discoverBriefableDocs`, which collects **every** root `.md`
  via `git ls-files "*.md"` and ranks by inbound links (`src/adapters/briefing-docs.ts:42-45,104`).
  The comment at `:42-43` is explicit — "A design doc can be named anything (DESIGN.md, ARCHITECTURE.md,
  SPEC.md)" — and `orchestrator.ts:174-175` says it avoids "teaching hive's own doc names". **No
  hardcoded document list exists.** The brief's concern here is already solved; do not spend effort on it.
- **The landing protocol is already repo-neutral.** `buildLandingProtocol`
  (`src/daemon/spawner-impl.ts:1058-1093`) parameterizes `mainBranch` and, per `:1066-1067`, deliberately
  stopped detecting this repo's concrete test/typecheck command, naming the rule instead
  (`:1068-1072`). Correct as-is.

*Positive control for the model-id sweep:* my first regex (opus-5/sonnet-5/gpt-5) returned zero, which
would have been a false all-clear. A broadened pattern found a real hit (2.3). Recorded because the
narrow version read as proof of absence and was not.

## 2.1 `CODE_REVIEW_RULES` hardcodes the branch name `main`

`src/daemon/spawner-impl.ts:1174` (rule 1) instructs every reviewer to resolve
"its merge-base with main", and rule 2 (`:1175`) likewise.

**Why it must go:** the literal `main` is baked into prompt prose, while the sibling
`buildLandingProtocol` (`:1061`) correctly takes `mainBranch = "main"` as a **parameter**. A project on
`master`, `trunk`, or `develop` gets reviewers told to diff against a branch that does not exist — and
because it is prose, nothing fails loudly; the reviewer improvises.

**Minimal change:** thread the same `mainBranch` value already available to `buildLandingProtocol` into
`CODE_REVIEW_RULES`, making it a function of the branch name rather than a `const`.

## 2.2 `SEARCH_HYGIENE` names `src/` as the place answers live

`src/daemon/spawner-impl.ts:1161` — "scope the search to the directory that can hold the answer (src/,
not the repo root)".

**Why it must go:** `src/` is Hive's own layout. On a project using `lib/`, `app/`, `pkg/`, or a
monorepo's `packages/*`, the parenthetical names a directory that may not exist. The *rule* (anchor the
pattern, scope the search) is sound and repo-neutral; only the example is Hive-shaped.

**Minimal change:** drop the parenthetical, or reword to "the subdirectory that can hold the answer,
not the repo root". One-line prose edit.

## 2.3 Hardcoded model id in orchestrator prose

`src/cli/orchestrator-brief.ts:7` — `(for example "open an Opus 4.8 terminal" means model
"claude-opus-4-8")`.

**Why it is worth flagging (low severity):** it names a concrete model that may not be in this user's
routing policy or account at all. The surrounding sentence is otherwise careful and correct — "Never pick
models from your own knowledge — the user's policy decides" — so a hardcoded example sits awkwardly
against its own rule, and it ages with every model release.

Every other `claude-opus-4-8` occurrence found (`src/schemas/capability.ts:61,316,405`,
`src/schemas/quota.ts:203`, `src/daemon/live-model.ts:9`, `src/daemon/quota-sources.ts:767-768`,
`src/daemon/quota-ledger.ts:1119`, `src/daemon/capability-discovery.ts:101`) is **inside a comment**,
illustrating alias normalization. Those are documentation, not behavior — **leave them**.

**Minimal change:** make the example generic ("naming a model explicitly launches that model verbatim")
or draw the illustration from the user's configured policy. Prose-only.

---

# Finding 3 — over-engineering on the C0–C6 path

C6 calls for removing "old process-equals-terminal assumptions, duplicated provider branches, repeated
prompt prose, repeated wake memory, and optimistic injection wording."

## 3.1 Control operations and the `process-tree` target — **needs decision**

**What exists today.** The native layer **already** supports all three §7 targets:

- `native/sessiond/src/neutral_evidence.zig:214` — `enum { foreground-group, session-members, process-tree }`
- `native/sessiond/src/neutral_operations.zig:315-329` — resolves each to a concrete pid/group
- `native/sessiond/src/host_core.zig:1643-1645` — validates all three
- `src/schemas/session-protocol.ts:1025` and
  `src/daemon/session-host/terminal-host-contract.ts:420` — the TS contract carries all three

**But the TS host requests exactly one.** `src/daemon/session-host/hive-terminal-host.ts:321` hardcodes
`target: "process-tree"`, and `terminate()` (`:307-328`) is the **only** operation that reaches the host.

Two distinct problems, and it matters not to conflate them:

**(a) The hardcoded literal at `:321` is, on its own, correct.** §7's table assigns
`terminate-terminal` the target "Whole session process tree". A method named `terminate` asking for
`process-tree` matches the spec. **Do not "fix" this line in isolation** — it would break the one
operation that is right.

**(b) The real gap is that the four narrower operations do not exist as process control at all.**
§7 specifies `pause`, `resume`, `cancel-turn`, and `stop-provider` with distinct targets and distinct
required proofs, three of which must leave zsh present. Searching for them finds only **message
intents** — prose delivered to the agent, not signals to a process group:

- `src/schemas/message.ts:13` — `"pause"` as a message intent
- `src/daemon/server.ts:357` — `intent: "pause" | "stop" | "cancel" | "restrict-writes"`
- `src/daemon/delivery.ts:349` — those intents gate delivery treatment

So the §7 control table is **largely unimplemented**, and the one place that does stop a provider goes
maximally wide: `src/daemon/teardown.ts:1-15` — "Killing an agent means positively terminating its
**entire process tree**" — which `hive_kill` uses (`src/daemon/server.ts:2621`, `:3256`).

**Why this is the process-equals-terminal assumption C6 names:** stopping a *provider* currently takes
down the *whole tree*, whereas §7 requires `stop-provider` to target the "Exact provider foreground
process group" with "zsh remains present" as its terminal result.

**Do not read this as gratuitous over-engineering — teardown's breadth is earned.** `teardown.ts:2-9`
documents exactly why: the Codex app-server host is a child of the **daemon**, never of the pane, "so no
pane signal can ever reach it"; MCP stdio children and anything `nohup`ed survive a shell stop; those
hold paid model sessions open. And `:10-15` encodes the right epistemics (signal delivered ≠ process
gone; look again; report survivors). That machinery is correct and should be preserved.

**Smallest change:** keep the tree walk and the survivor sweep as the *verification* pass, but let the
*signal* target the foreground group for `stop-provider`, so zsh survives — then reap survivors as it
does now. **This is a decision, not a mechanical edit**, because it changes what `hive_kill` leaves
running, and because the four missing operations are new surface rather than deletions. I am not
designing that surface here.

## 3.2 Hand-written provider lists where a descriptor belongs — **needs decision**

§10's closing paragraph: *"Delivery and recovery branch on the descriptor, not on hand-written provider
lists scattered through the daemon."*

**The clearest violation — `src/cli/orchestrator-turn-monitor.ts:156`:**

```ts
if (tool === "claude" || tool === "kimi" || tool === "opencode") {
  return run();          // run unmonitored
}
```

A literal hand-written provider list deciding **turn-boundary observation** — exactly what §10's
`turnBoundaryEvents` / `eventSource` / `transcriptReader` fields exist to answer. The comment at
`:144-149` states the real predicate: Claude has hooks; Kimi and opencode have neither usable hooks nor a
session-artifact turn reader. Those are **descriptor facts**, spelled as vendor names.

Supporting per-provider dispatch in the same file: `:104-121` `locateNativeTurnArtifact`, branching
`codex` → `findLatestCodexRollout` vs `grok` → `updates.jsonl`.

> **Cross-reference to my vendor research** (`planning/vendor-surfaces-grok-opencode.md`, landed
> `a00ca100`): the premise for **opencode** in that comment is now **outdated**. I verified live that a
> project-scoped plugin at `.opencode/plugin/` auto-loads with **no config edit, no trust step, and no
> global write** — so opencode's exclusion ("hooks/plugins live only in the operator's global config
> (which Hive never writes)") no longer holds. This is precisely the failure mode a descriptor prevents:
> a vendor fact changed, and the stale belief is frozen into a boolean expression in an unrelated file
> instead of one descriptor the adapter owns.

**Duplicated per-provider knowledge across two files** — the same resume/effort/session-id facts, twice:

- `src/daemon/recovery.ts:695` (`claude` + effort), `:721` (`codex` effort default `"medium"`),
  `:745` (`grok` + effort), `:794` (`grok`), `:801`/`:805` (`kimi`), `:812` (`codex` + instructions)
- `src/daemon/spawner-impl.ts:1603` (`claude`), `:1677` (`codex`), `:1730` (`grok` session id),
  `:2683` (`grok` UUID mint), `:2756` (`codex`)

Recovery and spawn must agree on how each provider resumes; today they agree only by two authors having
written the same branches. That is the drift §10 forbids.

**Excluded as false positives:** `src/daemon/memory-embeddings.ts:319,339,365` match
`provider === "api"` — an **embedding** provider, not a `CapabilityProvider`. Not relevant.

**Smallest change:** move the three facts these branches actually consult — has-usable-hooks, has a
turn/transcript reader, needs-a-pre-minted-session-id — onto the existing
`ProviderCommunicationCapabilities` descriptor, and have both `recovery.ts` and `spawner-impl.ts` read it.
**Needs a decision** on descriptor placement and on whether opencode's monitoring exclusion is lifted
now that its plugin path is verified. §10 also requires that "a new provider must compile-fail until its
descriptor and terminal fallback tests exist" — a `switch` over `CapabilityProvider` with no default gets
that for free, which these `if` chains do not.

## 3.3 Repeated prompt prose and wake memory

### 3.3a Pitfall memory is re-injected on every wake — **needs decision**

`src/daemon/memory-delta.ts:161-181`. The comment is explicit:

```
// (a) Pitfalls matching the current brief — the pitfall-check/FTS path,
// deliberately NOT filtered by the high-water mark: a task-matching
// pitfall matters however old it is.
```

Every wake re-runs `options.memory.search(brief, { limit: 8 })` (`:173`) and re-appends up to 8 pitfall
lines. Nothing tracks whether this agent already saw them.

**Why it must go:** §11's Communication diet states it directly — *"Do not append the same
task-matching memory on every wake. Task-relevant memory is selected once for bootstrap or handoff;
later memory is pull-based unless a new, directly relevant warning requires an explicit system
message."* §11's success condition names "unchanged memory is not re-injected" as a pass criterion.
The brief is fixed for an agent's lifetime, so the same 8 lines recur on every wake for the whole run.

The justification ("a pitfall matters however old it is") is genuine, which is why this needs a decision
rather than a deletion: §11 permits exactly one carve-out — "a new, directly relevant warning". The
smallest change consistent with both is to send a pitfall **once per agent** (bootstrap) and thereafter
only when it is new to *that agent*, tracked with a per-agent mark alongside the existing
`MemoryHighWater` — leaving the pitfall's age irrelevant, as intended, while stopping the repeat.
Whether "new to this agent" or "new since high-water" is the right predicate is the decision.

**Changes are already correctly deltaed** (`:142-144`, filtered by `entry.ordinal > highWater[scope]`,
mark advanced only after delivery per `:128-130`). That half complies with §11 — leave it alone.

### 3.3b Memory-delta change lines are not deduplicated — **mechanical**

`src/daemon/memory-delta.ts:184-193` — `changes.map(...)` renders one line per **log entry** with no
dedup by article.

**Observed firsthand this turn.** The memory delta injected into my own prompt read:

```
Wiki changes:
- [global] 2026-07-24 new/updated: kimi web REST is a second executor, not a channel into a live Kimi TUI
- [global] 2026-07-24 new/updated: kimi web REST is a second executor, not a channel into a live Kimi TUI
```

Two byte-identical lines, and a header at `:197-199` that counted them as "2 changes". One article
updated twice past the high-water mark produces two log entries and thus two identical rendered lines.

The comment at `:145-148` reasons that "Title is unique per scope … so a log entry's title resolves to at
most one article" — true for the *facts lookup*, but it does not imply the **log** holds one entry per
article, and nothing downstream dedups. So the count over-reports and context is wasted on a repeat —
a small §11 Context-economy leak with a visible correctness face (an agent reading "2 changes" reasonably
infers two distinct facts changed).

**Minimal change:** dedupe `changeLines` by rendered line (or by `scope` + normalized title, keeping the
newest entry) before the count at `:198` is taken.

### 3.3c Spawn-prompt prose volume — **needs decision**

`src/daemon/spawner-impl.ts:1012-1179` carries, as prose constants, on top of the task and landing
protocol: `CONTINUOUS_EXECUTION` (`:1012`), `CODING_GUIDELINES` (`:1027-1034`, self-documented at `:1022`
as **~560 tokens a spawn**), `HIVE_PROTOCOL_RULES` (`:1050-1056`), `GRAPHIFY_DIRECTIVE` (`:1119-1133`),
`GROK_SAFETY_DIRECTIVE` (`:1137-1149`), `SEARCH_HYGIENE` (`:1157-1164`), `CODE_REVIEW_RULES`
(`:1172-1179`).

**§11 does not say "delete this."** Its Bootstrap-diet rules are conditional, and the code has clearly
already been reasoned against them:

- *"Keep a concise behavioral rule only when the agent must exercise judgment and Hive cannot enforce
  the decision mechanically."* The comments at `:1017-1022` and `:1036-1049` argue exactly this — skills
  are progressively disclosed, so a rule left to a skill reaches only agents that elect to open it, and
  "a behavioural guarantee that depends on the agent electing to receive it is not a guarantee."
  That is a correct reading of §11, not a violation of it.
- *"Category-specific contracts appear only for that category."* Already honored: `CONCISE_CATEGORIES`
  drives a concise preamble (`:1196-1198`), and `GROK_SAFETY_DIRECTIVE` is gated on
  `options.tool === "grok"` (`:1252`).
- *"Put operation-specific semantics in the relevant tool description instead of every spawn prompt."*
  Partly honored, and `:1045-1048` says so: protocol rules 1-2 also ride `hive_send`'s tool description,
  "so an agent meets them at the moment it picks a priority."

**What I can flag as unjustified, without designing a replacement:** by the project's own reasoning at
`:1045-1049`, any rule that has a **daemon-enforced choke point** is already guaranteed and does not need
prompt prose. Protocol rules 1 and 2 have one (`hive_send`), and they are still shipped in full in the
prompt — that duplication is the concrete §11 "remove repeated prose when the rule is already
daemon-enforced" target. Rules 3 and 4 are epistemic with no choke point (`:1048-1049`) and, by §11's own
"agent must exercise judgment" clause, are the ones that legitimately stay.

`CODE_REVIEW_RULES` (`:1172-1179`) is only meaningful for review categories; if it is not already gated
the way `GROK_SAFETY_DIRECTIVE` is, gating it is the same mechanical shape as the existing `:1252` gate.

**Decision required:** which rules are considered daemon-enforced enough to drop from the prompt. That is
a behavioral-guarantee judgment, not an audit finding, and measuring first is what §11 asks for —
*"Measure current bootstrap and wake distributions before choosing the constants"* — so this item should
not be actioned on prose-length intuition alone.

---

## Complexity flagged but not costed

Named per the brief, without proposed replacements:

- **§7's control table is aspirational.** Four of five operations (`pause`, `resume`, `cancel-turn`,
  `stop-provider`) exist as message intents only, not as process control with the specified proofs
  (3.1b). The audit's other items are deletions; this one is unbuilt surface, and sizing it is a
  planning task.
- **Recovery/spawn provider knowledge is duplicated by construction** (3.2). Even after a descriptor
  lands, the two call sites must be proven to agree; §10's compile-fail requirement is the mechanism,
  and nothing enforces it today.
- **`native/` carries the full three-target vocabulary that TS never exercises**
  (`neutral_operations.zig:315-329`). Either the TS side grows into it (3.1) or the unused native paths
  are dead capability. I did not determine which, and it is the kind of thing §10's "a new provider must
  compile-fail" discipline is meant to prevent accumulating.

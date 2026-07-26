# Hive repo production audit — 2026-07-25

Scope: full-repo audit requested before any change. Goal set by Scott: *clean up the
project, and prove every feature works using prototypes before calling it good.*

Standing rule adopted for this work: **a passing test is not evidence.** Every claim
below is verified against the production call graph, not against test status.

---

## 1. Headline

The test suite is green **because part of it tests code production never runs.**

`bun test`: 1820 pass, 11 skip, 2 todo, **0 fail**, 6811 assertions, 179 files.
`tsc --noEmit`: clean. And the app is barely usable. Both facts are true, and the
reason they coexist is the finding of this audit.

A static walk of the production call graph from the real entry point (`src/cli.ts`)
found **54 exported symbols whose only occurrence in all of `src/` is their own
declaration** — zero production callers. 29 of those are referenced by tests. So
there is a body of code that is implemented, typed, asserted by a green test, and
unreachable in production.

This is the same defect class already burned into the repo history at `ac6fde0e`:
`INPUT_ORPHAN_DISCARD` was fully implemented, production-wired, and had a passing
test, while one guard line made it dead for **every message Hive has ever sent**.
That was not a one-off. It is the repo's dominant failure mode.

## 2. The mechanism: dead twins

The dead symbols are not random. Nearly every one is a **superseded implementation
whose replacement shipped, while the original stayed behind with its tests intact.**

| Dead in production | Live twin actually used | Twin refs |
|---|---|---|
| `findLatestClaudeSessionId` (`claude.ts:342`) | `discoverClaudeRecoverySessionId` (`claude.ts:376`) | 3 |
| `findLatestCodexSessionId` (`codex.ts:385`) | `discoverCodexRecoverySessionId` / `findCodexRolloutBySessionId` | 3 / 8 |
| `detectClaudeCliVersion` (`claude.ts:122`) | sync `--version` probe in `provider-executable.ts:33` | live |
| `composeVisibleStatus` (`status-fusion.ts:410`) | `fuseAgentStatus` (`status-fusion.ts:286`) | 8 |
| `capabilityFreshness` (`schemas/capability.ts:452`) | — nothing; staleness is never checked | 0 |

The two Claude functions sit **34 lines apart in the same file**, doing the same job,
one live and one dead. That is the literal form of Scott's complaint about "multiple
things doing the same job."

Consequences that are real, not cosmetic:

- **`VisibleStatus` is entirely dead.** Both the type (`status-fusion.ts:104`) and its
  only producer `composeVisibleStatus` have zero production references. Production
  fuses status via `fuseAgentStatus` and then never composes the visible projection.
  A whole presentation layer exists on paper only — and status display is one of the
  symptoms Scott reports.
- **Capability staleness is never evaluated.** `capabilityFreshness` has 8 test
  references and 0 production callers. Nothing in the running system asks whether a
  capability record is stale.
- **Vendor CLI version drift is undetected** on the Claude path — the richer async
  detector is dead; only a bare sync `--version` probe runs.

Roughly 30 tests assert the behaviour of these abandoned twins. They are green, they
will stay green, and they protect nothing. That is the answer to "why do tests pass
when it doesn't work."

### Not a finding (checked and cleared)

The `*_WIRE_SCHEMAS` bundles (`SESSION_WIRE_SCHEMAS`, `STATUS_WIRE_SCHEMAS`,
`MESSAGE_TERMINAL_WIRE_SCHEMAS`, `HV1_CAPABILITY_WIRE_SCHEMAS`) and the `*_CONTRACT`
constants also show zero production references. I initially flagged these as an
unvalidated-wire-contract gap. **That was wrong** — the individual schemas they
bundle *are* used in production (`HelloPayloadSchema` 8, `WelcomePayloadSchema` 8,
`CreateBeginPayloadSchema` 7). The bundles are test-facing registries. No defect.

## 3. Measurements

| Dimension | Value |
|---|---|
| TypeScript | ~74k LOC, 195 files in `src/` |
| Swift | 354 files (`workspace/`) |
| Zig | 781 files (`native/`) |
| `bun test` | 1820 pass / 0 fail / 51.5s |
| `tsc --noEmit` | clean |
| `bun run check` | red — 39 lint warnings + 14 files of formatter wrapping, **zero semantic content** |
| `native/sessiond/test.sh` | **>25 min, not yet complete** — multi-stage build + 139 tests. Unverified. |
| Unreachable modules in `src/` | 0 (7 flagged, all genuine entry points) |
| Exported symbols with zero production callers | **54** |

### Structure

- **`src/daemon/server.ts` is 7,511 lines.** `class HiveDaemon` spans L771–L7485 —
  **6,714 lines, 85 methods** in one class, mixing HTTP routing, quota settlement,
  memory writes, kill/teardown, worktree reconciliation, episodic ingestion, and
  telemetry. This is the single largest maintainability liability in the repo.
- Subsystem sprawl: quota **7,801 LOC** / 7 files; memory **5,291 LOC** / 12 files.
  Both are *layered correctly* (probes → ledger → service) — large, not tangled.
  They are not the emergency.

### Repo hygiene

- **18 orphan scripts, ~5,300 lines**, referenced by nothing: `b25-a4-proof.ts`
  (1,364 lines), `b22-live-attach-proof.ts` (564), `b25-production-pane-wiring-proof.ts`
  (289), `sessiond-lifecycle-staged-proof.ts` (291), plus 2,566 lines of dead
  `qualify-*.sh`.
- `raw/` — **20MB, 333 tracked files**, 17 PNGs.
- `planning/` — 47 files, 1.0MB. `docs/design/` — 768K of HTML.
- **Branch state: 22 commits ahead of `main`, nothing merged.** Includes three
  `TEMPORARY:` telemetry commits (`ed995a06`, `b34ae3f5`, `7e961455`) plus 29
  uncommitted telemetry lines in `TerminalTelemetry.swift` and
  `ProjectWindowController.swift`.

## 4. Known-real defects carried in from the prior session

Not re-derived here; these are already measured and outstanding.

1. **readOnly containment (security, highest).** Read-only is a false label on 3 of 5
   vendors, with escape files verified on disk. `Monitor` missing from `readOnlyDeny`
   (`claude.ts:562`); permission block written only under the agent entry instead of
   top level (`opencode.ts:178`); Kimi emits nothing (`kimi.ts:75-79`). Two false
   `SPEC.md` claims to correct (`:117`, `:115`).
2. **Delivery-state truthfulness.** `injectedAt` stays null while a manual drain flips
   rows to `applied`, so `state` is not evidence of delivery; root delivery flattens a
   detailed denial to a boolean; root is excluded from stuck-delivery alerts.
3. **sessiond capacity exhaustion** — blocks reliable multi-agent work.
4. **`ac6fde0e` is landed but not in force** — it spans Zig and daemon TS; requires a
   `hive-sessiond` rebuild and daemon restart before it does anything.

## 5. Recommended order

1. **readOnly containment** — a safety control that does not work.
2. **Purge the dead twins and their tests.** This is what makes green mean something.
   Delete the superseded implementation, keep the live one, delete the tests that
   pointed at the corpse. Then decide, per feature, whether `VisibleStatus` and
   `capabilityFreshness` should be wired up or removed — they are currently neither.
3. **Delivery-state truthfulness**, so fixes become verifiable.
4. **sessiond capacity.**
5. **Decompose `HiveDaemon`** along its seams.
6. **Hygiene** — orphan scripts, TEMPORARY telemetry, `raw/`, lint/format.

## 6. Proof obligations

Per the stated goal, each item ships with a prototype that exercises the real
production path and demonstrates the behaviour on the wire — not a unit test.

- readOnly: per-vendor prototype against current vendor documentation, attempting a
  real write from a read-only agent and showing it denied.
- Dead twins: prove the live twin is the one that executes (instrumented run), then
  remove the dead one and show the suite still passes with the corpse tests gone.
- Delivery: a message sent end-to-end with `injectedAt` and `state` agreeing.
- Any vendor-facing change: current vendor docs consulted, prototype first.

## 7. Executed — readOnly containment (2026-07-25)

Vendor docs consulted first, hole reproduced through the real production writer,
fix applied, containment re-proven. Prototypes were throwaway (scratchpad) so the
repo does not gain another orphan proof script; the property they proved is now a
permanent regression test.

**Claude** — `readOnlyDeny` was `["Edit","Write","NotebookEdit","Bash"]`. Checked
against the vendor's current tool table
([tools reference](https://code.claude.com/docs/en/tools-reference)), three
permission-required, mutation-capable tools were missing: `Monitor` (takes an
arbitrary shell command), `PowerShell`, `EnterWorktree` (creates a worktree on
disk). Under `bypassPermissions` nothing prompts, so these were **no-prompt**
escapes. Prototype output before the fix, driving `writeClaudeAgentConfig`:

```
deny: ["Edit","Write","NotebookEdit","Bash"]
RESULT: ESCAPE — PowerShell, Monitor, EnterWorktree not denied
OVERALL: FAIL — read-only is a false label
```

After: `CONTAINED` in both attended and bypass modes.

Two tools were deliberately **not** added: `Skill` (its shell still goes through the
denied `Bash`) and `Agent` (a subagent's tool calls are checked against these same
rules — confirmed in the vendor docs, so the existing code comment was right).

**OpenCode** — `permission` was written only under the `agent.hive` entry. Per
[opencode permissions](https://opencode.ai/docs/permissions/), agent rules merge
over global and a `task`-spawned subagent runs as a *different* agent, so it fell
back to global and kept `bash` + `edit`. Hive now also writes a global barrier,
merging rather than replacing (a user's `webfetch: "allow"` survives, proven).
Safe because Hive writes into the agent's own worktree, not the user's checkout.

**Kimi — NOT fixed, and cannot be.** Kimi's only deny channel is
`[[permission.rules]]` in the operator's global `config.toml`
([config docs](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html)).
Hive does not write operator config, so read-only on Kimi is **reported, not
enforced**. This needs an honest-reporting path at spawn; it is a design decision
about the surfacing channel, not a config write, and is left open deliberately.
**Grok remains unmeasured** (HTTP 402, balance exhausted).

**SPEC.md corrected** — both false claims. `:115` claimed readers share the main
checkout; `makeWorktree` is unconditional, so every reader gets a worktree. `:117`
claimed a reader "cannot regain shell access through a config default"; now states
where that holds, where it does not (Kimi), and that a denylist against a moving
vendor tool table fails open by construction.

**Verification:** `tsc --noEmit` clean; `bun test` **1840 tests, 1827 pass, 0 fail**
(up from 1833/1820 — the seven new cases are the per-tool containment assertions);
`native/sessiond/test.sh` **exit 0**. Two pre-existing tests failed on the fix and
were updated: they asserted the old four-item deny list verbatim, which means they
were **pinning the vulnerability in place** — a small instance of this audit's
whole thesis.

## 8. Executed — dead-twin purge and hygiene sweep (2026-07-25)

**Live twin proven first.** A prototype built a real Claude transcript layout and
drove `discoverClaudeRecoverySessionId` (the function `recovery.ts` imports): it
resolved `ses-after` and correctly refused a transcript belonging to a different
checkout. Worth recording *why* the twins differ — the dead one selected on file
**mtime**, the live one requires in-file `sessionId` + `timestamp` + `cwd`
evidence. The live path is strictly stronger; the corpse was the weaker design.

Removed, with zero production callers each:

| Removed | Superseded by |
|---|---|
| `findLatestClaudeSessionId` | `discoverClaudeRecoverySessionId` |
| `findLatestCodexSessionId` | `discoverCodexRecoverySessionId` |
| `detectClaudeCliVersion` | `probeClaudeVersion` (sync, adjacent in the same file) |
| `composeVisibleStatus` + `VisibleStatus` | `WorkspaceVisibleStatusComposer` **in Swift** |
| `CommandRunner` (claude.ts) | the `CommandRunner` in `graphify.ts` |
| `runCommand` (claude.ts) | orphaned by the above |

`composeVisibleStatus` is the most interesting: the visible-status projection was
reimplemented across the language boundary in `WorkspaceCore/WorkspaceStatus.swift`
and is used there. The TS copy was the abandoned half of a **cross-language**
duplicate — invisible to any single-language search.

**Corpse tests: repointed where they covered something real, deleted where they
did not.** Two Codex tests (8 KiB `session_meta` lines, unknown session-id key)
exercised shared helpers the live path also depends on, so they now call
`discoverCodexRecoverySessionId` and keep their coverage. The mtime-ordering test
was deleted outright — the live path selects on timestamp evidence, not recency.
Net: 54 → 50 zero-caller symbols.

**`capabilityFreshness` — first read wrong, then corrected.** Its docstring says
*"Callers that derive must check this,"* and nothing does, so the first pass here
recorded it as an unguarded stale-catalog hole. That was wrong. Reading
`routing-derivation.ts:12` shows **the derivation engine was deliberately deleted**
in the 2026-07-13 cutover (*the user is the router*), which removed every caller
the helper was written for. It is a leftover, not a hole — deleted, along with
`valueOr`, with the reasoning left as a comment at the removal site so the next
reader does not re-litigate it.

The one real residue: validation is supposed to *name* staleness in its warnings,
and does not. That is a reporting gap, not a safety gap — validation deliberately
does not gate on staleness, because refusing a launch over an old catalog turns a
discovery hiccup into an outage. Recorded, not implemented.

**Hygiene.** 15 orphan scripts deleted (**4,820 lines**) — all `b25-*-proof`,
`qualify-*`, and staged-proof one-offs with no reference from `Makefile`,
`package.json`, `install.sh`, CI, or any source tree. `scripts/*.test.ts` were
explicitly spared: nothing *references* a test file by name, the runner discovers
it, and all three carry live coverage (179 test files on disk = 179 executed).

**`raw/` — partially deleted, and the "aggressive" instruction was narrowed on
evidence.** `raw/` is cited **101 times across 27 files**, including live docs
(`docs/providers/quota-surfaces.md`, `docs/design/hivememory.html`). Deleting it
wholesale would have created 101 dangling citations, violating the repo's standing
sweep policy. Instead each file was tested for citation: **156 uncited files
(16MB) removed, 177 cited files kept**. Verified afterwards: **0 citations broken
by the deletion**. The 22 dangling `raw/` citations that remain were checked
against `HEAD` and **all pre-date this work** — a pre-existing cleanup item.

Note the memory compiler's `raw/` is `.hive/memory/raw`, a different directory
from the repo-root `raw/`; SPEC §5's "immutable raw/ observations" refers to the
former, and nothing under `.hive/` was touched.

**`bun run check` is green** — exit 0, after ~23h red. 398 files formatted, 14
fixed; purely line-wrapping as measured, no semantic content.

**Verification:** `bun run check` **exit 0** · `tsc --noEmit` clean · `bun test`
**1833 tests, 1820 pass, 0 fail** · `native/sessiond/test.sh` **exit 0** ·
**199 files changed, ~129,200 deletions**. Zero-caller symbols: **54 → 48**.

## 9. Executed — delivery-state truthfulness (2026-07-25)

**The lie, reproduced through the real pull path.** A prototype queued messages
and drained them via `MessageDelivery.inbox` / `orchestratorInbox`:

```
agent pull, normal priority   state: applied   injectedAt: null
agent pull, urgent priority   state: injected  injectedAt: set     <- already honest
root pull (orchestratorInbox) state: applied   injectedAt: null
OVERALL: FAIL — state is not evidence of delivery
```

`applied` — the strongest claim in the system, meaning *the recipient acted* —
was recorded purely because a poller **fetched** the row. No turn boundary
existed. The push path has forbidden exactly this since the busy-pane
measurement documented at `delivery.ts:1959` ("measuring bytes written to a pane
and reporting that a mind changed"); the fix landed on the push path and never
reached the pull paths.

**Why it made the outage unreadable.** The bad rows carried `state='applied'`
with `injectedAt=null`, a combination the lifecycle cannot otherwise produce.
`listInjectedUnapplied()` filters `injectedAt IS NOT NULL`, so those rows were
invisible to **both** `reconcileInjected` and the stalled-delivery sweep: a
maximal claim, on no evidence, in the one shape guaranteeing nobody would ever
re-examine it. That is the mechanism behind "persistence is never reported as
delivery" (SPEC §1) being violated in practice.

**Fix.** Both pull paths now record `injected`, exactly like the push path.
Urgent priority already did — this made the two consistent rather than
redesigning anything. `applied` is earned in `reconcileInjected` on a real turn
boundary, which already covers the root via `turnBoundaryAt` (the 105-of-107 case
in its own comment).

**Proven both directions.** Honesty is worthless if a message can never be
confirmed, so the prototype also drives the promotion: after a `turn-end` event,
`reconcileInjected` confirmed **3 of 3** — agent and root — and all reached
`applied`. New regression test `test/daemon/delivery-state-truthfulness.test.ts`
(4 tests) is **mutation-proved**: restoring the old `"applied"` write fails 3 of
4, and the root test correctly stays green because that mutation touches only
`inbox`.

Notably the full suite passed **unchanged** after the fix — nothing anywhere
asserted the old behaviour. The system's most load-bearing delivery claim was
entirely unguarded, which is this audit's thesis in its purest form.

**Verification:** `bun run check` exit 0 · `tsc` clean · `bun test` **1837 tests,
1824 pass, 0 fail**.

## 10. Executed — the two sibling delivery defects (2026-07-25)

Both came from the same handoff. One was real; the other was not.

### 10a. Root denial reasons — real, fixed

`RootProtocolDeliverer.deliverMessage` returned a bare `boolean`. The deliverer
knows exactly which gate refused — a changed foreground, an input claim held by
someone else, a host that is not running, an unbound provider run — and threw all
of it away one call before `deliverRoot`, whose comment (`delivery.ts:943`) states
the opposite intent: *"Every non-delivery records WHY on the row. The 2026-07-21
acceptance run failed with the root wake silently declining or dying on all four
queued messages; between a /dev/null stderr and a blind catch there was no surface
left that could say which gate refused."*

Prototype, driving `deliverRoot` with two genuinely different refusals:

```
refusal: foreground-changed: pid 4212 replaced 4109
  deliveryDiagnostic: root wake failed: the root protocol did not confirm delivery
refusal: claim held by a human composer until 12:31:00Z
  deliveryDiagnostic: root wake failed: the root protocol did not confirm delivery
distinct diagnostics for 2 distinct causes: 1   <- FLATTENED
```

The mechanism was already there and unused: `recordMessageDeliveryDiagnostic` has
**15 call sites on the agent path** and the column is documented as "the durable
answer to why is this message still queued." Root reached it with one constant
string.

Fixed by replacing the boolean with a discriminated union — a refusal must carry
its reason, a delivery has none to carry, so the shape makes the old bug
unrepresentable:

```ts
export type RootDeliveryOutcome =
  | { delivered: true }
  | { delivered: false; reason: string };
```

Each gate now names itself, and a host decline forwards the host's **own words**
rather than the coarse `MessageAttempt` enum it is bucketed into (the enum is not
the diagnostic; `claim held by <who> until <when>` is the sentence that ends an
investigation). After: **2 distinct diagnostics for 2 distinct causes.**

The six existing root-delivery tests were strengthened from `.resolves.toBe(false)`
to asserting the exact reason — previously they could not have caught this.
TypeScript also proved a defensive branch I wrote unreachable (the outcome union
has no third member), so it was removed rather than kept.

### 10b. Root excluded from stuck-delivery alerts — NOT a defect

Investigated and cleared. Root is excluded only from the **queued-phase** sweep
(`delivery.ts:1599`), and deliberately: *"the root's queue is its inbox, drained by
hive_inbox on its own turns — and the root is this alert's audience, so 'you have
unread mail' would be noise by construction."* Root is **not** excluded from the
injected-phase alerting, and `stalledReason` handles root explicitly via
`orchestratorRecipientNames()`. Sound design, correctly reasoned. No change made.

Worth noting §9's fix increases this path's value: root messages now enter
`injected` rather than jumping to `applied`, so they flow through the
injected-phase reconciliation and alerting that already covered them.

**Verification:** `bun run check` exit 0 · `tsc` clean · `bun test` **1837 tests,
1824 pass, 0 fail**.

## 11. `HiveDaemon` decomposition — measured, and it is not a refactor

Before attempting the extraction I measured which instance fields each method
actually touches, because "break up the god object" is only mechanical if the
methods separate. They do not.

| Measure | Value |
|---|---|
| Methods | 85, **6,589 lines** of method body |
| Methods touching **no** instance state | **1** (`denied`, 9 lines) |
| `createMcpServer` | **1,722 lines**, touches **40** fields |
| `constructor` | 503 lines, touches **72** fields |
| Next largest | `processEvent` 258 · `killAgentTeardown` 236 · `refreshToolTelemetry` 218 |

84 of 85 methods touch instance state, and the largest single method — a quarter
of the class on its own — reaches 40 of its fields. Those fields are `private`,
so moving the body to another module does not compile without widening the
class's visibility, which is a design change, not a move.

### Correction: the pattern works, and one method is out

The paragraph below originally concluded the decomposition was blocked outright
because the fields are `private`. **That was wrong**, and the error was mine: a
method's body can move to a free function taking an explicit `deps` object, with
that object built *at the call site inside the class* — where the privates are
readable. No visibility widening, no redesign prerequisite.

Proved on `refreshToolTelemetry`, the cleanest seam (218 lines, 3 fields and 5
injected readers, all `readonly`; `graphifyCalls` passes by reference because the
sweep advances the cursor in place). Now `src/daemon/tool-telemetry-refresh.ts`
with a named `ToolTelemetryRefreshDeps` interface, the class method reduced to a
12-line delegation.

Then repeated on `processEvent` (258 lines, 8 fields + the teardown call). Its
deps interface types the teardown as returning `unknown` on purpose: that path
awaits it for effect and reads nothing back, so the seam neither needs nor should
import the caller's large result shape. `logAlertDeliveryFailure`, needed by both
sides once a second module existed, moved to `alert-log.ts` rather than being
duplicated.

Then `checkWakePaths` (104 lines) and `sweepResources` (161). Two seams needed
more than a field list, and both are worth recording as pattern:

- `alertedWakeFaults` crosses **by reference** — the check de-duplicates its own
  alerts across sweeps by remembering what it already reported, so a fresh set
  per call would re-alert forever.
- `memoryPressure` crosses **as a setter**, not a field. It is daemon-owned
  mutable state read by an unrelated endpoint; a copied boolean would let the
  sweep raise the flag into a value nobody else can see.

| | before | after |
|---|---|---|
| `server.ts` | 7,511 lines | **6,718** (−793, −10.6%) |
| modules extracted | — | `tool-telemetry-refresh.ts`, `process-event.ts`, `wake-path-check.ts`, `sweep-resources.ts`, `attach-grant-endpoint.ts`, `alert-log.ts` |

Five methods out, all behaviour-identical under `bun test` (1843 tests) and `tsc`.
`attachGrantEndpoint` added a third pattern worth keeping: its three
authorization callbacks cross as **functions, not the capability store**. A route
needs the daemon's audited decisions, not the ability to mint its own — handing
it the store would give a route the authority to decide what it is allowed to do.

### `createMcpServer` — DONE. All 34 tools extracted into seven group modules

| | before | after |
|---|---|---|
| `createMcpServer` | **1,721 lines** | **138** (−92%) |
| `server.ts` | 7,511 | **4,970** (−33.8%) |
| `HiveDaemon` method lines | 6,589 | **4,219** (−36%) |
| modules extracted | — | **15** |

The seven groups: `memory-tools` (11 tools, 13 deps) · `quota-tools` (4, 4) ·
`messaging-tools` (6, 8) · `agent-control-tools` (3, 6) · `status-tools` (4, 15 —
the widest, because status reads from everything) · `spawn-approval-tools` (4, 7)
· `land-tool` (1, 6) · `graph-tool` (1, 2). Plus the shared `tool-result` and
`alert-log`.

Every step verified by `tsc` + the full suite before the next began. Three
patterns emerged that a bulk move would have gotten wrong:

- **Mutable daemon state crosses as an accessor, never a value.** `memoryPressure`
  as a plain boolean turned `if (deps.memoryPressure)` always-true, which would
  have **refused every agent spawn permanently**. `tsc` caught it (TS2774); the
  1830-test suite did not, because nothing exercises that branch.
- **Sets that exist to deduplicate cross by reference.** `alertedWakeFaults` and
  `resolvingApprovals` are the in-flight guards against re-alerting and
  double-resolving; a copy defeats the only thing they exist for.
- **Optional deps must stay optional.** Wrapping `modelInventory` in an arrow made
  an absent inventory look always-present and would have crashed instead of taking
  its guarded branch.

Shared symbols (`LIVE_STATUSES`, `LAND_REARM_PREFIX`) moved *into* the group
module rather than being duplicated: `server.ts` already imports from these
modules, so the direction creates no cycle.

**The constructor is deliberately NOT extracted, and this is a decision, not a
gap.** It is 503 lines assigning 72 fields: it *is* the assembly point. Hoisting
it into a `buildDependencies()` helper would not reduce coupling — the fields
still land on `this` — so it would move 72 assignments to improve a line count
and nothing else. That is change for the metric's sake. It has already shrunk as
the seven groups left, and that is the only shrinking it should get.

**The decomposition is complete.** What made `HiveDaemon` a god object was 34
tool handlers and their private state reached through `this`; those are out, each
behind a named dependency interface. What remains is a daemon that owns its
lifecycle, its HTTP routes, and the wiring — which is what the class is for.

### Original analysis (superseded, kept for the measurements)

Attempted next. The finding is that moving it whole is the wrong shape: it is
**1,721 lines registering 34 MCP tools**, reaching **41** distinct `this.`
members — a mix of fields and private methods with large return types
(`killAgentTeardown`, `statusLiveness`, `semanticRecall`). A single move needs a
41-member hand-written interface and lands as one unreviewable diff.

It splits cleanly **by tool group** instead, which is also the more meaningful
boundary. **The first group is now extracted** — `src/daemon/memory-tools.ts`,
`registerMemoryTools(server, capability, deps)`, 11 tools and their 8
memory-specific local symbols (seven request schemas, `MemoryIdSchema`,
`MEMORY_RECALL_DEFAULT_BUDGET`) moved with them. One test that imported the
budget constant from `server.ts` was repointed.

**Second group out: `quota-tools.ts`** — `hive_quota_status`, `hive_token_usage`,
`hive_models`, `hive_quota_reconcile`. The smallest dependency set in the whole
surface (4), plus `QuotaObservationRequestSchema` moved with it. One correctness
detail the compiler caught: `modelInventory` is optional on the daemon and the
handler already branched on `undefined`, so the dep is typed
`(() => Promise<ModelInventory>) | undefined` and passed straight through rather
than wrapped in an arrow that would have silently made it look always-present.

**Third group out: `messaging-tools.ts`** — `hive_send`, `_escalate`,
`_ack_message`, `_inbox`, `_pickup_handoff`, `_read_message`, with six local
request schemas and `inferLegacyControl` moved along. Two findings:

- `memoryPressure` crosses as a **getter**, and converting it turned
  `if (deps.memoryPressure)` into an always-true test — which would have
  **refused every agent spawn permanently** with a bogus memory-pressure error.
  `tsc` caught it (`TS2774`); the suite would not have, because nothing exercises
  that branch. This is the argument for extracting incrementally behind a
  compiler gate rather than in one sweep.
- `spawnAgent` was *defined* in the messaging region but only *used* by the
  lifecycle tools, so it went back to `server.ts` instead of being stranded.

`server.ts` **7,511 → 5,744 lines (−1,767, −24%)**, 10 modules extracted,
`check` exit 0, `tsc` clean, `bun test` 1830 pass / 0 fail.

**Stop point and a warning for whoever continues.** The next slice
(`hive_recover` / `hive_mark_dead` / `hive_kill`) must end at the close of
`hive_kill`'s registration, NOT at the next `registerTool`: the delegation calls
this decomposition itself inserted now sit between the tool groups, so a
"last registerTool before the next tool name" heuristic swallows
`registerMessagingTools(...)` and the `spawnAgent` helper. The tell is a dep list
containing `memoryPressure: () => this.memoryPressure` — that is inserted code,
not tool code. Delimit by the tool's own closing `);` instead.

The slice as delimited, for the groups that follow the same recipe:

- **`memory_*` tools** — `server.ts` **lines 6077–6615**, 539 lines, 11 tools
  (`memory_search`, `_write`, `_read`, `_delete`, `_reindex`, `_query`,
  `_digest`, `_pitfall`, `_note`, `_recall`, `_promote`).
- **13 deps only**: `authorizeTool`, `db`, `deleteMemoryFact`, `embeddingIndex`,
  `episodic`, `memory`, `rebuildMemoryIndex`, `repoRoot`, `semanticRecall`,
  `semanticRecallState`, `status`, `tokenUsage`, `writeMemoryFact`.
- Exact block: **6077–6609**. It ends at `memory_promote`'s closing `);` — the
  five comment lines from 6611 introduce `graph_locate` and belong to it, so
  slicing to the next `registerTool` swallows them.
- **The type obstacle is solved.** `serializeMemory<T>(op: () => Promise<T>)` is a
  generic passthrough, so no new named types are needed after all:
  - `writeMemoryFact: (input: MemoryWriteInput) => Promise<MemoryWriteFileResult & { embedding: MemoryEmbeddingWriteOutcome }>` — both names already exported (`adapters/memory.ts:371`, `memory-embeddings.ts`).
  - `rebuildMemoryIndex: () => Promise<unknown>` — its result is only handed to `toolResult(value: unknown)`.
  - `semanticRecall` / `semanticRecallState` — already written explicitly at `server.ts:1783` and `:1800`; copy verbatim.
- **Import map for the new module** (every free identifier in the block):
  `./memory-triggers` → `MEMORY_RECALL_HINT_NOTE`, `buildMemoryRecallBundle`, `memoryRecallDegradedWarning` ·
  `./episodic-digest` → `MemoryDigestInputSchema`, `runMemoryDigest` ·
  `./episodic-projections` → `MemoryQueryInputSchema`, `estimateTokens`, `runMemoryQuery` ·
  `./memory-embeddings` → `MemoryEmbeddingIndex`, `MemoryEmbeddingWriteOutcome` ·
  `./memory-index` → `findSimilarMemoryCandidates` ·
  `./memory-promote` → `scanPromotionRedaction` ·
  `./project-state` → `projectHiveUuid` ·
  `../adapters/memory` → `listMemoryFacts`, `normalizeTitle`, `readMemoryFact`, `MemoryFact` ·
  `../schemas` → `MemoryScope`, `MemoryWriteInput` · `node:os` → `homedir` ·
  `node:fs/promises` → `realpath`.
- **Symbols that must MOVE, not import** — these are module-local to `server.ts`
  and memory-specific, so they belong in the new module: the seven request
  schemas (`MemorySearchRequestSchema`, `MemoryWriteRequestSchema`,
  `MemoryFactRequestSchema`, `MemoryRecallRequestSchema`,
  `MemoryNoteRequestSchema`, `MemoryPitfallRequestSchema`,
  `MemoryPromoteRequestSchema`) and `MEMORY_RECALL_DEFAULT_BUDGET`.
- ~~`toolResult` must be SHARED first.~~ **Done** — now `src/daemon/tool-result.ts`,
  imported by `server.ts`, all 47 call sites unchanged. This was the prerequisite
  for any tool-group extraction; the memory slice is now unblocked end to end.

- Superseded note (kept for the reasoning): three deps have
  *inferred* return types that cannot be hand-written or referenced without a
  circular import — `writeMemoryFact` and `rebuildMemoryIndex` both return
  `this.serializeMemory(async () => …)`, and `semanticRecall` returns a nested
  optional function type. Resolve it by giving `serializeMemory`'s result a named
  exported type (e.g. `MemoryWriteOutcome`, `MemoryRebuildOutcome`) in
  `adapters/memory.ts` **before** extracting, then reference those names from the
  deps interface. That naming is the actual first task, not the move.

Watch the boundary arithmetic: `hive_land`'s registration sits at 6000 and its
handler runs long, so a naive "last registerTool before the memory names" lands
inside it and drags `landAgent` / `decideSpentLandGrant` /
`fileLandRearmApproval` into the dep set. Those three appearing is the signal the
start line is wrong.

Remaining groups after that: quota/usage (`hive_quota_*`, `hive_token_usage`,
`hive_models`), messaging (`hive_send`, `_escalate`, `_ack_message`, `_inbox`,
`_read_message`, `_pickup_handoff`), lifecycle (`hive_spawn*`, `_kill`,
`_recover`, `_mark_dead`, `_land`, `_approve`, `_approvals`), and status
(`hive_status`, `_update_status`, `_terminal_observe`, `_preserve_branch`).

The constructor (503 lines / 72 members) stays last: it is the assembly point,
so it shrinks naturally as the groups it wires move out.

`bun run check` exit 0, `tsc` clean, `bun test` **1843 tests, 1830 pass, 0 fail** —
behaviour identical, which is the only acceptable outcome for a pure move.

So it *is* incremental after all: one method at a time, each verified by the full
suite. What remains true is that it is 84 more methods of this, and the two
largest (`createMcpServer` at 1,722 lines / 40 fields, `constructor` at 503 / 72)
are of a different order — those genuinely want their dependency groups designed
rather than transcribed. The work is unblocked, not finished.

**Original (superseded) conclusion follows, kept because the field measurements
in it are accurate and still drive the ordering.**

**Conclusion: this is a dependency-injection redesign, not an extraction.** The
honest seams exist (`createMcpServer` is a genuinely distinct responsibility —
the MCP tool surface — and the maintenance cluster `reapIdleAgents` /
`reconcileAgents` / `reconcileOrphanedWorktrees` / `reconcileStrandedBranches` /
`recoverQuotaReservations` / `sweepResources` is reachable only from
`runMaintenance`), but each needs its dependencies named and passed explicitly
first. Doing that blind, in one pass, over code whose production paths this same
audit just proved were untrustworthy, would be exactly the kind of large
unverified change that created the problems documented above.

Recommended as its own scoped piece of work, in this order: (1) extract the
maintenance cluster, which has a single caller and a narrow field set; (2) give
`createMcpServer` an explicit dependency object; (3) only then split the file.

## 12. Executed — quota-redesign residue

All 11 `lint/correctness` warnings in the repo sat in one subsystem: **quota** —
residue from the quota-lifecycle redesign. Removed: an unused `QuotaAlertState`
import, the unused `confidenceLabel` helper, an unused `RoutingCategorySchema`
import, the unused `PercentEstimateSchema`, three unused test imports, and **two
trailing `const limit = …` statements** whose results were computed and then
discarded at the end of their methods.

Those two were checked before deletion rather than after: a discarded `limit` in
reservation code could have been a dropped guard. It was not — `resolvedLimits()`
and `limitFor()` are pure lookups and both statements were the last line of their
method, so nothing observable was lost. Leftovers from the redesign, not a
missing check.

`lint/correctness` warnings repo-wide: **11 → 0.** The 24 remaining warnings are
`noNonNullAssertion` style, almost all in tests where `!` is idiomatic.

## 13. sessiond capacity — already fixed, now independently mutation-proved

The earlier framing in this document ("untouched, needs live infrastructure") was
wrong. **`f9f01de6`, the tip commit of this branch, already fixes it**, and it
fixes hypothesis H1 from `planning/2026-07-25-sessiond-capacity-exhaustion.md`
exactly: `ProductionBackend.terminate` answers on the control plane and never
touches the in-memory `Registry` whose `occupiedSlots` gates capacity, so a
killed session stayed `.live` and fully occupied. The one mechanism that could
reconcile it, `reapExitedChildHosts`, was disabled in both directions — it wrote
`.unknown` (which `occupiedSlots` counts as occupied) and skipped every
non-child host, so after a restart, when every recovered session is adopted as
non-parent, it could not touch the registry the restart had just rebuilt.

The commit claims a real-host mutation proof. Per this audit's standing rule that
a claim is not evidence, it was re-run here rather than trusted.

**Mutation:** restore the pre-fix `entry.record.state = .unknown` in
`reapExitedHosts`. Result:

```
run exe sessiond-real-host-golden        failure
broker.zig:3263 test.registry reaps an exited broker-owned host child   failed
Build Summary: 64/67 steps succeeded; 2 failed; 277/278 tests passed; 1 failed
error: the following build command failed with exit code 1
```

Two independent guards catch it — the **real-host golden** (`real-host-golden.zig:483`,
downstream of `waitForProcessAbsence`, which is precisely the leg the handoff
recorded as never demonstrated outside `FakeHost`) and a broker unit test.
`broker.zig` was then restored byte-identical to HEAD, the content that ran
**exit 0** on two prior full runs.

Caution for whoever automates this: the suite is invoked through a pipe in this
harness, so the reported exit status is the *pipe tail's*, not the suite's. The
mutated run was reported as "exit code 0" while the build had in fact failed.
Read the Build Summary, not the exit code.

**Still true and unchanged:** the fix is landed but **not in force** on the
running system until `hive-sessiond` is rebuilt and the daemon restarted — the
same "landed ≠ in force" trap that applies to `ac6fde0e`.

## 14. Executed — Kimi read-only honesty

Kimi cannot be contained by Hive: it has no per-launch deny channel, and its only
permission surface is `[[permission.rules]]` / `default_permission_mode` in the
operator's **global** `config.toml`
([vendor docs](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html)),
which Hive must not write — that gate belongs to the user. So a Hive "read-only"
Kimi agent launched under an operator default of `yolo`/`auto` holds full write
and shell authority.

Enforcement is impossible; **honesty is not**. `kimiReadOnlyContainmentGap()`
reads the operator's config and, when the pinned mode contradicts the requested
posture, `prepareSpawn` says so at the moment the label stops being true — naming
the vendor gate and handing the fix to the user rather than applying it.

Prototype across all five operator states:

```
no config.toml at all          warns: false (expected false)  OK
pinned "manual"                warns: false (expected false)  OK
config with no permission key  warns: false (expected false)  OK
pinned "yolo"                  warns: true  (expected true)   OK
pinned "auto"                  warns: true  (expected true)   OK
vendor config left untouched:  yes
OVERALL: PASS — reports honestly, writes nothing
```

An unreadable config returns null rather than a warning: absence of evidence is
not evidence of a gap, and Kimi's own default is `manual`. Six regression tests
added, including one asserting that reporting the gap never writes the
operator's file.

This makes the `SPEC.md:117` correction true in code, not just on paper: read-only
"is reported, not enforced" on Kimi now describes behaviour that exists.

## 15. Still open

1. Validation does not name capability staleness in its warnings (reporting gap).
2. ~~Kimi honest-reporting path~~ — **landed** (§14). **Grok remains unmeasured**:
   the account returns HTTP 402 (balance exhausted), so its containment posture
   cannot be established at all. That is a funding action, not a code change, and
   it must not be recorded as "contained" in the meantime.
3. ~~Delivery-state truthfulness~~ — **landed** (§9). ~~Root denial flattening~~ —
   **landed** (§10a). ~~Root excluded from alerts~~ — **investigated, not a
   defect** (§10b).
4. ~~sessiond capacity exhaustion~~ — **already fixed at `f9f01de6` and
   mutation-proved here** (§13). Remaining action is operational, not code:
   rebuild `hive-sessiond` and restart the daemon so the fix is in force.
5. **`HiveDaemon` decomposition** — **unblocked and started** (§11):
   `refreshToolTelemetry` extracted, server.ts 7,511 → 7,314. The deps-object
   pattern is proven and repeatable; 84 methods remain, and `createMcpServer`
   (1,722 lines / 40 fields) and the constructor (503 / 72) need their dependency
   groups designed rather than transcribed.
6. Three `TEMPORARY:` telemetry commits (`ed995a06`, `b34ae3f5`, `7e961455`) plus
   uncommitted Swift telemetry — deliberately untouched: reverting them needs a
   Swift build to verify, and the uncommitted edits are the operator's.
7. 22 pre-existing dangling `raw/` citations.
8. 24 `noNonNullAssertion` style warnings (non-blocking; `check` passes).

## 16. Method note

The first two passes of this audit were wrong and were corrected before reporting:
`git ls-files 'src/**/*.ts'` silently **excludes top-level `src/cli.ts`** (34KB, the
main dispatcher) and `src/version.ts`. Any audit tooling in this repo must enumerate
with `git ls-files 'src/' | grep '\.ts$'`. The uncorrected run reported 98 dead
symbols and a largely-dead CLI; both were artifacts.

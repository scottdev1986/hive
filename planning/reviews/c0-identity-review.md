# C0 · Identity — independent cross-vendor review

**Reviewer:** leo (Claude Opus 5) — different vendor from the authoring agent.
**Targets:** `04a1df2f` (C0 Identity implementation), `2a1faffd` (design-doc corrections).
**Sources:** `docs/design/hive-communication.html` §1 design rule, §2 invariants 1/2/3/5/9, §3, §4, §13 C0 row, §14 items 1/4/5/6; `docs/contracts/terminal-host-v1.md` §2/§4.
**Validation:** `bun test test/daemon/provider-run-identity.test.ts test/daemon/db.test.ts test/daemon/session-host/ test/session-host-conformance/` → 98 pass, 1 todo, 0 fail. Nothing below is attributed to the pre-existing main baseline (8 full-suite failures + red `ts-live-create`); every finding is reasoned from source in this commit.

---

## Verdict up front

The rename is complete and correct. The four-state foreground union is the right shape. The DB record matches §3 field-for-field. Repo neutrality is clean. Over-engineering is **much lower than I expected** — I explicitly went looking for unread fields and found that almost all of them are §3-mandated recovery evidence, and I am not going to invent findings there.

The serious problems are all in one place and they are all the same mistake: **provider-run death is inferred from "the run is not currently the foreground process group" rather than from measured death of the run's own process.** That single inference produces three independent false-death paths, one of which (suspend/resume) directly contradicts §14 item 5 and the C4 exit condition, and it is the reason `inspect()` — a read — writes to the database.

Second serious problem: the minting path in `createSession` is the only production code that creates a `ProviderRun`, and **no test exercises it at all.** Its correctness rests on an unverified timing assumption.

---

# MUST FIX BEFORE C1 DEPENDS ON IT

## 1. Provider-run death is inferred from foreground position, not from process death — three false-death paths, all irreversible

**`src/daemon/session-host/hive-terminal-host.ts:508-514, 528-535, 545-553`**

`projectForeground` ends the active `ProviderRun` in three places:

- L508 — `foregroundProcessGroupId === shellRoot.processGroupId` → `endProviderRun(..., "foreground-provider-exited")`, return `shell-idle`.
- L528 — `processIdentity(...)` throws → return `unknown` *(no end — correct)*.
- L545 — measured foreground identity ≠ active run identity → `endProviderRun(..., "foreground-provider-exited")`, return `unmanaged`.

`endProviderRun` (`src/daemon/db.ts:1371-1395`) is terminal and one-way: `if (current.state === "exited") return current;` and the `UPDATE ... WHERE state = 'running'`. Nothing re-mints. So every one of these is permanent.

### 1a. Suspending a provider permanently kills its run — contradicts §14 item 5 and the C4 exit condition

§14 item 5: *"Pause and resume a foreground provider; verify the PID/start token/group remain the same and zsh remains alive."* C4's exit condition: *"Holding or replacing a provider preserves the terminal and worktree."*

`SIGTSTP` a foreground provider and zsh reclaims the terminal foreground group. The provider process is **alive and suspended**; its pid and start token are unchanged, exactly as §14 item 5 demands. But the next `inspect()` hits L505, sees `foregroundProcessGroupId === shellRoot.processGroupId`, and writes `state: "exited", exitReason: "foreground-provider-exited"`. Resume (`fg` / `SIGCONT`) restores the identical pid/startToken/pgid — and Hive can never rebind to it, because the run row is terminally exited and nothing re-mints. C4 is unimplementable on top of this without either re-minting (violating §2 invariant 2's spirit: same execution, new run ID) or an undocumented resurrection path.

### 1b. Any foreground-yielding child permanently kills the run

L545: if the provider forks a child into its **own** process group and gives it the terminal — `$EDITOR`, `less`, an interactive `git` pager, Claude Code's `!` bash mode — then `foregroundProcessGroupId !== active.foregroundProcessGroupId`, so Hive declares the still-running agent's run exited and reports `unmanaged`. `sessiondAgentProviderRunIsDead` then returns `true` (L64-68), which is what `CrashRecovery.isAlive` (`src/daemon/recovery.ts:341`) and `HiveDaemon` (`server.ts:1315`, `1848`, `1945`, `5854`) consume: **the live agent is classified gone and becomes eligible for respawn/mark-dead.**

I want to be precise about likelihood: providers whose subprocesses inherit their pgid (Node `child_process` without `detached`) do *not* trip this, which is why it has not been observed. But it is a correctness gap, not a theoretical one, and it fails closed only for C1's write — it fails *open* for recovery.

### 1c. PID recycling can fabricate a death

L526: `startToken = this.processIdentity(foregroundProcessGroupId).startToken`. This reads the identity of the process whose pid equals the pgid — the group leader. If the leader exits while the group persists and the OS recycles that pid, the start token differs, and L545 permanently kills a live run.

### Concrete fix (one change, closes all three)

Make identity drift **non-destructive**. End a run only on measured death of *the run's own* process:

```ts
// projectForeground, replacing the endProviderRun calls at L508 and L545:
// Foreground position is not death evidence. Only the run's own process is.
const runIsDead = (run: ProviderRun): boolean => {
  try {
    return this.processIdentity(run.pid).startToken !== run.startToken;
  } catch {
    return true; // the pid is gone
  }
};
```

Then: `shell-idle` and identity-mismatch both return their state **without touching the store**, and a single guarded `if (active !== null && runIsDead(active)) endProviderRun(active.runId, ..., "provider-process-exited")` handles the only case that is actually death. A suspended provider stays `running` (correct — §14 item 5), a pager in the foreground reports `unmanaged` *for the current foreground* while the run stays `running` (correct — the agent is alive), and a genuinely exited provider is ended.

Note this also makes `unmanaged` mean what §3 says it means — *"a manually launched foreground command"* — rather than doubling as an obituary.

---

## 2. `inspect()` and `list()` write to the database — a read mutates lifecycle state

**`src/daemon/session-host/hive-terminal-host.ts:498-556` reached from `inspect()` (L340) and `list()` (L272)**

`projectForeground` issues `endProviderRun` writes. It is called from `projectInspection`, which is called from **both** `inspect()` and `list()`. `list()` (`server.ts:1836-1852`, the fleet fault sweep) projects *every* binding, so one health listing can terminally close provider runs across the entire fleet.

Three consequences:

- **Run lifecycle is polling-driven.** If nothing inspects, no run is ever ended. `terminal-host-v1.md` §4 states process exit, reap, and output closure are *separate ordered events* — the host already offers exit as an ordered event, and C0 chose to infer it from polls instead.
- **`insertProviderRun` depends on the write-on-read.** `createSession` (`spawner-impl.ts:1336-1363`) can only insert because the immediately preceding `inspect()` cleared any prior active run via the partial unique index's guard. Remove the side effect and `insertProviderRun` starts throwing a raw SQLite `UNIQUE` error. That coupling is invisible and undocumented.
- **C1 is the direct victim.** C1's atomic `writeAutomated` must read foreground identity to decide whether to write. With this design, *the check itself mutates the thing being checked*, and observation is supposed to be inert (§2 invariant 5).

**Concrete fix:** finding 1's rewrite removes both `endProviderRun` calls from the drift paths. Keep exactly one `endProviderRun` in `projectForeground` — the measured-death case — or, cleaner, hoist even that into an explicit `reconcileProviderRun(locator)` the daemon calls on its existing lifecycle tick, and make `projectForeground` pure. `terminate()`'s explicit ending at L373-383 is fine and should stay; that is a caller-initiated lifecycle event, not a read.

---

## 3. The only code that mints a run ID is untested and races login-shell startup

**`src/daemon/spawner-impl.ts:1336-1363`**

```ts
const created = await this.requireSessiondHost(record).create(...);
const inspection = await this.requireSessiondHost(record).inspect(created.locator);
const foreground = inspection.foreground;
if (foreground.state !== "unmanaged") {
  throw new Error(`Provider launch for ${record.name} has no new foreground process identity`);
}
```

`SessiondHost.create` (`src/daemon/session-host/sessiond-host.ts:758-805`) returns as soon as the broker's create transaction completes — the host is launched and `/bin/zsh` is exec-verified. It does **not** wait for the provider. The shell then runs `SHELL_BOOTSTRAP` (`shell-session.ts:3-13`): a login+interactive zsh sources the user's startup files, writes history, and only then `eval "$hive_terminal_command"` forks the provider into a new foreground group. That is tens-to-hundreds of milliseconds. The `inspect()` on the next line is a single IPC round-trip.

So at that instant the foreground group is overwhelmingly likely to still be zsh's own → `shell-idle` → **the spawn throws.** The guard also throws on `unknown`, which `projectForeground` returns for any transient `jobControl.completeness !== "complete"` (L521) or any `processIdentity` failure (L528).

Corroborating evidence that this window is real: the very next lines call `monitorReadiness` / `monitorControlReadiness` (`spawner-impl.ts:1776`, `2865`), which exist precisely because launch is asynchronous. The new inspect was placed *before* that wait.

I could not observe a live spawn to confirm the failure, and I am flagging that honestly. But two things are certain regardless of timing:

1. **No test covers this code path.** `provider-run-identity.test.ts` never constructs a `HiveSpawner`; every foreground value in it is a hand-written stub. §2 invariant 2 — *"every provider launch creates a new provider-run ID"* — has zero test coverage on the launch path (see finding 7).
2. **A post-create failure leaks the session.** Before this commit, `createSession` could not fail after `create()` returned. Now `inspect()`, the guard throw, and `insertProviderRun` all sit downstream of a successful `create()`, with no cleanup. Every failure there strands a live zsh, a published visibility lease, and a visible terminal pane.

**Concrete fix:**

```ts
const created = await this.requireSessiondHost(record).create(...);
try {
  const foreground = await this.awaitProviderForeground(created.locator); // bounded poll
  this.dependencies.db.insertProviderRun({ ...built from foreground });
} catch (error) {
  await this.requireSessiondHost(record).terminate(created.locator, {
    mode: "immediate", reason: "provider run identity unavailable", requestId: ...,
  });
  throw error;
}
```

where `awaitProviderForeground` polls `inspect()` until `state === "unmanaged"` under the same deadline `monitorReadiness` already uses, treating `shell-idle` and `unknown` as *not yet* rather than *failed*. Smaller alternative worth considering: fold the mint into `monitorReadiness`, which is already polling, and delete the separate inspect entirely.

---

## 4. The root/queen exclusion is correct for C0 but leaves C1 with no safe option

**Assessment requested. I verified all five of the author's claims independently and they hold:**

| Claim | Verified how |
|---|---|
| Root foreground classifies `unmanaged` | `orchestrator-sessiond.ts:250-274` never calls `insertProviderRun`; `getActiveProviderRunByTerminal` returns null for the root locator; `projectForeground` L537-556 therefore falls through to `unmanaged`. |
| Cannot satisfy an agent locator | `requireSessiondAgentLocator` (`hive-terminal-host.ts:75-88`) requires `subject.kind === "agent"`. Asserted at `provider-run-identity.test.ts:220-225`. |
| Not adoptable | `insertProviderRun` has exactly one production caller (`spawner-impl.ts:1363`), inside `createSession`. No inspection path constructs a run. Confirmed by search. |
| Not agent-authoritative | `sessiondAgentProviderRunIsDead(unmanaged) === true` (L60-68); asserted at `provider-run-identity.test.ts:227`. |
| Live foreground job, not a reap target | `server.ts:1801-1806` uses `sessiondForegroundJobIsDead`, which is `false` for `unmanaged`. Reap tree at `server.ts:2386-2391` still watches root's `shellRoot.pid`. |

**I agree with the exclusion for C0.** The launch contract genuinely carries no `agentId`/`model`/`effort`, and inventing them would be exactly the speculative record §1 forbids.

**But it is an unsafe gap that happens to work today, and C1 collides with it head-on.** §2 invariant 3: *"Automated message text is never submitted to bare zsh. Foreground identity is checked atomically with the terminal write."* C1's `writeAutomated` will gate on `foreground.state === "managed"`. The queen can **never** be `managed`. That leaves two doors, and both are wrong:

- Refuse writes when not `managed` → **the queen becomes unwritable**, and Hive cannot deliver to its own orchestrator.
- Accept `unmanaged` for root subjects → **invariant 3 is violated by construction**, because `unmanaged` is precisely §3's *"manually launched foreground command"*. A user who types `vim` in the queen's terminal becomes a write target.

**Concrete fix, and it is small:** mint a `ProviderRun` for the root launch with the fields the contract actually carries. Relax three fields in `src/schemas/provider-run.ts` — `agentId: z.string().min(1).nullable()`, `model: z.string().min(1).nullable()` (`effort` is already nullable) — and insert at `orchestrator-sessiond.ts` after the same bounded foreground wait finding 3 introduces. `provider`, `terminal`, `pid`, `startToken`, `foregroundProcessGroupId`, `launchGrantId` (= `input.requestId`), `capabilityEpoch` (= 0) are all already present in `sessionSpec`. That is strictly less code than a root special-case in the C1 write path, and it makes invariant 3 uniform.

This one is only a *must fix before C1* because C1 forces the choice. It is not a C0 defect.

---

# WORTH DOING LATER

## 5. `ProviderRunStore` is optional, so every provider-run behavior silently no-ops when unwired

**`src/daemon/session-host/hive-terminal-host.ts:117-131, 209`; `?.` at L375, 377, 501, 505, 524, 551**

`providerRuns?: ProviderRunStore` is optional and guarded by six optional-chains and two `?? null`s. Nine of ten `HiveTerminalHostAdapter` construction sites omit it; only `server.ts:959` supplies it.

Test against §1's rule: it closes no race (it *opens* one — an adapter built without a store reports every live provider as `unmanaged`, which finding 1's chain converts into "agent dead"), preserves no evidence, creates no boundary. The *interface* is genuinely earned — the adapter must not see all of `HiveDatabase` — but the **optionality** is not. It is defensive code for a state that should be impossible.

**Concrete fix:** make it required. `constructor(host, bindings, instanceSuffix, providerRuns: ProviderRunStore, options: {...} = {})`, delete all six `?.` and both `?? null`, and pass `db` at the nine test sites (they already have a `HiveDatabase` in scope, or can pass a two-method literal). The type system then guarantees what six `?.` currently only hope for.

## 6. `pid` and `foregroundProcessGroupId` are provably always equal — two fields, one value

**`src/daemon/session-host/hive-terminal-host.ts:530-534`; `src/schemas/provider-run.ts:15,17`**

```ts
const measured = {
  pid: foregroundProcessGroupId,
  startToken,
  foregroundProcessGroupId,
};
```

This is the **only** producer of a `ProviderRun`'s `pid` (via `createSession`) and the only thing compared against it (L541-543). `pid` is therefore, at every write and every read in the codebase, a duplicate of `foregroundProcessGroupId`. §3 lists both, but §3 lists them because they are *conceptually* different — the provider process versus the group it leads — and the implementation collapses them without saying so.

It also encodes an unstated assumption: that the group leader's pid is the provider's pid, and that the leader outlives the group. Finding 1c is the failure mode.

**Concrete fix, pick one:**
- Measure the real thing: take the provider pid from the shell's child (sessiond already reports `descendants`), keep both fields, and compare `pid`+`startToken` for liveness and `foregroundProcessGroupId` for foreground position. This is what makes finding 1's `runIsDead` robust.
- Or collapse: drop `pid` from `ProviderRun` and `SessionForegroundSchema`, keep `foregroundProcessGroupId` + `startToken`, and note the deviation from §3 in the design doc.

Do **not** leave it as-is with two names for one number — that is the shape that makes finding 1c invisible.

## 7. Test honesty — the 5× provider loop is one stub replayed, and the launch invariant is untested

I checked every new test against the invariant it names.

**Genuinely good, keep as-is:**
- `db.test.ts:95-111` — `endProviderRun` idempotency (`toEqual(exited)` on the second call with a *different* reason). This is a real invariant, correctly asserted, and would fail if broken.
- `provider-run-identity.test.ts:216-243` — the managed→shell-idle transition with the `exitReason` and `state` assertions. Would fail if `projectForeground` stopped ending runs. (Which is awkward, because finding 1 says it *should* stop for the suspend case — this test will need to change, and that is correct.)
- `provider-run-identity.test.ts:270` — `test.todo("grok live launch: pending until its quota pool resets at 2026-07-26T17:18Z")`. **This is honest.** Bun reports it in a separate `1 todo` line, not as a pass; I verified in the run output. It does not read as covered. No finding.

**Tautological — would pass no matter what the implementation did:**

- **`provider-run-identity.test.ts:141`** — `expect(getAgentAdapter(provider).id).toBe(provider)`. This asserts the adapter registry maps a key to itself. It has nothing to do with provider-run identity. It is the *only* provider-dependent statement in the loop.
- **`db.test.ts:119`** — `expect(db.insertProviderRun(next).runId).not.toBe(run.runId)`. `next` is built with a literal different `runId` two lines above. This asserts that `insertProviderRun` returns its argument. §2 invariant 2 is about the **launch path** minting a fresh ID; this test cannot observe that path.
- **`db.test.ts:117`** — `conversationId: run.conversationId` inside a spread of `run` is a no-op, and no assertion follows it. The line reads as "same conversation, new run" but proves nothing.

**The 5× multiplier is inflation.** `provider-run-identity.test.ts:139-268` loops `CAPABILITY_PROVIDERS` and produces five tests whose only per-provider variation is the tautology at L141 and `model: \`${provider}-model\`` (never read). The neutral inspection, the pgids, the `processIdentity` stub, and every assertion are identical. §14 item 1 says *"Run each of the five providers under zsh; exit the provider."* **No provider is run.** Five identical stub tests should not be presented as five-provider coverage; one parameterless test plus a `test.todo` per un-run provider would be honest.

**Cases the suite would miss — I constructed these:**

1. **Two running runs on one terminal.** The partial unique index `provider_runs_one_active_terminal` (`db.ts:553-556`) is the *only* structural enforcement of "one active run per terminal" and **nothing tests it.** `db.test.ts` inserts the second run only after ending the first. A test that inserts two `running` runs for one terminal and expects a throw is three lines and covers the invariant.
2. **Suspend/resume.** Finding 1a. Set `foregroundProcessGroupId` to the shell root, then back to the run's pgid, and assert the run is still `running`. Today this fails — correctly, because the implementation is wrong.
3. **Launch minting.** Finding 3. Nothing constructs a `HiveSpawner` and checks that `createSession` inserts a run, that a second launch in the same terminal mints a *different* `runId`, or that a resumed conversation (`toolSessionId` set) still mints a fresh one. Invariant 2 is asserted nowhere on the path it describes.
4. **Adapter without a store.** Finding 5. No test asserts what happens when `providerRuns` is undefined — nine test sites *rely* on it and none names it.

## 8. `endProviderRun` does three round-trips and two schema parses to return a value nobody uses

**`src/daemon/db.ts:1371-1395`**

Inside a transaction: `getProviderRun` (SELECT + `JSON.parse` + Zod parse), `ProviderRunSchema.parse` of the constructed exited record, `UPDATE`, then `getProviderRun` **again** (SELECT + `JSON.parse` + Zod parse) to return a record it just constructed and validated. All five production call sites discard the return value; only `db.test.ts` reads it.

This is the "too clever, a plainer version is equally correct and easier to verify" case.

**Concrete fix:**

```ts
endProviderRun(runId: string, endedAt: string, exitReason: string): void {
  this.transaction(() => {
    const current = this.getProviderRun(runId);
    if (current === null || current.state === "exited") return;
    const exited = ProviderRunSchema.parse({ ...current, state: "exited", endedAt, exitReason });
    this.database
      .query("UPDATE provider_runs SET state = 'exited', recordJson = ? WHERE runId = ? AND state = 'running'")
      .run(JSON.stringify(exited), runId);
  });
}
```

Keep the idempotency test by asserting `getProviderRun` after a second call. Same for `insertProviderRun`'s return value (`db.ts:1315`) — both callers ignore it.

## 9. `listProviderRunsForAgent` and its index have no production reader

**`src/daemon/db.ts:1360-1369`; index `provider_runs_agent` at `db.ts:557-558`**

Zero production callers. One test (`db.test.ts:120`) asserts `toHaveLength(2)`. §1's rule: closes no race, preserves no evidence *that anything reads*, creates no boundary. It is built for C5's handoff, which does not exist.

**Concrete fix:** delete the method and the index; re-add in C5 when a caller exists. `agentId` stays as a column (it *is* §3-mandated evidence) — only the query and the index are speculative.

## 10. `exitReason` is an open string with exactly four producers

**`src/schemas/provider-run.ts:30`** — `exitReason: z.string().min(1).nullable()`

Producers: `"terminal-reaped"`, `"terminal-terminated"` (`hive-terminal-host.ts:380`), `"terminal-exited"` (L505), `"foreground-provider-exited"` (L509, L552). A typo in any of them validates fine and lands in the audit record. `db.test.ts:108` already passes `"later-observation"`, a fifth value that exists only in a test.

**Concrete fix:** `z.enum(["terminal-reaped", "terminal-terminated", "terminal-exited", "foreground-provider-exited"])`. Free, and it will catch the rename finding 1 requires.

## 11. The Zig create payload hardcodes `foreground: {state:"unknown"}` — a wire field that can never be true

**`native/sessiond/src/host_record.zig:230-234`**

```zig
var foreground = std.json.ObjectMap.init(a);
try foreground.put("state", .{ .string = "unknown" });
try foreground.put("runId", .null);
try inspection.put("foreground", .{ .object = foreground });
```

sessiond has no notion of a Hive run ID, so it can never emit anything but `unknown` — and it has no need to, because `HiveTerminalHostAdapter.create` (L238-244) reads only `shellRoot`, `executableVerified`, and `visibility` from the create payload, and the foreground is recomputed by the adapter's own `inspect()`. Meanwhile the Swift fixture corpus (`workspace/Tests/WorkspaceCoreTests/Fixtures/session-protocol-corpus.json`, `.schema.json`) now teaches downstream consumers that the create payload carries a foreground state. It carries a constant.

Test against §1: closes no race, preserves no evidence, creates no boundary. It exists only to satisfy a schema that should not have demanded it.

**Concrete fix:** make `foreground` absent from the create payload rather than constant. `CreateResult.inspection` and `SessionInspection` are the same schema today — split `foreground` out of what create returns (`.omit({ foreground: true })` on the create-payload schema), delete the six Zig lines, and drop `foreground` from the create fixtures. If a future consumer needs foreground at create time, sessiond can compute a genuine `shell-idle`/`unmanaged` from `process_inspector`'s foreground pgid — but not until something reads it.

## 12. `provider_runs` keys the terminal without the locator's `subject`

**`src/daemon/db.ts:546-556`, `1343-1358`**

The table stores `terminalInstanceId`, `terminalSessionId`, `terminalGeneration` — but not `subject`. `SessionLocator` carries `subject: {kind:"agent", agentId} | {kind:"root"}`, and the uniqueness of the active-run lookup therefore rests entirely on `sessionId` being globally unique across agent and root subjects.

That holds today (`ses_<uuid>` is minted per session), so this is not a live bug. But it is the one place where a root terminal could adopt an agent's run — the exact thing finding 4's verification depends on *not* being possible — and it depends on an invariant enforced nowhere near this table.

**Concrete fix:** add `terminalSubjectKind TEXT NOT NULL` and `terminalAgentId TEXT` to the table and the unique index, and match on them in `getActiveProviderRunByTerminal`. Two columns; makes the root-non-adoptability property structural instead of incidental.

## 13. Rename straggler: `spawnedProvider` in the live-create test

**`native/sessiond/test/ts-live-create.ts:217, 440, 443-450, 676-684, 715-743`**

`sessiondInspection.providerRoot` → `.shellRoot` was renamed, but the local it is assigned to is still `let spawnedProvider`. It now holds the **shell** root, and L443-450 assert things about "the provider" that are true of zsh. Cosmetic, but it is the one place the old mental model survives in a live test, and §3's whole point is that the two are different lifecycles. Rename to `spawnedShellRoot`.

**Everything else in the rename is complete.** I searched TypeScript, Zig, Swift workspace fixtures, JSON corpora, schemas, scripts, and comments: the only remaining `providerRoot` occurrence in the tree is `docs/design/hive-communication.html:144`, which is the sentence *describing* the rename and is correct there. The `"vendor process is confirmed dead"` strings at `server.ts:1805` and `server.ts:1850` are user-facing prose and now, post-change, accurately describe the provider rather than the shell.

---

# Categories where I found nothing

Stating these plainly rather than padding.

**Fresh reads of foreground identity — clean.** `projectForeground` recomputes from a live `NeutralSessionInspection` on every `inspect()` and every `list()` entry, and re-queries `getActiveProviderRunByTerminal` each time. There is no memoization, no cached `SessionInspection`, and no stored foreground on the binding. `HiveTerminalCreateEvidenceSchema` (`terminal-host-binding.ts:11-20`) stores `verifiedShellRoot` but deliberately not foreground. **C1's re-readability precondition holds.** The hazard for C1 is not staleness, it is finding 2 (the read writes).

**Fresh run IDs on every launch — clean on the paths that mint.** `createSession` is the single minting site; `crypto.randomUUID()` at `spawner-impl.ts:1341` is unconditional. All three callers route through it: normal spawn (`spawner-impl.ts:2848`), control launch (`spawner-impl.ts:1769`), and `createRecoverySession` (`spawner-impl.ts:1372`, which is a bare delegation). Resumed conversations pass `toolSessionId` into `conversationId` and still mint a fresh `runId` — §3's ConversationBinding and ProviderRunBinding are correctly separated. No reuse path exists, in recovery or control. The gap is coverage (finding 7.3), not logic.

**`shell-idle` vs `lost`/`unknown` — correctly distinguished.** `sessiondTerminalIsDead` (L36-43) keys only on `presence` and `SESSIOND_EXECUTABLE_EVIDENCE_STALE`; `sessiondForegroundJobIsDead` adds `shell-idle`; `sessiondAgentProviderRunIsDead` adds `unmanaged`. The three layers map to three genuinely different questions and each has real call sites. Abnormal death is handled: a provider killed by signal leaves zsh reclaiming the foreground → `shell-idle`, not `lost`; `lost`/`exited` remain terminal-level facts. `unknown` is returned — and, correctly, **no run is ended** — when job control is incomplete (L521) or `processIdentity` throws (L528), which is the right conservative default. This part of the design is well done.

**`unmanaged` grants no authority — verified through every indirect path I could find.** Agent locator lookup: blocked by `requireSessiondAgentLocator`'s subject check. Adoption: no inspection path calls `insertProviderRun`. Liveness: `sessiondAgentProviderRunIsDead` returns `true`. Reap: `sessiondForegroundJobIsDead` returns `false`, so the tree stays watched rather than reaped. `foreground.runId` is `null` on the `unmanaged` arm and — I checked — has **zero production readers** anywhere, so no code can accidentally treat it as a run handle. Clean.

**Repo neutrality — clean.** No repo-name check, no hardcoded path, no assumption that the worktree is Hive's own tree, nothing user-specific anywhere in the diff. `/bin/zsh` (`TERMINAL_SHELL`) and `macProcessIdentity` are platform assumptions, pre-existing and §3-mandated, not repo assumptions. One trivial note, not a finding: `test/daemon/db.test.ts:73` and the Swift corpus use the literal `"gpt-5-codex"` as a fixture model. That is a realistic value in a test fixture, which is appropriate; it is not configuration leaking into code.

**Over-engineering in `ProviderRun`'s field set — I looked hard and did not find it.** I checked every field for production readers and several have none today (`model`, `effort`, `conversationId`, `capabilityEpoch`, `launchGrantId`). I am *not* reporting them, because §3 names each one as what the binding proves ("Provider, model, effort, process identity, and capability epoch for one execution") and §1's rule admits "preserves recovery evidence" — which is exactly what a launch-time snapshot of mutable `AgentRecord` state is. `capabilityEpoch` additionally serves §5's hook-matching rule in C2. Reporting these would be manufacturing findings. The `ProviderRunBindingSchema`/`ProviderRunSchema` split likewise mirrors §3-plus-§4 exactly. The one genuinely unused artifact is the exported `type ProviderRunBinding` (`provider-run.ts:24`), which has zero references — too trivial to rank, mentioned only for completeness.

**`processIdentity` injection — earned.** One production implementation, but tests cannot fabricate real pids and start tokens. This is the legitimate case for a seam.

**`create()`'s new `expectedExecutable !== TERMINAL_SHELL` guard (`hive-terminal-host.ts:222-224`) — earned, with a nit.** All four callers construct the spec via `shellSessionLaunch`, so it is arguably defending an impossible state — but it is the assertion that makes `shellRoot` mean "zsh" rather than "whatever was launched", which is §3's central claim, and it is the reason the fixtures moved from `/bin/sh` to `/bin/zsh`. Keep it. The nit: it throws `TerminalHostBindingMismatchError`, which describes a locator/binding mismatch, not an executable mismatch. A distinct error type would make the failure diagnosable.

---

# Review of `2a1faffd` (design-doc corrections)

Checked for internal contradiction against sections it did **not** touch. **I found none.** All five edits tighten in the same direction and are consistent with the untouched §3, §4, §5 source-authority ordering, §13, and the C0/C1/C2 exit conditions:

- Invariant 7 gaining "untrusted" and "cannot reduce provider capability" is consistent with §10's untouched fallback column ("Terminal output and process state") and with §12's degradation rule.
- The §5 transcript-authority tightening ("bound to the exact provider run/executor **and** conversation") is the *reason* §3's three-lifecycle split exists and the reason `ProviderRun.conversationId` is separate from `runId`. It strengthens §3 rather than contradicting it.
- The new §5 projection rule ("Shared conversation, worktree, or session identity proves location, not causation") is consistent with the untouched §5 line "A hook updates activity only when its run ID, provider session when present, and capability epoch match the active ProviderRun" — same principle, stated for the observation path.
- The Kimi kickoff rewrite now routes first-turn delivery through "the same atomic terminal path used for later messages, bound to the exact foreground ProviderRun." This aligns C1's kickoff with §13's C1 row and §2 invariant 3, and it is what makes finding 4 (the queen has no ProviderRun) load-bearing rather than academic. The §10 Kimi row and §14 Kimi item were updated in lockstep; I checked and no untouched section still claims a Kimi web POST path.
- The Grok row/§14 item now scope Hive's writes to `.grok/hooks/*.json` and forbid touching `trusted_folders.toml`, matching invariant 7's new user-owned-trust clause and the `vendor-gates-belong-to-the-user` memory. The "Keep hook firing explicitly pending until verified by a live turn" instruction is honored by the `test.todo` in the C0 suite.

One observation, not a defect: §14's Grok and Kimi items are now the only acceptance items that carry an explicit *pending* qualifier. That is honest and should be preserved verbatim when C2 lands — the temptation will be to drop it once the quota resets and something green appears.

---

## Suggested order of application

1. Finding 1 (death by measured process exit, not foreground position) — largest correctness win, unblocks C4, and is a prerequisite for finding 2.
2. Finding 2 (make `projectForeground` pure) — falls out of 1; C1 depends on it.
3. Finding 3 (bounded wait + terminate-on-failure in `createSession`) — C1's kickoff runs through this path.
4. Finding 4 (root ProviderRun with nullable `agentId`/`model`) — decide before C1's `writeAutomated` gate is written, not after.
5. Finding 7's missing tests (unique index, suspend/resume, launch minting, storeless adapter) — write these *with* 1–4, since 1 and 2 change what the existing transition tests should assert.
6. Findings 5, 6, 8–13 — mechanical, independent, low risk.

# Session 2026-07-11: what Hive got wrong, and what it now knows

Twenty-one commits landed on 2026-07-11, and **none of them are running.** That is the first thing to fix and the reason this document opens with it rather than with the work.

What the day was actually about: a user complained about two small things — a nag telling him to run `hive init --refresh`, and `hive update` downloading a binary with no visible progress ("user trust is important"). Chasing those two complaints surfaced twelve bugs, and every one of them was the same bug.

**Hive already held the correct answer and joined it to the wrong conclusion.** Not one was a missing capability. Not one was a measurement Hive could not take. Every measurement was already correct, already arriving, already in memory — and was then discarded, overridden by a guess, clamped by an invented constant, or stamped with a label it had not earned. Every one of the twelve passed its tests. The suite is green at **1029 pass / 11 skip / 0 fail** across 72 files (`bun test`), and it was green while all twelve were live. **A green suite is not evidence of health, and this session is the proof.**

This document carries the evidence, not just the conclusions — measured numbers, `file:line`, commit hashes, raw provider field names, citations. A conclusion without its evidence gets re-litigated at full token price. That is the whole reason it exists.

## Read this first: nothing that landed today is live

The running daemon is the **old 0.0.8 binary**. Verified at the time of writing:

```
PID 6125   Sat Jul 11 09:21:20 2026   /Users/scottkellar/.local/share/hive/versions/0.0.8/hive daemon
```

The daemon started at **09:21:20**. The first fix landed at **10:13:37** (`856ec11`). Every commit below postdates the process serving them, so **every number `hive status` currently prints is still `tokens / 200_000`**, and every fix is inert on this machine.

Two independent proofs, because this is load-bearing enough to deserve them:

- **Arithmetic on a live reading.** While writing this, `hive_status` reported `chloe` at `contextPct: 47`. My transcript at that moment held ~94,000 tokens. 94,000 ÷ 200,000 = 47%. The old denominator, still dividing.
- **The orchestrator's own system prompt.** `ps` shows the running orchestrator (PID 6159) was launched with the *pre-fix* brief text: `reuse it when its status is live and its contextPct is under 65`. The current source (`src/cli/orchestrator-brief.ts:3`) says `is a number under 65` and adds the whole null-handling paragraph from `6fd526a`. The live fleet is running against a brief that no longer exists in the repo.

**First action next session: rebuild and restart the daemon.** Until then, nothing described here is true of the running system.

## This document was written by a fresh agent, and verification changed it

The orchestrator that ran this session is at very deep context. Per the research below, a deep agent's self-report is the least trustworthy artifact it owns, so this document was written by a fresh agent who treated the incoming account as a set of claims and checked each against the repo. Four things did not survive:

1. **The review's first HIGH defect is a false positive.** `reconcileInjected` was reported as "defined and never called — the twelfth instance of the disease, committed by the agent diagnosing it." It is called, at `src/daemon/server.ts:701`, on the 30-second reconciliation timer. The method and its caller were added by the *same commit*, `f5ab08a`; `git show f5ab08a^:src/daemon/delivery.ts | grep -c reconcileInjected` returns 0, so it never existed in a state without a caller. There is **one** real HIGH defect, not two.
2. **The never-fired count is three, not four** — and a fourth, genuinely uncalled, turned up somewhere else (`poolsGoverning`, below).
3. **SPEC §7 was already rewritten** in `73bebe7`, which makes the research doc's closing "recommendation only — not making this change" section stale and self-contradictory at HEAD. Fixed in the same commit as this document.
4. **The fleet is deeper than reported**, because it kept working after it was measured. Re-measured numbers below.

Read the rest of this document the same way: verify against the worktree before you act. Over-trusting a predecessor is a measured failure mode ([Handoff Debt, arXiv 2606.02875](https://arxiv.org/abs/2606.02875)), and this section is what that warning looks like when it is taken seriously.

## The twelve

Each entry: what Hive **measured correctly**, what it **concluded**, the **mechanism**, the **fix**, and **how it was found** — the finding method is the reusable part.

**1. A 99%-exhausted pool that gated nothing.** Measured: `weekly:Fable` at 99% used, provider-sourced, fresh. Concluded: safe to launch. The pool's `models[]` was empty, so it matched nothing, and `limitFor()` returned only the *first* matching pool — a Fable spawn was checked against the general pool (39% free → yes) and its own pool (1% free) was never asked. Two deep-tier agents launched onto an exhausted model. Fixed in `dd5a6da`: `limitsFor()` now returns `[...general, ...specific]` (`src/daemon/quota.ts:508`) and the gate reserves against **every** governing pool. *Found by the user, from his own account page.*

**2. A phantom pool that pulled traffic to itself.** A per-model pool for `claude-opus-4-8` reported "usage unknown; routing unconstrained" — for a model that is metered under general subscription usage and has no meter of its own. An "unconstrained" model is the *most attractive* route, so the phantom actively attracted the traffic it could not account for. Fixed in `1b30b55`/`82bd592`. *Found by the user:* "For opus 4.8 it should be tracked under general usage — there is no direct 4.8 usage meter. I do not know where that came from."

**3. The 200K denominator.** `contextPct = tokens / 200_000` while agents ran 1M windows. Agents at ~22% displayed 78%, then clamped to a fake 100%. **The origin is a documentation bug that became a code bug:** SPEC decision 2 said "Claude's transcript is its context source." The transcript carries the **numerator** and never the **denominator** — so the code invented one, and then a comment defended it. A doc naming the wrong source of truth does not produce a doc bug; it produces a code bug and then defends it. Fixed in `856ec11` and `4ea1c21`.

**4. The model Hive thought an agent was running.** Hive recorded a model at **spawn** and never noticed the user switching models mid-session. Quota was reserved against models nobody was running. Fixed in `c4d9e86` (`src/daemon/live-model.ts`), which reconciles the reservation onto the model the session actually reports.

**5. The readiness probe that made thinking a capital offence.** The probe measured **time-to-first-tool-call** against a 15-second deadline. A high-effort model thinks before it acts, so **deep-tier Codex was reproducibly unspawnable**. The cruelty of it: `hasFreshCodexActivity()` already existed to prevent exactly this, and was *structurally incapable of firing* — its predicate was `rollout_mtime > monitorStartedAt`, and Codex writes the rollout at session start and then goes silent for the entire reasoning phase. Measured: the rollout froze at **35,730 bytes for 13 seconds**, jumping to 38,294 only at first output. What a thinking agent *does* emit is a redrawing screen — the TUI redraws at ~1Hz, and **24 of 24 consecutive one-second polls showed pane changes** through the reasoning phase. Fixed in `1cdab2a`: `src/daemon/readiness.ts` bounds **redraw silence** (`QUIET_LIMIT = 12`, justified in-comment against the measured 1Hz redraw), not reasoning time. Death is now the *conjunction* — no redraw AND no events AND no rollout.

**6. "Timed out after 30000ms," which never happened.** `hive_land` reported a timeout on **every** failing git command. `proc.killed` is true in Bun for *any* process that exits on its own, so it cannot distinguish "we killed it" from "it failed instantly." Git had explained the real failure in ~9ms and the daemon threw its stderr away. Fixed in `add0879`: `GitResult.timedOut` is set only when *we* kill it (`src/daemon/landing.ts:44`), and the refusal now says what git said.

**7. The right answer, arriving on every keystroke, unread.** Claude Code's statusline payload carries `context_window.context_window_size` — literally `200000` or `1000000`. Hive **already ran that hook** for every agent. Its parser read only `payload.rate_limits` and discarded the window. The correct denominator was arriving continuously and being dropped on the floor. Fixed in `856ec11`; `4ea1c21` then collapsed it to one parse of the payload and deleted the second transport.

**8. An estimate wearing a measurement's badge.** `statusForLimit` computed `used = max(local_estimate_ledger, provider_reading + spend_since)` and stamped the result with the **observation's** provenance. Hive's own guesses (16 rows, all `confidence: "estimated"`, summing to 12.0) outranked the provider's measured **0** and inherited the word *authoritative*. **The user caught this by checking his own Codex account.** The raw provider bytes said:

```json
"primary":   { "usedPercent": 2, "windowDurationMins": 300 },
"secondary": { "usedPercent": 0, "windowDurationMins": 10080 }
```

Hive published 12%, authoritative. Fixed in `82bd592`: a label now describes the number actually **published**, not the reading it was built from.

**9. The spawn-failure path that destroyed real work.** `failSpawn` force-removed the worktree and force-deleted the branch **unconditionally** — while `assessStrandedWork()` already existed, and the kill and close paths already called it. The spawn-failure path simply never asked. Real work was destroyed (agent `liam`). Fixed in `1cdab2a`: `failSpawn` now calls `this.assessStranded` (`src/daemon/spawner-impl.ts:1387`) and preserves the worktree when work is found.

**10. Delivery that claimed what it could not prove.** Two failures in one. About **90 messages** to the orchestrator sat in `state="injected"`, `appliedAt` NULL, never reconciled — no deadline, no sweep, no alert. And a normal tmux delivery marked itself **"applied"** — the strongest claim available, meaning *the recipient acted on it* — purely because `tmux send-keys` exited 0. Measured: the TUI queues the message and prints `Messages to be submitted after next tool call (press esc to interrupt and send immediately)`, and it sat **unsubmitted for 2m00s** while the model reasoned. **The TUI gates submission on a tool call; a reasoning agent makes none.** This is the same disease as the readiness probe, one layer up: both make *acting* the precondition for *existing*. Zoe's line for it: "measuring bytes written to a pane and reporting that a mind changed." Fixed in `f5ab08a`.

**11. A deadline that fired before the agent could see the message.** The 30-second ack deadline was anchored to `createdAt`, not `injectedAt` — one message was alarmed as having "missed its deadline" **seventeen minutes before the agent could physically see it**. And 30s was far too short regardless: measured real ack latencies were **41s, 54s, 61s, 64s, 109s**. Fixed in `f5ab08a`.

**12. One vendor's model billed to the other's meter.** A `quota_usage` row billed a Claude model's spend to the **Codex** meter: agent `oscar`, `tier=standard`, where tier routing chose `tool=codex` while the caller pinned `model=claude-opus-4-8`. The ledger accepted an impossible `(tool, model)` pair without ever asking whether it could exist. Fixed in `1b30b55`: the pair is now validated, and an impossible route is refused rather than recorded.

## "Conservative" was the bug, twice

Two of the twelve were defended **in code comments** as the safe direction to err. Both were wrong the same way: they assumed one direction of error was free, and never asked what it cost.

- The `max()` quota floor took the larger of guess and measurement "to be safe." It published a fabricated 12%, stamped authoritative, on a pool the provider measured at 0.
- The 200K context denominator was justified on the reasoning that a larger-window model would merely read "conservatively high," erring toward recycling early. It clamped healthy agents to a fake 100%, which drove the orchestrator to spawn fresh agents and re-pay full briefings all day out of a quota pool that reached 99%.

> **The rule: name what each direction of error actually costs before you call one of them safe.**

Corollaries, each earned by one of the twelve: a measurement beats an estimate. A label describes the number actually *published*, not the reading it was built from. And an honest `null` beats a confident wrong number — **a missing number stops a bad decision; a wrong one causes it.** That last one is now load-bearing in the code: `contextPct` is nullable end to end (`6fd526a`), null reads as *full, not free*, and an agent Hive cannot sense is an agent it will not reuse.

## What the research settled

Full evidence in [docs/research/context-degradation-and-agent-recycling.md](research/context-degradation-and-agent-recycling.md); SPEC §7 is now written from it (`73bebe7`). The findings that change what Hive does:

**The ~140K "quality line" had no provenance.** It entered SPEC in the initial commit and was never derived. Its most-repeated public attribution — Geoffrey Huntley of Sourcegraph, "quality degrades at 147–152K tokens" — is a **hallucinated citation**: [the actual post](https://ghuntley.com/gutter/) contains no token numbers at all. The likeliest true origin is arithmetic: 200,000 × 70% ≈ 140,000 — a *budget* observation about a 200K window, retconned into a *quality* claim. Nothing in the published literature lands at 140K.

**A percentage of the window is the wrong unit, not merely mis-tuned.** LOCA-bench ([arXiv 2602.07962](https://arxiv.org/abs/2602.07962)) inflates context while holding task difficulty fixed — the exact experiment Hive needs:

| Model (window) | 8K | 32K | 64K | 128K | 256K |
|---|---|---|---|---|---|
| Claude-4.5-Opus (200K) | 96.0 | 84.0 | 65.3 | 34.0 | 14.7 |
| Gemini-3-Flash (1,050K) | 64.0 | 40.0 | – | 21.3 | 17.3 |

**Gemini-3-Flash has a 5× larger window and degrades earlier in absolute tokens** — 40% at 32K where Opus still holds 84%. A fraction-of-window law predicts the exact opposite. A bigger window buys **no** headroom, so "recycle at N% of the window" is unsound and gets *more* dangerous as windows grow. The percentage is deleted, not re-keyed.

**The recycle signal is not a token count.** The best-evidenced predictor of an agent's next error is whether its **own previous errors** are in its context — *self-conditioning* ([arXiv 2509.09677](https://arxiv.org/html/2509.09677v1)), which model scale does not fix. Anthropic's own guidance restates it without citing it: corrected more than twice on the same issue, `/clear` and start fresh. So the triggers are **task completion** (the normal path, and free) and **repeated failure** (the quality path); an absolute per-model ceiling is a **backstop only**.

**The economics run opposite to the instinct.** Cache read costs 0.1× base input and cache write 1.25×, so **re-paying a token costs 12.5× what carrying it warm costs**, and cache reads refresh the TTL for free — a warm agent stays warm at no cost while it keeps working. A Hive cold start is **~33K tokens**, now corroborated across six agents independently (32,310 / 33,076 / 33,817 / 34,527 / 34,594 / 44,438 — measured today from the live transcripts). Net growth runs ~700 tokens/turn. Below ~200K resident a respawn needs **12+ turns** of remaining work to amortize; below ~120K, **27 turns**. Recycling early is not caution — it is a recurring tax with a correctness risk attached.

**But the economics reverse at depth.** At 472K, shedding ~412K saves ~$0.21/turn against a ~$0.81 restart, so a respawn amortizes in **roughly four turns**. At depth, recycling is *cheap*. The reason not to recycle a deep agent was never cost.

**Handoff is load-bearing for cost, not correctness.** A successor given *nothing but the worktree* still solves **46.4%** of interrupted coding tasks; with structured notes, ~51%, at 50–63% fewer tokens ([Handoff Debt](https://arxiv.org/abs/2606.02875), 181 handoff points, 2,172 takeover runs). And a **bad** summary is worse than none: 22.22% against a 26.26% no-context baseline. Constraint violation across a compaction boundary goes **0% → 38%** when the summarizer drops the constraint ([Governance Decay, arXiv 2606.22528](https://arxiv.org/abs/2606.22528)) — the model does not disobey the rule, **it never sees the rule** — and roughly **47 pinned tokens** restore full compliance. Pin constraints verbatim; never prompt a summarizer to preserve them, because summary content is measurably non-deterministic.

**Never let a deep agent author its own handoff.** If it is degraded, its self-report is the least trustworthy thing it owns. Worse, an agent that can sense an incoming kill exhibits *context anxiety* and starts cutting corners **before** it writes anything. Reconstruct the handoff from sources that cannot have degraded: the worktree (computed), the original spawn brief (written before the agent existed), and a **fresh** summarizer.

**The decision rule.** Not "is this agent degraded?" — Hive cannot answer that — but **"is this agent still better than its replacement?"** There is no quality *line*, but there is a quality **floor**: a competent fresh agent reading the same repo, at 46.4%. That is the only version of "too degraded" with a measurement behind it.

**The real diagnosis: Hive has no admission control.** The failure was never a missing threshold. Work kept flowing to agents that had no room for it, and nothing stopped it. Fix the admission side and retirement mostly takes care of itself, because agents that are never overloaded retire at task end for free.

**And green tests prove nothing about quality.** SlopCodeBench ([arXiv 2603.24755](https://www.emergentmind.com/papers/2603.24755), with Anthropic co-authors): verbosity increased in **89.8%** of long trajectories and structural erosion in **80%**, and quality degrades "regardless of pass-rate performance." Hive's landing gate checks tests and types. It cannot see this.

## What Hive's own agents are carrying

Measured today by summing the last assistant `usage` entry in each live transcript — not by inverting a reported percentage. Re-measured independently while writing this document, which is why they exceed the numbers in the research doc: **the fleet kept working after it was measured.**

| Agent | Resident tokens | Turns | First turn | Daemon reports |
|---|---|---|---|---|
| zoe | **472,090** | 632 | 33,817 | 100% |
| lena | **460,433** | 643 | 34,527 | 100% |
| emma | **387,984** | 468 | 34,594 | 100% |
| omar | **375,479** | 499 | 44,438 | 100% |
| mia | **235,376** | 239 | 33,076 | 100% |
| lucas (codex) | — | — | — | **0%** |

**The 1M window is proven by existence, not by trusting a denominator.** zoe's largest single request carried **470,699 `cache_read_input_tokens` in one API call, and the API served it.** That is impossible against a 200K window. No denominator needs to be assumed; the request either fits or it does not, and it fit. Proof by existence beats proof by denominator — and reaching for the denominator first is exactly the mistake that produced bug #3.

The four 100% readings are the clamp (472,090 ÷ 200,000 → clamped), and lucas's **0%** is the other half of the same lie: an unobservable Codex agent reported as *empty* rather than *unknown*. Both are the 0.0.8 daemon still running. `6fd526a` makes null a first-class value; it is not live yet.

## The experiment that would have told us — and why it failed

The user directed a cross-vendor quality experiment: agent `lucas` (Codex, fresh context) scoring the day's 19 commits **blind** on verbosity, structural erosion, constraint adherence, and self-consistency, to be correlated afterwards against author context depth, which the orchestrator withheld.

**It was contaminated, and lucas disclosed it himself, unprompted.** While diagnosing why his worktree showed only five commits, `git log --all` exposed branch refs containing agent names. He did not inspect author metadata and says he did not use it — but he flagged it rather than let a conclusion rest on a compromised measurement. The orchestrator discarded the quality experiment. That was the right call, and lucas's disclosure is the single most creditable act of the day.

**So we have no data point on whether Hive's own agents degrade with depth.** Say it plainly: we do not know.

There is also a **confound that would have muddied it anyway**: the lowest-scoring commits were also the **largest**, so commit size and author context depth were not separable in that design.

To run it properly: the reviewer must be **structurally unable** to see a branch name or an author. Review a **squashed, anonymised diff in a scratch repo with no refs**, and control for diff size — either match commit sizes across depth buckets, or score per-hunk rather than per-commit.

## The cross-vendor review: what held, what did not

Five Claude agents and a green suite of over a thousand tests produced this code. A fresh Codex agent then reviewed it cold. That is worth doing again — but the results below are also a lesson in verifying the reviewer.

**Not a defect — the first HIGH did not survive verification.** `reconcileInjected` was reported as defined and never called. It is called at `src/daemon/server.ts:701`, inside the 30-second reconciliation timer, and `f5ab08a` added the method and the caller in the same commit. This was reported as "the twelfth instance of the disease, committed by the agent diagnosing it," which is a good story and did not happen. **A review finding is a claim, exactly like everything else here.**

**HIGH — real, and now fixed.** `src/daemon/quota-ledger.ts` summed spend since an observation with a strict `occurredAt > ?`. A provider reading and a spend landing in the **same millisecond** had no order between them, so the spend fell into neither the snapshot nor the "spend since" added on top of it. It failed in the **dangerous** direction: Hive under-counted and could admit a spawn past a limit the user had really hit. Equal wall-clock timestamps cannot encode ordering, and `>=` would only have moved the error. Fixed in `65cfca6` with a monotonic ledger sequence (`quota_usage_sequence`), backfilled from SQLite's `rowid` — which *is* the insertion order the sequence records.

**MEDIUM — fixed in the same commit.** The agents-table rebuild ran `PRAGMA foreign_keys = OFF` with no `try`/`finally`, so a throw inside the transaction left foreign keys unenforced for the life of the process. It now captures the prior state and restores it in a `finally` (`src/daemon/db.ts:584`). The *other* half of that finding does **not** hold: the rebuild copies `AGENT_COLUMNS.filter(c => existing.has(c))` — the intersection — so it cannot drop a column it has never heard of, and the comment claiming as much is accurate.

**MEDIUM — outstanding.** `src/daemon/readiness.ts` counts any pane change as life, so a wrapper spinner over a dead child reads as alive. Untouched by either fix commit. The redraw heartbeat is a large improvement over time-to-first-tool-call, but it is still a proxy for *something on screen moving* — the same shape of proxy, one level less wrong.

**CLEAN under adversarial scrutiny: release signing and staging.** No production activation path bypasses `ensureStaged()`; multi-key Ed25519 verification is correct; active-version corruption fails closed. This is the one area where a mistake would be a supply-chain compromise, and it held.

## The never-fired mechanisms — and a fourth, found while verifying

Three of today's bugs were "the mechanism exists and never runs," and all three are now fixed:

- `hasFreshCodexActivity` — predicate structurally impossible (`rollout_mtime > monitorStartedAt` against a rollout written once at session start). Replaced by the redraw heartbeat in `1cdab2a`.
- `reconcileAgentModel` — its guard (`report.model !== undefined && report.agent !== undefined`, `src/daemon/quota.ts:1797`) was permanently false because the handler passed neither field. It had **never once fired**. Fixed in `c4d9e86`.
- `assessStrandedWork` — existed, was called by the kill and close paths, and was never called by `failSpawn`. Fixed in `1cdab2a`.

**A fourth is live right now.** `poolsGoverning` (`src/daemon/quota.ts:531`) — the method whose docstring says it answers "how much quota does this model have left?", the question bug #1 turned on — **has no production caller.** Its only callers are `src/daemon/quota-discovery.test.ts:874` and `:886`. The gate itself is fine (it reaches `limitsFor` directly at `quota.ts:740, 1248, 1401, 1606`), so this is a dead reporting method rather than a broken gate — but it is precisely what the proposed detector is for, and it survived a five-agent review and a cross-vendor review to sit in the tree today. **It is the detector's first test case.**

## Pinned — the user's own words. Carry these verbatim; do not summarise.

> "Update and running hive update should be all inclusive — that means there are no extra steps that the user has to do. They should not need to run a follow up --init."

> "The experience I want for the users is like Claude Code or Codex. If we are downloading something they should see the progress of that download... and what we are downloading. User trust is important."

> "For opus 4.8 it should be tracked under general usage — there is no direct 4.8 usage meter. I do not know where that came from."

> "It is true that output degrades as token usage rises and hive needs to be aware of that and correctly manage this. But I don't think it is just about a hard line — it is about being intelligent and giving agents the proper amount of work to code optimally. It is not just about recycle when we hit a limit; we also want to be efficient with token usage and not needlessly waste tokens. Where if an agent needs to hand off, how can it do it efficiently and not waste tokens?"

> "For now keep going, I will release when I am ready."

**Standing prohibition: Hive must never spend one of the user's four Codex "Full reset" credits.** Surface the count in a refusal; never redeem. Confirmed structurally impossible today — no call to the consume endpoint exists anywhere in the tree.

**Decisions ratified by the user.** Adopt the SPEC §7 package in full: delete the 140K, delete the percentage framing, per-model absolute ceiling as a **backstop only**, task-completion and error-state as the real triggers, and **split the admit line from the retire line** — one number meant an agent could accept work at 64% and be killed at 66% still holding it. Adopt the compaction synthesis: SPEC's **quality** objection to `/compact` survived and now has evidence behind it, but its **cost** objection was backwards — so write the durable handoff artifact to disk first, pin constraints verbatim out of the lossy path, then compact in place, and never pay the cold-spawn toll. Leave the Fable auto-routing default alone; its cutoff fires 2026-07-12T00:00:00Z.

## Rejected alternatives

Preserved because the way a fabricated constant survives is by nobody writing down that it was fabricated.

- **The 140K quality line.** Fabricated. Hallucinated citation. Likely 200K × 70%, a budget number wearing a quality number's clothes.
- **"Conservative merge by `max()`."** Let a guess outrank a measurement and inherit its badge. Published a fabricated 12% stamped *authoritative* over a measured 0.
- **The 15s readiness deadline.** It bounded **reasoning time**, which is unbounded and unknowable. The replacement bounds **redraw silence**, which is measured.
- **"Commit `profile.toml` so repo facts travel with the clone."** Regenerating costs **56ms and zero model tokens**. The premise did not survive measurement. (`b5ce80a`)
- **Returning `null` for unknown `contextPct` without making it representable end to end.** `contextPct` was non-nullable and the server skipped nulls as "no new information," so the null **froze the previous wrong value** rather than clearing it — strictly worse than the original bug. Null had to become first-class in schema, column, sensor, and display together, or not at all. (`6fd526a`)
- **The naive ESC interrupt, without clearing the composer.** ESC restores the agent's **original prompt** into the composer, so the pasted control message concatenated onto it and Enter resubmitted the mash as **one turn**. A real corruption, caught only by measurement. The fix is `C-u` between the escape and the paste. And the interrupt itself has a measured cost: the cancelled turn is **not resumed** and its reasoning is lost — which is why `normal` must **not** interrupt, while `urgent` and `critical` must. (`f5ab08a`)

## Open questions — honestly

- **Do Hive's own agents degrade with depth?** Unknown. The experiment that would have told us was contaminated and discarded. Every degradation number in this document was measured on someone else's workload.
- **Where does Hive's curve actually break?** LOCA-bench is the closest analogue and its tasks are mock-server exploration, not code edits in a git worktree. The experiment is cheap and this repo is the ideal instrument: a fixed verifiable task with a known-good solution, run fresh and again pre-loaded with 32K/64K/128K/256K of irrelevant but plausible repo context, scoring solve rate, constraint adherence (plant an explicit "do not modify file X"), and turn count.
- **Which handoff fields carry the weight?** Nobody has ablated them, including Handoff Debt. The convergent community schema is lore that agrees with itself because it copies itself. `HandoffSchema` is as good a guess as anyone's — and it is a guess.
- **Is degradation a gradient or a cliff?** The sources genuinely disagree, and they use different units. A threshold whose correctness depends on the answer is built on sand — which is an argument for the error-state trigger, which does not care.
- **How does subscription quota actually count tokens?** Not publicly documented by either vendor. Hive's quota logic must stay measurement-only and must never back-derive a cost model from API prices.
- **Does Codex degrade on the same schedule?** Every curve cited here is for Claude, Gemini, GPT, or open models. Unmeasured for Codex in this harness.

## Next session, in order

**1. Rebuild and restart the daemon.** *(minutes)* Nothing below matters until this is done, and nothing above is true of the running system until it is. Then verify: `hive status` should report real percentages against a 1M window, deep agents should stop reading a clamped 100%, and lucas should read `—` rather than `0%`.

**2. Close out the review.** *(small)* The NO-SHIP defects landed while this document was being written — the quota-ledger sequence and the `db.ts` `finally` in `65cfca6`, the live-model source in `2beee6b`. What remains:
   - **MEDIUM:** `src/daemon/readiness.ts` — a wrapper spinner over a dead child still reads as alive. Untouched by either fix.
   - **The corrected scope matters here:** `reconcileInjected` is **not** a defect and needs no work, and the `db.ts` column-drop half of that finding does **not** hold. Do not spend an agent re-fixing either.

**3. Build admission control.** *(1 agent, one session — the highest-leverage item)* This is the real diagnosis and it needs **no recycle actuator at all**: do not hand work to an agent without room for it. `admit(agent, task) := resident_tokens + estimated_task_cost + handoff_reserve < ceiling(model)` AND no unresolved repeated failure AND cache warm. The estimate already exists — the orchestrator tiers every task (`src/schemas/quota.ts`). Ship this before anything else in the recycling design, because it is the half that prevents the problem rather than cleaning up after it.

**4. Make the research executable.** *(1–2 agents)* It is currently **inert**: SPEC §7 now describes a recycling policy Hive cannot execute. `HandoffSchema` (`src/schemas/handoff.ts`) has no producer and no consumer — its only references are `src/schemas/schemas.test.ts`. The recycle actuator does not exist. And `src/cli/orchestrator-brief.ts:3` still instructs the orchestrator to reuse an agent whose `contextPct` is "a number under 65" — **the deleted rule is still the live one.** Build the handoff artifact: computed half from the worktree; constraints pinned **verbatim** from the original spawn brief (written before the agent existed, therefore incapable of having degraded); written half authored by a **fresh** summarizer, never the incumbent.

**5. The never-fired detector.** *(1 agent)* Four mechanisms this session existed and never ran, and `poolsGoverning` (`src/daemon/quota.ts:531`) still does not — invisible to types and to a green suite. Codify: a safety-critical predicate needs a test where it **fires** and one where it does not, and CI fails if a load-bearing branch is never exercised across the suite plus one real run. Precedent: zoe hand-mutated the `tool === "claude"` guard to prove it load-bearing, and it was.

**6. Provenance types.** *(1 agent)* Make "an estimate wearing a measurement's badge" a **compile error**: a value carries its own provenance (`Measured` / `Estimated` / `Unknown`), and the label is *derived* from the value rather than asserted beside it. This also makes `Unknown` representable everywhere, killing the flattering-default class — the 0% that meant "cannot see it," the null that meant "keep the old lie."

**7. Constants must cite what measured them.** *(small)* `200_000`, `65%`, `140K`, `15s`, `30s` — every one wrong, every one inherited, none ever re-verified. `QUIET_LIMIT = 12` is the model to copy: justified in-comment against a measured 1Hz redraw. Lint: no bare numeric literal in a constants or config file without a provenance comment naming its measurement.

**8. Cross-vendor review as a release gate.** *(process)* Worth adopting — with the correction that a reviewer's findings are claims to verify, not facts to act on. The headline catch from this session's review was a false positive, and a fresh reviewer still found a real HIGH that five Claude agents and a thousand green tests missed. Both halves of that sentence are the lesson.

**9. Run the degradation experiment properly.** *(1 agent + 1 fresh reviewer)* Anonymised squashed diffs in a scratch repo with no refs, controlling for diff size. It would replace the last inherited constant in this design with a measurement of Hive's own curve — and it is the only open question here that is answerable today without building anything.

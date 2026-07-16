# Context degradation and agent recycling

Updated: 2026-07-14
Sources: Hive source tree, 2026-07-14; [SPEC decision 7](../../SPEC.md); linked research papers

## Summary

Hive used to describe agent reuse through a 65% context threshold, justified by "quality dies around ~140K tokens." Both numbers were fabricated, and the percentage was not merely mis-tuned — it was the wrong *unit*. This article records the evidence that retired them, the economics that say recycling early is a recurring tax rather than caution, and the remaining implementation gap: Hive still has no automatic recycle actuator.

## The 140K had no provenance

The figure entered SPEC in the initial commit (`bc58715`) and was never derived from anything. Its most-repeated public attribution — that an engineer at Sourcegraph measured degradation at 147,000–152,000 tokens — is a **fabricated citation**: the post it names ([ghuntley.com/gutter](https://ghuntley.com/gutter/)) makes a qualitative "one task, one context" argument and contains no token numbers at all. The figure appears to have been invented by a secondary blog and propagated.

Its likeliest true origin is arithmetic, not measurement: 200,000 × 70% ≈ 140,000 — a *budget* observation about Claude Code's 200K window, retconned into a *quality* claim.

Nothing in the published literature lands there. RULER's effective lengths are 16–64K; NoLiMa's are 2–8K; LOCA-bench's agentic decline is well underway by 32–64K; Databricks found RAG peaking and declining at 32–64K. The only figure in the neighbourhood is Fiction.liveBench's 60–120K band, which is a community leaderboard and sits *below* 140K.

`SPEC.md:204` now preserves the 140K only as a rejected alternative, "because the way a fabricated constant survives is by nobody writing down that it was fabricated."

## The units error — the finding that matters most

Re-keying the threshold to 140K absolute would have been the same mistake in a new coordinate system. The deeper problem is that **a fraction of the context window is the wrong unit.**

LOCA-bench ([arXiv 2602.07962](https://arxiv.org/abs/2602.07962), HKUST) inflates environment state to grow an agent's context *while holding task difficulty fixed* — Hive's exact experiment. Success rate against accumulated context:

| Model (window) | 8K | 32K | 64K | 96K | 128K | 256K |
|---|---|---|---|---|---|---|
| Claude-4.5-Opus (200K) | 96.0 | 84.0 | 65.3 | 45.3 | 34.0 | 14.7 |
| GPT-5.2-Medium (400K) | 72.0 | 60.0 | – | 44.0 | 38.7 | 21.3 |
| Gemini-3-Flash (1,050K) | 64.0 | 40.0 | – | 32.0 | 21.3 | 17.3 |

Read the third row against the first. **Gemini-3-Flash has a 5× larger window than Claude-4.5-Opus and degrades earlier in absolute tokens** — 40% at 32K where Opus still holds 84%. A fraction-of-window law predicts the exact opposite. NoLiMa and RULER corroborate: effective lengths cluster at absolute values largely independent of whether the advertised window was 32K, 128K, 200K, or 1M.

So: **a bigger window buys no headroom.** "Recycle at N% of the window" is unsound in both directions, and it gets *more* dangerous as windows grow. The 65% rule only ever looked defensible because 65% × 200K ≈ 130K sat near the invented 140K line. On a 1M window it means 650,000 tokens. Correcting the telemetry denominator (`856ec11`) exposed that; it did not cause it.

Related: length itself degrades reasoning even when retrieval is perfect. [arXiv 2510.05381](https://arxiv.org/abs/2510.05381) holds retrieval constant by construction — gold evidence placed immediately before the question, an attention-mask condition where the model *can only attend to relevant tokens* — and performance still falls **13.9%–85%** as input grows. Long context damages the *computation over* facts, not merely the *finding* of them. This is why needle-in-a-haystack scores are worthless here: GPT-4.1 retrieves a needle at ~100% across 1M while scoring **19%** on multi-hop reasoning above 128K.

## Self-conditioning is the real trigger

The strongest predictor of an agent's next error is not how many tokens it holds. It is whether its own previous errors are in its context.

*The Illusion of Diminishing Returns* ([arXiv 2509.09677](https://arxiv.org/html/2509.09677v1)) isolates **self-conditioning**: when a model's prior mistakes are present in its history it becomes measurably *more likely* to err next, and injected errors degrade turn-100 accuracy monotonically with the injected error rate. **Scaling the model does not fix it.** Anthropic's own Claude Code guidance restates this as folk practice without apparently knowing it is restating a paper: corrected more than twice on the same issue, `/clear` and start fresh. Two independent lines of evidence, one measured and one vendor practice, converge on the same trigger — and **neither is a token count.**

The companion finding reframes what "degraded" means. *LLMs Get Lost in Multi-Turn Conversation* ([arXiv 2505.06120](https://arxiv.org/abs/2505.06120), 200,000+ simulated conversations) measures a 39% single-turn→multi-turn drop but decomposes it: aptitude falls only ~16% while **unreliability rises ~112%**. A degraded agent is not dumber. It is *more variable*. And the mitigation designs Hive's spawn: giving the model everything **up front** recovers 95.1% of single-turn performance, while drip-feeding the same information recovers 15–20%. The information was never the problem; the drip-feed was.

**An agent that has failed twice is compromised regardless of how many tokens it holds, and an agent with a clean history is fine deeper than any folklore threshold admits.**

## The economics run opposite to the instinct

All figures are Anthropic's published API rates for Opus 4.8 (retrieved 2026-07-11), used to compare **ratios** only — converting them into subscription quota is not legitimate and is not done.

| Token class | $/MTok | vs. base input |
|---|---|---|
| Base input | $5.00 | 1.0× |
| Cache write (5 min) | $6.25 | 1.25× |
| Cache read | **$0.50** | **0.1×** |
| Output | $25.00 | — |

The whole design hangs off one identity: **cache write ÷ cache read = 12.5×.** Any token re-paid as a fresh write costs 12.5× what it costs to carry that same token, warm, for one more turn. Cache reads also refresh the TTL for free — **a warm agent stays warm at no cost as long as it keeps working.**

Two beliefs the old framing invited are false. There is **no long-context price premium** (the 2×/1.5× tier above 200K died with the Sonnet 4 `[1M]` beta; a 900K request bills at the same per-token rate as a 9K one). And **the cliff is cache warmth, not occupancy**: resuming a 300K agent whose TTL lapsed re-processes the entire prefix at write rates — 8–13× a warm turn, and *more than a fresh spawn's entire briefing*. **A cold fat agent is not a cheap agent**, and Hive has no idle timer and cannot see this at all.

Measured on Hive's own fleet: a writer agent's **cold start is ~33K tokens** (corroborated across two independent agents at 33,817 and 33,076) — the briefing a respawn re-pays before doing any work. Net growth runs 700–750 tokens/turn. A live agent's most recent turn ran **96% of input at the 0.1× cache-read rate.**

Break-even, with restart cost `R ≈ $0.81` and per-turn carry at $0.50/MTok:

> `N* = R / [ (C_old − C_new) × $0.50/MTok ]`

| Agent's context | Turns of remaining work needed to break even |
|---|---|
| 120K | **27** — recycling is a false economy |
| 200K | 12 |
| 300K | 7 |
| 650K | 3 |

**Recycling is cheap exactly when the agent is genuinely bloated, and a false economy when it is not.** Re-paying a 40K briefing costs the same as carrying that 40K warm for 12.5 turns, so a respawn that sheds only a briefing-sized slice never pays for itself.

Three mechanics that bind Hive's architecture:

- **`/compact` is cheaper than respawn.** It shares the cached prefix and rebuilds only the conversation layer; a Hive recycle kills the session and re-pays the whole briefing at write rate. SPEC rejected `/compact` on *quality* grounds, which the constraint-pinning data below fully vindicates — but that was never a *cost* argument, and the two objections separate.
- **Cache scope is per-directory.** The system prompt embeds the working directory and git branch, so **agents in different worktrees cannot share cache.** Hive runs every agent in `.hive/worktrees/*`. **N agents means N briefing writes, always.**
- **Never switch a live agent's model or effort level.** It silently invalidates the entire prefix. Route the change to a new agent.

## Constraint pinning: pin, do not prompt

*Governance Decay* ([arXiv 2606.22528](https://arxiv.org/abs/2606.22528), 1,323 episodes, 7 model families) is the highest-value, lowest-cost result in the corpus. With a constraint present in full context, violation rate is **0%**. After compaction it is 30% pooled, up to 59%. The mechanism is not disobedience:

- Constraint **survived** the summary → **0%** violation (n=90)
- Constraint **dropped** by the summarizer → **38%** violation (n=315)

The model does not break the rule. **It never sees the rule.** And compaction eats exactly the wrong thing: soft, deployment-specific policy decays **8.3× more** than hard safety norms — the tacit project constraints that exist nowhere but the conversation are precisely the ones a summarizer discards.

The fix is measured and cheap: **~47 pinned tokens, under 0.5% of context, restored 0% violations.**

You cannot get this by asking nicely. *Parallel Context Compaction* ([arXiv 2605.23296](https://arxiv.org/abs/2605.23296)) measured that summary length and retained content **fluctuate substantially run to run** and that **prompt instructions about summary volume are largely ignored**. Compaction loss is not just lossy, it is non-deterministic.

> **Pin, do not prompt.**

## Never let a deep agent author its own handoff

Cognition reports that Sonnet 4.5 models its own remaining context and takes shortcuts or leaves tasks incomplete "when it believed it was near the end of its window, **even when it had plenty of room left**" — and that it "consistently underestimates how many tokens it has left, and it's very precise about these wrong estimates." That is **context anxiety**: if an agent can perceive an approaching kill, it degrades *before* the kill, and the handoff it writes is written by an agent already cutting corners. **Do not tell an agent it is dying.**

Compounding it: a degraded agent's self-report is the *least* trustworthy artifact it owns, and a **bad summary is measurably worse than no summary** — in SWE-Context-Bench an agent-selected summary scored **22.22%**, *below* the 26.26% no-context baseline, while the correct summary scored 34.34%. Swapping *only* the summarizer moved SWE-bench Verified from 49.0% to 55.5% (CompactionRL) — 6.5 points from summarizer quality alone.

So a deep agent's handoff must be reconstructed from sources that **cannot** have degraded: the worktree (computed — `git diff --stat`, HEAD, last test exit code; it cannot hallucinate), the original spawn brief (written before the agent existed), and a **fresh** summarizer that is not self-conditioned on the incumbent's errors.

Also measured: **successors over-trust their predecessors**, adopting the predecessor's interpretation instead of verifying repo state. The incoming brief must instruct verification, not just inform.

## The right question: "is this agent still better than its replacement?"

*Handoff Debt* ([arXiv 2606.02875](https://arxiv.org/abs/2606.02875)) interrupted 75 SWE-bench Verified tasks mid-flight and resumed a successor in the same repo state under four information conditions — kill-and-respawn, measured:

| Successor receives | Solved | Prompt tokens |
|---|---|---|
| Repository only | **46.4%** | 1.63M |
| Raw trace | 52.5% | 811K |
| Summary notes | 51.4% | 602K |
| Structured notes | 50.8% | 660K |

Three things fall out. **The repo is a genuinely recoverable source of truth** — a successor given nothing but the worktree still solves 46.4%. Handoff is not load-bearing for *correctness*; it is load-bearing for **cost** (50–63% fewer tokens). **Notes match the raw transcript at a tenth of the size** — carrying the transcript buys ~1.7pp and costs 10× the prompt; SWE-Context-Bench is harsher still, where raw trajectories bought **exactly zero**.

And it gives the decision rule. The question is not "is this agent degraded?" — which Hive cannot answer — but:

> **Is this agent still better than its replacement?**

That has a number. A fresh agent with nothing but the worktree solves **46.4%**; with a good structured handoff, ~51%. Those are the replacement baselines. An incumbent is worth keeping only while it beats them. There is no quality *line* to cross, but there is a **quality floor to fall below**, and the floor is not zero — it is a competent fresh agent reading the same repo. That floor is knowable, depends on no invented threshold, and is the only version of "too degraded" with a measurement behind it.

The rule that follows:

> **Anything reconstructible from the worktree should be a pointer, not prose. Anything not reconstructible from the worktree must be carried verbatim and pinned.**

The transcript is the only source of truth for a small set: the user's actual goal and its amendments, in-conversation constraints and prohibitions, **why a path was abandoned**, what was tried and failed, and which reading of an ambiguous requirement was chosen. On failed approaches specifically, the evidence is thinner than the confidence with which everyone asserts it — Handoff Debt includes the field but never ablated it. What the evidence *does* support: **the value is in the label and the reason, not the trace.** Write "tried X, failed because Y, do not retry"; never carry the failed transcript.

## Standing prohibitions and operating rules

These are hard constraints, not guidance. The first has no other home in the corpus.

> **Hive must never spend one of the user's four Codex "Full reset" credits.** Surface the count in a refusal; never redeem. Verified 2026-07-13: still structurally impossible — no call to a consume endpoint exists anywhere in `src/`.

And the reasoning discipline that produced the rest of this article:

- **Name what each direction of error actually costs before you call one of them safe.** Assuming that "conservative" meant "recycle early" is exactly what justified hardcoding a 200K denominator, on the reasoning that a larger window would merely read "conservatively high."
- **A measurement beats an estimate; a label describes the number actually *published*, not the reading it was built from.**
- **An honest `null` beats a confident wrong number** — a missing number stops a bad decision; a wrong one causes it. This is load-bearing in the code: `contextPct` is nullable end to end, null reads as *full, not free*, and an agent Hive cannot sense is an agent it will not reuse (`src/schemas/agent.ts:117`, `src/cli/orchestrator-brief.ts:3`, SPEC.md:198–232).
- **Process or repository state never answers whether assigned work is complete.** Idle, landed, clean, reaped, killed, and recycled are activity or lifecycle facts. Only the exact holder's structured `reported_complete` followed by queen/operator `accepted` closes the durable assignment; recycling preserves the last truthful outcome.

## The cost of being wrong, in each direction

**Recycling too late** lands degraded work: forgotten constraints, contradicted decisions, early stopping — and per SlopCodeBench (verbosity up in **89.8%** of trajectories, structural erosion in **80%**), quality degrades "regardless of pass-rate performance." **The tests stay green while the code rots**, so Hive's landing gate cannot catch it.

**Recycling too early** throws away a ~96%-cache-read warm context, re-pays a ~33K cold start at full price, and — per Governance Decay — carries a real chance of dropping the very constraint keeping the work correct. Below ~200K the break-even is 12+ turns; below ~120K it is 27, so an early recycle usually never amortizes at all.

> **A too-late recycle costs one bad commit that review can catch; a too-early recycle costs quota on every agent, forever, and silently drops constraints.** Erring early is not caution. It is a recurring tax with a correctness risk attached.

## The remaining gap: the actuator does not exist

Verified against the tree on 2026-07-14, and it is a real, current gap.

**There is no recycle actuator.** No token ceiling, no recycle threshold, no kill-on-depth path exists anywhere in `src/`. `HandoffSchema` (`src/schemas/handoff.ts:3-12`) *is* now live — but not as a recycle artifact: it is produced in the `hive_escalate` path (imported at `src/daemon/server.ts:48`, parsed at `src/daemon/server.ts:3671-3680`), where an agent claims its task exceeds its model and hands queen a goal/done/remaining/decisions/failedApproaches/branch envelope. Escalation, not recycling. So "recycled too late" remains **structurally unreachable**; the single live failure mode is spawn-churn.

The orchestrator brief no longer turns the percentage into an admission threshold. It prefers a same-scope live agent when the next task fits its remaining room, keeps unobserved `contextPct` ineligible, and says explicitly that SPEC decision 7 defines no numeric threshold until an absolute-token admission actuator exists (`src/cli/orchestrator-brief.ts:3`; `src/cli/orchestrator-brief.test.ts:256-276`). This is qualitative dispatch guidance, not automatic recycling.

Two structural commitments SPEC already ratified and the code has not yet expressed: the ceiling must be **absolute tokens, per model, tuned by measurement, and subordinate to the error-state trigger**; and **admit and retire must be two different lines**. One number doing both jobs means an agent can accept a task at 64% and be killed at 66% while still holding it. The gap between the lines is the room an agent needs to finish what it accepted.

The sensing layer has already been fixed the right way: `src/daemon/tool-telemetry.ts:90-109` reports the **numerator only** — resident tokens, summed from the transcript — because the model id cannot supply the window (the 1M upgrade is a property of the *account's plan*, so `claude-opus-4-8` is 200K on one plan and 1M on another with a byte-identical string). The sweep divides by the window the statusline payload actually measured, or reports unknown (`src/daemon/server.ts:1422-1428`). Sensing is correct and the brief now uses the same qualitative rule; the automatic actuator is the remaining gap.

## Open questions

- **Where does *Hive's* curve break?** Every number here was measured on someone else's workload. The experiment: take a fixed verifiable coding task with a known-good solution; run it fresh, then in agents pre-loaded with 32K/64K/128K/256K of irrelevant-but-plausible repo context; score solve rate, constraint adherence (plant an explicit "do not modify file X"), and turn count. That is LOCA-bench's design pointed at Hive's actual workload.
- **Does the handoff protocol beat compaction and a cold restart?** Nobody has published it. Hive can A/B it: same interrupted task, three arms.
- **Which handoff fields carry the weight?** Nobody has ablated them, including Handoff Debt. The convergent community schema agrees with itself because it copies itself.
- **How does subscription quota actually count tokens?** Not publicly documented for either vendor. Hive's quota logic must stay measurement-only and must not back-derive a cost model from API prices.
- **Does Codex degrade on the same absolute-token schedule?** Unmeasured. Every curve cited here is Claude, Gemini, GPT, or open models.

## See Also

- [Agent briefing](briefing.md) — the scoped brief that a respawn re-pays, and what it costs
- [Agent memory](memory.md) — the durable tier a recycled agent does not lose
- [Rejected approaches](../routing/rejected-approaches.md) — the measured token facts behind the brief
- [Launch mechanics](../providers/launch-mechanics.md) — why per-worktree cache scope is unavoidable
- [Database resilience](../daemon/database-resilience.md) — the sibling "absence is a finding" invariant
- [SPEC.md decision 7](../../SPEC.md) — what happens when a context fills up

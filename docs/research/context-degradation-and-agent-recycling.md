# When to recycle an agent

Hive kills an agent and respawns it when its context gets too full. The rule is a percentage: SPEC §7 sets a 65% recycle default, justified by field evidence that "quality dies around ~140K tokens." Both halves of that sentence are wrong, and they are wrong in ways that cancelled out until someone fixed a bug.

The percentage was only ever a proxy for the token count. 65% × 200,000 = 130,000, which sits near the claimed 140K line. When Hive's telemetry was corrected to read the true window (commit 856ec11), the proxy broke: 65% × 1,000,000 = 650,000 tokens, 4.6× past the line the rule was built to respect. Fixing the number invalidated the decision resting on it.

The obvious repair is to re-key the threshold to 140K absolute. This document exists to argue that you should not, because the 140K is itself unmeasured — and because the deeper problem is that **a fraction of the context window is the wrong unit, and a single number is the wrong shape of answer.**

What the evidence actually supports: degradation is a smooth gradient that begins far earlier than anyone's folklore, its onset is an absolute token count that varies by model rather than a fraction of the window, the strongest recycle signal is not a token count at all but the presence of the agent's own errors in its context, and — the finding that should most change Hive's behavior — **continuing a warm agent is roughly an order of magnitude cheaper than respawning one**, so recycling early is not the safe direction to err. It is the expensive one.

Every claim below is marked MEASURED (someone ran an experiment and published numbers), CLAIMED (an authority asserts it without data), or INFERRED (reasoning from the above, including mine). Where the evidence is thin or contradictory, that is stated rather than smoothed.

## The provenance of 140K

The number has none.

Inside this repo, `140K` appears exactly once, at `SPEC.md:164`. `git log -S "140K" -- SPEC.md` puts its introduction in `bc58715` — the initial commit. It was never derived from anything; it arrived as an assumption and has been restated since. To SPEC's credit, it already says so: "The ~140K figure is field lore, not a measurement hive has reproduced, and no practitioner consensus exists on where the line sits."

Outside the repo it is worse than unmeasured. The most-repeated attribution in the wild — that Geoffrey Huntley, an engineer at Sourcegraph, found quality degrading at 147,000–152,000 tokens — is a **fabricated citation**. His actual post ([ghuntley.com/gutter](https://ghuntley.com/gutter/)) makes a qualitative argument ("one task, one context") and **contains no token numbers at all**. The figure appears to have been invented by a secondary blog and propagated. Anyone citing it is citing a hallucination.

The likeliest true origin is arithmetic, not measurement: 200,000 × 70% ≈ 140,000, or "200K minus system prompt, tools, and reserved output ≈ 150K usable." That is a *budget* observation about Claude Code's 200K window, later retconned into a *quality* claim (INFERRED).

Nothing in the published literature lands at 140K. RULER's effective lengths are 16–64K. NoLiMa's are 2–8K. LOCA-bench's agentic decline is well underway by 32–64K. Databricks found RAG peaking and declining at 32–64K. The only published figure in the neighborhood is Fiction.liveBench's 60–120K band for Claude Sonnet 4 (thinking) — a community leaderboard, not peer-reviewed, and it sits *below* 140K.

So: **no measurement anywhere supports a 140K degradation onset, and the evidence that does exist says the real trouble starts much earlier.** Re-keying the threshold to 140K would replace a broken percentage with an invented constant. That is the same mistake in a new coordinate system, and this repo lost a day to exactly that class of error — a 200K window, a 65% threshold, a 15s readiness deadline, a 30s ack deadline, every one of them inherited, unverified, wrong, and passing its tests.

## How quality actually degrades

**Length itself degrades reasoning, even when retrieval is guaranteed.** This is the load-bearing fact, and it has a clean experiment behind it. *Context Length Alone Hurts LLM Performance Despite Perfect Retrieval* ([arXiv 2510.05381](https://arxiv.org/abs/2510.05381), EMNLP 2025 Findings) holds retrieval constant by construction — gold evidence placed immediately before the question, irrelevant tokens replaced with near-null whitespace, and an attention-masking condition where the model *can only attend to the relevant tokens*. Performance still degrades **13.9%–85%** as input grows, across five models including GPT-4o, on math, QA, and coding (MEASURED). Long context damages the *computation over* facts, not merely the *finding* of them.

This is why needle-in-a-haystack scores are worthless here. GPT-4.1 retrieves a needle at essentially 100% across its full 1M window, and scores **19%** on GraphWalks BFS (multi-hop reasoning) above 128K — same model, same context regime (MEASURED, [OpenAI](https://openai.com/index/gpt-4-1/)). NoLiMa ([arXiv 2502.05167](https://arxiv.org/abs/2502.05167), ICML 2025) strips the lexical overlap between question and needle and finds effective lengths of **2–8K** against advertised 128K+, with 11 of 13 models below half their base score by 32K; chain-of-thought does not rescue it (o1: 99.9% base → 31.1% at 32K). HELMET ([arXiv 2410.02694](https://arxiv.org/abs/2410.02694)) measured the correlation between synthetic benchmarks and real downstream long-context tasks and found none exceeding ~0.8 Spearman. Retrieval saturates; reasoning does not.

**The shape is a gradient, not a cliff.** Chroma's *Context Rot* ([research.trychroma.com/context-rot](https://research.trychroma.com/context-rot), 18 models, 194,480 calls) is careful to name **no threshold at all** — degradation is "non-uniform" and model- and task-specific (MEASURED). The widely-circulated "30–50% drop" and "1M models break at 300–400K" numbers appear only in secondary write-ups, not in the report (CLAIMED, secondary). Two of Chroma's findings deserve to survive into Hive's design: models degrade even on *repeated-word echoing*, a task with zero retrieval difficulty — length itself is the poison; and **shuffled haystacks outperformed logically coherent ones on all 18 models**, which means well-organized context is not automatically safe context.

There is one dissent on shape worth naming. *The Long-Horizon Task Mirage* ([arXiv 2604.11978](https://arxiv.org/html/2604.11978v1)) finds agents stable at low compositional depth and then collapsing abruptly past a domain-specific breaking point, and Toby Ord ([arXiv 2505.05115](https://arxiv.org/abs/2505.05115)) fits METR's data with a constant hazard rate implying smooth exponential decay — a half-life, where every doubling of assigned work halves success. These use different units (compositional depth vs. elapsed task time) and may both be true. **We do not know the true shape**, and no one should build a threshold that depends on the answer.

**The unit is absolute tokens, not a fraction of the window.** This is the finding that kills Hive's current rule outright, and it is not a calibration complaint — it is a units error.

LOCA-bench ([arXiv 2602.07962](https://arxiv.org/abs/2602.07962), HKUST, Feb 2026) inflates environment state to grow an agent's context **while holding task difficulty fixed**, which is precisely the experiment Hive needs. Success rate against accumulated context (MEASURED, Table 1):

| Model (window) | 8K | 32K | 64K | 96K | 128K | 256K |
|---|---|---|---|---|---|---|
| Claude-4.5-Opus (200K) | 96.0 | 84.0 | 65.3 | 45.3 | **34.0** | 14.7 |
| GPT-5.2-Medium (400K) | 72.0 | 60.0 | – | 44.0 | 38.7 | 21.3 |
| Gemini-3-Flash (1,050K) | 64.0 | 40.0 | – | 32.0 | 21.3 | 17.3 |

Read the third row against the first. **Gemini-3-Flash has a 5× larger window than Claude-4.5-Opus and degrades earlier in absolute tokens** — 40% at 32K where Opus still holds 84%. A fraction-of-window law predicts the exact opposite. NoLiMa and RULER corroborate: effective lengths cluster at absolute values (2–8K, 16/32/64K) largely independent of whether the advertised window was 32K, 128K, 200K, or 1M.

The corollary is blunt: **a 1M-window model is not a 200K model scaled up, and the advertised window predicts almost nothing about where quality dies.** Any rule of the form "recycle at N% of the window" is unsound, and the bigger the window the more dangerous it gets. Hive's 65% rule was not merely mis-tuned by the 200K bug — it was never expressible as a percentage in the first place.

(The often-quoted "effective context is 10–50% of advertised" has **no study behind it**. It is a folk aggregate over RULER's 25–50%, contradicted downward by NoLiMa's 1.5–6%. Attribute it to nobody.)

**The coding-agent failure mode has now been measured, and it is the one Hive cares about.** This was the honest gap a year ago; it closed in 2026. LOCA-bench names its failure modes, and they are Hive's: explicit constraints forgotten ("do not change column names" ignored); tool-call frequency plateauing after 96K while the environment keeps growing, so agents "mistake partial evidence for complete review"; retrieved values distorted in later reasoning, so models "fail to reliably carry retrieved information forward." Forgetting constraints, stopping early, contradicting itself. LoCoBench-Agent ([arXiv 2511.13998](https://arxiv.org/abs/2511.13998), Salesforce) independently measures the looping mode: past 12 turns, agents redundantly re-read files with unchanged parameters and repeat failed tool calls.

And a warning that no threshold will catch: SlopCodeBench ([arXiv 2603.24755](https://www.emergentmind.com/papers/2603.24755), with Anthropic co-authors) had agents repeatedly extend their own code as specs evolved. Verbosity increased in **89.8%** of trajectories and structural erosion in **80%**, and the finding that matters is that "quality degrades steadily across checkpoints **regardless of pass-rate performance**" (MEASURED). The tests stay green while the code rots. Hive's landing gate checks tests and types; it cannot see this.

**A dissenting result, reported honestly.** LoCoBench-Agent finds *almost no* degradation across its difficulty tiers (comprehension flat at 0.71–0.75). But it varies task difficulty inside a scaffold that already does tiered compression and hierarchical memory, while LOCA-bench varies raw context with difficulty pinned. INFERRED: a good scaffold can mask context rot; the rot is still there underneath. That is a reason to build the scaffold, not a reason to disbelieve the curve.

## The mechanism that matters more than tokens

The strongest predictor of an agent's next error is not how many tokens it holds. It is whether its own previous errors are in the context.

*The Illusion of Diminishing Returns* ([arXiv 2509.09677](https://arxiv.org/html/2509.09677v1)) isolates this as **self-conditioning**: when a model's own prior mistakes are present in its history, it becomes measurably *more likely* to err on the next step, and injecting errors degrades turn-100 accuracy monotonically with the injected error rate. **Scaling the model does not fix it** (MEASURED). Thinking/reasoning models do largely avoid it — which matters, because Hive runs them.

Anthropic's own Claude Code documentation restates this as folk practice without apparently knowing it is restating a paper: "**If you've corrected Claude more than twice on the same issue in one session, the context is cluttered with failed approaches. Run `/clear` and start fresh.** A clean session with a better prompt almost always outperforms a long session with accumulated corrections" ([best practices](https://code.claude.com/docs/en/best-practices), CLAIMED). Two independent lines of evidence — one measured, one vendor practice — converge on the same trigger, and **neither of them is a token count**.

The companion finding reframes what "degraded" even means. *LLMs Get Lost in Multi-Turn Conversation* ([arXiv 2505.06120](https://arxiv.org/abs/2505.06120), Microsoft/Salesforce, 200,000+ simulated conversations, 15 models) finds a **39% average performance drop** from single-turn to multi-turn — but decomposes it: aptitude (90th-percentile score) falls only **~16%**, while **unreliability (the 90th–10th percentile spread) rises ~112%** (MEASURED). A degraded agent is not dumber. It is *more variable*. Their diagnosis: "when LLMs take a wrong turn in a conversation, they get lost and do not recover."

The mitigation result is the one that designs Hive's handoff: giving the model all the information **up front** (CONCAT) recovers **95.1%** of single-turn performance, while restating it each turn (RECAP/SNOWBALL) recovers only 15–20%. The information was never the problem. The drip-feed across turns was. The authors' own recommendation: "starting a new conversation that repeats the same information might yield significantly better outcomes than continuing an ongoing conversation."

INFERRED, and this is the pivot of the whole document: **an agent that has failed twice is compromised regardless of how many tokens it holds, and an agent with a clean history is fine deeper into its window than any folklore threshold admits.** Recycle on error state, not on a clock.

## What a handoff costs, and what it buys

Someone ran Hive's exact experiment. *Handoff Debt: The Rediscovery Cost When Coding Agents Take Over Interrupted Tasks* ([arXiv 2606.02875](https://arxiv.org/abs/2606.02875), June 2026) interrupts 75 SWE-bench Verified tasks mid-flight, producing 181 handoff points and 2,172 takeover runs, and resumes a successor **in the same repo state** under four information conditions. That is kill-and-respawn (MEASURED, medians):

| Successor receives | Solved | Agent events | Prompt tokens |
|---|---|---|---|
| Repository only | 46.4% | 99 | 1.63M |
| Raw trace | 52.5% | 41 | 811K |
| Summary notes | 51.4% | 53 | 602K |
| Structured notes | 50.8% | 55 | 660K |

Three things fall out, and they are not what the folklore predicts.

**The repo is a genuinely recoverable source of truth.** A successor given *nothing but the worktree* still solves 46.4%. Handoff is not load-bearing for correctness — it is load-bearing for **cost**, cutting tokens 50–63% and agent events 44–59%.

**Notes match the raw transcript at a tenth of the size.** Structured notes ran 7–10K characters against the raw trace's ~87K. Carrying the transcript buys ~1.7pp over notes and costs 10× the prompt. SWE-Context-Bench ([arXiv 2602.08316](https://arxiv.org/html/2602.08316v3)) is harsher: giving an agent raw trajectories to search bought **exactly zero** (26.26% → 26.26%) while costing more.

**A bad summary is worse than no summary.** In the same benchmark, a summary the agent selected for itself scored **22.22%**, *below* the 26.26% no-context baseline, while the correct summary scored 34.34%. Mis-targeted compressed context actively poisons. And CompactionRL ([arXiv 2607.05378](https://arxiv.org/html/2607.05378v1), Tsinghua) shows the stakes: holding the execution agent fixed and swapping **only the summarizer** moved SWE-bench Verified from **49.0% to 55.5%** — 6.5 absolute points from summarizer quality alone (MEASURED). That is also the only real number anywhere near Cognition's much-cited but entirely unpublished claim that you should fine-tune a dedicated compression model.

### What gets silently destroyed

*Governance Decay* ([arXiv 2606.22528](https://arxiv.org/abs/2606.22528), 1,323 episodes, 7 model families including Claude Sonnet 4.6) is the single most actionable paper in this report. With a constraint present in full context, violation rate is **0%**. After compaction, it is **30% pooled, up to 59%**. The mechanism is not disobedience:

- Constraint **survived** the summary → **0%** violation (n=90)
- Constraint **dropped** by the summarizer → **38%** violation (n=315)

The model does not break the rule. **It never sees the rule.** And compaction preferentially eats exactly the wrong thing: **soft, deployment-specific policy decays 8.3× more than hard safety norms.** "Decay targets the governance that can only live in context" — which is to say, the tacit project constraints that exist nowhere but the conversation are precisely the ones a summarizer discards.

The fix is cheap and it is measured: **constraint pinning** — quarantine constraints from the lossy path and re-inject them verbatim. **~47 pinned tokens, under 0.5% of context, restored 0% violations.**

You cannot get this by asking nicely. *Parallel Context Compaction* ([arXiv 2605.23296](https://arxiv.org/abs/2605.23296)) measured that summary length and retained content **fluctuate substantially run to run**, and that **prompt instructions about summary volume are largely ignored**. Compaction loss is not just lossy, it is non-deterministic. Pin, do not prompt.

### Two traps Hive is positioned to walk into

**Context anxiety.** Cognition reports that Sonnet 4.5 models its own remaining context and "tak[es] shortcuts or leav[es] tasks incomplete when it believed it was near the end of its window, **even when it had plenty of room left**" — and that it "consistently underestimates how many tokens it has left, and it's very precise about these wrong estimates" ([Rebuilding Devin for Sonnet 4.5](https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges), CLAIMED). Their workaround was to enable the 1M window and cap usage at 200K so the model *believed* it had room. INFERRED for Hive: if an agent can perceive an approaching kill, it may degrade *before* the kill — and the handoff document it writes will be written by an agent already cutting corners. Do not tell an agent it is dying.

**Successors over-trust their predecessors.** Handoff Debt observed this directly as a failure mode: successors adopt the predecessor's interpretation instead of verifying repository state, and note-based handoff into a "needs completion" state produced a small *negative* solve-rate delta. The handoff must instruct verification, not just inform.

### The rule that falls out

> **Anything reconstructible from the worktree should be a pointer, not prose. Anything not reconstructible from the worktree must be carried verbatim and pinned.**

The repo is the source of truth for code, diffs, tests, and current state — a fresh agent re-derives those successfully (46.4% with nothing else), just slowly. The transcript is the *only* source of truth for a small set of things: the user's actual goal and its amendments, in-conversation constraints and prohibitions, **why a path was abandoned**, what was already tried and failed, and which reading of an ambiguous requirement was chosen. That set is small — Governance Decay restored full compliance with ~47 tokens — and it is exactly what a summarizer throws away.

On failed approaches specifically, SPEC §7 stakes a lot on this and deserves an honest answer: **the evidence is thinner than the confidence with which everyone asserts it.** Handoff Debt includes "failures observed" as a first-class field but **never ablated it**, so its individual contribution is unmeasured. Reflexion ([arXiv 2303.11366](https://arxiv.org/abs/2303.11366)) is real (GPT-4 HumanEval 80% → 91%) but measures *within*-agent retry, not agent-to-agent handoff. Structured negative-knowledge records help in a different domain ([arXiv 2606.21024](https://arxiv.org/abs/2606.21024), research automation, direction MEASURED / magnitude unverified). Every community `HANDOFF.md` template makes "what didn't work" mandatory, and none of them measured anything — they agree because they copy each other.

What the evidence *does* support is a sharper version of SPEC's claim: **the value is in the label and the reason, not the trace.** Handoff Debt found that raw traces "contain low-level noise that can waste successor effort separating dead ends from useful evidence." A dead end must be labelled as dead. Write "tried X, failed because Y, do not retry"; never carry the failed transcript.

## The economics, which run the opposite way to the instinct

Hive's orchestrator brief tells the model to reuse a live agent when its context is under 65%. When the telemetry bug pinned every reading at 100%, that rule never fired, so the orchestrator spawned fresh agents and re-paid full briefings all day, out of a quota pool that reached 99%. That was not bad luck. It is the predicted consequence, and the arithmetic says so.

All prices are Anthropic's published API rates for Opus 4.8, retrieved 2026-07-11 ([pricing](https://platform.claude.com/docs/en/about-claude/pricing), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). They are used below to compare **ratios**, which is legitimate; converting them into subscription quota is not, and is not done.

| Token class | $/MTok | vs. base input |
|---|---|---|
| Base input | $5.00 | 1.0× |
| Cache write (5 min) | $6.25 | **1.25×** |
| Cache write (1 hour) | $10.00 | 2.0× |
| **Cache read** | **$0.50** | **0.1×** |
| Output | $25.00 | — |

The whole design hangs off one identity: **cache write ÷ cache read = 12.5×.** Any token you re-pay as a fresh write costs 12.5× what it costs to carry that same token, warm, for one more turn. Cache reads also refresh the TTL for free — **a warm agent stays warm at no cost as long as it keeps working** — and they do not count toward input rate limits.

Two beliefs I held going in, and that the SPEC's framing invites, are false:

**There is no long-context price premium.** Opus 4.8, Sonnet 5, and Fable 5 include the full 1M window at standard pricing; Anthropic's docs state that "a 900k-token request is billed at the same per-token rate as a 9k-token request" (DOCUMENTED). The 2×/1.5× tier above 200K was real in the Sonnet 4 `[1M]` beta era and is gone. Carrying context is *linear*, and cheap: **$0.50/MTok/turn, or about $0.05 per 100K resident tokens per turn.**

**The cliff is cache warmth, not occupancy.** Resuming a 300K agent whose cache TTL has lapsed re-processes the entire prefix at write rates: **$1.88–$3.00**, which is 8–13× a warm turn and *more than a fresh spawn's entire briefing*. Anthropic says this outright: "the first turn back into a long session can be the most expensive request you send" ([Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)). **A cold fat agent is not a cheap agent.** Hive currently has no idle timer and cannot see this at all.

I measured Hive's own numbers rather than assuming them. From this agent's transcript, live: **first turn = 33,076 tokens** — the cold-start cost of a Hive writer agent (system prompt, tools, spawn briefing, memory index) before doing any work, and exactly what a respawn re-pays. After 54 turns of real research the context stood at 69,754 tokens, and the most recent turn's input split was **66,633 cache-read against 2 fresh tokens and 2,600 cache-write — 96% of the input at the 0.1× rate.**

Putting those together (INFERRED, arithmetic shown). Let restart cost `R` ≈ $0.81 (a 40K briefing at write rate, ~50K of rediscovery re-reads, output, and cache reads across the rediscovery turns). A respawn only pays for itself if the agent has enough remaining work to amortize `R` against the per-turn saving of carrying less context:

> `N* = R / [ (C_old − C_new) × $0.50/MTok ]`

| Agent's context | Break-even (turns of work remaining) |
|---|---|
| 120K | **27 turns** — recycling is a false economy |
| 200K | 12 turns |
| 300K | 7 turns |
| 500K | 4 turns |
| 650K (65% of 1M) | 3 turns |

**Recycling is cheap exactly when the agent is genuinely bloated, and a false economy when it is not.** Re-paying a 40K briefing costs the same as carrying that 40K warm for 12.5 turns — so a respawn that sheds only a briefing-sized slice of context never pays for itself. Under the bug, Hive respawned agents that read 100% but were often at *low* real occupancy, i.e. paying the restart toll precisely in the regime where it never amortizes.

This is why the comment already in `src/daemon/tool-telemetry.ts:131` is right and should be promoted from a comment to a design principle: "reading high is not the safe direction… recycling an agent is not free." The belief that it *is* free — that a too-early recycle is merely wasteful while a too-late one is dangerous — is exactly what justified hardcoding a 200K denominator, on the reasoning that a larger window would merely read "conservatively high."

Three further mechanics from Anthropic's docs bear directly on Hive's architecture:

- **`/compact` is cheaper than respawn**, and this cuts against SPEC §7. Claude Code's compaction call shares the cached prefix and rebuilds only the conversation layer; the system prompt and project context stay cached. A Hive recycle kills the session and re-pays the entire briefing at write rate. SPEC rejected `/compact` on *quality* grounds — lossy self-summarization drops constraints and failed-approach history — which the Governance Decay data fully vindicates. But that is not a cost argument, and the two objections can be separated (see the design below).
- **Cache scope is per-directory.** The system prompt embeds the working directory and git branch, so **agents in different worktrees cannot share each other's cache.** Hive runs every agent in `.hive/worktrees/*`. N agents means N briefing writes, always.
- **Switching model or effort level invalidates the entire prefix.** Never re-route a live agent; route the change to a new one.

**One hard unknown, stated as such.** The unit of the Claude Pro/Max subscription limit — and whether cache reads are discounted inside it — is **not publicly documented**. Anthropic's support article names the factors ("length and complexity of your conversations, the features you use, which Claude model, the effort level") but never states the unit and never mentions cache tokens. Codex is worse documented still. Per this repo's `accurate-numbers-only-rule`: **we do not know, and Hive's quota logic must not infer a token-cost model for subscriptions from the API price list.** What *is* documented is that Claude Code requests the 1-hour TTL automatically on a subscription because "usage is included in your plan rather than billed per token," and drops to 5 minutes the moment you are billed for overage — which tells us Anthropic itself treats the write premium as material only when metered.

## What Hive's own agents actually carry

Every number above was measured on someone else's workload. These were measured on this fleet, on 2026-07-11, by summing the last assistant `usage` entry in each agent's transcript — not by inverting a reported percentage:

| Agent | Resident tokens | Turns | Daemon reports |
|---|---|---|---|
| zoe | **472,090** | 632 | 100% |
| lena | **425,724** | 585 | 100% |
| emma | **384,827** | 466 | 100% |
| omar | **366,692** | 491 | 100% |
| mia | 191,245 | 156 | 35% |

Four facts fall out, and they are worth more than any citation in this document because they are ours.

**The window is 1M, proven by existence rather than inference.** zoe's most recent request carried **470,699 cache-read tokens in a single API call**, and the API served it. That is impossible against a 200K window. No denominator needs to be assumed or trusted; the request either fits or it does not, and it fit. Her trajectory grows monotonically from 33,817 to 472,090 with no reset, so this is genuine accumulated context and not a compaction artifact.

**The daemon is still dividing by 200,000**, which the same table proves from the other side: 472,090 ÷ 200,000 clamps to 100%, while ÷ 1,000,000 would read 47%. Four agents pinned at exactly 100 is the clamp, not a coincidence. So the fix in `856ec11` is committed but not running, and every percentage the orchestrator currently reads is meaningless.

**Cold start is ~33K tokens, now corroborated across two independent agents** (zoe's first turn 33,817; mia's 33,076). That is the briefing a respawn re-pays before doing any work. Net context growth runs roughly 700–750 tokens/turn.

**And the fleet is far deeper into its windows than anyone believed.** This is where I have to correct myself. I earlier told the orchestrator that "no agent is anywhere near any quality line," reasoning that a reported 28% must be 28% of 200K ≈ 56,000 tokens. That was wrong, and it was wrong in exactly the way this document exists to warn against: **I inverted a percentage instead of measuring the transcript.** The 28% had come from a 1M denominator, not the daemon's. The agents are at 366K–472K, not 56K. Proof by existence beats proof by denominator, and I should have reached for it first.

The honest reading of that is neither "they are past the line" nor "so it does not matter," because this document's central claim is that **there is no line** — no measured threshold, in this repo or the literature, and certainly not at 140K. What can be said is sharper and more uncomfortable than the folklore it replaces: the only fixed-task agentic curve anyone has published (LOCA-bench) puts Claude-4.5-Opus at 34% success by 128K and 14.7% by 256K, and **zoe is at 472K — off the end of that table entirely.** We cannot say she has crossed a threshold. We can say she is operating in a region where every published measurement of every model shows severe degradation, that Hive has never checked whether she has degraded, and that Hive's telemetry currently cannot tell anyone either way.

That is the real finding, and it is worse than a wrong threshold: **Hive is flying four long-lived agents deep into unmeasured territory with a broken instrument.** Whether they are actually degraded is the open question below — and it is answerable, because their work is on branches and can be reviewed.

## Triage: what to do with an agent already at 472K

The design above is about not getting here. But Hive *is* here — four agents between 366K and 472K, mid-wave, doing work that looks excellent — and "what do I do with them right now" is a different question from "what should the rule have been." It is also the question the literature does not answer, so what follows is reasoning from the evidence rather than a finding, and is labelled as such.

**First: the economics reverse at this depth, and that is the part everyone gets backwards.** The false-economy warning in this document is aimed at recycling agents at 120–200K, where a respawn needs 12–27 turns of remaining work just to break even. At 472K it inverts. Shedding ~412K of context saves about $0.21/turn against a restart cost of ~$0.81, so **a respawn amortizes in roughly four turns of remaining work** (INFERRED, arithmetic per the break-even formula above). At this depth, recycling is *cheap*. The reason not to recycle zoe is not cost. It never was.

**Second: do not ask a 472K agent to summarize itself.** This is the trap, and it is the one Hive's current SPEC walks straight into by having the outgoing agent write its own handoff. If the agent is degraded, its self-report is the *least* trustworthy artifact it owns — Cognition's finding on exactly this was that "the model didn't know what it didn't know," and that self-authored notes were not a substitute for a proper compaction pass. Worse, an agent that can sense an incoming kill exhibits context anxiety and starts cutting corners *before* it writes anything. And a bad summary is measurably worse than no summary at all. So the handoff for a deep agent must be reconstructed from sources that **cannot** have degraded:

1. **The worktree** — `git diff --stat`, changed files, HEAD, the last test run and its exit code. Computed, not narrated. It cannot hallucinate no matter what state the agent is in.
2. **The original spawn brief**, still in run state. The constraints and the goal were written before the agent existed and never degraded. Pin them verbatim; do not let the agent restate them.
3. **A fresh summarizer** reading the transcript — not the incumbent. Summarizer quality alone is worth 6.5 points (CompactionRL), and a fresh summarizer is not self-conditioned on the incumbent's own errors.

**Third, and this is the decision rule I would actually use:** the question is not "is zoe degraded?" — which Hive cannot currently answer — but "**is zoe still better than her replacement?**" And that has a number. A fresh agent with *nothing but the worktree* solves 46.4% of interrupted coding tasks; with a good structured handoff, ~51%. Those are the replacement baselines. An incumbent is worth keeping only while it beats them. This reframes the whole problem usefully: there is no quality *line* to cross, but there is a **quality floor to fall below**, and the floor is not zero — it is a competent fresh agent reading the same repo. That floor is knowable, it does not depend on any threshold anyone invented, and it is the only version of "too degraded" that has a measurement behind it.

**So, concretely, for the four agents on the desk (judgement, not finding):**

- **Do not interrupt them mid-task.** The task boundary is a free recycle point — no handoff to write, no context to reconstruct, no cold-spawn toll, and no risk of a degraded agent authoring its own succession. Let them finish and land. Everything about the economics and the evidence says the cheapest correct moment to retire an agent is the moment it is done, and all four are close enough to that moment that manufacturing an earlier one buys nothing.
- **Do not give them anything new.** This is the admission-control half of the rule and it is free to apply immediately, today, with no code change: an agent at 472K should not be handed another task, and the reason zoe reached 472K in the first place is that nothing stopped work being added to her. Follow-ups to a deep agent are the mechanism by which agents get deep.
- **Retire them at completion rather than reusing them**, even though they are warm and the reuse rule would otherwise favour them. At this depth the cache saving no longer justifies the risk, and the break-even is four turns.
- **Check whether the fear is even real** — see the open question below. Their work is on branches; review it against a shallow agent's. That check costs one review and would tell Hive more about its own curve than every citation in this document.

The honest summary for the orchestrator: **you were not wrong to keep them working, and you are not wrong to be worried now.** The mistake was never a missing threshold — it was that Hive had no admission control, so work kept flowing to agents that had no room for it, and no instrument that could have told anyone. Fix the admission side and the retirement side mostly takes care of itself, because agents that are never overloaded retire at task end for free.

## What Hive should do

Nothing in this section is implemented, and one clarification is owed first, because it changes what the live risk actually is.

**The recycle actuator does not exist.** `HandoffSchema` (`src/schemas/handoff.ts`) is referenced by nothing but its own test — no producer, no consumer. There is no recycle threshold anywhere in the code. The only live use of `65` is a prose sentence in `src/cli/orchestrator-brief.ts:3` instructing the orchestrator model to *reuse* agents under 65%. So "recycled too late" is currently **unreachable** — there is no mechanism to fire late. The single live failure mode is spawn-churn, which is what the quota burn was.

There is also a latent bug in the number's double life. `65` entered SPEC as a *recycle* line ("quality is dying, kill it") and was then borrowed in commit `aac466a` as a *reuse* line ("has room, take more work"). One number, two opposed jobs, and no gap between them: an agent can be handed a fresh task at 64% and hit the kill line at 66%, getting recycled mid-task while holding work it just accepted. **These must be two different lines.**

### Signals, and their units

There is no single number, and asking for one is the error. Four signals, each in the unit its evidence is actually expressed in:

1. **Error state — the primary quality trigger.** Two failed attempts at the same sub-goal means the agent's own errors are now in its context, conditioning the next one. This is the best-evidenced trigger available (self-conditioning, MEASURED; Claude Code's own "correct twice, then `/clear`", CLAIMED) and it is not a token count. It should dominate.
2. **Absolute resident tokens, per model — a capacity check, not a quality proxy.** Occupancy is a *budget* number and answers only "does this agent have room for the next task." It must never be expressed as a percentage of the window, because the window does not predict degradation. Each model gets a calibrated absolute ceiling.
3. **Cache warmth.** An agent idle past its TTL is expensive to resume — potentially more expensive than a fresh spawn. This signal does not exist in Hive today and is the cheapest one to add.
4. **Task boundary.** The strongest recycle signal is simply that the agent **finished**. SPEC §7 already says most agents should retire at task end without seeing the ceiling; the design should lean on that hard and treat the ceiling as a rare safety net.

For (2), the honest position is that Hive cannot yet name its own numbers. LOCA-bench gives the only fixed-task agentic curve in existence and it says Claude-4.5-Opus is already at 65% success by 64K and 34% by 128K — far below any threshold Hive has contemplated. Taking those numbers literally would mean recycling at a fraction of what SPEC proposes. But LOCA-bench's tasks are environment-exploration tasks on mock servers, not code edits in a git worktree, and its context is *inflated environment state* rather than a working agent's own reasoning. Whether that curve transfers to Hive's workload is **unknown**, and the transfer is exactly the sort of inherited assumption this document exists to refuse. The measurement Hive should run is in the open questions below.

Until it is run, my judgement — labelled as judgement, not finding — is that the ceiling should be set **per model in absolute tokens, well below the folklore, and treated as a backstop rather than the mechanism**: something like 150–200K for a 200K-window Claude model and no more than ~250K on a 1M window, on the grounds that every published curve shows serious agentic decline by then and that nothing in the economics rewards carrying more. The important commitments are structural and do not depend on the exact figure: **absolute tokens, per model, tuned by measurement, and subordinate to the error-state trigger.**

### Sizing work up front

Prevention is the real mechanism, and SPEC §7 already knows it. The evidence sharpens it in three ways.

**Give the complete spec at t=0.** The multi-turn result is unambiguous: information delivered up front (CONCAT) recovers 95.1% of single-turn performance while the same information drip-fed recovers 15–20%. Devin's production data agrees from the other side — "Devin usually performs worse when you keep telling it more after it starts the task" (CLAIMED, [Cognition](https://cognition.com/blog/devin-annual-performance-review-2025)). A Hive spawn brief should be complete, and follow-up instructions to a live agent should be understood as a *cost*, not a free correction.

**Size in human-expert hours, and target well under the model's horizon.** METR's 50%-time-horizon is the only calibrated curve for this: Claude Opus 4.5 sits at ~320 minutes, doubling roughly every 89 days since 2024 ([Time Horizon 1.1](https://metr.org/blog/2026-1-29-time-horizon-1-1/), MEASURED). Devin's production sweet spot — clear requirements, verifiable outcome, 4–8 junior-engineer hours — yields a 67% PR merge rate. Under Ord's half-life model, a task at ¼ of the horizon succeeds ~84% of the time. **Judgement: target 1–4 human-hours per spawn.** And note METR's most useful result for Hive: re-running their measurement *inside the Claude Code and Codex harnesses* produced no significant difference from their own scaffolds — **the ceiling is a property of the model, not the harness.** An orchestrator cannot scaffold past it. Sizing is the only lever that exists.

**Admission control, separated from retirement.** Replacing the single 65 line with two:

- **Admit** a new task to a live agent only if `resident_tokens + estimated_task_cost + handoff_reserve < ceiling(model)`, the agent has no unresolved repeated failure, and its cache is warm. Hive already classifies tasks into tiers with cost estimates (`src/schemas/quota.ts`), so `estimated_task_cost` exists.
- **Retire** at task completion (the normal path), on repeated failure, or on reaching the ceiling (the backstop).

The gap between them is deliberate: it is the room an agent needs to *finish* what it accepted.

### The handoff protocol

The evidence gives an unusually precise specification, and it revises SPEC's on three points.

**Split the document into a computed half and a written half.** This is Handoff Debt's distinctive contribution and Hive gets it nearly free. The computed half is extracted from the worktree and **cannot hallucinate**: branch, HEAD, `git diff --stat`, changed files, the last validation command with its exit code and tail of output, and the todo state. The written half is where all the risk lives and should be minimal: goal, work completed, **failures observed with their reasons**, remaining uncertainty, the single next concrete action, and rollback notes.

**Pin constraints verbatim; never let them through the summarizer.** This is the highest-value, lowest-cost item in this entire document: 0% → 38% violation when a constraint is dropped, and ~47 pinned tokens to restore full compliance. Hive should maintain a small, append-only, **never-summarized** block of constraints and prohibitions — the user's amendments to the goal, "do not touch X," "must use Y" — and re-inject it byte-identical into every successor. Prompting the summarizer to preserve them is not a substitute; summary content is measurably non-deterministic and volume instructions are measurably ignored.

**Condition the handoff on the successor's goal.** Amp removed `/compact` entirely in favour of goal-directed handoff, on the argument that "instead of summarizing a thread, you're extracting from it what matters for your next task" ([Amp](https://ampcode.com/news/handoff), CLAIMED); Slipstream ([arXiv 2605.08580](https://arxiv.org/abs/2605.08580)) attacks the same problem from the other side — "the compactor must condense context but is fundamentally unaware of precisely what information the agent will need later" — and gets +8.8pp by verifying the summary preserves forward intent (MEASURED). Hive is in the fortunate position of *knowing* the successor's goal: same identity, same worktree, same task. It should write the handoff as extraction toward the remaining objective, not as a neutral transcript summary.

**Deliberately dropped:** the transcript, raw tool outputs, file contents, and the exploration path. All are reconstructible from the worktree, and carrying them is measurably worthless (raw trajectories bought exactly zero in SWE-Context-Bench) or actively harmful (unlabelled dead ends waste successor effort).

**And the successor must be told to verify.** Over-trusting the predecessor's interpretation was a measured failure mode. The incoming brief should say so explicitly.

Two implementation notes. `buildAgentPrompt` already takes an `options.brief` (`src/daemon/spawner-impl.ts:470`), so a handoff can ride in with no new plumbing. And the handoff should be generated with a slow, high-recall pass using the best available model, because the moment Hive decides to kill an agent **there is no user waiting** — this is free latency, and summarizer quality is worth 6.5 points.

### The reuse rule

The brief in `src/cli/orchestrator-brief.ts:3` already gets one thing right that this document would otherwise have had to argue for: an agent whose `contextPct` is `null` is **not** eligible for reuse, because unknown is not empty. Keep that. What should change is the number beside it:

> Prefer a follow-up to a live agent. Reuse an agent when it is live, its cache is warm, it has no unresolved repeated failure, and its **absolute resident tokens plus this task's estimated cost** fit under its model's ceiling with room to spare. Spawn fresh when no live agent fits, when file scopes would collide, or when the agent is carrying failures.

The substantive edit is that `contextPct` — a percentage — is the wrong quantity to threshold at all, and the orchestrator should be reasoning about resident tokens against a per-model ceiling. Until Hive exposes that, the percentage is what exists, and a *lower* bound on it is safer than the current 65 only because 65% of a 1M window is absurd — not because any percentage is right.

And a rule that follows from the cache mechanics rather than from quality: **never switch a live agent's model or effort level.** It silently invalidates the entire prefix. Route the change to a new agent.

### What SPEC §7 should say — recommendation only

Not making this change; it is the user's call. What I would change:

1. **Delete the ~140K claim.** It has no provenance, and its most-cited attribution is a fabricated citation. Replace it with what is measured: degradation is a gradient that begins in the tens of thousands of tokens, its onset is an absolute count that varies by model, and no cliff has been found anywhere.
2. **Delete the 65% default and the percentage framing entirely.** Not re-key it — *delete* it. A fraction of the advertised window is the wrong unit, demonstrated by a 1M-window model degrading earlier in absolute tokens than a 200K one. Replace with a per-model absolute ceiling in config.
3. **Demote the ceiling to a backstop and promote the real trigger.** The primary recycle signals are task completion and repeated failure. The ceiling is what catches the agent that neither finished nor failed loudly.
4. **State that recycling is not the safe direction to err.** Both errors cost, and the cheap-looking one is the expensive one (below).
5. **Revise the `/compact` rejection.** SPEC's quality objection is *correct* and now has hard evidence behind it (Governance Decay). But it is not a cost objection, and compaction is strictly cheaper than respawn on a warm agent. The synthesis: **write the durable handoff artifact to disk first, then compact in place** — keeping the pinned constraints out of the lossy path entirely. That preserves everything SPEC wanted to protect while never paying the cold-spawn toll. Kill-and-respawn remains correct when the agent is *cold*, or when its context is poisoned by its own failures and shedding the trajectory is the point.
6. **Add an idle/cache-warmth signal.** A cold fat agent is more expensive to resume than to replace, and Hive is currently blind to this.

## The cost of being wrong, in each direction

Neither error is free, and the assumption that one of them is — that "conservative" means "recycle early" — is precisely what produced the 200K bug.

**Recycling too late** lands degraded work in the repo. The agent forgets constraints, contradicts decisions it made earlier, stops exploring while believing it is done, and — per SlopCodeBench — writes progressively worse code **while the tests still pass**, which means Hive's landing gate cannot catch it. The cost is a bad commit, a wasted review, and a defect whose origin is invisible. This is the error everyone fears, and today in Hive it is **structurally unreachable**, because no actuator exists.

**Recycling too early** throws away a warm context that is ~96% cache-read (measured on this agent) and re-pays a 33,076-token cold start at full price, plus rediscovery, out of a quota pool that hit 99% today. Below ~200K of resident context the break-even is 12+ turns of remaining work, and below ~120K it is 27 — so an early recycle usually never amortizes at all. It also *destroys* things the successor cannot rebuild: Governance Decay measures constraint loss at 0% → 38% across a compaction boundary, and Anthropic's own guidance concedes that "each handoff loses context." An early recycle is not a free safety margin. **It is a quota bill plus a real chance of dropping the very constraint that was keeping the work correct.** This is the error Hive actually made, all day, and it is the one the current design is still shaped to repeat.

The asymmetry that should be encoded: **a too-late recycle costs one bad commit that review can catch; a too-early recycle costs quota on every agent, forever, and silently drops constraints.** Erring early is not caution. It is a recurring tax with a correctness risk attached.

## Open questions

**Are zoe, lena, emma and omar actually degraded right now?** They are carrying 366K–472K tokens each, which is past every published curve, and nobody has looked. This is the one open question that can be answered today without building anything: their work is on branches, so review it. If the code landing from a 472K agent is measurably worse than the code landing from a 190K one — more verbose, contradicting earlier decisions, ignoring stated constraints — that is Hive's own first data point on its own curve, and it is worth more than every citation in this document. If it is *not* worse, that is equally informative, and it is an argument that thinking models tolerate depth far better than the folklore assumes. Either way, do not guess: SlopCodeBench's warning is that quality rots while the tests stay green, so a green suite is not evidence of health.

**Where does *Hive's* curve actually break?** Every number in this document was measured on someone else's workload. LOCA-bench is the closest — a fixed task with context inflated around it — but its tasks are mock-server exploration, not code edits in a git worktree. **We do not know Hive's curve, and we should measure it rather than inherit one.** The experiment is cheap and this repo is the ideal instrument: take a fixed, verifiable coding task with a known-good solution; run it in a fresh agent, and again in agents pre-loaded with 32K / 64K / 128K / 256K of *irrelevant but plausible* repo context (other files, prior unrelated transcripts); score solve rate, constraint adherence (plant an explicit "do not modify file X"), and turn count. That is LOCA-bench's design, pointed at Hive's actual workload, and it would replace the last inherited constant in this design with a measurement.

**Does the handoff protocol proposed here beat compaction, and beat a cold restart?** Nobody has published this — Handoff Debt compares information conditions but not against in-place compaction. Hive can A/B it: same interrupted task, three arms (respawn with structured handoff / compact in place after writing the artifact / respawn with repo only).

**Which handoff fields carry the weight?** Nobody has ablated them, including Handoff Debt. The convergent community schema is lore that agrees with itself because it copies itself. Hive's `HandoffSchema` is as good a guess as anyone's — but it is a guess, and the failed-approaches field in particular is asserted far more confidently than the evidence supports.

**Is the degradation shape a gradient or a cliff?** The sources genuinely disagree (Ord's smooth half-life vs. the Long-Horizon Task Mirage's abrupt collapse past a compositional-depth threshold), and they use different units. A threshold whose correctness depends on the answer is a threshold built on sand — which is an argument for the error-state trigger, which does not care.

**How does subscription quota actually count tokens?** Not publicly documented, for either vendor. Hive's quota logic must stay measurement-only here and must not back-derive a cost model from API prices.

**Does Codex behave the same way?** Every degradation curve cited here is for Claude, Gemini, GPT, or open models on non-agentic harnesses. Hive runs Codex agents too, and reads their context window correctly already (`codex-app-server.ts:631`). Whether GPT-5.x-class models degrade on the same absolute-token schedule is unmeasured here.

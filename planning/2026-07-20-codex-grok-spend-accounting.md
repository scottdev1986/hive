# What last night's Codex and Grok spend actually bought

**Window:** 2026-07-19T23:47Z → 2026-07-20T10:47Z (instance `run-bc65ab00-416d-4032-91c1-7937388aa255`)
**Author:** ivo · **Method:** prior-instance DB (`token_usage_*`, `agents`), `hive_quota_status`, local `main` ancestry

---

## 1. Verdict

Both vendors' weekly quotas are at **0% remaining** and the night's Codex/Grok work produced **1.06 M measured output tokens of landed value and roughly the same again of measured waste**. The single most valuable thing bought was real: agent horatio's B2.5 defect run found four genuine defects via live runs, and **all four were fixed and are on main today** — those are the commits that make last night not a write-off. Against that: **11 of 22 Codex/Grok agents (50%) added no commit at all**, five Codex agents died against a dead idea-MCP port (64342) and three of those produced literally nothing, and **52.5% of Grok's entire measured output sits on three branches that are not in main** — including a branch whose final commit is a handoff doc written because Grok ran out of quota mid-task. The uncomfortable part is not the crashes: it is that the *largest* Grok spend of the night (helga, 271,985 output tokens, the biggest single Grok consumer) ended with nothing merged. Meanwhile M1 did not advance to closure on a single gate — A0, A1, B2.5, B2.6, C1.3, C1.4 and C2 are all still open, and five of the remaining gates are user-only and could never have been bought with tokens at all. **Correction to the briefing premise:** the ~12 unresumable deaths were not all Grok and not all port 64342. There were 11 resume-deaths, split 5 Codex (all port 64342) and 6 Grok (all `no proof of life within 10s`) — two different root causes that need two different fixes.

---

## 2. Measured spend

Provider-reported, from `token_usage_events` in the prior instance DB. Codex reports one cumulative event per subject (`cumulative=1`, authoritative); Grok and Claude report incremental per-turn events (`cumulative=0`), so summing is correct for each.

| Provider | Agents | Subjects reporting | Output tokens | Reasoning tokens |
|---|---|---|---|---|
| **Codex** (gpt-5.6-sol) | 11 | 11 | **1,323,664** | 558,276 |
| **Grok** (grok-4.5) | 11 | **7** (4 never reported) | **776,515** | 612,205 |
| Claude workers | 20 | 20 | 2,676,937 | — |
| Claude orchestrator (control) | 1 | 1 | 451,700 | — |

**Control share:** orchestrator output is 451,700 of 3,128,637 total Claude output = **14.4%**. This is a **lower bound** on Hive-protocol overhead, not an exact figure: worker turns mix task work with Hive protocol (inbox reads, status, land calls), and none of that worker-side protocol cost is separable in the current schema.

**Input tokens are deliberately not totalled.** Per-turn `inputTokens` re-counts the full context each turn; summing them yields absurdities (891 billion for Claude workers). Output and reasoning tokens are the honest additive measures.

**Quota state now** (`hive_quota_status`, authoritative/reported, fresh):

| Pool | Used | Remaining | Resets |
|---|---|---|---|
| codex / `codex` (prolite) | 100% | **0%** | 2026-07-26T00:00:27Z |
| grok / subscription (SuperGrok) | 100% | **0%** | 2026-07-26T17:18:56Z |
| codex / `codex_bengalfox` (GPT-5.3-Codex-Spark) | 0% | **100%** | 2026-07-27T13:24:02Z |

Worth knowing: **Codex is not entirely out.** The `codex_bengalfox` pool is untouched and routable for `gpt-5.3-codex-spark`. Only the main `codex` pool is exhausted.

---

## 3. Per-agent ledger

Attribution rule: an agent produced work only if its branch tip is a commit dated **after** the agent was spawned. Tips that predate spawn are inherited from a predecessor — several of last night's agents were explicitly "continue a crashed agent's work" and inherited a branch they never advanced.

### Codex — 11 agents

| Agent | Category | Output tok | Branch outcome | Produced? |
|---|---|---|---|---|
| howard | complex_coding | 290,056 | tip `7979106b` in main | ✅ yes |
| horatio | complex_coding | 281,505 | `6bd1f702` in main, credited twice | ✅ yes (see §4) |
| hector | debugging | 278,672 | tip `cc2f8483` 01:59 > spawn 00:47 | ✅ yes |
| hubert | code_review | 193,735 | tip `be48a971` in main | ✅ yes |
| horace | code_review | 61,871 | tip `5da90ca2` **predates spawn** · died 64342 | ❌ no |
| horst | debugging | 55,268 | tip `4ab8a45d` in main | ✅ yes |
| integrator | complex_coding | 48,672 | 2 merge commits in main | ✅ yes |
| hiram | code_review | 42,208 | tip `16908cc1` **predates spawn** · died 64342 | ❌ no |
| harold | code_review | 31,374 | tip = branch point `552a6241` · died 64342 | ❌ **nothing** |
| henry | debugging | 31,163 | tip = branch point `552a6241` · died 64342 | ❌ **nothing** |
| hugo | debugging | 9,140 | tip = branch point `552a6241` · died 64342 | ❌ **nothing** |

### Grok — 11 agents

| Agent | Category | Output tok | Branch outcome | Produced? |
|---|---|---|---|---|
| helga | complex_coding | 271,985 | `c4618c42` **NOT in main** — quota-exhaustion handoff doc | ❌ no |
| hulda | debugging | 161,371 | tip `b23943d9` predates spawn | ❌ no |
| hedda | complex_coding | 105,734 | tip `4db42977` predates spawn | ❌ no |
| hattie | debugging | 86,056 | `963a6f35` **NOT in main** · died on resume | ❌ no |
| hilda | complex_coding | 64,626 | tip `29ffd455` in main | ⚠️ inherited-tip, unresolved |
| helena | complex_coding | 49,595 | `fdfc3617` **NOT in main** · died on resume | ❌ no |
| hope | code_review | 37,148 | tip `2bfd2bfd` in main | ⚠️ inherited-tip, unresolved |
| hana | debugging | **unknown** | branch = branch point · died on resume | ❌ **nothing** |
| hazel | complex_coding | **unknown** | branch = branch point · died on resume | ❌ **nothing** |
| hedy | code_review | **unknown** | tip predates spawn · died on resume | ❌ **nothing** |
| herta | code_review | **unknown** | tip predates spawn · died on resume | ❌ **nothing** |

Those four Grok "unknown" cells are real unknowns, not zeroes: `token_usage_subjects.unknownReason` says *"grok has not reported token usage yet"*. They consumed quota; the amount is unmeasured.

---

## 4. Value delivered

**horatio's four B2.5 defects: found, fixed, and landed — confirmed, not assumed.** All five commits verified as ancestors of local `main`:

| Defect (as briefed) | Commit | Landed | Substance |
|---|---|---|---|
| spawn cleanup mis-routed through tmux | `5925dec2` `fix(sessiond): route spawn cleanup by locator host` | ✅ in main | **real code + tests**: `src/cli/daemon.ts`, `src/daemon/server.ts`, `test/cli/daemon.test.ts` — 97 insertions |
| locator no-binding | `5925dec2` (same fix) | ✅ in main | as above |
| error masking | `9669dbcd` `test(b2.5): surface spawn refusal before pane wait` | ✅ in main | refusal surfaced instead of swallowed |
| display-asleep host precondition | `d99f1b14` `test(b2.5): require an active production display` | ✅ in main | precondition now enforced |

Plus two further landed B2.5 fixes from the same work-stream:
- `d5794078` `fix(b2.5): keep production pane feed responsive` — in main
- `6bd1f702` `fix(b25): preserve pending quit disposition` — in main, credited to horatio by two independent commits (`21df3669`, `ea8bbdfd`)

**These are all in the value column and all are Codex.** `5925dec2` in particular is the night's best single artifact: a real routing bug in the daemon, fixed with a regression test.

Other landed Codex value: hector's C1.1 typography pin (merged `8e6a029b`), howard's B2.4 review follow-ups, horst's `4ab8a45d` IOSurface first-frame bootstrap, hubert's staircase verification, integrator's two merges.

**Landed Grok value: none I can positively attribute.** hilda and hope have tips in main, but both tips predate their spawn, so I cannot show either agent added a commit. This is an attribution limit, not proof of zero — see §7.

---

## 5. Waste, quantified

**Deaths.** 11 resume-deaths across the night, in two distinct failure modes:

- **Codex — 5 agents, port 64342.** `MCP client for 'idea' failed to start … http://127.0.0.1:64342/stream`, then `MCP startup incomplete (failed: hive, idea)`. Agents: hugo, henry, harold, horace, hiram. Positive control: the `LIKE '%64342%'` query returns exactly 5 rows, all `tool='codex'`, **zero Grok**.
- **Grok — 6 agents, resume probe timeout.** `resume launch failed: no proof of life within 10s (no hook event and no fresh tool activity)`. Agents: hana, hazel, hattie, helena, hedy, herta. **No 64342 anywhere in any Grok failure reason.**

The briefing's "Grok died ~12 times against port 64342" is wrong on both vendor and cause. The count (11) is close; the attribution is inverted.

**Codex waste.**
- 3 agents produced *nothing at all* (hugo, henry, harold): **71,677 output tokens = 5.4%** of Codex output.
- Including horace and hiram, which also added no commit: **175,756 = 13.3%** of Codex output.
- **Codex delivered ~86.7% of its output into agents that produced landed work.** Codex was the good buy of the night.

**Grok waste.**
- 3 agents' work sits on branches **not in main** (helga, hattie, helena): **407,636 output tokens = 52.5% of all measured Grok output.**
- 4 more agents (hana, hazel, hedy, herta) never reported a token and added no commit — spend unknown, value zero.
- 2 more (hulda, hedda, 267,105 tokens) added no commit to inherited branches.
- **Positively-attributable landed Grok work: none. On the measurable evidence, the Grok spend bought ~0 landed commits.**

The sharpest single fact: **helga was the largest Grok consumer of the night (271,985 output tokens) and its final commit is `c4618c42 docs(b2.5): handoff for non-Grok successor (quota …)`** — a handoff written because it exhausted quota mid-task. That branch is not in main. The largest Grok spend bought a note explaining that the spend had run out.

---

## 6. Work later found wrong or superseded

Today's audits (`planning/m1-definition-of-done-audit.md`) found the tracker **wrong in seven places**, and several corrections land directly on last night's output:

- `b5d2ed4c` — *"row K cites files that do not exist; deferral claim unsourced"* — a B2.5 record written last night cited non-existent files.
- `9bb69620` — *"row K's blocker is the GUI gate, not vendor quota"* — last night's stated blocker was wrong; quota was blamed for what was actually a GUI gate.
- `4023f5ca` — *"the b25 preflight is over-strict"* — a preflight added in the burn is itself a defect.
- `925fc7ce` — *"the 02:35 Workspace death did not happen"* — an incident investigated during the night was not real.
- `3ff6139b` / `0d39566a` — feed-failure positively ruled out, i.e. a hypothesis pursued overnight was refuted.
- C1.2 required six post-verdict correction commits (`1e46a20c`, `81c0c071`, `5b1356a1`, `34788e2b`, `384cb1e6`, `4b51c1ed`) fixing claims made hours earlier.
- **Issues closed with unmet acceptance:** #34 (A0), #3 (A1), #4 (A2), #8 (B2) were all marked CLOSED/Done while their own status lines say otherwise.

I can name these as redone-or-refuted, but **I cannot put a token number on them**: no per-commit or per-task token attribution exists. That is an instrumentation gap, not an estimate I am willing to fake.

---

## 7. What the spend did not buy

M1 gates still open after the burn (`planning/m1-definition-of-done-audit.md`):

| Gate | State |
|---|---|
| #34 M1-A0 | **OPEN** — contract says "real-session verification intentionally incomplete"; freeze cases B/C still `test.failing`; DoD 3 has no artifact |
| #3 M1-A1 | **OPEN by its own status line** — native create, control plane, attach streaming, crash/adoption, replay all remain open |
| #4 M1-A2 | Landed but **unevidenced** — no acceptance record or closure review on main |
| #8 M1-B2 | **PARTIAL** — B2.5 open, B2.6 pending-human, DoD-7 has no artifact |
| #9 M1-B3 | 4 declared gaps; **must be re-run post-cut**, so cannot close before the cut |
| C1.3 / C1.4 | **NOT STARTED** |
| C2 packaging | open except clean-machine acceptance |

And the honest structural point: of the blocking items, **B3 (pre-cut drain), B9 (A4 faithful app-quit), B10 (Gate 4 notarization), B11–B15 (human evidence batch), and B16 (C1.5 aesthetic signoff) are USER-ONLY.** No quantity of Codex or Grok tokens could ever have closed them. A meaningful share of last night's burn was spent by agents working around gates that were never agent-closable — and both vendor pools are now dry until 2026-07-26 with those gates untouched.

---

## 8. What to instrument so this is answerable next time

The four things that forced "unknown" into this report:

1. **Per-commit token attribution.** There is no link from a commit to the agent-session that produced it. Commit-trailer the agent name and subject id at commit time; then §6 becomes a number instead of a list.
2. **Grok token reporting.** 4 of 11 Grok agents reported *nothing* (`unknownReason: "grok has not reported token usage yet"`). Grok spend is structurally under-measured; a subject that dies before its first report is invisible. Sample token usage at turn boundaries, not only at session end.
3. **Branch-origin attribution.** `git branch --contains` is useless once branches rebase onto main, and hive deletes branches after landing, so "no branch" is ambiguous between *landed* and *never produced*. Record the agent's branch tip at close in the `agents` row.
4. **`hive_token_usage` is denied to the writer role** (`Role writer may not token-usage:read`). Every number here came from reading the SQLite file directly. An agent asked to audit spend cannot use the spend tool.

Also worth fixing before the next burn, since between them they cost 11 agents: the **idea-MCP on port 64342 is dead and Codex hard-fails on it**, and the **Grok resume probe's 10s proof-of-life window is too short** for an agent that resumes mid-reasoning.

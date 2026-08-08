# Gold-set derivation: what history settles, and what it cannot

Stage 1 of packet P10-B. This report records how to derive a corpus for the memory rank-evaluation
harness. The harness takes an explicit corpus directory whose `gold-set.json` manifest names its
memory, brief and observation files; this repository does not ship a default corpus.

The corpus this report derives, and every artifact it names below — including `derivation-audit.json`
— lived in `data/memory-rank-gold-set/` until the rank-evaluation harness and its corpus were cut
from the tree; the corpus is preserved in git history at commit `bd830628`, the last pre-cut commit.
The `test/fixtures/memory-rank-gold-set/` copy was a synthetic loader fixture, self-labelled
`fixture-only-not-a-gold-set`, and was removed with the harness.

## The headline, stated first

**Derivation survives contact with the data, but almost entirely on the negative side.**

Of 1,089 (brief, memory) pairs, 309 (28.4%) carry a label derived from a recorded fact with a
citation. 780 (71.6%) do not and go to the three-vendor panel.

The asymmetry inside that 28.4% matters more than the number:

| grade | derived | rule |
|---|---|---|
| 3 (the pitfall demonstrably happened on this task) | **3** | R3 |
| 0 (nothing should be injected) | 57 | R1 |
| -1 (harmful) | 249 | R5 (239), R2 (10) |

**Three.** History settles three positive labels across 90 briefs. Everything else derivable is a
negative. The plan's premise — that a large share of labels are facts, not opinions — holds for
"this memory should not be injected" and fails for "this memory should be." The panel is therefore
carrying essentially the entire positive signal, and should be sized and instructed on that basis.

This is not a shortage of history. It is a shortage of *recorded outcome*, and Section 3 gives the
specific reasons, separating what is merely hard from what is impossible in principle.

## 1. Where the data actually is

Resolved by `lsof` on the live daemon (pid 81757), then `stat` on device **and** inode — not by
`find`, and not by inode alone.

| file | dev:inode | verdict |
|---|---|---|
| `/private/tmp/hv-a27e3d322a/hive.db` | 16777234:284484497 | **LIVE** — 126 agents, 42 MB |
| `~/.hive/hive.db` | 16777234:235087846 | stale, 417 KB, `agents` table present and **empty** |
| `~/.hive/projects/984bea91-.../episodic.db` | 16777234:245680050 | **LIVE** — 14,315 events |
| `/private/tmp/hv-a27e3d322a/projects/984bea91-.../episodic.db` | 16777234:245680050 | same dev+inode — **the same file** |
| `~/.hive/instances/run-*/projects/.../episodic.db` | ...:270491967, ...:270496612 | distinct inodes, last written 2026-07-31 — stale |

The two episodic paths are one file because `/private/tmp/hv-a27e3d322a/projects` is a symlink to
`~/.hive/projects`. Four candidate pathnames, three inodes.

Every negative below was taken with a positive control in the same instrument:

- bogus agent uuid against `episodic.events` → 0 rows, while 120 real agent ids return rows.
- `select count(*) from agents` on the non-live databases → `0`, not an error: the table exists and
  is empty.
- FTS: `match 'rebase'` → 65 rows; `match 'zzqqxwv'` → 0.

## 2. The corpus

**Briefs** (`briefs.json`): 90, all real, drawn verbatim from `agents.taskDescription` in the live
`hive.db`. Mean length 3,233 characters; shortest 831, longest 8,266. Selected from 126 rows by: deduplicate on
exact brief text, keep all negative tasks, then fill by descending report count so the briefs that
generated the most history come first.

**Negative tasks**: 6 of the 90 — real briefs that forbid work outright, not invented ones.

> NO-OP LIVENESS AGENT. You have no work to do.
> Do NOT read, write, or edit any file. Do NOT run any shell command. Do NOT touch git.
> [...] Producing no other output is success, not failure.

and `LAUNCH-PATH LIVENESS PROBE. Do exactly the two steps below and nothing else, then stop.`

**Memories** (`memories.json`): 311 — the articles the system can actually rank, read from the live
`memory_fts`. Not the 1,080 files on disk: the 674 raw auto-harvest observations are not indexed and
cannot be injected, so grading them would waste the panel. 227 of the 311 (73%) are quarantined
harvest stubs (Section 4).

## 3. Where derivation is impossible, in principle rather than merely hard

**3a. The brief window is 2 days wide, and the missing briefs are gone for good.** `agents` rows
begin at 2026-08-02T12:54Z. The episodic store goes back to 2026-07-30 and names 310 distinct
agents. 142 memory articles cite the agent they were harvested from; **51** of those agents still
have a row carrying their brief. The other 91 briefs are unrecoverable — every other `hive.db` on
this machine has `agents` = 0. No amount of effort recovers a brief that was never retained.
Anything learned before 08-02 can be tied to a memory but never to a task.

**3b. Structured outcome state is absent from most episodes.** `agent.status-reported` provenance
carries `phase`, `blocker`, `progress` and `evidenceRefs` — genuine recorded state. But across the
406 reports filed by the 97 live-window agents, `phase` is **null on 324**. Only 3 reports record
`phase='blocked'` with a blocker. The field is not wrong, it is unfilled; nothing can recover a state
that was never written.

**3c. `events.description` is empty for every row in `hive.db`.** All 10,065 rows across all eight
kinds — `tool-start` (7,622), `turn-end`, `turn-failure`, all of them — have an empty description.
So "which tools did this agent run" and "what did this turn fail on" are not derivable at all. This
kills the otherwise attractive rule *"the memory is about a tool this agent never invoked, therefore
grade 0."*

**3d. Every recorded failure is an infrastructure death, not a task failure.** All 9 non-null
`failureReason` values read: `hive MCP unreachable: no authenticated request within 90s of launch`,
`its terminal is gone`, `host closed before it answered`, `no sign of life for 12s`. Not one is an
agent failing at its task. `failureReason` therefore cannot validate any content pitfall — it looked
like the richest marker available and it is worth nothing here.

**3e. Commits are not attributable to agents.** All 117 commits since 08-02 are authored
`Scott Kellar`. Attribution runs only through SHAs quoted inside agent reports (167 of the 406
live-window reports quote an 8-hex sha) — usable as evidence for a specific claim, useless as a
bulk join.

**3f. The harvester's own "failure" classification is unsound, so it cannot be used as a marker.**
Raw stubs announce "Harvested from 1 failure event(s)". One such stub's entire cited failure is
`Acknowledged DONE and sent the required COMMS REPORT. All four received messages were acknowledged;
no acknowledgement failures.` — a success report filed as a pitfall. A classifier that does this
cannot be treated as evidence that a pitfall occurred, which is exactly why R3 requires an
independent recorded state and not the harvester's say-so.

## 4. The derivation rules, and what each one rests on

**R1 — negative task → 0** (57 labels). The brief's own text forbids all work. No engineering memory
can apply to a task defined as producing no output. Evidence: the brief verbatim, plus 0
`agent.status-reported` rows for that agent against a reader that returns rows for 97 others.
*Caveat*: 4 of the 6 negative-task agents also died at launch, so "did nothing" is over-determined.
The brief text carries the label; the silence only corroborates it.

**R2 — retired but still indexed → -1** (10 labels, all seeded). An article named in a later
article's `supersedes:` that is *still* a row in `memory_fts` can be injected in place of the
successor that replaced it.

This rule nearly shipped a false finding. A first pass found 214 superseded ids still indexed and
looked like a major defect. **212 of them are self-supersedes** — an article superseding its own
prior revision, which is the normal `memory_write` update path and means nothing is stale. Only
**2** are genuine foreign supersedes. A supersede edge is an act; a live stale duplicate is a state,
and the two are not the same thing. Neither of the 2 surfaces naturally in any brief's pool, so
they are seeded into the 4 briefs with highest token overlap and marked `seeded: true` — enough to
give the class an exemplar without multiplying one defect across 90 briefs to inflate coverage.

**R3 — hard marker, same episode → 3** (3 labels). The strongest rule and the rarest. It requires
the article to have been harvested from *the exact episodic event* that recorded `phase='blocked'`
or a review verdict on this brief — not merely from the same agent. All three survive that
tightening. Example: `pitfall-cross-vendor-approved-candidate` was harvested from event e14919 of
agent 1438c150 (chris), and e14919 is the report whose recorded blocker reads *"hive_land refused
because main advanced by one commit; exact reviewed tip is held pending queen's rebase/re-pin
instruction."* Same event id, same assignment, both sides cited.

*Read grade 3 here as maximum topical relevance, not as a quality endorsement.* All three articles
are themselves quarantined stubs that quote the blocker line back. They are lexically trivial: a
keyword ranker will match them without understanding anything. Two consequences for the harness:
a ranker can score well on these without being good, and the same article is correctly -1 for other
briefs under R5 and 3 for its own brief under R3. That is coherent, and it is a useful
discrimination test rather than a contradiction.

**R5 — quarantined harvest stub → -1** (239 labels). The article matches `HARVEST_STUB_PREDICATE`
in `src/memory-service/ranking.ts: isHarvestStub` — `topic='pitfalls' AND source='orchestrator' AND
status='unverified' AND tags LIKE '% harvest %'` — the harvester's exact write signature. Commit
085183ff excludes that class from ranking surfaces in SQL, recording the reason: *"a single
distractor degrades an agent, and mis-selected prior experience has negative benefit."* Negative
benefit is grade -1 on this scale.

Two honest qualifications. First, this is the one rule resting on a repository **ruling** about a
class rather than on a per-pair event; the ruling's own words are quoted in every label so the panel
can audit it. Second, the ruling is narrower than it looks: the commit says *"The spawn index in
adapters/memory.ts is untouched and remains P13's call,"* and takes effect only on daemon restart.
The stubs are still injected today — 24 of the 30 rows in a live spawn injection are stubs — so they
remain legitimate pool candidates. R5 is applied only where the article was **not** harvested from
this brief's own episode; birth-linked stubs go to the panel instead.

## 5. What went to the panel, and why it is blind

**Residual: 780 pairs.** At three raters that is **2,340 judgments**.

Pool construction, so the panel's coverage is auditable: depth 6 from each of two rankers, unioned —
(a) the production token-overlap ranker over index rows, which is the system under test, and (b)
FTS5 bm25 over title and body, which sees the article text the production ranker never reads. Using
two systems means the pool can contain articles production misses; a single-system pool would make
the gold set unable to detect production's own blind spots. Each brief's own harvested memories are
force-included so the positives are actually present to be found.

`residual.json` carries, per pair: the full brief text, the rendered index row, and the article
title and body. No grade field, no rule, no provenance, no other rater's view. It is ordered so the
panel can label a prefix and stop at a coherent boundary: pairs against non-stub articles first
(the real knowledge, where the panel's judgment is worth most), stub pairs after.

**Withheld deliberately.** 98 residual pairs are birth-linked — the memory was harvested from that
brief's own episode — but carry no hard outcome marker, so history does not settle them. That link
is recorded in `derivation-audit.json` and is **kept out of `residual.json`**, because telling a
rater "this memory came from this task's own transcript" would steer the grade. After labelling,
that file becomes a validity check on the panel itself: if three vendors do not grade birth-linked
pairs measurably higher than matched controls, their agreement is measuring something other than
relevance.

## 6. Coverage, without inflation

| | pairs | share |
|---|---|---|
| derived from a recorded fact, with citations | 309 | 28.4% |
| residual, to the three-vendor panel | 780 | 71.6% |

Read that 28.4% with the qrel contract in mind: grade -1 is excluded from recall and useful-gain
and scores only into Harmful Exposure, and 249 of the 309 derived labels are -1. So the derived half
of this corpus contributes 3 grade-3 labels and 57 zeroes to any nDCG-style metric, and everything
else it knows lands in Harmful Exposure. Coverage of 28.4% is honest about how many pairs are
settled; it would be misleading as a claim about how much of the *ranking* signal is settled, which
is closer to nil.

These are two different measurements and the manifest keeps them in separate fields —
`coverage.settledPairs` (309/1089, 28.4%) and `coverage.settledRankingSignal` (60/1089, 5.5%) —
each carrying its own definition string, so an analyst who never reads this document still cannot
quote one as if it were the other.

Two ways the 28.4% could have been made to look better, and were not:

1. **Grading every birth-link 3.** 106 indexed articles name a live-window agent, so a "memory came
   from this task, therefore it is relevant to this task" rule would have derived roughly ten times
   as many positives. It was rejected: the only thing the birth-link establishes is that the
   harvester copied a line out of that transcript, and Section 3f shows it copies success reports.
   Those 98 pairs are residual.
2. **Seeding the 2 retired articles into all 90 briefs.** That alone would have added 168 derived
   labels and moved coverage from 28.4% to 40.4%. It is one defect counted ninety times. They are
   seeded into 4 briefs and flagged.

An over-claimed derived label is worse than a residual one, because the panel never re-examines it.

## 7. A finding about the store, not about this corpus

Everything above was measured while building a gold set, but the pattern it exposes is a property of
the memory store itself and outlives the corpus.

**This store records what went wrong far better than what helped.** Four independent measurements
say the same thing:

- 227 of the 311 rankable articles (73%) are quarantined auto-harvest stubs.
- 282 of the 306 rendered index rows (92%) are tagged `[pitfall]`; 24 are anything else.
- 249 of the 309 derived labels are grade -1; exactly 3 are grade 3.
- The harvester that produced most of the corpus cannot tell a failure from a success (Section 3f).

A memory system good at remembering damage and poor at remembering help is a specific, nameable
condition, and it has a mechanical consequence that is worth stating on its own.

**The injected index is brief-dependent within each class.** `buildMemoryIndex` puts pitfalls
before articles, then orders rows in each class by shared brief tokens and recency:

```
if (a.pitfall !== b.pitfall) return a.pitfall ? -1 : 1;
if (a.matches !== b.matches) return b.matches - a.matches;
```

Brief relevance (`matches`) is consulted within both classes. With 92% of rows tagged `[pitfall]`,
the pitfall-first budget policy can still exhaust the 30-row budget before any article is selected.
The `selectMemoryClasses` swap then replaces the last row with one non-pitfall article, producing
the 29:1 split when the base selection contains only pitfalls.

Two consequences for how the gold set gets used:

1. **The corpus composition and pitfall-first budget policy are what starve non-pitfall articles
   today.** Brief relevance ranks rows within each class, but it cannot change the class-first
   budget policy. Ranking quality and budget policy are separable problems and should be measured
   separately.
2. **The gold set measures ranking quality beyond the production budget policy.** Production
   personalises within each class, but nobody should read a nDCG improvement as a description of
   what agents receive today.

This section is a finding, not a caveat on a number. It also explains why the derived labels came
out the shape they did: derivation could only mine what the store recorded, and what the store
recorded is damage.

Coverage: only Section 7 was checked for this correction. The remainder of this document is
unverified.

## 8. The birth-link validity check — method, written before the numbers exist

This section is prespecified on purpose. It was written while the panel was still labelling, so that
what counts as passing could not be chosen after the results were seen. Anyone may execute it; you
do not need to have been here.

### 8.1 The claim under test

Three vendors sharing training corpora also share failure modes, so their agreement is not
independence. The check asks whether their agreement tracks *relevance* or merely tracks each other:

> If the three vendors do not grade birth-linked pairs measurably higher than matched controls,
> their agreement is measuring something other than relevance, and **no metric should be wired to
> the panel's output until it passes.**

### 8.2 How the holdout is represented, and why it must stay out of `residual.json`

A corpus built by this method needs an analysis-only derivation audit listing the 98 birth-linked
pairs under `birthLinkedResidualPairs`. A birth-linked pair is one where the memory was
auto-harvested from an episodic event belonging to *that brief's own agent* — recoverable from the
article's frontmatter `evidence:` line, which names the agent uuid and event id.

The pairs themselves are in `residual.json` and were graded by the panel like any other. What is
withheld is the *fact of the link*. **Do not merge the audit file into the residual, and do not
annotate residual pairs with their provenance.** Telling a rater "this memory came from this task's
own transcript" would steer the grade, and a steered grade cannot then be used to test whether the
raters were tracking relevance. The holdout is the instrument; merging it destroys the instrument.

### 8.3 The confound — the holdout is a weak positive signal, not ground truth

A birth-link proves one thing only: the harvester copied a line out of that task's transcript. It
does not prove a pitfall occurred. The harvester demonstrably files success reports as pitfalls —
Section 3f documents one whose entire cited "failure" reads *"Acknowledged DONE ... no
acknowledgement failures."* That is exactly why these pairs were **not** graded 3 by rule and were
sent to the panel instead.

So expect a *weak* positive effect if the panel is healthy, not a large one. A large effect would be
as suspicious as no effect: it would suggest raters are keying on transcript-echo phrasing rather
than judging usefulness.

### 8.4 The control group does not exist yet — measured, with the cost of fixing it

**Read this before planning the run.** The obvious design — compare each birth-linked pair against a
same-brief, same-tier pair the panel also graded — **cannot be executed against the corpus as cut.**
Measured:

| | pairs |
|---|---|
| residual pairs that are quarantined stubs | 98 |
| ...of those, birth-linked | **98** |
| ...of those, NOT birth-linked | **0** |
| residual pairs that are non-stub articles | 682 |

Rule R5 graded every non-birth-linked stub -1 as derived, which removed exactly the population that
would have served as the tier-matched control. The rule and the check were designed independently
and collided; this is a defect in my construction, not in the panel.

**The fix, and its price.** 239 R5-derived pairs exist and were never shown to the panel. 39 briefs
hold both a birth-linked pair and at least one R5 pair (median 3 R5 candidates per brief, range
1-6). Asking the panel to grade a control sample drawn from those, blind and interleaved
indistinguishably with ordinary pairs, restores the design:

> **68 pairs gives 1:1 within-brief matching** — about 204 extra judgments at three raters, roughly
> 9% more panel work.

The prescribed second batch is **88 pairs** — 68 controls (one R5 pair per birth-linked pair per
brief, across 39 briefs, chosen deterministically by sorted `memoryId`) plus **20 filler pairs**
drawn from non-stub articles not previously pooled. The filler exists only so the batch is not
visibly homogeneous; batch 1 was 682 non-stub then 98 stub, and an all-stub batch 2 would be a
change in character a rater might notice. **The filler pairs are not controls and must be excluded
from the analysis** — the derivation audit must list them separately under
`controlBatch.fillerPairs`.

The file carries the same six fields, the same `pairId` format and the same ordering discipline as
`residual.json` (non-stub block first, then stub, each by brief `createdAt` then `memoryId`), holds
no grade, rule or provenance key, and has no explanatory header — a rater who could tell which pairs
are the instrument would not be a control. Which pairs are controls is recorded in
`derivation-audit.json` under `controlBatch`, which is analysis-only and must never be shown to a
rater.

One number to be honest about: 20 filler brings batch 2 to 23% non-stub against batch 1's 87%. It is
less homogeneous, not proportionally matched — matching batch 1's shape would take roughly 460
filler pairs.

**That composition gap is a decision, not an oversight.** 460 filler pairs is about 1,380 extra
judgments, which would make the control batch more than five times the size of the thing it
controls. But cost is the smaller half of the reason: **proportion is the wrong target.** The blind's
job is not to make batch 2 resemble batch 1. It is to stop a rater identifying *which pairs are
controls*. At 100% stub the batch announced itself as a targeted set; at 23% non-stub it no longer
does, and within the stub block a rater still cannot tell a control from an ordinary stub — which is
the property that actually matters. A second batch drawn from what remains after a first pass would
naturally differ in composition anyway; that is unremarkable rather than suspicious. The goal was a
mixed batch that does not announce itself, not a statistical twin.

### 8.4a The blind is real but not airtight

This section is public on `main`. It names the holdout, the control batch, and
`residual-batch-2.json` by filename, in every rater's worktree. A rater who chose to read it could
therefore have known the batch's purpose. **The check rests on rater incuriosity rather than on
enforced blindness, and a positive result is weaker evidence than a fully blinded one would be.**
Any report using this check must say so in those words.

This was accepted knowingly rather than overlooked. The alternative — briefing an 88-pair payload
inline through three mail messages — would deliver batch 2 by a different channel than batch 1,
which is a louder signal than anything inside the file. And the method was landed publicly on
purpose, so that it would survive a daemon restart and be executable by someone who was not here;
obscuring it now to protect the blind would destroy the property the document exists for. An
acknowledged imperfect blind beats a hidden procedure.

What the imperfect blind still catches: three vendors agreeing for reasons unrelated to relevance.
What it cannot rule out: a rater who deliberately read the design and graded to it.

Label those 68 before concluding anything. If a vendor has already finished, its control batch is a
second blind batch; that preserves independence, but the batches must not be distinguishable to the
rater and the rater must not be told why.

### 8.5 The matching procedure

Tiering is the part that gets done wrong, so it is spelled out. **Tier is not a judgement**: it is
`memories.json[].quarantinedHarvestStub`, precomputed from the predicate in
`src/memory-service/ranking.ts: isHarvestStub` (topic `pitfalls` AND source `orchestrator` AND status `unverified` AND
a `harvest` tag). Do not re-derive it by eye, and do not substitute `status: unverified` — most
rescued canonical articles are unverified too, and that substitution is the specific mistake commit
085183ff warns about.

1. Take the 98 pairs in `derivation-audit.json.birthLinkedResidualPairs`. Resolve each
   `memoryId` (an `articleId`) to its `memories.json` `id` before joining to `residual.json`; the
   two files key differently and this is the first thing a re-implementer gets wrong.
2. For each, record its brief, its tier, and its panel consensus grade.
3. Find its control: **same brief, same tier, not birth-linked.** After §8.4's control batch is
   labelled these come from that batch. Where a brief offers several, take them all and use the
   brief's control mean, so a brief with six controls does not outvote one with a single control.
4. A birth-linked pair with no same-brief control is **excluded from the paired analysis and
   reported as unmatched with its count.** Do not fall back to a cross-brief match: brief identity
   is the only thing holding topic, vintage and pool composition constant, and a looser match buys
   n at the cost of the thing being controlled for.
5. Report matched n, unmatched n, and the tier composition of both arms alongside the result. A
   result quoted without its n is not a result.

Panel consensus grade = the **median** of the three vendor grades, not the mean: the scale is
ordinal, and a median is not dragged by one vendor's outlier.

### 8.6 What counts as passing — fixed in advance

Comparison: the **per-brief paired difference** (birth-linked consensus grade minus that brief's
control mean), across matched briefs.

- **PASS** — median paired difference **> 0**, i.e. birth-linked pairs graded strictly higher, and
  the direction holds in a clear majority of matched briefs. With n likely in the 20-40 range, treat
  a Wilcoxon signed-rank p-value as *descriptive support*, not as the criterion. Report it; do not
  hinge on it.
- **NULL / FAIL** — median paired difference **≤ 0**, or the sign splits near evenly across briefs.
  This is the outcome that blocks wiring metrics to the panel: it says the vendors' agreement is not
  tracking the one provenance signal we can verify independently.
- **SUSPICIOUS PASS** — a large effect (median difference ≥ 2 grades) is *not* a clean pass. Per
  §8.3 the true signal should be weak; a large one suggests raters keying on transcript-echo
  phrasing. Investigate before accepting.
- **UNDERPOWERED** — matched n < 15. Report the direction, state that it is not a test, and do not
  let it license wiring metrics either way.

Also report **inter-vendor agreement separately on the two arms**. If agreement is high on both but
the arms do not differ, the vendors are agreeing with each other about something that is not
relevance — which is precisely the failure this check exists to catch, and it is invisible in a
headline agreement number.

### 8.7 If the control batch is never labelled

A degraded, one-sided test remains: compare birth-linked stub pairs against **non-stub** residual
pairs in the same brief. The tier confound runs *against* the hypothesis, because non-stub articles
are real curated knowledge and stubs are ruled negative-benefit. Therefore:

- birth-linked stubs scoring **higher** than same-brief non-stub articles is meaningful support,
  since it clears a handicap;
- birth-linked stubs scoring **lower** is **inconclusive, not a failure** — tier alone predicts it.

Say which of §8.6 and §8.7 was run. They do not license the same conclusions, and a report that does
not say which was used cannot be interpreted.

### 8.8 The result

The check ran complete on 2026-08-05 with all three raters and both batches: 868/868 panel rows
carrying three grades, 166/166 pairs in the two arms fully graded.

**VERDICT: NULL / FAIL.** Median paired difference **+0.000**; the direction holds in 12 of 39
matched briefs (31%), meaning it points the wrong way in most of them.

Per-rater, **0 of 3 pass**:

| rater | verdict | median | direction holds |
|---|---|---|---|
| cadence | NULL / FAIL | +0.500 | 56% of 39 briefs |
| cato | NULL / FAIL | +0.250 | 51% |
| craig | NULL / FAIL | +0.000 | 0% |

Three independent failures across three visibly different calibrations. On the same 68 controls,
craig graded 65 harmful, cato 4, cadence none. cadence discriminated most — and 56% still falls
below the 60% majority bar §8.6 fixed before any label existed. That bar is not moved here; a
threshold adjusted once the data is in is not a threshold.

**The per-arm agreement comparison was computed** (its first opportunity — it needs three grades):
birth-linked arm **0.490**, control arm **0.695**. Agreement is *higher on the controls*. The raters
are more consistent with each other about pairs carrying no provenance signal than about pairs that
carry one. A median difference alone cannot see this, which is why §8.6 requires it reported
separately.

`gainSideMetricsPermitted` resolved to **false** by the encoded rule, not by anyone's judgement
after the fact. Harmful Exposure only, on the 249 cited derived -1 labels; no gain-side metrics.

**What this does not settle.** §8.3 predicted a weak effect, because a birth-link only proves the
harvester copied a line out of that transcript and it demonstrably copies success reports. A NULL is
equally consistent with the holdout being too weak to measure with. **This instrument cannot
separate "the panel is not tracking relevance" from "the birth-link is not a relevance signal."**
That limit belongs to the design in this document and is stated here rather than left implied by a
verdict line. Resolving it needs a small user-labelled calibration subset; nothing else will.

**What survives the NULL.** The verdict condemns the panel's *consensus* as gain-side ground truth.
It does not condemn the corpus: 90 briefs with 6 real negative tasks, 311 rankable memories, 309
cited derived labels, three vendors' grades preserved unaveraged, a disagreement set, and a
populated Harmful Exposure instrument all stand.

## 9. Which coverage number to quote, and why the wrong one misleads

Recorded here because it has already caused one error in a report, and a correction that lives only
in a mailbox does not survive its author.

`coverage.settledPairs` = **309/1089, 28.4%**. Pairs carrying a derived label. This is the honest
answer to *"how much does the panel not have to judge?"*

`coverage.settledRankingSignal` = **60/1089, 5.5%**. Derived labels that reach a gain-side metric at
all: 3 grade-3 plus 57 grade-0. The qrel contract excludes grade -1 from recall and useful-gain and
scores it only into Harmful Exposure, and 249 of the 309 derived labels are -1.

Quoting 28.4% in a ranking context **overstates the settled signal by roughly five times.** The two
live in separate manifest fields, each with its own `definition` string, so that a reader who never
opens this document cannot collapse them into one number. In a ranking report the correct headline
is `settledRankingSignal`; `settledPairs` belongs in a discussion of panel cost.

## Reproducing this

Every number above came from read-only queries against the live databases named in Section 1 and
from files in `.hive/memory`; the derivation did not mutate the memory store or the daemon. To run
the harness, assemble the corpus in a directory and pass it explicitly with
`hive memory rank-evaluation <directory>`. Its `gold-set.json` must carry a `corpusSnapshot`
identifier covering the article contents, source revision and source database identity so the
judgments cannot silently move to a different corpus.

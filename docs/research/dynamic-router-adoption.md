# Adopting models Hive has never heard of

*Design only. Nothing here is built. Measured against the live catalogs on 2026-07-12, claude 2.1.207 / codex-cli 0.144.1.*

The user's requirement: **"the router needs to be DYNAMIC. We are not going to re-release every time a new model comes out. Hive should be able to DETECT it and USE it where it is appropriate."** And the policy that governs it: **"we choose the CORRECT MODEL FOR THE JOB and we don't put substandard or uncapable models in because they are cheap."**

Those two pull against each other, and the whole design is in how the tension is resolved. Adopting a model automatically means placing it *before anyone has seen it work*. Placing it wrong means his real work runs on a model that cannot do it, and he may never learn it was the router's doing.

## 1. What the vendors actually declare

Walked off the live wire, not from memory. This is the complete field set, and the omission at the end is the finding.

**Claude** (`initialize` → `models[]`): `value`, `resolvedModel`, `displayName`, `description` (prose), `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`.

**Codex** (`model/list` → `data[]`): `id`, `model`, `displayName`, `description` (prose), `hidden`, `supportedReasoningEfforts` (objects: level + prose description), `upgrade`/`upgradeInfo`/`availabilityNux` (all null on this account).

**Plus, from the billing surface:** whether the vendor gives the model its own `model_scoped` pool — proven earlier to mean *the provider itself meters this model as heavy*. That is the single strongest capability signal either vendor emits, and it is emitted by the accounting system rather than the catalog.

**NEITHER VENDOR DECLARES CAPABILITY.** There is no `codingCapable`, no capability class, no tier, no rank, no ordering. The only fields that gesture at strength are `description` — free prose, e.g. *"Frontier model for complex coding, research, and real-world work"* and *"Opus 4.8 with 1M context · Best for everyday, complex tasks"*.

**That is the finding, and I will not paper over it.** Parsing `description` to place a model is inference-from-names wearing a longer sentence: it is the exact crime we spent tonight deleting (`FABLE_AUTO_ROUTING_CUTOFF`, `CLAUDE_BEST_MODEL`), and it is worse here because the string is vendor *marketing* rather than a vendor *fact*. `codingCapable` in the manifest is, and will remain, **a human's declaration** — the vendors give us nothing to derive it from.

So a predicate over vendor-declared attributes can honestly do exactly one thing: **shortlist**. It can say *this model is not a candidate* (hidden, unentitled, no effort ladder). It cannot say *this model is good enough for deep work*, because nothing it can read makes that claim.

## 2. The predicate, and what it is allowed to decide

A tier stops being a roster and becomes a filter — but a filter over **eligibility only**, never over **preference**:

```toml
[tiers.deep]
# ELIGIBILITY — machine-checkable, vendor-declared, safe to evaluate automatically.
requires.entitled          = true        # present in the account's catalog
requires.hidden            = false       # codex declares it; claude is silent → unknown → EXCLUDED
requires.effortCeiling     = "xhigh"     # advertises at least this level
requires.codingCapable     = true        # DECLARED BY A HUMAN. No vendor emits this.
# PREFERENCE — not derivable. Stays an ordered list.
prefer = ["claude-fable-5", "claude-opus-4-8"]
```

The split is the design. **Eligibility is a predicate; preference is a judgment.** Today's ordering (Fable before Opus for deep) encodes a human's belief that one is better for the job; no declared attribute implies it, and a predicate that invented an order — by effort-ceiling, by pool size, by recency — would be guessing with extra steps.

## 3. Does it reproduce today's table?

**Yes, exactly — because the ordered `prefer` list survives.** The predicate only decides who *may* enter; the list decides who *does*. Every cell of today's table is byte-identical, which is the same trick that made the flip provably safe: a mechanism that changes nothing on adoption is a mechanism whose adoption cannot break anything.

A pure predicate — eligibility with no list — does **not** reproduce it. Today, `claude-sonnet-5` satisfies every declared requirement deep could state (entitled, not hidden, xhigh/max, declared coding-capable). A predicate-only deep tier would admit Sonnet as a deep candidate, and quota pressure could then downshift his hardest work onto it. That is precisely the "substandard because cheap" failure he forbade, and it is what a naive reading of "make tiers predicates" produces.

## 4. A genuinely new model, worked through

`gpt-5.7` appears in `model/list` tomorrow. Hive knows: entitled, `hidden: false`, efforts `low…ultra`, `description: "Our most capable model for agentic coding"`, and — after the first billing read — whether it got its own metered pool.

- **Eligibility**: it clears every machine-checkable gate.
- **Capability**: unknown. `codingCapable` is absent, and absent means unknown, and unknown means **excluded**. The description is not evidence.
- **Therefore it is not routable**, and it is not silently ignored either: it raises **one approval** (§6).
- **Except in one case**, which is the only confident automatic placement I can defend: **the vendor makes it the account's effective default** (`config/read` for Codex; the menu's `default` entry for Claude). That is not an inference from a name — it is the vendor declaring *this is what you get when you ask for nothing*, and Hive's fallback ladder already trusts exactly that signal at rung 2. A new model that becomes the account's default may be adopted automatically **into the cells the previous default occupied**, like for like, and he is told after the fact.

## 5. Adopt automatically, or ask?

The rule that keeps the policy intact:

> **Automatic in the safe direction. Ask in the risky direction.**

- **Automatic — removal and degradation.** A model that vanishes from the catalog, becomes unpayable (tonight's `poolAvailability`), or starts failing is dropped from candidacy with no ceremony. Removing a model can never route his work onto something *worse than he asked for*; it can only fall back to a candidate that already cleared the floor. This is the auto-heal he asked for, and it already exists.
- **Ask — adoption and promotion.** Adding a candidate, or moving one ahead of another, can lower quality, and no vendor-declared fact rules that out. One approval, once, remembered.
- **Never — auto-adopt into a chain a quota downshift can reach.** An auto-adopted model that is only ever a *last* candidate is still a model his work lands on under pressure. There is no safe "just add it at the end".

Build on what exists: abel's quota work already quarantines auto-adoption on a provider whose model-scoped pool cannot be bound to a model. Same concept, same queue, same word — *auto-adoption is quarantined until a human clears it* — rather than a parallel mechanism.

## 6. What the recommendation looks like

Every fact carries its evidence class. They are never blended into one confident sentence, because the whole point is that they are not equally trustworthy.

```
NEW MODEL DETECTED — gpt-5.7 (Codex).  Route it? [deep] [standard] [cheap] [review] [never]

VENDOR-DECLARED, measured on your account just now      ← may act alone; only ever to ADD above the floor
  entitled            yes (present in your catalog)
  hidden              no
  effort levels       low, medium, high, xhigh, max, ultra
  metered separately  YES — the vendor gives it its own pool, i.e. it meters it as heavy
  coding-capable      NOT DECLARED BY ANYONE. No vendor publishes this field.

VENDOR'S OWN DOCS (openai.com)                          ← advisory. The vendor's marketing about its own product.
  "Our most capable model for agentic coding."  [model card, retrieved 2026-07-12]

BENCHMARKS                                              ← advisory. A claim with a provenance, not a measurement Hive made.
  Terminal-Bench 2.1   83.4%   run by: <who>  retrieved: <when>  agentic: YES — CLI, long-horizon
                       contamination: unknown — no held-out set published
  SWE-bench Verified   95.0%   run by: <who>  retrieved: <when>  agentic: YES — multi-file repo patching
  (LiveCodeBench and single-turn code-generation scores are EXCLUDED: they do not
   measure what Hive does, and a high number on an irrelevant benchmark wins an
   argument it should not be in.)

YOUR OWN RESULTS ON YOUR OWN REPO                       ← ground truth. Beats everything above the moment it exists.
  no history yet — this model has never run here.
```

As his telemetry accumulates, that last block moves to the top and the two advisory blocks shrink to a footnote. **The web is the cold-start prior; his own repo is the authority.**

## 7. The injection surface, and how it is closed

A fetched page that can move a route is a page that can *attack* a route — pointed straight at the thing that executes code in his repo. A stale constant cannot be written by an attacker; a blog post can.

The paths, and the closures:

1. **Fetched text reaching an agent's acting context.** Closed by never putting fetched prose into a prompt that holds tools. The fetcher extracts into a **typed struct** (`{benchmark, score, ranAt, source, methodologyUrl}`) and everything that fails to parse is dropped, not summarized.
2. **Fetched text reaching the user as persuasion.** Closed by rendering only typed fields — never model-authored prose *about* the page. Quoted vendor copy is shown as a quotation, attributed, and clearly marked class 2.
3. **A page naming a model into existence.** Closed structurally, and this is the important one: **the routable set is always `discovery ∩ approved`.** A page cannot introduce a model his account cannot launch, because a model that is not in his live catalog is not a candidate no matter what any document says. Web evidence can only ever reorder a human's opinion about models he already has.
4. **A page influencing a route without a human.** Closed by rule: **web evidence recommends; it never routes.** The only thing a fetch can produce is a row in an approvals queue.
5. **Domain trust.** Class 2 is an allowlist of vendor domains. Class 3 carries the source domain visibly, and is assumed adversarial.

## What Hive already measures, and the part it does not

**It already records, per model:** launch outcome past the transport (shadow log: `launched`/`failed` + reason, keyed to the exact model), terminal agent status (`done` / `dead` / `failed`), `recoveryAttempts`, `stuck`, context burn and usage units per event, and quota consumption per model. That is a real, private, ungameable signal about **reliability**, and no leaderboard can compete with it.

**It does not record quality.** Nothing counts an escalation (established while grading the flip criteria — "escalation" is prompt wording, nothing increments a counter). Nothing records whether the work **landed**, whether it was **reverted**, whether review found defects in it, or whether a human had to redo it. So today's telemetry can tell you a model *crashed, hung, or needed rescuing* — it cannot tell you the model *was wrong*, which is the failure the user actually fears ("a cheap model that produces wrong work is not a saving; it costs him a whole task and he may not notice").

**The missing signal is one join away.** `hive_land` already performs the merge and knows the agent; recording *landed / abandoned / reverted* per agent — and therefore per model — would turn the reliability signal into a **quality** signal, and it is the single highest-value telemetry Hive could add. It is the thing that would let his own repo out-rank every benchmark on the internet, which is where the authority belongs.

## Open, and I am not closing them by guessing

- **Preference order has no derivation.** Eligibility is a predicate; ranking is a judgment. Until landed-work telemetry exists, the order is a human's, and pretending otherwise would be the same guess in a new place.
- **Two floors exist and only one is implemented.** `codingCapable` ("can it code at all") is enforced. The user's standing floor — *nothing below `claude-opus-4-8` / `gpt-5.6-sol` does building work* — is not, and the Claude columns of `standard` and `cheap` currently sit beneath it.
- **A vendor could make a model unrunnable in a way no surface reveals** (pool silently removed, model left in the catalog). Two of the three plausible shapes are handled; the third is undetectable, and the launch simply fails.

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
- **Therefore it is not routable**, and it is not silently ignored either: it raises **one question to the user** (§6).
- **Except in one case**, which is the only confident automatic placement I can defend: **the vendor makes it the account's effective default** (`config/read` for Codex; the menu's `default` entry for Claude). That is not an inference from a name — it is the vendor declaring *this is what you get when you ask for nothing*, and Hive's fallback ladder already trusts exactly that signal at rung 2. A new model that becomes the account's default may be adopted automatically **into the cells the previous default occupied**, like for like, and he is told after the fact.

## 5. Adopt automatically, or ask?

The rule that keeps the policy intact:

> **Automatic in the safe direction. Ask in the risky direction.**

- **Automatic — removal and degradation.** A model that vanishes from the catalog, becomes unpayable (tonight's `poolAvailability`), or starts failing is dropped from candidacy with no ceremony. Removing a model can never route his work onto something *worse than he asked for*; it can only fall back to a candidate that already cleared the floor. This is the auto-heal he asked for, and it already exists.
- **Ask — adoption and promotion.** Adding a candidate, or moving one ahead of another, can lower quality, and no vendor-declared fact rules that out. One approval, once, remembered.
- **Never — auto-adopt into a chain a quota downshift can reach.** An auto-adopted model that is only ever a *last* candidate is still a model his work lands on under pressure. There is no safe "just add it at the end".

Build on what exists: abel's quota work already quarantines auto-adoption on a provider whose model-scoped pool cannot be bound to a model. Same concept, same queue, same word — *auto-adoption is quarantined until a human clears it* — rather than a parallel mechanism.

## 6. What Hive asks him, and what it never decides

**Hive is not in the business of model judgment.** It does not score models, rank them, consult the internet, read benchmarks, or form an opinion about which model is better. It cannot do that job well, and every attempt would be a claim wearing a measurement's clothes — the exact failure this whole line of work exists to end.

There are **two sources of truth, and no third**:

1. **What the vendor declares**, read live off the surface. Facts. No judgment required to read them.
2. **What the user decides.** He is the judge of models. Hive is not.

So the whole of adoption is: **Hive detects the model, shows him what the vendor declares, and asks where it belongs. He answers once. Hive remembers it and routes on it forever** — no re-release, no manifest publish, no rebuild. The detection and the plumbing are Hive's; the judgment is his. That is fully dynamic, and Hive never grades anything.

```
NEW MODEL DETECTED — gpt-5.7 (Codex), first seen 2026-07-13 09:14.

WHAT THE VENDOR DECLARES (read from your account just now):
  entitled            yes — it is in your catalog
  hidden              no
  effort levels       low, medium, high, xhigh, max, ultra
  metered separately  YES — the vendor gives it its own pool, so it meters it as heavy
  vendor default      no  (your unflagged launch is still gpt-5.6-sol)
  coding-capable      the vendor does not publish this. Nobody has said. That is why you are being asked.

WHERE DOES IT BELONG?   [deep] [standard] [cheap] [review] [never] [not yet — ask me again later]
```

No score. No recommendation. No prose from Hive about whether the model is any good. The card is the vendor's facts and one question.

**The one thing Hive may adopt without asking is a rank the VENDOR declares.** An alias like `best`, an `isDefault`, an explicit ordering, or the account's effective default (`config/read`; the menu's `default` entry) is *the vendor's judgment*, and passing it through is honest reporting rather than Hive opining. So when the vendor promotes a new model to be the account's default, Hive may take it into the cells the previous default occupied — like for like — and tell him after the fact. When the vendor declares nothing that places a model, **Hive asks. It does not guess, it does not score, and it does not consult the internet.**

And because nothing in the routing path ever fetches a web page, **there is no prompt-injection surface here to defend.** A feature that cannot be attacked beats one that is defended.

## 7. What Hive may still report: what it saw, never what it thinks

Hive already records, per model, facts it observed on his own repo: launch outcome past the transport (the shadow log, keyed to the exact model), terminal status (`done` / `dead` / `failed`), `recoveryAttempts`, `stuck`, context burn, and quota consumption.

That is **measurement, not judgment** — Hive reporting what happened, not deciding what is good — so it is allowed. Two rules keep it that way, and they are not optional:

- It is **shown to him**, never acted on. It must never silently re-rank his routing. Even here, he decides.
- It is reported as **what happened**, not as a verdict: *"3 of 4 deep spawns on this model failed to launch"*, never *"this model is unreliable"*.

**And be honest about what it does and does not measure.** These signals capture **reliability**, not **quality**. They can tell him a model crashed, hung, or needed rescuing. They cannot tell him the model produced **wrong code**, which is the failure he actually fears — *"a cheap model that produces wrong work is not a saving; it costs him a whole task and he may not notice."* Nothing counts an escalation; nothing records whether the work **landed**, was **reverted**, or was **redone**.

That missing signal is one join away: `hive_land` already performs the merge and knows the agent, and therefore the model. Recording *landed / abandoned / reverted* per agent would turn reliability telemetry into quality telemetry. Not to be built now, and not to be designed out — but note that even then it stays a **report to him**, never an input that re-ranks his routes behind his back.

## Open, and I am not closing them by guessing

- **Preference order has no derivation.** Eligibility is a predicate; ranking is a judgment, and the judgment is his. Where the vendor declares a rank, Hive passes it through; where it does not, Hive asks.
- **Two floors exist and only one is implemented.** `codingCapable` ("can it code at all") is enforced. The user's standing floor — *nothing below `claude-opus-4-8` / `gpt-5.6-sol` does building work* — is not, and the Claude columns of `standard` and `cheap` currently sit beneath it.
- **A vendor could make a model unrunnable in a way no surface reveals** (pool silently removed, model left in the catalog). Two of the three plausible shapes are handled; the third is undetectable, and the launch simply fails.

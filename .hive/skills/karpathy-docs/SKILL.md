---
name: karpathy-docs
description: Maintain this project's Karpathy-style living documents (SPEC.md and any doc in that voice). Use when a design or architecture decision is made or changed, a feature lands that shifts the roadmap, an open question gets resolved, or a new long-form document is being written — covers both updating existing docs and writing new ones in the same style.
---

# Karpathy-style living documents

SPEC.md is the design source of truth for this project. It is written in a specific voice and maintained by specific rules. This skill defines both. Any new long-form document in this repo (design docs, postmortems, deep-dive READMEs) follows the same rules.

## The style

A Karpathy-style document is a reasoned essay, not a reference manual:

- **Thesis first, in plain language.** What the thing is and why it exists, before any architecture, structure, or terminology. A reader who stops after the opening section should still know what's being built and why it matters.
- **Reasoning, not verdicts.** Every decision states four things: the choice, the alternatives actually considered, why this one won, and what it gives up. A decision recorded without its losing alternatives is a verdict — rewrite it.
- **Lean and linear.** Readable start to finish in one sitting. Prose over bullets except where enumeration is real. Minimal header nesting. No decision matrices, no glossaries, no boilerplate sections that exist because templates have them.
- **Honest.** Open questions, deferred bets, and risks get named explicitly in their own section, with the real downside stated. "We assume X and haven't proven it" beats silence. If the whole idea has an existential risk, the doc says so.
- **Plain language.** No marketing adjectives, no hedging, no passive voice hiding who decided what. Explain from first principles; a smart reader outside the project should be able to follow.

## Management rules

- **Edit in place, never append.** No "Update (July):" sections, no changelog residue, no strikethrough. The doc always reads as if it were written today, in one sitting. Git history is the changelog.
- **When a decision changes, the old choice becomes a rejected alternative.** Rewrite the section so the new decision is the conclusion of the reasoning — and preserve the previously chosen option in the alternatives, with an honest account of why it lost. Superseded reasoning is the most valuable content in the doc; deleting it condemns the project to re-litigate it.
- **When an open question is resolved, remove it** from the open-questions section and fold the answer into the section it belongs to. The open-questions list must only ever contain genuinely open items — a stale entry there erodes trust in all of them.
- **Keep it lean as it grows.** New content earns its place by changing what a reader would do or believe. When a section accumulates detail that no longer meets that bar, compress it. The doc getting longer over time is the default failure mode; fight it.
- **One source of truth per concern.** Don't duplicate SPEC.md content into other docs — link or reference the section. If two docs disagree, that's a bug: fix whichever is wrong in the same turn you notice.

## When to update (do it in the same turn as the triggering work)

- A design or architecture decision is made, changed, or reversed — including decisions made implicitly during implementation.
- Implementation reveals the spec was wrong or incomplete. Surface the contradiction to the user, then fix whichever is wrong.
- A roadmap item completes or moves phases (e.g. a v1 item ships, or gets deferred to v1.1).
- An open question gets answered, or a new genuinely-open one appears.
- A deferred bet resolves — the risk materialized or it didn't; say which.

## Utilization

- **Read SPEC.md before any design or architecture work.** Its decisions are binding unless the user changes them; don't re-open settled questions without new information, and cite the relevant section when a decision constrains implementation.
- When the user asks a "why is it built this way" question, answer from the doc's reasoning (and if the doc can't answer it, that's a gap — fix the doc).
- New long-form docs start from the thesis, not from a template.

## Checklist before finishing any doc edit

1. Does it still read linearly, start to finish, in one voice?
2. Is the thesis still true and still first?
3. Any changelog residue ("now", "previously", "as of", "Update:")? Remove it.
4. Does every decision still carry its alternatives and its cost?
5. Is the open-questions section honest — nothing stale, nothing papered over?
6. Did the edit make the doc leaner or at least not fatter without cause?

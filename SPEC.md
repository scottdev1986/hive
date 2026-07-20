# hive

> **Authority, 2026-07-20.** This document is again the single authoritative top-level design doc for Hive: it states the vision, the architecture in outline, and the milestone boundaries. Subsystem detail lives in the design docs under `docs/` (contracts, daemon, ADRs, agents, routing, providers, terminal, workspace) and in `planning/`; SPEC points at them by name and section and does not duplicate them. Where the two disagree about a *decision*, SPEC is authoritative and the design doc is to be corrected; where they differ in *depth*, the design doc is the detail and SPEC is the ruling.
>
> This refresh **ends the interim state** in which SPEC.md was treated as historical and the design docs were treated as authoritative pending a rewrite. Everything below is current as of 2026-07-20 unless a section says otherwise. Decisions that were true in the previous SPEC and remain true are carried forward under their original numbers with a carried-forward note; decisions that have been superseded are listed in the [superseded-decisions appendix](#appendix-a--superseded-decisions) rather than deleted, because a decision that vanishes silently gets re-made.

## The vision

**Hive is building a custom terminal so that Hive can be integrated *into* that terminal.**

Every other orchestrator watches its agents from outside — through hooks that fire when a vendor chooses to fire them, through transcripts written after the fact, through screen scrapes that guess. Hive owns the terminal the agent runs in, so it can see what is actually on the wire.

The point of owning the terminal is **omniscience about what is happening in a TUI**:

- If the agent is **asking a question**, Hive knows.
- If the agent has **stopped working when it should be working**, Hive knows.
- If the agent has hit a **vendor cybersecurity or safety stop**, Hive knows.

And in each case Hive gets the user's attention so a human can handle it. An agent blocked behind a question nobody sees is an agent that has silently stopped; that failure is the reason the terminal is being rebuilt rather than adapted.

The second half of the vision is **the agent factory**. M2 rebuilds agent spawning and agents themselves into a factory, so that adding a new TUI — Kimi Code, opencode, whatever ships next quarter — is exactly two steps: *do the research, build the factory entry*. Not a new pipeline, not a new adapter subsystem, not a per-vendor fork of the spawn path. Vendor neutrality stops being a claim about how many vendors we happen to support and becomes a property of the spine.

Everything in the milestone plan below serves those two things: a terminal Hive can see through, and a factory that makes seeing through it cheap for every new agent.

## What this is

You `cd` into a project and type `hive claude`, `hive codex`, or `hive grok`. The Workspace app opens with the selected AI orchestrator — **queen** — in its master terminal pane, scoped to that folder. You talk to it like a tech lead: "build this feature," "figure out why the tests are flaky," "have Codex take a second look at the auth code." It doesn't write the code itself. It decomposes the work, spawns agents — Claude Code here, Codex there, big model for the hard part, cheap model for the changelog — and each agent appears in a terminal pane where you can watch it work and type into it. Agents talk to each other when they need to, regardless of vendor. When the work is done, it gets merged, and the panes go away.

What separates this from a demo is the safety and control stack: **quota-aware routing that durably reserves subscription-CLI capacity before spawning, durable peer delivery with critical controls that mechanically revoke authority rather than politely request compliance, an orchestrator that physically cannot write, and a rebase→verify→fast-forward-only landing protocol that makes "the tests and the typechecker passed on exactly what main now is" structural.** Worktrees, terminals, sandboxes, panes are table stakes we build because we must; the control plane over cross-vendor agents is the product — and, from this rebuild forward, the terminal is part of that control plane rather than a window we borrowed.

The strategic read is unchanged and stated honestly: several parties could close this gap — a vendor shipping cross-vendor teams, or an existing orchestrator growing a real control plane. The defensible ground is the safety stack plus vendor neutrality, which is why the agent factory (M2) is a milestone rather than a refactor. macOS only, by choice, for now.

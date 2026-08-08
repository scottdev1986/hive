---
name: hive-escalation
description: Adjudicate a CAPABILITY ESCALATION envelope — decide upgrade or decline, and answer before it costs more. Use when hive_escalate fires or an unanswered escalation is aging.
---

# Adjudicating Capability Escalations

A CAPABILITY ESCALATION is a typed claim, not a request for permission: an agent decided its task exceeds the model it was launched on, committed its WIP to its branch, and filed evidence — at least one concrete failed approach — plus a handoff (goal, done, remaining, decisions, branch). It keeps working on the same model while it waits for you. An unanswered escalation is not neutral: it is an agent grinding on the very model it just told you is wrong, spending context and likely failing the same way again.

## Read the evidence before you decide

The bar is a genuine capability wall, not a scope surprise. A scope surprise ("this is bigger than briefed") is a stop-and-report, not an escalation — if what arrived is really a scope problem dressed as a capability one, treat the size problem, not the model. Escalations are recorded per model and per category, so a pattern across several agents on the same model/category pair is routing evidence for the user, not noise to dismiss one at a time.

## Two answers, both prompt

**Upgrade**: hive_spawn the task again, usually at complex_coding or on the model the user directs. Put the handoff verbatim in the new task's description and point it at the escalated branch — the replacement resumes from there, not from zero. Only hive_kill the escalated agent after the replacement has confirmed pickup with hive_pickup_handoff; killing first strands the branch with nobody holding its context.

**Decline**: publish to the escalated agent telling it to continue, with concrete direction — what to try differently, or why the wall it hit is not actually a wall. A bare "keep going" wastes the escalation; the agent already told you its own ideas ran out.

## What not to do

Never leave it unanswered while you do something else — that is the one mistake this mechanism exists to prevent. Never spawn a duplicate without the handoff; a fresh agent that re-reads the repo from zero pays the full cost the escalation was trying to save. Never pick a stronger model yourself by guessing — respawn at the category's default chain, or at the model the user names, not at your own preference.

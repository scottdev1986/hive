# Terminal-ownership methodology — the north star

**Ratified by the user, session 2026-07-20.** This is the methodology future spec
decisions cite instead of re-deriving. When a story, gate, or design doc has to
choose, it should be able to point here rather than re-argue why Hive owns the
terminal at all. Source anchors below are **section-level** (files move; line
numbers rot) — cite the named section, not a line.

---

## 1. Foundation

**Hive builds a custom terminal specifically so that Hive can be integrated into
it.** The terminal is not a rendering convenience; it is the integration surface.
Because Hive owns the terminal, Hive always knows what is going on in every agent
terminal:

- An agent has a question that needs a human — **Hive knows.**
- An agent got a security or vendor notification that stopped its work — **Hive
  knows.**
- An agent is timing out on an API connection — **Hive knows.**
- The user asks what an agent is doing — **queen summarizes from the journaled
  output, without interrupting the agent.**
- An agent crashes — **Hive knows, and can restart it** via resume, or via a
  reconstructed summary-plus-commands, so the agent is back on track.

Everything below is the disciplined form of this one idea: owning the terminal
means owning the truth about what each agent is doing, without having to ask the
agent and without disturbing it.

---

## 2. The four buckets

The reason to own the terminal decomposes into four jobs. This is the
user-approved framing.

### SEE — truth without asking

Fleet-wide observation of what every agent terminal is doing, derived from the
terminal itself rather than from a question posed to the agent:

- Fleet-wide observation across all agents at once.
- Output-rate analysis to detect an agent that is stuck or looping.
- Reading vendor-printed quota and rate-limit lines the agent's tool prints to
  its own terminal.
- A usable status even for uncooperative vendors that expose nothing structured.

*Anchors:* issue **#61**; issue **#38** (vendor-agnostic status spine);
`planning/backlog-outline.md` **M2 → S2.3** (status pipeline).

### ACT — safe intervention

Injecting into an agent terminal is allowed only when it is safe, and its effect
is measured, not assumed:

- State-aware injection: input is delivered only at safe prompt states.
- Measured receipt: "received" means Hive watched it render, not that a write
  returned.
- Human keystrokes take priority over automated injection.

*Anchors:* `planning/backlog-outline.md` **M2 → S2.4** (message delivery over the
new spine); invariants **I3 / I4** (input arbiter — one ordered write path, human
claim, no automation-timeout steal).

### SURVIVE — nothing lost

Sessions are durable and outlive the things that watch them:

- Headless, durable sessions that persist without an attached renderer.
- Reattach with zero loss.
- Queen can open and close terminals.
- Crash state survives long enough to drive a resume.

*Anchors:* invariant **A4** (close/reconnect — visibility lease, bounded replay,
verified termination); issue **#62** (queen opens/closes terminals); issue
**#57** (crash-state survival for resume).

### PROVE — flight recorder

The terminal is its own evidence instrument — the forensic black box:

- A full byte journal of everything the terminal emitted, kept as a forensic
  record.
- Secret-leak detection over that stream.
- The terminal is the capture instrument for human acceptance gates and for the
  conformance corpus — the evidence comes from the terminal itself.

*Anchors:* issue **#45**'s capture re-check (terminal-as-capture-instrument for
human acceptance); `planning/backlog-outline.md` **M2 → S2.5** (vendor-TUI
terminal conformance corpus).

---

## 3. Guardrail — two-lane truth

Observation and authority are two different lanes, and they must never be
confused.

- **Screen-derived facts are hints.** Everything SEE produces from the terminal
  surface is labeled with **source, freshness, and confidence** (StatusEnvelope
  v2). It informs; it does not adjudicate.
- **Authenticated status calls are truth.** When Hive needs the record of
  authority, it comes from an authenticated status call, not from pixels.
- **Invariant I6 is sacred: terminal pixels are never status truth.** Screen
  scraping is the always-on safety net that catches what structured status
  misses — it is never the system of record.

*Anchor:* `planning/backlog-outline.md` **M2 → S2.3** (StatusEnvelope v2 —
source/freshness/confidence; I6).

---

## 4. Three principles the user added (2026-07-20)

These extend the methodology; they are design constraints, not aspirations.

### 4a. EFFICIENCY — context and performance are design constraints

Observation at fleet scale is only useful if it is cheap to hold and cheap to
retrieve.

- **Graphify ships with Hive because it has been proven to lower token cost.**
  Bundling it is a token-economy decision, not a packaging convenience.
  *Anchors:* `docs/graphify/bundling.md`; `docs/graphify/integration.md`.
- If queen has access to a vast amount of observational data, queen must be able
  to get it **quickly, efficiently, and at efficient token cost.** A large
  journal that is expensive to query is a liability, not an asset.
- **The retrieval system is under active research** — this is an open research
  task, not a settled design. Its likely home is **M3**, alongside S3.1's
  content object store with bounded previews and the TokenAttributionProjection.
  *Anchor:* `planning/backlog-outline.md` **M3 → S3.1**.

- **The performance floor is a fixed machine (user-ruled, 2026-07-20).** "We can
  not engineer something that only top of the line computers can run." The
  baseline is the **base 14-inch MacBook Pro (2021): M1 Pro, 16 GB unified
  memory, active cooling** — a minimum spec, not a target. Efficiency, speed, and
  lightweight are product requirements measured *at this floor*, not on the
  developer's machine:
  - Every performance / memory / latency acceptance criterion is measured **on
    the floor machine, or explicitly modeled against it** — never certified only
    on faster hardware.
  - Always-resident components are sized for **16 GB shared with concurrent
    builds and agent processes**, and **degrade gracefully** under memory
    contention rather than failing or starving the fleet.
  - Measurement includes **sustained workload**, not a cold single-shot: the
    floor must hold while agents run and builds churn.

### 4b. PROJECT ISOLATION

**Hive is project-specific.** The knowledge base and the monitoring belong to the
project Hive is running in. Running Hive in a different project must have **zero
knowledge leakage** from any other project. Isolation is a hard boundary, not a
best-effort filter.

### 4c. DATA LIFECYCLE

**Cleanliness is designed, not incidental.** Data does not stay relevant forever,
and the methodology commits to an explicit policy for when it stops mattering —
but it does not yet answer *what* that policy is. These are the research remit,
stated as open questions, deliberately left unanswered here:

- How often do we clean up?
- Projects evolve — a decision made five months ago must not affect changes
  today unless it is still relevant. How do we express that?
- Is a session from yesterday still relevant data? From two or three sessions
  ago? Where does relevance decay?

Relevance decay and cleanup cadence need an explicit policy. Naming these
questions is the point; answering them is downstream work.

---

## 5. Status

- **Methodology: ratified by the user, 2026-07-20.**
- **Retrieval system: research in flight** (§4a).
- **Build home: expected M3**, subject to the retrieval-research recommendation.

# M1-A2 — retroactive acceptance record

Written 2026-07-20 by `imogen`, under a user ruling on audit question §5 Q4
("write the reasoning, close it"). Verified against local main at `b5d2ed4c`.

**This record is retroactive, and that matters.** No contemporaneous acceptance
artifact was produced when A2 landed: no evidence bundle, no per-clause matrix,
no closure review. A2 is also the only Track A item with no story doc of its
own — its entire stated DoD is one line at `planning/backlog-outline.md:36`.
With no doc to hold acceptance criteria, there was nothing to notice was empty,
which is why #4 closed unevidenced and stayed that way. A retroactive record
that hid its own retroactivity would be worth less than none, so: everything
below was derived after the fact, by reading main, not by observing the work.

**Verdict: four of five DoD clauses are met. The fifth is not. #4 stays open.**

## What A2's DoD actually requires

`planning/backlog-outline.md:36`, verbatim:

> A2 `sessiond-host.ts` — the production `SessionHost` backend speaking the
> sessiond protocol; daemon wiring (server, delivery, teardown, recovery)
> behind the A0-frozen contract — never against today's unproven contract.

That sentence carries **five** requirements, not four. The parenthesised list
names four wiring clauses; the trailing qualifier is a fifth, and it is
normative — "never" is not decorative.

## Clauses 1–4: the wiring. MET.

`src/daemon/session-host/sessiond-host.ts` exists (28 KB) and implements the
sessiond protocol directly: frame codec (`encodeSessiondFrame:132`,
`SessiondFrameDecoder:151`), a broker client (`SessiondSocketClient:267`
implementing `SessiondBrokerClient:240`), negotiated limits
(`SessiondNegotiatedLimits:261`), and a typed error taxonomy distinguishing
protocol, wire, not-ready, broker-unavailable and admission-disabled failures
(`:79-118`).

Each of the four named clauses has a daemon module *and* a test module, and
each imports this backend:

| Clause | Module | Test | Imports sessiond-host |
|---|---|---|---|
| server | `src/daemon/server.ts:28` | `src/daemon/server.test.ts:41` | yes |
| delivery | `src/daemon/delivery.ts:22` | `src/daemon/delivery.test.ts:19` | yes |
| teardown | `src/daemon/teardown.ts:40` | `src/daemon/teardown.test.ts:12` | yes |
| recovery | `src/daemon/recovery.ts` | `src/daemon/recovery.test.ts` | sessiond-aware via `requireSessiondAgentLocator:47,:239` |

`recovery` is the one clause whose module does not import a `Sessiond*` symbol
by that name; it reaches the backend through `requireSessiondAgentLocator`
instead. Named separately here rather than smoothed into the table, because the
evidence for it is genuinely a step weaker than for the other three.

The backend is wired into the real daemon entry point at `src/cli/daemon.ts:70`
(`import { SessiondHost }`), and is registered in the protocol schema map at
`src/schemas/session-protocol.ts:24` — so it is the production path, not a
parallel implementation.

**The argument that B2 running on this constitutes acceptance:** B2 wired
`HiveTerminalView` into Workspace panes on top of this backend, and B2.0–B2.4
closed with recorded evidence (see `raw/qualification/hive-b25-production-pane/`
and the B2 sub-gate record). Those gates exercise create, ordered output
delivery, resize, teardown and reconnect/replay through this code path against
a real sessiond — including a 100 MiB ordered-output stress run with no byte
loss. A backend that were broken in any of the four clauses could not have
carried those runs. That is real evidence, and it is why the user ruled the
wiring clauses satisfied: the code is not merely present, it is load-bearing
under gates that closed on measurement.

The honest limit of that argument: it is *inferential*. B2's evidence was
gathered to close B2, not to close A2, so no artifact isolates A2's clauses
individually. "Working under load" is weaker than "measured per clause" — but
per the ruling, it is sufficient for these four.

## Clause 5: built behind the A0-FROZEN contract. NOT MET.

A2's DoD does not say "build against the contract". It says **"behind the
A0-frozen contract — never against today's unproven contract."** The contract
was not frozen when A2 was built, and is not frozen now.

`docs/contracts/terminal-host-v1.md:3`:

> Status: **shape frozen**. ... Real-session verification is intentionally
> incomplete until the pending-A1 discriminators pass and a neutral adapter
> exists.

"Shape frozen" is not frozen. Two further documents state the same requirement
independently, so this is not a stray phrase in one backlog line:

- `planning/story-m1-a0-terminal-host-contract.md:9` — "A2 must build against
  an externally-derived, frozen, project-agnostic boundary — **never today's
  unproven seam**."
- `planning/story-m1-a0-terminal-host-contract.md:71` (A0 DoD-4) — "A2 declared
  unblocked only at freeze."

A0 is itself reopened (#34) precisely because the freeze has not closed: freeze
cases B and C are still `test.failing` in
`test/terminal-host-freeze/pending-a1.test.ts:11,:18`, and their struct shapes
are absent from `native/sessiond/src/pty_host.zig`.

This clause cannot be discharged by a retroactive record. The other four ask
"does the code do this?", which reading main can answer. This one asks "was the
prerequisite true at the time?", and it was not. No amount of after-the-fact
evidence changes a sequencing fact.

## Why this record does not close #4

The ruling was that working code plus B2 running on it is sufficient *evidence*
for A2. That ruling resolves an evidentiary standard, and it resolves clauses
1–4. It does not reach clause 5, which is not an evidence question at all —
nothing was under-measured there; a stated precondition was not met.

Audit §5 Q4 raised the sequencing point as "Related:", so it was visible when
the ruling was made. But what the ruling answered was the question as posed —
"does A2 need a retroactive acceptance record" — and a decision to accept
inferential evidence for the wiring is not the same decision as waiving a
"never" clause in the DoD. Reading it as both would close #4 on a premise the
user was never actually asked about.

So this record stops at the boundary of what it can honestly certify: clauses
1–4 accepted per the ruling; clause 5 open on the evidence.

**What would close #4:** either (a) A0's freeze closes via #34, after which
clause 5 is satisfiable — note it would still be satisfied *late*, since the
code was written first, so the user may prefer to record an explicit waiver
rather than pretend the ordering held; or (b) the user rules directly that
clause 5 is waived for A2, with the reasoning recorded. Option (b) is a
one-line ruling and needs no engineering.

## What this record explicitly does NOT settle

The A0-sequencing concern is **live on #34** and is not resolved here. Closing
or amending #4 must not be read as having settled it. The two are related but
distinct: #34 asks whether the contract can be frozen at all yet; clause 5 above
asks what follows for A2 from the fact that it was not. Neither answers the
other.

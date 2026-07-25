# Queen wake input-busy — message delivery blocked by stale and orphaned input claims

Diagnosis and constraints. **Not a design proposal.** The minimal fix ruled by
Scott is described under "The cut that landed"; everything else here is measured
evidence and the boundaries around it.

## Root cause, in one line

The delivery gate asked **"is a claim recorded?"** instead of **"is a human
actually present?"**. Those two questions diverge the moment a pane goes idle,
and from that moment delivery blocks forever.

`HostCore.claimInput` (`native/sessiond/src/host_core.zig`) denied every
contender whenever `active_claim` was non-null. It never compared the claim's
own lease deadline to the current time — it *printed* that deadline in the
denial it was about to send, and refused anyway.

## The three denial strings, verbatim from live message rows

    sessiond inject declined: claim denied: input already claimed (held by human writer workspace-pane-nina, lease expires 2026-07-25T19:53:07.658Z)
    claim denied: HumanOrphaned
    claim denied: HumanOrphaned

- **nina** — queued 14 minutes. Read the timestamp: the lease **expired at
  19:53** and delivery was still being refused at **20:12**, nineteen minutes
  past expiry.
- **kimi-probe** — queued 14 minutes.
- **david** — queued 9+ minutes, then **closed having never received its
  instruction.**

No human was typing in any of those panes. The gate blocked delivery on behalf
of people who were not there.

The first string is assembled in
`src/daemon/session-host/sessiond-viewer-attach.ts:367-375`, which interpolates
`owner.leaseExpiresAt` into the decline — the expiry was on the wire, in the
message row, and ignored by the code that wrote it.

## Two independent mechanisms, not one

**1. Expiry was never honoured.** `ActiveInputClaim.lease_expires_at` was
written once at grant (`host_core.zig`) and thereafter read only for
*reporting*: the inspection payload and the denial payload. It was never
compared against `now_ns` anywhere in the tree. A claim, once taken, blocked
automation until the process died.

**2. Orphan resolution was wired but unreachable.** The
`INPUT_ORPHAN_DISCARD` path exists, is implemented
(`HostCore.discardInputOrphan`), is production-wired (`src/cli/daemon.ts:184`,
`src/daemon/server.ts:1006`), and has its own passing test ("INPUT_ORPHAN_DISCARD
ends the HumanOrphaned deadlock and automation is heard again"). It never ran in
production. One guard in
`src/daemon/session-host/sessiond-agent-input.ts` returned the orphan decline
untouched whenever the caller passed an `expectedForeground` — and **both** real
callers always pass one (`writeAutomated` and `injectKeys`). The recovery path
was dead code for every message Hive has ever sent.

That is why `HumanOrphaned` was terminal for david rather than a one-retry
detour.

## The lease is never renewed — the expiry window *is* the delivery latency

Measured, not inferred:

- The human pane requests `leaseMilliseconds: 60_000`
  (`workspace/Sources/HiveTerminalKit/Attach/AttachReplayClient.swift:353`).
- The host does **not** grant that. It grants
  `@min(request.leaseMilliseconds, remaining_ms)` where `remaining_ms` is what
  is left of the **visibility** lease (`host_core.zig`).
- The visibility lease is `visibility_expiry_ms = 15000` (15 s), renewed by the
  daemon every `WORKSPACE_VISIBILITY_RENEWAL_MS = 5_000`
  (`src/daemon/server.ts:276`).
- So the granted human claim lease is **10–15 seconds** in steady state, never
  the requested 60.

**Is it renewed by actual human activity? No.** There is no `CLAIM_RENEW` frame
anywhere in `native/sessiond/src`, `src/`, or `workspace/Sources` — the concept
does not exist on the wire. `lease_expires_at` is assigned once at grant and
never reassigned. Keystrokes go through `HostCore.submitInput`, which validates
the claim token and never touches the deadline. The Swift client acquires once
per draft (`beginClaimAcquire` is guarded on `activeClaimToken == nil`) and
releases on submit or cancel.

**The number: 10–15 s.** That is the worst-case delivery latency the expiry
rule can add, and — stated plainly because it is the cost of the ruling — it is
also the point past which a human still typing one long draft no longer holds
input. Nothing renews under them. This is recorded as a known residual, **not**
a request to redesign renewal.

## Compounding defects on the root/orchestrator side

These were found in the same investigation and are **not** in the landed scope.
They are recorded because each one independently destroys the evidence needed to
notice the bug above.

1. **Total failure looked like a race.** The root wake path exists and runs.
   Every attempt ended input-busy, with retry tallies of 34/34, 34/34, 16/16,
   13/13, 10/10, 10/10 and 7/7 — every retry of every attempt failed. A
   transient race is ruled out by construction; this was a hard gate.
2. **The cause was flattened to a boolean.** Root delivery reduced a detailed
   claim denial to `false`, so the durable row recorded only a generic "root
   protocol did not confirm delivery". The diagnostic that named the owner and
   the expiry existed and was discarded before it could be written down.
3. **A wake that never happened is state-indistinguishable from one that did.**
   `injectedAt` stays null, but a later manual drain transitions rows straight
   to `applied`. Nothing in the row's final state distinguishes "delivered" from
   "never injected, then swept".
4. **Root is excluded from stuck-delivery alerts**, so `deliveryAlertAt` stayed
   null throughout. The one automated tripwire that would have surfaced this was
   not watching the root.

### Message `state` is NOT evidence of delivery

Stated plainly, because defect 3 makes it concrete: a row reading `applied`
does not prove an agent received anything. `queued` and `injected` are *sent*,
not *received*. SPEC.md:111 already commits to this — "**persistence is never
reported as delivery, and injection is never reported as receipt**" — and the
`applied`-via-manual-drain path violates it today. To establish that an agent
actually received an instruction, read the vendor's own boundary or transcript
surface, never the message row's state column.

## The cut that landed

    if (claim.expiresAt <= now)  -> NOT held, proceed with delivery
    if (claim.isOrphaned)        -> NOT held, proceed with delivery
    otherwise                    -> held: do not inject, leave durable, deliver at the next turn boundary

Nothing is ever taken from anyone. The original requirement was only ever "do
not clobber what I am typing", and expiry plus orphan status satisfies it
completely. When a human is genuinely holding input, waiting is correct.

## Constraints — do not re-inflate this

The previous attempt "ballooned into an over complicated mess that isn't
working" by going looking for a way to take input away from a human who *is*
holding it. That hard case never needed solving. Out of scope, permanently
unless Scott rules otherwise:

- **No preemption of a live claim.**
- **No composer-marker protocol**, no atomicity negotiation with sessiond, no
  retry framework, no delivery-strategy abstraction.
- **The existing preemption machinery stays.** `OrphanDiscardMode`'s `"held"`
  mode and `InputArbiter.operatorPreempt` are deliberately left in place;
  cleanup is deferred separately. Delivery must never select `"held"`.

### Do not resurrect `hive/notify-the-queen-orchestrator-never-r`

That preserved branch attempted held-claim preemption and is **UNSAFE**. Three
independent reasons, any one of which is disqualifying:

1. An always-true early return.
2. SPEC.md:111 forbids it: "**No incoming delivery may own a human's
   composer**".
3. Its composer-marker check is not atomic with sessiond preemption, so it
   cannot deliver the guarantee it claims even where the intent is sound.

Do not mine it for parts. The unsafe design is the part that looks reusable.

## Divergences found between the design docs and the code

This repo's design docs state intent in the same voice as measured fact. Two
load-bearing cases, both verified against source:

- **`docs/daemon/orchestrator-status.md:39-40`** — "Workspace creates a
  recipient-scoped composer lease before a user's first keystroke, so every one
  of those delivery paths remains queued while a human draft exists." The lease
  is real and is created before the first keystroke. The consequence is not
  implemented as written: the lease is never renewed, so it does **not** track
  the lifetime of the draft. Before this fix it also failed in the opposite
  direction — paths stayed queued long after the draft had ceased to exist.
- **`SPEC.md:111`** — "a synchronous typing lease blocks every submission path
  until the human's draft leaves the field." The implemented predicate is a
  fixed deadline set at first keystroke, not the draft leaving the field. The
  two coincide only for drafts shorter than the 10–15 s window.

Neither doc was edited by this change. They are recorded here as divergences to
reconcile, not as errors to paper over.

## Evidence

- Mutation-proved tests: `native/sessiond/src/session_host.zig` — "an expired
  human input claim does not block delivery", "a live human input claim still
  defers delivery"; `test/daemon/session-host/sessiond-agent-input.test.ts` —
  "an orphaned human draft does not block automated delivery".
- Prior investigation of the same claim lifecycle, reused rather than
  re-derived: `raw/hulda-claim-orphan-map.md`,
  `raw/hulda-claim-orphan-live-proof.md`.
- Earlier regression on the orphan path:
  `docs/incidents/2026-07-21-messaging-regression.md`.

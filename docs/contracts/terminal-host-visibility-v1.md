# Terminal host visibility extension v1.0.0

Status: **candidate shape frozen; cross-vendor review pending**. This is the project-neutral A0 extension required before representation-backed production create admission can open. The neutral qualification fixture passes L–S with a deliberate mutation control for every case. Production implementation and live process proof are intentionally deferred until this shape passes its independent contract review.

This profile extends [terminal host v1.0.0](terminal-host-v1.md). It replaces the base `create` operation with a visibility-guarded request and adds renewal. All other terminal-host operations retain their v1.0.0 shape.

## Boundary

The adapter above this boundary owns authentication and the complete representation inventory. It supplies a request only when its current complete inventory contains the exact proposed session key. Product pane states, close confirmation, window minimization or occlusion, inventory transport, and renderer lifetime do not cross the boundary.

The host receives only neutral evidence: one source-session identity, its exact live process identity, and the current positive inventory revision. A process identity is a PID plus an operating-system-derived start token. A PID by itself is never identity. The host profile rechecks evidence when creating and renewing; possession of a socket, renderer traffic, a heartbeat, or a previously saved snapshot is not evidence of current representation.

## Normative vocabulary

- A **visibility source** is an opaque source-session identity plus an exact process identity `{processId, startToken}`.
- An **inventory revision** is a canonical positive decimal integer. It orders complete snapshots from one source session. Revisions from different source sessions are unrelated.
- A **visibility request** carries exactly one visibility source and one inventory revision. The guarded create request separately carries the base terminal create request whose opaque key names the represented record.
- A **visibility lease** binds the host-issued exact session reference `{key, incarnation}`, the accepted source identity, and the accepted revision. It is `active` only between its `issuedAt` and finite `expiresAt` timestamps. After its deadline it is `expired` and carries the typed teardown result; an expired lease is never authority.
- A **current representation** is the exact session key in the source's latest complete inventory. Multiple keys may validly share one current inventory revision.

## Required behavior

### 1. Create admission

The guarded create validates a positive revision, exact live source process identity, latest complete revision, current representation of the exact session key, and exclusive generation ownership before invoking the base create operation. A changed start token rejects PID reuse even when the numeric PID is unchanged. A session key with an active or unreconciled leased generation rejects another create regardless of whether the source is the same or different.

A complete rejection has `createInvoked: false`, `session: null`, and `lease: null`; it cannot start a process. Incomplete or unavailable evidence returns `unknown` with the same fail-closed postconditions. Only accepted visibility admission invokes base create. Its `created` result preserves A0's typed launch outcome and carries an active lifecycle lease bound to the returned exact session generation.

### 2. Freshness and replay

The request revision must equal the source's latest complete inventory revision. An earlier revision is `stale-revision`; a later revision not yet established by the source is `unverified-revision`. A current revision may authorize multiple distinct represented session keys and may renew existing exact leases.

An exact retry of an already-completed create idempotency pair may replay its prior result, but it does not invoke create again or extend the prior lease. If the lease expired, the replayed result carries that `expired` lease and cannot restore authority. Rejections and unknown results are also cached by terminal key plus idempotency key; a corrected request uses a new idempotency key rather than replaying the prior failure. A new create attempt using a revision that became stale is rejected. This preserves base create idempotency without turning an old inventory snapshot into new authority.

### 3. Renewal

Renewal names the exact session reference and repeats the complete visibility request. It succeeds only when:

- the lease is still active;
- the source session and exact process identity match the lease;
- the request names the source's equal or later current complete revision;
- the current representation still contains the exact session key; and
- the session incarnation still matches.

A successful renewal returns a new active lease and finite expiry. A rejected or unknown renewal has `renewed: false`. It does not extend the deadline. Except when the deadline has already expired, rejection does not pretend that the prior lease or process vanished; the existing bounded deadline remains authoritative.

### 4. Expiry and teardown

Every lease has a finite, implementation-recorded duration; the neutral fixture freezes 15 seconds. At expiry the host marks that lease expired, stops accepting renewal, requests immediate process-tree termination for the exact session generation, and records termination, reap, descendant, and survivor evidence through the base inspection contract. Each expired lease is reconciled independently: a thrown teardown becomes a typed `unknown` result and cannot skip teardown of later leases. Signal delivery alone is not success. Unknown evidence or survivors remain explicit failure states and keep the session key fenced; only complete verified absence releases it for a new generation.

Source death does not require an event from the dead process. It prevents renewal, so the existing deadline expires and drives the same exact-generation teardown. A renderer disconnect has no effect on the lease.

### 5. Honest failures and completeness

`rejected` is permitted only with complete evidence and one typed reason:

- `invalid-revision`
- `stale-revision`
- `unverified-revision`
- `source-identity-mismatch`
- `source-not-live`
- `session-not-represented`
- `duplicate-session-owner`
- `session-generation-mismatch`
- `lease-expired`

Partial, unavailable, or unknown inventory or identity evidence returns `unknown`, never absence, rejection, or success. Diagnostics explain the observation but never strengthen its completeness.

## Operation shape

- `create({terminal, visibility}) -> {created, result, lease} | rejected | unknown`
- `renewVisibility({session, visibility}) -> {active, lease} | rejected | unknown`

`VisibilityTerminalHost` is the required combined profile: all terminal-host v1.0.0 operations except its unguarded `create`, plus the two operations above. Exposing both guarded and unguarded creation would defeat the profile.

## Freeze qualification L–S

| ID | Required observation | Shape status |
|---|---|---|
| L | Nonpositive/noncanonical revisions fail before create; success binds the exact source, revision, session incarnation, active state, and finite expiry. | Neutral green |
| M | Equal current revision can authorize multiple represented keys; replay of an older revision and an unverified future revision fail closed. | Neutral green |
| N | PID plus exact start token and liveness are required; same-PID start-token reuse and dead sources fail. | Neutral green |
| O | Equal/later renewal succeeds only while the latest complete inventory still represents the exact key. | Neutral green |
| P | Source death prevents renewal; the bounded deadline expires the lease, isolates each teardown failure as typed `unknown`, and continues exact-generation process-tree termination for every other expired lease. | Neutral green |
| Q | Incomplete inventory evidence returns typed `unknown` and never invokes create. | Neutral green |
| R | Neither the same source nor a second source can create over a session key with an active or unreconciled leased generation. | Neutral green |
| S | Renewal with a different incarnation is fenced. | Neutral green |

Every neutral case has a mutation control: injecting that case's semantic violation makes the corresponding assertion fail. Shape qualification does not claim that a production inventory channel, operating-system identity reader, or real process teardown has passed.

## Design and external basis

- The request/lease split, distinct lifecycle channel, full-snapshot freshness, pending-record admission, renewal, and source-death expiry requirements come from the [M1-B2 story](../../planning/story-m1-b2-hive-terminal-view.md)'s “A/Workspace-visibility interlock” and B2.1 build-increment sections.
- Apple's [`getpeereid(3)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html) documents kernel-supplied effective credentials for a connected UNIX-domain peer. These credentials can authenticate the local channel but do not replace exact process identity.
- Apple's XNU [`proc_bsdinfo`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h) exposes the process PID and start-time seconds/microseconds. A production Darwin adapter can derive and re-read an exact start token from operating-system process data; this contract deliberately keeps that mechanism out of its vocabulary.

# #40 claim-orphan map (hulda) — investigation

Port for live work: **43119**. Fix will rebase over horst #47 + hector when landing.

## Lifecycle (measured in source)

### Client — `AttachReplayClient`

| Event | Behavior |
|---|---|
| Encoder write, no claim | `beginClaimAcquire` → `waitingForClaim` |
| `CLAIM_RESULT` granted | `activeClaimToken` set; drain pending input |
| `CLAIM_RESULT` denied | refuse input; presentation free |
| `retarget` / `failDeferredPresentation` | `transport.close()` + `resetInputState()` — **no CLAIM_RELEASE** |
| Wire type `claimRelease` | exists in `FrameCodec` (0x0303) — **never sent** |

`SessiondPaneTerminal.detach` closes the transport only; no claim release.

### Host — `HostCore` / attach loop

| Event | Behavior |
|---|---|
| `CLAIM_ACQUIRE` | `claimInput` → arbiter `claimAcquire` if free; stores `active_claim` |
| Existing `active_claim` | Always **denied** ("input already claimed" or lease-expired diagnostic) — no resume path |
| `CLAIM_RELEASE` frame | Protocol allows it (`protocol.zig`); **`handleViewerFrame` has no case** → unsupported |
| Viewer stream error / supersede | `AttachedViewer.close` → stream only — **no `viewerDisconnect`, no clear of `active_claim`** |
| Claim lease expiry on INPUT_SUBMIT | `viewerDisconnect` once; claim still held at host layer as expired denial |

`active_claim` is written on grant and freed only in `HostCore.deinit`. **Never cleared on viewer drop.**

### Arbiter — `input_arbiter.zig` (§22)

| Transition | API |
|---|---|
| FREE → HUMAN_OWNED | `claimAcquire` |
| HUMAN_OWNED → FREE | `claimRelease(viewer, claim, submit\|cancel, encoded)` |
| HUMAN_OWNED → HUMAN_ORPHANED | `viewerDisconnect` (lease current); else terminate |
| HUMAN_ORPHANED → HUMAN_OWNED | `operatorResume(viewer, new_claim_id)` — **never-steal does not apply; one returning operator** |
| HUMAN_ORPHANED → FREE | `operatorDiscard` (cancel encoder) |
| CLAIM_ACQUIRE while orphaned | `error.HumanOrphaned` (not auto-resume) |

## Hypothesis (queen / harvey)

One dropped viewer leaves input permanently unusable:

1. First viewer acquires human claim (`active_claim` + HUMAN_OWNED).
2. Drop (resize reattach, settle recovery, transport loss, retarget) closes stream **without** release.
3. Host still has `active_claim`; arbiter still HUMAN_OWNED (or never notified).
4. Reattached viewer `CLAIM_ACQUIRE` → denied forever → UI `waitingForClaim` / CLAIM_DENIED.
5. Output pump independent → output fine, input dead (matches #40 asymmetry).

## Intended reclaim design (from arbiter, not inventing)

1. **Clean teardown** (user close, intentional detach): client sends `CLAIM_RELEASE` (cancel, empty/cancel bytes) **before** close → host → `claimRelease` → FREE + clear `active_claim`. Re-acquire works.
2. **Unclean drop** (wire error, supersede without release): host `onViewerDetached(viewer_id)` → `viewerDisconnect` → HUMAN_ORPHANED + clear host `active_claim`.
3. **Returning human** while orphaned + lease current: `claimInput` should call `operatorResume` (issue new token) rather than hard-deny; never-steal still blocks **second concurrent** owner while HUMAN_OWNED.
4. Lease expiry: existing terminate path; no silent auto-steal.

## Repro plan (43119)

1. Unit (host): grant claim → assert second acquire denied while uncleared (RED today).
2. Unit (host): grant → `onViewerDetached` → second acquire granted (GREEN after fix).
3. Live: attach shell → force transport drop / pane recovery reattach → observe CLAIM_DENIED vs grant (port 43119).

## Fix surfaces (do not land until rebased over horst/hector)

- `session_host.zig`: handle `claim_release`; `onViewerDetached` / close path; claimInput resume when orphaned.
- `AttachReplayClient`: `releaseClaim()` send; call from retarget/fail/close.
- `SessiondPaneTerminal.detach` / view `userClose`: release before close.

# #45 — live human terminal acceptance record, with an explicit user capture waiver

Written 2026-07-20 by `zoe`, under the approval-package digest #45 waiver ruling.
Precedent: the A2 acceptance-record + user-waiver instrument (`planning/a2-acceptance-record.md`, landed `8bfa4c50` + `b168589a`). This record is the artifact a reviewer opens to verify the #45 human-acceptance line — but it does **not** check the box: queen owns #45's issue-body updates.

**This record accepts terminal on user attestation plus a live-lifecycle evidence bundle, and it records — plainly — that the one thing #45's final checkbox literally asks for (a byte capture of resize-and-type) was NOT recorded, and that the user explicitly waived that capture for this acceptance.** Acceptance and the missing capture are different facts; this document exists so no future reader can mistake one for the other.

## What #45's final human-acceptance item requires

`#45` body, verbatim:

> **Live human resize-and-type acceptance in `make terminal`** … a human resizes a live pane and types into it, confirming input survives the resize. This checkbox is the *final* acceptance and **cannot be satisfied by an automated run**.

And the issue's governing Rule:

> **Nothing gets checked off without a pointer to the actual evidence artifact.** … An unpointed check is treated as unchecked.

## (1) What the user did — two live `make terminal` sessions, 2026-07-20

The user ran the `make terminal` (B2.2 live-proof) stack twice on 2026-07-20, viewed the live terminal, and exercised it by hand.

**Run 1** — instance `164ddb3b64`, home `/tmp/hb22-225a`:
- Workspace app pid **5563**; sessiond host pid 5321; provider (login shell `/bin/zsh -l`) pid 5328; session `ses_019f8126-206f-7856-9b8b-cb84e974749f` generation 1; engineBuildId `0d9070c4…f0f300`.
- Live **20:09:47 → 20:11:28 UTC** (~1m41s). Nineteen visibility renewals recorded, then ended by a **visibility-renewal `VERIFICATION_UNKNOWN` teardown** (`visibility renewal failed: SessiondWireError: sessiond VERIFICATION_UNKNOWN`), followed by SIGTERM shutdown.
- Evidence: `raw/45-human-acceptance/run1-2009-proof.json`, `raw/45-human-acceptance/run1-2009-transcript.txt`.

**Run 2** — instance `54e497ee1f`, home `/tmp/hb22-a277`:
- Workspace app pid **9684**; sessiond host pid 9484; provider pid 9491; session `ses_019f8128-7208-7572-adbd-b8c4731f170e` generation 1; same engineBuildId.
- Live **20:12:19 → 20:12:27 UTC** (~8s). One visibility renewal, then ended by **SIGTERM**.
- Evidence: `raw/45-human-acceptance/run2-2012-proof.json`, `raw/45-human-acceptance/run2-2012-transcript.txt`.

The user viewed and exercised the live terminal and stated, verbatim:

> "the terminal looks good"

> "I did my testing and I approve terminal"

## (2) The capture that does NOT exist — and the user's explicit waiver

**The harness transcripts captured lifecycle only.** They record broker/daemon/session bring-up, the process tree, visibility-lease renewals, and teardown. **There is no byte capture of a resize-and-type event** — no recording of the pane being resized and typed into with the input bytes and post-resize survival asserted, which is exactly what #45's final checkbox asks for. Read the two `*-transcript.txt` files: neither contains a resize-and-type byte record. Under the #45 Rule, that byte capture is the missing artifact.

**The user explicitly waives the capture requirement for this acceptance (2026-07-20).** Having done the resize-and-type testing by hand and approved terminal, the user waived the requirement that this specific acceptance be backed by a recorded byte capture. This is a **waiver, not a discharge**: the capture was not produced; it was accepted-without. The waiver covers **this #45 human-acceptance item only** and is scoped to the two runs above — it is not a finding that lifecycle-only evidence satisfies resize-and-type in general, and it does not extend to any other gate.

Why a waiver and not evidence: the two runs are attested by a human who was present and testing, but attestation is not a byte record. No artifact produced after the fact can turn the un-recorded resize-and-type of those two sessions into a recorded one. There is nothing left to measure for *these runs* — only something to accept or refuse. The user accepted.

## (3) Residual risk the waiver accepts

**Resize-and-type is attested, not recorded.** The claim "input survives the resize" rests on the user's testimony that they exercised it and it looked good, not on a captured byte sequence showing input before, during, and after a resize with post-resize survival asserted. If the attach/claim behavior around resize regresses, this acceptance carries no recorded baseline to catch it — the runbook re-check below is the safety net, not this record.

## (4) Re-check instruction

**Re-run resize-and-type WITH capture on the production Workspace pane — the B2 path, NOT `make terminal` — at the `planning/m1-human-evidence-session-runbook.md` sitting, before M1 exit.** The re-check must:
- Capture the resize-and-type bytes (input before/during/after a live resize; assert input survives), producing the recorded artifact this acceptance waived.
- Run on the **production Workspace pane (B2 path)**, explicitly **not** `make terminal`.

Because this re-check is bound to the production path and **must never depend on `make terminal`**, it does **not** block **#59**'s deletion of `make terminal`. This resolves the digest's P4 / #45↔#59 sequencing conflict for this acceptance: the human sign-off is recorded here against `make terminal` as run today, and the *durable* resize-and-type proof is re-homed onto the production path — so `make terminal` can be deleted without stranding an M1 exit criterion.

## What this record explicitly does NOT do

- It does **not** check the #45 checkbox or edit the #45 body — queen owns issue-body updates. This document is the evidence pointer that a reviewer opens; whether and how it satisfies the checkbox is queen's call, made against this record and the runbook re-check above.
- It does **not** close #45.
- It does **not** waive anything beyond the resize-and-type capture for these two runs.

## Evidence manifest (sha256)

Recorded so a reviewer can verify the bundle is the one this record describes.

```
b3b75297130700d50c1f381ca084a95434bd4ca64df4df280348bfa656e51e35  raw/45-human-acceptance/run1-2009-proof.json
675ab30c6448dfe422a150e7136f61083c7b70c51d6b477e4eb843c28866a13b  raw/45-human-acceptance/run1-2009-transcript.txt
301211c07da26adc8dfa51f6e4db225d9b8790346cb6a5e66dc843f5d44c2d7a  raw/45-human-acceptance/run2-2012-proof.json
0ee0e18e6421c247243c481127b3b76e1d5190fb1a11188b51226006534c5344  raw/45-human-acceptance/run2-2012-transcript.txt
```

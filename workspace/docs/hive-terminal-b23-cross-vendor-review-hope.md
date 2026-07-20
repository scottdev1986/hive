# M1-B2.3/A3 input acceptance matrix — cross-vendor review

- **Pin reviewed:** `71f8a2a4` (`test(m1-b2.3): record the Kitty keyboard query row`) on `hive/harvey-m1-item-1-mid-b2-3-a3-input-ac` (base older main `552a6241` — review AT THE PIN; rebase happens at landing).
- **Author:** harvey (Claude / Opus 4.8). **Reviewer:** hope (Grok) — cross-vendor requirement satisfied.
- **Method:** pin materialized detached at `/Users/scottkellar/Projects/hive/.hive/worktrees/hope-pin-71f8a2a4`; pin HEAD stayed at `71f8a2a4`; tracked content restored after every mutation. Evidence manifest verified from a pristine `git archive` of the pin into a clean directory, not from the working tree. All four mutation controls re-run by this reviewer and restored.

## Verdict: **PASS**

The matrix is honest about what it has and has not measured. Deliverables are present, green suite matches the claim (427 / 6 skipped / 0 fail), the four mutation controls all bite, the three recording-call rationales survive source check (with one non-blocking nuance on row 3's non-arrow keys), settle-then-assert is applied on every counting row, and the top-of-doc framing does not read as "acceptance complete."

No NO-LAND defect found. Non-blocking notes are listed at the end.

## Deliverables inventory (at pin)

| Artifact | Present |
|---|---|
| `workspace/docs/hive-terminal-b23-acceptance-matrix.md` | yes — 13 table entries (rows 1, 2, 2b, 3–8, 7b, 9–11); each graded with level |
| `bootstrap/evidence/m1-b2-b23-input/` | 9 data `.txt` + self-excluding `evidence-sha256.txt` |
| `scripts/b23-acceptance-matrix.sh` | yes — unpiped suite runs, `REAL_EXIT=` appended, manifest excludes itself |
| Five `B23*MatrixTests` suites | `B23MouseModeMatrixTests`, `B23PasteBoundaryMatrixTests`, `B23UnknownRetryMatrixTests`, `B23KittyStackMatrixTests`, `B23SpecialKeyMatrixTests` |

## (1) Green suite — measured exit codes

All unpiped; real process exit codes:

| Step | Exit | Result |
|---|---|---|
| `swift build` (workspace, after staging gitignored GhosttyKit from author's worktree) | **0** | Build complete |
| `swift test` | **0** | **427 tests, 6 skipped, 0 failures** |
| `bun run typecheck` | **0** | `tsc --noEmit` clean |
| `scripts/b23-acceptance-matrix.sh` | **0** | 8 suites recorded; each file ends `REAL_EXIT=0`; self-check of regen manifest OK |

### Manifest from `git archive` (not the working tree)

```
git archive 71f8a2a4 bootstrap/evidence/m1-b2-b23-input | tar -x -C $CLEAN
cd $CLEAN/bootstrap/evidence/m1-b2-b23-input
shasum -a 256 -c evidence-sha256.txt   # all 9 data files OK, exit 0
# independent recompute of digests (exclude manifest) diffed equal to committed manifest
```

Nine data files, manifest self-excluding. Regenerating the suite rewrites timestamps inside the logs so digests move — expected; the **committed** pin is what was verified from archive.

## (2) Four mutations — all bite; restored after each

| # | Mutation | Exit | Observed failure (captured by this reviewer) |
|---|---|---|---|
| 1 | Drop `.shift` on Shift-override gesture | 1 | `["\u{1B}[<0;2;14M", "\u{1B}[<0;2;14m"]` vs `[]` — exact SGR bytes harvey claimed |
| 2 | Answer fence row with `written-to-terminal` instead of `unknown` | 1 | State guard fails first: unknown stage did not produce unknown state (got `pending(...)`); fence depends on the unknown outcome |
| 3 | Drop `CSI < u` pop step | 1 | `Optional(7 bytes)` vs `Optional(10 bytes)` — kitty golden length vs legacy |
| 4 | Up-arrow expectation mutated to `\e[Z` | 1 | Assert failed: up arrow must encode `\u{1B}[Z` (actual remains the pinned `\u{1B}[A` from the green suite) |

No mutation failed to bite. Pin tree restored to pristine tracked content after each.

## (3) Three recording calls — judged on source

### Row 2b — automation-TIMEOUT steal recorded **by construction** — **UPHOLD**

Source check of `native/sessiond/src/input_arbiter.zig` at the pin:

- L9 / L1594–1596: module contract and in-file note — invents no timeouts; no `Timer`/`sleep` path that unlocks a claim.
- `onVisibilityLeaseExpired` (L285–293): sets `lease_current = false` and **terminates**, including from `human_owned` / `human_orphaned`. Does not free for automation.
- `claimAcquire` (L308–314) and `automationBegin` (L586–591): refuse while `human_owned` / `human_orphaned` (`HumanOwned` / `HumanOrphaned`).
- Orphan→FREE is never automatic (field doc L244).

There is no timer that can release a human claim into a state automation can steal. A pure "wait and assert automation still denied" test would pass against an arbiter with no automation path at all; harvey is right that that would be a vacuous positive.

**Control quality:** the live competing-writer denial at `real-host-golden.zig:817` (row 2) exercises a real automation contender against an incumbent human and reads back the incumbent token — that is the non-vacuous half. The structural half is source inspection, which is the right shape when the property is "this timer does not exist." Queen pre-ratified; code agrees. Not contested.

### Row 10 — fences instead of same-key retry — **UPHOLD**

Client (`AttachReplayClient.swift`):

- L512–519: `transactionId = "input-\(viewerId)-\(binding.generation)-\(sequence)"` with `inputSequence += 1` immediately before; `idempotencyKey` **is** that `transactionId`. A client-side resend after unknown would mint a new sequence → new key → new act. Literal same-key resend is unconstructable from this client without changing the keying scheme.
- Fence: `inputFenced` set on claim-unknown (L446), uncorrelated receipt (L463), unknown stage (L474), send failure (L540); guarded at enqueue (L206) and submit (L504); cleared only on fresh attach / reset (L558).

Host (`real-host-golden.zig:882+`): transport correlation id changes, domain idempotency stays fixed; replayed APPLIED payload is byte-identical; `waitForSingleInputEffect` + single `OUT:wire-input` count prove no duplicate PTY echo. Host-side same-key half is where harvey says it is.

Fencing is the correct client reading of the clause given this key derivation. Queen pre-ratified; code agrees. Not contested.

### Row 3 — arrows-only byte goldens — **UPHOLD with nuance**

Pinned engine `vendor/ghostty/src/input/function_keys.zig`:

- Arrows and **Home/End** use `cursorKey(normal, application)` — genuine DECCKM dual forms (`\x1b[H`/`\x1bOH`, `\x1b[F`/`\x1bOF`, and the `CSI`/`SS3` arrow pairs).
- **PageUp/Down, Delete, Insert** use a single default sequence plus `pcStyle` modifier variants — **not** DECCKM duals.
- **F1–F4** default to SS3 forms (`\x1BOP`…); **F5/F12** default to fixed CSI tilde forms — again not DECCKM duals. Keypad application mode is a separate table (`kpKeys`).

So the matrix claim "sequences vary with DECCKM and keypad state" is **true for Home/End (and arrows)** and **overstated for PageUp/Down/Delete/F-keys**. For those mode-stable defaults, a default-mode golden would not be "reading the build back into the assertion" in the same way; non-empty+distinct is a weaker claim than the engine would support for that subset.

**Not under-recording for Home/End** — dual forms make a single golden wrong under the other DECCKM state. **Mild under-recording for PageUp/Down/Delete/F5/F12** at the default mode only — non-empty still catches the historical silent-drop class; distinctness still catches collapse. Live-PTY adjudication (already HELD) is the right place to pin mode-specific goldens. Non-blocking; does not flip the recording call.

## (4) Top-of-doc caveat — accurate and prominent

Opening lines:

- **Status: IN PROGRESS** (line 3).
- Evidence-levels section (L25–36) states encoder proves vendor bytes, not sessiond/PTY transit — load-bearing distinction, prominent before the table.
- Sequencing hold (L38–49) names hattie/henry and refuses to record known-broken live behavior as acceptance.
- Remaining work (L176–188): no defect-independent rows open; live-PTY round-trips for rows 3–7 and 11 HELD; row 9 HELD.

The doc does **not** read as "acceptance complete." Story closure correctly requires the held live rows.

**Count note:** encoder-level-only among recorded rows is actually **3, 4, 5, 6, 7, 7b, 8, 11** (eight entries if 7b is separate). Remaining-work prose names "rows 3–7 and 11" (six, folding 7b into 7) and **omits row 8** from the live follow-up list even though row 8 is also encoder-only. Non-blocking drafting gap — the status/IN PROGRESS framing still prevents a false "done" reading.

## (5) Row 7b — both directions + security wording

`B23PasteBoundaryMatrixTests.swift`:

- **Safe single-line lands verbatim** — `testBracketedPasteResetEmitsSafeBodyWithoutMarkers` asserts unbracketed body equals `clipboard` with no 2004 markers.
- **Unsafe multiline withheld entirely** — `testBracketedPasteResetWithholdsUnsafeMultilineBody` asserts `actual == ""` for `clip\nboard`.
- **Attribution control** — same multiline body **is** present when bracketed, so silence is safe-paste, not a dead clipboard reader.

Matrix doc (row 7b + "Row 7b" section): words the risk as an embedded newline that would **submit to the shell unseen / without the user seeing it** — that is security-behavior language (unconfirmed shell submission). Does not use the capital-word "SECURITY" label; the substance is correct. Accept.

## (6) Settle-then-assert on every counting row

| Suite | Pattern |
|---|---|
| `B23MouseModeMatrixTests` | Drain until `expectedWriteCount`, **then always** `drainMainRunLoop(until: { false }, timeout: 0.25)` — including zero-write rows. Comment at L62–66 is the self-caught defect. |
| `B23PasteBoundaryMatrixTests` | Drain until body length, then same 0.25 settle (catches trailing `ESC[201~`). |
| `B23KittyStackMatrixTests` | `drain(until: 1)` then `drainIdle(0.25)`; exact count asserted after settle. |
| `B23SpecialKeyMatrixTests` | Same drain-then-`drainIdle(0.25)` for every key encode. |
| `B23UnknownRetryMatrixTests` | Not an encoder write-count row; fixed `drainMainQueue` after submissions. |

The settle-after-expected-writes fix is in **every** exact-count / wrote-nothing encoder row, not only the mouse suite where it was found.

## Non-blocking notes (do not block land)

1. **Row 8** is encoder-only but missing from the remaining-work live-PTY list that names 3–7 and 11.
2. **Row 3** DECCKM rationale is exact for Home/End; PageUp/Down/Delete/F-keys have mode-stable defaults and could take default-mode goldens later without the dual-form hazard — mild under-recording on that subset only.
3. Authority section says "11 rows below" while the table has 13 entries (2b and 7b are real rows). Cosmetic.
4. Mutation 2 fails first on the `unknown` state guard rather than the `after == before` fence count; both depend on the unknown stage, so the control still bites at its intended property.

## What this pin is / is not

**Is:** a solid, mutation-proven, partially held acceptance matrix for the defect-independent B2.3/A3 surface, with honest evidence grading and a regenerateable bundle.

**Is not:** story closure for B2.3. Live-PTY byte round-trips and the Retina resize row remain HELD pending the parallel PTY/resize fixes. Do not treat this pin as "input acceptance complete."

# HiveTerminalView B2.3/A3 — input acceptance matrix

Status: IN PROGRESS. Rows are recorded against the landed B2.3 typeable core
(`b3076000` NSTextInputClient -> Gate-8 encoder -> `INPUT_SUBMIT`/`APPLIED`,
`5572160e` focus, `4fdf9d4c` geometry/SIGWINCH).

This document is the acceptance matrix that
`workspace/docs/hive-terminal-b23-typeable-input.md` did not record. That
document froze the typeable core; this one cross-checks the core against the
acceptance clauses.

## Authority for the rows

The 11 rows below come from `planning/story-m1-b2-hive-terminal-view.md:162`
(the B2.3 acceptance cell) and `planning/backlog-outline.md:37` (the A3
invariants I3/I4). Detailed clause text is in the same story's "Input and
resize semantics" and "Scroll, selection, copy, paste, and mouse" sections.

Correction for anyone working from an earlier brief:
`planning/story-m1-a1-input-wire-options.md` does NOT contain an A3 acceptance
section. It is the normative wire projection (adopted Option 1: `INPUT_SUBMIT`
plus a discriminated `APPLIED`, 128 KiB decoded cap). It is authoritative for
frame SHAPE, not for acceptance.

## Evidence levels

Rows are graded by the level at which the bytes were observed. The distinction
is load-bearing: an encoder-level pass proves Ghostty emits the right bytes,
not that those bytes reached a PTY.

- `encoder` — real `GhosttyManualSurface` in-process, bytes captured at
  `callbackContext.onWrite`. Real vendor encoder, no sessiond, no PTY.
- `fake-host` — Swift client against `FakeHost`; proves frame ordering,
  claim discipline, and refusals, not PTY effects.
- `live-pty` — real sessiond and a real PTY; byte evidence read back from the
  host journal or the child process.

## Sequencing hold

Two input/rendering defects were being fixed in parallel with this matrix:

- hattie — PTY OPOST staircase (`native/sessiond/src/pty_host.zig`)
- henry — resize kills input (`SessiondPaneInputFocusTests.swift`)

Recording a live row before those land would pin known-broken behavior as
acceptance. Rows whose evidence depends on live PTY output rendering, or on a
resize, are therefore marked HELD and are not recorded here until queen
confirms both fixes are on main. All defect-independent rows (encoder,
fake-host, and daemon-side arbiter) are recorded now.

## Matrix

| # | Row | Status | Level | Proof |
|---|---|---|---|---|
| 1 | claim-before-input | RECORDED | fake-host | `AttachInputTests.swift:15` `testGate8TextWaitsForClaimThenUsesFrozenInputSubmit` — text is held until `CLAIM_RESULT`; asserts `INPUT_SUBMIT` is absent before the grant. Superseded-connection variant at `:104`. |
| 2 | no competing-writer steal | RECORDED | live-pty | `native/sessiond/test/real-host-golden.zig:817` — an `automation` contender against an incumbent human claim is `denied` and the reported owner token is the incumbent's. |
| 2b | no automation-TIMEOUT steal | RECORDED (by construction) | source | `input_arbiter.zig` invents no timeouts (L9). `onVisibilityLeaseExpired` (L283-293) TERMINATES rather than releasing to automation; `claimAcquire` (L308-314) refuses from `human_owned`/`human_orphaned`. There is no timer that can release a human claim, so this is a structural property, not a timing test. See "Row 2b" below for why it is recorded this way. |
| 3 | keys | PARTIAL | encoder | Ctrl chord `InputEncodingTests.swift:325`; Option mapping `:205`; press/repeat/release `:818-868`. GAP: no byte goldens for arrows, Home/End, PageUp/Down, Delete, Tab, F1-F12. |
| 4 | Kitty progressive modes | PARTIAL | encoder | `KittyKeyboardGoldenTests.swift:148` (`CSI > 1 u` -> `\x1b[13;2u`), press/repeat/release `:174`, left/right Shift `:196`, alternate-key `:221`. GAP: no pop (`CSI < u`), query (`CSI ? u`), or mode-stack nesting. |
| 5 | dead key | RECORDED | encoder | `InputEncodingTests.swift:516` — real surface, `´` -> `é` committed byte-exactly once; choreography at `:487`. |
| 6 | CJK IME | RECORDED | encoder | `InputEncodingTests.swift:516` — multi-stage `日`/`日本` preedit writes nothing, then commits exactly `日本語`. |
| 7 | bracketed paste | RECORDED (new) | encoder | `Gate8ClipboardTests.swift:43` pins the SET direction. NEW `B23PasteBoundaryMatrixTests.swift` adds the RESET direction (`?2004l` stops bracketing while a safe single-line body still reaches the encoder verbatim) and asserts exactly one marker pair on set. Without the reset row, a build that bracketed unconditionally passed. |
| 7b | safe paste while unbracketed | RECORDED (new) | encoder | `B23PasteBoundaryMatrixTests.swift` — with 2004 reset, a MULTILINE body is withheld entirely (zero bytes), because an embedded newline would submit to the shell unseen. This discharges the clause's "with it reset, Ghostty's safe-paste rules apply." See "Row 7b" below. |
| 8 | mouse modes, local vs captured | RECORDED (new) | encoder | NEW `B23MouseModeMatrixTests.swift` — X10 (9) press-only, VT200 (1000) press+release with button-3 release sentinel, SGR (1006) `M`/`m` edge discrimination, Shift override writes zero bytes while captured. Pre-existing any-motion (1003) + SGR at `InputEncodingTests.swift:747`, `:775`. |
| 9 | Retina resize coordinates | HELD (henry) | mixed | Backing-pixel coords `InputEncodingTests.swift:656`, `:676`; measured cell geometry `Gate7RenderingTests.swift:99`; `RESIZE`/`APPLIED` readback + stale-revision refusal `real-host-golden.zig:945`; independent `TIOCGWINSZ` readback `pending-a1-contract.zig:273`. End-to-end live Retina row `LiveHostAttachTests.swift:344` is skip-gated. HELD: henry's resize/input fix changes this path. |
| 10 | retry / unknown semantics | RECORDED (new) | live-pty + fake-host | HOST side: `real-host-golden.zig:882` — identical `INPUT_SUBMIT` under a new transport correlation id returns a byte-identical `APPLIED` and the PTY echoes exactly once. CLIENT side (NEW `B23UnknownRetryMatrixTests.swift`): an `unknown` receipt fences input, so no further `INPUT_SUBMIT` is authored. See "Row 10" below for why fencing, not resending, is the correct reading of this clause. |
| 11 | no-duplicate-input | RECORDED | encoder | `InputEncodingTests.swift:277`, `:291`, `:311` — a printable is embedded in the key event and never also sent as text; `:516` asserts writes equal the commit list exactly. |

## Row 2b — why "by construction" and not a timing test

The A3 invariant is that an automation writer must never acquire a human's
claim because a timeout elapsed. The arbiter satisfies this by having no such
timer at all: lease expiry routes to `terminate()`, and every automation entry
point refuses while a human owns or orphans the claim.

A test that lets a lease expire and then asserts "automation did not get the
claim" would pass for the wrong reason — it would pass identically against an
arbiter with no automation path whatsoever. The honest record is the source
property plus the competing-writer denial in row 2, which does exercise a real
automation contender and reads back the incumbent's token.

## Row 7b — safe paste was found, not assumed

The reset row was first written with the same multiline body the set row uses
(`clip\nboard`). It failed: the encoder wrote nothing at all. Rather than
weaken the assertion to match, the behavior was checked against the clause,
which says safe-paste rules apply once 2004 is reset. Pasting multiline text
unbracketed is exactly the unsafe case — the newline would submit the line to
the shell without the user seeing it — so withholding is correct.

The row was therefore split by paste BODY, not by expectation: a safe
single-line body must land verbatim, an unsafe multiline body must be
withheld. Folding the two together would let a build that always withholds,
or one that always sends, look correct. The withholding row carries its own
attribution control: the same multiline body IS written when bracketed, so
the silence is safe-paste rather than a dead clipboard reader.

## Row 10 — why the client fences instead of resending

The clause reads "retry repeats the same domain transaction and idempotency
key; it never invents a new act after an unknown result." Read literally it
suggests the client should resend. It cannot, and should not:
`AttachReplayClient.swift:512-519` derives `idempotencyKey` from
`transactionId`, which embeds a monotonic per-viewer sequence. A client-side
resend would therefore mint a NEW key — precisely the "new act" the clause
forbids.

The safe half of the clause is consequently enforced by fencing:
`inputFenced` is set on every unknown path (claim unknown L446, uncorrelated
receipt L463, unknown stage L474, send failure L540), guarded at both enqueue
(L206) and submit (L504), and cleared only by a fresh attach (L558). The
idempotent-replay half is a HOST property and is proven there, where the same
key genuinely does repeat.

Recording this as "the client resends with the same key" would have been
false. The matrix records what the code does and why that satisfies the
invariant.

## Positive controls

Per the repo rule that a committed matrix needs an in-suite positive control
planted through the same predicate that reads the rows,
`B23MouseModeMatrixTests.swift` brackets its reader from both sides through the
single `evaluate(_:)` predicate:

- `testPositiveControlNoModeEnabledProducesNoMouseReports` — the same gesture
  with no DECSET must be silent, so a non-empty row is attributable to the mode
  rather than to ambient encoder chatter.
- `testPositiveControlEnabledModeProducesReportsThroughSamePredicate` — the
  same predicate must come back non-empty for a mode that does report. Every
  "wrote zero bytes" assertion in the file is unattributable until this passes.

The zero-write rows additionally settle the run loop for a fixed interval
rather than returning immediately, so silence is measured rather than assumed.

## Mutation verification

Green rows prove nothing until the assertions are shown to bite. Two rows
whose false pass would be most damaging were mutated and reverted:

- Shift override: removing the `.shift` modifier turned the row RED with the
  captured bytes `\e[<0;2;14M` / `\e[<0;2;14m`. This proves the application
  genuinely HAD captured the mouse and that Shift is what suppresses the
  report — the row was not passing because capture was inactive.
- Unknown fence: answering the submission with stage `written-to-terminal`
  instead of `unknown` turned the row RED. The fence depends on the unknown
  outcome rather than on the client never submitting twice.

## Evidence bundle

`bootstrap/evidence/m1-b2-b23-input/` — 69 tests, 0 failures across six
suites, each recorded unpiped with its own `REAL_EXIT`, plus
`evidence-sha256.txt` (excludes itself; `.txt` because `*.log` is gitignored
at `.gitignore:38` and would not survive a fresh checkout). Regenerate with
`scripts/b23-acceptance-matrix.sh`.

## Remaining work

Closed in this bundle: rows 7 and 7b (DEC 2004 reset and safe paste), 8
(mouse encodings and Shift override), 10 (client-side unknown semantics).

Defect-independent gaps still open: row 3 (byte goldens for arrows, Home/End,
PageUp/Down, Delete, Tab, F1-F12) and row 4 (Kitty pop `CSI < u`, query
`CSI ? u`, and mode-stack nesting).

HELD pending hattie + henry landing on main: row 9 end-to-end Retina resize
with observed SIGWINCH delivery, and live-PTY byte round-trips for rows 3-7 and
11, which today have encoder-level evidence only.

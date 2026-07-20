# HiveTerminalView B2.3/A3 — input acceptance matrix

Status: IN PROGRESS. Rows are recorded against the landed B2.3 typeable core
(`b3076000` NSTextInputClient -> Gate-8 encoder -> `INPUT_SUBMIT`/`APPLIED`,
`5572160e` focus, `4fdf9d4c` geometry/SIGWINCH).

This document is the acceptance matrix that
`workspace/docs/hive-terminal-b23-typeable-input.md` did not record. That
document froze the typeable core; this one cross-checks the core against the
acceptance clauses.

## Authority for the rows

The acceptance CLAUSES below come from
`planning/story-m1-b2-hive-terminal-view.md:162`
(the B2.3 acceptance cell) and `planning/backlog-outline.md:37` (the A3
invariants I3/I4). Detailed clause text is in the same story's "Input and
resize semantics" and "Scroll, selection, copy, paste, and mouse" sections.

The source enumerates 11 clauses; the table below has 15 entries. The extra
four are deliberate SPLITS, not additional scope: 2b separates the
automation-timeout steal from the competing-writer steal, 7b separates
safe-paste from bracketing, and 8b/8c separate the 1005 and 1015 coordinate
formats from the mouse mode row. Each split exists because folding it back
into its parent would let a broken build pass — the reasoning for each is in
its own section below.

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

Two input/rendering defects were fixed in parallel with this matrix.
Recording a live row before they landed would have pinned known-broken
behavior as acceptance.

- hattie — PTY OPOST staircase. **LANDED** (`025f75b6`, `pty_host.zig:959`
  restores `OPOST|ONLCR` after `cfmakeraw`, with its own regression test at
  `:1168`). This unblocked the live rows recorded below.
- hector — resize. Henry originally owned this and died in a vendor crash
  wave; hector salvaged the WIP and owns it now. NOT yet landed, so row 9
  stays HELD. Hector's outcome also shifted: faithful resize is reported as a
  non-repro and the real defect is attach/claim, so row 9's final shape may
  become SIGWINCH-as-signal plus geometry correctness rather than a
  resize-breaks-input RED. Queen confirms before that row is recorded.

Also open on main while this was recorded: a BLANK-PANE attach defect (a
fresh attach can render nothing while the session journal provably carries
correct CRLF bytes; isolated by hubert, owned by hattie). It does not affect
the rows here — the live traversal below is verified at the host write
boundary and never renders a pane, and the harness is run with
`HIVE_B22_NO_APP=1`.

## Matrix

| # | Row | Status | Level | Proof |
|---|---|---|---|---|
| 1 | claim-before-input | RECORDED | fake-host | `AttachInputTests.swift:15` `testGate8TextWaitsForClaimThenUsesFrozenInputSubmit` — text is held until `CLAIM_RESULT`; asserts `INPUT_SUBMIT` is absent before the grant. Superseded-connection variant at `:104`. |
| 2 | no competing-writer steal | RECORDED | live-pty | `native/sessiond/test/real-host-golden.zig:817` — an `automation` contender against an incumbent human claim is `denied` and the reported owner token is the incumbent's. |
| 2b | no automation-TIMEOUT steal | RECORDED (by construction) | source | `input_arbiter.zig` invents no timeouts (L9). `onVisibilityLeaseExpired` (L283-293) TERMINATES rather than releasing to automation; `claimAcquire` (L308-314) refuses from `human_owned`/`human_orphaned`. There is no timer that can release a human claim, so this is a structural property, not a timing test. See "Row 2b" below for why it is recorded this way. |
| 3 | keys | RECORDED (encoder) + LIVE-PTY (write boundary) | encoder + live-pty | Ctrl chord `InputEncodingTests.swift:325`; Option mapping `:205`; press/repeat/release `:818-868`. NEW `B23SpecialKeyMatrixTests.swift` pins the four arrows to `CSI A/B/C/D` and asserts every navigation/function key (Home, End, PageUp/Down, forward Delete, F1/F2/F5/F12) encodes a NON-EMPTY and MUTUALLY DISTINCT sequence. See "Row 3" below for why the non-arrow keys are not pinned to byte goldens. |
| 4 | Kitty progressive modes | RECORDED (new, encoder) · OPEN for closure | encoder | `KittyKeyboardGoldenTests.swift:148` (`CSI > 1 u` -> `\x1b[13;2u`) pins PUSH only — a terminal that latched Kitty mode permanently and ignored every pop passed that suite. NEW `B23KittyStackMatrixTests.swift` adds pop (`CSI < u` restores the legacy golden), stack nesting (two pushes need two pops), and query (`CSI ? u` reports flags that TRACK the push, asserted as a round trip so a terminal answering a constant fails). **Live traversal DEFERRED pending a harness capability** (a mode-emitting child plus a claim release), not a matrix failure: this row needs an application mode set first, and DECSET cannot be injected via `processOutput` on a live attach because the ordered-output engine owns the stream sequence. |
| 5 | dead key | RECORDED (encoder) + LIVE-PTY (write boundary) | encoder + live-pty | `InputEncodingTests.swift:516` — real surface, `´` -> `é` committed byte-exactly once; choreography at `:487`. |
| 6 | CJK IME | RECORDED (encoder) + LIVE-PTY (write boundary) | encoder + live-pty | `InputEncodingTests.swift:516` — multi-stage `日`/`日本` preedit writes nothing, then commits exactly `日本語`. |
| 7 | bracketed paste | RECORDED (new, encoder) · OPEN for closure | encoder | `Gate8ClipboardTests.swift:43` pins the SET direction. NEW `B23PasteBoundaryMatrixTests.swift` adds the RESET direction (`?2004l` stops bracketing while a safe single-line body still reaches the encoder verbatim) and asserts exactly one marker pair on set. Without the reset row, a build that bracketed unconditionally passed. **Live traversal DEFERRED pending a harness capability** (a mode-emitting child plus a claim release), not a matrix failure: this row needs an application mode set first, and DECSET cannot be injected via `processOutput` on a live attach because the ordered-output engine owns the stream sequence. |
| 7b | safe paste while unbracketed (SECURITY) | RECORDED (new) | encoder | `B23PasteBoundaryMatrixTests.swift` — with 2004 reset, a MULTILINE body is withheld entirely (zero bytes). **This is a SECURITY behavior, not a limitation:** an embedded newline would submit the pasted line to the shell without the user ever seeing it, which is the classic paste-injection vector. Do NOT "fix" this into sending. This discharges the clause's "with it reset, Ghostty's safe-paste rules apply." See "Row 7b" below. **Live traversal DEFERRED pending a harness capability** (a mode-emitting child plus a claim release), not a matrix failure: this row needs an application mode set first, and DECSET cannot be injected via `processOutput` on a live attach because the ordered-output engine owns the stream sequence. |
| 8 | mouse modes, local vs captured | RECORDED (new) | encoder | NEW `B23MouseModeMatrixTests.swift` — X10 (9) press-only, VT200 (1000) press+release with button-3 release sentinel, SGR (1006) `M`/`m` edge discrimination, Shift override writes zero bytes while captured. Pre-existing any-motion (1003) + SGR at `InputEncodingTests.swift:747`, `:775`. **Live traversal DEFERRED pending a harness capability** (a mode-emitting child plus a claim release), not a matrix failure: this row needs an application mode set first, and DECSET cannot be injected via `processOutput` on a live attach because the ordered-output engine owns the stream sequence. |
| 8b | mouse format 1005 (UTF-8) | RECORDED (new, encoder) · OPEN for closure | encoder | NEW `B23MouseFormatMatrixTests.swift` — at column 125 the default format emits the coordinate as one raw byte `0x9D` (not valid UTF-8 alone); DECSET 1005 re-encodes the SAME logical 157 as `0xC2 0x9D`. See "Rows 8b/8c" below on why the coordinate had to move. **Live traversal DEFERRED pending a harness capability** (a mode-emitting child plus a claim release), not a matrix failure: this row needs an application mode set first, and DECSET cannot be injected via `processOutput` on a live attach because the ordered-output engine owns the stream sequence. |
| 8c | mouse format 1015 (urxvt) | RECORDED (new, encoder) · OPEN for closure | encoder | `B23MouseFormatMatrixTests.swift` — DECSET 1015 reports `ESC [ 32 ; 125 ; 14 M`: same button (+32 biased) and same cell, in decimal, with no SGR `<` introducer. A cross-format row asserts all three transports agree on the same logical cell. **Live traversal DEFERRED pending a harness capability** (a mode-emitting child plus a claim release), not a matrix failure: this row needs an application mode set first, and DECSET cannot be injected via `processOutput` on a live attach because the ordered-output engine owns the stream sequence. |
| 9 | Retina resize coordinates | HELD (hector) | mixed | Backing-pixel coords `InputEncodingTests.swift:656`, `:676`; measured cell geometry `Gate7RenderingTests.swift:99`; `RESIZE`/`APPLIED` readback + stale-revision refusal `real-host-golden.zig:945`; independent `TIOCGWINSZ` readback `pending-a1-contract.zig:273`. End-to-end live Retina row `LiveHostAttachTests.swift:344` is skip-gated. HELD: hector (henry's respawn) owns resize; his landing gates this row. |
| 10 | retry / unknown semantics | RECORDED (new) | live-pty + fake-host | HOST side: `real-host-golden.zig:882` — identical `INPUT_SUBMIT` under a new transport correlation id returns a byte-identical `APPLIED` and the PTY echoes exactly once. CLIENT side (NEW `B23UnknownRetryMatrixTests.swift`): an `unknown` receipt fences input, so no further `INPUT_SUBMIT` is authored. See "Row 10" below for why fencing, not resending, is the correct reading of this clause. |
| 11 | no-duplicate-input | RECORDED (encoder) · OPEN for closure | encoder | `InputEncodingTests.swift:277`, `:291`, `:311` — a printable is embedded in the key event and never also sent as text; `:516` asserts writes equal the commit list exactly. Live traversal NOT YET DRIVEN — unlike rows 4/7/8, this one needs no application mode and is therefore not blocked by the harness capability gap; it simply has not been added to the live set yet. |

## Live-PTY traversal (partial) — and why it is the substance of closure

Today's "live input proof",
`LiveHostAttachTests.testLiveGate8InputRoundTrip`, drives a
`FakeManualSurface` — so it never exercises the real Gate 8 encoder at all.
The encoder rows meanwhile capture bytes at `onWrite` from a real
`GhosttyManualSurface` that never reaches a PTY. The two halves of the input
proof had therefore never been connected, which makes the real-encoder ->
real-PTY connection the actual substance of B2.3/A3 closure rather than a
formality.

`B23LiveEncoderTraversalTests.swift` establishes that connection for the rows
that need no application mode. The claim it earns, stated exactly:

> each row's real encoder bytes were **written to a live PTY, verified at the
> host write boundary with a correlated `written-to-terminal` receipt**.

That is deliberately NOT a "byte-verbatim round-tripped" claim. Reading the
bytes back would mean echoing them through the proof child (`read -r` plus
`printf %s`), which is a normalizer — it cannot carry NUL, and it would
certify the normalizer rather than the transport. The write-boundary claim has
no normalizer in the path. If story closure later wants the stronger
round-trip claim, it is a separate addendum requiring an echo-capable child.

Attribution: exactly one input event is driven per transaction, so each
receipt is attributable to that row's encoder bytes and nothing else. The
assertion is mutation-verified — asserting stage `queued` instead turns all
four rows RED against the actual `written-to-terminal`, proving it reads the
host's real stage rather than a default.

Rows with live traversal recorded: 3 (keys), 5 (dead key), 6 (CJK IME), plus
the plain-text positive control.

Rows still WITHOUT live traversal, and why: 4 (Kitty), 7 and 7b (paste), 8,
8b and 8c (mouse) all require an application mode to be set first. DECSET
cannot be injected with `processOutput` on a live attach — the ordered-output
engine owns the stream sequence and rejects a hand-fed frame as
`invalidValue`. Setting them faithfully needs the PTY child to emit the mode
as real output, which is harness work not undertaken here. Row 11
(no-duplicate-input) is also not yet driven live.

## What "OPEN for closure" means

Queen's ruling, recorded here so the distinction is not softened later: a row
marked `RECORDED (encoder)` has real, mutation-verified byte evidence against
the real vendor encoder, and the matrix LANDS with it. It is NOT sufficient
for B2.3/A3 STORY closure.

Six of the twelve rows — 3, 4, 5, 6, 7, 11, plus the new 8b/8c — have never
had their bytes traverse sessiond or a PTY. Story closure requires live-PTY
traversal for them, on the same footing as rows 9 and the other held live
rows. They stay OPEN until the held live rows run after the parallel PTY and
resize fixes land.

Incremental landing of the encoder evidence is fine. Reading these rows as
"done" is not.

## Rows 8b/8c — the coordinate had to move

The other mouse rows click at (25, 40), which lands on column 2. At column 2
the 1005 encoding is BYTE-IDENTICAL to the default format: the UTF-8 form
only diverges once a coordinate exceeds 95, where the +32 biased value passes
127 and must become a multi-byte sequence.

A 1005 row recorded at the usual coordinate would therefore have passed
against a terminal that ignored DECSET 1005 entirely. These rows click at
column 125 instead, and the suite carries a positive control for the
COORDINATE CHOICE rather than only for the assertion: it asserts that at the
low column the two formats DO coincide. If that control ever fails, the
divergence threshold moved and the far-right coordinate must be re-derived.

The goldens were discovered by dumping the vendor's actual output and then
reconciled against the protocol before being pinned — `0xC2 0x9D` is exactly
UTF-8 for U+009D, the same 157 the default format sends raw — rather than
guessed from memory or back-filled from whatever the build happened to emit.

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

To be explicit for anyone who later reads the withheld bytes as a bug: this
is a SECURITY property. Silently sending a multiline clipboard payload to a
shell is the classic paste-injection vector, and a "fix" that makes this row
send would reintroduce it. If a product requirement ever needs multiline
paste while unbracketed, it must go through an explicit user confirmation,
not through deleting this row.

The row was therefore split by paste BODY, not by expectation: a safe
single-line body must land verbatim, an unsafe multiline body must be
withheld. Folding the two together would let a build that always withholds,
or one that always sends, look correct. The withholding row carries its own
attribution control: the same multiline body IS written when bracketed, so
the silence is safe-paste rather than a dead clipboard reader.

## Row 3 — why only the arrows are byte goldens

The four arrows are pinned to exact bytes: `CSI A/B/C/D` in the default cursor
key mode is spec-certain, and the repo already cites left -> `\u{1B}[D`.

The remaining navigation and function keys assert only that each encodes a
non-empty, mutually distinct sequence. That is weaker on purpose. Their
sequences vary with DECCKM and keypad state, and a "golden" produced by
reading this build's output back into the assertion would record current
behavior rather than test it — it would pass against any regression that
changed the value, because the value came from the change.

The two weaker claims still bite where it matters. Non-empty catches the
exact bug class this codebase has already hit: a documented "zero writes for
special keys" blocker in which every navigation key silently encoded nothing.
Distinctness catches two physical keys collapsing onto one sequence. Pinning
the exact values belongs with the live-PTY rows, where a real TUI can
adjudicate them.

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

`bootstrap/evidence/m1-b2-b23-input/` — 83 tests, 0 failures across nine
suites, each recorded unpiped with its own `REAL_EXIT`, plus
`evidence-sha256.txt` (excludes itself; `.txt` because `*.log` is gitignored
at `.gitignore:38` and would not survive a fresh checkout). Regenerate with
`scripts/b23-acceptance-matrix.sh`.

## Remaining work

Closed in this bundle: rows 3 (arrows pinned, navigation/function keys
non-empty and distinct), 4 (Kitty pop and stack nesting), 7 and 7b (DEC 2004
reset and safe paste), 8 (mouse encodings and Shift override), 10
(client-side unknown semantics).

No defect-independent rows remain open, including the DECSET 1005 and 1015
mouse coordinate formats added mid-task. Everything still outstanding is held
on the live-PTY sequencing below.

HELD pending the parallel PTY and resize fixes landing on main: row 9
end-to-end Retina resize with observed SIGWINCH delivery, and live-PTY byte
round-trips for every encoder-graded row — 3, 4, 5, 6, 7, 7b, 8, 8b, 8c and
11. All of those have encoder-level evidence ONLY and have never had their
bytes traverse sessiond or a PTY.

Row 8 and the format rows 8b/8c belong in that list as squarely as the key
and paste rows: a mouse report that Ghostty encodes correctly still has to
reach the child process, and nothing here proves it does.

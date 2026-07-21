# M1-B1 Gate 10 — accessibility and operability qualification design

Status (refreshed 2026-07-21): this design was authored 2026-07-18 on a branch
that was superseded before landing. It is recovered here as the Gate 10 design
of record, annotated against what has since shipped on `main`. Two scopes are
now distinct:

- **Engine scope — DELIVERED.** The seventh export
  `hive_ghostty_surface_semantic_snapshot_v1` landed at `602d0680` and is
  qualified with recorded evidence. The authoritative status paragraph is
  `planning/story-m1-b1-ghosttykit-qualification.md`, gate 10 status.
- **AppKit adapter (B2.6) — DELIVERED, machine scope only.** The accessibility
  tree, notification policy, and pinned-generation reads shipped in
  `workspace/Sources/HiveTerminalKit/View/HiveTerminalView+Accessibility.swift`,
  with later fixes `aa00f276` and `ea8de52d`. Its recorded evidence is
  `raw/qualification/hive-b26-gate10-accessibility/`.
- **Renderer-side live proof — OPEN.** Live VoiceOver, Accessibility
  Inspector, the Instruments leak/UAF/latency stress, and DoD row K on the
  vendor TUIs are not done. The multi-pane operability probe described below
  is not built. This document still does not claim Gate 10 live proof.

Section headings below carry a **DELIVERED** / **OPEN** marker on that basis.
Everything unmarked is design prose that remains the standing contract.

## Scope and evidence rule

This design implements gate 10 of
`planning/story-m1-b1-ghosttykit-qualification.md`: Hive owns the AppKit
accessibility contract for the custom-drawn manual surface, and live VoiceOver,
Accessibility Inspector, and Instruments runs are required. Automated property
tests are positive controls only. In-tree Ghostty and Hive code are candidate
implementations, not external evidence.

External sources were refreshed on 2026-07-18:

- [Accessibility for AppKit](https://developer.apple.com/documentation/AppKit/accessibility-for-appkit)
  directs custom `NSView` controls to role-based accessibility APIs and custom
  drawn children to `NSAccessibilityElement`.
- Apple's [custom-control guide](https://developer.apple.com/library/archive/documentation/Accessibility/Conceptual/AccessibilityMacOSX/ImplementingAccessibilityforCustomControls.html)
  requires role-appropriate properties, parent/child relationships, frames,
  and change notifications for custom drawn elements.
- [NSAccessibilityProtocol](https://developer.apple.com/documentation/appkit/nsaccessibilityprotocol)
  defines the text contract used here: UTF-16 ranges, insertion line, visible
  range, string/range/line conversion, and range frames. It also distinguishes
  properties, actions, and notifications.
- [NSTextInputClient](https://developer.apple.com/documentation/AppKit/NSTextInputClient)
  is the separate input-method contract. Its marked/selected ranges and
  character coordinates must agree with the accessibility snapshot; it is not
  a substitute for terminal cursor or viewport state.
- Apple's [VoiceOver evaluation criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/voiceover-evaluation-criteria)
  require all visible text, accurate text entry/selection, logical navigation,
  preserved reading position across refreshes, keyboard operability, and live
  VoiceOver testing.
- [Accessibility Inspector](https://developer.apple.com/documentation/accessibility/accessibility-inspector)
  exposes the hierarchy and attributes for inspection. Its
  [macOS audit](https://developer.apple.com/documentation/accessibility/performing-accessibility-audits-for-your-app)
  checks closed-loop parent/child relationships and role-valid actions, but
  Apple explicitly says a clean automated audit is not complete accessibility
  proof.
- [NSAccessibility notifications](https://developer.apple.com/documentation/appkit/nsaccessibility/notification/1524251-layoutchanged)
  provide value, selected-text, row-count, focus, layout, movement, resize, and
  destruction signals. Explicit spoken messages use
  [announcementRequested](https://developer.apple.com/documentation/appkit/nsaccessibility-swift.struct/notification/announcementrequested),
  with announcement text and priority in `userInfo`.
- Apple's [memory guidance](https://developer.apple.com/documentation/xcode/gathering-information-about-memory-use)
  uses Allocations timelines, statistics, and generations to establish which
  live allocations grow across a feature cycle.
- Apple's [hang-analysis guidance](https://developer.apple.com/tutorials/Instruments/getting-started-with-hang-analysis)
  says main-thread work must not run uninterrupted for more than 100 ms. The
  Hangs and Time Profiler instruments distinguish busy from blocked main-thread
  stalls.
- Apple's [sanitizer guidance](https://developer.apple.com/documentation/xcode/diagnosing-memory-thread-and-crash-issues-early)
  assigns memory-corruption and use-after-free detection to Address Sanitizer;
  it complements, rather than replaces, the Leaks and Allocations traces.
- The [pinned public `ghostty.h`](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/include/ghostty.h)
  exposes separate size, text, selection, and IME-point reads. It also exposes
  scrollbar and selection-changed action tags, but no cursor-to-text index or
  atomic semantic-snapshot function.

## Semantic snapshot boundary — DELIVERED

Shipped as `hive_ghostty_surface_semantic_snapshot_v1`, the seventh allowlisted
export, carried by `native/ghostty-patches/0004-hive-semantic-snapshot.patch`
(fourth in `native/ghostty-patches/series`; the third slot went to the Gate 6
restore-in-place patch). Qualified by `scripts/qualify-ghostty-gate10.sh` and
`workspace/Tests/GhosttyGate10Probe/main.swift` — engine scope only, no AppKit
layer — with C-ABI, allocation-ownership, atomicity, and sanitizer evidence in
`raw/qualification/ghostty-b1-gate10-snapshot/`. The Swift-side machine tests
are `workspace/Tests/HiveTerminalKitTests/Gate10SemanticSnapshotTests.swift`.

The accessibility adapter consumes one synchronous, main-thread snapshot. It
must not perform independent C reads from individual accessibility getters.
Every getter and row element reads the cached snapshot for one generation.

Required fields are:

| Field | Meaning |
|---|---|
| `generation` | Monotonic semantic generation; never a render generation unless the engine supplies that identity. |
| `text` | UTF-8 terminal text plus one precomputed UTF-16 length/range space. |
| `rows` | Visible semantic rows in display order, each with its UTF-16 range, cell span, screen-frame inputs, and stable visible-slot identity. |
| `cursor` | Visibility, cell row/column, UTF-16 insertion index and line, and cursor rectangle inputs. Geometry alone is insufficient for the insertion range. |
| `selection` | Exact selected text plus an optional viewport-clipped UTF-16 range. Gate 8's interactive selection/copy API remains a separate consumer path. |
| `viewport` | Scrollbar `total`, `offset`, and `len`, plus whether the viewport follows the bottom. |
| `geometry` | Rows/columns and pixel geometry from the locked Terminal commit; cell dimensions are derived from those locked values. |
| `focus` | The view's first-responder truth, mirrored to the engine by Gate 8. |
| `markedRange` | Gate 8's separate `NSTextInputClient` preedit state; it is not read through the semantic export. |

Gate 3 established that terminal and renderer workers mutate semantic state
off-main. Stock size/text/selection/IME reads take separate critical sections,
so an `@MainActor` aggregation can still tear. The user therefore approved one
deliberate seventh fork export. It captures every field below under exactly one
`renderer_state.mutex` acquisition, retains no Terminal Pin/node pointer after
unlock, and is admitted only from the main thread outside Ghostty
callback/reentrant stacks.

The native capture has these load-bearing rules:

- visible text is bounded explicitly to `.viewport`; it never formats the full
  `.screen` scrollback;
- rows, columns, pixels, cells, cursor, selection, and scrollbar values all
  come from the locked `Terminal`, never `core_surface.size`;
- row/cell-to-UTF-16 boundaries are resolved while locked, including blank,
  trimmed, wide-continuation, combining, and pending-wrap cells;
- a hidden or off-viewport cursor has no visible insertion index/frame;
- selected text is exact, while a partially visible non-rectangular selection
  has a clipped visible range and a rectangular selection has no fabricated
  contiguous `NSRange`;
- generation is a saturating monotonic counter over a canonical digest of every
  exported semantic field; it never hashes padding or native pointers.

Gate findings that justify the export and drive the Swift adapter:

- Gate 8's `imePoint()` supplies cursor geometry only. It cannot produce a
  UTF-16 cursor index through wide/combining graphemes, soft wraps, scrollback,
  or alternate-screen state. `selectedRange()` is `NSNotFound` when no
  selection exists.
- `read_text + size` cannot recover viewport position. Gate 9 now preserves the
  scrollbar action payload (`total`, `offset`, `len`) as a typed, observe-only,
  main-delivered notification.
- Generation/change observation is the union of main-delivered invalidate,
  Gate 9's typed selection/scrollbar notifications, direct geometry/focus and
  lifecycle changes, and successful accessibility scroll actions. Each
  semantic signal re-reads the native snapshot; its digest-backed generation
  prevents duplicate accessibility notifications.

## Accessibility tree — DELIVERED (machine scope)

Implemented in `HiveTerminalView+Accessibility.swift`. Two deltas from the
design as written: row elements declare the plain `.staticText` role rather
than a navigable-static-text role, and `TerminalAccessibilityController`
caches one snapshot until invalidation, with `withPinnedSnapshot` holding a
single generation across a multi-property read batch — the fix at `aa00f276`
for tree dumps that mixed flat properties from one generation with children
from the next. Machine coverage is
`workspace/Tests/HiveTerminalKitTests/Gate10AccessibilityTests.swift`; the
committed tree dumps are `raw/qualification/hive-b26-gate10-accessibility/`,
cross-checked by `scripts/audit-hive-b26-ax-dumps.py` against a preserved torn
fixture as its positive control.

The tree is intentionally shallow:

```text
HiveTerminalView — text area, focused state, full text/range contract
├── visible row 0 — navigable static text, row UTF-16 range, screen frame
├── visible row 1 — navigable static text, row UTF-16 range, screen frame
└── ... one element per reported visible semantic row
```

The view remains the editable text-area element. It exposes value, number of
UTF-16 characters, visible/shared range, selected text/range, insertion line,
string/range/line conversions, and range frames from one cached snapshot.
Gate 8 remains the sole input/IME/copy path.

Rows are cached `NSAccessibilityElement` subclasses, not rebuilt on every
query. Each has the terminal view as parent, a visible-slot identity, a
navigable-static-text role, its semantic value/range, and a frame in parent
space derived from Gate 7 geometry. Refresh updates the existing row objects,
adds or destroys only the changed tail, and never returns stale or duplicate
children.

The cursor is represented by the text area's zero-length insertion range,
insertion line, and `accessibilityFrame(for:)`. A separate noisy "cursor"
child is unnecessary if VoiceOver can locate and announce this insertion point
in the live run. If it cannot, the live result reopens the tree design; it does
not authorize a fabricated cursor label.

## Change and announcement policy — DELIVERED, with one gap

The notification set and the no-flood rule shipped. Five of the six
announcements exist in `HiveTerminalView`: “Terminal bell” (high), “Clipboard
access denied” (high), “Terminal closed” (medium), “Terminal ready” (low), and
“Terminal reconnecting” (low). **“Terminal unavailable” is not implemented** —
it remains an open item of this design, not a delivered behavior. The real
`NSAccessibility.post` call site is `TerminalAccessibilityController.post`; no
machine test observes AppKit delivery of it (`Gate10AccessibilityTests` watches
an in-process probe), so a green Gate 10 suite is not permission to remove it.

On each main-thread semantic signal, take one new snapshot, compare it with the
cached snapshot, update row objects, then post only the relevant notifications:

- text or cursor: `.valueChanged` on the text area and changed rows;
- selection: `.selectedTextChanged`;
- row count: `.rowCountChanged` plus `.layoutChanged` with changed elements;
- geometry: `.layoutChanged` on the text area and `.moved`/`.resized` for
  affected rows;
- first-responder transition: `.focusedUIElementChanged`;
- teardown: `.uiElementDestroyed` for removed custom elements.

Ordinary output does not post `announcementRequested` per chunk. That would
flood speech and reset reading. The implementation requests only “Terminal
bell” (high), “Clipboard access denied” (high), “Terminal reconnecting” (low),
“Terminal ready” after an attach or restore reaches its first correct frame
(low), “Terminal unavailable” (high), and engine-requested “Terminal closed”
(medium). Their delivery and lack of output floods are captured in live
evidence.

## Operability probe and Instruments workload — OPEN

Nothing in this section is built. The name `GhosttyGate10Probe` has since been
claimed by the engine-scope C-ABI probe
(`workspace/Tests/GhosttyGate10Probe/main.swift`, declared in
`workspace/Package.swift`), which deliberately contains no AppKit layer. The
multi-pane operability probe below therefore needs a distinct target name when
it is built; it is blocked on the B2 renderer wiring like the rest of the
renderer-side proof.

Add a release-built multi-pane operability probe after Gates 3/7/8 land. It
uses four real `HiveTerminalView`/manual surfaces in one AppKit window and emits
stage-delimited JSONL so recordings can be aligned with the workload.

One qualification run performs:

1. Create four panes, focus each once by an explicit synthetic user action,
   then return focus to pane 0. Record the steady baseline.
2. Attach all four panes through the real replay client and restore a real Gate
   6 checkpoint. The between-pass restore occurs before every reattach/replay;
   all attaches present a first correct frame.
3. Deliver exactly 104,857,600 output bytes total in 64 KiB chunks, round-robin
   across panes and one chunk per main-run-loop turn. The fixture contains
   hard/soft wraps, CJK, combining marks, emoji/ZWJ, cursor movement, primary
   and alternate screens, and enough newline output to prune scrollback.
4. Every 256 chunks, exercise the next pane in round-robin order through a
   different nonzero reported geometry. During output, repeatedly scroll away
   from and back to the bottom, select/copy, and query the accessibility tree.
   The work is deliberately one pane per main-loop turn; batching four large
   copy/selection operations into one synthetic turn would not model user input.
5. Restore and reattach every pane, then repeat a second 100 MiB pass to prove
   that live allocations plateau after the configured scrollback bound.
6. Close and recreate every pane 100 times while callbacks, draw invalidations,
   accessibility queries, resize, attach, and restore are active. End with all
   surfaces freed and the window closed.

The manual-surface configuration must state an explicit byte-valued
`scrollback-limit`; relying on an upstream default is not a product policy.
The probe records that value and pane count. Bounded-memory acceptance requires
both the configured bound and an Allocations trace whose live-byte curve reaches
a repeatable plateau across the second pass and post-close generation. Any
continuing positive slope, retained surface/view generation after close, or
unexplained allocation family blocks the gate.

Capture these independent runs at the frozen commit:

- Leaks: zero unresolved leaks rooted in HiveTerminalKit, Ghostty manual
  surfaces, callbacks, accessibility elements, or AppKit host views.
- Allocations: generation marks at baseline, each 100 MiB pass, restore, and
  final close; retained objects and live bytes satisfy the bound above.
- Time Profiler plus the probe's run-loop-delay monitor: no main-thread work
  interval or measured delivery delay reaches 100 ms. Inspect busy and blocked
  time separately.
- Address Sanitizer stress: the same lifecycle workload reports no use after
  free, buffer error, or memory corruption. A clean Leaks trace alone is not
  UAF evidence.

## Live accessibility acceptance — OPEN

The B2.6 slice landed the machine half: pinned-generation accessibility tree
dumps through input, scroll, alternate screen and its exit, replay, resize, and
teardown, plus a machine Inspector-style audit. Those dumps were captured under
an XCTest host where the renderer never presents, so they are Hive property
dumps of one semantic generation, not live-surface or system-AX captures — and
the committed scroll dump is a no-op (`scroll_page_up` at the bottom of the
buffer), not a scroll-transition proof. The live human passes below are
explicit `PENDING_HUMAN` slots in
`raw/qualification/hive-b26-gate10-accessibility/human-checklist.txt` and
remain unmet.

Record screen and VoiceOver audio. Accessibility Inspector and VoiceOver runs
must use the same frozen build and corpus, and a second reviewer independently
reproduces them.

Accessibility Inspector must show:

- text-area parent and exactly the reported visible row children;
- closed-loop parents, unique children, valid roles/actions, and screen frames;
- row text/ranges plus each declared hard-line-break length covering the
  text-area value in UTF-16 space;
- cursor insertion range/line/frame, focus, selected text/range, and scrollbar
  position matching the visible terminal;
- correct incremental changes through output, scroll, resize, alternate screen,
  attach, restore, and teardown, with no stale or duplicate row elements;
- recorded notification behavior without announcement floods.

With VoiceOver alone, the reviewer must navigate every visible row forward and
back, locate the cursor and selection, type and edit text, scroll retained
history, hear committed output and the declared lifecycle announcements,
survive attach/restore, and close the terminal without sighted assistance.

## Evidence bundle and hold

Store small text manifests, JSONL, exported trace summaries, hashes, exact
commands, versions, settings, results, and reviewer dispositions under the
qualification tree. The delivered slices took two directories rather than the
single `raw/qualification/ghostty-b1-gate10/` proposed here:
`raw/qualification/ghostty-b1-gate10-snapshot/` for the engine export and
`raw/qualification/hive-b26-gate10-accessibility/` for the AppKit adapter. The
still-open Instruments and live-VoiceOver evidence belongs with the latter.
Keep large `.trace` and screen/audio
recordings in the review artifact store and record their immutable identifiers
and SHA-256 hashes in the bundle. Automated tests, Inspector audits, trace
summaries, and live recordings must all name the frozen git commit.

When green, commit the implementation and evidence manifest, report the frozen
pin to queen, and hold. Gate 10 does not call `hive_land`; independent
cross-vendor review precedes landing.

The engine export and the B2.6 AppKit slice each cleared that review and landed
under it. The hold still governs the open renderer-side scope: the Instruments
runs, the live VoiceOver and Accessibility Inspector passes, and DoD row K on
the vendor TUIs. Gate 10 is not closed.

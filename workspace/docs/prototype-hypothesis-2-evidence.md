# Prototype hypothesis 2 — native transcript pane: evidence

Blueprint hypothesis: *"Render real partial messages, huge tool output, ANSI data, missing provider fields, interactive subprocess requests, approvals, and diffs. It must beat a terminal on comprehension while meeting VoiceOver, IME, selection, links, and find expectations. Failure reopens the terminal-renderer decision."*

This prototype was built and driven on 2026-07-10 (`workspace/`, mock structured event source, no daemon). Verdict up front: **the hypothesis survives and is strengthened for every case the prototype could test mechanically; it is not yet fully proven**, because "beats a terminal on comprehension" is ultimately a human claim and one named case (interactive TTY subprocesses) is out of scope until the SwiftTerm phase. Nothing observed reopens the terminal-renderer decision.

## What was rendered, and what a terminal would have done

Every hard case in the hypothesis ran through the fixture script (`FixtureScript.standard()`), reduced by `TranscriptModel`, and rendered into a live NSTextView:

- **Streaming partial messages.** Deltas sharing a message ID grow one transcript item in place with a "typing…" indicator; a terminal shows accumulating fragments with no message identity. Verified by unit test (`testStreamingDeltasGrowOneItemInPlace`) and visually in the 25 s live run.
- **Huge tool output.** A 5,000-line tool result renders as a 12-line preview plus an explicit "Show all 5,001 lines" control; expansion and collapse are commands, so the document stays navigable. The same output in a terminal is ~65 screens of scrollback that destroys the surrounding conversation. This is the single largest comprehension win observed.
- **ANSI content.** SGR color/weight/underline (16-color, 256, truecolor) render as styled native text mapped to system semantic colors, so logs adapt to light/dark appearance; cursor-movement and OSC sequences are dropped, never leaked (`testNonSGRSequencesAreDroppedCleanly`). A terminal renders these too — parity, not advantage — but the transcript keeps them selectable and findable inside one document.
- **Missing provider fields.** Messages and sessions with absent model/timestamp fields render as absent ("model unknown"), never invented — exercised by the mock envelope omitting a timestamp on every sixth event and by nil-model fixtures.
- **Approvals.** An approval request renders with title, detail, inline diff, and explicit Approve/Deny controls that route through the shared command model; keyboard (⇧⌘Y/⇧⌘N), menu, and link click are the same command. Focus, layout changes, and attention-item activation provably never resolve it (`testFocusAloneNeverClearsAttentionOrApproves`). In a terminal the equivalent prompt scrolls away and its answer is a keystroke race.
- **Inline diffs.** Native attributed rendering with add/delete line tinting via system colors, selectable and findable like any text.

## Platform expectations (VoiceOver, IME, selection, links, find)

The prototype's core bet — build the transcript on NSTextView so platform behavior is inherited rather than reimplemented — held:

- **Find** is the native find bar (`usesFindBar`, incremental search) over the entire transcript including expanded tool output; zero custom search code.
- **Selection and copy** cross item boundaries as ordinary text selection; a terminal grid cannot select "message + diff" as one logical range.
- **Links** are real link attributes: https URLs open natively; `hive://` URLs are the command transport for expand/approve, so a link click and a menu item cannot disagree.
- **IME** applies to the composer (an editable NSTextView), which inherits marked-text/candidate behavior from the platform; the read-only transcript does not intercept keystrokes.
- **VoiceOver** gets native text semantics for the whole transcript plus one accessibility group per pane with status as the accessibility value and custom actions (Promote, Acknowledge, Close) mirroring the command model.

Caveats recorded honestly: these are *inherited surfaces verified to be wired*, not a completed conformance audit. A VoiceOver session with a screen-reader user, an IME stress pass (Japanese/Chinese composition in the composer during streaming updates), and re-verification of range-tracked in-place updates at much larger transcript sizes (the current fixture peaks around 5,000-line items; an eight-hour soak is a release target, not yet run) remain open.

## What this prototype deliberately did not test

- **Interactive subprocesses that expect a TTY.** Out of scope by design; this remains the strongest argument for the limited SwiftTerm shell pane and stays an open question in the blueprint.
- **Human comprehension measurement.** The structural comparison above (collapse vs. scrollback flood, message identity vs. fragment stream, persistent approval state vs. scrolled-away prompt) is strong but is an engineering argument, not a user study.
- **Real provider event streams.** The mock envelope mirrors the AgentHost journal shape (monotonic per-session sequence, optional provider timestamps); field-level alignment with john's provider-conformance catalogue and sarah's WAL envelope is pending their results and is isolated to `AgentEvent.swift`.

## Layout, motion, and attention findings (foundation, not hypothesis 2 proper)

Built alongside the transcript and worth recording: the deterministic master/satellite tree holds its invariants under test (same ordered inserts + same geometry ⇒ identical frames; close collapses only the parent split; promote/return-orchestrator is a satellite-order-preserving swap round trip). The ~180 ms transition is interruptible by construction — the animator owns presentation frames, so a retarget starts from true presentation geometry — and the terminal-cell commit fires exactly once per settled layout, immediately under Reduce Motion. The attention queue orders by severity then age and is only ever cleared by explicit resolution commands. All of this ran end to end in `--smoke` through real NSViews.

# M1-B2 — Host live vendor TUIs in Workspace with HiveTerminalView

Milestone: M1, track B
Backlog position: after the M1-A0 freeze, M1-A2, and M1-B1; before the STORY-001/STORY-002 Removal Gate
State: design written; **must pass independent cross-vendor design review before landing**

## Why

Hive still needs the user-visible half of the new terminal stack. M1-A0 owns the frozen project-neutral terminal-host contract, M1-A2 implements its sessiond backend, and M1-B1 qualifies the pinned Ghostty manual-I/O engine boundary, but none proves that a real user can operate a live Claude Code, Codex, or Grok TUI in a Workspace pane. M1-B2 supplies that proof by making one `HiveTerminalView` render one exact session generation, routing every terminal operation over the sessiond terminal-host boundary, and making pane/window/Workspace lifecycle authoritative for provider lifetime.

This story is the renderer-side prerequisite for the STORY-001/STORY-002 atomic cut. Code presence, a mock surface, screenshots, and a single-vendor demo are not completion evidence. The target is STORY-002 DoD-2, DoD-3, and DoD-3a, plus the renderer cells of the STORY-001 Removal Gate, proven live and independently reproduced.

## Sequencing

1. **M1-A0 is the contract authority.** Its reviewed freeze owns exact-generation create, inspect, list, terminate, byte I/O, resize, attach/replay, exit, and reap postconditions. B2 consumes that neutral behavior; it does not add Hive, vendor, repository, or Workspace policy below the neutral boundary except through the reviewed visibility extension required below.
2. **M1-A2 is the backend prerequisite.** A2 implements the A0 freeze over sessiond and supplies the production backend B2 attaches to; it is not the source of the frozen contract.
3. **M1-B1 is the engine prerequisite.** B2 inherits the B1-qualified upstream Ghostty commit, Hive patch series, toolchain, build identity, ABI manifest, and behavior corpus. B2 may not silently move the pin or weaken a B1 gate.
4. **The Workspace-visibility interlock lands first inside B2.** Production create admission is intentionally closed until a real Workspace pane supplies a live Workspace PID, its exact start token, and an open-terminal inventory revision. Before implementing that gate, B2.1 first takes the visibility request/lease shape through the M1-A0 contract gate as a reviewed A0 extension. Today's implementation shape is reference material, not a freeze. The visibility source is its own build increment and lifecycle channel, not a separate story and not part of renderer transport.
5. **Renderer integration follows the visibility source.** A visible starting/attaching pane record exists before create; the created exact generation then attaches to its manual-I/O surface. Attach transport may be replaced without changing logical visibility.
6. **B2 discharges the renderer-coupled M1-A3/M1-A4 live proofs (queen-adjudicated).** A3's input-arbiter proof closes through B2.3: synchronous human-input claim, one ordered write path, and no automation-timeout steal. A4's visibility lease, renderer-crash-to-bounded-replay, and Workspace-quit-to-verified-provider-tree-termination proofs close through B2.1, B2.2, and B2.5 respectively. A3/A4 owners retain only daemon-side arbiter or lease semantics that are provable without a renderer and are not already covered by A2. If a fresh owner inventory finds no material remainder, A3/A4 fold into B2 and close with this evidence rather than remain hollow backlog items.
7. **No removal happens in B2.** SwiftTerm and the tmux attach path stay frozen while B2 qualifies. When B2 is green, STORY-001 and STORY-002 execute as one atomic hard cut with no renderer or host fallback. Their full matrix is re-run on the post-deletion tree before that cut lands. STORY-002 owns its paired DoD-7 terminal/workspace documentation cleanup at that atomic cut; B2 supplies the behavior contract and evidence but does not absorb or orphan that task.
8. **M1 remains provider-policy neutral.** Real vendor binaries are manually launched as black-box terminal probes. Provider launch profiles, readiness, belief, approvals, messaging, and authenticated status remain M2 work.

## Scope

- One edge-to-edge `HiveTerminalView` in a Workspace pane renders exactly one exact locator and generation. It never resolves “latest,” retargets by display name, or displays bytes from another generation.
- A Hive-owned adapter is the only consumer of libghostty/libghostty-vt symbols. It creates a manual surface with no child process or PTY, ingests ordered host output, exposes rendering and semantic terminal state, encodes native input, and tears down deterministically.
- The surface attaches to sessiond, restores a compatible checkpoint when supplied, replays retained bytes, follows live output, acknowledges only contiguous applied output, handles gaps explicitly, and renders typed exit/failure states.
- Keyboard, focus, resize/SIGWINCH, scroll and bounded scrollback, search, selection, copy, bracketed paste, IME composition, mouse modes, Retina scale changes, sleep/wake, and accessibility follow the VT and AppKit contracts below.
- Pane, window, and Workspace lifecycle publishes real open-terminal visibility. User close means exact-generation termination, never renderer detach. Workspace quit terminates and verifies every open provider tree.
- The result is project-agnostic: command, working directory, environment, identity, and geometry arrive through contracts. Nothing assumes the Hive repository, Bun, a package layout, or a provider-specific project shape.

## Design

### Fixed invariants and data flow

```text
Workspace pane inventory ──visibility attestation──> Hive daemon ──lease/admission──> sessiond
          │                                                        │
          └── exact generation ──attach grant/replay/output────────┘
                               │
                         HiveTerminalView
                               │
                 Hive-owned Ghostty adapter
                               │
AppKit event ──Ghostty encoder─┴──INPUT_SUBMIT / APPLIED──> terminal host PTY
```

- The pane inventory proves user-visible representation; renderer attachment proves only that a disposable viewer transport exists. Neither implies the other.
- Sessiond owns the PTY, process tree, ordered output, canonical terminal state used for replay, terminal-generated query replies, resize application, exit observation, and reap evidence. The Workspace never acquires a PTY descriptor.
- The rendering surface is a copy of the canonical stream. Output-induced DA/DSR/DECRQSS/XTGETTCAP and similar replies are disabled in the rendering copy so they cannot duplicate sessiond's canonical replies. Only bytes caused by an AppKit user event leave the renderer adapter.
- All identities are exact and generation-fenced. A late attach, output frame, input receipt, resize result, exit event, or termination result for an old binding is discarded and cannot mutate the current surface.

### Libghostty embedding boundary

The B2 engine pin is Ghostty commit `73534c4680a809398b396c94ac7f12fcccb7963d`, inherited from M1-B1. The public header at that commit says the embedding API is not general-purpose yet and names the Ghostty macOS app as its sole consumer. The libghostty-vt header calls its C API incomplete, work in progress, and unstable. Therefore:

- No upstream Ghostty type, callback, constant, or lifetime rule crosses the Hive-owned adapter boundary. Workspace code sees only Hive value types and operations: create/destroy a manual surface; apply ordered output; restore a build-bound checkpoint; set focus/size/scale/occlusion; draw; encode key/text/preedit/mouse/paste; read selection and semantic screen state; and receive copied invalidate/title/bell/close events.
- The exact upstream tree, public-header hashes, Hive patch-series hash, Zig/Xcode/Swift versions, deployment target, architectures, license/SBOM, exported-symbol allowlist, and engine build identity are one immutable build manifest. The build identity includes architecture and checkpoint-layout fingerprint. A mismatched build or architecture cannot restore a checkpoint or attach as if compatible.
- Compile-time and runtime ABI gates cover header self-containment, symbol presence and absence, struct size/alignment, enum values, calling convention, callback ownership, and app/config/surface destruction order on arm64 and x86_64. The behavior gate then proves no hidden process/PTY, ordered output at every byte split, terminal replies, checkpoint/restart, input encoders, rendering, GPU lifecycle, actions/security, and accessibility. Header compilation alone is never sufficient.
- Callback payloads are copied before return; rendering/AppKit calls are main-thread confined; output ingestion is serialized with draw/restore/destroy; destroy prevents later callbacks and cannot re-enter itself.
- An upstream or patch change is a new reviewed supply-chain increment. It re-runs the complete B1 and B2 corpora before activation. There is no “compatible enough” ABI fallback.

Manual I/O has one direction per responsibility. Ordered `OUTPUT` bytes mutate the surface through the adapter's output-ingestion operation. Native events enter Ghostty's encoders and the adapter copies the resulting bytes into the input transaction queue. The surface never launches a command, opens a PTY, reads provider stdout directly, or writes a provider descriptor.

### Session attachment, replay, output, and exit

1. A visible pending pane asks the daemon for one exact generation and a one-use attach authority. The authenticated host attach repeats the exact session reference and generation; both ends reject a mismatch.
2. The renderer declares its protocol, engine build, architecture, supported checkpoint content types, and last contiguous event/output cursor. A fresh surface starts at zero; a reconnect starts at its last acknowledged cursor only if the engine identity and local state still match.
3. If the host supplies a checkpoint, the adapter verifies type, build, architecture, digest, declared bounds, and cursor before atomic restore. It then applies replay bytes strictly after the checkpoint through-sequence. Without a checkpoint it replays retained output from the negotiated cursor.
4. Live `OUTPUT` is applied exactly once in increasing byte ranges. Duplicate identical ranges are harmless; overlap with conflicting bytes, a gap, overflow, wrong generation, or a late connection produces a typed rebase/failure state. The renderer never paints a stale cached frame as live.
5. Output acknowledgement advances only after the manual engine accepted a contiguous range. Pixel presentation is not falsely claimed; “first correct frame” additionally requires checkpoint/replay completion and a draw for the exact current generation.
6. Renderer recreation or transport loss may detach while the logical pane remains in the live inventory. It requests a fresh one-use grant and resumes from the last acknowledged cursor. Daemon restart revalidates the Workspace visibility source, then the renderer reconnects and replays without duplicated or missing terminal bytes.
7. Natural process exit disables input, drains retained output, and shows exit plus authoritative reap evidence. A process-exit notification without reap evidence is not “terminated.” Close of the exited pane still removes its visibility record and reconciles lifecycle state.

### Input and resize semantics

- The terminal becomes first responder only after a direct click or explicit focus command. Output, status, attach, replay, and alerts never steal focus. Focus-in/out bytes are encoded only when the terminal mode requests them.
- A user event is held until the exact viewer owns a human input claim. Ghostty encodes the event against current canonical modes; the copied byte batch is submitted through the adopted `INPUT_SUBMIT` request with exact session reference, claim token, transaction ID, idempotency key, and byte operation. The correlated discriminated `APPLIED` result must be the input branch. B2 does not use raw `HUMAN_INPUT` as a correctness path.
- One serialized renderer queue preserves encoder callback order. Retry repeats the same domain transaction and idempotency key; it never invents a new act after an unknown result. Receipts distinguish accepted, queued, written-to-terminal, rejected, and unknown, and never claim provider consumption.
- The v1 decoded transaction limit is 128 KiB. Paste at the boundary is tested. Oversize input is rejected visibly before partial submission; B2 does not split a bracketed paste, expand the control frame, or silently reinterpret the raw input lane. If measured product behavior requires larger atomic human input, the already documented chunked protocol upgrade must be separately adopted.
- Key handling preserves physical key, layout-derived text, consumed and unconsumed modifiers, left/right modifiers, repeat/release, function/navigation keys, Control chords, Option mappings, and Kitty progressive modes. A text-producing event is emitted once: never once as a key and again as text.
- `NSTextInputClient` owns composition. Marked text/preedit is displayed locally without committing PTY bytes; `insertText` commits the chosen text once; cancel/unmark clears preedit; command dispatch routes editing commands through the terminal encoder. Selected/marked ranges and character coordinates use AppKit's UTF-16 units. The insertion rectangle is the live cursor rectangle in screen coordinates so candidate windows follow the cursor through resize and monitor moves.
- Paste is an explicit user clipboard read followed by Ghostty's paste encoder under the human claim. With DEC private mode 2004 set, exactly one `ESC [ 200 ~`/`ESC [ 201 ~` pair surrounds only the paste body; with it reset, Ghostty's safe-paste rules apply. Paste never auto-submits, sleeps, or uses timing heuristics. OSC 52 read and write are denied in v1; ordinary Command-C/Command-V remain local user actions.
- View bounds are converted to actual backing pixels, while cell geometry comes from Ghostty's measured font/grid result, never division guesses. A nonzero geometry change gets a monotonic revision and idempotency key and is sent as `RESIZE`; the correlated `APPLIED` result must be the resize branch and its readback must match. Intermediate live-resize events may coalesce, but the final size and every display-scale change are delivered. Sessiond applies the PTY window size and signals the foreground process group; a redraw alone is not SIGWINCH proof.

### Scroll, selection, copy, paste, and mouse

- Scrollback is bounded by product policy and owned by terminal state, not scraped text. When at bottom, new output follows. When scrolled back, the viewport anchor remains stable and new output is indicated without jumping. Resize reflow preserves grapheme/cell and selection semantics. Search covers retained scrollback and reports truncation at the configured bound.
- With no application mouse capture, drag gestures create viewer-local terminal selections and wheel/trackpad gestures move scrollback. With an application mouse mode active, button, motion, wheel, modifier, and pixel/cell coordinates are encoded exactly for X10, VT200, button-event, any-event, SGR, alternate-scroll, and pixel modes. A deliberate Shift override provides local selection while captured and is tested against the standalone pinned Ghostty behavior.
- Selection is viewer-local and never writes PTY bytes. It handles character, word, line, rectangular mode when supported, wide cells, combining marks, emoji clusters, hard line breaks, and soft wraps. Copy is enabled only with a selection and writes exactly the semantic selected text to the native clipboard. Control-C stays provider input; Command-C stays copy.
- Primary and alternate screens retain independent terminal modes and Kitty keyboard stacks. Entering alternate screen does not destroy primary scrollback; DECSET/DECRST 1049 saves/clears/restores according to xterm behavior.

### A/Workspace-visibility interlock

**Decision: make this a distinct B2 build increment and a distinct authenticated lifecycle channel; do not fold it into `HiveTerminalView`.** The renderer can be destroyed, retargeted, or temporarily disconnected while the pane remains represented. Conversely, a live socket or hidden surface is not user visibility. Coupling lease renewal to the renderer would either kill valid reconnects or preserve invisible provider trees.

**B2.1 task zero is an A0 contract extension.** Before production create admission can close, a cross-vendor-reviewed A0 freeze must add the visibility request and lease behavior. The request carries one Workspace-session identity, a live PID verified against its exact OS start token, and a positive monotonic open-terminal revision. The resulting lease binds the exact session generation to the accepted revision, active state, and bounded expiry. The freeze also defines freshness, replay/stale-revision rejection, PID-reuse rejection, renewal, expiry, completeness, and typed failure postconditions. B2.1 derives and reviews this behavior at the contract gate; it must not treat today's daemon representation as normative or normalize it silently.

The channel behavior is:

1. Each Workspace launch creates a random Workspace-session identity and publishes its live PID plus an OS-derived start token. The daemon authenticates the local peer and re-reads the PID/start-token identity; PID alone is insufficient because of reuse.
2. The Workspace owns one monotonically increasing open-terminal inventory revision. Before create, it inserts a visible pending pane bound to the proposed exact locator, increments the revision, and publishes a full snapshot. Pending, attaching, live, reconnecting, closing, exited, and failed panes all remain visibly represented native states; a renderer is optional.
3. The daemon accepts only a fresh full snapshot for the authenticated Workspace identity. Older revisions, a changed start token, duplicate locator ownership, a record absent from the current UI model, or a publisher that is no longer live fail closed. Reconnect sends a full snapshot rather than reconstructing authority from event deltas.
4. At both candidate selection and the final create call, the daemon resolves the current snapshot again. Only an exact pending/open record supplies the A0-frozen visibility request: Workspace-session identity, verified PID, exact start token, and current positive revision. The daemon then passes that evidence to sessiond and records the returned lease; it never caches admission across a revision change.
5. Renewal continues only while a later or equal current snapshot still contains the exact generation and the Workspace process identity remains valid. Renderer traffic, window-server occlusion, heartbeats without an inventory record, screenshots, and stale saved UI state are not renewal evidence. Minimized or temporarily occluded panes remain logical user-visible representations; pane/window/Workspace close removes them.
6. Pane or window close first marks the exact record closing and refuses new input, then requests exact-generation termination and waits for positive reap/process-tree evidence. Only after successful reconciliation is the record removed. A confirmation cancellation leaves the pane open; close never degrades to detach.
7. Workspace quit freezes new creates, snapshots every open exact generation, runs the same close transition for all of them, and does not complete a successful quit until every provider tree is absent with authoritative evidence. Unknown or survivors are a visible failure, not success. An ungraceful Workspace death cannot send termination, so loss of its authenticated visibility source lets the existing bounded sessiond lease expire and trigger verified teardown.

This increment is project-neutral at the host boundary: Workspace policy terminates at the daemon adapter, while sessiond receives only the exact identity and visibility evidence frozen by the B2.1 A0 extension.

### Fidelity floor and accessibility acceptance

The executable VT baseline is pinned to **vttest 20251205**, archive SHA-256 `cd6886f9aefe6a3f6c566fa61271a55710901a71849c630bf5376aa984bf77cc`. The evidence bundle records the vttest `-V` output, archive hash, build flags, OS/hardware/architecture, locale, terminal declaration, font/settings, geometry, every selected menu path, expected result, actual result, screenshots/log, and reviewer disposition. Applicable tests are declared from advertised capabilities before execution; an applicable failure blocks. Unsupported historical hardware functions must be explicit and consistent with advertised capability, never waived after seeing a failure.

Mouse modes 1005 and 1015 receive an explicit up-front applicability decision in that capability manifest, derived from the pinned engine's advertised behavior before any run. Mode 1005 is deprecated in wide use and begins as **unknown until declared**, not assumed supported. Mode 1015 is likewise neither mandatory nor exempt until declared. A test failure cannot retroactively change either determination.

The concrete corpus is:

- vttest's applicable VT100 cursor movement, screen features, wrapping, insert/delete, character sets, double-width/height, keyboard, reports, and reset tests; applicable VT220–VT520 screen/editing/keyboard/report tests; ISO 6429 color/SGR tests; and XTerm alternate-screen and mouse-feature menus, including X10, normal, button-event, any-event, SGR, alternate-scroll, and pixel coordinates.
- ECMA-48 control parsing at every byte boundary plus xterm primary/alternate screen 1049, bracketed paste 2004, focus 1004, mouse 9/1000/1002/1003/1006/1007/1016 and the up-front-applicable subset of 1005/1015, cursor shape, title/bell, OSC 8 hyperlinks, denied OSC 52, 256-color, truecolor, synchronized output, and query/reply fixtures.
- Unicode fixtures split at every byte: narrow/wide CJK, combining sequences, variation selectors, emoji with skin tone, flags, and family ZWJ clusters; selection, copy, cursor, wrapping, and resize must agree on grapheme/cell boundaries.
- Kitty keyboard legacy mode and progressive flags for disambiguation, event types, alternate keys, all-keys reporting, associated text, query, push/pop, and independent primary/alternate stacks; physical runs cover US and international layouts, Option, dead keys, key repeat/release, function keys, Control chords, CJK IMEs, RTL composition, and emoji/ZWJ entry.
- Scrollback/search at empty, one row, exact limit, and limit-plus-one; selection across hard/soft wraps and wide/combining cells; bracketed and unbracketed paste at 0, 1, and 128 KiB; resize/reflow; Retina/non-Retina moves; minimized/occluded rendering; sleep/wake; GPU recreation; and bounded memory under sustained output.
- Every attach case at adversarial output splits: fresh replay, same-build checkpoint, daemon restart, renderer recreation, retained-range gap, corrupted checkpoint, wrong build/architecture, late old-generation frames, process exit, and close during replay.

Frame/byte digests and semantic state are the correctness oracle. “Looks right” is allowed only for the separate aesthetic gate.

Because the terminal is custom drawn, Hive supplies AppKit accessibility elements from the same semantic terminal state used by render, selection, and copy. The accessible terminal exposes a text-area/container identity, visible semantic rows with screen-coordinate frames, UTF-16 text ranges, cursor/focus, selected text/range, scroll position, and distinct native lifecycle/failure states. Incremental output, cursor, selection, and row changes post the appropriate accessibility notifications without replacing the entire tree or flooding announcements.

Acceptance includes recorded Accessibility Inspector and VoiceOver runs. Inspector must show valid roles, parent/child relationships, frames, focus, values, row/range/selection consistency, and no stale/duplicate elements through scroll, resize, alternate-screen, replay, and teardown. A VoiceOver user must navigate rows, locate cursor and selection, enter and edit text, hear committed output and lifecycle changes, inspect scrollback, survive reconnect, and close the terminal. The recording includes screen and audio and is independently reproduced; an API citation or automated property assertion cannot satisfy STORY-002 DoD-3a.

### Full live-proof matrix and Removal Gate handoff

Run the following on real installed Claude Code, Codex, and Grok TUIs, recording exact vendor/version/model, app/engine/sessiond builds, macOS/hardware/architecture, project directory, terminal settings, and session locator/generation. At least one run uses a non-Hive repository and no Bun or repository-layout dependency.

| Cell | Live act and evidence required for each vendor |
|---|---|
| Open/render | A visible pending pane admits one sessiond generation; the real full-screen TUI reaches a correct interactive frame with no hidden child/PTY owned by the renderer. |
| Input | Type text and editing/navigation/control/function/Option sequences; use an international dead key, live CJK IME composition/commit, and emoji/ZWJ; compare PTY byte/receipt evidence for no loss, duplication, or wrong target. |
| Resize | Drag through multiple cell sizes and a scale change; the TUI redraws and sessiond records the exact applied geometry/revision plus foreground SIGWINCH evidence. |
| Scroll/select/copy/paste | Produce retained output, leave bottom, search, select across wraps/wide text, copy an exact known digest, paste in bracketed mode, and exercise application mouse plus local-selection override. |
| Reconnect | Restart the daemon and recreate the renderer while the Workspace visibility record remains live; attach/replay produces the same exact generation and first correct frame with continuous output high-water and no duplicate input/query reply. |
| Exit/close | Exercise natural exit and explicit pane close; record exit and authoritative reap/process-tree absence for the exact PID/start tokens. Renderer detach alone must leave the pane represented and must not claim close. |
| Quit | Open all three providers concurrently, quit Workspace, and prove every owned provider/auxiliary tree absent. Repeat an ungraceful Workspace death and prove bounded lease-expiry teardown. |
| Stress/security | Run the integrated 100 MiB output/backpressure/replay fixture, hostile OSC/oversize input cases, stale generation/visibility revision/PID reuse attempts, and verify no byte loss, privileged renderer action, or invisible survivor. |

The author records the matrix; a person using a different model vendor reproduces it from the written runbook on a clean machine. The evidence bundle names failures and reruns rather than editing them away. B2 completion hands this bundle to STORY-001/STORY-002. The atomic removal train then repeats the same matrix on the deletion tree and adds the tmux-less/SwiftTerm-less supply-chain audit.

### Build increments and review pairs

The pairings below are proposals; queen may rotate people, but an increment's author vendor and approving reviewer vendor must differ. A third vendor performs the final independent reproduction.

| Increment | Depends on | Contract and deliverable | Blocking live-proof gate | Proposed author → reviewer |
|---|---|---|---|---|
| B2.0 · Engine/contract lock | M1-A0, M1-A2, M1-B1 | Freeze exact host/view mapping; import the B1 pin/build identity; expose only the Hive adapter; prove renderer reply suppression and callback/lifetime rules. | Clean arm64+x86_64 build loads the exact library, ABI/symbol/behavior lock passes, a manual surface renders a neutral replay, and process/fd inventory proves no renderer child or PTY. | Codex → Claude |
| B2.1 · Visibility freeze and Workspace source | B2.0 | First freeze visibility request/lease behavior through the reviewed A0 contract gate; then build the authenticated full-snapshot inventory channel, live PID/start-token/revision validation, pending-pane create gate, renew/remove/re-attest, and fail-closed replay/PID-reuse rules. | Contract fixtures prove the request/lease freeze before implementation; then a neutral full-screen process can be created only from a visible pending pane, stale/spoofed sources fail, and pane close, quit, and publisher death yield verified tree absence. | Claude → Grok |
| B2.2 · Attach/output/reconnect | B2.1 | Exact grant/binding, manual output ingestion, checkpoint/replay, acknowledgements, first-correct-frame, retarget fencing, typed gaps/failures, exit/reap. | Live neutral TUI survives daemon restart and renderer recreation at adversarial byte splits; digests/high-water match; wrong build/gap/late generation fail closed. | Grok → Codex |
| B2.3 · Input/geometry and A3 proof | B2.2 | First responder and synchronous claims; one ordered write path with no automation-timeout steal; Ghostty key/text/preedit/paste/mouse encoders; `INPUT_SUBMIT`/`APPLIED`; measured resize and final SIGWINCH; receipt/error UI. | Byte-capture fixture plus vttest proves claim-before-input, no competing-writer steal, keys, Kitty modes, dead key, CJK IME, bracketed paste boundaries, mouse modes, Retina resize, retry/unknown behavior, and no double input. | Codex → Claude |
| B2.4 · Viewer semantics | B2.3 | Bounded scrollback/search, selection/copy, local-vs-captured mouse, lifecycle states, and GPU/occlusion/sleep behavior. | Pinned vttest/VT corpus passes, including the predeclared 1005/1015 applicability, and Instruments proves rendering/memory bounds through scroll, replay, sleep/wake, and GPU recreation. | Claude → Grok |
| B2.5 · Workspace/vendor qualification | B2.4 | Production pane wiring, exact close/quit behavior, evidence runbook, non-Hive-project run, STORY-001/STORY-002 handoff bundle. | Full Claude Code/Codex/Grok matrix above passes, including daemon restart + renderer reconnect, per-pane verified close, concurrent quit teardown, and independent third-vendor reproduction. | Grok → Codex; Claude reproduces |
| B2.6 · Accessibility acceptance | B2.4; may run in parallel with B2.5 | AppKit accessibility tree, semantic rows/ranges/cursor/selection, notifications, and native lifecycle/failure states as the standalone STORY-002 DoD-3a increment. | Recorded VoiceOver and Accessibility Inspector acceptance passes through input, scroll, alternate screen, replay, resize, and teardown and is independently reproduced by the reviewer. | Codex → Claude |

No increment lands on implementation tests alone. Each live gate is recorded at the reviewed commit; every increment receives its independent cross-vendor review before landing.

### Open decisions

None requiring further queen/user adjudication remain after the review ruling. The potentially ambiguous seams are resolved here: M1-A0 is the contract authority and B2.1 first extends its freeze for visibility; B1's existing Ghostty pin is retained; sessiond is the single terminal-query-reply authority; human renderer bytes use `INPUT_SUBMIT` rather than the raw streaming optimization; oversize atomic human input fails visibly at the adopted v1 cap; Workspace visibility is a separate B2 increment/channel whose authority comes from the live pane inventory rather than renderer attachment; and renderer-coupled A3/A4 proofs fold into the named B2 increments.

## Definition of done

1. The pinned Ghostty adapter and manual surface satisfy the inherited M1-B1 ABI, behavior, checkpoint, lifetime, rendering, input, action/security, and accessibility gates on arm64 and x86_64. No Workspace code consumes the unstable upstream ABI directly.
2. A cross-vendor-reviewed A0 contract extension freezes visibility request/lease shape, freshness, renewal, expiry, and failure postconditions before implementation. Only then does a real Workspace pane supply fresh PID/start-token/revision visibility, open production sessiond create admission for an exact visible pending record, renew from the current inventory, and tear down on pane/window/Workspace close or bounded visibility expiry.
3. `HiveTerminalView` attaches one exact generation, restores/replays without loss or duplication, renders contiguous output, submits user bytes through `INPUT_SUBMIT` with discriminated `APPLIED` receipts, resizes with exact readback/SIGWINCH evidence, and handles exit/reap/close without confusing detach with termination.
4. Keyboard, scroll/scrollback/search, selection/copy, bracketed paste, IME, mouse modes, primary/alternate screen, Unicode, color, cursor, hyperlinks, title/bell, scale changes, GPU lifecycle, and security policy pass the pinned vttest/VT/Kitty/AppKit corpus with exact versions, hashes, settings, and results recorded.
5. VoiceOver and Accessibility Inspector pass live against semantic terminal text/rows, cursor, selection, scrolling, input, output, replay, and lifecycle/failure states. The runs are recorded and independently reproduced.
6. The full real Claude Code, Codex, and Grok matrix passes, including input, resize, scroll, selection/copy/paste, IME, mouse, daemon restart + renderer reconnect, natural exit, verified pane close, quit-Workspace teardown of every provider tree, 100 MiB-class replay/backpressure, and hostile/stale-identity cases.
7. A different model vendor reproduces the runbook on a clean machine. Code presence and author-only recordings are not evidence.
8. The replacement is project-agnostic and is live-proven on a non-Hive repository with no Hive-repo, Bun, or fixed-layout assumption.
9. Swift, TypeScript, and Zig tests/typechecks plus native ABI, sanitizer, Instruments, signing/notarization, architecture, dependency, license, and packaged-artifact checks are green at the reviewed commit.
10. The evidence bundle is accepted as the renderer input to the STORY-001/STORY-002 Removal Gate. No SwiftTerm/tmux removal, legacy shim, dual-renderer flag, or fallback is introduced by B2; the full matrix remains mandatory again on the atomic deletion tree, where STORY-002 owns and executes its paired DoD-7 terminal/workspace documentation cleanup.
11. Fresh external research drives every execution. Current implementation and the renderer transition design are reference material only. All implementation documentation is behavioral and contains no code file paths or line-number references.

## External documentation

Research reverified 2026-07-18; execution must recheck these sources and record versions/hashes rather than relying on this summary.

- **STORY-002 — Complete removal of agent TUI code:** Scope; Sequencing; DoD-2 live proof across Claude Code, Codex, and Grok; DoD-3 fidelity floor; DoD-3a live accessibility; DoD-7 paired documentation cleanup; External documentation.
- **STORY-001 — Gut ALL tmux terminal code:** Sequencing and the full Removal Gate matrix that B2 must unblock.
- **M1-A0 — Terminal-host contract audit & freeze:** normative authority for the neutral terminal-host contract and the contract gate B2.1 must extend before visibility-backed production create.
- **M1-A1 input wire projection options:** adopted Option 1, `INPUT_SUBMIT` plus the shared discriminated `APPLIED` result and its 128 KiB decoded v1 bound.
- **Native terminal foundation / terminal stack transition, renderer edition:** reference transition design only; it is not normative over fresh research or live proof.
- **Ghostty architecture and embedding status:** https://ghostty.org/docs/about
- **Pinned Ghostty tree and public embedding header:** https://github.com/ghostty-org/ghostty/tree/73534c4680a809398b396c94ac7f12fcccb7963d and https://github.com/ghostty-org/ghostty/blob/73534c4680a809398b396c94ac7f12fcccb7963d/include/ghostty.h
- **Pinned libghostty-vt header, explicitly API-unstable:** https://github.com/ghostty-org/ghostty/blob/73534c4680a809398b396c94ac7f12fcccb7963d/include/ghostty/vt.h
- **Ghostty 1.3.0 libghostty status:** the modules were still not versioned releases, so a desktop tag is not an ABI promise: https://ghostty.org/docs/install/release-notes/1-3-0#libghostty
- **ECMA-48, fifth edition:** https://ecma-international.org/publications-and-standards/standards/ecma-48/
- **XTerm Control Sequences:** alternate screen 1049, bracketed paste, focus, mouse tracking, OSC, color, and cursor behavior: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
- **VTTEST executable corpus and manual:** https://invisible-island.net/vttest/ and https://invisible-island.net/vttest/manpage/vttest.html
- **Kitty keyboard protocol:** https://sw.kovidgoyal.net/kitty/keyboard-protocol/
- **AppKit `NSTextInputClient`:** marked text, insertion, command dispatch, selection/ranges, and character coordinates: https://developer.apple.com/documentation/appkit/nstextinputclient
- **AppKit accessibility for custom controls:** accessibility elements, properties/protocols, notifications, VoiceOver, and Accessibility Inspector: https://developer.apple.com/documentation/accessibility/integrating-accessibility-into-your-app and https://developer.apple.com/documentation/appkit/accessibility-for-appkit
- **CAMetalLayer drawable sizing:** backing-pixel lifecycle used by the renderer: https://developer.apple.com/documentation/quartzcore/cametallayer/drawablesize

## Out of scope

- Removing SwiftTerm or tmux, deleting legacy schemas/scripts/artifacts, or landing the STORY-001/STORY-002 cut.
- STORY-002's paired DoD-7 terminal/workspace documentation cleanup. STORY-002 owns and executes it with the atomic cut; B2 supplies the behavioral contract and evidence inputs.
- Replacing the current Workspace pane topology, building Split Horizon, hierarchy UI, inspector/navigation redesign, or changing non-terminal status views.
- Provider launch profiles, readiness/belief, approvals, message delivery, authenticated provider status, or vendor-specific automation semantics.
- Changing the neutral M1-A0 host contract beyond B2.1's reviewed visibility request/lease extension, changing the adopted M1-A1 input wire or B1 Ghostty pin/patch budget, or inventing a stable libghostty ABI. Any further contract change returns to its owning story and review gate.
- Aesthetic terminal polish beyond the objective fidelity floor, or using SwiftTerm behavior as a compatibility oracle.

# Gate 9 — action/security matrix: recorded dispositions (2026-07-18, douglas)

Object under qualification: the manual-mode GhosttyKit surface at the
pinned vendored tree (B1.0, main a7ff468c) plus this increment.
Policy code: `HiveGhosttyActionPolicy` + `GhosttyBridgeFactory.makeRuntimeConfig`
(workspace/Sources/HiveTerminalKit/Bridge/ManualSurface.swift).

## Action callback (`action_cb`) — all 66 pinned `ghostty_action_tag_e` tags

Completeness is mechanical, not claimed: `Gate9ActionPolicyTests
.testEveryPinnedActionTagHasExactlyOneVerdictAndMatchesTheHeader` parses the
enum out of the pinned `vendor/ghostty/include/ghostty.h` at run time and
fails if any tag lacks exactly one verdict, if the classified-set size
drifts from the header, or if a value past the range classifies. An
upstream bump that appends a tag turns the suite RED and demands a verdict.

| Class | Tags | Disposition | Control (would fail if wrong) |
|---|---|---|---|
| handledByEffects | SET_TITLE, PWD, RING_BELL | HANDLED — visible behavior flows through the patched vt Handler effects → bridge events (TITLE/PWD/BELL); the action-cb arm is a deliberate no-op duplicate | effects-path event tests (foundation corpus); per-verdict routing spy (`testHandleRoutesThroughTheVerdictNotABlanketFalse`) |
| deniedPolicy | DESKTOP_NOTIFICATION, SECURE_INPUT, OPEN_URL | DENIED (security policy) | OSC 9 live-fire inert + stream-not-poisoned (`testOSC9NotificationBytesAreInertAndDoNotPoisonTheStream`); static no-opener scan (`testKitSourcesContainNoPrivilegedOpeners`, with dead-scan positive controls); reachability hard pin |
| deniedGesture | 39 window/tab/split/quit/inspector/search/title-UI tags | DENIED + UNREACHABLE-by-construction from input: `keybind = clear` strips every Ghostty binding from the manual config | `testDefaultWindowBindingsAreStrippedFromManualConfig` (cmd+N is NOT a binding on the live surface; RED on a stock config); trace asserts no gesture tag reachable from bytes |
| engineInert | 21 housekeeping tags (SCROLLBAR, RENDER, CELL_SIZE, COLOR_CHANGE, PROGRESS_REPORT, COMMAND_FINISHED, SELECTION_CHANGED, MOUSE_*, …) | DENIED (inert notification, returns false; no B1 privileged consumer) | live per-verdict routing (`testLiveCallbackFiringsCarryTheCorrectVerdict`); reachability hard pin |

MEASURED byte-reachable action surface (hostile corpus: OSC 0/1/2/4/7/8/9/
9;4/10/11/52-write/52-read/133/777, BEL, DECSET 2004, title stack):
exactly `{SCROLLBAR}` — `Gate9ReachabilityTraceTests` asserts hard
EQUALITY (a misclassified dangerous tag cannot hide in a subset check),
with a distinct liveness assert so a dead observer is diagnosed separately.

Unknown tag at the callback: loud `assertionFailure` in debug, deny in
release — never a silent blanket false.

## Observe-only carrier (Gate 10 consumer; this increment)

SELECTION_CHANGED and SCROLLBAR are additionally forwarded — payload
value-copied, async on main, per-surface, weak-registry routed — via
`GhosttyManualSurface.onActionNotification`
(`HiveGhosttyActionNotification.selectionChanged` /
`.scrollbar(total:offset:len:)` mapping 1:1 to `ghostty_action_scrollbar_s`).
The engine return value is UNCHANGED (false): observing is not handling;
the security disposition of both tags is unaffected.
Controls: `testScrollOutputDeliversScrollbarNotificationWithPayload`
(payload + main-thread delivery), `testSelectionGestureDeliversSelectionChangedNotification`
(real mouse-drag; SELECTION_CHANGED measured REAL, not inferred),
`testNoNotificationDeliveredAfterFree` (no callback after free).
Mutation control run 2026-07-18: disabling registry registration turned
all three RED (scroll, selection, plus the payload assert) — the controls
bite.

## Non-action runtime callbacks (`ghostty_runtime_config_s`)

All four are probe-instrumented (`HiveGhosttyRuntimeCallbackProbes`);
each "never fires" claim has a direct-invocation positive control proving
the probe observes (a dead probe cannot fake a negative).

| Callback | Disposition | Proof |
|---|---|---|
| close_surface_cb | UNREACHABLE for manual surfaces — the patched `apprt/embedded.zig Surface.close` takes the `hive_manual` branch, emits the CLOSE_REQUEST bridge event, and RETURNS before `app.opts.close_surface`; close requests are HANDLED as the visible CLOSE_REQUEST event | `testCloseRequestSurfacesAsBridgeEventNeverAsCloseSurfaceCb` (real `ghostty_surface_request_close` → event observed, probe flat) + `testCloseSurfaceProbeObservesDirectInvocation` |
| read_clipboard_cb | DENIED (returns false) AND unreachable from untrusted bytes — OSC 52 read is answered with protocol silence before the apprt layer | `testOSC52ReadNeverReachesTheApprtReadCallback` (direct-invoke: probe + false; byte-fire: probe flat) + `TerminalReplyCorpusTests.testOSC52ClipboardReadIsDeniedNoReplyEver` (silence, with a DA1 liveness control proving the write channel was alive) |
| write_clipboard_cb | UNREACHABLE from bytes — OSC 52 write is denied in the patched vt handler (`clipboardWrite` → emit CLIPBOARD_DENIED, return .denied) before the apprt layer | `testOSC52WriteIsVisiblyDeniedAndPasteboardUntouched`: CLIPBOARD_DENIED event observed, `NSPasteboard.general.changeCount` unchanged, write/confirm probes flat |
| confirm_read_clipboard_cb | No-op at this pin; see the 2026-07-18 amendment below — Gate 8 makes it reachable ONLY behind an explicit host paste gesture, and unsafe confirm FAILS CLOSED | probe flat across the hostile corpus and OSC 52 controls (byte-side; unchanged by the amendment) |

## Security-invariant coverage per story item

- title/pwd: handled as events; byte-fired; no privileged host effect.
- bell: handled as event; BEL in corpus.
- close request: CLOSE_REQUEST event; C callback proven unreachable (above).
- notifications: OSC 9/777 denied silently at the bridge; zero
  notification API symbols in the kit (static scan).
- URLs: OSC 8 fed hostile; OPEN_URL unreachable from bytes (hard pin);
  no opener symbol exists (static scan); de-facto OSC 8 spec sanctions
  disabled-by-default (external-source-verification.txt).
- clipboard/OSC 52: write → visible CLIPBOARD_DENIED + pasteboard
  untouched; read → protocol silence + apprt cb never invoked. Threat
  grounded in xterm ctlseqs (reply would carry base64 host clipboard).
- secure input: SECURE_INPUT classified deniedPolicy (defense in depth) and
  structurally unreachable in manual mode: the only byte-side producer is
  `termio/Exec.zig:370` (`password_input = mode.canonical and !mode.echo`,
  read from PTY termios) — manual surfaces have no exec/PTY (gate 1); the
  only other producer is the `toggle_secure_input` binding, stripped by
  `keybind = clear`. Regression guard: the reachability hard pin (any new
  byte path to SECURE_INPUT breaks set equality) + static scan (no
  EnableSecureEventInput symbol to reach).
- mouse shape/visibility: engineInert (no cursor change in B1); neither
  fired from the hostile corpus (hard pin); M-track item for a real
  NSCursor consumer remains open deliberately.

## Re-review fixes (2026-07-18, after dylan cross-vendor review of 509ca3b8)

Both blocking findings fixed in one follow-up commit:
1. Carrier delivery-after-free race: `deliverActionNotification` now
   re-checks the lock-protected registry (identity compare, which also
   drops notes whose handle value was reused) INSIDE the queued main.async
   closure — a note enqueued before `free()` delivers nothing. Regression
   test `testNotificationEnqueuedBeforeFreeIsDroppedAtExecutionTime`
   reproduces dylan's exploit ordering; mutation control (enqueue-time
   check only) turns it RED.
2. Dead forbidden-detector: the opener scan's predicate is factored and the
   committed suite plants synthetic forbidden code lines through the SAME
   predicate + list — dylan's disabling mutation (empty `forbiddenOpeners`)
   was replayed and now turns `testKitSourcesContainNoPrivilegedOpeners`
   RED ("detector must catch a planted forbidden opener").

## Amendment (2026-07-18, queen-blessed clipboard/paste policy)

The original prose "no paste-confirmation flow exists in B1" described the
pin's own code truthfully but is superseded by the blessed cross-gate
policy (douglas/donna converged, queen approved):

- The manual config's `keybind = clear` strip stays FROZEN. Gate 8's host
  paste is `HiveTerminalView.paste(_:)` programmatically calling
  `ghostty_surface_binding_action("paste_from_clipboard")` — an explicit
  HOST gesture, not a config keybind, so the gate-9 stripped-bindings
  control remains valid and green.
- Behind that gesture (and ONLY there), Ghostty's async clipboard path may
  invoke `read_clipboard_cb` / `confirm_read_clipboard_cb`. When
  paste-protection flags unsafe content, the confirm FAILS CLOSED (deny,
  empty completion) until a host confirmation UI exists.
- The two claims must not be conflated: OSC-52-FROM-BYTES unreachability
  (proven here, unchanged — untrusted terminal bytes never reach any
  clipboard callback) is a SECURITY invariant; host-gesture paste
  reachability is a FEATURE path Gate 8 qualifies, with its own fail-closed
  denial. This table's probe-flat evidence covers the byte side only.
- Same distinction for WRITE (donna correction, 2026-07-18): the explicit
  host/menu copy_to_clipboard gesture DOES reach `write_clipboard_cb`
  (confirm=false, standard location) — Gate 8 qualifies selection/copy
  there, preserving `HiveGhosttyRuntimeCallbackProbes.record(.writeClipboard)`
  as the first statement and denying confirm=true. The byte path stays
  dead independent of config: the manual patch's vt `clipboardWrite`
  handler denies OSC 52 before the apprt layer. My earlier "leave
  write_clipboard_cb as no-op" instruction to Gate 8 is retracted; the
  byte-scoped flat-probe controls here are unaffected by gesture-path
  invocations (deltas are scoped to byte feeds).

## Integration verification (2026-07-18, rebase onto main 4f3dd06e)

- Registry migration executed per planning/gate9-sink-registry-migration.md:
  the carrier rides BridgeCallbackContext (acceptingCallbacks execution-time
  gate) via GhosttySurfaceCallbackRegistry; private plumbing deleted; public
  API unchanged. Lifetime tests drive the production notifySurface path.
- Fresh GhosttyKit.xcframework rebuilt from the landed patched tree (stale
  pre-Gate-2/5 artifact crashed live-surface tests — ABI moved, confirming
  the rebuild requirement). Full unfiltered suite: 316 tests, 0 failures
  (2 pre-existing deliberate skips owned by Gates 6/7).
- Mutation replays on the MIGRATED code: registry enqueue no-op'd → both
  delivery-asserting carrier tests RED; forbiddenOpeners emptied → scan
  detector control RED. Both restored.
- Scan refinement forced by landed Gate 7: HiveTerminalView legitimately
  observes sleep/wake via NSWorkspace.shared.notificationCenter. NSWorkspace
  is now judged per code line with that narrow benign allowlist; a bare
  alias (`let ws = NSWorkspace.shared`, the opener-evasion shape) is pinned
  as a positive control alongside the benign-line exemption.
- Allowlist hardened after eleanor's integration review (2026-07-18): the
  marker-presence check was evadable (benign marker co-located on a mixed
  line, or inside an inline comment, exempted an opener). The predicate now
  strips inline comments per line and SUBTRACTS the exact benign observer
  expressions — any NSWorkspace residue flags. Both evasion shapes are
  committed positive controls (mixed-line and inline-comment openers must
  flag RED); the empty-list disabling mutation was replayed and turns all
  three detector controls RED.

## Residual risk / honesty notes

- The hostile corpus is finite; the classification's exhaustiveness
  guarantee is the pinned-header parse + hard-pin equality, not corpus
  size. A new byte→action path in a future vendor bump fails the pin.
- SELECTION_CHANGED/SCROLLBAR forwarding delivers to Hive's OWN view
  layer only; nothing terminal-byte-controlled crosses a privilege
  boundary (delivery is observe-only and the engine still gets false).
- `confirm_read_clipboard_cb` has no direct-invocation positive control of
  its own (its C signature takes an opaque request pointer we will not
  fabricate); its flat-probe negative rides the same probe mechanism
  positively controlled twice elsewhere.

# M1-B1 Gate 9 — action/security matrix (design, pre-implementation)

Status: DESIGN for the gate-9 increment. The current runtime config uses a
blanket `action_cb: { _, _, _ in false }` (ManualSurface.swift
makeRuntimeConfig) — exactly what the story forbids ("never blanket
false"). This document classifies every `ghostty_action_tag_e` at the
pinned header (ghostty.h:885-952, 70 tags) into the story's three verdicts
— HANDLED, DENIED (deliberate, with visible behavior), or UNREACHABLE
(proven, not assumed) — and names the positive control for each class.

Security invariant (story:21): untrusted terminal bytes must not trigger
privileged host actions without policy/user gesture. For a manual surface,
"untrusted bytes" enter ONLY via `hive_ghostty_surface_process_output_v1`;
"user gesture" enters via key/mouse/IME APIs which Hive's own view layer
calls.

## Classification

### A. Byte-triggerable (reachable from process_output — the security surface)
| Tag | Verdict | Rationale / visible behavior |
|---|---|---|
| SET_TITLE | HANDLED (event) | Already surfaced as HIVE_GHOSTTY_EVENT_TITLE via HiveManual effects; action_cb path must be verified duplicate-or-dead — if both fire, keep the effects path and return false with a comment, else handle here. |
| PWD | HANDLED (event) | Same as SET_TITLE (HIVE_GHOSTTY_EVENT_PWD). |
| RING_BELL | HANDLED (event) | HIVE_GHOSTTY_EVENT_BELL. |
| DESKTOP_NOTIFICATION | DENIED (policy) | OSC 9/777 from agent output must not post macOS notifications without Hive-level policy; deny = return false + count/log via event? Decision: deny silently at bridge, Hive's app layer owns notification policy from TITLE/BELL events. Control: OSC 9 burst → zero notifications posted, action_cb observed invoked. |
| COLOR_CHANGE | DENIED (inert) | OSC 4/10/11/12 palette changes affect rendering internally; the action is a host NOTIFICATION only. Returning false is inert-by-contract; verify rendering still applies (gate-7 owns rendering fidelity). |
| PROGRESS_REPORT | DENIED (inert) | ConEmu OSC 9;4 — no Hive UI consumer in B1. |
| MOUSE_SHAPE / MOUSE_VISIBILITY / MOUSE_OVER_LINK | HANDLED (B1: deny-visible) | Real app sets NSCursor. B1 ships deny-with-comment (no cursor change) + M-track item; control proves the callback fires with the right tag (so wiring exists when handled). |
| OPEN_URL | DENIED (gesture-gated) | Reachable only via click on hyperlink (gesture) but the URL content is byte-controlled. Deny at bridge in B1: no NSWorkspace.open ever. Control: synthetic click on OSC-8 link → action observed, no browser launch. |
| COMMAND_FINISHED / SHOW_CHILD_EXITED | UNREACHABLE (manual mode) | Emitted from exec/child lifecycle; manual surfaces have no child (gate 1). Prove by grep + test: feeding OSC 133 prompt marks must not fire SHOW_CHILD_EXITED. COMMAND_FINISHED (OSC 133;D) IS byte-triggerable → reclassify DENIED (inert) with control. |

### B. Gesture/binding-triggered only (key/mouse path, not raw bytes)
QUIT, NEW_WINDOW, NEW_TAB, CLOSE_TAB, NEW_SPLIT, CLOSE_ALL_WINDOWS,
TOGGLE_MAXIMIZE, TOGGLE_FULLSCREEN, TOGGLE_TAB_OVERVIEW,
TOGGLE_WINDOW_DECORATIONS, TOGGLE_QUICK_TERMINAL, TOGGLE_COMMAND_PALETTE,
TOGGLE_VISIBILITY, TOGGLE_BACKGROUND_OPACITY, MOVE_TAB, GOTO_TAB,
GOTO_SPLIT, GOTO_WINDOW, RESIZE_SPLIT, EQUALIZE_SPLITS, TOGGLE_SPLIT_ZOOM,
PRESENT_TERMINAL, FLOAT_WINDOW, INSPECTOR, SHOW_GTK_INSPECTOR,
RENDER_INSPECTOR, OPEN_CONFIG, RELOAD_CONFIG, UNDO, REDO,
CHECK_FOR_UPDATES, START_SEARCH, END_SEARCH, PROMPT_TITLE, SET_TAB_TITLE,
COPY_TITLE_TO_CLIPBOARD, SHOW_ON_SCREEN_KEYBOARD, READONLY.
→ Verdict: DENIED (deliberate). Hive owns window/tab/split management via
its own Workspace chrome; Ghostty bindings for these are surplus. Denial is
VISIBLE by contract: return false and the default keybinds simply do not
act, which the Kitty/legacy input goldens already exercise (a bound key
that misses its binding falls through to encoding — maybeHandleBinding
returns null only when unbound; a binding that fires and is denied at
action_cb consumes the key with no effect → control: press cmd+N-class
binding, assert no NEW_WINDOW side effect AND no bytes written).
NOTE: consider config-stripping instead (empty keybinds in the manual
config) to make these UNREACHABLE-by-construction — decision point for the
implementation round; stripping is stronger and testable (binding lookup
misses → keys encode normally).

### C. Engine housekeeping (engine-internal notifications)
SIZE_LIMIT, RESET_WINDOW_SIZE, INITIAL_SIZE, CELL_SIZE, SCROLLBAR, RENDER,
RENDERER_HEALTH, QUIT_TIMER, CONFIG_CHANGE, KEY_SEQUENCE, KEY_TABLE,
SECURE_INPUT, SELECTION_CHANGED, SEARCH_TOTAL, SEARCH_SELECTED.
→ Verdict: mixed. RENDER/CELL_SIZE/SCROLLBAR/RENDERER_HEALTH are
rendering-adjacent (gate 7 owns; bilal's view may already consume geometry
via other APIs — verify no double-path). SECURE_INPUT: DENIED in B1
(Hive's agent terminals are not password UIs; document; revisit for human
attach mode — flag to queen). Others: DENIED (inert notification).

## Implementation shape (next round)
1. Replace the blanket closure with `hiveGhosttyActionCallback` trampoline
   that switches on tag: emits the A-class events (or defers to effects
   path where already covered), returns false for every DENIED tag through
   an exhaustive Swift switch (no default:) so a NEW upstream tag is a
   COMPILE error, not a silent false — that is the "never blanket false"
   mechanical guarantee.
2. Controls: (a) untrusted-bytes matrix — one test per A-class tag feeding
   the triggering sequence, asserting the observable (event emitted /
   nothing privileged happened) AND that the callback genuinely fired
   (spy seam like tickOverride); (b) binding-denial control per B-class
   representative; (c) exhaustiveness control = the compile-time switch.
3. OSC 52 policy statement (story:14): write DENIED (clipboardWrite effect
   denies; CLIPBOARD_DENIED event visible) + read DENIED (read_clipboard_cb
   returns false). Controls exist partially in gate-2 corpus; add the read
   side.

## Open decisions for queen
- B-class: deny-at-callback vs strip-bindings-from-config (stronger).
- SECURE_INPUT policy for future human-attach mode.
- DESKTOP_NOTIFICATION: bridge-deny (proposed) vs event-surface for Hive
  app-layer policy.

# B2.6 / Gate 10 AppKit — accessibility acceptance (hedda)

Status: **machine slice RECORDED · human VoiceOver + Inspector PENDING · HOLD for cross-vendor review**

## Scope

B2.6 is the standalone STORY-002 DoD-3a increment: AppKit accessibility tree from the same semantic terminal state used by render/selection/copy; notifications on output and selection change; lifecycle/failure states accessible; recorded Inspector + VoiceOver passes through input, scroll, alternate screen, replay, resize, and teardown.

This delivery forward-ports duncan's atomic accessibility work (`943407ba` "Build atomic terminal accessibility snapshot") onto current main after B2.4 viewer semantics, OPOST, and occlusion bootstrap. Attribution for that foundation is preserved in the commit trail.

## Patch / rebuild decision

| Item | Result |
|---|---|
| duncan's `0003-hive-semantic-snapshot.patch` | Already present as `native/ghostty-patches/0004-hive-semantic-snapshot.patch` |
| Patch-series stamp | Unchanged: `ddeaf792…` (lock + ADR-0002 budget untouched) |
| GhosttyKit rebuild | **Not required** for this AppKit slice |
| Upstream pin | Ghostty `73534c46…`, Zig `3cc2bab3…` |

## What landed (code)

- `HiveTerminalView+Accessibility.swift` — semantic-snapshot-backed text area, row children (`staticText`), UTF-16 ranges, cursor insertion line, selection range/text, custom scroll actions, selection/value/layout notifications, lifecycle label + announcements, AX tree dump helper.
- Wiring in `HiveTerminalView.swift` / `+Input.swift` — invalidate, geometry, focus, lifecycle, bell/clipboard/close announcements, teardown row destroy.
- Selection-change AX posting claimed via Gate 9 `HiveTerminalActionNotification.selectionChanged` plus snapshot-diff (explicitly left open by the Gate 10 engine slice).
- `Gate10AccessibilityTests` — 14 positive controls including notification probe, row children, lifecycle/failure, and recorded scenario dumps.

## Evidence

Directory: `raw/qualification/hive-b26-gate10-accessibility/`

| Artifact | Status |
|---|---|
| `ax-tree-{input,alternate-screen,alternate-screen-exit,resize,replay,scroll,teardown}.txt` | RECORDED |
| `inspector-audit-machine.txt` | RECORDED (dump-shape audit; not a substitute for human Inspector) |
| `notification-positive-controls.txt` | RECORDED |
| `machine-xctest-transcript.txt` | RECORDED (14/14) |
| `human-checklist.txt` | RECORDED (executable checklist) |
| `human-inspector-audit-transcript.txt` | **PENDING_HUMAN** |
| `human-voiceover-transcript.txt` | **PENDING_HUMAN** |
| `port-claim.txt` | 43128 reserved; no listener bound |
| `evidence-sha256.txt` | RECORDED |

Runner: `scripts/qualify-hive-b26-accessibility.sh`

## Honest limits

- A clean automated audit / property suite is not DoD-3a alone. Human VoiceOver listening and Inspector GUI audit remain explicit slots (Gate 7 pattern).
- In-process `NSAccessibility.post` probes prove the post path; they do not prove a screen reader spoke the string.
- Full product DoD still wants live pane VO with sessiond-attached vendor TUIs once human slots fill.

## Reproduce

```bash
# Materialize GhosttyKit if needed from the locked artifact cache, then:
cd workspace
HIVE_B26_AX_EVIDENCE=../raw/qualification/hive-b26-gate10-accessibility \
  swift test --filter Gate10AccessibilityTests
# or:
../scripts/qualify-hive-b26-accessibility.sh
```

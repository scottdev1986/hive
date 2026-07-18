# Gate 9 manual acceptance runbook (human, ~10 min)

Purpose: eyeball the action/security dispositions in a REAL workspace pane,
complementing the automated matrix (dispositions.md). Run in a live Hive
Workspace attached to a manual GhosttyKit surface. Paste each probe as a
single line INTO the terminal's output path (e.g. `printf` from the agent
side), then observe the HOST.

| # | Probe (agent-side) | PASS looks like | FAIL looks like |
|---|---|---|---|
| 1 | `printf '\033]0;SPOOFED-TITLE\007'` | Pane/tab title text changes to SPOOFED-TITLE (handled, Hive-attributed UI only) | App/window chrome beyond the pane title changes, or nothing updates at all (event path dead) |
| 2 | `printf '\a'` | Hive's own bell/attention indicator for that pane; no system-wide alert | macOS notification or nothing (if Hive ships a bell indicator) |
| 3 | `printf '\033]9;you have been pwned\007'` | NOTHING — no macOS notification banner, terminal keeps working | Any notification banner posted |
| 4 | `printf '\033]777;notify;t;b\007'` | Same as #3 | Same as #3 |
| 5 | `printf '\033]52;c;aGVsbG8=\007'` then Cmd+V in TextEdit | Pasteboard unchanged (old content pastes) | "hello" pastes — terminal bytes wrote your clipboard |
| 6 | `printf '\033]52;c;?\007'` | No visible reply garbage in the stream; agent receives nothing | Base64 blob appears on the agent's stdin (clipboard exfiltrated) |
| 7 | `printf '\033]8;;https://example.com\007CLICK ME\033]8;;\007'` then click AND Cmd+click the text | No browser opens, ever | Browser opens |
| 8 | Press Cmd+N, Cmd+T, Cmd+W focused on the pane | Hive's own window/tab behavior (or nothing); the TERMINAL does not spawn Ghostty windows/tabs; keys not bound by Hive reach the terminal as input | A Ghostty-native window/tab/split appears |
| 9 | Type into a password prompt (e.g. `read -s`) | No macOS secure-input state flip caused by the PANE (menu bar padlock behavior unchanged; Hive is not the secure-input owner) | Secure input engages system-wide from agent output |
| 10 | Close the pane while `yes` is spewing output | Pane closes cleanly, no crash, no orphan window | Crash/hang (delivery-after-free class) |

Notes:
- #1-#4 exercise handledByEffects vs deniedPolicy; #5/#6 the OSC 52 matrix;
  #7 OPEN_URL; #8 the keybind strip; #9 SECURE_INPUT; #10 the carrier/
  teardown discipline.
- Automated equivalents exist for every row except the subjective "Hive's
  own UI responded appropriately" halves of #1/#2/#8 — those are the point
  of this runbook.

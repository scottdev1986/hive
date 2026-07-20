# Live terminal staircase fix (hattie)

**Pin tip when this note landed:** see branch `hive/hattie-continue-a-crashed-agent-s-wor`.  
**Root cause:** `cfmakeraw` cleared `OPOST` (and thus `ONLCR`) on the session PTY; bare `\n` reached the VT renderer untranslated and staircased.

## Fix (tree)

- `native/sessiond/src/pty_host.zig` — after `cfmakeraw`, restore `OPOST|ONLCR` in `applyTerminalProfile`; `profileMatches` requires both oflags.

## Tests that require CRLF (Zig, not Swift)

There are **no** Swift attach assertions changed to require CRLF. The report phrase “session_host + neutral_host attach assertions expect CRLF echo” names **Zig** tests only:

| Layer | File | What |
|-------|------|------|
| Primary blind-spot test | `native/sessiond/src/pty_host.zig` L1168–1196 | `spawn default profile translates bare newlines via OPOST ONLCR` — expects `"a\r\nb\r\n"` from bare-NL `printf` |
| session_host PTY echo | `native/sessiond/src/session_host.zig` L6484–6505 | `optional provider graceful action…` — writes `"…\n"`, asserts readback contains `"…\r\n"` |
| neutral_host attach payload | `native/sessiond/src/neutral_host.zig` L2657–2662 | `proveLiveLifecycle` attach output must contain `"opaque neutral byte proof\r\n"` |

Swift live-shell tests (geometry agreement, Gate 8 input) still pass while the pane stairs when OPOST is clear — that was the blind spot the Zig primary test closes.

## Visual evidence

| Shot | Path |
|------|------|
| BEFORE prompt (inverse `%` already present) | `raw/hattie-BEFORE-staircase-prompt.png` |
| BEFORE `ls` staircase | `raw/hattie-BEFORE-staircase-ls.png` |
| AFTER `ls` one entry per line | `raw/hattie-AFTER-ls-one-entry-per-line.png` (same pixels as `raw/hattie-live-terminal-ls-one-entry-per-line.png`) |

## Residual inverse-video `%` (PROMPT_EOL_MARK)

The white inverse-video `%` box in the user’s BEFORE shots is **zsh’s `PROMPT_EOL_MARK`** (partial-line marker), not a Hive cursor glyph and not inverse-cell mispaint.

- **Pre-fix:** missing OPOST made normal multi-line output look partial, so the marker was amplified across the pane.
- **Post-fix:** complete-line output (`ls -1` with trailing NL→CRNL) shows **no** white-`%` on those lines.
- **Residual:** one inverse `%` can still appear on **genuinely** partial output (or a login handoff that leaves a partial line). That residual is a **C1 theming/config decision for queen**, not fixed here (no shell-config injection from this change).

## Ghost / geoff compare (pinned refs only)

Cite only `519c5eb0` or `refs/hive-preserved/geoff-dirty-snapshot` (`b937e5a3`) — not the moving geoff tip. Same core OPOST restore; this branch is the canonical landing form (always-on OPOST + RED bare-NL test). Rejected: unrequested `output_translation` profile knob.

# Why the sessiond pane looked blocked — and the command that actually works

Diagnosis by ilse, 2026-07-20. No code changed. Companion to
`docs/workspace/seeing-a-live-terminal.md` (isaac, f700c624).

## Headline

**`make terminal` is the answer, it is current, and nothing is blocking it
today.** It launches the real Workspace app with a sessiond-hosted
HiveTerminalView pane running your interactive login shell. The row-K preflight
failure that made this look blocked belongs to a *different* script that
`make terminal` never runs.

## 1. The preflight that fails, verbatim

Not `demo-preflight`. The failing check is in
`scripts/b25-production-pane-proof.ts:168-174`, reached from
`prepareActiveDisplay()` at line 195:

```ts
function requireUnlockedSession(locked: boolean): void {
  if (locked) {
    throw new Error(
      "real Workspace pixel qualification requires an unlocked macOS session",
    );
  }
}
```

Recorded output, `matrix/production-wiring-pane.txt` (2026-07-20T06:04:12.348Z):

    MUTATION VERIFIED: locked session breaks the real-window pixel preflight
    FAIL: real Workspace pixel qualification requires an unlocked macOS session

### The "MUTATION VERIFIED" line proves less than it reads

Lines 186-194 call `requireUnlockedSession(true)` with a **hardcoded literal**
and confirm it throws. That is a positive control on the assertion function —
it prints on *every* run, locked or unlocked. It is not evidence that the
session was locked. The real measurement is line 195,
`requireUnlockedSession(screenLocked)`.

ines's reading of the FAIL was nonetheless correct: the FAIL string is only
reachable when the probe returned exactly `"1"`, so at 06:04Z the screen was
genuinely locked.

## 2. Root cause — and a second, live defect

**Confidence: high (measured, not inferred).**

At 06:04Z: the screen was really locked. Environmental, not a code defect.
ines's conclusion was sound *for that moment*.

**But the preflight also cannot pass on a healthy unlocked machine.** The probe
(`sessionScreenLocked()`, lines 155-166) is:

```ts
print((value?["CGSSessionScreenIsLocked"] as? NSNumber)?.intValue ?? -1)
...
if (output !== "0" && output !== "1") throw new Error(`screen-lock probe failed: ${output}`);
```

Measured live from this shell, 2026-07-20 (screen unlocked, on console):

    $ /usr/bin/swift -e '...CGSSessionScreenIsLocked...'
    -1

Full-dictionary dump, same moment:

    keys: ["CGSSessionUniqueSessionUUID", "kCGSSessionAuditIDKey",
           "kCGSSessionGroupIDKey", "kCGSSessionLoginwindowSafeLogin",
           "kCGSSessionOnConsoleKey", "kCGSSessionSystemSafeBoot",
           "kCGSSessionUserIDKey", "kCGSSessionUserNameKey",
           "kCGSessionLoginDoneKey", "kCGSessionLongUserNameKey",
           "kSCSecuritySessionID"]
    locked raw: nil
    onConsole: Optional(1)

The dictionary is fully readable and we are on the console. **macOS omits
`CGSSessionScreenIsLocked` entirely when the screen is unlocked** — it appears
only, as `1`, when locked. The `?? -1` collapses "key absent (= unlocked)" into
a sentinel that the guard then rejects as a probe failure.

So the preflight has three states and handles two:

| Real state | Probe output | Preflight result |
|---|---|---|
| locked | `1` | FAIL (correct) |
| unlocked | *key absent* → `-1` | **FAIL — "screen-lock probe failed: -1"** (wrong) |
| no GUI session | nil dict → `-1` | FAIL (correct, but indistinguishable from unlocked) |

**The preflight is over-strict: it fails on a healthy unlocked system.** This is
the third possibility the investigation was asked to take seriously, and it is
real. The intent is right; the encoding of "unlocked" is wrong.

Note this does *not* retroactively invalidate ines's 06:04 FAIL — that one read
a true `1`. It means clearing the GUI gate alone will not make row K pass; the
probe must be fixed too.

## 3. Can the user see a sessiond pane today? **Yes.**

`make terminal` exists (`Makefile:264-267`) and does exactly this:

```make
terminal: DEMO_TARGET := terminal
terminal: demo-preflight demo-artifacts
	@echo "launching a real interactive login shell (keep the Aqua session unlocked)"
	@unset HIVE_B22_HOME; HIVE_B22_REAL_SHELL=1 HIVE_B22_NO_APP=0 HIVE_B22_PORT=$(DEMO_PORT) bun "$(ROOT)/scripts/b22-live-attach-proof.ts"
```

Reading the recipe, not the name: it runs a real `hive-sessiond serve` broker,
creates a session with `hostKind: "sessiond"`
(`scripts/b22-live-attach-proof.ts:217`) running your login shell
(`HIVE_B22_REAL_SHELL=1`), and launches the **real Workspace app**
(`HIVE_B22_NO_APP=0`, spawn at line 334). Because the locator is
`hostKind == "sessiond"`, `ProjectWindowController.swift:309` takes the
HiveTerminalView branch and no tmux client is spawned.

### It is current, not stale

- Line 324 targets `workspace/.build/debug/**HiveWorkspaceDev**` — the *new*
  name from ivy's 40c3e72a. Not broken by the rename.
- `Makefile:93` defines `WORKSPACE_BIN` to the same path, and the `workspace`
  target (206-214) builds then `mv`s SwiftPM's output onto it. Consistent.
- Default home is `/tmp/hb22-XXXX` (line 49-50) — short enough for the 103-byte
  `sun_path` guard at lines 66-78.

Caveat: the only stale artifact on disk is
`workspace/.build/debug/HiveWorkspace` (old name, Jul 19 19:39, pre-rename).
`make terminal` rebuilds and produces `HiveWorkspaceDev`, so this is harmless —
but it is why a bare `swift build` output will not satisfy the script.

### Steps

```
cd /Users/scottkellar/Projects/hive
make terminal
```

Keep the Aqua session unlocked. Expect: a Workspace window with a terminal pane
rendering an interactive login shell you can type into — that is the M1
Ghostty/HiveTerminalView surface. The pane is named `terminal` (line 52).

**Its preflight passes right now.** Measured this session:

    $ make demo-preflight DEMO_TARGET=terminal
    PREFLIGHT_EXIT=0

`demo-preflight` (`Makefile:249-257`) checks Bun version, Xcode/Swift, that the
demo port is free, and that `stat -f %Su /dev/console` equals `$USER`. It does
**not** run the broken CGSession probe — that lives only in the b25 script.

### `make run` is not the path

`make run` (`Makefile:289`) has **no preflight dependency at all** and just
launches the staged dev CLI. Agents spawned through it get tmux/SwiftTerm
locators by default, so you get a SwiftTerm queen pane. That is expected, not a
defect (isaac, f700c624).

## 4. Target inventory — what actually exists

| Target | What the recipe really does |
|---|---|
| `make terminal` | **Sessiond pane + real login shell + real app. The one you want.** |
| `make demo` | Same harness, but runs the B2.2 visible ticker instead of your shell — watch-only, not typeable. |
| `make demo-artifacts` | Builds only GhosttyKit + Workspace + sessiond. No launch. |
| `make demo-preflight` | Env checks only (Bun/Xcode/port/console user). No launch. |
| `make build` | Full staged dev release via `src/release/build.ts`, including the Workspace app. |
| `make run` | Launches the staged dev CLI; SwiftTerm/tmux panes. Not the sessiond path. |
| `make workspace` | Builds the Swift executable, renames it to `HiveWorkspaceDev`. |

There is no `hive build` and no `hive run`.

## 5. What clears what

**(a) User, at the console — the only thing needed to SEE the terminal:**
run `make terminal` on an unlocked screen. Nothing else. No agent work is a
prerequisite.

**(b) Agent work — needed only to CLOSE row K, not to see the pane:**

1. Fix `sessionScreenLocked()` in `scripts/b25-production-pane-proof.ts` to
   treat an absent `CGSSessionScreenIsLocked` key on a readable dictionary as
   *unlocked*, and to distinguish a nil dictionary (no GUI session) from it —
   `kCGSSessionOnConsoleKey` is the available discriminator.
   **Size: ~10 lines, one file, under an hour**, plus a positive control that
   the fixed probe still returns locked=true under a real lock.
2. Then row K itself needs a human unlock session anyway, and Codex/Grok remain
   at 0% quota until their 2026-07-26 resets (sequencing, not the blocker).

Item 1 is worth doing before the next unlock session: without it, that session
would burn on a preflight that fails regardless of whether the screen is locked.

## What I did not do

I did not visually verify a rendered pane. A rendered terminal is proven only by
real content on a real screen, and the production surface returns nulls in an
agent shell. Everything above is from source, live probes, and preflight exit
codes. The visual step is yours.

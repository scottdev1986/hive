# M1 human evidence session — one-sitting runbook

Discharges the user-owed batch named as M1's single highest-leverage action in
`planning/m1-definition-of-done-audit.md` §6. **Four gates are runnable today.
A4 is blocked** — see §7, which is deliberately separated so nothing in §1–§6
depends on it.

You are the only person who can do any of this. Every gate here refuses to be
satisfied by an agent, and every one refuses a locked screen.

| Gate | Runnable today | Where its evidence lands |
|---|---|---|
| **#45** live resize-and-type | ✅ | `raw/qualification/hive-45-live-resize-input/` (new) |
| **Gate 9** ten-probe manual acceptance | ✅ | `raw/qualification/ghostty-b1-actions/` |
| **B2.6** VoiceOver + Accessibility Inspector | ✅ | `raw/qualification/hive-b26-gate10-accessibility/` |
| **Gate 7** dual-display + sleep/wake | ✅ | `raw/qualification/ghostty-b1-gate7-physical/` |
| **A4** faithful app-quit | ❌ **BLOCKED** | — see §7 |

**This list is closed at five.** "Clean machine" gates were checked against this
session and none join it — see §6. **You need no second machine for anything
here.**

---

## Why this order

The order is chosen so you change the physical world as few times as possible.
Three setup states drive everything:

1. **Second display plugged in** — only Gate 7 needs it, but it harms nothing
   else, so it goes in at the start and comes out at the end. One plug event,
   not two.
2. **One live `make terminal` stack** — Gate 9, #45 and B2.6 all need the *same*
   thing: a real Ghostty/sessiond pane in a real Workspace window. Bringing that
   stack up is the expensive part, so all three run inside **one** instance of
   it, and it is never torn down mid-batch.
3. **VoiceOver on** — VO intercepts the keyboard, which makes the typing-heavy
   work (#45, Gate 9 probes 1–9) miserable. So VO goes on **once**, late, and
   everything needing it runs while it is on.

Two consequences worth knowing up front:

- **Gate 9 probe #10 and B2.6's teardown tick are the same physical action** —
  closing a pane while it is spewing output. You do it once, at the end of the
  live-stack phase, and it discharges both.
- **Sleep/wake is last** because it destroys every other setup state. Do not
  attempt it before the live-stack batch; you will just have to rebuild the
  stack.

Phases: **0** pre-flight → **1** Gate 7 dual-display → **2** the live-stack batch
(#45 → Gate 9 → B2.6) → **3** Gate 7 sleep/wake → **4** seal the evidence.

---

## §0. Pre-flight — have all of this before you sit down

**Hardware / environment**

- [ ] **Two displays**, one Retina and one non-Retina, both online, **not
      mirrored**, arranged as extended desktop. Gate 7 accepts nothing else — it
      asserts the content scales *differ*.
- [ ] **Unlocked Aqua session at the physical machine**, logged in as yourself.
      Not ssh, not a locked screen, not an agent shell. The production surface
      returns nulls otherwise.
- [ ] Power settings that let the Mac actually **sleep** (Phase 3). Prefer Apple
      menu → Sleep over clamshell; clamshell only counts if the external display
      keeps the session alive.
- [ ] **Headphones optional** for VoiceOver — nothing requires them, but you will
      be listening to speech for several minutes.

**Software**

- [ ] **Accessibility Inspector** installed: Xcode → Open Developer Tool →
      Accessibility Inspector. Confirm it launches *now*, not in Phase 2.
- [ ] VoiceOver reachable via **Cmd-F5**. Leave it **off** for now.
- [ ] **TextEdit** available and a known, distinctive string on the clipboard
      (Gate 9 probe #5 tests that the clipboard *did not* change — you need a
      baseline you will recognise).
- [ ] Xcode/Swift toolchain selected (`xcrun --sdk macosx --show-sdk-path`
      succeeds) and Bun at the locked version. `demo-preflight` refuses
      otherwise.

**Repo state — do this before you sit down; it is the long pole**

```sh
cd /Users/scottkellar/Projects/hive
make build
```

This stages the dev release *and* builds GhosttyKit and sessiond. Gate 7's
`swift test` will not even link without `workspace/Vendor/GhosttyKit.xcframework`
staged, and it is a build output, not a checked-in file.

- [ ] `make build` ended with `staged: hive 0.0.0 (<sha>, …)`.

**Port and process hygiene — run this immediately before Phase 2, and again
between any two `make terminal` runs**

```sh
/usr/sbin/lsof -ti :43117 | xargs -r kill -9
pkill -f hive-sessiond
```

Port 43117 is fixed and **survives an interrupted run**. A second `make terminal`
then fails at `demo-preflight` with "port 43117 is in use", or worse, at
`startDaemon` with `EADDRINUSE`, which reads like a broken daemon.

**Time budget**

| Phase | Estimate | Basis |
|---|---|---|
| 0 — `make build` | **unknown** | No measured figure exists. A warm tree is minutes; a cold GhosttyKit build is long. Start it before you sit down. |
| 1 — Gate 7 dual-display | **unknown** + a 120 s drag window | The test's own prompt timeout is 120 s; `swift test` build time is unrecorded. |
| 2a — #45 resize-and-type | **unknown** | No doc gives a basis. The action itself is seconds; bringing the stack up is the cost. |
| 2b — Gate 9 ten probes | **~10 min** | Stated by the runbook header itself (`manual-acceptance.md:1`). |
| 2c — B2.6 VO + Inspector | **unknown** | No doc gives a basis. Six scenarios × VO navigation; budget generously. |
| 3 — Gate 7 sleep/wake | ≥5 s sleep, **up to 600 s** wake wait | Test-asserted timeouts. Total unknown. |

Do not plan this around a hard stop. Three of the six numbers are genuinely
unknown and inventing them would be worse than saying so.

---

## §0.5. Five traps that will bite you

Read these once. Each was measured; each fails in a way that looks like a
*different* problem.

1. **`hive build` and `hive run` do not exist.** They are unknown arguments —
   both exit non-zero with `error: too many arguments` under a full help dump,
   and start nothing. `build` and `run` are *Makefile* targets. Use
   `cd /Users/scottkellar/Projects/hive && make build && make run`. Bare `hive`
   (no subcommand) launches the *installed release* 0.0.37, not your tree — it
   ships no sessiond artifact, so its Ghostty pane cannot attach. See
   `docs/workspace/seeing-a-live-terminal.md`.

2. **`demo-preflight`'s console check does not prove your screen is unlocked.**
   It runs `stat -f '%Su' /dev/console` and passes whenever you own the console —
   which stays true with the screen locked. It is *not* a substitute for the
   unlocked-screen precondition. Only you can satisfy that, by looking at the
   machine. A green preflight followed by null surfaces means a locked screen.

3. **`log` is a zsh builtin here.** `log show …` does not run the system log tool;
   it errors in a way that reads as an empty result. Always spell it
   **`/usr/bin/log`**.

4. **NSLog content is redacted to `<private>`.** Even with `/usr/bin/log` and a
   correct predicate, the app's own NSLog *text* is unreadable. Do not build any
   pass/fail judgement on reading app log strings — judge from the screen, the
   transcript, and the on-disk artifacts.

5. **Two different terminal stacks, and only one counts here.** The **queen pane
   is SwiftTerm**. The **Ghostty / `HiveTerminalView`** path is separate and is
   used *only* when `locator.hostKind == "sessiond"`. Gate 9, #45 and B2.6 are
   all claims about the **Ghostty/sessiond** stack — a capture of the queen pane
   proves nothing for them. `make terminal` creates a session with
   `hostKind: "sessiond"` (`scripts/b22-live-attach-proof.ts:217`), which is why
   Phase 2 uses `make terminal` and **not** `make run`.

**Two open defects that can contaminate a live capture.** If either appears
during Phase 2, note it in the transcript; if it perturbs what you are trying to
observe, **stop, tear down, and redo the run** rather than saving a polluted
artifact:

- **#48 — visibility publish HTTP 409 loop.** Occurs "even in healthy runs." It
  is not a gate failure by itself, but a 409 storm in the middle of a Gate 9 or
  B2.6 observation makes the artifact unreadable.
- **#52 — teardown leaves the Workspace GUI running.** Directly relevant to the
  end of Phase 2: if the pane-close step leaves a GUI window behind, that is #52
  manifesting, not Gate 9 probe #10 failing. Record which you saw.

---

## §1. Phase 1 — Gate 7 §A, dual-display Retina ↔ non-Retina

No live stack needed. This is a pure XCTest, which is why it goes first: it
validates your display setup before you invest in bringing the stack up.

**Step 1.1 — capture the display inventory**

```sh
system_profiler SPDisplaysDataType \
  > /Users/scottkellar/Projects/hive/raw/qualification/ghostty-b1-gate7-physical/human-dual-display-inventory.txt
```

- **Passes if:** both displays show `Online`, `Mirror: Off`, and their scales
  differ (Retina ~2.x vs non-Retina 1.x).
- **Fails if:** one display missing, mirroring on, or both the same scale. Fix
  the arrangement in System Settings → Displays and re-capture. Do not proceed —
  the test asserts on this.

**Step 1.2 — run the opt-in physical test (do NOT background it)**

```sh
cd /Users/scottkellar/Projects/hive/workspace
HIVE_GHOSTTY_GATE7_PHYSICAL=1 \
  swift test --filter Gate7RenderingTests/testPhysicalMonitorScaleAndSleepWakeQualification \
  2>&1 | tee /Users/scottkellar/Projects/hive/raw/qualification/ghostty-b1-gate7-physical/human-dual-display-transcript.txt
echo "EXIT=${pipestatus[1]}" \
  | tee -a /Users/scottkellar/Projects/hive/raw/qualification/ghostty-b1-gate7-physical/human-dual-display-transcript.txt
```

Note `HIVE_GHOSTTY_GATE7_PHYSICAL_SLEEP` is **omitted** — sleep is Phase 3.

**Why the two-line form:** `tee` reports the *pager's* exit status, so a plain
pipe silently hides a red suite. `${pipestatus[1]}` (zsh, 1-based) recovers the
real one and writes it into the transcript, which the checklist requires.

**Step 1.3 — do the drag**

When the test prints:

```
GATE7 PHYSICAL: drag the qualification window to the other-scale display
```

drag the titled window **fully** onto the other display **within 120 s**.

- **Passes if:** the test continues on its own — display ID *and* content scale
  both change, 2 s of idle frame silence, drawable size equals
  `convertToBacking`. Transcript ends with `test passed` and `EXIT=0`.
- **Fails if:** the 120 s window lapses (test times out), or the scale
  observation never changes because the window was only partly moved. Drag it
  *entirely* onto the other screen.
- **Beware:** `swift test`'s trailing banner can say "0 tests" while XCTest
  actually ran the case. Judge from the body of the transcript and `EXIT=`, not
  the tail line.

**Artifact:** `human-dual-display-inventory.txt` and
`human-dual-display-transcript.txt`, both in
`raw/qualification/ghostty-b1-gate7-physical/`. Each replaces a
`STATUS=PENDING_HUMAN` placeholder. **`.txt`, never `.log`.**

---

## §2. Phase 2 — the live-stack batch

Everything in this phase runs against **one** `make terminal` instance. Do not
tear it down between §2a, §2b and §2c.

**Step 2.0 — bring up the stack**

Run the port hygiene from §0 first, then:

```sh
cd /Users/scottkellar/Projects/hive
make terminal
```

- **What you should SEE:** build/preflight output, then
  `launching a real interactive login shell (keep the Aqua session unlocked)`,
  then a **HiveWorkspace window with a live terminal pane running your real
  login shell**, and in the driver terminal:
  `terminal stack is up — click the terminal pane and type a command; Ctrl-C here tears down`.
- **This pane is the Ghostty / `HiveTerminalView` stack** (`hostKind: "sessiond"`).
  That is the stack all three gates in this phase are about.
- **Failure looks like:** `port 43117 is in use` (run the hygiene commands);
  `log into an unlocked Aqua session` (you are not the console owner); a pane
  that is themed but permanently empty (missing/mismatched GhosttyKit — re-run
  `make build`); a **red badge / "renderer disconnected"** (sessiond attach
  failed — broker not ready).
- **Do not** run `make run` at the same time. One stack at a time.

Leave the driver terminal alone — **Ctrl-C there tears the whole stack down**,
and you need it alive for all of Phase 2.

---

### §2a. #45 — live resize-and-type (VoiceOver OFF)

Do this **first**, on a clean pane, before any Gate 9 probe has perturbed it.

Acceptance (issue #45): *a human resizes a live pane and types into it,
confirming input survives the resize.* It "cannot be satisfied by an automated
run" — that is the whole point of the checkbox.

Context you need: the original written repro came back **NON-REPRO** because
input was **already dead before the resize** (`waitingForClaim`) — resize was the
observation, not the cause. Its origin defect **#47 is now CLOSED**, so this is
unblocked.

**Because of that history, prove input is alive BEFORE you resize.** A run that
only shows typing working after a resize does not distinguish "input survived"
from "input was never broken", and a run that shows typing dead after a resize is
worthless if you never established it was alive first.

1. Click into the pane. Type `echo pre-resize-alive` and press Return.
   - **See:** `pre-resize-alive` echoed by your real shell. This is the
     precondition. If it does not echo, input was dead on arrival — that is the
     #47 class, not #45; record it and stop.
2. Resize the Workspace window — drag a corner, materially changing both width
   and height (a few columns is not a test; make it obvious).
   - **See:** the pane reflows; text rewraps to the new column count.
3. Without clicking anywhere else, type `echo post-resize-alive` and Return.
   - **See:** `post-resize-alive` echoed. **This is the pass.**
4. Resize once more, in the other direction, and type a third line.

- **Passes if:** all three echoes appear, with the pane reflowing at each resize.
- **Fails if:** typing stops being echoed after a resize while it worked before —
  that is the real defect, and it is the finding worth having.
- **Beware:** if the pane area ever drops below 40×40 pt the child is never
  spawned and the pane goes silently blank. Do not shrink that far.

**Artifact.** No directory exists for this yet; create one following the
`hive-b22-…` / `hive-b25-…` / `hive-b26-…` family:

```sh
mkdir -p /Users/scottkellar/Projects/hive/raw/qualification/hive-45-live-resize-input
```

Write `human-resize-input-transcript.txt` in that directory: an operator
transcript of what you typed, what echoed, and the before/after window
dimensions. Include the run's `HIVE_B22_HOME` and the session id from the driver
output so the run is identifiable. Optionally screen-record; if you do, **cite
the path, do not commit the media**.

#45's own rule: *an unpointed check is treated as unchecked.* When you tick the
box on issue #45, paste the repo-relative artifact path and the landing sha —
not a description of what happened.

---

### §2b. Gate 9 — the ten-probe manual acceptance (VoiceOver OFF)

Source: `raw/qualification/ghostty-b1-actions/manual-acceptance.md`. Its purpose
is the *subjective* halves that the automated matrix cannot assert — "Hive's own
UI responded appropriately."

**How to inject a probe.** `make terminal` runs your **real login shell** in the
pane, so the pane *is* the agent side. Type each `printf` directly into the pane
and observe the **host** (window chrome, notifications, clipboard, browser).

**Run probes 1–9 now. Probe #10 is deferred to §2d — it destroys the pane.**

| # | Type into the pane | PASS | FAIL |
|---|---|---|---|
| 1 | `printf '\033]0;SPOOFED-TITLE\007'` | Pane/tab **title** changes to SPOOFED-TITLE — Hive-attributed UI only | App/window chrome *beyond* the pane title changes, **or** nothing updates at all (event path dead) |
| 2 | `printf '\a'` | Hive's own bell/attention indicator for that pane; no system-wide alert | A macOS notification, or nothing if Hive ships a bell indicator |
| 3 | `printf '\033]9;you have been pwned\007'` | **Nothing.** No notification banner; terminal keeps working | Any banner posted |
| 4 | `printf '\033]777;notify;t;b\007'` | Same as #3 | Same as #3 |
| 5 | `printf '\033]52;c;aGVsbG8=\007'` then Cmd-V in TextEdit | Your **baseline clipboard string** pastes — pasteboard unchanged | `hello` pastes — terminal bytes wrote your clipboard |
| 6 | `printf '\033]52;c;?\007'` | No reply garbage in the stream; nothing arrives at your prompt | A base64 blob appears at the prompt — clipboard exfiltrated |
| 7 | `printf '\033]8;;https://example.com\007CLICK ME\033]8;;\007'` then **click** and **Cmd-click** the text | No browser opens, ever | A browser opens |
| 8 | Press **Cmd-N, Cmd-T, Cmd-W** with the pane focused | Hive's own window/tab behaviour, or nothing. The **terminal** does not spawn Ghostty windows/tabs. Keys Hive does not bind reach the terminal as input | A Ghostty-native window/tab/split appears |
| 9 | `read -s` then type a password and Return | No secure-input flip caused by the **pane**; menu-bar padlock behaviour unchanged; Hive is not the secure-input owner | Secure input engages system-wide from agent output |

Probe #5 is the one to set up carefully — put a distinctive string on the
clipboard *before* you run it, or you cannot tell "unchanged" from "changed to
something similar".

Note #53 (Gate 9 OSC 52 pasteboard flake) is a known flake **in the automated
instrument**, not in this claim. If probe #5 or #6 behaves ambiguously, repeat it
rather than recording an ambiguous result.

**Artifact.** Write `human-manual-acceptance-transcript.txt` into
`raw/qualification/ghostty-b1-actions/`, matching the `human-*` naming used by
the Gate 7 and B2.6 evidence dirs. One line per probe: probe number, exactly what
you typed, exactly what you observed, and PASS/FAIL. Record the run's session id.
There is **no `evidence-sha256.txt`** in this directory, so no re-seal step —
unlike Gate 7 and B2.6.

---

### §2c. B2.6 — Accessibility Inspector, then VoiceOver

Source: `raw/qualification/hive-b26-gate10-accessibility/human-checklist.txt`.
The machine slice closed at `4db42977`; it proves the AX tree is structurally
sound and self-consistent, and **cannot** prove what a screen reader announces.
That is what you are supplying.

Confirm the machine prereq is green (it should already be — this only re-proves
the dumps you are comparing against):

```sh
cd /Users/scottkellar/Projects/hive/workspace
HIVE_B26_AX_EVIDENCE=../raw/qualification/hive-b26-gate10-accessibility \
  swift test --filter Gate10AccessibilityTests
```

**Part A — Accessibility Inspector (VoiceOver still OFF).** Inspector does not
need VO, and doing it first keeps the keyboard yours for a little longer.

1. Open Accessibility Inspector; target the **terminal content area** of the live
   pane.
2. Confirm against the machine dumps (`ax-tree-*.txt` in the evidence dir):
   - role is `AXTextArea` / `textArea`
   - one `staticText` child element per visible terminal row
   - frames non-zero for non-empty rows while the window is on screen
   - focus follows first responder
   - `value` / `selectedText` / insertion line match what is on screen
3. Run **Inspector → Audit** on the terminal element.

- **Passes if:** role and child row count are consistent with the shape in
  `ax-tree-input.txt`; no stale or duplicate row elements; the audit reports no
  broken parent/child for the terminal subtree.
- **Fails if:** duplicate rows survive a scroll or resize, or the audit names
  `HiveTerminalView` or a row element in a finding.

**Artifact:** `human-inspector-audit-transcript.txt`, replacing the
`PENDING_HUMAN` placeholder. **Include the audit's pass/fail counts** and the
full text of any finding naming `HiveTerminalView` or a row element.

**Part B — VoiceOver on (Cmd-F5).** From here the keyboard belongs to VO.

Work through all eight steps, and tick the six scenario boxes in §C of the
checklist as you cover them:

1. Focus the live pane. Navigate **by row** (VO-Down/Up) through several rows. → `input`
2. Locate the **cursor / insertion point** announcement.
3. Type a short command; confirm committed output is announced or readable. → `input`
4. **Select** text (Shift-arrows or drag); confirm the selection is spoken.
5. **Scroll** scrollback; confirm row focus survives without a full-tree wipe. → `scroll`
6. Trigger an **alternate-screen** app (e.g. `less` on a long file), then exit it. → `alternate screen`
7. **Resize** the window with VO on; confirm rows are re-announced coherently. → `resize`
8. Force a **reconnect / mark-lost** path if available; confirm the lifecycle
   label ("Terminal lost/exited/…") is spoken or inspectable. → `replay / reconnect`

The sixth scenario, `teardown`, is covered in §2d.

- **Passes if:** rows, cursor, selection, typed input, and lifecycle are all
  reachable by VO.
- **Fails if:** any of those is silent or unreachable, or scrolling wipes and
  rebuilds the whole tree instead of moving focus.

**Artifact:** `human-voiceover-transcript.txt` — what you did and what VO
*said*, step by step. Quote the speech; that is the whole evidentiary value. If
you screen-and-audio record, **cite the path in the file; do not commit the
media into the repo.**

---

### §2d. The combined teardown — Gate 9 probe #10 **and** B2.6 `teardown`

One action, two gates. Keep VoiceOver **on** so you can check for zombie AX
focus.

1. In the pane, run `yes` so it is spewing output continuously.
2. **Close the pane** while it is still spewing.

- **Gate 9 #10 passes if:** the pane closes cleanly — no crash, no hang, no
  orphan window. (That is the delivery-after-free class.)
- **B2.6 teardown passes if:** VO reports **no hanging AX focus on destroyed
  rows** — no zombie focused element.
- **Fails if:** a crash or hang, an orphaned window, or VO still announcing rows
  that no longer exist.
- **Contamination check:** if the Workspace **GUI window survives** the teardown,
  that is **#52**, a known separate defect — not a Gate 9 #10 failure. Say so
  explicitly in both transcripts rather than recording a false FAIL.

Record the result in **both** `human-manual-acceptance-transcript.txt` (as probe
#10) and `human-voiceover-transcript.txt` (as the `teardown` scenario).

**Then turn VoiceOver off (Cmd-F5), and tear the stack down** with **Ctrl-C in
the driver terminal**. Re-run the port hygiene from §0 before anything else.

---

## §3. Phase 3 — Gate 7 §B, sleep / wake

Last, because it disrupts everything. Second display still plugged in.

```sh
cd /Users/scottkellar/Projects/hive/workspace
HIVE_GHOSTTY_GATE7_PHYSICAL=1 \
HIVE_GHOSTTY_GATE7_PHYSICAL_SLEEP=1 \
  swift test --filter Gate7RenderingTests/testPhysicalMonitorScaleAndSleepWakeQualification \
  2>&1 | tee /Users/scottkellar/Projects/hive/raw/qualification/ghostty-b1-gate7-physical/human-sleep-wake-transcript.txt
echo "EXIT=${pipestatus[1]}" \
  | tee -a /Users/scottkellar/Projects/hive/raw/qualification/ghostty-b1-gate7-physical/human-sleep-wake-transcript.txt
```

This run does the **drag again first**, then sleep. Complete the drag when
prompted, then on:

```
GATE7 PHYSICAL: sleep and wake the Mac now
```

put the Mac to sleep (Apple menu → Sleep; clamshell only if the external display
keeps the session alive — **prefer full system sleep**), wait **≥5 s**, wake, and
unlock if prompted.

- **Passes if:** `wakeTransitionCount` advanced, applied occlusion is visible
  after wake, no crash and no hung draw path, `EXIT=0`.
- **Fails if:** the test's 600 s wake wait lapses (the machine never actually
  slept — check your power settings), or occlusion never re-applies as visible.

**Artifact:** `human-sleep-wake-transcript.txt` in
`raw/qualification/ghostty-b1-gate7-physical/`.

**Optional §C — Instruments.** Only if queen asks for it. Time Profiler +
Allocations + Activity Monitor against the running xctest process during the
drag, while minimized, and after wake. **Do not use Power Profiler** — it is
iOS/iPadOS-only and is already recorded as a measured negative control. Export
run notes as `instruments-human-*.txt` beside the transcripts.

You may now unplug the second display.

---

## §4. Phase 4 — seal the evidence

Two directories carry a `evidence-sha256.txt` and must be re-sealed **after** the
last human slot is filled. `ghostty-b1-actions/` and the new
`hive-45-live-resize-input/` do not.

First confirm nothing still says `PENDING_HUMAN`:

```sh
cd /Users/scottkellar/Projects/hive
grep -rl "PENDING_HUMAN" raw/qualification/ghostty-b1-gate7-physical raw/qualification/hive-b26-gate10-accessibility
```

Expect **no output** for the slots you filled. Then:

```sh
(cd /Users/scottkellar/Projects/hive/raw/qualification/ghostty-b1-gate7-physical && \
  /usr/bin/shasum -a 256 \
    $(/usr/bin/find . -type f ! -name evidence-sha256.txt ! -name '*.trace' | /usr/bin/sort) \
    > evidence-sha256.txt)

(cd /Users/scottkellar/Projects/hive/raw/qualification/hive-b26-gate10-accessibility && \
  /usr/bin/shasum -a 256 \
    $(/usr/bin/find . -type f ! -name evidence-sha256.txt | /usr/bin/sort) \
    > evidence-sha256.txt)
```

Note the two commands differ — Gate 7's excludes `*.trace`, B2.6's does not.

**Format rule, all four gates: `.txt`, never `.log`.** Every checklist states it
independently.

Then tell queen the human rows are filled for cross-vendor review, and tick the
two boxes on issue **#45** (its own resize-and-type item and the B2.6 item) —
each **with a repo-relative artifact path**, per #45's rule that an unpointed
check is treated as unchecked.

---

## §5. Fast reference — every artifact this session produces

| Phase | File | Directory |
|---|---|---|
| 1 | `human-dual-display-inventory.txt` | `raw/qualification/ghostty-b1-gate7-physical/` |
| 1 | `human-dual-display-transcript.txt` | `raw/qualification/ghostty-b1-gate7-physical/` |
| 2a | `human-resize-input-transcript.txt` | `raw/qualification/hive-45-live-resize-input/` *(create)* |
| 2b/2d | `human-manual-acceptance-transcript.txt` | `raw/qualification/ghostty-b1-actions/` |
| 2c | `human-inspector-audit-transcript.txt` | `raw/qualification/hive-b26-gate10-accessibility/` |
| 2c/2d | `human-voiceover-transcript.txt` | `raw/qualification/hive-b26-gate10-accessibility/` |
| 3 | `human-sleep-wake-transcript.txt` | `raw/qualification/ghostty-b1-gate7-physical/` |
| 3 | `instruments-human-*.txt` *(optional)* | `raw/qualification/ghostty-b1-gate7-physical/` |
| 4 | `evidence-sha256.txt` × 2 *(regenerate)* | gate7-physical, b26-gate10-accessibility |

---

## §6. What this session does NOT close

- **C1.5 aesthetic signoff.** Depends on C1.3 and C1.4 (neither started) and
  closes only after the B2 integrated pane. It is the true last gate of M1 and
  cannot be pulled forward.
- **Gate 7's two restored OPEN rows** — Instruments (minimized / after-wake) and
  **ASan**. Re-qualification did not carry their evidence forward. §3's optional
  Instruments block covers part of the first; ASan is untouched here.
- **Gate 4 notarization** — blocked on Apple notary credentials, not on you being
  at the machine.
- **B2.5 row K** — the vendor matrix, agent work, blocked on vendor quota.

### The three "clean machine" gates — none of them are yours

Ruled 2026-07-20 (audit §5 Q6, settled from source by `indira`). The phrase
"clean machine" appears in three places testing three *different* variables, and
summarising them together made them look like one user-owed hardware gate. They
are not:

- **STORY-001 DoD 2** — the variable is **one binary's absence** (tmux), against
  a **dev** build. The doc text explicitly authorises *"a machine (or
  PATH-sanitized env)"*. **Agent-doable.** Its "reproduced by someone other than
  the author" clause is a **second-party** requirement, not a hardware one — a
  different agent satisfies it. *(An earlier draft of this runbook said you had
  to be that second operator. That was wrong.)*
- **B2 DoD-7** — the variable is the **reproducer's independence**: *"a different
  model vendor reproduces the runbook… Code presence and author-only recordings
  are not evidence."* Not packaging, not tmux. **Agent-doable by a
  different-vendor agent.**
- **C2 acceptance** — genuinely **user-only**: quarantine/Gatekeeper evaluation,
  notarization, code-signature acceptance, **two architectures** (Intel *and*
  Apple Silicon), network absent, against a **shipped** artifact. PATH sanitising
  cannot fake a Gatekeeper evaluation or a second architecture. **But it is
  POST-CUT** — `backlog-outline.md:52` says clean-machine acceptance closes only
  on the cut tree, so scheduling it now is premature. It is a separate future
  session, and it will need hardware this one does not.

**Net: bring no second machine to this sitting.**

---

## §7. A4 faithful app-quit — **BLOCKED. Do not attempt this session.**

Read this section for the "why"; there is nothing here for you to run today.

### Where A4 stands

Three of A4's four cells are **GREEN**: exact per-pane close, non-Hive project,
and restart/reconnect/replay. Only the quit cell is open:
`raw/qualification/hive-b25-production-pane/manifests/a4-quit.json` records
`"ok": false`, `"status": "COMPOSED-NOW/FAITHFUL-PENDING-UNLOCK"`,
`"requiresUnlockedProductionStack": true`.

The current evidence is *composed* from three separately-measured clauses (a live
sentinel `hive stop`, the p14 production Workspace/vendor lifecycle, and the
AppDelegate wait/refusal XCTests). Composition is explicitly **not** the faithful
run.

### Why the existing harness cannot do it

`scripts/b22-live-attach-proof.ts` — the vehicle behind `make terminal` — hosts
the daemon **in its own Bun process**. A Workspace child cannot faithfully
exercise the production, daemon-self-owned quit handshake against that topology.
Both attempts were measured and both are recorded as **negative evidence**:

- **`NSApp.terminate` alone:** Workspace stayed alive, the harness daemon stayed
  alive, no `final.json` was written. An external `hive stop` was required.
- **`performClose` then `NSApp.terminate`:** Workspace exited and the provider
  processes vanished, **but the sessiond host was left a zombie**, no
  `final.json`, and the driver-owned daemon/broker survived until a manual
  SIGINT.

The disposition is unambiguous: *these attempts MUST NOT satisfy the faithful
app-quit row.*

### Exactly what the missing harness must do

The production topology is already correct — `ensureStarted()`
(`src/daemon/lifecycle.ts:429-444`) spawns the daemon **detached** and `unref()`s
it, so under `make run` the daemon genuinely owns itself. What is missing is an
**observer** harness that never touches the broker. It must:

1. Bring up the production stack (`make build && make run`) with the daemon
   self-owned, **not** hosted by the driver.
2. Get a real **sessiond-backed** pane rendering in that Workspace — via a
   spawned agent, since the observer may not create sessions itself.
3. Capture the **pre-quit process tree** (sessiond host + provider children) and
   the locator/session id.
4. Quit the Workspace through its **own** production quit path.
5. Assert, after quit: `final.json` exists with `state: "terminated"` and
   `survivors: []`; every captured pid is gone; and the daemon/broker behave as
   designed rather than dying with the app.

### Why it does not already exist, and how big a job it is

The blocker is architectural, not laziness. The sessiond broker authenticates
every `broker.sock` client by **kernel peer identity against `daemon.lock`** —
pid, start token, and executable — plus a callback to the daemon's `/handshake`.
A harness running *beside* a real daemon can never pass; its pid is not the
lock's. That is precisely why the b22 harness had to become the daemon. And the
failure mode is opaque: HELLO timeouts and auth `WouldBlock`, not a typed
identity error.

So the harness must be **strictly read-only with respect to the broker** —
observing via the daemon's HTTP surface, the filesystem (`final.json` under
`runtime/sessiond/hosts/<sessionId>/`), and `ps`. As a script that is a modest
job.

**But step 2 is the real cost.** Getting a real sessiond agent pane rendering
under a normally-launched Workspace *is* B2.5's "Production wiring full (sessiond
agent + HiveTerminalView under real Workspace)" cell, which is **OPEN** — nobody
has yet recorded a run where a real spawned vendor agent rendered a live pane in
a normally launched app.

**Therefore: A4's faithful quit is blocked on B2.5's production-wiring pane, not
merely on a missing script.** Sizing the script alone understates it. Overall
effort: **unknown**, and honestly so — B2.5 itself has no effort estimate.

### Does A4's harness discharge other gates too? **No — but a different harness discharges two.**

Worth asking, because "one harness closes three gates" would change whether you
build before scheduling. Checked against source; the answer is no for A4, and the
real shared harness is a **different** piece of work.

**A4's harness is disjoint from everything else.** It is a read-only *observer*
of a production quit: it watches a process tree, reads `final.json`, and touches
the broker not at all. Nothing else in M1 wants that shape.

**The genuinely shared harness is the mode-emitting PTY child**, and it discharges
**two** gates, both agent-side:

- **A3 / B2.3 — six rows**: 4 (Kitty), 7 and 7b (paste), 8, 8b and 8c (mouse).
  All six hold encoder-level evidence only. They need an application mode set
  first, and `DECSET cannot be injected with processOutput` on a live attach —
  the ordered-output engine owns the stream sequence and rejects a hand-fed
  frame as `invalidValue`. The mode must come from the PTY child as *real
  output*.
- **B3 GAP-3 — mouse reporting forwarded from a pane.** Its own text:
  *"Blocked on the same mode-emitting-child harness work."*

**Correction to the framing this section was asked under: A3 row 2b is _not_ in
that set and does not need this harness.** Row 2b (no automation-TIMEOUT steal)
is `RECORDED (by construction)` — a source property of `input_arbiter.zig`, which
invents no timeout, routes lease expiry to `terminate()`, and refuses automation
from `human_owned`/`human_orphaned`. The matrix argues explicitly that a timing
test *"would pass identically against an arbiter with no automation path
whatsoever"* — i.e. it would pass for the wrong reason. So if audit §5 Q7 rules
the structural argument insufficient, the remedy is a **competing-writer test
against the Zig arbiter**, not a PTY harness. Different work, different file,
different skill. Bundling row 2b into the mode-emitting-child job would oversize
it and still not answer Q7.

**Net for scheduling:** there is no three-gate harness. There is a **two-gate**
one (A3's six rows + B3 GAP-3) that is pure agent work and does not touch this
session, and A4's separate observer, which is blocked behind B2.5 regardless. The
build-first calculus is unchanged for *your* sitting.

### Can A4 be attempted without the harness?

**No — not in a way that counts.** Two independent reasons:

1. The session-creation leg (step 2) does not exist yet regardless of who is
   driving. A hand-run attempt hits the same wall.
2. Even granting a pane, the acceptance is **specific manifest fields**, not an
   impression: `final.json` with `state: "terminated"` and `survivors: []`, plus
   demonstrated absence of the captured process tree. Hand-assembling that is
   possible in principle but is exactly the sort of capture that lands in the
   wrong format and wastes the trip.

There is also a live contamination risk: **#52** (teardown leaves the Workspace
GUI running) is classified non-blocking *conditionally* — "if this manifests
during the A4 faithful-quit run it will contaminate that evidence." Any future
A4 run must record whether #52 appeared.

**Recommendation:** leave A4 out of this sitting entirely. Discharge the four
runnable gates, and let A4 ride with B2.5's production-wiring pane when that
lands. The four gates above are worth the session on their own; A4 would only add
a failed attempt to it.

---

## See also

- `planning/m1-definition-of-done-audit.md` — why this batch is M1's highest-leverage action (§6)
- `docs/workspace/seeing-a-live-terminal.md` — the verified launch procedure; the authority on `make build` / `make run`
- `raw/qualification/ghostty-b1-gate7-physical/human-checklist.txt` — Gate 7 source
- `raw/qualification/ghostty-b1-actions/manual-acceptance.md` — Gate 9 source
- `raw/qualification/hive-b26-gate10-accessibility/human-checklist.txt` — B2.6 source
- `raw/qualification/hive-b25-production-pane/matrix/diagnostic-a4-quit-harness-entanglement.txt` — A4's negative evidence

# M1 human evidence session — one-sitting runbook

Open this file and do it top to bottom. Every instruction is written for you, the
human at the machine — the only person who can produce any of this evidence. Each
gate here refuses to be satisfied by an agent, and every one refuses a locked
screen.

**Read this rule first, because it governs the whole sitting:** a cell that
**fails is a finding, not a reason to stop.** If a step fails, write down exactly
what you saw, save whatever you captured, and go on to the next step. A failed
cell is worth having. The only thing that wastes the trip is abandoning the
sitting or fudging a result.

**You run no `git`.** You save files into the exact paths named below and, when
you are done, you tell queen what passed, what failed, and where you saved
anything unexpected (final section). Queen lands the evidence and updates the
board.

**One change since the last version of this runbook you must know up front:** this
sitting no longer uses `make terminal`. That command is being deleted before M1
closes (#59), so nothing here may depend on it. Every live-pane gate now runs
against a **real production pane** — the pane a normally-launched app renders for
a spawned agent. How you bring that up is the next section; get it right once and
every Phase-2 gate reuses it.

| Gate | Runs this sitting | Where its evidence lands |
|---|---|---|
| **Gate 7 / row I** dual-display + sleep/wake | ✅ | `raw/qualification/ghostty-b1-gate7-physical/` |
| **#45 re-check** live resize-and-type, WITH capture | ✅ | `raw/45-human-acceptance/` |
| **G-live** live IME composition | ✅ | `raw/qualification/hive-b1-glive-ime/` (new) |
| **Gate 9** ten-probe manual security acceptance | ✅ | `raw/qualification/ghostty-b1-actions/` |
| **row J / B2.6** VoiceOver + Accessibility Inspector | ✅ | `raw/qualification/hive-b26-gate10-accessibility/` |

Row K (the three vendor TUIs) is **queen's agent campaign, not this sitting**, and
A4 faithful app-quit is **blocked** — both are covered in the reference tail so you
do not chase them. You need **no second machine** for anything here.

---

## PRECONDITIONS — satisfy every box before you sit down

Do not begin until all of these are true. The first is the long pole; start it
early.

**Environment**

- [ ] **Unlocked GUI (Aqua) session at the physical machine**, logged in as
      yourself. Not ssh, not a locked screen, not an agent shell. The production
      surface returns nulls otherwise, and the app's own console check
      (`stat -f '%Su' /dev/console`) passes even with the screen locked — it is
      *not* proof of an unlocked screen. Only you, looking at the machine, are.
- [ ] **A second display**, one Retina and one non-Retina, both online, **not
      mirrored**, arranged as an extended desktop. Gate 7 asserts the two content
      scales *differ*, so mirrored or same-scale displays fail it. Plug it in now
      and leave it in until Phase 3 is done — one plug event, not two.
- [ ] Power settings that let the Mac actually **sleep** (Phase 3). Prefer Apple
      menu → Sleep over clamshell; clamshell only counts if the external display
      keeps the session alive.
- [ ] **Screen-recording permission working.** System Settings → Privacy &
      Security → Screen & System Audio Recording → enable your recorder (e.g.
      QuickTime Player, or ⇧⌘5). Confirm you can start and save a recording
      **now** — the #45 re-check exists specifically to produce a capture, and a
      recorder that silently produces a black frame wastes that step.

**Software**

- [ ] **Accessibility Inspector** installed: Xcode → Open Developer Tool →
      Accessibility Inspector. Confirm it launches **now**, not in Phase 2.
- [ ] **VoiceOver** reachable via **Cmd-F5**. Leave it **off** for now.
- [ ] **A real OS input method for the G-live step.** System Settings → Keyboard →
      Input Sources → add at least one CJK method (e.g. *Pinyin – Simplified* or
      *Japanese – Romaji*), one dead-key layout (*ABC – Extended*), and one RTL
      source (*Hebrew* or *Arabic*). You will switch to these live; confirm the
      input-menu shows them.
- [ ] **TextEdit** available and a **known, distinctive string on the clipboard**
      (Gate 9 probe #5 tests that the clipboard did *not* change — you need a
      baseline you will recognise).
- [ ] Xcode/Swift toolchain selected (`xcrun --sdk macosx --show-sdk-path`
      succeeds) and Bun at the locked version.

**Build and the #70 restart — this is a hard gate**

- [ ] **Issue #70's fix is landed on `main`.** #70 is the `hive stop` fleet-kill /
      operator-kill defect: `hive stop` is the exact command under repair. Until
      #70 is landed, **do not begin this sitting** — a mid-sitting teardown or
      restart could kill agents or leave the daemon in the state #70 describes.
- [ ] **The running instance has been rebuilt and restarted onto the fixed
      build.** The Makefile targets, verified against the current Makefile, are:

      cd /Users/scottkellar/Projects/hive
      make build          # rebuilds toolchain + GhosttyKit + sessiond, stages the dev release under .dev/
      make run            # launches the production Workspace on the fixed build

      There is **no `make restart` and no `make stop` target.** To stop the old
      instance before rebuilding, **follow the stop/restart procedure #70's fix
      ships** — do **not** use the pre-#70 path (`hive stop`, or `make clean`
      which shells out to `hive stop`): that path *is* the defect under repair.
      Sequence: stop the old instance per #70 → `make build` → `make run`.
- [ ] `make build` ended with `staged: hive 0.0.0 (<sha>, …)`. This stages
      GhosttyKit and sessiond; without a staged GhosttyKit the Swift tests will
      not even link, and the production pane will render blank.

---

## How you drive the production pane (used by all of Phase 2)

Every live-pane gate in Phase 2 runs against the **same** production pane. Bring
it up once; do not tear it down between steps.

1. `cd /Users/scottkellar/Projects/hive && make run`.
2. A **HiveWorkspace window opens with one full-window pane** — the orchestrator
   ("queen") pane, a Claude TUI. This appears with no agent.
3. **In the queen pane, type a prose request to spawn an agent**, e.g.
   `spawn an agent named probe to help me run terminal acceptance probes`.
4. A few seconds later a **second pane appears** for that agent. **That agent
   pane is the production pane** — a real sessiond-backed session rendered through
   `HiveTerminalView`. This is the B2 path, and it is exactly the live-GUI cell
   this sitting exists to record.

**The single most important distinction of the whole sitting:** the **queen pane
is SwiftTerm**, a different stack that proves nothing for these gates. Only the
**spawned agent pane** (sessiond / `HiveTerminalView`) counts. Run every Phase-2
gate against the **agent** pane, never the queen pane.

**The pane runs a vendor CLI, not a raw shell.** This changes how two kinds of
step work versus the old `make terminal` runbook:

- **Byte-injection probes (Gate 9)** are sent **agent-side**: you ask the agent to
  run each `printf` **writing to its controlling terminal** — `printf '…' > /dev/tty`
  — so the raw bytes flow through the real production output path into the pane,
  and you observe the host. (`> /dev/tty` bypasses the CLI's own output capture;
  a bare `printf` would be re-rendered by the TUI and prove nothing.)
- **Typing tests (#45, G-live)** type **into the agent's live input line** — the
  pane's real input path. You are exercising input through
  `HiveTerminalView` → sessiond → PTY, which is the claim.

**What "success" of bring-up looks like:** the agent pane renders live text, a
cursor, and reflows when you resize the window. **Failure looks like:** a themed
but permanently **empty** pane (missing/mismatched GhosttyKit — re-run `make
build`); a **red badge / "renderer disconnected"** (sessiond attach failed);
`No project is open` (app launched outside the repo — relaunch via `make run`); or
nulls everywhere (locked/ssh/agent session — you must be at your own unlocked
console).

**Two open defects that can contaminate a live capture.** If either appears during
Phase 2, note it in that step's transcript; if it perturbs what you are trying to
observe, **stop, tear down, restart per #70, and redo the run** rather than saving
a polluted artifact:

- **#48 — visibility publish HTTP 409 loop.** Occurs even in healthy runs. Not a
  gate failure by itself, but a 409 storm in the middle of an observation makes
  the artifact unreadable.
- **#52 — teardown leaves the Workspace GUI running.** Relevant at the Phase-2
  teardown: if the pane-close step leaves a GUI window behind, that is **#52**
  manifesting, not the Gate 9 close-probe failing. Record which you saw.

**Two things that are not commands:** `hive build` and `hive run` **do not exist**
— they are unknown arguments that exit non-zero under a help dump and start
nothing. `build` and `run` are *Makefile* targets. And `log` is a zsh builtin
here: always spell the system log tool **`/usr/bin/log`**. The app's own NSLog
text is redacted to `<private>` in the unified log, so never build a pass/fail on
reading app log strings — judge from the **screen**, the **transcript**, and the
**on-disk artifacts**.

---

## Order — why the steps run in this sequence

You change the physical world as few times as possible:

- **Second display in** at the start, out at the end of Phase 3. One plug event.
- **One production stack** (`make run` + one spawned agent pane) hosts all of
  Phase 2. Bringing it up is the expensive part; it is never torn down mid-batch.
- **VoiceOver on late.** VO intercepts the keyboard and makes the typing-heavy work
  (#45, G-live, Gate 9 probes) miserable, so VO goes on **once**, for the B2.6
  step, and the teardown probe runs while it is on.
- **Sleep/wake is last** because it destroys every other setup state.

Phases: **1** Gate 7 dual-display → **2** the production-pane batch (#45 → G-live →
Gate 9 → B2.6 → teardown) → **3** Gate 7 sleep/wake → tell queen.

Do not plan this around a hard stop: build time and several step durations are
genuinely unmeasured, and inventing numbers would be worse than saying so. Start
`make build` well ahead and sit without a deadline.

---

## Phase 1 — Gate 7 / row I, dual-display Retina ↔ non-Retina

No live pane needed. This is a pure XCTest, so it goes first and validates your
display setup before you invest in the stack. This covers the dual-display half of
#36 **row I** (content scale / display id / drawable size on monitor moves,
Retina↔non-Retina).

**Step 1.1 — capture the display inventory**

```sh
system_profiler SPDisplaysDataType \
  > /Users/scottkellar/Projects/hive/raw/qualification/ghostty-b1-gate7-physical/human-dual-display-inventory.txt
```

- **Record verbatim — PASS if:** both displays show `Online`, `Mirror: Off`, and
  their scales differ (Retina ~2.x vs non-Retina 1.x).
- **FAIL if:** one display missing, mirroring on, or both the same scale.
- **On FAIL:** fix the arrangement in System Settings → Displays and re-capture;
  the test asserts on this, so a bad inventory will only fail Step 1.2 too.

**Step 1.2 — run the opt-in physical test (do NOT background it)**

```sh
cd /Users/scottkellar/Projects/hive/workspace
HIVE_GHOSTTY_GATE7_PHYSICAL=1 \
  swift test --filter Gate7RenderingTests/testPhysicalMonitorScaleAndSleepWakeQualification \
  2>&1 | tee /Users/scottkellar/Projects/hive/raw/qualification/ghostty-b1-gate7-physical/human-dual-display-transcript.txt
echo "EXIT=${pipestatus[1]}" \
  | tee -a /Users/scottkellar/Projects/hive/raw/qualification/ghostty-b1-gate7-physical/human-dual-display-transcript.txt
```

`HIVE_GHOSTTY_GATE7_PHYSICAL_SLEEP` is **omitted** — sleep is Phase 3. The
two-line form matters: `tee` reports the *pager's* exit status, so a plain pipe
hides a red suite; `${pipestatus[1]}` (zsh, 1-based) recovers the real one into
the transcript.

**Step 1.3 — do the drag.** When the test prints
`GATE7 PHYSICAL: drag the qualification window to the other-scale display`, drag
the titled window **fully** onto the other display **within 120 s**.

- **Record verbatim — PASS if:** the test continues on its own; the transcript ends
  with `test passed` and `EXIT=0` (display id *and* content scale both changed).
- **FAIL if:** the 120 s window lapses (times out), or the scale never changes
  because the window was only partly moved.
- **On FAIL:** note whether you dragged it *entirely* onto the other screen; a
  partial move is the usual cause. Record the result either way and continue.
- **Beware:** the trailing banner can say "0 tests" while XCTest actually ran the
  case. Judge from the body and `EXIT=`, not the tail line.

**Artifacts:** `human-dual-display-inventory.txt` and
`human-dual-display-transcript.txt`, both in
`raw/qualification/ghostty-b1-gate7-physical/`, tracked (`.txt`, never `.log`).
Each replaces a `STATUS=PENDING_HUMAN` placeholder already in that directory.

---

## Phase 2 — the production-pane batch

Bring up the production pane now, per **"How you drive the production pane"**
above: `make run`, then spawn one agent from the queen pane. Every step below runs
against that **agent** pane. Do not tear it down until Step 2e.

### Step 2a — #45 re-check: live resize-and-type, WITH capture

This is the re-check the #45 acceptance record
(`planning/2026-07-20-45-acceptance-record.md`, §4) mandates: the earlier
acceptance **waived the byte capture**, and this run produces the recorded
artifact that was waived — on the **production Workspace pane (B2 path),
explicitly NOT `make terminal`**. Do this **first**, on a clean pane, before any
Gate 9 probe has perturbed it.

Context that dictates the method: the original written repro came back NON-REPRO
because input was **already dead before the resize** — resize was the observation,
not the cause. So you must **prove input is alive before you resize.**

**Start your screen recording now** (⇧⌘5 → Record, or QuickTime → New Screen
Recording). Keep it running through all four sub-steps.

1. Click into the **agent** pane. Type a visible line into its live input — e.g.
   `hello from the pre-resize input line` — and watch each character appear. **Do
   not submit it.**
   - **See:** every character you type appears on the pane's input line. This is
     the precondition. If characters never appear, input was dead on arrival —
     record that and stop this step (it is a real finding).
2. Resize the Workspace window — drag a corner, materially changing **both** width
   and height (a few columns is not a test; make it obvious).
   - **See:** the pane reflows; text rewraps to the new column count.
3. Without clicking anywhere else, continue typing more characters onto the same
   input line.
   - **See:** the earlier text survived the resize **and** the new characters
     appear. **This is the pass.**
4. Resize once more, in the other direction, and type a third fragment.

- **Record verbatim — PASS if:** characters typed before the resize survived it,
  and characters typed after each resize appeared, with the pane reflowing at each
  resize.
- **FAIL if:** typed characters stop appearing after a resize while they appeared
  before it — that is the real defect, and the finding worth having.
- **On FAIL:** keep the recording, note the exact window dimensions before/after
  and which resize broke it, and continue.
- **Beware:** if the pane area ever drops below 40×40 pt the child is never spawned
  and the pane goes silently blank. Do not shrink that far.

**Artifacts** (create the directory if needed — the earlier `make terminal` runs
already wrote `run1-*`/`run2-*` here; yours are the production follow-up):

```sh
mkdir -p /Users/scottkellar/Projects/hive/raw/45-human-acceptance
```

- `raw/45-human-acceptance/human-production-resize-input.mov` — the screen
  recording. **Tracked, not gitignored** (this capture is the whole point of the
  re-check; last time it was waived).
- `raw/45-human-acceptance/human-production-resize-input.txt` — an operator
  transcript: what you typed, what appeared, the before/after window dimensions,
  and the **session id** of the agent pane (visible in the pane header / queen
  status) so the run is identifiable.

### Step 2b — G-live: live IME composition

Source definition (#36, matrix cell **G-live**): real CJK / dead-key / emoji / RTL
composition exercised through an **actual OS input method** — not a synthetic
NSEvent standing in for one. This is the live/interactive proof, done on the same
production agent pane.

Focus the **agent** pane, then compose one of each through a real input source and
watch the pane:

1. Switch to your **CJK** input method (input menu / Ctrl-Space). Type a syllable
   (e.g. pinyin `ni hao`); confirm the **candidate window appears at the cursor**,
   pick a candidate, and confirm the committed Han characters render in the pane.
2. Switch to **ABC – Extended**; type a **dead-key** accent (e.g. Option-e then e
   → `é`); confirm it renders as one composed character.
3. Open the **emoji picker** (Cmd-Ctrl-Space), insert an emoji; confirm it renders.
4. Switch to an **RTL** source (Hebrew/Arabic); type a few characters; confirm they
   render right-to-left in the pane.

- **Record verbatim — PASS if:** CJK, dead-key, emoji, and RTL composition each
  reach the pane and render correctly, with the IME candidate window positioned at
  the cursor.
- **FAIL if:** composition never reaches the pane, the candidate window is
  mispositioned, or characters render as boxes / mojibake attributable to the pane.
- **On FAIL:** record which of the four failed and how (mispositioned candidate vs
  wrong glyph vs nothing), and continue.

**Artifacts:**

```sh
mkdir -p /Users/scottkellar/Projects/hive/raw/qualification/hive-b1-glive-ime
```

- `raw/qualification/hive-b1-glive-ime/human-ime-composition-transcript.txt`
  (tracked): the input source used for each, exactly what you typed, and exactly
  what rendered. If you screen-record, cite the path in this file.

### Step 2c — Gate 9: the ten-probe manual security acceptance (probes 1–9)

Source: `raw/qualification/ghostty-b1-actions/manual-acceptance.md` (verified
path). Its purpose is the **subjective** halves the automated matrix cannot assert
— "Hive's own UI responded appropriately." Probe **#10 is deferred to Step 2e** —
it destroys the pane.

**How to inject each probe on the production path.** Ask the agent (the one whose
pane you are watching) to run each command **writing to its controlling terminal**:

```
printf '<sequence>' > /dev/tty
```

The `> /dev/tty` is required — it emits the raw bytes into the pane's PTY through
the real production output path. You then observe the **host** (window chrome,
notifications, clipboard, browser). Run probes 1–9 now.

| # | Ask the agent to run | Record verbatim — PASS | FAIL |
|---|---|---|---|
| 1 | `printf '\033]0;SPOOFED-TITLE\007' > /dev/tty` | Pane/tab **title** changes to SPOOFED-TITLE — Hive-attributed UI only | App/window chrome *beyond* the pane title changes, **or** nothing updates at all (event path dead) |
| 2 | `printf '\a' > /dev/tty` | **No macOS notification banner and no system alert sound** — the bell stays inside Hive as a per-pane effect (at most Hive's own pane attention indicator) | A macOS notification banner appears, **or** the system alert sound plays (the bell escaped to the OS) |
| 3 | `printf '\033]9;you have been pwned\007' > /dev/tty` | **Nothing** — no notification banner; terminal keeps working | Any banner posted |
| 4 | `printf '\033]777;notify;t;b\007' > /dev/tty` | Same as #3 | Same as #3 |
| 5 | `printf '\033]52;c;aGVsbG8=\007' > /dev/tty` then Cmd-V in TextEdit | Your **baseline clipboard string** pastes — pasteboard unchanged | `hello` pastes — terminal bytes wrote your clipboard |
| 6 | `printf '\033]52;c;?\007' > /dev/tty` | No reply garbage in the stream; nothing arrives back at the agent | A base64 blob appears back at the agent — clipboard exfiltrated |
| 7 | `printf '\033]8;;https://example.com\007CLICK ME\033]8;;\007' > /dev/tty` then **click** and **Cmd-click** the text | No browser opens, ever | A browser opens |
| 8 | Press **⌘N, ⌘T, ⌘W** (plain, no Shift) with the pane focused | **No Ghostty-native window/tab/split appears for any of the three.** Hive binds **none** of plain ⌘N/⌘T/⌘W, so each reaches the terminal as input — watch the keystroke land in the pane | A Ghostty-native window/tab/split appears |
| 9 | `read -s` in the agent's shell, then type a password and Return | No secure-input flip caused by the **pane**; menu-bar padlock unchanged; Hive is not the secure-input owner | Secure input engages system-wide from agent output |

**Bounded pass notes for the four probes whose old wording was open-ended:**

- **#2 (bell).** The old "or nothing if Hive ships a bell indicator" is now bounded
  on the observable: `RING_BELL` is handled as a **per-pane event** and
  `DESKTOP_NOTIFICATION` is **denied by policy**, so the pass is the *absence of
  any OS-level alert* — no banner, no system beep. Any OS-level alert is the fail,
  whether or not Hive also draws its own indicator.
- **#8 (⌘N/⌘T/⌘W).** Verified against `MainMenuBuilder.swift`: the **only**
  pane-close binding is **⇧⌘W** (Close Pane). Plain **⌘N, ⌘T, ⌘W are bound to
  nothing**, so the bounded pass is "no native window/tab/split appears **and** the
  key reaches the terminal as input." **Do not press ⇧⌘W during this probe** — that
  closes the pane by design and is Step 2e's job.

Probe **#5** is the one to set up carefully — a distinctive baseline string on the
clipboard *before* you run it, or you cannot tell "unchanged" from "changed to
something similar." **On any FAIL:** record the probe number, the exact command,
and exactly what you saw, then continue. Note #53 (OSC 52 pasteboard flake) is a
known flake **in the automated instrument**, not this claim; if probe #5 or #6
behaves ambiguously, repeat it rather than recording an ambiguous result.

**Artifact:** `raw/qualification/ghostty-b1-actions/human-manual-acceptance-transcript.txt`
(tracked). One line per probe: number, exactly what was run, exactly what you
observed, PASS/FAIL. Record the agent's session id. There is **no
`evidence-sha256.txt`** in this directory, so no re-seal here.

### Step 2d — row J / B2.6: Accessibility Inspector, then VoiceOver

Source: `raw/qualification/hive-b26-gate10-accessibility/human-checklist.txt`. The
machine slice (`4db42977`) proved the AX tree is structurally sound; it **cannot**
prove what a screen reader announces. That is #36 **row J**, and it is what you
supply here.

Optional re-confirm of the machine prereq (already green; only re-proves the dumps
you compare against):

```sh
cd /Users/scottkellar/Projects/hive/workspace
HIVE_B26_AX_EVIDENCE=../raw/qualification/hive-b26-gate10-accessibility \
  swift test --filter Gate10AccessibilityTests
```

**Part A — Accessibility Inspector (VoiceOver still OFF).** Inspector needs no VO,
and doing it first keeps the keyboard yours a little longer.

1. Open Accessibility Inspector; target the **terminal content area** of the live
   agent pane.
2. Run **Inspector → Audit** on the terminal element.

- **Record verbatim — PASS if (bounded against `ax-tree-input.txt`):** role is
  exactly **`AXTextArea`**; the number of `staticText` **row children equals the
  pane's visible row count** (the recorded input fixture has `geometryRows=26` and
  `childCount=26`); children are labelled **`Terminal row 1 … N` in unbroken
  sequence**; non-empty rows carry their text as `value` and empty rows read
  `(blank)`; **no duplicate or extra row child** survives a scroll or resize; and
  the audit reports **no broken parent/child** for the terminal subtree.
- **FAIL if:** wrong role; child count ≠ visible rows; a gap or duplicate in the
  `Terminal row N` sequence; or the audit names `HiveTerminalView` or a row element
  in a finding.
- **On FAIL:** paste the full text of any finding that names `HiveTerminalView` or
  a row element, and the audit's pass/fail counts, then continue.

**Artifact:** `raw/qualification/hive-b26-gate10-accessibility/human-inspector-audit-transcript.txt`
(tracked), replacing the `PENDING_HUMAN` placeholder. **Include the audit's
pass/fail counts.**

**Part B — VoiceOver on (Cmd-F5).** From here the keyboard belongs to VO. Work
through all eight, ticking the scenario boxes in §C of the checklist as you cover
them:

1. Focus the live pane. Navigate **by row** (VO-Down/Up) through several rows. → `input`
2. Locate the **cursor / insertion point** announcement.
3. Type a short line into the agent input; confirm it is announced or readable. → `input`
4. **Select** text (Shift-arrows or drag); confirm the selection is spoken.
5. **Scroll** scrollback; confirm row focus survives without a full-tree wipe. → `scroll`
6. Trigger an **alternate-screen** app (have the agent run `less` on a long file),
   then exit it. → `alternate screen`
7. **Resize** the window with VO on; confirm rows are re-announced coherently. → `resize`
8. **Force the mark-lost / reconnect path** and confirm the lifecycle label is
   spoken. → `replay / reconnect`

**Bounded pass for step 8 (the old "if available" is now concrete).** The path
**is** forcible: **end the pane's underlying session without closing the pane** —
in the agent pane have the agent `exit` the process running there, or from a
separate Terminal kill that session's sessiond host pid.

- **Record verbatim — PASS if:** the pane's lifecycle label transitions to
  **`Terminal lost: <evidence>`** or **`Terminal exited: <evidence>`** and
  VoiceOver **speaks it** (VO may first say `Terminal reconnecting`), or it is
  readable in the Inspector's `lifecycle`/`label` field.
- **FAIL if:** the session ends but **no** lifecycle label change is spoken or
  inspectable (silent loss).
- **If you genuinely cannot end the session without also closing the pane:** record
  the box as **`waived — not forcible on this build, reason: …`**, never blank. A
  blank box reads as untested.

- **Record verbatim — Part B PASS if:** rows, cursor, selection, typed input, and
  lifecycle are all reachable by VO.
- **FAIL if:** any of those is silent or unreachable, or scrolling wipes and
  rebuilds the whole tree instead of moving focus.
- **On FAIL:** quote exactly what VO said (or the silence), per step.

**Artifact:** `raw/qualification/hive-b26-gate10-accessibility/human-voiceover-transcript.txt`
(tracked), replacing the `PENDING_HUMAN` placeholder — what you did and what VO
**said**, step by step. Quote the speech; that is the evidentiary value. If you
screen-and-audio record, cite the path in the file.

### Step 2e — combined teardown: Gate 9 probe #10 **and** B2.6 `teardown`

One action, two gates. Keep VoiceOver **on** so you can check for zombie AX focus.

1. In the agent pane, have the agent run `yes` so it is spewing output.
2. **Close the pane** while it is still spewing (the pane's X button, or ⇧⌘W).

- **Record verbatim — Gate 9 #10 PASS if:** the pane closes cleanly — no crash, no
  hang, no orphan window (the delivery-after-free class).
- **Record verbatim — B2.6 `teardown` PASS if:** VO reports **no hanging AX focus
  on destroyed rows** — no zombie focused element.
- **FAIL if:** a crash or hang, an orphaned window, or VO still announcing rows that
  no longer exist.
- **Contamination check:** if the Workspace **GUI window survives** the teardown,
  that is **#52**, a known separate defect — record it as **PASS-with-#52-noted**
  in both transcripts rather than a false FAIL, and say explicitly which you saw.

Record the result in **both** `human-manual-acceptance-transcript.txt` (as probe
#10) and `human-voiceover-transcript.txt` (as the `teardown` scenario). Then turn
**VoiceOver off** (Cmd-F5).

---

## Phase 3 — Gate 7 / row I, sleep / wake

Last, because it disrupts everything. Second display still plugged in. This
completes the sleep/wake half of #36 **row I**.

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
prompted, then on `GATE7 PHYSICAL: sleep and wake the Mac now` put the Mac to sleep
(Apple menu → Sleep; prefer full system sleep), wait **≥5 s**, wake, and unlock if
prompted.

- **Record verbatim — PASS if:** `wakeTransitionCount` advanced, applied occlusion
  is visible after wake, no crash and no hung draw path, `EXIT=0`.
- **FAIL if:** the 600 s wake wait lapses (the machine never actually slept — check
  power settings), or occlusion never re-applies as visible.
- **On FAIL:** note whether the Mac visibly slept, and record the result.

**Artifact:** `raw/qualification/ghostty-b1-gate7-physical/human-sleep-wake-transcript.txt`
(tracked), replacing its `PENDING_HUMAN` placeholder.

**Optional Instruments block — only if queen asked for it.** Time Profiler +
Allocations + Activity Monitor against the running xctest process during the drag,
while minimized, and after wake. **Do not use Power Profiler** — it is
iOS/iPadOS-only and is already a recorded negative control. Export as
`instruments-human-*.txt` beside the transcripts.

You may now unplug the second display.

---

## When done — tell queen (you run no `git`)

Send queen one message with:

1. **Which steps passed and which failed** — Gate 7 dual-display, #45 re-check,
   G-live, Gate 9 probes 1–9, Gate 9 #10, B2.6 Inspector, B2.6 VoiceOver, Gate 7
   sleep/wake. A failed cell is a finding; report it plainly.
2. **Where you saved anything unexpected** — any recording paths, any `waived`
   boxes and their reasons, any #48/#52 contamination you noted.

Queen handles the rest: re-sealing the two `evidence-sha256.txt` manifests
(`ghostty-b1-gate7-physical/` and `hive-b26-gate10-accessibility/`), landing the
evidence, updating the board, and checking off the #45 and #36 rows — each with a
repo-relative artifact path, per #45's rule that an unpointed check is treated as
unchecked. You do not run any git yourself.

**File-format rule for everything you saved: `.txt` (never `.log`) for
transcripts; the `.mov` capture is tracked, not gitignored.**

---

## Reference — what this sitting does NOT close (do not chase these)

- **Row K — the three vendor TUIs (Claude, Codex, Grok) through the production
  pane.** Per #36's 2026-07-20 ownership split this is **queen's agent campaign**,
  scheduled when B2.5's production-wiring pane lands and the Codex quota window
  opens (2026-07-26). Not a human gate; nothing for you here.
- **A4 faithful app-quit — BLOCKED.** It needs an observer harness that watches a
  production quit (`final.json` with `state: "terminated"`, `survivors: []`) while
  never touching the broker, and it rides on B2.5's production-wiring pane, which is
  OPEN. Do not attempt it this sitting; it would only add a failed attempt.
- **C1.5 aesthetic signoff** (depends on C1.3/C1.4, closes after the integrated
  pane — the true last gate of M1), **Gate 7's Instruments minimized/after-wake and
  ASan OPEN rows**, **Gate 4 notarization** (blocked on Apple notary creds), and
  **B2.5 row K** (vendor matrix, agent work).
- **The three "clean-machine" gates are not yours.** STORY-001 DoD-2 (tmux absence,
  agent-doable) and B2 DoD-7 (different-vendor reproduction, agent-doable) are agent
  work; C2 acceptance (Gatekeeper, notarization, two architectures) is genuinely
  user-only but **post-cut** — a separate future session that will need hardware
  this one does not. **Bring no second machine to this sitting.**

## See also

- `planning/2026-07-20-45-acceptance-record.md` — the #45 waiver and re-check
  mandate this sitting discharges
- `docs/workspace/seeing-a-live-terminal.md` — the authority on `make build` /
  `make run` and the production pane
- `raw/qualification/ghostty-b1-actions/manual-acceptance.md` — Gate 9 source
- `raw/qualification/hive-b26-gate10-accessibility/human-checklist.txt` — row J / B2.6 source
- `raw/qualification/ghostty-b1-gate7-physical/human-checklist.txt` — Gate 7 / row I source
- `planning/2026-07-20-operator-kill-defect.md` — the #70 defect the precondition gates on

# M1-B1 Gate 7 physical slice — cross-vendor review (hester, Claude/Opus 4.8)

Reviewing: hilda (Grok), pin `3b849cbfdb1ee23a8bc43148cbd75ed534b29142` on
`hive/hilda-m1-item-2-hard-gate-7-physical`. Ghostty pin `73534c46`.

Pin materialized detached at `/Users/scottkellar/g7pin`. Runner re-run by this
reviewer on an unlocked GUI session with the real exit code captured (no
piping — a piped run reports the pager's status).

**VERDICT: NO-LAND** — fix F1, F2, F4 first. The substance is sound and every
load-bearing claim I could measure survived independent measurement; the
defects are in *attributability of the record*, which is what this review is
for. The branch is independently on HOLD for the three human rows regardless.

---

## 1. Independent reproduction — PASS

```
REAL_EXIT=0
corpus-gate7.txt: Executed 16 tests, with 1 test skipped and 0 failures
instruments: Time Profiler / Allocations / Activity Monitor / Leaks — exit_status=0 (all four)
human slots: all three still STATUS=PENDING_HUMAN (runner says so on stdout)
```

16 exec / 1 skip / 0 fail reproduces exactly. The skipped test is
`testPhysicalMonitorScaleAndSleepWakeQualification` — correctly skipped rather
than hanging for a human drag, because the runner deliberately does not set
`HIVE_GHOSTTY_GATE7_PHYSICAL`.

## 2. Artifact binding — PASS, and it closes the prior Gate 3 gap

`validate_artifact_binding` compares 16 `artifact-manifest.json` fields against
`native/toolchain-lock.json` **and** the actual sha256 of the linked
`macos-arm64_x86_64/libghostty-internal.a` against its manifest record.

Critically, three binding controls run on *every* invocation and the runner
hard-exits 1 if any of them **fails to bite**:
`missing-manifest`, `tampered-patched-tree`, `swapped-library`.

This is the exact hole that took a prior Gate 3 NO-LAND — an artifact-selection
step that accepted any binary, making every green claim unattributable. It is
closed here: the binary under test is provably the pinned one, and the proof
is self-controlling.

## 3. Main-thread admission (Gate 3 row E) — PASS on substance, see F3

I mutation-tested the assertion rather than trusting the green run. Mutating
`main.swift:242` to demand a layer class that cannot exist:

```
MUTANT_REAL_EXIT=1
{"error":"admission missing IOSurfaceLayer (got IOSurfaceLayer)","stage":"failed"}
```

The assertion **bites**, and the observed value is really `IOSurfaceLayer` — a
live Ghostty IOSurface-backed layer, not a seam and not a fabricated
`CAMetalLayer`. `assert_protocol` also greps for `"stage":"failed"`, so the
runner would fail closed on it.

The main-thread half is genuine but for a reason the evidence does not state:
production `ManualSurface.swift` arms `dispatchPrecondition(.onQueue(.main))`
on ~15 wrapper entry points plus `precondition(Thread.isMainThread, "Ghostty
surface wrappers must be created on the main thread")` at creation
(`ManualSurface.swift:428`). The probe drives a real surface through
create/present/free with those preconditions armed — that is the actual proof.
See F3 for why the recorded artifact doesn't say so.

## 4. Honesty claims — each verified independently

**Power Profiler iOS-only — claim is TRUE.** I re-ran it myself:

```
PP_REAL_EXIT=2
* [Error] The Power Profiler instrument is not supported on macOS. Record on iOS or iPadOS instead.
```

Exact error text as quoted in the prose. The Activity Monitor substitution is
labelled honestly in `instruments-power-energy-summary.txt` (`template=Activity
Monitor`) and is *not* silently relabelled as Power Profiler. But see F1 — the
failure is never captured as an artifact.

**Occlusion attempted-not-proven — honest.** The claim appears in the machine
evidence itself, not only the prose:
`occlusion-window-ordering.txt` carries `windowOrderingAttempted:true`,
`windowOcclusionStateVisibleWhileCovered:true`, and the note "AppKit did not
flip occlusion under ordering on this desktop". The cited fallback is real:
`Gate7RenderingTests.swift:247
testOcclusionSuppressesDrawAndPresentsOnePendingFrameWhenVisible`.

**GPU/device-fault scope — honest.** `gpu-device-fault-scope.txt` says exactly
what the summaries claim: `HOST_CONTRACT = GREEN`,
`HARDWARE_FAULT_OR_B2_REPLACEMENT = OPEN`, with the reason (IOSurfaceLayer, no
device-recreation API, no checkpoint-export API on a dying surface). The file
explicitly refuses to mark the hardware row green, and the OPEN state is
carried into the retained-items table — not silently dropped.

## 5. Churn hazards — PASS

`main.swift:435-457` is a strict serial `for` loop: each surface is created,
fed, waited on, and `close()`d before the next begins. No `DispatchQueue`
concurrency anywhere in the churn path, so the process-global backend slot is
never raced (that race can null the surface). Teardown is `view.userClose()`
then `Darwin.exit(0)` — no SIGKILL anywhere in probe or runner, so no GPU
resource leak. `concurrentCreation:false` / `sigkillUsed:false` in the record
match the source.

## 6. Evidence hygiene — PASS

Verified from a **pristine `git archive` of the pin**, not from my mutated
working tree:

```
21 of 21 committed files: OK   (shasum -c, exit 0)
```

- manifest excludes itself (`! -name evidence-sha256.txt`) and excludes
  `*.trace` and `*/instruments-*.trace/*` — so a fresh checkout verifies, which
  is the failure mode where a gitignored file listed in its own manifest breaks
  verification.
- `.trace` packages gitignored; their `trace_listing_sha256` lives inside each
  `instruments-*-summary.txt`, so the binary captures are still pinned.
- all evidence is `.txt`/`.jsonl`; no `.log`.

## 7. Human checklist — mostly executable, see F2

Sections A and B are genuinely executable by a non-engineer: exact commands,
exact prompt strings to wait for, explicit accept criteria (both displays
Online, Mirror: Off, differing scale), explicit capture slot per step, and a
"what you do NOT need to invent" section that names the two hazards. Each slot
states what the capture proves. Section C is the problem — see F2.

---

## Findings

### F1 — the Power Profiler "measured" claim is prose-only (fix before land)

`ghostty-gate7-physical-live-proof.md` says the failure was "measured on this
host", but the runner **never attempts Power Profiler**. It goes straight to
Activity Monitor with a source comment. The only record is a hand-written
`printf` in `provenance.txt:20` and the prose. Nothing in the evidence package
carries the command, its exit code, or its stderr.

The claim is true — I measured it — but a hand-typed sentence is not evidence,
and this package's whole thesis is that claims are attributable to captures.

*Fix:* have the runner actually attempt `--template 'Power Profiler'` once and
record its real exit status and stderr into
`instruments-power-energy-summary.txt` as a measured negative control, then
proceed with Activity Monitor. That turns the substitution into a proven
forced choice instead of an assertion.

### F2 — human-checklist section C tells the operator to use Power Profiler

`human-checklist.txt:70` instructs: "Start Instruments (Time Profiler +
Allocations + **Power Profiler**) …". That directly contradicts F1's finding
that Power Profiler is macOS-unsupported. A non-engineer following section C
hits the same iOS-only error with no guidance. The step is not executable as
written.

*Fix:* name Activity Monitor, matching the automated pass.

### F3 — `main-thread-admission.txt` records constants, not observations

`main.swift:258` emits `"layerClass": "IOSurfaceLayer"` as a **hardcoded string
literal**, not the observed `renderEvidence.layerClass`. And
`createOnMain` / `presentObservedOnMain` / `freeOnMain` are assigned *inside*
`onMain { … }`, which dispatches to main — so all three are tautologies that
can never read false, and the `check(...)` guarding each can never fail.

The underlying facts are real (§3 above proves both halves). But the artifact
a future reviewer reads cannot distinguish "observed IOSurfaceLayer on main"
from "printed the string IOSurfaceLayer" — and this file is the sole named
evidence for the row E discharge on #7/#45.

*Fix:* emit the observed `renderEvidence.layerClass` value, and record that the
main-thread guarantee comes from production `dispatchPrecondition`/
`precondition` (cite `ManualSurface.swift:428` and the wrapper preconditions)
being armed during a live create/present/free — not from reading a boolean
back.

Related: `Gate7RenderingTests.swift:162
testRenderingStateUsesMainConfinedEngineWrappers` is misnamed — it asserts
content-scale / displayID / occlusion values reached the engine and asserts
nothing about threads. It should not be cited as main-confinement coverage.

### F4 — the retained-items rewrite silently narrows two prior requirements

The old retained list had four numbered items; the new tables carry item 1
(dual-display) and item 4 (GPU fault, correctly OPEN). Two were narrowed
without saying so:

- **old item 2** required Instruments Time Profiler/Energy "while idle, live
  resizing, minimized, **occluded, and after wake**". The new pass covers
  idle / resize / occlusion-attempt / churn. **Minimized** is never exercised
  and **after wake** is never captured — neither gets an OPEN row or a human
  slot, and checklist section C demotes human-path Instruments to "Optional:
  … if queen asks".
- **old item 3** required "Allocations/**Address Sanitizer** evidence". ASan is
  absent with no note; only Allocations and Leaks are present.

A requirement that gets quietly downgraded to optional, or dropped, is the
failure mode this review exists to catch — the same class as the GPU row,
which was handled correctly by being marked OPEN.

*Fix:* restore both as explicit rows — either OPEN with a named slot, or
explicitly waived by queen with the reason recorded. Do not leave them
implicit.

### F5 — artifact fallback assumes worktree depth (minor)

`qualify-ghostty-gate7-physical.sh:46-50` probes
`$ROOT/../../.cache/native` and `$ROOT/../../../.cache/native`, which encode
the `.hive/worktrees/<agent>/` depth. From a detached worktree elsewhere on
disk none of the candidates hit and the run dies on "GhosttyKit artifact
missing"; I had to pass `HIVE_NATIVE_CACHE`. Not a correctness risk — binding
fails closed either way — but worth a usage note for the next reviewer.

### F6 — `completed: 20` is weaker than it reads (minor)

`churnCompleted += 1` (`main.swift:456`) is unconditional and the
`waitUntil(...)` result is discarded with `_ =`. So `completed:20` means 20
create/free cycles ran to teardown, not 20 that drew. It is not false — a
failed create throws into `fail(...)` — just less than the name suggests.

---

## Summary

| Review focus | Result |
|---|---|
| (1) runner reproduces, real exit codes | PASS — `REAL_EXIT=0`, 16/1/0, 4× Instruments exit 0 |
| (2) main-thread admission binds to a real IOSurfaceLayer, not a seam | PASS on substance (mutation-proved); artifact wording weak — **F3** |
| (2) artifact-selection positive control | PASS — three controls bite, runner hard-exits if they don't |
| (3) Power Profiler measured-fail | claim TRUE (re-measured); not captured — **F1** |
| (3) occlusion attempted-not-proven | PASS — honest in machine evidence, corpus reference real |
| (3) GPU/device-fault scope + OPEN recorded | PASS |
| (4) serial churn, no concurrency, no SIGKILL | PASS |
| (5) human checklist executable, slots state what they prove | PASS for A/B; **F2** in section C |
| (6) evidence hygiene, verify from HEAD | PASS — 21/21 from pristine archive |

F1, F2 and F4 are cheap fixes that do not require re-running the physical pass
(F1 adds one recorded command). Once they land, and the three human rows are
filled or explicitly waived, I see no obstacle to this package.

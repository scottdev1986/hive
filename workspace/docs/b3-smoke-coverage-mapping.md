# B3 smoke — legacy coverage mapping (removal-gate citation table)

Status: the replacement smoke is landed and green. This document is what the
STORY-001/STORY-002 atomic cut cites when it deletes the tmux/SwiftTerm smoke.

The legacy harness is two halves:

- `workspace/scripts/smoke.sh` — outer harness (tmux setup, post-mortem)
- `workspace/Sources/HiveWorkspace/SmokeRunner.swift` — in-process half

The replacement is also two halves, deliberately mirroring that split because
the most valuable legacy checks are the ones made from OUTSIDE the app:

- `scripts/b3-smoke.sh` — driver, stack lifecycle, post-mortem
- `workspace/Tests/HiveTerminalKitTests/B3SmokeTests.swift` — in-process

**Not wired to CI.** The legacy smoke is invoked by hand; it appears in no
Makefile target, no `package.json` script, and no workflow. Deleting it
therefore breaks no build — which is exactly why this table, not a red
pipeline, is the removal gate's evidence.

## Completeness — derived, not asserted

All 81 legacy checks are classified below. That is a DERIVED claim, not an
assertion: extract every `SMOKE-<n>` from this document with ranges
(`SMOKE-22..30`) and comma-lists (`SMOKE-09, 18, 19`) expanded, then diff the
set against 1..81. Re-derive it with:

```
/usr/bin/python3 - <<'EOF'
import re
lines=open('workspace/docs/b3-smoke-coverage-mapping.md').read().split('\n')
ids=set()
for ln in lines:
    st=ln.strip()
    # Only a classification TABLE ROW or a GAP bullet counts. A bare prose
    # mention must NOT satisfy this, or an id named only in the "these were
    # missing" note below would count as classified and the check could never
    # fail.
    if not (st.startswith('|') or st.startswith('- **GAP-')): continue
    for m in re.finditer(r'SMOKE-(\d+)((?:\s*(?:\.\.|,|and|&)\s*\d+)*)', ln):
        start=int(m.group(1)); ids.add(start); tail=m.group(2) or ''
        rng=re.match(r'\s*\.\.\s*(\d+)', tail)
        if rng:
            for i in range(start,int(rng.group(1))+1): ids.add(i)
        for n in re.findall(r'(\d+)', tail): ids.add(int(n))
print(len(ids), sorted(set(range(1,82))-ids))
EOF
```

Expected: `81 []`.

Note the row-scoping in that script. An earlier version of this derivation
counted any `SMOKE-NN` anywhere in the file, which meant the "SMOKE-06, 70 and
72 were missing" sentence below would itself have satisfied the check — a
derivation that cannot fail is no better than the asserted count it replaced.
It now counts only ids inside a classification row or a GAP bullet.

An earlier revision of this document claimed all 81 were classified while
actually classifying 78 — SMOKE-06, 70 and 72 were missing. That claim was
asserted rather than derived, and cross-vendor review caught it. Hence the
runnable derivation above: a count nobody can re-run is a claim, not a fact.

## Numbering basis — how to audit this table

**The `SMOKE-NN` ids are ORIGINAL to this document.** They do not appear
anywhere in the legacy source. Nothing in `SmokeRunner.swift` or `smoke.sh`
carries them, and they are NOT `check(` call order — so they cannot be
reconstructed by reading the current files, which is what makes stating the
basis mandatory rather than tidy.

**What enumerates 1..81.** The ids were assigned by a single inventory pass
over the two legacy files, in harness execution order: `smoke.sh` preconditions
first (1-6), then `SmokeRunner.run()`'s in-process checks in source order
(7-21), pane-menu lifecycle (22-37), input round trip (38-39), focus and
active-pane indicator (40-51), pane close lifecycle (52-59), `smoke.sh`
post-mortem after the app exits (60-65), and finally the separate opt-in
sessiond mode `runSessiondLiveResizeInputProof` (66-81), which `smoke.sh`
never reaches.

**Pinned to exact blobs, not to a commit.** Line numbers below are valid at
these blob SHAs, which are immutable and content-addressed:

```
59882aa795eeabf6a6636d56087c3a046428b98c  workspace/Sources/HiveWorkspace/SmokeRunner.swift
faadf6a9dc3d13b45e445d9f29d9c6c7a52cee0f  workspace/scripts/smoke.sh
```

Materialize exactly what was inventoried:

```
git cat-file -p 59882aa795eeabf6a6636d56087c3a046428b98c   # SmokeRunner.swift
git cat-file -p faadf6a9dc3d13b45e445d9f29d9c6c7a52cee0f   # smoke.sh
```

**LINE NUMBERS DRIFT; LABEL STRINGS DO NOT.** `smoke.sh` is unchanged
(`faadf6a9` on both the inventory base and current main), so its citations hold
anywhere. `SmokeRunner.swift` has since moved to `8df0b4fd` on main, and the
line numbers in this table DO NOT hold against it — for example the two lines
cited for SMOKE-70 and SMOKE-72 land on a blank line and a closing brace
respectively at current main.

So audit by the `check(` LABEL STRING, not by line number. The labels are
stable across that shift (each appears exactly once in both blobs), and they
are what a reviewer can grep for in whatever version they happen to have:

```
git show main:workspace/Sources/HiveWorkspace/SmokeRunner.swift \
  | grep -n "pre-resize command produced new PTY output"
```

This drift is not hypothetical: the inventory base predates hector's
`d5750507`, which is why the blobs differ. Pinning the blob rather than a
branch is what keeps the table checkable after the file moves again.

## Verdict key

| Verdict | Meaning |
|---|---|
| REPLACED | Same intent, proven on the new spine. Safe to delete. |
| REHOMED | Real coverage, but not about the terminal. Belongs in a reducer/layout/menu test, NOT in this smoke. Safe to delete from the smoke ONLY once rehomed. |
| DROPPED | Artifact of the tmux/SwiftTerm substrate. Nothing to replace. |
| **GAP** | Genuine coverage with NO equivalent yet. Called out loudly rather than quietly lost. |

## 1. Terminal-substrate coverage — REPLACED

| Legacy | What it proved | New check |
|---|---|---|
| SMOKE-02 | build succeeds | driver runs `swift test`; a build failure fails the stage |
| SMOKE-11, 13 | terminal buffer eventually shows the session's real output | STAGE 3 render-ready — `semanticSnapshot().text` contains the marker |
| SMOKE-38 | typed bytes were interpreted by a real shell, not echoed by the renderer (split marker rejoined) | STAGE 3 — same split-marker technique, ported verbatim: types `B3SM''OKE<n>`, asserts the REJOINED `B3SMOKE<n>` |
| SMOKE-39, 65 (marker half only) | the round-trip marker is observable at all | STAGE 3 — `semanticSnapshot().text` contains the rejoined marker. **Only the marker half is replaced.** The other half of SMOKE-39/65 — reading it back from OUTSIDE the app, after the app is gone — is NOT replaced and is tracked as GAP-4. Do not cite this row for independent readback. |
| SMOKE-71 | input reached `written-to-terminal` | STAGE 4 input-applied — the same receipt, and the write boundary that makes STAGE 3 attributable |
| SMOKE-12, 56 | attach client liveness / dies on close | STAGE 4 (driver) — holders of the host socket, path read from `record.json`'s own `socketRelativePath` |
| SMOKE-61, 62 | **detach never kills** | STAGE 3 (driver) — no `final.json` after detach, and the session child PID is still alive |
| SMOKE-63 | session survives window close | same as above; the replacement has no window, so detach IS the close |
| SMOKE-64 | zero clients left attached | STAGE 4 (driver) |
| SMOKE-60 | smoke exit status is 0 | driver exits 0/1, unpiped, so the reported code is the real one |
| SMOKE-66, 68 | sessiond pane reaches a live surface | STAGE 2 attach — `.firstCorrectFrame` |

## 2. App-integration coverage — REHOMED to the opt-in GUI proof

These are real, but they are about the app, not the terminal substrate.
Folding them into a CI-ish smoke would put an unlocked GUI session on the
critical path of every run and make it flaky. Their home is the existing
`SmokeRunner` sessiond mode (`HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT=1`),
which is already tmux-free.

| Legacy | Now covered by |
|---|---|
| SMOKE-40, 67 | SmokeRunner sessiond mode — window becomes key |
| SMOKE-41, 45, 48, 50, 52, 59, 69 | SmokeRunner sessiond mode — real first responder |
| SMOKE-44 | SmokeRunner — real click delivery |
| SMOKE-70 | SmokeRunner sessiond mode — synthesized NSEvent keyDowns are constructible |
| SMOKE-72 | SmokeRunner sessiond mode — pre-resize command produced new PTY output (intent separately covered by STAGE 3) |
| SMOKE-73..81 | SmokeRunner sessiond mode — live resize, RESIZE frames, post-resize input |
| SMOKE-32, 35 | SmokeRunner — terminal child survives PTY resize |

## 3. Not terminal coverage at all — REHOMED (owner: whoever deletes them)

Roughly 34 legacy checks are about layout, menus, and window chrome. They
must not be reimplemented in a terminal smoke, and they must not be silently
lost either. They want plain XCTest against the reducer and layout solver,
with no PTY involved.

| Group | Legacy IDs |
|---|---|
| Window chrome | SMOKE-07 |
| Layout solver | SMOKE-09, 18, 19, 20, 21, 31, 34, 57 |
| AppKit menu plumbing | SMOKE-22..30, 33, 36, 37 |
| Focus-ring / indicator chrome | SMOKE-42, 43, 46, 47, 49, 51, 58 |
| Feed contract | SMOKE-03, 04, 10 |
| Reducer/view agreement | SMOKE-08, 54, 55 |
| Daemon kill boundary | SMOKE-53 |
| Private orchestrator boundary | SMOKE-06 — REHOMED rather than DROPPED because the assertion is "the app invokes the private `hive workspace-orchestrator` subcommand and nothing else", which outlives the substrate; only the *fixture's* response to it (`tmux attach-session` at `smoke.sh:69`) is tmux, and a fixture's mechanism does not decide the bucket. |

## 4. Substrate artifacts — DROPPED

| Legacy | Why nothing replaces it |
|---|---|
| SMOKE-01 | "tmux can start" — the new precondition is "the sessiond stack came up", which the driver checks |
| SMOKE-15, 16 | tmux copy-mode and `pane_in_mode` introspection; copy-mode is a tmux concept with no sessiond equivalent |
| SMOKE-17 | launch config supplied a tmux session |

## 5. GAPS — coverage with no equivalent yet

These are the entries the removal gate must weigh. Nothing below is covered
by the replacement smoke today.

- **GAP-1 — multi-pane / multi-session.** The legacy smoke ran THREE sessions
  (two agents + orchestrator) and asserted per-pane behavior (SMOKE-08, 11,
  13). The replacement drives ONE session. This is not an oversight: a human
  input claim is never released today (`claimRelease` exists at
  `FrameCodec.swift:23` but nothing sends it), so a multi-viewer smoke would
  burn sessions on any failure. **Blocked on hulda's claim-release fix**;
  worth adding immediately after.
- **GAP-2 — attach retry before the session exists.** Legacy SMOKE-05
  deliberately delayed one agent by 1s and required the app to RETRY rather
  than surface an error. The replacement attaches once to an
  already-created session and, by design, must never retry — same
  claim-release cause. **Blocked on the same fix.**
- **GAP-3 — mouse reporting forwarded from a pane.** Legacy SMOKE-14 proved a
  scroll wheel reaches the app as mouse reporting. The B2.3 matrix proves
  mouse ENCODING exhaustively at encoder level (rows 8, 8b, 8c), but no live
  row drives a wheel through a pane, and those rows' live traversal is itself
  capability-deferred. **Blocked on the mode-emitting-child harness work.**
- **GAP-4 — scrollback readback from outside.** Legacy SMOKE-39/65 captured
  scrollback via `tmux capture-pane` after the app died. `journal.bin` is NOT
  an equivalent: it is a small rolling window (~2.4 KB observed) that the
  session's own output rotates out within seconds. The driver keeps it as an
  artifact but does NOT assert on it, and no assertion should be built on it
  without fixing that first.

## 6. Improvements over the legacy harness

- **Artifacts survive failure.** The legacy `EXIT` trap destroyed its temp
  dirs and tmux sessions unconditionally, including on failure, so a failing
  run left nothing to debug. The replacement keeps `stack.txt`,
  `in-process.txt`, `record-after-detach.json` and `final.json` under
  `$HOME/artifacts`.
- **Failures name their stage.** Legacy failures accumulated into one blob of
  strings. The replacement prints a per-stage PASS/FAIL transcript.
- **No GUI session required**, so it runs where the legacy smoke cannot.

## 7. Mutation verification

A green smoke that cannot fail is worthless. Both halves were mutated:

- **Killing the session child before the post-mortem** turned detach-never-kills
  red on both biting clauses (`final.json` appeared; child PID gone), and the
  client-leak check correctly reported that it COULD NOT RUN rather than
  passing by default.
- That same mutation exposed a **vacuous clause and it was removed**:
  `record.json`'s `state` field still read `live` for a SIGKILLed session,
  because death is recorded by writing `final.json` rather than by rewriting
  the record. It has been deleted, with the reason in the script, rather than
  left to pad the pass list.
- **The Return-key finding is itself a natural mutation.** The first run
  submitted the command as `"echo …\n"` through `insertText` and STAGE 3 went
  red; submitting the same text followed by a Return KEY event turned it
  green. So the render-ready check genuinely distinguishes "the shell executed
  this" from "the bytes arrived".

## 8. A constraint worth knowing before writing any smoke against a real shell

A real zsh enables bracketed paste (`ESC[?2004h`). Gate 8 therefore wraps
`insertText` in `ESC[200~`/`ESC[201~`, and a newline INSIDE a bracketed paste
is literal text — the shell highlights the line and never runs it. A smoke
that types `"cmd\n"` through `insertText` will wait forever for output that
cannot come, and the failure looks like a broken terminal rather than a
mis-driven one.

This is row 7b of the B2.3 acceptance matrix (safe paste) working exactly as
designed: an embedded newline must not submit unseen. Drive a shell the way a
human does — insert the text, then send Return as a KEY event.

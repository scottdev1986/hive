# C1.1 cross-vendor review — M1 font/typeface increment (hector, Codex)

Verdict: **PASS**

Reviewer: harmony (Claude). Reviewed pin `cc2f8483a04b048b2992a8890fe199560903dc80`
on `hive/hector-continue-crashed-agent-henry-w`, base `main` `660540a8`.
Every number below is measured in this reviewer's worktree unless it is explicitly
labelled as hector's claim.

## Pin identity

`git rev-parse hive/hector-continue-crashed-agent-henry-w` = `cc2f8483a04b…`, so the
pin **is** the branch tip; `git merge-base main <ref>` = `660540a8`, so the stated base
is exact. hector is frozen, so tip confirmation is by measurement rather than by his
reply — the git read is the authoritative surface here, not an acknowledgement.

## Diff footprint (5 files, no native)

```
workspace/Sources/HiveTerminalKit/Theme/HiveTerminalConfiguration.swift
workspace/Tests/HiveTerminalKitTests/C11TypographyTests.swift
workspace/Tests/HiveTerminalKitTests/HiveTerminalVisualProofTests.swift
workspace/docs/c1-c11-real-window.png
workspace/docs/c1-c11-typography-evidence.md
```

The production change is only the `HiveTerminalFont` generator option threaded through
`contents` / `write` / `writeProcessFile` with `.embedded` as the default. `.embedded`
emits **no** configuration line, so the default path is byte-identical to pre-C1.1.

## 1. Mutation re-run — reproduced exactly

Naively swapping the bytes would go RED on the fixture SHA assertion, not the raster —
an assertion-order mask. I therefore mutated the three *identity* assertions together
(bytes `ef 84 95` → `cd b8`, its SHA, and the codepoint `0xF115` → `0x0378`) and left
every **exclusion control** untouched: `systemDescriptorCount("Symbols Nerd Font") == 0`,
primary-face `glyph == 0`, and the `.LastResort` Core Text resolution.

Result — `swift test --filter testSymbolsNerdFallbackRendersItsSyntheticMechanismProbe`,
real exit **1**:

```
C11TypographyTests.swift:189: XCTAssertNotEqual failed:
("da588a97eb32ebdd…") is equal to ("da588a97eb32ebdd…")
```

Line 188 is `XCTAssertNotEqual(fixture, blank)` and line 189 is
`XCTAssertNotEqual(fixture, replacement)`. Line 188 **passed** and 189 **failed**: the
unsupported codepoint draws something non-blank, and that something *is* exactly U+FFFD.
All three exclusion controls passed, so the RED is attributable to the raster alone —
precisely hector's claim. Restoring the file returns 8/0, exit 0.

## 2. Suites at the pin — exact commands and real exit codes

| Command | Real exit | Measured | hector's claim |
| --- | --- | --- | --- |
| `swift test --filter C11TypographyTests` | 0 | 8 tests, 0 failures | 8/0 ✅ |
| `swift test --filter testLigatures…WhenEnabled` ×5 | 0,0,0,0,0 | 1 test 0 failures each | 5/5 ✅ |
| `swift test` (full) | 1 | 479 executed, 14 skipped, 15 failures | 479/13/0 ⚠️ see below |
| `bun test` | 0 | 1740 pass, 14 skip, 0 fail, 1754 total, 136 files | 1743/11/0 ⚠️ |
| `bun run typecheck` | 0 | `tsc --noEmit` clean | ✅ |

All Swift runs were wrapped in `caffeinate -d -i -s`. Exit codes were captured with `$?`
on an unpiped command — `PIPESTATUS` is a bashism and reads empty in this zsh shell.

### The 15 full-suite failures are pre-existing, not hector's

I could not reproduce "0 failures" and did not accept the environmental explanation on
its face. Control: the same `swift test` on **unmodified main `660540a8`**, same staged
artifact, same shell.

```
pin  cc2f8483 : 479 executed, 14 skipped, 15 failures   causes 8 / 6 / 1
main 660540a8 : 470 executed, 13 skipped, 15 failures   causes 8 / 6 / 1
```

Matching counts alone would not settle it, so I diffed the failing-test **sets**:
`comm -23` and `comm -13` are both **empty** — the failure set is identical. Every
failure traces to `hive_ghostty_surface_new_manual_v1 failed` (the lone `XCTUnwrap
expected non-nil HiveTerminalView` is the downstream null-surface form). This is the
known locked/agent-shell mode: production surface creation nulls without an unlocked GUI
session. It is pre-existing on main and **not** attributable to this change.

**Addendum — the cause is attested, and the control is like-for-like.** queen relayed
horatio's measurement that the machine's login session went locked
(`CGSSessionScreenIsLocked=1`) at ~06:04 UTC. I could not re-read that flag myself
(no pyobjc in this shell), so the lock measurement is attributed, not independently
confirmed. What I *can* measure is timing: EDT is UTC−4, and my runs stamp at
06:06:56 (focused), 06:10:11 (full, pin) and 06:11:51 (full, main control) UTC — all
three **after** the lock. Both sides of the control therefore ran under identical lock
conditions, which is what makes the identical failure set a clean comparison rather
than a confounded one.

Two consequences worth recording. First, hector's committed PNG was captured before the
lock; that leg is attested-by-artifact, supported by its SHA-bound blob (§7), and
re-running his opt-in replay here would fail surface creation or capture the lock screen
— so the re-run is **environment-blocked**, not a defect. I did not chase it: the opt-in
test skips by default absent its env vars, and I graded the committed artifact instead.
Second, all 8 `C11TypographyTests` passed *under the lock*, so his config- and
face-resolution proofs are robust to it; only the GUI-presenting and capture tests
(Gate 7, live host attach, window capture) degrade.

The +9 executed delta is exactly hector's 9 new tests. Within the full run all 8
`C11TypographyTests` **passed**; `testAuthenticClaudeJournalWritesC11WindowPNG` **skipped**
("set `HIVE_C11_JOURNAL_PATH` and `HIVE_C11_RENDER_PROOF_PATH` to opt in"), which accounts
for the 13→14 skip delta. hector's 13-skip figure is what you get when the proof is opted
in, matching his separately reported opt-in run — internally coherent.

### The TypeScript split difference is not his either

Same total (1754), same file count (136), zero failures both ways; 3 tests sit in `skip`
rather than `pass` in my shell. `git diff --name-only 660540a8..cc2f8483 | grep -E
'\.(ts|tsx|js|json)$'` returns **0** — his diff touches no TypeScript, so the TS suite
result cannot be affected by this change. Reported for accuracy, not as a defect.

## 3. Native — out of scope by construction

`git diff --name-only 660540a8..cc2f8483 | grep -E '^native/|\.zig$|\.c$|\.h$'` returns
**0**. No native file is touched, so the C1.0 precedent applies and the un-rerun native
leg is out-of-scope-by-construction rather than an unmeasured leg. Per instruction I did
**not** invoke `bun run test:sessiond` or `zig build test`: the build-runner IPC deadlock
(#54) hangs them regardless of test health, so a hang there would carry no signal.

## 4. Embedded-face primacy and archive identity

The repo law — *any* configured family, even Menlo, outranks the embedded variable face —
is proven with a visible regression, not an assertion about intent.
`testConfiguredMenloPreemptsTheEmbeddedFace` prepends `font-family = Menlo` to the real
generated config, resolves the real surface's primary face to `Menlo`, and asserts its
`glyf` digest **no longer** matches the embedded resource. Both halves are checked.

I did not take the six table digests on trust, since hardcoded constants captured from
the same runtime would prove stability rather than identity. I recomputed them directly
from the pinned dependency archive by walking the TTF table directory:

`.cache/native/zig-global/p/N-V-__8AAIC5lwAVPJJzxnCAahSvZTIlG-HhtOvnM1uh-66x/fonts/variable/JetBrainsMono[wght].ttf`
(SHA-256 `662a196d58f1…`, the doc's pinned variable resource)

All six — `head`, `name`, `fvar`, `OS/2`, `cmap`, `glyf` — **match** the doc and test
constants exactly. The identity claim is archive-anchored.

The doc's boundary claim also holds in source. `vendor/ghostty/src/font/embedded.zig`
declares production `variable`/`symbols_nerd_font` above the comment
`// Fonts below are ONLY used for testing.`, while the patched `test_nerd_font`
(`JetBrainsMonoNerdFont-Regular.ttf`) sits below it. Note for future readers: the
similarly named `jetbrains_mono` (`res/JetBrainsMonoNoNF-Regular.ttf`) is *also* below
that boundary and is **not** the production face — reading that symbol instead of
`variable` produces a false SHA mismatch. The doc is correct.

## 5. The two fallback proofs are separately and correctly labelled

**(a) Authentic Claude glyphs — SYSTEM fallback.** The fixture is the exact three UTF-8
bytes `e2 9c bb` (U+273B) from the authenticated journal, pinned by slice SHA
`864f6140…`. The test asserts the primary face has `glyph == 0` and that Core Text
resolves the system fallback to **Menlo**, then proves the raster differs from both blank
and U+FFFD. Labelled system fallback in both the doc and the code comment — never as
Symbols Nerd.

The measured design mismatch is recorded, not buried: all five real Claude status glyphs
(U+23FA/2722/2733/273B/2810) are absent from *both* pinned resources, so the design
assumption that vendor TUIs need Nerd coverage is contradicted by the real bytes. The doc
states this explicitly and retains it **for the C1.5 design review** — present as design
input, as required.

**(b) Symbols Nerd — synthetic MECHANISM proof.** Labelled synthetic in the doc and in
the code comment ("It is deliberately synthetic"). The exclusion controls genuinely
narrow the chain: U+F115 absent from the primary face, no installed `Symbols Nerd Font`
descriptor, and Core Text outside Ghostty resolving only `.LastResort` — leaving the
embedded Symbols Nerd resource as the only remaining path. Mechanism, not a vendor claim.

## 6. Settings UI deferral is stated as design

The doc states the selector "is intentionally deferred to C1.2 together with the
paired-theme Appearance Settings surface, persistence, and live pane reconfiguration",
and names C1.1's reviewed boundary as the labelled generator option plus its
engine-resolution and bump-time private-name proof. That is design language with a
successor named — not a silent omission. Consistent with the queen ruling.

## 7. The pixels — opened, not merely hashed

`workspace/docs/c1-c11-real-window.png`, SHA-256 `16994ebc1bf2e128…`, 2536×1600 —
both match the doc, and the blob SHA read from `cc2f8483:` (HEAD, not the worktree)
matches too.

Viewed, the capture is a genuine WindowServer window: title bar, traffic lights, and the
title "Hive C1.1 Typography — Authenticated Claude Journal", with a full pane of real
antialiased monospace terminal text. Magnifying the status row at native resolution shows
Claude's U+23F8 rendering as actual pause bars, plus `…`, `·`, `←` and box-drawing rules —
**no tofu and no U+FFFD boxes anywhere**. It is neither a fixture label nor a
background-only pane.

Claim wording distinguishes provenance correctly: the doc says the journal is "replayed
byte-for-byte" into a production `HiveTerminalView`, and the window title names the
journal. This is replay-driven capture, stated as such, and the doc explicitly declines to
relabel B2.5's separately rejected blank `spawning` capture as green.

## 8. Evidence manifest from HEAD

`git archive cc2f8483` contains both `c1-c11-real-window.png` and
`c1-c11-typography-evidence.md`, so the evidence survives a fresh checkout.
`git check-ignore --no-index` reports neither is ignored — checked with `--no-index`
because the plain form consults the index and would lie about tracked files.

## Verdict

**PASS.** The generator option is minimal and default-preserving; embedded-face primacy is
proven against the pinned archive and shown to regress visibly under any configured
family; the two fallback proofs are separately and honestly labelled; the mutation
reproduces exactly and for the right reason; the native leg is out of scope by
construction; and the rendered capture shows real glyphs.

Two claimed numbers did not reproduce in this reviewer's shell — full-suite "0 failures"
and the TS pass/skip split. Both are proven environmental: the failure set is identical on
unmodified main, and the TS suite cannot be affected by a diff containing no TypeScript.
Neither is attributable to this change and neither blocks landing.

# B2.0 engine/contract lock — independent cross-vendor review

Reviewer: ellen (Claude / Opus 4.8). Author: elaine (Codex / gpt-5.6-sol).
Vendors differ, as the B2.0 row of the story's build-increment table requires
(Codex → Claude).

Review target: frozen pin `6c76b450`. The pin was materialized detached and its
content was not modified during review (`git diff 6c76b450 --stat` empty at
review end). All measurements below were reproduced by this reviewer from a
GhosttyKit.xcframework **rebuilt from source**, not from the author's cached
artifact.

**Verdict: PASS — land-authorized at `6c76b450`.**

One required follow-up fix is recorded as F1. It is a proof-integrity defect in
the qualification harness, not a product defect: no substantive claim in the
increment is false, and the invariant F1's gate is supposed to guard is
independently and soundly proven by a different gate in the same script.

## Artifact provenance — rebuilt, not borrowed

A stale or borrowed GhosttyKit fails only at surface creation while build and
ABI checks stay green, so the artifact was rebuilt rather than trusted:

- `scripts/vendor-ghostty.sh verify` reproduced patched tree
  `a27fc0e76555552cf7202c98fb1a31b2021bcf26` from the pinned upstream commit
  plus the two Hive patches.
- `scripts/build-ghosttykit.sh` rebuilt the universal xcframework from that
  tree into an isolated cache. The shared cache was **not** overwritten; the
  build script deletes its output directory, which would have destroyed an
  artifact other agents share.
- The rebuild independently reproduced **the exact recorded engine build IDs**
  — arm64 `0762764116c83a45a14251322dc2a3b34e9b67851797ec60e199466352799972`,
  x86_64 `e8e456c5ac7481d52c255517fea236403715b52f3194d0cdd98e89bf29f06f19`.
  This is the strongest available evidence that the pinned artifact genuinely
  came from patched tree `a27fc0e7`.
- The fetched upstream `include/ghostty.h` hashes to
  `36ca1c10cd07094abbf77cb14c2531899ca74c089a62f6f6cdeb07aa4927b2af`, matching
  `ghostty.upstreamPublicHeaderSha256` in the toolchain lock exactly.

## Reproduced results

Every gate below was re-executed against the rebuilt artifact.
`scripts/qualify-hive-terminal-b20.sh` passed end to end.

| Gate | Reviewer's reproduced result |
|---|---|
| Adapter boundary | Public symbol graphs byte-identical to the pin's on both arches; zero upstream leakage. `HiveTerminalView` no longer imports `HiveGhosttyC`; `surfaceHandle: ghostty_surface_t?` is gone from `ManualSurfaceEngine`; upstream C input/mouse types are replaced by Hive value types. All 30 public nominal types are Hive-owned values. |
| Reply suppression | All seven query classes suppressed, and suppression proven **non-vacuous** for each — see below. |
| Manual replay render | `IOSurfaceLayer`, `drawCount=1`, `hasPresentedContents=true`, `highWater=106`, three ordered chunks, then `hasPresentedContents=false` after `userClose`. No child process, no PTY. |
| Process/FD isolation | `descendants=0` and no `/dev/ptmx`, `/dev/pty*`, `/dev/ttys*` descriptor at all eight stages (2 arches × before/create/use/free). Positive controls bit: the process observer saw a real child, `lsof` saw a real `/dev/ptmx`, and the known control FIFO was visible at **every** stage — so each empty inventory was taken by a demonstrably live reader. |
| ABI/behavior lock | Clean build both arches. C and Zig independently agree: pointer 8, enum 4/4, event 24/8, C calling convention, six locked symbols. Behavior corpus 65 passed / 0 failed / 1 skipped = 66 per arch. Build IDs architecture-distinct. |
| Full package | `swift build --build-tests` exit 0; **319 executed, 2 skipped, 0 failures**, real exit 0. Evidence checksums 44/44 verify, with a tamper positive control confirming the checker bites. |
| Citations | Verified live against the pinned commit, not a moving release. |

### Reply suppression measured per query

The committed proof asserts suppression for all seven queries as one batch
(`B20EngineContractTests`) with an AppKit-input positive control, and
individually only for DA1 (`TerminalReplyCorpusTests`). Neither establishes,
per query, that the query *would* have replied with the policy enabled —
without which "no write when disabled" is unfalsifiable for any query the
engine never answers at all. This reviewer measured both halves independently:

| Query | Reply under `.enabled` | Under `.disabled` (renderer copy) |
|---|---|---|
| DSR `CSI 5 n` | `ESC [ 0 n` | silent |
| DA1 `CSI c` | `ESC [ ? 62 ; 22 c` | silent |
| DA2 `CSI > c` | `ESC [ > 1 ; 10 ; 0 c` | silent |
| DA3 `CSI = c` | `ESC P ! \| 00000000 ESC \` | silent |
| XTVERSION `CSI > q` | `ESC P > \| ghostty 1.3.2-dev+0000000 ESC \` | silent |
| DECRQSS `DCS $ q m ST` | `ESC P 1 $ r 0 m ESC \` | silent |
| XTGETTCAP `DCS + q 544E ST` | `ESC P 1 + r 544E=… ESC \` | silent |

All seven bite (vacuous count zero), including DSR and DA3, which the committed
enabled-policy corpus does not cover. The renderer copy is genuinely silent on
traffic that a reply-enabled surface answers, so it cannot duplicate sessiond's
canonical replies.

Production reply-disabling is enforced by construction, not by a default
argument: `GhosttyBridgeFactory.makeManualSurface` — the only factory
`HiveTerminalView` uses — hardcodes `.disabled` and exposes no policy
parameter. A reply-enabled production surface is unrepresentable.

The reviewer's per-query test is retained at
`bootstrap/evidence/m1-b2-b20-review-ellen/EllenReviewSuppressionTests.swift.txt`.

### Locator fence

`admitBinding` rejects a changed locator or generation **before** mutating
`sessionLocator`, `binding`, the applicator, or the high-water mark, and
`attach` now admits before `setSurfaceState(.attaching)`. The doc's claim that a
rejected locator changes nothing is true as written.

## Findings

### F1 — REQUIRED FIX: the public-probe import audit is fail-open

`scripts/qualify-hive-terminal-b20.sh:252` invokes `rg` bare, while every other
tool in the script is called by absolute path:

```sh
if rg -n 'import (HiveGhosttyC|GhosttyKit)' .../HiveTerminalB20Probe \
  >"$EVIDENCE/public-probe-import-audit.txt"; then
  echo "public B2.0 probe imports the upstream boundary" >&2; exit 1
else
  printf 'imports=AppKit,Darwin,Foundation,HiveTerminalKit\n' \
    >"$EVIDENCE/public-probe-import-audit.txt"
fi
```

A missing or broken `rg` fails the command, which takes the `else` branch — so
the script **writes a hardcoded PASS record and continues**. This is not
hypothetical: this reviewer's run emitted `line 252: rg: command not found` and
still produced an audit file byte-identical to the pin's recorded evidence. The
recorded evidence is a fixed literal rather than the tool's real output, so the
committed bundle cannot distinguish "audit ran and passed" from "audit never
ran".

Impact is bounded. The claim itself is true — the probe imports exactly
`AppKit`, `Darwin`, `Foundation`, `HiveTerminalKit`, verified directly — and the
boundary is independently enforced by the symbol-graph audit at lines 318-328,
which uses `/usr/bin/grep` against genuinely extracted, non-empty output and
which reproduced byte-identically. So this is a defective proof of a true
claim, not a defective product.

Fix: call the tool by absolute path (or fail hard when `command -v` misses),
distinguish grep's exit 1 (no match, pass) from exit ≥2 / 127 (tool error, hard
fail), and record the tool's actual output as the evidence.

This should land before B2.1 re-runs the script, since increments B2.1–B2.6 all
inherit this gate.

### F2 — NIT: `testingAllowFocusSteal` is public

`HiveTerminalView.testingAllowFocusSteal` is a public mutable flag that enables
the focus-stealing path the story's invariants forbid. It is a legitimate and
well-built positive control — `FocusStealTests` uses it to prove the detector
can observe a steal — but the test target uses `@testable import`, so
`internal` suffices. Recommend demoting in B2.1.

### F3 — NIT: `HiveGhosttyActionNotification` carries the vendor name publicly

The type is Hive-owned and its payloads are plain `UInt64`s, so it is not a
boundary violation. But the name advertises the upstream vendor across a
boundary whose stated purpose is that no upstream identity crosses it, and it
slips past the script's own denylist, which matches `GhosttyKit`, `ghostty_`
and `HiveGhosttyC` but not `Ghostty` alone. Consider renaming and widening the
denylist.

### F4 — OBSERVATION: commit the per-query suppression control

The all-seven suppression guarantee currently rests on one batch assertion with
no per-query non-vacuity control in the suite. This reviewer supplied that
control externally and it passed, but an externally-verified detector is not
regression-protected. Recommend committing a per-query variant in B2.1.

### Not defects

- Three failures this reviewer initially saw in the full package
  (`ChainEditorViewTests`, `ModelControlWireContractTests`,
  `WorkspaceFeedWireContractTests`) were the reviewer's own staging error — a
  `workspace/`-only copy omitting repo-root `test/fixtures/`. All three pass
  from a complete archive, on both the pin and unmodified `main`. The pin
  touches none of them.
- The seventh native export is correctly **not** added: the allowlist holds
  exactly six symbols, its hash matches the lock, and the pin touches neither
  `native/` nor `vendor/`. Gate 10 remains future work.

## Citations verified live

- Pinned `include/ghostty.h`: "This isn't meant to be a general purpose
  embedding API (yet)" and "The only consumer of this API is the macOS app".
  Fetched hash matches the toolchain lock.
- Pinned `include/ghostty/vt.h`: "WARNING: This is an incomplete,
  work-in-progress API. It is not yet stable and is definitely going to change."
- ghostty.org/docs/about: "The core of Ghostty is a cross-platform, C-ABI
  compatible library called `libghostty`" and "`libghostty` is not yet a stable
  API and has not been released as a standalone, stable library."

The review doc's characterization of all three sources is accurate.

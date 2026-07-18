# HiveTerminalView B2.0 engine/contract lock

Status: the authoring-host live gate is green on arm64 and x86_64. This pin is
frozen for the independent Claude review required by the B2.0 review pair; it
must not land before that review.

## Contract source

This increment implements the story's [Why](../../planning/story-m1-b2-hive-terminal-view.md#why),
[Scope](../../planning/story-m1-b2-hive-terminal-view.md#scope),
[fixed invariants and data flow](../../planning/story-m1-b2-hive-terminal-view.md#fixed-invariants-and-data-flow),
[libghostty embedding boundary](../../planning/story-m1-b2-hive-terminal-view.md#libghostty-embedding-boundary),
and [B2.0 build row](../../planning/story-m1-b2-hive-terminal-view.md#build-increments-and-review-pairs).

Fresh upstream research was checked against the frozen source, not a moving
release. Ghostty describes libghostty as its C-ABI library for GUI consumers
while warning that it is unstable and not a standalone terminal library:
[Ghostty architecture](https://ghostty.org/docs/about). The pinned public
header is more restrictive: it says the embedding API is not general-purpose
and currently has a single macOS consumer:
[pinned `ghostty.h`](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/include/ghostty.h).
The VT header separately calls that API incomplete, work in progress, and
unstable: [pinned `vt.h`](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/include/ghostty/vt.h).
The frozen upstream source is commit
[`73534c4680a809398b396c94ac7f12fcccb7963d`](https://github.com/ghostty-org/ghostty/commit/73534c4680a809398b396c94ac7f12fcccb7963d).
These caveats are why no upstream handle, callback, ownership token, enum, or
library type is public outside the Hive-owned adapter.

## Locked boundary

- One `HiveTerminalView` pins the first exact `SessionLocator`, including its
  generation. A reconnect may replace only the connection fence. Attempting
  another locator or generation throws before the binding, high-water mark, or
  manual surface changes.
- Workspace-visible API consists only of Hive-owned values. The public symbol
  graph is rejected if it contains `HiveGhosttyC`, `GhosttyKit`, `ghostty_`, or
  any private adapter/callback/engine type.
- Production view creation always creates the renderer manual surface with
  terminal replies disabled. The renderer applies the canonical ordered
  OUTPUT stream as a display copy; sessiond's surface remains the sole reply
  authority.
- AppKit, Ghostty app, surface, draw, restore, and free operations remain
  main-thread confined. Native callback payloads are copied before return,
  host delivery is deferred until after callback return, teardown closes
  admission and waits for an in-flight copy, queued delivery self-drops after
  free, and destruction is surface then app then config.
- `HiveTerminalEngineIdentity` projects the qualified upstream commit and the
  architecture-bound native build ID. `HiveTerminalRenderEvidence` exposes
  only value evidence for the exact locator, high water, draw, and presented
  layer state.

This increment does not add the seventh native export or claim an atomic
semantic snapshot. That is Gate 10 work for a later B2 increment.

## Recorded blocking proof

Run on 2026-07-18 with macOS 26.3.1, Xcode 26.6, and Swift 6.3.3:

```sh
scripts/qualify-hive-terminal-b20.sh \
  /Users/scottkellar/Projects/hive/.cache/native/artifacts/ghostty-73534c4680a809398b396c94ac7f12fcccb7963d-zig-3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b \
  bootstrap/evidence/m1-b2-b20
```

The script begins with positive controls proving that the process observer can
see a real child and the FD observer can see a real PTY and a known FIFO. It
then builds in a clean copied workspace and records:

| Gate | Recorded result |
|---|---|
| Pin and artifact | Upstream commit `73534c4680a809398b396c94ac7f12fcccb7963d`; upstream tree `0aeaa44eda9efaf41523c3c0d4f6851eb81e536e`; patched tree `a27fc0e76555552cf7202c98fb1a31b2021bcf26`; patch-series SHA-256 `603bb8a1ef795b59c6b2e7a3de5d78b4cdab59bb68e6f4557d71e0cc17af225b`; exact macOS archive SHA-256 `64cb23f12ef50cd92b8b8cc1f564832cd43ede0cdfae60e7430c2ca79b453a72`; universal `x86_64 arm64`. |
| ABI and symbols | C and Zig independently report pointer 8, enum size/alignment 4/4, event size/alignment 24/8, C calling convention, and six locked bridge symbols. Both public symbol graphs pass the upstream-type exclusion audit. |
| Behavior lock | Each architecture executes the same 66-test engine/ordering/reply/callback/lifetime/render corpus with zero failures; one physical multi-display Gate 7 test is explicitly skipped and is not part of B2.0's live proof. |
| Neutral replay | The public-only probe imports `HiveTerminalKit`, creates a production `HiveTerminalView`, binds one exact locator, applies three ordered OUTPUT chunks including primary, secondary, and tertiary device-attribute queries and other terminal-query traffic, and presents an `IOSurfaceLayer` with one draw. The internal behavior proof records zero parser-generated renderer writes while an AppKit-input positive control still emits. No child process, PTY, or PTY input is used. |
| Process and FDs | At before/create/use/free, both architectures record `descendants=0` and no `/dev/ptmx`, `/dev/pty*`, or `/dev/ttys*` descriptor. The known control FIFO remains visible at every stage, proving the reader stayed live. |
| Teardown | After `userClose`, both probes report `hasPresentedContents=false` and an exited surface. Callback/free and app-wakeup tests prove no delivery/tick after free and deterministic serialized teardown. |

Primary artifacts are the [qualification provenance](../../bootstrap/evidence/m1-b2-b20/provenance.txt),
[ABI/symbol lock](../../bootstrap/evidence/m1-b2-b20/c-zig-abi-symbol-lock.txt),
[arm64 protocol](../../bootstrap/evidence/m1-b2-b20/arm64-protocol.jsonl),
[x86_64 protocol](../../bootstrap/evidence/m1-b2-b20/x86_64-protocol.jsonl),
[architecture-bound engine IDs](../../bootstrap/evidence/m1-b2-b20/architecture-bound-engine-ids.txt),
and the [evidence checksums](../../bootstrap/evidence/m1-b2-b20/evidence-sha256.txt).
The per-stage process trees, FDs, thread inventories, clean-build logs,
behavior logs, public symbol graphs, and positive controls are retained in the
same evidence directory.

## Review hold

The review target is the exact commit reported with this document and the
checksummed evidence directory. The author must not call `hive_land`; the next
state transition is an independent Claude review at this frozen pin.

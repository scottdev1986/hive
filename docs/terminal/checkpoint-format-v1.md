# Hive GhosttyKit Checkpoint Format v1 (Gate 6) — DRAFT

Status: DESIGN DRAFT (pre-B1.0-rebase). Owner: diego. Nothing here is frozen;
dimitri (Gates 5/2) and dominic (Gate 3) hold dependent surfaces and are pinged
before any freeze.

Provenance: pinned upstream Ghostty commit `73534c4680a809398b396c94ac7f12fcccb7963d`
(tree `0aeaa44eda9efaf41523c3c0d4f6851eb81e536e`) plus the Hive patch series
(sha256 `b19ab9c9...79855`, verified via `scripts/vendor-ghostty.sh verify`).
In-tree candidate code informs this design but is not evidence; every claim
below is re-proven live in the qualification phase.

## 1. Two layers, two magics

- **HVGCP001** — the engine payload, produced/consumed by the Zig serializer
  compiled into BOTH lib-vt (sessiond side, exporter) and GhosttyKit (app
  surface side, restorer). Layout: magic ·  version (u16) · 32-byte
  engineBuildId · terminal state · handler state · pending parser fragment.
  It has NO body digest of its own.
- **HVTCP001** — the host envelope (Swift/sessiond). Carries the payload
  sha256, the engineBuildId, and `through_seq`. `through_seq` is envelope-level
  and a restore parameter — it is NOT in the HVGCP payload.

Export exists only on the lib-vt side (sessiond's headless terminal); the app
surface only restores. Bounded: payload hard cap 64 MiB, enforced on both
encode and decode entry.

## 2. State captured (and deliberately not captured)

Captured: primary + alternate screens (full PageList incl. scrollback pages),
cursor (+ saved cursor, pending-wrap, style, hyperlink), modes (incl. bracketed
paste 2004, synchronized output 2026, mouse event/format via flags), tab stops,
colors/palette, title, pwd, charset state, protected mode, Kitty keyboard
state, semantic prompt, Kitty images (incl. in-flight loading transfer),
glyph glossary, partial UTF-8/CSI/OSC/DCS/APC input as a raw **pending byte
suffix** (see §5), previous_char, scrolling region, px dimensions.

**Known coverage gap to close in qualification: `Screen.selection`.** The gate
lists selection; the candidate serializer drops it (restore always yields
selection == null). v1 serializes selection as start/end screen coordinates +
rectangle flag (same tracked-pin discipline as the cursor pin) and restores it
via tracked pins, or records an explicit accepted-by-story justification if
selection is ruled host-side. Default plan: serialize it.

Deliberately NOT captured:
- **Pending terminal replies / callback queues.** Contract: a checkpoint is
  only valid at a quiescent point — no `process_output` in flight and every
  reply/event for bytes ≤ through_seq already delivered to the host callback.
  Emitted-reply durability is sessiond's problem, not the payload's.
- **Parser state machines.** Rebuilt by replaying the pending suffix (§5).
- **tmux control mode** (Option D, accepted): `tmux_control_mode` is compiled
  out; the DCS request to enter it is ignored. The build-option flag is part of
  the fingerprint, so a build that re-enables it cannot exchange checkpoints
  with one that doesn't.

## 3. Determinism defect and the canonical-bytes rule

Observed defect (B1.0 reviews; extent corrected by dexter's independent
3-build review): 8 arm64 fixtures (`case-00-split-005` … `split-012`) differ
at byte offsets 386206 AND 386207 with values that are not stable across
builds (e.g. 386206: 0x00/0xC1/0x00; 386207: 0x9F/0x9E/0x8F) — uninitialized
memory serialized into the checkpoint. The two-byte extent matches the root
cause exactly: a 4-byte `Color` union with `.palette` active has one tag byte
and one live payload byte, leaving precisely two undefined slack bytes. Root
cause (source-verified at the pin, confirmed by the extent):

- `case-00` is `ESC[31m red ESC[0m` (12 bytes; splits 000–012). `ESC[31m`
  completes at split 5 — exactly splits 005–012 have a live `Style` in the
  page's style set at checkpoint time.
- `Style.Color` is a `union(enum(u8))` whose inactive payload bytes are
  undefined; the style struct is copied into page memory by the style set, so
  its slack bytes are whatever the stack held — build-dependent.
- The serializer writes **raw live page memory**: `pagePreservingState` on a
  resident node returns a borrowed pointer, no clone. Every dead byte in the
  page (union slack, struct padding, freed cells/styles/graphemes, recycled
  pool pages) reaches the wire. This is simultaneously nondeterminism and an
  information leak (dead bytes can contain content that predates the
  checkpoint, including scrolled-off or freed data).

**Fix: the canonical-bytes rule — every serialized byte is live data or zero.**

1. **Page memory**: at export, each page is serialized from a canonical clone —
   a freshly **zeroed** same-capacity page into which the live rows are
   structurally cloned (upstream `Page.cloneFrom`), followed by in-place
   canonicalization of stored union-bearing values (styles; hyperlinks if
   slack-bearing). This is safe by upstream design: the style set hashes via
   the padding-free `PackedStyle` and compares field-wise, so stored-byte
   canonicalization cannot perturb set placement or lookups. Because
   `cloneFrom` re-inserts styles in row order, IDs may renumber: the cursor's
   serialized `style_id` (and any other id-bearing reference) is re-resolved
   against the canonical page at export. Export is cold path; the clone cost
   is acceptable and bounded by the payload cap.
2. **Scalar/metadata writes**: the memcpy codec is replaced by a structural
   codec (validated by a standalone prototype against the pinned Zig 0.15.2):
   tagged unions serialize as tag + active payload only; enums as their
   backing integer; packed structs as exactly their backing-integer bytes;
   auto structs field-by-field in declaration order (padding never reaches the
   wire); untagged unions and other opaque layouts are a compile error,
   forcing an explicit decision per type. The same codec's read side gives the
   §7 range validation (enum tags via checked conversion, bools 0/1, union
   tags checked) at zero extra mechanism.

Proofs (as shipped — the originally sketched 0xAA memset probe is not
implementable in defined Zig, for the same reason the defect exists: dead
bytes cannot be legally enumerated or written; the controls below cover the
class instead):
- **Exact-structural-bytes control**: a style read back from live page
  memory — carrying real runtime slack — must serialize to hand-computed
  exact bytes (`expectEqualSlices`). Any slack leak fails this test; it is
  the direct in-process control for the inherited defect class.
- **Wire region-zero validation**: import rejects any payload whose
  scrubbed set regions are not all-zero, and export's scrub is exercised by
  every round-trip test — dead bytes on the wire are structurally
  impossible, not merely absent.
- **Cross-build determinism**: the 3-clean-builds harness byte-compares the
  full both-arch fixture corpus and (post-fix) hard-fails on any
  difference; run 2026-07-18: fixture_difference_count=0 (B1.0: 8
  nondeterministic fixtures on the same harness). This is the mandated
  re-proof at the corrected two-offset extent.
- **Canonical round trip**: encode→decode→encode byte-identical (retained),
  including through id-renumbering histories.

## 4. Fingerprint (engineBuildId) and architecture binding

Composition (candidate, retained): sha256 over pinned commit id, Zig toolchain
ids, the serializer/bridge source texts, and a layout hash covering endianness,
ABI, c_char signedness, pointer width, `page_size_min`, checkpoint-relevant
build options (c_abi, kitty_graphics, tmux_control_mode, slow_runtime_safety),
and recursive type layouts (sizes, alignments, bit offsets, enum tag values,
field names) of every serialized type, plus the concrete `Page.layout(80x24)`
bytes.

Architecture binding: checkpoints embed raw `Page.memory`, whose page-rounded
layout differs across macOS slices (measured live on this host: arm64
page size 16384, x86_64-under-Rosetta 4096). The fingerprint must therefore be
**equal between lib-vt and GhosttyKit within an architecture** and **unequal
across architectures** (surfaced to the host as ENGINE_MISMATCH at the
envelope layer; the raw engine import rejects with its invalid-checkpoint
error). sessiond hands a checkpoint only to a same-architecture surface.

Changes over the candidate (Gate-6 backlog items A and B are closed in-scope):

- **(A) cpu.arch folded into the layout hash.** Today cross-arch separation
  rests solely on `page_size_min`. v1 hashes the architecture tag explicitly,
  and the qualification proves the two arch IDs still differ when
  `page_size_min` is held equal (test-only parameterization of the layout hash
  by page size; both slices emit component dumps, compared in the harness).
- **(B) single source of truth for fingerprinted types.** One comptime type
  list feeds both the layout hash and a comptime assertion inside the
  serializer's write/read funnel: serializing a type not in the list is a
  **compile error** (stronger than the requested drift test; a unit test also
  locks the funnel itself so it cannot be bypassed silently).
- **(C)** CI wiring for the exhaustive 187-restore release lock is verified by
  reading CI configuration after the B1.0 rebase; evidence recorded. This is
  verification only — the expensive path stays production-gated.

## 5. Pending input, through_seq, and replay

- `feed` gives every byte to the stream immediately AND mirrors the
  not-yet-clean suffix into `pending`; the suffix clears whenever the parser
  is in ground state, the UTF-8 decoder is empty, and the APC handler is
  inactive. The checkpointed terminal state therefore reflects ALL bytes ≤
  through_seq; `pending` exists only to rebuild parser/decoder/APC state.
- Restore replays `pending` into a fresh stream with effects detached, then
  attaches effects — replay dispatches nothing and never re-mutates the grid.
- `through_seq` = cumulative end offset of the accepted output prefix. The
  output-range ledger accepts only the exact continuation; equal-range,
  equal-digest re-sends are duplicates (idempotent success); everything else
  is invalid. **After restore the ledger resets to through_seq with cleared
  range history: pre-checkpoint ranges then classify invalid, not duplicate.**
  (SETTLED 2026-07-18: dimitri/Gate 5 concurs — a restore is a new baseline.
  Gate 5's contract additionally fixes: through_seq is an exclusive cumulative
  byte offset; accepted range+digest+parser feed is one mutex transaction; the
  pending-tail quiescence predicate includes DCS-inactive alongside parser
  ground, empty UTF-8 decoder, and APC-inactive.)

## 6. Restore semantics (contract with Gates 3/5)

1. Restore fully decodes and validates BEFORE touching live state; the swap of
   {stream, pending, terminal} happens in one critical section under the
   renderer mutex with a forced full repaint. Draw can never observe a
   half-swapped terminal; a failed restore leaves prior state untouched.
   The in-mutex phase is infallible by construction (stream init cannot
   fail; replay returns no errors), so there is no torn intermediate state.
   **No-move invariant**: the restored stream is initialized and replayed
   IN PLACE in its final storage. Replaying a partial OSC engages the
   parser's capture, whose writer and fixed backing reference the stream's
   own storage — a stream that has replayed pending bytes must never be
   moved (the by-value shape was a use-after-move: a later OSC continuation
   wrote through the stale capture pointer, EXC_BAD_ACCESS under Gate 3's
   async tick). A regression test pins the capture's pointer identity in
   final storage and completes the OSC end-to-end; it is RED under the
   by-value shape.
2. First frame after successful restore is the fully-restored grid.
3. The ONLY host-visible restore side effects are three deliberate post-unlock
   events, in order: title, pwd, invalidate. No write-callback bytes, no
   input, no other events — test whitelists exactly this set.
4. process_output / restore / free are mutually serialized (single logical
   caller); no restore/free while a host callback executes; callbacks must not
   re-enter surface entry points. (Candidate currently fires some callbacks
   under the renderer mutex — dimitri/dominic own whether emission moves; the
   no-spurious-event proofs inherit whatever they fix.)
5. Reply policy (Gate-2 frozen ABI): the surface's reply policy
   (DISABLED/ENABLED) is create-time configuration passed to
   `hive_ghostty_surface_new_manual_v1`, owned by Gate 2. It is NOT checkpoint
   state: the payload is policy-agnostic, restore preserves whatever policy the
   target surface was created with, and restore never enables replies nor
   emits any reply bytes (replay runs with effects detached; §6.3 whitelist is
   unchanged).
6. Geometry/config reconciliation: restore preserves checkpoint geometry; the
   host reconciles by resizing AFTER restore. Qualification proves
   restore-then-resize equals feeding the same bytes into a surface resized
   live (reflow equivalence), and that config deltas (palette overrides)
   reconcile without corrupting restored state.

## 7. Import hardening and fuzzing (backlog CH in scope)

Every decoded scalar is range-validated before use: enum tags checked against
declared values, bools restricted to {0,1}, tagged-union tags validated,
counts/lengths checked against the remaining payload and the 64 MiB cap before
allocation, page memory length must be a nonzero multiple of the page size and
exactly equal to `Page.layout(capacity).total_size`, and Page interior
offsets/capacity/size fields validated against page-memory bounds so corrupt
input yields the invalid-checkpoint error, never illegal behavior.

Three memory-safety holes were found (two by the reviewer, one by the fuzz)
and closed with regressions; the review pin carries all three:

- **Page-count alloc-bomb**: `readPageList` validated the page count only
  against remaining payload SIZE, then `MemoryPool.init` preheated
  count × `Page.layout(std_capacity)` (~512 KiB each) before any page was
  validated. Now the count is rejected unless the remaining payload can
  structurally back it (each page needs ≥ `page_size_min` raw bytes) and the
  preheat itself is capped (the pools grow on demand). Regression proves the
  reject happens with ZERO allocations via a first-alloc failing allocator.

- **Grapheme / hyperlink-map interior-offset UB (corruption-A)**: the
  grapheme_map, grapheme_alloc, and hyperlink_map regions store interior
  offsets whose alignment is asserted on deref (`Offset.ptr` → unreachable in
  ReleaseFast). Their headers live in raw backing memory with no public
  accessor, so minimal in-place validation is not cleanly reachable. Instead
  these regions are **scrubbed on the wire and rebuilt from range-validated
  side tables** via public page APIs (`appendGrapheme`, `setHyperlink`) — the
  exact scrub+side-table pattern already used for styles/hyperlink_set — so no
  raw byte of these regions is ever dereferenced during decode. Row cell
  offsets and cursor bounds/pin-coordinate-match are additionally validated
  before any cell deref. (string_alloc stays raw: it is u8, so it never
  misaligns, and its only readers already bounds-check offsets.)

- **Restore use-after-move**: see §6.1 (folded in here for the pin summary).

Fuzz plan (all under a leak-checking or bounded allocator and a runtime-safety
build):
- truncation sweep over every prefix length,
- seeded deterministic byte-flip fuzz over the fixture corpus,
- structure-aware mutations: large u32 injected at strided aligned offsets
  (length/count fields AND the scrubbed-region offsets), run under a bounded
  128 MiB arena so any unbounded allocation degrades to a deterministic
  OutOfMemory rather than a runaway,
- oracle: no crash, no UB, no leak, either clean success or an accepted error
  (invalid checkpoint / too large / bounded OOM); no partial mutation.

## 8. Qualification evidence (Definition of Done for this gate)

All recorded on BOTH native slices (arm64 native, x86_64 under Rosetta —
mandatory, never skipped):
1. Byte-split corpus authored and restored per arch; within-arch lib-vt ==
   GhosttyKit fingerprint equality; cross-arch inequality (with the
   page-size-held-equal proof for backlog A).
2. Cross-build determinism: corpus byte-identical across ≥3 builds per arch.
3. Poison positive control (dead bytes cannot reach the wire).
4. Fuzz results per §7.
5. FULL APP RESTART: sessiond-side harness exports at through_seq → file →
   fresh app process restores into a new surface → first-frame state digest
   equals the source of truth, event log empty except the §6.3 whitelist →
   exact replay from through_seq accepted and equivalent to the uninterrupted
   timeline.
6. Build-binding: mutated-build-id rejection (reusing devon's 32/32 probe
   pattern with its positive control).

## 9. Open items

- Landing-turn (needs the integrated async base, now on main): re-enable
  Gate6SurfaceRestoreTests under async (un-skip + pumpMainQueue + resolve the
  vacuous `restoredWrites.isEmpty`), and make qualify-ghostty-release-lock.sh
  assert an executed-and-not-skipped result (kill the false-green).

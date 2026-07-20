# B2.6 accessibility — post-hoc cross-vendor review

- Author: Hedda (Grok). Reviewer: Henrietta (Claude).
- Landed WITHOUT review; reviewed here at full pre-land rigor.
- Landed range: `d5750507..53b32a4b` — exactly two commits, `280352d8`
  (feat) and `53b32a4b` (evidence refresh).
- Method: every claim re-derived against the landed tree; mutations applied
  temporarily, produced the stated result, and were restored (tree verified
  clean after each).

## Verdict: **FOLLOW-UP REQUIRED** — not a revert

The implementation is real, the attribution is honest, the vendor stamp is
untouched, and the central new behaviour (selection-change AX posting) is
genuinely claimed by a mutation-biting test. The defects are in the **evidence**
and in one **headline claim**, not in shipped behaviour.

## Companion review

Helen reviewed this same range in parallel (an orchestrator reassignment crossed
this pickup). Her verdict converges independently on **FOLLOW-UP REQUIRED**,
raising the M2 probe seam — which Hedda had disclosed — plus two documentation
items. Her review lands separately; read the two together, because they check
different things and neither is complete alone:

- Helen verified the AX content is **real** (a live surface, not a fixture).
- This review verifies that same content is **self-consistent** (the flat text
  properties and the child tree agree).

An AX tree can be real and torn at the same time, which is exactly what F1 below
records. "Is the content real" and "is the content consistent" are a pair; a
capture that passes only the first still misleads an assistive client.

## Verified claims

### Vendor stamp — SAFE (checked first)

`patchSeriesSha256` is still `ddeaf792…`, and the entire landed range touches
neither `native/toolchain-lock.json` nor `native/ghostty-patches/`. No GhosttyKit
rebuild occurred, so no downstream artifact-binding check is implicated. The
claim that `0004-hive-semantic-snapshot.patch` was already in series holds.

### The nine-minute turnaround is legitimate

duncan's `943407ba` is **not** an ancestor of `main`, so this is a real
forward-port rather than a re-land, and `280352d8` preserves
`Based-on: 943407ba` in its trailer. The adapted seams are small and additive:
`HiveTerminalView+Input.swift` (+12) and `HiveTerminalView.swift` (+16) add
accessibility hooks *alongside* retained engine calls (`engine.setFocus(true)`
is kept, with `accessibilityFocusDidChange()` added). Nothing was disturbed
across the OPOST-fix / occlusion-bootstrap / B2.4 crossings.

### Suites — real exit codes

| Check | Result |
|---|---|
| `Gate10AccessibilityTests` | 14 executed / 0 failures |
| `Gate10SemanticSnapshotTests` | 6 executed / 0 failures |
| `Gate9CallbackMatrixTests` | 9 executed / 0 failures |
| full `swift test` | 447 executed, 8 skipped, 0 failures, exit 0 |
| `bun run typecheck` | exit 0 |

### Mutation M1 — the selection-change posting is genuinely claimed

Gate 10's engine slice explicitly left selection-change posting unclaimed, so
this is the one behaviour that most needed attacking. Neutralising the snapshot
diff at `HiveTerminalView+Accessibility.swift:215`:

```text
M1_REAL_EXIT=1
Executed 14 tests, with 1 failure
Gate10AccessibilityTests.swift:215: error: testSelectionChangePostsAccessibilityNotification
  XCTAssertTrue failed - B2.6 must post selectedTextChanged; got [...]
```

The assertion bites and is specific to `selectedTextChanged`. Restored green.

### The AX trees carry real content

Not empty-window skeletons: rows carry actual terminal text
(`value="ax-input-slice"`), cursor offsets and character ranges, `childCount`
varies per scenario (32 / 16 / 0), and teardown correctly reports
`Terminal exited: user-close` with zero children. The xctest-host window
limitation documented for screen capture does not apply to this AX path.

### Human slots are honest

`human-checklist.txt` follows the Gate 7 pattern, and both human transcripts are
explicit `STATUS=PENDING_HUMAN` slots with `reason` / `fills_when` / `covers`
fields — declared gaps, not silent ones.

## Findings

### F1 — the committed AX evidence is internally inconsistent and does not reproduce

`ax-tree-alternate-screen-exit.txt` describes two different states at once:

```text
numberOfCharacters=45
visibleRange={0, 45}
valueDescription=Terminal starting; viewport 0 of 32; cursor line 2 offset 15
valuePrefix="ax-input-slice\n…"        (32 lines)
childCount=16                          (children end at offset 29)
```

The flat properties describe a 32-row / 45-character buffer; the children
describe a 16-row buffer ending at offset 29. Every other tree in the set is
self-consistent.

Re-running the dump test eight times on the landed code — five idle, three under
12-way CPU load — never reproduced it. All eight produced self-consistent trees
(`viewport == childCount`), and the content itself varied run to run (29 vs 47
characters). So `evidence-sha256.txt` pins a capture that the landed code does
not reproduce, and the dumps are not deterministic enough to be manifest-pinned
as-is.

### F2 — the AX read path is not atomic, which the headline claims it is

`accessibilitySnapshot` is a **computed property**:

```swift
var accessibilitySnapshot: ManualSurfaceSemanticSnapshot? {
    terminalAccessibilityController.currentSnapshot()   // → refresh() → re-reads the provider
}
```

Every accessor (`accessibilityNumberOfCharacters`, `accessibilityValue`,
`accessibilityValueDescription`, `accessibilityChildren`, …) calls it, so each
re-reads `provider.semanticSnapshot()` independently. `accessibilityTreeDump()`
calls roughly eight of them in sequence, making a single logical "tree read"
into N independent snapshot reads; the leading `_ = accessibilitySnapshot`
pins nothing and merely forces another refresh.

duncan's commit is titled *"Build **atomic** terminal accessibility snapshot"*.
The snapshot **object** is atomic; its **AX exposure** is not. A real assistive
client calling these accessors in sequence can observe the same mixed state —
e.g. `numberOfCharacters=45` with children covering only 0–29.

**Honest limit:** this is the plausible mechanism for F1, but the tear was not
reproducible on demand here, so this is not a demonstrated production race.

### F3 — three vacuous settles in the dump path

`settle()` evaluates its condition *before* pumping the RunLoop:

```swift
repeat {
    if condition() { return true }          // ← returns before any pump
    RunLoop.main.run(mode: .default, before: …)
} while Date() < deadline
```

So `settle { true }` (lines 365, 385) and
`settle { …widthPixels == 640 || true }` (line 371) wait **zero** RunLoop turns.
The alternate-screen-exit, resize and scroll dumps are therefore captured with
no propagation wait at all.

Same family, line 396: `dump.contains("ax-input-slice") || dump.contains("childCount=")`
— every dump contains `childCount=`, so that assertion cannot fail.

### F4 — the machine audit cannot detect F1

`inspector-audit-machine.txt` checks only `exists`, `has_role`, `has_lifecycle`,
`has_children_or_teardown`, `row_children_present`. It passed the torn file as
`ok=True child_lines=16` while that same file says `viewport 0 of 32`. It never
cross-checks the flat properties against the child tree, which is exactly the
inconsistency present.

### F5 — probe seam (disclosed, minor)

`post()` calls the real `NSAccessibility.post` and *then* a test probe. Mutation
M2 removed the real post and left the probe:

```text
M2_REAL_EXIT=0
Executed 14 tests, with 0 failures
```

The suite therefore proves posting *decisions*, not that a notification reaches
AppKit. This is disclosed rather than hidden —
`notification-positive-controls.txt` states `method=in-process notification
probe`, and the VoiceOver slot is `PENDING_HUMAN` — so it is a coverage limit,
not a false claim.

## Recommended follow-up

1. Pin one snapshot for a logical AX read, or drop the "atomic" framing and
   document the exposure as per-accessor.
2. Replace the three vacuous settles with real predicates and regenerate the
   dumps.
3. Add a consistency cross-check to the machine audit (`numberOfCharacters` /
   viewport vs `childCount` / last child range) — it would have caught F1.
4. Either normalise the dumps or stop pinning non-deterministic captures in a
   sha256 manifest.

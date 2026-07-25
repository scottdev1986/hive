# Amber production-create WIP (`1e5937d7`) — keep-or-discard assessment

**Date:** 2026-07-25
**Subject:** preserved ref `refs/hive-preserved/hive/amber-implement-the-missing-producti`, commit `1e5937d7` ("wip: production create backend", agent amber, 1,172 lines)
**Verdict: DISCARD**, after landing one ~12-line gap (U1, below).

This closes the explicitly-open question recorded at
[`planning/2026-07-25-preserved-ref-triage.md`](2026-07-25-preserved-ref-triage.md):281 and :319-322,
which flagged amber as the "weakest A call in the set" and the one preserved ref that
"needs an explicit decision". The triage lacked a byte-identical proof that amber's payload
was superseded. That proof is below — and it is *not* byte-identical, which is why the
question needed settling on behaviour rather than on bytes.

All line citations are against `main` at `a4ed0436`.

---

## 1. Reachability — settled, and never previously proved

- `git merge-base --is-ancestor 1e5937d7 main` → **FALSE**. The commit is not an ancestor of main.
- The **only** ref containing it is `refs/hive-preserved/hive/amber-implement-the-missing-producti`.
  Both `git branch --contains` and `git tag --contains` are empty.
- Its parent is `de8267a3`, which **is** the merge-base with main. The WIP is exactly one
  commit off a point on main.
- **Replacement:** `81bdd0ab feat(sessiond): add production create backend` — same author,
  same parent, 43 minutes later (12:39 → 13:22, Jul 17).
  `git log -S 'pub const ProductionBackend'` and `git log -S 'pub fn serveAuthenticatedFrames'`
  on main each return `81bdd0ab` and nothing else.
- **Not byte-identical.** Trees `bbf37a4f` vs `a4ecf56b`; `git diff --stat 1e5937d7 81bdd0ab`
  = 457 insertions / 750 deletions. `81bdd0ab` is a **rework, not a copy**.
  The ~750 deleted lines are the WIP's in-broker `ProductionHostLauncher`, which landed
  separately at `357d2b05` and moved to `host_runtime.zig` at `a6b05b4f`.

So the WIP is unreachable from main, and what replaced it was rewritten rather than copied.
That combination is exactly why a behaviour-level assessment was required before discarding.

---

## 2. Verdict over 21 distinct WIP behaviours

| Class | Count |
|---|---|
| Subsumed (present on main, materially identical) | 17 |
| Superseded (main strictly better) | 8 named |
| Unique to the WIP | 3 — **only 1 real** |

---

## 3. Subsumed (17)

`CreateTransaction` and `ProductionBackend` begin/input/commit are line-for-line identical on
main (`broker.zig`:1742-1750, :2125-2202). Also present:

- `serveAuthenticatedFrames` — `broker.zig`:1519
- `BrokerBackend.call_fn(Header, payload, now_ns)` — `broker.zig`:1259
- `StartupBackend` pub — `broker.zig`:2205
- socketpair / fork / execve — `host_runtime.zig`:77, :84, :99-100
- `dup2` fd3 + clear `FD_CLOEXEC` — `host_runtime.zig`:88-95
- boot envelope write — `host_registration.zig`:317
- `HOST_REGISTER` read + schema — `host_registration.zig`:335-337, :224-228
- SIGKILL + reap — `host_runtime.zig`:112-126, wired at :542
- `hostRecordFromRegistration` → `parseRegistration` — `host_registration.zig`:220+
- `encodeHostRecord` → `host_record.zig`:155
- peer pid / exe / start_token — `host_runtime.zig`:557-565
- `protocol.major` pinned by schema literal — `session-protocol.ts`:496
- both WIP tests — `stub_host.zig`:1205 and :1809; helpers at :267, :296, :332, :350

---

## 4. Superseded (8) — main is strictly better

**(a) Premature, unretractable ack — the biggest one.**
The WIP acked the host `accepted:true` **inside `launch()`**, before Registry admission. If
admission then failed, the ack could not be retracted. Main added a two-phase commit with no
WIP analogue: `PendingRegistration` + `HostLaunchDecision` + `finalize_fn`
(`host_runtime.zig`:456, :643-667), `rejectLaunchedHost` at all **7** failure points
(`broker.zig`:1099, 1186, 1206, 1215, 1220, 1225, 1235), and `Registry.rollbackAdmission`
(`broker.zig`:1240-1246). The ack now fires only in `finalizeOne(.admitted)`
(`host_runtime.zig`:660).

**(b) Capacity checked before fork.** Main calls `registry.hasCapacity()` **before** forking
(`broker.zig`:1161). The WIP forked and completed the handshake, then failed.

**(c) Launcher injected, not hardwired.** `serve()` takes the launcher as a parameter
(`broker.zig`:2261-2288), injected at `main.zig`:29-31. The WIP hardwired it and had to carry
a **comment warning** that `StartupBackend` must never be installed. Injection makes that
state unrepresentable rather than merely documented.

**(d) Descriptor and environment hygiene.** Main closes **all** descriptors above 3
(`host_runtime.zig`:96-98) and scrubs the environment (:73). The WIP's targeted `CLOEXEC` left
the broker listener and lock descriptors inheritable, and passed `std.c.environ` verbatim.

**(e) Fabricated attestation removed.** The WIP hardcoded `.executableVerified = true` — an
attestation asserting a fact it never checked. Main derives it from a real
`sameFile(expectedExecutable, argv[0])` (`host_registration.zig`:196-197).

**(f) A check that could not fail.** The WIP did `_ = try wallExpiryToMonotonic(...)`,
discarding the result. Main validates the lease from the host's own `expiresAt`
(`host_registration.zig`:371-377), bounds it (`broker.zig`:1204-1205), and documents
`broker_now_ns` as non-authoritative in the host's clock domain (`host_runtime.zig`:494-498).

**(g) HELLO/WELCOME on the launch fd dropped, not lost.** The same identity facts are proved
on `HOST_REGISTER` (`host_registration.zig`:340-348) — one round trip, on a descriptor with
exactly one peer by construction.

**(h)** The launcher moved out of `broker.zig` entirely.

**Coverage.** Main additionally carries 2 tests with no WIP counterpart
(`stub_host.zig`:1637, :1726) plus a real-process golden suite
(`real-host-golden.zig`:218, 1675, 1946). The WIP had **zero** real-process coverage.
Main's `ProductionBackend` also handles list / inspect / terminate / visibility_renew /
orphan_discard / attach_request (`broker.zig`:1836-1847) — a strict superset.

---

## 5. Unique to the WIP (3) — only 1 real

### U1 — Geometry conformance. **REAL. Land this.**

Main never compares the host-registered geometry against the geometry the CREATE spec
requested.

Evidence:
- `host_runtime.zig` contains **zero** occurrences of "geometry". Its `SpecProjection` parses
  only `locator` / `argv` / `expectedExecutable` (:527-531), so it *cannot* compare.
- `launchHost` (`broker.zig`:1186-1224) omits it, while conformance-checking
  `expected_executable`, `visibility.workspaceSessionId`, `open_terminal_revision` and the
  locator against the spec in that same block.
- `recordJsonMatches` **does** compare geometry (`broker_record.zig`:325-328) — but between a
  record and its **own** json, both derived from the same registration. It therefore cannot
  detect a spec mismatch.
- `TerminalGeometrySchema` (`session-protocol.ts`:506-528) enforces only **bounds**, so any
  in-range geometry passes.
- The requested geometry *is* available: `SessionSpecSchema`:544 carries it, and
  `CreateBeginPayloadSchema` (:1931-1933) spreads the `SessionSpec` shape.

Positive control (guards against a broken search): the same searches **do** find
`sameGeometry` at `host_core.zig`:181, used at :1464 on the viewer attach-grant path. The
absence in the launch path is real, not a search artifact.

**Severity: low-to-moderate.** A correct host derives geometry from the spec, so this is a
don't-trust-the-host readback rather than a live exploit. Its value is consistency: pid,
token, exe, build-hash and engine-id are **all** verified this way, and geometry is the lone
omission in an otherwise uniformly paranoid path. That consistency argument — not a known
failure — is the reason to land it.

Contract note: `docs/contracts/terminal-host-v1.md` §1:23-25 ("`running` requires positive
executable-replacement evidence; creating a process or observing a PID is insufficient") and
the operation set at :75 establish the verify-positively posture that motivates U1, and :103
makes mutation controls a stated repo norm. The contract does **not** mandate launch-time
geometry readback conformance anywhere. U1 is consistency work supported by the contract's
posture, not compliance with an explicit clause.

### U2 — `protocol.minor` exact equality. **Note only. Do not implement.**

The schema pins `major` via `z.literal` but leaves `minor` a range
(`session-protocol.ts`:496-497). Main checks `minor` only on the adoption path
(`adoptionMatches`, `broker.zig`:2342), not on CREATE. Unreachable without a substituted
executable — which the build-hash and exe-path checks already catch. Recorded for the record;
deliberately not implemented.

### U3 — peer uid/gid. **Dropped.**

Unreachable. The descriptor is a socketpair the broker itself created and handed to its own
fork.

---

## 6. Conclusion

Delete `refs/hive-preserved/hive/amber-implement-the-missing-producti` once U1 lands.

The ref is not reachable from main, and it is not byte-identical to what landed — but the
reason for both is now on record: `81bdd0ab` reworked the same concern and improved on it in
eight named ways, and the single behaviour the WIP had that main lacks is U1, which is being
landed as ~12 fresh lines rather than cherry-picked. The WIP's own `sameGeometry` is 4 lines
and its `verifyLaunchRegistration` is written against types and a layout main no longer uses,
so cherry-picking would cost more than rewriting.

Deletion of the ref is the orchestrator's action, not this document's.

---

## Appendix — citation corrections

The assessment's cited file:line references were re-verified against `main` at `a4ed0436`
during U1 implementation. All spot-checked citations held exactly (notably
`stub_host.zig`:1205 / :1637 / :1726 / :1809, each landing precisely on its `test`
declaration, and `broker.zig`:2342, which lands on the `protocol_minor` comparison itself
rather than on the enclosing `adoptionMatches` at :2333) with **one** exception, corrected
here.

Two notes on reading the citations: where a WIP symbol is given as `name → file:line`, the
name is the **WIP's** and the location is main's equivalent — e.g. `encodeHostRecord` →
`host_record.zig`:155 lands inside `projectionValue` (:137), the shared record→json
projection behind `encodeRecordJson` (:182); main has no symbol named `encodeHostRecord`.

- **Claimed:** `stub_host.zig`:1264, `mismatched_record.locator.generation += 1`, offered as the
  pattern to mirror for the U1 test.
  **Actual:** the identifier `mismatched_record` does not appear anywhere in `stub_host.zig`;
  :1264 is `ServedBackendHarness` setup. The real analogue is
  `record.locator.generation += 1` at **`stub_host.zig`:1654**, inside
  `test "pre-admission CREATE rejection leaves Registry empty and tears down"`.
  The *pattern* described (mutate a fixture record field to induce a mismatch) is real and is
  the correct model for the U1 test; only the identifier and line were wrong.

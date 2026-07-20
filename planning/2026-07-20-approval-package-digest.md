# M1–M5 Approval Package — digest of all open/upcoming work

Compiled by **sam**, 2026-07-20, read-only. No file, issue, or board column was modified.

**How to use this.** Every item below carries (1) a plan summary, (2) acceptance criteria as a checklist preserving every distinct criterion with load-bearing wording quoted verbatim, (3) completion state per the doc's or issue's own status lines, and (4) flags — `AC-MISSING`, `AC-THIN`, `OPEN-USER-RULING` — each with the specific question you must answer. Approve or amend each item and each criterion.

**Sources.** Story docs under `planning/`; issue bodies via `gh issue view <n> --repo scottdev1986/hive`; human gates from `planning/m1-human-evidence-session-runbook.md`; far scope from `planning/backlog-outline.md`. Done items (#4, #35, #39–#44, #46, #47, #49–#51, #54, #58, #64–#67) are excluded as verified landed and were not re-audited.

---

## Preamble — four things to decide before reading the item list

### P1. The plan header says execution is not authorized, and execution is plainly underway. **RATIFY OR AMEND.**

`planning/backlog-outline.md` line 3, verbatim and unchanged:

> **PLAN STATUS: FINALIZED 2026-07-17 — awaiting user approval. Execution of any story is NOT authorized until the user approves this plan.** All user decisions (Q1–Q7) are ratified and folded in below.

This is contradicted by the tree: M1-A1 has 20 recorded live conformance evidence rows all Pass; B1 gates 3, 7 (partial), 9 and 10 (engine scope) carry landed 2026-07-18/19 live proof; #45 records two deferred-evidence items DISCHARGED with artifact shas. Meanwhile A0's and B1's own headers still read *"fully specified; execution awaits user plan approval."*

**Question:** ratify execution retroactively as of a named date and correct the header, or amend the plan and state what was executed out of authorization? Note the outline's own M2 section already establishes that this header is not immutable — *"The `PLAN STATUS: FINALIZED` header above records a drafting state, not immunity from supersession."* Any approval should be **dated and scoped to a revision**, not to the document by name.

### P2. #1 and #2 are not descoped — they ARE M1's exit event. **CONFIRM YOU READ THEM THAT WAY.**

The word "cut" in these docs is a noun — *the* cut, the atomic removal merge train — not a verb meaning removed-from-scope. Verified directly:

- `planning/story-001-gut-tmux.md:2` — "Milestone: M1 (this story is the cut that completes M1)"
- `planning/story-002-remove-agent-tui.md:2` — "Milestone: M1 (executes together with STORY-001 as the M1 cut)"
- `backlog-outline.md:49` carries a section literally headed **Cut** listing both, and the dependency chain ends "→ atomic cut → re-run B3+C2+matrix → M1 exit."

Treating #1/#2 as descoped would delete M1's exit condition. They are filed last in the M1 section below because they execute last, at the Removal Gate — not because they are optional.

### P3. Three M1 track cards carry live-proof invariants on one outline line each. **RULE ON WHETHER THEY GET STORY DOCS.**

Verified: `planning/` holds story docs for A0, A1, B1, B2, C1, C2 **only**. There is no `story-m1-a3-*.md`, no `story-m1-a4-*.md`, no `story-m1-b3-*.md`. Yet:

- **A3 (#5)** carries invariants **I3/I4** on `backlog-outline.md:37` — one line.
- **A4 (#6)** carries invariants **I2** (and **I5** in scope) on `backlog-outline.md:38` — one line.
- **B3 (#9)** carries no invariant but sits on the critical path to the cut, and defines its own scope only by reference to the coverage of the harness STORY-002 is simultaneously deleting.

Every other invariant-bearing M1 card got a refinement artifact. **Question:** do A3/A4/B3 get story docs + DoD refinement before execution, or are the issue bodies accepted as the specification?

### P4. Two M1 exit criteria are mutually blocking as written. **THIS NEEDS AN ORDERING RULING.**

- **#45**'s final unchecked human acceptance is written explicitly against `make terminal`: *"Live human resize-and-type acceptance in `make terminal` … This checkbox is the final acceptance and cannot be satisfied by an automated run."*
- **#59** directs that `make terminal` be **deleted** before M1 closes, and its runbook-dependency caveat names only `planning/m1-human-evidence-session-runbook.md` — **it misses #45 entirely.**

**Question:** does the #45 human acceptance run before `make terminal` is deleted, or is #45's acceptance rewritten against the production path first? This is the sharpest unresolved sequencing conflict in the package.

---

## Corrections to prior planning-doc claims, verified this pass

1. **`planning/2026-07-20-board-planning-repo-reconciliation.md` §3 called #11 C2 "not actionable as written."** That is now stale — `planning/story-m1-c2-packaging.md` exists (41 lines) and was written specifically to close that finding. Judged freshly below: **it is executable and I do not flag it AC-THIN.** It has two genuine AC-MISSING gaps (universality untested; Ghostty/Zig absence unprobed).
2. **#55 claims "#45 carries a note naming #2 as its blocker."** **Verified false.** I fetched #45's body and grepped it — no such note exists. #55's remediation is therefore **incomplete**, and the missing note is the safety net for the exact gate the prose-closure defect endangered. #2 itself *is* correctly reopened (verified OPEN).
3. **#12/#13/#14 retitled on the board as expected** — verified: all three now read "M2 proof target (under #38) — …". Consistent with #38's supersession.
4. **#36 is confirmed unscoped with no owner**, from its own status line: *"created 2026-07-17, unscoped for execution (blocked on B2 for K; J/I/G-live need a GUI-automation owner)."*


---

# Part 1 — M1 remainder

Track order: A0 → A1 → A3 → A4 → B1 → B2 → B3 → C1 → C2, then the matrix/gate/exit cards, the human gates, and finally the cut (which executes last).

## #34 — M1-A0 · Terminal-host contract audit & freeze


Source: `planning/story-m1-a0-terminal-host-contract.md` · Board item `PVTI_lAHOBUNSMM4BdtCrzgzO5RE`

### (1) Plan summary

A0 replaces today's `SessionHost` seam — which embeds Hive instance identity, root/agent subjects, a closed provider enum, worktree/grant/Workspace policy, and a tmux `hostKind` — with an externally-derived, frozen, project-agnostic terminal-host boundary that A2 can build against. The boundary is deliberately **behavior-level and implementation-neutral**: it freezes externally observable invariants and evidence, *not* syscalls, and explicitly must "NOT expose forkpty/setsid/TIOCSCTTY/TIOCSWINSZ as caller knobs" so the native implementation stays free to use a safer spawn mechanism (the doc cites post-fork async-signal-safety in a multithreaded AppKit/daemon host, `pthread_atfork`, and `posix_spawn` close-on-exec as the reason). Direction of the seam: the host accepts opaque session identity + `command{executable, argv, cwd, completeEnv, fdMap}` + terminal profile + initial winsize, and exposes byte I/O, resize, attach/replay, inspect, exit/reap evidence, and termination — while "ALL Hive agent/provider/grant/worktree/Workspace policy lives above the seam." The story defines 12 P0 contract semantics that must be expressed before freeze, a minimal semantic shape (not a prescribed method count), and 11 live freeze tests A–K that must pass **on a neutral fixture AND real sessiond** before the contract is considered frozen. Contract semantics were adopted in full from atlas's A0 pre-review of 2026-07-17, backed by nine verified Darwin/Apple primary sources.

### (2) Acceptance criteria checklist

**P0 contract semantics — all 12 must be expressed before the freeze**

- [ ] **1. PTY/job-control creation invariant** — "not merely argv/cwd/env/fds/geometry": child enters a new session as session leader; the slave PTY is its controlling terminal; stdin/stdout/stderr name that same slave; foreground process group is valid; initial termios profile and **all four winsize fields applied BEFORE exec**. `openpty`/`forkpty`/`login_tty` are "implementation options, not API vocabulary" (opening a tty alone never acquires a controlling terminal).
- [ ] **2. Exec proof** — "forkpty success proves fork, not exec." `create` returns `{running, exec_failed, exited, unknown}` and claims `running` only after an exec handshake/readback. Typed errno/layer for invalid executable, cwd, env/ARG_MAX, fd setup, controlling-tty setup. "PID existence is never equated with the expected executable."
- [ ] **3. ABA fencing on opaque identity** — host-issued incarnation/generation token; every attach/write/resize/terminate carries it. `create` idempotency such that "retry after uncertain transport failure cannot double-exec." "PID identity always includes a start token, never PID alone."
- [ ] **4. fd transfer semantics** — integer fds are process-local; define transferable handles (SCM_RIGHTS or equivalent), target-fd mapping, ownership/dup/close rules, close-on-exec default; "only explicitly mapped descriptors survive exec." Environment is a **COMPLETE vector** (or overlay + explicit unset) — "no ambient inheritance surprises."
- [ ] **5. Parenthood/reap authority** — waitpid is child-only; reparenting after forker death breaks truthful reap. **Choose one:** durable per-session monitor remains the vendor's parent and journals wait status (broker restart adopts the monitor), **OR** host crash yields typed lost/unknown exit authority + survivor cleanup. Exit evidence carries `{source: waitpid|parent-journal|unavailable, code/signal, reaped, completeness}`. "kevent/PID absence is notification, never reap proof."
- [ ] **6. Output and exit are independent ordered facts** — raw bytes (not assumed UTF-8), byte offsets/event sequence, tail-drain semantics (child may exit with unread PTY output). "Replay does not close at waitpid until master EOF/error/drain policy resolves"; `output_closed` reported separately from `process_exited`/`reaped`.
- [ ] **7. Resize is an ordered mutation** — rows/cols/xpixel/ypixel + expected incarnation + idempotency/revision. Receipt proves ioctl applied + `TIOCGWINSZ` readback, "NOT that the TUI handled SIGWINCH." Coalescing allowed; live proof shows the foreground process observes final geometry. Ordering defined relative to writes/attach — "resize and input cannot silently reorder."
- [ ] **8. Flow control/backpressure in the contract** — partial/EINTR/EAGAIN reads/writes; bounded input queues; termios IXON/IXOFF can stop/start output. Bounded credit/ack (or equivalent), journal low/high watermarks, explicit gap/overflow ("never silent loss"), max write/frame sizes; write-receipt words precise: "accepted/queued/written-to-master ≠ consumed by child." **Decide** whether TIOCPKT control events are internal or typed control frames.
- [ ] **9. Attach/replay is a resumable cursor, not a boolean** — protocol/build capability negotiation; checkpoint content-type/schema/hash + checkpoint/output sequence; resume-from sequence; bounded retention; explicit gap requiring full checkpoint. Checkpoints opaque/versioned — "the host contract does not bake Ghostty structs." Mid-escape/mid-UTF-8 disconnect "replays without duplicate or loss."
- [ ] **10. Input arbitration ≠ write(bytes)** — generic writer claim/lease/token + ordered transaction/idempotency + synchronous human-claim acquisition. "These are terminal concurrency semantics, not Hive policy." Key-to-byte encoding stays renderer-side.
- [ ] **11. Termination is a required INPUT** — graceful vs immediate; target semantics (foreground pgrp / session / process tree); deadline/idempotency; result includes survivors. "Closing the PTY is hangup, not generic half-close"; VEOF is canonical-mode-only (ordinary data in raw mode) — "PTY input is not a socket."
- [ ] **12. Inspect exposes honest evidence/completeness** — lifecycle state; host/child pid+start token; sid/pgid/foreground pgid/tty identity; geometry+revision; output/checkpoint retained ranges; input owner; exit/reap authority; descendants/survivors; evidence time/diagnostics. "Transport failure ⇒ unknown, never absent/exited."

**Minimal shape (semantic, not prescribing method count)**

- [ ] `create(opaqueKey, idempotencyKey, command{executable,argv,cwd,completeEnv,fdMap}, terminalProfile, initialWinsize) → incarnation + launch evidence`
- [ ] `claim/releaseInput; write(bytes, transaction, claim, incarnation)`
- [ ] `resize(winsize, revision, incarnation)`
- [ ] `attach/resume(cursor, capabilities, incarnation); ackOutput`
- [ ] `inspect/list; subscribe ordered events`
- [ ] `terminate(mode, target, deadline, idempotency, incarnation)`
- [ ] outputs: raw data/control frames, checkpoint/replay metadata, lifecycle/exit/reap evidence, receipts with completeness

**Live freeze tests A–K** — "the contract freezes only when these pass on a neutral fixture AND real sessiond"

- [ ] **A.** Fixture proves `isatty(0/1/2)`, same tty, new sid, foreground pgid, initial geometry present before first user instruction.
- [ ] **B.** Nonexistent exec / invalid cwd / oversize env / unmappable fd ⇒ typed exec failure, "no ghost running session"; Unicode/spaces + non-git cwd work (project-agnostic).
- [ ] **C.** fd-leak test: only declared fds survive; transferred-fd ownership/closure deterministic.
- [ ] **D.** Burst resizes interleaved with input: ioctl readback + trapped SIGWINCH/final geometry, monotonic revisions, no reordered bytes.
- [ ] **E.** 100 MiB producer + slow/disconnected viewer + XOFF/XON: no byte loss, bounded memory, explicit backpressure/gap.
- [ ] **F.** Child emits tail bytes then exits (normal **and** by signal): full tail replays; `output_closed`, `exited`, `waitpid`-reaped observed separately.
- [ ] **G.** Broker restart with live durable parent reconnects; parent/monitor death produces typed loss, "never fabricated exit."
- [ ] **H.** Attach disconnects mid-escape **and** mid-multibyte-UTF-8, resumes from checkpoint/cursor **exactly once**.
- [ ] **I.** Concurrent human+automation writes: claim fencing, idempotent retry, no interleaving.
- [ ] **J.** Descendant creates new pgrp/session; immediate terminate either kills it or reports it as survivor — "signal delivery alone is not success."
- [ ] **K.** Canonical VEOF vs raw `^D` vs PTY close/hangup are distinguished.

**Definition of done**

- [ ] **DoD-1.** Contract document (behavior/contracts only — **no file paths/line numbers**) expressing all 12 semantics and the minimal shape, versioned, with conformance-test IDs mapped to freeze tests A–K.
- [ ] **DoD-2.** Freeze tests A–K pass live against a neutral fake **AND** real sessiond; results recorded with exact versions.
- [ ] **DoD-3.** Non-Hive consumer demo (generic command, non-agent, non-Hive repo cwd) runs through the frozen boundary — project-agnostic proof.
- [ ] **DoD-4.** "A2 declared unblocked only at freeze; deep A1 qualification continues in parallel."
- [ ] **DoD-5.** Hard principles apply (external research drives; no legacy shims; production-grade; live proof; paired doc-cleanup).

### (3) Current completion state (per the doc's own status line)

> "Status: fully specified; execution awaits user plan approval."

No freeze tests recorded as run in this doc; no evidence table present. Nothing is claimed complete — this is a specification awaiting go-ahead.

### (4) Flags

- **OPEN-USER-RULING — semantic 5 (reap authority architecture).** The doc says "**Choose**: durable per-session monitor remains the vendor's parent and journals wait status (broker restart/adopts the monitor), OR host crash yields typed lost/unknown exit authority + survivor cleanup." *Question for the user:* which reap-authority architecture do we commit to — a durable adoptable monitor process, or typed-loss-on-host-crash? This drives freeze test G and materially changes A2's implementation surface.
- **OPEN-USER-RULING — semantic 8 (TIOCPKT).** "Decide whether TIOCPKT control events are internal or typed control frames." *Question:* are packet-mode control events part of the frozen public contract (typed control frames) or an implementation detail?
- **AC-THIN — semantic 8 backpressure quantities.** The criterion names "bounded credit/ack (or equivalent), journal low/high watermarks… max write/frame sizes" but fixes **no numeric thresholds**, whereas the sibling A1 wire doc pins concrete numbers (128 KiB decoded / 256 KiB control frame). *Question:* should A0 freeze the numeric watermarks/caps, or explicitly delegate them to the wire projection (A1)? As written, freeze test E ("bounded memory") has no pass/fail number.
- **AC-THIN — freeze test E.** "no byte loss, bounded memory, explicit backpressure/gap" — "bounded memory" is unquantified. *Question:* what memory ceiling counts as a pass for the 100 MiB producer case?
- **AC-MISSING — freeze-test-to-semantic coverage.** DoD-1 requires conformance-test IDs mapped to A–K, but semantics **3 (ABA fencing)**, **11 (termination modes/deadline)** and **12 (inspect completeness)** have no dedicated freeze test; they are only partially touched by I, J and G. *Question:* accept partial coverage, or require added freeze tests before declaring the mapping complete?
- **OPEN-USER-RULING — approval to execute.** The status line makes plan approval the sole blocker. *Question:* approve A0 execution as specified?

---

## #3 — M1-A1 · sessiond qualification (+ input wire projection)


Sources: `planning/story-m1-a1-sessiond-qualification.md`, `planning/story-m1-a1-input-wire-options.md`

### (1) Plan summary

A1 is the deep qualification of the real `sessiond` against the A0-facing frozen terminal-host contract, and unlike A0/B1 it is **already substantially executed and landed**. The qualified behavior set establishes launch-as-outcome (a `running` outcome only after the close-on-exec barrier proves replacement, failures reporting failing layer + errno), allowlisted descriptor transfer, revisioned ordered resize with post-set `TIOCGWINSZ` readback, single master/slave PTY creation with session-leader + controlling-terminal + foreground-pgrp + initial-geometry invariants, exact termios profile applied and read back before success, `waitpid`-only exit authority with `ECHILD` reported as unknown rather than fabricated, process-tree termination that routes root waits through the PTY owner, and a production broker/host wire that validates strict frozen claim, input-receipt and resize-receipt projections behind an authenticated exact-locator attachment with domain-transaction idempotency independent of transport request ID. A 20-row live conformance evidence table on macOS 26.3.1 (25D2128), arm64, locked Zig 0.15.2 records all rows as Pass, each with recorded positive controls (mutation-style: removing production `INPUT_SUBMIT` dispatch, or substituting a default termios profile, produced the expected RED, and restoration made all 173 native tests pass). The companion input-wire doc adjudicates how the frozen transactional input operation projects onto the framed protocol; it evaluated three options and **Option 1 was adopted by queen ruling on 2026-07-17** — a single new control type `INPUT_SUBMIT = 0x0305` carrying a strict JSON payload with the frozen `SessionRef`, claim token, transaction ID, idempotency key and a bytes/canonical-EOF/hangup operation union, with results returned through a strictly discriminated shared `APPLIED` response (`resultKind: "input"` vs `resultKind: "resize"`).

### (2) Acceptance criteria checklist

**A. Qualified behavior (each is a distinct frozen invariant)**

- [ ] **Launch is an outcome, not an inferred success.** "A failed replacement reports the failing layer and the operating-system error number. A running outcome is emitted only after the close-on-exec barrier proves replacement."
- [ ] **Descriptor transfer is allowlisted.** "The caller retains its source descriptor, the child receives a duplicate at the declared target, standard streams remain attached to the PTY, and every other inherited descriptor is closed before replacement."
- [ ] **Resize is a revisioned ordered mutation.** "Revisions must increase, input accepted earlier is written before the resize, and success returns the geometry read back from the terminal after the set operation. The receipt does not claim that a foreground application handled `SIGWINCH`."
- [ ] **PTY creation produces one master/slave pair.** "The replacement becomes a new session and process-group leader, receives the slave as all three standard streams and controlling terminal, starts in the foreground process group, and observes the requested initial geometry."
- [ ] **Initial terminal setup applies the exact requested canonical/literal, echo, signal-character, software-flow-control, control-byte, and hangup flags to the slave before replacement.** "It reads those attributes and all four window fields back before launch can report success, and the running evidence carries the real terminal identity and foreground process group."
- [ ] **A process event is notification, not exit proof.** "Exit evidence is authoritative only when the host, as direct parent, obtains the status from `waitpid`. A nonblocking wait distinguishes a running child from an unavailable wait authority; `ECHILD` is reported as unknown rather than fabricated into an exit."
- [ ] **Process-tree termination cannot consume the root child's wait status behind the PTY owner's back.** "Root waits are routed through the owner, and successful immediate termination persists a positive direct-child wait observation."
- [ ] **The production broker dispatches inventory, exact-locator inspection, and termination instead of collapsing those defined operations to not-found.** "Inventory preserves enumeration completeness; registry-only inspection marks unavailable host-owned arbiter and checkpoint facts as partial rather than inventing them; termination reports success only after the registry receives positive host and process-tree readback."
- [ ] **The production host wire validates strict frozen claim, input-receipt, and resize-receipt projections after an authenticated exact-locator attachment.** "A domain transaction ID controls input idempotency independently of the transport request ID, and the advertised decoded-input cap is enforced before any PTY effect."
- [ ] **Input claims distinguish a grant, a denial with the real current owner, and an unavailable arbiter without fabricating ownership.** "Bytes receive an applied receipt only after ordered PTY write and drain; an identical retry replays that receipt without writing twice. Canonical EOF is accepted only when the live terminal attributes make the configured EOF byte meaningful, while hangup closes the real PTY endpoint."
- [ ] **Wire resize applies the requested revision through the PTY owner and returns the actual post-`TIOCSWINSZ` `TIOCGWINSZ` readback.** "An identical transaction replays its receipt without another mutation."

**B. Live conformance evidence rows — all recorded Pass** (environment: "macOS 26.3.1 (25D2128), arm64; locked Zig 0.15.2")

- [x] **B — exec proof.** Nonexistent executable → layer `exec-transition` with `ENOENT` (2); real non-executable file → same layer with `EACCES` (13). "Neither produced a running host, live PID, or open PTY master."
- [x] **C — descriptor transfer.** Pipe declared for target descriptor 9 delivered its payload in the replaced process while the caller's source remained open.
- [x] **C — descriptor hygiene.** An arbitrary descriptor made intentionally inheritable before launch was positively observed absent in the replaced process.
- [x] **D — ordered resize.** Revision 41 applied rows 37, columns 111, both pixel dimensions; independent `TIOCGWINSZ` matched every receipt value; input accepted next preceded revision 42, ordered position increased, replaying revision 42 rejected as stale.
- [x] **A — PTY lifecycle.** Real replacement reported PID = session ID = process-group ID; `TIOCGPGRP` on the live master returned that group; child observed descriptors 0, 1, 2 as terminals; `stty` read back the requested 37-by-111 geometry.
- [x] **Frozen create terminal profile.** Deliberately non-default profile (canonical input, echo, signal chars, software flow control enabled; custom EOF/start/stop bytes; hangup-on-close disabled); independent `tcgetattr` and `TIOCGWINSZ` matched; running readback reported PID = session ID = process-group ID = foreground process-group ID and a real terminal identity.
- [x] **F — notify then reap.** Real `EVFILT_PROC`/`NOTE_EXIT` for a child exiting 23, followed by a separate direct-parent `waitpid` returning the same status → typed exited/reaped evidence.
- [x] **F — lost authority.** Deliberate competing `waitpid` consumed a child exiting 29; PTY owner's wait observed `ECHILD` → unavailable/unknown, "no invented exit code."
- [x] **Termination evidence.** Real provider tree terminated while an unrelated sentinel survived; immutable terminal result reported no survivors and a positive root wait observation.
- [x] **Production broker lifecycle wire.** Framed production-backend connection returned correlated, schema-valid inventory, exact inspection, termination for one admitted generation; repeated against a real recovered sessiond host — exact provider and host PIDs became absent, immutable final evidence remained positive.
- [x] **Resize discriminator promotion.** Formerly expected-failure resize shape discriminator "now runs as an ordinary passing assertion, so a genuine resize receipt/readback regression is a normal suite failure rather than an expected failure or XPASS."
- [x] **Claim wire.** Authenticated real-host attachment acquired a claim, replayed the holder truthfully, denied a competing automation claimant with the live holder token; separate unbound-host control returned unknown with no owner field.
- [x] **Transactional input wire.** Framed byte transaction wrote one line through a real PTY; retry of the same domain transaction under a different transport request ID returned the identical frozen receipt; provider-side file still contained exactly one line after the retry.
- [x] **Resize wire.** Framed resize applied revision 41 to a real PTY, returned rows 37 and columns 111 from post-set terminal readback.
- [x] **EOF and hangup.** Canonical EOF against the real raw-mode provider rejected because the terminal was not canonical, provider remained live; a real PTY accepted hangup only after draining, closed its master, produced direct-child reap evidence.
- [x] **Positive controls recorded.** Focused freeze discriminator step reported 0/4 passing pre-change; live termination test observed lost root wait evidence; removing production `INPUT_SUBMIT` dispatch failed at the expected APPLIED response and restoring it passed; replacing requested attributes with the default profile failed the independent live readback assertion, and restoring it made "all 173 native tests pass."

**C. Input-wire projection acceptance (Option 1, adopted)** — fixed constraints that any projection must satisfy

- [ ] "The frozen terminal-host operation is transactional and idempotent. Its request carries a session reference, claim token, transaction ID, idempotency key, and one of bytes, canonical end-of-file, or hangup. It returns the frozen input receipt."
- [ ] "JSON control payloads are strict. Raw `HUMAN_INPUT` and `AUTOMATION_CHUNK` payloads contain bytes only."
- [ ] "A control frame uses `streamSeq = 0`. Its nonzero header `requestId` is transport correlation only and never substitutes for the domain transaction or idempotency IDs."
- [ ] "An authenticated `HOST_ATTACH` connection selects one exact generation. That transport binding can reject a wrong target, but it does not automatically preserve the session field in the frozen method request."
- [ ] "`RESIZE` needs a correlated `APPLIED` response carrying the frozen resize result. Any other use of `APPLIED` must be a strict discriminated union."
- [ ] **Common claim establishment** — `CLAIM_ACQUIRE` is strict JSON with `schemaVersion: 1`, frozen `session`, `writer`, `kind`, `leaseMilliseconds`, `idempotencyKey`; `CLAIM_RESULT` is a correlated strict JSON response with `schemaVersion: 1` and the frozen `ClaimResult` union; "the host cross-checks the request session against the exact attached generation"; granted returns frozen token/writer/kind/lease expiry; "a denied or unknown result preserves its owner/diagnostic evidence without inventing ownership."
- [ ] **Adopted Option 1 shape** — one new control type `INPUT_SUBMIT = 0x0305` in the unused claim/input range; request has `streamSeq = 0`, the content-sensitive flag, and strict JSON `{schemaVersion: 1, session:{key, incarnation}, claimToken, transactionId, idempotencyKey, operation: {kind:"bytes", encoding:"base64", bytes} | {kind:"canonical-end-of-file"} | {kind:"hangup"}}`.
- [ ] Response reuses the header `requestId`, response/final flags, and the `APPLIED` branch `{schemaVersion: 1, resultKind: "input", receipt: InputReceipt}`.
- [ ] `RESIZE` remains strict JSON with `schemaVersion: 1` and frozen `session`, `window`, `revision`, `idempotencyKey`; its correlated response is the other `APPLIED` branch `{schemaVersion: 1, resultKind: "resize", result: ResizeResult}`.
- [ ] "Identity is explicit: both request payloads carry the frozen `SessionRef`, and the host cross-checks it against the authenticated attached locator."
- [ ] "Raw low-level `HUMAN_INPUT` remains available only for keystroke streaming inside an already-established claim; it is not the frozen transactional operation and cannot produce a frozen receipt by itself."
- [ ] **Size cap:** "The v1 `WELCOME` advertises `maxInputTransactionBytes = 131072` decoded bytes (128 KiB); request metadata and base64 encoding must still fit the 256 KiB control frame."
- [ ] "Larger automation bodies continue to use the separately defined chunked automation transaction rather than this operation."
- [ ] **Upgrade rule:** "If measured product behavior requires larger frozen transactions, adopt the Option 3 chunked upgrade rather than expanding the JSON control frame or silently reinterpreting raw `HUMAN_INPUT`."

**D. Remaining A1 qualification (explicitly still open)**

- [ ] Native neutral `create`.
- [ ] The rest of the frozen control plane — "`create`, `attach`, `resize` and `subscribe` have no handler in `native/sessiond/src/neutral_control_plane.zig`."
- [ ] Attach streaming.
- [ ] Visibility renewal.
- [ ] Broker/host crash and adoption matrices.
- [ ] Bounded journal/replay qualification.

### (3) Current completion state (per the docs' own status lines)

Qualification doc:

> "Status: the contract-freeze-facing minimum, PTY/reap qualification, production lifecycle wire, and frozen claim/input/resize projections have landed. Frozen create schemas have also landed. The frozen native LIST/INSPECT/TERMINATE handlers landed in `719c8e36`, wired against the neutral_host registry with real `waitpid` reap evidence, process-tree targets and live list/inspect projections; that commit deliberately left the legacy create/attach paths in place. Native neutral create, the rest of the frozen control plane (`create`, `attach`, `resize` and `subscribe` have no handler in `native/sessiond/src/neutral_control_plane.zig`), attach streaming, visibility renewal, crash/adoption, and bounded replay qualification remain open."

And the closing section:

> "The next increments must finish native neutral create and the frozen terminate/list/inspect control plane, then wire attach streaming and visibility renewal before exercising broker/host crash and adoption matrices and bounded journal/replay behavior."

Input-wire doc:

> "Status: adopted — Option 1, queen-adjudicated 2026-07-17. This is the normative wire projection."

Net: **partially complete and landing incrementally.** 20/20 recorded evidence rows Pass; six named workstreams remain open. The input-wire decision is **closed** (Option 1), not pending.

### (4) Flags

- **NOTE — the input-wire doc is NOT an open ruling.** Despite presenting three alternatives, it is already adjudicated: "Option 1 is adopted," queen-adjudicated 2026-07-17, "This is the normative wire projection." Options 2 and 3 are retained as recorded rationale only. *No user ruling is required here* — but see the conditional below.
- **OPEN-USER-RULING (conditional, latent) — the 128 KiB cap.** The adopted decision states "The 128 KiB decoded-byte cap is the known v1 limitation" and pre-commits the remedy: adopt Option 3 chunked upgrade if measured product behavior needs more. *Question:* has anyone measured whether real agent/automation input transactions exceed 128 KiB decoded? If the answer is unknown, the trigger for the Option 3 upgrade is undefined and the cap ships unvalidated.
- **AC-MISSING — no acceptance criteria for the six open workstreams.** "Native neutral create," "attach streaming," "visibility renewal," "crash/adoption matrices," and "bounded journal/replay" are named as remaining work but carry **no pass conditions, no evidence rows, and no positive-control requirements** in this doc — unlike every landed item. *Question:* what is the acceptance bar for each of the six, and which A0 freeze tests (G, E, H in particular) do they discharge?
- **AC-MISSING — A0 freeze-test mapping.** The evidence table labels rows with A0 freeze-test letters (A, B, C, D, F) but has **no rows for E (100 MiB / backpressure), G (broker restart / adoption), H (mid-escape / mid-UTF-8 resume), I (concurrent human+automation), J (descendant survivors), or K (VEOF vs raw ^D vs hangup)** — though the "EOF and hangup" and "Termination evidence" rows partially touch K and J. *Question:* is A1 expected to discharge freeze tests E, G, H, I in full, and if so, should they be added as explicitly named evidence rows before A0 can freeze?
- **AC-THIN — `subscribe` has no criteria at all.** It appears once, only in the status line's list of handlers that do not exist. No qualified behavior, no wire projection, no evidence. *Question:* what are `subscribe`'s ordered-event semantics (this is A0 semantic 6 and part of the minimal shape) and who specifies them?
- **NOTE — evidence is single-architecture.** All conformance evidence is "macOS 26.3.1 (25D2128), arm64." *Question:* does A1 require an x86_64 slice (B1 gate 4 does require both arm64 and x86_64)? If sessiond ships universal, the evidence is currently half.

---

## #5 — M1-A3 — Input arbiter live proof: one ordered write path, human priority

**State:** OPEN · **Labels:** `type:build`

**(1) Plan summary.** Milestone M1, track A. Prove invariants **I3/I4**: that `hive-sessiond` is the *only* PTY-master writer, that human and automated bytes converge into a single ordered arbiter, and that the human input claim is acquired **synchronously** and never times out into automation. Scope covers input-claim semantics across typing, paste, IME composition and mouse-report bytes, plus blocking automated delivery while a human claim is active and a bounded reconnect window on disconnect. Depends on M1-A2; parallel with A4 and B2.

**(2) Acceptance criteria checklist.** The body has exactly one acceptance sentence under "Live-proof acceptance" — decomposed, preserving verbatim wording:
- [ ] "Live interleaving drill: human types while automation delivers"
- [ ] "byte order and claim transitions recorded and correct"
- [ ] "no automation write lands inside a human composition"
- [ ] R3 addendum gating: "closes only after A2 (production arbiter proof); native-arbiter conformance work may start earlier"
- [ ] HARD PRINCIPLES, stated as applying and to be restated in DoD at refinement: "external research drives"; "external citations required"; "no legacy shims"; "production-grade"; "PROJECT-AGNOSTIC (works on any repo/stack, no Hive-specific assumptions)"; "paired SPEC + doc-cleanup task, docs describe behavior/contracts, never file paths or line numbers"; "LIVE PROOF to close"

**(3) Completion state.** No status lines, no checkboxes, no percentage in the body. The only progress-bearing text is the R3 addendum, which is a *gating* statement, not a status. Issue state: **OPEN**. Completion per the body: **unstated / zero recorded**.

**(4) Flags.**
- **AC-THIN.** The criteria are a single prose sentence. Not executable as written. Open questions the user must answer: *What is the pass/fail record format for "byte order and claim transitions recorded and correct" — a transcript, a manifest entry, an evidence file?* *What counts as "a human composition" boundary for the no-write-inside assertion — IME marked-text range only, or any keystroke burst?* *How many interleaving runs, and does this need a negative control (an arbiter mutation that makes the drill go RED)?*
- **AC-MISSING (partial, structural).** Per the carried context and verified above: **there is no `planning/story-m1-a3-*.md`.** Story docs exist for A0, A1, B1, B2, C1, C2 but not A3. A3's entire elaboration outside this issue is one line — `planning/backlog-outline.md:37`: *"A3 Input arbiter live-proof: one ordered write path, human input claim acquired synchronously, no automation timeout steal (invariants I3/I4)."* A live-proof invariant story is carrying I3/I4 with no refinement artifact. **OPEN-USER-RULING:** *Does A3 get a story doc + DoD refinement before execution, or is the issue body itself accepted as the specification?*

---

## #6 — M1-A4 — Close, reconnect, and containment live proof

**State:** OPEN · **Labels:** `type:build`

**(1) Plan summary.** Milestone M1, track A. Prove invariant **I2**: a live terminal is always user-known; close/quit terminates the *exact generation* with positive readback; renderer loss yields bounded replay and never a hidden survivor. Scope: visibility lease; renderer crash → bounded replay; Workspace quit → verified termination of every provider process tree; stale locator returns a typed error (invariant **I5**). Depends on M1-A2; parallel with A3 and B2.

**(2) Acceptance criteria checklist.** One "Live-proof acceptance" sentence:
- [ ] "Kill renderer / kill Workspace / kill broker drills on live sessions with real child process trees" — three distinct drills
- [ ] "ps-verified zero survivors"
- [ ] "replay byte-identical within the bounded window"
- [ ] In-scope but *not* mirrored in the acceptance sentence: "Stale locator returns typed error (I5)"
- [ ] R3 addendum gating: "needs A2 + B2 (Workspace visibility/reconnect/quit proof requires the integrated pane); host-only crash proofs may run earlier"
- [ ] HARD PRINCIPLES (identical block to #5)

**(3) Completion state.** No status lines or checkboxes. Issue state: **OPEN**. Completion per the body: **unstated / zero recorded**.

**(4) Flags.**
- **AC-THIN.** *What is "the bounded window" numerically — is the bound a spec value or per-run measured?* *"Byte-identical" against what reference capture?* *Does the I5 typed-error requirement need its own proof line, given it appears in Scope but is absent from the acceptance sentence?*
- **AC-MISSING (structural).** No `planning/story-m1-a4-*.md`; sole elaboration is `planning/backlog-outline.md:38`: *"A4 Close/reconnect semantics live-proof: visibility lease, renderer crash → bounded replay; Workspace quit → verified termination of every provider tree (I2)."* Same ruling needed as #5.
- **OPEN-USER-RULING.** *Is the I5 stale-locator typed error in or out of A4's acceptance?* — as written it is in Scope but unproven by the stated acceptance.

---

## #7 — M1-B1 · Qualify GhosttyKit build chain + manual-I/O bridge (Hive-owned fork contract)


Sources: `planning/story-m1-b1-ghosttykit-qualification.md`, `planning/gate9-action-security-matrix.md`, `planning/gate9-sink-registry-migration.md` · Board item `PVTI_lAHOBUNSMM4BdtCrzgzO08U`

### (1) Plan summary

B1 qualifies, end to end, Hive's seven `hive_ghostty_*_v1` exports as a **Hive-owned fork contract** — necessary because at the pinned commit the public `ghostty.h` "explicitly says it is not yet a general-purpose embedding API and its only consumer is Ghostty's macOS app," exposing process-owning surface creation and rendering/input/callbacks but "NO manual-output-ingestion, output-sequence, or checkpoint API." The doc is emphatic about what may not count as evidence: "'libghostty embeds' is not proof; Ghostling is test inspiration, not evidence" (upstream Ghostling is a minimal unaudited demo over libghostty-vt, which deliberately supplies neither renderer nor window/session integration), and per DoD-4, "in-tree code is candidate, never evidence." Scope boundary: B1 "ends with a qualified manual terminal engine/view bridge and its conformance corpus; it does NOT absorb M2 provider policy — vendor CLIs appear only as black-box terminal-compatibility probes." The work is organized as 10 P0 qualification gates (manual-mode isolation, terminal-generated replies, threading/lifetime, ABI/build/ship, ordered output, checkpoint/restore, rendering/geometry/GPU, input/IME/mouse, action/security, accessibility/operability), an A–K live-proof matrix, an indivisible-version-tuple upgrade/rollback contract, and a non-blocking Gate 6 follow-up backlog. Gates 3, 7 (automatable slice), 9 and the engine-scope half of 10 have recorded live proof; the renderer-dependent halves are B2-blocked. Gate 9 in particular has moved from design to implementation: the blanket-false action callback is gone, replaced by `HiveGhosttyActionPolicy` with typed per-tag verdicts and an exhaustive compile-time switch against the pinned header (66 tags, counted live rather than trusting a number), plus B-class binding stripping via `keybind = clear`, OSC 52 write/read denial, a SECURE_INPUT structural-unreachability record, and a static no-privileged-opener scan.

### (2) Acceptance criteria checklist

**Framing constraints (what B1 may NOT assume)**

- [ ] The pinned `ghostty.h` "is not yet a general-purpose embedding API and its only consumer is Ghostty's macOS app" — no general-embedding assumption permitted.
- [ ] There is "NO manual-output-ingestion, output-sequence, or checkpoint API" upstream; the seven exports are a Hive-owned fork contract requiring end-to-end qualification.
- [ ] "'libghostty embeds' is not proof; Ghostling is test inspiration, not evidence."
- [ ] Boundary respected: B1 "does NOT absorb M2 provider policy — vendor CLIs appear only as black-box terminal-compatibility probes."

**Gate 1 — Manual-mode isolation**

- [ ] Creating a manual surface "starts no child, shell, PTY, process reader/writer thread, or hidden command."
- [ ] `cwd`/`command`/`env`/`initial_input` "are rejected or inert by contract."
- [ ] "Only ordered `process_output` mutates remote output state; only the write callback emits terminal-generated bytes toward the host."
- [ ] Live proof is "process tree + fd inventory before/create/use/free — **not** exit-code assertions."
- [ ] "Stock pid/tty/process-exit queries in manual mode are defined unsupported/safe, never fabricated."

**Gate 2 — Terminal-generated replies** ("likely current-candidate P0")

- [ ] Feed DA/DSR/DECRQSS/XTGETTCAP/window-size/color/enquiry/XT-version and other response-producing controls; "exact bytes reach the write callback **exactly once, in order**."
- [ ] Address the KNOWN SNAPSHOT EVIDENCE: "the present patch sets several handler effects (`device_attributes`, `enquiry`, `size`, `write_pty`, `xtversion`) to null — a TUI can paint yet silently fail protocol negotiation." This is "snapshot evidence, not architectural truth; B1 must catch it."
- [ ] Include vttest **and** captured vendor startup/query corpora.
- [ ] "State an explicit OSC 52 clipboard read/write policy."

**Gate 3 — Threading, event loop, lifetime**

- [ ] Freeze main-thread requirements for AppKit/Metal and "every app/surface entry point."
- [ ] "Define whether output ingestion may arrive off-main and ownership/serialization if so."
- [ ] Prove: wakeup callback schedules `ghostty_app_tick`.
- [ ] Prove: callback payloads copied before return.
- [ ] Prove: callbacks cannot re-enter destruction.
- [ ] Prove: no callback after free.
- [ ] Prove: app/config/surface free ordering.
- [ ] Prove: multiple surfaces.
- [ ] Prove: rapid create/free.
- [ ] Prove: close while callback/draw/output in flight.
- [ ] Motivation to discharge: "Current Swift snapshot's no-op wakeup callback and always-false action callback make these mandatory."

**Gate 4 — ABI/build/ship**

- [ ] Pin upstream commit + tree, patch hash, Zig/toolchain, deployment target; reproducible clean-patch build.
- [ ] C/Zig/Swift compile **and** runtime assertions for struct size/alignment, enum values, calling convention, symbol signatures.
- [ ] "Exact seven-symbol export whitelist with build-id rejection."
- [ ] "arm64+x86_64 slices, codesign/notarization, bundled licenses, no dependency on user-installed Ghostty/Zig, no accidental dynamic libraries."
- [ ] "Every upstream/toolchain change re-runs the full corpus; rollback documented."

**Gate 5 — Ordered output**

- [ ] Arbitrary chunk boundaries across UTF-8/graphemes and CSI/OSC/DCS/APC; "empty/null input defined."
- [ ] "Exact gap/overlap/duplicate/conflicting-byte/sequence-overflow semantics; failures never poison later calls or retain locks."
- [ ] "Ingestion serialized with draw/export/restore; stress large streams and concurrent callers even if concurrency is rejected."

**Gate 6 — Checkpoint/restore**

- [ ] Format "opaque, versioned, build-bound, bounded."
- [ ] Captures: primary/alt screen, scrollback, cursor, modes, tabs, colors, selection, title/pwd, partial UTF-8/parser state, pending terminal replies, Kitty keyboard/mouse/bracketed-paste/synchronized-output state, "image state if supported."
- [ ] "Export atomic at `through_seq`, deterministic, allocator ownership/alignment explicit."
- [ ] "Reject wrong build/truncation/corruption/malicious sizes; fuzz import."
- [ ] "Restore into a fresh surface produces the correct first frame, emits no spurious input/write/event, then accepts exact replay."
- [ ] "Prove geometry/config reconciliation and **FULL APP RESTART**, not merely same-process round-trip."
- [ ] **Architecture binding:** checkpoints are architecture-bound because the opaque payload includes raw `Page.memory` whose page-rounded layout differs between macOS arm64 and x86_64. "The layout fingerprint therefore requires equality between lib-vt and GhosttyKit within each architecture and requires an `ENGINE_MISMATCH` across architectures."
- [ ] "Production qualification authors and restores the complete byte-split corpus on **both** native slices; sessiond must hand a checkpoint only to a same-architecture surface."
- [ ] **Accepted Option D build consequence (recorded, intentional):** "`tmux_control_mode` is decoupled from oniguruma and is disabled in the embedded terminal… A DCS request to enter tmux control mode is therefore ignored instead of activating that parser mode. Hive drives tmux through its host/CLI integration and does not depend on embedded terminal tmux-control-mode parsing, so this capability change is intentional and accepted."

**Gate 7 — Rendering/geometry/GPU**

- [ ] Real NSView/CAMetalLayer lifecycle.
- [ ] Content scale/display id/drawable size updated on monitor moves.
- [ ] "Use Ghostty's reported cell geometry, **never guessed cells**."
- [ ] Zero/minimized/occluded sizes; Retina↔non-Retina; live resize; sleep/wake; GPU-unhealthy/device recreation; idle CPU/frame pacing; "no double draw."
- [ ] Motivation to discharge: "Snapshot guesses rows/columns, initializes scale once, and can draw from both scheduling and draw(_:) paths — B1 makes those failures impossible."

**Gate 8 — Input/IME/mouse**

- [ ] "Golden-test Ghostty's **exact** physical-key/modifier mapping: consumed mods, repeats/releases, left/right modifiers, unshifted codepoint, dead keys/composition."
- [ ] "Prevent key+text double injection."
- [ ] "Compare Kitty keyboard bytes against the same pinned Ghostty app."
- [ ] "Full NSTextInputClient using `ghostty_surface_ime_point`; live CJK, dead keys, emoji/ZWJ, RTL composition."
- [ ] "All mouse buttons, scroll/momentum, pressure/capture, scaled coordinates."
- [ ] "Focus/occlusion, paste/bracketed paste, selection/copy/search, async clipboard completion."
- [ ] Motivation to discharge: "Snapshot's loose modifier mapping, raw macOS keyCode, zero unshifted/consumed fields, key+text double-send, placeholder IME ranges, and missing scroll are exactly why header compilation is insufficient."

**Gate 9 — Action/security** (expanded from the two gate-9 docs)

- [ ] "Exhaustive action-callback matrix: handled, deliberately denied with visible behavior, or proven unreachable — **never blanket false**."
- [ ] Cover title/pwd, bell, close request, notifications, URLs, clipboard/OSC52, secure input, mouse shape/visibility.
- [ ] **Security invariant (story:21):** "untrusted terminal bytes cannot trigger privileged host actions without policy/user gesture." For a manual surface, "'untrusted bytes' enter ONLY via `hive_ghostty_surface_process_output_v1`; 'user gesture' enters via key/mouse/IME APIs which Hive's own view layer calls."
- [ ] Classification is against **every** `ghostty_action_tag_e` at the pinned header, into exactly three verdicts — HANDLED, DENIED (deliberate, with visible behavior), or UNREACHABLE (proven, not assumed) — "and names the positive control for each class."
- [ ] Tag-count discipline: "the 'seventy tags' below was a pre-implementation estimate; the pinned enum has 66, and the completeness test **counts the header live** rather than trusting either number."

  *A-class (byte-triggerable — the security surface), per-tag:*
- [ ] `SET_TITLE` — HANDLED (event) via `HIVE_GHOSTTY_EVENT_TITLE`; "action_cb path must be verified duplicate-or-dead — if both fire, keep the effects path and return false with a comment, else handle here."
- [ ] `PWD` — HANDLED (event), `HIVE_GHOSTTY_EVENT_PWD`.
- [ ] `RING_BELL` — HANDLED (event), `HIVE_GHOSTTY_EVENT_BELL`.
- [ ] `DESKTOP_NOTIFICATION` — DENIED (policy). "OSC 9/777 from agent output must not post macOS notifications without Hive-level policy." Decision recorded: deny silently at bridge; Hive's app layer owns notification policy from TITLE/BELL events. **Control:** "OSC 9 burst → zero notifications posted, action_cb observed invoked."
- [ ] `COLOR_CHANGE` — DENIED (inert). OSC 4/10/11/12 palette changes affect rendering internally; the action is a host NOTIFICATION only; "returning false is inert-by-contract; verify rendering still applies (gate-7 owns rendering fidelity)."
- [ ] `PROGRESS_REPORT` — DENIED (inert). ConEmu OSC 9;4 — "no Hive UI consumer in B1."
- [ ] `MOUSE_SHAPE` / `MOUSE_VISIBILITY` / `MOUSE_OVER_LINK` — HANDLED (B1: deny-visible). "B1 ships deny-with-comment (no cursor change) + M-track item; control proves the callback fires with the right tag (so wiring exists when handled)."
- [ ] `OPEN_URL` — DENIED (gesture-gated). "Reachable only via click on hyperlink (gesture) but the URL content is byte-controlled. Deny at bridge in B1: **no NSWorkspace.open ever**. Control: synthetic click on OSC-8 link → action observed, no browser launch."
- [ ] `COMMAND_FINISHED` / `SHOW_CHILD_EXITED` — UNREACHABLE (manual mode); "prove by grep + test: feeding OSC 133 prompt marks must not fire SHOW_CHILD_EXITED." **Explicit reclassification:** "COMMAND_FINISHED (OSC 133;D) IS byte-triggerable → reclassify DENIED (inert) with control."

  *B-class (gesture/binding-triggered only) — verdict DENIED (deliberate):*
- [ ] The full enumerated set: QUIT, NEW_WINDOW, NEW_TAB, CLOSE_TAB, NEW_SPLIT, CLOSE_ALL_WINDOWS, TOGGLE_MAXIMIZE, TOGGLE_FULLSCREEN, TOGGLE_TAB_OVERVIEW, TOGGLE_WINDOW_DECORATIONS, TOGGLE_QUICK_TERMINAL, TOGGLE_COMMAND_PALETTE, TOGGLE_VISIBILITY, TOGGLE_BACKGROUND_OPACITY, MOVE_TAB, GOTO_TAB, GOTO_SPLIT, GOTO_WINDOW, RESIZE_SPLIT, EQUALIZE_SPLITS, TOGGLE_SPLIT_ZOOM, PRESENT_TERMINAL, FLOAT_WINDOW, INSPECTOR, SHOW_GTK_INSPECTOR, RENDER_INSPECTOR, OPEN_CONFIG, RELOAD_CONFIG, UNDO, REDO, CHECK_FOR_UPDATES, START_SEARCH, END_SEARCH, PROMPT_TITLE, SET_TAB_TITLE, COPY_TITLE_TO_CLIPBOARD, SHOW_ON_SCREEN_KEYBOARD, READONLY.
- [ ] Rationale: "Hive owns window/tab/split management via its own Workspace chrome; Ghostty bindings for these are surplus."
- [ ] "Denial is VISIBLE by contract." **Control:** "press cmd+N-class binding, assert no NEW_WINDOW side effect AND no bytes written."
- [ ] *Resolved during implementation:* the doc flagged "consider config-stripping instead (empty keybinds in the manual config) to make these UNREACHABLE-by-construction — decision point for the implementation round; stripping is stronger and testable." Per the status header, "the B-class strip landed as `keybind = clear`."

  *C-class (engine housekeeping) — verdict mixed:*
- [ ] SIZE_LIMIT, RESET_WINDOW_SIZE, INITIAL_SIZE, CELL_SIZE, SCROLLBAR, RENDER, RENDERER_HEALTH, QUIT_TIMER, CONFIG_CHANGE, KEY_SEQUENCE, KEY_TABLE, SECURE_INPUT, SELECTION_CHANGED, SEARCH_TOTAL, SEARCH_SELECTED.
- [ ] RENDER / CELL_SIZE / SCROLLBAR / RENDERER_HEALTH are rendering-adjacent — "gate 7 owns; bilal's view may already consume geometry via other APIs — **verify no double-path**."
- [ ] `SECURE_INPUT` — "DENIED in B1 (Hive's agent terminals are not password UIs; document; **revisit for human attach mode — flag to queen**)."
- [ ] All others — DENIED (inert notification).
- [ ] **B2.4 clarification (2026-07-19):** "SEARCH_TOTAL and SEARCH_SELECTED remain engine-inert and the callback still returns false. Their value-copied payloads may feed Hive's own lifetime-gated search overlay as observe-only presentation state; this does not authorize an engine action or privileged sink. Local selection is also pinned with `copy-on-select = false`, so only an explicit host copy gesture may request a clipboard write."

  *Implementation-shape criteria:*
- [ ] Replace the blanket closure with a `hiveGhosttyActionCallback` trampoline switching on tag; emit A-class events (or defer to the effects path where already covered); "returns false for every DENIED tag through an **exhaustive Swift switch (no `default:`)** so a NEW upstream tag is a COMPILE error, not a silent false — that is the 'never blanket false' mechanical guarantee."
- [ ] Control (a): untrusted-bytes matrix — "one test per A-class tag feeding the triggering sequence, asserting the observable (event emitted / nothing privileged happened) **AND** that the callback genuinely fired (spy seam like `tickOverride`)."
- [ ] Control (b): binding-denial control per B-class representative.
- [ ] Control (c): exhaustiveness control = the compile-time switch.
- [ ] **OSC 52 policy (story:14):** "write DENIED (clipboardWrite effect denies; CLIPBOARD_DENIED event visible) + read DENIED (`read_clipboard_cb` returns false). Controls exist partially in gate-2 corpus; **add the read side**."

  *Gate 9 → Gate 3 sink migration (pre-drafted; apply at douglas's integration turn):*
- [ ] Goal (queen-endorsed): "one routing path — my Gate-9 notification sink rides `GhosttySurfaceCallbackRegistry` + `BridgeCallbackContext`'s `acceptingCallbacks` execution-time gate, replacing my private `actionRegistry` one-for-one." Public API `GhosttyManualSurface.onActionNotification` and all Gate-9 test semantics "stay unchanged (duncan's Gate 10 code needs no edits)."
- [ ] Precondition: "Written 2026-07-18 against dominic's reviewed pin `e6d5413c`, BEFORE Gate 3 landed. **Verify line-level details against the LANDED code at apply time**; the shapes below were read from the pin, not guessed."
- [ ] Step 1 — `CallbackContext.swift`: add an action-notification channel "mirroring `onRendererHealth`/`enqueueRendererHealth` **EXACTLY** (same setter gating, same `main.async` + recheck body)": private `actionNotificationHandler`, public gated `onActionNotification`, and `enqueueActionNotification(_:)`.
- [ ] Step 2 — `GhosttySurfaceCallbackRegistry`: add `enqueueActionNotification(_ note:for surface:)` mirroring `enqueueRendererHealth`.
- [ ] Step 3 — `ManualSurface.swift`: DELETE the private plumbing (`actionRegistry`, `actionRegistryLock`, `WeakSurfaceBox`, `deliverActionNotification`, the init registration block, the `free()` deregistration block); `HiveGhosttyActionPolicy.notifySurface` becomes the registry call, "keep the `target.tag == GHOSTTY_TARGET_SURFACE` guard."
- [ ] Step 4 — keep `GhosttyManualSurface.onActionNotification` as a forwarding computed property over `callbackContext.onActionNotification` "so duncan's `surface.onActionNotification = { ... }` is source-stable."
- [ ] Step 5 — re-verify three safety equivalences with the EXISTING tests, no rewrites expected: queued-before-free ordering ("free() must reach `beginTeardown()` (admission false) before the drained closure runs → note dropped. If dominic's free() orders unregister/beginTeardown differently than assumed, **the test tells us — do not weaken the test to fit**"); after-free (registry unregistered → context lookup nil → drop); handle-value reuse (resolve the CONTEXT at enqueue and recheck THAT context's admission — "equivalent to my identity compare; no extra code needed").
- [ ] Step 6 — run "full workspace suite + the Gate-9 mutation replays (registration disabled → carrier tests RED; `forbiddenOpeners` emptied → scan RED)."
- [ ] Step 7 — doc-comment amendment (queen ruling `c1784ed2`, same edit): `HiveGhosttyActionNotification`'s comment currently tells consumers to pull selection via `readSelection()` on `.selectionChanged`; for ACCESSIBILITY consumers that is superseded — "selection range/text must come from the atomic semantic snapshot (`hive_ghostty_surface_semantic_snapshot_v1`, duncan's ruled Gate-10 surface) so it cannot tear against text/cursor/viewport; the notification is strictly the async-main invalidation signal. `readSelection()` stays valid for non-tree consumers. Reword the comment accordingly; **do not remove the API**."

**Gate 10 — Accessibility + operability**

- [ ] "Neither `ghostty.h` nor Ghostling supplies Hive's AppKit accessibility contract: live VoiceOver + Accessibility Inspector proves semantic rows/text, cursor, selection, scroll changes, announcements."
- [ ] "Instruments leak/UAF stress; bounded scrollback/memory."
- [ ] "Main-thread latency under multi-pane 100 MiB output, resize, attach, restore."

**Gate 4 upgrade and rollback contract**

- [ ] "The shippable Ghostty fork is one indivisible version tuple: the pinned upstream commit and tree, the ordered patch series and its digest, the public and bridge ABI digests, the exact seven-symbol allowlist, the Zig archives, the Apple and Swift toolchain, and the deployment target."
- [ ] "An upgrade or rollback must select a previously qualified tuple **as a whole**. Mixing an upstream snapshot from one tuple with patches, headers, symbols, or a toolchain from another is not a rollback and **must be rejected before building**."
- [ ] Rollback procedure: restore the selected upstream snapshot, apply that tuple's patches in recorded order, "verify that both the unpatched and patched tree identities match the tuple."
- [ ] "Provision the recorded toolchain from its checksummed archives into the project-local cache; a user-installed Ghostty or Zig is **never** a fallback."
- [ ] "Build a fresh artifact from the reconstructed tree and verify that its recorded source identity matches the rollback tuple **before any surface is created**."
- [ ] "Preserve the seven exported version-one entry points and their behavior."
- [ ] "Checkpoints remain build- and architecture-bound: accept one only when its engine identity and architecture match the rebuilt artifact, otherwise reject it and recover by replaying the session into a fresh surface rather than translating the checkpoint."
- [ ] Ship eligibility: "the rollback is eligible to ship only after the complete qualification corpus has been rerun against the rebuilt tuple," including "reproducible clean builds; C, Zig, and Swift ABI assertions; both architecture slices; the exact export allowlist; foreign-build rejection; signing and notarization; license and dependency inspection; and every behavioral gate affected by the restored patches."
- [ ] "Evidence from a newer tuple cannot qualify an older one."
- [ ] "Any later change to the upstream pin, patch contents or order, ABI inputs, toolchain, or deployment target creates a new tuple and invalidates the prior attestation until the full corpus is rerun."

**Non-blocking Gate 6 follow-up backlog** (explicitly non-blocking, but each is a distinct open item)

- [ ] **Fingerprint completeness A:** "cross-architecture `engineBuildId` separation currently rests solely on `page_size_min`; `cpu.arch` is absent from the fingerprint. Close by folding the architecture into the fingerprint and proving the two architecture IDs still differ when `page_size_min` is held equal."
- [ ] **Fingerprint completeness B:** "the fingerprint type list is hand-enumerated with no compile-time coupling to the serializer, creating drift risk. Close with a test or single source of truth that fails when a serialized type is not fingerprinted; **manually adding today's types is not sufficient closure**."
- [ ] **CI wiring C:** "the exhaustive 187-restore release lock runs only for production builds. Confirm, by reading CI configuration, that CI invokes that production-gated path or calls the release lock directly. This is a verification task, **not authorization to ungate an intentionally expensive check**."
- [ ] **Advisory CH (corruption hardening), pre-existing — NOT introduced by Option D:** "verify the lead that enum decode and `Page` interior offsets lack range validation. This is not yet an established defect… If source verification confirms the lead, close by range-validating decoded enums and checking interior offsets against page memory bounds so corrupt input returns an invalid-checkpoint error rather than reaching illegal behavior."

**Live-proof matrix A–K**

- [ ] **A** no-hidden-process/fd inventory
- [ ] **B** generated-reply corpus
- [ ] **C** every chunk boundary/order fault
- [ ] **D** checkpoint every split/malformed/restart case
- [ ] **E** lifetime/thread races
- [ ] **F** multi-display geometry/scale
- [ ] **G** keyboard+IME+mouse+paste goldens
- [ ] **H** action/OSC security
- [ ] **I** GPU/sleep/occlusion/perf
- [ ] **J** VoiceOver
- [ ] **K** "real Claude, Codex, and Grok interactive sessions (black-box compatibility probes only)"

**Definition of done**

- [ ] **DoD-1.** "All 10 gates pass live with recorded evidence (exact corpus/versions/results); the A–K matrix green, K on **all three** vendor TUIs."
- [ ] **DoD-2.** "The seven-symbol fork contract documented behaviorally (no file paths/line numbers) and versioned; ADR-0002 patch budget respected; upgrade/rollback procedure recorded."
- [ ] **DoD-3.** "Snapshot-evidence defects (null reply handlers, guessed geometry, key+text double-send, placeholder IME) either fixed and re-proven or shown already-absent — **never assumed fixed**."
- [ ] **DoD-4.** "Hard principles apply (in-tree code is candidate, never evidence; external research drives; live proof; paired doc-cleanup)."

### (3) Current completion state (per the docs' own status lines)

Main story doc header:

> "Status: fully specified; execution awaits user plan approval."

Per-gate status lines nonetheless record substantial landed work:

- **Gate 3** — "Status 2026-07-19: live proof recorded — `raw/qualification/ghostty-b1-gate3-lifetime`, runner `scripts/qualify-ghostty-gate3.sh`, prose `workspace/docs/ghostty-gate3-lifetime-live-proof.md`." New C-ABI probe `GhosttyGate3Probe` covering wakeup→deferred tick, callback-payload lifetime, no-callback-after-free, surface→app→config free ordering, four concurrent surfaces, fifty create/free cycles, close-while-output/draw-in-flight; host scope re-runs the 21-test HiveTerminalKit gate 3 corpus. "Both scopes run under AddressSanitizer and ThreadSanitizer: zero address reports, zero data races." The runner "first binds the exercised binary to this pin cryptographically, failing closed: all 16 `artifact-manifest.json` source/toolchain identity fields must equal `native/toolchain-lock.json`, and the macOS library's actual sha256 must equal the digest the manifest records for it." "Ten positive controls all bite… including the direct closure of cross-vendor review finding F1." Three findings recorded rather than smoothed over. "AppKit/Metal main-thread requirements under a real renderer remain B2-renderer-blocked and are qualified with gate 7."
- **Gate 7** — "Status 2026-07-19: automatable physical slice attached — `raw/qualification/ghostty-b1-gate7-physical`… Power Profiler is a **measured negative control** (real non-zero exit+stderr in the energy summary, not prose-only)… GPU-fault honesty (host-contract green; hardware fault OPEN). Prior hold rows **Instruments minimized/after-wake** and **ASAN multi-surface/churn** restored as explicit OPEN (not silently narrowed). Human dual-display + sleep/wake PENDING slots remain. **HOLD for hester delta-verify of F-fixes then queen-cleared land** of automatable slice with PENDING_HUMAN slots intact."
- **Gate 9** — "Status: IMPLEMENTED as of 2026-07-18. The blanket false is gone: the runtime config routes through `HiveGhosttyActionPolicy` (typed per-tag verdicts, exhaustive against the pinned header at test time), the B-class strip landed as `keybind = clear`, and this increment added the non-action runtime-callback matrix (close/clipboard probes), the OSC 52 write/read layer proofs, the SECURE_INPUT structural-unreachability record, the static no-privileged-opener scan, and the observe-only SELECTION_CHANGED/SCROLLBAR notification carrier for Gate 10. The authoritative record of every disposition + its control is `raw/qualification/ghostty-b1-actions/dispositions.md`."
- **Gate 9 sink migration** — "Gate 9 → Gate 3 sink migration (**pre-drafted; apply at douglas's integration turn**)." Not yet applied.
- **Gate 10** — "Status 2026-07-18: the engine-scope slice of this gate is delivered — the seventh export, `hive_ghostty_surface_semantic_snapshot_v1`… qualified for ABI, caller-owned single allocation, no-torn-reads consistency, and sanitizer cleanliness with recorded evidence (`raw/qualification/ghostty-b1-gate10-snapshot`). The renderer-side proof — live VoiceOver + Accessibility Inspector, Instruments leak/UAF stress, multi-pane main-thread latency, and DoD row K on the vendor TUIs — **remains open: it is blocked on the B2 renderer wiring** and is qualified in the later AppKit slice of Gate 10."
- **Gates 1, 2, 4, 5, 6, 8** — no status lines; Gate 6 carries an "Accepted Option D build consequence" and a four-item non-blocking backlog implying substantial work has occurred, but no completion claim is recorded in this doc.

Net: the header ("execution awaits user plan approval") is **contradicted by the per-gate status lines**, which record landed live proof for gates 3, 7 (partial), 9, and 10 (engine scope). See flags.

### (4) Flags

- **OPEN-USER-RULING — the header status is stale and self-contradictory.** The doc says "execution awaits user plan approval" while four gates record 2026-07-18/19 landed live proof. *Question:* is B1 approved-and-in-flight (in which case the header must be corrected), or was some of this work done ahead of approval and needs retroactive ratification? The approval package should not carry a header that misstates the milestone's real state.
- **OPEN-USER-RULING — Gate 7 is under an explicit HOLD.** "HOLD for hester delta-verify of F-fixes then queen-cleared land of automatable slice with PENDING_HUMAN slots intact." *Question:* clear the hold and authorize landing the automatable slice with PENDING_HUMAN slots left open, or require the human slots filled first?
- **OPEN-USER-RULING — Gate 7 human-only evidence.** "Human dual-display + sleep/wake PENDING slots remain," and GPU hardware-fault honesty is "OPEN." These cannot be automated from an agent shell. *Question:* who performs the dual-display, sleep/wake, and GPU-fault runs, on what hardware, and by when? Without an owner, DoD-1 ("all 10 gates pass live") cannot close.
- **OPEN-USER-RULING — Gate 7 restored OPEN rows.** "Prior hold rows **Instruments minimized/after-wake** and **ASAN multi-surface/churn** restored as explicit OPEN (not silently narrowed)." *Question:* are these in scope for B1 closure or deferred?
- **OPEN-USER-RULING — SECURE_INPUT policy for human-attach mode.** Listed verbatim under "Open decisions for queen": "SECURE_INPUT policy for future human-attach mode." B1 ships DENIED on the rationale that "Hive's agent terminals are not password UIs," but the doc explicitly flags it for revisit. *Question:* is DENIED acceptable permanently, or must human-attach mode carry a different verdict — and if so, does that verdict belong in B1's frozen matrix or a later story?
- **OPEN-USER-RULING (likely resolved — confirm) — DESKTOP_NOTIFICATION disposition.** Listed under "Open decisions for queen": "DESKTOP_NOTIFICATION: bridge-deny (proposed) vs event-surface for Hive app-layer policy." The A-class table records the proposal as decided ("Decision: deny silently at bridge, Hive's app layer owns notification policy from TITLE/BELL events") and the status header says the matrix is IMPLEMENTED. *Question:* confirm bridge-deny is the final ruling and strike this from the open-decisions list — as written the doc holds both a decision and an open question on the same tag.
- **OPEN-USER-RULING (resolved by implementation — confirm) — B-class mechanism.** Listed under "Open decisions for queen": "B-class: deny-at-callback vs strip-bindings-from-config (stronger)." The status header reports "the B-class strip landed as `keybind = clear`," i.e. the stronger option was taken. *Question:* ratify config-stripping as the adopted mechanism and close this decision. Note the consequence: stripping makes B-class **UNREACHABLE-by-construction** rather than DENIED, which changes their verdict classification and therefore what the positive control must assert — the doc's B-class control text ("press cmd+N-class binding, assert no NEW_WINDOW side effect AND no bytes written") was written for the deny-at-callback path and asserts *no bytes written*, whereas under stripping "binding lookup misses → keys encode normally," i.e. bytes **are** written. **These are contradictory.** *Question:* which assertion is correct post-strip?
- **AC-MISSING — no status or evidence for Gates 1, 2, 4, 5, 6, 8.** Six of ten gates carry no completion state at all. Gate 2 is flagged as "likely current-candidate P0" with a named live defect (five null handler effects), and Gate 8 has four named snapshot defects, yet neither records proof or disproof. *Question:* what is the actual state of gates 1, 2, 4, 5, 6, and 8, and can the approval package proceed without it?
- **AC-MISSING — DoD-3 has no per-defect closure record.** DoD-3 requires the four named snapshot-evidence defects (null reply handlers, guessed geometry, key+text double-send, placeholder IME) be "either fixed and re-proven or shown already-absent — never assumed fixed," but the doc records no disposition for any of the four. *Question:* require a per-defect disposition table (as Gate 9 produced in `dispositions.md`) before DoD-3 can be checked?
- **AC-THIN — Gate 3 self-reported coverage gaps.** Three findings are recorded: "the host corpus cannot witness deletion of the real `ghostty_app_tick` call (every test runs through the `tickOverride` seam, so only the probe covers it)"; "the no-delivery-after-free guarantee has two independent mechanisms so no single-line control can bite"; and "ThreadSanitizer reports one benign never-joined thread from `ghostty_init`." *Question:* accept all three as recorded residual risk, or require closure (e.g. a two-line mutation for the double-mechanism case, and a TSan suppression with justification for the `ghostty_init` thread)?
- **AC-THIN — the sink migration is drafted against a pre-Gate-3 pin.** "Written… against dominic's reviewed pin `e6d5413c`, BEFORE Gate 3 landed. Verify line-level details against the LANDED code at apply time." Every line reference in it (`ManualSurface.swift:726`, `:930`, `:421`, `CallbackContext` `:67/:80/:93`, `:158`, `:172-201`, `:194-201`, `:85-93`) may have moved. *Question:* who owns the re-verification at douglas's integration turn, and is a stale-line-reference failure a blocker or a mechanical fixup?
- **AC-THIN — Gate 6 architecture binding vs. available hardware.** Gate 6 requires that "production qualification authors and restores the complete byte-split corpus on **both** native slices," and Gate 4 requires "arm64+x86_64 slices." All recorded A1 evidence is arm64-only. *Question:* is x86_64 hardware (or a qualified emulation path) available, and if not, is a single-architecture ship with `ENGINE_MISMATCH` enforcement acceptable for M1?
- **AC-THIN — DoD-1 row K depends on vendor TUIs.** "K on all three vendor TUIs" (real Claude, Codex, Grok interactive sessions) is blocked on the B2 renderer per the Gate 10 status. *Question:* accept that DoD-1 cannot close within B1 and formally defer row K to the B2-dependent Gate 10 AppKit slice, or hold B1 open until B2 lands?
- **NOTE — Gate 6 Option D consequence is a recorded, accepted capability regression.** Embedded `tmux_control_mode` is disabled; "a DCS request to enter tmux control mode is therefore ignored." The doc rules this "intentional and accepted" because Hive drives tmux through host/CLI integration. *No ruling needed unless* the user disagrees that Hive has no dependency on embedded tmux-control-mode parsing — worth an explicit confirmation given it is a silent-ignore behavior change.
- **NOTE — the "70 tags" discrepancy is already handled correctly.** The pinned enum has 66, not 70, "and the completeness test counts the header live rather than trusting either number." No action; recorded because a reader comparing the prose to the table will otherwise flag it.

---

### Cross-story observations for the approval decision

1. **Two of three stories carry the identical stale header** — A0 and B1 both say "fully specified; execution awaits user plan approval," but B1 demonstrably has four gates of landed 2026-07-18/19 evidence while A0 has none. The header is accurate for A0 and misleading for B1.
2. **A1 is the only story with a truthful incremental status line** and is the only one with a recorded conformance evidence table plus positive controls. It is the model the other two should follow.
3. **The real approval gates are three:** (a) A0's two architectural rulings (reap authority; TIOCPKT), which unblock the freeze and therefore A2; (b) B1 Gate 7's HOLD clearance and the ownership of human-only physical evidence; (c) ratification of the two Gate 9 decisions that implementation already took ahead of the queen's open-decisions list (B-class stripping, DESKTOP_NOTIFICATION bridge-deny) — including resolving the **contradictory B-class control assertion** that stripping introduced.
4. **The input-wire doc needs no ruling** despite its options format — it was adjudicated 2026-07-17 and is normative. Its only latent question is whether anyone has measured input transactions against the 128 KiB v1 cap that would trigger the pre-committed Option 3 upgrade.

## M1-B2 (#8) — Host live vendor TUIs in Workspace with HiveTerminalView


`planning/story-m1-b2-hive-terminal-view.md`

## (1) Plan summary

B2 is the renderer-side half of Hive's new terminal stack: it makes one `HiveTerminalView` in a Workspace pane render exactly one exact session locator+generation, routing every terminal operation over the frozen M1-A0 terminal-host contract as implemented by M1-A2 over sessiond, using the M1-B1-qualified pinned Ghostty manual-I/O engine (commit `73534c4680a809398b396c94ac7f12fcccb7963d`) behind a Hive-owned adapter that is the sole consumer of libghostty/libghostty-vt symbols. Sessiond keeps the PTY, process tree, ordered output, canonical state and terminal query replies; the renderer surface is a reply-suppressed copy that only emits bytes caused by AppKit user events, submitted via `INPUT_SUBMIT` with discriminated `APPLIED` receipts under a synchronous human-input claim. A separate authenticated Workspace-visibility channel — gated on a new cross-vendor-reviewed A0 contract extension (B2.1 "task zero") — makes a live Workspace PID + OS start token + monotonic open-terminal inventory revision the admission authority for production create, the renewal authority for the sessiond lease, and the teardown trigger on pane/window/Workspace close or bounded expiry; renderer attachment is explicitly *not* visibility. Correctness is proven against an executable fidelity floor (vttest 20251205, SHA-256 `cd6886f9…77cc`, plus ECMA-48/xterm/Kitty/Unicode/attach corpora) with frame/byte digests as the oracle, plus live AppKit accessibility acceptance (VoiceOver + Accessibility Inspector), plus a full live matrix on real Claude Code, Codex and Grok TUIs, independently reproduced by a different model vendor on a clean machine. Delivery is seven increments (B2.0, B2.1a, B2.1b, B2.2, B2.3, B2.4, B2.5, B2.6) each with its own blocking live gate and a cross-vendor author≠reviewer pair; B2 removes nothing — SwiftTerm and tmux stay frozen — and hands its evidence bundle to the STORY-001/STORY-002 atomic cut.

## (2) Acceptance criteria checklist

### DoD (11 numbered criteria, verbatim-anchored)

- [ ] **DoD-1** — Pinned Ghostty adapter and manual surface satisfy inherited M1-B1 "ABI, behavior, checkpoint, lifetime, rendering, input, action/security, and accessibility gates on arm64 and x86_64". "No Workspace code consumes the unstable upstream ABI directly."
- [ ] **DoD-2** — "A cross-vendor-reviewed A0 contract extension freezes visibility request/lease shape, freshness, renewal, expiry, and failure postconditions **before implementation**." Only then: real Workspace pane supplies fresh PID/start-token/revision visibility, opens production sessiond create admission "for an exact visible pending record", renews from current inventory, tears down on pane/window/Workspace close or bounded visibility expiry.
- [ ] **DoD-3** — `HiveTerminalView` attaches one exact generation; restores/replays "without loss or duplication"; renders contiguous output; submits user bytes through `INPUT_SUBMIT` with discriminated `APPLIED` receipts; resizes "with exact readback/SIGWINCH evidence"; handles exit/reap/close "without confusing detach with termination".
- [ ] **DoD-4** — Keyboard, scroll/scrollback/search, selection/copy, bracketed paste, IME, mouse modes, primary/alternate screen, Unicode, color, cursor, hyperlinks, title/bell, scale changes, GPU lifecycle, and security policy pass the pinned vttest/VT/Kitty/AppKit corpus "with exact versions, hashes, settings, and results recorded".
- [ ] **DoD-5** — VoiceOver and Accessibility Inspector pass live against semantic terminal text/rows, cursor, selection, scrolling, input, output, replay, and lifecycle/failure states. "The runs are recorded and independently reproduced."
- [ ] **DoD-6** — Full real Claude Code, Codex, and Grok matrix passes, "including input, resize, scroll, selection/copy/paste, IME, mouse, daemon restart + renderer reconnect, natural exit, verified pane close, quit-Workspace teardown of every provider tree, 100 MiB-class replay/backpressure, and hostile/stale-identity cases."
- [ ] **DoD-7** — "A different model vendor reproduces the runbook on a clean machine. Code presence and author-only recordings are not evidence."
- [ ] **DoD-8** — Replacement is project-agnostic and "live-proven on a non-Hive repository with no Hive-repo, Bun, or fixed-layout assumption."
- [ ] **DoD-9** — "Swift, TypeScript, and Zig tests/typechecks plus native ABI, sanitizer, Instruments, signing/notarization, architecture, dependency, license, and packaged-artifact checks are green at the reviewed commit."
- [ ] **DoD-10** — Evidence bundle accepted as renderer input to the STORY-001/STORY-002 Removal Gate. "No SwiftTerm/tmux removal, legacy shim, dual-renderer flag, or fallback is introduced by B2"; full matrix "remains mandatory again on the atomic deletion tree, where STORY-002 owns and executes its paired DoD-7 terminal/workspace documentation cleanup."
- [ ] **DoD-11** — "Fresh external research drives every execution." Current implementation and the renderer transition design are reference material only. "All implementation documentation is behavioral and contains no code file paths or line-number references."

### Increment blocking gates (each carries its own pass condition)

- [ ] **B2.0 · Engine/contract lock** (dep: M1-A0, M1-A2, M1-B1; Codex → Claude) — "Clean arm64+x86_64 build loads the exact library, ABI/symbol/behavior lock passes, a manual surface renders a neutral replay, and process/fd inventory proves no renderer child or PTY."
- [ ] **B2.1a · Visibility freeze and create/sustain source** (dep: B2.0; Claude → Grok) — "Contract fixtures prove the freeze; a neutral process is created only from a visible pending pane and stale/spoofed sources fail. Close/quit completion is explicitly deferred to B2.1b."
- [ ] **B2.1b · Exact close and quit teardown** (dep: B2.1a; Codex → cross-vendor review) — "Stale locator kills nothing; explicit close and clean quit prove exact provider-tree absence; teardown failure remains visible; publisher death independently proves bounded expiry."
- [ ] **B2.2 · Attach/output/reconnect** (dep: B2.1b; Grok → Codex) — "Live neutral TUI survives daemon restart and renderer recreation at adversarial byte splits; digests/high-water match; wrong build/gap/late generation fail closed."
- [ ] **B2.3 · Input/geometry and A3 proof** (dep: B2.2; Codex → Claude) — "Byte-capture fixture plus vttest proves claim-before-input, no competing-writer steal, keys, Kitty modes, dead key, CJK IME, bracketed paste boundaries, mouse modes, Retina resize, retry/unknown behavior, and no double input."
- [ ] **B2.4 · Viewer semantics** (dep: B2.3; Claude → Grok) — "Pinned vttest/VT corpus passes, including the predeclared 1005/1015 applicability, and Instruments proves rendering/memory bounds through scroll, replay, sleep/wake, and GPU recreation."
- [ ] **B2.5 · Workspace/vendor qualification** (dep: B2.4; Grok → Codex; Claude reproduces) — "Full Claude Code/Codex/Grok matrix above passes, including daemon restart + renderer reconnect, per-pane verified close, concurrent quit teardown, and independent third-vendor reproduction."
- [ ] **B2.6 · Accessibility acceptance** (dep: B2.4; may run in parallel with B2.5; Codex → Claude) — "Recorded VoiceOver and Accessibility Inspector acceptance passes through input, scroll, alternate screen, replay, resize, and teardown and is independently reproduced by the reviewer."
- [ ] **Cross-cutting increment rule** — "No increment lands on implementation tests alone. Each live gate is recorded at the reviewed commit; every increment receives its independent cross-vendor review before landing." Author vendor and approving reviewer vendor **must differ**; a **third vendor** performs the final independent reproduction.

### Live-proof matrix (8 cells; each required **for each vendor**: Claude Code, Codex, Grok)

Recording requirement for the whole matrix: "exact vendor/version/model, app/engine/sessiond builds, macOS/hardware/architecture, project directory, terminal settings, and session locator/generation. At least one run uses a non-Hive repository and no Bun or repository-layout dependency."

- [ ] **Open/render** — "A visible pending pane admits one sessiond generation; the real full-screen TUI reaches a correct interactive frame with no hidden child/PTY owned by the renderer."
- [ ] **Input** — text plus editing/navigation/control/function/Option sequences; international dead key; live CJK IME composition/commit; emoji/ZWJ; "compare PTY byte/receipt evidence for no loss, duplication, or wrong target."
- [ ] **Resize** — drag through multiple cell sizes + a scale change; "the TUI redraws and sessiond records the exact applied geometry/revision plus foreground SIGWINCH evidence."
- [ ] **Scroll/select/copy/paste** — retained output, leave bottom, search, select across wraps/wide text, "copy an exact known digest", paste in bracketed mode, "exercise application mouse plus local-selection override."
- [ ] **Reconnect** — restart daemon and recreate renderer while visibility record remains live; "attach/replay produces the same exact generation and first correct frame with continuous output high-water and no duplicate input/query reply."
- [ ] **Exit/close** — natural exit and explicit pane close; record exit and "authoritative reap/process-tree absence for the exact PID/start tokens. Renderer detach alone must leave the pane represented and must not claim close."
- [ ] **Quit** — all three providers concurrently, quit Workspace, "prove every owned provider/auxiliary tree absent. Repeat an ungraceful Workspace death and prove bounded lease-expiry teardown."
- [ ] **Stress/security** — "integrated 100 MiB output/backpressure/replay fixture, hostile OSC/oversize input cases, stale generation/visibility revision/PID reuse attempts, and verify no byte loss, privileged renderer action, or invisible survivor."
- [ ] **Reproduction rule** — "The author records the matrix; a person using a different model vendor reproduces it from the written runbook on a clean machine. The evidence bundle names failures and reruns rather than editing them away."

### Fidelity floor / corpus criteria (each independently blocking)

- [ ] VT baseline pinned to **vttest 20251205**, archive SHA-256 **`cd6886f9aefe6a3f6c566fa61271a55710901a71849c630bf5376aa984bf77cc`**.
- [ ] Evidence bundle records: vttest `-V` output, archive hash, build flags, OS/hardware/architecture, locale, terminal declaration, font/settings, geometry, every selected menu path, expected result, actual result, screenshots/log, reviewer disposition.
- [ ] "Applicable tests are declared from advertised capabilities **before** execution; an applicable failure blocks." Unsupported historical hardware functions "must be explicit and consistent with advertised capability, never waived after seeing a failure."
- [ ] **Mouse modes 1005 and 1015** get "an explicit up-front applicability decision in that capability manifest, derived from the pinned engine's advertised behavior before any run." 1005 begins as "**unknown until declared**, not assumed supported"; 1015 "neither mandatory nor exempt until declared." "A test failure cannot retroactively change either determination."
- [ ] Corpus row 1 — vttest applicable VT100 (cursor movement, screen features, wrapping, insert/delete, character sets, double-width/height, keyboard, reports, reset); applicable VT220–VT520 screen/editing/keyboard/report; ISO 6429 color/SGR; XTerm alternate-screen and mouse-feature menus incl. X10, normal, button-event, any-event, SGR, alternate-scroll, pixel coordinates.
- [ ] Corpus row 2 — ECMA-48 control parsing **at every byte boundary**; xterm 1049, 2004, 1004, mouse 9/1000/1002/1003/1006/1007/1016 plus the up-front-applicable subset of 1005/1015; cursor shape; title/bell; OSC 8 hyperlinks; **denied OSC 52**; 256-color; truecolor; synchronized output; query/reply fixtures.
- [ ] Corpus row 3 — Unicode fixtures **split at every byte**: narrow/wide CJK, combining sequences, variation selectors, emoji with skin tone, flags, family ZWJ; "selection, copy, cursor, wrapping, and resize must agree on grapheme/cell boundaries."
- [ ] Corpus row 4 — Kitty keyboard legacy mode + progressive flags (disambiguation, event types, alternate keys, all-keys reporting, associated text, query, push/pop, independent primary/alternate stacks); physical runs cover US and international layouts, Option, dead keys, key repeat/release, function keys, Control chords, CJK IMEs, RTL composition, emoji/ZWJ entry.
- [ ] Corpus row 5 — Scrollback/search at **empty, one row, exact limit, and limit-plus-one**; selection across hard/soft wraps and wide/combining cells; bracketed and unbracketed paste at **0, 1, and 128 KiB**; resize/reflow; Retina/non-Retina moves; minimized/occluded rendering; sleep/wake; GPU recreation; bounded memory under sustained output.
- [ ] Corpus row 6 — Every attach case at adversarial output splits: fresh replay, same-build checkpoint, daemon restart, renderer recreation, retained-range gap, corrupted checkpoint, wrong build/architecture, late old-generation frames, process exit, close during replay.
- [ ] Oracle rule — "Frame/byte digests and semantic state are the correctness oracle. 'Looks right' is allowed only for the separate aesthetic gate."

### Accessibility acceptance criteria

- [ ] Accessibility elements are supplied "from the same semantic terminal state used by render, selection, and copy."
- [ ] Accessible terminal exposes: text-area/container identity, visible semantic rows with screen-coordinate frames, UTF-16 text ranges, cursor/focus, selected text/range, scroll position, distinct native lifecycle/failure states.
- [ ] Incremental output/cursor/selection/row changes "post the appropriate accessibility notifications without replacing the entire tree or flooding announcements."
- [ ] Accessibility Inspector run "must show valid roles, parent/child relationships, frames, focus, values, row/range/selection consistency, and no stale/duplicate elements through scroll, resize, alternate-screen, replay, and teardown."
- [ ] VoiceOver user "must navigate rows, locate cursor and selection, enter and edit text, hear committed output and lifecycle changes, inspect scrollback, survive reconnect, and close the terminal."
- [ ] Recording "includes screen and audio and is independently reproduced; an API citation or automated property assertion **cannot satisfy STORY-002 DoD-3a**."

### Embedding-boundary / ABI criteria

- [ ] "No upstream Ghostty type, callback, constant, or lifetime rule crosses the Hive-owned adapter boundary." Workspace sees only Hive value types/operations (enumerated: create/destroy manual surface; apply ordered output; restore build-bound checkpoint; set focus/size/scale/occlusion; draw; encode key/text/preedit/mouse/paste; read selection and semantic screen state; receive copied invalidate/title/bell/close events).
- [ ] Immutable build manifest = exact upstream tree, public-header hashes, Hive patch-series hash, Zig/Xcode/Swift versions, deployment target, architectures, license/SBOM, exported-symbol allowlist, engine build identity. Build identity **includes architecture and checkpoint-layout fingerprint**. "A mismatched build or architecture cannot restore a checkpoint or attach as if compatible."
- [ ] Compile-time **and** runtime ABI gates cover header self-containment, symbol presence **and absence**, struct size/alignment, enum values, calling convention, callback ownership, app/config/surface destruction order — "on arm64 and x86_64". "Header compilation alone is never sufficient."
- [ ] Behavior gate proves: no hidden process/PTY, ordered output at every byte split, terminal replies, checkpoint/restart, input encoders, rendering, GPU lifecycle, actions/security, accessibility.
- [ ] "Callback payloads are copied before return; rendering/AppKit calls are main-thread confined; output ingestion is serialized with draw/restore/destroy; destroy prevents later callbacks and cannot re-enter itself."
- [ ] "An upstream or patch change is a new reviewed supply-chain increment. It re-runs the complete B1 and B2 corpora before activation. There is no 'compatible enough' ABI fallback."
- [ ] Surface "never launches a command, opens a PTY, reads provider stdout directly, or writes a provider descriptor."
- [ ] Output-induced DA/DSR/DECRQSS/XTGETTCAP and similar replies "are disabled in the rendering copy"; "Only bytes caused by an AppKit user event leave the renderer adapter."
- [ ] "The Workspace never acquires a PTY descriptor."
- [ ] Generation fencing: "A late attach, output frame, input receipt, resize result, exit event, or termination result for an old binding is discarded and cannot mutate the current surface."

### Attach / replay / output / exit criteria (7 numbered)

- [ ] (1) Visible pending pane asks for one exact generation + one-use attach authority; authenticated host attach repeats exact session reference and generation; "both ends reject a mismatch."
- [ ] (2) Renderer declares protocol, engine build, architecture, supported checkpoint content types, last contiguous event/output cursor. Fresh surface starts at zero; reconnect resumes from last acknowledged cursor "only if the engine identity and local state still match."
- [ ] (3) Checkpoint restore verifies type, build, architecture, digest, declared bounds, cursor before **atomic** restore; replay bytes applied "strictly after the checkpoint through-sequence"; without checkpoint, replay from negotiated cursor.
- [ ] (4) Live `OUTPUT` applied "exactly once in increasing byte ranges." Duplicate identical ranges harmless; overlap-with-conflicting-bytes, gap, overflow, wrong generation, or late connection ⇒ "typed rebase/failure state." "The renderer never paints a stale cached frame as live."
- [ ] (5) Acknowledgement "advances only after the manual engine accepted a contiguous range." "Pixel presentation is not falsely claimed"; "first correct frame" additionally requires checkpoint/replay completion **and** a draw for the exact current generation.
- [ ] (6) Renderer recreation/transport loss may detach while pane stays in live inventory; fresh one-use grant; resume from last acknowledged cursor. Daemon restart revalidates the Workspace visibility source, then reconnect replays "without duplicated or missing terminal bytes."
- [ ] (7) Natural exit disables input, drains retained output, shows exit + authoritative reap evidence. "A process-exit notification without reap evidence is not 'terminated.'" Close of exited pane still removes visibility record and reconciles lifecycle state.

### Input / resize criteria

- [ ] First responder only after direct click or explicit focus command; "Output, status, attach, replay, and alerts never steal focus." Focus-in/out bytes encoded only when terminal mode requests them.
- [ ] User event held until exact viewer owns a human input claim; batch submitted via `INPUT_SUBMIT` with exact session reference, claim token, transaction ID, idempotency key, byte operation; "The correlated discriminated `APPLIED` result must be the input branch. B2 does not use raw `HUMAN_INPUT` as a correctness path."
- [ ] One serialized renderer queue preserves encoder callback order. "Retry repeats the same domain transaction and idempotency key; it never invents a new act after an unknown result." Receipts distinguish **accepted, queued, written-to-terminal, rejected, unknown**, and "never claim provider consumption."
- [ ] "The v1 decoded transaction limit is **128 KiB**." Paste at the boundary is tested. "Oversize input is rejected visibly before partial submission; B2 does not split a bracketed paste, expand the control frame, or silently reinterpret the raw input lane." Larger atomic input requires separate adoption of the documented chunked protocol upgrade.
- [ ] Key handling preserves physical key, layout-derived text, consumed/unconsumed modifiers, left/right modifiers, repeat/release, function/navigation keys, Control chords, Option mappings, Kitty progressive modes. "A text-producing event is emitted once: never once as a key and again as text."
- [ ] `NSTextInputClient` owns composition: marked text/preedit displayed locally without committing PTY bytes; `insertText` commits once; cancel/unmark clears preedit; command dispatch routes editing commands through terminal encoder; selected/marked ranges and character coordinates use AppKit UTF-16 units; insertion rectangle is live cursor rect in screen coordinates "so candidate windows follow the cursor through resize and monitor moves."
- [ ] Paste = explicit user clipboard read + Ghostty paste encoder under human claim. With DEC 2004 set, "exactly one `ESC [ 200 ~`/`ESC [ 201 ~` pair surrounds only the paste body"; reset ⇒ Ghostty safe-paste rules. "Paste never auto-submits, sleeps, or uses timing heuristics." **OSC 52 read and write are denied in v1**; Command-C/Command-V remain local user actions.
- [ ] Resize: view bounds → actual backing pixels; cell geometry from Ghostty's measured font/grid result, "never division guesses." Nonzero geometry change gets monotonic revision + idempotency key, sent as `RESIZE`; correlated `APPLIED` "must be the resize branch and its readback must match." Intermediate live-resize events may coalesce, "but the final size and every display-scale change are delivered." Sessiond applies PTY window size and signals foreground process group; "a redraw alone is not SIGWINCH proof."

### Scroll / selection / copy / mouse criteria

- [ ] Scrollback bounded by product policy, "owned by terminal state, not scraped text." At bottom → follows; scrolled back → "viewport anchor remains stable and new output is indicated without jumping." Resize reflow preserves grapheme/cell and selection semantics. Search covers retained scrollback and "reports truncation at the configured bound."
- [ ] No application mouse capture: drag ⇒ viewer-local selection, wheel/trackpad ⇒ scrollback. With application mouse mode active: button, motion, wheel, modifier, pixel/cell coordinates encoded exactly for X10, VT200, button-event, any-event, SGR, alternate-scroll, pixel modes. "A deliberate Shift override provides local selection while captured and is tested against the standalone pinned Ghostty behavior."
- [ ] "Selection is viewer-local and never writes PTY bytes." Handles character, word, line, rectangular mode when supported, wide cells, combining marks, emoji clusters, hard line breaks, soft wraps. "Copy is enabled only with a selection and writes exactly the semantic selected text to the native clipboard. Control-C stays provider input; Command-C stays copy."
- [ ] Primary and alternate screens retain independent terminal modes and Kitty keyboard stacks. "Entering alternate screen does not destroy primary scrollback; DECSET/DECRST 1049 saves/clears/restores according to xterm behavior."

### Workspace-visibility interlock criteria (7 numbered channel rules + framing)

- [ ] Framing decision — "make this a distinct B2 build increment and a distinct authenticated lifecycle channel; do not fold it into `HiveTerminalView`."
- [ ] B2.1 task zero — cross-vendor-reviewed **A0 freeze extension** must land before production create admission closes; must define freshness, replay/stale-revision rejection, PID-reuse rejection, renewal, expiry, completeness, typed failure postconditions. "must not treat today's daemon representation as normative or normalize it silently."
- [ ] (1) Each Workspace launch creates random Workspace-session identity, publishes live PID + OS-derived start token; daemon authenticates local peer and re-reads PID/start-token; "PID alone is insufficient because of reuse."
- [ ] (2) One monotonically increasing open-terminal inventory revision. Before create: insert visible pending pane bound to proposed exact locator, increment revision, publish full snapshot. "Pending, attaching, live, reconnecting, closing, exited, and failed panes all remain visibly represented native states; a renderer is optional."
- [ ] (3) Daemon accepts only a fresh full snapshot for the authenticated identity. Fail closed on: older revisions, changed start token, duplicate locator ownership, record absent from current UI model, publisher no longer live. "Reconnect sends a full snapshot rather than reconstructing authority from event deltas."
- [ ] (4) At **both** candidate selection **and** final create call the daemon re-resolves the snapshot. "Only an exact pending/open record supplies the A0-frozen visibility request"; daemon records returned lease and "never caches admission across a revision change."
- [ ] (5) Renewal only while a later-or-equal snapshot still contains the exact generation and Workspace process identity remains valid. "Renderer traffic, window-server occlusion, heartbeats without an inventory record, screenshots, and stale saved UI state are not renewal evidence." Minimized/occluded panes remain visible representations; pane/window/Workspace close removes them.
- [ ] (6) Pane/window close: mark record closing, refuse new input, request exact-generation termination, wait for positive reap/process-tree evidence; record removed only after successful reconciliation. "A confirmation cancellation leaves the pane open; close never degrades to detach."
- [ ] (7) Workspace quit freezes new creates, snapshots every open exact generation, runs the same close transition for all, "does not complete a successful quit until every provider tree is absent with authoritative evidence. Unknown or survivors are a visible failure, not success." Ungraceful death ⇒ loss of authenticated visibility source lets bounded sessiond lease expire and trigger verified teardown.
- [ ] Split delivery — B2.1a "wires authenticated create/sustain visibility and explicitly disclaims close/quit completion"; B2.1b completes lifecycle. "the visibility lease is only the crash backstop, never the ordinary close/quit mechanism."
- [ ] Project-neutrality — "Workspace policy terminates at the daemon adapter, while sessiond receives only the exact identity and visibility evidence frozen by the B2.1 A0 extension."

### Scope invariants (each a pass/fail statement)

- [ ] One edge-to-edge `HiveTerminalView` renders exactly one exact locator and generation. "It never resolves 'latest,' retargets by display name, or displays bytes from another generation."
- [ ] Hive-owned adapter is "the only consumer of libghostty/libghostty-vt symbols"; creates a manual surface "with no child process or PTY".
- [ ] Pane/window/Workspace lifecycle publishes real open-terminal visibility. "User close means exact-generation termination, never renderer detach. Workspace quit terminates and verifies every open provider tree."
- [ ] Result is project-agnostic: "Nothing assumes the Hive repository, Bun, a package layout, or a provider-specific project shape."
- [ ] Sequencing rule 3 — "B2 may not silently move the pin or weaken a B1 gate."
- [ ] Sequencing rule 7 — "No removal happens in B2." STORY-001/002 execute as one atomic hard cut "with no renderer or host fallback"; full matrix re-run on the post-deletion tree before the cut lands.
- [ ] Sequencing rule 6 (queen-adjudicated) — A3's input-arbiter proof closes through **B2.3**; A4's visibility lease / renderer-crash-to-bounded-replay / Workspace-quit-to-verified-provider-tree-termination proofs close through **B2.1 / B2.2 / B2.5** respectively. "If a fresh owner inventory finds no material remainder, A3/A4 fold into B2 and close with this evidence rather than remain hollow backlog items."
- [ ] Sequencing rule 8 — "M1 remains provider-policy neutral." Vendor binaries are manually launched black-box probes; launch profiles/readiness/belief/approvals/messaging/authenticated status remain M2.

## (3) Current completion state (doc's own status lines)

- Header, verbatim: **"State: design written; **must pass independent cross-vendor design review before landing**"**
- Backlog position, verbatim: "after the M1-A0 freeze, M1-A2, and M1-B1; before the STORY-001/STORY-002 Removal Gate"
- Open decisions, verbatim: **"None requiring further queen/user adjudication remain after the review ruling."** Seams listed as resolved: A0 is contract authority and B2.1 extends its freeze for visibility; B1's existing Ghostty pin retained; sessiond is single terminal-query-reply authority; human renderer bytes use `INPUT_SUBMIT` rather than the raw streaming optimization; oversize atomic human input fails visibly at the adopted v1 cap; Workspace visibility is a separate B2 increment/channel authoritative from the live pane inventory not renderer attachment; renderer-coupled A3/A4 proofs fold into named B2 increments.
- Research currency, verbatim: "Research reverified 2026-07-18; execution must recheck these sources and record versions/hashes rather than relying on this summary."
- **Per-gate status: the doc tracks NO per-increment or per-gate status.** All eight increments (B2.0–B2.6) and all eight matrix cells are specified as forward work with no closed/open/waived markers. No gate is recorded as closed. Effective state: **0 of 8 increments recorded closed; design not yet review-approved.**

## (4) Flags

- **AC-THIN — "bounded scrollback by product policy" has no number.** The scroll criteria and corpus row 5 both test "exact limit" and "limit-plus-one" but the document never states the limit. B2 also never states the retained-output bound sessiond must hold for replay. *Question for the user: what is the scrollback line bound (and the sessiond retained-output byte bound) that the "empty / one row / exact limit / limit-plus-one" fixtures test against?*
- **AC-THIN — "bounded expiry" of the visibility lease has no duration.** DoD-2, interlock rules 5/7, and the B2.1b gate all turn on a bounded lease expiring after ungraceful Workspace death, but no bound, renewal interval, or maximum-survivor window is given. *Question: what is the maximum time an orphaned provider tree may survive an ungraceful Workspace death, and what renewal interval implements it?*
- **AC-THIN — "100 MiB-class replay/backpressure" has no pass threshold.** The fixture size is given; the acceptance condition is only "no byte loss." No throughput, latency, memory ceiling, or drop-rate bound is stated, though B2.4's gate says "Instruments proves rendering/memory bounds." *Question: what are the numeric memory and frame/throughput bounds Instruments must show for the stress cell to pass?*
- **AC-MISSING — mouse modes 1005/1015 applicability is deliberately undetermined.** The doc mandates an up-front decision in the capability manifest but does not make it, and it is a blocking input to the B2.4 gate. This is intentional (decided by probing the pin, not by ruling) but must be produced before B2.4 can start. *Question: is producing the 1005/1015 applicability manifest an accepted B2.4 entry task, or does it need to be scheduled explicitly as part of B2.0's engine lock?*
- **AC-MISSING — no gate-status tracking exists in the document.** Unlike C1, B2 records no per-increment closed/open/waived state, so "which gates are closed" is unanswerable from the doc. *Question: should B2 carry a per-increment status table (as C1.2's gate cell does) so approval state is readable from the story?*
- **OPEN-USER-RULING — A3/A4 fold-in is stated as decided but conditioned on an inventory not yet done.** Sequencing rule 6 says A3/A4 "fold into B2 and close with this evidence" *if* "a fresh owner inventory finds no material remainder." That inventory is unrun. *Question: who runs the A3/A4 remainder inventory, and when — before B2.1 starts, or at B2.5 close?*
- **OPEN-USER-RULING — the chunked-protocol escape hatch is pre-authorized in prose but not scoped.** DoD/input criteria say larger atomic input "must be separately adopted" via the documented chunked upgrade. *Question: if measured vendor TUI behavior during B2.3 shows >128 KiB atomic paste is needed, does B2 stop and route back to M1-A1, or proceed with visible rejection and file the upgrade as M2?*
- **Note (not a flag):** B2 depends on M1-A0, M1-A2, and M1-B1 all being complete, and the B2.1 A0 *extension* must itself pass the A0 contract gate. Approval of B2 implicitly approves reopening a frozen A0 for that extension.

---

## #9 — M1-B3 — New smoke harness on the sessiond/HiveTerminalKit spine

**State:** OPEN · **Labels:** `type:build`

**(1) Plan summary.** Milestone M1, track B. Replace the SwiftTerm/tmux smoke harness (`SmokeRunner` + `smoke.sh`) with equivalent-or-better coverage driving the new spine, so **STORY-002 can delete the old one without losing the safety net**. Scope: a headless-driveable Workspace smoke run covering launch, render, input, resize, close, teardown; CI-runnable; exact-generation assertions. Needs M1-B2; **blocks the Removal Gate**.

**(2) Acceptance criteria checklist.**
- [ ] "Smoke run green on the new spine covering at least the old harness's scenario list"
- [ ] "runs in CI"
- [ ] Scope-derived coverage: "launch, render, input, resize, close, teardown"
- [ ] "exact-generation assertions"
- [ ] "Headless-driveable"
- [ ] R3 addendum gating: "closes only after A2+A3+A4+B1+B2 (full-system harness); re-runs on the post-deletion tree after the atomic cut"
- [ ] HARD PRINCIPLES (identical block to #5)

**(3) Completion state.** No status lines or checkboxes. Issue state: **OPEN**. Completion per the body: **unstated / zero recorded**.

**(4) Flags.**
- **AC-THIN.** *"the old harness's scenario list" is named but not enumerated in the issue — where is the authoritative list, and who freezes it before deletion?* Without an enumerated baseline, "equivalent-or-better" is unfalsifiable. *Is CI a real hosted runner or the local `make` path?*
- Note: also **no `planning/story-m1-b3-*.md`** (verified). Same story-doc gap as #5/#6, though #9 carries no live-proof invariant.
- **Cross-ref:** #53 identifies a shared-machine flake in a Gate 9 test and names #9 as related — the new harness inherits that flake class if it runs the same assertion.

---

## M1-C1 (#10) — The beautiful blank terminal: visual quality bar


`planning/story-m1-c1-beautiful-blank-terminal.md`

## (1) Plan summary

C1 turns "beautiful, modern, and stylish" into a buildable, checkable specification for the Hive terminal, separate from B2 so aesthetics cannot silently lose to correctness. Its load-bearing structural finding is that the pinned engine exposes **no per-key configuration setter** — so the theme transport is a Hive-authored configuration *file* that Hive writes, explicitly loads, and pushes to live surfaces, with three hard rules: never load the engine's default configuration locations (which would pull the user's personal config in and make the B1/B2 rendering corpus non-deterministic), never resolve a theme by name (name lookup consults the user's directory and a resources directory Hive doesn't ship), and always emit theme content before overrides. The design language is "quiet, dense, native, and honest": the grid font is the engine-embedded *unpatched* variable JetBrains Mono reached by **configuring no font family at all** (naming one — even Menlo as backup — makes the named family outrank the embedded fallback and silently renders the wrong face); 13 pt on the convergence of two defaults; ligatures off via the OpenType contextual-alternates feature on a byte-fidelity argument, with the engine's cursor shaping break left on as a second independent mitigation; no light weights; no grid tracking; thickening exposed as enable-flag-plus-strength because strength zero means lightest, not off. Color ships paired first-party dark and light themes authored together with Solarized's symmetric-lightness *method* (not its ratios), measured against WCAG 2.x explicitly not APCA, targeting ≥7:1 foreground-on-background, ≥4.5:1 per ANSI entry with de-emphasis entries clearing 3:1, ANSI 0–15 only with 16–255 standard and palette generation off, symbolic cursor/selection colors, and a deliberately *low* minimum-contrast floor whose cost is documented. Chrome forbids glass and vibrancy behind terminal content, opens padding with balance and nearest-cell padding-color extension, uses a 1 pt divider and cell-based pane minimums, and implements focus-by-attenuation as a sibling **overlay `NSView` — never a `CALayer` sublayer**, a hazard already proven in this codebase by a focus ring and status border that were built, reviewed, and never appeared on screen. Appearance follows the system unconditionally with no app-appearance setting, and Reduce Transparency / Increase Contrast / Reduce Motion each have a mandatory live-observed effect. Six increments (C1.0–C1.5) run after B2.4, in parallel with B2.5/B2.6, closing on the user's personal aesthetic signoff against the reference terminals after the B2 integrated pane.

## (2) Acceptance criteria checklist

### DoD (13 numbered criteria, verbatim-anchored)

- [ ] **DoD-1** — Theme transport is a Hive-authored configuration file, explicitly loaded and live-pushed. "Hive provably never loads the engine's default configuration locations and never resolves a theme by name; a file planted in the user's own configuration location has no observable effect on any Hive pane."
- [ ] **DoD-2** — "**No font family is configured by default, and the face that actually renders is identified as the engine-embedded one**" — captured and matched "on a machine carrying no additional fonts", with the negative control recorded ("a configured backup chain demonstrably preempts the embedded face"). Embedded symbols fallback proven live against all three vendor TUIs' powerline and status glyphs. "A family name is emitted only on an explicit user selection." "The literal SF Mono is not used, not referenced, and not shippable — it resolves to nothing and its license permits Apple-branded applications only" — while the system-provided monospaced family ships as a labelled non-default option "whose private family name is re-verified at every engine and OS bump."
- [ ] **DoD-3** — Ligature substitution off and byte-exactness demonstrated, "**with the engine's cursor shaping break left enabled**" so a user who turns ligatures on retains editing-case protection; "that break is proven still active in that configuration." Weight, tracking, thickening, cell-height implemented as specified, "with thickening exposed as an enable flag plus a strength because strength zero is not 'off.'" "Hive emits `bold-color` and never its deprecated compatibility alias."
- [ ] **DoD-4** — Paired first-party dark and light themes exist, "authored together with symmetric lightness, each with an increased-contrast variant." Per-entry measured contrast table recorded for **every theme and variant**: "foreground on background ≥ 7:1, palette entries ≥ 4.5:1 except de-emphasis entries which clear 3:1, chrome at the AA floors. **No entry sits below 3:1.**"
- [ ] **DoD-5** — Cursor and selection colors resolve symbolically against the cell rather than from authored hex. "ANSI 0–15 are the only indices Hive authors; 16–255 remain standard and palette generation remains off." Minimum-contrast floor set low, "and its documented cost — that it clamps toward black or white and flattens deliberate dimness — is recorded where a future reader will find it."
- [ ] **DoD-6** — Pane chrome, padding, balance, padding extension, thin divider, cell-based pane minimums implemented. "No glass material and no vibrancy sits behind or over terminal content, and terminal content is proven not to descend from a vibrancy-enabled view."
- [ ] **DoD-7** — "**The focus affordance is an overlay view, and it has been seen.**" Screen captures **at every supported pane count** are part of the evidence bundle, "and the sublayer construction is demonstrated failing so the hazard is proven rather than asserted." Focus carries **both** attenuation of unfocused panes **and** the system focus indicator on the focused one. "Pane status continues to resolve through the single existing status legend; no second legend is introduced."
- [ ] **DoD-8** — "**The user personally signs off the aesthetic bar against the reference terminals (Ghostty app, Terminal.app, iTerm2) — a hard gate, no engineer proxy**" (user ruling Q5, 2026-07-17). "**Design exploration may start early, but final aesthetic signoff closes only after the B2 integrated pane**" (R3 addendum, atlas, adopted). "Signoff is recorded against side-by-side captures at the reviewed commit."
- [ ] **DoD-9** — System appearance followed live "including a mid-session Auto switch, with no app-appearance setting offered." Reduce Transparency, Increase Contrast, and Reduce Motion each produce their specified effect, "each demonstrated by toggling during a live session rather than at launch, each driven by the accessibility-options change notification." "`NO_COLOR` is honored where Hive emits color."
- [ ] **DoD-10** — "No rendering artifacts across resize, fullscreen, and display-scale changes, demonstrated live — the pre-existing acceptance criterion for this story, unchanged."
- [ ] **DoD-11** — "The engine pin does not move for any aesthetic result, and no M1-B1 or M1-B2 gate is weakened to obtain one. Swift, TypeScript, and Zig tests and typechecks are green at the reviewed commit."
- [ ] **DoD-12** — "The result is project-agnostic: no Hive-repository, Bun, or fixed-layout assumption in any visual decision, demonstrated on a non-Hive project."
- [ ] **DoD-13** — "Fresh external research drives execution; this document and the current implementation are reference material only." Paired documentation cleanup lands with this story: "the Workspace design system's terminal principle is corrected, because 'the vendor owns every pixel inside a pane' was written against the previous renderer and is now only partly true — Hive supplies the theme the engine consumes, while vendor truecolor output genuinely remains the vendor's." "All implementation documentation is behavioral and contains no code file paths or line-number references."

### Increment blocking gates (each with its own pass condition)

- [ ] **C1.0 · Theme transport** (dep: M1-B2.4; Codex → Claude) — "A pane renders under a Hive-generated configuration; a hostile file in the user's own configuration location provably has no effect on any Hive pane; a theme change applies to a live surface without recreating the session."
- [ ] **C1.1 · Typography and cell metrics** (dep: C1.0; Claude → Grok) — sub-conditions, all required:
  - [ ] "**The face actually rendering is identified and proven to be the embedded one — not merely 'a monospace font appeared.'**"
  - [ ] On a machine with no extra fonts installed, resolved face captured and matched against the embedded variable face.
  - [ ] Negative control: "configuring a Menlo backup chain demonstrably makes Menlo primary."
  - [ ] Symbols fallback "proven live by rendering powerline/status glyphs from all three vendor TUIs."
  - [ ] "A byte-exactness check confirms no ligature substitution."
  - [ ] "the cursor shaping break is proven still active with ligatures enabled."
  - [ ] "Thickening at strength zero is proven distinct from thickening disabled."
  - [ ] "The system-monospaced option is proven to resolve, and its private family name is recorded as a bump-time recheck."
- [ ] **C1.2 · The theme system** (dep: C1.1; Grok → Codex) — sub-conditions:
  - [ ] "The measured contrast table is recorded per palette entry for both themes and both contrast variants"
  - [ ] "foreground/background clears 7:1"
  - [ ] "no entry falls below 3:1"
  - [ ] "the dark theme's high-contrast variant is verified specifically under Increase Contrast in Dark Mode"
  - [ ] Scope split, verbatim: "**C1.2 discharges the static half only — the variants are authored, measured, and proven to resolve. The live Increase Contrast signal is C1.4's, because the bit is readable solely through `NSWorkspace`, which Gate 9 bars from the kit, and it cannot be recovered from an appearance read at all** (`workspace/docs/c1-c12-theme-system-evidence.md:325`). **That deferral was independently re-measured and confirmed by cross-vendor review** (`workspace/docs/hive-terminal-c12-cross-vendor-review-hollis2.md:95`)."
- [ ] **C1.3 · Pane chrome, padding, and the focus affordance** (dep: C1.2; Codex → Claude) — "**The affordance is photographed on screen at every pane count before review** — a decoration that has never been seen is not a decoration. Overlay-view construction is demonstrated, and the sublayer construction is demonstrated failing, so the hazard is proven rather than asserted. Terminal content is proven not to descend from a vibrancy-enabled view."
- [ ] **C1.4 · Appearance, motion, and the accessibility floor** (dep: C1.3; Claude → Grok) — "Appearance switching under Auto is demonstrated live mid-session; Reduce Transparency demonstrably forces opacity to opaque and blur off; Increase Contrast switches variants; Reduce Motion makes transitions instant; each is toggled during a live session, not at launch."
- [ ] **C1.5 · Aesthetic signoff** (dep: C1.4 **and the B2 integrated pane**; Grok records → user signs) — "The user personally approves. See DoD 8." Deliverable: "Side-by-side comparison capture against the reference terminals; the design checklist; the evidence bundle."
- [ ] **Cross-cutting increment rule** — "No increment lands on implementation tests alone, and each receives independent cross-vendor review before landing." Author vendor and approving reviewer vendor **must differ**.

### Transport rules (three hard rules, each independently blocking)

- [ ] "**Hive never loads the engine's default configuration locations.**" Rationale recorded: would pull the user's personal terminal configuration into Hive panes and "would make the rendering corpus that M1-B1 and M1-B2 qualify non-deterministic. Hive loads exactly the file it wrote and nothing else."
- [ ] "**Hive never resolves a theme by name.**" Name lookup is "both unreliable (the corpus is absent) and leaky (the user's directory is consulted). Hive inlines color values into its own generated configuration."
- [ ] "**A theme is a base layer that explicit settings override.**" "the selected theme supplies the base, and any Hive-level or user-level override is emitted after it."
- [ ] Capability boundary — engine split settings (unfocused-split opacity, unfocused-split fill, split-divider color) are "**Inert for Hive, despite being present**"; the unfocused-pane affordance and divider are Hive chrome.
- [ ] Capability boundary — "**The theme therefore governs indexed color and Hive's chrome; it does not govern what a vendor TUI paints in truecolor, and this document does not promise that it does.**"

### Typography criteria

- [ ] Grid font: "whatever the pinned engine already embeds — reached by configuring no font family at all — at **13 pt**, with **no backup chain**."
- [ ] Production build embeds "the official **unpatched** variable JetBrains Mono, plus a separate symbols-only Nerd Font as its own fallback face." Nerd-Font-patched files in the engine tree "are test fixtures and are not what production loads."
- [ ] Negative-control fact recorded: clean-machine probe returns **zero** descriptors for "JetBrains Mono" and "JetBrains Mono Nerd Font", **four** for "Menlo".
- [ ] System monospaced family ships as a labelled option, not default; probe returns **twelve** descriptors, all monospaced traits, no fallback substitution; "re-verified at every engine and OS bump."
- [ ] Ligatures off by default, user-switchable, "disabled via the OpenType contextual-alternates feature"; cursor shaping break "left enabled regardless."
- [ ] "**No light weights anywhere**, in grid or chrome."
- [ ] "**Tracking is not adjusted in the grid.**" "Cell width adjustment is treated as near-untouchable."
- [ ] "In AppKit chrome, tracking is left to the system."
- [ ] "**Stroke thickening: available, default off, offered as an enable flag plus a strength — never as a single slider.**" Because "in this engine **a thickening strength of zero means the lightest thickening, not none**."
- [ ] Line height: "a modest positive cell-height adjustment, chosen by eye at the signoff, not by importing a ratio." Obligation is "that the grid survives an increased cell height without breaking."

### Color/theming criteria

- [ ] Theme fields authored: `background`/`foreground` (measured); `palette` 0–15 ("The only indices Hive authors"); `cursor-color`/`cursor-text` (**symbolic, not hex**); `selection-background`/`selection-foreground` (**symbolic**); `bold-color` explicit — "Hive emits `bold-color` and never the alias."
- [ ] "**Indices 16–255 are left at the engine's standard values, and palette generation stays off.**"
- [ ] Contrast standard: "**WCAG 2.x, and explicitly not APCA.**"
- [ ] "**Foreground on background: ≥ 7:1.**" — "met in both the dark and the light theme."
- [ ] "**Every ANSI palette entry against the theme background: ≥ 4.5:1**", with de-emphasis entries clearing **3:1**. "A theme entry below 3:1 against its own background is a defect, not a style."
- [ ] "**Chrome text and non-text UI indicators: the AA floors** (4.5:1 text, 3:1 non-text/UI)."
- [ ] "Ratios are recorded per entry in the evidence bundle. A measured table is the deliverable, not an assertion that the theme 'looks fine.'"
- [ ] Minimum-contrast floor: "**Hive sets a low floor that prevents literally invisible text and does not attempt to mandate readability**"; exact value chosen at signoff; "the design constraint is that it is set low, and that its cost is documented where a future reader will find it."
- [ ] "**Color never carries meaning alone.**" "Every state in Hive chrome carries a symbol or words in addition to color, and any two states distinguished by color must also differ in luminance."
- [ ] Theme selection writes the generated configuration and pushes to every live surface; "it does not require restarting a session." Set is "deliberately small at M1 — the paired first-party dark and light — with the generator structured so additional first-party pairs are data rather than code."

### Chrome / padding / focus criteria

- [ ] "**No glass material goes behind or over terminal content.**"
- [ ] "**The terminal surface therefore must not be a descendant of a vibrancy-enabled view.**" Pane background stays "a standard opaque content material; vibrancy, where used at all, is confined to leaf chrome outside the surface."
- [ ] Metrics taken "from the design system's tokens instead of restating the numbers locally"; existing corner radius and header rhythm kept; custom components adjacent to a bar use a concentric corner radius.
- [ ] "**Symmetric padding on both axes**, in points"; engine default of 2 is "too tight for a pane that reads as a card; this design opens it."
- [ ] "**Padding balance on.**"
- [ ] "**Padding color extends the nearest cell's background.**" "the always-extend variant is not used."
- [ ] Divider: "the thin **1 pt** divider"; pane minimum sizes "such that the divider never appears to vanish"; "Panes get a minimum size **in cells, not points**."
- [ ] Titlebar/window: "Standard system window appearance; no custom window UI." "Nothing critical goes in a bottom bar." "If a toolbar carries any command, that command also exists as a menu bar item."
- [ ] "**Background opacity and blur: off by default.**" "never on a path where the user cannot instantly turn it off."
- [ ] Focus treatment: "**focus by attenuation**" — focused pane renders normally, every unfocused pane dimmed by a uniform semi-transparent overlay. "Nothing is added to the focused pane — no glow, no heavy border, no color wash."
- [ ] "**And it must be an overlay `NSView`, never a `CALayer` sublayer.**" Pattern: "sibling overlay views added last, hit-test transparent, drawing with semantic colors so light/dark and accent changes resolve for free on every redraw — this is the pattern this affordance follows **without exception**."
- [ ] "A focused pane additionally carries the system focus indicator color on its border, resolved semantically rather than hardcoded."
- [ ] "**Status remains one legend.**" "A second table is a correctness bug, not a style choice." "Dashed continues to mean 'we cannot see it.'"

### Motion criteria

- [ ] Motion used only at: "pane open and close, and the focus attenuation transition." Durations "come from the existing motion tokens rather than new constants."
- [ ] "**Where motion is prohibited, absolutely: text and scrolling.**" "Terminal output is not animated, scroll position is not eased, and the cursor's own blink is the engine's, governed by terminal semantics and configuration — not by Hive chrome animation."
- [ ] Under Reduce Motion: tighten springs, replace positional transitions with fades, avoid animating depth changes, "**avoid animating into and out of blurs**"; focus transition "degrades to an instant state change cleanly."

### Appearance criteria

- [ ] "**Hive follows the system appearance. It does not offer an app-appearance setting.**"
- [ ] Auto must be handled live: "appearance changes must be handled live rather than at launch."
- [ ] Mechanism: resolve effective appearance from `NSAppearance`, drive surface color scheme from it, re-push generated configuration on appearance change; "Chrome colors are semantic system colors that resolve themselves on every redraw, so chrome needs no appearance branching at all."
- [ ] Distinction preserved: follows system for chrome/appearance always; defaults terminal theme to matching mode; "permits pinning the terminal theme alone. That is not an app-appearance override."
- [ ] "**Both modes are authored regardless**"; "the light theme is a real design, not an inverted dark one."
- [ ] Desktop tinting respected "on neutral chrome only — never on a colored state."

### Accessibility floor (3 mandatory settings, each with a stated required effect)

- [ ] All three "observed live via the workspace accessibility-options change notification, not read once at launch."
- [ ] **Reduce Transparency** — "Background opacity snaps to fully opaque and background blur is disabled, in the generated configuration and in chrome."
- [ ] **Increase Contrast** — "The theme switches to its increased-contrast variant. Every custom color needs a light variant, a dark variant, and an increased-contrast option for each." Dark theme's high-contrast variant "is verified in that exact combination rather than assumed."
- [ ] **Reduce Motion** — "Focus and pane transitions become instant. No positional or depth animation, no animated blur."
- [ ] "**`NO_COLOR` is honored**" where Hive itself emits color.

### Sequencing criteria

- [ ] "**Styling executes after M1-B2.4.**" Exploration may begin immediately. C1 implementation "may therefore run in parallel with B2.5/B2.6 rather than queuing behind them." Backlog edge tightened from "B2" to "B2.4"; close stays "gated on the full integrated pane."
- [ ] "C1 does not change transport, input encoding, geometry negotiation, or terminal semantics, and may not weaken a B1 or B2 gate to obtain a visual result."
- [ ] "**The engine pin does not move for aesthetics.**"
- [ ] "**No appearance decision overrides a system accessibility setting.**" "They are not optional polish."

## (3) Current completion state (doc's own status lines)

- Header, verbatim: **"State: design written; **must pass independent cross-vendor design review before landing**. Aesthetic signoff is the user's personally, and closes only after the B2 integrated pane."**
- Backlog position, verbatim: "after M1-B2.4 (viewer semantics); parallel with M1-B2.5/B2.6; before the STORY-001/STORY-002 Removal Gate"
- Open decisions, verbatim: **"None requiring queen or user adjudication before implementation."** Resolved seams enumerated (generated file not per-key API; default locations never loaded / themes never name-resolved; embedded face via no configured family; system monospaced as non-default labelled option gated on bump-time re-verification; ligatures off on byte-fidelity with cursor shaping break on; WCAG 2.x not APCA; unfocused-pane affordance as Hive overlay view; appearance follows system while terminal theme stays pinnable).
- Deliberately deferred values, verbatim: "**Two values are deliberately left to be set by eye at the C1.5 signoff rather than asserted here**... the exact unfocused-pane dim level (starting from the engine's own 0.7 for the same treatment) and the exact minimum-contrast floor (constrained to be low, for the documented reason)."
- Research currency, verbatim: "Research verified live 2026-07-19; execution must recheck these sources and record versions rather than relying on this summary. Where a claim could not be verified live it is marked in the text and is not load-bearing."
- **Per-gate status — the only gate the doc tracks with state is C1.2**, which records real prior work: its gate cell cites two existing evidence artifacts and states a **partial discharge**: "C1.2 discharges the static half only — the variants are authored, measured, and proven to resolve. The live Increase Contrast signal is C1.4's, because the bit is readable solely through `NSWorkspace`, which Gate 9 bars from the kit, and it cannot be recovered from an appearance read at all," and records that "That deferral was independently re-measured and confirmed by cross-vendor review." Cited artifacts: `workspace/docs/c1-c12-theme-system-evidence.md:325` and `workspace/docs/hive-terminal-c12-cross-vendor-review-hollis2.md:95`. C1.0, C1.1, C1.3, C1.4, C1.5 carry **no status marker** — no closed/open/waived state.
- Two prior rulings are recorded as already adopted: **DoD-8 "user ruling Q5, 2026-07-17"** (hard user-signoff gate, no engineer proxy) and the **"R3 addendum, atlas, adopted"** (signoff closes only after the B2 integrated pane).
- Effective state: **design written, review pending; C1.2's static half has recorded, cross-vendor-confirmed evidence; no increment recorded as fully closed.**

## (4) Flags

- **AC-MISSING — the theme colors themselves do not exist yet.** DoD-4 requires paired dark and light themes with a per-entry measured contrast table, but the document specifies only the *targets* (≥7:1, ≥4.5:1, 3:1 de-emphasis) and authors zero actual color values. *Question: is authoring the actual palettes accepted as C1.2 work under this approval, or does the user want to see and approve the candidate palettes before C1.2 lands?*
- **OPEN-USER-RULING — two numeric values are explicitly deferred to the C1.5 signoff.** The unfocused-pane dim level (starting from the engine's 0.7) and the minimum-contrast floor ("constrained to be low"). Both are acceptance-relevant and unset. *Question: does the user accept setting both by eye at C1.5, or should a candidate value be proposed and approved before C1.3/C1.2 build against it?*
- **OPEN-USER-RULING — DoD-8 makes the user a hard blocking gate with no proxy.** C1 cannot close without the user personally comparing against Ghostty app, Terminal.app, and iTerm2, and only after the B2 integrated pane exists. *Question: does the user confirm availability for a personal side-by-side signoff session gated on B2, and confirm no engineer-proxy fallback under any schedule pressure?*
- **AC-THIN — padding value is directionally specified but unnumbered.** The doc says the engine default of 2 is "too tight" and "this design opens it," giving no point value, and padding is called "the single highest-leverage aesthetic decision in the terminal." *Question: what symmetric padding value in points, or is this a third by-eye value for C1.5?*
- **AC-THIN — "cell-based pane minimums" carries no cell count.** Required by DoD-6 and constrained only by "the divider never appears to vanish." *Question: what minimum columns × rows per pane?*
- **AC-THIN — "a modest positive cell-height adjustment" is unnumbered** and explicitly deferred to signoff by eye; DoD-3 nonetheless requires it "implemented as specified." *Question: same treatment as the other by-eye values, or should C1.1 land a provisional number so the grid-survival check has something to test?*
- **AC-THIN — "every supported pane count" (DoD-7, C1.3 gate) is undefined.** The evidence requirement is photographs at every pane count, but the supported range is never stated. *Question: what is the supported pane-count range the focus affordance must be photographed at?*
- **OPEN-USER-RULING — C1.2's deferral of the live Increase Contrast signal to C1.4 is a stated scope reduction citing "Gate 9 bars `NSWorkspace` from the kit."** It is recorded as independently re-measured and cross-vendor confirmed, but it means DoD-9's Increase Contrast criterion cannot be satisfied until C1.4. *Question: does the user accept C1.2 landing with only the static half, with the live signal explicitly carried as C1.4 debt?*
- **Cross-story note (not a flag):** C1.2's gate cell cites two evidence documents by **file path and line number**, which C1's own DoD-13 prohibits ("All implementation documentation is behavioral and contains no code file paths or line-number references"). Whether the planning doc is bound by its own rule — which targets *implementation* documentation — is arguable, but the citation form is worth a ruling if the doc is meant to be self-consistent.
- **Dependency note:** C1 implementation cannot start until **B2.4** closes, and C1.5 cannot close until the **B2 integrated pane** exists. Approving C1 approves a plan whose critical path runs entirely through B2.

## #11 — M1-C2 · Packaging

Source: `planning/story-m1-c2-packaging.md` (41 lines)

### (1) Plan summary

C2 ships the Hive dev build as a self-contained, signed, notarized universal artifact that installs and runs the full M1 spine on a machine with no tmux, no user-installed Ghostty, and no Zig — proving the app carries everything it needs and has no residual dependency on the tooling the M1 cut removes. The doc exists specifically to close the "not actionable as written" finding in the reconciliation doc: C2's prior spec was one line in `backlog-outline.md` plus invariant I9, and two load-bearing ambiguities (what "signed, notarized" requires; what "clean machine" means) blocked it. Both are resolved by recorded user ruling — signing/notarization means a green run of the existing `.github/workflows/release.yml` pipeline on the post-cut tree, not a fresh per-cut attestation; "clean machine" means only a measured tmux-absence check, not a fresh account or separate hardware. C2 may be built early but can only close on the post-deletion tree.

### (2) Acceptance criteria checklist

- [ ] **1. Install from the packaged artifact.** "The artifact produced by the release pipeline is installed on an environment where `tmux` is verifiably absent from `PATH` — absence measured, not assumed (record the probe and its output, per the negative-control rule: show the probe reporting a positive on a machine that *does* have tmux, so an empty result is known not to be a broken reader)."
- [ ] **2. The app runs the full spine on that environment.** "Not a launch-and-quit smoke: the installed app exercises the M1 spine end to end (open the dev build → blank native terminal → create/type/scroll/resize/select/copy/close/reconnect) with no tmux present and no user-installed Ghostty or Zig."
- [ ] **3. The release workflow is green on the post-cut tree.** "`.github/workflows/release.yml` completes successfully on the tree that exists after the STORY-001/STORY-002 atomic cut. The run URL and the resulting artifact identity are recorded as the signing/notarization evidence. Per ruling 1, this run *is* the attestation."
- [ ] **4. Binding constraint.** "Criteria 1 and 2 must be satisfied by the artifact from the run in criterion 3 — not by a locally built app."
- [ ] **5. Dependency-derived gate (#59).** "A packaged artifact that still ships or depends on a testing-only support path has not proven what C2 claims to prove."

**Explicit non-goals** (recorded so absence is not read as oversight): a fresh user account; separate hardware / genuinely pristine machine; a fresh per-cut signing/notarization attestation (superseded by ruling 1).

### (3) Current completion state (doc's own status lines, quoted)

- "Milestone: M1, track C"
- "Backlog position: after B1+A2+B2 (integrated packaging); acceptance closes only on the post-cut tree"
- "Issue: #11"
- "State: spec written 2026-07-20 to close the 'not actionable as written' finding in `planning/2026-07-20-board-planning-repo-reconciliation.md` §3. The two blocking ambiguities are resolved by user ruling; recorded below."

There is no "Ready" or "Done" line — the doc reports only that the spec was written. No execution or completion is claimed.

**Fresh judgment on thickness (per the brief).** 41 lines is enough. Length is not the measure here; both rulings *collapsed* the open questions rather than expanding them. Each AC names a specific instrument (a measured PATH probe with a negative control; a named end-to-end spine sequence; a named workflow file plus recorded run URL and artifact identity), the binding line forecloses the likeliest cheat (local build substituted for pipeline artifact), and the non-goals section pre-empts scope creep. **I do not flag AC-THIN.** The real gaps are below.

### (4) Flags

- **AC-MISSING — universality is asserted but never tested.** The Goal says "universal artifact"; no AC verifies architecture coverage. Nothing requires `lipo -archs` (or equivalent) on the shipped binary, and nothing requires criteria 1 and 2 to run on both arm64 and x86_64. A green pipeline plus a single-arch install run satisfies all three ACs while leaving "universal" unproven. **Question:** must the install-and-run proof be executed on both architectures, or does a single-architecture run satisfy criterion 2?
- **AC-MISSING — the self-containment claim is not independently probed.** AC 2 requires absence of "user-installed Ghostty or Zig," but unlike tmux it prescribes no measured probe and no negative control. **Question:** should AC 1's measurement discipline (probe + positive control) extend to Ghostty and Zig, or is their absence assumed?
- **OPEN-USER-RULING — is a PATH-sanitized environment acceptable?** STORY-001 DoD-2 explicitly permits "(or PATH-sanitized env)"; C2 AC 1 says only "verifiably absent from `PATH`," which reads as permitting it — but C2 never says so. **Question:** confirm PATH-sanitization is acceptable, so the executor is not left to reconcile the two docs.
- **OPEN-USER-RULING — who reproduces?** STORY-001 and STORY-002 both require independent reproduction ("reproduced by someone other than the author"). C2 requires recording but never requires an independent reproducer. **Question:** intentional relaxation, or omission?
- **Scheduling note.** Per the human-gates runbook, C2's clean-machine acceptance is genuinely user-only (Gatekeeper, notarization, code-signature, two architectures, network absent) **but POST-CUT** — `backlog-outline.md:52` says it closes only on the cut tree, "so scheduling it now is premature… it will need hardware this one does not." #45 lists "C2 clean-machine install proof" under *expected to accrue*.

## #36 — M1-B1-MATRIX — Heavy GUI/live-vendor live-proof matrix cells (J/K/I, deferred from M1-B1)

**State:** OPEN · **Labels:** `type:matrix`

**(1) Plan summary.** A holding card, split out of M1-B1 by **queen's direction 2026-07-17**, so that four live-proof matrix cells that cannot be scripted against the bridge in isolation have a tracked home "instead of silently slipping or being declared done-by-omission when M1-B1 closes." The deferred cells: **I** (GPU/sleep/occlusion/perf — content scale, display id, drawable size on monitor moves, Retina↔non-Retina, live resize, sleep/wake, GPU-unhealthy/device recreation, idle CPU/frame pacing, no double draw); **J** (live VoiceOver + Accessibility Inspector proof of semantic rows/text, cursor, selection, scroll changes, announcements); **K** (real Claude, Codex and Grok interactive sessions as black-box terminal-compatibility probes only — "never provider policy — that's M2's boundary"); and **G (partial)** (real CJK/dead-key/emoji/RTL composition through an actual OS IME engine, added 2026-07-17 during gate-8 rework). Explicit scope boundary: this card does **not** own M1-B1's other P0 gates.

**(2) Acceptance criteria checklist.** **There are no acceptance criteria in this body.** It enumerates cells, dependency notes and a scope boundary, but states no pass condition, no evidence-artifact requirement and no closure test. The nearest thing to criteria are the per-cell descriptions of what must be exercised:
- [ ] I — "content scale/display id/drawable size on monitor moves, Retina<->non-Retina, live resize, sleep/wake, GPU-unhealthy/device recreation, idle CPU/frame pacing, no double draw"
- [ ] J — "live VoiceOver + Accessibility Inspector proof of semantic rows/text, cursor, selection, scroll changes, announcements"
- [ ] K — "real Claude, Codex, and Grok interactive sessions exercised against the bridge as black-box terminal-compatibility probes only"
- [ ] G (live) — "real CJK/dead-key/emoji/RTL composition exercised through an actual OS IME engine (interpretKeyEvents driven by a genuine input method, not a synthetic NSEvent standing in for one)"

Dependency constraints stated (not criteria, but gating): "**K blocks on M1-B2**"; "**J and I need full-app GUI automation**"; "G (live) likely also wants a real windowed app"; all are "also on the path to the later **REMOVAL-GATE vendor matrix**" and "likely the same evidence serves both."

**(3) Completion state.** The body carries an explicit status line, quoted verbatim:
> "Status: created 2026-07-17, unscoped for execution (blocked on B2 for K; J/I/G-live need a GUI-automation owner)."

No checkboxes. Issue state: **OPEN**.

**(4) Flags.**
- **AC-MISSING.** Confirmed from the body — no acceptance criteria section of any kind. *What is the closure test for each of I, J, K, G-live, and what evidence artifact discharges each?*
- **UNSCOPED / NO OWNER — verified from the body**, exactly as the carried context suspected. The status line self-declares "unscoped for execution" and states that J/I/G-live "need a GUI-automation owner." **OPEN-USER-RULING:** *(a) Who owns the GUI-automation pass — is it batched with M1-C1 (visual quality bar) as the body suggests, or run as a dedicated pass once B2 is live? (b) Is #36 an M1 blocker or does it defer past M1?* The body never says. *(c) Does one set of live sessions serve both #36 and the REMOVAL-GATE vendor matrix, as the body speculates ("likely the same evidence serves both")?* — that "likely" is an unresolved planning assumption, not a decision.
- **Cross-ref inconsistency worth a ruling:** #45 lists "**B2.6 live VoiceOver / Accessibility Inspector proof**" as an unchecked deferred item and says it "Corresponds to row **J** of #36." So row J is tracked in **two** places. *Which is authoritative, and does discharging one discharge the other?*

---

## #45 — M1 final end-to-end gate — deferred evidence checklist

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** The **canonical registry** of evidence deferred to the M1 final end-to-end gate. When a review *defers* a proof rather than waiving it, the debt gets a checkbox here with a pointer to its origin issue, "so deferred evidence is discovered at the gate, not after it." It also carries an "Expected to accrue" section (debts whose absence should be visible now rather than surprising at the gate) and an "Explicitly NOT on this list" section drawing a sharp line between *deferred* proofs and gates that are *by nature human*.

**(2) Acceptance criteria checklist.** This issue's criteria are its **Rule** plus its checkbox list. The Rule, verbatim and load-bearing:
> "**Nothing gets checked off without a pointer to the actual evidence artifact.** A claim that something was re-run, a green suite elsewhere, or an agent's report is *not* sufficient — the checkbox needs a link to the artifact (transcript, manifest entry, evidence file, commit) that a reviewer can open and verify. **An unpointed check is treated as unchecked.**"

Deferred evidence items (state as recorded in the body):
- [x] **Live b22 dead-broker Ctrl-C re-run** — deferred by `harold`'s ruling at closure of #41. "**DISCHARGED** 2026-07-20 by `henrietta` (landed `ed59a6b1`)." Two independent runs, distinct broker pids (51305, 52690), plus a **third run** at `e80c9e4b` because runs 1–2 predated the F6 teardown-reentry fix and "the canonical gate evidence would have been one commit stale." Results across all three: clean orderly exit in 1s, deliberate `process.exit(130)`, "**no refusal wedge**", "**no reconciliation spam** — 0 reconciliation lines, exactly 1 `SessiondBrokerUnavailableError`", "**no leaked processes**". Broker re-identified from `LOCAL_PEERPID` of the live socket, "never a remembered pid," positive-controlled against `ps comm`. Artifacts: `raw/qualification/hive-b22-dead-broker-ctrlc/` (3 probe captures, 3 transcripts, `provenance.txt`, `evidence-sha256.txt`), write-up `workspace/docs/hive-45-gate-evidence-henrietta.md`. Landed `0fc26a6c`.
- [x] **AppKit/Metal real-renderer main-thread proof** — "Gate 3 row E carve-out, **coupled to Gate 7**." Discharged by `hilda`'s landed Gate 7 slice, verified against this item's wording by `henrietta`. Artifact `raw/qualification/ghostty-b1-gate7-physical/main-thread-admission.txt` records "a **real** presented Ghostty IOSurface-backed layer (`layerIsIOSurface: true`, `drawCount: 1`, `hasPresentedContents: true`)". Mutation bites: off-main creation gives "`REAL_EXIT=133` (SIGTRAP)". Discharges "only because `3cb46484` fixed review finding **F3**" — the earlier artifact "recorded constants, not observations." Artifact selection itself positive-controlled via `artifact-binding-controls.txt` with "`mismatches=0`".
- [ ] **Live human resize-and-type acceptance in `make terminal`** — "a human resizes a live pane and types into it, confirming input survives the resize." The written repro "was tested faithfully and came back **NON-REPRO**: input was already dead pre-resize (`waitingForClaim`), so resize was the observation, not the cause." Reframed as a likely manifestation of the attach/claim defect (**#47**). "This checkbox is the *final* acceptance and **cannot be satisfied by an automated run**." Origin #40 (open).
- [ ] **Gate 7 — two restored OPEN rows**: "Instruments (minimized / after-wake) and **ASan**." Previously recorded as covered; re-qualification (`29ffd455`, hester delta-PASS) "did not carry their evidence forward, so they are restored to OPEN rather than left as silently-covered." Origin #7.
- [ ] **B2.6 live VoiceOver / Accessibility Inspector proof** — added when B2.6's "**machine slice closed** (landed `4db42977`, `hedda`)". The machine slice "proves the AX tree is **structurally sound and self-consistent**; it does not and cannot prove what a screen reader actually announces." Slots are `PENDING_HUMAN`. "Corresponds to row **J** of #36." Origin #8 (closed — "its closure explicitly does not claim these").

**Expected to accrue** (not yet checkboxes):
- [ ] "**Gate 7 HUMAN-REQUIRED items** from `hilda`'s work — real dual-display Retina / non-Retina, and sleep/wake… need a human at real hardware. To be added when hilda's pin lands."
- [ ] "**C2 clean-machine install proof** — joins when the C2 story starts (#11)."

**Explicitly NOT on this list:** "**C1.5 aesthetic signoff** — that is its own human gate on #10, not deferred evidence."

**(3) Completion state.** Explicit and well-instrumented: **2 of 5 checked (both DISCHARGED with artifact pointers), 3 unchecked**, plus 2 expected-to-accrue not yet added. Issue state: **OPEN**. This is the highest-fidelity status record of the 17.

**(4) Flags.**
- **No AC-MISSING, no AC-THIN.** The Rule is executable and the discharge entries demonstrably meet it (artifact paths, shas, positive controls, mutation records).
- **OPEN-USER-RULING (blocking dependency).** Two unchecked items are **not independently actionable**: the resize-and-type item is blocked on the attach/claim defect **#47**, and it requires **`make terminal`** — which **#59 directs to be deleted before M1 is done.** *Direct conflict: #45's final human acceptance is written against `make terminal`, and #59 removes `make terminal` as an M1 exit criterion. Which happens first, and does the acceptance get rewritten against the production path?* #59 anticipates exactly this ("verify nothing in the live-proof runbooks depends on `make terminal` before deletion") but names only `planning/m1-human-evidence-session-runbook.md`, **not #45**.
- **OPEN-USER-RULING (double-tracking).** B2.6 live VoiceOver is tracked here *and* as row J of **#36**. *Single owner?*
- **Note from #55:** #45 "carries a note naming #2 as its blocker" per #55's remediation text — **that note is not present in the #45 body as fetched.** *Was it added elsewhere, or is the remediation incomplete?*

---

## #59 — M1 exit — remove `make terminal` and all temporary testing-only support code

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** A **user directive (2026-07-20)**: before M1 is done, remove all `make terminal` commands and any code existing only to support `make terminal` — "it was temporary, for testing only." Scope: delete the target(s) from the Makefile; sweep for code whose only caller/consumer is that target (scripts, flags, harness shims) and remove it; and prove the sweep mechanically. Positioned as an M1 exit criterion alongside the atomic tmux cut.

**(2) Acceptance criteria checklist.**
- [ ] "Delete the `make terminal` target(s) from the Makefile."
- [ ] "Sweep for code whose only caller/consumer is that target (scripts, flags, harness shims) and remove it."
- [ ] "**Prove the sweep with a dry-run comparator (`make -n` diff per surviving target) so the removal is provably docs/target-only for everything else.**"
- [ ] "This is an M1 exit criterion alongside the atomic tmux cut (#1/#2): **M1 closes only when Hive runs on the new terminal with no tmux and no temporary terminal harness.**"
- [ ] "verify nothing in the live-proof runbooks (`planning/m1-human-evidence-session-runbook.md`) depends on `make terminal` before deletion; **if a runbook step uses it, the step must be rewritten against the production path first.**"

**(3) Completion state.** No status lines or checkboxes. Issue state: **OPEN**. Completion: **unstated**.

**(4) Flags.**
- **Not AC-MISSING; borderline AC-THIN on the sweep.** The `make -n` comparator requirement is genuinely executable and well chosen. But: *"code whose only caller/consumer is that target" is a judgement call — how is "only caller" established?* A grep line list is not call-site attribution; helpers hide calls one level down. *Does the user want a stated method (e.g. remove-and-build, or per-symbol reference proof) rather than a sweep-by-inspection?*
- **OPEN-USER-RULING (hard conflict with #45).** The runbook caveat names only `planning/m1-human-evidence-session-runbook.md`. It **misses #45**, whose unchecked final human acceptance is written *explicitly* against `make terminal`: "**Live human resize-and-type acceptance in `make terminal`** … This checkbox is the *final* acceptance and cannot be satisfied by an automated run." ***Ordering question the user must answer: does the #45 human acceptance run before `make terminal` is deleted, or does #45's acceptance get rewritten against the production path first?*** Both are M1 exit criteria and as written they are mutually blocking. This is, in my read, the sharpest unresolved sequencing conflict in the package.
- Secondary: `planning/m1-human-evidence-session-runbook.md` is 37KB — the dependency check on it is real work, not a glance.

---

## #60 — M1 AC — agent's own exit command closes the agent, terminal pane stays open, Hive records the closure

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** A **user AC (2026-07-20)**. In an agent's TUI, running that agent's own exit command (e.g. `/exit`) must close the agent while leaving the terminal pane open — establishing that **terminal lifecycle and agent lifecycle are decoupled** — and Hive must record the closure with the work-preservation flow running. It draws an explicit M1/M3 boundary on detection richness, and an explicit non-goal.

**(2) Acceptance criteria checklist.** Three numbered criteria, verbatim:
- [ ] 1. "Close the **agent** — the vendor process ends."
- [ ] 2. "Leave the **terminal pane open** — terminal lifecycle and agent lifecycle are decoupled. The pane stays, showing the ended session."
- [ ] 3. "**Hive records it** — the agent is marked closed and the work-preservation flow runs (unlanded commits preserved, stranded-work envelope if applicable)."
- [ ] Boundary clause: "Detection here means the lifecycle record updates; the richer TUI detection classes (question-waiting, idle-when-should-work, vendor security stop) are **M3 scope**."
- [ ] Non-goal: "**Non-goal (M1): queen opening/closing blank terminals — that is M3, with communication.**"

**(3) Completion state.** No status lines or checkboxes. Issue state: **OPEN**. Completion: **unstated**.

**(4) Flags.**
- **AC-THIN (mild).** The three criteria are clear in intent but under-specified for proof. *Which vendors must this be proven on — all of Claude, Codex, Grok (and later Kimi Code, opencode), or one as representative?* The body says "an agent's TUI" without quantifying. *Is the exit command per-vendor (`/exit` is given only as "e.g.") — does M1 require the mapping for every supported vendor?* *What is the observable for criterion 3 — a lifecycle row in the DB, a `hive_status` read, or a preserved-branch ref?* Given the repo's own experience that a reap message is not a completion report and that path-keyed reads alias across respawns, "Hive records it" needs a named, queryable artifact.
- **OPEN-USER-RULING.** *Vendor coverage for M1 acceptance — one vendor or all?* This determines whether #60 is a small card or a matrix.
- Note the clean complementarity with **#62**: #60 is the M1 half of lifecycle decoupling, #62 the M3 half. That boundary is consistent across both bodies.

---

## Human gates — the M1 evidence session (things only you can do)

Source: `planning/m1-human-evidence-session-runbook.md` (744 lines). Gate order below follows the doc's execution order (Phase 1 → 4).

Global framing, verbatim: **"Four gates are runnable today. A4 is blocked"** · **"This list is closed at five."** · **"You are the only person who can do any of this. Every gate here refuses to be satisfied by an agent, and every one refuses a locked screen."** · **"You need no second machine for anything here."**

### §0 Pre-flight — not a gate, but every gate is blocked on it

- Attach **two displays, one Retina and one non-Retina, both online, not mirrored, extended desktop**. "Gate 7 accepts nothing else — it asserts the content scales *differ*."
- Be at an **unlocked Aqua session at the physical machine**. "Not ssh, not a locked screen, not an agent shell. The production surface returns nulls otherwise."
- Power settings that permit real sleep. "Prefer Apple menu → Sleep over clamshell; clamshell only counts if the external display keeps the session alive."
- Launch **Accessibility Inspector** (Xcode → Open Developer Tool). "Confirm it launches *now*, not in Phase 2." Confirm VoiceOver reachable via **Cmd-F5**; "Leave it **off** for now."
- Open **TextEdit** and put "a known, distinctive string on the clipboard" — the probe-#5 baseline.
- Verify toolchain: `xcrun --sdk macosx --show-sdk-path` succeeds; Bun at locked version.
- Run `make build` **before you sit down** ("it is the long pole"). Checkbox: "`make build` ended with `staged: hive 0.0.0 (<sha>, …)`."
- Port hygiene, immediately before Phase 2 **and between any two `make terminal` runs**: `/usr/sbin/lsof -ti :43117 | xargs -r kill -9` then `pkill -f hive-sessiond`.

**Five traps to read first (§0.5).** `hive build`/`hive run` **do not exist** (use `make build`/`make run`; bare `hive` launches installed release 0.0.37, not your tree) · `demo-preflight`'s console check "does not prove your screen is unlocked" · `log` is a zsh builtin, always spell `/usr/bin/log` · NSLog text is `<private>`, so "Do not build any pass/fail judgement on reading app log strings" · **the queen pane is SwiftTerm** while Gate 9 / #45 / B2.6 are claims about the **Ghostty/sessiond** stack — "a capture of the queen pane proves nothing for them."

**Contamination watch, all of Phase 2:** **#48** (visibility publish HTTP 409 loop, occurs "even in healthy runs") and **#52** (teardown leaves Workspace GUI running). Rule: "if it perturbs what you are trying to observe, **stop, tear down, and redo the run** rather than saving a polluted artifact."

---

### Gate 1 — Gate 7 §A, dual-display Retina ↔ non-Retina (Phase 1) · **RUNNABLE**

**Prereq:** `make build` complete (GhosttyKit.xcframework staged — "Gate 7's `swift test` will not even link without `workspace/Vendor/GhosttyKit.xcframework` staged, and it is a build output, not a checked-in file"). Two displays, differing scales, not mirrored. **No live stack needed** — "This is a pure XCTest, which is why it goes first: it validates your display setup before you invest in bringing the stack up."

**You personally:**
1. Capture display inventory → `…/ghostty-b1-gate7-physical/human-dual-display-inventory.txt`.
2. Run the opt-in test **in the foreground, do NOT background it**: `HIVE_GHOSTTY_GATE7_PHYSICAL=1 swift test --filter Gate7RenderingTests/testPhysicalMonitorScaleAndSleepWakeQualification 2>&1 | tee …/human-dual-display-transcript.txt`, then `echo "EXIT=${pipestatus[1]}" | tee -a …`. `HIVE_GHOSTTY_GATE7_PHYSICAL_SLEEP` is **omitted here** — sleep is Phase 3.
3. When the test prints `GATE7 PHYSICAL: drag the qualification window to the other-scale display`, **drag the titled window fully onto the other display within 120 s**.

**Pass/fail, verbatim:** step 1 — "**Passes if:** both displays show `Online`, `Mirror: Off`, and their scales differ (Retina ~2.x vs non-Retina 1.x)." / "**Fails if:** one display missing, mirroring on, or both the same scale… Do not proceed — the test asserts on this." · step 3 — "**Passes if:** the test continues on its own — display ID *and* content scale both change, 2 s of idle frame silence, drawable size equals `convertToBacking`. Transcript ends with `test passed` and `EXIT=0`." / "**Fails if:** the 120 s window lapses, or the scale observation never changes because the window was only partly moved. Drag it *entirely* onto the other screen." / "**Beware:** `swift test`'s trailing banner can say '0 tests' while XCTest actually ran the case. Judge from the body of the transcript and `EXIT=`, not the tail line."

**You sign off:** the transcript + inventory files are the attestation. "Each replaces a `STATUS=PENDING_HUMAN` placeholder. **`.txt`, never `.log`.**"

**Status:** not yet run — the slot is a `STATUS=PENDING_HUMAN` placeholder. **Time:** "**unknown** + a 120 s drag window."

---

### Gate 2 — #45 live resize-and-type, VoiceOver OFF (Phase 2a) · **RUNNABLE**

**Prereq:** port hygiene, then **one** live `make terminal` stack up (Step 2.0), VoiceOver **off**, done **first, on a clean pane, before any Gate 9 probe has perturbed it**. Do not tear the stack down between §2a/§2b/§2c. Do not run `make run` concurrently — "One stack at a time." Leave the driver terminal alone: "**Ctrl-C there tears the whole stack down**."

Step 2.0 success signals: "`launching a real interactive login shell (keep the Aqua session unlocked)`", a HiveWorkspace window with a live pane running your real login shell, and `terminal stack is up — click the terminal pane and type a command; Ctrl-C here tears down`. Failure signals: `port 43117 is in use` · `log into an unlocked Aqua session` · "a pane that is themed but permanently empty (missing/mismatched GhosttyKit — re-run `make build`)" · "a **red badge / 'renderer disconnected'** (sessiond attach failed — broker not ready)."

**Acceptance quoted from #45:** "*a human resizes a live pane and types into it, confirming input survives the resize.*" It "cannot be satisfied by an automated run."

**You personally:**
1. Click into the pane. Type `echo pre-resize-alive`, Return. "**See:** `pre-resize-alive` echoed by your real shell. This is the precondition. If it does not echo, input was dead on arrival — that is the #47 class, not #45; record it and stop."
2. Resize the window by dragging a corner, "materially changing both width and height (a few columns is not a test; make it obvious)."
3. **Without clicking anywhere else**, type `echo post-resize-alive`, Return. "**See:** `post-resize-alive` echoed. **This is the pass.**"
4. Resize once more in the other direction, type a third line.
5. `mkdir -p …/raw/qualification/hive-45-live-resize-input` (directory does not exist yet).

**Why the pre-check matters, verbatim:** "the original written repro came back **NON-REPRO** because input was **already dead before the resize** (`waitingForClaim`)… A run that only shows typing working after a resize does not distinguish 'input survived' from 'input was never broken'." Origin defect **#47 is now CLOSED**, so this is unblocked.

**Pass/fail, verbatim:** "**Passes if:** all three echoes appear, with the pane reflowing at each resize." / "**Fails if:** typing stops being echoed after a resize while it worked before — that is the real defect, and it is the finding worth having." / "**Beware:** if the pane area ever drops below 40×40 pt the child is never spawned and the pane goes silently blank. Do not shrink that far."

**You sign off:** write `human-resize-input-transcript.txt` — "an operator transcript of what you typed, what echoed, and the before/after window dimensions. Include the run's `HIVE_B22_HOME` and the session id from the driver output so the run is identifiable." Optional screen recording: "**cite the path, do not commit the media**." Then per #45's rule — "*an unpointed check is treated as unchecked*" — "When you tick the box on issue #45, paste the repo-relative artifact path and the landing sha."

**Status:** not yet run. "No directory exists for this yet." No `evidence-sha256.txt` here, so no re-seal step. **Time:** "**unknown** | No doc gives a basis."

---

### Gate 3 — Gate 9 ten-probe manual acceptance, VoiceOver OFF (Phase 2b; probe #10 in §2d) · **RUNNABLE**

**Prereq:** same live stack, VoiceOver off, run after §2a. TextEdit open with your distinctive baseline clipboard string. Injection model: "`make terminal` runs your **real login shell** in the pane, so the pane *is* the agent side. Type each `printf` directly into the pane and observe the **host** (window chrome, notifications, clipboard, browser)." Purpose: "the *subjective* halves that the automated matrix cannot assert — 'Hive's own UI responded appropriately.'" Source: `raw/qualification/ghostty-b1-actions/manual-acceptance.md`.

**"Run probes 1–9 now. Probe #10 is deferred to §2d — it destroys the pane."**

| # | Type into the pane | PASS | FAIL |
|---|---|---|---|
| 1 | `printf '\033]0;SPOOFED-TITLE\007'` | "Pane/tab **title** changes to SPOOFED-TITLE — Hive-attributed UI only" | "App/window chrome *beyond* the pane title changes, **or** nothing updates at all (event path dead)" |
| 2 | `printf '\a'` | "Hive's own bell/attention indicator for that pane; no system-wide alert" | "A macOS notification, or nothing if Hive ships a bell indicator" |
| 3 | `printf '\033]9;you have been pwned\007'` | "**Nothing.** No notification banner; terminal keeps working" | "Any banner posted" |
| 4 | `printf '\033]777;notify;t;b\007'` | "Same as #3" | "Same as #3" |
| 5 | `printf '\033]52;c;aGVsbG8=\007'` then **Cmd-V in TextEdit** | "Your **baseline clipboard string** pastes — pasteboard unchanged" | "`hello` pastes — terminal bytes wrote your clipboard" |
| 6 | `printf '\033]52;c;?\007'` | "No reply garbage in the stream; nothing arrives at your prompt" | "A base64 blob appears at the prompt — clipboard exfiltrated" |
| 7 | `printf '\033]8;;https://example.com\007CLICK ME\033]8;;\007'` then **click** and **Cmd-click** | "No browser opens, ever" | "A browser opens" |
| 8 | Press **Cmd-N, Cmd-T, Cmd-W** with the pane focused | "Hive's own window/tab behaviour, or nothing. The **terminal** does not spawn Ghostty windows/tabs. Keys Hive does not bind reach the terminal as input" | "A Ghostty-native window/tab/split appears" |
| 9 | `read -s`, type a password, Return | "No secure-input flip caused by the **pane**; menu-bar padlock behaviour unchanged; Hive is not the secure-input owner" | "Secure input engages system-wide from agent output" |

Setup warning: "Probe #5 is the one to set up carefully — put a distinctive string on the clipboard *before* you run it, or you cannot tell 'unchanged' from 'changed to something similar'." And: "Note #53 (Gate 9 OSC 52 pasteboard flake) is a known flake **in the automated instrument**, not in this claim. If probe #5 or #6 behaves ambiguously, repeat it rather than recording an ambiguous result."

**You sign off:** `human-manual-acceptance-transcript.txt` in `raw/qualification/ghostty-b1-actions/` — "One line per probe: probe number, exactly what you typed, exactly what you observed, and PASS/FAIL. Record the run's session id. There is **no `evidence-sha256.txt`** in this directory, so no re-seal step."

**Status:** not yet run; probe #10 deferred to §2d. **Time:** "**~10 min**" — the only measured estimate in the runbook.

---

### Gate 4 — B2.6 Accessibility Inspector, then VoiceOver (Phase 2c; `teardown` in §2d) · **RUNNABLE**

**Prereq:** same live stack still up; Inspector already confirmed launchable in §0. Machine slice: "The machine slice closed at `4db42977`; it proves the AX tree is structurally sound and self-consistent, and **cannot** prove what a screen reader announces. That is what you are supplying." Re-prove it first: `HIVE_B26_AX_EVIDENCE=../raw/qualification/hive-b26-gate10-accessibility swift test --filter Gate10AccessibilityTests`.

**Part A — Accessibility Inspector (VoiceOver still OFF).** "Inspector does not need VO, and doing it first keeps the keyboard yours for a little longer."
1. "Open Accessibility Inspector; target the **terminal content area** of the live pane."
2. Confirm against the machine dumps (`ax-tree-*.txt`): "role is `AXTextArea` / `textArea`" · "one `staticText` child element per visible terminal row" · "frames non-zero for non-empty rows while the window is on screen" · "focus follows first responder" · "`value` / `selectedText` / insertion line match what is on screen".
3. "Run **Inspector → Audit** on the terminal element."

**Pass/fail, verbatim:** "**Passes if:** role and child row count are consistent with the shape in `ax-tree-input.txt`; no stale or duplicate row elements; the audit reports no broken parent/child for the terminal subtree." / "**Fails if:** duplicate rows survive a scroll or resize, or the audit names `HiveTerminalView` or a row element in a finding."

**Artifact:** `human-inspector-audit-transcript.txt`, replacing the `PENDING_HUMAN` placeholder. "**Include the audit's pass/fail counts** and the full text of any finding naming `HiveTerminalView` or a row element."

**Part B — VoiceOver on (Cmd-F5).** "From here the keyboard belongs to VO." Work through all eight steps, ticking the six scenario boxes in §C of the checklist:
1. "Focus the live pane. Navigate **by row** (VO-Down/Up) through several rows. → `input`"
2. "Locate the **cursor / insertion point** announcement."
3. "Type a short command; confirm committed output is announced or readable. → `input`"
4. "**Select** text (Shift-arrows or drag); confirm the selection is spoken."
5. "**Scroll** scrollback; confirm row focus survives without a full-tree wipe. → `scroll`"
6. "Trigger an **alternate-screen** app (e.g. `less` on a long file), then exit it. → `alternate screen`"
7. "**Resize** the window with VO on; confirm rows are re-announced coherently. → `resize`"
8. "Force a **reconnect / mark-lost** path if available; confirm the lifecycle label ('Terminal lost/exited/…') is spoken or inspectable. → `replay / reconnect`"

"The sixth scenario, `teardown`, is covered in §2d."

**Pass/fail, verbatim:** "**Passes if:** rows, cursor, selection, typed input, and lifecycle are all reachable by VO." / "**Fails if:** any of those is silent or unreachable, or scrolling wipes and rebuilds the whole tree instead of moving focus."

**You sign off:** "`human-voiceover-transcript.txt` — what you did and what VO *said*, step by step. **Quote the speech; that is the whole evidentiary value.** If you screen-and-audio record, **cite the path in the file; do not commit the media into the repo.**"

**Status:** not yet run — Part A's slot is an explicit `PENDING_HUMAN` placeholder. **Time:** "**unknown** … budget generously."

---

### Gate 5 — §2d combined teardown: Gate 9 probe #10 **and** B2.6 `teardown` · **RUNNABLE**

"One action, two gates. Keep VoiceOver **on** so you can check for zombie AX focus." Framing: "**Gate 9 probe #10 and B2.6's teardown tick are the same physical action** — closing a pane while it is spewing output. You do it once, at the end of the live-stack phase, and it discharges both."

**You personally:**
1. "In the pane, run `yes` so it is spewing output continuously."
2. "**Close the pane** while it is still spewing."
3. "**Then turn VoiceOver off (Cmd-F5), and tear the stack down** with **Ctrl-C in the driver terminal**. Re-run the port hygiene from §0 before anything else."

**Pass/fail, verbatim:** "**Gate 9 #10 passes if:** the pane closes cleanly — no crash, no hang, no orphan window. (That is the delivery-after-free class.)" / "**B2.6 teardown passes if:** VO reports **no hanging AX focus on destroyed rows** — no zombie focused element." / "**Fails if:** a crash or hang, an orphaned window, or VO still announcing rows that no longer exist." / "**Contamination check:** if the Workspace **GUI window survives** the teardown, that is **#52**, a known separate defect — not a Gate 9 #10 failure. Say so explicitly in both transcripts rather than recording a false FAIL."

**You sign off:** "Record the result in **both** `human-manual-acceptance-transcript.txt` (as probe #10) and `human-voiceover-transcript.txt` (as the `teardown` scenario)." **Status:** not yet run.

---

### Gate 6 — Gate 7 §B, sleep / wake (Phase 3) · **RUNNABLE**

"Last, because it disrupts everything. Second display still plugged in."

**Prereq:** live stack **torn down** and port hygiene re-run. Second display still attached. Power settings that permit real sleep. The drag is repeated inside this run: "This run does the **drag again first**, then sleep."

**You personally:**
1. Run with **both** env vars: `HIVE_GHOSTTY_GATE7_PHYSICAL=1 HIVE_GHOSTTY_GATE7_PHYSICAL_SLEEP=1 swift test --filter Gate7RenderingTests/testPhysicalMonitorScaleAndSleepWakeQualification 2>&1 | tee …/human-sleep-wake-transcript.txt`, then the `EXIT=` line.
2. Complete the drag when prompted.
3. On `GATE7 PHYSICAL: sleep and wake the Mac now` — "put the Mac to sleep (Apple menu → Sleep; clamshell only if the external display keeps the session alive — **prefer full system sleep**), wait **≥5 s**, wake, and unlock if prompted."
4. "You may now unplug the second display."

**Pass/fail, verbatim:** "**Passes if:** `wakeTransitionCount` advanced, applied occlusion is visible after wake, no crash and no hung draw path, `EXIT=0`." / "**Fails if:** the test's 600 s wake wait lapses (the machine never actually slept — check your power settings), or occlusion never re-applies as visible."

**Optional §C — Instruments:** "**Only if queen asks for it.** Time Profiler + Allocations + Activity Monitor against the running xctest process during the drag, while minimized, and after wake. **Do not use Power Profiler** — it is iOS/iPadOS-only and is already recorded as a measured negative control. Export run notes as `instruments-human-*.txt`."

**Status:** not yet run. Related: "**Gate 7's two restored OPEN rows** — Instruments (minimized / after-wake) and **ASan**. Re-qualification did not carry their evidence forward. §3's optional Instruments block covers part of the first; **ASan is untouched here**." **Time:** "≥5 s sleep, **up to 600 s** wake wait | Total unknown."

---

### §4 Phase 4 — seal the evidence (required close-out, not an acceptance gate)

1. Confirm no residual placeholders: `grep -rl "PENDING_HUMAN" raw/qualification/ghostty-b1-gate7-physical raw/qualification/hive-b26-gate10-accessibility` — "Expect **no output** for the slots you filled."
2. Regenerate `evidence-sha256.txt` in the **two** dirs that carry one. "Note the two commands differ — Gate 7's excludes `*.trace`, B2.6's does not." `ghostty-b1-actions/` and the new `hive-45-live-resize-input/` do **not** get sealed.
3. "**Format rule, all four gates: `.txt`, never `.log`.**"
4. "Then tell queen the human rows are filled for cross-vendor review, and tick the two boxes on issue **#45** … each **with a repo-relative artifact path**, per #45's rule that an unpointed check is treated as unchecked."

---

### Gate 8 — A4 faithful app-quit · **BLOCKED. Do not attempt this session.**

"Read this section for the 'why'; there is nothing here for you to run today."

**Status per the doc's own source:** three of four cells GREEN (exact per-pane close, non-Hive project, restart/reconnect/replay). The quit cell — `raw/qualification/hive-b25-production-pane/manifests/a4-quit.json` — records `"ok": false`, `"status": "COMPOSED-NOW/FAITHFUL-PENDING-UNLOCK"`, `"requiresUnlockedProductionStack": true`. "Composition is explicitly **not** the faithful run."

**Why not runnable:** `scripts/b22-live-attach-proof.ts` (the vehicle behind `make terminal`) "hosts the daemon **in its own Bun process**", so the production self-owned quit handshake cannot be exercised. Both attempts are recorded as negative evidence — `NSApp.terminate` alone (Workspace and harness daemon both stayed alive, no `final.json`) and `performClose` then `NSApp.terminate` (Workspace exited but "the sessiond host was left a zombie"). Disposition: "*these attempts MUST NOT satisfy the faithful app-quit row.*"

**Root blocker:** "**A4's faithful quit is blocked on B2.5's production-wiring pane, not merely on a missing script.**" The broker "authenticates every `broker.sock` client by **kernel peer identity against `daemon.lock`**", so a side-car harness "can never pass." Effort: "**unknown**, and honestly so."

**Can it be hand-run?** "**No — not in a way that counts.**" Acceptance is "**specific manifest fields**, not an impression: `final.json` with `state: 'terminated'` and `survivors: []`, plus demonstrated absence of the captured process tree."

**Recommendation, verbatim:** "leave A4 out of this sitting entirely… A4 would only add a failed attempt to it." Also: "Any future A4 run must record whether #52 appeared."

---

### Not runnable this session — and why

| Item | Why |
|---|---|
| **A4 faithful app-quit** | Blocked on **B2.5's production-wiring pane (OPEN)** + a missing read-only observer harness. Broker peer-identity auth makes any side-car harness impossible. |
| **C1.5 aesthetic signoff** | "Depends on C1.3 and C1.4 (neither started) and closes only after the B2 integrated pane. It is the true last gate of M1 and cannot be pulled forward." |
| **Gate 7 restored OPEN rows** | Instruments (minimized/after-wake) and ASan — evidence not carried forward; "**ASan is untouched here**." |
| **Gate 4 notarization** | "blocked on Apple notary credentials, not on you being at the machine." |
| **B2.5 row K** | "the vendor matrix, agent work, blocked on vendor quota." |
| **STORY-001 DoD 2 clean machine** | **Not yours** — "**Agent-doable.**" "*(An earlier draft of this runbook said you had to be that second operator. That was wrong.)*" |
| **B2 DoD-7 clean machine** | **Not yours** — "**Agent-doable by a different-vendor agent.**" |
| **C2 acceptance clean machine** | Genuinely user-only (Gatekeeper, notarization, code-signature, **two architectures**, network absent) **but POST-CUT** — "scheduling it now is premature… it will need hardware this one does not." |
| **A3/B2.3 six rows + B3 GAP-3** | Need the mode-emitting PTY child harness — "pure agent work and does not touch this session." |

Net, verbatim: "**bring no second machine to this sitting.**"

### Flags on the human gates

- **AC-THIN — Gate 9 probe #2 (bell).** FAIL is "A macOS notification, **or nothing if Hive ships a bell indicator**" while PASS is "Hive's own bell/attention indicator." If nothing visible happens, the verdict depends on a fact the doc never states. **Question:** does Hive ship a bell/attention indicator for a pane? If not, is "nothing happened" a PASS or a FAIL?
- **AC-THIN — Gate 9 probe #8 (Cmd-N/T/W).** PASS is "Hive's own window/tab behaviour, **or nothing**" — an unbounded PASS, in contrast to probe #1 where "nothing" is explicitly a FAIL. **Question:** which of Cmd-N / Cmd-T / Cmd-W does Hive actually bind, so an intended Hive response is distinguishable from a dead key path?
- **AC-THIN — B2.6 Part A "consistent with the shape in `ax-tree-input.txt`."** No numeric expectation; "child row count consistent" is judgement, against the doc's own §0.5 warning about impression-based judgements. **Question:** what row count / role shape does `ax-tree-input.txt` record, so "consistent" is a comparison?
- **AC-THIN — B2.6 Part B step 8, "Force a reconnect / mark-lost path *if available*."** The `replay / reconnect` box must be ticked but the doc never says how to force it. **Question:** what concretely forces mark-lost, and if nothing does, is the box ticked, blank, or waived?
- **AC-THIN — Gate 2 (#45) has no checklist and no `evidence-sha256.txt`;** its artifact format is prose only. **Question:** does the resize transcript need fields beyond `HIVE_B22_HOME` + session id, given #45 requires a landing sha at tick time while the run happens before the landing?
- **OPEN-USER-RULING — §3 optional Instruments.** "**Only if queen asks for it.**" **Question:** run Instruments in Phase 3 (the only chance this sitting, since the second display comes out afterwards), or do Gate 7's Instruments OPEN rows stay open?
- **OPEN-USER-RULING — §0.5 contamination judgement.** You are sole judge of "perturbs." **Question:** for #48's 409 storm specifically, what is your threshold for redoing a run versus noting it and continuing?
- **OPEN-USER-RULING — #52 attribution at teardown.** **Question:** if the GUI window survives, do you accept Gate 9 #10 as PASS-with-#52-noted, or hold it pending #52's fix?
- **OPEN-USER-RULING — time budget.** "Three of the six numbers are genuinely unknown and inventing them would be worse than saying so. **Do not plan this around a hard stop.**" **Question:** start `make build` well ahead and sit without a hard stop, or split Phase 3 into a second sitting? (Splitting costs a second display-plug event.)
- **AC-MISSING — no gate defines sign-off wording.** Every attestation is a transcript file plus placeholder replacement; there is no operator-signature line, name, or date field. **Question:** do transcripts need an operator identity/date header for cross-vendor review, or is file presence plus `EXIT=` sufficient?

## #1 — STORY-001 · Gut ALL tmux terminal code (complete removal, no legacy shims)

Source: `planning/story-001-gut-tmux.md`

### (1) Plan summary

STORY-001 removes every behavior through which Hive touches tmux — the old process host and terminal transport for every agent session — as a hard cut with no legacy shims. It is backlog position #1 and was fully specified first so every other M1 story builds toward its gate rather than toward coexistence, but it **executes last**, at the Removal Gate: the replacement (sessiond + `SessionHost` backend + HiveTerminalKit) must be live-proven across the full vendor matrix before removal is permitted, because you cannot remove the process host that runs agents before its replacement runs agents. There is no dual-host flag and no canary — the story explicitly overrides the reference design doc's gradual dual-host migration on the grounds that this is a dev build. It executes as one atomic merge train with STORY-002, on main progressively, with a pinned isolated bootstrap Hive orchestrating development and performing a pre-cut drain of legacy sessions before the cut is allowed to land.

### (2) Acceptance criteria / Definition of done (verbatim)

- [ ] **1. Zero production reference:** "no source file, package manifest, script, or shipped artifact references tmux (`grep -ri tmux src/ workspace/Sources native/ scripts/ package.json` → only historical docs/ADR mentions, which the doc-cleanup task rewrites as past-tense history)."
- [ ] **2. Live proof on a tmux-less machine:** "on a machine (or PATH-sanitized env) with **no tmux binary installed**, a dev build launches Hive, creates a session generation, runs each of the three real vendor TUIs (manually launched — M1 boundary), types/scrolls/resizes, closes with positive process-termination readback (waitpid evidence), and survives daemon restart + renderer reconnect. Recorded (screen capture + transcript) and reproduced by someone other than the author. Matrix re-run on the post-deletion tree (atomic cut)."
- [ ] **3. Identity replacement proven at the generic-session level (M1 boundary per atlas R3 P0-2):** "session identity carries exact host locator + generation; no tmux host kind or `tmuxSession` field remains in schemas, DB, successor protocol, or its TS/native/Swift mirrors. A generic session round-trips create → byte input → inspect → terminate through the new locator. (The full agent spawn→message→status→teardown round-trip is M2 scope and does NOT gate this story.)"
- [ ] **4.** "Full TS suite + typecheck green; Swift tests green; Zig sessiond tests green."
- [ ] **5. No legacy shims:** "review confirms no dual-host flags, no compat writes, no re-introduced tmux fallbacks."
- [ ] **6. Project-agnostic:** "nothing in the replacement wiring assumes the Hive repo, Bun, or any specific project layout; verified by launching the dev build on a non-Hive repository."
- [ ] **7. Doc-cleanup task (paired, same milestone):** "rewrite `docs/daemon/*`, `docs/providers/launch-mechanics.md`, `docs/workspace/*`, `README.md`, `SPEC.md` terminal sections, and `docs/terminal/legacy-terminal-postconditions.md` to describe the new behavior and contracts. **No doc may reference code by file path or line number** — behavior and contracts only."
- [ ] **8.** "Fresh external research drives; current code state and design docs are reference, not truth (stated here per the rebuild's hard principles)."

**Gating conditions stated outside the DoD but binding on execution:**

- [ ] **Removal Gate matrix, every cell:** "real Claude Code, Codex, AND Grok interactive TUIs each exercised live in the new host; daemon restart + renderer reconnect; PTY resize/SIGWINCH; EOF/exit with authoritative `waitpid` reap evidence (kevent EVFILT_PROC is notification, not proof); process-tree containment; sustained-output backpressure (100 MiB class) with no byte loss; crash survival with bounded replay. **If ANY matrix cell fails, this story cannot execute.**"
- [ ] **Atomic-cut constraint:** "Two separately-green PRs are NOT acceptable."
- [ ] **Pre-cut drain:** "the cut is refused while any legacy session or process survives; emptiness is positively proven (live tmux server query + process-table readback, not absence-of-error); incompatible dev DB/runtime state is archived and destructively RESET." "The new build ships with zero legacy readers."
- [ ] **Execution-time inventory:** "regenerate a fresh exact-reference inventory of files/symbols and attach it to the story as EPHEMERAL evidence."

### (3) Current completion state (doc's own status lines, quoted)

- "Milestone: M1 (this story is the cut that completes M1)"
- "Backlog position: #1 — ground zero of the rebuild. Written and specified first; **executed at the Removal Gate** (see Sequencing)."
- "State when board access lands: **Ready**"

The state line is conditional and stale-by-construction — it describes what the state *would be* when board access landed. Per `backlog-outline.md` Q1 that access has since RESOLVED ("read+write confirmed, 34 stories on the board"), so the board's Status field, not this line, is now authoritative. Nothing in the doc claims execution or completion.

### (4) Flags

- **AC-THIN — DoD-1's grep is evadable.** `grep -ri tmux` over a fixed path list is a name-presence test. It does not catch a renamed helper preserving tmux semantics, a tmux dependency reached via a variable or config value, or a path outside the five listed roots. The behavioral scope in §Scope is authoritative and far richer than the grep. **Question:** should DoD-1 assert against that behavioral scope, with the grep as one instrument among several?
- **AC-MISSING — "reproduced by someone other than the author" names no role.** In a fleet where the author may be an agent, this must say whether another agent qualifies or whether it requires you. (Note the human-gates runbook already rules this one **agent-doable** — "*An earlier draft of this runbook said you had to be that second operator. That was wrong.*" Confirm that ruling stands and fold it into the DoD.)
- **AC-MISSING — no AC covers the pre-cut drain as a checkable artifact.** The drain is specified in Scope with a strong evidence standard (positive emptiness proof, not absence-of-error) and a refusal condition, but no DoD item requires its evidence be produced and attached. **As written the DoD could be satisfied without the drain proof existing.**
- **OPEN-USER-RULING — destructive reset scope.** "incompatible dev DB/runtime state is archived and destructively RESET (dev rebuild — persistent agent rows carry mandatory tmux identity and are not migrated)." **Question:** confirm the archive format, its retention, and that loss of all persistent agent rows is accepted.

---

## #2 — STORY-002 · Complete removal of agent TUI code (SwiftTerm/tmux-attach presentation path)

Source: `planning/story-002-remove-agent-tui.md` · **Issue state verified OPEN** (it was wrongly auto-closed on 2026-07-20 by the #55 prose-numbering defect and has been reopened)

### (1) Plan summary

STORY-002 removes exactly the SwiftTerm / tmux-attach agent-TUI hosting and render path — the shipping path by which Hive hosts vendor TUIs via a SwiftTerm view execing `tmux attach-session` per pane. Its scope was confirmed narrow by user ruling: Hive rolls no renderer of its own, the vendors render themselves, and agent status-text emitters (statusline fact ingestion, status tables, workspace-feed wire) are explicitly out of scope as separate systems. It executes at the same Removal Gate as STORY-001 in one atomic merge train, gated on HiveTerminalKit's `HiveTerminalView` rendering live vendor-TUI sessions in the Workspace pane with input, resize, scroll, selection, copy, IME, and close/teardown proven live across all three vendors. Hard cut: no renderer flag, no per-pane fallback. In-tree HiveTerminalKit is an implementation candidate, not evidence — the gate measures live behavior, never code presence.

### (2) Acceptance criteria / Definition of done (verbatim)

- [ ] **1. Zero SwiftTerm — full supply chain (expanded per atlas R3):** "SwiftTerm absent from the dependency graph (`Package.swift`), the resolved lock (`Package.resolved`), all imports, dynamic linkage of shipped binaries, bundled resources, third-party licenses/notices, and launch scripts; app builds and is signed/notarized without it."
- [ ] **2. Live proof — all three vendors (corrected: DoD matches the Sequencing matrix):** "dev-build Workspace opens panes on live session generations rendered by HiveTerminalKit; each of Claude Code, Codex, AND Grok's real TUIs is exercised end-to-end (type, scroll, resize, select/copy, IME text entry, mouse, close with verified process termination, quit-Workspace teardown of every provider tree). Recorded and independently reproduced, re-run on the post-deletion tree."
- [ ] **3. Fidelity floor (expanded per atlas R3):** "judged against external VT references, never against SwiftTerm's behavior. Corpus must cover: Unicode width/combining/emoji-ZWJ; truecolor + 256-color; cursor shapes; focus events; bracketed paste; OSC 8 hyperlinks; OSC 52 clipboard policy; title/bell; primary + alternate screen; all mouse modes; keyboard incl. dead keys and Option mappings (kitty protocol); search/scrollback limits; selection/copy/paste; IME; Retina scale changes; GPU sleep/wake/memory behavior. Exact corpus/version/results recorded — 'looks right' belongs only to the aesthetic C1 gate."
- [ ] **3a. Accessibility is live acceptance, not a citation (promoted per atlas R3):** "VoiceOver + Accessibility Inspector runs on the new terminal pane pass and are recorded as part of this story's DoD."
- [ ] **4.** "Swift, TS, and Zig suites + typecheck green."
- [ ] **5. No legacy shims:** "no renderer flag, no SwiftTerm code path retained 'just in case.'"
- [ ] **6. Project-agnostic:** "pane hosting carries no Hive-repo assumptions; proven by opening the dev build on a non-Hive repository."
- [ ] **7. Doc-cleanup task (paired):** "`docs/workspace/*`, README, SPEC terminal/workspace sections describe the new renderer's behavior and contracts; no file-path or line-number references in any doc."
- [ ] **8.** "Fresh external research drives; current code and design docs are reference only."

**Binding conditions stated outside the DoD:**

- [ ] **Revalidation duty:** "**`ProjectState` and `AgentFeed` explicitly carry tmux identity today and MUST be revalidated and rewired**, as must Workspace app argument parsing and lifecycle semantics (AppDelegate/main/ProjectWindowController: orchestrator session/socket, attach command, first-responder, deferred geometry, pane-close-vs-agent-kill, quit)."
- [ ] Kept-category items are "revalidated, never presumed unchanged" — pane chrome/layout, attention/status reducers, DesignSystem, Settings, ModelControl, workspace-feed NDJSON wire, statusline.ts.
- [ ] **Replacement smoke harness:** the old SmokeRunner/smoke.sh is "replaced by an equivalent smoke harness against sessiond/HiveTerminalKit (same coverage, new spine; writing that harness is an M1 build story, this story deletes the old one)" — i.e. **B3 / #9**.
- [ ] Fresh inventory at execution as ephemeral evidence.

### (3) Current completion state (doc's own status lines, quoted)

- "Milestone: M1 (executes together with STORY-001 as the M1 cut)"
- "Backlog position: #2"
- "State when board access lands: **Ready** (with one interpretation flag for queen/user below)"
- "## Scope ruling (CONFIRMED by user via queen, 2026-07-17)"

Same caveat as #1: the state line is conditional on board access that has since landed. The referenced "one interpretation flag" is the Scope ruling section, which is marked CONFIRMED — so the flag appears resolved, though the state line was never updated to say so.

### (4) Flags

- **AC-THIN — DoD-3's fidelity floor names a corpus but no pass threshold.** Fifteen coverage areas are enumerated and results must be recorded, but nothing states what result constitutes a pass. vttest in particular produces graded output, not a boolean. **Without a threshold, "recorded" and "passing" are the same artifact and the AC cannot fail.** (Contrast B2, which pins vttest 20251205 by SHA-256 and requires applicability declared *before* execution — consider importing that discipline here.)
- **AC-MISSING — no defined disposition for known upstream defects.** B1 explicitly names "the known null-handler snapshot defect." STORY-002 has no equivalent clause saying what happens when a corpus cell fails for a vendored-engine reason outside Hive's control — waive, patch, or block the cut. **Question:** which?
- **AC-MISSING — "independently reproduced" again names no role** (same gap as STORY-001 DoD-2).
- **OPEN-USER-RULING — does STORY-002's DoD close without B3 (#9)?** DoD-2's live proof and the deleted SmokeRunner coverage both point at a replacement smoke harness the doc assigns to a *different* story. The outline's dependency edge `A3+A4+B2+B3+C1+C2 → atomic cut` implies B3 must be green first. **Question:** confirm B3 is a hard precondition of the cut rather than a parallel deliverable.
- **OPEN-USER-RULING — is a stale "State when board access lands" line authoritative for either removal story?** Both #1 and #2 carry a conditional state line written before board access resolved. **Question:** confirm the board is the authority and these lines are historical.
- **PROCESS FLAG carried from #55.** #2 was silently auto-closed with its acceptance criterion unmet by ordinary prose numbering in an unrelated docs commit. It is reopened, but **#55's claimed remediation — a note on #45 naming #2 as blocker — does not exist** (verified). See #55.


---

# Part 2 — Open defects and debt

## #48 — Workspace visibility publish loops HTTP 409 continuously even in healthy runs

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** The Workspace visibility publish path loops on **HTTP 409 continuously**, including in runs that are otherwise completely healthy. Seen independently by **hattie** and **hubert**, in **both** rendering runs and blank-pane runs — so it does *not* correlate with the attach/claim defect and is not a useful signal for it. Assessed as benign-as-measured but a wart: it is continuous rather than occasional (pure wasted work in steady state), it "poisons the logs as a diagnostic surface" (a persistent meaningless error trains everyone to ignore an error class, so "the next real 409 will be invisible"), and there is no account of *why* it conflicts or why retrying should help. Scoped as an M1 polish item.

**(2) Acceptance criteria checklist.** No section labelled acceptance. The Scope line states the disjunctive requirement:
- [ ] "Either make the publish succeed, **or** stop looping and record the conflict once with a reason"
- [ ] "Not a blocker; **should not ship as-is**"
- [ ] Conditional blocking rule (2026-07-20): "not M1-blocking by itself, but **blocking-by-contamination if the publish loop perturbs a live-proof capture**. Any live-proof session should either quiesce the loop or record that it ran."

**(3) Completion state.** No status lines or checkboxes. Issue state: **OPEN**. Completion: **unstated**. The 2026-07-20 addendum is a scoping refinement, not progress.

**(4) Flags.**
- **AC-THIN.** *Which branch of the "either/or" is the user choosing?* Those are very different tasks — root-causing the conflict versus suppressing the retry. *And the diagnosis is explicitly absent ("we do not currently have an account of why it conflicts") — does this issue own root-causing, or only silencing?*
- **OPEN-USER-RULING (contamination rule).** The addendum makes this a *conditional* live-proof blocker. *Who enforces "quiesce the loop or record that it ran," and where is that recorded — per-session in the evidence bundle, or as a standing runbook step?* As written this obligation attaches to every live-proof session in M1 (#5, #6, #9, #45's remaining items) but is not referenced from any of them.

---

## #52 — `hive stop` / app teardown leaves the Workspace GUI running (needed SIGKILL)

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** Tearing down via `hive stop` / the app-exit path leaves the **Workspace GUI application still running**. Surfaced during the **#43** end-to-end payoff proof (`helga`): teardown did not end the app and it had to be **SIGKILLed**. Explicitly framed as the same failure *shape* as **#44** on a *different path* — #44's defect (`make clean` leaving the launched dev app running) was fixed (`916f17a3` refuses on survivors; `29a69614` works when `.dev` is gone), and that fix does not cover the `hive stop` / app-teardown path. Filed separately rather than reopening #44 "so the fixed target stays fixed and this path gets its own evidence."

**(2) Acceptance criteria checklist.** **There are no acceptance criteria in this body.** It is a defect report: summary, family relationship, and evidence pointer. No pass condition, no reproduction steps, no fix direction.

**(3) Completion state.** The body opens with an explicit status line, verbatim:
> "**Backlog.** No owner yet. (Agent ownership is recorded in the body, never via GitHub assignees.)"

No checkboxes. Issue state: **OPEN**.

**(4) Flags.**
- **AC-MISSING.** *What is the pass condition — `hive stop` returns and `ps` shows zero Workspace survivors within N seconds? What is N? Does it need the same `ps`-verified-zero-survivors discipline as #6/A4, and does the fix need a positive control that the probe can see a survivor?*
- **OPEN-USER-RULING (evidence is unlanded).** The sole evidence is "`teardown.txt` in the #43 e2e proof bundle (`helga` worktree, `.dev/proofs/e2e-43-45/`; **unlanded — `.dev/` is gitignored**)." *That evidence is one worktree cleanup away from being unrecoverable. Should it be landed or preserved before the worktree is reclaimed?* This matters because a gitignored evidence path also fails manifest checks on a fresh checkout.
- **OPEN-USER-RULING (owner + milestone).** No owner, no milestone, no label. *Is this M1-blocking?* It is plausibly a duplicate-in-mechanism of **#56** (feed-failure self-quit hangs forever via unreachable `NSTerminateLater` reply) — #56 documents a Workspace process that stays alive at 0% CPU after `hive stop` already ran and succeeded, which is an exact match for #52's symptom. **However #56 explicitly rules that path out for its own incident and notes Cmd-Q/Dock/osascript/logout all quit normally.** *Is #52 the same bug as #56, or a third path? Someone must check whether #52's SIGKILLed process showed #56's signature (`phase=decision ... reply=terminateLater` with no `phase=resolved`).* If it did, #52 is fixed by #56 and should be closed as a duplicate.

---

## #53 — Gate9 OSC52 pasteboard test asserts on the system-wide macOS pasteboard — flakes when any process copies

**State:** OPEN · **Labels:** `test-debt`

**(1) Plan summary.** `testOSC52WriteIsVisiblyDeniedAndPasteboardUntouched` (`workspace/Tests/HiveTerminalKitTests/Gate9CallbackMatrixTests.swift`) asserts on **`NSPasteboard.general`** — the system-wide macOS pasteboard shared by every process. Because `changeCount` is bumped by *any* process that copies, "the assertion is not actually scoped to 'did the surface under test write to the clipboard' — it is scoped to 'did *anything on this Mac* copy during the test window'." `harvey` saw it fail once at `changeCount` **256 vs 255**, then pass in isolation — "the signature of external interference, not of the guard under test failing." Recurrence is structural: many Hive agents share one Mac, so frequency *scales with fleet activity*. It matters beyond flakiness because it guards a **security** property — "a re-run-until-green security assertion stops being evidence."

**(2) Acceptance criteria checklist.** No acceptance section, but a concrete named fix candidate and an explicit non-scope:
- [ ] "Use a **private `NSPasteboard` instance** for the test (`NSPasteboard(name:)` / `withUniqueName`) instead of `.general`, so the observed pasteboard is one only the test can touch"
- [ ] Rationale to satisfy: "That makes the assertion measure the thing it claims to measure and removes the shared-machine coupling entirely"
- [ ] Explicit non-scope: "the other three assertions in this test — the `CLIPBOARD_DENIED` event and the two callback-probe counts — are already correctly scoped and are **not** affected"

**(3) Completion state.** Same explicit status line as #52, verbatim:
> "**Backlog.** No owner yet. (Agent ownership is recorded in the body, never via GitHub assignees.)"

No checkboxes. Issue state: **OPEN**.

**(4) Flags.**
- **AC-THIN.** The fix is well specified — this is the most executable of the un-criteria'd issues — but the *verification* is not. *After switching to a private pasteboard, how do you prove the guard still bites?* A private-pasteboard assertion that can never fail is worse than a flaky one. **The fix must ship with a positive control: mutate the OSC 52 handler to actually write, and prove the test goes RED.** Without that, this change converts a crying-wolf security assertion into a silently-vacuous one. *Does the user want that control as part of acceptance?*
- **OPEN-USER-RULING.** *Is this fixed standalone, or folded into #9 (M1-B3), which the body names as related?* The new smoke harness will inherit this assertion class if built on the same pattern.

---

## #55 — Prose numbering in commit bodies silently closes issues — `fix #2` closed STORY-002

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** A process/tooling defect report. **STORY-002 (#2), a milestone gate, was closed by GitHub on 2026-07-20T03:09:12Z with its acceptance criterion unmet, and nobody decided to close it.** Ordinary prose numbering in an unrelated commit (`c9d440f4`, a *docs* commit about cross-vendor reviews) was parsed as a close directive: body line 8 read "Two follow-ups: production fix #2 has no unit coverage" — "#2" meant *the second production fix*, and GitHub read `fix #2` as closing grammar. The report explains precisely why this evades review (the subject line looks unrelated; no commit ever claimed the removal; and a **decoy** — line 4 of the same body contains the word "closes" correctly ruled non-adjacent, so a reader stops before reaching line 8). Blast radius was swept and is **contained**: all 54 issues checked via the timeline API, #2 is the only commit-driven close in the repo, cross-checked against a grep of main's 1181 commits with exactly one hit. Recurrence is judged near-certain because "this repo's review vocabulary makes ordinal phrasing routine."

**(2) Acceptance criteria checklist.** No acceptance section. Two **candidate** fixes, explicitly marked as *not implemented*:
- [ ] Candidate 1 (**"the load-bearing one"**): "**commit-msg hook** rejecting a bare `#N` preceded by close/fix/resolve grammar unless explicitly marked intentional (e.g. an allowlist trailer). Mechanical, catches it at authoring time."
- [ ] Candidate 2: "**House style**: write 'the 2nd production fix' / 'the second fix', never 'fix #2'. Zero tooling, relies on discipline, and does not protect against agent-authored commits that have not read the style guide."
- [ ] "These are not exclusive; (1) is the load-bearing one, (2) reduces friction with it."

Reusable diagnostic recorded (not a criterion but load-bearing for any re-audit):
> "A commit-driven close carries a non-null `commit_id` on its `closed` timeline event; a deliberate close has `commit_id: null`."
> `gh api repos/scottdev1986/hive/issues/<N>/timeline -q '.[] | select(.event=="closed" and .commit_id!=null)'`

Trap recorded for anyone re-running the sweep: "`git log -E --grep` does **not** honor `\b`. A word-boundary-anchored pattern returns zero matches silently and reads as a clean repo. **Positive-control any empty result against `c9d440f4` before believing it.**"

**(3) Completion state.** The body carries an "Already remediated" section:
> "#2 has been reopened with a scoped remaining-work list. #45 (final end-to-end gate) carries a note naming #2 as its blocker — without it that gate would certify a tmux/SwiftTerm-free build that does not exist."

So the **damage is remediated** but **neither preventive fix is implemented** ("Candidate fixes (**not implemented — filing only**)"). Issue state: **OPEN**.

**(4) Flags.**
- **AC-MISSING.** The body is a filing, self-described as such. *No acceptance criteria exist.* The user must decide what "done" means here.
- **OPEN-USER-RULING (which fix).** *Implement candidate 1 (commit-msg hook), candidate 2 (house style), both, or neither?* The body recommends (1) as load-bearing but does not decide. Note a real constraint on (1): a commit-msg hook is **local and opt-in** — it does not run for every agent worktree unless installed there, and it can be bypassed with `--no-verify`. *Does the user want a server-side/CI check instead of or in addition to the hook?*
- **VERIFICATION GAP.** The remediation claim "#45 carries a note naming #2 as its blocker" **does not match #45's body as fetched above** — no such note appears there. *Either the note was never added, or it lives somewhere else. This should be re-checked before the approval package is signed, because it is the safety net for the exact gate the defect endangered.*

---

## #56 — Workspace feed-failure self-quit hangs forever instead of exiting — NSTerminateLater reply is unreachable from a main-queue block

**State:** OPEN · **Labels:** `bug`

**(1) Plan summary.** A fully root-caused AppKit lifecycle bug with a stated general rule: **"A nested AppKit event loop does not drain the main dispatch queue,"** so any `.terminateLater` reply delivered via `DispatchQueue.main.async` is **unreachable** when termination began inside a main-queue block. `AppDelegate.terminateAfterFeedFailure` therefore does not terminate the app — it hangs it permanently. The six-step chain is documented (feed-restart runs inside `DispatchQueue.main.asyncAfter` → calls `NSApp.terminate(nil)` → `applicationShouldTerminate` returns `.terminateLater` → AppKit spins a nested event loop in `-[NSApplication _shouldTerminate]` → the reply is delivered via `DispatchQueue.main.async` → that block can never run because the main dispatch queue is already inside `_dispatch_main_queue_drain` and is not reentrant). **"The hang is unconditional, not a race"** — every route into `scheduleFeedRestart` is already on a main-queue block. An exhaustive sweep is included and reports **no other sites with this fingerprint**: exactly one `.terminateLater` producer, exactly one reply site, exactly two routes into `terminate:` (the Quit menu item — event-loop driven, safe — and `terminateAfterFeedFailure` — this bug).

**(2) Acceptance criteria checklist.** No acceptance section — this is a diagnosis, and it says so. What it *does* provide, all load-bearing for whoever fixes it:

Observable signature (recognise without a debugger):
- "Process alive **>45s at 0% CPU**, state `SN`"
- "`hive stop` **already ran and succeeded** (it is not what is stuck)"
- "Unified log shows `phase=requested` and `phase=decision ... reply=terminateLater` but **no `phase=resolved` line**, ever" — "**The missing `resolved` line is the tell.**"

Reproduction — "verified twice, real launches", with a positive control:
```sh
printf '#!/bin/sh\n/usr/bin/touch /tmp/STOP_RAN\nexit 0\n' > /tmp/hive-marker
chmod +x /tmp/hive-marker
HiveWorkspace --project /tmp/proj --port 59999 --instance-id probe \
  --instance-home /tmp/home --hive /tmp/hive-marker \
  --orchestrator-session probe-sess --feed /nonexistent/no-feed
```
- "After ~30s (restart budget 1+2+4+8+15s) the feed-failure path fires."
- "**Positive control that `hive stop` really ran:** `/tmp/STOP_RAN` exists — the subprocess ran and exited 0 — yet no `resolved` line is emitted and the process never exits. That rules out 'the stop command is hanging' as the explanation."

Explicit non-affected set:
- "**Cmd-Q, the Dock Quit item, `osascript`, and logout all quit normally.** … Verified: an Apple Event quit exits cleanly in ~2s with the full `requested`/`decision`/`resolved`/`will-terminate` sequence."

Fix directions, explicitly unverified:
- [ ] "reply on the next runloop turn rather than via the main dispatch queue"
- [ ] "**or** hop out of the main-queue block before calling `terminate:`"

**(3) Completion state.** The body carries an explicit scope note that this is deliberately **not** fixed:
> "Deliberately **not** fixed alongside the termination-logging work that found it (that change was logging-only, no behavior change). A termination-behavior fix needs its own scoped task and its own review."

Found by `iona` while verifying the termination instrumentation landed in `acead1f8` — "The instrumentation is what made it visible." Cross-ref: `docs/incidents/2026-07-20-workspace-death.md`. Issue state: **OPEN**.

**(4) Flags.**
- **AC-MISSING.** No acceptance criteria — by design, since the card is a diagnosis and explicitly defers the fix to "its own scoped task and its own review." *The user must either write the AC or rule that the fix task is a separate card.* Suggested minimum AC given the material already present: run the documented reproduction, and require the `phase=resolved` line to appear and the process to exit — **plus** the negative control that the reproduction still hangs on the pre-fix binary, so the probe is proven able to see the failure.
- **OPEN-USER-RULING (which fix direction).** Both listed directions are marked "**Plausible directions, unverified**". *Reply on the next runloop turn, or hop out of the main-queue block before calling `terminate:`?* These have different risk profiles and the issue does not choose.
- **OPEN-USER-RULING (relationship to #52).** See #52 above — #52's symptom (Workspace survives `hive stop`, needed SIGKILL) matches #56's observable signature closely, yet #56's sweep claims exhaustiveness and #56 rules its own path out for the 2026-07-20 incident. ***Are #52 and #56 the same defect?*** This must be settled before both are scheduled, or the same fix gets built twice — or worse, #52 gets closed by #56's fix without anyone checking.
- **Milestone/owner:** none set.

---

## #57 — A resumed Codex agent can come back alive but unable to report — hive's own MCP fails at resume

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** A resumed agent whose `hive` MCP failed to start comes back **alive but structurally unable to report** — "process healthy, TUI redrawing, pane responsive, and permanently incapable of `hive_send`, `hive_inbox`, or `hive_land`. It burns quota until a human notices." The card opens by *disclaiming* a conflation: the 11 overnight deaths on instance `run-bc65ab00-…` were "a separate defect in the resume liveness probe", root-caused and fixed in `9ebd0268` — "Do not conflate them: fixing this would not have saved those 11 agents, and fixing those 11 does not fix this." Critically, **the liveness fix made this defect worse**: before `9ebd0268` such an agent failed the 10s proof-of-life watch and "**died loudly**"; after it, the agent "**passes** the watch … recorded as *successfully resumed*", so the operator sees "a healthy agent that never speaks again." The card names the mechanism: "The watch measures *acting*, not *reporting*." This is characterised as "a silent-failure regression introduced by an otherwise-correct fix."

Scope: treat hive's **own** MCP as **required** at spawn and resume while every *inherited* MCP is **optional** ("These are opposite tolerances and today both get the same one"); fail loudly at launch; add a post-launch reachability round-trip through the agent's own credential; and root-cause the startup failure (two unconfirmed candidates: MCP startup timeout under 11+ live agents, or a **stale daemon port** — `writeCodexAgentConfig` rewrites the hive MCP URL with the current daemon port at resume time). Explicitly out of scope: MCP scoping for inherited servers (`buildCodexMcpExclusionArgs` already does this — "There is nothing to build there").

**(2) Acceptance criteria checklist.** This is the **most executable AC set of the 17**. Verbatim, under "Live-proof acceptance", prefaced by "A unit test does **not** close this":
- [ ] 1. "Spawn a **real Codex agent** and resume it against a live daemon."
- [ ] 2. "Capture the pane **during MCP startup** and assert `MCP startup incomplete` does **not** appear, and that `hive` specifically is listed as started."
- [ ] 3. "The resumed agent completes a **`hive_send` round-trip** — **measured on the receiving side, not inferred from the agent's own claim.** *Alive is not reporting; an act is not a state.*"
- [ ] 4. "**Negative control (required):** force the `hive` MCP to fail (e.g. point it at a dead port) and prove the launch **refuses loudly** rather than proceeding. Without this arm, the pass in step 2 could be a probe that cannot see failure at all."
- [ ] 5. "Pin the vendor version in the evidence."

Scope requirements (distinct, each closeable):
- [ ] "Treat hive's **own** MCP server as **required** at spawn and at resume; treat every *inherited* MCP server as **optional**."
- [ ] "A spawn or resume whose `hive` MCP did not come up must **fail loudly at launch**."
- [ ] "Post-launch reachability check: a round-trip through the agent's own credential… **Proof of *reporting*, not proof of *drawing*.**"
- [ ] "Root-cause the startup failure itself" (candidates: load/MCP startup timeout; stale daemon port — "plausible, unverified")
- [ ] Vendor coverage: "Observed on Codex; Claude and Grok spawns carry the same hive MCP and **have not been checked**. Confirming or excluding them is part of this story."

Principles (explicit and unusually sharp):
- [ ] "**LIVE PROOF to close** — a green process exit, a redrawing pane, and a passing unit test are all explicitly *not* acceptance here"
- [ ] "Measure the state (a received message), never the act (a spawn that exited 0). **An absent signal is unknown, not false** — hence the mandatory negative control."
- [ ] "PROJECT-AGNOSTIC: the required/optional MCP distinction must hold on any repo, with no Hive-specific server names hardcoded outside hive's own entry."

Evidence already measured (supports, not criteria): "5/5 Codex resume failures on `run-bc65ab00` carry `⚠ MCP startup incomplete (failed: hive, idea)`"; `idea` **exonerated** with a documented control — "Six Codex agents *survived* against the identical dead port, interleaved by minutes with the deaths: horace died 00:43, hector survived 00:47, hiram died 00:47:53, hubert survived 00:51 — and the survivors produced landed work. Port 64342 refuses connections today (`curl` exit 7). Same dead port, opposite outcomes."

**(3) Completion state.** No checkboxes. The body carries a hard blocker and a closure guard, both verbatim:
> "**Blocked until `2026-07-26T00:00:27Z`.** Codex quota is at 0%, so no live vendor session can be driven before then."

> "**#57 remains open.** Commits 9ebd0268 + 4a7ed9db (resume liveness) fix a **different** defect… **Do not close this issue on any commit that does not name this issue's defect explicitly.** (Guard added 2026-07-20 per reconciliation audit, given the #55 prose-closure hazard.)"

Issue state: **OPEN**.

**(4) Flags.**
- **Neither AC-MISSING nor AC-THIN.** The acceptance is executable, includes a mandatory negative control, and specifies measurement on the receiving side. This is the model the thinner cards should be held to.
- **OPEN-USER-RULING (milestone — explicitly requested).** The body states this outright: "**Deliberately left unset — this straddles two milestones and needs a ruling, not a guess.**" M2 owns the spawn/registration spine (#38) and "'Hive's MCP is required at launch' is a spine-level invariant, and the fix would be implemented there"; M4 owns recovery (`S4.5 H4 recovery`) and "The failure is observed at *resume*, which is recovery's surface." Recommendation recorded as **M2**, "Recorded rather than applied — #37 is already an example on this board of unassigned scope causing confusion." ***This is the single most explicit user decision request across all 17 issues.***
- **OPEN-USER-RULING (build order).** "If #38 is built first, this becomes a requirement on it rather than a standalone patch to the Codex path." *Fold into #38, or patch Codex standalone?* Note #38's body does **not** currently carry this requirement.
- **SCHEDULING CONSTRAINT.** Blocked on Codex quota until **2026-07-26T00:00:27Z**, and it must **share one session** with the debt in `planning/2026-07-20-resume-liveness-verification-debt.md`: "One post-reset Codex session can satisfy both; **do not schedule two.**"

---


---

# Part 3 — M2

#38 is the spine; #12/#13/#14 are retitled proof targets under it (verified on the board: "M2 proof target (under #38) — …").

## #38 — M2 — Agent-agnostic spawn & registration spine (Kimi Code + opencode as first proof targets)

**State:** OPEN · **Labels:** `type:build`

**(1) Plan summary.** Milestone M2. Rebuild agent spawning as **one agnostic spine** — a single spawn/registration path every agent and model goes through — with Kimi Code and opencode as the first proof targets. The existing per-vendor spawn stories (#12 Claude Code, #13 Codex, #14 Grok Build) are **demoted to proof targets under this spine** rather than independent spine-level forks, because "the per-vendor fork is exactly what the agnostic requirement replaces." The spine must carry Claude Code, Codex, Grok, opencode and Kimi Code with none as a hardcoded spine-level fork. A 2026-07-20 user framing reframes M2 as building an **AGENT FACTORY**: by end of M2, spawning is native to the terminals built in M1, and adding a future TUI is "research + a factory entry, nothing more."

**(2) Acceptance criteria checklist.** No section is labelled "acceptance," but the "Added requirements (2026-07-18)" block is explicitly requirement-shaped and includes a LIVE-PROVEN acceptance clause. Preserved as distinct criteria:
- [ ] **Orchestrator (queen) permissions**: "queen spawns with permission to EDIT the files it needs (its own memory, planning/board-adjacent docs) and to access GitHub Projects via `gh` in Bash, while NOT authoring implementation code"
- [ ] Framed as "a behavioral role boundary ('queen never authors implementation code'), not a blanket tool denial — today queen has Write/Edit/Bash fully disabled, which forces avoidable delegation and **must be fixed here**"
- [ ] **Agent-agnostic / model-agnostic ARCHITECTURE**: "the core spawn/registration spine must not be hardcoded to any particular TUI or model"
- [ ] "Models are config/data — adding or changing a model needs **no code change**"
- [ ] Adding a new TUI *is* expected to need code, but "as a self-contained implementation behind a shared interface, i.e. a factory/plugin pattern, **NOT a fork that touches the spine or the existing agents' code**"
- [ ] "New agent TUIs must be addable as **first-class citizens exactly like the existing agents**. Concrete named targets: the Kimi Code TUI and the opencode TUI — plus any future agent TUI via the same path."
- [ ] **Full parity for every such agent/TUI**: "status reporting, usage/quota-limit surfacing, the ability to set its model, and the ability to add it to the router" — four distinct parity axes
- [ ] **LIVE-PROVEN acceptance**: "the new agent TUIs (Kimi Code and opencode) must be fully working and proven end-to-end — spawn, status, usage limits, model selection, and router integration — before the story is accepted. **Code presence is not acceptance.**"
- [ ] M2 framing: "spawning is native to the terminals we built"

**(3) Completion state.** No status lines, no checkboxes. Issue state: **OPEN**. Completion per the body: **unstated**.

**(4) Flags.**
- **AC-THIN (partial).** The live-proof clause is strong and executable; the architecture clauses are not. *How is "not hardcoded to any particular TUI" **verified** — is there a mutation/conformance test (e.g. remove a vendor entry and prove the spine still builds and the others still spawn), or is it a review judgement?* *What exact artifact proves "adding a model needs no code change" — a config-only diff demonstration?*
- **OPEN-USER-RULING (queen permissions).** *What is the precise allow/deny set for queen after this lands?* The body says EDIT its own memory and "planning/board-adjacent docs" — that boundary is not enumerable as written. **Note the standing hazard:** per the repo's own recorded experience, orchestrator permission hand-edits are asymmetric (allow entries survive but can be inert; deny removals return), and the deny list is shared with revoked writers — so widening it can re-arm a revoked agent. *Does #38 own making that permission change durable, or only specifying it?*
- **OPEN-USER-RULING (scope overlap).** #63 is a separate card carrying "Kimi Code + opencode as first-class agents" as the **M2 exit criterion**, and says "Blocked by #38." But #38's own LIVE-PROVEN acceptance *also* requires Kimi Code and opencode fully working end-to-end. *Are these the same deliverable tracked twice, and if so which one closes on the vendor proof?* As written, #38 cannot close until the #63 work is done, which makes "#63 blocked by #38" circular.
- **Cross-ref:** #57 states that if #38 is built first, the "hive MCP required / inherited MCP optional" property "becomes a requirement on it rather than a standalone patch to the Codex path." That requirement is **not currently listed in #38's body.** *Should it be added?*

---

## #15 / #16 / #17 — M2 status, delivery, conformance (no story docs; outline S-numbering only)

**Numbering warning.** The numbers #15, #16 and #17 **do not appear anywhere in `planning/backlog-outline.md`**. The M2 section's remaining bullets are labelled S2.3, S2.4, S2.5. If #15/#16/#17 correspond to them, that mapping exists **only on the board**, not in any planning doc. The task brief scoped issue-body reads to #38 and #63 only, so I have not fetched #15–#17 bodies; the outline text below is all the planning repo records.

- [ ] **S2.3 Status pipeline** — verbatim: "StatusEnvelope v2 (source/freshness/confidence), `hive_update_status`, statusline-fact ingestion on the new spine; live agent demonstrates EVERY current status promise (working/idle/approval/paused/stuck/done/failed/unknown) observed end-to-end; terminal pixels are never status truth (I6)."
- [ ] **S2.4 Message delivery over the new spine** — verbatim: "normal/steer/urgent/critical delivered through the sessiond arbiter per-vendor with measured receipt; truthful degradation stated per vendor (flat queen→workers policy only; hierarchy comes in M4)."
- [ ] **S2.5 Vendor-TUI terminal conformance** — verbatim: "alt-screen, kitty keyboard, mouse reports, bracketed paste, OSC 52 — per-vendor corpus runs inside the new terminal."

**M2 exit criterion, verbatim:** "Exit: for each of claude code / codex / grok × {normal, yolo}: agent boots inside the new terminal as Queen with the belief injected silently (never visible in the transcript), performs work, and updates status end-to-end with every current status promise proven live."

**M2 dependencies, verbatim:** "M2 story DEVELOPMENT may start once M1-A2 exists; M2 story CLOSURE requires the M1 cut (post-deletion tree). Per-vendor stories mutually ∥; S2.3/S2.4 ∥ with the vendor stories."

**Historical per-vendor detail now superseded by #38** — retained because #12/#13/#14 are proof targets against it. The belief-injection spec (atlas, sourced 2026-07-17) pins per vendor: claude `--append-system-prompt-file <0600 file>`, normal `--permission-mode default`, yolo `--dangerously-skip-permissions`; codex `developer_instructions` via ephemeral 0600 `$CODEX_HOME/<name>.config.toml` + `--profile <name>` (explicitly "not AGENTS.md, not model_instructions_file which REPLACES base instructions"), normal `-a on-request -s workspace-write`, yolo `--yolo`; grok `--rules` (alias `--append-system-prompt`), "Never `--system-prompt-override` (replaces xAI base prompt)", normal explicit `--permission-mode default` + explicit sandbox ("sandbox default is OFF"), yolo `--always-approve`/`--yolo`. **Approval modes: FULL 3-WAY MATRIX, RATIFIED by user (final)** — "approval and sandbox are independent axes; each vendor story BUILDS and LIVE-PROVES all three of {manual, sandboxed-autonomous, unsafe-bypass}." Grok argv note **RESOLVED by user ruling Q6**: "TUI/transcript-silence is SUFFICIENT — 'no user should SEE the belief prompt.' ps-invisibility is NOT a requirement." Live proof for all vendors: "unique nonce in belief; capture ALL PTY bytes and assert nonce never renders; neutral first prompt elicits belief-dependent behavior or an authenticated status call carrying the nonce; manual-mode run produces a real approval state on a harmless write+shell, autonomous/bypass runs execute without one. **Green exit ≠ proof.** Pin vendor versions in evidence."

### Flags

- **AC-MISSING — #15/#16/#17 have no planning-doc identity.** Their AC exists only as three outline lines under different labels, and the number-to-story mapping is board-only. **Question:** confirm S2.3→#15, S2.4→#16, S2.5→#17, or supply the real mapping.
- **OPEN-USER-RULING — the M2 exit line and #38 disagree on vendor count.** The exit criterion names three vendors; #38's supersession explicitly widens scope to Kimi Code and opencode, "two agents this outline never names," and #63 makes them an **M2 exit criterion**. **Question:** does M2 exit now require five agents, or do the two new ones ride under #38/#63 without gating exit? As written the outline's exit line is stale.
- **AC-THIN — S2.4's "measured receipt" and "truthful degradation stated per vendor"** name no artifact or threshold. **Question:** what measures receipt, and where is per-vendor degradation recorded?

## #63 — M2 — Kimi Code + opencode as first-class agents via the agent factory (M2 exit criterion)

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** An **M2 exit criterion (user ruling, 2026-07-20)**: Kimi Code and opencode are added to Hive as **first-class agents via the agent factory (#38)** — held to "the same bar as Claude/Codex/Grok." Adding a new TUI must reduce to "do the research, build the factory entry." Detection-class parity is explicitly deferred to M3 "for all vendors at once." The card frames the two vendors "as **deliverables, not proof-of-concept targets**." Blocked by #38.

**(2) Acceptance criteria checklist.** Four named parity requirements plus framing, verbatim:
- [ ] "**native spawn in our terminal**"
- [ ] "**normal+yolo modes**"
- [ ] "**hive_send/report protocol**"
- [ ] "**the landing protocol**"
- [ ] Bar: "the same bar as Claude/Codex/Grok"
- [ ] Process requirement: "Adding a new TUI must be: **do the research, build the factory entry.**"
- [ ] Deferral: "Detection-class parity (see M3 TUI omniscience story) arrives in **M3** for all vendors at once."
- [ ] Framing: "This card tracks the two vendor additions as **deliverables, not proof-of-concept targets**."
- [ ] "**Blocked by #38.**"

**(3) Completion state.** No status lines or checkboxes. Issue state: **OPEN**. Completion: **unstated**. Blocked.

**(4) Flags.**
- **AC-THIN.** The four parity axes are named but not given proof conditions. *What discharges "the landing protocol" for a new vendor — one successful `hive_land` per vendor, live? What discharges "normal+yolo modes" — a spawn in each mode?* Compare #38's own live-proof clause, which is more specific ("spawn, status, usage limits, model selection, and router integration"). **The two cards list overlapping but non-identical parity sets** — #38 says *status reporting, usage/quota surfacing, model setting, router*; #63 says *native spawn, normal+yolo, hive_send/report, landing*. *Which list is authoritative for the two new vendors?*
- **OPEN-USER-RULING (circular dependency — see #38).** #63 says "Blocked by #38," but #38's acceptance requires Kimi Code and opencode "fully working and proven end-to-end… before the story is accepted." ***As written neither can close first.*** The user must rule: either #38 closes on spine architecture + a conformance proof (with the two vendors landing under #63), or #63 is absorbed into #38 and one of the cards is closed as a duplicate.
- **RESEARCH DEPENDENCY.** "do the research" is an unestimated prerequisite: neither Kimi Code's nor opencode's invocation, status surface, quota surface, or model-setting mechanism is documented anywhere in these bodies. Per this repo's own standing rule, those must be verified against vendor docs, never specced from memory. *Is the research a separate scoped task, or in-card?*


# Part 4 — M3

## #61 — M3 — TUI omniscience: question-waiting, idle-when-should-work, and vendor-security-stop detection with user-attention escalation

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** An **M3 story (user vision, 2026-07-20)** stating the *purpose* of the custom terminal: "The custom terminal exists so Hive is integrated INTO the terminal and can detect everything happening in a TUI." Three detection classes, required "for EVERY vendor the factory supports."

**(2) Acceptance criteria checklist.** Three numbered classes plus a proof requirement and a boundary, verbatim:
- [ ] 1. "**Agent is asking a question** → Hive knows (queen/user can be prompted to answer)."
- [ ] 2. "**Agent has stopped working when it should be working** → Hive knows."
- [ ] 3. "**Vendor has stopped the agent for cybersecurity/safety reasons** → Hive knows **AND actively gets the user's attention to handle it.**" — note this class carries a second obligation the other two do not.
- [ ] "Each class needs a **live-agent proof per vendor** (Claude, Codex, Grok, Kimi Code, opencode), **not a parser argument.**"
- [ ] Boundary: "M2's #15 proves status promises (working/idle truthfulness); these three richer classes and the user-attention escalation land here."

**(3) Completion state.** No status lines or checkboxes. Issue state: **OPEN**. Completion: **unstated**. This is forward-looking M3 scope, not in-flight work.

**(4) Flags.**
- **AC-THIN.** The proof bar ("live-agent proof per vendor, not a parser argument") is admirably strict, but the detection definitions are not operationalised. Specifically: *class 2, "stopped working when it should be working" — what defines "should be working"? Elapsed wall-clock with no tool calls? A pending task with no output? Without a definition this class is not testable, and it is the one most prone to false positives.* *Class 1 — is "asking a question" detected from TUI rendering, from a vendor protocol event, or both, and what is the acceptable false-negative rate?* *Class 3 — what does "actively gets the user's attention" mean concretely (push notification, sound, modal, all three)?*
- **SCALE FLAG.** 3 classes × 5 vendors = **15 live-agent proofs**, each requiring a real vendor session. Combined with #57's evidence that Codex quota alone gates live sessions for days, this is a substantial scheduling commitment. *Does the user accept a 15-cell live matrix, or is a representative subset acceptable with the rest by extension?*
- **DEPENDENCY.** Requires the factory (#38) and the two new vendors (#63) to exist first, since it demands parity across Kimi Code and opencode. Not stated in the body as a blocker.

---

## #62 — M3 — queen can open and close blank terminals (terminal lifecycle decoupled from agents)

**State:** OPEN · **Labels:** *(none)*

**(1) Plan summary.** An **M3 story (user directive, 2026-07-20)**: when M3 communication lands, hive queen can open and close **blank** terminals — "terminal lifecycle as a first-class queen capability, decoupled from agent lifecycle (the M1 half of that decoupling is the exit-command AC)."

**(2) Acceptance criteria checklist.** The body is a single sentence. Decomposed:
- [ ] "hive queen can **open** … BLANK terminals"
- [ ] "hive queen can … **close** BLANK terminals"
- [ ] "terminal lifecycle as a first-class queen capability, decoupled from agent lifecycle"
- [ ] Gating: "when M3 communication lands"
- [ ] Cross-ref: "the M1 half of that decoupling is the exit-command AC" (= #60)

**No acceptance criteria section exists** — the above are derived from the single descriptive sentence, not stated as criteria.

**(3) Completion state.** No status lines or checkboxes. Issue state: **OPEN**. Completion: **unstated**. Forward M3 scope.

**(4) Flags.**
- **AC-MISSING.** The body states a capability, not a pass condition. *What proves it — queen issues an open, a blank pane appears and is user-visible; queen issues a close, the pane disappears and `ps` shows no survivor? Is there a live-proof requirement, as M1's track-A cards have?* Nothing is specified.
- **AC-THIN on the gate.** *"when M3 communication lands" — which issue is "M3 communication"? It is not linked.* This card's only stated precondition points at an unnamed artifact.
- **OPEN-USER-RULING (permissions).** Queen opening/closing terminals is a **new queen capability**, and queen's permission boundary is itself unresolved scope under **#38** ("queen never authors implementation code" as a behavioral boundary). *Does queen-opens-terminals require a permission change, and is that change owned by #38 or by #62?* Given the repo's recorded experience that orchestrator permission edits are asymmetric and the deny list is shared with revoked writers, this is not a trivial config change.
- Smallest body in the package — 2 sentences for a first-class capability.

---


---

# Far scope — M3 / M4 / M5 (#18–#33)

**Numbering warning, load-bearing.** Issue numbers **#18 through #33 do not appear anywhere in `planning/backlog-outline.md`**. The M3/M4/M5 sections use S-numbering exclusively (S3.1–S3.5, S4.1–S4.6, S5.x), and no mapping from #18–#33 to S-numbers exists in any planning doc. The one-liners below are the S-items — the only enumeration the planning repo provides. **The #18–#33 ↔ S-item mapping exists only on the board and must be supplied before these can be approved individually.**

**Also note: none of the M3/M4/M5 items carries acceptance criteria.** Every S-item is a one-line scope sketch pointing at a design doc or a feature ledger; none states a pass condition. For M3/M4 the design docs (`docs/design/hive-communication.html`, `docs/design/agentic-hierarchy.html`) are the real spec; for M5 it is the Split Horizon feature ledger.

### M3 — communication fabric
Builds `docs/design/hive-communication.html`; staging follows the doc's C-ladder, minus UI, C2 deferred to M5 gate/Split Horizon.

- **S3.1** — C0A durable core: v2 envelopes/events, pre-spawn identity reservation, digests/causal links/idempotency, content object store + bounded previews, ContextInputRecord + TokenAttributionProjection, WorkManifest + checksummed journal outside worktrees.
- **S3.2** — C0B bounded truthful wakes: one delivery lane on the sessiond spine, provider-observed vs applied split, byte/rendered-token wake budgets, inbox cursors, mandatory reads, explicit acks.
- **S3.3** — C0C stranding recovery: journal-first WorkManifest rebuild, agreed-empty auto-clean, typed Engineer prompt with resume/preserve/discard.
- **S3.4** — C1A hierarchy-aware routes (lands with M4's schema): edge checks, channels, delegation validation, artifacts, rollups, budgets.
- **S3.5** — C1B cutover: reject caller-supplied `from`, name-only addressing, inbox-implies-applied, unbounded paste, prose-derived control intent; the ambiguous legacy paths are deleted not shimmed, only after no live legacy binding remains.
- **(unnumbered)** — Verification stories mirroring the doc's attack suite: identity/authority, delivery/recovery chaos (kill -9 between every durable step), context/evidence, token-efficiency gates, stranded work — each a live-proof story, no adapter test doubles for live acceptance.
- **Parallelism:** S3.1 can start during M2 (daemon-side, no terminal dependency); S3.2 needs M1 spine + M2 per-vendor delivery evidence.

### M4 — agentic hierarchy
Builds `docs/design/agentic-hierarchy.html`; follows the doc's H-ladder, minus UI.

- **S4.1** — H0 shadow records: SpecRevision, PlanRevision, HierarchyNode/AgentBinding, IntegrationStage, PromotionGrant, Run/Task/TaskDetail, grants/channels/budgets/decisions/checkpoints/reviews/ArtifactRef.
- **S4.2** — H1 direct+flat control plane: typed G1/G2 gates, queen-owned run IntegrationStage, DelegationSpec, scoped tasks, independent authored-candidate review, budget fencing, daemon-only promotion (hive_land loses its fixed target; PromotionGrant-derived).
- **S4.3** — H2 optional lead tier: attenuated crew delegation, InterfaceContracts, pair channels, subtree rollups, TopologyDecision.
- **S4.4** — H3 promotion trains: speculative exact-SHA validation, bisect/requeue, revalidation.
- **S4.5** — H4 recovery: semantic checkpointing, WorkManifest ownership transfer, queen succession, lead loss, bounded quiesce, circuit breakers. *(This is the milestone #57 might belong to — see the #57 ruling request.)*
- **S4.6** — H5 stable projections freeze — the handoff Split Horizon consumes.
- **(unnumbered)** — New-launch integration: spawning (M2 pipeline) gains hierarchy admission — reserve-before-spawn, attenuation checks, capability epochs (project-agnostic: roles/topology never assume the Hive repo).
- **Dependencies:** depends on M3 C0/C1A; H-stories sequential-ish (H0→H1→H2) with verification stories ∥ per stage.

### M5 — UI-readiness gate (NOT UI work)

- **Exit** — every Split Horizon feature-ledger row (A run awareness/hierarchy, B terminal workbench/input safety, C task/review/lifecycle/evidence, D settings/global controls) has its underlying truth built and LIVE-PROVEN via projections/CLI/typed operations — demonstrated without any new UI; Split Horizon then starts as pure presentation ("about looks, not features") and is out of this plan's build scope.
- **S5.x** — one gate story per ledger row family, each enumerating its projections (Workspace feed v1, WorkspaceSnapshot v2, session inspection+events, TaskDetail+ArtifactRef, CommunicationProjection, TokenAttributionProjection, CLI bridge) with live proof.
- **Final story** — end-state demo: dev build opens on an arbitrary non-Hive project, any of the three vendors boots as Queen, full loop (spawn→work→status→message→land) proven. *(Note: "any of the three vendors" may itself be superseded by #38/#63's five-agent expansion.)*


---

# Flag register — everything needing your decision, in one place

## Flag counts

| Flag | Items |
|---|---|
| **AC-MISSING** (no acceptance criteria at all, or a named requirement with no pass condition) | **#36, #52, #55, #56, #62**; structurally **#5, #6** (no story doc, one outline line each); **#15–#17, #18–#33** (no planning-doc identity); plus specific gaps inside **#34, #3, #7, #11, #10, #1, #2** |
| **AC-THIN** (present but not executable as written) | **#5, #6, #9, #38, #48, #53, #59, #60, #61, #63**; plus specific criteria inside **#34, #7, #8, #10, #1, #2** and four human-gate probes |
| **Adequate AC as written** | **#45** (the Rule is executable and demonstrably enforced), **#57** (live proof with a mandatory negative control), **#11** (three instrumented criteria + a binding constraint) |

## Rulings ranked by consequence

1. **P1 — ratify or amend the `PLAN STATUS: FINALIZED … Execution NOT authorized` header.** Execution is underway; A0 and B1 headers still say otherwise. Date and scope any approval to a revision, not to the document by name.
2. **#59 vs #45 — `make terminal` deletion vs the human resize-and-type acceptance.** Both are M1 exit criteria and are mutually blocking. #59's runbook caveat misses #45 entirely. *Which runs first?*
3. **#57 milestone (M2 vs M4).** The issue explicitly refuses to guess — "needs a ruling, not a guess." Recommendation on record is M2. Hard date gate: **blocked until 2026-07-26T00:00:27Z** on Codex quota, and it must **share one session** with the resume-liveness debt — "do not schedule two."
4. **#38 vs #63 — circular blocking.** #63 says "Blocked by #38"; #38's acceptance requires #63's two vendors "fully working and proven end-to-end… before the story is accepted." Neither can close first, and their parity lists differ (#38: status, usage/quota, model setting, router · #63: native spawn, normal+yolo, hive_send/report, landing). *Which list is authoritative, and which card closes on the vendor proof?*
5. **A0 semantic 5 — reap authority architecture.** Durable adoptable monitor, or typed-loss-on-host-crash? This drives freeze test G, gates the contract freeze, and therefore gates A2 and everything downstream. **This is the deepest architectural fork in the package.**
6. **P3 — do A3/A4/B3 get story docs?** Two live-proof invariant cards (I3/I4, I2/I5) are carrying one outline line each.
7. **#52 vs #56 — possible duplicate.** #52's symptom (Workspace survives `hive stop`, needed SIGKILL) matches #56's signature closely, yet #56 claims an exhaustive sweep and rules its own path out for its incident. The check is cheap: did #52's SIGKILLed process show `reply=terminateLater` with no `phase=resolved`? *Settle before both are scheduled, or the same fix gets built twice — or #52 gets closed by #56's fix with nobody checking.*
8. **B1 Gate 7 HOLD clearance** — "HOLD for hester delta-verify of F-fixes then queen-cleared land of automatable slice with PENDING_HUMAN slots intact." Clear it, or require human slots filled first?
9. **B1 Gate 9's two decisions taken ahead of the open-decisions list** — B-class `keybind = clear` stripping, and DESKTOP_NOTIFICATION bridge-deny. Ratify both. **Note the stripping introduced a contradiction:** the B-class control text asserts "no bytes written," but under stripping "binding lookup misses → keys encode normally," i.e. bytes *are* written. *Which assertion is correct post-strip?*
10. **#36 ownership.** Self-declared "unscoped for execution," no GUI-automation owner, no acceptance criteria, and its row J is double-tracked as a #45 checkbox. *M1 blocker or deferred? Single owner for row J?*
11. **C1 DoD-8 — your personal aesthetic signoff, no engineer proxy** (user ruling Q5). Confirm availability for a side-by-side session against Ghostty app / Terminal.app / iTerm2, gated on the B2 integrated pane, with no proxy fallback under schedule pressure.
12. **Queen permissions (#38, touching #62).** Specified behaviorally ("queen never authors implementation code"), not as an allow/deny set. Standing hazard on record: orchestrator permission hand-edits are asymmetric (allow entries survive but can be inert; deny removals return), and the deny list is shared with revoked writers — widening it can re-arm a revoked agent. *Does #38 own making the change durable, or only specifying it?*
13. **Architecture coverage across the board.** Gate 4 requires "arm64+x86_64 slices"; Gate 6 requires the checkpoint corpus on **both** native slices; B2 DoD-1 says both; C2 implies "universal." **All recorded A1 conformance evidence is arm64-only.** *Is x86_64 hardware (or a qualified emulation path) available? If not, is a single-architecture ship with `ENGINE_MISMATCH` enforcement acceptable for M1?*
14. **#48's contamination rule** attaches an obligation ("quiesce the loop or record that it ran") to every live-proof session in M1, but is referenced from none of them. *Who enforces it, and where is it recorded?*
15. **#55 — which preventive fix?** Commit-msg hook, house style, both, or neither? Note the hook is local and opt-in — it does not run in every agent worktree and is bypassable with `--no-verify`. *Do you want a server-side/CI check instead of or in addition?*

## Verification gaps I could not close read-only

- **#55's remediation is incomplete — verified.** It claims "#45 carries a note naming #2 as its blocker." I fetched #45's body and grepped it: **no such note exists.** #2 itself is correctly reopened. That missing note is the safety net for the exact gate the prose-closure defect endangered.
- **#52's only evidence is unlanded and gitignored** — `.dev/proofs/e2e-43-45/` in the `helga` worktree. One worktree cleanup from unrecoverable, and a gitignored evidence path also fails manifest checks on a fresh checkout. *Land or preserve it before the worktree is reclaimed.*
- **B1 gates 1, 2, 4, 5, 6, 8 carry no status line at all** — six of ten gates. Gate 2 is flagged "likely current-candidate P0" with a named live defect (five null handler effects: `device_attributes`, `enquiry`, `size`, `write_pty`, `xtversion`); Gate 8 has four named snapshot defects. Neither records proof or disproof. **DoD-3 requires each named snapshot defect be "either fixed and re-proven or shown already-absent — never assumed fixed," and no disposition exists for any of the four.**
- **B2 records no per-increment status of any kind** — 0 of 8 increments (B2.0–B2.6) marked closed, and the doc has no status column to mark. *Consider requiring a per-increment status table, as C1.2's gate cell has.*

## Two structural observations worth carrying into the approval

1. **A1 is the only story with a truthful incremental status line**, a recorded conformance evidence table, and recorded positive controls (mutation-style: removing production `INPUT_SUBMIT` dispatch, or substituting a default termios profile, produced the expected RED; restoration made all 173 native tests pass). **It is the model the other stories should be held to.** A0 and B1 share an identical header — "fully specified; execution awaits user plan approval" — which is accurate for A0 and demonstrably false for B1.
2. **`PLAN STATUS: FINALIZED` has already proven not to mean immutable.** #38 superseded part of M2 three weeks after finalization, and the outline says so in as many words. Approval should be dated and scoped to a revision, and **the board should be treated as authoritative wherever the two disagree** — the board carries scope no planning doc records.


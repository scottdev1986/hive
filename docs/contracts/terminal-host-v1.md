# Terminal host contract v1.0.0

Status: **shape frozen**. This is the project-neutral target boundary for terminal-session adapters. The neutral qualification fixture passes A–K. Real-session verification is intentionally incomplete until the pending-A1 discriminators pass and a neutral adapter exists.

The host accepts an opaque session key, a command, a terminal profile, and an initial window. It owns terminal I/O and reports evidence. Product identity, agent identity, provider choice, authorization, repository/worktree concepts, and product lifecycle policy are exclusively adapter concerns above this boundary. A consumer whose creation authority depends on a live external representation adopts the separately versioned [terminal-host visibility extension](terminal-host-visibility-v1.md); UI policy still terminates in its adapter.

## Normative vocabulary

- A **session reference** is an opaque caller key plus a host-issued incarnation. Every mutating, attachment, and termination request carries both. Reusing a key never makes an old reference name a new process.
- A **sequence** is an opaque, monotonically ordered token. Callers compare sequences only through ordering established by the host; they do not parse them.
- **Complete** means the host has the evidence needed for the stated claim. **Partial**, **unavailable**, and **unknown** never imply absence or exit.
- A **receipt** reports the strongest stage actually evidenced. Accepted, queued, written to the terminal endpoint, consumed by the child, and observed by the application are different claims.
- A **checkpoint** is an opaque, versioned byte object described by content type, schema version, hash, and the event/output positions it covers. Renderer-native structures are not part of the boundary.

## Required behavior

### 1. Creation and job control

Before executable replacement, the child is a new session leader, the slave terminal controls that session, standard input/output/error refer to the same slave, the foreground process group is valid, and the complete initial terminal profile and all four window fields are applied. Creation mechanisms are implementation choices, not caller controls.

The launch result is exactly one of `running`, `exec-failed`, `exited`, or `unknown`. `running` requires positive executable-replacement evidence; creating a process or observing a PID is insufficient. Failures identify the failing semantic layer and preserve an operating-system code when one exists. Invalid command, working directory, complete environment, descriptor transfer, terminal setup, and executable replacement are distinguishable.

Create is idempotent by opaque key and idempotency key. A retry after an uncertain transport result cannot start a second command. Every process identity combines a process ID with a start token.

### 2. Command environment and handles

The environment is a complete vector. No ambient variable is inherited unless the caller includes it. Every extra child descriptor comes from an explicitly transferred handle mapped to one target descriptor. The source disposition is explicit. Unmapped descriptors do not survive executable replacement, and transfer failure cannot produce a running result.

### 3. Exit and reap authority

A durable parent either remains the authority and records the child status for later adoption, or reports authority as unavailable after losing parenthood. Direct-parent observation and an authenticated durable-parent record are authoritative; process notification or disappearance alone is not reap proof. Exit status, reap state, evidence source, and completeness are reported independently.

### 4. Ordered output lifecycle

Output is raw bytes with exact byte ranges and event sequence. Process exit, process reap, and output closure are separate ordered events. Exit never closes replay by itself: the host drains the terminal tail until endpoint closure or an explicit bounded failure is reported. Text decoding is a consumer concern.

### 5. Ordered resize

Resize carries an expected incarnation, an idempotency key, and a monotonic revision. It shares the session mutation order with input. An applied receipt includes all four fields read back from the terminal and never claims the foreground application handled its notification. Coalescing is allowed only when the final applied revision and ordering remain truthful.

### 6. Bounded flow control

Input transactions and queues, output frames, retained output, and unacknowledged output are bounded by negotiated limits. Partial progress, interruption, and temporary unavailability are implementation realities that must not reorder bytes. Credits and acknowledgements expose available capacity. Retention loss produces an explicit gap with the missing range and checkpoint requirement; silent loss is forbidden. Software start/stop flow control is represented as terminal behavior, not assumed away.

### 7. Resumable attachment

Attach negotiates protocol and checkpoint capabilities. A cursor names both event and output positions and may bind an opaque checkpoint identity. Resume is exactly-once at byte boundaries even when disconnect occurs inside a terminal escape or multibyte text encoding. A cursor outside retention returns a gap and a full checkpoint requirement.

### 8. Input ownership

Every input transaction is fenced by a host-issued claim/lease and the session incarnation. Human and automation are generic writer kinds. Claim acquisition completes synchronously before human bytes are accepted. Transactions are ordered and idempotent; concurrent writers cannot interleave one transaction with another. Key-event encoding belongs above the host.

### 9. Termination and terminal input

Termination is a required request with graceful/immediate mode, foreground-group/session-members/process-tree target, deadline, idempotency key, and incarnation. Completion reports verified survivors; signal delivery alone is not success.

Byte input, canonical end-of-file input, and terminal hangup are distinct operations. End-of-file has its special meaning only in canonical input mode. The same byte is ordinary data in literal mode. Hangup is terminal closure behavior, never a generic socket half-close.

### 10. Honest inspection

Inspection reports lifecycle, host and child identities, session/process-group/foreground-group and terminal evidence, geometry plus revision, retained output and checkpoint ranges, current input owner, exit/reap authority, descendants, survivors, evidence time, diagnostics, and completeness. Transport failure maps to `unknown`, never absent or exited. Listing returns the same inspection shape without product-specific filtering.

## Minimal operation set

- `create(key, idempotency, command, terminalProfile, initialWindow)` returns an incarnation, launch evidence, and limits.
- `claimInput`, `releaseInput`, and `submitInput` provide fenced, leased, transactional input.
- `resize` provides an ordered revision and applied readback.
- `attach` and `acknowledgeOutput` provide negotiated cursor replay and backpressure.
- `inspect`, `list`, and `subscribe` provide honest snapshots and ordered facts.
- `terminate` provides targeted, idempotent termination with survivor evidence.

This operation set is semantic. Implementations may combine transport messages or use different internal process/terminal primitives while preserving every observable guarantee.

## Freeze qualification A–K

| ID | Required observation | Shape status |
|---|---|---|
| A | All three standard streams are the same terminal; child is session leader with a valid foreground group; initial profile and four-field window precede the first instruction. | Neutral green |
| B | Invalid executable, working directory, environment size, and descriptor transfer return typed failures without ghost-running state; Unicode/spaces and a generic non-repository working directory succeed. | Neutral green; real typed discriminator pending A1 |
| C | Only declared descriptors survive; handle transfer ownership and closure are deterministic. | Neutral green; real transfer/leak discriminator pending A1 |
| D | Interleaved input and burst resize preserve mutation order, monotonic revisions, applied readback, and final foreground observation. | Neutral green; real receipt discriminator pending A1 |
| E | A 100 MiB producer with slow/disconnected viewers and software flow stop/start has bounded memory, byte integrity, and explicit pressure/gap. | Neutral green; real candidate baseline green |
| F | Normal and signaled exit retain all tail bytes and separately order output closure, exit, and authoritative reap. | Neutral green; real candidate baseline green |
| G | Broker restart reattaches to a durable parent; parent loss reports unavailable authority rather than fabricated exit. | Neutral green; real candidate baseline green |
| H | Disconnect inside an escape and multibyte encoding resumes once from checkpoint/cursor without byte duplication or loss. | Neutral green; real candidate baseline green |
| I | Concurrent human and automation writes obey claim fencing, transaction idempotency, and non-interleaving. | Neutral green; real candidate baseline green |
| J | Immediate process-tree termination either removes an escaped descendant or reports it as a survivor. | Neutral green; real candidate baseline green |
| K | Canonical end-of-file, the same byte in literal mode, and terminal hangup have distinct results. | Neutral green; real candidate baseline green |

Every neutral case has a mutation control: injecting that case's semantic violation makes the corresponding assertion fail. The three pending-A1 real discriminators are expected failures, remain executable and visible, and must turn green before declaring the real-session freeze complete. The ordinary suite reports them as intentional xfails; the separately invoked `pending-a1-contract` native qualification target is intentionally red and includes a live arbitrary-descriptor-leak probe.

Qualification versions: contract `1.0.0`; neutral fixture `1.0.0`; audited sessiond candidate `82b671a5b14e9489d584f41e0c36c65813923d3e`; Zig `0.15.2`; Bun `1.3.14`; libghostty-vt `1.3.2-dev` at `73534c4680a809398b396c94ac7f12fcccb7963d`.

## Deferred boundary work

There is no project-neutral real-sessiond adapter before A2. A1 qualifies and repairs the candidate primitives against the pending discriminators. A2 implements this frozen target over the qualified host. Real-session verification is complete only after both are present; shape freeze does not claim otherwise.

## Visibility-backed creation profile

The base v1.0.0 shape remains stable for consumers without representation-backed lifecycle authority. Visibility-backed consumers must use the visibility extension's replacement `create` operation rather than expose this profile's unguarded base `create`. The extension adds only neutral source identity, inventory revision, lease, renewal, expiry, and typed failure behavior; product pane states and inventory transport stay above the boundary.

## External basis

- Apple documents the PTY pair plus initial terminal/window setup, and that login preparation creates the session, controlling terminal, and standard streams: [openpty, login_tty, forkpty](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/openpty.3.html).
- Apple documents allocation of master/slave pseudo-terminal pairs without implying job-control setup: [posix_openpt](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/posix_openpt.3.html).
- Darwin documents controlling-terminal acquisition, foreground groups, raw/canonical input, bounded queues, nonblocking progress, software flow control, end-of-file, and hangup behavior: [termios](https://keith.github.io/xcode-man-pages/termios.4.html) and [tcsetpgrp](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/tcsetpgrp.3.html).
- Darwin documents complete argument/environment replacement, descriptor inheritance, and size failures: [execve](https://keith.github.io/xcode-man-pages/execve.2.html).
- Apple documents child-status collection and reparenting semantics: [waitpid](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/waitpid.2.html).
- Apple documents process filters as event notification; the contract therefore does not treat them as reap authority: [kevent](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kevent.2.html).
- Ghostty describes libghostty-vt as terminal parsing/state rather than session policy and notes that its API remains in flux; checkpoints therefore stay opaque and versioned: [Ghostty libghostty](https://github.com/ghostty-org/ghostty#cross-platform-libghostty-for-embeddable-terminals).

# ADR 0002: Ghostty patch budget and local threat model

- Status: Accepted
- Date: 2026-07-16
- Decision scope: pinned Ghostty bridge, local session transport, and release provenance
- Source of record: [Terminal stack transition](../design/terminal-stack-transition.html), especially §§05, 16, 21, 23, and 28

## Context

Pinned upstream Ghostty supplies the terminal engine and renderer, but its current public embedding header does not expose Hive's two required capabilities: an AppKit surface with embedder-owned manual I/O and complete same-build checkpoint import/export. A compatibility patch is permitted only to close those seams. A larger application fork would move Hive policy and process ownership into an unstable dependency boundary and make security review, upgrades, and provenance unbounded.

The service is local and all cooperating processes normally share a macOS user. Same-UID therefore does not mean authorized. Terminal content and control operations cross Unix sockets, native callbacks, PTYs, files, and renderer protocols, while provider output is hostile input.

## Decision: exact patch boundary

The Ghostty patch may implement only manual surface I/O and complete same-build terminal checkpoint import/export. Its hard budget is:

- exactly one Hive public C header;
- at most six modified upstream implementation files; and
- at most 1,500 non-test lines.

Generated bindings, tests, fixtures, and build wiring do not count toward those three limits. They remain reviewable release inputs and may not hide implementation logic. One Swift wrapper fences the C ABI on the Hive side.

The bridge may create a manual surface without a child PTY, accept contiguous ordered output, return Ghostty-encoded human input through a bounded callback, inject text/paste through the same encoder, emit the six declared surface events, and import/export a complete opaque checkpoint for the exact engine build. The renderer copy must not generate canonical PTY query replies.

No Hive window management, navigation, hierarchy, settings UI, message policy, process management, provider behavior, authorization rule, or product identity may enter the Ghostty tree. A need for any of those is a design failure, not permission to spend more patch budget.

The exact upstream commit, patch series, public header, exported symbol list, engine/toolchain identity, and produced XCFramework receive SHA-256 identities in the release lock and SBOM. An upgrade requires an intentional lock update, bridge rebase, ABI/symbol diff, and the complete terminal corpus.

TG1 or TG2 failure stops direct sessiond admission. It never authorizes a broader fork, partial checkpoint advertised as reconnect, terminal-screen scraping, or a runtime-fetched dependency.

## Assets and trust boundary

The protected assets are:

- terminal bytes, captures, pasted text, clipboard data, checkpoints, message bodies, and provider environment secrets;
- exact instance, subject, generation, PID/start-token, process-group, executable/build, socket, output-sequence, and visibility-lease identity;
- the sole PTY master and ordered human/automated input path;
- lifecycle authority, message receipts, status source/confidence, and exit/survivor evidence; and
- the source pin, patch, headers, symbols, helper/framework bytes, signatures, licenses, and SBOM.

Authorized peers are the exact signed/bound Hive daemon, Workspace, sessiond broker, and generation host acting with the operation-specific capability described by the local protocol. Agents never connect to sessiond. A same-user process, a different Hive instance or project, a stale generation, a replayed grant, a substituted socket/path, a hostile provider VT stream, and a compromised build input are untrusted.

The v1 boundary prevents accidental cross-project and cross-generation access and stale-token reuse. Same-UID malware is an explicitly accepted residual risk; this design is not a sandbox claim.

## Threats, controls, and stop conditions

| Threat | Required control | Stop condition |
| --- | --- | --- |
| Unstable or expanding libghostty surface | Exact source/toolchain pin, one Swift fence, header/symbol ABI tests, upstream-first bridge, and the hard patch budget | Required behavior cannot be isolated, provenance cannot be proven, or upgrades repeatedly exceed the budget |
| Incomplete checkpoint or replay divergence | Complete opaque engine state, adversarial byte-split corpus, digest/effect equivalence, bounded journal eviction only after verified checkpoint | Any restored screen, cursor, parser/mode, keyboard protocol, hyperlink, grapheme, synchronized-output state, or image lifetime differs |
| Duplicate or misordered I/O | One host owns the PTY master; one event loop orders claims and transactions; surface accepts contiguous sequence ranges; renderer query replies disabled | Any loss, duplication, reordering, interleaving, wrong target, or ambiguous reconnect |
| Cross-instance, cross-generation, or stale-token access | Canonical private paths; directory FDs; `openat`/`O_NOFOLLOW`; ownership/mode checks; peer UID/PID/start-token evidence; exact locator; one-use 256-bit grants; adoption secret | Any unauthorized attach, inspect, write, adoption, or termination succeeds |
| Sensitive-data disclosure | Runtime files mode 0600/0700; no raw grants in argv/env/logs; content-free normal metrics; consent/preview/redaction for support bundles | Terminal content, messages, paste, clipboard, checkpoints, tokens, or secrets enter ordinary logs or analytics |
| Hostile terminal protocols | Deny OSC 52 reads/writes; explicit gesture for HTTP/HTTPS; normalized repository boundary for `file:`; bounded direct Kitty images; disable file/temp/shared-memory image transports | Escape sequence, link, clipboard, image, or frame crosses its authority/resource boundary |
| Process escape or PID reuse | Per-generation host, PID start tokens, verified process inspection, deepest-first termination, positive absence/closed-PTY evidence, explicit survivors/unknown | Hive kills an unrelated process or reports stopped while an owned process survives or is unobservable |
| Invisible live provider or excessive resources | Workspace open-terminal inventory, short visibility lease, terminate-on-close/quit/expiry, isolated hosts, bounded journals/images/queues/renderers | A process survives without visibility, one host harms another, detached surfaces render, or memory/disk/GPU grows without bound |
| False status, receipt, or authority | Daemon-owned authorization and ledger; structured sourced status with TTL/revision/confidence; provider-specific receipt evidence; no terminal text as truth | Agent self-approval, stale-as-fresh state, timer/screen phrase as proof, hidden contradiction, or false receipt |
| Compromised or non-portable release | Universal reproducible build, hashes, licenses/SBOM, nested signing/notarization/Gatekeeper, offline clean-machine launch | A supported Mac needs developer tools/runtime downloads, rejects nested code, lacks an architecture, or loads unpinned bytes |

## Security invariants

- Peer identity comes from kernel/process evidence and the existing daemon handshake, never JSON claims.
- Capabilities authorize one operation on one exact generation; display names do not address sessions.
- Bridge callbacks are non-reentrant, callback-lifetime only, main-thread confined for the surface, and copied synchronously within bounds. They never write a file descriptor directly.
- A failed or changing process inspection is `unknown`, not success. A sent signal, successful syscall, or exited command is not termination proof.
- Normal telemetry records identifiers, byte counts/ranges, timings, transitions, build IDs, and redacted diagnostic codes—not content.

## Consequences

The patch remains replaceable and auditable, and local transport threats are stated without promising isolation macOS does not provide. The tradeoff is a hard stop when upstream cannot satisfy TG1/TG2 inside the budget. Shipping later is acceptable; silently widening the fork or weakening reconnect truth is not.

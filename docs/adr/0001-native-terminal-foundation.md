# ADR 0001: macOS native terminal foundation

- Status: Accepted
- Date: 2026-07-16
- Decision scope: terminal transition T0–T7
- Source of record: [Terminal stack transition](../design/terminal-stack-transition.html), especially §§01, 03, 04, 11, 17, 21, and 28

## Context

Hive is a macOS product. Its terminal must show each provider's real full-screen TUI while keeping terminal bytes, Hive control state, and native presentation in separate planes. The existing stack couples daemon-owned tmux sessions to AppKit panes through SwiftTerm. T0 freezes the replacement before implementation so later work cannot choose identity, lifecycle, input, or renderer semantics locally.

The selected engine's embedding API is not yet a stable general-purpose ABI. That makes exact source provenance, a fenced compatibility bridge, and qualification gates part of the architecture rather than optional build details.

## Decision

Hive supports macOS only and ships universal arm64 and x86_64 release artifacts. The terminal foundation is:

- The existing native AppKit workspace remains the product shell and pane topology through T0–T7. Split Horizon may later change navigation and layout; it does not change terminal ownership.
- `HiveTerminalKit`, a Swift/AppKit module, owns the presentation boundary: the Ghostty Metal surface, render scheduling, first responder, native key/text/IME/mouse encoding, selection, search, copy, accessibility, theme projection, and attach state.
- A pinned upstream `libghostty` is packaged inside Hive as `GhosttyKit.xcframework`. Hive adopts its parser, encoder, grid semantics, and Metal renderer as an internal engine, not the Ghostty application, window model, settings, configuration files, or product identity.
- A bundled universal `hive-sessiond` executable provides a per-`HIVE_HOME` broker and one isolated host per terminal generation. The broker owns discovery, attach routing, visibility leases, supervision, and adoption. Each host owns exactly one vendor process generation, its macOS PTY master, ordered input, canonical headless VT state, output sequence, journal, checkpoints, attached clients, process evidence, and resource limits.
- The existing Bun Hive daemon remains the control authority for lifecycle intent, authorization, capability epochs, status fusion, messages, and attention. It does not own terminal bytes, a PTY descriptor, a terminal grid, focus, or a renderer.
- The neutral `SessionHost` contract is the only control-side terminal interface. It contains no tmux or renderer vocabulary.
- Claude, Codex, and Grok continue to run as their real interactive processes on macOS PTYs. Hive never reconstructs a transcript to imitate their TUIs and never treats terminal-screen text as authoritative agent state.

Every operation addresses an exact instance, tagged subject, and generation. A stale or ambiguous locator fails with typed evidence. A live terminal may lack a renderer only while its exact generation remains in the Workspace's open-terminal inventory under a current visibility lease. User close means verified termination, never background detach.

## Consequences

Hive can use one native input, rendering, accessibility, packaging, and process-lifecycle contract. The app ships its renderer, helper, VT engine, and native dependencies; users do not install tmux, Ghostty, Zig, a shell plugin, or a package manager.

The transition is admission-based. Existing tmux/SwiftTerm generations drain on the path that created them; no live PTY or checkpoint is migrated across engines. Until TG1 proves complete manual I/O and TG2 proves complete same-build checkpoints, tmux and SwiftTerm remain the fallback and Hive makes no direct-session reconnect claim. T0–T7 does not require the future hierarchy, review, or one-workbench UI records.

The architecture is blocked by any violation of invariants I1–I10, gates TG1–TG7, or SLO-01–SLO-10. Stable proof identifiers are frozen in [the conformance-test registry](../terminal/conformance-test-ids.json).

This ADR is the newer binding terminal decision. Earlier exploratory documentation that rejects an unpinned or unfenced libghostty integration does not override the exact-pin, bounded-bridge, stop-gated decision recorded here.

## Rejected alternatives

- Keep tmux and SwiftTerm as the permanent foundation: rejected because session lifetime, process evidence, input authority, and rendering remain split across legacy substrates.
- Embed or fork the Ghostty application: rejected because Hive owns its workspace, settings, lifecycle, status, hierarchy, and visual identity.
- Let `libghostty` spawn and own the provider PTY: rejected because all human and automated input must enter the single sessiond arbiter and canonical VT state must survive renderer replacement.
- Build a Hive transcript renderer: rejected because the real vendor VT stream and TUI semantics are binding invariant I1.
- Make the terminal transition depend on hierarchy or Split Horizon: rejected because those later designs consume this foundation rather than define it.

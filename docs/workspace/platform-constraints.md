# Platform Constraints

Updated: 2026-07-14
Sources: Hive source tree, 2026-07-14; [cross-vendor architecture review](../../raw/reviews/cross-vendor-architecture-review.md)

## Summary

A reference of macOS platform traps and terminal-renderer facts that a native Workspace keeps rediscovering the expensive way. Each entry is a correction to an assumption that looked obviously true; most describe Apple or upstream behavior and have no corresponding line in this repo, which is exactly why they need a home.

## Bookmarks name a path, not a project

**A bookmark will happily name an impostor.** Apple documents a bookmark as "capable of locating resources that have been moved or renamed" — Alias Manager semantics — so the first correction is that a bookmark does *not* pin the directory you bookmarked. The obvious remedy follows: never trust the bookmark; compare its resolved path against the last confirmed path and treat disagreement as a move.

**That remedy is also wrong, and the prototype is what proved it.** Driving real plain `NSURL` bookmarks (`prototypes/project-identity`, `prototypes/project-identity/EVIDENCE.md:174`) shows resolution is **path-first**: a bookmark follows a rename only while the old path stays *vacant*.

| step | state on disk | bookmark resolves to |
|---|---|---|
| bookmark `A` | `A` exists | `A`, `isStale=false` |
| rename `A` → `B` | `B` exists, `A` vacant | `B`, `isStale=true` |
| create any fresh dir at `A` | **both** `B` and `A` exist | **`A`** — the impostor, `isStale=true` |

In row three the real project is alive at `B` and the bookmark points at an unrelated directory at `A` — and, decisively, **resolved path == confirmed path**. The path-disagreement check therefore *passes* in precisely the dangerous case and attaches the wrong directory (`prototypes/project-identity/EVIDENCE.md:116`, `move-then-impostor`).

The surviving rule is stronger than either version: a bookmark is a hint, never a verdict. Filesystem evidence is consulted **before** the bookmark and may **only refuse**. See the resolver in [blueprint.md](blueprint.md) ("Project identity: evidence may only refuse").

- **`NSURLFileResourceIdentifierKey` is not persistent across system restarts.** It can be evidence; it can never be the durable key. The durable refusal pair is `ino`/`birthtime`: matching is necessary and insufficient, while either differing is dispositive. `st_dev` is only a process-local mount hint because macOS may renumber it across reboot.
- **Security-scoped bookmarks are a sandbox construct.** `startAccessingSecurityScopedResource()` is a no-op outside a sandbox. Hive ships unsandboxed (`scripts/signing/entitlements.plist` declares only `allow-jit` and `allow-unsigned-executable-memory` — no `app-sandbox` key), so the Workspace uses **plain** bookmarks, which is what the prototype measured.

## XPC: the endpoint is not the identity

- **`xpc_connection_get_audit_token` is private SPI.** Not an option.
- **PID-based peer checks are TOCTOU-broken** by Apple's own warning: another process can spawn and claim the PID before the message is received.
- **The supported mechanism is a code-signing requirement**: `NSXPCConnection/NSXPCListener.setCodeSigningRequirement` (macOS 13+), `xpc_connection_set_peer_code_signing_requirement` (12+), `xpc_connection_set_peer_lightweight_code_requirement` (14.4+). Swift's native `XPCListener`/`IncomingSessionRequest` exposes no code-requirement check, so the Objective-C/C API is mandatory.
- **An anonymous endpoint is a bearer capability, not an identity.** Possessing it proves nothing about who holds it. `prototypes/authenticated-xpc` A/Bs exactly this (H2): the *same* hostile client, holding a *real* endpoint fetched from an unauthenticated rendezvous, is served by the listener without a requirement and rejected by the identically shaped listener with one. Identity came from the requirement, never from the address. `setConnectionCodeSigningRequirement` rejects the peer *before* `shouldAcceptNewConnection` is consulted.
- Corollary, also measured (H4): a capability file descriptor **not** marked `FD_CLOEXEC` is readable by an agent's grandchild by its known fd number. Inherited credentials leak through descendants unless the flag is set.

Authentication (who is calling) and authorization (what they may do) are separate and both required; the authorization half is the capability rights matrix in [../daemon/authorization.md](../daemon/authorization.md).

## Isolation tiers that cannot be built

- **Child sandboxes are un-tightenable.** Children inherit the single parent sandbox and cannot be given a stricter one; an inheriting child that declares anything beyond `app-sandbox` + `inherit` is aborted by the system.
- **`sandbox_init(3)` / `sandbox-exec(1)` — the only per-child profile mechanism — is deprecated with no supported replacement.** Together these make a "restricted native experiment" tier *unimplementable on supported API*. Record that honestly rather than shipping a tier that cannot hold. Real boundaries mean a VM or a remote runner; nothing in between is enforceable.
- **`NSPasteboard(name:)` separates storage, not access.** Any same-user process can open any named pasteboard, and a GUI parent has no mechanism to stop its own non-sandboxed child — a tmux-hosted CLI, `pbcopy`, an agent's Bash tool — from reaching `NSPasteboard.general`. Mediating OSC 52 inside the terminal surface is worth doing; calling the result a *private per-tenant clipboard* is a false security claim. (Nothing in `workspace/` builds one — keep it that way.)
- **Multiple instances of one bundle share one saved-state container** (`~/Library/Saved Application State/<bundleID>.savedState`), one Dock tile, one `UserDefaults` suite, and one menu-bar owner at a time. Automatic window restoration therefore cannot distinguish per-project instances; it must be disabled and reimplemented if instance-per-project is ever revisited.
- **Agent toolchains that JIT force `com.apple.security.cs.allow-jit`** under Hardened Runtime — which is why `scripts/signing/entitlements.plist` carries it. Spawning child processes itself needs no entitlement.

## The terminal-renderer landscape

The one-line decision: **do not start a libghostty integration** ([blueprint.md](blueprint.md)). The rest is why.

| Candidate | Layer | What you get | What you must build |
|---|---|---|---|
| **SwiftTerm** (MIT) | Full stack | Parser, buffer, `TerminalView: NSView`, CoreText rendering | Accessibility depth, selection completeness |
| `libghostty` (MIT, Zig) | Surface + Metal | Embeddable, real | Nothing — but the API is **untagged and explicitly unstable** |
| `libghostty-vt`, `alacritty_terminal`, `wezterm-term`, `termwiz`, `libvterm` | **Core only** | VT parsing, grid, buffer, pty | Renderer, view, input stack, IME, accessibility — all four |

- **libghostty's surface API is untagged.** Ghostty's own C API overview says it is "not yet stabilized for general-purpose embedding" and "may change significantly between releases"; the repo states no version has been tagged. That is the disqualifier: an unversioned upstream cannot be the floor of a shipped ABI. Embedding also imports a Zig toolchain into an Xcode notarization pipeline. Revisit only if a tagged surface library ships.
- **The core-only crates are not alternatives to SwiftTerm — they are alternatives to the *parser inside* SwiftTerm.** Choosing one means writing the renderer, the AppKit view, the IME integration, and the accessibility tree yourself. Zed embeds `alacritty_terminal` and supplies its own GPUI renderer; that is the true cost.
- **SwiftTerm's weakness is accessibility and selection, NOT IME.** This corrects the obvious guess. In the pinned checkout, `TerminalView` conforms to `NSTextInputClient` with the complete marked-text suite (`setMarkedText`, `unmarkText`, `firstRect(forCharacterRange:)`, `attributedSubstring`, `validAttributesForMarkedText`). Meanwhile its macOS `AccessibilityService` is a 15-line class with one empty `invalidate()`. IME is done; accessibility is a stub. Point the caveat at the right subsystem.
- **A CALayer/Metal-drawn view gets zero accessibility for free.** Every `NSAccessibility` role, value, and range API must be hand-written before VoiceOver can read a single cell. This cost is invisible in a renderer bake-off and dominates it.
- The version pin is load-bearing and lives at `workspace/Package.swift:20` (`exact: "1.11.2"` — 1.12's Metal backend breaks universal release builds). Rationale in [ui-design-system.md](ui-design-system.md).

## Verifying the UI: a click you post to the system is silently dropped

A synthetic click posted to the *system* (`CGEventPost`) never arrives unless the posting process holds the Accessibility grant — and it fails **silently**: no error, no exception, the event simply never lands. So a "click" that returned success proves nothing, and a test that drives the app that way is green because nothing happened. This is the Workspace's instance of the rule the daemon docs state in general: an act is not a state, and *the screen redrew* is not *the button worked*.

Drive the app **in-process** instead. Two techniques, at different altitudes:

- **A click or a scroll at a point** — build the `NSEvent` and hand it to the window's own dispatch: `window.sendEvent(event)`. This is the path a real user's click takes (hit-testing, the pane's click recognizer, SwiftTerm taking first responder itself). Already in-tree and shipped: `postClick` at `workspace/Sources/HiveWorkspace/ProjectWindowController.swift:419-440`, `postScrollWheel` at `:394-413`. Note that a click only *focuses* in a **key** window — an unfocused window swallows the effect and looks like a dropped event.
- **Pressing a named control** (the pane's X, a menu item) — the point-based helpers above cannot address a button by identity, only by location. The approach on record walks the app's **own** AX tree (`AXUIElementCreateApplication(getpid())`), finds the control by role + description (`"Close Pane"`), and presses it with `AXUIElementPerformAction`. The harness this was recorded from (`XProbe.swift`, plus a `HIVE_PROBE=quit` mode that exercised the quit path with an agent live) was **deliberately not on main** — it armed itself at app launch and its own header called it temporary — and it has since been deleted. The technique above is the durable part; there is no implementation left to recover.

**Firmness:** the `sendEvent` technique is shipped code with callers. The AX-press harness is **recorded, not independently reproduced** — it was written by an agent whose work was discarded, and re-running it means pressing a real Close Pane button on a live agent, which is why it was never re-verified. Treat it as a strong lead that must be rebuilt from the description above, not as a proven recipe.

## Three rules that came out of this

- **"Content-blind" must be an explicit field allowlist, not an adjective.** A quota arbiter that leases capacity must see provider, account, pool, concrete model, and estimated units — and therefore learns how many projects exist and which models they run. It never sees prompts, paths, repo names, or branch names. Write the field list down; an adjective is not a specification.
- **`UNKNOWN_OUTCOME` is a first-class, surfaced state because no vendor offers turn-level idempotency.** Vendor resume recovers the *conversation*, not the *outcome of the turn that was in flight*. A turn you are unsure about cannot be safely replayed, so the honest unknown must be renderable — never a silent retry. It is written into the safety gates in [blueprint.md](blueprint.md) (gate 10).
- **"35 gates is a wish, not a gate."** A blocking gate must be falsifiable, cheap to run, and tied to a failure that has occurred or would be unrecoverable. A list long enough to feel thorough is a list nobody runs — and several of the original 35 gated subsystems that were later deleted, or asserted properties the platform cannot provide (the private clipboard, above). The blueprint's gate list is thirteen.

## Where the evidence lives

Four de-risking prototypes ran; their measured results supersede anything restated here.

- `prototypes/project-identity` — bookmarks, moves, impostors, symlinks, submodules, linked worktrees (22 checks).
- `prototypes/authenticated-xpc` — signed peers, code-signing requirements, anonymous endpoints, capability FDs (H1–H4, `run-evidence.sh`).
- `prototypes/agenthost-crash-matrix` — pipe-owner loss, replay, `UNKNOWN_OUTCOME`.
- `prototypes/provider-conformance` — one scenario vocabulary across Claude stream-json and Codex app-server.

## See Also

- [Blueprint](blueprint.md) — the settled Workspace architecture, the identity resolver, and the safety gates
- [UI Design System](ui-design-system.md) — the AppKit invariants and the SwiftTerm version pin
- [Authorization](../daemon/authorization.md) — the capability rights matrix that authentication feeds
- [Capability discovery](../providers/capability-discovery.md) — the provider-side counterpart to these platform limits

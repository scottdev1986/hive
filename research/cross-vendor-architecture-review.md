# Cross-vendor review: the Hive Workspace flagship

## The thesis, and where it changes

Maya and Noah propose a signed Swift/AppKit `Hive Workspace.app`: a Supervisor process owning a registry of projects, one Tenant Broker per project, one UI process per project in strict mode, authenticated tenant-scoped XPC between them, tmux as the truth of process survival, provider adapters as the truth of semantic events, and a versioned `TerminalSurface` ABI chosen by a bake-off among libghostty, SwiftTerm, and Alacritty's core. Thirty-five acceptance gates block release.

Most of that is right, and the parts that are right are right for reasons the memos state well. The control plane genuinely needs a Supervisor, because project identity and provider-account quota are the two things that cannot live inside any one project. The tier honesty about sandboxing is the best security writing in either memo. The refusal to scrape a TUI, guess a model id, or treat protocol presence as conformance is correct and hard-won.

But the memos share one assumption that, once tested, collapses a large fraction of the proposed machinery: that Claude Code cannot be trusted as a first-class orchestrator until it proves "approval/control conformance," and that the workspace must therefore be built around vendor TUIs living in tmux panes rendered by an embedded terminal emulator. I tested it. Claude Code 2.1.206 already implements the entire conformance list — semantic lifecycle, steering, cancellation with a receipt, a correlated approval round-trip, durable resume, effective-model reporting, and a capability handshake — over a documented stdio protocol. It is, on protocol hygiene, ahead of Codex's app-server, which has no protocol-version field at all.

The consequence is the central finding of this review. **If Hive owns the composer — which both memos independently conclude it must — then the agent has no TUI, and a pane showing an agent is a transcript view, not a terminal.** The terminal emulator stops being the foundation of the product and becomes a component needed for exactly two things: the user's own shell, and a legacy compatibility mode. A versioned `TerminalSurface` ABI with a three-way renderer bake-off is a large, risky, load-bearing investment in a component that, in the destination architecture, is no longer load-bearing.

That reframing is the recommendation. Everything below argues it, and corrects the factual record where the memos are wrong.

## What I verified, and how

Everything in this section was run on this machine against `claude` 2.1.206 and `codex-cli` 0.144.0, or fetched from Apple's and vendors' primary documentation. Where I could not verify a claim, it is named as unverified rather than smoothed over. Two subagents independently checked the macOS platform claims and the renderer claims; a third checked the non-Anthropic provider matrix.

One methodological note that is itself a finding. Probing for a model-discovery subcommand by typing `claude models` does not print help — Claude Code interprets an unknown subcommand as a *prompt* and runs a billable session. Discovery by guessing costs money and mutates state. This is the strongest possible argument for Noah's signed `ProviderDefinition` with declared-safe probe argv, and it bit this review before it reached the memo.

### Claude Code implements the whole orchestrator contract

Sending `{"type":"control_request","request":{"subtype":"initialize"}}` into `claude -p --input-format stream-json --output-format stream-json` returns, before any model call and at zero cost, an `account` block (`email`, `organization`, `subscriptionType: "Claude Max"`, `apiProvider`) and a `models` array. Each entry carries `value`, `resolvedModel`, `displayName`, `supportsEffort`, `supportedEffortLevels`, `supportsFastMode`, `supportsAutoMode`.

That is a machine-readable, authenticated, account-scoped model enumeration obtained without a billable probe. Both memos assert it does not exist. Maya: "Claude Code OAuth: no documented machine model list ... → Unknown." Noah: "OAuth subscription has no documented machine model enumeration." Undocumented, yes. Absent, no.

Alias resolution is also live. Starting a session and reading the `system/init` event before the model call reports the effective concrete model:

```
best              -> claude-fable-5
default           -> claude-opus-4-8[1m]
opus              -> claude-opus-4-8
sonnet            -> claude-sonnet-5
haiku             -> claude-haiku-4-5-20251001
opusplan          -> claude-sonnet-5
```

Hive currently hardcodes `CLAUDE_BEST_MODEL = "claude-fable-5"` in `src/adapters/tools/models.ts`. That constant is *currently correct* — and it never needed to be a constant. SPEC decision 6 says "the alias is resolved inside the CLI and no local file records it." True, and irrelevant: the CLI will tell you, for free, if you ask.

`system/init` also carries `capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"]`. This is a vendor-supplied capability handshake — feature detection by token, not by version-string comparison. It is exactly the shape Hive's own `RunnerProtocol` should adopt, and it is strictly better than what Codex offers.

The approval round-trip is real, and I drove it end to end. With `--permission-prompt-tool <sentinel>` and streaming input, a gated tool emits:

```json
{"type":"control_request","request_id":"f6d19880-…","request":{
  "subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
  "input":{"file_path":"…/note.txt","content":"hello"},
  "description":"note.txt",
  "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
  "tool_use_id":"…"}}
```

Answering with `control_response {behavior:"deny", message:"DENIED_BY_HIVE_BROKER"}` denies the call, and the model observes the denial and reports it. Without the flag, the same write is auto-denied with no way for a broker to intervene. So Claude's approval conformance is proven — with one honest caveat: `--permission-prompt-tool` is **absent from `--help` in 2.1.206** while still parsing. It is undocumented surface, the same risk class as the Channels research preview that SPEC already flags. The Agent SDK's `canUseTool`, `interrupt()`, `setModel()`, `supportedModels()`, and `pending_permission_requests`-on-reconnect are the documented face of the same protocol.

That last one deserves emphasis, because it answers a question Maya raised as possibly unanswerable. Her uncertainty 10 asks how recovery distinguishes "provider session accepted but response lost" from "not accepted," and concludes idempotency across vendor boundaries may be impossible. For Claude it is not impossible: re-sending `initialize` to a live session returns `pending_permission_requests`, an array of the exact `control_request`s the session is still blocked on. Reconnect, re-read, re-answer. The vendor solved it.

### Model pins cannot fail closed at spawn

`--model totally-bogus-model-xyz` is **accepted** at `initialize`, and `system/init` echoes the garbage back verbatim as the effective model. Only the first turn fails, with `is_error: true`, `total_cost_usd: 0`, and the message "There's an issue with the selected model … It may not exist or you may not have access to it."

This breaks a contract both memos assert. Maya's gate says "model mismatch/fallback fails closed"; Noah's says "no guessed IDs, automatic fallback or billable validation." A pin cannot be validated at spawn, because nothing validates it at spawn. But for Claude the news is better than it looks: **invalid-model validation is free**, resolving to zero observed cost.

So the corrected contract has three states rather than two. A model id is `catalogued` when a provider's catalog names it, `providerReportedSelectable` when an authenticated account-scoped call offers it, and `launchValidated` only after a real session accepted it. Claude's `initialize.models[]` yields the middle state, which is stronger than anything another vendor offers and weaker than proof. A session therefore opens in `VALIDATING`, accepts no task until the first-turn outcome lands, and fails closed on mismatch. `--fallback-model` must be left permanently unset, because it exists precisely to do the silent substitution both memos correctly forbid.

The zero-cost property is Claude-specific and must not be generalized. Each adapter declares its own validation semantics — whether a failed pin is free, billable, or leaves a partially created remote session — and the UI reports what that adapter actually promises rather than what Claude happens to do. Copilot, whose `-p` consumes credits, is the obvious counterexample.

This answers Maya's uncertainty 2 and Noah's item 9. Resume compatibility needs no billable probe: pin the concrete id, diff it against `initialize`'s `models[].resolvedModel` set at relaunch, and if the first turn returns `model_not_found`, stop and surface. Never substitute.

### Hive's own daemon is unauthenticated, and that is the real evidence for tenant-scoped IPC

Maya's stale-daemon analysis is correct and I reproduce it independently. `src/daemon/lifecycle.ts:41` fetches `/health`; line 49 accepts any response where `body.ok === true`. `src/daemon/server.ts:829` returns `{ok: true, version: HIVE_VERSION}` — the version is *sent and ignored*. `src/cli/daemon.ts:50` passes `repoRoot: process.cwd()` at daemon start, and `HIVE_PORT` defaults to `4483` with a shared `HIVE_HOME`. Project B therefore silently adopts project A's already-running daemon, and a daemon built before a code change keeps serving the old code path under an unchanged marketing version. That is the leading explanation for the recurring post-land viewer error, and it is architecture evidence, not a spawn blocker.

But there is a larger defect neither memo names. `src/daemon/server.ts` binds `127.0.0.1:4483` and performs **no authentication of any kind** — no bearer token, no authorization header, no peer check — while exposing `hive_land`, `hive_kill`, `hive_approve`, and `hive_spawn` as MCP tools. Any local process on the machine, including a sandboxed Codex agent that is supposedly confined to its worktree, can POST to that port and land arbitrary commits onto `main`, kill any agent, or approve any pending escalation. The sandbox boundary that decision 4 leans on ("an agent physically cannot write outside its worktree") is bypassed by a loopback HTTP call.

This is the single most important finding for the flagship design, because it converts "authenticated tenant-scoped IPC" from an architectural preference into a fix for a live vulnerability. It also means the capability epoch is currently unenforceable against a determined agent: the agent can simply call the daemon directly.

### The renderer bake-off compares three different layers

This is the cleanest factual error in Noah's memo, and Maya inherits it.

`libghostty`'s full surface-plus-Metal API does exist and is embeddable — Ghostty's repository advertises it with examples — but it is **internal and explicitly unstable**. Ghostty's own C API overview: "The libghostty API is currently used primarily by the macOS app and is not yet stabilized for general-purpose embedding. The API may change significantly between releases." The repository states "we haven't tagged libghostty with a version yet." The separately released piece, `libghostty-vt`, covers VT sequence parsing and terminal state only — no renderer, no input, no IME — and its author describes it as alpha, "not promising API stability," with surface/renderer/Swift-view libraries on the roadmap. The shipping objection is therefore not that the surface API is absent; it is that it is unversioned and in flux, which is precisely what a "versioned `TerminalSurface` ABI" cannot be built on. Ghostty is MIT and written in Zig, so embedding also imports a Zig toolchain into an Xcode build and notarization pipeline.

`alacritty_terminal` is Apache-2.0 and is **core only**: `grid`, `index`, `selection`, `term`, `tty`, `event`, plus a re-exported `vte` parser. No renderer, no view. Zed embeds it and supplies its own GPUI renderer. From Swift it costs a hand-maintained C shim plus a Cargo build.

`SwiftTerm` is MIT, actively maintained (pushed 2026-07-10), and is the only **full stack** candidate: parser, buffer, `TerminalView: NSView`, CoreText rendering with an optional Metal backend, and — contrary to the memos' framing — a complete `NSTextInputClient` implementation with the full marked-text suite (`setMarkedText`, `unmarkText`, `firstRect(forCharacterRange:)`, `attributedSubstring`, `validAttributesForMarkedText`). SwiftTerm's genuine weaknesses are **accessibility depth and selection completeness**, which its README admits have "lagged behind." IME is not among them. Noah's uncertainty 5 has the caveat pointed at the wrong subsystem.

So "bake off libghostty vs SwiftTerm vs Alacritty core" is not a choice among three implementations of one thing. It is a choice between adopting a full AppKit terminal view and adopting a VT engine and then building the renderer, the view, the input stack, the IME integration, and the accessibility tree yourself. And a `CALayer`/Metal-drawn custom view gets **zero** accessibility for free; every `NSAccessibility` role, value, and range API must be hand-written for VoiceOver to read a single cell.

Other core-only options exist and change nothing: `wezterm-term` and `termwiz` (MIT, Rust, "subject to fairly wild sweeping changes"), `libvterm` (C, callback-based, no toolkit).

### macOS: five load-bearing assumptions are wrong

**Bookmarks are inverted.** Apple's own release notes state a bookmark "is capable of locating resources that have been moved or renamed since the bookmark was created, similar to Alias Manager aliases." Bookmarks *silently follow moves*. Maya's contract — "moves propose explicit rebind; deleted/recreated same path never silently inherits" — gets the second half right for the wrong reason (it holds because tracking is inode-based, not because it is path-based) and the first half exactly backwards. Rebind-on-move is not a bookmark behavior you receive; it is a check you must implement by comparing the resolved path against the stored path after every resolve. Further: `NSURLFileResourceIdentifierKey` "isn't persistent across system restarts," so it can be evidence but never the durable key; and security-scoped bookmarks are a sandbox construct — `startAccessingSecurityScopedResource()` is a no-op outside a sandbox. A non-sandboxed Supervisor should use **plain bookmarks**. That is the direct answer to Maya's uncertainty 1.

**XPC identity.** `xpc_connection_get_audit_token` is private SPI. PID-based checks are TOCTOU-broken by Apple's own documentation, which warns that "another process could spawn and claim the PID before a message is actually received." The supported mechanism is `NSXPCConnection.setCodeSigningRequirement(_:)` (macOS 13+), `xpc_connection_set_peer_code_signing_requirement` (12+), or `xpc_connection_set_peer_lightweight_code_requirement` (14.4+). Critically for Noah's design: **an anonymous XPC endpoint is a bearer capability, not an identity.** "Signing-checked anonymous XPC endpoint" is only true if the listener explicitly applies a code requirement; a connection arriving on a tenant-scoped endpoint proves nothing about who is on the other end. The connection-bound tenant capability that "omits tenant IDs" is excellent *authorization* design — it prevents the confused deputy — and it is not *authentication*. Both are needed. Note also that Swift's native `XPCListener`/`IncomingSessionRequest` exposes no code-requirement check, so the C API is mandatory.

**App Sandbox cannot jail the agents.** Children inherit the single parent sandbox and cannot be given a tighter one; an inheriting child that declares anything beyond `app-sandbox` + `inherit` is aborted by the system. The only mechanism for a custom per-child profile, `sandbox_init(3)` / `sandbox-exec(1)`, is **deprecated with no supported replacement**. Noah already says App Sandbox cannot honestly contain arbitrary dev tools; the deprecation makes it stronger than a caveat. Tier T1 ("restricted native experiment") is not implementable on supported API and should be deleted rather than offered.

**The private per-tenant clipboard is not enforceable.** `NSPasteboard(name:)` separates storage, not access. Any same-user process can open any named pasteboard, and there is no macOS mechanism by which a parent GUI process prevents its own non-sandboxed child — a tmux-hosted CLI, `pbcopy`, an agent's Bash tool — from reaching `NSPasteboard.general`. Mediating OSC 52 inside the terminal surface is real and worth doing. Calling the result a tenant isolation boundary is a false security claim of exactly the kind Noah's own memo warns against.

**Two smaller corrections.** An app does **not** need Accessibility permission to move its own windows; `AXIsProcessTrustedWithOptions` gates driving *other* apps. This is a point in favor of the native app that Noah undersells — the entire osascript/AX/CGWindow identity mess of SPEC decisions 9 and 10 simply evaporates. And spawning child processes requires **no** Hardened Runtime entitlement, though agent toolchains that JIT will force `com.apple.security.cs.allow-jit`.

Finally, against strict mode: multiple instances of one bundle are possible via `createsNewApplicationInstance`, but they share **one** saved-state container (`~/Library/Saved Application State/<bundleID>.savedState`), one Dock tile, one `UserDefaults` suite, and one menu-bar owner at a time. Automatic window restoration therefore cannot distinguish per-project instances; it must be disabled and reimplemented. Maya's uncertainty 8 suspected this. It is real.

### Providers: corrections

Codex's app-server is strong — 122 JSON-RPC methods, `thread/*`, `turn/start|steer|interrupt`, approvals as server-initiated requests, `account/read` (which does yield `planType`), `account/rateLimits/read`. But its `initialize` carries `clientInfo` and capability flags and **no numeric protocol-version field**; versioning is by build-pinned generated schemas, and `--help` calls the whole surface experimental. Both memos treat Codex as the protocol-hygiene benchmark. On version negotiation, Claude Code's `capabilities[]` array is the better model.

`model/list` is a catalog, not entitlement. Both memos say so. Correct, and it holds.

Noah's Gemini claim needs two fixes: `geminicli.com` **is** an official Google property, so the citation stands; but the 2026-06-18 Antigravity transition retired the **free tier and Google AI Pro/Ultra**, not "Google One." Enterprise Code Assist is unaffected. Qwen's OAuth free tier did end 2026-04-15 and the `auth` subcommand was removed — verified. OpenCode's server is loopback-bound but **not authenticated by default**; auth is opt-in via `OPENCODE_SERVER_PASSWORD`. Copilot CLI's `-p` does consume credits, confirming the "never probe with a prompt" rule; its ACP server mode and `--resume` are real, while a bare CLI `--model` pin flag remains unverified. Aider's Python API is explicitly unsupported by its own docs.

ACP itself is real: authored by Zed, Apache-2.0, specifying `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/update`, `session/request_permission`, and optional `session/load`. But Claude Code and Codex reach it only through third-party **adapters**, and the two providers Noah puts in ACP ring 1 are the two in the worst shape: Gemini's consumer tiers are deprecated as of last month and Qwen's OAuth is dead. The ACP ring is thinner than the memo implies.

## Agree and disagree

**Agree.** A per-user Supervisor owning project identity and a content-blind quota arbiter is correct, because project identity and provider-account capacity are the only two facts that cannot live inside a project. One broker per HiveUUID preserving ordering, epochs, approvals, and landing is correct and matches the current daemon's semantics. Connection-bound capabilities that never accept a tenant id are correct and prevent the confused deputy. Provider adapters, not output scraping, as the source of semantic events is correct. `ProjectKey` = canonical physical worktree root, with `git-common-dir` demoted to repo-family metadata, is correct — and the split between those two keys is the sharpest thing in either memo. Bare repos blocked; nested child wins; separate clones distinct; user-created linked worktrees distinct despite a shared object store: all correct. The immutable `InstallationBinding` generation, PATH as discovery only, closed-stdin bounded probes that never read credential files or send a prompt: correct, and validated the hard way when `claude models` billed me. Tri-state Installed / Authenticated / Reachable / Entitled with Unknown as first-class: correct. Transactional migration with rollback: correct. Terminal.app and AppleScript as containment-only, with no window handle in the destination model: correct, and the AX finding above makes it cheaper than Noah thinks.

**Disagree, with evidence.**

*Claude Code is not a gated second-tier orchestrator.* It is conformant today on every criterion both memos list, and superior to Codex on capability negotiation and on reconnect-time approval replay. The "Codex strongest" conclusion is an artifact of reading Codex's docs and Claude's docs, rather than driving Claude's binary. Maya's uncertainty 1 asks whether that ranking is biased by adapter maturity. Yes. The residual risk is real but different from the stated one: the enabling flag is undocumented.

*tmux is not the survival substrate for a stream-json agent.* Both memos assert that Hive owns the composer and the vendor TUI is irrelevant, and simultaneously that tmux owns PTY survival with each `PaneUUID` mapped to a tmux target. Those cannot both be true. A headless `claude -p --input-format stream-json` process has no TUI and no PTY worth preserving. What must survive is the *pipe owner*, and the tempting answer — let the broker parent the agents — is wrong, because then a broker crash or a rolling upgrade takes every agent with it. The pipe owner must be something smaller and more boring than the broker, which is what AgentHost is for. Durability then comes from AgentHost holding the pipe, the broker's database holding the state, and the vendor's `--resume` / `thread/resume` holding the conversation. tmux remains genuinely necessary for exactly two things: hosting a real interactive TUI in the legacy compatibility driver, and giving the user a shell pane. This deletes an entire class of proposed gates ("tmux reattach must prove exact pane UUID→target mapping and no duplicate shell," "PTY resize storms absent") by deleting their subject — and it must not smuggle tmux back in under a new name, which is the standing risk of AgentHost and the reason it is specified to hold no state.

*The terminal surface is not the foundation.* Follow the previous point. If agents are stream-json processes and Hive renders their semantic events, an agent pane is a transcript view — structured messages, tool calls, diffs, approvals — not a VT100 grid. Hive should render it with `NSTextView`/`NSCollectionView` and get IME, VoiceOver, selection, find, and drag-and-drop from AppKit for free. That is a better product than a terminal: you can fold a tool call, click a file path, or diff a patch, none of which a grid of cells supports. A terminal emulator is then needed only for the user's shell pane and legacy TUI mode. Ship **SwiftTerm** there and stop. A versioned `TerminalSurface` ABI, a Zig toolchain, an unstable upstream, and a hand-written accessibility tree are a very large bet on the least differentiated part of the product.

*Strict process-per-tenant UI is not justified.* It costs the shared saved-state container, the shared Dock tile, menu-bar ownership churn, and a reimplemented restoration stack, and it buys a boundary that does not bind the actual threat. The tenant's agent already executes arbitrary code as the user, reads any file the user can, and — as shown above — can open any named pasteboard. Process separation defends the UI against its own renderer, not the user against the agent. One UI process with hard in-process tenant objects is the right default; genuine process and kernel boundaries belong in T2 (VM) and T3 (remote), where they mean something. Noah's own tier honesty argues this; strict mode contradicts it.

*"Content-blind" needs a definition, not an adjective.* A quota arbiter that leases capacity must see provider, account, pool, concrete model, and estimated units, and must therefore learn how many projects exist and which models they run. It never sees prompts, paths, repo names, or branch names. Say that. Maya's uncertainty 9 is right to ask; the answer is an explicit allowlist of fields crossing the boundary, not a promise.

*Thirty-five release-blocking gates is not a gate, it is a wish.* A blocking gate must be falsifiable, cheap to run, and tied to a failure that has actually occurred or would be catastrophic. Several of the proposed 35 are unachievable (the private clipboard), unmeasurable as stated, or belong to subsystems this review recommends deleting. The corrected set below has twelve.

**Answering the memos' direct questions.** Maya's Q2 — do linked worktrees sharing refs need a dedicated Git service? No. A Supervisor landing lease keyed on the realpath of `git rev-parse --git-common-dir` is sufficient, because `git merge --ff-only` is already a compare-and-swap on the ref; the lease only serializes the rebase→retest→merge window so two Hives cannot interleave it. Maya's Q3 — should "Use Parent" for nested repos be ephemeral or disallowed? Disallowed once the child is registered, and ephemeral otherwise: an identity override that outlives its session is an aliasing footgun whose failure mode is silent cross-project routing. Maya's Q5 — can legacy tmux sessions be atomically moved to per-tenant sockets? They cannot, and under the recommendation above they mostly need not be; record a compatibility locator, drain, and let the last legacy session die with its agent. Noah's item 3 — the one-window-per-display spike is still needed, and Stage Manager has no developer guidance, so the layout must degrade gracefully rather than assume placement holds.

## The corrected technology decision

The renderer question dissolves into two questions with different answers.

| Surface | Choice | Why | Cost accepted |
|---|---|---|---|
| Agent pane (transcript of semantic events) | AppKit `NSTextView`/`NSCollectionView` | IME, VoiceOver, selection, find, drag-drop for free; enables folding, clickable paths, inline diffs | Not a terminal; a genuine TUI cannot render here |
| User shell pane, legacy TUI driver | SwiftTerm (MIT) | Only full-stack candidate; `NSTextInputClient` complete | Accessibility and selection depth must be improved upstream or forked |
| Rejected: libghostty full surface | — | Surface/Metal API internal, explicitly unstable, untagged; Zig toolchain in the notarization path | Revisit if a tagged, versioned surface library ships |
| Rejected: `alacritty_terminal` / `libghostty-vt` / `wezterm-term` | — | Core only: no renderer, view, IME, or accessibility. Choosing one means building all four | Would be correct only if we needed a custom grid renderer, which we do not |

The `TerminalSurface` protocol survives, shrunken: it is an internal seam around SwiftTerm so the shell pane can be swapped later. It is not a versioned ABI, because nothing outside the app implements it.

For the provider tiers, the correction is that ring 1 has two members, not one, and that conformance is proven by fixtures rather than assumed from documentation.

| Provider | Orchestrator | Worker | Evidence | Correction to memos |
|---|---|---|---|---|
| Claude Code 2.1.206 | **Yes, ring 1** | Yes | Driven end-to-end here: `can_use_tool` round-trip, `capabilities[]`, `initialize.models[]`, live alias resolution, `pending_permission_requests` | Both memos gate it. Ungate it. Flag `--permission-prompt-tool` is undocumented |
| Codex 0.144.0 | **Yes, ring 1** | Yes | 122 app-server methods; approvals; `account/read`; `rateLimits` | Keep, but stop treating it as the protocol benchmark: no protocol-version field, wholly experimental |
| OpenCode | Ring 2 | Yes | HTTP server, session fork | Loopback ≠ authenticated; auth is opt-in |
| goose | Ring 2 | Yes | Apache-2.0, native ACP | Unchanged |
| Copilot CLI | Ring 3 | Yes | ACP server, `--resume` | `-p` spends credits; `--model` flag unverified |
| Gemini CLI | Ring 3 | Degraded | ACP real | Consumer tiers retired 2026-06-18 to Antigravity — not "Google One" |
| Qwen | Ring 3 | Degraded | ACP | OAuth dead 2026-04-15 |
| Aider | — | Worker only | Unsupported Python API | Unchanged |

Entitlement remains Unknown everywhere except Claude Code, where `initialize` returns an account-scoped model set — the one place a non-billable, authenticated entitlement observation exists. Report it as `reported`, not `authoritative`, because Anthropic documents no stability for it.

## Recommended end-state architecture

A per-user **Supervisor**, launched as a `SMAppService` agent, owns three things and nothing else: the `ProjectKey ↔ HiveUUID` registry with creation leases, the provider `InstallationBinding` registry, and the repo-family landing lease. It never runs project commands and never sees prompts, paths, or branch names beyond what the registry requires.

A per-user **Quota Arbiter**, colocated with the Supervisor, leases capacity per `(provider, account, pool)`. Its interface accepts exactly `{provider, account, pool, concreteModel, estimatedUnits, hiveUUID}` and returns a reservation. That field list is the definition of content-blind.

One **Tenant Broker** per HiveUUID owns the canonical state, the event log, the worktree ledger, the capability epochs, approvals, and landing. It persists to its own SQLite under its own runtime directory.

The broker does **not** own the agent's stdio pipes, and this is a correction to the obvious design. If the broker were the pipe owner, an agent would survive a UI crash but not a broker crash or a rolling upgrade: the child dies or takes `SIGPIPE`, and a restarted broker cannot reattach an anonymous pipe. That fails the recovery gate this review itself sets. So each agent gets a tiny per-session **AgentHost** that owns the stdio pair and exposes a reconnectable, authenticated unix endpoint which successive broker generations attach to. AgentHost is deliberately small enough to be uninteresting — it holds no policy, no database, no approval state; it forwards frames and buffers a bounded backlog. The alternative, letting a broker crash explicitly reap its provider children and then reconstruct from vendor resume state, is simpler and was rejected as the default because an in-flight accepted turn cannot be reconstructed from the vendor's session store: the turn either happened or did not, and the broker cannot tell which. Vendor resume recovers the conversation, not the outcome of the turn that was in flight. AgentHost keeps the pipe alive across the gap so the question never has to be asked.

Where the question must be asked anyway — AgentHost itself died, or a provider without reconnectable approvals — the state is `UNKNOWN_OUTCOME`, an explicit, first-class, surfaced state. Never a replay. Claude's `pending_permission_requests` resolves the *approval* leg of this, not the general turn-response-loss leg, and no vendor offers turn-level idempotency keys. An honest unknown beats a duplicate side effect.

One **Workspace UI** process, multiplexing tenants as hard in-process objects, with an explicit label that the isolation is logical. It talks to brokers over XPC listeners that apply `setCodeSigningRequirement` — authentication — and hold connection-bound tenant capabilities that never accept a tenant id — authorization. Both, not either.

**Agents are stream-json processes**, not TUIs. Claude Code runs `--input-format stream-json --output-format stream-json --permission-prompt-tool <broker>`; Codex runs app-server. Approvals arrive as correlated control requests and are answered by broker policy or escalated to the user's one approval queue. The orchestrator's read-only invariant from SPEC decision 11 becomes mechanical in a new way: `--permission-mode dontAsk` plus a broker that denies every write tool, verified by the same `can_use_tool` channel.

**tmux survives in two narrow roles**: the legacy interactive driver, and the user's shell pane. It is not the survival substrate and not the identity.

The **RunnerProtocol** negotiates by capability tokens, copying Claude Code's `capabilities[]` shape, plus a build hash and a migration epoch. A peer whose build hash is unknown and whose capability set is not a superset of the required tokens is rejected visibly. This is the direct fix for the `ok === true` defect: never accept a peer because it answered.

The **daemon endpoints get authentication immediately**, ahead of any flagship work, and identity alone is not enough. A token bound to `(HiveUUID, agentName, capabilityEpoch)` says who is calling; it does not say what they may do, and today every caller may do everything. The credential must therefore be a **capability with an explicit subject-action allowlist**. An ordinary writer may read its own inbox, send messages, and land *its own branch at its current epoch* — a one-shot, short-lived right, consumed on use. It may not spawn, may not approve, may not kill another agent, may not read the global inbox. The orchestrator holds spawn and approve and holds no land right at all, which is decision 11's read-only invariant expressed as a capability rather than a prompt. Every mutating endpoint is authenticated, not just `/mcp` — `/event`, the channel routes, the viewer routes, and `recover` are all mutations today. `/health` may stay unauthenticated if it stops being an authorization decision.

A per-tenant unix socket is necessary and insufficient: it stops accidents and cross-project confusion, and it does nothing against a same-UID agent, which is exactly the adversary. The credential must therefore never be a long-lived master secret sitting in an environment variable that every descendant of the agent inherits. The broker vends a per-agent stdio MCP proxy over an inherited, `CLOEXEC`-marked descriptor, so an arbitrary grandchild of an agent — a build script, a test, a compromised dependency — receives no reusable token. This is a bug fix, not a feature.

## De-risking prototypes

Five, each falsifiable in under a week, ordered by how much they would change the plan if they failed.

1. **Headless agent survives its pipe owner.** Spawn Claude Code and Codex headless behind an AgentHost, drive a full task with approvals, then kill the UI *and separately kill the pipe owner* — the interesting failure is the second one, not the first. Prove the agent continues, that a new broker generation reattaches, that `pending_permission_requests` replays without duplicate approval, and that a turn interrupted mid-flight surfaces as `UNKNOWN_OUTCOME` rather than replaying. If AgentHost cannot meet the recovery target, tmux returns as the survival substrate and the terminal surface returns with it.
2. **Transcript pane instead of a terminal.** Render one real agent session as structured AppKit views, and try hard to break it: streaming partial messages, enormous tool output, raw ANSI inside tool results, an agent that spawns an interactive subprocess expecting a TTY, provider events with missing fields, composer focus during a burst. Measure VoiceOver navigation, IME into the composer, find, and selection. If a transcript view cannot beat a terminal on comprehension, the renderer bet comes back.
3. **XPC authentication adversarial test.** A signed broker, a signed UI, and a hostile unsigned client. Prove `setCodeSigningRequirement` rejects it, prove an anonymous endpoint alone does not, and prove capability FDs are `CLOEXEC` and not inherited by agent descendants.
4. **Identity under motion.** Register a project, move it, rename it, delete and recreate the path, symlink it, add a submodule, put it on a case-insensitive volume and an SMB mount. Prove the bookmark's silent move-following is caught by the path-disagreement check, and that a recreated path never inherits.
5. **Provider conformance fixture.** One harness, run against every `InstallationBinding` generation: lifecycle, approve, deny, needs-user, steer, cancel-with-receipt, resume, invalid-model fail-closed, read-only denial. Codex and Claude Code must both pass identically. This is the artifact that turns "ring 1" from an opinion into a test result.

## Roadmap

**Phase 0, now, independent of the flagship.** Authenticate the daemon MCP endpoint and scope it per tenant. Make `isRunning()` verify build hash and project identity, not `ok`. These are live defects; the second explains a recurring bug and the first is exploitable.

**Phase 1.** Prototypes 1 and 5. Replace Claude's tmux-and-Channels delivery with the stream-json control channel behind a flag, keeping tmux as the fallback SPEC already maintains. Replace `CLAUDE_BEST_MODEL` with a live `initialize` probe. Ungate Claude Code as a ring-1 orchestrator on fixture evidence.

**Phase 2.** Supervisor, registry, `hive init`, quota arbiter, tenant brokers. Prototypes 3 and 4 gate this. Migration with rollback. No UI yet — the CLI keeps working.

**Phase 3.** Workspace UI: one process, tiled split tree, transcript panes, deterministic promotion and focus, semantic attention borders driven by broker events, `CoreAnimation` layout generations, multi-display consolidation. Prototype 2 gates the pane model. SwiftTerm arrives only for the shell pane.

**Phase 4.** T2 isolation (per-Hive VM) for users who want a real boundary, and T3 remote runners. T1 is deleted.

## Go/no-go acceptance criteria

Twelve, each falsifiable, each tied to a failure that has happened or would be unrecoverable.

1. Nested paths and symlink aliases resolve to one HiveUUID; user-created linked worktrees resolve to distinct HiveUUIDs; separate clones distinct; bare repo refused.
2. A moved project is detected by path disagreement and prompts rebind; a deleted-and-recreated path never inherits the old HiveUUID.
3. Twenty simultaneous `hive init` calls on one project produce exactly one HiveUUID, one broker, one orchestrator.
4. Two projects with identically named agents never cross-route a message; stopping A cannot signal B.
5. A peer whose build hash differs but whose marketing version matches is rejected. (This is our own bug, written as a gate.)
6. No unauthenticated local process can reach any mutating endpoint. An agent's capability authorizes an explicit subject-action set: a writer can land only its own branch at its current epoch, once, and cannot spawn, approve, kill another agent, or read the global inbox. A revoked epoch is refused. An agent's grandchild inherits no reusable credential.
7. A hostile unsigned client cannot connect to a broker XPC listener, and an endpoint alone does not authenticate it. Capability FDs are `CLOEXEC` and not inherited by agent descendants.
8. Every ring-1 binding generation passes the identical conformance fixture: lifecycle, approve, deny, needs-user, steer, cancel-with-receipt, resume, read-only denial. The fixture records, per claim, whether the behavior is documented, undocumented-but-observed, and billable or not.
9. An invalid model pin fails closed before any task is accepted, with no fallback and no substitution, and `--fallback-model` is never passed. Each adapter declares its own validation cost; zero-cost is asserted only where the adapter proves it.
10. Killing the UI leaves every agent running. Killing the *pipe owner* leaves every agent running, and a new broker generation reattaches with monotonic event replay, no duplicate session, and no duplicate turn. A turn in flight at the moment of the kill surfaces as `UNKNOWN_OUTCOME` and is never replayed.
11. Entitlement is displayed as Installed / Authenticated / Reachable / Catalogued / Entitled with evidence age, and Unknown is never rendered as yes. No probe sends a prompt or spends credits.
12. Interrupted migration rolls back to a working prior state.

Targets, not gates, because failing them delays rather than endangers: warm attach p95 under 400 ms; cold broker and UI under 2 s excluding provider startup; crash restore under 2 s; a 50-pane eight-hour soak with no identity loss and bounded logs; Reduce Motion honored; VoiceOver navigation of a transcript pane at parity with a native text view.

## Open questions

**Is `--permission-prompt-tool` load-bearing and undocumented?** It is absent from `--help` in 2.1.206 but parses and works. Hive's Claude orchestration would depend on it. This is the same risk class as Channels, and it deserves the same treatment: version-gated, fixture-tested, with the tmux fallback maintained rather than deleted. It should also be raised with Anthropic, because the Agent SDK documents the behavior while the CLI hides the flag.

**Does `initialize.models[]` reflect entitlement or catalog?** It is account-authenticated and returned only what this Max account can select, which is stronger evidence than any competitor offers. But Anthropic documents no such contract, so a model listed there may still fail at first turn. Treat it as `reported` provenance and let the first turn be the arbiter.

**Can a transcript pane replace a terminal for a user who wants to watch?** This is the load-bearing product bet of the recommendation, and it is unproven. Prototype 2 exists to answer it. If the answer is no, the renderer investment returns, and this review's central simplification collapses with it.

**What replaces tmux's incidental gifts?** tmux gave `--headless` mode, SSH access, and a free reattach story. A broker that owns pipes gives durability but not remote viewing. Remote access likely becomes T3's problem, but it is currently unowned.

**Does the Quota Arbiter's field list leak across tenants?** Provider, account, pool, and model are not content. But an observer of the arbiter learns how many Hives exist and which models they use. Whether that matters depends on a threat model nobody has written, and the memos' "sanitized" adjective is doing the work that document should do.

## Appendix: reproducing the Claude Code observations

Because the enabling flag is undocumented, every claim above about Claude Code is recorded here as a runnable procedure against `claude` 2.1.206 on macOS. Each is marked billable or not. Redact `account.email` and `account.organization` before sharing any capture.

**Non-billable.** Alias resolution and the capability array. Start a streaming session, read `system/init`, kill before the model call:

```
echo '{"type":"user","message":{"role":"user","content":"x"}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose --model best
```

`system/init` carries `model` (the resolved concrete id) and `capabilities: ["interrupt_receipt_v1","msg_lifecycle_v1"]`. Observed: `best → claude-fable-5`, `default → claude-opus-4-8[1m]`, `opus → claude-opus-4-8`, `sonnet → claude-sonnet-5`, `haiku → claude-haiku-4-5-20251001`, `opusplan → claude-sonnet-5`.

**Non-billable.** Account and model enumeration. Send one frame and read the reply:

```
{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}
```

The `control_response` contains `account` and `models[]`, each entry with `value`, `resolvedModel`, `supportsEffort`, `supportedEffortLevels`, `supportsFastMode`, `supportsAutoMode`. No model call occurs.

**Non-billable, and it fails.** `--model totally-bogus-model-xyz` is accepted by `initialize` and echoed verbatim as `system/init.model`. The first turn returns `result` with `is_error: true`, `total_cost_usd: 0`, and "There's an issue with the selected model."

**Billable — a few cents on `haiku`.** The approval round-trip. Run with `--permission-prompt-tool <any-sentinel>`, `--input-format stream-json`, `--permission-mode default`, `--settings '{}'`, in a directory with no permissive settings, and ask for a gated tool such as `Write`. Note that `Bash(echo)` and `Bash(whoami)` are in the read-only auto-approved set and will *not* prompt; a file write will. The CLI emits `control_request{subtype:"can_use_tool", tool_name, display_name, input, description, permission_suggestions, tool_use_id}`; answer on stdin with `control_response{subtype:"success", request_id:<echoed>, response:{behavior:"deny", message:"…"}}`. Without the flag the same write is auto-denied and the broker never sees it.

**Inbound control subtypes**, read from the shipped binary: `initialize`, `interrupt`, `can_use_tool`, `control_cancel_request`, `set_model`, `set_permission_mode`, `hook_callback`, `mcp_message`, `apply_flag_settings`.

**Billable, and a warning.** `claude models` is not a subcommand. Claude Code treats an unrecognized subcommand as a prompt and runs a full session. Never probe a provider by guessing argv.

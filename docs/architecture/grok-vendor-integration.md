# Grok as a first-class Hive vendor

This document maps Hive's side of adding `grok` beside `claude` and `codex`. It is an implementation map, not a design for the Grok CLI. Every statement about current behavior below was checked against the cited source. Grok-side facts were not probed; where Hive's design depends on one, the dependency is called out as an open question.

## 1. Widening the vendor union is not sufficient

Adding `"grok"` to the canonical enum would make many records parse, but it would not make Grok a first-class vendor. Hive has several two-way conditionals in which “not Claude” means Codex, or “not Codex” means Claude. A third value can therefore compile and launch while being given another vendor's configuration, recovery command, telemetry parser, or billing transport. These are the highest-risk sites because they fail as a plausible null or wrong answer instead of rejecting an unsupported vendor.

The measured silent fallthroughs are:

1. Model settings: `readToolModel` reads Claude settings for Claude and Codex config for every other tool (`src/adapters/tools/models.ts:81`). Grok would be parsed as Codex configuration.
2. Capability discovery: daemon construction chooses `ClaudeCapabilityProbe` for Claude and `CodexCapabilityProbe` for every other provider (`src/cli/daemon.ts:122`). Grok would be probed as Codex.
3. Recovery session lookup: recovery uses the Claude session resolver for Claude and the Codex rollout resolver otherwise (`src/daemon/recovery.ts:297`).
4. Recovery configuration: recovery writes Claude agent config for Claude and Codex agent config otherwise (`src/daemon/recovery.ts:339`).
5. Recovery resume: recovery builds Claude resume arguments for Claude and Codex resume arguments otherwise (`src/daemon/recovery.ts:370`).
6. Recovery effort: the non-Claude recovery path preserves effort only for Codex and substitutes `medium` otherwise (`src/daemon/recovery.ts:385`). Grok would receive a guessed Codex effort.
7. Normal spawn setup: the Claude branch is explicit and every other tool enters Codex setup and command construction (`src/daemon/spawner-impl.ts:1880`).
8. Execution identity: spawn records a Claude identity for Claude and a Codex-shaped identity, including `effort ?? "medium"`, for every other tool (`src/daemon/spawner-impl.ts:1749`, `src/daemon/spawner-impl.ts:1758`).
9. Effort resolution: only Claude exits without an effort; every other tool is assigned Codex defaults and fallbacks (`src/daemon/spawner-impl.ts:943`).
10. Control/restart setup: the Claude branch is explicit and every other tool receives Codex config and arguments (`src/daemon/spawner-impl.ts:1067`). The nested native-Codex check and `medium` defaults make Grok look like a non-native Codex session rather than rejecting it (`src/daemon/spawner-impl.ts:1124`, `src/daemon/spawner-impl.ts:1154`, `src/daemon/spawner-impl.ts:1168`).
11. Context telemetry: the server reads Claude telemetry for Claude and Codex telemetry for every other agent (`src/daemon/server.ts:1043`, `src/daemon/server.ts:1047`).
12. Graphify telemetry dispatch: the server maps Claude to `claude` and every other agent to `codex` (`src/daemon/server.ts:1057`).
13. Context percentage selection: the server uses Claude's computed percentage for Claude and the Codex field for every other agent (`src/daemon/server.ts:1077`).
14. Graphify event parsing: the line counter recognizes Claude events for Claude and Codex events for every other tool (`src/daemon/tool-telemetry.ts:243`).
15. Graphify artifact lookup: the reader locates a Claude transcript for Claude and a Codex rollout for every other tool (`src/daemon/tool-telemetry.ts:290`).
16. Usage-credit transport: the reader uses Codex billing only for Codex and Claude billing for every other provider (`src/daemon/usage-credits.ts:546`). Grok would silently query Claude billing.
17. Model inventory: provider discovery chooses the Claude capability probe for Claude and Codex capability probe otherwise (`src/daemon/model-inventory.ts:132`).
18. Review-tool selection: quota review deliberately chooses the other existing vendor—Claude maps to Codex and everything else maps to Claude (`src/daemon/quota.ts:1408`). With three vendors, “the other vendor” is no longer defined.
19. Routing fallback: a missing resolved tool defaults to Claude (`src/daemon/routing-resolve.ts:146`). The current resolver intends the value to be present, but if a new derivation path omits it, the error is hidden.
20. Workspace launch parsing accepts only the two known strings and otherwise leaves the launch request unchanged (`workspace/Sources/HiveWorkspace/LaunchConfig.swift:55`). A Grok request can therefore be ignored rather than rejected.

There are also closed two-vendor lists that do not misclassify Grok but make it disappear: live benchmarking (`src/daemon/livebench.ts:365`), model inventory and refresh (`src/daemon/model-inventory.ts:278`, `src/daemon/model-inventory.ts:327`, `src/daemon/model-inventory.ts:334`, `src/daemon/model-inventory.ts:388`), quota refresh (`src/daemon/quota.ts:1300`), routing display and refresh (`src/cli/routing.ts:142`, `src/cli/routing.ts:257`), and skill uninstall (`src/cli/uninstall.ts:190`). Public CLI validation rejects unknown providers loudly rather than falling through (`src/cli.ts:360`, `src/cli.ts:620`).

The implementation rule is therefore: first replace every binary vendor decision with an exhaustive three-way dispatch that throws on an unimplemented case. Only then widen the enum. This converts silent half-support into visible missing work.

## 2. Type, schema, and persistence surfaces

The canonical capability provider is the Zod enum `claude | codex` (`src/schemas/capability.ts:30`). Capability surfaces are a separate enum and carry vendor-specific discovery names (`src/schemas/capability.ts:40`, `src/schemas/capability.ts:65`). Adding Grok requires both a provider value and any Grok-specific surface identifiers Hive will actually discover; inventing surface names before discovery would turn absence into a false negative.

The provider type flows into the agent record through a discriminated `ExecutionIdentity` union (`src/schemas/agent.ts:29`, `src/schemas/agent.ts:42`) and the `AgentRecord.tool` field (`src/schemas/agent.ts:66`). Grok needs its own identity member, not a Codex-shaped reuse, because resume identity and model metadata are vendor artifacts.

Routing has separate Claude and Codex route schemas (`src/schemas/routing.ts:37`, `src/schemas/routing.ts:55`). Spawn input repeats the two tool literals (`src/daemon/spawner.ts:8`, `src/daemon/spawner.ts:18`). Routing derivation persists tool-valued pins, floors, snapshots, and fixed cells (`src/schemas/routing-derivation.ts:120`, `src/schemas/routing-derivation.ts:159`, `src/schemas/routing-derivation.ts:190`, `src/schemas/routing-derivation.ts:269`), constructs provider-specific cells (`src/schemas/routing-derivation.ts:352`), and writes snapshots containing them (`src/schemas/routing-derivation.ts:1005`). All of these must admit and preserve Grok without coercion.

Quota schemas independently enumerate the provider in pool snapshots, probe results, and related records (`src/schemas/quota.ts:34`, `src/schemas/quota.ts:152`, `src/schemas/quota.ts:214`, `src/schemas/quota.ts:267`). The quota ledger stores provider values in `TEXT` columns, so no SQL enum migration is required merely to store `grok` (`src/daemon/quota-ledger.ts:230`, `src/daemon/quota-ledger.ts:334`). Its read/write boundary does validate the two-value Zod schemas, however, so widening those schemas is required before persisted Grok rows are usable (`src/daemon/quota-ledger.ts:12`, `src/daemon/quota-ledger.ts:54`, `src/daemon/quota-ledger.ts:80`, `src/daemon/quota-ledger.ts:105`).

The agents table likewise stores `tool` as open `TEXT` (`src/daemon/db.ts:207`, `src/daemon/db.ts:216`), but reconstructed rows are parsed as `AgentRecord` (`src/daemon/db.ts:695`). The schema, not SQLite, is the effective enum. Other duplicate type aliases include `SkillTool` (`src/adapters/skills.ts:15`) and the private orchestrator tool argument (`src/cli/orchestrator.ts:23`).

## 3. The vendor adapter contract

Hive does not currently express a single typed vendor-adapter interface. The contract is implicit in the parallel Claude and Codex modules and in the spawner/recovery call sites. A first-class Grok adapter must satisfy all of the following obligations.

1. **Spawn command.** Accept the resolved model, prompt file, autonomy mode, environment, MCP configuration, and vendor options, then return executable argv. Claude's option shape and builder are at `src/adapters/tools/claude.ts:22` and `src/adapters/tools/claude.ts:245`; Codex's are at `src/adapters/tools/codex.ts:17` and `src/adapters/tools/codex.ts:209`.
2. **Resume command and durable session identity.** Build argv that resumes the exact prior session and provide a resolver for the vendor's on-disk session artifact. Claude does this at `src/adapters/tools/claude.ts:296` and `src/adapters/tools/claude.ts:311`; Codex does it at `src/adapters/tools/codex.ts:213` and `src/adapters/tools/codex.ts:228`.
3. **Settings/config writing.** Write only the agent-local configuration needed for lifecycle hooks, notification, MCP, and credential propagation. Claude's writer begins at `src/adapters/tools/claude.ts:434`; Codex's begins at `src/adapters/tools/codex.ts:329`.
4. **Trust and permissions.** Establish noninteractive workspace trust and translate Hive's reader/writer/autonomy policy into vendor-native permission flags or settings. Claude's trust and permission handling is at `src/adapters/tools/claude.ts:364` and `src/adapters/tools/claude.ts:458`; Codex's trust and configuration arguments are at `src/adapters/tools/codex.ts:94` and `src/adapters/tools/codex.ts:102`.
5. **Lifecycle hooks.** Register the hooks Hive uses for liveness, delivery acknowledgement, Graphify interception, and completion. Claude composes hook matchers at `src/adapters/tools/claude.ts:502`; Codex composes its equivalents in config arguments at `src/adapters/tools/codex.ts:102`.
6. **MCP attachment.** Attach Hive's MCP endpoints, including Graphify, in the vendor's native configuration format. Claude writes MCP and credential helper configuration at `src/adapters/tools/claude.ts:563`; Codex emits MCP configuration at `src/adapters/tools/codex.ts:171`.
7. **Credentials and environment.** Make the per-agent capability credential available without leaking it through shared configuration. Codex defines its token path and environment wrapper at `src/adapters/tools/codex.ts:47` and `src/adapters/tools/codex.ts:77`; Claude uses credential/header configuration in its MCP setup (`src/adapters/tools/claude.ts:563`). Grok needs an equally isolated mechanism.
8. **Delivery.** Supply either a verified native input transport or a channel integration, plus a tmux fallback and a vendor-correct critical restart path. The concrete requirements are in §5.
9. **Transcript and telemetry.** Locate and parse the vendor's durable session artifact for activity, context use, live model, and Graphify calls. The concrete requirements are in §6.
10. **Capability and landing continuity.** Preserve the issued capability token across initial spawn and resume so a writer can use the shared landing gate. The rights model is vendor-neutral, but token injection is adapter-specific; see §8.

The contract should be made explicit in code before or while Grok is added. Otherwise the compiler cannot identify an omitted operation, and the binary fallthroughs in §1 remain attractive shortcuts.

## 4. Spawn, tmux launch, prompt injection, and landing text

The shared spawn pipeline resolves the route and identity, creates the worktree, issues credentials, provisions skills, writes a prompt file, constructs vendor argv, launches tmux, waits for readiness, and records the agent (`src/daemon/spawner-impl.ts:1766`, `src/daemon/spawner-impl.ts:2008`, `src/daemon/spawner-impl.ts:2077`). Grok belongs in that pipeline as a third adapter, not as a separate launch path.

Prompt-file creation is shared and deliberately avoids putting the brief directly on the command line (`src/daemon/launch-prompt.ts:25`, `src/daemon/launch-prompt.ts:46`). The prompt assembly includes the task brief, graph-scoped brief, capability/landing instructions, and operational protocol (`src/daemon/spawner-impl.ts:431`, `src/daemon/spawner-impl.ts:659`). Grok's command builder must consume that file without truncating or reinterpreting it. Whether the Grok CLI supports a prompt-file argument, stdin, or another safe mechanism is an open discovery question.

The landing gate is text plus a real capability check: the prompt tells authorized writers how to land, while the daemon enforces the credential and branch-scoped right (`src/daemon/spawner-impl.ts:497`, `src/daemon/capabilities.ts:87`). Grok does not need a new landing implementation if its MCP connection carries the issued token and its prompt receives the same landing instructions. It does need vendor-correct token injection and resume continuity.

Control/restart is also a launch path, not merely recovery. It reconstructs configuration and argv inside `restartAgent` (`src/daemon/spawner-impl.ts:1067`, `src/daemon/spawner-impl.ts:1168`). A Grok adapter is incomplete until initial spawn, control restart, crash recovery, and manual resume all use the same Grok identity and configuration semantics.

## 5. Delivery, urgent preemption, and critical restart

Durable delivery state and acknowledgement are shared. The delivery service records messages, chooses a transport, and for critical messages can revoke the current turn and restart the agent (`src/daemon/delivery.ts:236`, `src/daemon/delivery.ts:341`). It verifies effect by observing a new turn rather than treating a successful write as receipt (`src/daemon/delivery.ts:629`, `src/daemon/delivery.ts:718`). Grok should reuse this state machine.

The transports are vendor-specific:

1. Codex has a native app-server input RPC implementing the delivery interface (`src/adapters/tools/codex-app-server.ts:481`, `src/adapters/tools/codex-app-server.ts:542`). Codex root delivery also has a specialized path (`src/daemon/codex-root-delivery.ts:34`, `src/daemon/codex-root-delivery.ts:88`).
2. Claude can register a channel bridge and receive delivery through that channel (`src/cli/channel-bridge.ts:140`, `src/cli/channel-bridge.ts:285`). The registry treats transport write as only one stage of delivery (`src/daemon/channels.ts:92`, `src/daemon/channels.ts:270`). Spawned agent channels are currently constrained by interactive-dialog behavior (`src/daemon/spawner-impl.ts:956`, `src/daemon/spawner-impl.ts:979`).
3. Tmux injection is the shared last-mile fallback. Interrupt sends Escape/control input before pasting a message (`src/adapters/tmux.ts:151`, `src/adapters/tmux.ts:188`), and normal send uses the same tmux adapter (`src/adapters/tmux.ts:190`). Terminal keystrokes and redraw behavior are vendor-sensitive even though the wrapper is shared.

A Grok implementation must choose and verify a primary transport, define how ordinary messages enter an active turn, define how urgent messages cancel that turn, and define how a critical delivery restarts/resumes the correct session. If Grok has no native RPC or channel API, tmux can be a fallback, but discovery must establish the correct cancel sequence, paste behavior, readiness signal, and durable evidence that a new turn began. A zero exit status from tmux is not that evidence.

Root delivery currently falls back through Codex-specific and generic paths (`src/daemon/delivery.ts:562`, `src/daemon/delivery.ts:598`). That dispatch must become explicit for Grok rather than inheriting Codex root behavior.

## 6. Telemetry, context, live model, and Graphify

`ToolTelemetry` is the common output contract: activity time, context percentage, live model, session identity, Graphify call count, and a cursor (`src/daemon/tool-telemetry.ts:16`, `src/daemon/tool-telemetry.ts:32`). The readers are not common. Claude parses its transcript token fields and derives a percentage (`src/daemon/tool-telemetry.ts:99`, `src/daemon/tool-telemetry.ts:175`); Codex reads percentage data from rollout events (`src/daemon/tool-telemetry.ts:178`, `src/daemon/tool-telemetry.ts:210`). Live-model parsing is separately Claude-shaped (`src/daemon/live-model.ts:24`, `src/daemon/live-model.ts:134`). Server injection is currently fixed to the two readers (`src/daemon/server.ts:417`, `src/daemon/server.ts:428`) and its runtime dispatch has the silent fallthroughs listed in §1 (`src/daemon/server.ts:1032`, `src/daemon/server.ts:1120`).

Grok therefore needs a reader for Grok's own durable artifact format. Discovery must establish: where artifacts live; how a Hive session maps to an artifact; how activity is timestamped; whether context use is a percentage or token counts; how compaction is represented; where the active model is recorded; and what stable cursor prevents recounting. None of those Grok facts was verified for this document.

Graphify installation is also two-layered. The shared hook writes vendor-specific hook paths under `.claude` or `.codex` (`src/adapters/tools/graphify-hook.ts:6`, `src/adapters/tools/graphify-hook.ts:10`) and emits one JSON output shape intended for both current harnesses (`src/adapters/tools/graphify-hook.ts:24`, `src/adapters/tools/graphify-hook.ts:47`). Claude registers it through `PreToolUse` matchers (`src/adapters/tools/claude.ts:522`, `src/adapters/tools/claude.ts:545`); Codex registers it through its config (`src/adapters/tools/codex.ts:171`, `src/adapters/tools/codex.ts:179`). Graphify call telemetry then parses Claude and Codex event shapes separately (`src/daemon/tool-telemetry.ts:212`, `src/daemon/tool-telemetry.ts:337`).

Grok discovery must answer whether it supports an equivalent pre-tool hook, its matcher vocabulary, its required hook response schema, and how hook invocations appear in its artifact. Reusing the current script output without verifying that schema is a silent half-work risk: the hook can be installed and never affect execution.

## 7. Quota, billing, routing, model catalogs, and reservations

Quota measurement begins with a vendor probe returning pools and model catalog entries (`src/daemon/quota-sources.ts:47`, `src/daemon/quota-sources.ts:111`). A pool becomes routable only when Hive can bind it to the models it meters (`src/daemon/quota.ts:471`, `src/daemon/quota.ts:520`). Unbound pools are quarantined instead of guessed (`src/daemon/quota.ts:1419`, `src/daemon/quota.ts:1447`). Grok therefore needs a measured capability/model catalog and an evidence-based pool-to-model binding rule; neither can be inferred from model-name substrings alone.

Capacity unreadability and billing uncertainty have different behavior. If a bound pool's quota cannot be read, Hive enters compatibility mode, creates unbounded estimated reservations, and emits a warning rather than blocking the route (`src/daemon/quota.ts:1526`, `src/daemon/quota.ts:1560`; warning path at `src/daemon/quota.ts:2014`, `src/daemon/quota.ts:2048`). This preserves old behavior but cannot enforce headroom or prevent overcommit.

Unknown billing is stricter. Automatic derivation blocks a route whose cost state is unknown until cost consent is recorded (`src/schemas/routing-derivation.ts:751`, `src/schemas/routing-derivation.ts:781`); consent is persisted and queried separately (`src/daemon/cost-consent.ts:24`, `src/daemon/cost-consent.ts:71`). Consequently, unreadable capacity alone does **not** stop routing, but a vendor whose noninteractive surfaces cannot establish billing/credit state will not auto-route without explicit cost consent. Compatibility reservations do not rescue that case. Shipping Grok in that state would defeat the purpose of a normally auto-routable first-class vendor.

The current billing-memory reader and dispatch are two-vendor code (`src/daemon/usage-credits.ts:480`, `src/daemon/usage-credits.ts:555`), including the Grok-to-Claude fallthrough in §1. Grok discovery must establish whether quota and billing can be read noninteractively, the freshness and meaning of each window, and a positive control proving that any chosen field is observable. An all-empty response is not evidence of no usage.

Routing resolution explicitly considers only Claude and Codex (`src/daemon/routing-resolve.ts:91`, `src/daemon/routing-resolve.ts:153`). Model inventory constructs only the two probes (`src/daemon/model-inventory.ts:127`, `src/daemon/model-inventory.ts:159`), and static vendor inference recognizes only their model-name patterns (`src/adapters/tools/models.ts:18`, `src/adapters/tools/models.ts:29`). Grok needs a real model catalog, route schema, pool binding, benchmark participation, reservations, and billing memory before it can be treated equally. The “review on the other vendor” policy also needs a three-vendor rule rather than a binary inversion (`src/daemon/quota.ts:1404`, `src/daemon/quota.ts:1409`).

## 8. Capabilities, rights, credentials, and landing

Hive authorization is role-based and vendor-neutral. Roles and actions are defined in `src/daemon/capabilities.ts:19` through `src/daemon/capabilities.ts:46`; writer and reader grants are issued with different rights at `src/daemon/capabilities.ts:87` through `src/daemon/capabilities.ts:125`. The architecture matrix defines the roles at `docs/architecture/capability-rights-matrix.md:15` and their allowed operations at `docs/architecture/capability-rights-matrix.md:29` through `docs/architecture/capability-rights-matrix.md:67`. Reader agents must remain unable to land; writers receive only the branch-scoped landing right.

Grok does not require a third authorization model. It requires an adapter mechanism that places the existing per-agent capability token where Grok's Hive MCP client can send it, preserves it across resume/restart, and does not put it in shared or user-global config. The adapter must also ensure that read-only versus writer permissions are enforced both by Hive's capability gate and by the vendor's filesystem/shell autonomy settings. Vendor-native “trust” is not a substitute for Hive authorization, and the prompt's landing command is not proof that the credential was attached.

## 9. Skills, CLI, workspace UI, recovery, and reaping

Skills are shipped per vendor. Native target directories currently exist only for Claude and Codex (`src/adapters/skills.ts:17`, `src/adapters/skills.ts:25`), and provisioning switches over those tool values (`src/adapters/skills.ts:188`, `src/adapters/skills.ts:220`). The binary inlines `skills/hive-claude/` and `skills/hive-codex/` manifests and bodies (`src/skills/shipped.ts:11`, `src/skills/shipped.ts:18`, `src/skills/shipped.ts:36`, `src/skills/shipped.ts:49`). `hive init` has a two-vendor target list and installs each shipped skill (`src/cli/init.ts:64`, `src/cli/init.ts:71`, `src/cli/init.ts:345`, `src/cli/init.ts:385`); uninstall has a closed two-vendor list (`src/cli/uninstall.ts:190`). Grok needs a vendor-native `hive-grok` skill, binary inlining, init installation, runtime provisioning, and uninstall cleanup. A shipped skill is not complete until tests prove init and spawn install it where Grok actually reads skills.

The public CLI exposes tool/provider arguments and validates only the two current values (`src/cli.ts:304`, `src/cli.ts:316`, `src/cli.ts:344`, `src/cli.ts:362`). The workspace launch parser likewise hard-codes the two values (`workspace/Sources/HiveWorkspace/LaunchConfig.swift:16`, `workspace/Sources/HiveWorkspace/LaunchConfig.swift:67`), while the agent feed is largely vendor-string tolerant (`workspace/Sources/WorkspaceCore/AgentFeed.swift:8`, `workspace/Sources/WorkspaceCore/AgentFeed.swift:47`). Status rendering is generic (`src/cli/status.ts:14`, `src/cli/status.ts:58`), but every selection control, filter, icon/label, and launch serializer still needs an explicit Grok test.

Crash recovery has three vendor-specific operations—artifact lookup, config rewrite, and resume argv—and currently sends every non-Claude tool down Codex paths (`src/daemon/recovery.ts:297`, `src/daemon/recovery.ts:339`, `src/daemon/recovery.ts:370`). Codex also owns a native app-server host with orphan reaping (`src/adapters/tools/codex-app-server.ts:910`, `src/adapters/tools/codex-app-server.ts:952`) wired into the daemon (`src/daemon/server.ts:1243`, `src/daemon/server.ts:1260`). Grok needs equivalent host reaping only if its integration creates a separate long-lived host; ordinary tmux/process resource monitoring is shared. Project cleanup currently knows the existing vendor config locations (`src/cli/project-config-cleanup.ts:161`, `src/cli/project-config-cleanup.ts:180`) and must include any Grok project-local artifacts Hive creates.

## 10. Verification map

The existing suite shows the seams where third-vendor coverage belongs. Adapter command/config/resume tests live in `src/adapters/tools/claude.test.ts:65` and `src/adapters/tools/codex.test.ts:140`. Telemetry and Graphify parsing are covered at `src/daemon/tool-telemetry.test.ts:33`, `src/daemon/tool-telemetry.test.ts:135`, and `src/daemon/tool-telemetry.test.ts:199`. Recovery coverage starts at `src/daemon/recovery.test.ts:356`; delivery and channel behavior at `src/daemon/delivery.test.ts:171` and `src/daemon/channel-delivery.test.ts:78`.

Quota discovery, bindings, unreadable surfaces, and reservations have cases throughout `src/daemon/quota-discovery.test.ts:181`, `src/daemon/quota-discovery.test.ts:579`, `src/daemon/quota-discovery.test.ts:659`, `src/daemon/quota-discovery.test.ts:758`, and `src/daemon/quota-discovery.test.ts:1251`. Capability discovery is tested at `src/daemon/capability-discovery.test.ts:177`, `src/daemon/capability-discovery.test.ts:261`, and `src/daemon/capability-discovery.test.ts:419`. Routing derivation and resolution tests begin at `src/schemas/routing-derivation.test.ts:132`, `src/schemas/routing-derivation.test.ts:238`, `src/schemas/routing-derivation.test.ts:386`, `src/schemas/routing-derivation.test.ts:451`, `src/schemas/routing-derivation.test.ts:530`, and `src/daemon/routing-resolve.test.ts:120`.

Spawner tests cover prompt/argv/config/restart behavior at `src/cli/spawner-impl.test.ts:1064`, `src/cli/spawner-impl.test.ts:2848`, `src/cli/spawner-impl.test.ts:3228`, `src/cli/spawner-impl.test.ts:3427`, `src/cli/spawner-impl.test.ts:3609`, and `src/cli/spawner-impl.test.ts:3990`. Shipped skills and init are covered at `src/skills/shipped.test.ts:29` and `src/cli/init.test.ts:227`. Model inventory starts at `src/daemon/model-inventory.test.ts:90`. Workspace parsing has TypeScript coverage at `src/cli/workspace.test.ts:138` and Swift project-state coverage at `workspace/Tests/WorkspaceCoreTests/ProjectStateTests.swift:94`.

The new tests should include negative controls: an unknown fourth vendor must throw at every exhaustive dispatch, Grok fixtures must produce a positive telemetry/quota/model result before absence cases are trusted, and delivery tests must observe a new turn rather than only a successful transport write.

## 11. Open questions for Grok discovery

This map deliberately does not claim answers to the following. They are the vendor-side facts consumed by Hive's spawn builders (`src/adapters/tools/claude.ts:245`, `src/adapters/tools/codex.ts:209`), delivery transports (`src/daemon/delivery.ts:138`), telemetry readers (`src/daemon/tool-telemetry.ts:99`, `src/daemon/tool-telemetry.ts:178`), quota probes (`src/daemon/quota-sources.ts:93`), and skill installer (`src/adapters/skills.ts:188`). The Grok discovery work must provide measured fixtures or command output before implementation choices are frozen.

1. What noninteractive command and arguments start a session with an exact model, autonomy policy, prompt source, and working directory?
2. What stable identifier and command resume exactly that session after daemon or terminal restart?
3. Which project-local or agent-local settings establish trust, permissions, hooks, MCP servers, and credentials without mutating user-global state?
4. Is there a pre-tool hook? If so, what matchers and response JSON does it accept, and how is a hook effect recorded?
5. Is there a native input RPC or channel API? If not, which terminal cancel/paste sequence works, and what artifact proves a new turn began?
6. Where is the durable transcript or rollout artifact, and how does it encode activity, context use, compaction, live model, tool calls, and session identity?
7. Can account quota and billing/credit state be read noninteractively? What are the pool windows, reset semantics, model bindings, and positive controls?
8. How is the model catalog discovered, and which model facts are authoritative enough for routing and benchmarking?
9. Does the integration create a long-lived helper process that requires orphan detection and reaping?
10. Where does the CLI discover vendor-native skills, and can Hive install them per worktree without global side effects?

Until those are answered, any Grok implementation in the corresponding area is a hypothesis, not first-class support.

## 12. Ordered implementation checklist

The labels distinguish exhaustive plumbing from behavior that depends on measured Grok facts. Parallel work is identified only after its prerequisites.

1. **[REAL DESIGN, prerequisite] Finish Grok surface discovery.** Answer §11 with reproducible fixtures for launch/resume, config, delivery, artifacts, hooks, model catalog, quota, and billing. In particular, prove positive quota/billing fields before interpreting absence.
2. **[MECHANICAL, prerequisite] Make vendor dispatch exhaustive.** Replace every binary conditional and closed list in §1 with an exhaustive dispatcher that throws for an unimplemented provider. Add an unknown-vendor negative test. Do this before widening the enum so missing work is visible.
3. **[MECHANICAL] Widen canonical and duplicate schemas.** Add Grok to capability, agent identity, routing, spawn, quota, ledger, skill, CLI, and workspace schemas in §2 and §9. No SQL migration is expected for the existing `TEXT` columns, but round-trip tests are required.
4. **[REAL DESIGN] Define a typed vendor-adapter interface.** Encode the ten obligations in §3, including resume/artifact resolution, delivery, telemetry, and credential injection. Migrate Claude and Codex to it before accepting a Grok adapter.
5. **[REAL DESIGN; parallel tracks after steps 1–4] Implement the Grok runtime adapter.** One track owns spawn/resume/config/trust/permissions/MCP/credentials; a second owns delivery/cancel/critical restart; a third owns artifact lookup/telemetry/live model/Graphify parsing; a fourth owns quota/billing/catalog/pool binding. These tracks can proceed in parallel because their shared types and measured fixtures are already fixed.
6. **[MECHANICAL with vendor fixtures] Wire all lifecycle paths.** Connect the adapter to normal spawn, control restart, crash recovery, prompt-file injection, readiness, execution identity, and cleanup/reaping. Verify all four lifecycle paths use the same session identity.
7. **[REAL DESIGN] Integrate routing economics.** Add Grok pools, model catalog, benchmarks, reservation accounting, billing memory, cost-consent behavior, and a three-vendor review policy. Do not call compatibility mode “quota support”; it is unbounded estimation with a warning (`src/daemon/quota.ts:1526`, `src/daemon/quota.ts:1560`).
8. **[REAL DESIGN] Integrate Graphify.** Add the vendor's hook installation and MCP attachment only after the hook request/response schema is measured. Add artifact fixtures proving an intercepted tool call changes behavior and increments telemetry.
9. **[MECHANICAL; parallel after adapter paths stabilize] Ship the vendor skill and product surfaces.** Add `skills/hive-grok/`, binary inlining, init/provision/uninstall, CLI validation, routing/status displays, workspace launch parsing, and UI labels. Test the effect at the vendor's actual skill directory, not just the shipped manifest.
10. **[MECHANICAL plus end-to-end verification] Close the matrix.** Add Grok cases to every suite in §10, plus reader/writer capability tests, delivery-effect tests, recovery/reaping tests, and positive-control quota/telemetry fixtures. Run the full TypeScript suite, typecheck, and workspace/Swift tests where the workspace code changed.
11. **[RELEASE GATE, REAL DESIGN] Prove first-class behavior.** A reader and writer must both spawn, receive ordinary and urgent delivery, report live context/model, invoke Graphify, recover the same session, participate in model-aware quota routing, and—only for the writer—land through the capability gate. Any null telemetry, unbounded reservation, guessed model binding, or fallback transport must be reported explicitly rather than presented as parity.

The mechanical work is broad but straightforward once the adapter boundary and Grok facts exist. The real design risk is concentrated in four places: delivery/preemption, transcript and hook artifact formats, quota/billing readability, and model-to-pool binding. Those are precisely the places where an action can succeed while the intended effect remains absent.

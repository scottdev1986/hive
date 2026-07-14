# Agent-authored project profiling: implementation plan for Slices 2, 4, and 5

Status: design for review. This document does not change the product contract or implement any slice.

## Scope and fixed decisions

This plan covers profiler tools and bootstrap spawning (Slice 2), first-run UX and the spawn gate (Slice 4), and drift/refresh (Slice 5). It assumes Erica's Slice 1 schema and storage land first. The `profiling` routing category and cross-ecosystem fixtures are already on `main` (`src/schemas/routing-policy.ts:34`, `src/adapters/project-fixtures.test-support.ts`).

The following decisions are load-bearing:

- The daemon is the sole authority for profile lifecycle, current-profile validity, the spawn gate, and the per-session **Continue Without Profile** bypass. CLI and Workspace are clients of the same daemon state; neither derives or caches a separate gate decision.
- Workspace startup is never gated. Profile status/read are never gated. Only orchestrator and ordinary-worker creation are gated.
- A legacy `profile.toml` or `.hive/profile.override.toml` is not a completed agent-authored profile and cannot open the gate.
- The bypass lives in daemon memory and lasts for that daemon session. It is shared by every launcher attached to that daemon and deliberately disappears on restart, causing the automatic retry required on the next start.
- Profile state remains below the active instance's `HIVE_HOME`, consistent with `docs/daemon/multi-instance.md:47-58`. Named instances may independently profile the same Git project.
- A profiler never receives a repo filesystem, shell, landing, branch, dependency-install, project-script, or general-purpose network capability. It learns about the repo only through the bounded `profile_inventory` tool and submits only through `profile_submit`.
- The profiler prompt repeats every load-bearing restriction. Provider settings and the shipped skill are defense in depth, not substitutes for the prompt or daemon authorization.
- The last validated `current.json` remains active while a refresh is stale, running, deferred, or failed. Only a validated temp-file-plus-rename replaces it.

## Slice 1 contract required from Erica

The emerging contract is in `hive/erica-build-the-foundation-of-hive-s` at `7581230` and is not yet on this branch. Integration packages should import these functions rather than recreate profile storage:

All file:line pointers below into Erica's `src/schemas/project-profile.ts`, `src/daemon/project-profile.ts`, `src/daemon/project-profile-validate.ts`, and `src/daemon/project-state.ts` are relative to `7581230`. Her branch is in review/rework and validation/staleness-adjacent lines will move; after her final commit lands, implementers must resolve each cited symbol by name and re-check its current source before editing.

| Interface | Emerging location | Required semantics |
|---|---|---|
| `ProjectProfileSchema`, lifecycle/state schemas | `src/schemas/project-profile.ts:24-264`, `:281-352` | Strict versioned validated profile and `unprofiled | profiling | current | stale | failed` state. |
| `projectStateDir`, `projectHiveUuid` | `src/daemon/project-state.ts:27-40` | Resolve the primary worktree identity and write below the active `HIVE_HOME`. |
| `projectProfileDir`, `currentProfilePath`, `profileStatePath` | `src/daemon/project-profile.ts:46-55` | Exact paths used in disclosure and operator status. |
| `computeProfileInventory` | `src/daemon/project-profile.ts:180-228` | One canonical, content-based inventory implementation shared by run validation, session drift checks, and `profile_inventory`. |
| `readCurrentProfile`, `readProfileState` | `src/daemon/project-profile.ts:228-260` | Return only schema-valid current data; missing/invalid state is `unprofiled`. |
| `beginProfiling` | `src/daemon/project-profile.ts:291-365` | Daemon mints run ID and input digest without removing current. `{ifIdle:true}` atomically returns one handle or `null` under the cross-process profile lock. |
| `submitProfile` | `src/daemon/project-profile.ts:398` onward | Authenticate the run, validate evidence/digest outside the lock, then re-check the run under lock before atomic replacement. |
| `failProfiling`, `markProfileStale` | `src/daemon/project-profile.ts:547-595` | Preserve current and record an exact failure/staleness reason. |
| daemon validation | `src/daemon/project-profile-validate.ts:75` onward | The daemon, not the model or tool client, is the acceptance authority. |

### Foundation corrections required before tool/coordinator work

These are contract fixes, not optional polish. They should land as the first independently-landable follow-ups after Erica's foundation.

The one-job compare-and-begin primitive is already delivered at `7581230`: all `state.json` read-modify-writes use the repository's cross-process `withFileLock` (`src/daemon/project-profile.ts:270-287`), and `beginProfiling(root, profiler, {ifIdle:true})` performs the check, content inventory, and state write under it (`:317-365`). The coordinator must always use that overload for normal first/refresh work. A `null` result means “join the durable active run and mark this request pending/coalesced”; only explicit dead-run takeover may call the default superseding overload after the coordinator's expiry proof. Submission validates expensive inputs outside the lock and re-checks ownership inside it before replacement.

1. **Use one safe, bounded inventory policy.** The emerging implementation hashes contents and skips a small directory set (`src/daemon/project-profile.ts:74-95`, `:135-196`), but it is unbounded and does not exclude credential stores or known secret files. Export an inventory service used by digesting and MCP reads. It must:
   - skip directory segments `.git`, `.hive`, `node_modules`, `bower_components`, `.pnpm-store`, `.yarn`, `vendor`, `vendors`, `dist`, `build`, `out`, `target`, `coverage`, `.next`, `.nuxt`, `.cache`, `.parcel-cache`, `.turbo`, `.venv`, `venv`, `__pycache__`, `.tox`, `.mypy_cache`, `.pytest_cache`, and `.gradle`;
   - skip credential-store segments `.ssh`, `.aws`, `.azure`, `.config/gcloud`, `.kube`, `.gnupg`, and `.docker`;
   - skip known-secret basenames/patterns: `.env` and `.env.*` except `.env.example`/`.env.sample`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `id_rsa`, `id_ed25519`, `credentials*`, `secrets*`, private-key/service-account files, and extensions `.pem`, `.key`, `.p12`, `.pfx`;
   - normalize to POSIX repo-relative paths, reject absolute/`..` paths, use `lstat`, and never dereference symlinks. A symlink may expose only its repo-relative path and a target string when the resolved target remains inside the project; an outside target is reported as skipped without exposing it;
   - hash each allowed regular file by content, not size. Canonical digest input is sorted `type NUL path NUL contentDigest` records, so add/remove, type, rename, and same-size edits change the digest;
   - fail explicitly with `inventory-limit` rather than return an apparently complete partial inventory after 100,000 files, 2 GiB hashed bytes, 64 path segments, or 60 seconds. Do not start/accept a run against a partial digest.
2. **Separate model-authored candidate from daemon envelope.** Add `ProjectProfileCandidateSchema` containing the authored fields. The `profile_submit` payload must not choose `schemaVersion`, `generatedAt`, project UUID/input digest, provider/model/agent, run ID, tool session ID, request provenance, or accepted time. `submitProfile` assembles those fields from the authenticated active run and daemon clock before `ProjectProfileSchema` validation. The current full-payload path at `src/daemon/project-profile.ts:398-425` and `src/daemon/project-profile-validate.ts:75-80` makes the model claim daemon-owned metadata even though validation later compares it.
3. **Record request provenance.** Extend the daemon-owned run/request state with `{source, requestedAt, requestedBy, guidance}`. Guidance is optional, UTF-8, normalized only for line endings, capped at 4 KiB, and copied into accepted-profile provenance. It is an instruction to investigate, never a validation override.
4. **Reconcile two-file crash windows.** `current.json` is correctly renamed before `state.json`. Add `reconcileProfileState(root)` at daemon start/read: a valid newer current profile repairs state to `current`; state can never claim a different current digest. Leave temp-file cleanup to the same reconciliation.
5. **Return stable machine-readable failures.** Preserve a `code` plus exact human `detail`. Routing currently throws a multiline string from `src/daemon/spawner-impl.ts:1823-1830`; store it verbatim as `routing-refused` rather than parsing it into invented structure.

## Public interfaces

### MCP tools and capability matrix

Add a fifth role, `profiler`, and four actions to `src/daemon/capabilities.ts:19-47`. Grants are already explicit: append `profile:read`/`profile:request` to the existing `OPERATOR_ACTIONS` literal at `src/daemon/capabilities.ts:65-88` and the orchestrator list at `:103-114`; add a profiler grant containing only `profile:inventory` and `profile:submit`. Do not grant profiler actions to another role by default, and do not refactor the existing operator list.

| Tool/surface | Capability | Roles | Mutates | Contract |
|---|---|---|---|---|
| `profile_inventory` | `profile:inventory` | profiler only | no | Run-bound catalog/content reads under the safe inventory policy. |
| `profile_submit` | `profile:submit` | profiler only | yes | Validate a candidate for the authenticated active run and atomically commit only on success. |
| `profile_status` | `profile:read` | operator, orchestrator | no | Lifecycle, current availability, exact path/failure, active run, refresh state, and authoritative spawn gate. |
| `profile_read` | `profile:read` | operator, orchestrator | no | The validated current profile or `null`; a legacy profile is never returned. |
| `profile_reprofile` | `profile:request` | operator, orchestrator | yes | Coalesce a refresh request and record optional guidance/requester provenance; never bypass validation. |
| `GET /profile/gate` | `profile:read` | operator, orchestrator | no | The same gate object returned by `profile_status`; used by hidden launchers. |
| `POST /profile/continue-without` | `profile:request` | operator only | yes | Set the daemon-session bypass after the disclosure/failure UI; audit the act. This is not a profiler tool. |

The role/action definitions, grant matrix, route/tool table, stolen-credential analysis, and drift test must change together in `docs/daemon/authorization.md:20-32`, `:34-67`, `:69-108`, `:146-168` and `src/daemon/auth.test.ts:165-274`, `:585-813`.

Register tools in `HiveDaemon.createMcpServer` at `src/daemon/server.ts:3267-3891`. Keep authentication before tool enumeration (`src/daemon/server.ts:3896-3914`) and use `authorizeTool` (`src/daemon/server.ts:938-953`) in every handler. Register profile tools conditionally by authenticated role: profiler sessions see only inventory/submit; operator/orchestrator see status/read/reprofile; reader/writer agents see no profile tools. Do not rely on a handler denial to hide an inappropriate tool from model context.

Define shared Zod wire schemas in `src/schemas/profile-tools.ts`, exported at `src/schemas/index.ts`. Stable responses:

```ts
type ProfileSpawnGate = {
  canSpawn: boolean;
  basis: "validated-profile" | "session-bypass" | "first-profile-required";
  bypassed: boolean;
};

type ProfileStatus = {
  lifecycle: "unprofiled" | "profiling" | "current" | "stale" | "failed";
  hasCurrent: boolean;
  currentPath: string;
  statePath: string;
  failure: { code: string; detail: string; at: string } | null;
  run: { runId: string; provider: string; model: string; startedAt: string } | null;
  refresh: { pending: boolean; deferredReason: string | null };
  gate: ProfileSpawnGate;
};
```

`profile_inventory` has two mutually exclusive modes:

- `{ cursor?: string }` returns at most 500 catalog entries and 256 KiB. Allowed entries contain path, type, size, content digest, and any content-omission reason; excluded directories/credential stores/secret files are absent. `nextCursor` is opaque and bound to `{projectUuid, runId, inputDigest, offset}`.
- `{ paths: string[] }` returns UTF-8 contents only for up to 32 paths already present in that run's safe catalog, at most 256 KiB per file, 512 KiB per response, and 8 MiB total content per run. Binary, large, secret, symlink, changed, or uncatalogued paths return an explicit per-path omission, never bytes.

On every call the daemon verifies credential subject, project UUID, active run ID, and input digest. A tree change invalidates the cursor/read and schedules a new run. Caps are daemon constants, not caller-expandable options.

### Profiler token-usage attribution

Keep provider spend visible without widening the profiler model's tool rights. Do **not** grant `telemetry:report`: `/statusline` is keyed to an ordinary agent row (`src/daemon/server.ts:2425-2437`), while the specialized profiler deliberately has no such row. Instead, extend the daemon-owned usage ledger:

- add `profiler` to `TokenUsageSubjectSchema.role` and a separate `profilingSessions` breakdown in `src/schemas/token-usage.ts:30-73`;
- migrate the `token_usage_subjects.role` check, add nullable `profileRunId` plus a unique `(sessionId, profileRunId)` index, and add `TokenUsageStore.startProfiler(...)` beside `startOrchestrator` in `src/daemon/token-usage.ts:327-456`. It records run ID/name, provider, model, isolated runtime cwd, provider session ID when observed, start/end timestamps, and no ordinary `agentId`;
- make active-session reuse at `src/daemon/token-usage.ts:384-408` treat an unfinished profiler subject as live, so gate-critical profiling that starts before the orchestrator is not closed into a throwaway usage session;
- have `ProfilingAgentLauncher`/`ProfileCoordinator` start the usage session and profiler subject before provider launch, attach the observed provider session ID, refresh/finalize it on every accepted/failed/timeout/shutdown path, and keep its ID in daemon run state; and
- include profiler subjects in `fleet`, their own `profilingSessions` bucket, `subjects`, completeness, and unknown-subject reporting at `src/daemon/token-usage.ts:761-810`. `hive_token_usage` at `src/daemon/server.ts:3361-3376` then exposes the job through the existing operator/orchestrator surface;
- add `profilingSessions` to Swift `TokenUsageSession` at `workspace/Sources/WorkspaceCore/ModelControlSnapshot.swift:514-550`; and
- change `workspace/Sources/WorkspaceCore/TokenUsagePresentation.swift:90-125` to partition `role == "orchestrator"`, `role == "profiler"`, and `role == "worker"` explicitly. Render a dedicated profiling aggregate/subject row from `profilingSessions`; a profiler must never fall through into WORKERS.

Use only provider-reported artifact/session readings through the existing adapters. If the provider session ID or artifact is absent, report an explicit unknown and keep the usage session incomplete; never turn the routing reservation/estimate into an observed token count. Cover schema migration, pre-orchestrator session reuse, all three provider adapters, terminal finalization, measured counts, and honest unknowns in `src/daemon/token-usage.test.ts`.

Add a real cross-language wire guard; no token-usage fixture exists today. Create `workspace/Tests/WorkspaceCoreTests/Fixtures/token-usage-wire.json`, a daemon-side `src/schemas/token-usage.wire-contract.test.ts` proving the fixture parses and carries every current role/breakdown, and `workspace/Tests/WorkspaceCoreTests/TokenUsageWireContractTests.swift` proving the same fixture decodes `profilingSessions` and presents profiler subjects outside WORKERS. Model the shared-fixture pattern on `routing-policy-wire.json`, `src/schemas/routing-policy.wire-contract.test.ts`, and `workspace/Tests/WorkspaceCoreTests/RoutingPolicyWireContractTests.swift`; `workspace/Package.swift:35-42` already bundles the Fixtures directory.

### Profiler credential

Issue a new role through the existing mint/authorize/audit path in `src/daemon/capabilities.ts:247-377`, `:414-460` and credential files in `src/daemon/credentials.ts:29-83`.

- Subject is `profiler-<projectUuid>-<runId>`; never reuse an ordinary agent name.
- TTL is 30 minutes. The coordinator removes/revokes the credential when the run is accepted, failed, timed out, or daemon shutdown begins.
- Authorization additionally requires that the subject's project/run matches the active state. A stolen token from another project, named instance, or completed run buys nothing.
- Invalid schema submissions do not consume the credential: return all validation errors so the same bounded run can repair and resubmit. Acceptance or terminal timeout consumes it.
- The provider/model/tool-session provenance comes from the authorized launch and observed provider session, not tool arguments.
- Audit allowed/denied submit/request/bypass operations. For inventory, audit the first page and denials rather than every catalog page; the run record already identifies the reader.

## Bootstrap profiling spawn

The ordinary path cannot be reused as-is. `HiveSpawner.spawnReserved` always creates a branch worktree (`src/daemon/spawner-impl.ts:1869-1873`; `src/adapters/worktrees.ts:306-351`), then calls the legacy profile/brief pipeline (`src/daemon/spawner-impl.ts:1874-1942`), inserts an ordinary landable agent (`:1953-1982`), provisions repo skills (`:2000-2002`), and launches in that worktree (`:2115-2138`). All five behaviors violate bootstrap independence or profiler confinement.

Add a non-public `ProfilingAgentLauncher` (suggested `src/daemon/profiling-agent-launcher.ts`) called only by `ProfileCoordinator`. Extract the existing routing/launch-admission portion at `src/daemon/spawner-impl.ts:1417-1867` into a shared service; do not duplicate model enablement, capability floor, effort, final revalidation, or quota rules. It requests the landed `profiling` category, honors its routing contract, and records routing refusal strings exactly. Profiling is headroom-preserving and may be refused under quota pressure; first-run becomes `failed`, while refresh stays pending/deferred.

The specialized path:

1. routes/reserves a provider/model under category `profiling`;
2. begins/coalesces the run and mints its run-scoped profiler credential;
3. creates a runtime directory below `projectProfileDir(root)/runs/<runId>` and uses it as `cwd` (never the repo and never `.hive/worktrees`);
4. installs only `hive-project-profiler` into provider-native runtime config there;
5. attaches only the Hive MCP server and only the two profiler tools;
6. launches a background provider process/tmux session named with project and run IDs;
7. tracks process/session, quota reservation, provider/model/session ID, deadline, and credential in the daemon-owned run; and
8. on exit without an accepted submission, records the exact exit/routing/timeout failure and leaves any current profile active.

It must never call `createWorktree`, `ensureProfile`, `buildScopedBrief`, graphify, memory indexing/injection, `provisionSkills(worktree, ...)`, ordinary agent insertion, landing protocol construction (`src/daemon/spawner-impl.ts:510-586`), or `landAgent`.

### Prompt and provider confinement

Add `buildProfilerPrompt` beside the launcher, separate from ordinary `buildAgentPrompt` at `src/daemon/spawner-impl.ts:641-695`. It carries project display name, run ID, profile schema/candidate instructions, optional guidance verbatim, and these explicit rules:

> You are Hive's project profiler. Inspect the project only with `profile_inventory`; do not use native file, shell, code execution, network, browser, or other MCP tools. Do not create or modify files, branches, worktrees, commits, dependencies, configuration, memory, or skills. Do not run build, test, lint, typecheck, install, package-manager, VCS, or project commands. Record unknowns instead of guessing. Submit only through `profile_submit`, repair validation errors if returned, and stop after acceptance.

Ship `skills/hive-project-profiler/SKILL.md` through `src/skills/shipped.ts:17-51` with `tools: CAPABILITY_PROVIDERS`, and cover it in `src/skills/shipped.test.ts:29-65` and `src/skills/packaging.test.ts:30-36`, `:118-140`. Do not use ordinary `provisionSkills` (`src/adapters/skills.ts:221-258`), which writes all skills into the repo/worktree; add a runtime-only materializer for this one shipped skill.

Provider adapters need explicit profiler modes, not merely ordinary `readOnly`:

- Claude: extend config/launch seams at `src/adapters/tools/claude.ts:33-66`, `:267-306`, `:519-690`. Deny native Read/Glob/Grep in addition to Edit/Write/NotebookEdit/Bash, deny WebFetch/WebSearch and unknown MCPs, and allow only the scoped Hive inventory/submit server. Seed trust only in the isolated runtime directory.
- Codex: extend `src/adapters/tools/codex.ts:32-68`, `:112-240`. Disable Apps, inherited MCPs, graphify, web search, shell/exec, and app-server host tools; attach only the run-scoped Hive MCP. A read-only sandbox alone is insufficient because it still permits project reads/scripts.
- Grok: extend `src/adapters/tools/grok.ts:12-50`, `:104-150`, `:184-225`. Deny Bash/Shell, Read/Grep, Write/Edit, web/network tools, and inherited MCPs; allow only the scoped Hive server.

Each provider gets a command/config conformance test proving the effective tool list, working directory, MCP list, credential injection, and absence of shell/native-read/network. If a provider version cannot prove that surface, launch fails closed with an exact profile failure; it does not silently fall back to a weaker sandbox.

## Daemon coordinator, gate, and first-run sequence

Add `ProfileCoordinator` in `src/daemon/profile-coordinator.ts`, wire it into `HiveDaemonOptions`/fields at `src/daemon/server.ts:419-523`, `:546-628`, and construct it in `src/cli/daemon.ts:53-210`. Required API:

```ts
interface ProfileCoordinator {
  start(): Promise<void>; // reconcile, check digest, then schedule; never blocks bind
  stop(): Promise<void>;
  status(): Promise<ProfileStatus>;
  read(): Promise<ProjectProfile | null>;
  gate(): Promise<ProfileSpawnGate>;
  requireSpawnAllowed(kind: "orchestrator" | "worker"): Promise<void>;
  continueWithoutProfile(requester: CapabilitySubject): Promise<void>;
  requestReprofile(request: ProfileRequest): Promise<ProfileRunRef>;
  noteFilesystemChange(path: string): void;
  noteLandedPaths(paths: readonly string[]): void;
  updateCapacity(state: ProfileCapacity): void;
}
```

Keep MCP/HTTP plumbing independently landable by defining a narrow `ProfileControl` interface at this boundary. `HiveDaemonOptions` accepts it, handlers call it, and P1 tests inject a fake; `ProfileCoordinator` becomes the production implementation in P3. Until P3 is wired, production construction omits the optional service and registers no profile tools/routes. Do not let server handlers reach around this interface to mutate `state.json`.

Daemon startup currently starts the old profile asynchronously at `src/daemon/server.ts:1037-1046` through `ensureRepoProfile` at `:1090-1102`. Replace that call with `coordinator.start()` after the daemon is bound. The daemon must become available before profiling so Workspace, disclosure, status, retry, and Continue Without Profile remain usable.

Gate formula, evaluated on every request:

```text
canSpawn = readCurrentProfile() != null || daemonSessionBypass == true
```

`stale`, refreshing, deferred, and refresh-failed projects with a validated current profile remain open. `unprofiled`, first-run `profiling`, and first-run `failed` remain closed until acceptance or bypass. Lifecycle alone is not enough; valid current bytes are the positive control.

Enforce the gate at all creation boundaries:

- before memory-pressure checks and before any worktree mutation in MCP `hive_spawn` (`src/daemon/server.ts:3610-3666`);
- in the hidden orchestrator supervisor before every initial/recovery launch (`src/cli/orchestrator-supervisor.ts:97-100`, `:146` onward);
- in the direct orchestrator launch path (`src/cli/orchestrator.ts:411-505`);
- defensively in `/codex-root-token` (`src/daemon/server.ts:2381-2406`), while retaining supervisor enforcement because Claude/Grok do not use that endpoint; and
- in Workspace as a client-side wait on daemon status, not as an alternate authority.

Return one stable `PROFILE_REQUIRED` error with status/path/failure and no side effects. A race between gate check and a refresh cannot close an already-open gate because current stays; a race with first acceptance is resolved by rechecking after the client receives the error.

### First start

`startSession` currently builds the legacy profile before the daemon starts (`src/cli/start.ts:119-136`). Remove that behavior. The new sequence is:

1. resolve project and exact `currentProfilePath(root)`;
2. if no validated current exists, print/show disclosure before any repo content reaches a provider: what bounded read-only profiling does, the exact local `current.json` path, and `Repository content selected by the profiler may be sent to the configured <provider>/<model>`;
3. start/bind the daemon and Workspace normally;
4. coordinator reconciles state, performs the session digest check, and starts exactly one background first profiler if needed;
5. profile status remains available; orchestrator/ordinary spawns receive `PROFILE_REQUIRED` until accepted;
6. on failure, preserve and show the exact failure, with Retry and Continue Without Profile. Retry calls the daemon request path and coalesces. Continue calls `POST /profile/continue-without` and then rechecks the gate;
7. if neither is chosen, daemon shutdown clears the bypass and the next start automatically retries one profiler.

Never auto-loop a first-run failure in one daemon session. Automatic retry means one attempt on the next daemon start; explicit Retry may start another in the current session.

Bare/vendor-specific startup reaches this boundary through `src/cli/workspace.ts:232-275`. Keep that shared path: it must print the disclosure before daemon launch when it can positively observe no validated current profile, then Workspace renders the same daemon status after connecting. A second client attaching to an already-profiling daemon shows the disclosure/status but does not request a second run.

## Operator CLI and legacy command removal

Add `src/cli/profile.ts` and public commands at the command registration seam `src/cli.ts:229-290`:

- `hive profile status` prints lifecycle, current/stale use, exact paths, active provider/model, pending/deferred refresh, exact failure, and gate/bypass. `--json` emits `ProfileStatus`.
- `hive profile show` prints validated `current.json`; without one it exits nonzero with `No validated agent-authored profile` and the exact expected path. `--json` is the raw schema object.
- `hive profile reprofile [--guidance <text>]` starts/attaches to the daemon, calls `profile_reprofile`, reports `started` or `coalesced`, and never edits profile files directly.

Add wrappers beside `callHiveTool` in `src/cli/mcp.ts:43-66`. CLI uses operator credentials; orchestrator calls use orchestrator credentials.

Remove legacy profile generation from `runInit` at `src/cli/init.ts:304-325` and `runInitCli` at `:524-569`. `hive init --refresh` is no longer a compatibility alias for the deterministic scan (`src/cli.ts:256-289`; `src/cli/init.ts:548`): reject it with one actionable line, `Fix: hive profile reprofile`, without silently spending model quota. Init may keep its unrelated skills/memory/scaffold responsibilities.

Remove old `ensureProfile` calls from `src/cli/start.ts:125-131`, `src/daemon/server.ts:1037-1102`, `src/cli/orchestrator.ts:225-234`, `src/daemon/spawner-impl.ts:1874-1942`, and `src/adapters/brief.ts:25-32` as their replacement packages land. Do not consult `profile.toml` or `.hive/profile.override.toml` for gate state or new-profile reads.

## Workspace disclosure and daemon-owned gate

Workspace currently bootstraps its private orchestrator immediately at `workspace/Sources/HiveWorkspace/AppDelegate.swift:60-119`, and `ProjectWindowController.bootstrapOrchestrator` launches the hidden CLI at `workspace/Sources/HiveWorkspace/ProjectWindowController.swift:99-102`, `:293-307`. Change it as follows:

1. Extend workspace feed version/schema at `src/cli/workspace-feed.ts:1-34`, `:141-209` with the complete daemon `ProfileStatus`/gate object on every snapshot.
2. Extend Swift decoding at `workspace/Sources/WorkspaceCore/AgentFeed.swift:66-102` and delivery at `workspace/Sources/HiveWorkspace/FeedClient.swift:25`, `:69-83`.
3. AppDelegate still opens the project window and calls idempotent `bootstrapOrchestrator`; it never treats feed decoding as launch authority. The hidden `workspace-orchestrator` process calls `GET /profile/gate` and waits/rechecks there before every initial/recovery provider child. That authenticated daemon response is the sole spawn decision.
4. With no current profile, show a disclosure sheet containing the exact path and configured provider/model warning before profiling begins; show progress while `profiling`.
5. On `failed`, show `failure.detail` verbatim and buttons **Retry** and **Continue Without Profile**. Do not replace a detailed error with a friendly summary.
6. Actions invoke a hidden CLI client using the exact launching Hive binary: Retry calls `profile_reprofile`; Continue calls the operator-only daemon bypass endpoint. The hidden client authenticates through `operatorFetch` in `src/cli/credential.ts`, as the feed already does at `src/cli/workspace-feed.ts:32`, `:63-79`. Swift holds no capability token and no local `continueWithoutProfile` boolean.
7. Model the feed observation as `allowed | denied | unknown`. A valid gate payload yields allowed/denied; an absent or undecodable field yields unknown, never denied. Because `AgentFeed.swift:83-101` deliberately decodes fields lossily, unknown renders `Profile status unavailable` and suppresses Retry/Continue decisions that require known state, but it neither blocks nor authorizes the hidden orchestrator process. Test missing and malformed gate fields as well as valid open/closed values.

Test the wire contract in `src/cli/workspace-feed.test.ts:106` onward and `workspace/Tests/WorkspaceCoreTests/WorkspaceFeedWireContractTests.swift`; test AppDelegate/window lifecycle around `workspace/Sources/HiveWorkspace/AppDelegate.swift:118` and `ProjectWindowController.swift:300`.

## Drift and refresh

The coordinator owns one in-memory job/pending slot and the foundation owns the durable run lock. The accepted profile also owns an authored relevance signal: `staleness.paths` and `staleness.notes` at Erica's `src/schemas/project-profile.ts:209-217`, with paths existence-validated at `src/daemon/project-profile-validate.ts:428-429`. Required behavior:

- At every daemon session start, compute the canonical whole-safe-inventory content digest and compare it with the accepted profile's `project.inputDigest`. This is the broad correctness backstop required by the epic: if equal, launch no profiler; a same-size edit must change it; any mismatch marks stale and schedules refresh even when the changed path was not model-authored.
- Treat `staleness.paths` as the high-signal scope/prioritization set. A filesystem event or landed path matching one of them bypasses debounce and gets an immediate digest check, alongside the fixed manifest/commands/docs/conventions/workspaces/entry-point classifier. Other included events still immediately record `stale`, then reset a 2-second whole-digest debounce. If the digest did not change, restore `current` without launching.
- Do not parse `staleness.notes` into paths or hashes. Include the notes as daemon-recorded refresh context/profile guidance so the next profiler can revisit relational inputs such as a changing workspace member set. A newly accepted profile atomically replaces both authored staleness fields.
- Install a best-effort recursive project watcher in the coordinator. Apply the same safe inventory exclusions before marking stale. Watch errors/overflow mark stale and request a digest check; the next session's full content digest is the correctness backstop. Timers are unref'd and closed in `stop()`.
- A successful land returns changed paths. Extend `LandBranch`'s result at `src/daemon/landing.ts:39-42`, compute them against pre-land HEAD in `:477-532`, and call `noteLandedPaths` beside graphify scheduling at `src/daemon/server.ts:2174-2222`.
- Landed changes touching manifests, lockfiles, command/task config, docs, conventions, workspace definitions, or entry-point declarations bypass the 2-second debounce and trigger an immediate digest check. Centralize the path classifier with inventory policy; examples include `package.json`, lockfiles, `Cargo.toml`, `pyproject.toml`, `go.mod`, Make/Just/Task files, CI config, root/docs Markdown, `AGENTS.md`/provider instructions, workspace configs, and conventional entry files. Other landed changes flow through the watcher debounce.
- A reprofile request during a run sets `pending=true` and merges provenance/guidance deterministically: keep every requester/timestamp, concatenate guidance in arrival order up to the 4 KiB total cap, and schedule one follow-up digest check after the active run. It never starts a second process.
- A digest mismatch at submit discards the candidate, marks stale/unprofiled as appropriate, and schedules one coalesced retry subject to capacity; it never replaces current.

### Yielding to user work

First profiling is gate-critical and may use the routing category's normal headroom-preserving quota admission. Refresh is lower priority:

- do not start a refresh while daemon memory pressure is set (`src/daemon/server.ts:1485-1620`, checked for ordinary spawn at `:3628-3635`), while an ordinary agent is being spawned/landed, or while all configured agent capacity is occupied;
- expose `refresh.deferredReason`, keep current active, and retry when capacity changes or after the next debounce/session start;
- if user work arrives before a queued refresh launches, user work wins. Do not cancel a provider that has already started unless the existing resource watchdog requires it; coalescing prevents further refreshes;
- quota/routing refusal is a normal `deferred` state for refresh and an exact `failed` state for gate-critical first profiling.

Use the landed category `profiling` at `src/schemas/routing-policy.ts:34`. Preserve its model-chain/default/fallback semantics and quota attribution; do not infer a model from its name or invent a fallback.

## Profile consumers and generic fallback

Rewire consumers only to `readCurrentProfile`:

- `src/adapters/brief.ts:25-32`: construct the exact `briefable` allowlist and primary-doc selector from the validated profile. The new schema has exact doc paths, not a directory wildcard; set `briefableDirectories` empty rather than widening authored authority.
- `src/cli/orchestrator.ts:225-234`: teach the root the validated load-bearing docs/primary doc, or use repo-neutral examples when absent/bypassed.
- `src/daemon/spawner-impl.ts:510-586`, `:1922-1942`: render all applicable test/typecheck/validate commands with their `cwd` and workspace scope. Do not silently choose the first monorepo command. When absent/bypassed, use generic verification wording and do not invent `bun test`.
- router/spawn consumers must treat profile fields as typed data, not dump the whole profile into prompts.

The gate guarantees a normal worker usually has a profile, but every consumer still supports `null`: Continue Without Profile and a corrupt cache must produce generic prompts rather than crashes or Hive-repo defaults.

## Independently-landable work packages

Each package is sized for one implementing agent and includes its own tests. The dependency column is a hard land order, not merely a suggested review order.

| ID | Package | Primary files | Depends on | Acceptance check |
|---|---|---|---|---|
| F1 | Safe bounded inventory snapshot/catalog/content service | Erica inventory at `src/daemon/project-profile.ts:180-228`; new inventory-policy tests | Erica base | same-size edit changes digest; tracked/untracked secrets, symlinks, binaries, and every cap covered |
| F2 | Submission/run follow-up: candidate/envelope split, guidance provenance, two-file reconciliation | `src/schemas/project-profile.ts:222-352`, `src/daemon/project-profile.ts:233-595`, `src/daemon/project-profile-validate.ts:75` onward | Erica `7581230` | model metadata is ignored/rejected; guidance persists; crash repair works; delivered `ifIdle` concurrency tests remain green |
| P1 | Capability role/actions, wire schemas, `ProfileControl` seam, five MCP tools, internal gate/bypass routes | `src/daemon/capabilities.ts:19-132`, `src/daemon/server.ts:938-953`, `:2375-2406`, `:3267-3914`, `src/daemon/credentials.ts:29-83`, auth docs/tests | F1 + F2 | exact role matrix/tool visibility; cross-project/completed token denied; invalid submit repairable |
| P2A | Specialized launcher core, shared routing/admission extraction, prompt, isolated runtime, run credential, shipped skill | `src/daemon/spawner-impl.ts:1417-2138`, new launcher, `src/skills/shipped.ts:17-51`, skill packaging | P1 | no worktree/branch/repo cwd; no old profile/brief/memory/land path; prompt contains all rules |
| P2B | Profiler confinement modes for Claude, Codex, and Grok | `src/adapters/tools/claude.ts:33-66`, `:267-306`, `:519-690`; `src/adapters/tools/codex.ts:32-68`, `:112-240`; `src/adapters/tools/grok.ts:12-50`, `:104-225` | P2A | effective tool surface has only inventory/submit for every supported provider; unknown versions fail closed |
| P2C | Profiler token-usage subject, aggregation, Swift presentation, and shared TS/Swift wire contract | `src/daemon/token-usage.ts:327-456`, `:761-810`; `src/schemas/token-usage.ts:30-73`; `workspace/Sources/WorkspaceCore/ModelControlSnapshot.swift:514-550`; `workspace/Sources/WorkspaceCore/TokenUsagePresentation.swift:90-125`; new `token-usage-wire.json` plus TS/Swift contract tests | P1 | measured-or-unknown profiler usage appears in `profilingSessions`, decodes in Swift, and never renders under WORKERS |
| P3 | `ProfileCoordinator`, daemon assembly, job lifecycle, capacity/deferred state | `src/daemon/server.ts:419-628`, `:963-1102`, `src/cli/daemon.ts:53-210`, new coordinator | F2 + P2B + P2C | one run under concurrent requests; first failure exact; current survives failed refresh; clean shutdown revokes token/session |
| P4 | Authoritative spawn gate and first-start daemon sequence | `src/daemon/server.ts:3610-3666`, `:2381-2406`; `src/cli/start.ts:119-136`; `src/cli/workspace.ts:232-275`; `src/cli/orchestrator.ts:411-505`; `src/cli/orchestrator-supervisor.ts:97-100`, `:146` onward | P3 | Workspace/status start while closed; worker/orchestrator denied before mutation; bypass shared and cleared on restart |
| P5 | Operator CLI and init/legacy behavior removal | `src/cli.ts:229-290`, new `src/cli/profile.ts`, `src/cli/mcp.ts:43-66`, `src/cli/init.ts:304-325`, `:524-569` | P1 + P3 | status/show/reprofile round trips; guidance provenance; `init --refresh` emits exact replacement; legacy never opens gate |
| P6 | Workspace feed, disclosure, Retry/Continue, deferred orchestrator bootstrap | `src/cli/workspace-feed.ts:1-34`, `:141-209`; `workspace/Sources/WorkspaceCore/AgentFeed.swift:66-102`; `workspace/Sources/HiveWorkspace/FeedClient.swift:25`, `:69-83`; `AppDelegate.swift:60-119`; `ProjectWindowController.swift:99-102`, `:293-307` | P4 + P5 | exact path/provider warning; exact failure; no child before allowed; two Workspace clients share daemon bypass |
| P7 | Session digest, filesystem debounce, landing immediate checks, capacity deferral | coordinator, `src/daemon/landing.ts:39-42`, `:477-532`, `src/daemon/server.ts:1485-1620`, `:2174-2222` | F1 + P3 | unchanged start launches zero; same-size edit refreshes; event storm launches one; relevant land immediate; scarce capacity defers |
| P8 | Validated-profile consumers and generic fallback; remove remaining old readers | `src/adapters/brief.ts:25-32`; `src/cli/orchestrator.ts:225-234`; `src/daemon/spawner-impl.ts:510-586`, `:1874-1942`; legacy `src/adapters/profile.ts` callers/tests | F2 + P4 | authored docs/commands used with scopes; bypass/null gets generic prompt; no runtime import of legacy profile generator |

F1 and F2 may proceed in parallel after Erica lands. P2A and P2C independently follow P1; P2B follows P2A; P3 waits for P2B and P2C. P4, P5, and P7 may be assigned in parallel after P3. P4 and P7 touch disjoint regions of `src/daemon/server.ts`, but Hive lands fast-forward-only: whichever lands second must rebase onto the first and rerun tests/typecheck before review/landing. P6 and P8 may proceed in parallel after P4. The landed cross-ecosystem fixtures in `src/adapters/project-fixtures.test-support.ts` should be consumed by F1, F2, P2B, P7, and P8 rather than copied.

## Test matrix

In addition to package-local unit tests:

- authorization: extend `src/daemon/auth.test.ts:165-274`, `:585-813` and keep docs/action matrix synchronized;
- MCP and gate: extend `src/daemon/server.test.ts:1209` onward, spawn cases around `:1276`, `:1645`, and memory-pressure cases around `:3048`;
- bootstrap: extend `src/cli/spawner-impl.test.ts:1817-1860`, prompt tests around `:2887`, plus provider tests at `src/adapters/tools/claude.test.ts:398-455` and `src/adapters/tools/codex.test.ts:170-261` and Grok equivalents;
- startup/CLI: `src/cli/start.test.ts:52-157`, `src/cli/workspace.test.ts:190-283`, new profile CLI tests;
- landing/drift: `src/daemon/landing.test.ts` and coordinator fake-clock tests, including same-size writes, ignored paths, overflow, and event storms;
- Workspace: TypeScript feed wire test plus `WorkspaceFeedWireContractTests.swift` and AppDelegate/window tests;
- multi-instance: `src/daemon/multi-instance.live.test.ts:116-262` proves each `HIVE_HOME` owns a distinct project profile/gate and duplicate profiling is permitted;
- end-to-end: empty repo, Bun/TypeScript, Cargo workspace, Python monorepo, mixed ecosystem, internal/outside symlinks, tracked secret file, huge-inventory failure, provider routing refusal, invalid-then-valid submit, crash between current/state writes, two simultaneous launchers, bypass restart.

Every package runs `bun test` and `bun run typecheck`; Swift packages also run the Workspace test command used by CI.

## Open questions and risks

1. **Gate/startup/multi-client race and lossy feed.** The daemon must bind before first profiling, yet no launcher may create an orchestrator meanwhile. Server-side checks on worker spawn plus `workspace-orchestrator`'s authenticated gate check before every orchestrator generation are the authority. Workspace feed state is three-valued UX only; missing/malformed is unknown and must never silently become a permanent closed gate. Test two Workspace processes, absent/malformed feed fields, CLI `hive_spawn`, Retry, and Continue racing against acceptance.
2. **Profiler credential scope.** File-backed credentials are instance-local, but role alone is insufficient. Authorization must bind subject to active `{projectUuid, runId}` and revoke terminal runs. Decide whether this binding lives in the capability record or coordinator lookup; do not encode trust only in a parseable subject string.
3. **Named-instance duplication.** The chosen design intentionally keeps profiles under instance-local `HIVE_HOME`; two named instances can pay for two profilers and maintain two current files. A machine-global project-profile owner could deduplicate by moving identity/profile/lock below a machine scope and having instances proxy to it, but that introduces cross-instance lifecycle, provider policy, credential, and disclosure ownership. It is outside this epic and must not leak into these interfaces.
4. **Provider confinement is version-sensitive.** Native tool names/config switches can change. A generic “read-only” flag is not evidence that shell, native reads, or web are absent. Conformance must inspect the generated effective config/argv for supported versions and fail closed for unknown versions.
5. **Inventory limits versus very large repos.** An explicit `inventory-limit` failure is safer than silently incomplete provenance, but it may force Continue Without Profile. Instrument limit failures before considering larger bounds or a streaming snapshot store; do not make caller-adjustable escape hatches in this slice.
6. **Watcher portability.** Recursive watch behavior differs by platform and may overflow. Events are optimization; session-start content digest is correctness. A platform without reliable recursive watch should report deferred watcher coverage, not claim active freshness.
7. **Routing refusal shape.** Current routing exposes structured refusals internally but throws a formatted string at `src/daemon/spawner-impl.ts:1823-1830`. Store the exact string now. If UX later needs provider-by-provider rendering, expose `LaunchRefusal[]` from the shared launch service rather than parsing prose.
8. **Two-file atomicity.** Atomic rename protects each file, not the pair. Readers must reconcile or prefer a valid current profile when state lags; tests must kill between the two writes.
9. **Guidance sensitivity.** User guidance becomes local provenance and provider prompt content. Disclosure/help should state that fact, cap it, and never echo it into ordinary agent prompts unless the accepted schema intentionally exposes it.
10. **Project-registry lost update outside profile locking.** `7581230` makes the registry temp filename process-private at `src/daemon/project-identity.ts:51-60`, fixing concurrent rename `ENOENT`, but registry persistence remains last-write-wins across processes. Concurrent first identity resolution for two different projects in one `HIVE_HOME` can lose one entry. The profile coordinator resolves its one project identity before scheduling and does not attempt to fix this broader registry ownership issue; it needs a separate project-identity owner and cross-process read-modify-write lock.

## Documentation impact for Slice 8

Do not reconcile these passages in the middle-slice implementation. The later docs package should update each precise contradiction:

- `SPEC.md:291` says derive-then-refine and never block; first agent-authored profiling now gates ordinary/orchestrator spawn unless the disclosed bypass is chosen.
- `SPEC.md:295` names one `profile.toml`; storage is now `profile/current.json` plus `profile/state.json`.
- `SPEC.md:297`, `:303`, and `:313` say generation is an instant deterministic zero-token scan; it is now a provider/model-authored background job that may send selected repo content and fail/refuse.
- `SPEC.md:299` says there is no visible staleness state, hashes paths and sizes, silently rewrites before reads, and retains `hive init --refresh`; the epic has explicit stale/profiling/failed state, content digesting, background refresh, and `hive profile reprofile`.
- `SPEC.md:301` defines `.hive/profile.override.toml`; optional user guidance is request provenance and can never bypass daemon validation.
- `SPEC.md:305` says the CLI does not call a model and `hive init` owns token-spending asks; first-run profiling is daemon-launched and disclosed instead.
- `SPEC.md:307` says profiling is not owned and “it happens”; the daemon coordinator now owns an observable lifecycle, retry, and bypass.
- `docs/agents/briefing.md:61-69` describes ubiquitous silent `ensureProfile`, one TOML cache, and a 56 ms zero-token scan.
- `docs/agents/briefing.md:71-79` argues against broad content/tree invalidation; Slice 5 explicitly requires content-based session inventory and filesystem-triggered stale/refresh. Document the new bounded inventory signal rather than preserving the old size/input-only claim.
- `docs/agents/briefing.md:81-88` says profiling is not a command and init owns token-spending asks; the supported operator commands are now `hive profile reprofile|status|show`.
- `docs/daemon/authorization.md:20-32`, `:34-67`, `:69-108`, and `:146-168` enumerate four roles/26 actions and the old route matrix; add the profiler role, four actions, five tools, internal gate/bypass routes, and credential exposure analysis.
- `docs/daemon/multi-instance.md:47-58` is not contradictory, but should explicitly name profiles as instance-local derived project state and state that duplicate profiling across named instances is expected.

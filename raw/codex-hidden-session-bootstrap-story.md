# Story: Start Codex sessions without exposing Hive's bootstrap wall

**Status:** Proposed  
**Type:** Product behavior, provider integration, and compatibility gate  
**Provider:** Codex CLI and Codex app-server  
**Minimum supported Codex CLI:** `0.144.4`  
**Evidence date:** 2026-07-15

## Story

As a Hive user, I want a Codex orchestrator or worker to open without displaying
Hive's full role, protocol, worktree, memory, and document briefing as my first
message, so that the session begins with a clean composer or a concise assignment
instead of a wall of implementation text.

As a user inspecting a worker, I want the real assignment to remain visible, so
that removing the bootstrap wall does not make the session opaque or leave me
guessing what the agent was asked to do.

As Hive, we want role and policy text to retain developer-level precedence, so
that improving the presentation does not weaken the orchestrator's or worker's
behavioral contract.

As a Hive operator, I want Hive to refuse Codex versions that do not implement
the required developer-instruction surfaces, so that an old CLI cannot silently
turn hidden setup back into a visible user prompt or launch an under-instructed
agent.

## Outcome

After this story ships:

1. A fresh Codex orchestrator opens at an empty composer. Hive's orchestrator
   brief is present as developer instructions, not as a user message. The first
   real user request is the first user turn.
2. A recovering Codex orchestrator receives the recovery state as developer
   instructions and, when an automatic recovery turn is required, displays only
   the short user message `Resume Hive orchestration.`
3. A Codex worker displays only its actual assignment as the initial user
   message. Its identity, Hive protocol, worktree rules, coding rules, scoped
   documentation, graph context, and memory index are developer instructions.
4. The TUI, app-server, app-server-to-TUI fallback, critical restart, and crash
   resume paths preserve the same instruction content and ordering.
5. Hive requires Codex CLI `>= 0.144.4` before authorizing any new Codex process.
6. Claude and Grok launch prompts remain byte-for-byte unchanged.

This story changes presentation and message roles. It does not promise a token
reduction: developer instructions still consume model context.

## The current defect

Hive currently treats the entire bootstrap as user input on every Codex path.

### Orchestrator

`buildOrchestratorCommand` combines `ORCHESTRATOR_BRIEF`, recovery state,
repository document guidance, and the memory index into one `brief`, then places
that string in Codex's positional `[PROMPT]` slot:

- `src/cli/orchestrator.ts:247-249` builds the combined brief.
- `src/cli/orchestrator.ts:267-297` appends it as the final Codex argument.
- `src/cli/orchestrator.ts:329-348` forwards that positional prompt through the
  remote TUI that connects to the root app-server authority.

Codex correctly renders a positional prompt as a user message. The wall is
therefore expected behavior for the command Hive builds.

### Worker TUI

`buildAgentPrompt` combines the worker identity, task, protocol, coding rules,
landing rules, scoped documentation, graph context, and memory index into one
string at `src/daemon/spawner-impl.ts:615-669`.

The spawn path writes that string to a launch file and shell-expands it as the
single positional prompt at `src/daemon/spawner-impl.ts:2047-2107`. The launch
file avoids tmux's approximately 16 KiB command ceiling, but the content is still
a Codex user prompt and is therefore rendered in the conversation.

### Worker app-server

The app-server manager creates a thread without developer instructions at
`src/adapters/tools/codex-app-server.ts:388-394`, then sends the entire combined
prompt as `turn/start.input` at `src/adapters/tools/codex-app-server.ts:418-427`.
That is also explicitly a user turn.

The app-server host renderer currently ignores user-message item events, so its
plain terminal pane often does not show the wall. That is only a rendering side
effect. The rollout still records Hive's setup as user input, and a richer client
or later attachment can expose it.

### Outdated assumption

`test/cli/spawner-impl.test.ts:3139` says that Codex has no
`--append-system-prompt` and therefore the prompt must carry all rules. The first
half remains true, but the conclusion is obsolete. Codex now provides explicit
developer-instruction channels; Hive does not need a Claude-shaped flag to solve
the problem.

## Verified Codex basis

The implementation must rely only on the following verified surfaces.

### Configuration override

The current Codex configuration reference defines:

```toml
developer_instructions = "Additional developer instructions injected into the session"
```

The installed Codex CLI `0.144.4` accepted this session flag:

```text
codex app-server --stdio -c 'developer_instructions="HIVE_SENTINEL_9f23"'
config/read -> config.developer_instructions = "HIVE_SENTINEL_9f23"
origin -> sessionFlags
```

No thread, turn, model request, or billable work was started for that check.

### Stable app-server field

Bindings generated by the installed CLI without `--experimental` include:

```ts
type ThreadStartParams = {
  // ...
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  // ...
};
```

Generate the version-local schema when reproducing this evidence:

```bash
codex app-server generate-ts --out /tmp/codex-app-server-schema
```

`developerInstructions` is present on stable `thread/start` and
`thread/resume`. It does not require `initialize.capabilities.experimentalApi`.

### SessionStart hook fallback

Codex also documents that plain stdout from a `SessionStart` hook, or
`hookSpecificOutput.additionalContext`, is added as developer context. This is
a valid fallback mechanism, but it is not the primary design in this story.
Hive should use the direct configuration and app-server fields because they
state the session contract at thread creation and do not couple role setup to
hook execution.

### Sources

- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Codex SessionStart hooks](https://learn.chatgpt.com/docs/hooks#sessionstart)

## Product decisions

These are decisions, not open implementation choices.

1. Use `developer_instructions` for Codex TUI sessions.
2. Use `thread/start.developerInstructions` for Codex app-server sessions.
3. Do not use `baseInstructions` or `model_instructions_file`; those replace
   Codex's built-in instruction set instead of adding Hive's contract.
4. Do not create or rewrite `AGENTS.md`. Hive's role, agent name, assignment,
   worktree, recovery state, and scoped brief are session-specific, not durable
   repository conventions.
5. Do not hide the worker's actual assignment. It remains the concise initial
   user prompt.
6. Do not create a synthetic acknowledgement turn for a fresh orchestrator. A
   fresh root opens idle and creates its thread when the user sends the first
   real request.
7. A recovery launch may create one short automatic turn when recovery work
   must begin before another user message.
8. Treat developer instructions as presentation-private, not secret. They may
   be persisted in Codex rollout metadata, inspected through configuration
   diagnostics, or appear in process arguments after shell expansion. Never put
   credentials or other secrets in them.
9. Gate Codex at `0.144.4`. That is the first version Hive has verified for the
   complete behavior required by this story. Do not infer that an earlier build
   is safe merely because it parses one similarly named field.
10. A future story may lower the minimum only after reproducing the complete
    TUI, remote-root, app-server, resume, and fallback acceptance matrix on that
    older build.

## Prompt partition contract

Introduce a structured bootstrap value at the point where Hive currently builds
one undifferentiated string:

```ts
export interface CodexSessionBootstrap {
  developerInstructions: string;
  initialUserPrompt?: string;
}
```

For workers, `initialUserPrompt` is required. For a fresh orchestrator it is
absent. For orchestrator recovery it is either absent or exactly the short
recovery trigger chosen below.

### Developer instructions contain

- Orchestrator or worker identity and role.
- Agent name and read-only/writer designation.
- Worktree and file-scope constraints.
- Hive MCP coordination and delivery rules.
- Continuous-execution and capability-escalation rules.
- Coding guidelines and search hygiene.
- Read-only or landing protocol.
- Scoped documentation excerpts and file/line references.
- Graphify guidance and graph brief.
- Memory index.
- Orchestrator recovery state, repository document guidance, and root memory
  index.

### User prompt contains

- Worker: the task text supplied to `hive_spawn`, without the setup blocks
  repeated around it.
- Fresh orchestrator: nothing until the user types a real request.
- Recovering orchestrator: `Resume Hive orchestration.` only when the supervisor
  needs an immediate recovery turn.
- Critical worker restart: the existing critical control message. It remains a
  user/control turn because it is new runtime direction, not durable role setup.
- Later Hive deliveries: unchanged; they remain turns, steering input, or
  provider-native control messages according to their delivery semantics.

The developer instructions must reach Codex before the first user prompt. A
worker must never receive its task first and its role in a later turn.

## Detailed implementation instructions

### 1. Add a centralized Codex version gate

Add the provider-owned constant and pure comparison logic beside the Codex
adapter, not in UI code:

```ts
export const MINIMUM_CODEX_CLI_VERSION = "0.144.4";
```

Expose two operations:

```ts
parseCodexCliVersion(output: string): ParsedVersion | null
codexCompatibilityRefusal(version: string | null): string | null
```

Requirements:

1. Read the version with `codex --version`. This opens no session and spends no
   prompt.
2. Accept the installed output shape `codex-cli X.Y.Z`.
3. Compare numeric major, minor, and patch components. Never compare versions
   lexicographically.
4. Accept `0.144.4` and higher release versions.
5. Reject versions below `0.144.4`.
6. Reject an unparseable or missing version. Unknown is not permission.
7. Reject prereleases of the minimum release, such as `0.144.4-alpha.1`, because
   the verified floor is the final `0.144.4` build. Build metadata may be ignored
   for precedence.
8. Do not add a semver dependency solely for this three-component gate. Keep the
   parser provider-specific and covered by table tests.

Do not leave a second incompatible version parser in
`src/daemon/capability-discovery.ts:424-443`. Extract or reuse the parsing
primitive so capability inventory and launch compatibility report the same
version string.

#### Integrate the gate into routed worker authorization

Extend `LaunchRefusalReason` and `LaunchGateChecks` in
`src/daemon/authorized-launch.ts` with a `compatibility` guard. Run it before
model resolution so a known-incompatible provider does not perform unnecessary
catalog work.

For Claude and Grok, the compatibility guard returns `null`. For Codex it reads
and checks the current CLI version. Within one spawn decision, memoize the
`codex --version` promise so a chain containing several Codex models invokes the
binary once, not once per model.

This placement is load-bearing:

- A Codex link below the minimum is refused with reason `compatibility`.
- An ordered, non-explicit route may continue to the user's next enabled link.
- An explicit Codex tool/model fails closed and is not silently substituted.
- The refusal appears with the other per-link reasons when every route fails.
- Quota is not reserved and a worktree is not created for a candidate that
  cannot pass the version gate.

Apply the same compatibility guard in `HiveSpawner.authorizeLaunch`. Critical
restarts and crash recovery already re-enter that full authorization boundary
through `src/daemon/server.ts:839-840`; they must not bypass the minimum after a
user downgrades Codex between the original spawn and resume.

#### Gate the orchestrator

Replace the deliberately empty Codex version arm at
`src/cli/orchestrator.ts:440-443` with the same minimum check.

Run it before:

- killing or replacing the current orchestrator tmux session;
- minting the Codex root capability token;
- starting the root app-server authority; or
- creating an automatic recovery turn.

An unsupported Codex orchestrator has no provider fallback because the user
selected the root provider explicitly. Return a direct error:

```text
Codex CLI 0.144.3 is unsupported. Hive requires Codex CLI >= 0.144.4 because
Codex session bootstrap uses developer instructions instead of a visible user
prompt.
Fix: update Codex, then reopen Hive.
```

For an unreadable version:

```text
Hive could not determine the Codex CLI version from `codex --version` and
refuses to start an under-instructed Codex session.
Fix: repair or update Codex, then reopen Hive.
```

Provide an injected version-reader seam in orchestrator and spawner tests; no
unit test should depend on the developer machine's installed Codex.

### 2. Split Codex worker bootstrap without changing other providers

Refactor the construction around `buildAgentPrompt`, but preserve the existing
public function as the combined-prompt compatibility wrapper used by Claude,
Grok, and existing tests.

Recommended shape:

```ts
interface AgentPromptParts {
  developerInstructions: string;
  userPrompt: string;
  combinedPrompt: string;
}

function buildAgentPromptParts(/* current inputs */): AgentPromptParts

export function buildAgentPrompt(/* current inputs */): string {
  return buildAgentPromptParts(/* inputs */).combinedPrompt;
}
```

Construction rules:

1. Build the role and rule blocks once; do not duplicate the large prompt
   templates in a Codex-only copy.
2. Preserve the current combined block order exactly, including the early
   `Your task:` line, so Claude and Grok behavior does not move as collateral
   cleanup.
3. Build Codex `developerInstructions` from every block except the task line.
4. Set Codex `userPrompt` to the original task text. A short label such as
   `Your assigned task:` is acceptable, but no role or protocol block may be
   repeated.
5. Preserve the concise-category behavior. Trimming narration must not drop a
   rule from developer instructions.
6. Preserve read-only, landing, graphify, memory, and scoped-brief ordering.

Add a regression test that compares `buildAgentPrompt` before and after the
refactor for representative concise writer, full writer, and read-only inputs.
The expected Claude/Grok strings must not change.

### 3. Carry TUI developer instructions through a file-backed config override

Do not inline the full developer instructions in the tmux command. Hive already
measured tmux rejecting commands around 20 KiB, and scoped briefs exceed that
ceiling by design.

Extend `src/daemon/launch-prompt.ts` with two distinct 0600 artifacts under
`HIVE_HOME/runtime/prompts`:

```text
<tmux-session>.developer.toml
<tmux-session>.user.txt
```

The developer file contains one complete Codex config override, not raw prose:

```text
developer_instructions=<TOML string literal>
```

Use the repository's existing TOML-string convention (`JSON.stringify`) so
quotes, newlines, backslashes, and Unicode produce one valid override value.
The user file contains the raw assignment or short recovery trigger.

The launch shell must expand each file as exactly one argument:

```sh
codex [OPTIONS] -c "$(cat '/path/session.developer.toml')" \
  "$(cat '/path/session.user.txt')"
```

Requirements:

1. `-c` appears before Codex's positional `[PROMPT]`.
2. The tmux command string contains only artifact paths, never the role text or
   task text.
3. The developer artifact and user artifact are written before tmux starts.
4. Both files are mode `0600`; their parent remains mode `0700`.
5. One session name maps to one pair of files, overwritten on a new generation,
   matching today's bounded prompt-file lifecycle.
6. The shell builder must remain correct for spaces, apostrophes, newlines,
   dollar signs, and command-substitution text inside either payload.
7. The content is not advertised as secret: after shell expansion it may be
   visible in the Codex process argument list.

Create one dedicated Codex TUI shell builder and use it in all three places:

- normal TUI worker spawn;
- app-server handshake fallback to TUI; and
- critical-control replacement that starts a new Codex TUI.

Do not keep three hand-built concatenations of `shellJoin(...) + promptSuffix`.
The current normal and fallback paths already drift together; this story adds a
second ordered argument and must centralize that ordering.

#### Resume command ordering

`codex resume` has two positionals: `[SESSION_ID] [PROMPT]`. Reapply the
developer override before `SESSION_ID`:

```sh
codex resume [OPTIONS] -c "$(cat '/path/session.developer.toml')" SESSION_ID
```

Do not send the original assignment again on crash resume. The existing thread
already contains that user turn. Reapplying developer instructions is idempotent
session configuration; replaying the task is a duplicate action.

Restructure the Codex resume command builder enough to distinguish option
arguments from positional arguments. Do not append `-c` after `SESSION_ID`, and
do not introduce a general command AST for this single ordering need.

For a session created by an older Hive release, the developer artifact will be
absent. Resume that legacy session with today's command because its original
visible user prompt already contains the Hive contract. Do not rewrite vendor
rollout history. Log one concise diagnostic that the session uses legacy visible
bootstrap semantics; all newly created sessions must have the artifact.

### 4. Start the Codex root with developer instructions and no fresh prompt

Build the existing combined root brief exactly as today. Serialize it into the
root session's `.developer.toml` artifact rather than appending it to
`buildOrchestratorCommand("codex", ...)` as `[PROMPT]`.

`buildCodexRootAuthorityCommand` must apply the same file-backed override to the
root app-server authority and its remote TUI. Preserve the existing rule that
authority-owned configuration is replayed to the authority before the remote
client connects.

Conceptual command:

```sh
codex app-server --listen unix://... \
  -c "$(cat '/path/hive-orchestrator.developer.toml')" &

codex --remote unix://... --no-alt-screen \
  -c "$(cat '/path/hive-orchestrator.developer.toml')"
```

Fresh launch requirements:

- Do not provide positional `[PROMPT]`.
- Do not start a model turn merely to acknowledge the role.
- Leave the composer empty and ready for the user.
- The first user request creates the root thread with the configured developer
  instructions.

Recovery requirements:

- Add `recoveryBrief` to developer instructions, as today.
- If `recoveryBrief` is non-empty and the supervisor requires the root to act
  immediately, pass one user prompt file containing exactly
  `Resume Hive orchestration.`
- If recovery can wait for the user, omit the prompt and open at the composer.
- Do not display the durable recovery state as a user message.

The root-delivery path must tolerate the interval before a fresh user creates
the first thread. A message that arrives before a root thread exists remains
durably queued and is flushed after the first thread is observed. Do not create
a hidden synthetic user turn solely to obtain a thread id.

### 5. Use native developer instructions on app-server workers

Change the app-server manager boundary from one undifferentiated `prompt` string
to `CodexSessionBootstrap`.

At `thread/start`, send:

```ts
{
  // current model/cwd/approval/sandbox fields
  developerInstructions: bootstrap.developerInstructions,
}
```

At the first `turn/start`, send:

```ts
{
  threadId,
  input: [{ type: "text", text: bootstrap.initialUserPrompt }],
  effort,
}
```

Requirements:

1. Keep `experimentalApi: false`; this story depends only on the stable field.
2. Reject a worker bootstrap without `initialUserPrompt` before creating its
   first turn.
3. Keep later `startTurn`, `steer`, `deliver`, and interrupt behavior unchanged.
4. Keep the TUI artifacts available before attempting app-server startup so an
   automatic handshake fallback receives the same developer/user partition.
5. On `thread/resume`, reapply `developerInstructions` when Hive owns the
   original artifact. Do not resend the assignment.
6. Do not use `thread/inject_items`; injected raw history is not a substitute
   for a thread-level developer contract.

### 6. Preserve critical-control and crash-recovery semantics

Critical control is new direction and remains visible. The role setup is not.

For a critical restart:

1. Reuse the persisted worker developer artifact.
2. Start the replacement process read-only as today.
3. Send only `controlPrompt` as the new user prompt.
4. Do not overwrite the developer artifact with `controlPrompt`.
5. Keep capability epoch, acknowledgement, teardown verification, and quota
   behavior unchanged.

For crash recovery:

1. Re-enter the full launch gate, including Codex compatibility.
2. Refuse recovery on a downgraded or unreadable Codex version.
3. Preserve the worktree and report the compatibility reason; recovery may not
   switch the recorded agent to another provider.
4. Reapply the developer override before the session id when the artifact is
   present.
5. Send no initial prompt, avoiding duplicate work.
6. Allow legacy sessions without an artifact to resume under their existing
   visible bootstrap history.

### 7. Remove obsolete claims and align comments

Update comments and tests that say the user prompt is Codex's only carrier.
Replace them with the actual invariant:

```text
Codex has no Claude-style --append-system-prompt. Hive supplies durable setup
through Codex developer instructions and reserves user input for the assignment.
```

Do not change Claude's `--append-system-prompt` behavior or Grok's prompt path in
this story.

## Version-gate behavior by context

| Context | Codex below `0.144.4` | Required result |
|---|---|---|
| Explicit Codex orchestrator | Refuse | Print update remedy; start no root process |
| Explicit Codex worker/model | Refuse | No provider substitution |
| Routed worker, later enabled provider exists | Refuse Codex link | Continue through the user's configured route |
| Routed worker, all links fail | Refuse spawn | Include Codex compatibility reason with all link failures |
| Codex crash resume | Refuse recovery | Preserve worktree and recorded session; report operator action |
| Codex critical restart | Refuse replacement | Preserve stopped/stuck safety state; never restart under old CLI |
| Claude or Grok launch | Not applicable | Do not invoke `codex --version` |

The gate is a minimum, not a protocol-version negotiation. Codex app-server does
not expose a numeric protocol version in `initialize`, so the CLI version is the
only stable pre-launch identity Hive can check. Higher future versions still run
through all existing handshake and readiness checks.

## Documentation work

Documentation is part of the story, not a follow-up.

### README

Update `README.md`:

- Add Codex CLI `>= 0.144.4` to prerequisites or provider setup.
- Explain that Codex role setup is supplied as developer instructions and does
  not appear as the first user message.
- State that worker assignments remain visible.
- Keep the optional `[codex] driver = "app-server"` configuration documented,
  but do not present it as the fix for prompt visibility; both drivers must pass.
- Include the exact error remedy for an old Codex installation.

### Provider launch mechanics

Update `docs/providers/launch-mechanics.md`:

- Record `developer_instructions` and
  `thread/start.developerInstructions` as the Codex bootstrap surfaces.
- Record the 0.144.4 verification date and commands.
- Explain why TUI developer instructions use a file-backed config override:
  tmux sees a short file path while Codex receives one parsed `-c` value.
- Separate presentation privacy from secrecy.
- Document fresh root, recovery root, worker, fallback, and resume behavior.
- Remove any claim that the positional prompt must carry Codex rules.

### Capability discovery and routing

Update `docs/providers/capability-discovery.md`:

- Record `codex --version` as a free, no-thread compatibility observation.
- Document `MINIMUM_CODEX_CLI_VERSION = 0.144.4` and the fail-closed parser.
- Explain that compatibility is part of the full per-link launch gate, so a
  non-explicit route may continue while an explicit selection may not.
- State that the model catalog's stored `cliVersion` is evidence about the
  catalog read, while the launch gate checks the currently installed binary.

### Recovery documentation

Update the appropriate daemon recovery document or add a short section to
`docs/providers/launch-mechanics.md` if no narrower document owns it:

- New Codex sessions persist a developer override artifact under HIVE_HOME.
- Crash resume reapplies it without replaying the task.
- Legacy sessions without the artifact resume with their original visible
  bootstrap history.
- A downgraded CLI refuses resume and preserves the worktree.

### Evidence log

Add a concise entry to `docs/log.md` after live acceptance, recording:

- Codex CLI version and platform.
- Fresh root visual result.
- TUI worker visual result.
- app-server worker wire result.
- recovery and fallback result.
- The generated-schema command and evidence location.

Do not paste credentials, account details, full prompts, or rollout contents into
the log.

## Tests

### Unit tests: version compatibility

Use a table covering at least:

| Input | Result |
|---|---|
| `codex-cli 0.144.4` | accept |
| `codex-cli 0.144.5` | accept |
| `codex-cli 0.145.0` | accept |
| `codex-cli 1.0.0` | accept |
| `codex-cli 0.144.3` | refuse |
| `codex-cli 0.143.99` | refuse |
| `codex-cli 0.144.4-alpha.1` | refuse |
| `codex-cli 0.144.4+build.7` | accept |
| `unknown` | refuse |
| empty output | refuse |
| malformed version | refuse |

Prove numeric comparison with a case such as `0.144.10 > 0.144.4`.

### Unit tests: launch gate

1. Compatibility runs before resolution.
2. A routed Codex refusal leaves the next provider eligible.
3. An explicit Codex request reports compatibility and does not substitute.
4. Several Codex models in one route invoke the version reader once.
5. Claude/Grok-only routes never invoke the Codex reader.
6. Revalidation immediately before adapter launch includes compatibility.
7. Critical restart and crash recovery inherit the same refusal.

### Unit tests: orchestrator command

1. The full root brief is in the developer artifact, not a positional prompt.
2. Fresh root authority and remote TUI both receive the file-backed `-c` value.
3. Fresh root has no positional `[PROMPT]`.
4. Recovery state remains in developer instructions.
5. Automatic recovery shows only `Resume Hive orchestration.`
6. Codex below the minimum fails before session teardown or token minting.
7. Claude and Grok command snapshots remain unchanged.

### Unit tests: worker prompt partition

For concise writer, full writer, and reader:

1. Developer instructions contain every rule expected by today's rule-coverage
   test.
2. Developer instructions do not contain the `Your task:` block.
3. User prompt contains the task and none of the role/protocol preamble.
4. `combinedPrompt` matches the pre-change string used by Claude and Grok.
5. Scoped brief, graph brief, Graphify directive, memory index, and landing or
   read-only protocol remain present exactly once.

### Unit tests: TUI shell transport

1. The tmux command contains only artifact paths, not prompt sentinels.
2. `-c` precedes the user prompt.
3. A 64 KiB developer instruction payload does not enlarge the tmux command
   beyond the path-sized form.
4. Quotes, newlines, apostrophes, dollar signs, backticks, and literal `$()` text
   survive as data.
5. The developer override parses through Codex `config/read` in a no-turn
   integration fixture.
6. Normal spawn, app-server fallback, and critical restart use the same builder.
7. Resume places `-c` before `SESSION_ID` and sends no duplicate task.

### Unit tests: app-server wire

Update the fake transport assertions to prove:

1. `thread/start.params.developerInstructions` contains the role and rules.
2. `turn/start.params.input[0].text` contains only the assignment.
3. `experimentalApi` remains `false`.
4. Fallback receives the same partition.
5. Resume reapplies developer instructions and does not start a task turn.

### Integration and live acceptance

Run against the exact installed release that sets the minimum:

```text
codex-cli 0.144.4
```

Capture evidence for:

1. Fresh Codex root opens with an empty composer and no bootstrap wall.
2. The first real user request causes the root to identify and behave as queen.
3. A TUI worker shows one concise assignment and follows all Hive coordination,
   scope, search, and landing rules.
4. An app-server worker receives the same contract on the wire and the same
   concise assignment as its user turn.
5. A forced app-server handshake failure falls back to a TUI without exposing
   the setup wall.
6. A root recovery displays only the short recovery trigger and acts from the
   hidden durable recovery context.
7. A worker crash resumes without repeating its assignment.
8. A critical restart displays only the control order and remains read-only.
9. Temporarily substitute version outputs below, at, and above the floor and
   verify gate behavior without launching a model turn.
10. A legacy rollout created before this story still resumes.

Redact prompt content from captured process listings and protocol evidence.

## Acceptance criteria

This story is complete only when all of the following are true.

1. Hive refuses every Codex CLI below `0.144.4` and every unreadable Codex
   version before authorizing a Codex launch.
2. The version gate participates in routed per-link refusal, explicit selection,
   revalidation, critical restart, crash recovery, and root launch.
3. A fresh Codex orchestrator displays no Hive bootstrap user message and starts
   no acknowledgement turn.
4. A recovering orchestrator never displays the full recovery brief as user
   input.
5. A Codex worker's first user message contains only its assignment.
6. Every rule previously carried by the worker prompt is present once in
   developer instructions.
7. The TUI path uses `developer_instructions` through a file-backed `-c`
   override; no large bootstrap enters the tmux command payload.
8. The app-server path uses stable `thread/start.developerInstructions` with
   `experimentalApi: false`.
9. Normal TUI, app-server, automatic fallback, critical restart, and crash
   resume pass the same prompt-partition tests.
10. Crash resume does not replay the original task.
11. Legacy Codex sessions without a developer artifact still resume.
12. Claude and Grok launch prompt snapshots do not change.
13. Developer and user artifacts are stored below HIVE_HOME with modes 0600 and
   are referenced safely from paths containing spaces and apostrophes.
14. README, provider launch mechanics, capability discovery, recovery guidance,
   and the live evidence log are updated.
15. Live acceptance on Codex CLI 0.144.4 proves the root, TUI worker,
   app-server worker, fallback, recovery, and critical-control experiences.

## Non-goals

- Reducing model input tokens.
- Hiding instructions from filesystem owners, process inspectors, Codex
  diagnostics, or rollout inspection.
- Replacing the Codex TUI with a Hive transcript UI.
- Changing Claude's system-prompt handling.
- Changing Grok's prompt handling.
- Changing assignment wording beyond making it concise and separating setup.
- Rewriting existing Codex rollout history.
- Adding a user preference to restore the wall of text.
- Claiming protocol compatibility for Codex releases older than 0.144.4.
- Replacing the current app-server driver selection or making app-server the
  default as part of this work.

## Rollout order

Implement and land in this order so every intermediate state fails safely:

1. Add the pure version parser, compatibility refusal, and tests.
2. Insert compatibility into the authorized-launch gate and root launch.
3. Add prompt partitioning while retaining the old combined wrapper.
4. Add developer/user artifacts and the shared Codex TUI shell builder.
5. Move the normal worker TUI and fallback paths to the shared builder.
6. Move root bootstrap to developer instructions and remove its fresh prompt.
7. Move app-server `thread/start` to `developerInstructions` and shorten its
   first `turn/start` input.
8. Update critical restart and crash resume.
9. Run unit and no-turn protocol tests.
10. Update documentation.
11. Run live acceptance on 0.144.4 and record evidence.

Do not remove the visible prompt carrier until the version gate and the target
developer-instruction carrier are both tested. An intermediate build must
prefer the old visible, fully instructed session over a clean-looking but
under-instructed one.

## Implementation checklist

- [ ] `MINIMUM_CODEX_CLI_VERSION` is `0.144.4` in provider-owned code.
- [ ] Version parsing is shared with capability inventory where appropriate.
- [ ] Authorized launch has a `compatibility` refusal reason.
- [ ] Routed fallback and explicit fail-closed behavior are tested.
- [ ] Root launch is version-gated before mutation.
- [ ] Worker prompt construction returns developer/user parts.
- [ ] Claude/Grok combined prompts are unchanged.
- [ ] Developer and user artifacts are separate and mode 0600.
- [ ] Codex TUI spawn uses file-backed `-c developer_instructions`.
- [ ] Root authority and remote TUI receive the same developer override.
- [ ] Fresh root sends no positional prompt.
- [ ] Recovery root sends only the short trigger when needed.
- [ ] App-server `thread/start` carries `developerInstructions`.
- [ ] App-server first turn carries only the assignment.
- [ ] Fallback, critical restart, and crash resume preserve the partition.
- [ ] Resume does not replay the assignment.
- [ ] Legacy sessions remain recoverable.
- [ ] Obsolete prompt-carrier comments are removed.
- [ ] README and provider/recovery docs are updated.
- [ ] Live 0.144.4 evidence is recorded without prompt or account data.


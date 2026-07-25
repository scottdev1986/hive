# Kimi TUI transport contract

Date verified: 2026-07-24 (America/New_York)

Kimi Code CLI: `0.29.1`

## Decision

Hive must launch Kimi as an ordinary TUI and deliver every user turn through
sessiond's atomic terminal submission. The `kimi web` REST server is a separate
executor. It can open the same persisted session as a live TUI, append a
completed user turn to that session, and return success while the bound TUI
does no work.

**Hard rule: never POST a prompt, prompt action, or steer request to a Kimi
session that has a live TUI bound to it.** Doing so creates a parallel executor
that mutates the shared persisted session. Transcript mutation is not proof of
delivery to the bound provider run.

The rejected web-owned design would require Hive to own a server process and
capture its bearer token for every Kimi agent. The address registry does not
contain the token, so Hive cannot safely attach to a server it did not launch.
That is more lifecycle and security machinery than the terminal transport
already shared by all providers, and it introduces two possible executors for
one conversation. Hive therefore does not build or use a Kimi web transport.

## Empirical findings

Commands below were run on 2026-07-24. Values shown as `<server-id>`,
`<token>`, `<session-id>`, and `<session-dir>` are specimen values, never
contract constants.

### 1. `kimi web` reachability — confirmed, but not attached to a TUI

Current help:

```sh
kimi --version
kimi web --help
```

reported version `0.29.1`, default loopback host `127.0.0.1`, default port
`58627`, `--port <port>`, `--host [host]`, bearer authentication, and
`--dangerous-bypass-auth`. The probe used:

```sh
kimi web --port 0 --no-open --log-level info
```

The CLI chose an ephemeral loopback port and printed:

```text
Kimi server: http://127.0.0.1:<port>/#token=<token>
```

It also created:

```text
~/.kimi-code/server/instances/<server-id>.json
```

with this exact shape:

```json
{
  "server_id": "<server-id>",
  "pid": 6419,
  "host": "127.0.0.1",
  "port": 63404,
  "started_at": 1784939102766,
  "heartbeat_at": 1784939102801,
  "host_version": "0.29.1"
}
```

The PID, port, and timestamps are specimen data. The important finding is that
the file contains the address but **not the bearer token**. Without an
`Authorization: Bearer <token>` header:

```sh
curl -i http://127.0.0.1:<port>/api/v1/meta
```

returned HTTP 401:

```json
{"code":40101,"msg":"Unauthorized","data":null,"request_id":"<request-id>"}
```

With the startup token, `GET /api/v1/meta` returned server version, server ID,
start time, capability flags, `dangerous_bypass_auth: false`, and
`backend: "v2"`.

For any machine, the only honest discovery procedure for an already running
server is to enumerate `~/.kimi-code/server/instances/*.json`, validate the PID
and heartbeat, and read its host and port. That procedure cannot discover the
credential. A caller can obtain the credential only by launching the server
and capturing its startup output (or by out-of-band user provisioning). Hive
does neither for a TUI agent.

The vendor session index is:

```text
~/.kimi-code/session_index.jsonl
```

Each observed row had:

```json
{"sessionId":"session_<uuid>","sessionDir":"<absolute-session-dir>","workDir":"<absolute-work-dir>"}
```

For a newly launched TUI, a reader snapshots the index before launch, then
binds the one new row whose `workDir` and creation time match the launch. It
validates `state.json` in the returned `sessionDir`. If zero or multiple rows
match, session discovery is unknown and structured file observation must
degrade to terminal/process evidence; it must not guess. The reader uses
`sessionDir` from the index and never recreates the workspace hash.

The per-agent wire is:

```text
<sessionDir>/agents/<agent-id>/wire.jsonl
```

The main TUI agent is `<sessionDir>/agents/main/wire.jsonl`; `state.json` is the
agent roster. This path is measured from the index, not hardcoded to a project,
user, port, or session ID.

### 2. Session status — confirmed on the web server; unnecessary for TUI observation

There is no global `GET /api/v1/status`; it returned HTTP 404. The real route is:

```sh
curl -H 'Authorization: Bearer <token>' \
  http://127.0.0.1:<port>/api/v1/sessions/<session-id>/status
```

For idle `john`, the exact response shape was:

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "busy": false,
    "model": "kimi-code/k3",
    "thinking_level": "high",
    "permission": "auto",
    "plan_mode": false,
    "swarm_mode": false,
    "context_tokens": 0,
    "max_context_tokens": 1048576,
    "context_usage": 0
  },
  "request_id": "<request-id>"
}
```

After the REST-owned probe turn it reported `context_tokens: 35199`,
`max_context_tokens: 1048576`, and
`context_usage: 0.033568382263183594`.

This status is the web server's in-memory view of the persisted session. It is
not a run binding to an independently running TUI. Hive must not start a server
merely to read it.

File-only observation provides the needed facts:

- Config-only wire with a live, verified foreground TUI and no open turn is
  idle.
- `turn.prompt` opens a turn.
- A final `step.end` with `finishReason: "end_turn"` closes it.
- `turn.cancel` interrupts and closes it. A tool result may be appended just
  after cancellation as cleanup.
- `tool.call` without its matching `tool.result` identifies an open tool
  boundary, but the containing turn remains busy after the result until its
  final `step.end`.
- Latest `usage.record.usage` fields sum to current context tokens. In the
  probe, `23611 + 68 + 11520 + 0 = 35199`, exactly matching `/status`.
  `llm.request.maxTokens` was `1048576`, exactly matching
  `max_context_tokens`; their ratio reproduces `context_usage`.

Every derived state is paired with measured foreground process identity.
Malformed JSON, an incomplete tail record, ambiguous session binding, a dead
process, or a stale open turn yields `unknown`, never idle or busy by guess.
Thus no HTTP server, port, or token is required for Kimi TUI observation.

### 3. POST to idle `john` — HTTP success, live-TUI delivery refuted

Baseline:

```sh
wc -l -c <session-dir>/agents/main/wire.jsonl
lsof -nP -p <john-tui-pid> | rg '/dev/ttys004'
```

showed seven startup/config records, 79,512 bytes, and 8,111 bytes written by
the TUI to its tty.

The decisive request was:

```http
POST /api/v1/sessions/<john-session-id>/prompts
Authorization: Bearer <token>
Content-Type: application/json

{"content":[{"type":"text","text":"Reply with the single word ACKNOWLEDGED and nothing else, then stop."}]}
```

It returned HTTP 200:

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "prompt_id": "msg_01KYBAM83S2RN97JM7F6Y0FKF1",
    "user_message_id": "msg_01KYBAM83S2RN97JM7F6Y0FKF1",
    "status": "running",
    "content": [
      {
        "type": "text",
        "text": "Reply with the single word ACKNOWLEDGED and nothing else, then stop."
      }
    ],
    "created_at": "2026-07-25T00:25:59.673Z"
  },
  "request_id": "<request-id>"
}
```

The web server process executed the turn and appended ten records to the shared
wire: `turn.prompt`, the user `context.append_message` with the returned
message ID, `step.begin`, `llm.request`, usage, assistant thinking/text, and
`step.end`. `GET /transcript?agent_id=main` showed completed turn `t0` and
assistant text `ACKNOWLEDGED`.

That did **not** wake the bound TUI executor. During the complete REST turn,
the original TUI process remained sleeping and its tty write offset remained
exactly 8,111 bytes. The newly launched web-server process consumed the model
work. The TUI later redrew after noticing shared-session mutation (the tty
offset later became 10,679), but a redraw is not execution and does not prove
receipt.

The injected user-origin turn is permanent session pollution. Nothing in these
wire records identifies the executor PID or provider-run ID. A transcript
reader bound only by session ID would falsely report that the TUI-bound agent
ran the turn. Session ID is therefore insufficient authority: Hive also needs
its ProviderRun/foreground binding and the single-executor prohibition above.

Conclusion: the §6 Kimi kickoff path is refuted. Held `begin` or later messages
must not be resubmitted through REST. They must be submitted through the bound
terminal.

### 4. `prompts:steer` — endpoint confirmed; TUI steer claim refuted

The live server's authenticated `GET /openapi.json` documents:

```text
POST /api/v1/sessions/{session_id}/prompts:steer
```

with description `Steer queued prompts into the active turn` and body:

```json
{"prompt_ids":["<queued-web-prompt-id>"]}
```

It does not accept steer text. It only promotes prompt IDs already queued in
that web server's prompt service. The related
`POST /api/v1/sessions/{session_id}/prompts/{tail}` performs prompt actions.

A probe with no web-owned active prompt:

```http
POST /api/v1/sessions/<session-id>/prompts:steer
Authorization: Bearer <token>
Content-Type: application/json

{"prompt_ids":["<prompt-id>"]}
```

returned:

```json
{"code":40402,"msg":"no active prompt to steer into","data":null,"request_id":"<request-id>"}
```

Mid-turn delivery inside a web-owned executor was not verified because the
scratch prompt failed before becoming active. Mark that vendor behavior
**unverified**. It is not Hive's transport in either case.

For an ordinary TUI, this is not a native steer channel. The server has no
web-owned active prompt for the TUI turn, and obtaining a queued web prompt
requires the prohibited REST submission that creates a parallel executor.
Therefore the adapter statement that Kimi TUI exposes no non-destructive
mid-turn injection boundary is correct. Kimi `steer` must degrade to `normal`
and report that degradation.

Observed `turn.steer` wire records were background-task notifications with
`origin.kind: "background_task"`, not externally submitted user guidance.

### 5. `wire.jsonl` records and ProviderEvent mapping — confirmed with gaps

Across the available `0.29.1` session wires, these relevant shapes were
observed with:

```sh
find "$HOME/.kimi-code/sessions" -name wire.jsonl -type f -print0 |
  xargs -0 jq -r '.type' | sort | uniq -c

find "$HOME/.kimi-code/sessions" -name wire.jsonl -type f -print0 |
  xargs -0 jq -r \
    'select(.type=="context.append_loop_event") | .event.type // empty' |
  sort | uniq -c

rg -n '"type":"turn.cancel"' "$HOME/.kimi-code/sessions" -g wire.jsonl

jq -c '
  select(
    .type=="turn.prompt" or
    .type=="turn.cancel" or
    (
      .type=="context.append_loop_event" and
      (.event.type=="step.begin" or
       .event.type=="step.end" or
       .event.type=="tool.call" or
       .event.type=="tool.result")
    )
  )' <sessionDir>/agents/main/wire.jsonl
```

Representative records:

```json
{"type":"turn.prompt","input":[{"type":"text","text":"..."}],"origin":{"kind":"user"},"time":1784939159674}
{"type":"context.append_loop_event","time":1784939159676,"event":{"type":"step.begin","uuid":"...","turnId":"0","step":1}}
{"type":"context.append_loop_event","time":1784395908494,"event":{"type":"tool.call","uuid":"...","turnId":"0","step":1,"stepUuid":"...","toolCallId":"...","name":"Skill","args":{},"description":"...","display":{},"traceId":"..."}}
{"type":"context.append_loop_event","time":1784395908497,"event":{"type":"tool.result","parentUuid":"...","toolCallId":"...","result":{"output":"..."},"traceId":"..."}}
{"type":"context.append_loop_event","time":1784939166524,"event":{"type":"step.end","uuid":"...","turnId":"0","step":1,"finishReason":"end_turn","usage":{},"messageId":"..."}}
{"type":"turn.cancel","turnId":0,"time":1784396122989}
```

Some `turn.cancel` records omit `turnId`. Tool-using turns have intermediate
`step.end` records with `finishReason: "tool_use"`; these do not mean idle.
Only the final `end_turn`, a cancel, or measured process exit closes the open
turn. The observed nested loop-event types were `step.begin`, `content.part`,
`tool.call`, `tool.result`, and `step.end`.

Mapping:

| ProviderEvent kind | Kimi TUI file source |
|---|---|
| `run-started` | No reliable wire record per launch/resume; source from Hive's measured process launch. |
| `turn-started` | `turn.prompt` with `origin.kind: "user"` (or retain the other origin explicitly). |
| `tool-started` | `context.append_loop_event.event.type == "tool.call"`; `name` supplies `toolName`. |
| `tool-finished` | Matching `tool.result.toolCallId`. |
| `approval-waiting` | **Unverified/unavailable.** No reliable waiting record was observed; `permission.record_approval_result` records a result, not the wait boundary. |
| `turn-idle` | Final `step.end` with `finishReason: "end_turn"`, combined with live foreground process state. |
| `turn-failed` | **Unverified/unavailable.** No failed terminal step shape was observed in the sampled wires. |
| `interrupted` | `turn.cancel`; reason is not always present. |
| `compacted` | **Unverified/unavailable.** No compaction record was observed. |
| `run-ended` | No reliable wire record; source from measured foreground process exit/reap. |

Tool inputs and outputs can be large or sensitive. The normalized event emits
the tool name and a locally computed input digest, not raw payloads.

### 6. Submission correlation — partially confirmed

For a REST-owned prompt, the POST response's `user_message_id` exactly matched
`context.append_message.message.id` in the wire. `turn.prompt` itself carries
the exact input and origin but no prompt/message ID. Older TUI-origin user
messages were observed with no `message.id`, so a message ID cannot be assumed
for terminal submission. The producing checks were:

```sh
curl -H 'Authorization: Bearer <token>' \
  http://127.0.0.1:<port>/api/v1/sessions/<session-id>/messages

jq -c '
  select(.type=="turn.prompt" or .type=="context.append_message") |
  {type,input,origin,message,time}
' <sessionDir>/agents/main/wire.jsonl
```

For terminal transport, Hive must:

1. Place the durable Hive message ID in the submitted user envelope.
2. Compute a digest over the exact canonical prompt content written to the
   terminal.
3. Record the bound ProviderRun, terminal generation, foreground identity,
   wire file identity/offset, and digest on the `MessageAttempt`.
4. Advance `submitted` to `observed` only after the same bound TUI shows a new
   user-origin `turn.prompt` after that offset whose exact canonical input
   matches the digest/message envelope, or the bound PTY exposes an equivalent
   correlated turn-start boundary.

Identical bare prompt text is ambiguous, which is why the message ID belongs
in the envelope. A generic idle, `step.end`, later tool event, HTTP 200, or
uncorrelated transcript mutation is insufficient. The REST pollution test
proves that even an exact wire message ID is insufficient when two executors
share a vendor session; the single-executor/run binding is also mandatory.

## Global hooks remain prohibited

Current official documentation was checked on 2026-07-24:

```text
https://moonshotai.github.io/kimi-code/en/customization/hooks
```

It specifies global `[[hooks]]` entries in
`~/.kimi-code/config.toml`. Each rule has only `event`, `matcher`, `command`,
and `timeout`. Hook stdin includes a vendor `session_id` and `cwd`, correcting
the overly broad claim that hooks carry no session ID, but there is no
per-launch Hive run ID, endpoint, or credential field. The rules apply to the
user's Kimi sessions, not one exact Hive launch. Hive must never write this
global file. No global config was modified during this investigation.

## Honest Kimi capability descriptor

For the selected ordinary-TUI architecture:

```ts
{
  provider: "kimi",
  eventSource: "transcript",
  nativeDelivery: false,
  toolBoundaryEvents: true,
  turnBoundaryEvents: true,
  transcriptReader: true,
  nativeCancel: false,
  conversationResume: true
}
```

`conversationResume: true` is measured from current CLI help:
`kimi --session [id]` resumes a selected session and `kimi --continue`
continues the previous session for the working directory. Cancel remains a
bound terminal/process control operation, not a native communication API.

## Minimal C1 transport contract

### First turn

1. Launch the ordinary `kimi` TUI. The brief may ride launch/system context,
   but context does not initiate a turn.
2. Mint and bind the ProviderRun to the measured foreground PID, start token,
   process group, terminal generation, and (when uniquely discoverable) Kimi
   session directory.
3. Wait until the foreground Kimi process is live and file/terminal evidence
   says no turn is open. Do not label the run `working`; report `idle` or
   `unknown` from measured evidence.
4. Submit the kickoff as the first real user turn through:

```ts
writeAutomated({
  terminal,
  expectedForeground: {
    providerRunId,
    pid,
    startToken,
    processGroupId
  },
  bytes,
  idempotencyKey
})
```

5. Correlate observation by the message envelope/digest rule in finding 6.

### Later messages

Normal messages use the same atomic terminal operation at the next proven
input-ready boundary. Re-check foreground identity at commit time; a mismatch
writes zero bytes and leaves the message queued. A human input lease blocks
the write. Kimi `steer` degrades to normal because the TUI has no safe native
steer boundary. Urgent delivery first uses the separately typed, run-bound
terminal/process cancel operation, waits for `turn.cancel`/input readiness,
then performs the same atomic write.

### Idle versus busy

Run a file-tail state machine over the bound `wire.jsonl`, paired with measured
foreground process state:

- no open `turn.prompt` after the latest final `end_turn`/`turn.cancel`:
  `idle`;
- open prompt, step, LLM request, or tool boundary without a closing final
  event: `busy`;
- parse gap, ambiguous session, stale record, identity mismatch, or dead/
  changing foreground: `unknown` or the measured terminal/run end state.

Never convert unknown to working. Context usage comes from the latest
`usage.record` sum and `llm.request.maxTokens`; if either is absent, report it
as unknown.

### Required terminal fallback

Terminal submission is Kimi's primary delivery, not a fallback. Terminal
output plus process identity is the observation fallback when session
discovery or wire parsing is unavailable. It must cover TUI readiness,
correlated prompt/turn evidence where possible, permission/input waits,
provider errors, interruption, and provider exit without ever acquiring input
during observation.

## Required design-document corrections

### §6 closing paragraph

Replace the current Kimi paragraph with:

> Kimi kickoff is the agent's first delivery. The brief may ride the
> AGENTS.md system context at launch, but context never initiates a turn: a
> freshly spawned Kimi TUI idles until spoken to. Hive therefore submits the
> queued `begin` message as a real user turn through the same atomic terminal
> `writeAutomated` path used for later messages, bound to the exact foreground
> ProviderRun. Hive must never POST to `kimi web` for a TUI-bound session:
> the server creates a parallel executor that can mutate the shared transcript
> while the TUI remains idle. Observation requires a correlated turn-start
> from the bound executor; transcript mutation alone is insufficient.

### §10 Kimi row

Replace the Kimi row's structured source, integration decision, and fallback
with:

> **Structured source:** Bound session `wire.jsonl` read directly from the
> session directory, plus measured foreground process state. `kimi web`
> status/transcript is not required and its prompt/steer routes are prohibited
> for TUI-bound sessions.
>
> **Hive integration decision:** Atomic terminal delivery is primary. Add a
> read-only wire tailer for turn, step, tool, cancellation, and usage evidence.
> Do not install Kimi hooks and never modify
> `~/.kimi-code/config.toml`: hooks are global rules and cannot carry Hive's
> per-run endpoint/credential identity. Do not POST prompts or steer requests
> to a TUI-bound vendor session; a web server is a separate executor.
>
> **Required fallback:** Terminal output and process state when session
> discovery or wire parsing is unavailable.

Also remove the claims “Native web delivery plus the transcript reader”, “A
POSTed prompt is a real user turn in the live TUI (proven)”,
“`prompts:steer` is a vendor-native steer channel”, and “`/status` gives busy
and context usage” as integration requirements. The status response exists,
but it is not authoritative for the bound TUI.

### §14 acceptance item 12

Replace it with:

> For Kimi, verify direct `wire.jsonl` turn/step/tool/cancellation/usage
> records plus foreground process state map to the supported normalized event
> set; a freshly launched idle TUI receives its first and later turns only
> through bound atomic terminal submission; file-tail state distinguishes
> idle, busy, and unknown; no Hive path POSTs prompts or steer requests to a
> TUI-bound session; and structured observation degrades to terminal/process
> evidence when session discovery or wire parsing is absent.

# AgentHost crash matrix

An AgentHost is useful only if its uncertainty is narrower than the provider process it protects. This prototype makes that claim executable. A small host owns one provider process group and its stdio, fsyncs `ACCEPTED` before a command can reach the provider, journals provider semantic events with stable IDs and monotonic sequence numbers, and exposes an authenticated reconnect report plus replay from the broker's durable high-water mark.

The crash harness launches four independent processes: a simulated UI, broker, AgentHost, and provider. It kills each one at all six architecture boundaries for both Claude- and Codex-shaped fixtures. The fixtures persist a vendor session and execution counters outside the host WAL. That lets the harness detect the forbidden failures directly: a second prompt, approval, or tool execution; completion without a provider terminal record; cross-tenant reconnect; or a provider left alive after its host is replaced.

Run it with:

```sh
bun test
bun run matrix
bun run live
```

`evidence/matrix.md` is the full deterministic 48-row matrix. `evidence/live-providers.json` records a sanitized run through the installed Claude stream-json and Codex app-server protocols. They are deliberately separate: the matrix proves the host state machine and OS-process cleanup under deterministic fault injection; the live run proves that the installed provider versions can complete a tool/approval task behind the same journal ordering. It does not pretend that a fixture proves an undocumented vendor resume contract.

The live run corrected one provider assumption. Claude Code 2.1.206 requires `--permission-prompt-tool` to name a real MCP tool. It invoked the prototype's per-session relay and waited for its explicit denial; it did not emit `can_use_tool` on stdout. The host therefore owns that relay as part of the provider process group and merges its correlated request into the semantic WAL. Passing an arbitrary sentinel is not a usable approval channel.

## Recovery contract

The WAL contains command identity, child identity, semantic events, approval delivery, and broker acknowledgements. It never contains the prompt, raw environment, or provider stderr. Repeating a `commandId` or `approvalId` returns the known state and never writes it to the provider twice. A new host verifies and kills a surviving pinned fixture process group before using its vendor session. Stable provider event IDs deduplicate events replayed by resume.

If `ACCEPTED` exists but neither a durable terminal event nor a reconcilable vendor session exists, the host emits `UNKNOWN_OUTCOME` and stops. It does not infer that absence of an event means absence of execution. Pending approval requests may be reported again as provider state, but no prior decision is sent again; the broker must obtain an explicit decision after reconnect.

The WAL compacts only acknowledged events. If unacknowledged semantic boundaries fill the configured bound, the host terminates the provider and reports overflow rather than discard events or block provider output indefinitely.

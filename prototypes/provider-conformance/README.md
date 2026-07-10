# Provider-neutral conformance fixture

Ring 1 should be a test result, not a reputation. This prototype drives one scenario vocabulary through Claude Code stream-json control and Codex app-server, translates both protocols into the same semantic events, and applies one assertion set. A binding passes because its exact executable generation produced the required lifecycle, control, recovery, model, and policy evidence—not because another version once did.

The fixture chooses caution over convenience at the provider boundary. It resolves each executable to an absolute real path, hashes it, records its version, and pins every real session to the provider-reported concrete model selected during a non-billable preflight. It never passes a fallback option. It never guesses a provider subcommand; in particular, there is no `claude models` probe because Claude treats unknown subcommands as prompts. Codex schema discovery uses the binding's documented `app-server generate-json-schema` command, while Claude catalog discovery sends the driven stream-json `initialize` control request before any model turn.

## The contract

The shared scenarios are structured lifecycle, approve, deny, needs-user, steer, cancel with a receipt, resume through a durable session ID, invalid-model validation, and read-only denial. Provider adapters may use different wire messages, but they must produce the same normalized facts. Cancel requires both an acknowledged command and a terminal interrupted state. Resume requires prior context, not merely a syntactically accepted ID. Approval verifies the side effect; denial and read-only verify its absence. Invalid-model uses a validation-only sentinel and sets `realTaskStarted` to false, so a failed pin cannot accidentally consume a real assignment.

Codex has one provider-specific extension: `dual-client`. It starts one WebSocket app-server, creates a durable thread, attaches the interactive TUI to that exact ID with documented `--remote` plus `resume`, then resumes the same thread from a second JSON-RPC connection. The second connection starts and steers a turn, injects a raw model-visible history item, and verifies the injected token in a following turn. The gate passes only when both commands are acknowledged and the TUI transcript receives the history-dependent result. This keeps a useful Codex capability out of the common denominator without turning it into an untested architectural assumption.

The alternative was a provider-shaped test suite with parallel assertions. That would be easier to write and nearly useless: a Codex "interrupt request succeeded" and a Claude "process exited" could both be called cancel even though only one has a receipt. Normalization makes the semantic difference explicit. The cost is adapter code and an intentionally small common denominator; provider-only features belong in separate capability tests.

## Billing boundary

Dry-run is the default and starts no provider process:

```sh
bun run prototypes/provider-conformance/run.ts
```

`--probe` runs only the declared non-billable surface: `--version`, Codex's schema generator and `model/list`, and Claude's control `initialize`. Captures redact account identity and credential-shaped fields before writing JSONL.

```sh
bun run prototypes/provider-conformance/run.ts --probe \
  --claude /absolute/path/to/claude \
  --codex /absolute/path/to/codex
```

Every successful lifecycle, approval, question, steering, cancellation, resume, or read-only scenario starts at least one model turn and is classified billable. Claude's invalid-model repro reported `total_cost_usd: 0`; Codex has no equivalent proved guarantee, so its validation cost remains unknown. A live command containing either class fails before spawning unless the caller adds `--allow-billable`:

```sh
bun run prototypes/provider-conformance/run.ts --live --allow-billable \
  --claude /absolute/path/to/claude \
  --codex /absolute/path/to/codex
```

This explicit flag is the authorization boundary. It is not inferred from an interactive terminal, an authenticated account, or available quota. To isolate one failure, repeat `--scenario <name>` or select one provider with `--provider claude|codex`. The exact prompts, their purpose, and their real-task classification live in `prompts.ts`; adding a scenario without adding its billing classification fails review and tests.

## Evidence

Each live report records three independent axes for every provider/scenario fact:

- `documented` links the public contract or names a binding-generated schema. Documentation does not count as an observation.
- `observed` points to a redacted frame capture and the immutable binding hash. An observation does not become a timeless provider guarantee.
- `billable` records the declared class and provider-reported cost or token fields where the protocol supplies them. Unknown stays unknown.

The checked-in [evidence matrix](EVIDENCE.md) is the reviewable snapshot for the pinned ring-1 candidates. Generated run directories are ignored because they may contain repository paths and model output even after credential redaction; promote only the minimal normalized result and provenance needed to support a claim.

## Verification

```sh
bun test prototypes/provider-conformance
bunx tsc --noEmit -p prototypes/provider-conformance/tsconfig.json
```

The first command tests the provider-neutral invariants and the billing gate without starting either provider. The second checks both adapters against the repository's strict TypeScript settings. Live conformance is a separate, explicitly billable operation; green offline tests prove the harness, not either provider binding.

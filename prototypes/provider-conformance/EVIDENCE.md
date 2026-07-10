# Provider conformance evidence

This matrix separates three questions that are easy to blur: whether a provider publishes a contract, whether this exact executable generation produced the behavior, and whether obtaining the observation consumes provider capacity. The canonical driven run was `2026-07-10T14-00-28-311Z`, from 2026-07-10T14:00:28.312Z through 2026-07-10T14:02:46.690Z. All 18 common provider/scenario facts passed the shared assertions. A separately driven Codex dual-client extension adds the nineteenth applicable fact.

The bindings were Claude Code `2.1.206 (Claude Code)` at SHA-256 `3197aba4442dbd5b3df42b6f35e6d7bd03b5e48ce18b7a3c5c6f5f8c28e03b7f`, pinned for real turns to `claude-haiku-4-5-20251001`; and Codex `codex-cli 0.144.0` at SHA-256 `978740e6bcbd9af2f850823b723fb74f16d8d1e44de05f7dd6737ae631f72017`, pinned to `gpt-5.5`. Claude reported $0.081725 across the complete run, including exactly $0 for invalid-model validation. Codex reported per-turn token usage but no currency amount; its invalid-model turn emitted no token-usage update, which is insufficient to claim a general zero-cost guarantee.

| Provider | Scenario | Documented | Observed | Billable |
|---|---|---:|---:|---|
| claude | lifecycle | yes | pass | billable — Provider-reported total_cost_usd: 0.004426. |
| claude | approve | yes | pass | billable — Provider-reported total_cost_usd: 0.012570. |
| claude | deny | yes | pass | billable — Provider-reported total_cost_usd: 0.013149. |
| claude | needs-user | yes | pass | billable — Provider-reported total_cost_usd: 0.013283. |
| claude | steer | yes | pass | billable — Provider-reported total_cost_usd: 0.007502. |
| claude | cancel | partial | pass | billable — Provider-reported total_cost_usd: 0.005448. |
| claude | resume | yes | pass | billable — Provider-reported total_cost_usd: 0.010968. |
| claude | invalid-model | partial | pass | non-billable — Provider-reported total_cost_usd: 0.000000. |
| claude | read-only | yes | pass | billable — Provider-reported total_cost_usd: 0.014379. |
| codex | lifecycle | yes | pass | billable — No provider currency amount was available. |
| codex | approve | yes | pass | billable — No provider currency amount was available. |
| codex | deny | yes | pass | billable — No provider currency amount was available. |
| codex | needs-user | yes | pass | billable — No provider currency amount was available. |
| codex | steer | yes | pass | billable — No provider currency amount was available. |
| codex | cancel | yes | pass | billable — No provider currency amount was available. |
| codex | resume | yes | pass | billable — No provider currency amount was available. |
| codex | invalid-model | partial | pass | unknown — No provider currency amount was available. |
| codex | read-only | yes | pass | billable — No provider currency amount was available. |
| codex | dual-client | yes | pass | billable — Three tiny no-tool turns; no provider currency amount was available. |

## What the compact table hides

Claude's public CLI reference documents `--permission-prompt-tool`, correcting the blueprint's former statement that the flag itself is undocumented. The low-level `stdio` target that makes raw stream-json approval control work is still absent from that reference; the pinned binary and driven frames prove it. The matrix therefore calls cancel and invalid-model documentation partial where receipt or cost semantics still depend on observation.

Codex needs-user is not available to an ordinary default turn merely because `item/tool/requestUserInput` appears in the server-request schema. The first drive produced the expected answer without any request—the model chose for the user. The passing drive initializes with `experimentalApi` and starts the turn in experimental `collaborationMode: plan`, whose binding-generated schema exposes the native request-user-input tool.

Codex read-only enforcement passed mechanically: `thread/start` reported the effective `readOnly` sandbox and the forbidden marker did not exist. This binding did not emit a rejected `fileChange` item on the JSON event stream; the rejection appeared only on stderr. Hive can trust the structured policy plus its own filesystem check, but should not promise a structured per-tool denial event for this generation.

Codex dual-client passed as a provider-specific extension. One WebSocket app-server owned a durable thread; the interactive TUI resumed it with `--remote`, and a second raw JSON-RPC connection resumed the same ID. `turn/steer` returned a correlated receipt, but the deliberately tiny proof turn completed before its corrected answer could demonstrate semantic application. The same second connection then appended a raw user message with `thread/inject_items`; a verification turn returned exactly `HIVE_INJECT_SEEN`, and the attached TUI rendered that exchange while its composer remained untouched. The gate therefore records steer transport acceptance and uses injection plus verification as its semantic shared-thread proof. Future fixture runs use a deliberate turn for steer timing as well. The drive recorded `codex` 0.144.0; the digest provenance is same-host PATH resolution immediately after the report rather than a digest emitted by the driving process.

## Provenance

The committed [driven run summary](evidence/driven-run-summary.json) contains the 18 common binding results; the [dual-client driven proof](evidence/dual-client-driven-proof.json) contains the provider-specific extension. Both retain binding identity, minimal normalized evidence, and billing provenance without account identity, absolute paths, durable IDs, prompts, or raw transcript output. Raw redacted JSONL remains local and gitignored because even a redacted protocol trace contains machine-specific paths and unnecessary transcript material.

Documentation provenance is attached to every fact in [the machine-readable matrix](evidence/evidence-matrix.json). The primary contracts are the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), [Claude CLI reference](https://code.claude.com/docs/en/cli-usage), [Claude streaming-input guide](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [Claude approvals and user-input guide](https://code.claude.com/docs/en/agent-sdk/user-input), and the repository's [driven cross-vendor review](../../research/cross-vendor-architecture-review.md).

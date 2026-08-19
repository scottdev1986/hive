# Queen status

Updated: 2026-08-19
Source: Hive source tree, 2026-08-19

## Summary

The root orchestrator is named queen. It has no row in the `agents` table, so its Workspace status travels beside the worker array. That structural difference does not justify different semantics: Workspace must display the same provider-native turn state shown at the bottom of the queen TUI.

The queen agent-ui already converts provider events into typed status reports and sends them to the daemon. `GET /orchestrator-status` now reads that persisted projection directly. It preserves `idle`, `queued`, `working`, `awaiting_approval`, `awaiting_answer`, `done`, and `failed`; it does not collapse completion into idle or a question into an unrecognized state.

## Authority order

The endpoint resolves status in this order:

1. A failed, exited, or not-yet-visible `sessiond` host reports its measured lifecycle state.
2. The newest provider-native turn report for the active root `ProviderRun` supplies the exact TUI state; provider runtime supplies connecting, ready, disconnected, or exited before the first turn.
3. Legacy hook boundaries are used only when no structured provider status is available.
4. Launch, connection, ready, and disconnected lifecycle states cover periods in which no turn exists.

This makes the wire status non-nullable. “No current turn” is not “unknown”: it is a measured lifecycle condition such as connecting, ready, or disconnected.

The lookup is bound to the active `ProviderRun`. A late report from a predecessor cannot overwrite the current queen. Within that run, daemon event sequence decides which accepted provider report is newest; provider timestamps need not be unique.

## Why boundaries were insufficient

The former projection reduced rich provider states to `turn-start` and `turn-end`, then reconstructed a status from the last two boundaries. That discarded three facts the TUI already knew:

- `turn-idle` means the TUI says **Done**, not idle.
- `question-waiting` means **Answer needed** and requires user attention.
- `approval-waiting` is distinct from ordinary work.

It also returned `null` for duplicate `turn-end` rows. Duplicate delivery is real: provider protocol reporting and vendor hooks can both record the same end boundary. The exact provider report is idempotent and ordered, so it is the correct status authority. The conservative boundary reducer remains only as a compatibility fallback and still refuses to manufacture idle from contradictory legacy events.

## Workspace presentation

Workspace maps provider-native words to the same labels used by agent-ui:

| Provider state | Queen label | Workspace activity |
| --- | --- | --- |
| `idle` | Idle | idle |
| `queued` | Queued | working |
| `submitting` | Sending | working |
| `working` | Working | working |
| `awaiting_approval` | Approval needed | needs user |
| `awaiting_answer` | Answer needed | needs user |
| `cancelling` | Stopping | working |
| `done` | Done | done |
| `failed` | Failed | failed |

An `awaiting_answer` report also raises a Workspace attention item titled “Queen is asking a question.” When the provider reports a new non-waiting state, that attention is resolved. Repeated questions carry their provider observation time, so a later question can alert again.

Before the first snapshot, Workspace shows Connecting. If the queen status channel disappears, it shows Disconnected. Neither condition is presented as an unknown queen turn.

## Invariants

- Do not add a fake queen row to `agents`; authorization and lifecycle code rely on that table containing spawned workers only.
- Do not scrape terminal text. Provider protocol events are the typed source used by the TUI itself.
- Do not infer stuck or waiting from elapsed time. Only an explicit provider question or approval state produces needs-user attention.
- Do not translate `done` to `idle`. Preserve the provider word.

## Authorization

`GET /orchestrator-status` is gated on `status:read`, the same action used by `hive_status`. Poll allows are not audited, so the one-second Workspace feed cannot bury meaningful audit rows.

## See also

- [Authorization](authorization.md) — `status:read` and the no-agents-row invariant
- [Database resilience](database-resilience.md) — durable event ordering and evidence rules
- `src/daemon/status-service/status-projection-service.ts` — provider report projection
- `src/daemon/status-service/status-orchestrator.ts` — conservative legacy fallback

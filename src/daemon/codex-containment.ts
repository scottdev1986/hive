import type { CapabilityProvider } from "../schemas";

// Codex writer authoring is admissible on exactly one surface: the app-server
// driver, where every mutation is brokered through a daemon-owned gate.
//
// Admission is a question about the DRIVER, never about the CLI version or
// build. A version floor is bootstrap compatibility, not writer safety: a
// newer build can regress the broker, and a `>=` comparison would silently
// read as permission. Safety instead comes structurally from the runtime
// boundary — the writer's sandbox stays read-only, so the only way a mutation
// can reach the filesystem is a synchronous approval request that Hive answers,
// and Hive answers `allow` only for an exact live holder whose provider-applied
// identity is freshly attested for that same app-server thread and turn. On a
// build whose app-server cannot supply that evidence the gate denies every
// mutation: the writer is useless, never ungated.
//
// The Codex TUI can NEVER be a safe writer surface: PreToolUse hooks fail open
// (command failure/timeout/invalid JSON is `should_block=false`) and the writer
// owns its own `.codex/` hook scripts, so the agent can edit away its own
// guard. An unknown driver is refused for the same reason a missing field is
// refused — unknown is not permission. Read-only Codex (review, query, the
// root/orchestrator) is unaffected on either driver: a reader cannot mutate.
//
// Recovery and resume of a Codex writer stay refused: they pass no live
// brokered driver, and 0.144.4 has no durable app-server resume, so a
// reauthorized writer could run outside the boundary that makes it safe.

/** The driver that will actually run the session. Only `app-server` brokers
 * every mutation through Hive; `tui` cannot, and `null` is an unknown driver. */
export type CodexDriver = "app-server" | "tui";

export const CODEX_WRITER_CONTAINMENT_REASON =
  "Codex writer authoring is contained on this launch: a Codex writer is only " +
  "admissible on the app-server driver, where Hive brokers every mutation " +
  "through a daemon-owned identity gate. The Codex TUI cannot host a writer " +
  "(PreToolUse hooks fail open and the writer can edit its own hook scripts), " +
  "and an unknown driver is not permission, so an unknown or drifted Codex " +
  "writer could reach a mutating tool. Codex read-only review/query/root " +
  "remain available. Fix: launch this agent read-only, or use a Claude or " +
  "Grok writer.";

/**
 * The containment refusal for a launch that would be a Codex *writer*, or null
 * when the launch is allowed (any read-only launch, any non-Codex tool, or a
 * Codex writer on the brokered app-server driver). This is the single
 * authorization rule every launch/reauthorization path shares, so the refusal
 * cannot be reached inconsistently.
 *
 * `driver` is null wherever no live brokered session is being established
 * (recovery, resume, the TUI config/argv writers) — unknown is a refusal.
 */
export function codexWriterContainment(
  tool: CapabilityProvider,
  readOnly: boolean,
  driver: CodexDriver | null,
): string | null {
  if (tool !== "codex" || readOnly) return null;
  return driver === "app-server" ? null : CODEX_WRITER_CONTAINMENT_REASON;
}

/** Throwing form for the launch chokepoints that abort by exception. */
export function assertCodexWriterContained(
  tool: CapabilityProvider,
  readOnly: boolean,
  driver: CodexDriver | null,
): void {
  const refusal = codexWriterContainment(tool, readOnly, driver);
  if (refusal !== null) throw new CodexWriterContainedError(refusal);
}

/** A distinct type so callers can tell containment from an ordinary launch
 * failure and surface it as an actionable diagnostic rather than a crash. */
export class CodexWriterContainedError extends Error {
  constructor(message: string = CODEX_WRITER_CONTAINMENT_REASON) {
    super(message);
    this.name = "CodexWriterContainedError";
  }
}

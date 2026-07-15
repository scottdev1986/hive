import type { CapabilityProvider } from "../schemas";

// Codex writer authoring is contained until Hive has an enforceable per-mutation
// broker/sandbox boundary. Per-mutation execution-identity CANNOT be enforced on
// Codex 0.144.4: TUI PreToolUse hooks fail open (command failure/timeout/invalid
// JSON is `should_block=false`) and are writer-tamperable (the agent owns its
// `.codex/` hook scripts), and the app-server driver has no hooks and no identity
// attestation at any mutation approval/execution boundary. A writer we cannot
// gate per-mutation could reach a mutating tool while unknown or drifted, which
// the user's invariant forbids. So Hive refuses to launch or reauthorize a Codex
// *writer* on every path — fresh spawn, recovery, resume/write reauthorization,
// app-server, explicit model, route selection, and fallback — with no silent
// fallback to another Codex driver or provider. Read-only Codex (review, query,
// the root/orchestrator) is unaffected: a reader cannot mutate.
//
// The daemon-side defenses (the 30s identity sweep, the fresh landing
// reattestation, and the terminal/capability gates) remain, but as
// defense-in-depth for pre-activation and legacy/running processes — never as
// authorization to write.
//
// Residual: real-provider Codex hook session-id acceptance was never
// proven end-to-end; the PreToolUse guard subsystem that would have
// relied on it has been removed, so that gap is closed by refusal
// rather than by an unproven hook path.

export const CODEX_WRITER_CONTAINMENT_REASON =
  "Codex writer authoring is contained: Hive cannot enforce per-mutation " +
  "execution-identity on Codex 0.144.4 (TUI PreToolUse hooks fail open and are " +
  "writer-tamperable; the app-server has no mutation-approval identity gate), so " +
  "an unknown or drifted Codex writer could reach a mutating tool. Codex " +
  "read-only review/query/root remain available. Fix: launch this agent " +
  "read-only, or use a Claude or Grok writer.";

/**
 * The containment refusal for a launch that would be a Codex *writer*, or null
 * when the launch is allowed (any read-only launch, or any non-Codex tool).
 * This is the single authorization rule every launch/reauthorization path
 * shares, so the refusal cannot be reached inconsistently.
 */
export function codexWriterContainment(
  tool: CapabilityProvider,
  readOnly: boolean,
): string | null {
  return tool === "codex" && !readOnly
    ? CODEX_WRITER_CONTAINMENT_REASON
    : null;
}

/** Throwing form for the launch chokepoints that abort by exception. */
export function assertCodexWriterContained(
  tool: CapabilityProvider,
  readOnly: boolean,
): void {
  const refusal = codexWriterContainment(tool, readOnly);
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

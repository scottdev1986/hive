import type { OrchestratorStatus } from "../../schemas/status-envelope";

/** Legacy root-status fallback for providers that have not emitted a structured
 * turn report. The primary path reads the exact provider projection persisted
 * by agent-ui, which preserves done and waiting states that boundaries cannot.
 * This reducer remains deliberately conservative: duplicate or unpaired end
 * signals are contradictory and must not manufacture an idle state. */

export type TurnBoundaryKind = "turn-start" | "turn-end";
export type OrchestratorSignalKind =
  | "session-launch"
  | "session-start"
  | "session-end"
  | TurnBoundaryKind;

/** The root's wire vocabulary is owned by schemas/status-envelope.ts; this
 * re-export keeps the status service's import surface unchanged. */
export type { OrchestratorStatus };

/** @param signals the root's most recent lifecycle/turn signals, NEWEST FIRST. Two is enough; more are ignored. A confirmed `session-start` is the one honest idle state available before the first user turn: Claude emits it only after its root session has started and loaded Hive's hooks. */
export function deriveOrchestratorStatus(
  signals: readonly OrchestratorSignalKind[],
): OrchestratorStatus | null {
  const [newest, previous] = signals;
  if (newest === undefined) return null;
  if (newest === "session-launch") return "spawning";
  if (newest === "session-end") return "exited";
  if (newest === "session-start") return "idle";
  if (newest === "turn-start") return "working";
  return previous === "turn-start" ? "idle" : null;
}

/**
 * What the orchestrator is doing, derived from the only surface that records it.
 *
 * The orchestrator is not a spawned agent and has no agents-table row (db.ts's
 * `setOrchestratorTerminal` is explicit about it), so it has no `status` column
 * to read. The Workspace used to paper over that by inventing the status word
 * "running" in Swift — a word in no vocabulary here — which its dot correctly
 * degraded to "unknown", and the root's dot was therefore gray forever. The root
 * is alive by definition whenever the Workspace is running; gray was a lie of
 * omission. See docs/daemon/orchestrator-status.md.
 *
 * The root's turns ARE observable. Claude hooks post `turn-start` on
 * UserPromptSubmit and `turn-end` on Stop; Codex rollouts persist exact
 * `task_started` / `task_complete` records; Grok updates persist an exact
 * terminal `turn_completed`. The hookless providers' native records are
 * bridged into this same event stream by orchestrator-turn-monitor.ts. Delivery
 * already reads the stream to tell a busy root from a deaf one. This derives
 * the dot's status word from those events, and it never guesses:
 *
 *   newest signal is session-launch                → spawning (process launch began)
 *   newest signal is session-start                 → idle     (ready, no turn yet)
 *   newest signal is session-end                   → exited   (root process ended)
 *   newest signal is turn-start                    → working  (a turn is open)
 *   newest is turn-end, preceded by a turn-start   → idle     (turn closed)
 *   anything else                                  → null     (say nothing)
 *
 * That last line is the point, and it is not defensive padding. A `turn-end`
 * whose predecessor is another `turn-end` is a CONTRADICTION: a turn cannot end
 * without having started. It means the hooks are lying to us — which is not
 * hypothetical. Measured in the live events table, the root posted 231
 * turn-ends and ZERO turn-starts between 2026-07-11T19:39Z and
 * 2026-07-12T10:58Z, because a daemon port change had re-pointed every hook
 * except turn-start (the incident recorded in adapters/tools/claude.ts). For
 * those 15 hours a naive "newest boundary is a turn-end, so it's idle" would
 * have rendered a confident yellow "idle" dot while the root worked
 * continuously. Returning null there means the field is omitted, and an absent
 * field is unknown, never false: the dot goes back to honest gray.
 *
 * The same rule covers a root that has posted no boundary at all (a fresh
 * session, or one whose turn-start hook never landed): those two are
 * indistinguishable from here, so we say nothing rather than pick the flattering
 * one.
 *
 * What is deliberately NOT here: any inference from elapsed time. "No turn-end
 * for N minutes" describes a deep build turn exactly as well as a wedged
 * process — delivery.ts records that inference misfiring seven times in one
 * evening on agents that were merely working. A contradiction in the record is
 * something we can conclude from; an absence of news is not.
 */

export type TurnBoundaryKind = "turn-start" | "turn-end";
export type OrchestratorSignalKind =
  | "session-launch"
  | "session-start"
  | "session-end"
  | TurnBoundaryKind;

/** The dot's vocabulary for the root. A subset of the agent status words: the
 * root can never be spawning, done, failed, or blocked on a human. */
export type OrchestratorStatus = "spawning" | "working" | "idle" | "exited";

/**
 * @param signals the root's most recent lifecycle/turn signals, NEWEST FIRST.
 * Two is enough; more are ignored. A confirmed `session-start` is the one
 * honest idle state available before the first user turn: Claude emits it only
 * after its root session has started and loaded Hive's hooks.
 */
export function deriveOrchestratorStatus(
  signals: readonly OrchestratorSignalKind[],
): OrchestratorStatus | null {
  const [newest, previous] = signals;
  if (newest === undefined) return null;
  if (newest === "session-launch") return "spawning";
  if (newest === "session-end") return "exited";
  if (newest === "session-start") return "idle";
  if (newest === "turn-start") return "working";
  // newest is a turn-end. It is only trustworthy if a turn actually started.
  return previous === "turn-start" ? "idle" : null;
}

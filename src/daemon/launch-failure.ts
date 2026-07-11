/**
 * Which layer produced a failed launch — and therefore what it is evidence of.
 *
 * A launch crosses two layers. The transport is this machine: tmux, the shell,
 * the filesystem, the binary on disk. The model is the far side. Only the far
 * side can say anything about a route, and Hive acts on what it says by
 * quarantining that route for up to an hour (see QuotaService.quarantinedUntil).
 *
 * Recording a transport failure there benches a model that was never contacted.
 * One over-long brief took Opus out of rotation for half an hour and silently
 * downgraded every spawn that followed — the guard became the outage. The router
 * (phases 1-6) will route on this same signal, so transport noise mixed into it
 * corrupts the router's input, not just today's spawn.
 */
export type LaunchFailureLayer = "transport" | "model";

/**
 * What a shell prints when it cannot execute the provider binary at all: the
 * pane died before the CLI ever ran, so the model was never contacted.
 */
const EXEC_FAILURE =
  /command not found|no such file or directory|permission denied|cannot execute|exec format error/i;

/**
 * Classify a launch that started but never proved life.
 *
 * Reaching readiness means tmux carried the command and the shell ran it, so a
 * failure here is normally the model's own: the CLI came up and refused, or it
 * never answered. That is the true positive this quarantine exists for, and it
 * must survive. The exception is a binary that could not be executed — a missing
 * or unrunnable `claude`/`codex` — which surfaces here only as pane stderr, and
 * is a fault of this machine rather than of the route.
 */
export function readinessFailureLayer(reason: string): LaunchFailureLayer {
  return EXEC_FAILURE.test(reason) ? "transport" : "model";
}

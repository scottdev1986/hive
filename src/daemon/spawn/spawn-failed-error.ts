import type { QuarantineLaunchLayer } from "./readiness";

export class SpawnFailedError extends Error {
  readonly code: "SPAWN_FAILED" | "SPAWN_CLEANUP_UNVERIFIED";

  constructor(
    readonly agentName: string,
    readonly layer: QuarantineLaunchLayer,
    readonly outcome: "failed" | "stuck",
    readonly detail: string,
  ) {
    const code =
      outcome === "failed"
        ? ("SPAWN_FAILED" as const)
        : ("SPAWN_CLEANUP_UNVERIFIED" as const);
    super(`${code}: Hive agent ${agentName} ${detail}`);
    this.name = "SpawnFailedError";
    this.code = code;
  }
}

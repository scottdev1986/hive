// Pure lifecycle decisions used by the live scenario and its failure-path
// tests. Keeping them free of rig state lets the tests exercise the same
// guarded paths without starting a daemon or spending provider quota.

import { join } from "node:path";

export interface MarkerAgent {
  taskDescription: string;
}

export function findMarkerAgents<T extends MarkerAgent>(
  agents: readonly T[],
  marker: string,
): T[] {
  return agents.filter((agent) => agent.taskDescription.includes(marker));
}

export type TeardownReadback = "clean" | "no-admission";

export type TeardownPlan =
  | { kind: "no-admission" }
  | { kind: "measure"; readbackRoot: string };

export function planTeardown(
  agents: readonly { worktreePath: string | null }[],
  project: string,
): TeardownPlan {
  if (agents.length === 0) return { kind: "no-admission" };
  const soleWorktree = agents.length === 1 ? agents[0]?.worktreePath : null;
  return {
    kind: "measure",
    readbackRoot: soleWorktree ?? join(project, ".hive", "worktrees"),
  };
}

export function readbackAllowsRemoval(
  identities: ReadonlySet<string>,
): boolean {
  return identities.size === 0;
}

export function isProductFailure(failure: unknown): boolean {
  if (failure instanceof AggregateError) {
    return failure.errors.some(isProductFailure);
  }
  return failure instanceof Error && failure.message.startsWith("PRODUCT_RED");
}

export function teardownReport(outcome: TeardownReadback): string {
  return outcome === "clean"
    ? "teardown clean: no pid+cwd-inode survivors; project restored"
    : "INFRASTRUCTURE_RED teardown found no marker-matched admission; survivor cleanliness is unmeasured";
}

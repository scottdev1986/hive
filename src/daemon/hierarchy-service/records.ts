import type { AgentBindingRef } from "../../schemas/hierarchy-node";
import type { TaskState } from "../../schemas/task-detail";

/**
 * The shapes and keys the hierarchy store persists, and the errors it throws.
 *
 * Shapes only — every statement that reads or writes them lives in
 * hierarchy-store.ts, which is the named R4 SQL owner of this database. A
 * reader can see what a fence set, a record row, or a task-update input *is*
 * without reading the DDL that stores it.
 */

export class HierarchyConflictError extends Error {
  readonly code = "HIERARCHY_CONFLICT";

  constructor(readonly currentRevision: string) {
    super(`revision conflict: record is at revision ${currentRevision}`);
    this.name = "HierarchyConflictError";
  }
}

export class HierarchyFenceError extends Error {
  readonly code = "HIERARCHY_FENCE";

  constructor(
    readonly fence: "hierarchyRevision" | "runEpoch" | "capabilityEpoch",
    readonly expected: string | number,
    readonly current: string | number,
  ) {
    super(
      `fence rejected: ${fence} expected ${String(expected)}, current is ${String(current)}`,
    );
    this.name = "HierarchyFenceError";
  }
}

export class HierarchyValidationError extends Error {
  readonly code = "HIERARCHY_VALIDATION";

  constructor(message: string) {
    super(message);
    this.name = "HierarchyValidationError";
  }
}

export type AuthorityFences = {
  expectedHierarchyRevision: string;
  expectedRunEpoch: number;
  expectedCapabilityEpoch: number;
  binding: AgentBindingRef;
};

export type GrantIssuerAuthority = "acting-binding" | "run-root";

export type RoleConferral = {
  binding: AgentBindingRef;
  expectedCapabilityEpoch: number;
};

/** An assignee cannot accept its own result, even when also owner. */
export type TaskUpdateInput = {
  taskId: string;
  expectedRevision: string;
  actorNodeId: string;
  state?: TaskState;
  blockers?: string[];
  evidence?: string[];
  assigneeNodeId?: string;
  correction?: string;
  acceptResult?: boolean;
  /** Gates live on the Run, so this path refuses rather than ignores one. */
  moveGate?: boolean;
};

/** Discriminator for rows in hierarchy_records.kind. */
export type HierarchyRecordKind =
  | "run"
  | "spec-revision"
  | "plan-revision"
  | "run-budget"
  | "topology-decision"
  | "node"
  | "task"
  | "grant"
  | "binding"
  | "root-binding"
  | "integration-stage"
  | "review"
  | "run-control-decision"
  | "ownership-transfer";

/** One row of hierarchy_records as SQLite returns it. */
export type HierarchyRecordRow = {
  kind: string;
  id: string;
  runId: string;
  revision: string | null;
  capabilityEpoch: number | null;
  document: string;
};

export const nextRevision = (current: string): string =>
  (BigInt(current) + 1n).toString();

export function bindingId(binding: AgentBindingRef): string {
  return `${binding.nodeId}:${binding.agentId}:${String(binding.generation)}`;
}

export function sameBindingRef(
  left: AgentBindingRef,
  right: AgentBindingRef,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.agentId === right.agentId &&
    left.generation === right.generation
  );
}

export function revisionedId(runId: string, revision: string): string {
  return `${runId}:${revision}`;
}

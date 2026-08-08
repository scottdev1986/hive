import { createHash } from "node:crypto";
import {
  type WorkspaceEventV2,
  type WorkspaceSnapshotV2,
  WorkspaceSnapshotV2Schema,
} from "../../schemas/status-envelope";
import { canonicalJson } from "./status-canonical";

export { canonicalJson } from "./status-canonical";

export type StatusReducerProjection = Readonly<{
  highWaterSeq: string;
  paused: boolean;
  recovery: "SNAPSHOT_REQUIRED" | null;
  corruption: string | null;
  entities: Readonly<Record<string, unknown>>;
  seen: Readonly<Record<string, string>>;
}>;

export const emptyStatusProjection = (): StatusReducerProjection => ({
  highWaterSeq: "0",
  paused: false,
  recovery: null,
  corruption: null,
  entities: {},
  seen: {},
});

export const statusEntityKey = (entity: WorkspaceEventV2["entity"]): string =>
  entity.kind === "agent"
    ? `agent:${entity.id}`
    : `${entity.kind}:${entity.id}:${entity.generation ?? "-"}`;

export function reduceStatusEvent(
  state: StatusReducerProjection,
  event: WorkspaceEventV2,
): StatusReducerProjection {
  if (state.paused || state.corruption !== null) return state;
  const encoded = canonicalJson(event);
  const prior = state.seen[event.eventId];
  if (prior !== undefined) {
    if (prior === encoded) return state;
    return { ...state, corruption: `conflicting duplicate ${event.eventId}` };
  }
  if (BigInt(event.seq) !== BigInt(state.highWaterSeq) + 1n) {
    return { ...state, paused: true, recovery: "SNAPSHOT_REQUIRED" };
  }

  const seen = { ...state.seen, [event.eventId]: encoded };
  const key = statusEntityKey(event.entity);
  const existing = state.entities[key] as
    | { entityRevision?: string }
    | undefined;
  const entities =
    existing !== undefined &&
    BigInt(event.entityRevision) < BigInt(existing.entityRevision ?? "0")
      ? state.entities
      : {
          ...state.entities,
          [key]: {
            entityRevision: event.entityRevision,
            eventId: event.eventId,
            kind: event.kind,
            occurredAt: event.occurredAt,
            source: event.source,
            data: event.data,
          },
        };
  return { ...state, highWaterSeq: event.seq, entities, seen };
}

export class InvalidWorkspaceSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkspaceSnapshotError";
  }
}

export function verifyWorkspaceSnapshot(
  value: unknown,
  lastAppliedSeq: string,
): WorkspaceSnapshotV2 {
  const parsed = WorkspaceSnapshotV2Schema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidWorkspaceSnapshotError(
      "Workspace snapshot schema is invalid",
    );
  }
  const snapshot = parsed.data;
  const digest = createHash("sha256")
    .update(canonicalJson(snapshot.entities), "utf8")
    .digest("hex");
  if (digest !== snapshot.contentSha256) {
    throw new InvalidWorkspaceSnapshotError(
      "Workspace snapshot digest mismatch",
    );
  }
  if (BigInt(snapshot.seq) < BigInt(lastAppliedSeq)) {
    throw new InvalidWorkspaceSnapshotError(
      "Workspace snapshot high-water regressed",
    );
  }
  return snapshot;
}

export function reconcileStatusSnapshot(
  state: StatusReducerProjection,
  value: unknown,
): StatusReducerProjection {
  const snapshot = verifyWorkspaceSnapshot(value, state.highWaterSeq);
  const entities = Object.fromEntries(
    snapshot.entities.map((entity) => [
      statusEntityKey(entity),
      { ...entity.projection, entityRevision: entity.entityRevision },
    ]),
  );
  return {
    highWaterSeq: snapshot.seq,
    paused: false,
    recovery: null,
    corruption: null,
    entities,
    seen: {},
  };
}

export interface WorkspaceStatusEventSource {
  subscribe(afterSeq: string): AsyncIterable<WorkspaceEventV2>;
  fetchSnapshot(): Promise<unknown>;
}

/** A source event before the store assigns it a seq, eventId, and entityRevision — what `StatusStore.appendSourceEvent(s)` accepts from a live caller (e.g. the sessiond status bridge in `server.ts`). */
export type WorkspaceStatusSourceEvent = Omit<
  WorkspaceEventV2,
  "schemaVersion" | "eventId" | "seq" | "entityRevision"
>;

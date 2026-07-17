import { createHash } from "node:crypto";
import {
  WorkspaceEventV2Schema,
  WorkspaceSnapshotV2Schema,
  type WorkspaceEventV2,
  type WorkspaceSnapshotV2,
} from "../schemas/status-envelope";
import type { SessionEvent } from "./session-host/contract";

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

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

const entityKey = (
  entity: WorkspaceEventV2["entity"],
): string => `${entity.kind}:${entity.id}:${entity.generation ?? "-"}`;

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
  const key = entityKey(event.entity);
  const existing = state.entities[key] as { entityRevision?: string } | undefined;
  const entities = existing !== undefined &&
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
    throw new InvalidWorkspaceSnapshotError("Workspace snapshot schema is invalid");
  }
  const snapshot = parsed.data;
  const digest = createHash("sha256")
    .update(canonicalJson(snapshot.entities), "utf8")
    .digest("hex");
  if (digest !== snapshot.contentSha256) {
    throw new InvalidWorkspaceSnapshotError("Workspace snapshot digest mismatch");
  }
  if (BigInt(snapshot.seq) < BigInt(lastAppliedSeq)) {
    throw new InvalidWorkspaceSnapshotError("Workspace snapshot high-water regressed");
  }
  return snapshot;
}

export function reconcileStatusSnapshot(
  state: StatusReducerProjection,
  value: unknown,
): StatusReducerProjection {
  const snapshot = verifyWorkspaceSnapshot(value, state.highWaterSeq);
  const entities = Object.fromEntries(snapshot.entities.map((entity) => [
    entityKey(entity),
    { ...entity.projection, entityRevision: entity.entityRevision },
  ]));
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

/**
 * Owns one resumable stream. A gap never reduces live data speculatively: the
 * current stream is abandoned, a verified snapshot replaces it, and the next
 * subscription begins at the snapshot high-water.
 */
export class ResumableStatusSubscription {
  private projection = emptyStatusProjection();

  constructor(
    private readonly source: WorkspaceStatusEventSource,
    initial: StatusReducerProjection = emptyStatusProjection(),
  ) {
    this.projection = initial;
  }

  get current(): StatusReducerProjection {
    return this.projection;
  }

  async reconcile(): Promise<StatusReducerProjection> {
    this.projection = reconcileStatusSnapshot(
      this.projection,
      await this.source.fetchSnapshot(),
    );
    return this.projection;
  }

  async run(
    onProjection: (projection: StatusReducerProjection) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const aborted = () => signal?.aborted === true;
    while (!aborted()) {
      let resubscribe = false;
      for await (const raw of this.source.subscribe(this.projection.highWaterSeq)) {
        if (aborted()) return;
        const event = WorkspaceEventV2Schema.parse(raw);
        const reduced = reduceStatusEvent(this.projection, event);
        if (reduced.recovery === "SNAPSHOT_REQUIRED") {
          this.projection = reduced;
          onProjection(this.projection);
          await this.reconcile();
          onProjection(this.projection);
          resubscribe = true;
          break;
        }
        this.projection = reduced;
        onProjection(this.projection);
        if (this.projection.corruption !== null) return;
      }
      if (!resubscribe) return;
    }
  }
}

/** WP3 binds its broker here after landing; WP7 never imports that broker. */
export interface SessionStatusSourceAdapter {
  adapt(event: SessionEvent): WorkspaceStatusSourceEvent | null;
}

export type WorkspaceStatusSourceEvent = Omit<
  WorkspaceEventV2,
  "schemaVersion" | "eventId" | "seq" | "entityRevision"
>;

export class FakeSessionStatusSourceAdapter implements SessionStatusSourceAdapter {
  constructor(
    private readonly mapping: (event: SessionEvent) => WorkspaceStatusSourceEvent | null,
  ) {}

  adapt(event: SessionEvent): WorkspaceStatusSourceEvent | null {
    return this.mapping(event);
  }
}

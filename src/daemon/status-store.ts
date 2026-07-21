import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  FlatAssignmentSchema,
  HiveUpdateStatusInputSchema,
  WorkspaceEventV2Schema,
  WorkspaceSnapshotV2Schema,
  type FlatAssignment,
  type HiveUpdateStatusAdvertisedInput,
  type WorkspaceEventV2,
  type WorkspaceSnapshotV2,
} from "../schemas/status-envelope";
import type { Role } from "./capabilities";
import type { HiveDatabase } from "./db";
import {
  canonicalJson,
  statusEntityKey,
  type WorkspaceStatusEventSource,
} from "./status-events";
import type { WorkspaceStatusSourceEvent } from "./status-events";
import { fuseAgentStatus } from "./status-fusion";

const RequestRowSchema = z.object({ digest: z.string(), result: z.string() });
const EventRowSchema = z.object({ payload: z.string() });

export type StatusReportResult = Readonly<{
  eventId: string;
  eventSeq: string;
  reportRevision: string;
  expiresAt: string;
  currentConflicts: readonly string[];
}>;

export class StatusRequestConflictError extends Error {
  readonly code = "STATUS_REQUEST_CONFLICT";

  constructor(requestId: string) {
    super(`STATUS_REQUEST_CONFLICT: request ${requestId} was retried with different content`);
    this.name = "StatusRequestConflictError";
  }
}

export class StatusAssignmentMismatchError extends Error {
  readonly code = "STATUS_ASSIGNMENT_MISMATCH";

  constructor() {
    super("STATUS_ASSIGNMENT_MISMATCH: status report does not match the caller's open Assignment");
    this.name = "StatusAssignmentMismatchError";
  }
}

const uuidV7 = (prefix: "asg" | "evt"): string => {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const nextDecimal = (value: string | null): string =>
  (BigInt(value ?? "0") + 1n).toString();

export class StatusStore implements WorkspaceStatusEventSource {
  private readonly listeners = new Set<(event: WorkspaceEventV2) => void>();

  constructor(
    private readonly db: HiveDatabase,
    readonly instanceId: string,
  ) {
    db.database.exec(`
      CREATE TABLE IF NOT EXISTS status_assignments (
        assignmentId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        assignmentGeneration TEXT NOT NULL,
        state TEXT NOT NULL,
        openedAt TEXT NOT NULL,
        closedAt TEXT,
        UNIQUE(agentId, assignmentGeneration)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS status_assignments_one_open
        ON status_assignments(agentId) WHERE state = 'open';
      CREATE TABLE IF NOT EXISTS status_workspace_events (
        eventId TEXT PRIMARY KEY,
        seq TEXT NOT NULL UNIQUE,
        entityKey TEXT NOT NULL,
        entityRevision TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS status_counters (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS status_requests (
        caller TEXT NOT NULL,
        requestId TEXT NOT NULL,
        digest TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY(caller, requestId)
      );
    `);
  }

  openAssignment(agentId: string, openedAt: string): FlatAssignment {
    return this.db.transaction(() => {
      const open = this.currentAssignment(agentId);
      if (open !== null) return open;
      const prior = this.db.database.query(`
        SELECT assignmentGeneration FROM status_assignments
        WHERE agentId = ?
        ORDER BY length(assignmentGeneration) DESC, assignmentGeneration DESC
        LIMIT 1
      `).get(agentId) as { assignmentGeneration: string } | null;
      const assignment = FlatAssignmentSchema.parse({
        assignmentId: uuidV7("asg"),
        agentId,
        assignmentGeneration: nextDecimal(prior?.assignmentGeneration ?? null),
        state: "open",
        openedAt,
        closedAt: null,
      });
      this.db.database.query(`
        INSERT INTO status_assignments (
          assignmentId, agentId, assignmentGeneration, state, openedAt, closedAt
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        assignment.assignmentId,
        assignment.agentId,
        assignment.assignmentGeneration,
        assignment.state,
        assignment.openedAt,
        assignment.closedAt,
      );
      return assignment;
    });
  }

  closeAssignment(agentId: string, closedAt: string): FlatAssignment | null {
    return this.db.transaction(() => {
      const open = this.currentAssignment(agentId);
      if (open === null) return null;
      this.db.database.query(`
        UPDATE status_assignments SET state = 'closed', closedAt = ?
        WHERE assignmentId = ? AND state = 'open'
      `).run(closedAt, open.assignmentId);
      return FlatAssignmentSchema.parse({ ...open, state: "closed", closedAt });
    });
  }

  currentAssignment(agentId: string): FlatAssignment | null {
    const row = this.db.database.query(`
      SELECT assignmentId, agentId, assignmentGeneration, state, openedAt, closedAt
      FROM status_assignments WHERE agentId = ? AND state = 'open'
    `).get(agentId);
    return row === null ? null : FlatAssignmentSchema.parse(row);
  }

  hasAssignmentHistory(agentId: string): boolean {
    return this.db.database.query(
      "SELECT 1 FROM status_assignments WHERE agentId = ? LIMIT 1",
    ).get(agentId) !== null;
  }

  appendAgentReport(
    actor: Readonly<{
      subject: string;
      agentId: string;
      role: Role;
      incarnationGeneration: number;
      capabilityEpoch: number;
      toolSessionId: string | null;
    }>,
    // The daemon mints requestId when the caller omits it, so the store always
    // receives one even though the advertised MCP schema makes it optional.
    rawInput: HiveUpdateStatusAdvertisedInput & { requestId: string },
    now: Date,
  ): StatusReportResult {
    const input = HiveUpdateStatusInputSchema.parse(rawInput);
    const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const result = this.db.transaction(() => {
      const priorValue = this.db.database.query(`
        SELECT digest, result FROM status_requests WHERE caller = ? AND requestId = ?
      `).get(actor.subject, input.requestId);
      if (priorValue !== null) {
        const prior = RequestRowSchema.parse(priorValue);
        if (prior.digest !== digest) throw new StatusRequestConflictError(input.requestId);
        return JSON.parse(prior.result) as StatusReportResult;
      }

      const assignment = this.currentAssignment(actor.agentId);
      // Three axes stay separate: incarnationGeneration comes from the live
      // authenticated SessionLocator, capabilityEpoch rotates authority, and
      // assignmentGeneration is the prompt literal validated against this row.
      // Exact matching stops a stale predecessor reporting for its successor.
      if (
        assignment === null || assignment.assignmentId !== input.assignmentId ||
        assignment.assignmentGeneration !== input.assignmentGeneration
      ) throw new StatusAssignmentMismatchError();

      const observedAt = now.toISOString();
      const expiresAt = new Date(
        now.getTime() + input.freshForSeconds * 1_000,
      ).toISOString();
      const appended = this.appendEventInTransaction({
        entity: {
          kind: "agent",
          id: actor.agentId,
        },
        occurredAt: observedAt,
        kind: "agent.status-reported",
        source: {
          kind: "agent-report",
          id: `${actor.agentId}:${assignment.assignmentGeneration}`,
          observedAt,
          confidence: "authoritative",
        },
        data: {
          authenticated: true,
          requestId: input.requestId,
          assignmentId: input.assignmentId,
          assignmentGeneration: input.assignmentGeneration,
          phase: input.phase,
          ...(input.progress === undefined ? {} : { progress: input.progress }),
          summary: input.summary,
          blocker: input.blocker,
          evidenceRefs: input.evidenceRefs,
          ...(input.nextCheckpoint === undefined
            ? {}
            : { nextCheckpoint: input.nextCheckpoint }),
          freshUntil: expiresAt,
          binding: {
            agentId: actor.agentId,
            incarnationGeneration: actor.incarnationGeneration,
            role: actor.role,
            instanceId: this.instanceId,
            capabilityEpoch: actor.capabilityEpoch,
            issuer: "hive-daemon",
            session: actor.toolSessionId,
          },
        },
      });
      const events = this.listEventsForAgent(actor.agentId);
      const currentConflicts = fuseAgentStatus(
        events,
        {
          agentId: actor.agentId,
          incarnationGeneration: actor.incarnationGeneration,
        },
        now,
      ).conflicts;
      const value: StatusReportResult = {
        eventId: appended.eventId,
        eventSeq: appended.seq,
        reportRevision: appended.entityRevision,
        expiresAt,
        currentConflicts,
      };
      this.db.database.query(`
        INSERT INTO status_requests (caller, requestId, digest, result)
        VALUES (?, ?, ?, ?)
      `).run(actor.subject, input.requestId, digest, JSON.stringify(value));
      return value;
    });
    const appended = this.eventById(result.eventId);
    if (appended !== null) this.publish(appended);
    return result;
  }

  appendSourceEvent(event: WorkspaceStatusSourceEvent): WorkspaceEventV2 {
    const appended = this.db.transaction(() => this.appendEventInTransaction(event));
    this.publish(appended);
    return appended;
  }

  appendObservationAudit(input: Readonly<{
    reader: string;
    readerRole: Role;
    subjectAgentId: string;
    subjectGeneration: number;
    rowCount: number;
    reason: string;
    observedAt: string;
  }>): WorkspaceEventV2 {
    const event = this.db.transaction(() => this.appendEventInTransaction({
      entity: {
        kind: "agent",
        id: input.subjectAgentId,
      },
      occurredAt: input.observedAt,
      kind: "terminal.content-observed",
      source: {
        kind: input.readerRole === "operator" ? "operator" : "agent-report",
        id: input.reader,
        observedAt: input.observedAt,
        confidence: "authoritative",
      },
      data: {
        reader: input.reader,
        subject: input.subjectAgentId,
        sessionGeneration: input.subjectGeneration,
        rowCount: input.rowCount,
        reason: input.reason,
      },
    }));
    this.publish(event);
    return event;
  }

  listEvents(afterSeq = "0"): WorkspaceEventV2[] {
    const rows = this.db.database.query(`
      SELECT payload FROM status_workspace_events
      WHERE length(seq) > length(?) OR (length(seq) = length(?) AND seq > ?)
      ORDER BY length(seq), seq
    `).all(afterSeq, afterSeq, afterSeq);
    return rows.map((row) => WorkspaceEventV2Schema.parse(
      JSON.parse(EventRowSchema.parse(row).payload),
    ));
  }

  listEventsForAgent(agentId: string): WorkspaceEventV2[] {
    return this.listEvents().filter((event) =>
      event.entity.id === agentId || event.data.agentId === agentId
    );
  }

  async *subscribe(afterSeq: string): AsyncIterable<WorkspaceEventV2> {
    let highWater = afterSeq;
    const queue: WorkspaceEventV2[] = [];
    let wake: (() => void) | null = null;
    const listener = (event: WorkspaceEventV2) => {
      if (BigInt(event.seq) <= BigInt(highWater)) return;
      queue.push(event);
      wake?.();
    };
    this.listeners.add(listener);
    try {
      for (const event of this.listEvents(afterSeq)) {
        highWater = event.seq;
        yield event;
      }
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
        const event = queue.shift();
        if (event !== undefined && BigInt(event.seq) > BigInt(highWater)) {
          highWater = event.seq;
          yield event;
        }
      }
    } finally {
      this.listeners.delete(listener);
    }
  }

  async fetchSnapshot(): Promise<WorkspaceSnapshotV2> {
    const events = this.listEvents();
    const agents = new Set<string>();
    for (const event of events) {
      const agentId = event.entity.kind === "agent"
        ? event.entity.id
        : typeof event.data.agentId === "string" ? event.data.agentId : null;
      if (agentId !== null) agents.add(agentId);
    }
    const createdAt = new Date().toISOString();
    const entities = [...agents].map((agentId) => {
      const incarnationGeneration = [...events].reverse().map((event) => {
        const binding = event.data.binding;
        if (
          event.entity.kind === "agent" && event.entity.id === agentId &&
          typeof binding === "object" && binding !== null &&
          "incarnationGeneration" in binding &&
          typeof binding.incarnationGeneration === "number"
        ) return binding.incarnationGeneration;
        if (
          event.entity.kind === "session" && event.data.agentId === agentId &&
          event.entity.generation !== undefined
        ) return event.entity.generation;
        return null;
      }).find((generation) => generation !== null) ?? null;
      const projection = fuseAgentStatus(
        events,
        { agentId, incarnationGeneration },
        new Date(createdAt),
      );
      return {
        kind: "agent",
        id: agentId,
        entityRevision: projection.revision,
        projection: JSON.parse(JSON.stringify(projection)) as Record<string, unknown>,
      };
    });
    const value = {
      schemaVersion: 2 as const,
      instanceId: this.instanceId,
      seq: events.at(-1)?.seq ?? "0",
      entities,
      createdAt,
      contentSha256: createHash("sha256")
        .update(canonicalJson(entities), "utf8")
        .digest("hex"),
    };
    return WorkspaceSnapshotV2Schema.parse(value);
  }

  private appendEventInTransaction(
    event: Omit<WorkspaceEventV2, "schemaVersion" | "eventId" | "seq" | "entityRevision">,
  ): WorkspaceEventV2 {
    const seq = this.nextCounter("instance-seq");
    const key = statusEntityKey(event.entity);
    const entityRevision = this.nextCounter(`entity:${key}`);
    const value = WorkspaceEventV2Schema.parse({
      ...event,
      schemaVersion: 2,
      eventId: uuidV7("evt"),
      seq,
      entityRevision,
    });
    this.db.database.query(`
      INSERT INTO status_workspace_events (
        eventId, seq, entityKey, entityRevision, payload
      ) VALUES (?, ?, ?, ?, ?)
    `).run(value.eventId, value.seq, key, value.entityRevision, canonicalJson(value));
    return value;
  }

  private nextCounter(key: string): string {
    const row = this.db.database.query(
      "SELECT value FROM status_counters WHERE key = ?",
    ).get(key) as { value: string } | null;
    const value = nextDecimal(row?.value ?? null);
    this.db.database.query(`
      INSERT INTO status_counters (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
    return value;
  }

  private eventById(eventId: string): WorkspaceEventV2 | null {
    const row = this.db.database.query(
      "SELECT payload FROM status_workspace_events WHERE eventId = ?",
    ).get(eventId);
    return row === null
      ? null
      : WorkspaceEventV2Schema.parse(JSON.parse(EventRowSchema.parse(row).payload));
  }

  private publish(event: WorkspaceEventV2): void {
    for (const listener of this.listeners) listener(event);
  }
}

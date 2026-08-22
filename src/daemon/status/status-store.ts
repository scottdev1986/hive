import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { AgentRecord } from "../../schemas/agent";
import { isNumber, isRecord, isString } from "../../shared/is-record";
import type {
  AgentBindingRef,
  HierarchyNode,
} from "../../schemas/hierarchy-node";
import type { StrandedManifestAttention } from "../../schemas/hierarchy-projection";
import {
  type FlatAssignment,
  FlatAssignmentSchema,
  type HiveUpdateStatusAdvertisedInput,
  HiveUpdateStatusInputSchema,
  type WorkspaceEventV2,
  WorkspaceEventV2Schema,
  type WorkspaceSnapshotV2,
  WorkspaceSnapshotV2Schema,
} from "../../schemas/status-envelope";
import type { DatabaseHost } from "../../shared/database-host";
import { definedFields } from "../../shared/defined-fields";
import type { Role } from "../../schemas/capability";
import { HierarchyStore } from "../hierarchy-store";
import {
  ManifestJournal,
  projectStrandedManifestAttention,
} from "../manifest-journal";
import type { WorkspaceStatusSourceEvent } from "../status-service/events";
import {
  canonicalJson,
  statusEntityKey,
  type WorkspaceStatusEventSource,
} from "../status-service/events";
import {
  fuseAgentStatus,
  type ProviderCapabilitiesEvidence,
} from "../status-service/fusion";
import {
  isActiveAttentionEvent,
  isAuthenticatedReportEvent,
  statusCandidateForEvent,
} from "../status-service/status-current-projection";
import {
  projectHierarchyEntities,
  projectStrandedManifestEntity,
} from "../status-service/status-hierarchy-projection";
import type { JsonObject } from "../../shared/json";

interface StatusDatabase extends DatabaseHost {
  getAgentById(id: string): AgentRecord | null;
}

const RequestRowSchema = z.object({ digest: z.string(), result: z.string() });
const EventRowSchema = z.object({ payload: z.string() });
const ProjectionEventRowSchema = z.object({ payload: z.string() });
const ProjectionRevisionRowSchema = z.object({ revision: z.string() });
const ProviderReceiptRowSchema = z.object({ projection: z.string() });

const STATUS_PROJECTION_VERSION = "1";

const sequenceKey = (sequence: string): string => sequence.padStart(20, "0");

const subjectAgentId = (event: WorkspaceEventV2): string => {
  if (event.entity.kind === "agent") return event.entity.id;
  return isString(event.data.agentId) ? event.data.agentId : "";
};

const statusDimension = (kind: string): string | null =>
  kind.startsWith("status.") && kind !== "status.attention-resolved"
    ? kind.slice("status.".length)
    : null;

export type StatusCurrentProjection = Readonly<{
  revision: string;
  events: readonly WorkspaceEventV2[];
}>;

export type ProviderReportAcceptance =
  | Readonly<{ kind: "appended"; events: readonly WorkspaceEventV2[] }>
  | Readonly<{ kind: "duplicate" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "stale"; newestSequence: number }>;

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
    super(
      `STATUS_REQUEST_CONFLICT: request ${requestId} was retried with different content`,
    );
    this.name = "StatusRequestConflictError";
  }
}

export class StatusAssignmentMismatchError extends Error {
  readonly code = "STATUS_ASSIGNMENT_MISMATCH";

  constructor() {
    super(
      "STATUS_ASSIGNMENT_MISMATCH: status report does not match the caller's open Assignment",
    );
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
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const nextDecimal = (value: string | null): string =>
  (BigInt(value ?? "0") + 1n).toString();

/** The binding ref each node currently holds. A node accumulates one binding per incarnation, and unbinding stamps the record rather than deleting it, so the live binding is the never-unbound one at the newest generation. Nodes with no live binding are left out: the projection renders that as an absent binding, not as an empty one. */
function liveBindings(
  store: HierarchyStore,
  nodes: readonly HierarchyNode[],
): Map<string, AgentBindingRef> {
  const live = new Map<string, AgentBindingRef>();
  for (const node of nodes) {
    const newest = store
      .findBindingsByNode(node.nodeId)
      .filter((binding) => binding.unboundAt === null)
      .sort((a, b) => b.generation - a.generation)
      .at(0);
    if (newest === undefined) continue;
    live.set(node.nodeId, {
      nodeId: newest.nodeId,
      agentId: newest.agentId,
      generation: newest.generation,
    });
  }
  return live;
}

export class StatusStore implements WorkspaceStatusEventSource {
  private readonly listeners = new Set<(event: WorkspaceEventV2) => void>();
  private readonly providerCapabilities = new Map<
    string,
    ProviderCapabilitiesEvidence
  >();

  constructor(
    private readonly db: StatusDatabase,
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
        seqKey TEXT NOT NULL,
        entityKey TEXT NOT NULL,
        subjectAgentId TEXT NOT NULL,
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
    this.migrateStatusStorage();
  }

  private migrateStatusStorage(): void {
    const columns = new Set(
      // SAFETY: The surrounding code already established this contract.
      (
        this.db.database
          .query("PRAGMA table_info(status_workspace_events)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!columns.has("seqKey")) {
      this.db.database.exec(
        "ALTER TABLE status_workspace_events ADD COLUMN seqKey TEXT",
      );
    }
    if (!columns.has("subjectAgentId")) {
      this.db.database.exec(
        "ALTER TABLE status_workspace_events ADD COLUMN subjectAgentId TEXT",
      );
    }
    this.db.database.exec(`
      CREATE INDEX IF NOT EXISTS status_workspace_events_seq_key
        ON status_workspace_events(seqKey);
      CREATE INDEX IF NOT EXISTS status_workspace_events_agent_seq
        ON status_workspace_events(subjectAgentId, seqKey);
      CREATE INDEX IF NOT EXISTS status_workspace_events_entity_seq
        ON status_workspace_events(entityKey, seqKey);
      CREATE TABLE IF NOT EXISTS status_agent_current_events (
        agentId TEXT NOT NULL,
        slot TEXT NOT NULL,
        eventId TEXT NOT NULL,
        seqKey TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(agentId, slot)
      );
      CREATE INDEX IF NOT EXISTS status_agent_current_events_agent_seq
        ON status_agent_current_events(agentId, seqKey);
      CREATE TABLE IF NOT EXISTS status_agent_current_revisions (
        agentId TEXT PRIMARY KEY,
        revision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS status_provider_reports (
        sourceId TEXT NOT NULL,
        providerSequence INTEGER NOT NULL,
        projection TEXT NOT NULL,
        PRIMARY KEY(sourceId, providerSequence)
      );
      CREATE INDEX IF NOT EXISTS status_provider_reports_latest
        ON status_provider_reports(sourceId, providerSequence DESC);
      CREATE TABLE IF NOT EXISTS status_projection_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.db.transaction(() => {
      // SAFETY: The surrounding code already established this contract.
      const metadataRows = this.db.database
        .query(
          `
          SELECT eventId, seq, payload FROM status_workspace_events
          WHERE seqKey IS NULL OR subjectAgentId IS NULL
          ORDER BY length(seq), seq
        `,
        )
        .all() as Array<{ eventId: string; seq: string; payload: string }>;
      const updateMetadata = this.db.database.query(`
        UPDATE status_workspace_events
        SET seqKey = ?, subjectAgentId = ?
        WHERE eventId = ?
      `);
      for (const row of metadataRows) {
        const event = WorkspaceEventV2Schema.parse(JSON.parse(row.payload));
        updateMetadata.run(
          sequenceKey(row.seq),
          subjectAgentId(event),
          row.eventId,
        );
      }

      // SAFETY: The surrounding code already established this contract.
      const projectionVersion = this.db.database
        .query(
          "SELECT value FROM status_projection_metadata WHERE key = 'version'",
        )
        .get() as { value: string } | null;
      if (projectionVersion?.value === STATUS_PROJECTION_VERSION) return;

      this.db.database.exec(`
        DELETE FROM status_agent_current_events;
        DELETE FROM status_agent_current_revisions;
        DELETE FROM status_provider_reports;
      `);
      // SAFETY: The surrounding code already established this contract.
      const rows = this.db.database
        .query("SELECT payload FROM status_workspace_events ORDER BY seqKey")
        .all() as Array<{ payload: string }>;
      const providerProjections = new Map<
        string,
        {
          sourceId: string;
          sequence: number;
          projection: JsonObject;
        }
      >();
      for (const row of rows) {
        const event = WorkspaceEventV2Schema.parse(JSON.parse(row.payload));
        this.projectAgentEventInTransaction(event);
        if (
          event.source.kind !== "provider-protocol" ||
          !isNumber(event.data.providerSequence)
        ) {
          continue;
        }
        const sequence = event.data.providerSequence;
        const key = `${event.source.id}\u0000${sequence}`;
        const entry = providerProjections.get(key) ?? {
          sourceId: event.source.id,
          sequence,
          projection: {},
        };
        if (event.kind === "status.runtime") {
          entry.projection.runtime = event.data.value;
        } else if (event.kind === "status.turn") {
          entry.projection.turn = event.data.value;
        }
        providerProjections.set(key, entry);
      }
      const insertProviderProjection = this.db.database.query(`
        INSERT INTO status_provider_reports (
          sourceId, providerSequence, projection
        ) VALUES (?, ?, ?)
      `);
      for (const entry of providerProjections.values()) {
        if (Object.keys(entry.projection).length === 0) continue;
        insertProviderProjection.run(
          entry.sourceId,
          entry.sequence,
          canonicalJson(entry.projection),
        );
      }
      this.db.database
        .query(
          `
          INSERT INTO status_projection_metadata (key, value)
          VALUES ('version', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        )
        .run(STATUS_PROJECTION_VERSION);
    });
  }

  replaceProviderCapabilities(
    subject: string,
    evidence: ProviderCapabilitiesEvidence,
  ): void {
    this.providerCapabilities.set(subject, evidence);
  }

  providerCapabilitiesFor(
    subject: string,
  ): ProviderCapabilitiesEvidence | null {
    return this.providerCapabilities.get(subject) ?? null;
  }

  openAssignment(agentId: string, openedAt: string): FlatAssignment {
    return this.db.transaction(() => {
      const open = this.currentAssignment(agentId);
      if (open !== null) return open;
      // SAFETY: The surrounding code already established this contract.
      const prior = this.db.database
        .query(
          `
        SELECT assignmentGeneration FROM status_assignments
        WHERE agentId = ?
        ORDER BY length(assignmentGeneration) DESC, assignmentGeneration DESC
        LIMIT 1
      `,
        )
        .get(agentId) as { assignmentGeneration: string } | null;
      const assignment = FlatAssignmentSchema.parse({
        assignmentId: uuidV7("asg"),
        agentId,
        assignmentGeneration: nextDecimal(prior?.assignmentGeneration ?? null),
        state: "open",
        openedAt,
        closedAt: null,
      });
      this.db.database
        .query(
          `
        INSERT INTO status_assignments (
          assignmentId, agentId, assignmentGeneration, state, openedAt, closedAt
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
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
      this.db.database
        .query(
          `
        UPDATE status_assignments SET state = 'closed', closedAt = ?
        WHERE assignmentId = ? AND state = 'open'
      `,
        )
        .run(closedAt, open.assignmentId);
      return FlatAssignmentSchema.parse({ ...open, state: "closed", closedAt });
    });
  }

  currentAssignment(agentId: string): FlatAssignment | null {
    const row = this.db.database
      .query(
        `
      SELECT assignmentId, agentId, assignmentGeneration, state, openedAt, closedAt
      FROM status_assignments WHERE agentId = ? AND state = 'open'
    `,
      )
      .get(agentId);
    return row === null ? null : FlatAssignmentSchema.parse(row);
  }

  hasAssignmentHistory(agentId: string): boolean {
    return (
      this.db.database
        .query("SELECT 1 FROM status_assignments WHERE agentId = ? LIMIT 1")
        .get(agentId) !== null
    );
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
    rawInput: HiveUpdateStatusAdvertisedInput & { requestId: string },
    now: Date,
  ): StatusReportResult {
    const input = HiveUpdateStatusInputSchema.parse(rawInput);
    const digest = createHash("sha256")
      .update(canonicalJson(input))
      .digest("hex");
    const result = this.db.transaction(() => {
      const priorValue = this.db.database
        .query(
          `
        SELECT digest, result FROM status_requests WHERE caller = ? AND requestId = ?
      `,
        )
        .get(actor.subject, input.requestId);
      if (priorValue !== null) {
        const prior = RequestRowSchema.parse(priorValue);
        if (prior.digest !== digest)
          throw new StatusRequestConflictError(input.requestId);
        // SAFETY: The surrounding code already established this contract.
        return JSON.parse(prior.result) as StatusReportResult;
      }

      const assignment = this.currentAssignment(actor.agentId);
      // Three axes stay separate: incarnationGeneration comes from the live authenticated SessionLocator, capabilityEpoch rotates authority, and assignmentGeneration is the prompt literal validated against this row. Exact matching stops a stale predecessor reporting for its successor.
      if (
        assignment === null ||
        assignment.assignmentId !== input.assignmentId ||
        assignment.assignmentGeneration !== input.assignmentGeneration
      )
        throw new StatusAssignmentMismatchError();

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
          ...definedFields({ progress: input.progress }),
          summary: input.summary,
          blocker: input.blocker ?? null,
          evidenceRefs: input.evidenceRefs,
          ...definedFields({ nextCheckpoint: input.nextCheckpoint }),
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
      const events =
        this.currentProjectionForAgent(actor.agentId)?.events ?? [];
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
      this.db.database
        .query(
          `
        INSERT INTO status_requests (caller, requestId, digest, result)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(actor.subject, input.requestId, digest, JSON.stringify(value));
      return value;
    });
    const appended = this.eventById(result.eventId);
    if (appended !== null) this.publish(appended);
    return result;
  }

  appendSourceEvent(event: WorkspaceStatusSourceEvent): WorkspaceEventV2 {
    const appended = this.db.transaction(() =>
      this.appendEventInTransaction(event),
    );
    this.publish(appended);
    return appended;
  }

  appendSourceEvents(
    events: readonly WorkspaceStatusSourceEvent[],
  ): readonly WorkspaceEventV2[] {
    const appended = this.db.transaction(() =>
      events.map((event) => this.appendEventInTransaction(event)),
    );
    for (const event of appended) this.publish(event);
    return appended;
  }

  acceptProviderReport(
    input: Readonly<{
      sourceId: string;
      providerSequence: number;
      projection: string;
      events: readonly WorkspaceStatusSourceEvent[];
      onAppend?: () => void;
    }>,
  ): ProviderReportAcceptance {
    const result = this.db.transaction((): ProviderReportAcceptance => {
      const priorValue = this.db.database
        .query(
          `
          SELECT projection FROM status_provider_reports
          WHERE sourceId = ? AND providerSequence = ?
        `,
        )
        .get(input.sourceId, input.providerSequence);
      if (priorValue !== null) {
        const prior = ProviderReceiptRowSchema.parse(priorValue);
        return prior.projection === input.projection
          ? { kind: "duplicate" }
          : { kind: "conflict" };
      }

      // SAFETY: The surrounding code already established this contract.
      const newest = this.db.database
        .query(
          `
          SELECT providerSequence FROM status_provider_reports
          WHERE sourceId = ?
          ORDER BY providerSequence DESC LIMIT 1
        `,
        )
        .get(input.sourceId) as { providerSequence: number } | null;
      if (newest !== null && input.providerSequence < newest.providerSequence) {
        return { kind: "stale", newestSequence: newest.providerSequence };
      }

      const events = input.events.map((event) =>
        this.appendEventInTransaction(event),
      );
      this.db.database
        .query(
          `
          INSERT INTO status_provider_reports (
            sourceId, providerSequence, projection
          ) VALUES (?, ?, ?)
        `,
        )
        .run(input.sourceId, input.providerSequence, input.projection);
      input.onAppend?.();
      return { kind: "appended", events };
    });
    if (result.kind === "appended") {
      for (const event of result.events) this.publish(event);
    }
    return result;
  }

  appendObservationAudit(
    input: Readonly<{
      reader: string;
      readerRole: Role;
      subjectAgentId: string;
      subjectGeneration: number;
      rowCount: number;
      reason: string;
      observedAt: string;
    }>,
  ): WorkspaceEventV2 {
    const event = this.db.transaction(() =>
      this.appendEventInTransaction({
        entity: {
          kind: "agent",
          id: input.subjectAgentId,
        },
        occurredAt: input.observedAt,
        kind: "terminal.content-observed",
        source: {
          kind: input.readerRole === "user" ? "user" : "agent-report",
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
      }),
    );
    this.publish(event);
    return event;
  }

  /** Register a listener for every event this store publishes. Listeners run synchronously on the write path, so a listener that must not affect the primary record (e.g. episodic-memory projection) has to isolate its own failures. Returns an unsubscribe function. */
  onEvent(listener: (event: WorkspaceEventV2) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listEvents(afterSeq = "0"): WorkspaceEventV2[] {
    const rows = this.db.database
      .query(
        `
      SELECT payload FROM status_workspace_events
      WHERE seqKey > ?
      ORDER BY seqKey
    `,
      )
      .all(sequenceKey(afterSeq));
    return rows.map((row) =>
      WorkspaceEventV2Schema.parse(
        JSON.parse(EventRowSchema.parse(row).payload),
      ),
    );
  }

  listEventsForAgent(agentId: string): WorkspaceEventV2[] {
    const rows = this.db.database
      .query(
        `
        SELECT payload FROM status_workspace_events
        WHERE subjectAgentId = ?
        ORDER BY seqKey
      `,
      )
      .all(agentId);
    return rows.map((row) =>
      WorkspaceEventV2Schema.parse(
        JSON.parse(EventRowSchema.parse(row).payload),
      ),
    );
  }

  currentProjectionForAgent(agentId: string): StatusCurrentProjection | null {
    const revisionValue = this.db.database
      .query(
        "SELECT revision FROM status_agent_current_revisions WHERE agentId = ?",
      )
      .get(agentId);
    if (revisionValue === null) return null;
    const revision = ProjectionRevisionRowSchema.parse(revisionValue).revision;
    const rows = this.db.database
      .query(
        `
        SELECT payload FROM status_agent_current_events
        WHERE agentId = ?
        ORDER BY seqKey
      `,
      )
      .all(agentId);
    const unique = new Map<string, WorkspaceEventV2>();
    for (const row of rows) {
      const event = WorkspaceEventV2Schema.parse(
        JSON.parse(ProjectionEventRowSchema.parse(row).payload),
      );
      unique.set(event.eventId, event);
    }
    return { revision, events: [...unique.values()] };
  }

  /** The newest provider-native status event for one root ProviderRun. The
   * entity/run binding excludes stale predecessor sessions; seqKey supplies
   * daemon acceptance order when provider timestamps tie. */
  latestProviderStatusEvent(
    entity: WorkspaceEventV2["entity"],
    providerRunId: string,
    kind: "status.runtime" | "status.turn",
  ): WorkspaceEventV2 | null {
    const row = this.db.database
      .query(
        `
        SELECT payload FROM status_workspace_events
        WHERE entityKey = ?
          AND json_extract(payload, '$.source.kind') = 'provider-protocol'
          AND json_extract(payload, '$.data.providerRunId') = ?
          AND json_extract(payload, '$.kind') = ?
        ORDER BY seqKey DESC LIMIT 1
      `,
      )
      .get(statusEntityKey(entity), providerRunId, kind);
    if (row === null) return null;
    return WorkspaceEventV2Schema.parse(
      JSON.parse(EventRowSchema.parse(row).payload),
    );
  }

  /** The newest sequence this agent's own entity has produced, or null when it has produced nothing. A monotonic identity rather than a timestamp. A watcher that samples this before an action and again after can tell that the stream genuinely advanced; a wall clock only tells it that some clock moved, and every writer of a shared clock moves it. */
  newestAgentEventSeq(agentId: string): string | null {
    // SAFETY: The surrounding code already established this contract.
    const row = this.db.database
      .query(
        `
      SELECT seq FROM status_workspace_events
      WHERE entityKey = ?
      ORDER BY seqKey DESC LIMIT 1
    `,
      )
      .get(statusEntityKey({ kind: "agent", id: agentId })) as {
      seq: string;
    } | null;
    return row?.seq ?? null;
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
    // SAFETY: The surrounding code already established this contract.
    const agents = this.db.database
      .query(
        "SELECT agentId FROM status_agent_current_revisions ORDER BY agentId",
      )
      .all() as Array<{ agentId: string }>;
    const createdAt = new Date().toISOString();
    const agentEntities = agents.map(({ agentId }) => {
      const current = this.currentProjectionForAgent(agentId);
      if (current === null) {
        throw new Error(`status projection missing for ${agentId}`);
      }
      const events = current.events;
      const incarnationGeneration =
        [...events]
          .reverse()
          .map((event) => {
            const binding = event.data.binding;
            if (
              event.entity.kind === "agent" &&
              event.entity.id === agentId &&
              isRecord(binding) &&
              "incarnationGeneration" in binding &&
              isNumber(binding.incarnationGeneration)
            )
              return binding.incarnationGeneration;
            if (
              event.entity.kind === "session" &&
              event.data.agentId === agentId &&
              event.entity.generation !== undefined
            )
              return event.entity.generation;
            return null;
          })
          .find((generation) => generation !== null) ?? null;
      const projection = {
        ...fuseAgentStatus(
          events,
          { agentId, incarnationGeneration },
          new Date(createdAt),
          {},
          this.providerCapabilitiesFor(
            this.db.getAgentById(agentId)?.name ?? "",
          ),
        ),
        revision: current.revision,
      };
      return {
        kind: "agent",
        id: agentId,
        entityRevision: projection.revision,
        // SAFETY: The surrounding code already established this contract.
        projection: JSON.parse(JSON.stringify(projection)) as JsonObject,
      };
    });
    const entities = [...agentEntities, ...this.hierarchyEntities()];
    const value = {
      schemaVersion: 2 as const,
      instanceId: this.instanceId,
      seq: this.newestEventSeq(),
      entities,
      createdAt,
      contentSha256: createHash("sha256")
        .update(canonicalJson(entities), "utf8")
        .digest("hex"),
    };
    return WorkspaceSnapshotV2Schema.parse(value);
  }

  private newestEventSeq(): string {
    // SAFETY: The surrounding code already established this contract.
    const row = this.db.database
      .query(
        "SELECT seq FROM status_workspace_events ORDER BY seqKey DESC LIMIT 1",
      )
      .get() as { seq: string } | null;
    return row?.seq ?? "0";
  }

  /** The hierarchy half of the snapshot: store reads in, projected entities out. All decisions about what a record projects to belong to the projector, so this stays a load-and-call with no shaping of its own. Every field the projection can render is fed from a store read here. A field left unfed reads as absent, which the projection reports as "nothing supplied this" — an honest answer, but the wrong one when the record was sitting in the database the whole time. Only this instance's active run is the live picture — the same test liveRoot and hierarchyStatusContext already use. A leftover run from a previous instance identity stays in the store and stays off Live Run. A repo with no current Run asserts no topology. The stranded row is keyed by agent rather than by run and is emitted either way: gating an agent-keyed answer on run-keyed state is how stranded work in a repo with no Run yet would go missing. */
  private hierarchyEntities(): WorkspaceSnapshotV2["entities"] {
    const store = new HierarchyStore(this.db);
    const topology = store
      .listRuns()
      .filter(
        (run) =>
          run.instanceId === this.instanceId && run.lifecycle === "active",
      )
      .flatMap((run) => {
        const nodes = store.listNodes(run.runId);
        return projectHierarchyEntities({
          run,
          topology: store.getTopologyDecision(run.runId, run.topology.revision),
          budget: store.getRunBudget(run.runId, run.budget.revision),
          nodes,
          bindings: liveBindings(store, nodes),
          reviews: store.listReviews(run.runId),
          runDecisions: store.listRunControlDecisions(run.runId),
          transfers: store.listOwnershipTransfers(run.runId),
          tasks: store.listTasks(run.runId),
        });
      });

    const stranded = new ManifestJournal(this.db)
      .listAttention()
      .map(projectStrandedManifestAttention)
      .filter((item): item is StrandedManifestAttention => item !== null);
    return [...topology, projectStrandedManifestEntity(stranded)];
  }

  private appendEventInTransaction(
    event: Omit<
      WorkspaceEventV2,
      "schemaVersion" | "eventId" | "seq" | "entityRevision"
    >,
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
    this.db.database
      .query(
        `
      INSERT INTO status_workspace_events (
        eventId, seq, seqKey, entityKey, subjectAgentId, entityRevision, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        value.eventId,
        value.seq,
        sequenceKey(value.seq),
        key,
        subjectAgentId(value),
        value.entityRevision,
        canonicalJson(value),
      );
    this.projectAgentEventInTransaction(value);
    return value;
  }

  private projectAgentEventInTransaction(event: WorkspaceEventV2): void {
    const agentId = subjectAgentId(event);
    if (agentId === "") return;

    const priorRevision = this.db.database
      .query(
        "SELECT revision FROM status_agent_current_revisions WHERE agentId = ?",
      )
      .get(agentId);
    const revision =
      priorRevision === null
        ? event.entityRevision
        : ProjectionRevisionRowSchema.parse(priorRevision).revision;
    if (
      priorRevision === null ||
      BigInt(event.entityRevision) > BigInt(revision)
    ) {
      this.db.database
        .query(
          `
          INSERT INTO status_agent_current_revisions (agentId, revision)
          VALUES (?, ?)
          ON CONFLICT(agentId) DO UPDATE SET revision = excluded.revision
        `,
        )
        .run(agentId, event.entityRevision);
    }

    this.upsertProjectionSlot(agentId, "activity", event, false);
    const dimension = statusDimension(event.kind);
    if (dimension !== null) {
      this.upsertProjectionSlot(agentId, `heard:${dimension}`, event, true);
    }

    if (event.kind === "status.attention-resolved") {
      if (isString(event.data.causeEventId)) {
        this.db.database
          .query(
            `
            DELETE FROM status_agent_current_events
            WHERE agentId = ? AND slot = ?
          `,
          )
          .run(agentId, `attention:${event.data.causeEventId}`);
      }
      return;
    }
    if (event.kind === "status.attention") {
      if (isActiveAttentionEvent(event)) {
        this.upsertProjectionSlot(
          agentId,
          `attention:${event.eventId}`,
          event,
          false,
        );
      }
      return;
    }
    if (statusCandidateForEvent(event) !== null) {
      this.upsertProjectionSlot(
        agentId,
        `candidate:${event.kind}:${event.source.kind}:${event.source.id}`,
        event,
        true,
      );
    }
    if (isAuthenticatedReportEvent(event)) {
      this.upsertProjectionSlot(agentId, "report", event, false);
    }
  }

  private upsertProjectionSlot(
    agentId: string,
    slot: string,
    event: WorkspaceEventV2,
    preferNewestObservation: boolean,
  ): void {
    if (preferNewestObservation) {
      const priorValue = this.db.database
        .query(
          `
          SELECT payload FROM status_agent_current_events
          WHERE agentId = ? AND slot = ?
        `,
        )
        .get(agentId, slot);
      if (priorValue !== null) {
        const prior = WorkspaceEventV2Schema.parse(
          JSON.parse(ProjectionEventRowSchema.parse(priorValue).payload),
        );
        if (
          Date.parse(prior.source.observedAt) >=
          Date.parse(event.source.observedAt)
        ) {
          return;
        }
      }
    }
    this.db.database
      .query(
        `
        INSERT INTO status_agent_current_events (
          agentId, slot, eventId, seqKey, payload
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agentId, slot) DO UPDATE SET
          eventId = excluded.eventId,
          seqKey = excluded.seqKey,
          payload = excluded.payload
      `,
      )
      .run(
        agentId,
        slot,
        event.eventId,
        sequenceKey(event.seq),
        canonicalJson(event),
      );
  }

  private nextCounter(key: string): string {
    // SAFETY: The surrounding code already established this contract.
    const row = this.db.database
      .query("SELECT value FROM status_counters WHERE key = ?")
      .get(key) as { value: string } | null;
    const value = nextDecimal(row?.value ?? null);
    this.db.database
      .query(
        `
      INSERT INTO status_counters (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
      )
      .run(key, value);
    return value;
  }

  private eventById(eventId: string): WorkspaceEventV2 | null {
    const row = this.db.database
      .query("SELECT payload FROM status_workspace_events WHERE eventId = ?")
      .get(eventId);
    return row === null
      ? null
      : WorkspaceEventV2Schema.parse(
          JSON.parse(EventRowSchema.parse(row).payload),
        );
  }

  private publish(event: WorkspaceEventV2): void {
    for (const listener of this.listeners) listener(event);
  }
}

import { z } from "zod";
import type { NormalizedProviderEvent } from "../../adapters/providers/protocol/types";
import {
  type AgentRecord,
  canonicalOrchestratorName,
  ORCHESTRATOR_NAME,
} from "../../schemas/agent";
import type { HookEvent } from "../../schemas/event";
import type {
  RUNTIME_STATES,
  TURN_STATES,
  WorkspaceEventV2,
  WorkspaceStatusDimensionsV1,
} from "../../schemas/status-envelope";
import type { HiveDatabase } from "../database/hive-database";
import {
  buildActivitySnapshot,
  type ActivitySnapshotInput,
} from "./activity-snapshot";
import type { WorkspaceStatusSourceEvent } from "./events";
import { canonicalJson } from "./status-canonical";
import {
  fuseAgentStatus,
  type FusedAgentStatus,
  workspaceStatusDimensions,
} from "./fusion";
import { StatusStore } from "../status/status-store";
import {
  deriveOrchestratorStatus,
  type OrchestratorSignalKind,
  type OrchestratorStatus,
} from "./status-orchestrator";

const PROVIDER_RUNTIME_STATES = [
  "connecting",
  "ready",
  "disconnected",
  "exited",
] as const satisfies readonly (typeof RUNTIME_STATES)[number][];

const PROVIDER_TURN_STATES = [
  "idle",
  "queued",
  "working",
  "awaiting_approval",
  "awaiting_answer",
  "done",
  "failed",
] as const satisfies readonly (typeof TURN_STATES)[number][];

export const ProviderStatusProjectionSchema = z
  .strictObject({
    runtime: z.enum(PROVIDER_RUNTIME_STATES).optional(),
    turn: z.enum(PROVIDER_TURN_STATES).optional(),
  })
  .refine(
    (value) => value.runtime !== undefined || value.turn !== undefined,
    "a provider status report must carry runtime or turn state",
  );

export type ProviderStatusProjection = z.infer<
  typeof ProviderStatusProjectionSchema
>;

export const ProviderStatusReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  agent: z.string().min(1),
  providerRunId: z.string().uuid(),
  vendorSessionId: z.string().min(1),
  providerSequence: z.number().int().positive(),
  observedAt: z.iso.datetime({ offset: true }),
  projection: ProviderStatusProjectionSchema,
});

export type ProviderStatusReport = z.infer<typeof ProviderStatusReportSchema>;

export function statusProjectionForProviderEvent(
  event: NormalizedProviderEvent,
): ProviderStatusProjection | null {
  switch (event.kind) {
    case "runtime-connecting":
      return { runtime: "connecting" };
    case "runtime-ready":
      return { runtime: "ready" };
    case "runtime-disconnected":
      return { runtime: "disconnected" };
    case "run-ended":
      return { runtime: "exited", turn: "idle" };
    case "turn-queued":
      return { turn: "queued" };
    case "turn-started":
    case "tool-started":
      return { turn: "working" };
    case "turn-idle":
      return { turn: "done" };
    case "turn-failed":
      return { turn: "failed" };
    case "interrupted":
      return { turn: "idle" };
    case "approval-waiting":
      return { turn: "awaiting_approval" };
    case "question-waiting":
      return { turn: "awaiting_answer" };
    case "elicitation-settled":
      return { turn: "working" };
    case "message-delta":
    case "thought-delta":
    case "tool-updated":
    case "tool-finished":
    case "plan-updated":
    case "usage-updated":
    case "config-updated":
    case "compacted":
    case "turn-diff-updated":
    case "commands-updated":
    case "unrecognized":
      return null;
  }
}

export function providerStatusReportForEvent(
  context: Readonly<{
    agent: string;
    providerRunId: string;
    vendorSessionId: string;
  }>,
  event: NormalizedProviderEvent,
): ProviderStatusReport | null {
  const projection = statusProjectionForProviderEvent(event);
  if (projection === null) return null;
  return ProviderStatusReportSchema.parse({
    schemaVersion: 1,
    agent: context.agent,
    providerRunId: context.providerRunId,
    vendorSessionId: context.vendorSessionId,
    providerSequence: event.sequence,
    observedAt: event.occurredAt,
    projection,
  });
}

export function statusProjectionForHookEvent(
  event: HookEvent,
): ProviderStatusProjection | null {
  if (event.kind === "turn-start" || event.kind === "tool-start") {
    return { turn: "working" };
  }
  if (event.kind === "turn-end") return { turn: "done" };
  if (event.kind === "turn-failure") return { turn: "failed" };
  if (event.kind === "approval-request") {
    return { turn: "awaiting_approval" };
  }
  if (
    event.kind === "notification" &&
    event.notificationType === "permission_prompt"
  ) {
    return { turn: "awaiting_approval" };
  }
  return null;
}

export class AgentStatusConflictError extends Error {
  readonly code = "AGENT_STATUS_CONFLICT";

  constructor(message: string) {
    super(`AGENT_STATUS_CONFLICT: ${message}`);
    this.name = "AgentStatusConflictError";
  }
}

export class AgentStatusBindingError extends Error {
  readonly code = "AGENT_STATUS_BINDING";

  constructor(message: string) {
    super(`AGENT_STATUS_BINDING: ${message}`);
    this.name = "AgentStatusBindingError";
  }
}

type AgentStatusDatabase = Pick<
  HiveDatabase,
  | "getLiveAgentByName"
  | "getProviderRun"
  | "getAgentById"
  | "insertEvent"
  | "upsertAgent"
>;

function orchestratorEventsForProviderReport(
  report: ProviderStatusReport,
): readonly HookEvent[] {
  const shared = {
    agentName: ORCHESTRATOR_NAME,
    timestamp: report.observedAt,
    providerRunId: report.providerRunId,
    toolSessionId: report.vendorSessionId,
  };
  return [
    ...(report.projection.runtime === "ready"
      ? [{ ...shared, kind: "session-start" as const }]
      : []),
    ...(report.projection.turn === "working"
      ? [{ ...shared, kind: "turn-start" as const }]
      : report.projection.turn === "idle" ||
          report.projection.turn === "done" ||
          report.projection.turn === "failed"
        ? [{ ...shared, kind: "turn-end" as const }]
        : []),
    ...(report.projection.runtime === "exited"
      ? [{ ...shared, kind: "session-end" as const }]
      : []),
  ];
}

export class StatusService {
  static create(db: HiveDatabase, instanceId: string): StatusService {
    return new StatusService(db, new StatusStore(db, instanceId));
  }

  static fromStore(db: HiveDatabase, store: StatusStore): StatusService {
    return new StatusService(db, store);
  }

  private constructor(
    private readonly db: AgentStatusDatabase,
    private readonly events: StatusStore,
  ) {}

  get instanceId(): string {
    return this.events.instanceId;
  }

  replaceProviderCapabilities(
    ...args: Parameters<StatusStore["replaceProviderCapabilities"]>
  ): ReturnType<StatusStore["replaceProviderCapabilities"]> {
    return this.events.replaceProviderCapabilities(...args);
  }

  providerCapabilitiesFor(
    ...args: Parameters<StatusStore["providerCapabilitiesFor"]>
  ): ReturnType<StatusStore["providerCapabilitiesFor"]> {
    return this.events.providerCapabilitiesFor(...args);
  }

  openAssignment(
    ...args: Parameters<StatusStore["openAssignment"]>
  ): ReturnType<StatusStore["openAssignment"]> {
    return this.events.openAssignment(...args);
  }

  closeAssignment(
    ...args: Parameters<StatusStore["closeAssignment"]>
  ): ReturnType<StatusStore["closeAssignment"]> {
    return this.events.closeAssignment(...args);
  }

  currentAssignment(
    ...args: Parameters<StatusStore["currentAssignment"]>
  ): ReturnType<StatusStore["currentAssignment"]> {
    return this.events.currentAssignment(...args);
  }

  hasAssignmentHistory(
    ...args: Parameters<StatusStore["hasAssignmentHistory"]>
  ): ReturnType<StatusStore["hasAssignmentHistory"]> {
    return this.events.hasAssignmentHistory(...args);
  }

  appendAgentReport(
    ...args: Parameters<StatusStore["appendAgentReport"]>
  ): ReturnType<StatusStore["appendAgentReport"]> {
    return this.events.appendAgentReport(...args);
  }

  appendSourceEvent(
    ...args: Parameters<StatusStore["appendSourceEvent"]>
  ): ReturnType<StatusStore["appendSourceEvent"]> {
    return this.events.appendSourceEvent(...args);
  }

  appendObservationAudit(
    ...args: Parameters<StatusStore["appendObservationAudit"]>
  ): ReturnType<StatusStore["appendObservationAudit"]> {
    return this.events.appendObservationAudit(...args);
  }

  onEvent(
    ...args: Parameters<StatusStore["onEvent"]>
  ): ReturnType<StatusStore["onEvent"]> {
    return this.events.onEvent(...args);
  }

  listEvents(
    ...args: Parameters<StatusStore["listEvents"]>
  ): ReturnType<StatusStore["listEvents"]> {
    return this.events.listEvents(...args);
  }

  listEventsForAgent(
    ...args: Parameters<StatusStore["listEventsForAgent"]>
  ): ReturnType<StatusStore["listEventsForAgent"]> {
    return this.events.listEventsForAgent(...args);
  }

  newestAgentEventSeq(
    ...args: Parameters<StatusStore["newestAgentEventSeq"]>
  ): ReturnType<StatusStore["newestAgentEventSeq"]> {
    return this.events.newestAgentEventSeq(...args);
  }

  subscribe(
    ...args: Parameters<StatusStore["subscribe"]>
  ): ReturnType<StatusStore["subscribe"]> {
    return this.events.subscribe(...args);
  }

  fetchSnapshot(
    ...args: Parameters<StatusStore["fetchSnapshot"]>
  ): ReturnType<StatusStore["fetchSnapshot"]> {
    return this.events.fetchSnapshot(...args);
  }

  activitySnapshot(
    input: ActivitySnapshotInput,
  ): ReturnType<typeof buildActivitySnapshot> {
    return buildActivitySnapshot(input);
  }

  orchestratorStatus(
    signals: readonly OrchestratorSignalKind[],
  ): OrchestratorStatus | null {
    return deriveOrchestratorStatus(signals);
  }

  observeProvider(raw: ProviderStatusReport): FusedAgentStatus | null {
    const parsed = ProviderStatusReportSchema.parse(raw);
    const report = {
      ...parsed,
      agent: canonicalOrchestratorName(parsed.agent),
    };
    const run = this.db.getProviderRun(report.providerRunId);
    if (run === null || run.state !== "running") {
      throw new AgentStatusBindingError(
        `provider run ${report.providerRunId} is not active for ${report.agent}`,
      );
    }
    const agent =
      run.agentId === null ? null : this.db.getLiveAgentByName(report.agent);
    if (run.agentId === null) {
      if (
        report.agent !== ORCHESTRATOR_NAME ||
        run.terminal.subject.kind !== "root"
      ) {
        throw new AgentStatusBindingError(
          `provider run ${report.providerRunId} is not active for ${report.agent}`,
        );
      }
    } else if (agent === null || agent.id !== run.agentId) {
      throw new AgentStatusBindingError(
        `no live agent is bound to ${report.agent}`,
      );
    } else if (run.capabilityEpoch !== agent.capabilityEpoch) {
      throw new AgentStatusBindingError(
        `provider run ${report.providerRunId} has a stale capability epoch`,
      );
    }

    const sourceId = `${run.provider}:${run.runId}:${report.vendorSessionId}`;
    const entity: WorkspaceEventV2["entity"] =
      agent === null
        ? { kind: "orchestrator", id: report.agent }
        : { kind: "agent", id: agent.id };

    const source = {
      kind: "provider-protocol" as const,
      id: sourceId,
      observedAt: report.observedAt,
      confidence: "authoritative" as const,
    };
    const data = {
      ...(agent === null ? {} : { agentId: agent.id }),
      providerRunId: run.runId,
      vendorSessionId: report.vendorSessionId,
      providerSequence: report.providerSequence,
      ...(agent?.sessionLocator === undefined
        ? {}
        : { incarnationGeneration: agent.sessionLocator.generation }),
    };
    const events: WorkspaceStatusSourceEvent[] = [
      ...(report.projection.runtime === undefined
        ? []
        : [
            {
              entity,
              occurredAt: report.observedAt,
              kind: "status.runtime",
              source,
              data: { ...data, value: report.projection.runtime },
            },
          ]),
      ...(report.projection.turn === undefined
        ? []
        : [
            {
              entity,
              occurredAt: report.observedAt,
              kind: "status.turn",
              source,
              data: { ...data, value: report.projection.turn },
            },
          ]),
    ];

    const acceptance = this.events.acceptProviderReport({
      sourceId,
      providerSequence: report.providerSequence,
      projection: canonicalJson(report.projection),
      events,
      onAppend: () => {
        if (agent === null) {
          for (const event of orchestratorEventsForProviderReport(report)) {
            this.db.insertEvent(event);
          }
          return;
        }
        const currentAgent = this.db.getAgentById(agent.id);
        if (currentAgent === null) return;
        this.db.upsertAgent({
          ...currentAgent,
          status: compatibilityTurnStatus(currentAgent, report.projection.turn),
          lastEventAt: report.observedAt,
        });
      },
    });
    if (acceptance.kind === "conflict") {
      throw new AgentStatusConflictError(
        `provider sequence ${report.providerSequence} was reused with different status`,
      );
    }
    if (acceptance.kind === "stale") {
      throw new AgentStatusConflictError(
        `provider sequence ${report.providerSequence} is older than ${acceptance.newestSequence}`,
      );
    }
    return agent === null ? null : this.current(agent);
  }

  /** Accepts the lower-fidelity hook fallback through the same ingress as the provider protocol. A rejected run binding records only that the dimension was observed; it must not be allowed to claim a state for another run. */
  observeHook(
    agent: AgentRecord,
    event: HookEvent,
    binding: "accepted" | "rejected",
  ): FusedAgentStatus | null {
    const turn = statusProjectionForHookEvent(event)?.turn;
    if (turn === undefined) return null;
    const observedAt = new Date(event.timestamp).toISOString();
    this.events.appendSourceEvents([
      {
        entity: { kind: "agent", id: agent.id },
        occurredAt: observedAt,
        kind: "status.turn",
        source: {
          kind: "provider-hook",
          id:
            binding === "accepted"
              ? `${agent.tool}:${event.toolSessionId ?? agent.id}`
              : `${agent.tool}:run:${event.providerRunId ?? "unbound"}`,
          observedAt,
          confidence: binding === "accepted" ? "high" : "low",
        },
        data: binding === "accepted" ? { value: turn } : {},
      },
    ]);
    return this.current(agent);
  }

  current(agent: AgentRecord, now = new Date()): FusedAgentStatus {
    const projection = this.events.currentProjectionForAgent(agent.id);
    const status = this.currentFromEvents(agent, projection?.events ?? [], now);
    return projection === null
      ? status
      : { ...status, revision: projection.revision };
  }

  currentForAgentId(
    agentId: string,
    now = new Date(),
  ): FusedAgentStatus | null {
    const projection = this.events.currentProjectionForAgent(agentId);
    if (projection === null) return null;
    const agent = this.db.getAgentById(agentId);
    const status = fuseAgentStatus(
      projection.events,
      { agentId, incarnationGeneration: null },
      now,
      {},
      this.events.providerCapabilitiesFor(agent?.name ?? ""),
    );
    return { ...status, revision: projection.revision };
  }

  currentFromEvents(
    agent: AgentRecord,
    events: readonly WorkspaceEventV2[],
    now = new Date(),
  ): FusedAgentStatus {
    return fuseAgentStatus(
      events,
      {
        agentId: agent.id,
        incarnationGeneration: agent.sessionLocator?.generation ?? null,
      },
      now,
      {},
      this.events.providerCapabilitiesFor(agent.name),
    );
  }

  dimensions(
    agent: AgentRecord,
    now = new Date(),
  ): WorkspaceStatusDimensionsV1 {
    return this.dimensionsFrom(this.current(agent, now));
  }

  dimensionsFrom(status: FusedAgentStatus): WorkspaceStatusDimensionsV1 {
    return workspaceStatusDimensions(status);
  }

  displayStatus(
    agent: AgentRecord,
    status: FusedAgentStatus,
  ): AgentRecord["status"] {
    if (
      ["spawning", "control-paused", "held", "done", "dead"].includes(
        agent.status,
      )
    ) {
      return agent.status;
    }
    // A quiet turn and a missing process are each ambiguous. `stuck` needs
    // both an explicit provider turn verdict and degraded process health; the
    // status dimensions carry the source and observation time for each.
    if (
      status.turnState?.value === "stuck" &&
      status.healthState !== null &&
      status.healthState.value !== null &&
      ["delayed", "stale", "disconnected"].includes(status.healthState.value)
    ) {
      return "stuck";
    }
    switch (status.turnState?.value) {
      case "working":
      case "queued":
      case "submitting":
      case "cancelling":
        return "working";
      case "awaiting_approval":
      case "awaiting_answer":
        return "awaiting-approval";
      case "ready":
      case "idle":
        return "idle";
      case "done":
        return "done";
      case "failed":
      case "paused":
      case "stuck":
        return "unknown";
      case "unknown":
      case null:
      case undefined:
        return "unknown";
    }
  }

  isTurnAtRest(
    value: FusedAgentStatus["turnState"],
  ): value is NonNullable<FusedAgentStatus["turnState"]> {
    return (
      value?.value === "ready" ||
      value?.value === "idle" ||
      value?.value === "done"
    );
  }
}

function compatibilityTurnStatus(
  agent: AgentRecord,
  turn: ProviderStatusProjection["turn"],
): AgentRecord["status"] {
  if (
    !["working", "idle", "unknown", "awaiting-approval"].includes(
      agent.status,
    ) ||
    turn === undefined
  ) {
    return agent.status;
  }
  if (["working", "queued"].includes(turn)) return "working";
  if (["awaiting_approval", "awaiting_answer"].includes(turn)) {
    return "awaiting-approval";
  }
  return "idle";
}

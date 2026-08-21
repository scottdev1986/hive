import { z } from "zod";
import { getAgentAdapter } from "../../adapters/providers/provider-registry";
import {
  markBranchPreserved,
  observedWorktreeFiles,
} from "../../adapters/worktrees";
import { hiveInstanceSuffix } from "../../hive-home/home";
import {
  type AgentRecord,
  isLiveAgent,
  isOrchestratorName,
  ORCHESTRATOR_NAME,
} from "../../schemas/agent";
import { TaskIdSchema } from "../../schemas/hierarchy-ids";
import {
  HIERARCHY_ENTITY_KINDS,
  HierarchyTaskProjectionSchema,
} from "../../schemas/hierarchy-projection";
import type { ActivitySnapshot } from "../../schemas/provider-communication";
import {
  HiveTerminalObserveInputSchema,
  HiveUpdateStatusAdvertisedSchema,
} from "../../schemas/status-envelope";
import type { TaskDetail } from "../../schemas/task-detail";
import { definedFields } from "../../shared/defined-fields";
import { toolResult } from "../../shared/mcp-tool-result";
import {
  type Action,
  AuthorizationRefusedError,
  type Capability,
  permitsTerminalObservation,
} from "../authorization/authorization-service";
import type { HiveToolRegistrar } from "../authorization/mcp-tool-policy";
import type { HiveDatabase } from "../database/hive-database";
import type { GraphifyService } from "../graphify-service/graphify-service";
import { HierarchyStore } from "../hierarchy-store";
import { computeMemoryMetric } from "../incident-ledger/metric";
import type { GraphifyCallCursor } from "../observability/tool-telemetry";
import {
  type ActiveAgentRun,
  type ActiveAgentSummary,
  compactActiveTeam,
} from "../orchestrator-host/orchestrator-projections";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  requireSessiondRootLocator,
} from "../session-host/hive-terminal-host";
import {
  mintSessionRequestId,
  sameSessionLocator,
} from "../session-host/locators";
import type {
  SessionHost,
  SessionLocator,
} from "../session-host/session-host-contract";
import { ROOT_VISIBILITY_ID } from "../session-host/workspace-visibility";
import { findBoardContradictions } from "./board-contradictions";
import type { FusedAgentStatus } from "./fusion";
import {
  type StatusIncarnationGenerationSource,
  StatusIncarnationUnavailableError,
} from "./generation";
import type { StatusService } from "./status-projection-service";

export const StatusRequestSchema = z.object({
  detail: z.enum(["full", "active"]).optional(),
  history: z.boolean().optional(),
  fields: z.array(z.string().min(1)).max(32).optional(),
});

export const PreserveBranchRequestSchema = z.strictObject({
  agent: z.string().min(1),
});

export const TaskListRequestSchema = z.strictObject({});

export const TaskGetRequestSchema = z.strictObject({
  taskId: TaskIdSchema,
});

export function shouldWarnForMissingTerminal(
  run: { readonly state: string } | null,
): boolean {
  return run === null || run.state === "running";
}

/** What the daemon has seen of one credential on its MCP surface: the last authenticated request from that subject, and the start of the window the record covers. */
export interface McpCredentialObservation {
  readonly lastAuthenticatedAt: string | null;
  readonly observingSince: string;
}

/**
 * Whether an agent's own credential has authenticated against the daemon's MCP
 * surface since it launched, and when that was last checked.
 *
 * Proof of life is not proof of reporting. A launch can paint a screen and hold
 * its process while its MCP client never connects, and that agent can never
 * publish mail, claim, or land — it burns a whole session producing nothing
 * while every other status dimension reads healthy. This is an observation for
 * a caller to act on, never a verdict: it closes no provider run and is not
 * fused into `stuck`.
 *
 * `unobserved` is the honest answer when the record began after the agent
 * launched, which is what a daemon restart under a live fleet looks like. The
 * record cannot speak for a window it was not keeping, and calling that silence
 * a negative is the mistake this observation exists to avoid.
 */
export interface McpCredentialReport {
  readonly state: "authenticated" | "never-authenticated" | "unobserved";
  readonly lastAuthenticatedAt: string | null;
  readonly since: string;
  readonly checkedAt: string;
}

export function mcpCredentialReport(
  observation: McpCredentialObservation,
  launchedAt: string,
  checkedAt: string,
): McpCredentialReport {
  const { lastAuthenticatedAt, observingSince } = observation;
  if (lastAuthenticatedAt !== null && lastAuthenticatedAt >= launchedAt) {
    return {
      state: "authenticated",
      lastAuthenticatedAt,
      since: launchedAt,
      checkedAt,
    };
  }
  // Anything the record holds is older than this launch, so it says nothing about this incarnation.
  return observingSince > launchedAt
    ? {
        state: "unobserved",
        lastAuthenticatedAt: null,
        since: observingSince,
        checkedAt,
      }
    : {
        state: "never-authenticated",
        lastAuthenticatedAt: null,
        since: launchedAt,
        checkedAt,
      };
}

/** The observability tool surface, with its dependencies named. Status reads across many daemon subsystems, so its inputs are explicit rather than reached through `this`. `memoryEmbeddingsStatusSection` is typed `() => unknown` because its result is only nested into a response object — naming its inferred union here would couple this module to the embedding service's shape for no benefit. */
export interface StatusToolDeps {
  db: HiveDatabase;
  repoRoot: string;
  status: StatusService;
  terminalHost: HiveTerminalHostAdapter;
  graphify: GraphifyService | undefined;
  graphifyCalls: Map<string, GraphifyCallCursor>;
  sessionHost: Pick<SessionHost, "capture"> | null;
  statusIncarnationGenerationSource: StatusIncarnationGenerationSource;
  resolveSessionLocator:
    | ((
        sessionId: string,
        generation: number,
      ) => Promise<SessionLocator | null>)
    | null;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
  /** Full TaskDetail by id. Lives here so hive_task_get sits next to hive_task_list. */
  getTask: (taskId: string) => TaskDetail | null;
  listTasks: () => TaskDetail[];
  hasCompletedSessiondBinding: (agent: AgentRecord) => boolean;
  memoryEmbeddingsStatusSection: () => unknown;
  /** Root instructions still waiting in each agent's mailbox, by agent name. Only the ones nobody has finished with: a handled instruction is settled and gone, so this counts what is outstanding rather than what was ever said. The field names downstream say "waiting" for that reason. */
  waitingInstructions: () => Map<string, string[]>;
  mailBacklog: (recipient: string) => number;
  /** The daemon's receiving-side record for one credential. Measured where the requests arrive, never inferred from the agent looking alive. */
  mcpCredential: (subject: string) => McpCredentialObservation;
  settlementDebt?: () => Promise<unknown>;
  statusLiveness: (
    agent: AgentRecord,
    sessions: Awaited<ReturnType<HiveTerminalHostAdapter["list"]>> | null,
  ) => AgentRecord;
}

export type CurrentRunHierarchyFences =
  | {
      availability: "present";
      runId: string;
      hierarchyRevision: string;
      runEpoch: number;
    }
  | {
      availability: "absent";
      reason: "no-active-run" | "ambiguous-active-runs" | "fences-unavailable";
      detail: string;
    };

export function hierarchyStatusContext(
  db: HiveDatabase,
  agents: readonly AgentRecord[],
  instanceId = hiveInstanceSuffix(),
): {
  currentRun: CurrentRunHierarchyFences;
  agentRuns: Map<string, ActiveAgentRun>;
} {
  const store = new HierarchyStore(db);
  const bindingRunIds = new Map<string, string | null>();
  for (const { binding, runId } of store.listAgentBindings()) {
    if (binding.unboundAt !== null) continue;
    const key = `${binding.agentId}:${String(binding.generation)}`;
    bindingRunIds.set(key, bindingRunIds.has(key) ? null : runId);
  }
  const agentRuns = new Map(
    agents.flatMap((agent) => {
      const locator = agent.sessionLocator;
      const runId =
        locator?.subject.kind === "agent"
          ? bindingRunIds.get(`${agent.id}:${String(locator.generation)}`)
          : undefined;
      return [
        [
          agent.id,
          runId === undefined
            ? { runId: null, runIdReason: "no-live-binding" as const }
            : runId === null
              ? { runId: null, runIdReason: "ambiguous-live-bindings" as const }
              : { runId },
        ] as const,
      ];
    }),
  );
  const activeRuns = store
    .listRuns()
    .filter(
      (run) => run.instanceId === instanceId && run.lifecycle === "active",
    );
  if (activeRuns.length === 0) {
    return {
      agentRuns,
      currentRun: {
        availability: "absent",
        reason: "no-active-run",
        detail: "this Hive instance has no active hierarchy run",
      },
    };
  }
  if (activeRuns.length !== 1) {
    return {
      agentRuns,
      currentRun: {
        availability: "absent",
        reason: "ambiguous-active-runs",
        detail: "this Hive instance has more than one active hierarchy run",
      },
    };
  }
  const [run] = activeRuns;
  if (run === undefined) {
    return {
      agentRuns,
      currentRun: {
        availability: "absent",
        reason: "no-active-run",
        detail: "this Hive instance has no active hierarchy run",
      },
    };
  }
  const fences = store.getFences(run.runId);
  if (fences === null) {
    return {
      agentRuns,
      currentRun: {
        availability: "absent",
        reason: "fences-unavailable",
        detail: `run ${run.runId} has no hierarchy fences`,
      },
    };
  }
  return {
    agentRuns,
    currentRun: {
      availability: "present",
      runId: run.runId,
      hierarchyRevision: fences.hierarchyRevision,
      runEpoch: fences.runEpoch,
    },
  };
}

/// Project each agent record down to the requested keys, refusing any name that
/// would otherwise be dropped in silence.
///
/// `fields` names top-level keys of an AGENT RECORD — not paths into the status
/// document. A caller who asks for "agents.capabilityEpoch" or for a sibling
/// section like "settlementDebt" used to get a well-formed `{}` per agent, which
/// reads exactly like a record that genuinely has no such field. That is the one
/// answer this must never give: a query that found nothing has to say so.
///
/// The legal field names at each detail level.
///
/// Declared rather than read off whatever records happen to be live, because a
/// set derived from data makes validation depend on the fleet: a name would be
/// legal only while some agent carried it, so a typo would pass on an idle Hive
/// and refuse once one was running, and `latestWaitingInstruction` would come and
/// go with whether anyone had mail. The same call must get the same answer.
///
/// `Record<keyof Shape, true>` is what keeps a declared list honest — it requires
/// every key of the shape, so adding a field to either record fails `tsc` here
/// until it is listed. That is the whole reason this is safe to hand-write.
const FULL_FIELDS: Record<keyof AgentRecord, true> = {
  id: true,
  name: true,
  tool: true,
  model: true,
  liveModel: true,
  category: true,
  status: true,
  statusDimensions: true,
  holdReason: true,
  holdResetAt: true,
  holdProviderRunId: true,
  closedAt: true,
  quotaReservationId: true,
  controlQuotaReservationId: true,
  controlMessageId: true,
  executionIdentity: true,
  taskDescription: true,
  worktreePath: true,
  branch: true,
  sessionLocator: true,
  toolSessionId: true,
  contextPct: true,
  contextWindow: true,
  graphifyCalls: true,
  createdAt: true,
  lastEventAt: true,
  landedCommit: true,
  landedAt: true,
  capabilityEpoch: true,
  readOnly: true,
  writeRevoked: true,
};

const COMPACT_FIELDS: Record<keyof ActiveAgentSummary, true> = {
  name: true,
  capabilityEpoch: true,
  runId: true,
  runIdReason: true,
  readOnly: true,
  tool: true,
  model: true,
  contextPct: true,
  status: true,
  brief: true,
  waitingInstructionCount: true,
  latestWaitingInstruction: true,
  observedFiles: true,
  overlaps: true,
  graphifyCalls: true,
  lastEventAt: true,
  activity: true,
};

/// Project each agent record down to the requested keys, refusing any name that
/// would otherwise be dropped in silence.
///
/// `fields` names top-level keys of an AGENT RECORD — not paths into the status
/// document. A caller who asks for "agents.capabilityEpoch" or for a sibling
/// section like "settlementDebt" used to get a well-formed `{}` per agent, which
/// reads exactly like a record that genuinely has no such field. That is the one
/// answer this must never give: a query that found nothing has to say so.
///
/// NEITHER detail level's keys contain the other's: the full record carries
/// `branch` and `worktreePath`, while the compact projection computes `runId` and
/// `brief` that no full record has. So a name can be real and still absent here, in
/// both directions, and that case gets its own message naming the detail that does
/// return it. Telling a caller their field does not exist, when it does and they
/// merely asked at the wrong level, would trade a silent drop for a misleading
/// refusal — the same defect wearing a different face.
function projectAgents(
  selected: readonly object[],
  legal: Record<string, true>,
  elsewhere: Record<string, true>,
  otherDetail: string,
  fields: readonly string[],
): Record<string, unknown>[] {
  const missing = fields.filter((field) => legal[field] !== true);
  if (missing.length > 0) {
    const wrongDetail = missing.filter((field) => elsewhere[field] === true);
    if (wrongDetail.length > 0) {
      throw new Error(
        `hive_status returns ${wrongDetail.join(", ")} at detail:"${otherDetail}", ` +
          `not at this detail level.`,
      );
    }
    throw new Error(
      `hive_status has no agent field named ${missing.join(", ")}. ` +
        `fields names keys of an agent record, not paths into the response. ` +
        `Legal fields here: ${Object.keys(legal).sort().join(", ")}.`,
    );
  }
  return selected.map((record) =>
    Object.fromEntries(
      Object.entries(record).filter(([field]) => fields.includes(field)),
    ),
  );
}

export function registerStatusTools(
  server: HiveToolRegistrar,
  capability: Capability,
  deps: StatusToolDeps,
): void {
  server.registerTool(
    "hive_status",
    {
      title: "Hive agent status",
      description:
        "Live agents and this instance's current run. Default detail is active: identity, capability fences, truncated spawn brief (`brief` — not a board task id), status, overlaps, and observed files. Use detail=full for complete records; history=true to include dead and done. Board tasks are hive_task_list / hive_task_get. `fields` names top-level keys of an agent record only. Extra sections: credentialReporting, openAssignments, memory.embeddings, recentRunOutcomes, settlementDebt.",
      inputSchema: StatusRequestSchema,
    },
    async ({ detail, history, fields }, context) => {
      const { signal } = context.mcpReq;
      deps.authorizeTool(
        capability,
        "hive_status",
        "status:read",
        undefined,
        false,
      );
      signal.throwIfAborted();
      // graphifyCalls says whether the graph tools are earning their context cost. Null is unknown — no observation — never zero; only rendered at all when this daemon runs graphify. Kickoff is not messaging: it is the one write that starts an agent, and an agent whose spawn prompt never landed reads as an ordinary idle one in every other field here. A sessiond row is Hive's private cleanup ownership until host creation completes. Publishing it earlier gives Workspace a locator that cannot attach yet and turns ordinary launch ordering into a renderer race.
      let storedAgents = deps.db
        .listAgents()
        .filter((agent) => deps.hasCompletedSessiondBinding(agent));
      if (history !== true) {
        storedAgents = storedAgents.filter(
          (agent) => !["dead", "done"].includes(agent.status),
        );
      }
      let sessions: Awaited<
        ReturnType<HiveTerminalHostAdapter["list"]>
      > | null = null;
      if (storedAgents.length > 0) {
        sessions = await deps.terminalHost
          .list(hiveInstanceSuffix())
          .catch((error: unknown) => {
            console.warn(
              `Hive could not list terminal sessions; no agent will report ` +
                `terminal state this pass: ${
                  error instanceof Error ? error.message : "unknown failure"
                }`,
            );
            return null;
          });
      }
      signal.throwIfAborted();
      const fusedStatuses = new Map<string, FusedAgentStatus>();
      const statusObservedAt = new Date();
      const agents = storedAgents.map((agent): AgentRecord => {
        const liveAgent = deps.statusLiveness(agent, sessions);
        const fusedStatus = deps.status.current(liveAgent, statusObservedAt);
        fusedStatuses.set(agent.id, fusedStatus);
        return {
          ...liveAgent,
          status: deps.status.displayStatus(liveAgent, fusedStatus),
          statusDimensions: deps.status.dimensionsFrom(fusedStatus),
          ...definedFields({
            graphifyCalls:
              deps.graphify === undefined
                ? undefined
                : (deps.graphifyCalls.get(agent.id)?.count ?? null),
          }),
        };
      });
      const waiting = deps.waitingInstructions();
      const evidence = new Map<
        string,
        { instructions: string[]; files: string[] }
      >();
      const activity = new Map<string, ActivitySnapshot>();
      const includeActivity =
        isOrchestratorName(capability.subject) || capability.role === "user";
      await Promise.all(
        agents.map(async (agent) => {
          signal.throwIfAborted();
          const files = await observedWorktreeFiles(
            deps.repoRoot,
            agent.worktreePath,
            agent.branch,
          ).catch(() => []);
          signal.throwIfAborted();
          evidence.set(agent.name, {
            instructions: waiting.get(agent.name) ?? [],
            files,
          });
          if (!includeActivity) return;
          const locator = requireSessiondAgentLocator(agent);
          const inspection =
            sessions?.find((session) =>
              sameSessionLocator(session.locator, locator),
            ) ?? null;
          const run = deps.db.listProviderRunsForAgent(agent.id).at(-1) ?? null;
          if (
            inspection === null &&
            sessions !== null &&
            shouldWarnForMissingTerminal(run)
          ) {
            // The list came back and this agent was not in it. That is a locator mismatch, not an outage, and it is the difference between "sessiond is down" and "we are asking about the wrong generation" — which no amount of staring at `outputThrough: 0` would ever distinguish.
            console.warn(
              `Hive has no terminal session matching ${agent.name} ` +
                `(${locator.sessionId}#${locator.generation}); its terminal state ` +
                `cannot be inspected. sessiond listed ${sessions.length}: ` +
                sessions
                  .map(
                    (session) =>
                      `${session.locator.sessionId}#${session.locator.generation}`,
                  )
                  .join(", "),
            );
          }
          const providerEvents =
            run === null ? [] : [...deps.db.listProviderEvents(run.runId)];
          if (
            run !== null &&
            run.state === "running" &&
            inspection?.foreground.state === "managed" &&
            inspection.foreground.runId === run.runId &&
            agent.worktreePath !== null &&
            getAgentAdapter(agent.tool).communication.eventSource ===
              "transcript"
          ) {
          }
          activity.set(
            agent.id,
            deps.status.activitySnapshot({
              agent,
              run,
              inspection,
              gitPaths: files,
              events: providerEvents,
              status: fusedStatuses.get(agent.id) ?? null,
              observedAt: statusObservedAt.toISOString(),
            }),
          );
        }),
      );
      signal.throwIfAborted();
      const hierarchy = hierarchyStatusContext(deps.db, agents);
      const result =
        detail === "full"
          ? agents
          : compactActiveTeam(agents, evidence, activity, hierarchy.agentRuns);
      const providerCapabilities = Object.fromEntries(
        agents.flatMap((agent) => {
          const projection = fusedStatuses.get(agent.id)?.providerCapabilities;
          return projection === null || projection === undefined
            ? []
            : [[agent.name, projection]];
        }),
      );
      const providerCapabilitiesSection =
        Object.keys(providerCapabilities).length === 0
          ? {}
          : { providerCapabilities };
      // Measured against this incarnation's own launch, so a predecessor's handshake is never credited to the agent running now.
      const credentialReporting = Object.fromEntries(
        agents.map((agent) => [
          agent.name,
          mcpCredentialReport(
            deps.mcpCredential(agent.name),
            deps.db.getActiveProviderRunForAgent(agent.id)?.startedAt ??
              agent.createdAt,
            statusObservedAt.toISOString(),
          ),
        ]),
      );
      // Identifiers of the daemon-held open Assignment, per agent — never a
      // task or hierarchy reading. null is a measured absence: the store holds
      // no open row for that agent.
      const openAssignments = Object.fromEntries(
        agents.map((agent) => {
          const open = deps.status.currentAssignment(agent.id);
          return [
            agent.name,
            open === null
              ? null
              : {
                  assignmentId: open.assignmentId,
                  assignmentGeneration: open.assignmentGeneration,
                },
          ];
        }),
      );
      const memory = { embeddings: deps.memoryEmbeddingsStatusSection() };
      const recentRunOutcomes = deps.db.listRunOutcomes().slice(-20).reverse();
      // Scored over the whole ledger rather than a trailing window: on a
      // single-user tool the incidents are rare enough that a weekly rate is
      // noise, and a rate read off two events reads as a result.
      const memoryIncidentMetric = computeMemoryMetric(
        deps.db.listIncidentExposures(),
        null,
      );
      const boardContradictions = findBoardContradictions(
        agents,
        deps.listTasks(),
      );
      const boardContradictionsSection =
        boardContradictions.length === 0 ? {} : { boardContradictions };
      const settlementDebt = await deps.settlementDebt?.();
      const settlementSection =
        settlementDebt === undefined ? {} : { settlementDebt };
      const selectedAgents =
        fields === undefined
          ? result
          : projectAgents(
              result,
              detail === "full" ? FULL_FIELDS : COMPACT_FIELDS,
              detail === "full" ? COMPACT_FIELDS : FULL_FIELDS,
              detail === "full" ? "active" : "full",
              fields,
            );
      const status = {
        agents: selectedAgents,
        currentRun: hierarchy.currentRun,
      };
      return {
        ...toolResult(status, "status"),
        structuredContent: {
          ...status,
          credentialReporting,
          openAssignments,
          memory,
          recentRunOutcomes,
          memoryIncidentMetric,
          ...providerCapabilitiesSection,
          ...boardContradictionsSection,
          ...settlementSection,
        },
      };
    },
  );

  server.registerTool(
    "hive_task_list",
    {
      title: "List hierarchy tasks",
      description:
        "List compact board-task projections (id, state, blockers, evidence). Not part of hive_status. Use hive_task_get for the full story.",
      inputSchema: TaskListRequestSchema,
    },
    async () => {
      deps.authorizeTool(
        capability,
        "hive_task_list",
        "status:read",
        undefined,
        false,
      );
      const snapshot = await deps.status.fetchSnapshot();
      const tasks = snapshot.entities
        .filter((entity) => entity.kind === HIERARCHY_ENTITY_KINDS.task)
        .map((entity) =>
          HierarchyTaskProjectionSchema.parse(entity.projection),
        );
      return toolResult(tasks, "tasks");
    },
  );

  server.registerTool(
    "hive_task_get",
    {
      title: "Get hierarchy task",
      description:
        "Fetch one hierarchy task's full record (correction first when present, then original objective, state, blockers, dependsOn, evidence, artifactRefs, revisions) by taskId. Read-only. Use hive_task_list first if you need to discover ids.",
      inputSchema: TaskGetRequestSchema,
    },
    async (rawInput) => {
      deps.authorizeTool(
        capability,
        "hive_task_get",
        "task:read",
        undefined,
        false,
      );
      const { taskId } = TaskGetRequestSchema.parse(rawInput);
      const task = deps.getTask(taskId);
      if (task === null) {
        throw new Error(
          `Task ${taskId} does not exist on the board. Fix: hive_task_list`,
        );
      }
      return toolResult(task, "task");
    },
  );

  server.registerTool(
    "hive_update_status",
    {
      title: "Report descriptive agent status",
      description:
        "Append a descriptive status report for your open session Assignment (assignmentId + assignmentGeneration from your prompt — not a board task). Does not approve work or change task, review, or landing authority. Returns mailBacklog as a count; read mail with hive_mail_poll.",
      inputSchema: HiveUpdateStatusAdvertisedSchema,
    },
    async (input) => {
      deps.authorizeTool(
        capability,
        "hive_update_status",
        "status:write",
        capability.subject,
      );
      const agent = deps.db.getLiveAgentByName(capability.subject);
      if (agent === null) {
        throw new Error(`No live agent is bound to ${capability.subject}`);
      }
      const incarnation =
        await deps.statusIncarnationGenerationSource.currentForAgent(agent.id);
      if (incarnation.kind === "unavailable") {
        throw new StatusIncarnationUnavailableError(incarnation.reason);
      }
      const report = deps.status.appendAgentReport(
        {
          subject: capability.subject,
          agentId: agent.id,
          role: capability.role,
          incarnationGeneration: incarnation.generation,
          capabilityEpoch: capability.epoch,
          toolSessionId: agent.toolSessionId ?? null,
        },
        {
          ...input,
          blocker: input.blocker ?? null,
          requestId: input.requestId ?? mintSessionRequestId(),
        },
        new Date(),
      );
      return toolResult(
        { ...report, mailBacklog: deps.mailBacklog(capability.subject) },
        "statusReport",
      );
    },
  );

  server.registerTool(
    "hive_terminal_observe",
    {
      title: "Observe bounded terminal state",
      description:
        "Read self terminal metadata, or explicitly authorized active-screen text. This cannot focus, attach, resize, acquire input, refresh status, or trigger delivery.",
      inputSchema: HiveTerminalObserveInputSchema,
    },
    async (input, context) => {
      const { signal } = context.mcpReq;
      if (deps.sessionHost === null || deps.resolveSessionLocator === null) {
        throw new Error("SessionHost terminal observation is unavailable");
      }
      const locator = await deps.resolveSessionLocator(
        input.sessionId,
        input.generation,
      );
      signal.throwIfAborted();
      if (
        locator === null ||
        locator.sessionId !== input.sessionId ||
        locator.generation !== input.generation ||
        locator.instanceId !== deps.status.instanceId
      ) {
        throw new Error(
          "No exact terminal generation matches the observation request",
        );
      }
      const target =
        locator.subject.kind === "agent"
          ? deps.db.getAgentById(locator.subject.agentId)
          : null;
      const targetSubjectId =
        locator.subject.kind === "agent"
          ? locator.subject.agentId
          : ROOT_VISIBILITY_ID;
      const targetName =
        locator.subject.kind === "agent"
          ? (target?.name ?? null)
          : ORCHESTRATOR_NAME;
      const rootBinding =
        locator.subject.kind === "root"
          ? deps.db.getTerminalHostBindingByLocator(
              requireSessiondRootLocator(locator),
            )
          : null;
      if (
        targetName === null ||
        (locator.subject.kind === "root" &&
          rootBinding?.createEvidence === undefined)
      ) {
        throw new Error("Terminal subject is unknown");
      }
      deps.authorizeTool(
        capability,
        "hive_terminal_observe",
        "terminal:observe",
        targetName,
      );
      const readerAgentId = isOrchestratorName(capability.subject)
        ? ROOT_VISIBILITY_ID
        : (deps.db.getLiveAgentByName(capability.subject)?.id ?? null);
      if (
        !permitsTerminalObservation(
          capability,
          readerAgentId,
          targetSubjectId,
          input.include,
        )
      ) {
        throw new AuthorizationRefusedError(
          "Terminal observation scope was not granted",
        );
      }
      const capture = await deps.sessionHost.capture(locator, {
        include: input.include,
        maxRows: input.maxRows,
      });
      signal.throwIfAborted();
      const visibleCapture =
        input.include === "metadata"
          ? { ...capture, text: null, styledText: null }
          : capture;
      let auditEventSeq: string | null = null;
      if (input.include === "visible-text") {
        const rowCount =
          capture.text === null || capture.text.length === 0
            ? 0
            : Math.min(input.maxRows, capture.text.split("\n").length);
        auditEventSeq = deps.status.appendObservationAudit({
          reader: capability.subject,
          readerRole: capability.role,
          subjectAgentId: targetSubjectId,
          subjectGeneration: locator.generation,
          rowCount,
          reason: `capability:${capability.id}`,
          observedAt: new Date().toISOString(),
        }).seq;
      }
      return toolResult(
        { capture: visibleCapture, auditEventSeq },
        "terminalObservation",
      );
    },
  );

  server.registerTool(
    "hive_preserve_branch",
    {
      title: "Mark intentionally preserved branch",
      description:
        "Mark a closed agent branch as intentionally preserved so settlement keeps it under an owned, reviewable case. This surface cannot release or discard a ref.",
      inputSchema: PreserveBranchRequestSchema,
    },
    async ({ agent }) => {
      deps.authorizeTool(
        capability,
        "hive_preserve_branch",
        "agent:kill",
        agent,
        false,
      );
      const record = deps.db.getAgentByName(agent);
      if (record?.branch === null || record?.branch === undefined) {
        throw new Error(`Agent ${agent} has no branch to preserve`);
      }
      if (isLiveAgent(record)) {
        throw new Error(
          `Agent ${agent} is still live; its branch is active work`,
        );
      }
      await markBranchPreserved(deps.repoRoot, record.branch);
      return toolResult({ branch: record.branch, preserved: true }, "result");
    },
  );
}

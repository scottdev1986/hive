import type { AgentRecord } from "../../schemas/agent";
import { definedFields } from "../../shared/defined-fields";
import { unsafeCast } from "../../shared/unsafe-cast";
import type { ApprovalKind } from "../../schemas/approval";
import type { ActivitySnapshot } from "../../schemas/provider-communication";

export { orchestratorSessionKey } from "../../hive-home/home";

const MAX_TASK_CODE_POINTS = 160;

export type ActiveAgentRun =
  | { runId: string }
  | {
      runId: null;
      runIdReason: "no-live-binding" | "ambiguous-live-bindings";
    };

export interface ActiveAgentSummary {
  name: string;
  capabilityEpoch: number;
  runId: string | null;
  runIdReason?: "no-live-binding" | "ambiguous-live-bindings";
  readOnly: boolean;
  tool: AgentRecord["tool"];
  model: string;
  /** Null when Hive has not observed this agent's context. The orchestrator's reuse rule must read null as "not eligible", never as "plenty of room". */
  contextPct: number | null;
  status: AgentRecord["status"];
  /** Truncated spawn brief. Not a board task id — those live on hive_task_list. */
  brief: string;
  waitingInstructionCount: number;
  latestWaitingInstruction?: string;
  observedFiles: string[];
  overlaps: string[];
  graphifyCalls?: number | null;
  lastEventAt: string;
  activity?: ActivitySnapshot;
}

interface AgentWithGraphifyCalls {
  graphifyCalls: number | null;
}

const codePoints = (value: string): string[] => Array.from(value);

function truncateCodePoints(value: string, maximum: number): string {
  const points = codePoints(value);
  if (points.length <= maximum) {
    return value;
  }
  return `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

export function compactActiveTeam(
  agents: AgentRecord[],
  evidence: Map<
    string,
    { instructions: string[]; files: string[] }
  > = new Map(),
  activity: Map<string, ActivitySnapshot> = new Map(),
  hierarchyRuns: ReadonlyMap<string, ActiveAgentRun> = new Map(),
): ActiveAgentSummary[] {
  return agents
    .filter((agent) => agent.status !== "dead" && agent.status !== "done")
    .map((agent) => {
      const observed = evidence.get(agent.name) ?? {
        instructions: [],
        files: [],
      };
      const overlaps = agents
        .filter(
          (other) =>
            other.name !== agent.name &&
            !["dead", "done"].includes(other.status) &&
            (evidence.get(other.name)?.files ?? []).some((path) =>
              observed.files.includes(path),
            ),
        )
        .map((other) => other.name);
      const latestWaiting = observed.instructions.at(-1);
      const hierarchyRun = hierarchyRuns.get(agent.id) ?? {
        runId: null,
        runIdReason: "no-live-binding" as const,
      };
      return {
        name: agent.name,
        capabilityEpoch: agent.capabilityEpoch,
        ...hierarchyRun,
        readOnly: agent.readOnly,
        tool: agent.tool,
        model: agent.liveModel ?? agent.model,
        status: agent.status,
        contextPct:
          agent.contextPct === null ? null : Math.round(agent.contextPct),
        brief: truncateCodePoints(
          agent.taskDescription.replaceAll(/\s+/g, " ").trim(),
          MAX_TASK_CODE_POINTS,
        ),
        waitingInstructionCount: observed.instructions.length,
        ...definedFields({
          latestWaitingInstruction:
            latestWaiting === undefined
              ? undefined
              : truncateCodePoints(
                  latestWaiting.replaceAll(/\s+/g, " ").trim(),
                  MAX_TASK_CODE_POINTS,
                ),
        }),
        observedFiles: observed.files,
        overlaps,
        ...definedFields({
          graphifyCalls: Object.hasOwn(agent, "graphifyCalls")
            ? unsafeCast<AgentWithGraphifyCalls>(agent).graphifyCalls
            : undefined,
        }),
        lastEventAt: agent.lastEventAt,
        ...definedFields({
          activity: activity.has(agent.id) ? activity.get(agent.id) : undefined,
        }),
      };
    });
}

const MAX_SPAWN_TASK_CODE_POINTS = 120;
const MAX_APPROVAL_DESCRIPTION_CODE_POINTS = 200;

export interface SpawnResultSummary {
  id: string;
  name: string;
  tool: AgentRecord["tool"];
  model: string;
  category: AgentRecord["category"];
  effort?: string;
  status: AgentRecord["status"];
  branch: string | null;
  worktreePath: string | null;
  contextPct: number | null;
  readOnly: boolean;
  quotaReservationId?: string;
  taskDescription: string;
  taskDescriptionLength: number;
}

// hive_spawn's caller just wrote taskDescription itself — echoing the whole multi-kilobyte brief back doubles the cost of every spawn for no new information. hive_status still carries the full record for whoever needs to re-read it.
export function compactSpawnResult(agent: AgentRecord): SpawnResultSummary {
  return {
    id: agent.id,
    name: agent.name,
    tool: agent.tool,
    model: agent.model,
    category: agent.category,
    ...definedFields({ effort: agent.executionIdentity?.effort }),
    status: agent.status,
    branch: agent.branch,
    worktreePath: agent.worktreePath,
    contextPct: agent.contextPct,
    readOnly: agent.readOnly,
    ...definedFields({ quotaReservationId: agent.quotaReservationId }),
    taskDescription: truncateCodePoints(
      agent.taskDescription,
      MAX_SPAWN_TASK_CODE_POINTS,
    ),
    taskDescriptionLength: codePoints(agent.taskDescription).length,
  };
}

/** Tool-permission descriptions are decision input and must remain complete. Only the boilerplate land-rearm description is shortened. Legacy rows without a kind migrate to tool-permission. */
export function compactApprovalDescription<
  T extends { description: string; kind: ApprovalKind },
>(approval: T): T & { truncated: boolean } {
  if (approval.kind === "tool-permission") {
    return { ...approval, truncated: false };
  }
  const points = codePoints(approval.description);
  return {
    ...approval,
    description: truncateCodePoints(
      approval.description,
      MAX_APPROVAL_DESCRIPTION_CODE_POINTS,
    ),
    truncated: points.length > MAX_APPROVAL_DESCRIPTION_CODE_POINTS,
  };
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type Action,
  type Capability,
  permitsTerminalObservation,
} from "./capabilities";
import type { HiveDatabase } from "./db";
import type { MessageDelivery } from "./delivery";
import type { GraphifyService } from "./graphify-service";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  requireSessiondRootLocator,
} from "./session-host/hive-terminal-host";
import type { SessionHost, SessionLocator } from "./session-host/contract";
import type { SessiondOutputObservation } from "./session-host/sessiond-output-observer";
import { ROOT_VISIBILITY_ID } from "./session-host/workspace-visibility";
import {
  StatusIncarnationUnavailableError,
  type StatusIncarnationGenerationSource,
} from "./status-generation";
import type { StatusStore } from "./status-store";
import type { GraphifyCallCursor } from "./tool-telemetry";
import { toolResult } from "./tool-result";
import { buildActivitySnapshot } from "./activity-snapshot";
import { compactActiveTeam } from "./orchestrator-lifecycle";
import { fuseAgentStatus } from "./status-fusion";
import { hiveInstanceSuffix } from "./instance-identity";
import {
  mintSessionRequestId,
  sameSessionLocator,
} from "./session-host/locators";
import { getAgentAdapter } from "../adapters/tools/agents/agent-factory";
import {
  markBranchPreserved,
  observedWorktreeFiles,
} from "../adapters/worktrees";
import {
  type ActivitySnapshot,
  type AgentRecord,
  HiveTerminalObserveInputSchema,
  HiveUpdateStatusAdvertisedSchema,
  isOrchestratorName,
  ORCHESTRATOR_NAME,
  type TerminalGeometry,
} from "../schemas";

export const StatusRequestSchema = z.object({
  detail: z.enum(["full", "active"]).optional(),
  history: z.boolean().optional(),
  fields: z.array(z.string().min(1)).max(32).optional(),
});

export const PreserveBranchRequestSchema = z.object({
  agent: z.string().min(1),
  preserved: z.boolean().default(true),
});

/**
 * The observability tool surface, with its dependencies named.
 *
 * Fifth tool-group extraction out of `createMcpServer` (audit §11). The widest
 * dependency set of the four groups (15), which is itself the finding: status is
 * the surface that reads from everything, so it is the group that most wanted
 * its inputs written down rather than reached for through `this`.
 *
 * `memoryEmbeddingsStatusSection` is typed `() => unknown` because its result is
 * only nested into a response object — naming its inferred union here would
 * couple this module to the embedding service's shape for no benefit.
 */
export interface StatusToolDeps {
  db: HiveDatabase;
  repoRoot: string;
  delivery: MessageDelivery;
  status: StatusStore;
  terminalHost: HiveTerminalHostAdapter;
  graphify: GraphifyService | undefined;
  graphifyCalls: Map<string, GraphifyCallCursor>;
  sessionHost: Pick<SessionHost, "capture"> | null;
  statusIncarnationGenerationSource: StatusIncarnationGenerationSource;
  observeTerminalOutput:
    | ((
        locator: SessionLocator,
        geometry: TerminalGeometry,
      ) => Promise<SessiondOutputObservation | null>)
    | null;
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
  hasCompletedSessiondBinding: (agent: AgentRecord) => boolean;
  memoryEmbeddingsStatusSection: () => unknown;
  statusLiveness: (
    agent: AgentRecord,
    sessions: Awaited<ReturnType<HiveTerminalHostAdapter["list"]>> | null,
  ) => AgentRecord;
}

export const LIVE_STATUSES: AgentRecord["status"][] = [
  "spawning",
  "working",
  "idle",
  "awaiting-approval",
  "control-paused",
  "stuck",
];

export function registerStatusTools(
  server: McpServer,
  capability: Capability,
  deps: StatusToolDeps,
): void {
  server.registerTool(
    "hive_status",
    {
      title: "Hive agent status",
      description:
        'Fetch bounded live-agent status on demand. The compact default reports spawn-task provenance, later orchestrator instructions, observed Git paths, and overlaps. Use detail "full" for full live records, fields for a projection, and history:true only when terminal history is explicitly needed. The structuredContent memory.embeddings section reports the semantic recall leg — provider, model, state (ready / pending / disabled / embedding-runtime-missing / embedding-runtime-broken / embedding-native-unloadable / embedding-runtime-unverified / unavailable), vector-row counts, and the runtime dir in use — so embedding degradation is visible here without reading logs.',
      inputSchema: StatusRequestSchema,
    },
    async ({ detail, history, fields }) => {
      deps.authorizeTool(
        capability,
        "hive_status",
        "status:read",
        undefined,
        false,
      );
      // graphifyCalls says whether the graph tools are earning their context
      // cost (integration doc, layer 3). Null is unknown — no observation —
      // never zero; only rendered at all when this daemon runs graphify.
      // A recipient whose mail is not arriving reads as an ordinary idle agent
      // in every other field here. deliveryBlocked is the one place the
      // orchestrator can see it without knowing to look (2026-07-21 messaging
      // regression: hours of silence that looked exactly like "nothing to say").
      const blocked = deps.delivery.blockedDeliveries();
      // A sessiond row is Hive's private cleanup ownership until host creation
      // completes. Publishing it earlier gives Workspace a locator that cannot
      // attach yet and turns ordinary launch ordering into a renderer race.
      const storedAgents = deps.db
        .listAgents()
        .filter((agent) => deps.hasCompletedSessiondBinding(agent));
      let sessions: Awaited<
        ReturnType<HiveTerminalHostAdapter["list"]>
      > | null = null;
      if (storedAgents.length > 0) {
        sessions = await deps.terminalHost
          .list(hiveInstanceSuffix())
          .catch((error: unknown) => {
            // Losing this list costs every agent its inspection, and an absent
            // inspection silently costs every agent its terminal output. One
            // failure here reads downstream as a whole fleet producing nothing.
            console.warn(
              `Hive could not list terminal sessions; no agent will report ` +
                `terminal activity this pass: ${
                  error instanceof Error ? error.message : "unknown failure"
                }`,
            );
            return null;
          });
      }
      let agents = storedAgents.map((agent): AgentRecord => {
        const deliveryBlocked = blocked.get(agent.name);
        return {
          ...deps.statusLiveness(agent, sessions),
          ...(deps.graphify === undefined
            ? {}
            : {
                graphifyCalls: deps.graphifyCalls.get(agent.id)?.count ?? null,
              }),
          // Only when blocked, so a healthy `detail:"full"` record stays the
          // agent row verbatim. The compact team view — what queen reads —
          // always carries the field, null included.
          ...(deliveryBlocked !== undefined ? { deliveryBlocked } : {}),
        };
      });
      if (history !== true) {
        agents = agents.filter(
          (agent) => !["dead", "done", "failed"].includes(agent.status),
        );
      }
      const messages = deps.db.listMessages();
      const evidence = new Map<
        string,
        { instructions: string[]; files: string[] }
      >();
      const activity = new Map<string, ActivitySnapshot>();
      const includeActivity =
        isOrchestratorName(capability.subject) ||
        capability.role === "operator";
      await Promise.all(
        agents.map(async (agent) => {
          const files = await observedWorktreeFiles(
            deps.repoRoot,
            agent.worktreePath,
            agent.branch,
          ).catch(() => []);
          evidence.set(agent.name, {
            instructions: messages
              .filter(
                (message) =>
                  isOrchestratorName(message.from) &&
                  message.to === agent.name &&
                  message.intent === "instruction" &&
                  Date.parse(message.createdAt) > Date.parse(agent.createdAt),
              )
              .map((message) => message.body),
            files,
          });
          if (!includeActivity) return;
          const locator = requireSessiondAgentLocator(agent);
          const inspection =
            sessions?.find((session) =>
              sameSessionLocator(session.locator, locator),
            ) ?? null;
          if (inspection === null && sessions !== null) {
            // The list came back and this agent was not in it. That is a
            // locator mismatch, not an outage, and it is the difference
            // between "sessiond is down" and "we are asking about the wrong
            // generation" — which no amount of staring at `outputThrough: 0`
            // would ever distinguish.
            console.warn(
              `Hive has no terminal session matching ${agent.name} ` +
                `(${locator.sessionId}#${locator.generation}); its terminal ` +
                `output cannot be observed. sessiond listed ${sessions.length}: ` +
                sessions
                  .map(
                    (session) =>
                      `${session.locator.sessionId}#${session.locator.generation}`,
                  )
                  .join(", "),
            );
          }
          // A failed observation is REPORTED, not dropped. `.catch(() => null)`
          // here rendered downstream as `outputThrough: "0"` and an empty
          // summary, which reads to a queen as "the agent produced nothing"
          // rather than "Hive could not look".
          const output =
            deps.observeTerminalOutput === null || inspection === null
              ? null
              : await deps
                  .observeTerminalOutput(locator, inspection.geometry)
                  .catch((error: unknown) => {
                    console.warn(
                      `Hive could not observe ${agent.name}'s terminal output: ` +
                        `${error instanceof Error ? error.message : "unknown failure"}`,
                    );
                    return null;
                  });
          if (output?.failure !== undefined) {
            console.warn(
              `Hive observed no terminal output for ${agent.name}: ${output.failure}`,
            );
          }
          const run = deps.db.listProviderRunsForAgent(agent.id).at(-1) ?? null;
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
            // TODO(C2): normalize Grok project-hook events after live hook
            // firing can be verified; until then its transcript descriptor
            // deliberately reaches the universal fallback below.
          }
          activity.set(
            agent.id,
            buildActivitySnapshot({
              agent,
              run,
              inspection,
              output,
              gitPaths: files,
              events: providerEvents,
              status: fuseAgentStatus(
                deps.status.listEventsForAgent(agent.id),
                {
                  agentId: agent.id,
                  incarnationGeneration: locator.generation,
                },
                new Date(),
              ),
              observedAt: new Date().toISOString(),
            }),
          );
        }),
      );
      const result =
        detail === "full"
          ? agents
          : compactActiveTeam(agents, evidence, activity);
      // Defect D2: the semantic leg's health is an operator-visible status
      // section, so embedding degradation is SEEN without reading code or
      // logs. It rides structuredContent (the text payload stays the agents
      // shape parsers already read).
      const memory = { embeddings: deps.memoryEmbeddingsStatusSection() };
      if (fields !== undefined) {
        const base = toolResult(
          result.map((record) =>
            Object.fromEntries(
              Object.entries(record).filter(([field]) =>
                fields.includes(field),
              ),
            ),
          ),
          "agents",
        );
        return {
          ...base,
          structuredContent: { ...base.structuredContent, memory },
        };
      }
      const base = toolResult(result, "agents");
      return {
        ...base,
        structuredContent: { ...base.structuredContent, memory },
      };
    },
  );

  server.registerTool(
    "hive_update_status",
    {
      title: "Report descriptive agent status",
      description:
        "Append an authenticated, Assignment-bound descriptive status report. Complete is descriptive and never approves work or changes task, gate, review, or landing authority. Report with the assignmentId and assignmentGeneration your prompt gave you; requestId is an optional idempotency key the daemon mints for you, and passing your own makes a retry return the first result instead of appending a second report.",
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
      return toolResult(
        deps.status.appendAgentReport(
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
            requestId: input.requestId ?? mintSessionRequestId(),
          },
          new Date(),
        ),
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
    async (input) => {
      if (deps.sessionHost === null || deps.resolveSessionLocator === null) {
        throw new Error("SessionHost terminal observation is unavailable");
      }
      const locator = await deps.resolveSessionLocator(
        input.sessionId,
        input.generation,
      );
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
        throw new Error("Terminal observation scope was not granted");
      }
      const capture = await deps.sessionHost.capture(locator, {
        include: input.include,
        maxRows: input.maxRows,
      });
      const visibleCapture =
        input.include === "metadata" ? { ...capture, text: null } : capture;
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
        "Mark or unmark a closed agent branch as intentionally preserved so stranded-work reconciliation does not repeatedly alarm on a deliberate state.",
      inputSchema: PreserveBranchRequestSchema,
    },
    async ({ agent, preserved }) => {
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
      if (LIVE_STATUSES.includes(record.status)) {
        throw new Error(
          `Agent ${agent} is still live; its branch is active work`,
        );
      }
      await markBranchPreserved(deps.repoRoot, record.branch, preserved);
      return toolResult({ branch: record.branch, preserved }, "result");
    },
  );
}

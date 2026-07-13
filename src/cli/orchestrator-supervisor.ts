import type { AgentRecord, CapabilityProvider } from "../schemas";
import { isLiveAgent } from "../schemas";
import { fetchAgentStatus, sendOrchestratorMessage } from "./mcp";
import { launchOrchestrator } from "./orchestrator";
import {
  endTokenUsageSession,
  endTokenUsageSubject,
  startOrchestratorTokenSubject,
  startTokenUsageSession,
} from "./token-usage";

const STATUS_RETRY_MAX_MS = 30_000;
const RAPID_EXIT_MS = 10_000;
const TASK_PREVIEW_LENGTH = 240;

const recoveryPing =
  "Hive recovery: the previous orchestrator exited while your agent session " +
  "remained active. Continue your current task, and send a concise recovery " +
  "report to orchestrator with your objective, current status, branch and " +
  "worktree, files you are changing, blockers, and next action.";

export interface OrchestratorSupervisorDependencies {
  launch: (recoveryBrief: string) => Promise<number>;
  fetchAgents: () => Promise<AgentRecord[]>;
  sendRecoveryPing: (agentName: string, body: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  report: (message: string) => void;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

export function buildOrchestratorRecoveryBrief(
  generation: number,
  exitCode: number,
  agents: AgentRecord[],
  unconfirmedPings: string[],
): string {
  const unconfirmed = new Set(unconfirmedPings);
  const rows = agents.map((agent) => {
    const task = oneLine(agent.taskDescription).slice(0, TASK_PREVIEW_LENGTH);
    return `- ${agent.name} | ${agent.tool}/${agent.liveModel ?? agent.model} | ` +
      `${agent.status} | branch=${agent.branch ?? "unknown"} | ` +
      `worktree=${agent.worktreePath ?? "unknown"} | ` +
      `lastEvent=${agent.lastEventAt} | task=${task}`;
  });
  const confirmedNames = agents
    .map((agent) => agent.name)
    .filter((name) => !unconfirmed.has(name));

  return [
    "RECOVERY MODE — BACKUP ORCHESTRATOR",
    `You are backup generation ${generation}. The previous orchestrator process ` +
    `exited with exit code ${exitCode} while live agents remained. Do not duplicate ` +
    "or restart their work.",
    "Call hive_status immediately, then read hive_inbox. The snapshot below is only " +
    "the durable state observed at recovery time; agent replies are the current truth.",
    "Active-agent snapshot:",
    ...rows,
    `Recovery request durably recorded: ${confirmedNames.join(", ") || "none"}.`,
    `Recovery request NOT confirmed: ${unconfirmedPings.join(", ") || "none"}. ` +
    "Contact any unconfirmed agent yourself after hive_status succeeds.",
  ].join("\n");
}

async function readKnownAgentState(
  dependencies: OrchestratorSupervisorDependencies,
): Promise<AgentRecord[]> {
  let delay = 1_000;
  while (true) {
    try {
      return await dependencies.fetchAgents();
    } catch (error) {
      dependencies.report(
        "[hive] orchestrator exited, but Hive cannot determine whether agents " +
        `remain active; refusing to guess and retrying (${error instanceof Error ? error.message : String(error)})`,
      );
      await dependencies.sleep(delay);
      delay = Math.min(delay * 2, STATUS_RETRY_MAX_MS);
    }
  }
}

export async function superviseOrchestratorSession(
  dependencies: OrchestratorSupervisorDependencies,
): Promise<number> {
  let recoveryBrief = "";
  let generation = 0;
  let consecutiveRapidExits = 0;

  while (true) {
    const startedAt = dependencies.now();
    const exitCode = await dependencies.launch(recoveryBrief);
    const lifetime = Math.max(0, dependencies.now() - startedAt);
    const agents = await readKnownAgentState(dependencies);
    const liveAgents = agents.filter(isLiveAgent);
    if (liveAgents.length === 0) return exitCode;

    dependencies.report(
      `[hive] orchestrator exited with code ${exitCode} while ` +
      `${liveAgents.length} agent${liveAgents.length === 1 ? " remains" : "s remain"} active; starting a backup`,
    );

    const pingResults = await Promise.allSettled(liveAgents.map((agent) =>
      dependencies.sendRecoveryPing(agent.name, recoveryPing)
    ));
    const unconfirmedPings = liveAgents
      .filter((_agent, index) => pingResults[index]?.status === "rejected")
      .map((agent) => agent.name);

    generation += 1;
    recoveryBrief = buildOrchestratorRecoveryBrief(
      generation,
      exitCode,
      liveAgents,
      unconfirmedPings,
    );

    consecutiveRapidExits = lifetime < RAPID_EXIT_MS
      ? consecutiveRapidExits + 1
      : 0;
    if (consecutiveRapidExits > 0) {
      const delay = Math.min(
        1_000 * (2 ** (consecutiveRapidExits - 1)),
        STATUS_RETRY_MAX_MS,
      );
      dependencies.report(
        `[hive] orchestrator exited after ${lifetime}ms; backup starts in ${delay}ms`,
      );
      await dependencies.sleep(delay);
    }
  }
}

export async function runWorkspaceOrchestrator(
  tool: CapabilityProvider,
  port: number,
  cwd = process.cwd(),
): Promise<number> {
  let tokenSessionId: string | null = null;
  try {
    tokenSessionId = await startTokenUsageSession(port, cwd);
  } catch (error) {
    console.error(
      `[hive] token tracking unavailable; launches continue unmetered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const exitCode = await superviseOrchestratorSession({
    launch: async (recoveryBrief) => {
      let subjectId: string | null = null;
      if (tokenSessionId !== null) {
        try {
          subjectId = await startOrchestratorTokenSubject(
            port,
            tokenSessionId,
            tool,
            cwd,
          );
        } catch (error) {
          console.error(
            `[hive] orchestrator token tracking unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      try {
        return await launchOrchestrator(
          tool,
          port,
          cwd,
          undefined,
          undefined,
          undefined,
          undefined,
          recoveryBrief,
        );
      } finally {
        if (subjectId !== null) {
          await endTokenUsageSubject(port, subjectId).catch((error) => {
            console.error(
              `[hive] could not finalize orchestrator token usage: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      }
    },
    fetchAgents: async () => await fetchAgentStatus(port),
    sendRecoveryPing: async (agentName, body) =>
      await sendOrchestratorMessage(port, agentName, body),
    sleep: async (milliseconds) =>
      await new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: Date.now,
    report: (message) => { console.error(message); },
  });
  if (tokenSessionId !== null) {
    await endTokenUsageSession(port, tokenSessionId).catch((error) => {
      console.error(
        `[hive] could not finalize token session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  return exitCode;
}

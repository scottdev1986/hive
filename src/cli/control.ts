import { readFileSync } from "node:fs";
import { TmuxAdapter } from "../adapters/tmux";
import {
  buildAgentTerminalTitle,
  resolveTerminal,
} from "../adapters/terminal";
import { loadHiveConfig } from "../config/load";
import {
  cleanupLifecycleFiles,
  getPidFilePath,
  readDaemonPort,
} from "../daemon/lifecycle";
import type { AgentRecord, QuotaObservation } from "../schemas";
import { ORCHESTRATOR_TMUX_SESSION } from "../daemon/orchestrator-lifecycle";
import {
  fetchAgentStatus,
  fetchQuotaStatus,
  markAgentDead,
  reconcileQuota,
} from "./mcp";
import { formatQuotaStatus, formatStatusTable } from "./status";

const isLive = (agent: AgentRecord): boolean =>
  agent.status !== "dead" && agent.status !== "done";

const isNoSuchProcessError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ESRCH";

const isValidDaemonPort = (port: number | null): port is number =>
  port !== null && port > 0 && port <= 65_535;

type StopTmux = Pick<TmuxAdapter, "killSession" | "listSessions">;
type AgentStatusFetcher = (port: number) => Promise<AgentRecord[]>;
type DeadAgentMarker = (port: number, agentName: string) => Promise<void>;

export interface StopAgentSessionDependencies {
  tmux: StopTmux;
  fetchAgents?: AgentStatusFetcher;
  markDead?: DeadAgentMarker;
}

const markAgentDeadViaMcp: DeadAgentMarker = async (port, agentName) => {
  await markAgentDead(port, agentName);
};

export async function stopAgentSessions(
  port: number | null,
  dependencies: StopAgentSessionDependencies,
): Promise<number> {
  const fetchAgents = dependencies.fetchAgents ?? fetchAgentStatus;
  const markDead = dependencies.markDead ?? markAgentDeadViaMcp;

  if (isValidDaemonPort(port)) {
    let agents: AgentRecord[] | null;
    try {
      agents = await fetchAgents(port);
    } catch {
      agents = null;
    }
    if (agents !== null) {
      const liveAgents = agents.filter(isLive);
      await Promise.all(liveAgents.map(async (agent) => {
        await dependencies.tmux.killSession(agent.tmuxSession, {
          ignoreMissing: true,
        });
        await markDead(port, agent.name);
      }));
      return liveAgents.length;
    }
  }

  const hiveSessions = (await dependencies.tmux.listSessions()).filter(
    (session) => /^hive-/.test(session),
  );
  await Promise.all(hiveSessions.map((session) =>
    dependencies.tmux.killSession(session, { ignoreMissing: true })
  ));
  return hiveSessions.length;
}

export function requireDaemonPort(): number {
  const port = readDaemonPort();
  if (port === null || port <= 0 || port > 65_535) {
    throw new Error(
      "Hive daemon is not running; start one with `hive claude` or `hive codex`.",
    );
  }
  return port;
}

function readDaemonPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(getPidFilePath(), "utf8"), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function printStatus(): Promise<void> {
  const agents = await fetchAgentStatus(requireDaemonPort());
  console.log(formatStatusTable(agents));
}

export async function printQuotaStatus(): Promise<void> {
  console.log(formatQuotaStatus(
    await fetchQuotaStatus(requireDaemonPort()),
  ));
}

export async function recordQuotaObservation(
  observation: QuotaObservation,
): Promise<void> {
  const recorded = await reconcileQuota(requireDaemonPort(), observation);
  console.log(
    `Recorded ${recorded.source} quota observation for ` +
      `${recorded.provider}/${recorded.account}/${recorded.pool} at ${recorded.observedAt}.`,
  );
}

export async function watchAgent(name: string): Promise<void> {
  const agents = await fetchAgentStatus(requireDaemonPort());
  const agent = agents.find((candidate) => candidate.name === name);
  if (agent === undefined) {
    const known = agents.length === 0
      ? "No agents are currently registered."
      : `Known agents: ${agents.map((candidate) => candidate.name).join(", ")}.`;
    throw new Error(`Unknown Hive agent: ${name}. ${known}`);
  }

  const tmux = new TmuxAdapter();
  if (!(await tmux.hasSession(agent.tmuxSession))) {
    throw new Error(
      `Agent ${name} is known, but tmux session ${agent.tmuxSession} is gone. Check \`hive status\` and spawn a replacement if needed.`,
    );
  }
  const config = await loadHiveConfig();
  await resolveTerminal(config).openWindow(
    agent.tmuxSession,
    buildAgentTerminalTitle(agent.name, agent.model),
  );
}

export async function stopHive(): Promise<void> {
  const port = readDaemonPort();
  const tmux = new TmuxAdapter();
  const stoppedAgentCount = await stopAgentSessions(port, { tmux });
  await tmux.killSession(ORCHESTRATOR_TMUX_SESSION, { ignoreMissing: true });

  const pid = readDaemonPid();
  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (!isNoSuchProcessError(error)) {
        throw error;
      }
    }
    cleanupLifecycleFiles(pid);
  } else {
    cleanupLifecycleFiles();
  }

  const agentLabel = stoppedAgentCount === 1 ? "agent session" : "agent sessions";
  console.log(
    `Stopped ${stoppedAgentCount} ${agentLabel}${pid === null ? "; no daemon process was recorded." : " and the Hive daemon."}`,
  );
}

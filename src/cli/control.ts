import { readFileSync } from "node:fs";
import { factVerificationFlag } from "../adapters/memory";
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
import type {
  AgentRecord,
  MemoryScope,
  MemoryWriteInput,
  QuotaObservationInput,
} from "../schemas";
import { orchestratorTmuxSession } from "../daemon/orchestrator-lifecycle";
import { isTmuxSessionForInstance } from "../daemon/tmux-sessions";
import {
  deleteMemory,
  fetchAgentStatus,
  fetchQuotaStatus,
  markAgentDead,
  readMemory,
  reconcileQuota,
  reindexMemory,
  searchMemory,
  writeMemory,
} from "./mcp";
import {
  type OrchestratorTerminalApp,
  registerRunningOrchestratorTerminal,
} from "./orchestrator";
import { operatorHeaders } from "./credential";
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
  hiveHome?: string;
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
      const liveAgents = agents.filter((agent) =>
        isLive(agent) &&
        isTmuxSessionForInstance(agent.tmuxSession, dependencies.hiveHome)
      );
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
    (session) => isTmuxSessionForInstance(session, dependencies.hiveHome),
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
  observation: QuotaObservationInput,
): Promise<void> {
  const recorded = await reconcileQuota(requireDaemonPort(), observation);
  console.log(
    `Recorded ${recorded.source} quota observation for ` +
      `${recorded.provider}/${recorded.account}/${recorded.pool} at ${recorded.observedAt}.`,
  );
}

export async function searchMemoryCli(
  query: string,
  options?: { scope?: MemoryScope; limit?: number },
): Promise<void> {
  const results = await searchMemory(requireDaemonPort(), query, options);
  if (results.length === 0) {
    console.log("No matching memory facts.");
    return;
  }
  for (const result of results) {
    console.log(
      `[${result.scope}] ${result.id} (${result.date}) — ${result.title}\n  ${result.snippet}`,
    );
  }
}

export async function writeMemoryCli(input: MemoryWriteInput): Promise<void> {
  const fact = await writeMemory(requireDaemonPort(), input);
  console.log(`Wrote [${fact.scope}] ${fact.id} — ${fact.path}`);
}

export async function readMemoryCli(
  scope: MemoryScope,
  id: string,
): Promise<void> {
  const fact = await readMemory(requireDaemonPort(), scope, id);
  // Provenance surfaces on read (SPEC decision 5), where the load-bearing
  // check happens: show source and verification, and flag a fact whose
  // concrete claims must be re-checked against the repo before acting.
  const flag = factVerificationFlag(fact);
  const provenance = [
    `date: ${fact.date}`,
    `source: ${fact.source ?? "unknown (legacy — treated as earned)"}`,
    `verified: ${fact.verified ?? "never"}`,
    `tags: ${fact.tags.join(", ")}`,
  ].join("\n");
  const notice = flag === null
    ? ""
    : `\n⚠ ${flag}: re-check any path, command, or flag this fact names against the repo before acting on it.`;
  console.log(`# ${fact.title}\n\n${provenance}${notice}\n\n${fact.body}`);
}

export async function deleteMemoryCli(
  scope: MemoryScope,
  id: string,
): Promise<void> {
  const deleted = await deleteMemory(requireDaemonPort(), scope, id);
  console.log(
    deleted
      ? `Deleted [${scope}] ${id}.`
      : `No memory fact found at [${scope}] ${id}.`,
  );
}

export async function reindexMemoryCli(): Promise<void> {
  const count = await reindexMemory(requireDaemonPort());
  console.log(`Rebuilt the memory search index from ${count} fact(s).`);
}

export interface RecoveryOutcomeView {
  agent: string;
  action: "resumed" | "marked-dead" | "skipped";
  sessionId?: string;
  reason?: string;
}

export async function recoverAgentsCli(name?: string): Promise<void> {
  const port = requireDaemonPort();
  const response = await fetch(`http://127.0.0.1:${port}/recover`, {
    method: "POST",
    headers: { "content-type": "application/json", ...operatorHeaders() },
    body: JSON.stringify(name === undefined ? {} : { agent: name }),
  });
  const body = await response.json() as {
    outcomes?: RecoveryOutcomeView[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error ?? `Recovery failed (HTTP ${response.status})`);
  }
  const outcomes = body.outcomes ?? [];
  if (outcomes.length === 0) {
    console.log("No crashed agents to recover.");
    return;
  }
  for (const outcome of outcomes) {
    if (outcome.action === "resumed") {
      console.log(`Resumed ${outcome.agent} (session ${outcome.sessionId}).`);
    } else if (outcome.action === "marked-dead") {
      console.log(`Marked ${outcome.agent} dead: ${outcome.reason}`);
    } else {
      console.log(`Skipped ${outcome.agent}: ${outcome.reason}`);
    }
  }
}

export async function watchAgent(name: string): Promise<void> {
  const port = requireDaemonPort();
  const agents = await fetchAgentStatus(port);
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
  const handle = await resolveTerminal(config).openWindow(
    agent.tmuxSession,
    buildAgentTerminalTitle(agent.name, agent.model),
  );
  try {
    // Hand the handle to the daemon so the new viewer joins the layout and
    // hive_kill can close it later.
    await fetch(`http://127.0.0.1:${port}/viewer`, {
      method: "POST",
      headers: { "content-type": "application/json", ...operatorHeaders() },
      body: JSON.stringify({ agent: name, handle }),
    });
  } catch {
    // Viewer tracking is best-effort; the window is already open.
  }
}

export async function registerLayoutTerminal(
  app: string = "auto",
): Promise<void> {
  if (app !== "auto" && app !== "terminal" && app !== "iterm2") {
    throw new Error("terminal must be auto, terminal, or iterm2");
  }
  const terminalApp: OrchestratorTerminalApp = app;
  const handle = await registerRunningOrchestratorTerminal(
    requireDaemonPort(),
    terminalApp,
  );
  console.log(
    `Registered the orchestrator ${
      handle.app === "terminal" ? "Terminal.app window" : "iTerm2 session"
    } for layout.`,
  );
}

export async function stopHive(): Promise<void> {
  const port = readDaemonPort();
  const tmux = new TmuxAdapter();
  const stoppedAgentCount = await stopAgentSessions(port, { tmux });
  await tmux.killSession(orchestratorTmuxSession(), { ignoreMissing: true });
  if (isTmuxSessionForInstance("hive-orchestrator")) {
    await tmux.killSession("hive-orchestrator", { ignoreMissing: true });
  }

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

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
  daemonInstanceLiveness,
  getPidFilePath,
  readDaemonPort,
  type DaemonInstanceLiveness,
} from "../daemon/lifecycle";
import { getHiveHome } from "../daemon/db";
import type {
  AgentRecord,
  MemoryScope,
  MemoryWriteInput,
  QuotaObservationInput,
} from "../schemas";
import { orchestratorTmuxSession } from "../daemon/orchestrator-lifecycle";
import { hiveInstanceSuffix, isTmuxSessionForInstance } from "../daemon/tmux-sessions";
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
import { operatorFetch, operatorHeaders } from "./credential";
import { isAutonomy, type Autonomy } from "../config/autonomy";
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

export function requireDaemonPort(explicitPort?: number): number {
  const port = explicitPort ?? readDaemonPort();
  if (port === null || port <= 0 || port > 65_535) {
    throw new Error(
      "no daemon is running\nFix: run `hive init` in the project first",
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

/**
 * `hive kill <agent>` — close an agent and everything it started.
 *
 * This is what the Workspace's pane X shells out to, and it is deliberately the
 * same daemon path `hive_kill` takes: the daemon owns the kill, because only
 * the daemon knows the agent's process tree, its quota reservation and its
 * unlanded work. A UI that killed the tmux session itself would leave the
 * vendor CLI, the Codex host and the MCP children running — that is the exact
 * leak this command exists to close.
 *
 * Immediate and unconditional: no confirmation, no prompt. Unlanded work is not
 * discarded by that — the daemon preserves the branch and tells the
 * orchestrator — so the caller has nothing to ask the user about.
 */
export async function killAgentCli(
  name: string,
  port: number = requireDaemonPort(),
): Promise<void> {
  const response = await operatorFetch(
    `http://127.0.0.1:${port}/agents/${encodeURIComponent(name)}/kill`,
    { method: "POST" },
  );
  const body = await response.json().catch(() => null) as
    | {
      error?: string;
      alreadyDead?: boolean;
      preserved?: { branch: string; ref: string } | null;
      reaped?: { killed?: unknown[]; survivors?: { pid: number; command: string }[] };
    }
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `kill failed (HTTP ${response.status})`);
  }
  if (body?.alreadyDead === true) {
    console.log(`${name} was already closed`);
    return;
  }
  const killed = body?.reaped?.killed?.length ?? 0;
  console.log(
    `killed ${name} — ${killed} process(es) reaped`,
  );
  if (body?.preserved != null) {
    console.log(
      `  unlanded work preserved: ${body.preserved.branch} at ${body.preserved.ref}`,
    );
  }
  // Survivors are a failed kill. Say so on stderr and exit non-zero: the whole
  // point of this command is that "I sent the signal" is not "it is dead".
  const survivors = body?.reaped?.survivors ?? [];
  if (survivors.length > 0) {
    throw new Error(
      `${survivors.length} process(es) survived SIGKILL and are still running: ` +
        survivors.map((process) => `pid ${process.pid} (${process.command})`)
          .join(", "),
    );
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

const AUTONOMY_MEANING: Record<Autonomy, string> = {
  sandboxed:
    "writers run inside their vendor sandboxes; risky actions queue for approval",
  dangerous: "writers run with permission prompts off",
};

/** `hive autonomy [mode]` — read or set the daemon's live autonomy dial.
 * Both directions go through the daemon, never the config file directly:
 * what this prints is what the next spawn will actually use, and a set is
 * confirmed by the daemon's answer, not assumed from a clean exit. */
export async function autonomyCli(
  mode?: string,
  port: number = requireDaemonPort(),
): Promise<void> {
  if (mode !== undefined && !isAutonomy(mode)) {
    throw new Error('autonomy must be "sandboxed" or "dangerous"');
  }
  const response = await operatorFetch(`http://127.0.0.1:${port}/autonomy`, {
    ...(mode === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autonomy: mode }),
    }),
  });
  const body = await response.json().catch(() => null) as
    | { autonomy?: unknown; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `autonomy request failed (HTTP ${response.status})`);
  }
  const value = body?.autonomy;
  if (!isAutonomy(value)) {
    throw new Error("the daemon reported no autonomy setting");
  }
  console.log(
    mode === undefined
      ? `${value} — ${AUTONOMY_MEANING[value]}`
      : `autonomy is now ${value} — ${
        AUTONOMY_MEANING[value]
      } (persisted to config; applies to new spawns and crash resumes)`,
  );
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
    console.log("no matching memory articles");
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
  console.log(
    `wrote [${fact.scope}/${fact.topic}] ${fact.id} — ${fact.path}\n` +
      `raw observation: ${fact.rawPath}`,
  );
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
    `topic: ${fact.topic}`,
    `source: ${fact.source}`,
    `status: ${fact.status}`,
    `verified: ${fact.verified ?? "never"}`,
    `evidence: ${fact.evidence}`,
    `supersedes: ${fact.supersedes.join(", ")}`,
    `raw: ${fact.raw.join(", ")}`,
    `tags: ${fact.tags.join(", ")}`,
  ].join("\n");
  const notice = flag === null
    ? ""
    : `\n⚠ ${flag}: reconcile this article before acting on any path, command, or flag it names.`;
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
      : `No memory article found at [${scope}] ${id}.`,
  );
}

export async function reindexMemoryCli(): Promise<void> {
  const result = await reindexMemory(requireDaemonPort());
  console.log(`rebuilt the memory search index from ${result.count} article(s)`);
  for (const backup of result.migration.backups) {
    console.log(`backed up [${backup.scope}] legacy memory to ${backup.path}`);
  }
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
  // A daemon that fails before its JSON handler (proxy page, empty body)
  // must still surface as the HTTP failure it is, not as a parse error.
  const body = await response.json().catch(() => ({})) as {
    outcomes?: RecoveryOutcomeView[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error ?? `Recovery failed (HTTP ${response.status})`);
  }
  const outcomes = body.outcomes ?? [];
  if (outcomes.length === 0) {
    console.log("no crashed agents to recover");
    return;
  }
  for (const outcome of outcomes) {
    if (outcome.action === "resumed") {
      console.log(`resumed ${outcome.agent} (session ${outcome.sessionId})`);
    } else if (outcome.action === "marked-dead") {
      console.log(`marked ${outcome.agent} dead: ${outcome.reason}`);
    } else {
      console.log(`skipped ${outcome.agent}: ${outcome.reason}`);
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
    throw new Error(`unknown agent: ${name}. ${known}`);
  }

  const tmux = new TmuxAdapter();
  if (!(await tmux.hasSession(agent.tmuxSession))) {
    throw new Error(
      `${name} is known, but its tmux session ${agent.tmuxSession} is gone\n` +
        "Fix: check `hive status`, then spawn a replacement",
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

export interface StopHiveDependencies {
  readonly tmux?: StopTmux;
  readonly readPort?: () => number | null;
  readonly readPid?: () => number | null;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly liveness?: () => Promise<DaemonInstanceLiveness>;
  readonly cleanup?: (pid?: number) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export async function stopHive(deps: StopHiveDependencies = {}): Promise<void> {
  const port = (deps.readPort ?? readDaemonPort)();
  const tmux = deps.tmux ?? new TmuxAdapter();
  const stoppedAgentCount = await stopAgentSessions(port, { tmux });
  await tmux.killSession(orchestratorTmuxSession(), { ignoreMissing: true });
  if (isTmuxSessionForInstance("hive-orchestrator")) {
    await tmux.killSession("hive-orchestrator", { ignoreMissing: true });
  }

  const pid = (deps.readPid ?? readDaemonPid)();
  const liveness = deps.liveness ?? (() =>
    daemonInstanceLiveness(getHiveHome(), hiveInstanceSuffix())
  );
  const cleanup = deps.cleanup ?? cleanupLifecycleFiles;
  if (pid !== null) {
    try {
      (deps.kill ?? process.kill)(pid, "SIGTERM");
    } catch (error) {
      if (!isNoSuchProcessError(error)) {
        throw error;
      }
    }
    const sleep = deps.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
    const attempts = Math.max(1, Math.ceil((deps.timeoutMs ?? 5_000) / 50));
    let state = await liveness();
    for (let attempt = 0; state !== "dead" && attempt < attempts; attempt += 1) {
      await sleep(50);
      state = await liveness();
    }
    if (state !== "dead") {
      throw new Error(
        `daemon pid ${pid} did not stop (liveness: ${state})\n` +
          "Fix: inspect the daemon, stop it manually, then rerun `hive stop`.",
      );
    }
    cleanup(pid);
  } else {
    const state = await liveness();
    if (state !== "dead") {
      throw new Error(
        `the daemon is ${state} but has no recorded pid\n` +
          "Fix: inspect the daemon lifecycle files, then rerun `hive stop`.",
      );
    }
    cleanup();
  }

  const agentLabel = stoppedAgentCount === 1 ? "agent session" : "agent sessions";
  (deps.log ?? console.log)(
    `Stopped ${stoppedAgentCount} ${agentLabel}${pid === null ? "; no daemon process was recorded." : " and the Hive daemon."}`,
  );
}

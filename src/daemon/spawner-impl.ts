import {
  buildAgentTerminalTitle,
  type TerminalAdapter,
} from "../adapters/terminal";
import { shellJoin } from "../adapters/tmux";
import type { TmuxAdapter } from "../adapters/tmux";
import {
  buildClaudeSpawnCommand,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import {
  buildCodexSpawnCommand,
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { resolveConcreteModel } from "../adapters/tools/models";
import {
  createWorktree,
  removeWorktree,
  slugify,
  type CreatedWorktree,
} from "../adapters/worktrees";
import type { HiveConfig, Route, RoutingTier } from "../schemas";
import { ORCHESTRATOR_NAME, type AgentRecord } from "../schemas";
import type { HiveDatabase } from "./db";
import type { SpawnRequest, Spawner } from "./spawner";

export const NAME_POOL = [
  "maya",
  "david",
  "sam",
  "john",
  "sarah",
  "alex",
  "nina",
  "leo",
  "anna",
  "james",
  "zoe",
  "omar",
  "lena",
  "noah",
  "priya",
  "liam",
  "emma",
  "lucas",
  "ava",
  "ethan",
  "mia",
  "henry",
  "isla",
  "jack",
  "chloe",
  "ryan",
  "sofia",
  "adam",
  "grace",
  "owen",
  "layla",
  "theo",
  "ruby",
  "caleb",
  "alice",
  "felix",
  "clara",
  "marco",
  "julia",
  "ben",
] as const;

type AgentStore = Pick<
  HiveDatabase,
  "attachTerminalHandle" | "getAgentById" | "insertAgent" | "listAgents"
>;
type RouteResolver = (tier: RoutingTier) => Promise<Route>;
type WorktreeCreator = (
  repoRoot: string,
  agentName: string,
  taskSlug: string,
) => Promise<CreatedWorktree>;
type WorktreeRemover = typeof removeWorktree;
type TmuxSessionManager = Pick<
  TmuxAdapter,
  "newSession" | "hasSession" | "capturePane" | "killSession"
>;
type Sleep = (milliseconds: number) => Promise<void>;
type ModelResolver = typeof resolveConcreteModel;

export interface HiveSpawnerDependencies {
  db: AgentStore;
  repoRoot: string;
  port: number;
  config: HiveConfig;
  routing: RouteResolver;
  tmux: TmuxSessionManager;
  terminal: TerminalAdapter;
  createWorktree?: WorktreeCreator;
  removeWorktree?: WorktreeRemover;
  keepWorktreeOnFailure?: boolean;
  sleep?: Sleep;
  resolveModel?: ModelResolver;
}

const isLive = (agent: AgentRecord): boolean =>
  agent.status !== "dead" &&
  agent.status !== "done" &&
  agent.status !== "failed";

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,20}$/;
const READINESS_POLL_MS = 1_000;
const READINESS_ATTEMPTS = 15;
const LAUNCH_FAILURE_PATTERNS = [
  /^(Error|error):/m,
  /command not found/,
  /not supported/i,
  /not found\.?$/m,
];

const sleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function tailLines(value: string, count: number): string {
  const trimmed = value.trimEnd();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.split(/\r?\n/).slice(-count).join("\n").trim();
}

export function selectAgentName(agents: AgentRecord[]): string {
  const liveNames = new Set(
    agents.filter(isLive).map((agent) => agent.name),
  );
  const name = NAME_POOL.find((candidate) => !liveNames.has(candidate));
  if (name === undefined) {
    throw new Error(
      `Hive agent name pool exhausted (${NAME_POOL.length} live agents)`,
    );
  }
  return name;
}

export function resolveAgentName(
  requestedName: string | undefined,
  agents: AgentRecord[],
): string {
  if (requestedName === undefined) {
    return selectAgentName(agents);
  }

  const normalizedName = requestedName.toLowerCase();
  if (normalizedName === ORCHESTRATOR_NAME) {
    throw new Error(
      `Agent name "${ORCHESTRATOR_NAME}" is reserved for the Hive orchestrator`,
    );
  }
  if (!AGENT_NAME_PATTERN.test(normalizedName)) {
    throw new Error(
      `Invalid agent name "${normalizedName}": after lowercasing, the name must match /^[a-z][a-z0-9-]{1,20}$/`,
    );
  }
  if (
    agents.some((agent) =>
      isLive(agent) && agent.name === normalizedName
    )
  ) {
    throw new Error(
      `Agent name collision: "${normalizedName}" is already assigned to a live agent`,
    );
  }
  return normalizedName;
}

export function buildAgentPrompt(
  name: string,
  task: string,
  worktreePath: string,
): string {
  return [
    `You are ${name}, a Hive writer agent.`,
    `Your task: ${task}`,
    `Your file scope is your worktree at ${worktreePath}; do all code and file work there.`,
    "Use the Hive MCP tools hive_send, hive_inbox, and hive_status to message and coordinate with other named agents.",
    'Report completion, blockers, and important findings with hive_send to "orchestrator"; the orchestrator reads those reports from its inbox.',
  ].join("\n\n");
}

export class HiveSpawner implements Spawner {
  private readonly makeWorktree: WorktreeCreator;
  private readonly cleanupWorktree: WorktreeRemover;
  private readonly wait: Sleep;
  private readonly modelResolver: ModelResolver;

  constructor(private readonly dependencies: HiveSpawnerDependencies) {
    this.makeWorktree = dependencies.createWorktree ?? createWorktree;
    this.cleanupWorktree = dependencies.removeWorktree ?? removeWorktree;
    this.wait = dependencies.sleep ?? sleep;
    this.modelResolver = dependencies.resolveModel ?? resolveConcreteModel;
  }

  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    const existingAgents = this.dependencies.db.listAgents();
    const name = resolveAgentName(request.name, existingAgents);
    const previousRecord = existingAgents.find((agent) => agent.name === name);
    const configuredRoute = await this.dependencies.routing(request.tier);
    const tool = request.tool ?? configuredRoute.tool;
    // The record (and thus the terminal title and hive_status) carries the
    // concrete model; the spawn command below still receives the configured
    // route value, so alias-driven CLI behavior is unchanged.
    const model = await this.modelResolver(tool, configuredRoute);
    const worktree = await this.makeWorktree(
      this.dependencies.repoRoot,
      name,
      slugify(request.task),
    );
    const prompt = buildAgentPrompt(name, request.task, worktree.path);
    const timestamp = new Date().toISOString();
    const record = this.dependencies.db.insertAgent({
      id: previousRecord?.id ?? crypto.randomUUID(),
      name,
      tool,
      model,
      tier: request.tier,
      status: "spawning",
      taskDescription: request.task,
      worktreePath: worktree.path,
      branch: worktree.branch,
      tmuxSession: `hive-${name}`,
      contextPct: 0,
      createdAt: timestamp,
      lastEventAt: timestamp,
    });

    let argv: string[];
    try {
      if (tool === "claude") {
        await writeClaudeAgentConfig(worktree.path, {
          daemonPort: this.dependencies.port,
          name,
          readOnly: false,
        });
        argv = buildClaudeSpawnCommand({
          daemonPort: this.dependencies.port,
          model: configuredRoute.claude.model,
          name,
          readOnly: false,
          worktreePath: worktree.path,
        });
      } else {
        await writeCodexAgentConfig(worktree.path, {
          daemonPort: this.dependencies.port,
          name,
          readOnly: false,
        });
        argv = buildCodexSpawnCommand({
          daemonPort: this.dependencies.port,
          effort: configuredRoute.codex.effort ?? "medium",
          model: configuredRoute.codex.model,
          name,
          readOnly: false,
          worktreePath: worktree.path,
        });
      }
      argv.push(prompt);

      await this.dependencies.tmux.newSession(
        record.tmuxSession,
        worktree.path,
        shellJoin(argv),
      );
      const failureReason = await this.monitorReadiness(record);
      if (failureReason !== null) {
        return await this.failSpawnIfStillSpawning(
          record,
          worktree,
          failureReason,
        );
      }
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : "Agent launch failed";
      return await this.failSpawnIfStillSpawning(record, worktree, reason);
    }

    if (!this.dependencies.config.headless) {
      let handle: Awaited<ReturnType<TerminalAdapter["openWindow"]>> | null =
        null;
      try {
        handle = await this.dependencies.terminal.openWindow(
          record.tmuxSession,
          buildAgentTerminalTitle(record.name, record.model),
        );
        const attached = this.dependencies.db.attachTerminalHandle(
          record.id,
          handle,
        );
        if (attached === null) {
          const orphanedHandle = handle;
          handle = null;
          await this.dependencies.terminal.closeWindow(orphanedHandle);
        } else {
          handle = null;
        }
      } catch {
        // Opening a viewer is cosmetic and does not affect agent readiness.
        if (handle !== null) {
          try {
            await this.dependencies.terminal.closeWindow(handle);
          } catch {
            // A viewer that vanished during launch needs no further cleanup.
          }
        }
      }
    }
    return this.dependencies.db.getAgentById(record.id) ?? record;
  }

  private async monitorReadiness(record: AgentRecord): Promise<string | null> {
    const session = record.tmuxSession;
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
      await this.wait(READINESS_POLL_MS);
      if (!this.isStillSpawning(record.id)) {
        return null;
      }
      if (!(await this.dependencies.tmux.hasSession(session))) {
        return "tmux session exited";
      }
      let pane: string;
      try {
        pane = await this.dependencies.tmux.capturePane(session);
      } catch (error) {
        if (!(await this.dependencies.tmux.hasSession(session))) {
          return "tmux session exited";
        }
        continue;
      }
      const paneTail = tailLines(pane, 5);
      if (LAUNCH_FAILURE_PATTERNS.some((pattern) => pattern.test(paneTail))) {
        return tailLines(pane, 15) || "Agent launch error";
      }
    }
    return null;
  }

  private isStillSpawning(agentId: string): boolean {
    const current = this.dependencies.db.getAgentById(agentId);
    return current === null || current.status === "spawning";
  }

  private async failSpawnIfStillSpawning(
    record: AgentRecord,
    worktree: CreatedWorktree,
    failureReason: string,
  ): Promise<AgentRecord> {
    const current = this.dependencies.db.getAgentById(record.id);
    if (current !== null && current.status !== "spawning") {
      return current;
    }
    return await this.failSpawn(record, worktree, failureReason);
  }

  private async failSpawn(
    record: AgentRecord,
    worktree: CreatedWorktree,
    failureReason: string,
  ): Promise<AgentRecord> {
    const failedAt = new Date().toISOString();
    let failed = this.dependencies.db.insertAgent({
      ...record,
      status: "failed",
      failureReason,
      failedAt,
      lastEventAt: failedAt,
    });
    const cleanupErrors: string[] = [];

    try {
      await this.dependencies.tmux.killSession(record.tmuxSession, {
        ignoreMissing: true,
      });
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : "tmux cleanup failed",
      );
    }

    if (!(this.dependencies.keepWorktreeOnFailure ?? false)) {
      try {
        await this.cleanupWorktree(
          this.dependencies.repoRoot,
          worktree.path,
          { deleteBranch: true },
        );
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error.message : "worktree cleanup failed",
        );
      }
    }

    if (cleanupErrors.length > 0) {
      failed = this.dependencies.db.insertAgent({
        ...failed,
        failureReason: `${failureReason}\nCleanup failed: ${cleanupErrors.join("; ")}`,
      });
    }
    return failed;
  }
}

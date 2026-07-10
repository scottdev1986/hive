import type { TerminalAdapter } from "../adapters/terminal";
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
import {
  createWorktree,
  slugify,
  type CreatedWorktree,
} from "../adapters/worktrees";
import type { HiveConfig, Route, RoutingTier } from "../schemas";
import type { AgentRecord } from "../schemas";
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

type AgentStore = Pick<HiveDatabase, "insertAgent" | "listAgents">;
type RouteResolver = (tier: RoutingTier) => Promise<Route>;
type WorktreeCreator = (
  repoRoot: string,
  agentName: string,
  taskSlug: string,
) => Promise<CreatedWorktree>;
type TmuxSessionCreator = Pick<TmuxAdapter, "newSession">;

export interface HiveSpawnerDependencies {
  db: AgentStore;
  repoRoot: string;
  port: number;
  config: HiveConfig;
  routing: RouteResolver;
  tmux: TmuxSessionCreator;
  terminal: TerminalAdapter;
  createWorktree?: WorktreeCreator;
}

const isLive = (agent: AgentRecord): boolean =>
  agent.status !== "dead" && agent.status !== "done";

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
  ].join("\n\n");
}

export class HiveSpawner implements Spawner {
  private readonly makeWorktree: WorktreeCreator;

  constructor(private readonly dependencies: HiveSpawnerDependencies) {
    this.makeWorktree = dependencies.createWorktree ?? createWorktree;
  }

  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    const existingAgents = this.dependencies.db.listAgents();
    const name = selectAgentName(existingAgents);
    const previousRecord = existingAgents.find((agent) => agent.name === name);
    const route = await this.dependencies.routing(request.tier);
    const worktree = await this.makeWorktree(
      this.dependencies.repoRoot,
      name,
      slugify(request.task),
    );
    const prompt = buildAgentPrompt(name, request.task, worktree.path);

    let argv: string[];
    if (route.tool === "claude") {
      await writeClaudeAgentConfig(worktree.path, {
        daemonPort: this.dependencies.port,
        name,
        readOnly: false,
      });
      argv = buildClaudeSpawnCommand({
        daemonPort: this.dependencies.port,
        model: route.model,
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
        effort: route.effort ?? "medium",
        model: route.model,
        name,
        readOnly: false,
        worktreePath: worktree.path,
      });
    }
    argv.push(prompt);

    const tmuxSession = `hive-${name}`;
    await this.dependencies.tmux.newSession(
      tmuxSession,
      worktree.path,
      shellJoin(argv),
    );
    if (!this.dependencies.config.headless) {
      await this.dependencies.terminal.openWindow(tmuxSession, tmuxSession);
    }

    const timestamp = new Date().toISOString();
    const record: AgentRecord = {
      id: previousRecord?.id ?? crypto.randomUUID(),
      name,
      tool: route.tool,
      model: route.model,
      tier: request.tier,
      status: "spawning",
      taskDescription: request.task,
      worktreePath: worktree.path,
      branch: worktree.branch,
      tmuxSession,
      contextPct: 0,
      createdAt: timestamp,
      lastEventAt: timestamp,
    };
    return this.dependencies.db.insertAgent(record);
  }
}

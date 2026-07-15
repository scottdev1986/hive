import { QuotaConfigSchema, type AgentRecord } from "../../schemas";
import { createWorktree } from "../../adapters/worktrees";
import type { TmuxSender } from "../delivery";
import { HiveDatabase } from "../db";
import {
  acquireDaemonLock,
  releaseDaemonLock,
} from "../lifecycle";
import { QuotaService } from "../quota";
import { QuotaDatabase, QuotaLedger } from "../quota-ledger";
import { HiveDaemon } from "../server";
import type { SpawnRequest, Spawner } from "../spawner";
import { authorizeForQuotaTest } from "../authorized-launch.test-support";
import {
  agentTmuxSession,
  hiveInstanceSuffix,
  orchestratorTmuxSession,
  resolveHiveHome,
} from "../tmux-sessions";
import { TokenUsageStore } from "../token-usage";

const repoRoot = process.env.HIVE_PROJECT_ROOT;
const quotaPath = process.env.HIVE_TEST_QUOTA_DB;
if (repoRoot === undefined || quotaPath === undefined) {
  throw new Error("HIVE_PROJECT_ROOT and HIVE_TEST_QUOTA_DB are required");
}

class FakeTmux {
  readonly sessions = new Set<string>();
  private readonly panes = new Map<string, Bun.Subprocess>();

  addSession(session: string): void {
    this.sessions.add(session);
    this.panes.set(session, Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    }));
  }

  async hasSession(session: string): Promise<boolean> {
    return this.sessions.has(session);
  }

  async capturePane(_session: string): Promise<string> {
    return "";
  }

  async killSession(session: string): Promise<void> {
    this.sessions.delete(session);
    this.panes.delete(session);
  }

  async newSession(name: string): Promise<void> {
    this.addSession(name);
  }

  async listPanePids(session: string): Promise<number[]> {
    const pane = this.panes.get(session);
    return pane === undefined || pane.exitCode !== null ? [] : [pane.pid];
  }
}

class AcceptanceSpawner implements Spawner {
  constructor(
    private readonly db: HiveDatabase,
    private readonly tmux: FakeTmux,
  ) {}

  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    if (request.name === undefined) throw new Error("acceptance spawn requires a name");
    const worktree = await createWorktree(repoRoot!, request.name, request.task);
    const tool = request.tool ?? "codex";
    const model = tool === "claude"
      ? "claude-test"
      : tool === "grok"
      ? "grok-test"
      : "codex-test";
    const now = new Date().toISOString();
    const toolSessionId = `acceptance-${request.name}`;
    const record: AgentRecord = {
      id: crypto.randomUUID(),
      name: request.name,
      tool,
      model,
      category: request.category,
      status: "working",
      taskDescription: request.task,
      worktreePath: worktree.path,
      branch: worktree.branch,
      tmuxSession: agentTmuxSession(request.name),
      contextPct: null,
      createdAt: now,
      lastEventAt: now,
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
      toolSessionId,
      ...(tool === "codex"
        ? {
          executionIdentity: {
            tool: "codex" as const,
            model,
            effort: "medium" as const,
          },
          identityState: "matching" as const,
        }
        : {}),
    };
    this.tmux.addSession(record.tmuxSession);
    return record;
  }

  async authorizeLaunch(identity: AgentRecord["executionIdentity"]) {
    if (identity === undefined) throw new Error("identity required");
    return (await authorizeForQuotaTest([identity]))[0]!;
  }
}

class AcceptanceSender implements TmuxSender {
  constructor(private readonly db: HiveDatabase) {}

  async sendMessage(session: string): Promise<void> {
    const agent = this.db.listAgents().find((row) => row.tmuxSession === session);
    if (agent === undefined) throw new Error(`missing fake session ${session}`);
    this.db.insertEvent({
      kind: "turn-start",
      agentName: agent.name,
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
  }
}

await acquireDaemonLock();
const db = new HiveDatabase();
const quotaDb = new QuotaDatabase(quotaPath);
const quota = new QuotaService(
  new QuotaLedger(
    quotaDb,
    hiveInstanceSuffix(),
    resolveHiveHome(),
  ),
  QuotaConfigSchema.parse({ enabled: false }),
);
const tmux = new FakeTmux();
tmux.addSession(orchestratorTmuxSession());
const daemon = new HiveDaemon({
  db,
  repoRoot,
  port: 0,
  manageLifecycle: true,
  spawner: new AcceptanceSpawner(db, tmux),
  tmux,
  tmuxSender: new AcceptanceSender(db),
  quota,
  tokenUsage: new TokenUsageStore(db, []),
  resourceRunners: {
    panePids: (session) => tmux.listPanePids(session),
  },
  // Fresh landing reattest: acceptance agents have no real Codex rollout, so
  // the identity reader synthesizes a matching observation from the launch
  // identity the AcceptanceSpawner recorded.
  telemetryReaders: {
    codexIdentity: async (_worktree, toolSessionId) => {
      const agent = db.listAgents().find((row) =>
        row.toolSessionId === toolSessionId
      );
      const launch = agent?.executionIdentity;
      if (launch === undefined || launch.tool !== "codex") {
        return { status: "absent" };
      }
      return {
        status: "observed",
        model: launch.model,
        effort: launch.effort,
        turnId: "acceptance-turn",
        sessionId: toolSessionId ?? "acceptance",
        observedAt: new Date().toISOString(),
      };
    },
  },
});
daemon.start();
const { token } = daemon.capabilities.mint("acceptance", "operator", { epoch: 0 });
console.log(`READY ${JSON.stringify({
  port: daemon.listeningPort,
  pid: process.pid,
  instanceId: hiveInstanceSuffix(),
  token,
})}`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await daemon.stop();
  quotaDb.close();
  db.close();
  releaseDaemonLock();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

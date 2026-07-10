import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport as StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "bun";
import { z } from "zod";
import { TmuxAdapter } from "../adapters/tmux";
import {
  closeTerminal,
  type TerminalCloser,
} from "../adapters/terminal";
import {
  assessStrandedWork,
  removeWorktree,
  type RemoveWorktreeOptions,
  type StrandedWork,
} from "../adapters/worktrees";
import {
  HookEventSchema,
  ORCHESTRATOR_NAME,
  QuotaObservationSchema,
  TerminalHandleSchema,
  type AgentRecord,
  type HookEvent,
} from "../schemas";
import { HiveDatabase, type Approval } from "./db";
import type { LayoutCoordinator } from "./layout";
import {
  BunTmuxSender,
  MessageDelivery,
  type TmuxSender,
} from "./delivery";
import {
  cleanupLifecycleFiles,
  readConfiguredPort,
  writeLifecycleFiles,
} from "./lifecycle";
import { compactActiveTeam } from "./orchestrator-lifecycle";
import {
  SpawnRequestSchema,
  type SpawnRequest,
  type Spawner,
} from "./spawner";
import type { QuotaService } from "./quota";

export const HIVE_VERSION = "0.1.0";

const SendRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
});

const InboxRequestSchema = z.object({
  agent: z.string().min(1),
});

const ReadMessageRequestSchema = z.object({
  id: z.string().min(1),
});

const StatusRequestSchema = z.object({
  detail: z.enum(["full", "active"]).optional(),
});

const QuotaObservationRequestSchema = QuotaObservationSchema.omit({
  observedAt: true,
}).extend({
  observedAt: z.iso.datetime({ offset: true }).optional(),
});

const MarkDeadRequestSchema = z.object({
  agent: z.string().min(1),
});

const KillRequestSchema = z.object({
  name: z.string().min(1),
  removeWorktree: z.boolean().optional(),
  discardWork: z.boolean().optional(),
});

const ApprovalDecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
});

const OrchestratorTerminalRequestSchema = z.object({
  handle: TerminalHandleSchema,
});

const ViewerRequestSchema = z.object({
  agent: z.string().min(1),
  handle: TerminalHandleSchema,
});

export interface HiveDaemonOptions {
  spawner: Spawner;
  db?: HiveDatabase;
  tmuxSender?: TmuxSender;
  tmux?: Pick<TmuxAdapter, "hasSession" | "killSession" | "capturePane">;
  closeTerminal?: TerminalCloser;
  repoRoot?: string;
  removeWorktree?: (
    repoRoot: string,
    worktreePath: string,
    options?: RemoveWorktreeOptions | boolean,
  ) => Promise<void>;
  assessStrandedWork?: (
    repoRoot: string,
    worktreePath: string | null,
    branch: string | null,
  ) => Promise<StrandedWork>;
  port?: number;
  hostname?: string;
  manageLifecycle?: boolean;
  layout?: LayoutCoordinator;
  quota?: QuotaService;
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

function toolResult(value: unknown, key: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { [key]: value },
  };
}

export class HiveDaemon {
  readonly db: HiveDatabase;
  readonly delivery: MessageDelivery;
  readonly spawner: Spawner;
  private readonly ownsDatabase: boolean;
  private readonly port: number;
  private readonly hostname: string;
  private readonly manageLifecycle: boolean;
  private readonly tmux: Pick<
    TmuxAdapter,
    "hasSession" | "killSession" | "capturePane"
  >;
  private readonly repoRoot: string;
  private readonly cleanupWorktree: typeof removeWorktree;
  private readonly assessStranded: NonNullable<
    HiveDaemonOptions["assessStrandedWork"]
  >;
  private readonly closeTerminal: TerminalCloser;
  private readonly layout: LayoutCoordinator | null;
  private readonly quota: QuotaService | undefined;
  private bunServer: Server<undefined> | null = null;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HiveDaemonOptions) {
    this.ownsDatabase = options.db === undefined;
    this.db = options.db ?? new HiveDatabase();
    this.spawner = options.spawner;
    this.delivery = new MessageDelivery(
      this.db,
      options.tmuxSender ?? new BunTmuxSender(),
    );
    this.quota = options.quota;
    this.quota?.setAlertSink(async (body) => {
      await this.delivery.send("hive-quota", ORCHESTRATOR_NAME, body);
    });
    this.port = options.port ?? readConfiguredPort();
    this.hostname = options.hostname ?? "127.0.0.1";
    this.manageLifecycle = options.manageLifecycle ?? false;
    this.tmux = options.tmux ?? new TmuxAdapter();
    this.closeTerminal = options.closeTerminal ?? closeTerminal;
    this.layout = options.layout ?? null;
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.cleanupWorktree = options.removeWorktree ?? removeWorktree;
    this.assessStranded = options.assessStrandedWork ?? assessStrandedWork;
  }

  get server(): Server<undefined> | null {
    return this.bunServer;
  }

  get listeningPort(): number | null {
    return this.bunServer?.port ?? null;
  }

  start(): Server<undefined> {
    if (this.bunServer !== null) {
      return this.bunServer;
    }
    this.bunServer = Bun.serve({
      port: this.port,
      hostname: this.hostname,
      fetch: (request) => this.fetch(request),
    });
    const listeningPort = this.bunServer.port;
    if (listeningPort === undefined) {
      throw new Error("Hive daemon did not bind to a TCP port");
    }
    if (this.manageLifecycle) {
      writeLifecycleFiles(listeningPort);
    }
    this.reconciliationTimer = setInterval(() => {
      void Promise.all([
        this.reconcileAgents(),
        this.quota?.recoverExpired() ?? Promise.resolve(0),
      ]).catch((error) => {
        console.error(
          `Hive reconciliation failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
    }, 30_000);
    this.reconciliationTimer.unref?.();
    void this.quota?.recoverExpired().catch((error) => {
      console.error(
        `Hive quota recovery failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
    return this.bunServer;
  }

  async stop(): Promise<void> {
    if (this.reconciliationTimer !== null) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    this.bunServer?.stop(true);
    this.bunServer = null;
    if (this.manageLifecycle) {
      cleanupLifecycleFiles();
    }
    if (this.ownsDatabase) {
      this.db.close();
    }
  }

  async reconcileAgents(): Promise<void> {
    const liveStatuses: AgentRecord["status"][] = [
      "working",
      "idle",
      "awaiting-approval",
      "stuck",
    ];
    let viewersChanged = false;
    for (const agent of this.db.listAgents()) {
      if (agent.status === "spawning") {
        continue;
      }
      if (!liveStatuses.includes(agent.status)) {
        continue;
      }
      if (await this.tmux.hasSession(agent.tmuxSession)) {
        continue;
      }
      const reconciled = this.db.markAgentDeadAndDetachTerminal(
        agent.id,
        new Date().toISOString(),
        "tmux session missing (reconciled)",
      );
      if (agent.quotaReservationId !== undefined) {
        await this.quota?.cancel(agent.quotaReservationId);
      }
      // The tmux session is already gone, so the viewer shows nothing but a
      // dead shell; close it instead of leaving a stale window on the wall.
      if (reconciled?.terminalHandle !== undefined) {
        viewersChanged = true;
        try {
          await this.closeTerminal(reconciled.terminalHandle);
        } catch {
          // Viewer cleanup is best-effort; reconciliation must not stall.
        }
      }
    }
    if (viewersChanged) {
      this.layout?.requestLayout();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, version: HIVE_VERSION });
    }
    if (url.pathname === "/event" && request.method === "POST") {
      return this.receiveEvent(request);
    }
    if (url.pathname === "/orchestrator-terminal") {
      if (request.method === "POST") {
        return this.registerOrchestratorTerminal(request);
      }
      if (request.method === "DELETE") {
        this.db.clearOrchestratorTerminal();
        return json({ ok: true });
      }
    }
    if (url.pathname === "/viewer" && request.method === "POST") {
      return this.attachViewer(request);
    }
    if (url.pathname === "/mcp") {
      return this.handleMcp(request);
    }
    return json({ error: "Not found" }, { status: 404 });
  }

  private async registerOrchestratorTerminal(
    request: Request,
  ): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid terminal handle" }, { status: 400 });
    }
    const parsed = OrchestratorTerminalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "Invalid terminal handle", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    this.db.setOrchestratorTerminal(parsed.data.handle);
    // Registration alone leaves a lone orchestrator window untouched; the
    // wall only starts moving once agent viewers exist.
    const hasViewers = this.db.listAgents().some((agent) =>
      agent.terminalHandle !== undefined &&
      agent.status !== "dead" && agent.status !== "done" &&
      agent.status !== "failed"
    );
    if (hasViewers) {
      this.layout?.requestLayout();
    }
    return json({ ok: true });
  }

  private async attachViewer(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid viewer request" }, { status: 400 });
    }
    const parsed = ViewerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "Invalid viewer request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const agent = this.db.getAgentByName(parsed.data.agent);
    if (agent === null) {
      return json(
        { error: `Hive agent not found: ${parsed.data.agent}` },
        { status: 404 },
      );
    }
    const attached = this.db.attachTerminalHandle(agent.id, parsed.data.handle);
    if (attached === null) {
      return json(
        { error: `Hive agent is no longer live: ${parsed.data.agent}` },
        { status: 409 },
      );
    }
    this.layout?.requestLayout();
    return json({ agent: attached });
  }

  async processEvent(event: HookEvent): Promise<void> {
    const value = HookEventSchema.parse(event);
    this.db.transaction(() => {
      this.db.insertEvent(value);

      const agent = this.db.getAgentByName(value.agentName);
      if (
        agent !== null &&
        agent.status !== "dead" &&
        agent.status !== "done" &&
        agent.status !== "failed"
      ) {
        const updated: AgentRecord = {
          ...agent,
          status: value.kind === "dead"
            ? "dead"
            : value.kind === "turn-start"
              ? "working"
              : value.kind === "notification" ||
                  value.kind === "approval-request"
                ? "awaiting-approval"
                : "idle",
          contextPct: value.kind === "turn-end" &&
              value.contextPct !== undefined
            ? value.contextPct
            : agent.contextPct,
          lastEventAt: new Date(value.timestamp).toISOString(),
        };
        this.db.upsertAgent(updated);
      }

      if (value.kind === "notification" || value.kind === "approval-request") {
        this.db.insertApproval({
          id: crypto.randomUUID(),
          agentName: value.agentName,
          description: value.kind === "approval-request"
            ? value.description
            : `Notification from ${value.agentName}`,
          status: "pending",
          createdAt: value.timestamp,
          resolvedAt: null,
        });
      }
    });

    const agent = this.db.getAgentByName(value.agentName);
    if (agent?.quotaReservationId !== undefined) {
      if (value.kind === "session-start" || value.kind === "turn-start") {
        this.quota?.markStarted(agent.quotaReservationId, value.timestamp);
      } else if (value.kind === "turn-end") {
        await this.quota?.reconcile(
          agent.quotaReservationId,
          value.usageUnits,
          value.usageSource ?? "estimated",
          value.timestamp,
        );
      } else if (value.kind === "dead") {
        await this.quota?.cancel(agent.quotaReservationId, value.timestamp);
      }
    }

    if (value.kind === "session-start" || value.kind === "turn-end") {
      await this.delivery.flushQueued(value.agentName);
    }
  }

  private async receiveEvent(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid HookEvent" }, { status: 400 });
    }
    const event = HookEventSchema.safeParse(body);
    if (!event.success) {
      return json(
        { error: "Invalid HookEvent", issues: event.error.issues },
        { status: 400 },
      );
    }
    try {
      await this.processEvent(event.data);
      return json({ ok: true });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Event failed" },
        { status: 500 },
      );
    }
  }

  private createMcpServer(): McpServer {
    const server = new McpServer({
      name: "hive-daemon",
      version: HIVE_VERSION,
    });

    server.registerTool("hive_status", {
      title: "Hive agent status",
      description:
        'Fetch agent status on demand. Use detail "active" for a compact active-team summary; omitted detail preserves the full legacy response.',
      inputSchema: StatusRequestSchema,
    }, async ({ detail }) => {
      const agents = this.db.listAgents();
      return toolResult(
        detail === "active" ? compactActiveTeam(agents) : agents,
        "agents",
      );
    });

    server.registerTool("hive_quota_status", {
      title: "Hive quota status",
      description:
        "Show configured provider/account/model-pool capacity, reservations, telemetry confidence, freshness, and reset estimates.",
      inputSchema: z.object({}),
    }, async () => toolResult(this.quota?.statuses() ?? [], "quotas"));

    server.registerTool("hive_quota_reconcile", {
      title: "Reconcile Hive quota",
      description:
        "Record a provider, gateway, or manual usage observation for one configured quota pool.",
      inputSchema: QuotaObservationRequestSchema,
    }, async (observation) => {
      if (this.quota === undefined) {
        throw new Error("Quota tracking is unavailable");
      }
      const value = await this.quota.observe({
        ...observation,
        observedAt: observation.observedAt ?? new Date().toISOString(),
      });
      return toolResult(value, "observation");
    });

    server.registerTool("hive_mark_dead", {
      title: "Mark Hive agent dead",
      description: "Mark a stopped Hive agent as dead in the status table.",
      inputSchema: MarkDeadRequestSchema,
    }, async ({ agent: agentName }) => {
      const agent = this.db.getAgentByName(agentName);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${agentName}`);
      }
      const updated = this.db.upsertAgent({
        ...agent,
        status: "dead",
        lastEventAt: new Date().toISOString(),
      });
      if (updated.quotaReservationId !== undefined) {
        await this.quota?.cancel(updated.quotaReservationId);
      }
      return toolResult(updated, "agent");
    });

    server.registerTool("hive_kill", {
      title: "Kill Hive agent",
      description:
        "Kill a named Hive agent's tmux session, mark it dead, and optionally remove its worktree and branch. Removal refuses to delete unmerged commits or dirty files and reports them as stranded work instead; pass discardWork to delete them anyway.",
      inputSchema: KillRequestSchema,
    }, async ({ name, removeWorktree: shouldRemoveWorktree, discardWork }) => {
      const agent = this.db.getAgentByName(name);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${name}`);
      }

      await this.tmux.killSession(agent.tmuxSession, { ignoreMissing: true });
      const timestamp = new Date().toISOString();
      const killed = this.db.markAgentDeadAndDetachTerminal(
        agent.id,
        timestamp,
      );
      if (killed === null) {
        throw new Error(`Hive agent not found: ${name}`);
      }
      if (killed.agent.quotaReservationId !== undefined) {
        await this.quota?.cancel(killed.agent.quotaReservationId, timestamp);
      }
      if (killed.terminalHandle !== undefined) {
        try {
          await this.closeTerminal(killed.terminalHandle);
        } catch {
          // Terminal cleanup is best-effort; killing and marking dead must win.
        }
        this.layout?.requestLayout();
      }
      let updated = killed.agent;
      const cleaned: {
        tmuxSession: string;
        worktreePath: string | null;
        branch: string | null;
      } = {
        tmuxSession: agent.tmuxSession,
        worktreePath: null,
        branch: null,
      };

      // Work is either merged or explicitly surfaced — never silently lost.
      // A kill therefore always reports stranded work (unmerged commits or
      // uncommitted files), and removal refuses to delete it unless the
      // caller passes discardWork.
      let stranded:
        | {
          branch: string | null;
          worktreePath: string | null;
          dirtyFiles: string[];
          unmergedCommits: number;
          note: string;
        }
        | null = null;
      if (agent.worktreePath !== null || agent.branch !== null) {
        try {
          const work = await this.assessStranded(
            this.repoRoot,
            agent.worktreePath,
            agent.branch,
          );
          if (work.dirtyFiles.length > 0 || work.unmergedCommits > 0) {
            stranded = {
              branch: agent.branch,
              worktreePath: agent.worktreePath,
              dirtyFiles: work.dirtyFiles,
              unmergedCommits: work.unmergedCommits,
              note:
                `${agent.name} left work that is not on main; merge it via an integrator agent or pass discardWork to delete it.`,
            };
          }
        } catch (error) {
          stranded = {
            branch: agent.branch,
            worktreePath: agent.worktreePath,
            dirtyFiles: [],
            unmergedCommits: 0,
            note: `stranded-work check failed (${
              error instanceof Error ? error.message : "unknown error"
            }); worktree kept.`,
          };
        }
      }

      if (
        (shouldRemoveWorktree ?? false) && agent.worktreePath !== null &&
        (stranded === null || (discardWork ?? false))
      ) {
        await this.cleanupWorktree(this.repoRoot, agent.worktreePath, {
          deleteBranch: true,
          discardTracked: discardWork ?? false,
        });
        cleaned.worktreePath = agent.worktreePath;
        cleaned.branch = agent.branch;
        updated = this.db.upsertAgent({
          ...updated,
          worktreePath: null,
          branch: null,
        });
      }

      return toolResult({ agent: updated, cleaned, stranded }, "result");
    });

    server.registerTool("hive_send", {
      title: "Send agent message",
      description:
        'Send or queue a message for a named Hive agent, or wake the root with recipient "orchestrator".',
      inputSchema: SendRequestSchema,
    }, async ({ from, to, body }) =>
      toolResult(await this.delivery.send(from, to, body), "message"));

    server.registerTool("hive_inbox", {
      title: "Read agent inbox",
      description:
        'Read and atomically acknowledge queued messages. Recipient "orchestrator" returns bounded envelopes.',
      inputSchema: InboxRequestSchema,
    }, async ({ agent }) => toolResult(
      agent === ORCHESTRATOR_NAME
        ? await this.delivery.orchestratorInbox()
        : this.delivery.inbox(agent),
      "messages",
    ));

    server.registerTool("hive_read_message", {
      title: "Read full orchestrator message",
      description:
        "Read one full agent report by the id referenced in a bounded orchestrator envelope.",
      inputSchema: ReadMessageRequestSchema,
    }, async ({ id }) => {
      const message = this.delivery.readOrchestratorMessage(id);
      if (message === null) {
        throw new Error(`Orchestrator message not found: ${id}`);
      }
      return toolResult(message, "message");
    });

    server.registerTool("hive_spawn", {
      title: "Spawn Hive agent",
      description: "Start a new Hive agent for a delegated task.",
      inputSchema: SpawnRequestSchema,
    }, async (request: SpawnRequest) => {
      const agent = await this.spawner.spawn(request);
      const current = this.db.getAgentById(agent.id);
      const persisted = current !== null &&
          current.lastEventAt >= agent.lastEventAt
        ? current
        : this.db.upsertAgent(agent);
      if (persisted.status === "failed") {
        throw new Error(
          `Hive agent ${persisted.name} failed to spawn: ${
            persisted.failureReason ?? "unknown launch failure"
          }`,
        );
      }
      return toolResult(persisted, "agent");
    });

    server.registerTool("hive_approvals", {
      title: "List pending approvals",
      description: "List approval requests currently waiting for a decision.",
      inputSchema: z.object({}),
    }, async () =>
      toolResult(this.db.listApprovals("pending"), "approvals"));

    server.registerTool("hive_approve", {
      title: "Resolve agent approval",
      description: "Approve or deny a pending Hive agent approval request.",
      inputSchema: ApprovalDecisionSchema,
    }, async ({ id, decision }) => {
      const approval = this.db.resolveApproval(
        id,
        decision === "approve" ? "approved" : "denied",
        new Date().toISOString(),
      );
      if (approval === null) {
        throw new Error(`Pending approval not found: ${id}`);
      }
      const agent = this.db.getAgentByName(approval.agentName);
      if (agent?.status === "awaiting-approval") {
        this.db.upsertAgent({ ...agent, status: "idle" });
        await this.delivery.flushQueued(approval.agentName);
      }
      return toolResult(approval, "approval");
    });

    return server;
  }

  private async handleMcp(request: Request): Promise<Response> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = this.createMcpServer();
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      return json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
        id: null,
      }, { status: 500 });
    }
  }
}

export function startDaemon(options: HiveDaemonOptions): HiveDaemon {
  const daemon = new HiveDaemon(options);
  daemon.start();
  return daemon;
}

class UnavailableSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("No concrete spawner is configured");
  }
}

if (import.meta.main) {
  const daemon = startDaemon({
    spawner: new UnavailableSpawner(),
    manageLifecycle: true,
  });
  const stop = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export type { Approval };

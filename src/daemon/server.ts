import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport as StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "bun";
import { z } from "zod";
import {
  HookEventSchema,
  type AgentRecord,
  type HookEvent,
} from "../schemas";
import { HiveDatabase, type Approval } from "./db";
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
import {
  SpawnRequestSchema,
  type SpawnRequest,
  type Spawner,
} from "./spawner";

export const HIVE_VERSION = "0.1.0";

const SendRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
});

const InboxRequestSchema = z.object({
  agent: z.string().min(1),
});

const ApprovalDecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
});

export interface HiveDaemonOptions {
  spawner: Spawner;
  db?: HiveDatabase;
  tmuxSender?: TmuxSender;
  port?: number;
  hostname?: string;
  manageLifecycle?: boolean;
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
  private bunServer: Server<undefined> | null = null;

  constructor(options: HiveDaemonOptions) {
    this.ownsDatabase = options.db === undefined;
    this.db = options.db ?? new HiveDatabase();
    this.spawner = options.spawner;
    this.delivery = new MessageDelivery(
      this.db,
      options.tmuxSender ?? new BunTmuxSender(),
    );
    this.port = options.port ?? readConfiguredPort();
    this.hostname = options.hostname ?? "127.0.0.1";
    this.manageLifecycle = options.manageLifecycle ?? false;
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
    return this.bunServer;
  }

  async stop(): Promise<void> {
    this.bunServer?.stop(true);
    this.bunServer = null;
    if (this.manageLifecycle) {
      cleanupLifecycleFiles();
    }
    if (this.ownsDatabase) {
      this.db.close();
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
    if (url.pathname === "/mcp") {
      return this.handleMcp(request);
    }
    return json({ error: "Not found" }, { status: 404 });
  }

  async processEvent(event: HookEvent): Promise<void> {
    const value = HookEventSchema.parse(event);
    this.db.transaction(() => {
      this.db.insertEvent(value);

      const agent = this.db.getAgentByName(value.agentName);
      if (agent !== null) {
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

    if (value.kind === "turn-end") {
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
      description: "List all Hive agents and their current execution status.",
      inputSchema: z.object({}),
    }, async () => toolResult(this.db.listAgents(), "agents"));

    server.registerTool("hive_send", {
      title: "Send agent message",
      description: "Send or queue a message for a named Hive agent.",
      inputSchema: SendRequestSchema,
    }, async ({ from, to, body }) =>
      toolResult(await this.delivery.send(from, to, body), "message"));

    server.registerTool("hive_inbox", {
      title: "Read agent inbox",
      description: "Read and acknowledge queued messages for a Hive agent.",
      inputSchema: InboxRequestSchema,
    }, async ({ agent }) =>
      toolResult(this.delivery.inbox(agent), "messages"));

    server.registerTool("hive_spawn", {
      title: "Spawn Hive agent",
      description: "Start a new Hive agent for a delegated task.",
      inputSchema: SpawnRequestSchema,
    }, async (request: SpawnRequest) => {
      const agent = await this.spawner.spawn(request);
      this.db.upsertAgent(agent);
      return toolResult(agent, "agent");
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

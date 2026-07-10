import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord, HookEvent } from "../schemas";
import { HiveDatabase } from "./db";
import type { TmuxSender } from "./delivery";
import { HIVE_VERSION, HiveDaemon } from "./server";
import type { SpawnRequest, Spawner } from "./spawner";

const home = mkdtempSync(join(tmpdir(), "hive-server-test-"));
process.env.HIVE_HOME = home;

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    tier: "standard",
    status: "working",
    taskDescription: "Build server",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-server",
    tmuxSession: "hive-maya",
    contextPct: 14,
    createdAt: timestamp,
    lastEventAt: timestamp,
    ...overrides,
  };
}

class SilentTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
  }
}

class RootUnavailableTmuxSender extends SilentTmuxSender {
  override async sendMessage(session: string, text: string): Promise<void> {
    if (session === "hive-orchestrator") {
      throw new Error("root session unavailable");
    }
    await super.sendMessage(session, text);
  }
}

class FakeDaemonTmux {
  readonly sessions = new Set<string>();
  readonly killed: string[] = [];
  readonly checked: string[] = [];

  async hasSession(session: string): Promise<boolean> {
    this.checked.push(session);
    return this.sessions.has(session);
  }

  async capturePane(_session: string): Promise<string> {
    return "";
  }

  async killSession(session: string): Promise<void> {
    this.killed.push(session);
    this.sessions.delete(session);
  }
}

class StubSpawner implements Spawner {
  readonly requests: SpawnRequest[] = [];

  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    this.requests.push(request);
    return agent({
      id: "agent-sam",
      name: request.name ?? "sam",
      tier: request.tier,
      taskDescription: request.task,
      tmuxSession: `hive-${request.name ?? "sam"}`,
      worktreePath: `/tmp/hive-${request.name ?? "sam"}`,
      branch: `hive/${request.name ?? "sam"}-task`,
    });
  }
}

class FailedSpawner implements Spawner {
  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    return agent({
      status: "failed",
      tier: request.tier,
      taskDescription: request.task,
      failureReason: "Error: model not supported",
      failedAt: timestamp,
    });
  }
}

async function postEvent(
  daemon: HiveDaemon,
  event: Record<string, unknown>,
): Promise<Response> {
  return daemon.fetch(new Request("http://hive/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  }));
}

function textValue(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as unknown;
}

describe("HiveDaemon HTTP server", () => {
  test("event ingestion drives every status and creates approvals", async () => {
    const db = new HiveDatabase(join(home, "events.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(),
    });
    db.insertAgent(agent());
    try {
      const events = [
        { kind: "session-start", agentName: "maya", timestamp },
        {
          kind: "turn-start",
          agentName: "maya",
          timestamp: "2026-07-09T12:00:30.000Z",
        },
        {
          kind: "turn-end",
          agentName: "maya",
          timestamp: "2026-07-09T12:01:00.000Z",
          contextPct: 47,
        },
        {
          kind: "notification",
          agentName: "maya",
          timestamp: "2026-07-09T12:02:00.000Z",
        },
        {
          kind: "approval-request",
          agentName: "maya",
          timestamp: "2026-07-09T12:03:00.000Z",
          description: "Run npm publish",
        },
        {
          kind: "dead",
          agentName: "maya",
          timestamp: "2026-07-09T12:04:00.000Z",
        },
      ] satisfies HookEvent[];
      const statuses: AgentRecord["status"][] = [
        "idle",
        "working",
        "idle",
        "awaiting-approval",
        "awaiting-approval",
        "dead",
      ];
      for (let index = 0; index < events.length; index += 1) {
        const response = await postEvent(daemon, events[index]!);
        expect(response.status).toEqual(200);
        expect(db.getAgentByName("maya")?.status).toEqual(statuses[index]);
        expect(db.getAgentByName("maya")?.lastEventAt).toEqual(
          events[index]!.timestamp,
        );
      }
      expect(db.getAgentByName("maya")?.contextPct).toEqual(47);
      expect(db.listEvents()).toEqual(events);
      const approvals = db.listApprovals("pending");
      expect(approvals.length).toEqual(2);
      expect(approvals.map((approval) => approval.description)).toEqual([
        "Notification from maya",
        "Run npm publish",
      ]);

      const invalid = await postEvent(daemon, { kind: "dead" });
      expect(invalid.status).toEqual(400);
      expect(db.listEvents().length).toEqual(6);

      const health = await daemon.fetch(new Request("http://hive/health"));
      expect(await health.json()).toEqual({ ok: true, version: HIVE_VERSION });
    } finally {
      db.close();
    }
  });

  test("all MCP tools work through StreamableHTTPClientTransport", async () => {
    const db = new HiveDatabase(join(home, "mcp.db"));
    const spawner = new StubSpawner();
    const tmux = new RootUnavailableTmuxSender();
    const daemonTmux = new FakeDaemonTmux();
    const removedWorktrees: Array<[string, string]> = [];
    const daemon = new HiveDaemon({
      db,
      spawner,
      tmuxSender: tmux,
      tmux: daemonTmux,
      repoRoot: "/tmp/repo",
      removeWorktree: async (repoRoot, worktreePath) => {
        removedWorktrees.push([repoRoot, worktreePath]);
      },
    });
    const baseUrl = "http://hive";
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        fetch: (input, init) => daemon.fetch(new Request(input, init)),
      },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);

      const spawned = textValue(await client.callTool({
        name: "hive_spawn",
        arguments: {
          task: "Review auth",
          tier: "review",
          name: "sam",
          tool: "claude",
        },
      }));
      expect(spawned).toEqual(agent({
        id: "agent-sam",
        name: "sam",
        tier: "review",
        taskDescription: "Review auth",
        tmuxSession: "hive-sam",
        worktreePath: "/tmp/hive-sam",
        branch: "hive/sam-task",
      }));
      expect(spawner.requests).toEqual([
        {
          task: "Review auth",
          tier: "review",
          name: "sam",
          tool: "claude",
        },
      ]);

      const status = textValue(await client.callTool({
        name: "hive_status",
        arguments: {},
      }));
      expect(status).toEqual([spawned]);

      const tools = await client.listTools();
      expect(tools.tools.every((tool) =>
        tool.title !== undefined && tool.description !== undefined
      )).toEqual(true);

      const missingRecipient = await client.callTool({
        name: "hive_send",
        arguments: { from: "maya", to: "nobody", body: "Hello?" },
      });
      expect(missingRecipient.isError).toEqual(true);

      const completionReport = await client.callTool({
        name: "hive_send",
        arguments: {
          from: "sam",
          to: "orchestrator",
          body: "Auth review complete on hive/sam-task.",
        },
      });
      expect(completionReport.isError ?? false).toEqual(false);
      expect(
        (textValue(completionReport) as { deliveredAt: string | null })
          .deliveredAt,
      ).toEqual(null);

      const orchestratorInbox = textValue(await client.callTool({
        name: "hive_inbox",
        arguments: { agent: "orchestrator" },
      })) as Array<{ from: string; body: string }>;
      expect(orchestratorInbox.length).toEqual(1);
      expect(orchestratorInbox[0]?.from).toEqual("sam");
      expect(orchestratorInbox[0]?.body).toEqual(
        "Auth review complete on hive/sam-task.",
      );

      const sent = textValue(await client.callTool({
        name: "hive_send",
        arguments: { from: "maya", to: "sam", body: "Please check auth." },
      })) as { deliveredAt: string | null };
      expect(sent.deliveredAt).toEqual(null);

      const inbox = textValue(await client.callTool({
        name: "hive_inbox",
        arguments: { agent: "sam" },
      })) as Array<{ deliveredAt: string | null }>;
      expect(inbox.length).toEqual(1);
      expect(inbox[0]?.deliveredAt === null).toEqual(false);

      const approvalRequest = new Request(`${baseUrl}/event`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "approval-request",
            agentName: "sam",
            timestamp: "2026-07-09T12:05:00.000Z",
            description: "Push the branch",
          }),
        });
      const approvalResponse = await daemon.fetch(approvalRequest);
      expect(approvalResponse.status).toEqual(200);

      const approvals = textValue(await client.callTool({
        name: "hive_approvals",
        arguments: {},
      })) as Array<{ id: string; status: string }>;
      expect(approvals.length).toEqual(1);
      expect(approvals[0]?.status).toEqual("pending");

      const queuedForApproval = textValue(await client.callTool({
        name: "hive_send",
        arguments: { from: "maya", to: "sam", body: "After approval." },
      })) as { deliveredAt: string | null };
      expect(queuedForApproval.deliveredAt).toEqual(null);

      const approved = textValue(await client.callTool({
        name: "hive_approve",
        arguments: { id: approvals[0]!.id, decision: "approve" },
      })) as { status: string; resolvedAt: string | null };
      expect(approved.status).toEqual("approved");
      expect(approved.resolvedAt === null).toEqual(false);
      expect(db.listApprovals("pending")).toEqual([]);
      expect(db.getAgentByName("sam")?.status).toEqual("idle");
      expect(tmux.calls).toEqual([
        ["hive-sam", "📨 message from maya: After approval."],
      ]);

      const killed = textValue(await client.callTool({
        name: "hive_kill",
        arguments: { name: "sam", removeWorktree: true },
      })) as {
        agent: AgentRecord;
        cleaned: {
          tmuxSession: string;
          worktreePath: string | null;
          branch: string | null;
        };
      };
      expect(killed.agent.status).toEqual("dead");
      expect(killed.agent.worktreePath).toEqual(null);
      expect(killed.cleaned).toEqual({
        tmuxSession: "hive-sam",
        worktreePath: "/tmp/hive-sam",
        branch: "hive/sam-task",
      });
      expect(daemonTmux.killed).toEqual(["hive-sam"]);
      expect(removedWorktrees).toEqual([
        ["/tmp/repo", "/tmp/hive-sam"],
      ]);

      const stopped = textValue(await client.callTool({
        name: "hive_mark_dead",
        arguments: { agent: "sam" },
      })) as AgentRecord;
      expect(stopped.status).toEqual("dead");
      expect(db.getAgentByName("sam")?.status).toEqual("dead");
    } finally {
      await client.close();
      await daemon.stop();
      db.close();
    }
  });

  test("reconciliation marks a vanished live session dead", async () => {
    const db = new HiveDatabase(join(home, "reconcile.db"));
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
    });
    db.insertAgent(agent({ status: "idle" }));
    try {
      await daemon.reconcileAgents();

      expect(db.getAgentByName("maya")).toMatchObject({
        status: "dead",
        failureReason: "tmux session missing (reconciled)",
      });
    } finally {
      db.close();
    }
  });

  test("reconciliation ignores spawning agents", async () => {
    const db = new HiveDatabase(join(home, "reconcile-spawning.db"));
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
    });
    db.insertAgent(agent({ status: "spawning" }));
    try {
      await daemon.reconcileAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("spawning");
      expect(tmux.checked).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("reconciliation handles stuck agents as live", async () => {
    const db = new HiveDatabase(join(home, "reconcile-stuck.db"));
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
    });
    db.insertAgent(agent({ status: "stuck" }));
    try {
      await daemon.reconcileAgents();

      expect(tmux.checked).toEqual(["hive-maya"]);
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "dead",
        failureReason: "tmux session missing (reconciled)",
      });
    } finally {
      db.close();
    }
  });

  test("hive_spawn returns a tool error for a failed verdict", async () => {
    const db = new HiveDatabase(join(home, "failed-spawn.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new FailedSpawner(),
      tmux: new FakeDaemonTmux(),
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      {
        fetch: (input, init) => daemon.fetch(new Request(input, init)),
      },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "hive_spawn",
        arguments: { task: "Unsupported launch", tier: "standard" },
      });
      const content = (result as {
        content: Array<{ type: string; text?: string }>;
      }).content;

      expect(result.isError).toEqual(true);
      expect(content[0]?.text).toContain("Error: model not supported");
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "failed",
        failureReason: "Error: model not supported",
      });
      const statuses = textValue(await client.callTool({
        name: "hive_status",
        arguments: {},
      })) as AgentRecord[];
      expect(statuses[0]?.failureReason).toEqual(
        "Error: model not supported",
      );
    } finally {
      await client.close();
      await daemon.stop();
      db.close();
    }
  });

  test("rolls back event state when approval insertion fails", async () => {
    const db = new HiveDatabase(join(home, "event-transaction.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(),
    });
    db.insertAgent(agent());
    db.database.exec(`
      CREATE TRIGGER reject_approval
      BEFORE INSERT ON approvals
      BEGIN
        SELECT RAISE(ABORT, 'approval insert rejected');
      END
    `);
    try {
      const response = await postEvent(daemon, {
        kind: "approval-request",
        agentName: "maya",
        timestamp: "2026-07-09T12:06:00.000Z",
        description: "Trigger rollback",
      });

      expect(response.status).toEqual(500);
      expect(db.listEvents()).toEqual([]);
      expect(db.getAgentByName("maya")?.status).toEqual("working");
      expect(db.listApprovals()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

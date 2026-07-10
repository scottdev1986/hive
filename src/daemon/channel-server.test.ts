import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaConfigSchema, type AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import type { TmuxSender } from "./delivery";
import { QuotaLedger } from "./quota-ledger";
import { QuotaService } from "./quota";
import { HiveDaemon } from "./server";
import { actingAs } from "./testing";
import type { SpawnRequest, Spawner } from "./spawner";

const home = mkdtempSync(join(tmpdir(), "hive-channel-server-"));
process.env.HIVE_HOME = home;

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "claude",
    model: "claude-fable-5",
    tier: "standard",
    status: "idle",
    taskDescription: "Build channels",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-channels",
    tmuxSession: "hive-maya",
    contextPct: 0,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: true,
    ...overrides,
  };
}

class SilentTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];
  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
  }
}

class StubSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not used");
  }
}

let counter = 0;

function daemon(withQuota = false): { daemon: HiveDaemon; db: HiveDatabase } {
  const db = new HiveDatabase(join(home, `server-${counter++}.db`));
  const quota = withQuota
    ? new QuotaService(
        new QuotaLedger(db),
        QuotaConfigSchema.parse({
          limits: [{
            provider: "claude",
            account: "personal",
            pool: "claude-subscription",
            models: ["claude-fable-5"],
            fiveHourAllowance: 200,
            weeklyAllowance: 1_000,
          }],
        }),
      )
    : undefined;
  return {
    daemon: new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(),
      ...(quota === undefined ? {} : { quota }),
    }),
    db,
  };
}

// Channel and statusline routes are subject-bound, so a test posts as the
// agent its body names — exactly as that agent's bridge or hook would.
const post = (
  instance: HiveDaemon,
  path: string,
  body: unknown,
): Promise<Response> => {
  const named = typeof body === "object" && body !== null && "agent" in body &&
      typeof body.agent === "string" && body.agent.length > 0
    ? body.agent
    : null;
  const fetcher = named === null
    ? actingAs(instance, "operator")
    : actingAs(instance, named, "writer");
  return fetcher(`http://127.0.0.1/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

/** Drive a real MCP tool call against the daemon, as the orchestrator does. */
async function callTool(
  instance: HiveDaemon,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: actingAs(instance, "orchestrator", "orchestrator") },
  );
  const client = new Client({ name: "channel-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

describe("channel HTTP endpoints", () => {
  test("registers a bridge, delivers a message, and acks it", async () => {
    const { daemon: instance, db } = daemon();
    try {
      db.insertAgent(agent());
      const registration = await post(instance, "/channel/register", {
        agent: "maya",
        clientName: "claude-code",
        clientVersion: "2.1.206",
      });
      expect(await registration.json()).toEqual({
        enabled: true,
        permissionRelay: true,
        retryable: false,
      });

      const sent = instance.delivery.send("sam", "maya", "hello over channel");
      const polled = await post(instance, "/channel/poll", {
        agent: "maya",
        waitMs: 5_000,
      });
      const { events } = await polled.json() as {
        events: Array<{ kind: string; deliveryId: string; content: string }>;
      };
      expect(events).toHaveLength(1);
      expect(events[0]?.content).toBe("hello over channel");

      const acked = await post(instance, "/channel/ack", {
        agent: "maya",
        deliveryId: events[0]!.deliveryId,
        ok: true,
      });
      expect(acked.status).toBe(200);

      const message = await sent;
      expect(message.state).toBe("injected");
    } finally {
      db.close();
    }
  });

  test("declines registration for an agent launched without channels", async () => {
    const { daemon: instance, db } = daemon();
    try {
      db.insertAgent(agent({ channelsEnabled: false }));
      const response = await post(instance, "/channel/register", {
        agent: "maya",
        clientVersion: "2.1.206",
      });
      expect(await response.json()).toMatchObject({
        enabled: false,
        retryable: false,
      });
    } finally {
      db.close();
    }
  });

  test("asks a bridge that outran its agent row to retry", async () => {
    const { daemon: instance, db } = daemon();
    try {
      const response = await post(instance, "/channel/register", {
        agent: "maya",
        clientVersion: "2.1.206",
      });
      expect(await response.json()).toMatchObject({
        enabled: false,
        retryable: true,
      });
    } finally {
      db.close();
    }
  });

  test("a poll without registration returns 404 so the bridge re-registers", async () => {
    const { daemon: instance, db } = daemon();
    try {
      db.insertAgent(agent());
      const response = await post(instance, "/channel/poll", { agent: "maya" });
      expect(response.status).toBe(404);
    } finally {
      db.close();
    }
  });

  test("rejects a malformed channel request", async () => {
    const { daemon: instance, db } = daemon();
    try {
      const response = await post(instance, "/channel/register", { agent: "" });
      expect(response.status).toBe(400);
    } finally {
      db.close();
    }
  });
});

describe("permission relay through the approval queue", () => {
  test("an approved relay decision reaches the CLI dialog as allow", async () => {
    const { daemon: instance, db } = daemon();
    try {
      db.insertAgent(agent());
      await post(instance, "/channel/register", {
        agent: "maya",
        clientVersion: "2.1.206",
      });

      const created = await post(instance, "/channel/permission-request", {
        agent: "maya",
        requestId: "zvrrq",
        toolName: "Bash",
        description: "Publish the package",
        inputPreview: '{"command":"npm publish"}',
      });
      const { approval } = await created.json() as {
        approval: { id: string; agentName: string; description: string };
      };
      expect(approval.agentName).toBe("maya");
      expect(approval.description).toContain("npm publish");
      expect(db.getAgentByName("maya")?.status).toBe("awaiting-approval");
      expect(db.listApprovals("pending")).toHaveLength(1);

      // The orchestrator answers through the ordinary single approval queue.
      const polled = post(instance, "/channel/poll", {
        agent: "maya",
        waitMs: 5_000,
      });
      await callTool(instance, "hive_approve", {
        id: approval.id,
        decision: "approve",
      });

      const { events } = await (await polled).json() as {
        events: Array<Record<string, unknown>>;
      };
      expect(events[0]).toMatchObject({
        kind: "permission-decision",
        requestId: "zvrrq",
        behavior: "allow",
      });
      expect(db.getApproval(approval.id)?.status).toBe("approved");
      expect(db.getAgentByName("maya")?.status).toBe("idle");
    } finally {
      db.close();
    }
  });

  test("hive_approve relays a denial to the CLI dialog", async () => {
    const { daemon: instance, db } = daemon();
    try {
      db.insertAgent(agent());
      await post(instance, "/channel/register", {
        agent: "maya",
        clientVersion: "2.1.206",
      });
      const created = await post(instance, "/channel/permission-request", {
        agent: "maya",
        requestId: "abcde",
        toolName: "Bash",
        description: "rm -rf /",
        inputPreview: "{}",
      });
      const { approval } = await created.json() as { approval: { id: string } };

      const polled = post(instance, "/channel/poll", {
        agent: "maya",
        waitMs: 5_000,
      });
      await callTool(instance, "hive_approve", {
        id: approval.id,
        decision: "deny",
      });

      const { events } = await (await polled).json() as {
        events: Array<Record<string, unknown>>;
      };
      expect(events[0]).toMatchObject({
        requestId: "abcde",
        behavior: "deny",
      });
      expect(db.getApproval(approval.id)?.status).toBe("denied");
    } finally {
      db.close();
    }
  });

  test("a non-relayed approval resolves without touching any channel", async () => {
    const { daemon: instance, db } = daemon();
    try {
      db.insertAgent(agent({ status: "awaiting-approval" }));
      const approval = db.insertApproval({
        id: "approval-hook",
        agentName: "maya",
        description: "Notification from maya",
        status: "pending",
        createdAt: timestamp,
        resolvedAt: null,
      });
      await callTool(instance, "hive_approve", {
        id: approval.id,
        decision: "approve",
      });
      expect(db.getApproval(approval.id)?.status).toBe("approved");
      expect(instance.channels.takePermissionByApproval(approval.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a permission request for a dead agent is refused", async () => {
    const { daemon: instance, db } = daemon();
    try {
      db.insertAgent(agent({ status: "dead" }));
      const response = await post(instance, "/channel/permission-request", {
        agent: "maya",
        requestId: "zvrrq",
        toolName: "Bash",
      });
      expect(response.status).toBe(404);
      expect(db.listApprovals("pending")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a control-paused agent's relayed request never revives its status", async () => {
    const { daemon: instance, db } = daemon();
    try {
      db.insertAgent(agent({ status: "control-paused", writeRevoked: true }));
      const response = await post(instance, "/channel/permission-request", {
        agent: "maya",
        requestId: "zvrrq",
        toolName: "Bash",
      });
      expect(response.status).toBe(200);
      expect(db.getAgentByName("maya")?.status).toBe("control-paused");
    } finally {
      db.close();
    }
  });
});

describe("statusline endpoint", () => {
  test("records a subscriber reading as a reported observation", async () => {
    const { daemon: instance, db } = daemon(true);
    try {
      db.insertAgent(agent());
      const response = await post(instance, "/statusline", {
        agent: "maya",
        fiveHour: { usedPct: 50, resetsAt: "2026-07-09T15:00:00.000Z" },
        sevenDay: { usedPct: 20, resetsAt: null },
        observedAt: new Date().toISOString(),
      });
      const { observation } = await response.json() as {
        observation: { fiveHourUsed: number; source: string; confidence: string } | null;
      };
      expect(observation).toMatchObject({
        fiveHourUsed: 100,
        weeklyUsed: 200,
        source: "statusline",
        confidence: "reported",
      });
    } finally {
      db.close();
    }
  });

  test("ignores a reading for an unknown agent", async () => {
    const { daemon: instance, db } = daemon(true);
    try {
      const response = await post(instance, "/statusline", {
        agent: "ghost",
        fiveHour: { usedPct: 50, resetsAt: null },
      });
      expect(response.status).toBe(404);
    } finally {
      db.close();
    }
  });

  test("accepts a reading when quota tracking is unavailable", async () => {
    const { daemon: instance, db } = daemon(false);
    try {
      db.insertAgent(agent());
      const response = await post(instance, "/statusline", {
        agent: "maya",
        fiveHour: { usedPct: 50, resetsAt: null },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ observation: null });
    } finally {
      db.close();
    }
  });

  test("rejects a malformed report", async () => {
    const { daemon: instance, db } = daemon(true);
    try {
      const response = await post(instance, "/statusline", {
        agent: "maya",
        fiveHour: { usedPct: 500 },
      });
      expect(response.status).toBe(400);
    } finally {
      db.close();
    }
  });
});

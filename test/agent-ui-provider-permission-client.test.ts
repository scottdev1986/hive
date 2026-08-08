import { describe, expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ProviderPermissionClient } from "../src/cli/agent-ui/provider-permission-client";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { HiveDaemon } from "../src/daemon/server";
import type { AgentRecord } from "../src/schemas/agent";

const AT = "2026-08-09T12:00:00.000Z";

function agent(): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "standard_coding",
    status: "working",
    taskDescription: "permission integration",
    worktreePath: "/tmp/maya",
    branch: "hive/maya",
    contextPct: null,
    createdAt: AT,
    lastEventAt: AT,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  };
}

describe("provider permission client", () => {
  test("reports, settles, polls, and acknowledges durable daemon approvals", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertAgent(agent());
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: { spawn: async () => agent() },
      repoRoot: "/tmp/provider-permission-client",
    });
    const agentToken = daemon.capabilities.mint("maya", "writer").token;
    const userToken = daemon.capabilities.mint("user", "user").token;
    const authorized =
      (token: string) =>
      (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("Host", "127.0.0.1");
        return daemon.fetch(new Request(input, { ...init, headers }));
      };
    const client = new ProviderPermissionClient(
      4317,
      "maya",
      authorized(agentToken),
    );

    const user = new Client({
      name: "provider-permission-integration",
      version: "1.0.0",
    });
    await user.connect(
      new StreamableHTTPClientTransport(new URL("http://hive/mcp"), {
        fetch: authorized(userToken),
      }),
    );
    try {
      await client.report("provider-local", "run local tests");
      const local = db
        .listApprovals("pending")
        .find((approval) => approval.description === "run local tests");
      expect(local).toBeDefined();
      if (local === undefined) throw new Error("local approval missing");
      expect(db.getAgentByName("maya")?.status).toBe("awaiting-approval");

      await client.settle("provider-local", "deny");
      expect(db.getApproval(local.id)?.status).toBe("denied");
      expect(db.getAgentByName("maya")?.status).toBe("working");

      await client.report("provider-remote", "run remote tests");
      const remote = db
        .listApprovals("pending")
        .find((approval) => approval.description === "run remote tests");
      expect(remote).toBeDefined();
      if (remote === undefined) throw new Error("remote approval missing");
      const approved = await user.callTool({
        name: "hive_approve",
        arguments: { id: remote.id, decision: "approve" },
      });
      expect(approved.isError).not.toBe(true);

      expect(await client.poll()).toEqual([
        {
          approvalId: remote.id,
          requestId: "provider-remote",
          outcome: "allow",
        },
      ]);
      await client.acknowledge(remote.id);
      expect(await client.poll()).toEqual([]);
      expect(db.getApproval(remote.id)?.status).toBe("approved");
    } finally {
      await user.close().catch(() => undefined);
      await daemon.stop();
      db.close();
    }
  });
});

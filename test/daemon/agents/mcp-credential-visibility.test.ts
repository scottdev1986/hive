import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HiveDatabase } from "../../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../../src/daemon/spawn/spawn-service";
import type { AgentRecord } from "../../../src/schemas/agent";
import { HIVE_MCP_VERSION_NEGOTIATION } from "../../../src/shared/mcp-protocol";
import { OUTSIDE_REPO_TMPDIR } from "../../outside-repo-tmpdir";

/**
 * An agent whose own credential never authenticates against the daemon's MCP
 * surface is alive and permanently mute: it paints a screen and holds a
 * process, but it can never publish mail, claim, or land. Every other status
 * dimension reads exactly like a healthy agent's, which is what these tests
 * pin — the two fixtures differ only in whether one authenticated request was
 * made, so anything that tells them apart can only be the credential
 * observation itself.
 *
 * The observation is never a verdict. It does not close the provider run and
 * it is not fused into `stuck`; an orchestrator reads it and decides.
 */

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<never> {
    throw new Error("not exercised by credential visibility tests");
  }
}

async function makeDaemon(db: HiveDatabase): Promise<HiveDaemon> {
  const home = await mkdtemp(
    join(OUTSIDE_REPO_TMPDIR, "hive-credential-home-"),
  );
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  const repoRoot = await mkdtemp(
    join(OUTSIDE_REPO_TMPDIR, "hive-credential-repo-"),
  );
  tempRoots.push(repoRoot);
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db,
    repoRoot,
    daemonLog: () => {},
  });
}

/** A live agent with a completed terminal binding and an open provider run — the shape hive_status reports on. */
function seedLiveAgent(
  db: HiveDatabase,
  name: string,
  sessionId: string,
  runId: string,
  launchedAt: string,
): AgentRecord {
  const locator = {
    schemaVersion: 1 as const,
    instanceId: "instance-fixture",
    subject: { kind: "agent" as const, agentId: `agent-${name}` },
    generation: 1,
    sessionId,
    hostKind: "sessiond" as const,
    engineBuildId: "engine-test",
  };
  const agent: AgentRecord = {
    id: `agent-${name}`,
    name,
    tool: "kimi",
    model: "kimi-code/k3",
    category: "simple_coding",
    status: "working",
    taskDescription: "Continue the assigned task",
    worktreePath: `/bounded/${name}`,
    branch: `hive/${name}`,
    sessionLocator: locator,
    contextPct: null,
    createdAt: launchedAt,
    lastEventAt: launchedAt,
    capabilityEpoch: 1,
    readOnly: false,
    writeRevoked: false,
  };
  db.insertAgent(agent);
  db.bindTerminalHostSession({
    locator,
    visibility: {
      workspaceSessionId: "workspace-fixture",
      workspacePid: 3_800,
      workspaceStartToken: "3800:1",
      openTerminalRevision: "1",
    },
  });
  db.completeTerminalHostSession(locator, {
    expectedExecutable: "bun",
    executableVerified: true,
    verifiedShellRoot: null,
    geometry: {
      columns: 80,
      rows: 24,
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
    },
    visibility: {
      state: "visible",
      workspaceSessionId: "workspace-fixture",
      openTerminalRevision: "1",
      expiresAt: "2126-08-14T20:31:13.902Z",
    },
  });
  db.insertProviderRun({
    runId,
    agentId: agent.id,
    terminal: locator,
    provider: agent.tool,
    model: agent.model,
    effort: null,
    conversationId: null,
    adapterChild: null,
    protocolReceipt: null,
    capabilityEpoch: agent.capabilityEpoch,
    launchGrantId: "launch-fixture",
    startedAt: launchedAt,
    endedAt: null,
    state: "running",
    exitReason: null,
  });
  return agent;
}

async function connect(daemon: HiveDaemon, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Host", "127.0.0.1");
        headers.set("Authorization", `Bearer ${token}`);
        return daemon.fetch(new Request(input, { ...init, headers }));
      },
    },
  );
  const client = new Client(
    { name: "hive-credential-test", version: "1.0.0" },
    { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
  );
  await client.connect(transport);
  return client;
}

interface CredentialReport {
  state: string;
  lastAuthenticatedAt: string | null;
  since: string;
  checkedAt: string;
}

async function readStatus(client: Client): Promise<{
  agents: AgentRecord[];
  credentialReporting: Record<string, CredentialReport>;
}> {
  const result = await client.callTool({
    name: "hive_status",
    arguments: { detail: "full" },
  });
  return (
    result as unknown as {
      structuredContent: {
        agents: AgentRecord[];
        credentialReporting: Record<string, CredentialReport>;
      };
    }
  ).structuredContent;
}

/** Identity and its consequences, dropped so the comparison is about reporting rather than about which fixture is which. */
function withoutIdentity(agent: AgentRecord): Partial<AgentRecord> {
  const { id, name, sessionLocator, worktreePath, branch, ...comparable } =
    agent;
  return comparable;
}

test("hive_status separates a mute agent from a reporting one, and only there", async () => {
  const db = new HiveDatabase(":memory:");
  const daemon = await makeDaemon(db);
  try {
    const launchedAt = new Date().toISOString();
    seedLiveAgent(
      db,
      "mute",
      "ses_01a0020d-0000-7000-8000-000000000001",
      "01a0020d-0000-7000-8000-00000000000a",
      launchedAt,
    );
    seedLiveAgent(
      db,
      "chatty",
      "ses_01a0020d-0000-7000-8000-000000000002",
      "01a0020d-0000-7000-8000-00000000000b",
      launchedAt,
    );

    // The one difference between the two fixtures: chatty's own credential
    // reaches /mcp, which is the whole chain the launch path cares about —
    // right port, right config, a credential that authenticates.
    const chattyClient = await connect(
      daemon,
      daemon.capabilities.mint("chatty", "writer").token,
    );
    await chattyClient.close().catch(() => undefined);

    const observer = await connect(
      daemon,
      daemon.capabilities.mint("observer", "writer").token,
    );
    const status = await readStatus(observer);
    await observer.close().catch(() => undefined);

    const rows = new Map(status.agents.map((agent) => [agent.name, agent]));
    const mute = rows.get("mute");
    const chatty = rows.get("chatty");
    if (mute === undefined || chatty === undefined) {
      throw new Error("both fixtures must appear in hive_status");
    }

    // Everything hive_status already reported is equal, so the mute agent is
    // indistinguishable from the healthy one in every pre-existing dimension.
    expect(withoutIdentity(mute)).toEqual(withoutIdentity(chatty));

    expect(status.credentialReporting.mute).toMatchObject({
      state: "never-authenticated",
      lastAuthenticatedAt: null,
      since: launchedAt,
    });
    expect(status.credentialReporting.chatty?.state).toBe("authenticated");
    expect(typeof status.credentialReporting.chatty?.lastAuthenticatedAt).toBe(
      "string",
    );
    // When it was last checked, so a caller can tell a fresh answer from a stale one.
    expect(
      Date.parse(status.credentialReporting.mute?.checkedAt ?? ""),
    ).toBeGreaterThanOrEqual(Date.parse(launchedAt));

    // An observation, not a verdict: the run stays open and nothing says stuck.
    expect(db.getActiveProviderRunForAgent("agent-mute")?.endedAt).toBeNull();
    expect(db.listRunOutcomes()).toHaveLength(0);
    expect(mute.status).not.toBe("stuck");
  } finally {
    await daemon.stop();
    db.close();
  }
});

test("an agent that launched before the daemon's record began is unobserved, not mute", async () => {
  const db = new HiveDatabase(":memory:");
  const daemon = await makeDaemon(db);
  try {
    // The daemon's record of authenticated credentials is process-local, so a
    // daemon that started after this agent launched has no evidence about its
    // handshake. An absent entry there is unknown, never a negative.
    const launchedAt = new Date(Date.now() - 600_000).toISOString();
    seedLiveAgent(
      db,
      "elder",
      "ses_01a0020d-0000-7000-8000-000000000003",
      "01a0020d-0000-7000-8000-00000000000c",
      launchedAt,
    );

    const observer = await connect(
      daemon,
      daemon.capabilities.mint("observer", "writer").token,
    );
    const status = await readStatus(observer);
    await observer.close().catch(() => undefined);

    expect(status.credentialReporting.elder).toMatchObject({
      state: "unobserved",
      lastAuthenticatedAt: null,
    });
    expect(
      Date.parse(status.credentialReporting.elder?.since ?? ""),
    ).toBeGreaterThan(Date.parse(launchedAt));
    expect(db.getActiveProviderRunForAgent("agent-elder")?.endedAt).toBeNull();
  } finally {
    await daemon.stop();
    db.close();
  }
});

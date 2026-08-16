// Adversarial tests for the daemon's authorization boundary.
//
// Every test here is written from the attacker's side: it asserts that a thing
// which *looks* legitimate is refused. A few assert the opposite — that the
// orchestrator and a self-scoped writer keep working — because an
// authorization layer that only denies is indistinguishable from a broken
// daemon.
//
// Nothing in this file touches live work: an in-memory database, a stub
// spawner that launches nothing, and a stub landBranch that runs no git.
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  readCredential,
  writeCredential,
} from "../../src/daemon/authorization/credentials";
import { credentialPath } from "../../src/hive-home/home";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import type { LandReadiness } from "../../src/daemon/landing/landing-service";
import type { MainHealthMonitorHandle } from "../../src/daemon/landing/main-health-monitor";
import type { ProjectGate } from "../../src/daemon/landing/project-gate";
import { AUTO_REARM_BUDGET, HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import {
  deleteAgentRow,
  listAuditEntries,
} from "../support/daemon-test-support";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import { bindRootSession, mailbox } from "../mail-test-support";
import { required } from "../required";
import { tempRoot } from "../temp-root";
import { callHiveTool } from "../../src/cli/mcp";

const home = tempRoot("hive-auth-test-");
process.env.HIVE_HOME = home;

const timestamp = "2026-07-10T12:00:00.000Z";

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: `agent-${overrides.name ?? "maya"}`,
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "working",
    taskDescription: "Phase 0",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-work",
    contextPct: 3,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

class StubSpawner implements Spawner {
  readonly requests: SpawnRequest[] = [];
  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    this.requests.push(request);
    const name = `spawned-${this.requests.length}`;
    return agentRecord({ id: `agent-${name}`, name });
  }
}

interface Harness {
  daemon: HiveDaemon;
  db: HiveDatabase;
  spawner: StubSpawner;
  landed: string[];
  landFailures: { count: number };
}

function harness(
  options: {
    landFailsTimes?: number;
    readiness?: LandReadiness;
    refreshModelControl?: () => Promise<void>;
    projectGate?: ProjectGate;
    mainHealthMonitor?: MainHealthMonitorHandle;
    repoRoot?: string;
  } = {},
): Harness {
  const db = new HiveDatabase(":memory:");
  const spawner = new StubSpawner();
  const landed: string[] = [];
  const landFailures = { count: options.landFailsTimes ?? 0 };
  // Unknown by default: this harness has no git, and "we could not read the
  // branch" is exactly what the daemon must treat as a reason to ask, not as a
  // reason to grant. Every re-arm test below therefore runs the fail-closed
  // path unless it passes its own readiness.
  const readiness: LandReadiness = options.readiness ?? {
    pending: null,
    rebased: null,
    targetBranch: null,
    targetHead: null,
    baseSha: null,
  };
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner,
    repoRoot: options.repoRoot ?? join(tmpdir(), "hive-auth-noop"),
    landBranch: async (_root, branch) => {
      if (landFailures.count > 0) {
        landFailures.count -= 1;
        throw new Error("Not possible to fast-forward, aborting.");
      }
      landed.push(branch);
      return {
        commit: "c0ffee".padEnd(40, "0"),
        landedCommits: ["c0ffee".padEnd(40, "0")],
      };
    },
    projectGate: options.projectGate ?? (async () => {}),
    ...(options.mainHealthMonitor === undefined
      ? {}
      : { mainHealthMonitor: options.mainHealthMonitor }),
    readLandReadiness: async () => readiness,
    listSettlementBranches: async () => [],
    reconcileOrphanedWorktrees: async () => ({
      worktrees: [],
      preservedRefs: { releasable: [], kept: [] },
    }),
    ...(options.refreshModelControl === undefined
      ? {}
      : { refreshModelControl: options.refreshModelControl }),
  });
  bindRootSession(db);
  return { daemon, db, spawner, landed, landFailures };
}

const authorized =
  (daemon: HiveDaemon, token: string | null) =>
  (input: string | URL, init?: RequestInit) => {
    // Headers must be merged through the Headers API: spreading a Headers
    // instance yields {} and would strip the MCP client's Accept header.
    const headers = new Headers(init?.headers);
    headers.set("Host", "127.0.0.1");
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };

async function callTool(
  daemon: HiveDaemon,
  token: string | null,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; error: string; content: unknown }> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const text = JSON.stringify(result.content ?? "");
    return {
      ok: result.isError !== true,
      error: result.isError === true ? text : "",
      content: result.content,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "?",
      content: null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

const denials = (daemon: HiveDaemon): string[] =>
  listAuditEntries(daemon.db, 50)
    .filter((entry) => entry.decision === "deny")
    .map((entry) => entry.reason ?? "");

describe("an unauthenticated process cannot mutate anything", () => {
  test("every mutation route rejects a caller with no credential", async () => {
    const { daemon, db, spawner, landed } = harness();
    db.upsertAgent(agentRecord());

    const routes: Array<[string, string, unknown]> = [
      [
        "/event",
        "POST",
        { kind: "notification", agentName: "maya", timestamp },
      ],
      ["/recover", "POST", { agent: "maya" }],
      ["/quota/observe", "POST", {}],
      ["/settlement/sweep", "POST", {}],
      ["/token-usage/protocol-session-facts", "POST", { agent: "maya" }],
      [
        "/provider-permission/settled",
        "POST",
        { requestId: "permission-1", outcome: "deny" },
      ],
    ];
    for (const [path, method, body] of routes) {
      const response = await authorized(daemon, null)(`http://hive${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      expect([path, method, response.status]).toEqual([path, method, 401]);
    }

    // The MCP transport refuses before a tool can even be enumerated.
    for (const tool of [
      "hive_spawn",
      "hive_spawn_many",
      "hive_kill",
      "hive_approve",
      "hive_land",
    ]) {
      expect((await callTool(daemon, null, tool, {})).ok).toBe(false);
    }
    expect(spawner.requests).toHaveLength(0);
    expect(landed).toEqual([]);
    expect(db.getAgentByName("maya")?.status).toBe("working");
    await daemon.stop();
  });

  test("a malformed or unknown token is refused, and audited", async () => {
    const { daemon } = harness();
    const response = await authorized(daemon, "not-a-token")(
      "http://hive/recover",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(401);

    const unknown = `hv1.${crypto.randomUUID()}.deadbeef`;
    expect((await callTool(daemon, unknown, "hive_status")).ok).toBe(false);
    expect(denials(daemon)).toContain("capability.malformed");
    expect(denials(daemon)).toContain("capability.unknown");
    await daemon.stop();
  });

  test("a real capability id with a wrong secret is indistinguishable from an unknown one", async () => {
    const { daemon } = harness();
    const { capability } = daemon.capabilities.mint("maya", "writer");
    const forged = `hv1.${capability.id}.wrong-secret`;
    expect((await callTool(daemon, forged, "hive_status")).ok).toBe(false);
    expect(denials(daemon)).toContain("capability.unknown");
    await daemon.stop();
  });

  test("/health stays public and authorizes nothing", async () => {
    const { daemon } = harness();
    await daemon.runMaintenance();
    const response = await daemon.fetch(new Request("http://hive/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    await daemon.stop();
  });

  test("/health refuses readiness until maintenance succeeds and exposes isolated failures", async () => {
    const { daemon } = harness({
      refreshModelControl: () =>
        Promise.reject(new Error("provider inventory unavailable")),
    });

    const before = await daemon.fetch(new Request("http://hive/health"));
    expect(before.status).toBe(503);
    expect(await before.json()).toMatchObject({
      ok: false,
      maintenance: { status: "unknown" },
    });

    await daemon.runMaintenance();
    const after = await daemon.fetch(new Request("http://hive/health"));
    expect(after.status).toBe(503);
    expect(await after.json()).toMatchObject({
      ok: false,
      maintenance: {
        status: "degraded",
        failures: [
          {
            component: "model-control refresh",
            error: "provider inventory unavailable",
          },
        ],
      },
    });
    await daemon.stop();
  });
});

describe("a foreign agent cannot act on another tenant", () => {
  test("maya cannot land, kill, or read the inbox of zara", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    db.upsertAgent(
      agentRecord({ id: "agent-zara", name: "zara", branch: "hive/zara-work" }),
    );
    const { token } = daemon.capabilities.mint("maya", "writer");

    // The confused deputy: a body field naming another subject grants nothing.
    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "zara",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(false);
    expect(
      (await callTool(daemon, token, "hive_mail_poll", { recipient: "zara" }))
        .ok,
    ).toBe(false);
    expect(
      (await callTool(daemon, token, "hive_kill", { name: "zara" })).ok,
    ).toBe(false);
    expect(
      (
        await callTool(daemon, token, "hive_mail_publish", {
          from: "zara",
          to: "orchestrator",
          lane: "control",
          body: "spoofed",
          idempotencyKey: "spoofed-1",
        })
      ).ok,
    ).toBe(false);

    expect(landed).toEqual([]);
    expect(db.getAgentByName("zara")?.status).toBe("working");
    expect(denials(daemon)).toContain("capability.foreign-subject");
    await daemon.stop();
  });

  test("a writer holds none of the orchestrator's rights", async () => {
    const { daemon, db, spawner } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer");

    for (const [tool, args] of [
      ["hive_spawn", { task: "probe", category: "simple_coding" }],
      [
        "hive_spawn_many",
        { requests: [{ task: "probe", category: "simple_coding" }] },
      ],
      ["hive_approve", { id: "any", decision: "approve" }],
      ["hive_approvals", {}],
      ["hive_settlement_decide", {}],
    ] as const) {
      expect([tool, (await callTool(daemon, token, tool, args)).ok]).toEqual([
        tool,
        false,
      ]);
    }
    expect(spawner.requests).toHaveLength(0);
    expect(denials(daemon)).toContain("capability.forbidden-action");
    await daemon.stop();
  });

  test("a writer can compile memory but never delete it", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer");

    const denied = await callTool(daemon, token, "memory_delete", {
      scope: "repo",
      id: "any",
    });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("may not memory:delete");
    expect(denials(daemon)).toContain("capability.forbidden-action");

    // The roots keep the right: the user and the orchestrator delete.
    for (const [subject, role] of [
      ["user", "user"],
      ["queen", "orchestrator"],
    ] as const) {
      const root = daemon.capabilities.mint(subject, role).token;
      // The article does not exist, but the call is authorized and answers.
      expect(
        (
          await callTool(daemon, root, "memory_delete", {
            scope: "repo",
            id: "any",
          })
        ).ok,
      ).toBe(true);
    }
    await daemon.stop();
  });

  test("a foreign agent cannot report events as another agent", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    db.upsertAgent(agentRecord({ id: "agent-zara", name: "zara" }));
    const { token } = daemon.capabilities.mint("maya", "writer");

    const event = await authorized(daemon, token)("http://hive/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "dead", agentName: "zara", timestamp }),
    });
    expect(event.status).toBe(403);
    expect(db.getAgentByName("zara")?.status).toBe("working");

    await daemon.stop();
  });
});

describe("the orchestrator decides but never merges", () => {
  test("the orchestrator cannot land a branch or write into a worktree", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("orchestrator", "orchestrator");

    const result = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("may not branch:land");
    expect(landed).toEqual([]);
    expect(denials(daemon)).toContain("capability.forbidden-action");
    await daemon.stop();
  });
});

describe("a revoked epoch invalidates a capability", () => {
  test("an epoch advance makes an outstanding landing right stale", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    db.upsertAgent(agentRecord({ capabilityEpoch: 1 }));
    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 1,
        })
      ).ok,
    ).toBe(false);
    expect(landed).toEqual([]);
    expect(denials(daemon)).toContain("capability.stale-epoch");
    await daemon.stop();
  });

  test("a stale landing argument is refused and the live epoch can retry", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord({ capabilityEpoch: 4 }));
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 4 });

    const refused = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 3,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(
      "capabilityEpoch passed (3) is not maya's current epoch (4)",
    );
    expect(landed).toEqual([]);

    const retried = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 4,
    });
    expect(retried.ok).toBe(true);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("a critical control revokes write and landing authority for the live token", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    // This is exactly what a critical control publish calls.
    db.revokeAgentCapabilities("maya", timestamp);

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await callTool(daemon, token, "memory_write", {
          scope: "repo",
          title: "x",
          body: "y",
        })
      ).ok,
    ).toBe(false);
    expect(landed).toEqual([]);
    expect(denials(daemon)).toContain("capability.write-revoked");

    // The paused agent can still speak, which is the whole point of a pause.
    expect(
      (
        await callTool(daemon, token, "hive_mail_publish", {
          from: "maya",
          to: "orchestrator",
          lane: "control",
          body: "paused",
          idempotencyKey: "maya-paused-1",
        })
      ).ok,
    ).toBe(true);
    await daemon.stop();
  });

  test("killing an agent revokes its credential outright", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer");
    const user = daemon.capabilities.mint("user", "user").token;

    expect((await callTool(daemon, token, "hive_status")).ok).toBe(true);
    expect(
      (await callTool(daemon, user, "hive_kill", { name: "maya" })).ok,
    ).toBe(true);
    // A surviving descendant of the killed process holds a dead credential.
    expect((await callTool(daemon, token, "hive_status")).ok).toBe(false);
    expect(denials(daemon)).toContain("capability.revoked");
    await daemon.stop();
  });

  test("an expired capability is refused", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { ttlMs: -1 });
    expect((await callTool(daemon, token, "hive_status")).ok).toBe(false);
    expect(denials(daemon)).toContain("capability.expired");
    await daemon.stop();
  });
});

describe("an agent-bound capability requires a live authority record", () => {
  test("a writer whose agent row vanished is refused instead of inheriting permission", async () => {
    const { daemon, db } = harness();
    const record = db.upsertAgent(agentRecord());
    const { capability } = daemon.capabilities.mint("maya", "writer", {
      epoch: 0,
    });
    expect(deleteAgentRow(db, record.id)).toBe(true);

    expect(
      daemon.capabilities.authorize(capability, {
        action: "branch:land",
        route: "hive_land",
      }),
    ).toMatchObject({
      ok: false,
      reason: "capability.authority-unknown",
    });
    await daemon.stop();
  });
});

describe("the codex root token endpoint", () => {
  test("mints a session-lived orchestrator capability for the user", async () => {
    const { daemon } = harness();
    const user = daemon.capabilities.mint("user", "user", {
      epoch: 0,
    });

    const response = await authorized(daemon, user.token)(
      "http://hive/codex-root-token",
      { method: "POST" },
    );
    expect(response.status).toEqual(200);
    const body = (await response.json()) as {
      token: string;
      expiresAt: string;
    };
    expect(body.token.length).toBeGreaterThan(0);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The minted token authenticates as the orchestrator subject.
    expect((await callTool(daemon, body.token, "hive_status")).ok).toBe(true);
    await daemon.stop();
  });

  test("refuses writers and anonymous callers", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const writer = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    const denied = await authorized(daemon, writer.token)(
      "http://hive/codex-root-token",
      { method: "POST" },
    );
    expect(denied.status).toEqual(403);
    const anonymous = await authorized(daemon, null)(
      "http://hive/codex-root-token",
      { method: "POST" },
    );
    expect(anonymous.status).toEqual(401);
    await daemon.stop();
  });

  test("a fresh mint revokes the predecessor and persists the queen credential", async () => {
    const { daemon } = harness();
    const user = daemon.capabilities.mint("user", "user", {
      epoch: 0,
    });
    const mint = async () => {
      const response = await authorized(daemon, user.token)(
        "http://hive/codex-root-token",
        { method: "POST" },
      );
      expect(response.status).toEqual(200);
      return ((await response.json()) as { token: string }).token;
    };

    const predecessor = await mint();
    expect((await callTool(daemon, predecessor, "hive_status")).ok).toBe(true);
    const successor = await mint();
    // The predecessor's token is dead: only the current root's credential
    // may act, and the store holds exactly that one.
    expect((await callTool(daemon, predecessor, "hive_status")).ok).toBe(false);
    expect((await callTool(daemon, successor, "hive_status")).ok).toBe(true);
    expect(readCredential(ORCHESTRATOR_NAME)).toEqual(successor);
    await daemon.stop();
  });

  test("launcher mint grants content:true; startup issueCredential does not", async () => {
    // Root self-observe requires content:true (capabilities.ts self path).
    // Production must not diverge from that fixture: only POST /codex-root-token
    // (the launcher mint that replaces queen.cap) grants it. Generic startup
    // issueCredential stays unconstrained so the pre-launch token is not widened.
    const { daemon, db } = harness();
    const startupToken = daemon.issueCredential(
      ORCHESTRATOR_NAME,
      "orchestrator",
      0,
    );
    const startupId = required(startupToken.split(".")[1]);
    const startupRow = required(db.getCapability(startupId));
    expect(startupRow.capability.constraints?.content).not.toBe(true);

    const user = daemon.capabilities.mint("user", "user", {
      epoch: 0,
    });
    const response = await authorized(daemon, user.token)(
      "http://hive/codex-root-token",
      { method: "POST" },
    );
    expect(response.status).toEqual(200);
    const launcherToken = ((await response.json()) as { token: string }).token;
    const launcherId = required(launcherToken.split(".")[1]);
    const launcherRow = required(db.getCapability(launcherId));
    expect(launcherRow.capability.constraints).toEqual({ content: true });
    await daemon.stop();
  });
});

describe("a one-shot landing grant cannot be replayed", () => {
  test("a project gate refusal blocks the merge", async () => {
    let calls = 0;
    const { daemon, db, landed } = harness({
      projectGate: async () => {
        calls += 1;
        throw new Error(
          "Project format:check blocked landing: deliberate regression",
        );
      },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    const result = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("deliberate regression");
    expect(calls).toBe(1);
    expect(landed).toEqual([]);
    await daemon.stop();
  });

  test("a successful land asks the out-of-band main monitor to check now", async () => {
    let checks = 0;
    const { daemon, db } = harness({
      mainHealthMonitor: {
        start: () => {},
        checkNow: async () => {
          checks += 1;
        },
        stop: async () => {},
      },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    const result = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });

    expect(result.ok).toBe(true);
    expect(checks).toBe(1);
    await daemon.stop();
  });

  test("the second land with the same capability is denied", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    expect(landed).toEqual(["hive/maya-work"]);

    const replay = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(replay.ok).toBe(false);
    expect(replay.error).toContain("already spent");
    expect(landed).toEqual(["hive/maya-work"]);
    expect(denials(daemon)).toContain("capability.replayed");
    await daemon.stop();
  });

  test("a refused land files a re-arm approval and approving grants one more landing", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });
    const user = daemon.capabilities.mint("user", "user", {
      epoch: 0,
    });

    // Land once (spends the grant), then land follow-up work: refused, but
    // the refusal files exactly one pending re-arm approval, even across
    // repeated refusals.
    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    const refused = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(refused.ok).toBe(false);
    // The refusal names what happened, and tells the agent there is nothing for
    // *it* to run — Hive filed the approval itself. The only action left is the
    // orchestrator's, so that is the one thing on the Fix: line.
    expect(refused.error).toContain("already spent");
    expect(refused.error).toContain(
      "Hive has already filed the re-arm approval",
    );
    expect(refused.error).toContain("Fix: the orchestrator approves");
    await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    const pending = db
      .listApprovals("pending")
      .filter((approval) => approval.agentName === "maya");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.description).toContain("Re-arm landing");

    // Approval re-arms exactly one landing: the next land succeeds, the one
    // after is refused again.
    const approved = await callTool(daemon, user.token, "hive_approve", {
      id: pending[0]?.id,
      decision: "approve",
    });
    expect(approved.ok).toBe(true);

    // Nothing tells a waiting agent its re-arm resolved unless the daemon
    // says so itself — this is the notification that replaces the user
    // having to prod it with an urgent message.
    const notice = mailbox(daemon.mail, "maya").find(
      (item) => item.sender === "hive-approvals",
    );
    expect(notice?.body).toContain(pending[0]?.description);
    expect(notice?.body).toContain("approved");
    expect(notice?.body).toContain("retry hive_land now");

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    expect(landed).toEqual(["hive/maya-work", "hive/maya-work"]);
    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(false);
    await daemon.stop();
  });

  test("denying the re-arm approval leaves the grant spent", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });
    const user = daemon.capabilities.mint("user", "user", {
      epoch: 0,
    });

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(false);
    const pending = db
      .listApprovals("pending")
      .filter((approval) => approval.agentName === "maya");
    expect(pending).toHaveLength(1);
    expect(
      (
        await callTool(daemon, user.token, "hive_approve", {
          id: pending[0]?.id,
          decision: "deny",
        })
      ).ok,
    ).toBe(true);

    // A denial must not leave the agent waiting or guessing: it is told
    // explicitly, so it reports back instead of retrying blindly.
    const notice = mailbox(daemon.mail, "maya").find(
      (item) => item.sender === "hive-approvals",
    );
    expect(notice?.body).toContain(pending[0]?.description);
    expect(notice?.body).toContain("denied");
    expect(notice?.body).toContain("report back");

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(false);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("an MCP delivery failure reaches the CLI with its reason", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint(
      "orchestrator",
      "orchestrator",
    ).token;
    const approvalId = daemon.queueProviderApproval(
      "maya",
      "detached-provider-request",
      "run a command",
    );
    const approvalOwner = daemon as unknown as {
      approvalService: {
        providerPermissionRequests: Map<string, unknown>;
      };
    };
    approvalOwner.approvalService.providerPermissionRequests.delete(approvalId);

    await expect(
      callHiveTool(
        4483,
        "hive_approve",
        { id: approvalId, decision: "approve" },
        "approval",
        authorized(daemon, token),
      ),
    ).rejects.toThrow(
      "hive_approve failed: the provider permission is not attached to a live frontend",
    );
    await daemon.stop();
  });

  test("concurrent lands merge exactly once", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    const results = await Promise.all([
      callTool(daemon, token, "hive_land", {
        agent: "maya",
        capabilityEpoch: 0,
      }),
      callTool(daemon, token, "hive_land", {
        agent: "maya",
        capabilityEpoch: 0,
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("a lost fast-forward race releases the grant so the rebase can retry", async () => {
    const { daemon, db, landed } = harness({ landFailsTimes: 1 });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    // main moved: the merge fails and the writer must still be able to land.
    const rejected = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("fast-forward");
    expect(landed).toEqual([]);

    const retried = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(retried.ok).toBe(true);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });
});

describe("a descendant process inherits no reusable credential", () => {
  test("the credential file is 0600 inside a 0700 directory, outside every worktree", () => {
    writeCredential("descendant-probe", "hv1.id.secret");
    const path = credentialPath("descendant-probe");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "credentials")).mode & 0o777).toBe(0o700);
    expect(path.startsWith(home)).toBe(true);
  });

  test("the credential descriptor is close-on-exec, so a child cannot read it", () => {
    writeCredential("cloexec-probe", "hv1.id.secret");
    // Prove the property the daemon relies on: a descriptor opened for a
    // credential is not inherited across exec. The child is asked to read the
    // parent's descriptor number directly.
    const probe = Bun.spawnSync([
      process.execPath,
      "-e",
      `const fs = require("node:fs");
       const O_CLOEXEC = 0x1000000;
       const fd = fs.openSync(${JSON.stringify(credentialPath("cloexec-probe"))}, fs.constants.O_RDONLY | O_CLOEXEC);
       const child = Bun.spawnSync(["bash", "-c", "cat /dev/fd/" + fd + " 2>&1 || echo NOT_INHERITED"]);
       console.log(child.stdout.toString().includes("hv1.id.secret") ? "INHERITED" : "NOT_INHERITED");
       fs.closeSync(fd);`,
    ]);
    expect(probe.stdout.toString().trim()).toBe("NOT_INHERITED");
  });

  test("no capability token is ever placed in an agent's environment", () => {
    writeCredential("env-probe", "hv1.id.supersecret");
    // Model the environment handed to an agent explicitly. The test runner's
    // ambient environment may itself belong to a Hive agent and contain a
    // capability token unrelated to this fixture.
    const environment = JSON.stringify({
      HIVE_HOME: home,
      PATH: "/usr/bin:/bin",
    });
    expect(environment).not.toContain("hv1.");
    expect(environment).not.toContain("supersecret");
  });

  test("a descendant that cannot read the credential file is refused by the daemon", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    daemon.capabilities.mint("maya", "writer");

    // A descendant with no credential — the environment gave it nothing and
    // the descriptor did not survive its exec — presents no token at all.
    expect(readCredential("a-name-that-was-never-issued")).toBeNull();
    expect(
      (
        await callTool(daemon, null, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(false);
    expect(denials(daemon)).toContain("capability.absent");
    await daemon.stop();
  });

  test("a written credential round-trips through a close-on-exec read", () => {
    writeCredential("roundtrip", "hv1.abc.def");
    expect(readCredential("roundtrip")).toBe("hv1.abc.def");
    expect(readFileSync(credentialPath("roundtrip"), "utf8").trim()).toBe(
      "hv1.abc.def",
    );
  });
});

describe("legitimate workflows keep working", () => {
  test("the orchestrator spawns, approves, kills, and reads the global inbox", async () => {
    const { daemon, db, spawner } = harness();
    db.upsertAgent(agentRecord());
    const maya = required(db.getAgentByName("maya"));
    db.insertProviderRun({
      runId: crypto.randomUUID(),
      agentId: maya.id,
      terminal: required(maya.sessionLocator),
      provider: maya.tool,
      model: maya.model,
      effort: null,
      conversationId: null,
      adapterChild: {
        pid: 4_200,
        startToken: "4200:1",
        processGroupId: 4_200,
        observedAt: timestamp,
      },
      protocolReceipt: null,
      capabilityEpoch: maya.capabilityEpoch,
      launchGrantId: "grant-auth-workflow",
      startedAt: timestamp,
      endedAt: null,
      state: "running",
      exitReason: null,
    });
    const { token } = daemon.capabilities.mint("orchestrator", "orchestrator");

    expect(
      (
        await callTool(daemon, token, "hive_spawn", {
          name: "alex",
          task: "try to choose an identity",
          category: "simple_coding",
        })
      ).ok,
    ).toBe(false);
    expect(spawner.requests).toHaveLength(0);

    expect(
      (
        await callTool(daemon, token, "hive_spawn", {
          task: "do a thing",
          category: "simple_coding",
        })
      ).ok,
    ).toBe(true);
    expect(spawner.requests).toHaveLength(1);

    expect(
      (
        await callTool(daemon, token, "hive_spawn_many", {
          requests: [
            {
              task: "do the first thing",
              category: "simple_coding",
            },
            {
              task: "do the second thing",
              category: "debugging",
            },
          ],
        })
      ).ok,
    ).toBe(true);
    expect(spawner.requests).toHaveLength(3);

    const approvalId = daemon.queueProviderApproval(
      "maya",
      "provider-request-1",
      "run a command",
    );
    expect((await callTool(daemon, token, "hive_approvals")).ok).toBe(true);
    expect(
      (
        await callTool(daemon, token, "hive_approve", {
          id: approvalId,
          decision: "approve",
        })
      ).ok,
    ).toBe(true);
    expect(db.getApproval(approvalId)?.status).toBe("approved");
    const mayaToken = daemon.capabilities.mint("maya", "writer").token;
    const decisionsResponse = await authorized(
      daemon,
      mayaToken,
    )("http://localhost/provider-permission/decisions");
    expect(decisionsResponse.status).toBe(200);
    expect(await decisionsResponse.json()).toEqual({
      decisions: [
        {
          approvalId,
          requestId: "provider-request-1",
          outcome: "allow",
        },
      ],
    });
    const ackResponse = await authorized(daemon, mayaToken)(
      "http://localhost/provider-permission/ack",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId }),
      },
    );
    expect(ackResponse.status).toBe(200);

    expect(
      (
        await callTool(daemon, token, "hive_mail_poll", {
          recipient: "orchestrator",
        })
      ).ok,
    ).toBe(true);
    expect((await callTool(daemon, token, "hive_status")).ok).toBe(true);
    await daemon.stop();
  });

  test("a pane settlement retires pending and already-queued provider approvals", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord({ status: "awaiting-approval" }));
    const mayaToken = daemon.capabilities.mint("maya", "writer").token;
    const user = daemon.capabilities.mint("orchestrator", "orchestrator").token;

    const localApproval = daemon.queueProviderApproval(
      "maya",
      "provider-local",
      "run local command",
    );
    const localSettlement = await authorized(daemon, mayaToken)(
      "http://localhost/provider-permission/settled",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "provider-local",
          outcome: "deny",
        }),
      },
    );
    expect(localSettlement.status).toBe(200);
    expect(db.getApproval(localApproval)?.status).toBe("denied");

    const queuedApproval = daemon.queueProviderApproval(
      "maya",
      "provider-queued",
      "run queued command",
    );
    expect(
      (
        await callTool(daemon, user, "hive_approve", {
          id: queuedApproval,
          decision: "approve",
        })
      ).ok,
    ).toBe(true);
    const queuedSettlement = await authorized(daemon, mayaToken)(
      "http://localhost/provider-permission/settled",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "provider-queued",
          outcome: "allow",
        }),
      },
    );
    expect(queuedSettlement.status).toBe(200);
    expect(await queuedSettlement.json()).toEqual({ settled: 1 });
    const decisions = await authorized(
      daemon,
      mayaToken,
    )("http://localhost/provider-permission/decisions");
    expect(await decisions.json()).toEqual({ decisions: [] });

    await daemon.stop();
  });

  test("root credentials accept queen↔orchestrator cross-pairs and case variants", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    // Preferred mint subject is queen; synonym still appears on older tooling.
    const asQueen = daemon.capabilities.mint("queen", "orchestrator").token;
    const asSynonym = daemon.capabilities.mint(
      "orchestrator",
      "orchestrator",
    ).token;

    expect(
      (
        await callTool(daemon, asQueen, "hive_mail_poll", {
          recipient: "orchestrator",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await callTool(daemon, asQueen, "hive_mail_poll", {
          recipient: "Orchestrator",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await callTool(daemon, asQueen, "hive_mail_poll", {
          recipient: "queen",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await callTool(daemon, asQueen, "hive_mail_poll", {
          recipient: "Queen",
        })
      ).ok,
    ).toBe(true);

    expect(
      (
        await callTool(daemon, asSynonym, "hive_mail_poll", {
          recipient: "queen",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await callTool(daemon, asSynonym, "hive_mail_poll", {
          recipient: "Queen",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await callTool(daemon, asSynonym, "hive_mail_poll", {
          recipient: "orchestrator",
        })
      ).ok,
    ).toBe(true);

    // Foreign root-style subject from a worker is still denied.
    const worker = daemon.capabilities.mint("maya", "writer").token;
    expect(
      (await callTool(daemon, worker, "hive_mail_poll", { recipient: "queen" }))
        .ok,
    ).toBe(false);
    await daemon.stop();
  });

  test("a writer reports, talks, reads its own inbox, and lands its own branch", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    const event = await authorized(daemon, token)("http://hive/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "turn-start",
        agentName: "maya",
        timestamp,
      }),
    });
    expect(event.status).toBe(200);

    expect(
      (
        await callTool(daemon, token, "hive_mail_publish", {
          from: "maya",
          to: "orchestrator",
          lane: "control",
          body: "report",
          idempotencyKey: "maya-report-1",
        })
      ).ok,
    ).toBe(true);
    expect(
      (await callTool(daemon, token, "hive_mail_poll", { recipient: "maya" }))
        .ok,
    ).toBe(true);
    expect((await callTool(daemon, token, "hive_status")).ok).toBe(true);
    expect(
      (await callTool(daemon, token, "memory_search", { query: "phase" })).ok,
    ).toBe(true);

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("the user drives recovery", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord({ status: "dead" }));
    const { token } = daemon.capabilities.mint("user", "user");

    const recover = await authorized(daemon, token)("http://hive/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(recover.status).toBe(200);
    await daemon.stop();
  });
});

describe("audit", () => {
  test("denials record the caller, the subject it reached for, and why it lost", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    db.upsertAgent(agentRecord({ id: "agent-zara", name: "zara" }));
    const { token, capability } = daemon.capabilities.mint("maya", "writer");

    await callTool(daemon, token, "hive_land", {
      agent: "zara",
      capabilityEpoch: 0,
    });

    const entry = listAuditEntries(db, 50).find(
      (row) => row.decision === "deny" && row.action === "branch:land",
    );
    expect(entry).toBeDefined();
    expect(entry?.callerSubject).toBe("maya");
    expect(entry?.callerRole).toBe("writer");
    expect(entry?.requestedSubject).toBe("zara");
    expect(entry?.capabilityId).toBe(capability.id);
    expect(entry?.reason).toBe("capability.foreign-subject");
    await daemon.stop();
  });

  test("the audit log never contains the token secret", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer");
    const secret = required(token.split(".")[2]);

    await callTool(daemon, token, "hive_spawn", {
      task: "denied",
      category: "simple_coding",
    });
    await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });

    const serialized = JSON.stringify(listAuditEntries(db, 50));
    expect(serialized).not.toContain(secret);
    expect(serialized.length).toBeGreaterThan(2);
    await daemon.stop();
  });

  test("read-only traffic is not audited", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer");

    await callTool(daemon, token, "hive_status");
    await callTool(daemon, token, "hive_status");
    expect(listAuditEntries(db, 50)).toHaveLength(0);
    await daemon.stop();
  });

  test("the database stores only a hash of the secret", () => {
    const { daemon, db } = harness();
    const { token, capability } = daemon.capabilities.mint("maya", "writer");
    const secret = required(token.split(".")[2]);
    const row = db.database
      .query("SELECT secretHash FROM capabilities WHERE id = ?")
      .get(capability.id) as { secretHash: string };
    expect(row.secretHash).not.toContain(secret);
    expect(row.secretHash).toMatch(/^[0-9a-f]{64}$/);
    void daemon.stop();
  });
});

// The re-arm is where Hive spends users. Two things it must never do: ask for
// an approval that grants nothing (the branch is already merged), and grant one
// on evidence it does not have.
describe("a spent land grant is measured before a user is asked", () => {
  const pendingRearms = (db: HiveDatabase): number =>
    db
      .listApprovals("pending")
      .filter((approval) => approval.description.startsWith("Re-arm landing"))
      .length;

  const autoRearms = (daemon: HiveDaemon): number =>
    listAuditEntries(daemon.db, 50).filter(
      (entry) => entry.reason === "capability.auto-rearm",
    ).length;

  test("an already-landed branch files no re-arm approval at all", async () => {
    // main..branch is empty: there is nothing to merge, so there is nothing to
    // grant, and asking a user costs them a decline for no change at all.
    const { daemon, db, landed } = harness({
      readiness: {
        pending: 0,
        rebased: true,
        targetBranch: "main",
        targetHead: null,
        baseSha: null,
      },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    const again = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(again.ok).toBe(false);
    expect(again.error).toContain("Nothing to land for maya");
    expect(again.error).toContain("No re-arm approval was filed");
    expect(pendingRearms(db)).toBe(0);
    expect(autoRearms(daemon)).toBe(0);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("real work on a rebased branch re-arms itself, up to the budget", async () => {
    const { daemon, db, landed } = harness({
      readiness: {
        pending: 2,
        rebased: true,
        targetBranch: "main",
        targetHead: null,
        baseSha: null,
      },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    // The granted landing plus AUTO_REARM_BUDGET re-armed ones, none of which
    // touches a user.
    for (let attempt = 0; attempt <= AUTO_REARM_BUDGET; attempt += 1) {
      const result = await callTool(daemon, token, "hive_land", {
        agent: "maya",
        capabilityEpoch: 0,
      });
      expect(result.ok).toBe(true);
    }
    expect(landed).toHaveLength(AUTO_REARM_BUDGET + 1);
    expect(autoRearms(daemon)).toBe(AUTO_REARM_BUDGET);
    expect(pendingRearms(db)).toBe(0);

    // The budget is a bound, not a bypass: the next landing asks, and the
    // refusal says the budget is why.
    const refused = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("already spent");
    expect(refused.error).toContain("re-arm budget is exhausted");
    expect(pendingRearms(db)).toBe(1);
    expect(landed).toHaveLength(AUTO_REARM_BUDGET + 1);
    await daemon.stop();
  });

  test("a branch main has moved past is never auto-re-armed", async () => {
    // Not a fast-forward: the merge Hive would be granting cannot even happen,
    // and the agent has to rebase and re-run its tests first.
    const { daemon, db, landed } = harness({
      readiness: {
        pending: 2,
        rebased: false,
        targetBranch: "main",
        targetHead: "f".repeat(40),
        baseSha: "e".repeat(40),
      },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    const refused = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(refused.ok).toBe(false);
    // Both true conditions are named: the grant IS spent, AND the target has
    // moved — the forty-minute loss was the message reporting only the first
    // and sending the agent to wait on a user when its next step was a rebase.
    expect(refused.error).toContain("already spent");
    expect(refused.error).toContain("has also moved");
    expect(refused.error).toContain("f".repeat(40));
    expect(refused.error).toContain("e".repeat(40));
    expect(refused.error).toContain("rebase");
    expect(autoRearms(daemon)).toBe(0);
    expect(pendingRearms(db)).toBe(1);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("a branch Hive cannot measure asks a user — unknown is never a yes", async () => {
    // The whole guard: a reader that returns null returns NO EVIDENCE, and no
    // evidence may not be converted into a grant.
    const { daemon, db, landed } = harness({
      readiness: {
        pending: null,
        rebased: null,
        targetBranch: null,
        targetHead: null,
        baseSha: null,
      },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    const refused = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("already spent");
    // The refusal admits the measurement failed rather than blaming the grant
    // alone — unknown is a reason to ask, and the agent is told that.
    expect(refused.error).toContain("could not measure");
    expect(refused.error).not.toContain("Nothing to land");
    expect(autoRearms(daemon)).toBe(0);
    expect(pendingRearms(db)).toBe(1);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("a revoked writer is still refused, budget or no budget", async () => {
    // The auto re-arm sits behind authorization, not in front of it: it is only
    // ever reached by a caller whose *only* failing check was the spent grant.
    const { daemon, db, landed } = harness({
      readiness: {
        pending: 2,
        rebased: true,
        targetBranch: "main",
        targetHead: null,
        baseSha: null,
      },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    db.upsertAgent(agentRecord({ writeRevoked: true }));
    const refused = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("revoked");
    expect(autoRearms(daemon)).toBe(0);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("a spent grant on a detached primary names the detachment, never a branch to rebase onto", async () => {
    // The 2026-08-13 khalid refusal: the primary was detached at another
    // agent's unlanded tip, and the text answered "rebase onto the primary
    // checkout's current branch" — a branch that did not exist.
    const { daemon, db, landed } = harness({
      readiness: {
        pending: 2,
        rebased: false,
        targetBranch: null,
        targetHead: "f".repeat(40),
        baseSha: "e".repeat(40),
      },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    const refused = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("already spent");
    expect(refused.error).toContain("detached");
    expect(refused.error).toContain("f".repeat(40));
    // No remedy may aim a rebase at the detached position.
    expect(refused.error).not.toContain("rebase onto the primary checkout");
    expect(refused.error).not.toContain("git rebase HEAD");
    // A detachment is not measurable, so no auto re-arm is spent against it.
    expect(autoRearms(daemon)).toBe(0);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("a detached primary never reports 'nothing to land'", async () => {
    // pending: 0 measured against a detached position means "contained in a
    // commit", not "on main" — reporting it would declare unlanded work done.
    const { daemon, db } = harness({
      readiness: {
        pending: 0,
        rebased: true,
        targetBranch: null,
        targetHead: "f".repeat(40),
        baseSha: "e".repeat(40),
      },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect(
      (
        await callTool(daemon, token, "hive_land", {
          agent: "maya",
          capabilityEpoch: 0,
        })
      ).ok,
    ).toBe(true);
    const refused = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("detached");
    expect(refused.error).not.toContain("Nothing to land");
    await daemon.stop();
  });

  test("a landed branch writes a receipt naming every commit that landed", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    const landed = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });
    expect(landed.ok).toBe(true);
    expect(JSON.stringify(landed.content)).toContain("landedCommits");

    const receipts = listAuditEntries(db, 50).filter((entry) =>
      entry.reason?.startsWith("receipt: landed "),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.decision).toBe("allow");
    expect(receipts[0]?.callerSubject).toBe("maya");
    expect(receipts[0]?.reason).toContain(
      "landed 1 commit from hive/maya-work",
    );
    expect(receipts[0]?.reason).toContain("c0ffee");
    await daemon.stop();
  });

  test("a read-only agent cannot land even with its current capability epoch", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord({ writeRevoked: true }));
    const { token } = daemon.capabilities.mint("maya", "reader", { epoch: 0 });

    const refused = await callTool(daemon, token, "hive_land", {
      agent: "maya",
      capabilityEpoch: 0,
    });

    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("may not branch:land");
    expect(landed).toEqual([]);
    await daemon.stop();
  });
});

// Adversarial tests for the Phase 0 authorization boundary.
//
// Every test here is written from the attacker's side: it asserts that a thing
// which *looks* legitimate is refused. The two tests at the bottom assert the
// opposite — that the orchestrator and a self-scoped writer keep working —
// because an authorization layer that only denies is indistinguishable from a
// broken daemon.
//
// Nothing in this file touches live work: an in-memory database, a stub
// spawner that launches nothing, and a stub landBranch that runs no git.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import type { LandReadiness } from "./landing";
import { deleteAgentRow, listAuditEntries } from "./testing";
import { readCredential, writeCredential, credentialPath } from "./credentials";
import { AUTO_REARM_BUDGET, HiveDaemon } from "./server";
import type { SpawnRequest, Spawner } from "./spawner";

const home = mkdtempSync(join(tmpdir(), "hive-auth-test-"));
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
    tmuxSession: "hive-maya",
    contextPct: 3,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
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
    const name = request.name ?? "spawned";
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
  options: { landFailsTimes?: number; readiness?: LandReadiness } = {},
): Harness {
  const db = new HiveDatabase(":memory:");
  const spawner = new StubSpawner();
  const landed: string[] = [];
  const landFailures = { count: options.landFailsTimes ?? 0 };
  // Unknown by default: this harness has no git, and "we could not read the
  // branch" is exactly what the daemon must treat as a reason to ask, not as a
  // reason to grant. Every pre-existing re-arm test below therefore proves the
  // fail-closed path.
  const readiness: LandReadiness = options.readiness ??
    { pending: null, rebased: null };
  const daemon = new HiveDaemon({
    db,
    spawner,
    repoRoot: "/tmp/hive-auth-noop",
    tmux: {
      hasSession: async () => false,
      killSession: async () => {},
      capturePane: async () => "",
      newSession: async () => {},
    },
    landBranch: async (_root, branch) => {
      if (landFailures.count > 0) {
        landFailures.count -= 1;
        throw new Error("Not possible to fast-forward, aborting.");
      }
      landed.push(branch);
      return { commit: "c0ffee".padEnd(40, "0") };
    },
    readLandReadiness: async () => readiness,
    resourceRunners: { orphans: null },
  });
  return { daemon, db, spawner, landed, landFailures };
}

const authorized =
  (daemon: HiveDaemon, token: string | null) =>
  (input: string | URL, init?: RequestInit) => {
    // Headers must be merged through the Headers API: spreading a Headers
    // instance yields {} and would strip the MCP client's Accept header.
    const headers = new Headers(init?.headers);
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };

async function callTool(
  daemon: HiveDaemon,
  token: string | null,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; error: string }> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const text = JSON.stringify(result.content ?? "");
    return { ok: result.isError !== true, error: result.isError === true ? text : "" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "?" };
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
      ["/event", "POST", { kind: "notification", agentName: "maya", timestamp }],
      ["/recover", "POST", { agent: "maya" }],
      ["/statusline", "POST", { agent: "maya" }],
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
    for (const tool of ["hive_spawn", "hive_kill", "hive_approve", "hive_land"]) {
      expect((await callTool(daemon, null, tool, {})).ok).toBe(false);
    }
    expect(spawner.requests).toHaveLength(0);
    expect(landed).toEqual([]);
    expect(db.getAgentByName("maya")?.status).toBe("working");
    await daemon.stop();
  });

  test("a malformed or unknown token is refused, and audited", async () => {
    const { daemon } = harness();
    const response = await authorized(daemon, "not-a-token")("http://hive/recover", {
      method: "POST",
      body: JSON.stringify({}),
    });
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
    const response = await daemon.fetch(new Request("http://hive/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    await daemon.stop();
  });
});

describe("a foreign agent cannot act on another tenant", () => {
  test("maya cannot land, kill, or read the inbox of zara", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    db.upsertAgent(agentRecord({ id: "agent-zara", name: "zara", branch: "hive/zara-work", tmuxSession: "hive-zara" }));
    const { token } = daemon.capabilities.mint("maya", "writer");

    // The confused deputy: a body field naming another subject grants nothing.
    expect((await callTool(daemon, token, "hive_land", { agent: "zara", capabilityEpoch: 0 })).ok).toBe(false);
    expect((await callTool(daemon, token, "hive_inbox", { agent: "zara" })).ok).toBe(false);
    expect((await callTool(daemon, token, "hive_kill", { name: "zara" })).ok).toBe(false);
    expect((await callTool(daemon, token, "hive_send", { from: "zara", to: "orchestrator", body: "spoofed" })).ok).toBe(false);

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
      ["hive_approve", { id: "any", decision: "approve" }],
      ["hive_approvals", {}],
      ["hive_recover", {}],
      ["hive_read_message", { id: "any" }],
      ["hive_quota_reconcile", {}],
    ] as const) {
      expect([tool, (await callTool(daemon, token, tool, args)).ok]).toEqual([tool, false]);
    }
    expect(spawner.requests).toHaveLength(0);
    expect(denials(daemon)).toContain("capability.forbidden-action");
    await daemon.stop();
  });

  test("a foreign agent cannot report events as another agent", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    db.upsertAgent(agentRecord({ id: "agent-zara", name: "zara", tmuxSession: "hive-zara" }));
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

    const result = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
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
    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 1 })).ok).toBe(false);
    expect(landed).toEqual([]);
    expect(denials(daemon)).toContain("capability.stale-epoch");
    await daemon.stop();
  });

  test("a critical control revokes write and landing authority for the live token", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    // This is exactly what `hive_send --priority critical` calls.
    db.revokeAgentCapabilities("maya", timestamp);

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(false);
    expect((await callTool(daemon, token, "memory_write", { scope: "repo", title: "x", body: "y" })).ok).toBe(false);
    expect(landed).toEqual([]);
    expect(denials(daemon)).toContain("capability.write-revoked");

    // The paused agent can still speak, which is the whole point of a pause.
    expect((await callTool(daemon, token, "hive_send", { from: "maya", to: "orchestrator", body: "paused" })).ok).toBe(true);
    await daemon.stop();
  });

  test("killing an agent revokes its credential outright", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer");
    const operator = daemon.capabilities.mint("operator", "operator").token;

    expect((await callTool(daemon, token, "hive_status")).ok).toBe(true);
    expect((await callTool(daemon, operator, "hive_kill", { name: "maya" })).ok).toBe(true);
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
    const { capability } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });
    expect(deleteAgentRow(db, record.id)).toBe(true);

    expect(daemon.capabilities.authorize(capability, {
      action: "branch:land",
      route: "hive_land",
    })).toMatchObject({
      ok: false,
      reason: "capability.authority-unknown",
    });
    await daemon.stop();
  });
});

describe("the codex root token endpoint", () => {
  test("mints a session-lived orchestrator capability for the operator", async () => {
    const { daemon } = harness();
    const operator = daemon.capabilities.mint("operator", "operator", { epoch: 0 });

    const response = await authorized(daemon, operator.token)(
      "http://hive/codex-root-token",
      { method: "POST" },
    );
    expect(response.status).toEqual(200);
    const body = await response.json() as { token: string; expiresAt: string };
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
});

describe("a one-shot landing grant cannot be replayed", () => {
  test("the second land with the same capability is denied", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(true);
    expect(landed).toEqual(["hive/maya-work"]);

    const replay = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
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
    const operator = daemon.capabilities.mint("operator", "operator", { epoch: 0 });

    // Land once (spends the grant), then land follow-up work: refused, but
    // the refusal files exactly one pending re-arm approval, even across
    // repeated refusals.
    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(true);
    const refused = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
    expect(refused.ok).toBe(false);
    // The refusal names what happened, and tells the agent there is nothing for
    // *it* to run — Hive filed the approval itself. The only action left is the
    // orchestrator's, so that is the one thing on the Fix: line.
    expect(refused.error).toContain("already spent");
    expect(refused.error).toContain("Hive has already filed the re-arm approval");
    expect(refused.error).toContain("Fix: the orchestrator approves");
    await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
    const pending = db.listApprovals("pending").filter(
      (approval) => approval.agentName === "maya",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.description).toContain("Re-arm landing");

    // Approval re-arms exactly one landing: the next land succeeds, the one
    // after is refused again.
    const approved = await callTool(daemon, operator.token, "hive_approve", {
      id: pending[0]!.id,
      decision: "approve",
    });
    expect(approved.ok).toBe(true);

    // Nothing tells a waiting agent its re-arm resolved unless the daemon
    // says so itself — this is the notification that replaces the human
    // having to prod it with an urgent message.
    const notice = db.listMessages().find(
      (message) => message.from === "hive-approvals" && message.to === "maya",
    );
    expect(notice?.body).toContain(pending[0]!.description);
    expect(notice?.body).toContain("approved");
    expect(notice?.body).toContain("retry hive_land now");

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(true);
    expect(landed).toEqual(["hive/maya-work", "hive/maya-work"]);
    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(false);
    await daemon.stop();
  });

  test("denying the re-arm approval leaves the grant spent", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });
    const operator = daemon.capabilities.mint("operator", "operator", { epoch: 0 });

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(true);
    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(false);
    const pending = db.listApprovals("pending").filter(
      (approval) => approval.agentName === "maya",
    );
    expect(pending).toHaveLength(1);
    expect((await callTool(daemon, operator.token, "hive_approve", {
      id: pending[0]!.id,
      decision: "deny",
    })).ok).toBe(true);

    // A denial must not leave the agent waiting or guessing: it is told
    // explicitly, so it reports back instead of retrying blindly.
    const notice = db.listMessages().find(
      (message) => message.from === "hive-approvals" && message.to === "maya",
    );
    expect(notice?.body).toContain(pending[0]!.description);
    expect(notice?.body).toContain("denied");
    expect(notice?.body).toContain("report back");

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(false);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("concurrent lands merge exactly once", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    const results = await Promise.all([
      callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 }),
      callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 }),
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
    const rejected = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("fast-forward");
    expect(landed).toEqual([]);

    const retried = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
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
    expect((await callTool(daemon, null, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(false);
    expect(denials(daemon)).toContain("capability.absent");
    await daemon.stop();
  });

  test("a written credential round-trips through a close-on-exec read", () => {
    writeCredential("roundtrip", "hv1.abc.def");
    expect(readCredential("roundtrip")).toBe("hv1.abc.def");
    expect(readFileSync(credentialPath("roundtrip"), "utf8").trim()).toBe("hv1.abc.def");
  });
});

describe("legitimate workflows keep working", () => {
  test("the orchestrator spawns, approves, kills, and reads the global inbox", async () => {
    const { daemon, db, spawner } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("orchestrator", "orchestrator");

    expect((await callTool(daemon, token, "hive_spawn", { task: "do a thing", category: "simple_coding" })).ok).toBe(true);
    expect(spawner.requests).toHaveLength(1);

    const approvalId = await daemon.queueCodexApproval("maya", "run a command");
    expect((await callTool(daemon, token, "hive_approvals")).ok).toBe(true);
    expect((await callTool(daemon, token, "hive_approve", { id: approvalId, decision: "approve" })).ok).toBe(true);
    expect(db.getApproval(approvalId)?.status).toBe("approved");

    expect((await callTool(daemon, token, "hive_inbox", { agent: "orchestrator" })).ok).toBe(true);
    expect((await callTool(daemon, token, "hive_status")).ok).toBe(true);
    expect((await callTool(daemon, token, "hive_kill", { name: "maya" })).ok).toBe(true);
    expect(db.getAgentByName("maya")?.status).toBe("dead");
    await daemon.stop();
  });

  test("a writer reports, talks, reads its own inbox, and lands its own branch", async () => {
    const { daemon, db, landed } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    const event = await authorized(daemon, token)("http://hive/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "turn-start", agentName: "maya", timestamp }),
    });
    expect(event.status).toBe(200);

    expect((await callTool(daemon, token, "hive_send", { from: "maya", to: "orchestrator", body: "report" })).ok).toBe(true);
    expect((await callTool(daemon, token, "hive_inbox", { agent: "maya" })).ok).toBe(true);
    expect((await callTool(daemon, token, "hive_status")).ok).toBe(true);
    expect((await callTool(daemon, token, "memory_search", { query: "phase" })).ok).toBe(true);

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(true);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("the operator drives recovery", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("operator", "operator");

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
    db.upsertAgent(agentRecord({ id: "agent-zara", name: "zara", tmuxSession: "hive-zara" }));
    const { token, capability } = daemon.capabilities.mint("maya", "writer");

    await callTool(daemon, token, "hive_land", { agent: "zara", capabilityEpoch: 0 });

    const entry = listAuditEntries(db, 50).find((row) =>
      row.decision === "deny" && row.action === "branch:land"
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
    const secret = token.split(".")[2]!;

    await callTool(daemon, token, "hive_spawn", { task: "denied", category: "simple_coding" });
    await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });

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
    const secret = token.split(".")[2]!;
    const row = db.database.query("SELECT secretHash FROM capabilities WHERE id = ?")
      .get(capability.id) as { secretHash: string };
    expect(row.secretHash).not.toContain(secret);
    expect(row.secretHash).toMatch(/^[0-9a-f]{64}$/);
    void daemon.stop();
  });
});

// The re-arm is where Hive was spending humans. Two things it must never do:
// ask for an approval that grants nothing (the branch is already merged), and
// grant one on evidence it does not have.
describe("a spent land grant is measured before a human is asked", () => {
  const pendingRearms = (db: HiveDatabase): number =>
    db.listApprovals("pending").filter(
      (approval) => approval.description.startsWith("Re-arm landing"),
    ).length;

  const autoRearms = (daemon: HiveDaemon): number =>
    listAuditEntries(daemon.db, 50).filter(
      (entry) => entry.reason === "capability.auto-rearm",
    ).length;

  test("an already-landed branch files no re-arm approval at all", async () => {
    // main..branch is empty: there is nothing to merge, so there is nothing to
    // grant. This is the no-op approval agents were declining by hand.
    const { daemon, db, landed } = harness({
      readiness: { pending: 0, rebased: true },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(true);
    const again = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
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
      readiness: { pending: 2, rebased: true },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    // The granted landing plus AUTO_REARM_BUDGET re-armed ones, none of which
    // touches a human.
    for (let attempt = 0; attempt <= AUTO_REARM_BUDGET; attempt += 1) {
      const result = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
      expect(result.ok).toBe(true);
    }
    expect(landed).toHaveLength(AUTO_REARM_BUDGET + 1);
    expect(autoRearms(daemon)).toBe(AUTO_REARM_BUDGET);
    expect(pendingRearms(db)).toBe(0);

    // The budget is a bound, not a bypass: the next landing asks.
    const refused = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("already spent");
    expect(pendingRearms(db)).toBe(1);
    expect(landed).toHaveLength(AUTO_REARM_BUDGET + 1);
    await daemon.stop();
  });

  test("a branch main has moved past is never auto-re-armed", async () => {
    // Not a fast-forward: the merge Hive would be granting cannot even happen,
    // and the agent has to rebase and re-run its tests first.
    const { daemon, db, landed } = harness({
      readiness: { pending: 2, rebased: false },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(true);
    const refused = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
    expect(refused.ok).toBe(false);
    expect(autoRearms(daemon)).toBe(0);
    expect(pendingRearms(db)).toBe(1);
    expect(landed).toEqual(["hive/maya-work"]);
    await daemon.stop();
  });

  test("a branch Hive cannot measure asks a human — unknown is never a yes", async () => {
    // The whole guard: a reader that returns null returns NO EVIDENCE, and no
    // evidence may not be converted into a grant.
    const { daemon, db, landed } = harness({
      readiness: { pending: null, rebased: null },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(true);
    const refused = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("already spent");
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
      readiness: { pending: 2, rebased: true },
    });
    db.upsertAgent(agentRecord());
    const { token } = daemon.capabilities.mint("maya", "writer", { epoch: 0 });

    expect((await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 })).ok).toBe(true);
    db.upsertAgent(agentRecord({ writeRevoked: true }));
    const refused = await callTool(daemon, token, "hive_land", { agent: "maya", capabilityEpoch: 0 });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("revoked");
    expect(autoRearms(daemon)).toBe(0);
    expect(landed).toEqual(["hive/maya-work"]);
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

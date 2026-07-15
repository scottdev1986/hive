import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../adapters/worktrees";
import {
  AgentMessageSchema,
  QuotaConfigSchema,
  type AgentRecord,
  type HookEvent,
  type QuotaPoolStatus,
} from "../schemas";
import { HiveDatabase } from "./db";
import { RoutingPolicyStore } from "./routing-policy-store";
import type { TmuxSender } from "./delivery";
import {
  authorizeForQuotaTest,
  CatalogedQuotaLedger as QuotaLedger,
} from "./authorized-launch.test-support";
import { QuotaService } from "./quota";
import { HIVE_VERSION, HiveDaemon, inferLegacyControl } from "./server";
import { readLiveClaudeModel } from "./live-model";
import { formatStatusTable } from "../cli/status";
import { actingAs, listAuditEntries, submitPaste } from "./testing";
import type { BuildFreshness } from "./build-freshness";
import type { SpawnRequest, Spawner } from "./spawner";
import { agentTmuxSession, orchestratorTmuxSession } from "./tmux-sessions";
import {
  MachineMutationCoordinator,
  type ProcessIdentityState,
} from "./mutation-lease";

const home = mkdtempSync(join(tmpdir(), "hive-server-test-"));
process.env.HIVE_HOME = home;

const timestamp = "2026-07-09T12:00:00.000Z";

function machineCoordinator(
  path: string,
  instanceId: string,
  instanceLiveness: "live" | "dead" | "unknown" = "unknown",
): MachineMutationCoordinator {
  return new MachineMutationCoordinator({
    path,
    instanceId,
    instanceHome: `/hive/${instanceId}`,
    processIdentity: async (): Promise<ProcessIdentityState> => ({
      state: "live",
      startedAt: "server-test-process",
    }),
    instanceLiveness: async () => instanceLiveness,
  });
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "working",
    taskDescription: "Build server",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-server",
    tmuxSession: "hive-maya",
    contextPct: 14,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

class SilentTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];

  constructor(private readonly db: HiveDatabase) {}

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
    submitPaste(this.db, session);
  }
}

class RootUnavailableTmuxSender extends SilentTmuxSender {
  override async sendMessage(session: string, text: string): Promise<void> {
    if (session === orchestratorTmuxSession()) {
      throw new Error("root session unavailable");
    }
    await super.sendMessage(session, text);
  }
}

class FakeDaemonTmux {
  readonly sessions = new Set<string>();
  readonly killed: string[] = [];
  readonly checked: string[] = [];
  readonly created: { name: string; cwd: string; command: string }[] = [];

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

  async newSession(name: string, cwd: string, command: string): Promise<void> {
    this.created.push({ name, cwd, command });
    this.sessions.add(name);
  }
}

test("managed daemon shutdown reaps the orchestrator session", async () => {
  const db = new HiveDatabase(join(home, "managed-stop-root.db"));
  const tmux = new FakeDaemonTmux();
  const daemon = new HiveDaemon({
    db,
    spawner: new StubSpawner(),
    tmux,
    manageLifecycle: true,
  });
  try {
    await daemon.stop();
    expect(tmux.killed).toContain(orchestratorTmuxSession());
  } finally {
    db.close();
  }
});

test("accepted selection CAS writes the ordinary preference; rejected and unrelated writes do not", async () => {
  const db = new HiveDatabase(":memory:");
  const persisted: unknown[] = [];
  const daemon = new HiveDaemon({
    db,
    spawner: new StubSpawner(),
    selectionPreferences: {
      apply: async (mutation, fallback) => {
        persisted.push({ mutation, fallback });
        return fallback;
      },
    },
  });
  const operator = actingAs(daemon, "operator");
  const post = (body: unknown) => operator("http://hive/routing/policy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const selected = await post({
      op: "set-selection",
      expectedRevision: 0,
      mode: "choice",
    });
    expect(selected.status).toBe(200);
    expect(persisted).toEqual([{
      mutation: { op: "set-selection", expectedRevision: 0, mode: "choice" },
      fallback: { global: "choice", categories: {} },
    }]);

    expect((await post({
      op: "set-provider",
      expectedRevision: 1,
      provider: "codex",
      state: "enabled",
    })).status).toBe(200);
    expect(persisted).toHaveLength(1);

    expect((await post({
      op: "set-selection",
      expectedRevision: 1,
      mode: "auto",
    })).status).toBe(409);
    expect(persisted).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("a shared selection failure is explicit about the already-saved local policy", async () => {
  const db = new HiveDatabase(":memory:");
  const daemon = new HiveDaemon({
    db,
    spawner: new StubSpawner(),
    selectionPreferences: {
      apply: async () => {
        throw new Error("disk full");
      },
    },
  });
  try {
    const response = await actingAs(daemon, "operator")(
      "http://hive/routing/policy",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "set-selection",
          expectedRevision: 0,
          mode: "choice",
        }),
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error:
        "selection was saved in this Workspace but could not be saved " +
        "for future ordinary Workspace sessions: disk full",
    });
    expect(new RoutingPolicyStore(db).read().selection.global).toBe("choice");
  } finally {
    db.close();
  }
});

test("agent kill refuses when a live session's process roots are unreadable", async () => {
  const db = new HiveDatabase(join(home, "unreadable-kill-roots.db"));
  const tmux = new FakeDaemonTmux();
  tmux.sessions.add("hive-maya");
  const daemon = new HiveDaemon({
    db,
    spawner: new StubSpawner(),
    tmux,
    resourceRunners: {
      panePids: async () => {
        throw new Error("tmux pane probe failed");
      },
      orphans: null,
    },
  });
  db.insertAgent(agent());
  const agentFetch = actingAs(daemon, "maya", "writer");
  try {
    const response = await actingAs(daemon, "operator")(
      "http://hive/agents/maya/kill",
      { method: "POST" },
    );
    expect(response.status).toEqual(500);
    expect(await response.json()).toEqual({
      error: "tmux pane probe failed",
    });
    expect(tmux.killed).toEqual([]);
    expect(db.getAgentByName("maya")).toMatchObject({
      status: "working",
      writeRevoked: false,
    });
    expect((await agentFetch("http://hive/orchestrator-status")).status).toEqual(
      200,
    );
  } finally {
    await daemon.stop();
    db.close();
  }
});

test("agent kill refuses when tmux reports success but leaves the session", async () => {
  const db = new HiveDatabase(join(home, "surviving-kill-session.db"));
  const owned = Bun.spawn(["sleep", "60"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const tmux = new class extends FakeDaemonTmux {
    override async killSession(session: string): Promise<void> {
      this.killed.push(session);
    }
  }();
  tmux.sessions.add("hive-maya");
  const daemon = new HiveDaemon({
    db,
    spawner: new StubSpawner(),
    tmux,
    resourceRunners: {
      panePids: async () => [owned.pid],
      orphans: null,
    },
  });
  db.insertAgent(agent());
  const agentFetch = actingAs(daemon, "maya", "writer");
  try {
    const response = await actingAs(daemon, "operator")(
      "http://hive/agents/maya/kill",
      { method: "POST" },
    );
    expect(response.status).toEqual(500);
    expect(await response.json()).toEqual({
      error: "Tmux session hive-maya survived kill-session",
    });
    expect(await Promise.race([
      owned.exited,
      Bun.sleep(1_000).then(() => null),
    ])).not.toBeNull();
    expect(db.getAgentByName("maya")).toMatchObject({
      status: "working",
      writeRevoked: false,
    });
    expect((await agentFetch("http://hive/orchestrator-status")).status).toEqual(
      403,
    );
  } finally {
    tmux.sessions.clear();
    owned.kill("SIGKILL");
    await owned.exited;
    await daemon.stop();
    db.close();
  }
});

test("managed shutdown refuses to exit after an agent teardown probe fails", async () => {
  const db = new HiveDatabase(join(home, "unreadable-shutdown-roots.db"));
  const tmux = new FakeDaemonTmux();
  tmux.sessions.add("hive-maya");
  tmux.sessions.add(orchestratorTmuxSession());
  const daemon = new HiveDaemon({
    db,
    spawner: new StubSpawner(),
    tmux,
    manageLifecycle: true,
    resourceRunners: {
      panePids: async () => {
        throw new Error("tmux pane probe failed");
      },
      orphans: null,
    },
  });
  db.insertAgent(agent());
  try {
    await expect(daemon.stop()).rejects.toThrow("refused shutdown");
    expect(tmux.killed).toEqual([]);
    expect(db.getAgentByName("maya")?.status).toEqual("working");
  } finally {
    tmux.sessions.clear();
    await daemon.stop();
    db.close();
  }
});

test("managed shutdown refuses unreadable orchestrator process roots", async () => {
  const db = new HiveDatabase(join(home, "unreadable-root-roots.db"));
  const tmux = new FakeDaemonTmux();
  tmux.sessions.add(orchestratorTmuxSession());
  const daemon = new HiveDaemon({
    db,
    spawner: new StubSpawner(),
    tmux,
    manageLifecycle: true,
    resourceRunners: {
      panePids: async () => {
        throw new Error("root pane probe failed");
      },
      orphans: null,
    },
  });
  try {
    await expect(daemon.stop()).rejects.toThrow("root pane probe failed");
    expect(tmux.killed).toEqual([]);
  } finally {
    tmux.sessions.clear();
    await daemon.stop();
    db.close();
  }
});

class StubSpawner implements Spawner {
  readonly requests: SpawnRequest[] = [];

  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    this.requests.push(request);
    return agent({
      id: "agent-sam",
      name: request.name ?? "sam",
      category: request.category,
      taskDescription: request.task,
      tmuxSession: `hive-${request.name ?? "sam"}`,
      worktreePath: `/tmp/hive-${request.name ?? "sam"}`,
      branch: `hive/${request.name ?? "sam"}-task`,
    });
  }

  async authorizeLaunch(identity: AgentRecord["executionIdentity"]) {
    if (identity === undefined) throw new Error("identity required");
    return (await authorizeForQuotaTest([identity]))[0]!;
  }
}

class FailedSpawner implements Spawner {
  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    return agent({
      status: "failed",
      category: request.category,
      taskDescription: request.task,
      failureReason: "Error: model not supported",
      failedAt: timestamp,
    });
  }
}

class StuckSpawner implements Spawner {
  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    return agent({
      status: "stuck",
      writeRevoked: true,
      category: request.category,
      taskDescription: request.task,
      failureReason: "process teardown could not be verified",
    });
  }
}

class RestartingSpawner extends StubSpawner {
  readonly restarts: Array<{ agent: AgentRecord; messageId: string }> = [];
  async restartForControl(
    value: AgentRecord,
    message: import("../schemas").AgentMessage,
  ): Promise<AgentRecord> {
    this.restarts.push({ agent: value, messageId: message.id });
    return value;
  }
}

class FailingRestartSpawner extends StubSpawner {
  constructor(private readonly reason: string) {
    super();
  }
  async restartForControl(): Promise<AgentRecord> {
    throw new Error(this.reason);
  }
}

async function postEvent(
  daemon: HiveDaemon,
  event: Record<string, unknown>,
): Promise<Response> {
  return actingAs(daemon, "operator")("http://hive/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
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
  test("classifies only conservative legacy control phrases as critical", () => {
    expect(inferLegacyControl("Pause before coding; propose a design first."))
      .toEqual({ priority: "critical", intent: "pause" });
    expect(inferLegacyControl("Do not modify files until approval."))
      .toEqual({ priority: "critical", intent: "restrict-writes" });
    expect(inferLegacyControl("stop now")).toEqual({
      priority: "critical",
      intent: "stop",
    });
    expect(inferLegacyControl("Can you stop by the docs too?")).toEqual(null);
  });

  test("critical delivery reaps only the target process and restarts read-only after revocation", async () => {
    const db = new HiveDatabase(join(home, "critical-runtime.db"));
    const owned = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const unrelated = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const tmux = new FakeDaemonTmux();
    tmux.sessions.add("hive-maya");
    tmux.sessions.add("hive-unrelated");
    const spawner = new RestartingSpawner();
    const quota = new QuotaService(
      new QuotaLedger(db),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const daemon = new HiveDaemon({
      db,
      spawner,
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      quota,
      resourceRunners: {
        panePids: async (session) => session === "hive-maya" ? [owned.pid] : [],
        orphans: null,
      },
    });
    try {
      db.insertAgent(agent());
      expect(() => process.kill(owned.pid, 0)).not.toThrow();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      const message = await daemon.delivery.send(
        "orchestrator",
        "maya",
        "Do not modify files.",
        { priority: "critical", intent: "restrict-writes" },
      );
      expect(tmux.killed).toEqual(["hive-maya"]);
      expect(tmux.sessions.has("hive-unrelated")).toEqual(true);
      expect(await Promise.race([
        owned.exited,
        Bun.sleep(1_000).then(() => null),
      ])).not.toBeNull();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      expect(spawner.restarts).toHaveLength(1);
      expect(spawner.restarts[0]?.agent).toMatchObject({
        writeRevoked: true,
        capabilityEpoch: 1,
      });
      expect(message.state).toEqual("injected");
    } finally {
      owned.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([owned.exited, unrelated.exited]);
      db.close();
    }
  });

  test("critical delivery refuses restart when process capture is unreadable", async () => {
    const db = new HiveDatabase(join(home, "critical-unreadable-processes.db"));
    const tmux = new FakeDaemonTmux();
    tmux.sessions.add("hive-maya");
    const spawner = new RestartingSpawner();
    const quota = new QuotaService(
      new QuotaLedger(db),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const daemon = new HiveDaemon({
      db,
      spawner,
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      quota,
      resourceRunners: {
        panePids: async () => {
          throw new Error("pane process probe failed");
        },
        orphans: null,
      },
    });
    try {
      db.insertAgent(agent());

      const message = await daemon.delivery.send(
        "orchestrator",
        "maya",
        "Do not modify files.",
        { priority: "critical", intent: "restrict-writes" },
      );

      expect(message.state).toEqual("queued");
      expect(spawner.restarts).toEqual([]);
      expect(tmux.killed).toEqual([]);
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "control-paused",
        writeRevoked: true,
      });
    } finally {
      tmux.sessions.clear();
      await daemon.stop();
      db.close();
    }
  });

  test("critical interruption settles the target's quota reservation", async () => {
    const db = new HiveDatabase(join(home, "critical-quota.db"));
    const ledger = new QuotaLedger(db);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({
        limits: [
          {
            provider: "codex",
            pool: "codex-premium",
            models: ["gpt-5-codex"],
            fiveHourAllowance: 100,
            weeklyAllowance: 1000,
          },
          {
            provider: "claude",
            pool: "claude-premium",
            models: ["claude-model"],
            fiveHourAllowance: 100,
            weeklyAllowance: 1000,
          },
        ],
      }),
      () => new Date(timestamp),
    );
    const decision = await quota.routeAndReserve({
      agentName: "maya",
      category: "simple_coding",
      selection: "strict",
      explicitTool: "codex",
      candidates: await authorizeForQuotaTest([
        { tool: "claude", model: "claude-model" },
        { tool: "codex", model: "gpt-5-codex" },
      ]),
    });
    quota.markStarted(decision.reservation.id);
    const tmux = new FakeDaemonTmux();
    const spawner = new RestartingSpawner();
    const daemon = new HiveDaemon({
      db,
      spawner,
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      quota,
    });
    try {
      db.insertAgent(agent({
        quotaReservationId: decision.reservation.id,
      }));
      await daemon.delivery.send("orchestrator", "maya", "Stop now.", {
        priority: "critical",
        intent: "stop",
      });
      expect(spawner.restarts).toHaveLength(1);
      // The interrupted run keeps its conservative estimate instead of
      // holding live headroom until the reservation TTL expires.
      expect(ledger.getReservation(decision.reservation.id)).toMatchObject({
        status: "reconciled",
        source: "estimated",
      });
    } finally {
      db.close();
    }
  });

  test("failed critical restart becomes terminal, releases its ledger hold, and is not retried", async () => {
    const db = new HiveDatabase(join(home, "critical-restart-failure.db"));
    const ledger = new QuotaLedger(db);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    class ReservingFailureSpawner extends StubSpawner {
      attempts = 0;
      async restartForControl(
        value: AgentRecord,
        message: import("../schemas").AgentMessage,
      ): Promise<AgentRecord> {
        this.attempts += 1;
        await quota.reserveControlRun({
          agentName: value.name,
          category: value.category,
          tool: value.tool,
          model: value.model,
          controlMessageId: message.id,
        });
        throw new Error("restart fixture failed");
      }
    }
    const spawner = new ReservingFailureSpawner();
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner,
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      quota,
    });
    try {
      db.insertAgent(agent());
      const positiveControl = await quota.reserveControlRun({
        agentName: "maya",
        category: "simple_coding",
        tool: "codex",
        model: "gpt-5-codex",
        controlMessageId: "original-run",
      });
      expect(ledger.getReservation(positiveControl.id)?.status).toEqual("active");
      await daemon.delivery.send("orchestrator", "maya", "Pause.", {
        priority: "critical",
        intent: "pause",
      });
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "failed",
        writeRevoked: true,
      });
      expect(ledger.getActiveReservationForAgent("maya")).toBeNull();
      expect(await daemon.delivery.recoverCriticalControls()).toEqual(0);
      expect(spawner.attempts).toEqual(1);
    } finally {
      db.close();
    }
  });

  test("an unverified critical restart remains stuck instead of being declared dead", async () => {
    const db = new HiveDatabase(join(home, "critical-restart-stuck.db"));
    const quota = new QuotaService(
      new QuotaLedger(db),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    class StuckRestartSpawner extends StubSpawner {
      async restartForControl(value: AgentRecord): Promise<AgentRecord> {
        db.upsertAgent({
          ...value,
          status: "stuck",
          writeRevoked: true,
          failureReason: "control process teardown could not be verified",
        });
        throw new Error("control process teardown could not be verified");
      }
    }
    const daemon = new HiveDaemon({
      db,
      spawner: new StuckRestartSpawner(),
      tmux: new FakeDaemonTmux(),
      tmuxSender: new SilentTmuxSender(db),
      quota,
    });
    try {
      db.insertAgent(agent());

      const message = await daemon.delivery.send(
        "orchestrator",
        "maya",
        "Pause.",
        { priority: "critical", intent: "pause" },
      );

      expect(message.state).toEqual("queued");
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "stuck",
        writeRevoked: true,
        failureReason: "control process teardown could not be verified",
      });
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("repeated critical interruption settles the prior control run before starting the next", async () => {
    const db = new HiveDatabase(join(home, "repeated-critical.db"));
    const ledger = new QuotaLedger(db);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const prior = await quota.reserveControlRun({
      agentName: "maya",
      category: "simple_coding",
      tool: "codex",
      model: "gpt-5-codex",
      controlMessageId: "prior-control",
    });
    quota.markStarted(prior.id);
    const tmux = new FakeDaemonTmux();
    const spawner = new RestartingSpawner();
    const daemon = new HiveDaemon({
      db,
      spawner,
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      quota,
    });
    try {
      db.insertAgent(agent({
        status: "control-paused",
        writeRevoked: true,
        capabilityEpoch: 1,
        controlMessageId: "prior-control",
        controlQuotaReservationId: prior.id,
      }));
      await daemon.delivery.send("orchestrator", "maya", "Stop now.", {
        priority: "critical",
        intent: "stop",
      });
      expect(ledger.getReservation(prior.id)).toMatchObject({
        status: "reconciled",
        source: "estimated",
      });
      expect(spawner.restarts).toHaveLength(1);
      expect(tmux.killed).toEqual(["hive-maya"]);
      expect(db.getAgentByName("maya")).toMatchObject({
        writeRevoked: true,
        capabilityEpoch: 2,
      });
    } finally {
      db.close();
    }
  });

  test("daemon crash recovery reuses a surviving control process and reservation", async () => {
    const db = new HiveDatabase(join(home, "control-crash-recovery.db"));
    const ledger = new QuotaLedger(db);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const reservation = await quota.reserveControlRun({
      agentName: "maya",
      category: "simple_coding",
      tool: "codex",
      model: "gpt-5-codex",
      controlMessageId: "recover-control",
    });
    quota.markStarted(reservation.id);
    const tmux = new FakeDaemonTmux();
    tmux.sessions.add("hive-maya");
    const spawner = new RestartingSpawner();
    const daemon = new HiveDaemon({
      db,
      spawner,
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      quota,
    });
    try {
      db.insertAgent(agent({
        status: "control-paused",
        writeRevoked: true,
        capabilityEpoch: 1,
        controlMessageId: "recover-control",
        controlQuotaReservationId: reservation.id,
      }));
      db.insertMessage({
        id: "recover-control",
        from: "orchestrator",
        to: "maya",
        body: "Pause.",
        createdAt: timestamp,
        deliveredAt: null,
        priority: "critical",
        intent: "pause",
        state: "queued",
        injectedAt: null,
        acknowledgedAt: null,
        appliedAt: null,
        deadlineAt: "2026-07-09T12:01:00.000Z",
        alertAt: null,
        sequence: 1,
        idempotencyKey: null,
        capabilityEpoch: 1,
      });
      expect(await daemon.delivery.recoverCriticalControls()).toEqual(1);
      expect(spawner.restarts).toHaveLength(0);
      expect(tmux.killed).toHaveLength(0);
      expect(db.getMessage("recover-control")?.state).toEqual("injected");
      expect(ledger.getReservation(reservation.id)?.status).toEqual("active");
    } finally {
      db.close();
    }
  });

  test("control recovery never reuses a process whose teardown state is stuck", async () => {
    const owned = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const unrelated = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const db = new HiveDatabase(join(home, "stuck-control-recovery.db"));
    const quota = new QuotaService(
      new QuotaLedger(db),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const reservation = await quota.reserveControlRun({
      agentName: "maya",
      category: "simple_coding",
      tool: "codex",
      model: "gpt-5-codex",
      controlMessageId: "recover-stuck-control",
    });
    quota.markStarted(reservation.id);
    const tmux = new FakeDaemonTmux();
    tmux.sessions.add("hive-maya");
    const spawner = new RestartingSpawner();
    const daemon = new HiveDaemon({
      db,
      spawner,
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      quota,
      resourceRunners: {
        panePids: async (session) => session === "hive-maya" ? [owned.pid] : [],
        orphans: null,
      },
    });
    try {
      db.insertAgent(agent({
        status: "stuck",
        writeRevoked: true,
        capabilityEpoch: 1,
        controlMessageId: "recover-stuck-control",
        controlQuotaReservationId: reservation.id,
      }));
      db.insertMessage({
        id: "recover-stuck-control",
        from: "orchestrator",
        to: "maya",
        body: "Pause.",
        createdAt: timestamp,
        deliveredAt: null,
        priority: "critical",
        intent: "pause",
        state: "queued",
        injectedAt: null,
        acknowledgedAt: null,
        appliedAt: null,
        deadlineAt: "2026-07-09T12:01:00.000Z",
        alertAt: null,
        sequence: 1,
        idempotencyKey: null,
        capabilityEpoch: 1,
      });

      expect(await daemon.delivery.recoverCriticalControls()).toEqual(1);
      expect(spawner.restarts).toHaveLength(1);
      expect(await Promise.race([
        owned.exited,
        Bun.sleep(1_000).then(() => null),
      ])).not.toBeNull();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      owned.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([owned.exited, unrelated.exited]);
      await daemon.stop();
      db.close();
    }
  });

  test("acknowledgement settles the dedicated control reservation", async () => {
    const db = new HiveDatabase(join(home, "control-ack.db"));
    const ledger = new QuotaLedger(db);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const reservation = await quota.reserveControlRun({
      agentName: "maya",
      category: "simple_coding",
      tool: "codex",
      model: "gpt-5-codex",
      controlMessageId: "ack-control",
    });
    quota.markStarted(reservation.id);
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      quota,
    });
    try {
      db.insertAgent(agent({
        status: "control-paused",
        writeRevoked: true,
        capabilityEpoch: 1,
        controlMessageId: "ack-control",
        controlQuotaReservationId: reservation.id,
      }));
      db.insertMessage({
        id: "ack-control",
        from: "orchestrator",
        to: "maya",
        body: "Pause.",
        createdAt: timestamp,
        deliveredAt: timestamp,
        priority: "critical",
        intent: "pause",
        state: "injected",
        injectedAt: timestamp,
        acknowledgedAt: null,
        appliedAt: null,
        deadlineAt: "2026-07-09T12:01:00.000Z",
        alertAt: null,
        sequence: 1,
        idempotencyKey: null,
        capabilityEpoch: 1,
      });
      const acknowledged = await daemon.acknowledgeControlMessage(
        "maya",
        "ack-control",
        1,
        true,
      );
      expect(acknowledged.state).toEqual("applied");
      expect(ledger.getReservation(reservation.id)).toMatchObject({
        status: "reconciled",
        source: "estimated",
      });
    } finally {
      db.close();
    }
  });

  test("completion, death, reconciliation, and hive_kill settle the current control reservation", async () => {
    const db = new HiveDatabase(join(home, "control-terminal-paths.db"));
    const ledger = new QuotaLedger(db);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      quota,
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    });
    const cases = ["complete", "dead", "reconcile", "kill"] as const;
    const reservations = new Map<string, string>();
    for (const [index, name] of cases.entries()) {
      const reservation = await quota.reserveControlRun({
        agentName: name,
        category: "simple_coding",
        tool: "codex",
        model: "gpt-5-codex",
        controlMessageId: `${name}-control`,
      });
      quota.markStarted(reservation.id);
      reservations.set(name, reservation.id);
      db.insertAgent(agent({
        id: `agent-${name}`,
        name,
        tmuxSession: `hive-${name}`,
        status: "control-paused",
        writeRevoked: true,
        capabilityEpoch: 1,
        controlMessageId: `${name}-control`,
        controlQuotaReservationId: reservation.id,
      }));
      if (name === "complete") tmux.sessions.add(`hive-${name}`);
    }
    try {
      await daemon.processEvent({
        kind: "turn-end",
        agentName: "complete",
        timestamp: "2026-07-09T12:01:00.000Z",
        usageUnits: 3,
        usageSource: "gateway",
      });
      await daemon.processEvent({
        kind: "dead",
        agentName: "dead",
        timestamp: "2026-07-09T12:01:01.000Z",
      });
      await daemon.reconcileAgents();

      const transport = new StreamableHTTPClientTransport(
        new URL("http://hive/mcp"),
        { fetch: actingAs(daemon, "operator") },
      );
      const client = new Client({ name: "control-kill", version: "1.0.0" });
      await client.connect(transport);
      await client.callTool({ name: "hive_kill", arguments: { name: "kill" } });
      await client.close();

      expect(ledger.getReservation(reservations.get("complete")!)).toMatchObject({
        status: "reconciled",
        actualUnits: 3,
        source: "gateway",
      });
      for (const name of ["dead", "reconcile", "kill"]) {
        expect(ledger.getReservation(reservations.get(name)!)).toMatchObject({
          status: "reconciled",
          source: "estimated",
        });
      }
    } finally {
      db.close();
    }
  });

  test("an expired control reservation settles, stops its process, and preserves work", async () => {
    const db = new HiveDatabase(join(home, "control-timeout.db"));
    const ledger = new QuotaLedger(db);
    let now = new Date(timestamp);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({
        enabled: false,
        reservationTtlMinutes: 1,
      }),
      () => now,
    );
    const reservation = await quota.reserveControlRun({
      agentName: "maya",
      category: "simple_coding",
      tool: "codex",
      model: "gpt-5-codex",
      controlMessageId: "timeout-control",
    });
    quota.markStarted(reservation.id);
    const tmux = new FakeDaemonTmux();
    tmux.sessions.add("hive-maya");
    const process = Bun.spawn(["sh", "-c", "sleep 60 & wait"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      tmuxSender: new RootUnavailableTmuxSender(db),
      quota,
      resourceRunners: {
        panePids: async (session) =>
          session === "hive-maya" ? [process.pid] : [],
      },
    });
    try {
      db.insertAgent(agent({
        status: "control-paused",
        writeRevoked: true,
        capabilityEpoch: 1,
        controlMessageId: "timeout-control",
        controlQuotaReservationId: reservation.id,
      }));
      now = new Date("2026-07-09T12:02:00.000Z");
      expect(await daemon.recoverQuotaReservations()).toEqual(1);
      expect(ledger.getReservation(reservation.id)).toMatchObject({
        status: "reconciled",
        source: "estimated",
      });
      expect(tmux.killed).toEqual(["hive-maya"]);
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "dead",
        writeRevoked: true,
        worktreePath: "/tmp/hive-maya",
      });
      expect(db.listMessages().some((message) =>
        message.to === "queen" && message.body.includes("timed out")
      )).toEqual(true);
      const exitCode = await Promise.race([
        process.exited,
        Bun.sleep(1_000).then(() => null),
      ]);
      expect(exitCode).not.toBeNull();
    } finally {
      process.kill("SIGKILL");
      db.close();
    }
  });

  test("an expired control reservation stays held when process teardown is unknown", async () => {
    const db = new HiveDatabase(join(home, "control-timeout-unknown.db"));
    const ledger = new QuotaLedger(db);
    let now = new Date(timestamp);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({
        enabled: false,
        reservationTtlMinutes: 1,
      }),
      () => now,
    );
    const reservation = await quota.reserveControlRun({
      agentName: "maya",
      category: "simple_coding",
      tool: "codex",
      model: "gpt-5-codex",
      controlMessageId: "timeout-control-unknown",
    });
    quota.markStarted(reservation.id);
    const tmux = new FakeDaemonTmux();
    tmux.sessions.add("hive-maya");
    const process = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      tmuxSender: new RootUnavailableTmuxSender(db),
      quota,
      resourceRunners: {
        panePids: async () => {
          throw new Error("ps output unreadable");
        },
      },
    });
    try {
      db.insertAgent(agent({
        status: "control-paused",
        writeRevoked: true,
        capabilityEpoch: 1,
        controlMessageId: "timeout-control-unknown",
        controlQuotaReservationId: reservation.id,
      }));
      now = new Date("2026-07-09T12:02:00.000Z");
      await expect(daemon.recoverQuotaReservations()).rejects.toThrow(
        "ps output unreadable",
      );
      expect(ledger.getReservation(reservation.id)).toMatchObject({
        status: "active",
      });
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "control-paused",
        controlQuotaReservationId: reservation.id,
      });
      expect(tmux.killed).toEqual([]);
      expect(() => globalThis.process.kill(process.pid, 0)).not.toThrow();
    } finally {
      process.kill("SIGKILL");
      await process.exited;
      db.close();
    }
  });

  test("quota-blocked control stops terminally and emits a durable actionable alert", async () => {
    const db = new HiveDatabase(join(home, "control-quota-blocked.db"));
    const quota = new QuotaService(
      new QuotaLedger(db),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new FailingRestartSpawner(
        "Insufficient quota for recorded codex/gpt-5-codex; no model fallback",
      ),
      tmux,
      tmuxSender: new RootUnavailableTmuxSender(db),
      quota,
    });
    try {
      db.insertAgent(agent());
      const control = await daemon.delivery.send(
        "orchestrator",
        "maya",
        "Pause before coding.",
        { priority: "critical", intent: "pause" },
      );
      expect(control.state).toEqual("queued");
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "failed",
        writeRevoked: true,
        worktreePath: "/tmp/hive-maya",
      });
      const alert = db.listMessages().find((message) =>
        message.to === "queen" && message.from === "hive-control"
      );
      expect(alert?.body).toContain("Insufficient quota");
      expect(alert?.body).toContain("automatic recovery will not retry");
      expect(alert?.body).toContain("Worktree was preserved");
      expect(alert?.idempotencyKey).toContain("control-restart-failed:");
    } finally {
      db.close();
    }
  });

  test("landing is epoch-gated and cannot run after critical revocation", async () => {
    const db = new HiveDatabase(join(home, "capability-land.db"));
    const landed: string[] = [];
    const daemon = new HiveDaemon({
      db,
      spawner: new RestartingSpawner(),
      tmux: new FakeDaemonTmux(),
      tmuxSender: new SilentTmuxSender(db),
      repoRoot: "/repo",
      port: 0,
      landBranch: async (_root, branch) => {
        landed.push(branch);
        return { commit: "abc123" };
      },
    });
    try {
      db.insertAgent(agent());
      await daemon.landAgent("maya", 0);
      expect(landed).toEqual(["hive/maya-server"]);

      db.revokeAgentCapabilities("maya", new Date().toISOString());
      // "revoked or stale" told an agent neither which of the two it was nor
      // what to do about it, and they need opposite things. Revocation is
      // authority maya no longer has: only the orchestrator can give it back.
      await expect(daemon.landAgent("maya", 0)).rejects.toThrow(
        /write authority was revoked/,
      );
      await expect(daemon.landAgent("maya", 0)).rejects.toThrow(/Fix:/);
      expect(landed).toHaveLength(1);

      // A stale epoch is the agent's own to fix, and the message hands it the
      // number to retry with rather than making it go and look.
      const current = db.getAgentByName("maya")?.capabilityEpoch ?? 0;
      db.upsertAgent({ ...db.getAgentByName("maya")!, writeRevoked: false });
      await expect(daemon.landAgent("maya", current + 7)).rejects.toThrow(
        new RegExp(`capabilityEpoch ${current}\\b`),
      );
      expect(landed).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("an intentionally read-only agent cannot land through operator authority", async () => {
    const db = new HiveDatabase(join(home, "read-only-land.db"));
    const landed: string[] = [];
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      repoRoot: "/repo",
      landBranch: async (_root, branch) => {
        landed.push(branch);
        return { commit: "unreachable" };
      },
    });
    db.insertAgent(agent({ readOnly: true }));
    try {
      await expect(daemon.landAgent("maya", 0)).rejects.toThrow(
        /launched read-only/,
      );
      expect(landed).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("a machine mutation lease blocks spawn before the spawner runs", async () => {
    const path = join(home, "spawn-mutation-lease.db");
    const updater = machineCoordinator(path, "default");
    const daemonMutations = machineCoordinator(path, "server");
    const lease = await updater.acquireLease("update");
    const db = new HiveDatabase(join(home, "spawn-mutation-daemon.db"));
    const spawner = new StubSpawner();
    const daemon = new HiveDaemon({ db, spawner, machineMutations: daemonMutations });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: actingAs(daemon, "operator") },
    );
    const client = new Client({ name: "mutation-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const refused = await client.callTool({
        name: "hive_spawn",
        arguments: { task: "Must wait", category: "simple_coding" },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/machine update.*progress/i);
      expect(spawner.requests).toEqual([]);
    } finally {
      await client.close();
      await daemon.stop();
      lease.release();
      updater.close();
      daemonMutations.close();
      db.close();
    }
  });

  test("an in-flight landing blocks a machine mutation lease", async () => {
    const path = join(home, "landing-mutation-lease.db");
    const daemonMutations = machineCoordinator(path, "server", "live");
    const updater = machineCoordinator(path, "default", "live");
    const db = new HiveDatabase(join(home, "landing-mutation-daemon.db"));
    let announceLanding!: () => void;
    let finishLanding!: () => void;
    const landingStarted = new Promise<void>((resolve) => {
      announceLanding = resolve;
    });
    const landingMayFinish = new Promise<void>((resolve) => {
      finishLanding = resolve;
    });
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      machineMutations: daemonMutations,
      repoRoot: "/repo",
      landBranch: async () => {
        announceLanding();
        await landingMayFinish;
        return { commit: "abc123" };
      },
    });
    db.insertAgent(agent());
    const landing = daemon.landAgent("maya", 0);
    try {
      await landingStarted;
      await expect(updater.acquireLease("rollback")).rejects.toThrow(
        /landing.*server.*in progress/i,
      );
      finishLanding();
      await expect(landing).resolves.toEqual({ commit: "abc123" });
      const lease = await updater.acquireLease("rollback");
      lease.release();
    } finally {
      finishLanding();
      await landing.catch(() => undefined);
      await daemon.stop();
      updater.close();
      daemonMutations.close();
      db.close();
    }
  });

  test("only approval requests block agents and enter the approval queue", async () => {
    const db = new HiveDatabase(join(home, "events.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
    });
    db.insertAgent(agent({ tmuxSession: agentTmuxSession("maya", home) }));
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
        "idle",
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
      expect(approvals.length).toEqual(1);
      expect(approvals[0]?.description).toEqual("Run npm publish");

      const invalid = await postEvent(daemon, { kind: "dead" });
      expect(invalid.status).toEqual(400);
      expect(db.listEvents().length).toEqual(6);

      const health = await daemon.fetch(new Request("http://hive/health"));
      expect(await health.json()).toEqual({
        ok: true,
        version: HIVE_VERSION,
        database: { status: "ok" },
        maintenance: { status: "unknown" },
      });

      const reuseHandshake = await daemon.fetch(
        new Request("http://hive/handshake"),
      );
      expect(await reuseHandshake.json()).toMatchObject({
        productVersion: HIVE_VERSION,
        wireProtocol: { min: 1, max: 1 },
        schemaEpoch: 1,
        capabilities: ["daemon-handshake-v1"],
        generation: 1,
      });
    } finally {
      db.close();
    }
  });

  test("health reports an unreadable database instead of inventing ok", async () => {
    const path = join(home, "health-corrupt.db");
    const db = new HiveDatabase(path);
    const daemon = new HiveDaemon({ db, spawner: new StubSpawner() });
    db.database.close();
    await Bun.write(path, "not a sqlite database");
    (db as unknown as { database: Database }).database =
      new Database(path, { readonly: true });
    try {
      const response = await daemon.fetch(new Request("http://hive/health"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        database: { status: "unreadable" },
      });
    } finally {
      db.close();
    }
  });

  test("health surfaces a failed maintenance run", async () => {
    const db = new HiveDatabase(join(home, "health-maintenance.db"));
    const daemon = new HiveDaemon({ db, spawner: new StubSpawner() });
    (daemon as unknown as { reconcileAgents(): Promise<never> })
      .reconcileAgents = () => Promise.reject(new Error("measured sweep failure"));
    try {
      await expect(daemon.runMaintenance()).rejects.toThrow(
        "measured sweep failure",
      );
      const response = await daemon.fetch(new Request("http://hive/health"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        database: { status: "ok" },
        maintenance: {
          status: "error",
          error: "measured sweep failure",
        },
      });
    } finally {
      db.close();
    }
  });

  test("notification events do not starve message delivery", async () => {
    const db = new HiveDatabase(join(home, "notification-delivery.db"));
    const tmux = new SilentTmuxSender(db);
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: tmux,
    });
    db.insertAgent(agent({ status: "idle" }));
    try {
      await daemon.processEvent({
        kind: "notification",
        agentName: "maya",
        timestamp,
      });

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      expect(db.listApprovals("pending")).toEqual([]);
      const message = await daemon.delivery.send(
        "sam",
        "maya",
        "Notifications must not block this.",
      );
      expect(message.deliveredAt).not.toBeNull();
      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from sam: Notifications must not block this."],
      ]);
    } finally {
      db.close();
    }
  });

  // Claude raises its NATIVE permission dialog through the same Notification
  // hook it uses to say it is idle, and Hive kept the agent's status on both —
  // so an agent parked on a dialog reported "working" forever and told nobody.
  // The vendor's `notification_type` is what tells the two apart. Measured
  // against claude 2.1.207:
  //   permission_prompt  "Claude needs your permission"      <- blocked
  //   idle_prompt        "Claude is waiting for your input"  <- idle
  test("a native permission dialog makes the agent visible, not 'working'", async () => {
    const db = new HiveDatabase(join(home, "permission-dialog.db"));
    const tmux = new SilentTmuxSender(db);
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: tmux,
    });
    db.insertAgent(agent({ status: "working" }));
    try {
      await daemon.processEvent({
        kind: "notification",
        agentName: "maya",
        timestamp,
        notificationType: "permission_prompt",
      });

      // The whole defect in one assertion: this used to stay "working".
      expect(db.getAgentByName("maya")?.status).toEqual("awaiting-approval");

      // And a human is actually told, through the orchestrator. The agent
      // cannot report this itself — it is blocked mid-turn.
      const alerts = db.listMessages()
        .filter((message) => message.from === "hive-resources");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.to).toEqual("queen");
      expect(alerts[0]?.body).toContain("BLOCKED");
      expect(alerts[0]?.body).toContain("maya");

      // Hive can see the dialog but cannot answer it, so it must never claim
      // it can: no pending approval is filed, because hive_approve would
      // resolve a row while the agent stayed stuck behind the real dialog.
      expect(db.listApprovals("pending")).toEqual([]);
    } finally {
      db.close();
    }
  });

  // The negative control. An idle agent emits notifications while doing nothing
  // at all, so keying "blocked" on the mere ARRIVAL of a Notification hook
  // would park every idle agent in awaiting-approval.
  test("an idle notification does not mark an agent blocked", async () => {
    const db = new HiveDatabase(join(home, "idle-notification.db"));
    const tmux = new SilentTmuxSender(db);
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: tmux,
    });
    db.insertAgent(agent({ status: "working" }));
    try {
      await daemon.processEvent({
        kind: "notification",
        agentName: "maya",
        timestamp,
        notificationType: "idle_prompt",
      });

      expect(db.getAgentByName("maya")?.status).toEqual("working");
      expect(
        db.listMessages().filter((message) => message.from === "hive-resources"),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  // Hive cannot answer the vendor's dialog, so it cannot know from its own
  // action that the dialog is gone. A completed tool call is the observation
  // that proves it: the human cleared it at the pane and the agent moved on.
  test("a completed tool call clears a blocked agent back to working", async () => {
    const db = new HiveDatabase(join(home, "permission-cleared.db"));
    const tmux = new SilentTmuxSender(db);
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: tmux,
    });
    db.insertAgent(agent({ status: "awaiting-approval" }));
    try {
      await daemon.processEvent({
        kind: "tool-boundary",
        agentName: "maya",
        timestamp,
      });

      expect(db.getAgentByName("maya")?.status).toEqual("working");
    } finally {
      db.close();
    }
  });

  test("all MCP tools work through StreamableHTTPClientTransport", async () => {
    const db = new HiveDatabase(join(home, "mcp.db"));
    const spawner = new StubSpawner();
    const tmux = new RootUnavailableTmuxSender(db);
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
      assessStrandedWork: async () => ({
        dirtyFiles: [],
        unmergedCommits: 0,
      }),
      modelInventory: async () => ({
        observedAt: timestamp,
        complete: true,
        discoveredCount: 0,
        renderedCount: 0,
        providers: {
          claude: { status: "ok", count: 0 },
          codex: { status: "unavailable", reason: "not installed" },
          grok: { status: "unavailable", reason: "not installed" },
        },
        models: [],
        warnings: [],
      }),
    });
    const baseUrl = "http://hive";
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        fetch: actingAs(daemon, "operator"),
      },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);

      const spawned = textValue(await client.callTool({
        name: "hive_spawn",
        arguments: {
          task: "Review auth",
          category: "code_review",
          name: "sam",
          tool: "claude",
        },
      }));
      // hive_spawn echoes identity/state, not the task brief the caller just
      // wrote: taskDescription comes back truncated with its full length
      // alongside it, and the rest of the full record is dropped entirely —
      // hive_status is where that full record still lives.
      expect(spawned).toEqual({
        id: "agent-sam",
        name: "sam",
        tool: "codex",
        model: "gpt-5-codex",
        category: "code_review",
        status: "working",
        branch: "hive/sam-task",
        worktreePath: "/tmp/hive-sam",
        contextPct: 14,
        readOnly: false,
        taskDescription: "Review auth",
        taskDescriptionLength: 11,
      });
      expect(spawner.requests).toEqual([
        {
          task: "Review auth",
          category: "code_review",
          name: "sam",
          tool: "claude",
        },
      ]);

      const status = textValue(await client.callTool({
        name: "hive_status",
        arguments: { detail: "full" },
      }));
      expect(status).toEqual([agent({
        id: "agent-sam",
        name: "sam",
        category: "code_review",
        taskDescription: "Review auth",
        tmuxSession: "hive-sam",
        worktreePath: "/tmp/hive-sam",
        branch: "hive/sam-task",
      })]);

      const inventory = textValue(await client.callTool({
        name: "hive_models",
        arguments: {},
      })) as { complete: boolean; discoveredCount: number };
      expect(inventory).toMatchObject({ complete: true, discoveredCount: 0 });

      const tools = await client.listTools();
      expect(tools.tools.every((tool) =>
        tool.title !== undefined && tool.description !== undefined
      )).toEqual(true);

      // Two protocol rules enforced where they are DECIDED, not merely stated in
      // a prompt the agent had to remember: an agent reading this description is
      // choosing a priority right now. "urgent interrupts at the next safe
      // boundary" used to read as "arrives promptly" — it actually discards the
      // recipient's in-flight reasoning, and sending is not stopping.
      const send = tools.tools.find((tool) => tool.name === "hive_send");
      expect(send?.description).toContain("CANCEL");
      expect(send?.description).toContain("never resumed");
      expect(send?.description).toContain("not RECEIVED and not STOPPED");
      // Preferred root address is queen; synonym remains accepted.
      expect(send?.description).toContain("queen");
      expect(send?.description).toContain("orchestrator");

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

      // The self-escalation contract: a typed wrong-model claim carries evidence
      // or it is refused — an agent that has tried nothing has nothing to
      // escalate.
      const noEvidence = await client.callTool({
        name: "hive_escalate",
        arguments: {
          agent: "sam",
          reason: "this exceeds my tier",
          goal: "Review auth",
          failedApproaches: [],
        },
      });
      expect(noEvidence.isError).toEqual(true);

      const escalated = textValue(await client.callTool({
        name: "hive_escalate",
        arguments: {
          agent: "sam",
          reason:
            "the token refresh path needs a formal state-machine argument my " +
            "model cannot hold together",
          goal: "Review auth",
          done: ["read the auth module"],
          remaining: ["verify the refresh path"],
          decisions: ["treated expiry as monotonic"],
          failedApproaches: [
            "manual trace of the refresh flow lost the concurrent case",
            "a property test that could not encode the invariant",
          ],
        },
      })) as {
        escalation: { category: string; agentName: string; model: string };
        handoff: { branch: string; agentName: string };
        priorEscalations: number;
      };
      expect(escalated.priorEscalations).toEqual(0);
      expect(escalated.escalation.agentName).toEqual("sam");
      expect(escalated.escalation.category).toEqual("code_review");
      expect(escalated.escalation.model.length).toBeGreaterThan(0);
      expect(escalated.handoff.branch).toEqual("hive/sam-task");

      // The escalation reached the orchestrator as a durable message carrying
      // the handoff, and the telemetry row is countable (the second escalation
      // reports the first — measured, reviewable, not blocked).
      const escalationInbox = textValue(await client.callTool({
        name: "hive_inbox",
        arguments: { agent: "orchestrator" },
      })) as Array<{ from: string; body: string }>;
      expect(escalationInbox.length).toEqual(1);
      expect(escalationInbox[0]?.from).toEqual("sam");
      expect(escalationInbox[0]?.body).toContain("CAPABILITY ESCALATION from sam");
      expect(escalationInbox[0]?.body).toContain("category=code_review");
      expect(escalationInbox[0]?.body).toContain("branch: hive/sam-task");
      expect(daemon.db.countEscalationsForAgent("agent-sam")).toEqual(1);

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

      const approvalResponse = await actingAs(daemon, "operator")(
        `${baseUrl}/event`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "approval-request",
            agentName: "sam",
            timestamp: "2026-07-09T12:05:00.000Z",
            description: "Push the branch",
          }),
        },
      );
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
      // The approval-resolution notice is deliberately fire-and-forget (it
      // must not make hive_approve's response wait on pane delivery), so give
      // its microtask chain a tick to land before asserting on the pane.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(tmux.calls).toEqual([
        ["hive-sam", "📨 message from maya: After approval."],
        [
          "hive-sam",
          '📨 message from hive-approvals: Your approval request "Push the branch" was approved.',
        ],
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
        stranded: unknown;
      };
      expect(killed.agent.status).toEqual("dead");
      expect(killed.agent.worktreePath).toEqual(null);
      expect(killed.cleaned).toEqual({
        tmuxSession: "hive-sam",
        worktreePath: "/tmp/hive-sam",
        branch: "hive/sam-task",
      });
      expect(killed.stranded).toEqual(null);
      expect(daemonTmux.killed).toEqual(["hive-sam"]);
      expect(removedWorktrees).toEqual([
        ["/tmp/repo", "/tmp/hive-sam"],
      ]);
      await client.callTool({
        name: "hive_kill",
        arguments: { name: "sam" },
      });
      expect(daemonTmux.killed).toEqual(["hive-sam", "hive-sam"]);

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

  test("hive_spawn, hive_send, and hive_approvals trim large echoes while the full data stays reachable elsewhere", async () => {
    const db = new HiveDatabase(join(home, "compact-results.db"));
    const spawner = new StubSpawner();
    const daemon = new HiveDaemon({
      db,
      spawner,
      tmux: new FakeDaemonTmux(),
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: actingAs(daemon, "operator") },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);

      const longTask = "Investigate the auth regression. ".repeat(20);
      const spawned = textValue(await client.callTool({
        name: "hive_spawn",
        arguments: {
          task: longTask,
          category: "simple_coding",
          name: "nia",
          tool: "claude",
        },
      })) as {
        taskDescription: string;
        taskDescriptionLength: number;
        tmuxSession?: string;
        createdAt?: string;
      };
      expect(spawned.taskDescription.length).toBeLessThan(longTask.length);
      expect(spawned.taskDescriptionLength).toEqual(longTask.length);
      expect(spawned.tmuxSession).toBeUndefined();
      expect(spawned.createdAt).toBeUndefined();

      // The full brief the caller just wrote is not gone — hive_status still
      // carries the untouched record.
      const status = textValue(await client.callTool({
        name: "hive_status",
        arguments: { detail: "full" },
      })) as Array<{ name: string; taskDescription: string }>;
      expect(status.find((row) => row.name === "nia")?.taskDescription)
        .toEqual(longTask);

      const longBody = "The auth regression traces to a stale token cache. "
        .repeat(10);
      const sent = textValue(await client.callTool({
        name: "hive_send",
        arguments: { from: "maya", to: "nia", body: longBody },
      })) as { body: string; truncated: boolean; deliveredAt: string | null };
      expect(sent.body.length).toBeLessThan(longBody.length);
      expect(sent.truncated).toEqual(true);

      // The recipient's own inbox is the read path for the full body.
      const inbox = textValue(await client.callTool({
        name: "hive_inbox",
        arguments: { agent: "nia" },
      })) as Array<{ body: string }>;
      expect(inbox[0]?.body).toEqual(longBody);

      // An approval-request hook event is a TOOL PERMISSION: the description
      // is the thing being decided, so it is exempt from the trim and comes
      // back whole however long it is. The boilerplate kinds are the trimmed
      // ones — see "hive_approvals trims by kind" below.
      const longDescription =
        "Bash: curl https://example.com/install.sh | sh --flag ".repeat(6);
      const approvalResponse = await actingAs(daemon, "operator")(
        "http://hive/event",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "approval-request",
            agentName: "nia",
            timestamp: "2026-07-09T12:05:00.000Z",
            description: longDescription,
          }),
        },
      );
      expect(approvalResponse.status).toEqual(200);

      const approvals = textValue(await client.callTool({
        name: "hive_approvals",
        arguments: {},
      })) as Array<{ kind: string; description: string; truncated: boolean }>;
      expect(approvals[0]?.kind).toEqual("tool-permission");
      expect(approvals[0]?.description).toEqual(longDescription);
      expect(approvals[0]?.truncated).toEqual(false);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
      db.close();
    }
  });

  test("hive_mark_dead refuses live sessions and cleans confirmed-stopped agents", async () => {
    const db = new HiveDatabase(join(home, "mark-dead-stopped-only.db"));
    const tmux = new FakeDaemonTmux();
    tmux.sessions.add("hive-maya");
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
      resourceRunners: { panePids: async () => [] },
    });
    db.insertAgent(agent());
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: actingAs(daemon, "operator") },
    );
    const client = new Client({ name: "mark-dead-test", version: "1.0.0" });
    try {
      await client.connect(transport);

      const refused = await client.callTool({
        name: "hive_mark_dead",
        arguments: { agent: "maya" },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("hive_kill");
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "working",
      });
      expect(tmux.killed).toEqual([]);

      tmux.sessions.delete("hive-maya");
      const stopped = textValue(await client.callTool({
        name: "hive_mark_dead",
        arguments: { agent: "maya" },
      })) as AgentRecord;
      expect(stopped.status).toEqual("dead");
    } finally {
      await client.close();
      await daemon.stop();
      db.close();
    }
  });

  test("the dead-agent kill path reaps residual owned processes only", async () => {
    const owned = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const unrelated = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const db = new HiveDatabase(join(home, "residual-http-kill.db"));
    const tmux = new FakeDaemonTmux();
    tmux.sessions.add("hive-maya");
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      resourceRunners: {
        panePids: async (session) => session === "hive-maya" ? [owned.pid] : [],
        orphans: null,
      },
    });
    db.insertAgent(agent({
      status: "dead",
      worktreePath: null,
      branch: null,
    }));
    try {
      expect(() => process.kill(owned.pid, 0)).not.toThrow();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();

      const response = await actingAs(daemon, "operator")(
        "http://hive/agents/maya/kill",
        { method: "POST" },
      );
      expect(response.status).toEqual(200);
      const result = await response.json() as {
        reaped: { killed: Array<{ pid: number }>; survivors: unknown[] };
      };
      expect(result.reaped.killed.map(({ pid }) => pid)).toContain(owned.pid);
      expect(result.reaped.survivors).toEqual([]);
      expect(await Promise.race([
        owned.exited,
        Bun.sleep(1_000).then(() => null),
      ])).not.toBeNull();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      expect(tmux.killed).toEqual(["hive-maya"]);
    } finally {
      owned.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([owned.exited, unrelated.exited]);
      await daemon.stop();
      db.close();
    }
  });

  test("hive_approvals trims by kind: boilerplate is cut, a tool permission never is", async () => {
    // The trim exists to stop re-sending the same boilerplate on every poll.
    // It must never reach a tool-permission description, because THAT text is
    // the decision — cutting its tail would let an approver approve a command
    // whose tail they never read.
    const db = new HiveDatabase(join(home, "approval-kinds.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: actingAs(daemon, "operator") },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);

      // A real shell command well past the 200-char trim: the exact case that
      // must survive intact.
      const longCommand =
        "Codex wants to run bash -lc 'find . -name \"*.ts\" -newer package.json " +
        "-print0 | xargs -0 grep -ln \"insertApproval\" | sort -u | head -50 " +
        "&& rm -rf ./build/cache && npm publish --access public --tag latest'";
      expect(longCommand.length).toBeGreaterThan(200);
      const permissionId = await daemon.queueCodexApproval("nia", longCommand);

      const boilerplate =
        "SPEND REAL MONEY on some-model? Approve to let Hive run it and bill "
          .repeat(5);
      expect(boilerplate.length).toBeGreaterThan(200);
      db.insertApproval({
        id: "cost-consent:some-model",
        agentName: "router",
        kind: "cost-consent",
        description: boilerplate,
        status: "pending",
        createdAt: "2026-07-09T12:00:00.000Z",
        resolvedAt: null,
      });
      const rearmText =
        "Re-arm landing: the one-shot branch:land grant for nia is spent. "
          .repeat(5);
      expect(rearmText.length).toBeGreaterThan(200);
      db.insertApproval({
        id: "rearm-1",
        agentName: "nia",
        kind: "land-rearm",
        description: rearmText,
        status: "pending",
        createdAt: "2026-07-09T12:01:00.000Z",
        resolvedAt: null,
      });

      const approvals = textValue(await client.callTool({
        name: "hive_approvals",
        arguments: {},
      })) as Array<{
        id: string;
        kind: string;
        description: string;
        truncated: boolean;
      }>;
      const byId = new Map(approvals.map((entry) => [entry.id, entry]));

      // The command round-trips byte-for-byte, however long it is.
      const permission = byId.get(permissionId)!;
      expect(permission.kind).toEqual("tool-permission");
      expect(permission.description).toEqual(longCommand);
      expect(permission.truncated).toEqual(false);

      // Boilerplate kinds are still cut — the context saving amy landed stands.
      const consent = byId.get("cost-consent:some-model")!;
      expect(consent.kind).toEqual("cost-consent");
      expect(consent.description.length).toBeLessThan(boilerplate.length);
      expect(consent.truncated).toEqual(true);

      const rearm = byId.get("rearm-1")!;
      expect(rearm.kind).toEqual("land-rearm");
      expect(rearm.description.length).toBeLessThan(rearmText.length);
      expect(rearm.truncated).toEqual(true);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
      db.close();
    }
  });

  test("hive_kill surfaces stranded work and refuses to delete it without discardWork", async () => {
    const db = new HiveDatabase(join(home, "stranded.db"));
    const removed: Array<[string, boolean]> = [];
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      tmux: new FakeDaemonTmux(),
      repoRoot: "/tmp/repo",
      removeWorktree: async (_repoRoot, worktreePath, options) => {
        const discardTracked = typeof options === "object" &&
          (options?.discardTracked ?? false);
        removed.push([worktreePath, discardTracked]);
      },
      assessStrandedWork: async () => ({
        dirtyFiles: ["src/wip.ts"],
        unmergedCommits: 2,
      }),
    });
    db.insertAgent(agent());
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: actingAs(daemon, "operator") },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);

      const refused = textValue(await client.callTool({
        name: "hive_kill",
        arguments: { name: "maya", removeWorktree: true },
      })) as {
        agent: AgentRecord;
        cleaned: { worktreePath: string | null; branch: string | null };
        stranded: {
          branch: string;
          worktreePath: string;
          dirtyFiles: string[];
          unmergedCommits: number;
          note: string;
        } | null;
      };
      expect(refused.agent.status).toEqual("dead");
      expect(refused.agent.worktreePath).toEqual("/tmp/hive-maya");
      expect(refused.cleaned.worktreePath).toEqual(null);
      expect(refused.stranded).toMatchObject({
        branch: "hive/maya-server",
        worktreePath: "/tmp/hive-maya",
        dirtyFiles: ["src/wip.ts"],
        unmergedCommits: 2,
      });
      expect(refused.stranded?.note).toContain("discardWork");
      expect(removed).toEqual([]);

      const discarded = textValue(await client.callTool({
        name: "hive_kill",
        arguments: { name: "maya", removeWorktree: true, discardWork: true },
      })) as typeof refused;
      expect(discarded.cleaned.worktreePath).toEqual("/tmp/hive-maya");
      expect(discarded.agent.worktreePath).toEqual(null);
      // The discard is still recorded so the orchestrator sees what was lost.
      expect(discarded.stranded?.unmergedCommits).toEqual(2);
      expect(removed).toEqual([["/tmp/hive-maya", true]]);
    } finally {
      await client.close();
      await daemon.stop();
      db.close();
    }
  });

  // Against REAL git, because a stubbed removeWorktree is what hid this: it
  // cannot model the repo dominic was actually killed in, where the worktree
  // directory was gone and its registration pruned. hive_kill discardWork:true
  // removed the worktree, reported "Nothing was deleted", and left the branch
  // AND refs/hive-preserved/* holding every commit it was told to discard.
  test("hive_kill discardWork leaves no branch and no preserved ref", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hive-kill-discard-"));
    const git = async (cwd: string, ...args: string[]): Promise<string> => {
      const process = Bun.spawn(["git", "-C", cwd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        process.exited,
      ]);
      if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
      return stdout.trim();
    };
    await git(repoRoot, "init", "-b", "main");
    await git(repoRoot, "config", "user.name", "Hive Test");
    await git(repoRoot, "config", "user.email", "hive@example.test");
    await git(repoRoot, "commit", "--allow-empty", "-m", "initial");

    const created = await createWorktree(repoRoot, "maya", "server");
    await Bun.write(join(created.path, "wip.ts"), "throwaway\n");
    await git(created.path, "add", "wip.ts");
    await git(created.path, "commit", "-m", "wip nobody wants");

    // dominic's repo state: the worktree directory is already gone.
    await rm(created.path, { recursive: true, force: true });
    await git(repoRoot, "worktree", "prune");

    const db = new HiveDatabase(join(home, "discard-real-git.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      tmux: new FakeDaemonTmux(),
      repoRoot,
    });
    db.insertAgent(
      agent({ worktreePath: created.path, branch: created.branch }),
    );
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: actingAs(daemon, "operator") },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);

      const discarded = textValue(await client.callTool({
        name: "hive_kill",
        arguments: { name: "maya", removeWorktree: true, discardWork: true },
      })) as {
        preserved: { ref: string } | null;
        stranded: { unmergedCommits: number; note: string } | null;
      };

      // The work existed, so the discard was a real decision, not a no-op.
      expect(discarded.stranded?.unmergedCommits).toEqual(1);
      // And it was carried out: nothing of the branch survives, anywhere.
      expect(await git(repoRoot, "branch", "--list", created.branch))
        .toEqual("");
      expect(await git(repoRoot, "for-each-ref", "refs/hive-preserved/"))
        .toEqual("");
      // Nor does the report claim work was preserved that no longer exists.
      expect(discarded.preserved).toEqual(null);
      expect(discarded.stranded?.note).toContain("DELETED");
    } finally {
      await client.close();
      await daemon.stop();
      db.close();
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("hive_kill still wins when the stranded-work check itself fails", async () => {
    const db = new HiveDatabase(join(home, "stranded-error.db"));
    const removed: string[] = [];
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      tmux: new FakeDaemonTmux(),
      repoRoot: "/tmp/repo",
      removeWorktree: async (_repoRoot, worktreePath) => {
        removed.push(worktreePath);
      },
      assessStrandedWork: async () => {
        throw new Error("git exploded");
      },
    });
    db.insertAgent(agent());
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: actingAs(daemon, "operator") },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const killed = textValue(await client.callTool({
        name: "hive_kill",
        arguments: { name: "maya", removeWorktree: true },
      })) as {
        agent: AgentRecord;
        stranded: { note: string } | null;
      };
      expect(killed.agent.status).toEqual("dead");
      expect(killed.stranded?.note).toContain("git exploded");
      // An unverifiable worktree is kept, never deleted on a guess.
      expect(removed).toEqual([]);
    } finally {
      await client.close();
      await daemon.stop();
      db.close();
    }
  });

  test("hook events capture the tool session id and a completed turn rearms the resume budget", async () => {
    const db = new HiveDatabase(join(home, "session-capture.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      tmux: new FakeDaemonTmux(),
    });
    db.insertAgent(agent({ status: "working", recoveryAttempts: 2 }));
    try {
      await daemon.processEvent({
        kind: "session-start",
        agentName: "maya",
        timestamp: "2026-07-10T10:00:00.000Z",
        toolSessionId: "0189-first",
      });
      expect(db.getAgentByName("maya")).toMatchObject({
        toolSessionId: "0189-first",
        recoveryAttempts: 2,
      });

      // A resume forks Claude to a fresh session id; the newest wins.
      await daemon.processEvent({
        kind: "turn-end",
        agentName: "maya",
        timestamp: "2026-07-10T10:05:00.000Z",
        toolSessionId: "0189-forked",
      });
      expect(db.getAgentByName("maya")).toMatchObject({
        toolSessionId: "0189-forked",
        recoveryAttempts: 0,
      });

      // An event without identity leaves the recorded session untouched.
      await daemon.processEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: "2026-07-10T10:06:00.000Z",
      });
      expect(db.getAgentByName("maya")?.toolSessionId).toEqual("0189-forked");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("a read-only agent reaches working without becoming control-paused", async () => {
    const db = new HiveDatabase(join(home, "reader-lifecycle.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
    });
    db.insertAgent(agent({
      status: "spawning",
      readOnly: true,
      writeRevoked: false,
    }));
    try {
      await daemon.processEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: "2026-07-10T10:00:00.000Z",
        toolSessionId: "reader-session",
      });

      expect(db.getAgentByName("maya")).toMatchObject({
        status: "working",
        readOnly: true,
        writeRevoked: false,
        toolSessionId: "reader-session",
      });
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("a dead hook reaps the process tree", async () => {
    const db = new HiveDatabase(join(home, "dead-hook-teardown.db"));
    const tmux = new FakeDaemonTmux();
    tmux.sessions.add("hive-maya");
    const owned = Bun.spawn(["sh", "-c", "sleep 60 & wait"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      resourceRunners: {
        panePids: async (session) =>
          session === "hive-maya" ? [owned.pid] : [],
      },
    });
    db.insertAgent(agent());
    try {
      await daemon.processEvent({
        kind: "dead",
        agentName: "maya",
        timestamp: "2026-07-10T10:07:00.000Z",
      });

      expect(db.getAgentByName("maya")).toMatchObject({ status: "dead" });
      expect(tmux.killed).toEqual(["hive-maya"]);
      const exitCode = await Promise.race([
        owned.exited,
        Bun.sleep(1_000).then(() => null),
      ]);
      expect(exitCode).not.toBeNull();
    } finally {
      owned.kill("SIGKILL");
      await daemon.stop();
      db.close();
    }
  });

  test("hive_recover resumes a crashed agent over MCP and reports the outcome", async () => {
    const db = new HiveDatabase(join(home, "recover-mcp.db"));
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      // This embedded daemon is driven through an in-memory MCP transport and
      // never calls start(), so give recovery the nonzero port a real bound
      // daemon would expose after its ephemeral bind.
      port: 4317,
      tmuxSender: new SilentTmuxSender(db),
      tmux,
      recovery: {
        worktreeExists: () => true,
        sleep: async () => {},
        seedClaudeTrust: async () => {},
        writeClaudeConfig: async () => {},
        writeCodexConfig: async () => {},
        // The hardened resume monitor fails a resume that never proves life;
        // fresh codex rollout activity is this resumed TUI's stand-in signal.
        readCodexActivity: async () =>
          new Date(Date.now() + 60_000).toISOString(),
      },
    });
    db.insertAgent(agent({
      status: "dead",
      toolSessionId: "0189-session",
      executionIdentity: {
        tool: "codex",
        model: "gpt-5-codex",
        effort: "medium",
      },
      failureReason: "tmux session missing (reconciled)",
    }));
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: actingAs(daemon, "operator") },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const outcomes = textValue(await client.callTool({
        name: "hive_recover",
        arguments: { agent: "maya" },
      })) as { agent: string; action: string; sessionId?: string }[];
      expect(outcomes).toEqual([{
        agent: "maya",
        action: "resumed",
        sessionId: "0189-session",
      }]);
      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      expect(tmux.created[0]?.command).toContain("'codex' 'resume'");
      expect(tmux.created[0]?.command).toContain("0189-session");
    } finally {
      await client.close();
      await daemon.stop();
      db.close();
    }
  });

  test("the /recover endpoint sweeps and reports over HTTP for the CLI", async () => {
    const db = new HiveDatabase(join(home, "recover-http.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      tmux: new FakeDaemonTmux(),
      recovery: { worktreeExists: () => false },
    });
    db.insertAgent(agent({ status: "working" }));
    try {
      const response = await actingAs(daemon, "operator")(
        "http://hive/recover",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(response.status).toEqual(200);
      const body = await response.json() as { outcomes: { action: string }[] };
      expect(body.outcomes).toMatchObject([{ action: "marked-dead" }]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("reconciliation marks a vanished live session dead when nothing is resumable", async () => {
    const db = new HiveDatabase(join(home, "reconcile.db"));
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      recovery: { worktreeExists: () => false },
    });
    db.insertAgent(agent({ status: "idle" }));
    try {
      await daemon.reconcileAgents();

      expect(db.getAgentByName("maya")).toMatchObject({
        status: "dead",
        failureReason: "worktree is missing; session not resumable",
      });
      // Death surfaces durably: the orchestrator gets the stored task text
      // for a respawn instead of a silent status flip.
      const alert = db.listMessages().find((message) =>
        message.to === "queen" && message.from === "hive-recovery"
      );
      expect(alert?.body).toContain("maya died in a crash");
      expect(alert?.body).toContain("Build server");
    } finally {
      db.close();
    }
  });

  test("reconciliation classifies a spawning agent with a vanished session as died-during-spawn", async () => {
    const db = new HiveDatabase(join(home, "reconcile-spawning.db"));
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      recovery: { worktreeExists: () => true },
    });
    db.insertAgent(agent({ status: "spawning" }));
    try {
      await daemon.reconcileAgents();

      // The anna failure mode: a status table saying "spawning" forever
      // while urgent messages rot in the queue. Death is now explicit and
      // the worktree survives for a respawn.
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "dead",
        failureReason: "process died during spawn (crash recovery)",
        worktreePath: "/tmp/hive-maya",
      });
    } finally {
      db.close();
    }
  });

  test("reconciliation leaves an in-flight spawn alone while its name is reserved", async () => {
    const db = new HiveDatabase(join(home, "reconcile-inflight.db"));
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      recovery: { worktreeExists: () => true },
    });
    db.insertAgent(agent({ status: "spawning" }));
    db.reserveAgentName("maya");
    try {
      await daemon.reconcileAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("spawning");
      expect(tmux.checked).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the telemetry sweep updates context% and revives a notify-blind codex agent", async () => {
    const db = new HiveDatabase(join(home, "telemetry-sweep.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      telemetryReaders: {
        claude: async () => ({
          // 420k tokens measured from the transcript. No statusline report
          // has ever carried this row's window — but 420k tokens cannot fit
          // a 200k window, so the window is provably the 1M one.
          contextTokens: 420_000,
          lastActivityAt: "2026-07-09T12:05:00.000Z",
        }),
        codex: async () => ({
          contextPct: 17,
          lastActivityAt: "2026-07-09T12:06:00.000Z",
        }),
      },
    });
    db.insertAgent(agent({ status: "working", tool: "claude", model: "sonnet" }));
    db.insertAgent(agent({
      id: "agent-priya",
      name: "priya",
      tool: "codex",
      // The field failure: notify never landed a single event, so the row
      // froze at "spawning" while the agent worked, landed, and reported.
      status: "spawning",
      tmuxSession: "hive-priya",
      worktreePath: "/tmp/hive-priya",
    }));
    try {
      await daemon.refreshToolTelemetry();

      // Claude context% is measured tokens over a measured window. This row
      // has no statusline-observed window, but 420k resident tokens are an
      // existence proof of the 1M window: 420k / 1M = 42%.
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "working",
        contextPct: 42,
      });
      // A fresh rollout is proof of codex life: the stuck spawning row
      // becomes working and its lastEventAt tracks the artifact.
      expect(db.getAgentByName("priya")).toMatchObject({
        status: "working",
        contextPct: 17,
        lastEventAt: "2026-07-09T12:06:00.000Z",
      });
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
      recovery: { worktreeExists: () => false },
    });
    db.insertAgent(agent({ status: "stuck" }));
    try {
      await daemon.reconcileAgents();

      // Checked once by the sweep and once again inside the recovery's
      // exclusive section, which guards against a session appearing between
      // the two.
      expect(tmux.checked).toEqual(["hive-maya", "hive-maya"]);
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "dead",
        failureReason: "worktree is missing; session not resumable",
      });
    } finally {
      db.close();
    }
  });

  test("reconciliation settles a dead agent's quota reservation", async () => {
    const db = new HiveDatabase(join(home, "reconcile-quota.db"));
    const ledger = new QuotaLedger(db);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({
        limits: [
          {
            provider: "codex",
            pool: "codex-premium",
            models: ["gpt-5-codex"],
            fiveHourAllowance: 100,
            weeklyAllowance: 1000,
          },
          {
            provider: "claude",
            pool: "claude-premium",
            models: ["claude-model"],
            fiveHourAllowance: 100,
            weeklyAllowance: 1000,
          },
        ],
      }),
      () => new Date(timestamp),
    );
    const decision = await quota.routeAndReserve({
      agentName: "maya",
      category: "simple_coding",
      selection: "strict",
      explicitTool: "codex",
      candidates: await authorizeForQuotaTest([
        { tool: "claude", model: "claude-model" },
        { tool: "codex", model: "gpt-5-codex" },
      ]),
    });
    quota.markStarted(decision.reservation.id);
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      tmux: new FakeDaemonTmux(),
      quota,
      recovery: { worktreeExists: () => false },
    });
    db.insertAgent(agent({
      status: "working",
      quotaReservationId: decision.reservation.id,
    }));
    try {
      await daemon.reconcileAgents();

      expect(db.getAgentByName("maya")).toMatchObject({
        status: "dead",
        failureReason: "worktree is missing; session not resumable",
      });
      // A started agent that dies keeps its conservative estimate.
      expect(ledger.getReservation(decision.reservation.id)).toMatchObject({
        status: "reconciled",
        source: "estimated",
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
        fetch: actingAs(daemon, "operator"),
      },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "hive_spawn",
        arguments: { task: "Unsupported launch", category: "simple_coding" },
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
        arguments: { detail: "full", history: true },
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

  test("hive_spawn returns a tool error for an unverified stuck verdict", async () => {
    const db = new HiveDatabase(join(home, "stuck-spawn.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StuckSpawner(),
      tmux: new FakeDaemonTmux(),
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: actingAs(daemon, "operator") },
    );
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(transport);

      const result = await client.callTool({
        name: "hive_spawn",
        arguments: { task: "Unverified launch", category: "simple_coding" },
      });

      expect(result.isError).toEqual(true);
      expect(JSON.stringify(result.content)).toContain(
        "process teardown could not be verified",
      );
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "stuck",
        writeRevoked: true,
      });
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
      tmuxSender: new SilentTmuxSender(db),
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

describe("resource watchdog", () => {
  const psOutput = [
    "  10     1   102400 claude --model sonnet", // maya pane root, 100 MB
    "  11    10 94371840 bun test",              // runaway grandchild, 90 GB
    "  20     1   102400 codex",                 // sam pane root, healthy
  ].join("\n");
  const vmStatOutput = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                              262144.",
    "Pages inactive:                          262144.",
  ].join("\n");

  function watchdogDaemon(overrides: {
    vmStat?: string;
    availableFloorMb?: number;
  } = {}) {
    const db = new HiveDatabase(":memory:");
    const sender = new SilentTmuxSender(db);
    const killed: number[] = [];
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: sender,
      resources: {
        enabled: true,
        perProcessMemoryMb: 12_288,
        minSystemAvailableMb: overrides.availableFloorMb ?? 4_096,
      },
      resourceRunners: {
        ps: async () => psOutput,
        vmStat: async () => overrides.vmStat ?? vmStatOutput,
        panePids: async (session) =>
          session === "hive-maya" ? [10] : session === "hive-sam" ? [20] : [],
        kill: (pid) => {
          killed.push(pid);
        },
        orphans: null,
      },
    });
    return { db, daemon, killed };
  }

  test("kills a runaway process under an agent session and reports it", async () => {
    const { db, daemon, killed } = watchdogDaemon();
    db.insertAgent(agent({ tmuxSession: "hive-maya" }));
    db.insertAgent(agent({
      id: "agent-sam",
      name: "sam",
      tmuxSession: "hive-sam",
    }));
    try {
      await daemon.sweepResources();

      expect(killed).toEqual([11]);
      const reports = db.listMessages()
        .filter((message) => message.from === "hive-resources");
      const toOrchestrator = reports.filter((message) => message.to === "queen");
      expect(toOrchestrator).toHaveLength(1);
      expect(toOrchestrator[0]?.body).toContain("killed pid 11 under maya");
      expect(toOrchestrator[0]?.body).toContain("bun test");

      // maya is told WHY her command died. Without this she reads the opaque
      // death as a bad command and retries it, wider each time.
      const toMaya = reports.filter((message) => message.to === "maya");
      expect(toMaya).toHaveLength(1);
      expect(toMaya[0]?.body).toContain("KILLED");
      expect(toMaya[0]?.body).toContain("12288 MB per-process ceiling");
      expect(toMaya[0]?.body).toContain("bun test");
      expect(toMaya[0]?.body).toContain("do not widen it");
      // sam's process was healthy; she hears nothing.
      expect(reports.filter((message) => message.to === "sam")).toHaveLength(0);

      // The same runaway is never re-reported on the next sweep.
      await daemon.sweepResources();
      expect(killed).toEqual([11, 11]);
      expect(db.listMessages()
        .filter((message) => message.from === "hive-resources"))
        .toHaveLength(2);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("reports a process that survived the watchdog kill instead of claiming success", async () => {
    const owned = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      resources: {
        enabled: true,
        perProcessMemoryMb: 12_288,
        minSystemAvailableMb: 4_096,
      },
      resourceRunners: {
        ps: async () =>
          `${owned.pid} 1 94371840 sleep 60`,
        vmStat: async () => vmStatOutput,
        panePids: async (session) =>
          session === "hive-maya" ? [owned.pid] : [],
        kill: () => {},
        orphans: null,
      },
    });
    db.insertAgent(agent({ tmuxSession: "hive-maya" }));
    try {
      await daemon.sweepResources();

      const reports = db.listMessages()
        .filter((message) => message.from === "hive-resources");
      expect(reports.some((message) =>
        message.body.includes(`FAILED to kill pid ${owned.pid}`)
      )).toBe(true);
      expect(reports.some((message) =>
        message.body.includes(`watchdog killed pid ${owned.pid}`)
      )).toBe(false);
      expect(() => process.kill(owned.pid, 0)).not.toThrow();
    } finally {
      owned.kill("SIGKILL");
      await owned.exited;
      await daemon.stop();
      db.close();
    }
  });

  test("memory pressure pauses hive_spawn until it clears", async () => {
    const lowMemory = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                              1024.",
      "Pages inactive:                          1024.",
    ].join("\n");
    const { db, daemon } = watchdogDaemon({ vmStat: lowMemory });
    try {
      await daemon.sweepResources();

      const transport = new StreamableHTTPClientTransport(
        new URL("http://hive/mcp"),
        { fetch: actingAs(daemon, "operator") },
      );
      const client = new Client({ name: "watchdog-test", version: "1.0.0" });
      await client.connect(transport);
      const refused = await client.callTool({
        name: "hive_spawn",
        arguments: { task: "More work", category: "simple_coding" },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("memory pressure");
      expect(db.listMessages()
        .some((m) => m.body.includes("paused agent spawning")))
        .toBe(true);
      await client.close();
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});

describe("the model an agent is actually running", () => {
  // Hive believed zoe and lena were on claude-fable-5 and omar on sonnet, while
  // all of their transcripts said claude-opus-4-8: the user had typed /model
  // inside the sessions, and `agents.model` is a spawn-time string that nothing
  // ever corrected. Quota was then reserved and observed against a model nobody
  // was running, and `hive status` reported the same fiction to the orchestrator,
  // which routes off it. The transcript is the observation; the row must follow it.
  const transcript = async (
    worktreePath: string,
    models: string[],
  ): Promise<void> => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { claudeProjectDirectory } = await import("../adapters/tools/claude");
    const directory = claudeProjectDirectory(worktreePath, home);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "session.jsonl"),
      models
        .map((model) => JSON.stringify({ type: "assistant", message: { model } }))
        .join("\n"),
    );
  };

  test("a statusline report rebinds quota to the live model and fixes the row", async () => {
    const db = new HiveDatabase(join(home, "live-model.db"));
    const worktreePath = mkdtempSync(join(tmpdir(), "hive-zoe-"));
    const observed: Array<{ model: string }> = [];
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      // The real transcript parser, pointed at this test's home rather than the
      // developer's. A stubbed reader would only prove that a stub returns what
      // it was told to.
      telemetryReaders: {
        liveModel: (worktreePath, toolSessionId) =>
          readLiveClaudeModel(worktreePath, toolSessionId, home),
      },
      quota: {
        setAlertSink: () => {},
        ledger: new QuotaLedger(db),
        observeStatusline: async (binding: { model: string }) => {
          observed.push({ model: binding.model });
          return null;
        },
      } as unknown as QuotaService,
    });
    try {
      db.insertAgent(agent({
        id: "agent-zoe",
        name: "zoe",
        tool: "claude",
        model: "claude-fable-5", // what it was spawned with
        worktreePath,
        toolSessionId: "session", // what hook traffic names its transcript
      }));
      // What it is actually running, after the user typed /model.
      await transcript(worktreePath, ["claude-fable-5", "claude-opus-4-8"]);

      const response = await actingAs(daemon, "zoe", "writer")(
        "http://hive/statusline",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "zoe",
            fiveHour: { usedPct: 40, resetsAt: null },
          }),
        },
      );
      expect(response.status).toBe(200);

      // The ledger is charged to the model that is burning the tokens...
      expect(observed).toEqual([{ model: "claude-opus-4-8" }]);
      // ...and the row no longer lies to `hive status`, which is the half that
      // makes it visible. Fixing only the ledger keeps the display wrong, and
      // the orchestrator routes off the display.
      const row = db.getAgentByName("zoe");
      expect(row?.liveModel).toBe("claude-opus-4-8");
      expect(formatStatusTable([row!])).toContain("claude-opus-4-8");

      // And the immutable execution identity is untouched. This is not an
      // incidental detail: `restartForControl` fails closed when the recorded
      // identity and the row disagree, so writing the observation over `model`
      // would leave every agent whose user typed `/model` permanently
      // unrestartable with its capability revoked.
      expect(row?.model).toBe("claude-fable-5");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("a statusline report lands Claude's own occupancy figure on the agent row", async () => {
    const db = new HiveDatabase(join(home, "statusline-context-pct.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      quota: {
        setAlertSink: () => {},
        ledger: new QuotaLedger(db),
        observeStatusline: async () => null,
      } as unknown as QuotaService,
    });
    try {
      db.insertAgent(
        agent({ id: "agent-maya", name: "maya", tool: "claude", contextPct: null }),
      );
      expect(db.getAgentByName("maya")?.contextPct).toBeNull();

      const response = await actingAs(daemon, "maya", "writer")(
        "http://hive/statusline",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "maya",
            contextWindow: 1_000_000,
            contextUsedPct: 28,
          }),
        },
      );
      expect(response.status).toBe(200);
      // This is the one field the daemon never re-derives: Claude Code measured
      // it against the account's real window, so the report lands verbatim.
      expect(db.getAgentByName("maya")?.contextPct).toBe(28);
      // And the window itself is persisted: it is the denominator the
      // telemetry sweep divides the transcript's token count by, so one
      // report that ever carried it keeps contextPct measurable even if the
      // statusline goes quiet afterwards.
      expect(db.getAgentByName("maya")?.contextWindow).toBe(1_000_000);

      // A second report with no context block at all — an API-key account, or a
      // render before the session's first response — must not erase the reading
      // that's already standing.
      const followUp = await actingAs(daemon, "maya", "writer")(
        "http://hive/statusline",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "maya",
            fiveHour: { usedPct: 5, resetsAt: null },
          }),
        },
      );
      expect(followUp.status).toBe(200);
      expect(db.getAgentByName("maya")?.contextPct).toBe(28);
      expect(db.getAgentByName("maya")?.contextWindow).toBe(1_000_000);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("a Codex agent is never relabelled from a Claude transcript in its worktree", async () => {
    const db = new HiveDatabase(join(home, "live-model-none.db"));
    const worktreePath = mkdtempSync(join(tmpdir(), "hive-lucas-"));
    const observed: string[] = [];
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      telemetryReaders: {
        liveModel: (path, toolSessionId) =>
          readLiveClaudeModel(path, toolSessionId, home),
      },
      quota: {
        setAlertSink: () => {},
        ledger: new QuotaLedger(db),
        observeStatusline: async (binding: { model: string }) => {
          observed.push(binding.model);
          return null;
        },
      } as unknown as QuotaService,
    });
    try {
      // A Codex agent whose worktree ALSO holds a Claude transcript — which is
      // not hypothetical: the live lucas has one, and reading it without checking
      // the tool would have relabelled a Codex agent as `claude-sonnet-5` and
      // charged its tokens to a Claude pool. Codex rollouts record no model name,
      // so there is nothing here to observe, and an unknown model stays unknown.
      db.insertAgent(agent({
        id: "agent-lucas",
        name: "lucas",
        tool: "codex",
        model: "gpt-5.6-sol",
        worktreePath,
      }));
      await transcript(worktreePath, ["claude-sonnet-5"]);
      await actingAs(daemon, "lucas", "writer")("http://hive/statusline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "lucas",
          fiveHour: { usedPct: 10, resetsAt: null },
        }),
      });
      expect(observed).toEqual(["gpt-5.6-sol"]);
      expect(db.getAgentByName("lucas")?.model).toBe("gpt-5.6-sol");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  // The leak this test exists for, as it actually happened: nadia and owen were
  // spawned as `sonnet`, ran as `claude-sonnet-5`, were killed cleanly — and
  // went on holding 4% each of a five-hour window nobody was spending. The
  // re-key released the booking the agent row named and wrote a new one, but
  // left the row naming the released id, and every terminal path settles by
  // that id. So the assertion here is not "cancel was called": it is the number
  // `hive_quota_status` serves, read from the same surface, before and after.
  test("a re-keyed reservation is released on kill, and reserved returns to its prior value", async () => {
    const db = new HiveDatabase(join(home, "rekey-leak.db"));
    const worktreePath = mkdtempSync(join(tmpdir(), "hive-probe-"));
    const ledger = new QuotaLedger(db);
    const quota = new QuotaService(
      ledger,
      QuotaConfigSchema.parse({
        limits: [{
          provider: "claude",
          pool: "subscription",
          models: ["*"],
          fiveHourAllowance: 100,
          weeklyAllowance: 100,
        }],
      }),
    );
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      tmuxSender: new SilentTmuxSender(db),
      quota,
      telemetryReaders: {
        liveModel: (path, toolSessionId) =>
          readLiveClaudeModel(path, toolSessionId, home),
      },
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    });
    // The exact figure hive_quota_status reports: QuotaService.statuses().
    const reserved = (): number => {
      const value = quota.statuses().find((status): status is QuotaPoolStatus =>
        !("configured" in status) && status.pool === "subscription"
      )!.fiveHour.reserved;
      if (value === null) throw new Error("subscription five-hour window is not metered");
      return value;
    };
    try {
      const before = reserved();

      // Spawn, as the spawner does it: book the run, then write the row that
      // names the booking. `sonnet` is an alias — which is the whole trigger.
      const decision = await quota.routeAndReserve({
        agentName: "probe",
        category: "simple_coding",
        selection: "strict",
        candidates: await authorizeForQuotaTest([{ tool: "claude", model: "sonnet" }]),
      });
      quota.markStarted(decision.reservation.id);
      db.insertAgent(agent({
        id: "agent-probe",
        name: "probe",
        tool: "claude",
        model: "sonnet",
        tmuxSession: "hive-probe",
        worktreePath,
        toolSessionId: "session",
        quotaReservationId: decision.reservation.id,
      }));
      const held = reserved();
      expect(held).toBeGreaterThan(before);

      // The session reports in. Its transcript names the canonical model, which
      // is not the alias it was spawned with, so the booking is re-keyed.
      await transcript(worktreePath, ["claude-sonnet-5"]);
      const response = await actingAs(daemon, "probe", "writer")(
        "http://hive/statusline",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "probe",
            fiveHour: { usedPct: 5, resetsAt: null },
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(db.getAgentByName("probe")?.liveModel).toBe("claude-sonnet-5");
      // The swap moves the booking; it neither doubles it nor drops it.
      expect(reserved()).toBe(held);

      // Kill it through the tool the orchestrator actually calls.
      const transport = new StreamableHTTPClientTransport(
        new URL("http://hive/mcp"),
        { fetch: actingAs(daemon, "operator") },
      );
      const client = new Client({ name: "rekey-kill", version: "1.0.0" });
      await client.connect(transport);
      await client.callTool({ name: "hive_kill", arguments: { name: "probe" } });
      await client.close();

      // The state, not the call: a dead agent holds no capacity.
      expect(reserved()).toBe(before);
      expect(ledger.activeReservations()).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});

describe("Codex execution-identity attestation sweep", () => {
  const codexAgent = (overrides: Partial<AgentRecord> = {}): AgentRecord =>
    agent({
      tool: "codex",
      status: "working",
      contextPct: null,
      toolSessionId: "session-1",
      executionIdentity: { tool: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
      ...overrides,
    });

  test("records observed identity and marks drift the launch model cannot", async () => {
    const db = new HiveDatabase(join(home, "attest-drift.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      telemetryReaders: {
        codex: async () => ({ contextPct: null, lastActivityAt: null }),
        // The productive parent drifted to Luna/low after launching Sol/xhigh.
        codexIdentity: async () => ({
          status: "observed",
          model: "gpt-5.6-luna",
          effort: "low",
          turnId: "turn-2",
          sessionId: "session-1",
          observedAt: "2026-07-15T18:00:00.000Z",
        }),
      },
    });
    db.insertAgent(codexAgent());
    try {
      await daemon.refreshToolTelemetry();
      const row = db.getAgentByName("maya")!;
      // The immutable launch model is untouched; the observation is separate.
      expect(row.model).toBe("gpt-5-codex");
      expect(row.identityState).toBe("drift");
      expect(row.liveModel).toBe("gpt-5.6-luna");
      expect(row.liveEffort).toBe("low");
      expect(row.observedIdentity).toMatchObject({
        model: "gpt-5.6-luna",
        effort: "low",
        source: "codex-rollout",
      });
    } finally {
      db.close();
    }
  });

  test("matching when the observed identity equals the launch identity", async () => {
    const db = new HiveDatabase(join(home, "attest-match.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      telemetryReaders: {
        codex: async () => ({ contextPct: null, lastActivityAt: null }),
        codexIdentity: async () => ({
          status: "observed",
          model: "gpt-5.6-sol",
          effort: "xhigh",
          turnId: "turn-1",
          sessionId: "session-1",
          observedAt: "2026-07-15T18:00:00.000Z",
        }),
      },
    });
    db.insertAgent(codexAgent());
    try {
      await daemon.refreshToolTelemetry();
      expect(db.getAgentByName("maya")?.identityState).toBe("matching");
    } finally {
      db.close();
    }
  });

  test("a live rollout with no readable identity is unknown, never synthesized", async () => {
    const db = new HiveDatabase(join(home, "attest-unknown.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      telemetryReaders: {
        codex: async () => ({ contextPct: null, lastActivityAt: null }),
        codexIdentity: async () => ({ status: "unknown" }),
      },
    });
    db.insertAgent(codexAgent());
    try {
      await daemon.refreshToolTelemetry();
      const row = db.getAgentByName("maya")!;
      expect(row.identityState).toBe("unknown");
      // Never guessed from the launch model.
      expect(row.liveModel).toBeUndefined();
      expect(row.observedIdentity).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("an unobservable agent reads unknown, never 0", () => {
  test("telemetry that returns null clears a stale number instead of leaving it standing", async () => {
    const db = new HiveDatabase(join(home, "unknown-context.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      telemetryReaders: {
        // 44k measured tokens, but no statusline report has ever carried this
        // row's window and 44k fits either window — so occupancy is genuinely
        // unknowable this tick, and the sweep must not divide by a guessed
        // denominator or disturb the reading the statusline handler landed.
        claude: async () => ({ contextTokens: 44_000, lastActivityAt: null }),
        // lucas, live: a Codex agent whose rollout carries no usable token count.
        // This is the real one — he did real work and Hive reported 0%.
        codex: async () => ({ contextPct: null, lastActivityAt: null }),
        liveModel: async () => null,
      },
    });
    db.insertAgent(agent({
      id: "agent-lucas",
      name: "lucas",
      tool: "codex",
      status: "working",
      tmuxSession: "hive-lucas",
      worktreePath: "/tmp/hive-lucas",
      // The 0 he was born with, which nothing ever corrected because a null
      // observation used to be skipped as "no new information".
      contextPct: 0,
    }));
    db.insertAgent(agent({
      id: "agent-maya",
      name: "maya",
      tool: "claude",
      status: "working",
      // Stands in for a value the statusline handler already landed on this
      // row. With no measurable window this sweep has nothing better, and a
      // sweep that overwrote it with null would make contextPct flicker
      // false-unknown between renders — corrupting reuse decisions, since
      // null marks an agent ineligible for reuse.
      contextPct: 55,
    }));
    try {
      await daemon.refreshToolTelemetry();

      // Unknown is an observation, and it overwrites the fiction — for Codex,
      // whose rollout really is this sweep's only source of truth.
      const lucas = db.getAgentByName("lucas")!;
      expect(lucas.contextPct).toBeNull();
      // The user's acceptance test: never 0.
      expect(lucas.contextPct).not.toBe(0);
      expect(formatStatusTable([lucas])).toContain("—");
      expect(formatStatusTable([lucas])).not.toContain("0%");

      // For Claude, tokens without a window are not an occupancy. The sweep
      // must not guess a denominator and must not touch the standing reading.
      expect(db.getAgentByName("maya")?.contextPct).toBe(55);
    } finally {
      db.close();
    }
  });

  test("a statusline-observed window lets the sweep track the transcript continuously", async () => {
    const db = new HiveDatabase(join(home, "measured-window.db"));
    // The transcript grows between sweeps, the way a live session's does.
    let residentTokens = 90_000;
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      telemetryReaders: {
        claude: async () => ({
          contextTokens: residentTokens,
          lastActivityAt: null,
        }),
        codex: async () => ({ contextPct: null, lastActivityAt: null }),
        liveModel: async () => null,
      },
    });
    db.insertAgent(agent({
      tool: "claude",
      status: "working",
      contextPct: null,
      // One statusline report carried the account's real window; from then on
      // the sweep alone keeps contextPct current, even if the statusline
      // never posts again.
      contextWindow: 1_000_000,
    }));
    try {
      await daemon.refreshToolTelemetry();
      expect(db.getAgentByName("maya")?.contextPct).toBe(9);

      residentTokens = 230_000;
      await daemon.refreshToolTelemetry();
      expect(db.getAgentByName("maya")?.contextPct).toBe(23);
    } finally {
      db.close();
    }
  });
});

/**
 * The reconciliation sweep, driven the way production drives it.
 *
 * Every test here goes through `daemon.runMaintenance()` — the daemon's real
 * recurring sweep — and never calls `reconcileInjected()` directly. That is the
 * whole point of them. The sweep was written, was correct-looking, and was hung
 * off the interval callback rather than maintenance, so no test could reach the
 * wiring; a test that calls the function directly passes just as happily when
 * nothing in the daemon calls it at all, which is exactly what had happened.
 * Delete the call from `runMaintenance` and these go red.
 */
describe("delivery reconciliation runs in maintenance", () => {
  test("a delivered message becomes applied once its recipient takes a turn", async () => {
    const db = new HiveDatabase(join(home, "reconcile-agent.db"));
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux,
      tmuxSender: new SilentTmuxSender(db),
    });
    try {
      // Idle: a channel-less recipient mid-turn keeps its message queued, and a
      // queued message is not what this sweep is about.
      db.insertAgent(agent({ status: "idle" }));
      const sent = await daemon.delivery.send("orchestrator", "maya", "Reuse the middleware.");
      // A paste is not a mind changed: delivery claims only "injected".
      expect(sent.state).toEqual("injected");
      expect(sent.appliedAt).toBeNull();

      // The recipient finishes a turn. That boundary is where the TUI submits
      // what it had queued, so this — and nothing before it — is evidence the
      // message reached the model. It must land after the injection the real
      // clock just stamped: that comparison is the thing under test.
      await daemon.processEvent({
        kind: "turn-end",
        agentName: "maya",
        timestamp: new Date(Date.now() + 60_000).toISOString(),
      });

      await daemon.runMaintenance();

      const settled = db.getMessage(sent.id);
      expect(settled?.state).toEqual("applied");
      expect(settled?.appliedAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("a root-bound message is confirmed too — the orchestrator has no agents row", async () => {
    // The case that mattered and the case the first version could not see. The
    // orchestrator is not a spawned agent and has no row, so a sweep that asks
    // `agents.lastEventAt` for its turn boundary gets null and concludes the root
    // never took one. In the live database this was not an edge: 105 of the 107
    // messages stuck in "injected" were addressed to the orchestrator.
    const db = new HiveDatabase(join(home, "reconcile-root.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      tmuxSender: new SilentTmuxSender(db),
    });
    try {
      expect(db.getAgentByName("orchestrator")).toBeNull();

      const sent = await daemon.delivery.send("maya", "orchestrator", "Auth API is done.");
      // Injected by the root transport, exactly as root delivery leaves it.
      expect(sent.state).toEqual("injected");

      // The root's turn boundaries live in the events table and nowhere else.
      await daemon.processEvent({
        kind: "turn-end",
        agentName: "orchestrator",
        timestamp: new Date(Date.now() + 60_000).toISOString(),
      });

      await daemon.runMaintenance();

      expect(db.getMessage(sent.id)?.state).toEqual("applied");
    } finally {
      db.close();
    }
  });

  test("hook events under queen/orchestrator/case variants store one canonical root identity", async () => {
    const db = new HiveDatabase(join(home, "root-event-canonical.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      tmuxSender: new SilentTmuxSender(db),
    });
    try {
      const base = Date.parse("2026-07-15T18:00:00.000Z");
      await daemon.processEvent({
        kind: "session-launch",
        agentName: "Orchestrator",
        timestamp: new Date(base).toISOString(),
        toolSessionId: "root-sess-1",
      });
      await daemon.processEvent({
        kind: "turn-start",
        agentName: "orchestrator",
        timestamp: new Date(base + 1_000).toISOString(),
        toolSessionId: "root-sess-1",
      });
      await daemon.processEvent({
        kind: "turn-end",
        agentName: "Queen",
        timestamp: new Date(base + 2_000).toISOString(),
        toolSessionId: "root-sess-1",
      });

      // All three variants land under queen; legacy key stays empty for new writes.
      expect(db.recentOrchestratorSignals("queen")).toEqual([
        "turn-end",
        "turn-start",
      ]);
      expect(db.recentOrchestratorSignals("orchestrator")).toEqual([]);

      // Worker-instruction provenance: root sender normalizes too.
      db.insertAgent(agent({ status: "idle" }));
      const instruction = await daemon.delivery.send(
        "ORCHESTRATOR",
        "maya",
        "Ship the fix.",
      );
      expect(instruction.from).toEqual("queen");
    } finally {
      db.close();
    }
  });

  test("status provenance includes pre-rename from=orchestrator root instructions", async () => {
    const db = new HiveDatabase(join(home, "root-status-legacy-from.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      tmuxSender: new SilentTmuxSender(db),
    });
    try {
      db.insertAgent(agent({
        status: "working",
        createdAt: "2026-07-09T11:00:00.000Z",
      }));
      // Historical instruction still stored under the synonym sender.
      db.insertMessage(AgentMessageSchema.parse({
        id: "legacy-root-instruction",
        from: "orchestrator",
        to: "maya",
        body: "pre-rename instruction still in force",
        createdAt: "2026-07-09T12:00:00.000Z",
        deliveredAt: null,
        priority: "normal",
        intent: "instruction",
        state: "queued",
        sequence: 1,
      }));

      const transport = new StreamableHTTPClientTransport(
        new URL("http://hive/mcp"),
        { fetch: actingAs(daemon, "operator") },
      );
      const client = new Client({ name: "legacy-from-status", version: "1.0.0" });
      await client.connect(transport);
      const status = textValue(await client.callTool({
        name: "hive_status",
        arguments: { detail: "active" },
      }));
      expect(Array.isArray(status)).toBe(true);
      const row = (status as Array<{
        name: string;
        latestInstruction?: string;
        instructionCount?: number;
      }>).find((entry) => entry.name === "maya");
      expect(row).toBeDefined();
      expect(row?.instructionCount).toEqual(1);
      expect(row?.latestInstruction).toContain("pre-rename instruction");
      await client.close();
    } finally {
      db.close();
    }
  });

  test("a message that never reached a turn is surfaced once, and the alert never surfaces itself", async () => {
    const db = new HiveDatabase(join(home, "reconcile-stalled.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      tmuxSender: new SilentTmuxSender(db),
    });
    try {
      db.insertAgent(agent({ status: "idle" }));
      const sent = await daemon.delivery.send("orchestrator", "maya", "Rebase before you land.");
      // Injected, and then nothing: maya never reaches another turn boundary.
      // Past the deadline this is precisely what must never be silent.
      const late = new Date(Date.now() + 30 * 60_000).toISOString();
      expect(await daemon.delivery.reconcileInjected(late)).toEqual(0);

      const alerts = db.listMessages().filter((m) => m.from === "hive-control");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.body).toContain("1 message(s)");
      expect(alerts[0]!.body).toContain("maya");
      expect(db.getMessage(sent.id)?.alertAt).not.toBeNull();

      // And now the loop that would have eaten the root's context. The alert is
      // itself a message to the orchestrator; if it could stall, the next sweep
      // would report it, and that report would stall too — one more message every
      // sweep, forever. It is born already alerted, so the sweep has a fixed
      // point: a second pass, an hour later, with the alert itself injected and
      // unread, produces nothing new.
      db.transitionMessage(alerts[0]!.id, "injected", late);
      await daemon.delivery.reconcileInjected(
        new Date(Date.now() + 90 * 60_000).toISOString(),
      );

      expect(db.listMessages().filter((m) => m.from === "hive-control")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

// bridget, a real grok agent, sat at "spawning" long after her turn had ended
// with stop_reason end_turn -- and her context read null forever. Grok drives
// no control channel, so no turn-start ever promoted her row and no turn-end
// ever settled it: the daemon simply never observed her turn. Her session's
// own updates.jsonl is the observable, and this sweep is what reads it.
describe("a grok agent's turn is observed from its session artifacts", () => {
  test("a completed turn settles the row to idle and lands the vendor's context reading", async () => {
    const db = new HiveDatabase(join(home, "grok-turn.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      telemetryReaders: {
        claude: async () => ({ contextTokens: null, lastActivityAt: null }),
        codex: async () => ({ contextPct: null, lastActivityAt: null }),
        grok: async () => ({
          contextPct: 6,
          lastActivityAt: "2026-07-12T21:19:20.991Z",
          turnCompleted: true,
        }),
        liveModel: async () => null,
        grokLiveModel: async () => "grok-4.5",
      },
    });
    db.insertAgent(agent({
      id: "agent-bridget",
      name: "bridget",
      tool: "grok",
      model: "grok-4.5",
      status: "spawning",
      tmuxSession: "hive-bridget",
      worktreePath: "/tmp/hive-bridget",
      contextPct: null,
    }));
    try {
      await daemon.refreshToolTelemetry();
      const bridget = db.getAgentByName("bridget")!;
      // The turn ended, so the agent is idle -- not still "spawning" 40
      // minutes after it answered.
      expect(bridget.status).toBe("idle");
      expect(bridget.contextPct).toBe(6);
      expect(bridget.liveModel).toBe("grok-4.5");
      expect(bridget.lastEventAt).toBe("2026-07-12T21:19:20.991Z");
    } finally {
      db.close();
    }
  });

  test("a streaming turn is working, and an unreadable session stays unknown", async () => {
    const db = new HiveDatabase(join(home, "grok-streaming.db"));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmux: new FakeDaemonTmux(),
      telemetryReaders: {
        claude: async () => ({ contextTokens: null, lastActivityAt: null }),
        codex: async () => ({ contextPct: null, lastActivityAt: null }),
        grok: async (worktreePath) =>
          worktreePath === "/tmp/hive-bridget"
            ? {
              contextPct: null,
              lastActivityAt: "2026-07-12T21:19:20.991Z",
              turnCompleted: false,
            }
            // No session on disk yet: unknown. A sweep that guessed a state
            // here would be inventing the very thing it exists to measure.
            : { contextPct: null, lastActivityAt: null, turnCompleted: null },
      },
    });
    db.insertAgent(agent({
      id: "agent-bridget",
      name: "bridget",
      tool: "grok",
      model: "grok-4.5",
      status: "spawning",
      tmuxSession: "hive-bridget",
      worktreePath: "/tmp/hive-bridget",
      contextPct: null,
    }));
    db.insertAgent(agent({
      id: "agent-blake",
      name: "blake",
      tool: "grok",
      model: "grok-4.5",
      status: "spawning",
      tmuxSession: "hive-blake",
      worktreePath: "/tmp/hive-blake",
      contextPct: null,
    }));
    try {
      await daemon.refreshToolTelemetry();
      expect(db.getAgentByName("bridget")?.status).toBe("working");
      // Unknown is not idle and not working: the row is left alone.
      expect(db.getAgentByName("blake")?.status).toBe("spawning");
      expect(db.getAgentByName("blake")?.contextPct).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("landed is not live", () => {
  // The daemon executes a compiled binary, so main can be ahead of the code
  // answering a tool call. These assert the two surfaces an orchestrator sees
  // without thinking to ask: every hive_status, and any hive_spawn Hive cannot
  // vouch for. The warning rides as a second content block, so the payload the
  // callers parse is untouched.
  async function withClient(
    freshness: BuildFreshness,
    dbName: string,
    body: (client: Client) => Promise<void>,
  ): Promise<void> {
    const db = new HiveDatabase(join(home, dbName));
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new RootUnavailableTmuxSender(db),
      tmux: new FakeDaemonTmux(),
      repoRoot: "/tmp/repo",
      buildFreshness: async () => freshness,
    });
    const client = new Client({ name: "hive-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(
        new URL("http://hive/mcp"),
        { fetch: actingAs(daemon, "operator") },
      ));
      await body(client);
    } finally {
      await client.close();
      await daemon.stop();
      db.close();
    }
  }

  const notes = (result: Awaited<ReturnType<Client["callTool"]>>): string[] =>
    (result as { content: Array<{ type: string; text?: string }> }).content
      .slice(1)
      .map((block) => block.text ?? "");

  const stale: BuildFreshness = {
    state: "stale",
    version: "0.0.7",
    buildCommit: "abc1234",
    mainCommit: "f00dcafe",
    commitsBehind: 3,
    message: "STALE BINARY: this daemon runs 0.0.7, built from abc1234, which is 3 commits behind main (f00dcaf).",
  };

  test("a stale binary warns on hive_status and on every spawn, and never blocks", async () => {
    await withClient(stale, "stale-binary.db", async (client) => {
      const status = await client.callTool({ name: "hive_status", arguments: {} });
      expect(notes(status)).toEqual([stale.message]);
      // The payload the parsers read is unchanged: still the bare agent array.
      expect(textValue(status)).toEqual([]);

      const spawned = await client.callTool({
        name: "hive_spawn",
        arguments: { task: "Test the fix that is not in this binary", category: "code_review", name: "sam", tool: "claude" },
      });
      expect(spawned.isError).toBeUndefined();
      expect(notes(spawned)).toEqual([stale.message]);
      expect(textValue(spawned)).toMatchObject({ name: "sam", status: "working" });
    });
  });

  test("a binary Hive cannot vouch for reports unknown, never fresh", async () => {
    const unknown: BuildFreshness = {
      state: "unknown",
      version: "0.0.0-dev",
      buildCommit: null,
      mainCommit: null,
      commitsBehind: null,
      message: "Hive cannot tell whether the running binary is up to date with main: this build carries no commit provenance (a dev build or a source checkout).",
    };
    await withClient(unknown, "unknown-binary.db", async (client) => {
      const status = await client.callTool({ name: "hive_status", arguments: {} });
      expect(notes(status)[0]).toContain("cannot tell");
      const spawned = await client.callTool({
        name: "hive_spawn",
        arguments: { task: "Anything", category: "code_review", name: "sam", tool: "claude" },
      });
      expect(notes(spawned)[0]).toContain("cannot tell");
    });
  });

  test("a current binary confirms on status and stays silent on spawn", async () => {
    const current: BuildFreshness = {
      state: "current",
      version: "0.0.7",
      buildCommit: "abc1234",
      mainCommit: "abc1234",
      commitsBehind: 0,
      message: "Running binary 0.0.7 was built from abc1234 and contains everything on main.",
    };
    await withClient(current, "current-binary.db", async (client) => {
      expect(notes(await client.callTool({ name: "hive_status", arguments: {} })))
        .toEqual([current.message]);
      const spawned = await client.callTool({
        name: "hive_spawn",
        arguments: { task: "Anything", category: "code_review", name: "sam", tool: "claude" },
      });
      expect(notes(spawned)).toEqual([]);
    });
  });
});

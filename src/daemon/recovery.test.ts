import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import { submitPaste } from "./testing";
import { MessageDelivery, type TmuxSender } from "./delivery";
import {
  CrashRecovery,
  MAX_AUTO_RESUME_ATTEMPTS,
  type CrashRecoveryDependencies,
} from "./recovery";
import { verifiedAgentStop } from "./teardown";
import { authorizeForQuotaTest } from "./authorized-launch.test-support";

const timestamp = "2026-07-10T09:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "claude",
    model: "claude-fable-5",
    executionIdentity: {
      tool: "claude",
      model: "claude-fable-5",
      effort: "high",
    },
    category: "simple_coding",
    status: "working",
    taskDescription: "Build the server",
    worktreePath: "/repo/.hive/worktrees/maya",
    branch: "hive/maya-server",
    tmuxSession: "hive-maya",
    contextPct: 40,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

class FakeTmux {
  readonly sessions = new Set<string>();
  readonly created: { name: string; cwd: string; command: string }[] = [];
  readonly killed: string[] = [];
  panes = new Map<string, string>();
  panePids = new Map<string, number[]>();
  failNewSession = false;

  async hasSession(session: string): Promise<boolean> {
    return this.sessions.has(session);
  }

  async newSession(name: string, cwd: string, command: string): Promise<void> {
    if (this.failNewSession) {
      throw new Error("tmux new-session failed: boom");
    }
    this.created.push({ name, cwd, command });
    this.sessions.add(name);
  }

  async killSession(session: string): Promise<void> {
    this.killed.push(session);
    this.sessions.delete(session);
  }

  async capturePane(session: string): Promise<string> {
    return this.panes.get(session) ?? "";
  }

  async listPanePids(session: string): Promise<number[]> {
    return this.panePids.get(session) ?? [];
  }
}

class SilentSender implements TmuxSender {
  readonly sent: { session: string; text: string }[] = [];
  constructor(private readonly db: HiveDatabase) {}
  async sendMessage(session: string, text: string): Promise<void> {
    this.sent.push({ session, text });
    submitPaste(this.db, session);
  }
}

interface Harness {
  db: HiveDatabase;
  tmux: FakeTmux;
  sender: SilentSender;
  recovery: CrashRecovery;
  settled: string[];
  revoked: string[];
  /** The hardened resume monitor fails a resume that never proves life, so
   * every successful-resume test must call this before resuming: it makes
   * each readiness poll tick advance lastEventAt, standing in for the
   * relaunched process's first hook event. Failure-path tests leave the
   * default signal-free sleep so exhaustion stays honest. */
  signalProofOfLife: () => void;
}

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hive-recovery-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function harness(
  overrides: Partial<CrashRecoveryDependencies> = {},
): Harness {
  const db = new HiveDatabase(join(home, `${crypto.randomUUID()}.db`));
  const tmux = new FakeTmux();
  const sender = new SilentSender(db);
  const delivery = new MessageDelivery(db, sender);
  const settled: string[] = [];
  const revoked: string[] = [];
  let proveLife = false;
  const recovery = new CrashRecovery({
    db,
    tmux,
    authorizeLaunch: async (identity) =>
      (await authorizeForQuotaTest([identity]))[0]!,
    port: 4483,
    send: (from, to, body, options) => delivery.send(from, to, body, options),
    settleQuota: async (record) => {
      settled.push(record.name);
    },
    stopSession: async (record) => {
      await tmux.killSession(record.tmuxSession);
      return { killed: [], survivors: [] };
    },
    flushQueued: (name) => delivery.flushQueued(name),
    revokeCapabilities: (name) => {
      revoked.push(name);
    },
    resolveClaudeSessionId: async () => null,
    resolveCodexSessionId: async () => null,
    resolveGrokSessionId: async () => null,
    worktreeExists: () => true,
    sleep: async () => {
      if (!proveLife) return;
      for (const record of db.listAgents()) {
        db.upsertAgent({
          ...record,
          lastEventAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
    },
    // Synthetic worktrees: the real config writers would hit the filesystem
    // (and fail the resume, by design), so the harness stubs them out.
    seedClaudeTrust: async () => {},
    writeClaudeConfig: async () => {},
    writeCodexConfig: async () => {},
    writeGrokConfig: async () => {},
    ...overrides,
  });
  return {
    db,
    tmux,
    sender,
    recovery,
    settled,
    revoked,
    signalProofOfLife: () => {
      proveLife = true;
    },
  };
}

function orchestratorAlerts(db: HiveDatabase): string[] {
  return db.listMessages()
    .filter((message) =>
      message.to === "queen" && message.from === "hive-recovery"
    )
    .map((message) => message.body);
}

// Claude resumes pre-accept folder trust in ~/.claude.json. Point HOME at a
// throwaway directory so the suite never writes to the operator's real config.
let previousHome: string | undefined;
let claudeHomeRoot = "";

beforeAll(() => {
  claudeHomeRoot = mkdtempSync(join(tmpdir(), "hive-recovery-home-"));
  previousHome = Bun.env.HOME;
  Bun.env.HOME = claudeHomeRoot;
});

afterAll(() => {
  if (previousHome === undefined) {
    delete Bun.env.HOME;
  } else {
    Bun.env.HOME = previousHome;
  }
  if (claudeHomeRoot !== "") {
    rmSync(claudeHomeRoot, { recursive: true, force: true });
  }
});

describe("crash classification", () => {
  test("a spawning agent with a vanished session is died-during-spawn: dead, worktree kept, task surfaced", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "spawning" }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toEqual([{
      agent: "maya",
      action: "marked-dead",
      reason: "process died during spawn (crash recovery)",
    }]);
    expect(h.db.getAgentByName("maya")).toMatchObject({
      status: "dead",
      worktreePath: "/repo/.hive/worktrees/maya",
    });
    // No resume was ever attempted for a session that never produced work.
    expect(h.tmux.created).toEqual([]);
    const alerts = orchestratorAlerts(h.db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Build the server");
    expect(alerts[0]).toContain("Worktree preserved");
    expect(h.settled).toEqual(["maya"]);
  });

  test("a spawning agent whose name is still reserved is an in-flight spawn and is left alone", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "spawning" }));
    h.db.reserveAgentName("maya");

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toEqual([]);
    expect(h.db.getAgentByName("maya")?.status).toEqual("spawning");
  });

  test("an agent whose session is still running is untouched", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "working" }));
    h.tmux.sessions.add("hive-maya");

    expect(await h.recovery.sweep()).toEqual([]);
    expect(h.db.getAgentByName("maya")?.status).toEqual("working");
  });

  test("a fail-closed critical control is never converted into death or a resume", async () => {
    const h = harness();
    const message = h.db.insertMessage({
      id: "control-1",
      from: "orchestrator",
      to: "maya",
      body: "stop",
      createdAt: timestamp,
      deliveredAt: null,
      priority: "critical",
      intent: "stop",
      state: "queued",
      injectedAt: null,
      acknowledgedAt: null,
      appliedAt: null,
      deadlineAt: null,
      alertAt: null,
      sequence: 1,
      idempotencyKey: null,
      capabilityEpoch: 1,
    });
    h.db.insertAgent(agent({
      status: "control-paused",
      writeRevoked: true,
      controlMessageId: message.id,
    }));

    expect(await h.recovery.sweep()).toEqual([]);
    expect(h.db.getAgentByName("maya")?.status).toEqual("control-paused");
  });

  test("a control-paused agent without a queued control dies without a resume", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "control-paused", writeRevoked: true }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toMatchObject([{ agent: "maya", action: "marked-dead" }]);
    expect(h.tmux.created).toEqual([]);
    expect(h.db.getAgentByName("maya")?.status).toEqual("dead");
  });

  test("terminal agents are ignored", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "dead" }));
    h.db.insertAgent(agent({
      id: "agent-david",
      name: "david",
      status: "done",
      tmuxSession: "hive-david",
    }));

    expect(await h.recovery.sweep()).toEqual([]);
  });

  test("a missing worktree makes active work unresumable: dead with the reason recorded", async () => {
    const h = harness({ worktreeExists: () => false });
    h.db.insertAgent(agent({ status: "working", toolSessionId: "sess-1" }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toEqual([{
      agent: "maya",
      action: "marked-dead",
      reason: "worktree is missing; session not resumable",
    }]);
  });

  test("active work with no discoverable tool session is unresumable", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "working" }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toEqual([{
      agent: "maya",
      action: "marked-dead",
      reason: "no resumable tool session was found for this worktree",
    }]);
  });
});

describe("crash resume", () => {
  test("a claude agent with a recorded session id is relaunched with --resume in the same worktree", async () => {
    const h = harness();
    h.signalProofOfLife();
    h.db.insertAgent(agent({
      status: "working",
      toolSessionId: "0189-claude-session",
      executionIdentity: {
        tool: "claude",
        model: "claude-fable-5",
        effort: "high",
      },
    }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toEqual([{
      agent: "maya",
      action: "resumed",
      sessionId: "0189-claude-session",
    }]);
    expect(h.tmux.created).toHaveLength(1);
    expect(h.tmux.created[0]!.name).toEqual("hive-maya");
    expect(h.tmux.created[0]!.cwd).toEqual("/repo/.hive/worktrees/maya");
    expect(h.tmux.created[0]!.command).toContain("claude");
    expect(h.tmux.created[0]!.command).toContain("--resume");
    expect(h.tmux.created[0]!.command).toContain("0189-claude-session");
    expect(h.tmux.created[0]!.command).toContain("--model");
    expect(h.tmux.created[0]!.command).toContain("'--effort' 'high'");

    const record = h.db.getAgentByName("maya");
    expect(record).toMatchObject({
      status: "idle",
      recoveryAttempts: 1,
      toolSessionId: "0189-claude-session",
    });
    // The resumed tmux session receives the recovery notice.
    expect(h.sender.sent.some(({ session, text }) =>
      session === "hive-maya" && text.includes("resumed your tool session")
    )).toBe(true);
    expect(orchestratorAlerts(h.db).some((body) =>
      body.includes("Resumed maya after a crash")
    )).toBe(true);
  });

  test("a codex agent resumes through `codex resume <thread-id>` with its spawn config overrides", async () => {
    // The resumed codex TUI emits no hook event before its first turn-end;
    // fresh rollout-file activity is its proof of life, injected here.
    const h = harness({
      readCodexActivity: async () =>
        new Date(Date.now() + 60_000).toISOString(),
    });
    h.db.insertAgent(agent({
      tool: "codex",
      model: "gpt-5-codex",
      status: "working",
      toolSessionId: "019f-codex-thread",
      executionIdentity: {
        tool: "codex",
        model: "gpt-5-codex",
        effort: "high",
      },
    }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toMatchObject([{ agent: "maya", action: "resumed" }]);
    const command = h.tmux.created[0]!.command;
    expect(command).toContain("codex");
    expect(command).toContain("resume");
    expect(command).toContain("019f-codex-thread");
    expect(command).toContain("model_reasoning_effort=high");
    expect(command).toContain("workspace-write");
  });

  test("a resume resolves the daemon port after an ephemeral bind", async () => {
    let daemonPort = 0;
    let configuredPort: number | undefined;
    const h = harness({
      port: () => daemonPort,
      writeCodexConfig: async (_worktreePath, options) => {
        configuredPort = options.daemonPort;
      },
      readCodexActivity: async () =>
        new Date(Date.now() + 60_000).toISOString(),
    });
    h.db.insertAgent(agent({
      tool: "codex",
      model: "gpt-5-codex",
      status: "working",
      toolSessionId: "019f-dynamic-port",
      executionIdentity: {
        tool: "codex",
        model: "gpt-5-codex",
        effort: "high",
      },
    }));

    daemonPort = 43_219;
    const outcomes = await h.recovery.sweep();

    expect(outcomes).toMatchObject([{ agent: "maya", action: "resumed" }]);
    expect(configuredPort).toBe(43_219);
    expect(h.tmux.created[0]?.command).toContain(
      'mcp_servers.hive.url="http://127.0.0.1:43219/mcp"',
    );
  });

  test("a Grok agent resumes the exact session with current flags and compatibility isolation", async () => {
    const h = harness();
    h.signalProofOfLife();
    h.db.insertAgent(agent({
      tool: "grok",
      model: "catalog-model",
      status: "working",
      toolSessionId: "019f-grok-session",
      executionIdentity: {
        tool: "grok",
        model: "catalog-model",
        effort: "high",
        cliVersion: "fixture-version",
        cliBuildHash: "fixture-build",
      },
    }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toMatchObject([{ agent: "maya", action: "resumed" }]);
    const command = h.tmux.created[0]!.command;
    expect(command).toContain("GROK_CLAUDE_SKILLS_ENABLED=false");
    expect(command).toContain("'grok' '-r' '019f-grok-session'");
    expect(command).toContain("'--reasoning-effort' 'high'");
    expect(command).toContain("'--always-approve'");
    expect(command).not.toContain("--session-id");
  });

  test("a session id discovered on disk is used and persisted when none was captured", async () => {
    const h = harness({
      resolveClaudeSessionId: async (worktreePath) =>
        worktreePath === "/repo/.hive/worktrees/maya" ? "disk-session" : null,
    });
    h.signalProofOfLife();
    h.db.insertAgent(agent({ status: "working" }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toEqual([{
      agent: "maya",
      action: "resumed",
      sessionId: "disk-session",
    }]);
    expect(h.db.getAgentByName("maya")?.toolSessionId).toEqual("disk-session");
  });

  test("ambiguous session evidence preserves the agent without declaring its state dead", async () => {
    let observedCreatedAt: string | undefined;
    const h = harness({
      resolveClaudeSessionId: async (_worktreePath, agentCreatedAt) => {
        observedCreatedAt = agentCreatedAt;
        throw new Error("ambiguous recovery artifacts");
      },
    });
    h.db.insertAgent(agent({ status: "working" }));

    const outcomes = await h.recovery.sweep();

    expect(observedCreatedAt).toEqual(timestamp);
    expect(outcomes).toEqual([{
      agent: "maya",
      action: "skipped",
      reason: "session discovery refused: ambiguous recovery artifacts",
    }]);
    expect(h.db.getAgentByName("maya")).toMatchObject({
      status: "stuck",
      writeRevoked: true,
      failureReason: "session discovery refused: ambiguous recovery artifacts",
    });
    expect(h.settled).toEqual([]);
    expect(h.revoked).toEqual(["maya"]);
    expect(await h.recovery.sweep()).toEqual([{
      agent: "maya",
      action: "skipped",
      reason: "write authority is revoked; recovery requires explicit cleanup",
    }]);
  });

  test("manual recovery resumes a read-only agent as a reader", async () => {
    let configuredReadOnly: boolean | undefined;
    const h = harness({
      writeClaudeConfig: async (_worktreePath, options) => {
        configuredReadOnly = options.readOnly;
      },
    });
    h.signalProofOfLife();
    h.db.insertAgent(agent({
      status: "dead",
      readOnly: true,
      writeRevoked: false,
      toolSessionId: "reader-session",
    }));

    const outcome = await h.recovery.recoverAgent("maya");

    expect(outcome).toEqual({
      agent: "maya",
      action: "resumed",
      sessionId: "reader-session",
    });
    expect(h.db.getAgentByName("maya")).toMatchObject({
      status: "idle",
      readOnly: true,
      writeRevoked: false,
    });
    expect(configuredReadOnly).toBe(true);
  });

  test("the auto-resume attempt cap converts a crash-looping agent into an explicit death", async () => {
    const h = harness();
    h.db.insertAgent(agent({
      status: "working",
      toolSessionId: "sess-1",
      recoveryAttempts: MAX_AUTO_RESUME_ATTEMPTS,
    }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toEqual([{
      agent: "maya",
      action: "marked-dead",
      reason:
        `crash recovery gave up after ${MAX_AUTO_RESUME_ATTEMPTS} resume attempts`,
    }]);
    expect(h.tmux.created).toEqual([]);
  });

  test("a resume whose process dies during the readiness watch falls back to death", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "working", toolSessionId: "sess-1" }));
    // The relaunch starts, then the session evaporates before readiness.
    const tmux = h.tmux;
    const originalNewSession = tmux.newSession.bind(tmux);
    tmux.newSession = async (name, cwd, command) => {
      await originalNewSession(name, cwd, command);
      tmux.sessions.delete(name);
    };

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toEqual([{
      agent: "maya",
      action: "marked-dead",
      reason: "resume launch failed: tmux session exited",
    }]);
    expect(h.db.getAgentByName("maya")).toMatchObject({
      status: "dead",
      recoveryAttempts: 1,
    });
  });

  test("a resume that prints a launch failure signature is killed and marked dead", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "working", toolSessionId: "sess-1" }));
    h.tmux.panes.set("hive-maya", "Error: No conversation found with session ID sess-1");

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toMatchObject([{ agent: "maya", action: "marked-dead" }]);
    expect(h.tmux.killed).toContain("hive-maya");
    expect(h.db.getAgentByName("maya")?.status).toEqual("dead");
  });

  test("a failed resume reaps its real process and spares an unrelated process", async () => {
    const owned = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const unrelated = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let stopSession: CrashRecoveryDependencies["stopSession"];
    const h = harness({
      stopSession: (record) => stopSession!(record),
    });
    stopSession = verifiedAgentStop(h.tmux);
    h.db.insertAgent(agent({ status: "working", toolSessionId: "sess-1" }));
    h.tmux.panes.set(
      "hive-maya",
      "Error: No conversation found with session ID sess-1",
    );
    h.tmux.panePids.set("hive-maya", [owned.pid]);
    try {
      expect(() => process.kill(owned.pid, 0)).not.toThrow();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();

      const outcomes = await h.recovery.sweep();

      expect(outcomes).toMatchObject([{ agent: "maya", action: "marked-dead" }]);
      expect(await Promise.race([
        owned.exited,
        Bun.sleep(1_000).then(() => null),
      ])).not.toBeNull();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      owned.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([owned.exited, unrelated.exited]);
    }
  });

  test("a failed resume stays nonterminal when teardown readback fails", async () => {
    const h = harness({
      stopSession: async () => {
        throw new Error("ps verification failed");
      },
    });
    h.db.insertAgent(agent({ status: "working", toolSessionId: "sess-1" }));
    h.tmux.panes.set(
      "hive-maya",
      "Error: No conversation found with session ID sess-1",
    );

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ agent: "maya", action: "skipped" });
    expect((outcomes[0] as { reason: string }).reason).toContain(
      "teardown could not be verified: ps verification failed",
    );
    expect(h.db.getAgentByName("maya")).toMatchObject({
      status: "stuck",
      writeRevoked: true,
    });
    expect(h.settled).toEqual([]);
  });

  test("a resume that never proves life is killed and marked dead", async () => {
    // The relaunched session stays up and prints nothing suspicious, but no
    // hook event and no tool activity ever arrive: exhausting the poll budget
    // is a failed resume, never a silently accepted one.
    const h = harness();
    h.db.insertAgent(agent({ status: "working", toolSessionId: "sess-1" }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toMatchObject([{ agent: "maya", action: "marked-dead" }]);
    const reason =
      (outcomes[0] as { action: "marked-dead"; reason: string }).reason;
    expect(reason).toContain("resume launch failed");
    expect(reason).toContain("no proof of life");
    expect(h.tmux.killed).toContain("hive-maya");
    expect(h.db.getAgentByName("maya")).toMatchObject({
      status: "dead",
      recoveryAttempts: 1,
    });
  });

  test("a failed tmux launch settles into death instead of throwing out of the sweep", async () => {
    const h = harness();
    h.tmux.failNewSession = true;
    h.db.insertAgent(agent({ status: "working", toolSessionId: "sess-1" }));

    const outcomes = await h.recovery.sweep();

    expect(outcomes).toEqual([{
      agent: "maya",
      action: "marked-dead",
      reason: "resume launch failed: tmux new-session failed: boom",
    }]);
  });

  test("queued messages flush into the resumed idle session", async () => {
    const h = harness();
    h.signalProofOfLife();
    h.db.insertAgent(agent({ status: "working", toolSessionId: "sess-1" }));
    h.db.insertMessage({
      id: "queued-1",
      from: "david",
      to: "maya",
      body: "pull my branch",
      createdAt: timestamp,
      deliveredAt: null,
      priority: "normal",
      intent: "instruction",
      state: "queued",
      injectedAt: null,
      acknowledgedAt: null,
      appliedAt: null,
      deadlineAt: null,
      alertAt: null,
      sequence: 1,
      idempotencyKey: null,
      capabilityEpoch: null,
    });

    await h.recovery.sweep();

    expect(h.sender.sent.some(({ text }) => text.includes("pull my branch")))
      .toBe(true);
    expect(h.db.getMessage("queued-1")?.deliveredAt).not.toBeNull();
  });

  test("stale pending approvals are denied on resume", async () => {
    const h = harness();
    h.signalProofOfLife();
    h.db.insertAgent(agent({ status: "awaiting-approval", toolSessionId: "s1" }));
    h.db.insertApproval({
      id: "approval-1",
      agentName: "maya",
      description: "run npm publish",
      status: "pending",
      createdAt: timestamp,
      resolvedAt: null,
    });

    await h.recovery.sweep();

    expect(h.db.getApproval("approval-1")?.status).toEqual("denied");
    expect(h.db.getAgentByName("maya")?.status).toEqual("idle");
  });
});

describe("dead-path bookkeeping", () => {
  test("death flags queued messages so deadline alarms stop and the alert names them", async () => {
    const h = harness({ worktreeExists: () => false });
    h.db.insertAgent(agent({ status: "working" }));
    h.db.insertMessage({
      id: "urgent-1",
      from: "orchestrator",
      to: "maya",
      body: "urgent check-in",
      createdAt: timestamp,
      deliveredAt: null,
      priority: "urgent",
      intent: "instruction",
      state: "queued",
      injectedAt: null,
      acknowledgedAt: null,
      appliedAt: null,
      deadlineAt: timestamp,
      alertAt: null,
      sequence: 1,
      idempotencyKey: null,
      capabilityEpoch: null,
    });

    await h.recovery.sweep();

    expect(h.db.getMessage("urgent-1")?.alertAt).not.toBeNull();
    expect(orchestratorAlerts(h.db)[0]).toContain(
      "1 queued message(s) were flagged undeliverable",
    );
  });

  test("death denies the agent's pending approvals", async () => {
    const h = harness({ worktreeExists: () => false });
    h.db.insertAgent(agent({ status: "awaiting-approval" }));
    h.db.insertApproval({
      id: "approval-1",
      agentName: "maya",
      description: "run rm -rf",
      status: "pending",
      createdAt: timestamp,
      resolvedAt: null,
    });

    await h.recovery.sweep();

    expect(h.db.getApproval("approval-1")?.status).toEqual("denied");
  });

  test("death revokes the agent's capability subject", async () => {
    const h = harness({ worktreeExists: () => false });
    h.db.insertAgent(agent({ status: "working" }));

    await h.recovery.sweep();

    // Same guarantee as hive_kill and hive_mark_dead: a capability (and its
    // credential file) never outlives its agent through the recovery path.
    expect(h.db.getAgentByName("maya")?.status).toEqual("dead");
    expect(h.revoked).toEqual(["maya"]);
  });
});

describe("manual recovery", () => {
  test("recovers an agent already marked dead — the bring-her-back path", async () => {
    const h = harness();
    h.signalProofOfLife();
    h.db.insertAgent(agent({
      status: "dead",
      toolSessionId: "sess-1",
      failureReason: "tmux session missing (reconciled)",
    }));

    const outcome = await h.recovery.recoverAgent("maya");

    expect(outcome).toEqual({
      agent: "maya",
      action: "resumed",
      sessionId: "sess-1",
    });
    expect(h.db.getAgentByName("maya")?.status).toEqual("idle");
  });

  test("concurrent recoveries of one agent resume exactly once", async () => {
    const h = harness();
    h.signalProofOfLife();
    h.db.insertAgent(agent({
      status: "dead",
      toolSessionId: "sess-1",
      failureReason: "tmux session missing (reconciled)",
    }));

    // A manual `hive recover` racing the maintenance sweep (or a second
    // operator command) must not launch two tmux sessions around the same
    // conversation or double-bump the attempt counter.
    const outcomes = await Promise.all([
      h.recovery.recoverAgent("maya"),
      h.recovery.recoverAgent("maya"),
    ]);

    expect(outcomes.map((outcome) => outcome.action).toSorted())
      .toEqual(["resumed", "skipped"]);
    expect(h.tmux.created).toHaveLength(1);
    expect(h.db.getAgentByName("maya")?.recoveryAttempts).toEqual(1);
  });

  test("bypasses the auto attempt cap because a human asked", async () => {
    const h = harness();
    h.signalProofOfLife();
    h.db.insertAgent(agent({
      status: "dead",
      toolSessionId: "sess-1",
      recoveryAttempts: MAX_AUTO_RESUME_ATTEMPTS + 2,
    }));

    const outcome = await h.recovery.recoverAgent("maya");

    expect(outcome).toMatchObject({ agent: "maya", action: "resumed" });
  });

  test("skips an agent whose session is running", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "working" }));
    h.tmux.sessions.add("hive-maya");

    expect(await h.recovery.recoverAgent("maya")).toEqual({
      agent: "maya",
      action: "skipped",
      reason: "tmux session is running",
    });
  });

  test("refuses done and write-revoked agents", async () => {
    const h = harness();
    h.db.insertAgent(agent({ status: "done" }));
    h.db.insertAgent(agent({
      id: "agent-david",
      name: "david",
      status: "control-paused",
      writeRevoked: true,
      tmuxSession: "hive-david",
    }));

    expect(await h.recovery.recoverAgent("maya")).toMatchObject({
      action: "skipped",
      reason: "agent is done",
    });
    expect((await h.recovery.recoverAgent("david")).action).toEqual("skipped");
  });

  test("throws for an unknown agent", async () => {
    const h = harness();
    expect(h.recovery.recoverAgent("ghost")).rejects.toThrow(
      "Hive agent not found: ghost",
    );
  });
});

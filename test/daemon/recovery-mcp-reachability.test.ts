import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../../src/schemas";
import { HiveDatabase } from "../../src/daemon/db";
import { CrashRecovery } from "../../src/daemon/recovery";
import { authorizeForQuotaTest } from "./authorized-launch.test-support";

/**
 * #57, the launch-side refusal at resume. The proof-of-life watch measures
 * *acting* — a redrawing pane, a held process — and an agent whose hive MCP
 * failed produces both while being permanently unable to hive_send,
 * hive_inbox, or hive_land. These tests drive a full resume: the watch is
 * made to pass (an advancing event timestamp, exactly what a working agent
 * emits), and only the reporting channel varies. The negative control is the
 * whole point: a probe that cannot see failure would pass both arms.
 */

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hive-recovery-mcp-"));
  process.env.HIVE_HOME = home;
});

afterEach(() => {
  delete process.env.HIVE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function agent(): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "simple_coding",
    status: "working",
    taskDescription: "Build the server",
    worktreePath: join(home, "worktree"),
    branch: "hive/maya-server",
    contextPct: 40,
    createdAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    // A known session id skips discovery, so the sweep exercises the resume
    // path itself — which is where the reachability refusal lives.
    toolSessionId: "session-1",
    executionIdentity: { tool: "codex", model: "gpt-5.6-sol", effort: "medium" },
    sessionLocator: {
      schemaVersion: 1,
      instanceId: "test-instance",
      subject: { kind: "agent", agentId: "agent-maya" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-00000000010a",
      hostKind: "sessiond",
      engineBuildId: "test-engine",
    },
  };
}

function deps(
  db: HiveDatabase,
  sessions: { created: { name: string; command: string }[] },
  over: Record<string, unknown>,
) {
  return {
    db,
    terminalHost: {
      // No live session anywhere: the agent reads as crashed, so the sweep
      // resumes it. The proof-of-life watch never reaches the pane because
      // the hook-event signal below fires first.
      async inspect() {
        return { presence: "exited", diagnosticIds: [] };
      },
    },
    createRecoverySession: async (agent: AgentRecord, command: string) => {
      sessions.created.push({ name: agent.name, command });
    },
    stopSession: async () => ({ survivors: [] }),
    port: 4483,
    send: async () => {},
    settleQuota: async () => {},
    flushQueued: async () => {},
    worktreeExists: () => true,
    sleep: async () => {},
    seedClaudeTrust: async () => {},
    writeClaudeConfig: async () => {},
    writeCodexConfig: async () => {},
    ...over,
  } as unknown as ConstructorParameters<typeof CrashRecovery>[0];
}

/** Make the proof-of-life watch pass: every read of the row shows a newer
 * event timestamp than the read before it, exactly what a working agent's
 * hook traffic bumps — so the baseline read and the watch's first poll
 * always compare correctly no matter how many reads happen in between. */
function agentReportsLife(db: HiveDatabase): void {
  const read = db.getAgentById.bind(db);
  let calls = 0;
  db.getAgentById = (id: string) => {
    const record = read(id);
    calls += 1;
    if (record === null) return null;
    return {
      ...record,
      lastEventAt: new Date(Date.now() + calls * 1_000).toISOString(),
    };
  };
}

describe("hive MCP reachability at resume (#57)", () => {
  test("a resume whose hive MCP never answers is refused loudly, not recorded healthy", async () => {
    const db = new HiveDatabase(join(home, "mcp-dead.db"));
    db.insertAgent(agent());
    agentReportsLife(db);
    const sessions: { created: { name: string; command: string }[] } = {
      created: [],
    };
    const recovery = new CrashRecovery({
      authorizeLaunch: async (identity) =>
        (await authorizeForQuotaTest([identity]))[0]!,
      ...deps(db, sessions, {
        // The dead port: nothing the agent reports can ever arrive.
        mcpClientSeen: () => false,
        mcpReportingTimeoutMs: 0,
      }),
    });

    const outcomes = await recovery.sweep();

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0]!;
    expect(outcome.action).toBe("marked-dead");
    if (outcome.action !== "marked-dead") {
      throw new Error(`expected marked-dead, got ${outcome.action}`);
    }
    expect(outcome.reason).toContain("hive MCP unreachable");
    expect(outcome.reason).toContain("maya");
    // The mute agent was torn down, not left burning quota looking healthy.
    expect(db.getAgentById("agent-maya")?.status).toBe("dead");
    db.close();
  });

  test("a resume whose credential reports is recorded as resumed", async () => {
    const db = new HiveDatabase(join(home, "mcp-live.db"));
    db.insertAgent(agent());
    agentReportsLife(db);
    const sessions: { created: { name: string; command: string }[] } = {
      created: [],
    };
    const recovery = new CrashRecovery({
      authorizeLaunch: async (identity) =>
        (await authorizeForQuotaTest([identity]))[0]!,
      ...deps(db, sessions, {
        mcpClientSeen: () => true,
        mcpReportingTimeoutMs: 0,
      }),
    });

    const outcomes = await recovery.sweep();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.action).toBe("resumed");
    db.close();
  });
});

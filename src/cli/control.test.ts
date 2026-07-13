import { describe, expect, test } from "bun:test";
import type { KillSessionOptions } from "../adapters/tmux";
import type { AgentRecord } from "../schemas";
import { stopAgentSessions } from "./control";
import { agentTmuxSession, orchestratorTmuxSession } from "../daemon/tmux-sessions";

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(
  name: string,
  status: AgentRecord["status"],
): AgentRecord {
  return {
    id: `agent-${name}`,
    name,
    tool: "codex",
    model: "gpt-test",
    category: "simple_coding",
    status,
    taskDescription: `Task for ${name}`,
    worktreePath: `/tmp/${name}`,
    branch: `hive/${name}-task`,
    tmuxSession: `hive-${name}`,
    contextPct: 0,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: false,
  };
}

class FakeStopTmux {
  readonly killed: string[] = [];

  constructor(readonly sessions: string[]) {}

  async listSessions(): Promise<string[]> {
    return this.sessions;
  }

  async killSession(
    session: string,
    _options?: KillSessionOptions,
  ): Promise<void> {
    this.killed.push(session);
  }
}

describe("hive stop agent sessions", () => {
  test("kills live daemon agents and marks each row dead after its session", async () => {
    const tmux = new FakeStopTmux([]);
    const marked: string[] = [];
    const stopped = await stopAgentSessions(4317, {
      tmux,
      fetchAgents: async () => [
        agent("maya", "working"),
        agent("sam", "idle"),
        agent("david", "done"),
      ],
      markDead: async (_port, name) => {
        expect(tmux.killed).toContain(`hive-${name}`);
        marked.push(name);
      },
    });

    expect(stopped).toEqual(2);
    expect(tmux.killed).toEqual(["hive-maya", "hive-sam"]);
    expect(marked).toEqual(["maya", "sam"]);
  });

  test("falls back to every hive-prefixed tmux session when daemon is unreachable", async () => {
    const tmux = new FakeStopTmux([
      "hive-maya",
      "unrelated",
      "hive-stale-agent",
      "also-unrelated",
    ]);
    let marked = false;
    const stopped = await stopAgentSessions(4317, {
      tmux,
      fetchAgents: () => Promise.reject(new Error("daemon unreachable")),
      markDead: async () => {
        marked = true;
      },
    });

    expect(stopped).toEqual(2);
    expect(tmux.killed).toEqual(["hive-maya", "hive-stale-agent"]);
    expect(marked).toEqual(false);
  });

  test("scratch stop targets only sessions scoped to its HIVE_HOME", async () => {
    const scratch = "/tmp/hive-scratch-stop";
    const other = "/tmp/hive-real-instance";
    const ownAgent = agentTmuxSession("maya", scratch);
    const ownOrchestrator = orchestratorTmuxSession(scratch);
    const tmux = new FakeStopTmux([
      ownAgent,
      ownOrchestrator,
      agentTmuxSession("sam", other),
      orchestratorTmuxSession(other),
      "hive-orchestrator",
      "hive-legacy-agent",
      "unrelated",
    ]);

    const stopped = await stopAgentSessions(null, { tmux, hiveHome: scratch });

    expect(stopped).toEqual(2);
    expect(tmux.killed).toEqual([ownAgent, ownOrchestrator]);
  });

  test("rejects daemon rows belonging to another instance", async () => {
    const scratch = "/tmp/hive-scratch-daemon";
    const own = agent("maya", "working");
    own.tmuxSession = agentTmuxSession("maya", scratch);
    const foreign = agent("sam", "working");
    foreign.tmuxSession = agentTmuxSession("sam", "/tmp/hive-real-daemon");
    const tmux = new FakeStopTmux([]);

    const stopped = await stopAgentSessions(4317, {
      tmux,
      hiveHome: scratch,
      fetchAgents: async () => [own, foreign],
      markDead: async () => {},
    });

    expect(stopped).toEqual(1);
    expect(tmux.killed).toEqual([own.tmuxSession]);
  });
});

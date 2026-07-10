import { describe, expect, test } from "bun:test";
import type { KillSessionOptions } from "../adapters/tmux";
import type { AgentRecord } from "../schemas";
import { stopAgentSessions } from "./control";

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
    tier: "standard",
    status,
    taskDescription: `Task for ${name}`,
    worktreePath: `/tmp/${name}`,
    branch: `hive/${name}-task`,
    tmuxSession: `hive-${name}`,
    contextPct: 0,
    createdAt: timestamp,
    lastEventAt: timestamp,
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
});

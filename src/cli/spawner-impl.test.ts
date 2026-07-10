import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalAdapter } from "../adapters/terminal";
import type { AgentRecord, Route, RoutingTier } from "../schemas";
import {
  HiveSpawner,
  NAME_POOL,
  selectAgentName,
} from "../daemon/spawner-impl";

const timestamp = "2026-07-09T12:00:00.000Z";
const tempRoots: string[] = [];

function agent(
  name: string,
  status: AgentRecord["status"] = "working",
): AgentRecord {
  return {
    id: `agent-${name}`,
    name,
    tool: "codex",
    model: "gpt-test",
    tier: "standard",
    status,
    taskDescription: "Test task",
    worktreePath: `/tmp/${name}`,
    branch: `hive/${name}-test`,
    tmuxSession: `hive-${name}`,
    contextPct: 0,
    createdAt: timestamp,
    lastEventAt: timestamp,
  };
}

class FakeStore {
  readonly agents: AgentRecord[];

  constructor(agents: AgentRecord[] = []) {
    this.agents = [...agents];
  }

  listAgents(): AgentRecord[] {
    return [...this.agents];
  }

  insertAgent(record: AgentRecord): AgentRecord {
    const index = this.agents.findIndex((candidate) =>
      candidate.id === record.id
    );
    if (index === -1) {
      this.agents.push(record);
    } else {
      this.agents[index] = record;
    }
    return record;
  }
}

class FakeTmux {
  readonly sessions: Array<[string, string, string]> = [];

  async newSession(name: string, cwd: string, command: string): Promise<void> {
    this.sessions.push([name, cwd, command]);
  }
}

class FakeTerminal implements TerminalAdapter {
  readonly windows: Array<[string, string]> = [];

  async openWindow(session: string, title: string): Promise<void> {
    this.windows.push([session, title]);
  }
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("HiveSpawner name pool", () => {
  test("selects the first name not held by a live agent", () => {
    expect(selectAgentName([
      agent("maya"),
      agent("david", "dead"),
      agent("sam", "done"),
    ])).toEqual("david");
  });

  test("reports exhaustion when every pool name is live", () => {
    expect(() => selectAgentName(NAME_POOL.map((name) => agent(name))))
      .toThrow("name pool exhausted");
  });

  test("fails from the fake database before creating a worktree when exhausted", async () => {
    const store = new FakeStore(NAME_POOL.map((name) => agent(name)));
    let attemptedWorktree = false;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: "/tmp/hive-exhausted",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => ({ tool: "claude", model: "opus" }),
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        attemptedWorktree = true;
        return { path: "/tmp/unused", branch: "hive/unused-task" };
      },
    });

    await expect(spawner.spawn({ task: "One task too many", tier: "deep" }))
      .rejects.toThrow("name pool exhausted");
    expect(attemptedWorktree).toEqual(false);
  });
});

describe("HiveSpawner wiring", () => {
  test("writes tool configs, starts named sessions, opens viewers, and inserts records", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const terminal = new FakeTerminal();
    const routes: Record<"deep" | "standard", Route> = {
      deep: { tool: "claude", model: "opus", effort: "high" },
      standard: { tool: "codex", model: "gpt-test", effort: "medium" },
    };
    const routing = async (tier: RoutingTier): Promise<Route> => {
      if (tier === "deep" || tier === "standard") {
        return routes[tier];
      }
      throw new Error(`Unexpected tier: ${tier}`);
    };
    const createWorktree = async (
      _repoRoot: string,
      name: string,
      slug: string,
    ) => {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      return { path, branch: `hive/${name}-${slug}` };
    };
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing,
      tmux,
      terminal,
      createWorktree,
    });

    const claude = await spawner.spawn({ task: "Build auth API", tier: "deep" });
    const codex = await spawner.spawn({
      task: "Add route tests",
      tier: "standard",
    });

    expect(claude.name).toEqual("maya");
    expect(claude.status).toEqual("spawning");
    expect(claude.contextPct).toEqual(0);
    expect(codex.name).toEqual("david");
    expect(store.agents).toEqual([claude, codex]);
    expect(tmux.sessions.map(([name]) => name)).toEqual([
      "hive-maya",
      "hive-david",
    ]);
    expect(tmux.sessions[0]?.[2]).toContain("'claude' '--model' 'opus'");
    expect(tmux.sessions[0]?.[2]).toContain("You are maya");
    expect(tmux.sessions[1]?.[2]).toContain("'codex'");
    expect(tmux.sessions[1]?.[2]).toContain("notify=");
    expect(tmux.sessions[1]?.[2]).toContain("You are david");
    expect(terminal.windows).toEqual([
      ["hive-maya", "hive-maya"],
      ["hive-david", "hive-david"],
    ]);

    const claudeSettings = await readFile(
      join(root, "maya", ".claude", "settings.local.json"),
      "utf8",
    );
    const codexConfig = await readFile(
      join(root, "david", ".codex", "config.toml"),
      "utf8",
    );
    expect(claudeSettings).toContain("acceptEdits");
    expect(claudeSettings).toContain("hive event session-start --agent maya");
    expect(codexConfig).toContain("http://127.0.0.1:4317/mcp");
  });
});

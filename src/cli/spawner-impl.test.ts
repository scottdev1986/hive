import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalAdapter } from "../adapters/terminal";
import { DEFAULT_ROUTING } from "../schemas";
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

  getAgentById(id: string): AgentRecord | null {
    return this.agents.find((candidate) => candidate.id === id) ?? null;
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
  readonly active = new Set<string>();
  readonly killed: string[] = [];
  hasSessionCalls = 0;
  capturePaneCalls = 0;

  constructor(readonly pane = "") {}

  async newSession(name: string, cwd: string, command: string): Promise<void> {
    this.sessions.push([name, cwd, command]);
    this.active.add(name);
  }

  async hasSession(name: string): Promise<boolean> {
    this.hasSessionCalls += 1;
    return this.active.has(name);
  }

  async capturePane(_name: string): Promise<string> {
    this.capturePaneCalls += 1;
    return this.pane;
  }

  async killSession(name: string): Promise<void> {
    this.killed.push(name);
    this.active.delete(name);
  }
}

class FakeTerminal implements TerminalAdapter {
  readonly windows: Array<[string, string]> = [];

  async openWindow(session: string, title: string): Promise<void> {
    this.windows.push([session, title]);
  }
}

class FlakyCaptureTmux extends FakeTmux {
  override async capturePane(name: string): Promise<string> {
    this.capturePaneCalls += 1;
    if (this.capturePaneCalls === 1) {
      throw new Error(`capture failed for ${name}`);
    }
    return this.pane;
  }
}

class FailingTerminal implements TerminalAdapter {
  async openWindow(_session: string, _title: string): Promise<void> {
    throw new Error("viewer unavailable");
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
      routing: async () => DEFAULT_ROUTING.deep,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        attemptedWorktree = true;
        return { path: "/tmp/unused", branch: "hive/unused-task" };
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({ task: "One task too many", tier: "deep" }))
      .rejects.toThrow("name pool exhausted");
    expect(attemptedWorktree).toEqual(false);
  });

  test("rejects an invalid requested name before creating a worktree", async () => {
    let attemptedWorktree = false;
    const spawner = new HiveSpawner({
      db: new FakeStore(),
      repoRoot: "/tmp/hive-invalid-name",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        attemptedWorktree = true;
        return { path: "/tmp/unused", branch: "hive/unused-task" };
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Bad name",
      tier: "standard",
      name: "1Maya",
    })).rejects.toThrow("must match /^[a-z][a-z0-9-]{1,20}$/");
    expect(attemptedWorktree).toEqual(false);
  });

  test("rejects a requested name held by a live agent", async () => {
    const spawner = new HiveSpawner({
      db: new FakeStore([agent("maya")]),
      repoRoot: "/tmp/hive-collision",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        throw new Error("worktree must not be created");
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Duplicate name",
      tier: "standard",
      name: "MAYA",
    })).rejects.toThrow('"maya" is already assigned to a live agent');
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
      deep: DEFAULT_ROUTING.deep,
      standard: {
        ...DEFAULT_ROUTING.standard,
        codex: { model: "gpt-test", effort: "medium" },
      },
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
      sleep: async () => {},
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
    expect(tmux.sessions[0]?.[2]).toContain("'claude' '--model' 'best'");
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

  test("short-circuits readiness when the persisted status leaves spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-ready-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const store = new FakeStore();
    const tmux = new FakeTmux();
    let polls = 0;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-ready",
      }),
      sleep: async () => {
        polls += 1;
        const current = store.listAgents()[0];
        if (current !== undefined) {
          store.insertAgent({ ...current, status: "working" });
        }
      },
    });

    const spawned = await spawner.spawn({
      task: "Become ready during polling",
      tier: "standard",
    });

    expect(spawned.status).toEqual("working");
    expect(polls).toEqual(1);
    expect(tmux.hasSessionCalls).toEqual(0);
    expect(tmux.capturePaneCalls).toEqual(0);
    expect(tmux.killed).toEqual([]);
  });

  test("honors requested names and applies cross-vendor tool overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-override-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
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
      config: { terminal: "auto", headless: true },
      routing: async (tier) => DEFAULT_ROUTING[tier],
      tmux,
      terminal: new FakeTerminal(),
      createWorktree,
      sleep: async () => {},
    });

    const claude = await spawner.spawn({
      task: "Use Claude",
      tier: "standard",
      name: "Quinn-2",
      tool: "claude",
    });
    const codex = await spawner.spawn({
      task: "Use Codex",
      tier: "deep",
      name: "Riley",
      tool: "codex",
    });

    expect(claude.name).toEqual("quinn-2");
    expect(claude.tool).toEqual("claude");
    expect(claude.model).toEqual("sonnet");
    expect(tmux.sessions[0]?.[2]).toContain("'claude'");
    expect(tmux.sessions[0]?.[2]).toContain("'--model' 'sonnet'");
    expect(codex.name).toEqual("riley");
    expect(codex.tool).toEqual("codex");
    expect(codex.model).toEqual("default");
    expect(tmux.sessions[1]?.[2]).toContain(
      "'model_reasoning_effort=high'",
    );
    expect(tmux.sessions[1]?.[2]).not.toContain("'model=default'");
  });

  test("uses the cheap Claude model for an explicit Claude override", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-cheap-claude-"));
    tempRoots.push(root);
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      db: new FakeStore(),
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.cheap,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: async () => {},
    });

    const spawned = await spawner.spawn({
      task: "Use cheap Claude",
      tier: "cheap",
      tool: "claude",
    });

    expect(spawned.tool).toEqual("claude");
    expect(spawned.model).toEqual("haiku");
    expect(tmux.sessions[0]?.[2]).toContain("'--model' 'haiku'");
  });

  test("uses the tier's configured tool and its model without an override", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-configured-route-"));
    tempRoots.push(root);
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      db: new FakeStore(),
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.review,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: async () => {},
    });

    const spawned = await spawner.spawn({
      task: "Use configured review route",
      tier: "review",
    });

    expect(spawned.tool).toEqual("claude");
    expect(spawned.model).toEqual("sonnet");
    expect(tmux.sessions[0]?.[2]).toContain("'--model' 'sonnet'");
  });

  test("marks pane errors failed, cleans up, and never opens a viewer", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-failed-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const pane = [
      ...Array.from({ length: 16 }, (_, index) => `startup line ${index + 1}`),
      "Error: model not supported for this account",
    ].join("\n");
    const store = new FakeStore();
    const tmux = new FakeTmux(pane);
    const terminal = new FakeTerminal();
    const removals: Array<[string, string]> = [];
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal,
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-failing-launch",
      }),
      removeWorktree: async (repoRoot, path) => {
        removals.push([repoRoot, path]);
      },
      sleep: async () => {},
    });

    const failed = await spawner.spawn({
      task: "Fail at startup",
      tier: "standard",
    });

    expect(failed.status).toEqual("failed");
    expect(failed.failureReason).toContain("Error: model not supported");
    expect(failed.failureReason).not.toContain("startup line 1\n");
    expect(failed.failedAt).toBeDefined();
    expect(store.agents).toEqual([failed]);
    expect(tmux.killed).toEqual(["hive-maya"]);
    expect(removals).toEqual([[root, worktreePath]]);
    expect(terminal.windows).toEqual([]);
  });

  test("does not treat incidental error text as a launch failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-error-text-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const store = new FakeStore();
    const tmux = new FakeTmux([
      "Task: fix the error handling",
      "typecheck complete: 2 errors found",
    ].join("\n"));
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-error-handling",
      }),
      sleep: async () => {},
    });

    const spawned = await spawner.spawn({
      task: "Fix the error handling",
      tier: "standard",
    });

    expect(spawned.status).toEqual("spawning");
    expect(tmux.capturePaneCalls).toEqual(15);
    expect(tmux.killed).toEqual([]);
  });

  test("tolerates transient pane capture and viewer failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-transient-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const tmux = new FlakyCaptureTmux();
    const spawner = new HiveSpawner({
      db: new FakeStore(),
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FailingTerminal(),
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-transient",
      }),
      sleep: async () => {},
    });

    const spawned = await spawner.spawn({
      task: "Survive cosmetic failures",
      tier: "standard",
    });

    expect(spawned.status).toEqual("spawning");
    expect(tmux.capturePaneCalls).toEqual(15);
    expect(tmux.killed).toEqual([]);
  });
});

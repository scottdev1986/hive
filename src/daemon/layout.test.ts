import { describe, expect, test } from "bun:test";
import { computeLayout, type Frame } from "../adapters/layout";
import type { AgentRecord, TerminalHandle } from "../schemas";
import { HiveDatabase } from "./db";
import { TerminalLayoutManager } from "./layout";

const timestamp = "2026-07-09T12:00:00.000Z";
const screen: Frame = { x: 0, y: 25, width: 2560, height: 1415 };

function agent(
  name: string,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    id: `agent-${name}`,
    name,
    tool: "claude",
    model: "claude-test",
    tier: "standard",
    status: "working",
    taskDescription: "Layout test",
    worktreePath: `/tmp/${name}`,
    branch: `hive/${name}-test`,
    tmuxSession: `hive-${name}`,
    contextPct: 0,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: false,
    ...overrides,
  };
}

const viewer = (name: string): TerminalHandle => ({
  app: "iterm2",
  sessionId: `session-${name}`,
});

const orchestratorHandle: TerminalHandle = {
  app: "terminal",
  processId: 71,
  windowId: 402,
  tty: "/dev/ttys004",
};

interface Placement {
  handle: TerminalHandle;
  frame: Frame;
}

function manager(
  db: HiveDatabase,
  overrides: Partial<
    ConstructorParameters<typeof TerminalLayoutManager>[0]
  > = {},
): { layout: TerminalLayoutManager; placements: Placement[] } {
  const placements: Placement[] = [];
  const layout = new TerminalLayoutManager({
    db,
    enabled: true,
    setBounds: async (handle, frame) => {
      placements.push({ handle, frame });
    },
    readScreen: async () => screen,
    logError: () => {},
    ...overrides,
  });
  return { layout, placements };
}

describe("TerminalLayoutManager", () => {
  test("positions the orchestrator and live viewers per the computed layout", async () => {
    const db = new HiveDatabase(":memory:");
    db.setOrchestratorTerminal(orchestratorHandle);
    db.upsertAgent(agent("maya", { terminalHandle: viewer("maya") }));
    db.upsertAgent(agent("david", {
      terminalHandle: viewer("david"),
      createdAt: "2026-07-09T12:00:01.000Z",
    }));

    const { layout, placements } = manager(db);
    layout.requestLayout();
    await layout.settled();

    const expected = computeLayout(screen, 2, true);
    expect(placements.length).toEqual(3);
    expect(placements[0]).toEqual({
      handle: orchestratorHandle,
      frame: expected.orchestrator!,
    });
    expect(placements[1]).toEqual({
      handle: viewer("maya"),
      frame: expected.workers[0]!,
    });
    expect(placements[2]).toEqual({
      handle: viewer("david"),
      frame: expected.workers[1]!,
    });
    db.close();
  });

  test("skips dead, done, failed, and handle-less agents", async () => {
    const db = new HiveDatabase(":memory:");
    db.setOrchestratorTerminal(orchestratorHandle);
    db.upsertAgent(agent("maya", { terminalHandle: viewer("maya") }));
    db.upsertAgent(agent("david", {
      status: "dead",
      terminalHandle: viewer("david"),
    }));
    db.upsertAgent(agent("sam", {
      status: "failed",
      failureReason: "boom",
      failedAt: timestamp,
      terminalHandle: viewer("sam"),
    }));
    db.upsertAgent(agent("john", { status: "done" }));
    db.upsertAgent(agent("sarah"));

    const { layout, placements } = manager(db);
    layout.requestLayout();
    await layout.settled();

    const expected = computeLayout(screen, 1, true);
    expect(placements.length).toEqual(2);
    expect(placements[0]!.handle).toEqual(orchestratorHandle);
    expect(placements[1]).toEqual({
      handle: viewer("maya"),
      frame: expected.workers[0]!,
    });
    db.close();
  });

  test("does nothing when disabled or when no windows are tracked", async () => {
    const db = new HiveDatabase(":memory:");
    db.setOrchestratorTerminal(orchestratorHandle);
    db.upsertAgent(agent("maya", { terminalHandle: viewer("maya") }));

    const disabled = manager(db, { enabled: false });
    disabled.layout.requestLayout();
    await disabled.layout.settled();
    expect(disabled.placements).toEqual([]);

    const empty = new HiveDatabase(":memory:");
    let screenReads = 0;
    const idle = manager(empty, {
      readScreen: async () => {
        screenReads += 1;
        return screen;
      },
    });
    idle.layout.requestLayout();
    await idle.layout.settled();
    expect(idle.placements).toEqual([]);
    expect(screenReads).toEqual(0);
    db.close();
    empty.close();
  });

  test("coalesces bursts of requests into at most one trailing pass", async () => {
    const db = new HiveDatabase(":memory:");
    db.setOrchestratorTerminal(orchestratorHandle);
    db.upsertAgent(agent("maya", { terminalHandle: viewer("maya") }));

    let passes = 0;
    let releaseFirstPass!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    });
    const { layout } = manager(db, {
      readScreen: async () => {
        passes += 1;
        if (passes === 1) {
          await gate;
        }
        return screen;
      },
    });

    layout.requestLayout();
    layout.requestLayout();
    layout.requestLayout();
    releaseFirstPass();
    await layout.settled();

    expect(passes).toEqual(2);
    db.close();
  });

  test("one unplaceable window never blocks the rest of the wall", async () => {
    const db = new HiveDatabase(":memory:");
    db.setOrchestratorTerminal(orchestratorHandle);
    db.upsertAgent(agent("maya", { terminalHandle: viewer("maya") }));
    db.upsertAgent(agent("david", {
      terminalHandle: viewer("david"),
      createdAt: "2026-07-09T12:00:01.000Z",
    }));

    const errors: string[] = [];
    const placements: Placement[] = [];
    const layout = new TerminalLayoutManager({
      db,
      enabled: true,
      setBounds: async (handle, frame) => {
        if (handle.app === "iterm2" && handle.sessionId === "session-maya") {
          throw new Error("window vanished");
        }
        placements.push({ handle, frame });
      },
      readScreen: async () => screen,
      logError: (message) => {
        errors.push(message);
      },
    });

    layout.requestLayout();
    await layout.settled();

    expect(placements.length).toEqual(2);
    expect(placements.map((placement) => placement.handle)).toEqual([
      orchestratorHandle,
      viewer("david"),
    ]);
    expect(errors.length).toEqual(1);
    expect(errors[0]).toContain("window vanished");
    db.close();
  });

  test("a failing screen read is reported, not thrown", async () => {
    const db = new HiveDatabase(":memory:");
    db.setOrchestratorTerminal(orchestratorHandle);
    db.upsertAgent(agent("maya", { terminalHandle: viewer("maya") }));

    const errors: string[] = [];
    const { layout, placements } = manager(db, {
      readScreen: async () => {
        throw new Error("no display");
      },
      logError: (message) => {
        errors.push(message);
      },
    });
    layout.requestLayout();
    await layout.settled();

    expect(placements).toEqual([]);
    expect(errors.length).toEqual(1);
    expect(errors[0]).toContain("no display");
    db.close();
  });
});

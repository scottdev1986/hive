import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../schemas";
import {
  buildOrchestratorRecoveryBrief,
  superviseOrchestratorSession,
} from "./orchestrator-supervisor";

function agent(
  name: string,
  status: AgentRecord["status"] = "working",
): AgentRecord {
  return {
    id: `agent-${name}`,
    name,
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "complex_coding",
    status,
    taskDescription: `Implement ${name}'s part of the recovery`,
    worktreePath: `/repo/.hive/worktrees/${name}`,
    branch: `hive/${name}-recovery`,
    tmuxSession: `hive-${name}-instance`,
    recoveryAttempts: 0,
    contextPct: null,
    createdAt: "2026-07-13T12:00:00.000Z",
    lastEventAt: "2026-07-13T13:00:00.000Z",
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  };
}

describe("orchestrator session supervisor", () => {
  test("does not replace a startup or finished-session root when no agents are live", async () => {
    const launches: string[] = [];
    const pings: string[] = [];
    const reports: string[] = [];
    const exitCode = await superviseOrchestratorSession({
      launch: async (brief) => {
        launches.push(brief);
        return 17;
      },
      fetchAgents: async () => [agent("maya", "done")],
      sendRecoveryPing: async (name) => { pings.push(name); },
      sleep: async () => {},
      now: (() => {
        let now = 0;
        return () => (now += 60_000);
      })(),
      report: (message) => { reports.push(message); },
    });

    expect(exitCode).toEqual(17);
    expect(launches).toEqual([""]);
    expect(pings).toEqual([]);
    expect(reports).toEqual([
      "[hive] orchestrator exited with code 17; no live agents remain",
    ]);
  });

  test("starts a labelled backup and asks every live agent for current work", async () => {
    const launches: string[] = [];
    const pings: Array<{ name: string; body: string }> = [];
    const exitCodes = [9, 0];
    const exitCode = await superviseOrchestratorSession({
      launch: async (brief) => {
        launches.push(brief);
        return exitCodes.shift()!;
      },
      fetchAgents: async () => launches.length === 1
        ? [agent("maya"), agent("noah", "idle"), agent("closed", "dead")]
        : [],
      sendRecoveryPing: async (name, body) => { pings.push({ name, body }); },
      sleep: async () => {},
      now: (() => {
        let now = 0;
        return () => (now += 60_000);
      })(),
      report: () => {},
    });

    expect(exitCode).toEqual(0);
    expect(launches).toHaveLength(2);
    expect(launches[0]).toEqual("");
    expect(launches[1]).toContain("BACKUP ORCHESTRATOR");
    expect(launches[1]).toContain("exit code 9");
    expect(launches[1]).toContain("maya | codex/gpt-5.6-sol | working");
    expect(launches[1]).toContain("hive/maya-recovery");
    expect(launches[1]).toContain("/repo/.hive/worktrees/maya");
    expect(launches[1]).toContain("noah | codex/gpt-5.6-sol | idle");
    expect(launches[1]).not.toContain("closed | codex");
    expect(pings.map((ping) => ping.name)).toEqual(["maya", "noah"]);
    for (const ping of pings) {
      expect(ping.body).toContain("previous orchestrator exited");
      expect(ping.body).toContain("branch and worktree");
      expect(ping.body).toContain("files you are changing");
      expect(ping.body).toContain("blockers");
    }
  });

  test("treats unreadable daemon state as unknown and waits before deciding", async () => {
    const events: string[] = [];
    let reads = 0;
    const exitCode = await superviseOrchestratorSession({
      launch: async (brief) => {
        events.push(`launch:${brief === "" ? "primary" : "backup"}`);
        return 4;
      },
      fetchAgents: async () => {
        reads += 1;
        events.push(`read:${reads}`);
        if (reads === 1) throw new Error("daemon unavailable");
        return [];
      },
      sendRecoveryPing: async () => {},
      sleep: async () => { events.push("sleep"); },
      now: (() => {
        let now = 0;
        return () => (now += 60_000);
      })(),
      report: (message) => { events.push(`report:${message}`); },
    });

    expect(exitCode).toEqual(4);
    expect(events[0]).toEqual("launch:primary");
    expect(events).toContain("read:1");
    expect(events).toContain("sleep");
    expect(events).toContain("read:2");
    expect(events.filter((event) => event === "launch:backup")).toEqual([]);
    expect(events.some((event) => event.includes("cannot determine whether")))
      .toEqual(true);
  });

  test("reports an unconfirmed ping in the backup brief without blocking recovery", async () => {
    const launches: string[] = [];
    await superviseOrchestratorSession({
      launch: async (brief) => {
        launches.push(brief);
        return 0;
      },
      fetchAgents: async () => launches.length === 1
        ? [agent("maya"), agent("noah")]
        : [],
      sendRecoveryPing: async (name) => {
        if (name === "noah") throw new Error("delivery unavailable");
      },
      sleep: async () => {},
      now: (() => {
        let now = 0;
        return () => (now += 60_000);
      })(),
      report: () => {},
    });

    expect(launches[1]).toContain("Recovery request durably recorded: maya");
    expect(launches[1]).toContain("Recovery request NOT confirmed: noah");
  });

  test("bounds task text included in a recovery brief", () => {
    const long = agent("maya");
    long.taskDescription = "x".repeat(1_000);
    const brief = buildOrchestratorRecoveryBrief(2, 137, [long], []);
    expect(brief.length).toBeLessThan(2_000);
    expect(brief).toContain("backup generation 2");
    expect(brief).toContain("exit code 137");
  });
});

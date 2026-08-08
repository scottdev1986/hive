import { describe, expect, test } from "bun:test";
import { selectAgentName } from "../../src/daemon/spawn/spawner-impl";
import type { AgentRecord } from "../../src/schemas/agent";

function closedAgent(name: string, index: number): AgentRecord {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `agent-${String(index)}`,
    name,
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "simple_coding",
    status: "done",
    taskDescription: "Naming-order fixture",
    worktreePath: null,
    branch: null,
    contextPct: null,
    createdAt: timestamp,
    lastEventAt: timestamp,
    closedAt: timestamp,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  };
}

function nameSequence(seed: string, count: number): string[] {
  const agents: AgentRecord[] = [];
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = selectAgentName(agents, new Set(), seed);
    names.push(name);
    agents.push(closedAgent(name, index));
  }
  return names;
}

function longestInitialRun(names: readonly string[]): number {
  let longest = 0;
  let current = 0;
  let previous: string | undefined;
  for (const name of names) {
    const initial = name[0];
    current = initial === previous ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = initial;
  }
  return longest;
}

describe("agent name selection", () => {
  test("uses a stable, varied order for each Hive instance", () => {
    const firstRun = nameSequence("runtime-a", 120);
    const secondRun = nameSequence("runtime-b", 120);

    expect(firstRun).toEqual(nameSequence("runtime-a", 120));
    expect(firstRun).not.toEqual(secondRun);
    expect(longestInitialRun(firstRun)).toBeLessThanOrEqual(5);
    expect(longestInitialRun(secondRun)).toBeLessThanOrEqual(5);
  });

  test("skips used and unavailable names without changing the remaining order", () => {
    const expected = nameSequence("runtime-a", 2);
    const firstName = expected.slice(0, 1);

    expect([selectAgentName([], new Set(firstName), "runtime-a")]).toEqual(
      expected.slice(1),
    );
    expect([
      selectAgentName(
        firstName.map((name) => closedAgent(name, 0)),
        new Set(),
        "runtime-a",
      ),
    ]).toEqual(expected.slice(1));
  });

  test("reuses the least-recently-closed name only after exhausting fresh names", () => {
    const agents: AgentRecord[] = [];
    let reused: string | undefined;

    for (let index = 0; index < 1_000; index += 1) {
      const name = selectAgentName(agents, new Set(), "runtime-a");
      if (agents.some((agent) => agent.name === name)) {
        reused = name;
        break;
      }
      agents.push(closedAgent(name, index));
    }

    expect(agents.length).toBeGreaterThan(500);
    expect(reused).toBe(agents[0]?.name);
  });
});

import { describe, expect, test } from "bun:test";
import { mintAgentTmuxSessionLocator } from "./tmux-host";
import {
  WorkspaceVisibilityAuthority,
  type WorkspaceVisibilitySnapshot,
} from "./workspace-visibility";

const instanceId = mintAgentTmuxSessionLocator("instance-probe").instanceId;
const engineBuildId = "engine-build";
const process = { processId: 7101, startToken: "7101:100" };

function locator(agentId: string) {
  return {
    ...mintAgentTmuxSessionLocator(agentId),
    hostKind: "sessiond" as const,
    engineBuildId,
  };
}

function snapshot(
  revision: string,
  overrides: Partial<WorkspaceVisibilitySnapshot> = {},
): WorkspaceVisibilitySnapshot {
  return {
    schemaVersion: 1,
    source: { sessionId: "workspace-session", process },
    inventoryRevision: revision,
    terminals: [{
      agentId: "agent-1",
      agentName: "visible-agent",
      locator: locator("agent-1"),
      state: "pending",
    }],
    ...overrides,
  };
}

function authority() {
  let observed = process;
  let build = engineBuildId;
  const value = new WorkspaceVisibilityAuthority({
    expectedInstanceId: instanceId,
    observeProcess: (pid) => pid === observed.processId ? observed : null,
    discoverEngineBuildId: async () => build,
  });
  return {
    value,
    replaceProcess: (next: typeof process) => { observed = next; },
    replaceBuild: (next: string) => { build = next; },
  };
}

describe("WorkspaceVisibilityAuthority", () => {
  test("accepts only advancing full snapshots from one live exact source", () => {
    const host = authority();
    expect(host.value.publish(snapshot("1"))).toEqual({
      state: "accepted",
      inventoryRevision: "1",
    });
    expect(host.value.publish(snapshot("1"))).toMatchObject({
      state: "rejected",
      reason: "stale-revision",
      currentRevision: "1",
    });
    host.replaceProcess({ processId: 7101, startToken: "7101:200" });
    expect(host.value.publish(snapshot("2"))).toMatchObject({
      state: "rejected",
      reason: "source-not-live",
    });
  });

  test("rejects duplicate ownership and mismatched exact locators", () => {
    const host = authority();
    const repeated = snapshot("1").terminals[0]!;
    expect(host.value.publish(snapshot("1", {
      terminals: [repeated, { ...repeated, locator: locator("agent-2") }],
    }))).toMatchObject({ state: "rejected", reason: "duplicate-terminal" });
    expect(host.value.publish(snapshot("1", {
      terminals: [{ ...repeated, agentId: "wrong-agent" }],
    }))).toMatchObject({ state: "rejected", reason: "locator-mismatch" });
  });

  test("admission re-reads source liveness, engine build, state, and revision", async () => {
    const host = authority();
    expect(host.value.publish(snapshot("1"))).toMatchObject({ state: "accepted" });
    await expect(host.value.admit({ agentId: "agent-1", agentName: "visible-agent" }))
      .resolves.toEqual({
        engineBuildId,
        visibility: {
          workspaceSessionId: "workspace-session",
          workspacePid: 7101,
          workspaceStartToken: "7101:100",
          openTerminalRevision: "1",
        },
      });

    expect(host.value.publish(snapshot("2", {
      terminals: [{ ...snapshot("2").terminals[0]!, state: "closing" }],
    }))).toMatchObject({ state: "accepted" });
    await expect(host.value.admit({ agentId: "agent-1", agentName: "visible-agent" }))
      .resolves.toBeNull();

    expect(host.value.publish(snapshot("3"))).toMatchObject({ state: "accepted" });
    host.replaceBuild("changed-engine");
    await expect(host.value.admit({ agentId: "agent-1", agentName: "visible-agent" }))
      .resolves.toBeNull();
    host.replaceBuild(engineBuildId);
    host.replaceProcess({ processId: 7101, startToken: "7101:200" });
    await expect(host.value.admit({ agentId: "agent-1", agentName: "visible-agent" }))
      .resolves.toBeNull();
  });

  test("a dead prior source may be replaced, but a live one is exclusive", () => {
    const host = authority();
    expect(host.value.publish(snapshot("1"))).toMatchObject({ state: "accepted" });
    const second = snapshot("1", {
      source: {
        sessionId: "replacement-workspace",
        process: { processId: 7102, startToken: "7102:100" },
      },
    });
    expect(host.value.publish(second)).toMatchObject({
      state: "rejected",
      reason: "source-not-live",
    });
    host.replaceProcess({ processId: 7102, startToken: "7102:100" });
    expect(host.value.publish(second)).toMatchObject({ state: "accepted" });
  });
});

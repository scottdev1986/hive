import { describe, expect, test } from "bun:test";
import {
  mintSessionLocator,
  mintSessionRequestId,
} from "../../src/daemon/session-host/locators";
import {
  configuredOrchestratorHost,
  mintRootSessiondLocator,
  RootSessiondLocatorSchema,
  rootSessionIdForLaunchRequest,
} from "../../src/daemon/orchestrator-host";
import type { HiveTerminalBinding } from "../../src/daemon/session-host/terminal-host-binding";

describe("orchestrator host selection", () => {
  test("production has one host and no environment selector can restore tmux", () => {
    const previous = process.env.HIVE_ORCHESTRATOR_HOST;
    try {
      process.env.HIVE_ORCHESTRATOR_HOST = "tmux";
      expect(configuredOrchestratorHost()).toBe("sessiond");
    } finally {
      if (previous === undefined) delete process.env.HIVE_ORCHESTRATOR_HOST;
      else process.env.HIVE_ORCHESTRATOR_HOST = previous;
    }
  });
});

describe("root sessiond locator", () => {
  test("is stable across launch retries and advances only for a new request", () => {
    const requestId = mintSessionRequestId(1_750_000_000_000);
    const first = mintRootSessiondLocator({
      requestId,
      instanceId: "instance-a",
      engineBuildId: "engine-a",
      bindings: [],
    });
    expect(first).toMatchObject({
      subject: { kind: "root" },
      generation: 1,
      sessionId: rootSessionIdForLaunchRequest(requestId),
      hostKind: "sessiond",
      engineBuildId: "engine-a",
    });
    expect(() => RootSessiondLocatorSchema.parse({ ...first, hostKind: "tmux" }))
      .toThrow();
    const binding: HiveTerminalBinding = {
      locator: first,
      visibility: {
        workspaceSessionId: "workspace-a",
        workspacePid: 123,
        workspaceStartToken: "123:1",
        openTerminalRevision: "1",
      },
    };
    expect(mintRootSessiondLocator({
      requestId,
      instanceId: "instance-a",
      engineBuildId: "engine-b",
      bindings: [binding],
    })).toEqual(first);
    const second = mintRootSessiondLocator({
      requestId: mintSessionRequestId(1_750_000_000_001),
      instanceId: "instance-a",
      engineBuildId: "engine-b",
      bindings: [binding],
    });
    expect(second.generation).toBe(2);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  test("ignores agent generations when allocating the root generation", () => {
    const agent = mintSessionLocator(
      "instance-a",
      { kind: "agent", agentId: "agent-1" },
      17,
      "engine-a",
    );
    const binding: HiveTerminalBinding = {
      locator: agent,
      visibility: {
        workspaceSessionId: "workspace-a",
        workspacePid: 123,
        workspaceStartToken: "123:1",
        openTerminalRevision: "1",
      },
    };
    expect(mintRootSessiondLocator({
      requestId: mintSessionRequestId(1_750_000_000_002),
      instanceId: agent.instanceId,
      engineBuildId: "engine-a",
      bindings: [binding],
    }).generation).toBe(1);
  });

  test("never reuses or counts a binding from another Hive instance", () => {
    const requestId = mintSessionRequestId(1_750_000_000_003);
    const foreign = mintRootSessiondLocator({
      requestId,
      instanceId: "instance-foreign",
      engineBuildId: "engine-a",
      bindings: [],
    });
    const binding: HiveTerminalBinding = {
      locator: foreign,
      visibility: {
        workspaceSessionId: "workspace-foreign",
        workspacePid: 123,
        workspaceStartToken: "123:1",
        openTerminalRevision: "1",
      },
    };

    expect(mintRootSessiondLocator({
      requestId,
      instanceId: "instance-local",
      engineBuildId: "engine-b",
      bindings: [binding],
    })).toMatchObject({
      instanceId: "instance-local",
      generation: 1,
      engineBuildId: "engine-b",
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  daemonOrchestratorSessiondControl,
  OrchestratorLaunchFailedError,
  type OrchestratorSessiondControl,
  type OrchestratorSessiondWaitResult,
  runOrchestratorSessiondLaunch,
} from "../../src/cli/orchestrator-sessiond";
import { hiveInstanceSuffix } from "../../src/hive-home/instance-identity";
import {
  type RootSessiondLocator,
  rootSessionIdForLaunchRequest,
} from "../../src/daemon/orchestrator-host/orchestrator-host-contract";
import type {
  OrchestratorSessiondLaunch,
  OrchestratorSessiondSnapshot,
} from "../../src/daemon/orchestrator-host/sessiond-controller";
import { mintSessionRequestId } from "../../src/daemon/session-host/locators";

const launch: OrchestratorSessiondLaunch = {
  requestId: mintSessionRequestId(1_750_000_000_000),
  providerRunId: "018f1e90-7b5a-7cc0-8000-0000000007a1",
  provider: "codex",
  cwd: "/repo",
  argv: ["codex", "--no-alt-screen"],
  environment: {},
  expectedExecutable: "codex",
};

const locator: RootSessiondLocator = {
  schemaVersion: 1,
  instanceId: hiveInstanceSuffix(),
  subject: { kind: "root" },
  sessionId: rootSessionIdForLaunchRequest(launch.requestId),
  generation: 1,
  hostKind: "sessiond",
  engineBuildId: "engine-fixture",
};

function snapshot(
  state: OrchestratorSessiondSnapshot["state"],
  value: RootSessiondLocator = locator,
): OrchestratorSessiondSnapshot {
  return {
    requestId: launch.requestId,
    locator: value,
    state,
    exitCode: state === "exited" ? 0 : null,
    diagnostic: null,
  };
}

describe("sessiond orchestrator launch client", () => {
  test("a terminal long-poll response completes the launch without another request", async () => {
    let waits = 0;
    const control: OrchestratorSessiondControl = {
      start: async () => snapshot("running"),
      waitForTerminal: async () => {
        waits += 1;
        return { kind: "snapshot", snapshot: snapshot("exited") };
      },
    };

    await expect(runOrchestratorSessiondLaunch(launch, control)).resolves.toBe(
      0,
    );
    expect(waits).toBe(1);
  });

  test("an explicitly missing generation reconnects the same request after a daemon restart", async () => {
    const starts: OrchestratorSessiondLaunch[] = [];
    const waits: OrchestratorSessiondWaitResult[] = [
      { kind: "missing" },
      { kind: "snapshot", snapshot: snapshot("exited") },
    ];
    const control: OrchestratorSessiondControl = {
      start: async (request) => {
        starts.push(request);
        return snapshot(
          starts.length === 1 ? "awaiting-visibility" : "running",
        );
      },
      waitForTerminal: async () => waits.shift() ?? { kind: "missing" },
    };

    await expect(runOrchestratorSessiondLaunch(launch, control)).resolves.toBe(
      0,
    );
    expect(starts).toEqual([launch, launch]);
  });

  test("a nonterminal timeout response re-enters the event-driven wait without restarting", async () => {
    const starts: OrchestratorSessiondLaunch[] = [];
    const waits: OrchestratorSessiondWaitResult[] = [
      { kind: "snapshot", snapshot: snapshot("running") },
      { kind: "snapshot", snapshot: snapshot("exited") },
    ];
    const control: OrchestratorSessiondControl = {
      start: async (request) => {
        starts.push(request);
        return snapshot("running");
      },
      waitForTerminal: async () => waits.shift() ?? { kind: "missing" },
    };

    await expect(runOrchestratorSessiondLaunch(launch, control)).resolves.toBe(
      0,
    );
    expect(starts).toEqual([launch]);
    expect(waits).toEqual([]);
  });

  test("refuses instance, session, or generation drift within one request", async () => {
    const drifted = { ...locator, generation: 2 };
    const control: OrchestratorSessiondControl = {
      start: async () => snapshot("running"),
      waitForTerminal: async () => ({
        kind: "snapshot",
        snapshot: snapshot("running", drifted),
      }),
    };

    await expect(
      runOrchestratorSessiondLaunch(launch, control),
    ).rejects.toThrow("locator changed");
  });

  test("returns a typed failure instead of falling back after sessiond launch refusal", async () => {
    const control: OrchestratorSessiondControl = {
      start: async () => ({
        ...snapshot("failed"),
        diagnostic: "visibility expired before create",
      }),
      waitForTerminal: async () => ({ kind: "missing" }),
    };
    const error = await runOrchestratorSessiondLaunch(launch, control).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(OrchestratorLaunchFailedError);
    expect(error).toMatchObject({
      code: "ORCHESTRATOR_LAUNCH_FAILED",
      detail: "visibility expired before create",
    });
  });

  test("surfaces a diagnosed frontend exit instead of returning a bare code", async () => {
    const control: OrchestratorSessiondControl = {
      start: async () => ({
        ...snapshot("exited"),
        exitCode: 1,
        diagnostic:
          "agent-ui could not open the queen provider: missing binary",
      }),
      waitForTerminal: async () => ({ kind: "missing" }),
    };

    await expect(
      runOrchestratorSessiondLaunch(launch, control),
    ).rejects.toThrow(
      "agent-ui could not open the queen provider: missing binary",
    );
  });

  test("HTTP launch refusal is typed before a queen process can exist", async () => {
    const control = daemonOrchestratorSessiondControl(4317, async () =>
      Response.json({ error: "sessiond is unavailable" }, { status: 503 }),
    );
    const error = await control.start(launch).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OrchestratorLaunchFailedError);
    expect(error).toMatchObject({
      code: "ORCHESTRATOR_LAUNCH_FAILED",
      detail: "sessiond is unavailable",
    });
  });

  test("HTTP wait keeps snapshot parsing and makes a missing generation explicit", async () => {
    const responses = [
      Response.json(snapshot("exited")),
      Response.json(
        { error: "queen session generation not found" },
        { status: 404 },
      ),
    ];
    const paths: string[] = [];
    const control = daemonOrchestratorSessiondControl(4317, async (input) => {
      paths.push(new URL(input.toString()).pathname);
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await expect(control.waitForTerminal(launch.requestId)).resolves.toEqual({
      kind: "snapshot",
      snapshot: snapshot("exited"),
    });
    await expect(control.waitForTerminal(launch.requestId)).resolves.toEqual({
      kind: "missing",
    });
    expect(paths).toEqual(["/orchestrator-session", "/orchestrator-session"]);
  });

  test("an unreachable control surface is a typed terminal launch failure", async () => {
    const control: OrchestratorSessiondControl = {
      start: async () => {
        throw new TypeError("connect ECONNREFUSED 127.0.0.1");
      },
      waitForTerminal: async () => ({ kind: "missing" }),
    };

    const error = await runOrchestratorSessiondLaunch(launch, control).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(OrchestratorLaunchFailedError);
    expect(error).toMatchObject({ code: "ORCHESTRATOR_LAUNCH_FAILED" });
    expect((error as Error).message).toContain("ECONNREFUSED");
  });
});

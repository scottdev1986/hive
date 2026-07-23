import { describe, expect, test } from "bun:test";
import { hiveInstanceSuffix } from "../../src/daemon/tmux-sessions";
import { mintSessionRequestId } from "../../src/daemon/session-host/locators";
import {
  rootSessionIdForLaunchRequest,
  type RootSessiondLocator,
} from "../../src/daemon/orchestrator-host";
import type {
  OrchestratorSessiondLaunch,
  OrchestratorSessiondSnapshot,
} from "../../src/daemon/orchestrator-sessiond";
import {
  daemonOrchestratorSessiondControl,
  OrchestratorLaunchFailedError,
  runOrchestratorSessiondLaunch,
  type OrchestratorSessiondControl,
} from "../../src/cli/orchestrator-sessiond";

const launch: OrchestratorSessiondLaunch = {
  requestId: mintSessionRequestId(1_750_000_000_000),
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
  test("retries the same request after a daemon restart and returns the exact exit", async () => {
    const starts: OrchestratorSessiondLaunch[] = [];
    const inspections: Array<OrchestratorSessiondSnapshot | null> = [
      null,
      snapshot("exited"),
    ];
    const control: OrchestratorSessiondControl = {
      start: async (request) => {
        starts.push(request);
        return snapshot(starts.length === 1 ? "awaiting-visibility" : "running");
      },
      inspect: async () => inspections.shift() ?? null,
    };

    await expect(runOrchestratorSessiondLaunch(launch, control, async () => {}))
      .resolves.toBe(0);
    expect(starts).toEqual([launch, launch]);
  });

  test("refuses instance, session, or generation drift within one request", async () => {
    const drifted = { ...locator, generation: 2 };
    const control: OrchestratorSessiondControl = {
      start: async () => snapshot("running"),
      inspect: async () => snapshot("running", drifted),
    };

    await expect(runOrchestratorSessiondLaunch(launch, control, async () => {}))
      .rejects.toThrow("locator changed");
  });

  test("returns a typed failure instead of falling back after sessiond launch refusal", async () => {
    const control: OrchestratorSessiondControl = {
      start: async () => ({
        ...snapshot("failed"),
        diagnostic: "visibility expired before create",
      }),
      inspect: async () => null,
    };
    const error = await runOrchestratorSessiondLaunch(launch, control, async () => {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OrchestratorLaunchFailedError);
    expect(error).toMatchObject({
      code: "ORCHESTRATOR_LAUNCH_FAILED",
      detail: "visibility expired before create",
    });
  });

  test("HTTP launch refusal is typed before a queen process can exist", async () => {
    const control = daemonOrchestratorSessiondControl(
      4317,
      async () => Response.json({ error: "sessiond is unavailable" }, { status: 503 }),
    );
    const error = await control.start(launch).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OrchestratorLaunchFailedError);
    expect(error).toMatchObject({
      code: "ORCHESTRATOR_LAUNCH_FAILED",
      detail: "sessiond is unavailable",
    });
  });

  test("an unreachable control surface is a typed terminal launch failure", async () => {
    const control: OrchestratorSessiondControl = {
      start: async () => {
        throw new TypeError("connect ECONNREFUSED 127.0.0.1");
      },
      inspect: async () => null,
    };

    const error = await runOrchestratorSessiondLaunch(launch, control, async () => {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OrchestratorLaunchFailedError);
    expect(error).toMatchObject({ code: "ORCHESTRATOR_LAUNCH_FAILED" });
    expect((error as Error).message).toContain("ECONNREFUSED");
  });
});

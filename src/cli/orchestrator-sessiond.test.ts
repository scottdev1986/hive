import { describe, expect, test } from "bun:test";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import { mintSessionRequestId } from "../daemon/session-host/locators";
import {
  rootSessionIdForLaunchRequest,
  type RootSessiondLocator,
} from "../daemon/orchestrator-host";
import type {
  OrchestratorSessiondLaunch,
  OrchestratorSessiondSnapshot,
} from "../daemon/orchestrator-sessiond";
import {
  runOrchestratorSessiondLaunch,
  type OrchestratorSessiondControl,
} from "./orchestrator-sessiond";

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

  test("returns failure so the existing supervisor can relaunch with queued mail", async () => {
    const control: OrchestratorSessiondControl = {
      start: async () => ({
        ...snapshot("failed"),
        diagnostic: "visibility expired before create",
      }),
      inspect: async () => null,
    };
    await expect(runOrchestratorSessiondLaunch(launch, control, async () => {}))
      .resolves.toBe(1);
  });
});

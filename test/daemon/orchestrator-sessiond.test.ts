import { describe, expect, test } from "bun:test";
import type { SessionInspection } from "../../src/daemon/session-host/contract";
import type {
  HiveTerminalBinding,
  TerminalHostBindingStore,
} from "../../src/daemon/session-host/terminal-host-binding";
import { mintSessionRequestId } from "../../src/daemon/session-host/locators";
import {
  OrchestratorSessiondController,
  type OrchestratorSessiondDependencies,
  type OrchestratorSessiondLaunch,
} from "../../src/daemon/orchestrator-sessiond";

class MemoryBindings implements TerminalHostBindingStore {
  values: HiveTerminalBinding[] = [];

  bindTerminalHostSession(binding: HiveTerminalBinding): HiveTerminalBinding {
    this.values.push(binding);
    return binding;
  }
  releaseUncreatedTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
  ): boolean {
    const index = this.values.findIndex((binding) =>
      binding.locator.instanceId === locator.instanceId &&
      binding.locator.sessionId === locator.sessionId &&
      binding.locator.generation === locator.generation &&
      binding.createEvidence === undefined
    );
    if (index < 0) return false;
    this.values.splice(index, 1);
    return true;
  }
  completeTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
    evidence: NonNullable<HiveTerminalBinding["createEvidence"]>,
  ): HiveTerminalBinding {
    const index = this.values.findIndex((binding) =>
      binding.locator.sessionId === locator.sessionId
    );
    const value = { ...this.values[index]!, createEvidence: evidence };
    this.values[index] = value;
    return value;
  }
  renewTerminalHostVisibility(): HiveTerminalBinding {
    throw new Error("not under test");
  }
  recordTerminalHostTermination(): HiveTerminalBinding {
    throw new Error("not under test");
  }
  getTerminalHostBindingByLocator(
    locator: HiveTerminalBinding["locator"],
  ): HiveTerminalBinding | null {
    return this.values.find((binding) =>
      binding.locator.instanceId === locator.instanceId &&
      binding.locator.sessionId === locator.sessionId &&
      binding.locator.generation === locator.generation
    ) ?? null;
  }
  listTerminalHostBindings(instanceId: string): readonly HiveTerminalBinding[] {
    return this.values.filter((binding) => binding.locator.instanceId === instanceId);
  }
}

const launch: OrchestratorSessiondLaunch = {
  requestId: mintSessionRequestId(1_750_000_000_000),
  provider: "codex",
  cwd: "/repo",
  argv: ["codex", "--no-alt-screen"],
  environment: { HIVE_ROOT_FIXTURE: "1" },
  expectedExecutable: "codex",
};

const visibility = {
  workspaceSessionId: "workspace-1",
  workspacePid: 123,
  workspaceStartToken: "123:1",
  openTerminalRevision: "1",
};
const geometry = {
  columns: 117,
  rows: 41,
  widthPx: 1170,
  heightPx: 820,
  cellWidthPx: 10,
  cellHeightPx: 20,
};

function inspection(
  locator: HiveTerminalBinding["locator"],
  presence: SessionInspection["presence"],
  expired = false,
): SessionInspection {
  return {
    schemaVersion: 1,
    locator,
    presence,
    complete: true,
    hostPid: presence === "present" ? 500 : null,
    hostStartToken: presence === "present" ? "500:1" : null,
    providerRoot: null,
    expectedExecutable: "codex",
    executableVerified: presence === "present",
    outputSeq: "0",
    checkpointSeq: "0",
    checkpointAvailable: false,
    input: { state: "FREE", ownerViewerId: null, claimId: null },
    viewerCount: 0,
    geometry: {
      columns: 80,
      rows: 24,
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
    },
    resources: {},
    visibility: {
      state: expired ? "expired" : "visible",
      workspaceSessionId: "workspace-1",
      openTerminalRevision: "1",
      expiresAt: "2026-07-22T12:00:00.000Z",
    },
    exit: presence === "present"
      ? null
      : { code: null, signal: 15, observedAt: "2026-07-22T12:00:01.000Z" },
    survivors: [],
    evidenceAt: "2026-07-22T12:00:01.000Z",
    diagnosticIds: [],
  };
}

function completeBinding(
  bindings: MemoryBindings,
  locator: HiveTerminalBinding["locator"],
): void {
  const value = inspection(locator, "present");
  bindings.completeTerminalHostSession(locator, {
    expectedExecutable: value.expectedExecutable,
    executableVerified: value.executableVerified,
    verifiedProviderRoot: value.providerRoot,
    geometry: value.geometry,
    visibility: value.visibility,
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe("OrchestratorSessiondController", () => {
  test("failed native create releases its incomplete generation", async () => {
    const bindings = new MemoryBindings();
    const controller = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        create: async (_spec, _input, policy) => {
          bindings.bindTerminalHostSession(policy);
          throw new Error("native host registration failed");
        },
        renewVisibility: async () => { throw new Error("not reached"); },
        inspect: async () => { throw new Error("not reached"); },
      },
      sleep: async () => {},
    });

    await expect(controller.start(launch)).rejects.toThrow(
      "native host registration failed",
    );
    expect(controller.snapshot()).toBeNull();
    expect(bindings.values).toEqual([]);
  });

  test("creates once before publishing the ready locator", async () => {
    const bindings = new MemoryBindings();
    let admissionAttempts = 0;
    let creates = 0;
    let renewals = 0;
    const controller = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      visibility: {
        prepareAgentCreation: async () => ++admissionAttempts < 2
          ? null
          : { engineBuildId: "engine-a", visibility, geometry },
      },
      terminalHost: {
        create: async (spec, _input, policy) => {
          expect(spec.geometry).toEqual(geometry);
          expect(spec.environment).toEqual({
            BASE_ENV: "base",
            HIVE_ROOT_FIXTURE: "1",
          });
          creates += 1;
          bindings.bindTerminalHostSession(policy);
          completeBinding(bindings, policy.locator);
          return { locator: spec.locator, inspection: inspection(policy.locator, "present"), created: true };
        },
        renewVisibility: async (value) => {
          expect(bindings.getTerminalHostBindingByLocator(value)?.createEvidence)
            .toBeDefined();
          renewals += 1;
          return {
            locator: value,
            state: "active" as const,
            expiresAt: "2026-07-22T12:00:15.000Z",
            openTerminalRevision: "1",
          };
        },
        inspect: async (value) => inspection(value, "exited"),
      },
      sleep: async () => {},
      environment: { BASE_ENV: "base", NO_COLOR: "1" },
    });

    const ready = await controller.start(launch);
    expect(ready.state).toBe("running");
    expect(ready.locator.subject).toEqual({ kind: "root" });
    await settle();
    expect(admissionAttempts).toBe(2);
    expect(creates).toBe(1);
    expect(renewals).toBe(1);
    expect(bindings.values[0]?.locator).toEqual(ready.locator);
    expect(controller.snapshot()).toMatchObject({ state: "exited", exitCode: 1 });
    await controller.start(launch);
    expect(creates).toBe(1);
  });

  test("surfaces visibility expiry so the supervisor can relaunch", async () => {
    const bindings = new MemoryBindings();
    const controller = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        create: async (spec, _input, policy) => {
          bindings.bindTerminalHostSession(policy);
          completeBinding(bindings, policy.locator);
          return { locator: spec.locator, inspection: inspection(policy.locator, "present"), created: true };
        },
        renewVisibility: async (value) => ({
          locator: value,
          state: "active" as const,
          expiresAt: "2026-07-22T12:00:15.000Z",
          openTerminalRevision: "1",
        }),
        inspect: async (value) => inspection(value, "exited", true),
      },
      sleep: async () => {},
    });
    await controller.start(launch);
    await settle();
    expect(controller.snapshot()).toMatchObject({
      state: "exited",
      diagnostic: "sessiond visibility expired; supervisor will relaunch if agents remain",
    });
  });

  test("daemon cancellation escapes both visibility and monitor waits", async () => {
    const waiting = new OrchestratorSessiondController({
      bindings: new MemoryBindings(),
      instanceId: "instance-a",
      visibility: {
        prepareAgentCreation: async () => null,
      },
      terminalHost: {
        create: async () => { throw new Error("not reached"); },
        renewVisibility: async () => { throw new Error("not reached"); },
        inspect: async () => { throw new Error("not reached"); },
      },
      sleep: async () => await new Promise<void>(() => {}),
    });
    const pending = waiting.start(launch);
    await settle();
    waiting.cancel("test shutdown during admission");
    await settle();
    await expect(pending).rejects.toThrow("queen sessiond creation canceled");
    expect(waiting.snapshot()).toBeNull();

    const bindings = new MemoryBindings();
    const monitoring = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        create: async (spec, _input, policy) => {
          bindings.bindTerminalHostSession(policy);
          completeBinding(bindings, policy.locator);
          return {
            locator: spec.locator,
            inspection: inspection(policy.locator, "present"),
            created: true,
          };
        },
        renewVisibility: async (value) => ({
          locator: value,
          state: "active" as const,
          expiresAt: "2026-07-22T12:00:15.000Z",
          openTerminalRevision: "1",
        }),
        inspect: async (value) => inspection(value, "present"),
      },
      sleep: async () => await new Promise<void>(() => {}),
    });
    await monitoring.start({
      ...launch,
      requestId: mintSessionRequestId(1_750_000_000_100),
    });
    await settle();
    expect(monitoring.snapshot()?.state).toBe("running");
    monitoring.cancel("test shutdown during monitor");
    await settle();
    expect(monitoring.snapshot()).toMatchObject({
      state: "failed",
      diagnostic: "queen sessiond controller canceled: test shutdown during monitor",
    });
  });

  test("a daemon restart resumes the same durable root binding without a second create", async () => {
    const bindings = new MemoryBindings();
    let creates = 0;
    const terminalHost: OrchestratorSessiondDependencies["terminalHost"] = {
      create: async (spec) => {
        creates += 1;
        throw new Error(`unexpected second create for ${spec.locator.sessionId}`);
      },
      renewVisibility: async (value: HiveTerminalBinding["locator"]) => ({
        locator: value,
        state: "active" as const,
        expiresAt: "2026-07-22T12:00:15.000Z",
        openTerminalRevision: "1",
      }),
      inspect: async (value: HiveTerminalBinding["locator"]) =>
        inspection(value, "exited"),
    };
    const firstLocator = (await new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        ...terminalHost,
        create: async (spec, _input, policy) => {
          creates += 1;
          bindings.bindTerminalHostSession(policy);
          completeBinding(bindings, policy.locator);
          return {
            locator: spec.locator,
            inspection: inspection(policy.locator, "present"),
            created: true,
          };
        },
      },
      sleep: async () => {},
    }).start(launch)).locator;
    await settle();

    const restarted = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost,
      sleep: async () => {},
    });
    const resumed = await restarted.start(launch);
    await settle();

    expect(resumed.locator).toEqual(firstLocator);
    expect(creates).toBe(1);
    expect(restarted.snapshot()?.state).toBe("exited");
  });
});

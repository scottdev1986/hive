import { describe, expect, test } from "bun:test";
import {
  OrchestratorSessiondController,
  type OrchestratorSessiondDependencies,
  type OrchestratorSessiondLaunch,
} from "../../src/daemon/orchestrator-host/sessiond-controller";
import type { SessionInspection } from "../../src/daemon/session-host/session-host-contract";
import { mintSessionRequestId } from "../../src/daemon/session-host/locators";
import { TERMINAL_SHELL } from "../../src/daemon/session-host/shell-session";
import type {
  HiveTerminalBinding,
  TerminalHostBindingStore,
} from "../../src/daemon/session-host/terminal-host-binding";
import type { ProviderRun } from "../../src/schemas/provider-run";
import { required } from "../required";

class MemoryBindings implements TerminalHostBindingStore {
  values: HiveTerminalBinding[] = [];

  bindTerminalHostSession(binding: HiveTerminalBinding): HiveTerminalBinding {
    this.values.push(binding);
    return binding;
  }
  releaseUncreatedTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
  ): boolean {
    const index = this.values.findIndex(
      (binding) =>
        binding.locator.instanceId === locator.instanceId &&
        binding.locator.sessionId === locator.sessionId &&
        binding.locator.generation === locator.generation &&
        binding.createEvidence === undefined,
    );
    if (index < 0) return false;
    this.values.splice(index, 1);
    return true;
  }
  completeTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
    evidence: NonNullable<HiveTerminalBinding["createEvidence"]>,
  ): HiveTerminalBinding {
    const index = this.values.findIndex(
      (binding) => binding.locator.sessionId === locator.sessionId,
    );
    const value = { ...required(this.values[index]), createEvidence: evidence };
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
    return (
      this.values.find(
        (binding) =>
          binding.locator.instanceId === locator.instanceId &&
          binding.locator.sessionId === locator.sessionId &&
          binding.locator.generation === locator.generation,
      ) ?? null
    );
  }
  listTerminalHostBindings(instanceId: string): readonly HiveTerminalBinding[] {
    return this.values.filter(
      (binding) => binding.locator.instanceId === instanceId,
    );
  }
}

class MemoryProviderRuns {
  values: ProviderRun[] = [];

  getActiveProviderRunByTerminal(
    terminal: ProviderRun["terminal"],
  ): ProviderRun | null {
    return (
      this.values.find(
        (run) =>
          run.state === "running" &&
          run.terminal.sessionId === terminal.sessionId,
      ) ?? null
    );
  }

  insertProviderRun(run: ProviderRun): ProviderRun {
    this.values.push(run);
    return run;
  }
}

const terminalTermination = {
  reconcileProviderRun: () => null,
  waitForExit: async () => ({
    kind: "managed-exit" as const,
    exitCode: null,
  }),
  terminate: async (locator: HiveTerminalBinding["locator"]) => ({
    locator,
    state: "terminated" as const,
    exit: null,
    survivors: [],
    errors: [],
  }),
};

const launch: OrchestratorSessiondLaunch = {
  requestId: mintSessionRequestId(1_750_000_000_000),
  providerRunId: "018f1e90-7b5a-7cc0-8000-0000000007a1",
  provider: "codex",
  cwd: "/repo",
  argv: ["codex", "--no-alt-screen"],
  environment: { HIVE_ROOT_FIXTURE: "1" },
  expectedExecutable: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
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
    shellRoot: null,
    foreground:
      presence === "present"
        ? {
            state: "unmanaged",
            runId: null,
            pid: 600,
            startToken: "600:1",
            foregroundProcessGroupId: 600,
          }
        : { state: "unknown", runId: null },
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
    exit:
      presence === "present"
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
    verifiedShellRoot: value.shellRoot,
    geometry: value.geometry,
    visibility: value.visibility,
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function terminalWaitHarness(): Readonly<{
  controller: OrchestratorSessiondController;
  finishExit: () => void;
  inspections: () => number;
}> {
  const bindings = new MemoryBindings();
  let exit:
    | ((value: { kind: "managed-exit"; exitCode: number }) => void)
    | null = null;
  let inspections = 0;
  const controller = new OrchestratorSessiondController({
    bindings,
    instanceId: "instance-a",
    providerRuns: new MemoryProviderRuns(),
    visibility: {
      prepareAgentCreation: async () => ({
        engineBuildId: "engine-a",
        visibility,
        geometry,
      }),
    },
    terminalHost: {
      ...terminalTermination,
      create: async (spec, policy) => {
        bindings.bindTerminalHostSession(policy);
        completeBinding(bindings, policy.locator);
        return {
          locator: spec.locator,
          inspection: inspection(policy.locator, "present"),
          created: true,
        };
      },
      waitForExit: async () =>
        await new Promise<{ kind: "managed-exit"; exitCode: number }>(
          (resolve) => {
            exit = resolve;
          },
        ),
      inspect: async (value) => {
        inspections += 1;
        return inspection(value, "exited");
      },
    },
  });
  return {
    controller,
    finishExit: () => {
      if (exit === null) throw new Error("monitor is not waiting");
      exit({ kind: "managed-exit", exitCode: 23 });
    },
    inspections: () => inspections,
  };
}

async function seedCompletedRoot(): Promise<
  Readonly<{
    bindings: MemoryBindings;
    providerRuns: MemoryProviderRuns;
  }>
> {
  const bindings = new MemoryBindings();
  const providerRuns = new MemoryProviderRuns();
  await new OrchestratorSessiondController({
    bindings,
    instanceId: "instance-a",
    providerRuns,
    visibility: {
      prepareAgentCreation: async () => ({
        engineBuildId: "engine-a",
        visibility,
        geometry,
      }),
    },
    terminalHost: {
      ...terminalTermination,
      create: async (spec, policy) => {
        bindings.bindTerminalHostSession(policy);
        completeBinding(bindings, policy.locator);
        return {
          locator: spec.locator,
          inspection: inspection(policy.locator, "present"),
          created: true,
        };
      },
      inspect: async (value) => inspection(value, "exited"),
    },
  }).start(launch);
  await settle();
  return { bindings, providerRuns };
}

describe("OrchestratorSessiondController", () => {
  test("a terminal transition wakes the exact pending generation", async () => {
    const harness = terminalWaitHarness();
    await harness.controller.start(launch);
    await settle();

    const waiting = harness.controller.waitForTerminal(
      launch.requestId,
      10_000,
    );
    expect(harness.inspections()).toBe(0);
    harness.finishExit();

    await expect(waiting).resolves.toMatchObject({
      requestId: launch.requestId,
      state: "exited",
      exitCode: 23,
    });
    expect(harness.inspections()).toBe(1);
  });

  test("an absent exact generation returns immediately for reconnect", async () => {
    const harness = terminalWaitHarness();
    await harness.controller.start(launch);
    await settle();

    await expect(
      harness.controller.waitForTerminal(
        mintSessionRequestId(1_750_000_000_100),
        10_000,
      ),
    ).resolves.toBeNull();
    harness.finishExit();
  });

  test("a bounded wait returns the current nonterminal snapshot", async () => {
    const harness = terminalWaitHarness();
    await harness.controller.start(launch);
    await settle();

    await expect(
      harness.controller.waitForTerminal(launch.requestId, 5),
    ).resolves.toMatchObject({
      requestId: launch.requestId,
      state: "running",
    });
    harness.finishExit();
  });

  test("a client disconnect releases its pending wait", async () => {
    const harness = terminalWaitHarness();
    await harness.controller.start(launch);
    await settle();
    const disconnect = new AbortController();

    const waiting = harness.controller.waitForTerminal(
      launch.requestId,
      10_000,
      disconnect.signal,
    );
    disconnect.abort();

    await expect(waiting).resolves.toMatchObject({ state: "running" });
    harness.finishExit();
  });

  test("failed native create releases its incomplete generation", async () => {
    const bindings = new MemoryBindings();
    const controller = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      providerRuns: new MemoryProviderRuns(),
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        ...terminalTermination,
        create: async (_spec, policy) => {
          bindings.bindTerminalHostSession(policy);
          throw new Error("native host registration failed");
        },
        inspect: async () => {
          throw new Error("not reached");
        },
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
    const providerRuns = new MemoryProviderRuns();
    const controller = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      providerRuns,
      visibility: {
        prepareAgentCreation: async () =>
          ++admissionAttempts < 2
            ? null
            : { engineBuildId: "engine-a", visibility, geometry },
      },
      terminalHost: {
        ...terminalTermination,
        create: async (spec, policy) => {
          expect(spec.geometry).toEqual(geometry);
          expect(spec.environment).toEqual({
            BASE_ENV: "base",
            HIVE_ROOT_FIXTURE: "1",
          });
          expect(spec.argv.slice(0, 4)).toEqual([
            TERMINAL_SHELL,
            "-l",
            "-i",
            "-c",
          ]);
          expect(spec.argv.at(-1)).toBe("'codex' '--no-alt-screen'");
          expect(spec.expectedExecutable).toBe(TERMINAL_SHELL);
          creates += 1;
          bindings.bindTerminalHostSession(policy);
          completeBinding(bindings, policy.locator);
          return {
            locator: spec.locator,
            inspection: inspection(policy.locator, "present"),
            created: true,
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
    expect(providerRuns.values).toHaveLength(1);
    expect(providerRuns.values[0]).toMatchObject({
      agentId: null,
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      launchGrantId: launch.requestId,
      runId: launch.providerRunId,
    });
    expect(bindings.values[0]?.locator).toEqual(ready.locator);
    expect(controller.snapshot()).toMatchObject({
      state: "exited",
      exitCode: 1,
    });
    await controller.start(launch);
    expect(creates).toBe(1);
  });

  test("surfaces visibility expiry so the supervisor can relaunch", async () => {
    const bindings = new MemoryBindings();
    const controller = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      providerRuns: new MemoryProviderRuns(),
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        ...terminalTermination,
        create: async (spec, policy) => {
          bindings.bindTerminalHostSession(policy);
          completeBinding(bindings, policy.locator);
          return {
            locator: spec.locator,
            inspection: inspection(policy.locator, "present"),
            created: true,
          };
        },
        inspect: async (value) => inspection(value, "exited", true),
      },
      sleep: async () => {},
    });
    await controller.start(launch);
    await settle();
    expect(controller.snapshot()).toMatchObject({
      state: "exited",
      diagnostic:
        "sessiond visibility expired; supervisor will relaunch if agents remain",
    });
  });

  test("daemon cancellation escapes both visibility and monitor waits", async () => {
    const waiting = new OrchestratorSessiondController({
      bindings: new MemoryBindings(),
      instanceId: "instance-a",
      providerRuns: new MemoryProviderRuns(),
      visibility: {
        prepareAgentCreation: async () => null,
      },
      terminalHost: {
        ...terminalTermination,
        create: async () => {
          throw new Error("not reached");
        },
        inspect: async () => {
          throw new Error("not reached");
        },
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
      providerRuns: new MemoryProviderRuns(),
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        ...terminalTermination,
        create: async (spec, policy) => {
          bindings.bindTerminalHostSession(policy);
          completeBinding(bindings, policy.locator);
          return {
            locator: spec.locator,
            inspection: inspection(policy.locator, "present"),
            created: true,
          };
        },
        inspect: async (value) => inspection(value, "present"),
        waitForExit: async (_locator, signal) =>
          await new Promise<{ kind: "aborted" }>((resolve) => {
            signal.addEventListener(
              "abort",
              () => resolve({ kind: "aborted" }),
              { once: true },
            );
          }),
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
      diagnostic:
        "queen sessiond controller canceled: test shutdown during monitor",
    });
  });

  test("a managed host cannot silently enter the inherited polling fallback", async () => {
    const bindings = new MemoryBindings();
    let inspections = 0;
    const controller = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      providerRuns: new MemoryProviderRuns(),
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        ...terminalTermination,
        create: async (spec, policy) => {
          bindings.bindTerminalHostSession(policy);
          completeBinding(bindings, policy.locator);
          return {
            locator: spec.locator,
            inspection: inspection(policy.locator, "present"),
            created: true,
          };
        },
        inspect: async (value) => {
          inspections += 1;
          return inspection(value, "present");
        },
        waitForExit: async () => ({ kind: "inherited" }),
      },
    });

    await controller.start(launch);
    await settle();

    expect(controller.snapshot()).toMatchObject({
      state: "failed",
      diagnostic: "queen sessiond managed host lost its exit handle",
    });
    expect(inspections).toBe(0);
  });

  test("a present observation resets the inherited failure budget indefinitely", async () => {
    const { bindings, providerRuns } = await seedCompletedRoot();
    let now = 0;
    let inspections = 0;
    let sleeps = 0;
    const controller = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      providerRuns,
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        ...terminalTermination,
        create: async () => {
          throw new Error("not reached");
        },
        inspect: async (value) => {
          inspections += 1;
          return inspection(value, inspections === 1 ? "unknown" : "present");
        },
        waitForExit: async () => ({ kind: "inherited" }),
      },
      inheritedObservationFailureTimeoutMs: 500,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
        sleeps += 1;
        if (sleeps >= 8) await new Promise<void>(() => {});
      },
    });

    await controller.start(launch);
    for (let turn = 0; turn < 100 && sleeps < 8; turn += 1) {
      await Promise.resolve();
    }

    expect(now).toBe(2_000);
    expect(controller.snapshot()?.state).toBe("running");
    expect(inspections).toBe(8);
    controller.cancel("test cleanup");
  });

  test("consecutive inherited observation failures exhaust their own budget", async () => {
    const { bindings, providerRuns } = await seedCompletedRoot();
    let now = 0;
    let inspections = 0;
    const controller = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      providerRuns,
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-a",
          visibility,
          geometry,
        }),
      },
      terminalHost: {
        ...terminalTermination,
        create: async () => {
          throw new Error("not reached");
        },
        inspect: async (value) => {
          inspections += 1;
          if (inspections % 2 === 1) throw new Error("host unavailable");
          return inspection(value, "unknown");
        },
        waitForExit: async () => ({ kind: "inherited" }),
      },
      inheritedObservationFailureTimeoutMs: 500,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await controller.start(launch);
    await expect(
      controller.waitForTerminal(launch.requestId, 1_000),
    ).resolves.toMatchObject({
      state: "failed",
      diagnostic: "queen sessiond inherited host could no longer be observed",
    });
    expect(inspections).toBe(3);
  });

  test("a daemon restart resumes the same durable root binding without a second create", async () => {
    const bindings = new MemoryBindings();
    const providerRuns = new MemoryProviderRuns();
    let creates = 0;
    const terminalHost: OrchestratorSessiondDependencies["terminalHost"] = {
      ...terminalTermination,
      create: async (spec) => {
        creates += 1;
        throw new Error(
          `unexpected second create for ${spec.locator.sessionId}`,
        );
      },
      inspect: async (value: HiveTerminalBinding["locator"]) =>
        inspection(value, "exited"),
      waitForExit: async () => ({ kind: "inherited" }),
    };
    const firstLocator = (
      await new OrchestratorSessiondController({
        bindings,
        instanceId: "instance-a",
        providerRuns,
        visibility: {
          prepareAgentCreation: async () => ({
            engineBuildId: "engine-a",
            visibility,
            geometry,
          }),
        },
        terminalHost: {
          ...terminalHost,
          create: async (spec, policy) => {
            creates += 1;
            bindings.bindTerminalHostSession(policy);
            completeBinding(bindings, policy.locator);
            return {
              locator: spec.locator,
              inspection: inspection(policy.locator, "present"),
              created: true,
            };
          },
          waitForExit: terminalTermination.waitForExit,
        },
        sleep: async () => {},
      }).start(launch)
    ).locator;
    await settle();

    const restarted = new OrchestratorSessiondController({
      bindings,
      instanceId: "instance-a",
      providerRuns,
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

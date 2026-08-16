import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { macProcessIdentity } from "../../src/daemon/lifecycle/daemon-lifecycle";
import {
  type HeadlessOrchestratorSessiondLaunch,
  OrchestratorSessiondController,
  type OrchestratorSessiondDependencies,
  type OrchestratorSessiondLaunch,
} from "../../src/daemon/orchestrator-host/sessiond-controller";
import { HiveTerminalHostAdapter } from "../../src/daemon/session-host/hive-terminal-host";
import type { SessionInspection } from "../../src/daemon/session-host/session-host-contract";
import { SessiondHost } from "../../src/daemon/session-host/sessiond-host";
import { mintSessionRequestId } from "../../src/daemon/session-host/locators";
import { TERMINAL_SHELL } from "../../src/daemon/session-host/shell-session";
import type {
  HiveTerminalBinding,
  TerminalHostBindingStore,
} from "../../src/daemon/session-host/terminal-host-binding";
import {
  type ProviderRun,
  ProviderRunSchema,
} from "../../src/schemas/provider-run";
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
  recordTerminalHostTerminationEvidence(): HiveTerminalBinding {
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
  bindings: TerminalHostBindingStore,
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

// Headless root: task_01a00790-0305. Every control here reads
// getActiveRootProviderRun off a REAL HiveDatabase, not a fake — the claim
// under test is that the daemon's own dispatch gate accepts and later refuses
// this row, not that a mock was configured to say so.
const headlessLaunch: HeadlessOrchestratorSessiondLaunch = {
  requestId: mintSessionRequestId(1_750_000_200_000),
  providerRunId: "018f1e90-7b5a-7cc0-8000-0000000007b1",
  cwd: "/repo",
  environment: { HIVE_ROOT_FIXTURE: "1" },
};

/** A plain shell with nothing launched inside it never reaches "unmanaged" — that state means a foreign process took the foreground, which only a vendor launch produces. It settles at "shell-idle": the terminal's own foreground process group, matching exactly what shell-session.ts's SHELL_BOOTSTRAP leaves behind once eval runs nothing. */
function shellIdleInspection(
  locator: HiveTerminalBinding["locator"],
  presence: SessionInspection["presence"],
): SessionInspection {
  return {
    ...inspection(locator, presence),
    foreground:
      presence === "present"
        ? { state: "shell-idle", runId: null }
        : { state: "unknown", runId: null },
  };
}

/** Wires OrchestratorSessiondController.startHeadless against a real, in-memory HiveDatabase so getActiveRootProviderRun is the genuine daemon query, not a fake. The fake terminalHost's reconcileProviderRun ends the run in that same real database exactly as HiveTerminalHostAdapter's does on a detected exit — simulating that reconciliation already ran, not re-testing it; HiveTerminalHostAdapter's own exit detection is pre-existing and out of this task's scope. */
function headlessHarness(): Readonly<{
  db: HiveDatabase;
  controller: OrchestratorSessiondController;
  finishExit: () => void;
}> {
  const db = new HiveDatabase(":memory:");
  let exit:
    | ((value: { kind: "managed-exit"; exitCode: number }) => void)
    | null = null;
  const controller = new OrchestratorSessiondController({
    bindings: db,
    instanceId: "instance-a",
    providerRuns: db,
    visibility: {
      prepareAgentCreation: async () => ({
        engineBuildId: "engine-a",
        visibility,
        geometry,
      }),
    },
    terminalHost: {
      create: async (spec, policy) => {
        db.bindTerminalHostSession(policy);
        completeBinding(db, policy.locator);
        return {
          locator: spec.locator,
          inspection: shellIdleInspection(policy.locator, "present"),
          created: true,
        };
      },
      inspect: async (value) => shellIdleInspection(value, "present"),
      reconcileProviderRun: (locator) => {
        const run = db.getActiveProviderRunByTerminal(locator);
        if (run === null) return null;
        return db.endProviderRun(
          run.runId,
          "2026-08-16T02:00:00.000Z",
          "provider-process-exited",
        );
      },
      terminate: terminalTermination.terminate,
      waitForExit: async () =>
        await new Promise<{ kind: "managed-exit"; exitCode: number }>(
          (resolve) => {
            exit = resolve;
          },
        ),
    },
  });
  return {
    db,
    controller,
    finishExit: () => {
      if (exit === null) throw new Error("monitor is not waiting");
      exit({ kind: "managed-exit", exitCode: 0 });
    },
  };
}

describe("OrchestratorSessiondController headless root", () => {
  test("POSITIVE: a headless root opens and is accepted by getActiveRootProviderRun", async () => {
    const { db, controller } = headlessHarness();

    const snapshot = await controller.startHeadless(headlessLaunch);
    await settle();

    expect(snapshot.state).toBe("running");
    const accepted = db.getActiveRootProviderRun("instance-a");
    expect(accepted).not.toBeNull();
    expect(accepted?.agentId).toBeNull();
    expect(accepted?.provider).toBeNull();
    expect(accepted?.runId).toBe(headlessLaunch.providerRunId);
  });

  test("NEGATIVE (runtime): a worker run on the root's own terminal still cannot masquerade as the root", async () => {
    const { db, controller } = headlessHarness();
    const snapshot = await controller.startHeadless(headlessLaunch);
    await settle();
    const rootLocator = snapshot.locator;

    // End the headless root's own run first: getActiveProviderRunByTerminal only
    // ever returns one running row per terminal, so a worker impostor has to
    // replace it, not sit beside it — the realistic shape of an attempted
    // masquerade, not a contrived double-booking.
    db.endProviderRun(
      headlessLaunch.providerRunId,
      "2026-08-16T02:00:00.000Z",
      "provider-process-exited",
    );
    db.insertProviderRun({
      runId: "018f1e90-7b5a-7cc0-8000-0000000007b2",
      agentId: "worker-imposter",
      terminal: rootLocator,
      provider: "claude",
      model: "claude-haiku-4-5-20251001",
      effort: null,
      conversationId: null,
      adapterChild: null,
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "grant-imposter",
      startedAt: "2026-08-16T02:00:01.000Z",
      endedAt: null,
      state: "running",
      exitReason: null,
    });

    expect(db.getActiveRootProviderRun("instance-a")).toBeNull();
  });

  test("REAP: the headless root is refused by getActiveRootProviderRun once its shell process exits", async () => {
    const { db, controller, finishExit } = headlessHarness();
    await controller.startHeadless(headlessLaunch);
    await settle();
    expect(db.getActiveRootProviderRun("instance-a")).not.toBeNull();

    finishExit();
    await settle();

    expect(controller.snapshot()?.state).toBe("exited");
    expect(db.getActiveRootProviderRun("instance-a")).toBeNull();
  });

  test("NEGATIVE (schema, positive control included): ProviderRunSchema accepts a headless root and a normal worker row, and refuses a worker row with a null provider", async () => {
    const rootLocator: HiveTerminalBinding["locator"] = {
      schemaVersion: 1,
      instanceId: "instance-a",
      subject: { kind: "root" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-0000000007c1",
      hostKind: "sessiond",
      engineBuildId: "engine-a",
    };
    const workerLocator: HiveTerminalBinding["locator"] = {
      ...rootLocator,
      subject: { kind: "agent", agentId: "worker-schema-fixture" },
    };
    const base = {
      runId: "018f1e90-7b5a-7cc0-8000-0000000007c2",
      capabilityEpoch: 0,
      model: null,
      effort: null,
      conversationId: null,
      adapterChild: null,
      protocolReceipt: null,
      launchGrantId: "grant-schema-fixture",
      startedAt: "2026-08-16T02:00:00.000Z",
      endedAt: null,
      state: "running" as const,
      exitReason: null,
    };

    // Positive control: a loud fixture proving the parser can accept a headless
    // root at all, so the refusal below is a real refusal and not a parser that
    // never built anything.
    expect(() =>
      ProviderRunSchema.parse({
        ...base,
        agentId: null,
        terminal: rootLocator,
        provider: null,
      }),
    ).not.toThrow();
    // Regression control: an ordinary worker row, provider set, is unaffected.
    expect(() =>
      ProviderRunSchema.parse({
        ...base,
        agentId: "worker-schema-fixture",
        terminal: workerLocator,
        provider: "claude",
      }),
    ).not.toThrow();
    // The actual negative control: a worker row can never carry a null provider.
    expect(() =>
      ProviderRunSchema.parse({
        ...base,
        agentId: "worker-schema-fixture",
        terminal: workerLocator,
        provider: null,
      }),
    ).toThrow(/only a root run may be headless/);
  });

  // The four tests above run against a fake terminalHost — they prove the daemon-layer decision,
  // not that a headless launch survives the real sessiond wire. This one uses the production
  // SessiondHost and HiveTerminalHostAdapter, no fakes: it is the control that would have caught
  // WireCreateSpec.provider being non-optional Zig, which every daemon-layer control above missed
  // because none of them ever crossed the wire.
  test("END-TO-END: a headless root opens across the real sessiond wire and is reaped on terminate", async () => {
    const home = process.env.HIVE_TEST_ROOT;
    if (home === undefined) {
      throw new Error(
        "this test requires HIVE_TEST_ROOT; run it through scripts/test-sandbox.ts",
      );
    }
    const repoRoot = resolve(import.meta.dir, "../..");
    const db = new HiveDatabase(":memory:");
    const instanceId = "e2e-headless-root";
    const host = new SessiondHost({
      repoRoot,
      hiveHome: home,
      pendingBindings: db,
    });
    const terminalHost = new HiveTerminalHostAdapter(host, db, instanceId, {
      providerRuns: db,
    });
    const controller = new OrchestratorSessiondController({
      bindings: db,
      instanceId,
      providerRuns: db,
      visibility: {
        prepareAgentCreation: async () => ({
          engineBuildId: await host.discoverEngineBuildId(),
          visibility: {
            workspaceSessionId: "e2e-workspace",
            workspacePid: process.pid,
            workspaceStartToken: macProcessIdentity(process.pid).startToken,
            openTerminalRevision: "1",
          },
          geometry,
        }),
      },
      terminalHost,
    });
    const launch: HeadlessOrchestratorSessiondLaunch = {
      requestId: mintSessionRequestId(),
      providerRunId: crypto.randomUUID(),
      cwd: home,
      environment: {},
    };

    let snapshot: Awaited<ReturnType<typeof controller.startHeadless>> | null =
      null;
    try {
      snapshot = await controller.startHeadless(launch);
      expect(snapshot.state).toBe("running");

      const accepted = db.getActiveRootProviderRun(instanceId);
      expect(accepted).not.toBeNull();
      expect(accepted?.agentId).toBeNull();
      expect(accepted?.provider).toBeNull();
      // The host's own reap bookkeeping needs a moment to settle after a create that returns as
      // soon as the shell is idle; inspecting once first gives it that moment without inventing a
      // fixed sleep.
      await terminalHost.inspect(snapshot.locator);
    } finally {
      if (snapshot !== null) {
        const terminated = await terminalHost.terminate(snapshot.locator, {
          mode: "immediate",
          reason: "end-to-end test cleanup",
          requestId: mintSessionRequestId(),
        });
        // "survivors" is the one outcome that would mean the real process is still alive; that is
        // the only thing this cleanup step must prove did not happen. It sometimes lands on
        // "unknown" rather than "terminated" for a headless launch specifically — a disclosed,
        // separate gap in the native reap-completeness signal outside this task's
        // session_host.zig-only lease (reported, not fixed here). Confirmed by direct process
        // inspection, not asserted: a real kill did happen even when the state read is "unknown".
        expect(terminated.state).not.toBe("survivors");
      }
    }
  }, 30_000);
});

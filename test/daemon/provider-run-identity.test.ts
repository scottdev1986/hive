import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/db";
import type { SessionInspection as ProductSessionInspection } from "../../src/daemon/session-host/contract";
import {
  HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  requireSessiondRootLocator,
  sessiondAgentProviderRunIsDead,
  sessiondForegroundJobIsDead,
} from "../../src/daemon/session-host/hive-terminal-host";
import type { HiveTerminalBinding } from "../../src/daemon/session-host/terminal-host-binding";
import type { SessionInspection } from "../../src/daemon/session-host/terminal-host-contract";
import { HiveSpawner } from "../../src/daemon/spawner-impl";
import {
  type AgentRecord,
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  type ProviderRun,
} from "../../src/schemas";

const endedAt = "2026-07-24T18:00:00.000Z";

function locator(provider: CapabilityProvider): HiveTerminalBinding["locator"] {
  const generation = CAPABILITY_PROVIDERS.indexOf(provider) + 1;
  return {
    schemaVersion: 1,
    instanceId: "identity-fixture",
    subject: { kind: "agent", agentId: `agent-${provider}` },
    generation,
    sessionId: `ses_018f1e90-7b5a-7cc0-8000-00000000010${generation}`,
    hostKind: "sessiond",
    engineBuildId: "engine-fixture",
  };
}

function neutralInspection(
  binding: HiveTerminalBinding,
  foregroundProcessGroupId: number,
): SessionInspection {
  return {
    session: {
      key: binding.locator.sessionId,
      incarnation: String(binding.locator.generation),
    },
    lifecycle: "running",
    completeness: "complete",
    host: { processId: 3_900, startToken: "3900:1" },
    child: { processId: 4_000, startToken: "4000:1" },
    jobControl: {
      sessionLeader: true,
      controllingTerminal: true,
      standardStreamsShareTerminal: true,
      childSessionId: 4_000,
      childProcessGroupId: 4_000,
      foregroundProcessGroupId,
      terminalIdentity: "/dev/ttys001",
      initialProfileAppliedBeforeExec: true,
      initialWindowAppliedBeforeExec: true,
      completeness: "complete",
    },
    window: {
      value: {
        columns: 80,
        rows: 24,
        widthPixels: 800,
        heightPixels: 480,
      },
      revision: "1",
    },
    output: {
      closed: false,
      retained: { start: "0", endExclusive: "0" },
    },
    checkpoints: { retained: 0, newest: null },
    inputOwner: null,
    exit: null,
    reap: {
      authority: "direct-parent",
      reaped: false,
      status: null,
      completeness: "complete",
    },
    descendants: [],
    survivors: [],
    evidenceAt: endedAt,
    diagnostics: [],
  };
}

function productInspection(
  terminal: HiveTerminalBinding["locator"],
  foreground: ProductSessionInspection["foreground"],
): ProductSessionInspection {
  return {
    schemaVersion: 1,
    locator: terminal,
    presence: "present",
    complete: true,
    hostPid: 3_900,
    hostStartToken: "3900:1",
    shellRoot: {
      pid: 4_000,
      startToken: "4000:1",
      processGroupId: 4_000,
    },
    foreground,
    expectedExecutable: "/bin/zsh",
    executableVerified: true,
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
      state: "visible",
      workspaceSessionId: "workspace-fixture",
      openTerminalRevision: "1",
      expiresAt: "2026-07-24T18:00:15.000Z",
    },
    exit: null,
    survivors: [],
    evidenceAt: endedAt,
    diagnosticIds: [],
  };
}

describe("C0 provider-run identity", () => {
  test("a live provider run is not dead when its terminal foreground changes", () => {
    const root = {
      ...locator("codex"),
      subject: { kind: "root" as const },
    };
    const unmanaged = {
      presence: "present" as const,
      diagnosticIds: [] as readonly string[],
      foreground: {
        state: "unmanaged" as const,
        runId: null,
        pid: 5_000,
        startToken: "5000:1",
        foregroundProcessGroupId: 5_000,
      },
    };
    const shellIdle = {
      ...unmanaged,
      foreground: { state: "shell-idle" as const, runId: null },
    };
    const activeRun: ProviderRun = {
      runId: crypto.randomUUID(),
      agentId: "agent-fixture",
      terminal: locator("codex"),
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
      conversationId: null,
      pid: 4_500,
      startToken: "4500:1",
      foregroundProcessGroupId: 4_500,
      capabilityEpoch: 0,
      launchGrantId: "grant-fixture",
      startedAt: endedAt,
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    expect(requireSessiondRootLocator(root)).toEqual(root);
    expect(() =>
      requireSessiondAgentLocator({
        id: "agent-fixture",
        sessionLocator: root,
      }),
    ).toThrow("mismatched sessiond SessionLocator");
    expect(sessiondForegroundJobIsDead(unmanaged)).toBe(false);
    expect(sessiondAgentProviderRunIsDead(shellIdle, activeRun)).toBe(false);
    expect(sessiondAgentProviderRunIsDead(unmanaged, activeRun)).toBe(false);
    expect(sessiondAgentProviderRunIsDead(unmanaged, null)).toBe(true);
  });

  for (const provider of CAPABILITY_PROVIDERS) {
    test(`${provider}: provider exit leaves the zsh session shell-idle and a manual command is unmanaged`, async () => {
      const db = new HiveDatabase(":memory:");
      const terminal = locator(provider);
      const visibility = {
        workspaceSessionId: "workspace-fixture",
        workspacePid: 3_800,
        workspaceStartToken: "3800:1",
        openTerminalRevision: "1",
      };
      db.bindTerminalHostSession({ locator: terminal, visibility });
      const binding = db.completeTerminalHostSession(terminal, {
        expectedExecutable: "/bin/zsh",
        executableVerified: true,
        verifiedShellRoot: {
          pid: 4_000,
          startToken: "4000:1",
          processGroupId: 4_000,
        },
        geometry: {
          columns: 80,
          rows: 24,
          widthPx: 800,
          heightPx: 480,
          cellWidthPx: 10,
          cellHeightPx: 20,
        },
        visibility: {
          state: "visible",
          workspaceSessionId: visibility.workspaceSessionId,
          openTerminalRevision: visibility.openTerminalRevision,
          expiresAt: "2026-07-24T18:00:15.000Z",
        },
      });
      let measured = neutralInspection(binding, 5_000);
      const host = {
        create: async () => {
          throw new Error("not used");
        },
        issueAttach: async () => {
          throw new Error("not used");
        },
        claimInput: async () => {
          throw new Error("not used");
        },
        submitInput: async () => {
          throw new Error("not used");
        },
        resize: async () => {
          throw new Error("not used");
        },
        inspect: async () => measured,
        list: async () => [measured],
        terminate: async () => ({
          state: "terminated" as const,
          exit: null,
          reap: {
            authority: "direct-parent" as const,
            reaped: true,
            status: null,
            completeness: "complete" as const,
          },
          survivors: [],
          completeness: "complete" as const,
          diagnostics: [],
        }),
      } satisfies ConstructorParameters<typeof HiveTerminalHostAdapter>[0];
      const run: ProviderRun = {
        runId: crypto.randomUUID(),
        agentId: `agent-${provider}`,
        terminal,
        provider,
        model: `${provider}-model`,
        effort: null,
        conversationId: null,
        pid: 5_000,
        startToken: "5000:1",
        foregroundProcessGroupId: 5_000,
        capabilityEpoch: 0,
        launchGrantId: `grant-${provider}`,
        startedAt: "2026-07-24T17:59:00.000Z",
        endedAt: null,
        state: "running",
        exitReason: null,
      };
      db.insertProviderRun(run);
      let providerStartToken = "5000:1";
      const adapter = new HiveTerminalHostAdapter(
        host,
        db,
        terminal.instanceId,
        {
          now: () => new Date(endedAt),
          providerRuns: db,
          processIdentity: (pid) => ({
            startToken: pid === 5_000 ? providerStartToken : `${pid}:1`,
          }),
        },
      );

      expect((await adapter.inspect(terminal)).foreground).toEqual({
        state: "managed",
        runId: run.runId,
        pid: 5_000,
        startToken: "5000:1",
        foregroundProcessGroupId: 5_000,
      });

      measured = neutralInspection(binding, 4_000);
      const idle = await adapter.inspect(terminal);
      expect(idle.presence).toBe("present");
      expect(idle.executableVerified).toBe(true);
      expect(idle.foreground).toEqual({ state: "shell-idle", runId: null });
      expect(await adapter.list(terminal.instanceId)).toHaveLength(1);
      expect(db.getProviderRun(run.runId)).toMatchObject({
        state: "running",
        endedAt: null,
      });
      expect(adapter.reconcileProviderRun(terminal)).toEqual(run);

      measured = neutralInspection(binding, 5_000);
      expect((await adapter.inspect(terminal)).foreground).toMatchObject({
        state: "managed",
        runId: run.runId,
      });

      measured = neutralInspection(binding, 4_000);
      providerStartToken = "5000:2";
      expect(adapter.reconcileProviderRun(terminal)).toBeNull();
      expect(db.getProviderRun(run.runId)).toMatchObject({
        state: "exited",
        endedAt,
        exitReason: "provider-process-exited",
      });

      measured = neutralInspection(binding, 6_000);
      expect((await adapter.inspect(terminal)).foreground).toEqual({
        state: "unmanaged",
        runId: null,
        pid: 6_000,
        startToken: "6000:1",
        foregroundProcessGroupId: 6_000,
      });
      expect(db.getActiveProviderRunByTerminal(terminal)).toBeNull();

      measured = neutralInspection(binding, 7_000);
      const reapedRun: ProviderRun = {
        ...run,
        runId: crypto.randomUUID(),
        pid: 7_000,
        startToken: "7000:1",
        foregroundProcessGroupId: 7_000,
        startedAt: "2026-07-24T17:59:30.000Z",
      };
      db.insertProviderRun(reapedRun);
      await adapter.terminate(terminal, {
        mode: "immediate",
        reason: "identity fixture",
        requestId: `req_018f1e90-7b5a-7cc0-8000-00000000020${terminal.generation}`,
      });
      expect(db.getProviderRun(reapedRun.runId)).toMatchObject({
        state: "exited",
        endedAt,
        exitReason: "terminal-reaped",
      });
      db.close();
    });
  }

  test.todo("grok live launch: pending until its quota pool resets at 2026-07-26T17:18Z", () => {});

  test("recovery launch mints a run, and a failed relaunch never kills the terminal", async () => {
    const db = new HiveDatabase(":memory:");
    const terminal = locator("codex");
    const record: AgentRecord = {
      id: "agent-codex",
      name: "codex-fixture",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "working",
      taskDescription: "identity fixture",
      worktreePath: "/tmp/codex-fixture",
      branch: "hive/codex-fixture",
      contextPct: null,
      createdAt: endedAt,
      lastEventAt: endedAt,
      recoveryAttempts: 0,
      capabilityEpoch: 2,
      readOnly: false,
      writeRevoked: false,
      sessionLocator: terminal,
    };
    const idle = productInspection(terminal, {
      state: "shell-idle",
      runId: null,
    });
    const launched = productInspection(terminal, {
      state: "unmanaged",
      runId: null,
      pid: 5_000,
      startToken: "5000:1",
      foregroundProcessGroupId: 5_000,
    });
    let inspections = 0;
    let terminations = 0;
    const spawner = new HiveSpawner({
      db,
      repoRoot: "/repo",
      port: 4_321,
      config: {},
      sleep: async () => {},
      stopSession: async () => ({ killed: [], survivors: [] }),
      sessiond: {
        prepareAgentCreation: async () => ({
          engineBuildId: terminal.engineBuildId,
          visibility: {
            workspaceSessionId: "workspace-fixture",
            workspacePid: 3_800,
            workspaceStartToken: "3800:1",
            openTerminalRevision: "1",
          },
          geometry: idle.geometry,
        }),
        admit: async () => null,
        terminalHost: {
          create: async () => ({
            locator: terminal,
            inspection: idle,
            created: true,
          }),
          inspect: async () => (++inspections < 2 ? idle : launched),
          terminate: async () => {
            terminations += 1;
            return {
              locator: terminal,
              state: "terminated",
              exit: null,
              survivors: [],
              errors: [],
            };
          },
        },
      },
    });

    await spawner.createRecoverySession(
      record,
      "codex --resume thread-fixture",
      "codex",
      "req_018f1e90-7b5a-7cc0-8000-000000000299",
      "018f1e90-7b5a-7cc0-8000-000000000298",
    );

    expect(inspections).toBe(2);
    expect(terminations).toBe(0);
    expect(db.getActiveProviderRunByTerminal(terminal)).toMatchObject({
      runId: "018f1e90-7b5a-7cc0-8000-000000000298",
      agentId: record.id,
      provider: "codex",
      pid: 5_000,
      startToken: "5000:1",
      capabilityEpoch: 2,
    });
    inspections = 0;
    // Not having observed the provider is not evidence that it failed. A
    // terminal that is up is left up: this used to terminate the session and
    // throw, which at 31 wide killed agents whose vendor TUI was rendered and
    // running, and left no audit when the terminate itself failed.
    await expect(
      spawner.createRecoverySession(
        record,
        "codex --resume thread-fixture",
        "codex",
        "req_018f1e90-7b5a-7cc0-8000-000000000300",
        "018f1e90-7b5a-7cc0-8000-000000000301",
      ),
    ).rejects.toThrow();
    expect(terminations).toBe(0);
    db.close();
  });
});

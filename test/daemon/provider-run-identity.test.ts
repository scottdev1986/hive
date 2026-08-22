import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  requireSessiondRootLocator,
  sessiondAgentProviderRunIsDead,
} from "../../src/daemon/session-host/hive-terminal-host";
import type { HiveTerminalBinding } from "../../src/daemon/session-host/terminal-host-binding";
import type { SessionInspection } from "../../src/daemon/session-host/terminal-host-contract";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
} from "../../src/schemas/capability";
import type { ProviderRun } from "../../src/schemas/provider-run";

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

describe("C0 provider-run identity", () => {
  test("a live provider run is not dead when its terminal foreground changes", () => {
    const root = {
      ...locator("codex"),
      subject: { kind: "root" as const },
    };
    const unmanaged = {
      presence: "present" as const,
      // SAFETY: The test owns this value and its fields.
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
      adapterChild: {
        pid: 4_500,
        startToken: "4500:1",
        processGroupId: 4_500,
        observedAt: endedAt,
      },
      protocolReceipt: null,
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
    expect(sessiondAgentProviderRunIsDead(shellIdle, activeRun)).toBe(false);
    expect(sessiondAgentProviderRunIsDead(unmanaged, activeRun)).toBe(false);
    expect(sessiondAgentProviderRunIsDead(unmanaged, null)).toBe(true);
  });

  for (const provider of CAPABILITY_PROVIDERS) {
    test(`${provider}: terminal foreground stays separate from reported provider identity`, async () => {
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
        waitForHostExit: async () => ({ kind: "inherited" as const }),
        create: async () => {
          throw new Error("not used");
        },
        issueAttach: async () => {
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
        adapterChild: {
          pid: 5_000,
          startToken: "5000:1",
          processGroupId: 5_000,
          observedAt: "2026-07-24T17:59:00.000Z",
        },
        protocolReceipt: null,
        capabilityEpoch: 0,
        launchGrantId: `grant-${provider}`,
        startedAt: "2026-07-24T17:59:00.000Z",
        endedAt: null,
        state: "running",
        exitReason: null,
      };
      db.insertProviderRun(run);
      let providerStartToken = "5000:1";
      let providerGroupState: "running" | "gone" = "running";
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
          processGroupState: () => providerGroupState,
        },
      );

      expect((await adapter.inspect(terminal)).foreground).toEqual({
        state: "unmanaged",
        runId: null,
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
        state: "unmanaged",
        runId: null,
      });

      measured = neutralInspection(binding, 4_000);
      providerStartToken = "5000:2";
      providerGroupState = "gone";
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
        adapterChild: {
          pid: 7_000,
          startToken: "7000:1",
          processGroupId: 7_000,
          observedAt: "2026-07-24T17:59:30.000Z",
        },
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
});

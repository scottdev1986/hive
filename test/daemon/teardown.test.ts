import { describe, expect, test } from "bun:test";
import { macProcessIdentity } from "../../src/daemon/lifecycle/daemon-lifecycle";
import {
  parseProcessTable,
  runPs,
} from "../../src/daemon/resource-management/resources";
import {
  captureProcessTree,
  type ReapDependencies,
  reapCapturedTree,
  stopSessiondAgentSession,
} from "../../src/daemon/resource-management/teardown";
import { HostOperationError } from "../../src/daemon/session-host/host-operations";
import { SessiondWireError } from "../../src/daemon/session-host/sessiond-host";
import type { AgentRecord } from "../../src/schemas/agent";
import type { ProviderRun } from "../../src/schemas/provider-run";
import { TerminationRequestSchema } from "../../src/schemas/session-protocol";
import { required } from "../required";
import { spawnTestChild } from "../support/spawn-test-child";
import { PROCESS_TABLE_VISIBLE_MS, waitUntil } from "../support/wait-until";

/** capture + reap, the way every caller uses them when nothing reparents. */
const reapProcessTree = async (
  roots: readonly number[],
  dependencies: ReapDependencies,
  selfPid: number,
) =>
  reapCapturedTree(
    await captureProcessTree(roots, dependencies, selfPid),
    dependencies,
    selfPid,
  );

/** The fake world covers states the kernel cannot safely produce on demand. */
interface FakeProcess {
  pid: number;
  ppid: number;
  command: string;
  stat?: string;
  /** Survives the kill, like a process wedged in uninterruptible IO. */
  unkillable?: boolean;
}

function world(processes: FakeProcess[]) {
  const alive = new Map(processes.map((entry) => [entry.pid, { ...entry }]));
  const signalled: number[] = [];
  const dependencies: ReapDependencies = {
    ps: async () =>
      [...alive.values()]
        .map((p) => `${p.pid} ${p.ppid} 1024 ${p.command}`)
        .join("\n"),
    psState: async () =>
      [{ pid: 1, ppid: 0, command: "init", stat: "S" }, ...alive.values()]
        .map((p) => `${p.pid} ${p.ppid} ${p.stat ?? "S"}`)
        .join("\n"),
    kill: (pid) => {
      signalled.push(pid);
      const target = alive.get(pid);
      if (target !== undefined && target.unkillable !== true) alive.delete(pid);
    },
    wait: async () => undefined,
  };
  return { dependencies, signalled, alive };
}

async function realProcesses() {
  return parseProcessTable(await runPs());
}

async function waitForProcess(
  predicate: (processes: Awaited<ReturnType<typeof realProcesses>>) => boolean,
  label: string,
): Promise<void> {
  await waitUntil(async () => predicate(await realProcesses()), {
    deadlineMs: PROCESS_TABLE_VISIBLE_MS,
    label,
  });
}

function processGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("reapProcessTree", () => {
  test("kills the whole process tree under the terminal", async () => {
    // The shape that actually leaks: the pane's shell owns the vendor CLI,
    // which owns an MCP stdio child. Stopping the terminal tears down the
    // pane; these keep running.
    const { dependencies, alive } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 101, ppid: 100, command: "claude --model opus" },
      { pid: 102, ppid: 101, command: "bun mcp-server" },
      { pid: 999, ppid: 1, command: "unrelated" },
    ]);

    const outcome = await reapProcessTree([100], dependencies, 1);

    expect(outcome.killed.map((p) => p.pid).sort()).toEqual([100, 101, 102]);
    expect(outcome.survivors).toEqual([]);
    expect(alive.has(999)).toBe(true);
  });

  test("a process that survives SIGKILL is reported, not rounded down to success", async () => {
    const { dependencies } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 101, ppid: 100, command: "wedged", unkillable: true },
    ]);

    const outcome = await reapProcessTree([100], dependencies, 1);

    expect(outcome.killed.map((p) => p.pid)).toEqual([100]);
    expect(outcome.survivors).toEqual([{ pid: 101, command: "wedged" }]);
  });

  test("a zombie counts as dead: it is an exit nobody reaped", async () => {
    const { dependencies } = world([
      { pid: 100, ppid: 1, command: "-zsh", stat: "Z", unkillable: true },
    ]);

    const outcome = await reapProcessTree([100], dependencies, 1);

    expect(outcome.survivors).toEqual([]);
    expect(outcome.killed.map((p) => p.pid)).toEqual([100]);
  });

  test("refuses the daemon itself as a process-tree root", async () => {
    const { dependencies, signalled } = world([
      { pid: 7, ppid: 1, command: "hive daemon" },
      { pid: 100, ppid: 7, command: "-zsh" },
    ]);

    await expect(reapProcessTree([7], dependencies, 7)).rejects.toThrow(
      "invalid root pid 7",
    );

    expect(signalled).not.toContain(7);
  });

  test("kills a detached child that was reparented to init", async () => {
    // Why capture is a separate step, and has to run first.
    //
    // The agent nohup'ed a command (101). Stopping the terminal tears the
    // pane down: the shell (100) dies, and 101 — which ignored the SIGHUP —
    // is reparented to init, so its ppid becomes 1. A tree walk performed
    // AFTER the session died finds nothing under 100 and reports a clean kill
    // over a process that is still running. Capturing first is what makes 101
    // killable, because at capture time it was still a child of the pane.
    const { dependencies, alive } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 101, ppid: 100, command: "nohup long-build" },
    ]);

    const captured = await captureProcessTree([100], dependencies, 1);

    // The terminal host stops the session. The shell dies; the nohup'ed child is reparented.
    alive.delete(100);
    const orphan = required(alive.get(101));
    orphan.ppid = 1;

    const outcome = await reapCapturedTree(captured, dependencies, 1);

    expect(outcome.killed.map((p) => p.pid).sort()).toEqual([100, 101]);
    expect(outcome.survivors).toEqual([]);
    expect(alive.has(101)).toBe(false);
  });

  test("real ps capture survives reparenting and reaps only the captured tree", async () => {
    const shell = Bun.spawn(["sh", "-c", "sleep 60 & wait"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const unrelated = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let childPid: number | undefined;
    try {
      await waitForProcess((processes) => {
        childPid = processes.find((entry) => entry.ppid === shell.pid)?.pid;
        return childPid !== undefined;
      }, `process ${shell.pid} to start its child`);
      expect(childPid).toBeDefined();
      await waitForProcess(
        (processes) => processes.some((entry) => entry.pid === unrelated.pid),
        `unrelated process ${unrelated.pid} to appear in the process table`,
      );

      const captured = await captureProcessTree([shell.pid]);
      expect(captured.map((entry) => entry.pid)).toContain(shell.pid);
      expect(captured.map((entry) => entry.pid)).toContain(required(childPid));

      shell.kill("SIGKILL");
      await shell.exited;
      await waitForProcess(
        (processes) =>
          processes.some(
            (entry) => entry.pid === childPid && entry.ppid !== shell.pid,
          ),
        `process ${required(childPid)} to reparent away from ${shell.pid}`,
      );

      const outcome = await reapCapturedTree(captured);

      expect(outcome.survivors).toEqual([]);
      expect(outcome.killed.map((entry) => entry.pid)).toContain(
        required(childPid),
      );
      await waitForProcess(
        (processes) => !processes.some((entry) => entry.pid === childPid),
        `process ${required(childPid)} to leave the process table after reap`,
      );
      expect(
        (await realProcesses()).some((entry) => entry.pid === unrelated.pid),
      ).toBe(true);
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The reaper already removed it.
        }
      }
      shell.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([shell.exited, unrelated.exited]);
    }
  });

  test("sessiond teardown requires frozen termination and reap readback", async () => {
    const sessionLocator = {
      schemaVersion: 1 as const,
      instanceId: "hive-fixture",
      subject: { kind: "agent" as const, agentId: "agent-maya" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000101",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-fixture",
    };
    const record = {
      id: "agent-maya",
      name: "maya",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "working",
      taskDescription: "test",
      worktreePath: "/tmp/maya",
      branch: "hive/maya-test",
      sessionLocator,
      contextPct: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      lastEventAt: "2026-07-13T00:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;
    let capabilityRevoked = false;
    const requests: unknown[] = [];

    await expect(
      stopSessiondAgentSession(
        record,
        {
          terminalHost: {
            terminate: async (locator, request) => {
              expect(capabilityRevoked).toBe(true);
              expect(locator).toEqual(sessionLocator);
              requests.push(request);
              return {
                locator: sessionLocator,
                state: "terminated",
                exit: null,
                survivors: [],
                errors: [],
              };
            },
          },
          readHostPid: async () => null,
        },
        () => {
          capabilityRevoked = true;
        },
      ),
    ).resolves.toEqual({ killed: [], survivors: [] });
    expect(requests).toHaveLength(1);
    expect(TerminationRequestSchema.parse(requests[0])).toMatchObject({
      mode: "immediate",
      reason: `stop agent ${record.id}`,
      requestId: expect.stringMatching(/^req_[0-9a-f-]+$/),
    });

    await expect(
      stopSessiondAgentSession(record, {
        terminalHost: {
          terminate: async () => ({
            locator: sessionLocator,
            state: "unknown",
            exit: null,
            survivors: [],
            errors: [
              {
                phase: "neutral-control",
                code: "UNKNOWN",
                diagnosticId: "no positive readback",
              },
            ],
          }),
        },
        readHostPid: async () => null,
      }),
    ).rejects.toThrow("not positively verified");

    await expect(
      stopSessiondAgentSession(record, {
        terminalHost: {
          terminate: async () => ({
            locator: sessionLocator,
            state: "unknown",
            exit: null,
            survivors: [],
            errors: [
              {
                phase: "process-tree-inspection",
                code: "UNKNOWN",
                diagnosticId: "process-tree-escapees-unaccounted",
              },
            ],
          }),
        },
        readHostPid: async () => null,
      }),
    ).resolves.toEqual({ killed: [], survivors: [] });
  });

  test("refuses VERIFIED teardown when the reported provider group is not gone", async () => {
    const sessionLocator = {
      schemaVersion: 1 as const,
      instanceId: "hive-fixture",
      subject: { kind: "agent" as const, agentId: "agent-provider" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000102",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-fixture",
    };
    const record = {
      id: "agent-provider",
      name: "provider",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "working",
      taskDescription: "test",
      worktreePath: "/tmp/provider",
      branch: "hive/provider-test",
      sessionLocator,
      contextPct: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      lastEventAt: "2026-07-13T00:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;
    const run: ProviderRun = {
      runId: "018f1e90-7b5a-7cc0-8000-000000000103",
      agentId: record.id,
      terminal: sessionLocator,
      provider: record.tool,
      model: record.model,
      effort: null,
      conversationId: null,
      adapterChild: {
        pid: 4_200,
        startToken: "4200:1",
        processGroupId: 4_200,
        observedAt: record.createdAt,
      },
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "grant-provider",
      startedAt: record.createdAt,
      endedAt: null,
      state: "running",
      exitReason: null,
    };

    await expect(
      stopSessiondAgentSession(record, {
        terminalHost: {
          stopProvider: async () => false,
          terminate: async () => ({
            locator: sessionLocator,
            state: "terminated",
            exit: null,
            survivors: [],
            errors: [],
          }),
        },
        readHostPid: async () => null,
        readProviderRun: () => run,
      }),
    ).rejects.toThrow("process group was not positively verified gone");
  });

  test("a frontend crash mid-turn still reaps a SIGTERM-trapping child group", async () => {
    const sessionLocator = {
      schemaVersion: 1 as const,
      instanceId: "hive-fixture",
      subject: { kind: "agent" as const, agentId: "agent-crashed-ui" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000104",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-fixture",
    };
    const record = {
      id: "agent-crashed-ui",
      name: "crashed-ui",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "working",
      taskDescription: "test",
      worktreePath: "/tmp/crashed-ui",
      branch: "hive/crashed-ui-test",
      sessionLocator,
      contextPct: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      lastEventAt: "2026-07-13T00:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;
    const child = spawnTestChild({
      executable: "/bin/sh",
      argv: ["-c", "trap '' TERM; echo ready; sleep 30 & wait"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    try {
      await new Promise<void>((resolve) => {
        child.stdout.once("data", () => resolve());
      });
      const run: ProviderRun = {
        runId: "018f1e90-7b5a-7cc0-8000-000000000105",
        agentId: record.id,
        terminal: sessionLocator,
        provider: record.tool,
        model: record.model,
        effort: null,
        conversationId: null,
        adapterChild: {
          pid: child.pid,
          startToken: macProcessIdentity(child.pid).startToken,
          processGroupId: child.pid,
          observedAt: record.createdAt,
        },
        protocolReceipt: null,
        capabilityEpoch: 0,
        launchGrantId: "grant-crashed-ui",
        startedAt: record.createdAt,
        endedAt: null,
        state: "running",
        exitReason: null,
      };
      await expect(
        stopSessiondAgentSession(record, {
          terminalHost: {
            stopProvider: async (_locator, expected) => {
              expect(expected.adapterChild).toEqual(run.adapterChild);
              await child.shutdown(150);
              return !processGroupAlive(child.pid);
            },
            terminate: async () => {
              throw new HostOperationError("frontend host already exited");
            },
          },
          readHostPid: async () => null,
          readProviderRun: () => run,
        }),
      ).resolves.toEqual({ killed: [], survivors: [] });
      expect(processGroupAlive(child.pid)).toBe(false);
    } finally {
      if (processGroupAlive(child.pid)) process.kill(-child.pid, "SIGKILL");
    }
  });

  test("an unreachable host is an already-dead session, but survivors still refuse", async () => {
    const sessionLocator = {
      schemaVersion: 1 as const,
      instanceId: "hive-fixture",
      subject: { kind: "agent" as const, agentId: "agent-terminal" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000202",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-fixture",
    };
    const record = {
      id: "agent-terminal",
      name: "terminal",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "working",
      taskDescription: "test",
      worktreePath: "/tmp/terminal",
      branch: "hive/terminal-test",
      sessionLocator,
      contextPct: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      lastEventAt: "2026-07-13T00:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;
    const hostGone = {
      terminate: async () => {
        throw new HostOperationError("host socket failed", {
          cause: new Error("ENOENT"),
        });
      },
    };

    // Nothing of the session's tree is left standing, so refusing would strand
    // shutdown to save a session that no longer exists.
    const empty = world([{ pid: 1, ppid: 0, command: "init" }]);
    await expect(
      stopSessiondAgentSession(record, {
        terminalHost: hostGone,
        reap: empty.dependencies,
        readHostPid: async () => null,
        selfPid: 1,
      }),
    ).resolves.toEqual({ killed: [], survivors: [] });

    // The guarantee the refusal exists for: a captured process that survives
    // SIGKILL is live work, and an unreachable host does not excuse it.
    const wedged = world([
      { pid: 100, ppid: 1, command: "sessiond host", unkillable: true },
    ]);
    await expect(
      stopSessiondAgentSession(record, {
        terminalHost: hostGone,
        reap: wedged.dependencies,
        readHostPid: async () => 100,
        selfPid: 1,
      }),
    ).rejects.toThrow("host socket failed");
  });

  test("a positively-absent root with a broker NOT_FOUND is a completed teardown", async () => {
    // The collapse shape: the host self-terminated on lease expiry long before
    // teardown ran, so the probe correctly finds no root and the broker has
    // already reaped the session. Two independent absences are a completed
    // teardown, not "could not be verified".
    const sessionLocator = {
      schemaVersion: 1 as const,
      instanceId: "hive-fixture",
      subject: { kind: "agent" as const, agentId: "agent-expired" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000303",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-fixture",
    };
    const record = {
      id: "agent-expired",
      name: "expired",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "working",
      taskDescription: "test",
      worktreePath: "/tmp/expired",
      branch: "hive/expired-test",
      sessionLocator,
      contextPct: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      lastEventAt: "2026-07-13T00:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;
    const brokerNotFound = {
      terminate: async () => {
        throw new SessiondWireError("NOT_FOUND", "no such session", null);
      },
    };

    const gone = world([{ pid: 100, ppid: 1, command: "sessiond host" }]);
    gone.alive.delete(100);
    await expect(
      stopSessiondAgentSession(record, {
        terminalHost: brokerNotFound,
        reap: gone.dependencies,
        readHostPid: async () => 100,
        selfPid: 1,
      }),
    ).resolves.toEqual({ killed: [], survivors: [] });

    // Negative control: NOT_FOUND against a root still standing in the process
    // table stays a failure — the session may be live while the broker
    // disagrees about it.
    const present = world([{ pid: 100, ppid: 1, command: "sessiond host" }]);
    await expect(
      stopSessiondAgentSession(record, {
        terminalHost: brokerNotFound,
        reap: present.dependencies,
        readHostPid: async () => 100,
        selfPid: 1,
      }),
    ).rejects.toThrow("NOT_FOUND");

    // Negative control: an absent root does not excuse a survivor reported by
    // the terminate readback — that is the failure the whole path exists for.
    const orphaned = world([
      { pid: 100, ppid: 1, command: "sessiond host" },
      { pid: 101, ppid: 100, command: "nohup long-build", unkillable: true },
    ]);
    orphaned.alive.delete(100);
    await expect(
      stopSessiondAgentSession(record, {
        terminalHost: {
          terminate: async () => ({
            locator: sessionLocator,
            state: "terminated",
            exit: null,
            survivors: [
              { pid: 101, startToken: "101:1", reason: "nohup long-build" },
            ],
            errors: [],
          }),
        },
        reap: orphaned.dependencies,
        readHostPid: async () => 100,
        selfPid: 1,
      }),
    ).rejects.toThrow("not positively verified");
  });

  test("refuses capture after the root has vanished", async () => {
    // The negative control for the test above: capturing after the root is gone
    // returns an empty tree, which would read as "nothing survived" rather than
    // as "nothing was measured".
    const { dependencies, alive } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 101, ppid: 100, command: "nohup long-build" },
    ]);

    alive.delete(100);
    required(alive.get(101)).ppid = 1;

    await expect(captureProcessTree([100], dependencies, 1)).rejects.toThrow(
      "did not contain root pid 100",
    );
  });

  test("refuses to report reaping when the verification probe sees no positive control", async () => {
    const { dependencies } = world([{ pid: 100, ppid: 1, command: "-zsh" }]);
    dependencies.psState = async () => "";

    await expect(reapProcessTree([100], dependencies, 1)).rejects.toThrow(
      "did not contain verification pid 1",
    );
  });

  test("no roots is a no-op, not a sweep of everything", async () => {
    const { dependencies, signalled } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
    ]);

    expect(await reapProcessTree([], dependencies, 1)).toEqual({
      killed: [],
      survivors: [],
    });
    expect(signalled).toEqual([]);
  });
});

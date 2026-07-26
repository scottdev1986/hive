// A crash resume must release the generation it supersedes, and it must do so
// BEFORE the record stops naming it.
//
// The host outlives its provider by design — terminal-stack-transition.html §02:
// the shell stays at a prompt after the provider exits — so a dead provider
// releases nothing. `resume()` then mints generation N+1 with a brand-new
// session id and persists it, and from that moment generation N exists in no
// record and no index: `stopSession`, `killAgentTeardown` and the MCP close all
// resolve the locator from the agent record, so nothing can address it again.
// Its sessiond slot is held until that host exits, which it never does.
//
// Measured with real vendor TUIs on real PTYs (prototypes/resume-leak): four
// resumes of ONE agent left four live, unaddressable hosts and consumed four of
// eight slots, while the only terminate production could issue reached just the
// newest generation. That is the second half of the CAPACITY_EXCEEDED
// exhaustion in planning/2026-07-25-sessiond-capacity-exhaustion.md.
import { describe, expect, test } from "bun:test";
import { CrashRecovery } from "../../src/daemon/recovery";
import type { SessionLocator } from "../../src/daemon/session-host/contract";
import type { AgentRecord } from "../../src/schemas";

// `sessionId` is a real `ses_`-tagged UUIDv7: `requireSessiondAgentLocator`
// parses the locator through its schema, and a hand-written id is rejected
// before any terminate can be attempted — which reads exactly like the fix not
// running.
function locatorFor(generation: number, sessionId: string): SessionLocator {
  return {
    schemaVersion: 1,
    instanceId: "inst-test",
    subject: { kind: "agent", agentId: "agt_superseded" },
    generation,
    sessionId,
    hostKind: "sessiond",
    engineBuildId: "engine-test",
  };
}

function agentRecord(): AgentRecord {
  return {
    id: "agt_superseded",
    name: "aria",
    sessionLocator: locatorFor(1, "ses_019f7e00-0000-7000-8000-000000000001"),
  } as unknown as AgentRecord;
}

/** Records every terminate, with the record's locator as it stood at the call. */
class RecordingTerminalHost {
  readonly terminated: { generation: number; sessionId: string }[] = [];
  result: { state: string; survivors: unknown[] } = {
    state: "terminated",
    survivors: [],
  };
  failure: Error | null = null;

  async terminate(locator: SessionLocator): Promise<unknown> {
    if (this.failure !== null) throw this.failure;
    this.terminated.push({
      generation: locator.generation,
      sessionId: locator.sessionId,
    });
    return { ...this.result, locator, exit: null, errors: [] };
  }

  async inspect(): Promise<never> {
    throw new Error("not used");
  }

  reconcileProviderRun(): null {
    return null;
  }
}

/** Reaches the private release step with the record exactly as `resume` has it. */
function releaseSuperseded(
  recovery: CrashRecovery,
  agent: AgentRecord,
): Promise<void> {
  return (
    recovery as unknown as {
      releaseSupersededGeneration: (agent: AgentRecord) => Promise<void>;
    }
  ).releaseSupersededGeneration(agent);
}

function recoveryWith(terminalHost: RecordingTerminalHost): CrashRecovery {
  return new CrashRecovery({
    db: {} as never,
    terminalHost: terminalHost as never,
    port: 0,
    send: async () => undefined,
    settleQuota: async () => undefined,
    flushQueued: async () => undefined,
  });
}

describe("a resume releases the generation it supersedes", () => {
  // The rows below drive `releaseSupersededGeneration` directly, which pins WHAT
  // it does but not THAT the resume calls it — deleting the call site keeps them
  // green, which is precisely the hole recovery-session-wiring.test.ts was
  // written about. This row pins the ORDER at the call site: the terminate must
  // land before the upsert that replaces the locator, because after that upsert
  // the old generation is unnameable.
  test("terminates BEFORE the record stops naming the old generation", async () => {
    const events: string[] = [];
    const terminalHost = new RecordingTerminalHost();
    const original = terminalHost.terminate.bind(terminalHost);
    terminalHost.terminate = async (locator: SessionLocator) => {
      events.push(`terminate:generation-${locator.generation}`);
      return original(locator);
    };
    const agent = agentRecord();
    const db = {
      upsertAgent: (record: AgentRecord) => {
        events.push(`upsert:generation-${record.sessionLocator?.generation}`);
        return record;
      },
      getAgentById: () => agent,
      listApprovals: () => [],
      resolveApproval: () => undefined,
    };
    const recovery = new CrashRecovery({
      db: db as never,
      terminalHost: terminalHost as never,
      port: 0,
      send: async () => undefined,
      settleQuota: async () => undefined,
      flushQueued: async () => undefined,
    });

    // The resume cannot complete here — it has no execution identity, no
    // adapter and no launch authorization — and it does not need to. Everything
    // this row is about happens in its first three statements.
    await (
      recovery as unknown as {
        resume: (agent: AgentRecord, sessionId: string) => Promise<unknown>;
      }
    )
      .resume(agent, "tool-session")
      .catch(() => undefined);

    expect(events[0]).toBe("terminate:generation-1");
    expect(events).toContain("upsert:generation-2");
    expect(events.indexOf("terminate:generation-1")).toBeLessThan(
      events.indexOf("upsert:generation-2"),
    );
  });

  test("terminates the generation the record still names", async () => {
    const terminalHost = new RecordingTerminalHost();
    const recovery = recoveryWith(terminalHost);

    await releaseSuperseded(recovery, agentRecord());

    expect(terminalHost.terminated).toEqual([
      { generation: 1, sessionId: "ses_019f7e00-0000-7000-8000-000000000001" },
    ]);
  });

  test("a terminate that does not verify is reported, and never blocks the resume", async () => {
    const terminalHost = new RecordingTerminalHost();
    terminalHost.result = { state: "unknown", survivors: [] };
    const recovery = recoveryWith(terminalHost);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      await releaseSuperseded(recovery, agentRecord());
    } finally {
      console.error = original;
    }

    expect(errors.join("\n")).toContain("superseded terminal");
    expect(errors.join("\n")).toContain("slot stays occupied");
  });

  test("a throwing terminate is reported, and never blocks the resume", async () => {
    const terminalHost = new RecordingTerminalHost();
    terminalHost.failure = new Error("broker unavailable");
    const recovery = recoveryWith(terminalHost);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      await expect(releaseSuperseded(recovery, agentRecord())).resolves.toBe(
        undefined,
      );
    } finally {
      console.error = original;
    }

    expect(errors.join("\n")).toContain("broker unavailable");
  });

  test("an agent with no sessiond generation is left alone", async () => {
    const terminalHost = new RecordingTerminalHost();
    const recovery = recoveryWith(terminalHost);

    await releaseSuperseded(recovery, {
      id: "agt_superseded",
      name: "aria",
    } as unknown as AgentRecord);

    expect(terminalHost.terminated).toEqual([]);
  });
});

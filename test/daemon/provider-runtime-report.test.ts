import { describe, expect, test } from "bun:test";
import {
  observeAdapterChild,
  providerRuntimeReporter,
} from "../../src/cli/agent-ui/runtime-report";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { hiveInstanceSuffix } from "../../src/hive-home/instance-identity";
import { macProcessIdentity } from "../../src/daemon/lifecycle/daemon-lifecycle";
import { HiveDaemon } from "../../src/daemon/server";
import { ORCHESTRATOR_NAME, type AgentRecord } from "../../src/schemas/agent";
import type { ProviderRun } from "../../src/schemas/provider-run";
import { required } from "../required";
import { spawnTestChild } from "../support/spawn-test-child";

const AT = "2026-08-02T12:00:00.000Z";

function harness() {
  const db = new HiveDatabase(":memory:");
  const terminal = {
    schemaVersion: 1 as const,
    instanceId: "runtime-report-test",
    subject: { kind: "agent" as const, agentId: "agent-ada" },
    generation: 1,
    sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000701",
    hostKind: "sessiond" as const,
    engineBuildId: "engine-runtime-report",
  };
  const agent = {
    id: "agent-ada",
    name: "ada",
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "standard_coding",
    status: "working",
    taskDescription: "runtime report",
    worktreePath: "/tmp/ada",
    branch: "hive/ada",
    sessionLocator: terminal,
    contextPct: null,
    createdAt: AT,
    lastEventAt: AT,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  } satisfies AgentRecord;
  db.insertAgent(agent);
  const run: ProviderRun = {
    runId: "018f1e90-7b5a-7cc0-8000-000000000702",
    agentId: agent.id,
    terminal,
    provider: agent.tool,
    model: agent.model,
    effort: null,
    conversationId: null,
    adapterChild: null,
    protocolReceipt: null,
    capabilityEpoch: 0,
    launchGrantId: "grant-runtime-report",
    startedAt: AT,
    endedAt: null,
    state: "running",
    exitReason: null,
  };
  db.insertProviderRun(run);
  const daemon = new HiveDaemon({
    db,
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: { spawn: async () => agent },
    repoRoot: "/tmp/hive-runtime-report-test",
  });
  const fetcherFor = (subject: string, role: "writer" | "orchestrator") => {
    const token = daemon.capabilities.mint(subject, role, { epoch: 0 }).token;
    return (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return daemon.fetch(new Request(input, { ...init, headers }));
    };
  };
  const fetcher = fetcherFor("ada", "writer");
  return { daemon, db, run, fetcher, fetcherFor };
}

/**
 * The queen's own provider run: keyed on the terminal it was launched into and
 * carrying no agentId, because the root is a capability subject with no agent
 * record. `bindTerminal` false leaves the run with no terminal binding the
 * daemon can find, which is how a run belonging to some other terminal looks.
 */
function seedRoot(
  db: HiveDatabase,
  options: { readonly bindTerminal: boolean; readonly agentId?: string },
): ProviderRun {
  const terminal = {
    schemaVersion: 1 as const,
    instanceId: hiveInstanceSuffix(),
    subject: { kind: "root" as const },
    generation: 1,
    sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000801",
    hostKind: "sessiond" as const,
    engineBuildId: "engine-runtime-report",
  };
  if (options.bindTerminal) {
    db.bindTerminalHostSession({
      locator: terminal,
      visibility: {
        workspaceSessionId: "workspace-runtime-report",
        workspacePid: 4_321,
        workspaceStartToken: "workspace-start-token",
        openTerminalRevision: "1",
      },
    });
  }
  return db.insertProviderRun({
    runId: "018f1e90-7b5a-7cc0-8000-000000000802",
    agentId: options.agentId ?? null,
    terminal,
    provider: "codex",
    model: null,
    effort: null,
    conversationId: null,
    adapterChild: null,
    protocolReceipt: null,
    capabilityEpoch: 0,
    launchGrantId: "grant-runtime-report-root",
    startedAt: AT,
    endedAt: null,
    state: "running",
    exitReason: null,
  });
}

describe("frontend provider runtime reports", () => {
  test("retries a transport failure before reporting runtime", async () => {
    let calls = 0;
    const reporter = providerRuntimeReporter(
      "ada",
      "018f1e90-7b5a-7cc0-8000-000000000704",
      4_321,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket closed");
        return new Response(null, { status: 204 });
      },
    );
    await reporter.reportReceipt({
      clientInputId: "018f1e90-7b5a-7cc0-8000-000000000703",
      outcome: "accepted",
      turnId: "turn-1",
    });
    expect(calls).toBe(2);
  });
  test("binds the exact adapter child, then records the protocol receipt", async () => {
    const { db, run, fetcher } = harness();
    const child = spawnTestChild({
      executable: "/bin/sh",
      argv: ["-c", "sleep 30"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    try {
      const reporter = providerRuntimeReporter(
        "ada",
        run.runId,
        4_321,
        fetcher,
      );
      const identity = observeAdapterChild(
        { pid: child.pid, processGroupId: child.pid },
        macProcessIdentity,
        new Date(AT),
      );
      await reporter.reportChild(identity);
      expect(db.getProviderRun(run.runId)?.adapterChild).toEqual(identity);

      await reporter.reportReceipt({
        clientInputId: "018f1e90-7b5a-7cc0-8000-000000000703",
        outcome: "accepted",
        turnId: "turn-1",
      });
      expect(db.getProviderRun(run.runId)?.protocolReceipt).toMatchObject({
        clientInputId: "018f1e90-7b5a-7cc0-8000-000000000703",
        outcome: "accepted",
        turnId: "turn-1",
        reportedAt: expect.any(String),
      });
    } finally {
      await child.shutdown(100);
    }
  });

  /**
   * A receipt is the pane process speaking for itself, so it is proof the agent
   * is alive. It matters most for the outcomes no turn ever follows: a
   * submission the vendor refused, or one whose acknowledgement was lost, is
   * exactly when an agent is stuck rather than working — and a liveness
   * timestamp that freezes there is what gets a working agent called dead.
   */
  test("a receipt no turn will follow still advances liveness", async () => {
    const { db, run, fetcher } = harness();
    const child = spawnTestChild({
      executable: "/bin/sh",
      argv: ["-c", "sleep 30"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    try {
      const reporter = providerRuntimeReporter(
        "ada",
        run.runId,
        4_321,
        fetcher,
      );
      await reporter.reportChild(
        observeAdapterChild(
          { pid: child.pid, processGroupId: child.pid },
          macProcessIdentity,
          new Date(AT),
        ),
      );
      db.upsertAgent({
        ...required(db.getAgentById("agent-ada")),
        lastEventAt: AT,
      });

      await reporter.reportReceipt({
        clientInputId: "018f1e90-7b5a-7cc0-8000-000000000704",
        outcome: "rejected",
        turnId: null,
      });
      expect(db.getProviderRun(run.runId)?.protocolReceipt).toMatchObject({
        outcome: "rejected",
      });
      expect(required(db.getAgentById("agent-ada")).lastEventAt > AT).toBe(
        true,
      );
    } finally {
      await child.shutdown(100);
    }
  });

  test("rejects stale identity evidence without poisoning the pending run", async () => {
    const { db, run, fetcher } = harness();
    const child = spawnTestChild({
      executable: "/bin/sh",
      argv: ["-c", "sleep 30"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    try {
      const identity = observeAdapterChild(
        { pid: child.pid, processGroupId: child.pid },
        macProcessIdentity,
        new Date(AT),
      );
      const stale = await fetcher("http://hive/provider-runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: "adapter-child",
          providerRunId: run.runId,
          identity: { ...identity, startToken: `${identity.startToken}:stale` },
        }),
      });
      expect(stale.status).toBe(409);
      expect(db.getProviderRun(run.runId)?.adapterChild).toBeNull();

      const reporter = providerRuntimeReporter(
        "ada",
        run.runId,
        4_321,
        fetcher,
      );
      await reporter.reportChild(identity);
      expect(db.getProviderRun(run.runId)?.adapterChild).toEqual(identity);
    } finally {
      await child.shutdown(100);
    }
  });

  test("the root reports the run its own terminal carries", async () => {
    const { db, fetcherFor } = harness();
    const root = seedRoot(db, { bindTerminal: true });
    const queen = fetcherFor(ORCHESTRATOR_NAME, "orchestrator");
    const child = spawnTestChild({
      executable: "/bin/sh",
      argv: ["-c", "sleep 30"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    try {
      const identity = observeAdapterChild(
        { pid: child.pid, processGroupId: child.pid },
        macProcessIdentity,
        new Date(AT),
      );
      const bound = await queen("http://hive/provider-runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: "adapter-child",
          providerRunId: root.runId,
          identity,
        }),
      });
      expect(bound.status).toBe(200);
      expect(db.getProviderRun(root.runId)?.adapterChild).toEqual(identity);

      const receipt = await queen("http://hive/provider-runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: "protocol-receipt",
          providerRunId: root.runId,
          receipt: {
            clientInputId: "018f1e90-7b5a-7cc0-8000-000000000803",
            outcome: "accepted",
            turnId: "turn-root",
          },
        }),
      });
      expect(receipt.status).toBe(200);
      expect(db.getProviderRun(root.runId)?.protocolReceipt).toMatchObject({
        clientInputId: "018f1e90-7b5a-7cc0-8000-000000000803",
        outcome: "accepted",
        turnId: "turn-root",
      });
      // The run still belongs to no agent. Authorizing the root must not have
      // given it one, because the identity it would have to invent is exactly
      // the fact the report is trusted to carry.
      expect(db.getProviderRun(root.runId)?.agentId).toBeNull();
    } finally {
      await child.shutdown(100);
    }
  });

  /**
   * The two facts beyond the root capability that the authorization rests on.
   * Each is asserted by its refusal message rather than by the status alone,
   * because the receipt writer refuses an unbound run too — a bare 409 here
   * passes whether or not the endpoint ever looked at the terminal.
   */
  test.each([
    ["its terminal does not carry", { bindTerminal: false }],
    ["belongs to an agent", { bindTerminal: true, agentId: "agent-ada" }],
  ] as const)("the root is refused a run that %s", async (_label, options) => {
    const { db, fetcherFor } = harness();
    const root = seedRoot(db, options);
    const refused = await fetcherFor(ORCHESTRATOR_NAME, "orchestrator")(
      "http://hive/provider-runtime",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: "protocol-receipt",
          providerRunId: root.runId,
          receipt: {
            clientInputId: "018f1e90-7b5a-7cc0-8000-000000000804",
            outcome: "accepted",
            turnId: "turn-root",
          },
        }),
      },
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "provider runtime report is stale",
    });
    expect(db.getProviderRun(root.runId)?.protocolReceipt).toBeNull();
  });

  test("an agent is still refused a run that is not its own", async () => {
    const { db, run, fetcher, fetcherFor } = harness();
    const root = seedRoot(db, { bindTerminal: true });
    const receipt = {
      clientInputId: "018f1e90-7b5a-7cc0-8000-000000000805",
      outcome: "accepted" as const,
      turnId: "turn-1",
    };
    const post = (call: ReturnType<typeof fetcherFor>, providerRunId: string) =>
      call("http://hive/provider-runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: "protocol-receipt",
          providerRunId,
          receipt,
        }),
      });

    // The root's run is agentId-null and live, which is the shape the root
    // branch authorizes. An agent's credential must not reach it.
    const crossed = await post(fetcher, root.runId);
    expect(crossed.status).toBe(409);
    expect(await crossed.json()).toEqual({
      error: "provider runtime report is stale",
    });
    expect(db.getProviderRun(root.runId)?.protocolReceipt).toBeNull();

    // A live agent with no provider run of its own.
    db.insertAgent({
      id: "agent-bo",
      name: "bo",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "standard_coding",
      status: "working",
      taskDescription: "no run",
      worktreePath: "/tmp/bo",
      branch: "hive/bo",
      contextPct: null,
      createdAt: AT,
      lastEventAt: AT,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord);
    const absent = await post(fetcherFor("bo", "writer"), run.runId);
    expect(absent.status).toBe(409);
    expect(await absent.json()).toEqual({
      error: "provider runtime report is stale",
    });

    // A name with no agent record at all is still not a subject.
    const unknown = await post(fetcherFor("nobody", "writer"), run.runId);
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({
      error: "provider runtime has no live agent",
    });
    expect(db.getProviderRun(run.runId)?.protocolReceipt).toBeNull();
  });
});

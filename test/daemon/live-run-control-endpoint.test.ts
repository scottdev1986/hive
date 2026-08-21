import { describe, expect, test } from "bun:test";
import type { Capability } from "../../src/schemas/capability";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { liveRunControlEndpoint } from "../../src/daemon/live-run-control/live-run-control-endpoint";
import { HiveDaemon } from "../../src/daemon/server";
import type { TerminalControlInspection } from "../../src/daemon/session-host/hive-terminal-host";
import type { HiveTerminalBinding } from "../../src/daemon/session-host/terminal-host-binding";
import type { AgentRecord } from "../../src/schemas/agent";
import {
  LiveRunControlIntentSchema,
  LiveRunControlProjectionSchema,
  LiveRunControlResultSchema,
  type LiveRunControlIntent,
} from "../../src/schemas/live-run-control";
import type { ProviderRun } from "../../src/schemas/provider-run";
import { definedFields } from "../../src/shared/defined-fields";

const AT = "2026-08-15T20:00:00.000Z";
const locator = {
  schemaVersion: 1 as const,
  instanceId: "live-run-control-fixture",
  subject: { kind: "agent" as const, agentId: "agent-ada" },
  generation: 1,
  sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000901",
  hostKind: "sessiond" as const,
  engineBuildId: "engine-live-run-control",
};
const shellRoot = {
  pid: 4_000,
  startToken: "4000:123400",
  processGroupId: 4_000,
};
const providerChild = {
  pid: 4_100,
  startToken: "4100:123400",
  processGroupId: 4_100,
  observedAt: AT,
};
const agent: AgentRecord = {
  id: "agent-ada",
  name: "ada",
  tool: "codex",
  model: "gpt-5.6-sol",
  category: "standard_coding",
  status: "working",
  taskDescription: "live run process control",
  worktreePath: "/tmp/hive-ada",
  branch: "hive/ada",
  sessionLocator: locator,
  contextPct: null,
  createdAt: AT,
  lastEventAt: AT,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
};
const run: ProviderRun = {
  runId: "018f1e90-7b5a-7cc0-8000-000000000902",
  agentId: agent.id,
  terminal: locator,
  provider: agent.tool,
  model: agent.model,
  effort: null,
  conversationId: null,
  adapterChild: providerChild,
  protocolReceipt: null,
  capabilityEpoch: 0,
  launchGrantId: "grant-live-run-control",
  startedAt: AT,
  endedAt: null,
  state: "running",
  exitReason: null,
};
const capability: Capability = {
  id: "cap_user",
  subject: "user",
  role: "user",
  epoch: 0,
  issuedAt: AT,
  expiresAt: "2026-08-16T20:00:00.000Z",
  revokedAt: null,
};

function liveInspection(
  foregroundProcessGroupId = providerChild.processGroupId,
): TerminalControlInspection {
  return {
    terminal: {
      schemaVersion: 1,
      locator,
      presence: "present",
      complete: true,
      hostPid: 3_900,
      hostStartToken: "3900:123400",
      shellRoot,
      foreground: {
        state: "unmanaged",
        runId: null,
        pid: foregroundProcessGroupId,
        startToken:
          foregroundProcessGroupId === providerChild.pid
            ? providerChild.startToken
            : shellRoot.startToken,
        foregroundProcessGroupId,
      },
      expectedExecutable: "/bin/zsh",
      executableVerified: true,
      outputSeq: "20",
      checkpointSeq: "20",
      checkpointAvailable: true,
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
        expiresAt: "2026-08-15T20:05:00.000Z",
      },
      exit: null,
      survivors: [],
      evidenceAt: AT,
      diagnosticIds: [],
    },
    foregroundProcessGroupId,
    processCensus: {
      completeness: "complete",
      members: [
        { pid: shellRoot.pid, startToken: shellRoot.startToken },
        { pid: providerChild.pid, startToken: providerChild.startToken },
        { pid: 4_200, startToken: "4200:123400" },
      ],
      evidenceAt: AT,
      diagnostics: [],
    },
  };
}

function terminatedInspection(): TerminalControlInspection {
  return {
    ...liveInspection(shellRoot.processGroupId),
    terminal: {
      ...liveInspection(shellRoot.processGroupId).terminal,
      presence: "lost",
      complete: false,
      hostPid: null,
      hostStartToken: null,
      shellRoot: null,
      executableVerified: false,
      foreground: { state: "unknown", runId: null },
      diagnosticIds: ["SESSIOND_HOST_ALREADY_ABSENT"],
    },
    foregroundProcessGroupId: null,
    processCensus: {
      completeness: "unavailable",
      members: [],
      evidenceAt: AT,
      diagnostics: ["SESSIOND_HOST_ALREADY_ABSENT"],
    },
  };
}

function harness() {
  let activeRun: ProviderRun | null = run;
  let inspection = liveInspection();
  let binding: HiveTerminalBinding = {
    locator,
    visibility: {
      workspaceSessionId: "workspace-fixture",
      workspacePid: 3_800,
      workspaceStartToken: "3800:123400",
      openTerminalRevision: "1",
    },
    createEvidence: {
      expectedExecutable: "/bin/zsh",
      executableVerified: true,
      verifiedShellRoot: shellRoot,
      geometry: inspection.terminal.geometry,
      visibility: inspection.terminal.visibility,
    },
  };
  const stopCalls: ProviderRun[] = [];
  const terminateCalls: AgentRecord[] = [];
  const actions: string[] = [];
  const deps = {
    db: {
      getAgentById: (id: string) => (id === agent.id ? agent : null),
      getActiveProviderRunForAgent: (id: string) =>
        id === agent.id ? activeRun : null,
      getTerminalHostBindingByLocator: () => binding,
    },
    terminalHost: {
      inspectControl: async () => inspection,
      reconcileProviderRun: () => activeRun,
      verifyAdapterChildIdentity: () => true,
      stopProvider: async (_locator: typeof locator, expected: ProviderRun) => {
        stopCalls.push(expected);
        activeRun = null;
        inspection = liveInspection(shellRoot.processGroupId);
        inspection = {
          ...inspection,
          processCensus: {
            ...inspection.processCensus,
            members: [{ pid: shellRoot.pid, startToken: shellRoot.startToken }],
          },
        };
        return true;
      },
    },
    terminateAgent: async (record: AgentRecord) => {
      terminateCalls.push(record);
      activeRun = null;
      inspection = terminatedInspection();
      binding = {
        ...binding,
        terminationEvidence: {
          completedAt: AT,
          result: {
            locator,
            state: "terminated",
            exit: null,
            survivors: [],
            errors: [],
          },
        },
      };
    },
    now: () => new Date(AT),
    authenticate: () => ({ ok: true as const, capability }),
    authorize: (_capability: Capability, _route: string, action: string) => {
      actions.push(action);
      return { ok: true as const, capability };
    },
    denied: () => Response.json({ error: "denied" }, { status: 403 }),
  };
  return { deps, stopCalls, terminateCalls, actions };
}

function intent(operation: "stop-provider" | "terminate-terminal") {
  return LiveRunControlIntentSchema.parse({
    schemaVersion: 1,
    intentId: `intent-${operation}`,
    expected: { kind: "epoch", epoch: String(locator.generation) },
    idempotencyKey: `idempotency-${operation}`,
    body: {
      operation,
      agentId: agent.id,
      locator,
      expectedShellRoot: shellRoot,
      ...definedFields({
        expectedProviderRunId:
          operation === "stop-provider" ? run.runId : undefined,
      }),
    },
  });
}

function request(body?: LiveRunControlIntent) {
  return new Request(
    body === undefined
      ? `http://hive/live-run-control?agentId=${agent.id}`
      : "http://hive/live-run-control",
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}

describe("Live Run process controls", () => {
  test("the daemon route requires the user credential for reads and writes", async () => {
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      db,
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: {
        spawn: async () => {
          throw new Error("no spawn");
        },
      },
      repoRoot: "/tmp/hive-live-run-control-endpoint",
    });
    expect(
      (
        await daemon.fetch(
          new Request(`http://hive/live-run-control?agentId=${agent.id}`),
        )
      ).status,
    ).toBe(401);
    const { token } = daemon.capabilities.mint("user", "user");
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (
        await daemon.fetch(
          new Request(`http://hive/live-run-control?agentId=${agent.id}`, {
            headers,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await daemon.fetch(
          new Request("http://hive/live-run-control", {
            method: "POST",
            headers,
            body: "{}",
          }),
        )
      ).status,
    ).toBe(400);
    await daemon.stop();
    db.close();
  });

  test("GET projects exact provider, shell, and independent process facts", async () => {
    const { deps, actions } = harness();
    const response = await liveRunControlEndpoint(deps, request());
    expect(response.status).toBe(200);
    expect(LiveRunControlProjectionSchema.parse(await response.json())).toEqual(
      expect.objectContaining({
        agentId: agent.id,
        locator,
        providerRun: {
          state: "running",
          runId: run.runId,
          provider: "codex",
          process: providerChild,
        },
        shell: {
          state: "retained",
          root: shellRoot,
          foreground: "provider",
        },
        processCensus: {
          state: "complete",
          source: "sessiond-process-tree",
          members: expect.arrayContaining([
            { pid: 4_000, startToken: "4000:123400" },
            { pid: 4_100, startToken: "4100:123400" },
            { pid: 4_200, startToken: "4200:123400" },
          ]),
          observedAt: AT,
        },
        termination: { state: "not-requested" },
        controls: {
          stopProvider: { enabled: true, reason: null },
          terminateTerminal: { enabled: true, reason: null },
        },
      }),
    );
    expect(actions).toEqual(["status:read"]);
  });

  test("Stop Provider returns the same terminal and shell to zsh without terminating it", async () => {
    const { deps, stopCalls, terminateCalls } = harness();
    const first = await liveRunControlEndpoint(
      deps,
      request(intent("stop-provider")),
    );
    expect(first.status).toBe(200);
    const result = LiveRunControlResultSchema.parse(await first.json());
    expect(result.outcome).toEqual({ status: "accepted" });
    expect(result.observedPostState).toMatchObject({
      locator,
      providerRun: { state: "absent" },
      shell: { state: "retained", root: shellRoot, foreground: "shell" },
      termination: { state: "not-requested" },
      controls: {
        stopProvider: { enabled: false },
        terminateTerminal: { enabled: true },
      },
    });
    const replay = await liveRunControlEndpoint(
      deps,
      request(intent("stop-provider")),
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()) as { operationId: string }).toMatchObject({
      operationId: result.operationId,
    });
    expect(stopCalls).toEqual([run]);
    expect(terminateCalls).toEqual([]);
  });

  test("Terminate Terminal uses the one agent teardown and reads verified terminal death back", async () => {
    const { deps, stopCalls, terminateCalls } = harness();
    const first = await liveRunControlEndpoint(
      deps,
      request(intent("terminate-terminal")),
    );
    expect(first.status).toBe(200);
    const result = LiveRunControlResultSchema.parse(await first.json());
    expect(result.outcome).toEqual({ status: "accepted" });
    expect(result.observedPostState).toMatchObject({
      locator,
      providerRun: { state: "absent" },
      shell: { state: "terminated" },
      processCensus: { state: "terminated" },
      termination: {
        state: "terminated",
        completedAt: AT,
        survivors: [],
      },
      controls: {
        stopProvider: { enabled: false },
        terminateTerminal: { enabled: false },
      },
    });
    const replay = await liveRunControlEndpoint(
      deps,
      request(intent("terminate-terminal")),
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()) as { operationId: string }).toMatchObject({
      operationId: result.operationId,
    });
    expect(stopCalls).toEqual([]);
    expect(terminateCalls).toEqual([agent]);
  });

  test("a stale shell identity is rejected before either destructive path", async () => {
    const { deps, stopCalls, terminateCalls } = harness();
    const stale = intent("terminate-terminal");
    const response = await liveRunControlEndpoint(
      deps,
      request({
        ...stale,
        body: {
          ...stale.body,
          expectedShellRoot: { ...shellRoot, startToken: "recycled" },
        },
      } as LiveRunControlIntent),
    );
    expect(response.status).toBe(409);
    const result = LiveRunControlResultSchema.parse(await response.json());
    expect(result.outcome).toMatchObject({
      status: "rejected",
      failure: { code: "shell-identity-mismatch" },
    });
    expect(stopCalls).toEqual([]);
    expect(terminateCalls).toEqual([]);
  });
});

// THE OUTCOME THE PLATFORM ACTUALLY PRODUCES. A process-tree target never
// reports "terminated": the inspector answers `unknown` unconditionally because
// macOS cannot prove containment (terminal-host-v1.md row J). A clean kill
// therefore arrives as unknown-with-no-survivors and the escapee gap stated
// outright, and this endpoint used to demand the exact "terminated" the
// platform cannot yield — so it reported every clean kill as unknown.
describe("a clean kill the platform cannot positively prove", () => {
  const rowJEvidence = {
    completedAt: AT,
    result: {
      locator,
      state: "unknown" as const,
      exit: null,
      survivors: [],
      errors: [
        {
          phase: "neutral-control",
          code: "UNKNOWN",
          diagnosticId: "process-tree-escapees-unaccounted",
        },
      ],
    },
  };

  function terminatedHarness(evidence: typeof rowJEvidence) {
    const { deps } = harness();
    return {
      ...deps,
      terminalHost: {
        ...deps.terminalHost,
        inspectControl: async () => terminatedInspection(),
        reconcileProviderRun: () => null,
      },
      db: {
        ...deps.db,
        getTerminalHostBindingByLocator: () => ({
          locator,
          visibility: {
            workspaceSessionId: "workspace-fixture",
            workspacePid: 3_800,
            workspaceStartToken: "3800:123400",
            openTerminalRevision: "1",
          },
          createEvidence: {
            expectedExecutable: "/bin/zsh",
            executableVerified: true,
            verifiedShellRoot: shellRoot,
            geometry: liveInspection().terminal.geometry,
            visibility: liveInspection().terminal.visibility,
          },
          terminationEvidence: evidence,
        }),
      },
    };
  }

  test("projects as terminated on the wire, not unknown", async () => {
    const response = await liveRunControlEndpoint(
      terminatedHarness(rowJEvidence),
      request(),
    );

    expect(response.status).toBe(200);
    const projection = LiveRunControlProjectionSchema.parse(
      await response.json(),
    );
    expect(projection.termination).toEqual({
      state: "terminated",
      completedAt: AT,
      survivors: [],
    });
  });

  // The loud fixture: the same shape WITHOUT the documented escapee diagnostic
  // is an unexplained absence of evidence, not the floor, and must stay unknown.
  test("a bare unknown, with no escapee diagnostic, still projects unknown", async () => {
    const response = await liveRunControlEndpoint(
      terminatedHarness({
        ...rowJEvidence,
        result: { ...rowJEvidence.result, errors: [] },
      }),
      request(),
    );

    const projection = LiveRunControlProjectionSchema.parse(
      await response.json(),
    );
    expect(projection.termination.state).toBe("unknown");
  });
});

// Terminate is the destructive fallback. Requiring a complete census to reach
// it withheld that fallback in exactly the degraded state it exists for, and
// bought nothing: the kill is keyed on the agent's session locator and the
// verified shell root, never on the census members. Stop is different — it aims
// at one specific foreground process group — so it keeps the requirement.
describe("admission when the process census is not complete", () => {
  function degradedCensus() {
    const { deps } = harness();
    return {
      ...deps,
      terminalHost: {
        ...deps.terminalHost,
        inspectControl: async () => {
          const live = liveInspection(providerChild.processGroupId);
          return {
            ...live,
            processCensus: {
              ...live.processCensus,
              completeness: "partial" as const,
              diagnostics: ["job-control-evidence-unavailable"],
            },
          };
        },
      },
    };
  }

  test("Terminate is admitted: the retained shell is what identifies the terminal", async () => {
    const response = await liveRunControlEndpoint(degradedCensus(), request());
    const projection = LiveRunControlProjectionSchema.parse(
      await response.json(),
    );

    expect(projection.processCensus.state).toBe("unknown");
    expect(projection.controls.terminateTerminal.enabled).toBe(true);
  });

  // The loud sibling: Stop must still refuse on the same input, so this proves
  // the change is confined to Terminate rather than relaxing admission at large.
  test("Stop still refuses, because it aims at one process group", async () => {
    const response = await liveRunControlEndpoint(degradedCensus(), request());
    const projection = LiveRunControlProjectionSchema.parse(
      await response.json(),
    );

    expect(projection.controls.stopProvider.enabled).toBe(false);
  });
});

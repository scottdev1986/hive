import { describe, expect, test } from "bun:test";
import { getAgentAdapter } from "../../src/adapters/providers/provider-registry";
import { buildActivitySnapshot } from "../../src/daemon/activity-snapshot";
import type { FusedAgentStatus } from "../../src/daemon/status-fusion";
import type {
  AgentRecord,
  CapabilityProvider,
  ProviderEvent,
  ProviderRun,
} from "../../src/schemas";
import { CAPABILITY_PROVIDERS } from "../../src/schemas/capability";

const observedAt = "2026-07-24T20:00:00.000Z";

function agent(provider: CapabilityProvider): AgentRecord {
  return {
    id: `agent-${provider}`,
    name: provider,
    tool: provider,
    model: "measured-model",
    category: "standard_coding",
    status: "working",
    taskDescription: "Observe",
    worktreePath: `/tmp/${provider}`,
    branch: `hive/${provider}`,
    contextPct: null,
    createdAt: observedAt,
    lastEventAt: observedAt,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  };
}

function run(value: AgentRecord): ProviderRun {
  return {
    runId: `018f1e90-7b5a-7cc0-8000-0000000002${CAPABILITY_PROVIDERS.indexOf(value.tool)}0`,
    agentId: value.id,
    terminal: {
      schemaVersion: 1,
      instanceId: "activity-test",
      subject: { kind: "agent", agentId: value.id },
      generation: 1,
      sessionId: `ses_018f1e90-7b5a-7cc0-8000-0000000002${CAPABILITY_PROVIDERS.indexOf(value.tool)}0`,
      hostKind: "sessiond",
      engineBuildId: "test",
    },
    provider: value.tool,
    model: value.model,
    effort: null,
    conversationId: null,
    pid: 4300,
    startToken: "4300:1",
    foregroundProcessGroupId: 4300,
    capabilityEpoch: 0,
    launchGrantId: `grant-${value.tool}`,
    startedAt: observedAt,
    endedAt: null,
    state: "running",
    exitReason: null,
  };
}

function event(kind: ProviderEvent["kind"], occurredAt: string): ProviderEvent {
  return {
    eventId: `event-${kind}-${occurredAt}`,
    providerRunId: "018f1e90-7b5a-7cc0-8000-000000000210",
    provider: "codex",
    capabilityEpoch: 0,
    conversationId: null,
    kind,
    occurredAt,
    toolName: null,
    inputDigest: null,
  };
}

describe("ActivitySnapshot", () => {
  test("all providers use structured process, git, and status evidence", () => {
    for (const provider of CAPABILITY_PROVIDERS) {
      expect(getAgentAdapter(provider).communication.provider).toBe(provider);
      const value = agent(provider);
      const active = run(value);
      const snapshot = buildActivitySnapshot({
        agent: value,
        run: active,
        inspection: {
          schemaVersion: 1,
          locator: active.terminal,
          presence: "present",
          complete: true,
          hostPid: 10,
          hostStartToken: "10:1",
          shellRoot: { pid: 11, startToken: "11:1", processGroupId: 11 },
          foreground: {
            state: "managed",
            runId: active.runId,
            pid: active.pid,
            startToken: active.startToken,
            foregroundProcessGroupId: active.foregroundProcessGroupId,
          },
          expectedExecutable: "/bin/zsh",
          executableVerified: true,
          outputSeq: "9",
          checkpointSeq: "1",
          checkpointAvailable: true,
          input: { state: "FREE", ownerViewerId: null, claimId: null },
          viewerCount: 0,
          geometry: {
            columns: 80,
            rows: 24,
            widthPx: 0,
            heightPx: 0,
            cellWidthPx: 0,
            cellHeightPx: 0,
          },
          resources: {},
          visibility: {
            state: "visible",
            workspaceSessionId: "workspace",
            openTerminalRevision: "1",
            expiresAt: "2026-07-24T21:00:00.000Z",
          },
          exit: null,
          survivors: [],
          evidenceAt: observedAt,
          diagnosticIds: [],
        },
        gitPaths: ["src/a.ts"],
        events: [],
        status: null,
        observedAt,
      });
      expect(snapshot).toMatchObject({
        agentId: value.id,
        providerRunId: active.runId,
        terminalState: "present",
        providerState: "running",
        turnState: "unknown",
        outputThrough: "9",
        completeness: "complete",
        summary: null,
      });
      expect(snapshot.evidence.map((item) => item.kind)).toEqual([
        "process",
        "git",
      ]);
    }
  });

  test("terminal text never becomes authority and gaps remain visible", () => {
    const value = agent("codex");
    const snapshot = buildActivitySnapshot({
      agent: value,
      run: null,
      inspection: null,
      gitPaths: [],
      events: [],
      status: null,
      observedAt,
    });
    expect(snapshot).toMatchObject({
      terminalState: "unknown",
      providerState: "unknown",
      turnState: "unknown",
      summary: null,
      completeness: "unknown",
    });
  });

  test("session lifecycle cannot erase measured turn state", () => {
    const value = agent("codex");
    expect(
      buildActivitySnapshot({
        agent: value,
        run: null,
        inspection: null,
        gitPaths: [],
        events: [
          event("tool-finished", "2026-07-24T19:59:59.000Z"),
          event("run-started", observedAt),
        ],
        status: null,
        observedAt,
      }).turnState,
    ).toBe("working");
  });

  test("a complete report stays complete instead of collapsing to unknown", () => {
    const value = agent("codex");
    const status: FusedAgentStatus = {
      agentId: value.id,
      incarnationGeneration: 1,
      revision: "1",
      sessionState: null,
      turnState: null,
      workflowState: { kind: "reserved" },
      inputState: null,
      healthState: null,
      attention: null,
      report: {
        phase: "complete",
        progress: 100,
        summary: "Mutation failed before the fix and passed after restore.",
        blocker: null,
        evidenceRefs: ["test/daemon/activity-snapshot.test.ts"],
        nextCheckpoint: null,
        assignmentId: "assignment-fixture",
        assignmentGeneration: "1",
        freshUntil: "2026-07-24T21:00:00.000Z",
        source: { kind: "agent-report", id: "report-fixture" },
        observedAt,
        freshness: "fresh",
        confidence: "authoritative",
      },
      sources: [],
      conflicts: [],
    };

    expect(
      buildActivitySnapshot({
        agent: value,
        run: null,
        inspection: null,
        gitPaths: [],
        events: [],
        status,
        observedAt,
      }),
    ).toMatchObject({
      phase: "complete",
      summary: "Mutation failed before the fix and passed after restore.",
    });
  });

  test("Kimi hook events, not shared transcript entries, claim an executor turn", () => {
    const sharedWireEntry = {
      type: "turn.prompt",
      origin: { kind: "user" },
    };
    expect(sharedWireEntry.origin.kind).toBe("user");
    expect(getAgentAdapter("kimi").communication).toMatchObject({
      eventSource: "hooks",
      toolBoundaryEvents: false,
      turnBoundaryEvents: true,
      transcriptReader: false,
    });

    const value = agent("kimi");
    expect(
      buildActivitySnapshot({
        agent: value,
        run: run(value),
        inspection: null,
        gitPaths: [],
        events: [],
        status: null,
        observedAt,
      }).turnState,
    ).toBe("unknown");
  });
});

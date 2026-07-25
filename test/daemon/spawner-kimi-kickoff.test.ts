import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/db";
import type {
  SessionInspection,
  SessionLocator,
} from "../../src/daemon/session-host/contract";
import type { SessiondAgentInput } from "../../src/daemon/session-host/sessiond-agent-input";
import { HiveSpawner } from "../../src/daemon/spawner-impl";
import type { RoutingPolicy } from "../../src/schemas";

const terminal: SessionLocator = {
  schemaVersion: 1,
  instanceId: "kimi-kickoff-fixture",
  subject: { kind: "agent", agentId: "placeholder" },
  generation: 1,
  sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000501",
  hostKind: "sessiond",
  engineBuildId: "engine-fixture",
};

function inspection(locator: SessionLocator): SessionInspection {
  return {
    schemaVersion: 1,
    locator,
    presence: "present",
    complete: true,
    hostPid: 3_900,
    hostStartToken: "3900:1",
    shellRoot: {
      pid: 4_000,
      startToken: "4000:1",
      processGroupId: 4_000,
    },
    foreground: {
      state: "unmanaged",
      runId: null,
      pid: 5_000,
      startToken: "5000:1",
      foregroundProcessGroupId: 5_000,
    },
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
      expiresAt: "2026-07-25T18:00:15.000Z",
    },
    exit: null,
    survivors: [],
    evidenceAt: "2026-07-25T18:00:00.000Z",
    diagnosticIds: [],
  };
}

test("Kimi turn zero is submitted after readiness with the measured foreground identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-kimi-kickoff-root-"));
  const home = await mkdtemp(join(tmpdir(), "hive-kimi-kickoff-home-"));
  const worktree = join(root, "maya");
  await mkdir(worktree, { recursive: true });
  const previousHome = process.env.HIVE_HOME;
  process.env.HIVE_HOME = home;
  const db = new HiveDatabase(":memory:");
  const events: string[] = [];
  const writes: Parameters<SessiondAgentInput["writeAutomated"]>[0][] = [];
  const policy: RoutingPolicy = {
    schemaVersion: 2,
    revision: 1,
    updatedAt: "2026-07-25T00:00:00.000Z",
    provisional: false,
    providers: {},
    models: [],
    chains: {
      simple_coding: [
        {
          provider: "kimi",
          model: "kimi-code/k3",
          effort: { mode: "provider-controlled" },
        },
      ],
    },
    selection: { global: "choice", categories: {} },
  };
  let locator = terminal;
  const spawner = new HiveSpawner({
    db,
    repoRoot: root,
    port: 4_317,
    config: {},
    readRoutingPolicy: () => policy,
    isModelEnabled: async () => true,
    readBilling: async () => null,
    createWorktree: async () => ({
      path: worktree,
      branch: "hive/maya-kimi-kickoff",
    }),
    unavailableAgentNames: async () => new Set(),
    removeWorktree: async () => {},
    assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    stopSession: async () => ({ killed: [], survivors: [] }),
    sleep: async () => {},
    mcpClientSeen: () => {
      events.push("mcp-ready");
      return true;
    },
    ps: async () => {
      events.push("process-ready");
      return [
        " 4000     1  1024 /bin/zsh",
        " 5000  4000  2048 kimi -m kimi-code/k3",
      ].join("\n");
    },
    claudeExecutable: "claude",
    codexExecutable: "codex",
    grokExecutable: "grok",
    kimiExecutable: "kimi",
    opencodeExecutable: "opencode",
    sessiondInput: {
      writeAutomated: async (input) => {
        events.push("kickoff");
        writes.push(input);
        expect(db.getAgentByName("maya")?.status).toBe("spawning");
        return {
          outcome: "injected",
          receipt: {
            transactionId: input.idempotencyKey,
            stage: "written-to-terminal",
            byteRange: { start: "0", endExclusive: "44" },
            orderedAt: "44",
            availableCreditBytes: 4_096,
            consumedByProcess: "not-claimed",
            completeness: "complete",
            diagnostic: null,
          },
        };
      },
    },
    sessiond: {
      prepareAgentCreation: async () => ({
        engineBuildId: locator.engineBuildId,
        geometry: inspection(locator).geometry,
        visibility: {
          workspaceSessionId: "workspace-fixture",
          workspacePid: 3_800,
          workspaceStartToken: "3800:1",
          openTerminalRevision: "1",
        },
      }),
      admit: async () => null,
      terminalHost: {
        create: async (spec) => {
          events.push("created");
          locator = spec.locator;
          return {
            locator,
            inspection: inspection(locator),
            created: true,
          };
        },
        inspect: async () => inspection(locator),
        terminate: async () => ({
          locator,
          state: "terminated",
          exit: null,
          survivors: [],
          errors: [],
        }),
      },
    },
  });

  try {
    const admitted = await spawner.spawn({
      name: "maya",
      task: "Run the assigned smoke test",
      category: "simple_coding",
    });
    for (let attempt = 0; attempt < 200 && writes.length === 0; attempt += 1) {
      await Bun.sleep(5);
    }
    if (admitted.sessionLocator === undefined) {
      throw new Error("spawned Kimi has no session locator");
    }

    expect(writes).toHaveLength(1);
    expect(events.indexOf("created")).toBeLessThan(
      events.indexOf("process-ready"),
    );
    expect(events.indexOf("process-ready")).toBeLessThan(
      events.indexOf("mcp-ready"),
    );
    expect(events.indexOf("mcp-ready")).toBeLessThan(events.indexOf("kickoff"));
    const providerRunId = writes[0]?.expectedForeground.providerRunId;
    if (providerRunId === undefined) {
      throw new Error("Kimi kickoff omitted its provider run");
    }
    expect(writes[0]).toEqual({
      terminal: admitted.sessionLocator,
      expectedForeground: {
        providerRunId,
        pid: 5_000,
        startToken: "5000:1",
        processGroupId: 5_000,
      },
      bytes: new TextEncoder().encode(
        "\x1b[200~Begin the assigned task.\x1b[201~\r",
      ),
      idempotencyKey: `kimi-kickoff:${providerRunId}`,
    });
  } finally {
    db.close();
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  }
});

// Renewal-target resolution for the daemon's visibility loop: the inventory
// decides WHO is visible, the binding store decides WHICH generation exists.
// On 2026-07-27 david's recovery moved him to generation 2 while the
// Workspace kept publishing his gen-1 pane; renewing the inventory's locator
// was a guaranteed failure and the live gen-2 session had no renewal path
// (planning/2026-07-27-spawn-collapse-root-cause.md).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/db";
import { hiveInstanceSuffix } from "../../src/daemon/instance-identity";
import { HiveDaemon } from "../../src/daemon/server";
import type { HiveTerminalBinding } from "../../src/daemon/session-host/terminal-host-binding";
import { WorkspaceVisibilityAuthority } from "../../src/daemon/session-host/workspace-visibility";

const home = mkdtempSync(join(tmpdir(), "hive-visibility-renewal-"));
process.env.HIVE_HOME = home;

const WORKSPACE_PID = 4_242;
const WORKSPACE_TOKEN = "4242:777";
const geometry = {
  columns: 80,
  rows: 24,
  widthPx: 800,
  heightPx: 480,
  cellWidthPx: 10,
  cellHeightPx: 20,
};

// The adapter refuses bindings for any other instance, and the visibility
// authority rejects foreign locators, so every fixture shares the daemon's
// own instance id (derived from this test's HIVE_HOME).
const instanceId = hiveInstanceSuffix();

function agentLocator(generation: number, sessionId: string) {
  return {
    schemaVersion: 1 as const,
    instanceId,
    subject: { kind: "agent" as const, agentId: "agent-david" },
    generation,
    sessionId,
    hostKind: "sessiond" as const,
    engineBuildId: "engine-fixture",
  };
}

const gen1 = agentLocator(1, "ses_018f1e90-7b5a-7cc0-8000-000000000901");
const gen2 = agentLocator(2, "ses_018f1e90-7b5a-7cc0-8000-000000000902");

function completeBinding(
  db: HiveDatabase,
  locator: ReturnType<typeof agentLocator>,
): void {
  db.bindTerminalHostSession({
    locator,
    visibility: {
      workspaceSessionId: "ws-1",
      workspacePid: WORKSPACE_PID,
      workspaceStartToken: WORKSPACE_TOKEN,
      openTerminalRevision: "1",
    },
  });
  db.completeTerminalHostSession(locator, {
    expectedExecutable: "/bin/zsh",
    executableVerified: true,
    verifiedShellRoot: null,
    geometry,
    visibility: {
      state: "visible",
      workspaceSessionId: "ws-1",
      openTerminalRevision: "1",
      expiresAt: "2026-07-27T00:00:15.000Z",
    },
  });
}

function harness(db: HiveDatabase) {
  const renewals: Array<{ locator: unknown; request: unknown }> = [];
  const landedHost = {
    create: async () => {
      throw new Error("create not under test");
    },
    issueAttach: async () => {
      throw new Error("issueAttach not under test");
    },
    claimInput: async () => {
      throw new Error("claimInput not under test");
    },
    submitInput: async () => {
      throw new Error("submitInput not under test");
    },
    resize: async () => {
      throw new Error("resize not under test");
    },
    inspect: async () => {
      throw new Error("inspect not under test");
    },
    list: async () => [],
    terminate: async () => {
      throw new Error("terminate not under test");
    },
    renewVisibility: async (
      locator: HiveTerminalBinding["locator"],
      request: { openTerminalRevision: string },
    ) => {
      renewals.push({ locator, request });
      return {
        locator,
        state: "active" as const,
        expiresAt: "2026-07-27T00:00:30.000Z",
        openTerminalRevision: request.openTerminalRevision,
      };
    },
  };
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-visibility-noop",
    resourceRunners: { orphans: null },
    terminalHost: landedHost,
    workspaceVisibility: new WorkspaceVisibilityAuthority({
      expectedInstanceId: instanceId,
      observeProcess: (processId) =>
        processId === WORKSPACE_PID ? { startToken: WORKSPACE_TOKEN } : null,
      discoverEngineBuildId: async () => "engine-fixture",
    }),
  });
  return { daemon, renewals };
}

async function post(
  daemon: HiveDaemon,
  route: string,
  body: unknown,
): Promise<Response> {
  const { token } = daemon.capabilities.mint("operator", "operator");
  return daemon.fetch(
    new Request(`http://hive${route}`, {
      method: "POST",
      headers: new Headers({
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify(body),
    }),
  );
}

const owner = {
  sessionId: "ws-1",
  process: { processId: WORKSPACE_PID, startToken: WORKSPACE_TOKEN },
};

function inventory(
  terminals: Array<{
    locator: ReturnType<typeof agentLocator>;
    state: "live";
  }>,
) {
  return {
    schemaVersion: 1,
    source: owner,
    inventoryRevision: "1",
    terminals: terminals.map((terminal) => ({
      agentId: "agent-david",
      agentName: "david",
      locator: terminal.locator,
      state: terminal.state,
    })),
  };
}

describe("POST /workspace-visibility renewal target", () => {
  test("a stale-generation inventory renews the agent's latest binding", async () => {
    const db = new HiveDatabase(":memory:");
    completeBinding(db, gen1);
    completeBinding(db, gen2);
    const { daemon, renewals } = harness(db);
    try {
      await post(daemon, "/workspace-owner", owner);
      const response = await post(
        daemon,
        "/workspace-visibility",
        inventory([{ locator: gen1, state: "live" }]),
      );
      expect(response.status).toEqual(200);
      // A publish makes the inventory current; the renewal pass is what renews
      // it, on its own timer. Driving that pass here is what the timer does.
      await daemon.renewWorkspaceVisibility();
      // The gen-1 pane still names the visible agent, but the session that
      // exists — and the one whose lease dies without this — is generation 2.
      expect(renewals).toHaveLength(1);
      expect(renewals[0]?.locator).toEqual(gen2);
    } finally {
      await daemon.stop();
    }
  });

  test("a current inventory renews its own locator (control)", async () => {
    const db = new HiveDatabase(":memory:");
    completeBinding(db, gen1);
    const { daemon, renewals } = harness(db);
    try {
      await post(daemon, "/workspace-owner", owner);
      const response = await post(
        daemon,
        "/workspace-visibility",
        inventory([{ locator: gen1, state: "live" }]),
      );
      expect(response.status).toEqual(200);
      await daemon.renewWorkspaceVisibility();
      expect(renewals).toHaveLength(1);
      expect(renewals[0]?.locator).toEqual(gen1);
    } finally {
      await daemon.stop();
    }
  });
});

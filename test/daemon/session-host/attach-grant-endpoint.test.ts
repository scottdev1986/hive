import { describe, expect, test } from "bun:test";
import type { Capability } from "../../../src/daemon/authorization/authorization-service";
import { HiveDatabase } from "../../../src/daemon/database/hive-database";
import { attachGrantEndpoint } from "../../../src/daemon/session-host/attach-grant-endpoint";
import {
  TerminalHostBindingIncompleteError,
  TerminalHostBindingNotFoundError,
} from "../../../src/daemon/session-host/hive-terminal-host";
import { HostOperationError } from "../../../src/daemon/session-host/host-operations";
import type { AttachGrant } from "../../../src/daemon/session-host/session-host-contract";
import type { AgentRecord } from "../../../src/schemas/agent";

const AT = "2026-08-15T16:00:00.000Z";
const locator = {
  schemaVersion: 1 as const,
  instanceId: "hive-fixture",
  subject: { kind: "agent" as const, agentId: "agent-ada" },
  generation: 1,
  sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000101",
  hostKind: "sessiond" as const,
  engineBuildId: "engine-fixture",
};
const geometry = {
  columns: 80,
  rows: 24,
  widthPx: 800,
  heightPx: 480,
  cellWidthPx: 10,
  cellHeightPx: 20,
};
const capability: Capability = {
  id: "cap_user",
  subject: "user",
  role: "user",
  epoch: 0,
  issuedAt: AT,
  expiresAt: "2026-08-16T16:00:00.000Z",
  revokedAt: null,
};

const agent = (name: string): AgentRecord => ({
  id: "agent-ada",
  name,
  tool: "codex",
  model: "gpt-5-codex",
  category: "simple_coding",
  status: "spawning",
  taskDescription: "work",
  worktreePath: `/tmp/hive-${name}`,
  branch: `hive/${name}`,
  contextPct: null,
  createdAt: AT,
  lastEventAt: AT,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
  sessionLocator: locator,
});

const grant: AttachGrant = {
  locator,
  endpoint: "/tmp/host.sock",
  token: "token",
  expiresAt: AT,
  engineBuildId: locator.engineBuildId,
  checkpointSeq: "0",
  outputSeq: "0",
  operations: ["view", "user-input", "resize"],
};

function request() {
  return new Request("http://hive/agents/ada/attach-grant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionLocator: locator,
      viewerId: "workspace-pane-ada",
      geometry,
      operations: ["view", "user-input", "resize"],
    }),
  });
}

function deps(issueAttach: () => Promise<AttachGrant>) {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(agent("ada"));
  return {
    db,
    orchestratorSessiond: null,
    terminalHost: { issueAttach },
    authenticate: () => ({ ok: true as const, capability }),
    authorize: () => ({ ok: true as const, capability }),
    denied: () => Response.json({ error: "denied" }, { status: 403 }),
  };
}

describe("attach-grant start races", () => {
  test("an unbound host is session-not-ready, not a 500", async () => {
    const response = await attachGrantEndpoint(
      deps(async () => {
        throw new TerminalHostBindingNotFoundError();
      }),
      "/agents/ada/attach-grant",
      request(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      state: "rejected",
      reason: "session-not-ready",
    });
  });

  test("an incomplete create is session-not-ready", async () => {
    const response = await attachGrantEndpoint(
      deps(async () => {
        throw new TerminalHostBindingIncompleteError();
      }),
      "/agents/ada/attach-grant",
      request(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "session-not-ready",
    });
  });

  test("a missing host socket is session-not-ready", async () => {
    const response = await attachGrantEndpoint(
      deps(async () => {
        throw new HostOperationError("host control socket failed");
      }),
      "/agents/ada/attach-grant",
      request(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "session-not-ready",
      error: "host control socket failed",
    });
  });

  test("a ready host still grants", async () => {
    const response = await attachGrantEndpoint(
      deps(async () => grant),
      "/agents/ada/attach-grant",
      request(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "granted" });
  });
});

// A kill the USER ordered from the Workspace sidebar has to be distinguishable
// from a kill the orchestrator ordered, because she may hold work in flight
// with the agent that just vanished. POST /agents/<name>/kill is the one place
// the two callers meet, so the flag that separates them lives on its request
// body and the notification is emitted there.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "../../src/daemon/authorization/authorization-service";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type { Spawner } from "../../src/daemon/spawn/spawn-service";
import {
  MailRulingRequiredError,
  MailTools,
} from "../../src/mail-service/mail-tools";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";
import { required } from "../required";

const AT = "2026-08-19T12:00:00.000Z";

function locator(agentId: string, sessionId: string) {
  return {
    schemaVersion: 1 as const,
    instanceId: "user-closed-fixture",
    subject: { kind: "agent" as const, agentId },
    generation: 1,
    sessionId,
    hostKind: "sessiond" as const,
    engineBuildId: "engine-user-closed",
  };
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const id = overrides.id ?? "agent-maya";
  return {
    id,
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "working",
    taskDescription: "Build server",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-server",
    sessionLocator: locator(id, "ses_018f1e90-7b5a-7cc0-8000-000000000801"),
    contextPct: null,
    createdAt: AT,
    lastEventAt: AT,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

class StubSpawner implements Spawner {
  async spawn(): Promise<AgentRecord> {
    throw new Error("not used in these tests");
  }
}

const hostNotReached = async (): Promise<never> => {
  throw new Error("terminal host method not expected in this test");
};

const emptyTerminalHost = {
  waitForHostExit: async () => ({ kind: "inherited" as const }),
  create: hostNotReached,
  capture: hostNotReached,
  submitInput: hostNotReached,
  resize: hostNotReached,
  inspect: hostNotReached,
  terminate: hostNotReached,
  issueAttach: hostNotReached,
  list: async () => [],
};

async function rig(seed: AgentRecord[] = [agent()]) {
  const db = new HiveDatabase(":memory:");
  const repo = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "user-closed-"));
  for (const record of seed) db.insertAgent(record);
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: new StubSpawner(),
    repoRoot: repo,
    terminalHost: emptyTerminalHost,
    assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
  });
  const token = daemon.capabilities.mint("user", "user").token;
  return {
    daemon,
    db,
    token,
    async dispose(): Promise<void> {
      await daemon.stop();
      db.close();
      await rm(repo, { recursive: true, force: true });
    },
  };
}

function killRequest(
  name: string,
  token: string,
  body: Record<string, unknown>,
): Request {
  return new Request(`http://hive/agents/${encodeURIComponent(name)}/kill`, {
    method: "POST",
    headers: {
      Host: "127.0.0.1",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const queenCapability: Capability = {
  id: "cap_queen",
  subject: ORCHESTRATOR_NAME,
  role: "writer",
  epoch: 0,
  issuedAt: AT,
  expiresAt: "2026-08-20T12:00:00.000Z",
  revokedAt: null,
};

/** The tool boundary the orchestrator settles her mailbox through, over the
 * daemon's real mail service, with a ruling record that cites nothing. */
function queenMailTools(daemon: HiveDaemon): MailTools {
  return new MailTools({
    service: daemon.mailService,
    wake: daemon.mailWake,
    recipients: (named) => ({
      kind: "live",
      canonical: named === "orchestrator" ? ORCHESTRATOR_NAME : named,
    }),
    authorizeTool: () => {},
    liveGeneration: () => 0,
    now: () => new Date(AT),
    requireRulingRecord: async () => false,
  });
}

const userClosedMail = (daemon: HiveDaemon): string[] =>
  daemon.mailService
    .unsettledFor(ORCHESTRATOR_NAME)
    .filter((item) => item.sender === "hive-control")
    .map((item) => item.body);

describe("a user-ordered close tells the orchestrator; an orchestrator kill does not", () => {
  test("userClosed:true publishes one message naming the agent", async () => {
    const rigged = await rig();
    try {
      const seeded = required(rigged.db.getAgentByName("maya"));
      const response = await rigged.daemon.fetch(
        killRequest("maya", rigged.token, {
          sessionLocator: required(seeded.sessionLocator),
          origin: "workspace sidebar Close Agent",
          userClosed: true,
        }),
      );

      expect(response.status).toBe(200);
      const mail = userClosedMail(rigged.daemon);
      expect(mail).toHaveLength(1);
      expect(mail[0]).toContain("The user closed maya");
      expect(mail[0]).toContain("You did not order this kill");
    } finally {
      await rigged.dispose();
    }
  });

  test("the same route without the flag stays silent — this is what `hive kill` sends", async () => {
    const rigged = await rig();
    try {
      const seeded = required(rigged.db.getAgentByName("maya"));
      // Byte-for-byte the body killAgentCli builds: sessionLocator and origin.
      const response = await rigged.daemon.fetch(
        killRequest("maya", rigged.token, {
          sessionLocator: required(seeded.sessionLocator),
          origin: "kill pid=1 argv=[hive,kill,maya]",
        }),
      );

      expect(response.status).toBe(200);
      expect(userClosedMail(rigged.daemon)).toEqual([]);
    } finally {
      await rigged.dispose();
    }
  });

  test("closing two agents leaves both names readable, not one merged body", async () => {
    // The control lane is load-bearing here: work-lane items from one sender on
    // one topic coalesce while unread, which would have left the orchestrator
    // holding only the second agent's name.
    const rigged = await rig([
      agent(),
      agent({
        id: "agent-ida",
        name: "ida",
        worktreePath: "/tmp/hive-ida",
        branch: "hive/ida-server",
      }),
    ]);
    try {
      for (const name of ["maya", "ida"]) {
        const seeded = required(rigged.db.getAgentByName(name));
        const response = await rigged.daemon.fetch(
          killRequest(name, rigged.token, {
            sessionLocator: required(seeded.sessionLocator),
            userClosed: true,
          }),
        );
        expect(response.status).toBe(200);
      }

      const mail = userClosedMail(rigged.daemon);
      expect(mail).toHaveLength(2);
      expect(mail.some((body) => body.includes("closed maya"))).toBe(true);
      expect(mail.some((body) => body.includes("closed ida"))).toBe(true);
    } finally {
      await rigged.dispose();
    }
  });

  test("the orchestrator can settle it without writing a memory article first", async () => {
    // The user attribution is in the BODY, not in the sender. A sender of "user"
    // or "owner" would put this item behind the owner-ruling gate
    // (MailTools.requireOwnerRuling), and every routine right-click would then
    // force a memory_write before the orchestrator could clear her own mailbox.
    const rigged = await rig();
    try {
      const seeded = required(rigged.db.getAgentByName("maya"));
      await rigged.daemon.fetch(
        killRequest("maya", rigged.token, {
          sessionLocator: required(seeded.sessionLocator),
          userClosed: true,
        }),
      );
      const item = required(
        rigged.daemon.mailService.unsettledFor(ORCHESTRATOR_NAME).at(-1),
      );
      const tools = queenMailTools(rigged.daemon);
      tools.poll(queenCapability, { recipient: ORCHESTRATOR_NAME });
      tools.claim(queenCapability, {
        recipient: ORCHESTRATOR_NAME,
        itemId: item.itemId,
        handlerId: "queen-h1",
      });

      // requireRulingRecord answers "nothing cites this" for every id, so a
      // settlement that succeeds here proves the gate did not apply.
      const settled = await tools.complete(queenCapability, {
        recipient: ORCHESTRATOR_NAME,
        itemId: item.itemId,
        handlerId: "queen-h1",
        disposition: "completed",
      });

      expect(
        (settled.structuredContent.mail as { disposition: string }).disposition,
      ).toBe("completed");
      expect(item.sender).not.toBe("user");
      expect(item.sender).not.toBe("owner");
      // The attribution the queen actually reads.
      expect(item.body).toContain("The user closed maya");

      // Positive control: the gate IS armed in this rig. An owner control item
      // settled through the same tools with the same ruling record is refused,
      // so the settlement above is a real absence, not a disabled check.
      const owner = tools.publish(
        { ...queenCapability, subject: "owner" },
        {
          from: "owner",
          to: ORCHESTRATOR_NAME,
          lane: "control",
          topic: "ruling",
          body: "a ruling",
          idempotencyKey: "owner-ruling-1",
        },
      );
      const ownerItemId = (owner.structuredContent.mail as { itemId: string })
        .itemId;
      tools.poll(queenCapability, { recipient: ORCHESTRATOR_NAME });
      tools.claim(queenCapability, {
        recipient: ORCHESTRATOR_NAME,
        itemId: ownerItemId,
        handlerId: "queen-h2",
      });
      await expect(
        tools.complete(queenCapability, {
          recipient: ORCHESTRATOR_NAME,
          itemId: ownerItemId,
          handlerId: "queen-h2",
          disposition: "completed",
        }),
      ).rejects.toThrow(MailRulingRequiredError);
    } finally {
      await rigged.dispose();
    }
  });

  test("a repeated close cannot deliver twice", async () => {
    const rigged = await rig();
    try {
      const seeded = required(rigged.db.getAgentByName("maya"));
      const body = {
        sessionLocator: required(seeded.sessionLocator),
        userClosed: true,
      };
      const first = await rigged.daemon.fetch(
        killRequest("maya", rigged.token, body),
      );
      expect(first.status).toBe(200);
      // The second kill is refused (the generation is gone), and even if it
      // were not, the idempotency key is the agent id.
      await rigged.daemon.fetch(killRequest("maya", rigged.token, body));

      expect(userClosedMail(rigged.daemon)).toHaveLength(1);
    } finally {
      await rigged.dispose();
    }
  });
});

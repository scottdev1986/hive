import { describe, expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { hiveInstanceSuffix } from "../../src/hive-home/home";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import { MAIL_CONTROL_LANE_CAPACITY } from "../../src/schemas/mail";
import { mailbox } from "../mail-test-support";
import { required } from "../required";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-mail-mcp-");
process.env.HIVE_HOME = home;

const timestamp = "2026-08-01T12:00:00.000Z";

const agentRecord = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  id: `agent-${overrides.name ?? "maya"}`,
  name: "maya",
  tool: "codex",
  model: "gpt-5-codex",
  category: "simple_coding",
  status: "working",
  taskDescription: "Phase 0",
  worktreePath: "/tmp/hive-maya",
  branch: "hive/maya-work",
  contextPct: 3,
  createdAt: timestamp,
  lastEventAt: timestamp,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
  sessionLocator: {
    schemaVersion: 1,
    instanceId: "hive-mail-mcp",
    subject: { kind: "agent", agentId: `agent-${overrides.name ?? "maya"}` },
    generation: 1,
    sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000901",
    hostKind: "sessiond",
    engineBuildId: "engine-mail-mcp",
  },
  ...overrides,
});

class StubSpawner implements Spawner {
  bindingState: "bound" | "unbound" | "legacy" = "legacy";

  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("this harness spawns nothing");
  }

  hierarchyRecipientBindingState() {
    return this.bindingState;
  }
}

/** The root's bound session, which is what gives the root an incarnation. */
const bindRootSession = (db: HiveDatabase, generation: number): void => {
  db.bindTerminalHostSession({
    locator: {
      schemaVersion: 1,
      instanceId: hiveInstanceSuffix(),
      subject: { kind: "root" },
      generation,
      sessionId: `ses_018f1e90-7b5a-7cc0-8000-00000000090${generation}`,
      hostKind: "sessiond",
      engineBuildId: "engine-mail-mcp",
    },
    visibility: {
      workspaceSessionId: "workspace-mail-mcp",
      workspacePid: 4100,
      workspaceStartToken: "4100:1",
      openTerminalRevision: "7",
    },
  });
};

const harness = () => {
  const db = new HiveDatabase(":memory:");
  const spawner = new StubSpawner();
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner,
    repoRoot: "/tmp/hive-mail-mcp-noop",
  });
  bindRootSession(db, 1);
  return { daemon, db, spawner };
};

const authorized =
  (daemon: HiveDaemon, token: string) =>
  (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Host", "127.0.0.1");
    headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };

const callTool = async (
  daemon: HiveDaemon,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; text: string; value: Record<string, unknown> }> => {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const text = JSON.stringify(result.content ?? "");
    return {
      ok: result.isError !== true,
      text,
      value: (result.structuredContent ?? {}) as Record<string, unknown>,
    };
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : "?",
      value: {},
    };
  } finally {
    await client.close().catch(() => undefined);
  }
};

const listedTools = async (daemon: HiveDaemon, token: string) => {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  try {
    await client.connect(transport);
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => undefined);
  }
};

const mailOf = (result: { value: Record<string, unknown> }) =>
  (result.value.mail ?? {}) as Record<string, unknown>;

describe("the mailbox over MCP", () => {
  test("agent-facing schemas omit identities the daemon already knows", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const maya = daemon.capabilities.mint("maya", "writer");
    const tools = await listedTools(daemon, maya.token);
    const publish = required(
      tools.find((tool) => tool.name === "hive_mail_publish"),
      "publish tool",
    );
    const status = required(
      tools.find((tool) => tool.name === "hive_mail_status"),
      "status tool",
    );
    const publishSchema = publish.inputSchema as {
      properties?: Record<string, unknown>;
    };
    const statusSchema = status.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(publishSchema.properties).not.toHaveProperty("addressedGeneration");
    expect(statusSchema.properties?.recipient).toMatchObject({ const: "maya" });
    expect(statusSchema.required ?? []).not.toContain("recipient");
    await daemon.stop();
  });

  test("the authenticated pane renews its claimed lease over HTTP", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");
    const maya = daemon.capabilities.mint("maya", "writer");
    const published = await callTool(daemon, queen.token, "hive_mail_publish", {
      from: ORCHESTRATOR_NAME,
      to: "maya",
      lane: "control",
      topic: "handoff",
      body: "keep this lease alive",
      idempotencyKey: "queen-heartbeat-1",
    });
    const itemId = String(mailOf(published).itemId);
    await callTool(daemon, maya.token, "hive_mail_poll", {
      recipient: "maya",
    });
    await callTool(daemon, maya.token, "hive_mail_claim", {
      recipient: "maya",
      itemId,
      handlerId: "maya-turn-1",
    });

    const response = await authorized(daemon, maya.token)(
      "http://hive/mail/lease-heartbeat",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(required(daemon.mail.getItem(itemId)).attempts).toBe(1);
    expect(daemon.mail.listEvents(itemId).map((event) => event.kind)).toEqual([
      "published",
      "claimed",
      "lease-renewed",
    ]);
    await daemon.stop();
  });

  test("publish, poll, claim and complete carry a message end to end", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");
    const maya = daemon.capabilities.mint("maya", "writer");

    const published = await callTool(daemon, queen.token, "hive_mail_publish", {
      from: ORCHESTRATOR_NAME,
      to: "maya",
      lane: "control",
      topic: "handoff",
      body: "take the cutover",
      idempotencyKey: "queen-cutover-1",
    });
    expect(published.ok).toBe(true);
    const itemId = String(mailOf(published).itemId);

    const polled = await callTool(daemon, maya.token, "hive_mail_poll", {
      recipient: "maya",
    });
    expect(polled.ok).toBe(true);
    expect(mailOf(polled).control).toMatchObject({
      itemId,
      body: "take the cutover",
    });

    const claimed = await callTool(daemon, maya.token, "hive_mail_claim", {
      recipient: "maya",
      itemId,
      handlerId: "maya-turn-1",
    });
    expect(claimed.ok).toBe(true);

    const completed = await callTool(daemon, maya.token, "hive_mail_complete", {
      recipient: "maya",
      itemId,
      handlerId: "maya-turn-1",
      disposition: "completed",
    });
    expect(completed.ok).toBe(true);
    expect(
      daemon.mailWake.deliveryChain(itemId).map((row) => row.state),
    ).toEqual(["published", "mail_presented", "mail_claimed", "completed"]);

    const after = await callTool(daemon, maya.token, "hive_mail_status", {
      recipient: "maya",
    });
    expect(mailOf(after)).toMatchObject({
      recipient: "maya",
      deadLetters: { total: 0 },
      lanes: { control: { available: 0, leased: 0 } },
    });
    expect(
      (
        await callTool(daemon, maya.token, "hive_mail_poll", {
          recipient: "maya",
        })
      ).value,
    ).toMatchObject({ mail: { control: null } });
    await daemon.stop();
  });

  test("claim of the current offer presents from the mailbox without a prior poll", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");
    const maya = daemon.capabilities.mint("maya", "writer");
    const published = await callTool(daemon, queen.token, "hive_mail_publish", {
      from: ORCHESTRATOR_NAME,
      to: "maya",
      lane: "control",
      topic: "handoff",
      body: "must be presented first",
      idempotencyKey: "queen-presentation-first",
    });
    const itemId = String(mailOf(published).itemId);

    const claimed = await callTool(daemon, maya.token, "hive_mail_claim", {
      recipient: "maya",
      itemId,
      handlerId: "maya-turn-early",
    });
    expect(claimed.ok).toBe(true);
    expect(mailOf(claimed).itemId).toBe(itemId);
    expect(daemon.mail.countByState("maya", "control", "leased")).toBe(1);
    await daemon.stop();
  });

  test("a work-lane body is readable by the recipient the digest showed it to", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");
    const maya = daemon.capabilities.mint("maya", "writer");
    const published = await callTool(daemon, queen.token, "hive_mail_publish", {
      from: ORCHESTRATOR_NAME,
      to: "maya",
      lane: "work",
      topic: "progress",
      body: "the digest reports only how many bytes this is",
      idempotencyKey: "queen-work-1",
    });
    const itemId = String(mailOf(published).itemId);

    const polled = await callTool(daemon, maya.token, "hive_mail_poll", {
      recipient: "maya",
    });
    expect(mailOf(polled).workDigest).toMatchObject([{ itemId }]);

    const claimed = await callTool(daemon, maya.token, "hive_mail_claim", {
      recipient: "maya",
      itemId,
      handlerId: "maya-work-1",
    });
    expect(claimed.ok).toBe(true);
    expect(mailOf(claimed).body).toBe(
      "the digest reports only how many bytes this is",
    );
    expect(
      (
        await callTool(daemon, maya.token, "hive_mail_complete", {
          recipient: "maya",
          itemId,
          handlerId: "maya-work-1",
          disposition: "completed",
        })
      ).ok,
    ).toBe(true);
    expect(daemon.mail.getItem(itemId)).toBeNull();
    await daemon.stop();
  });

  /**
   * Both fields are validated by the MCP layer before the broker sees them, so
   * the refusal an agent met came from the tool boundary rather than the
   * mailbox. Neither refusal protected anything the mailbox needed.
   */
  test("the tool boundary trims an annotation and honours a zero digest", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");
    const maya = daemon.capabilities.mint("maya", "writer");
    const published = await callTool(daemon, queen.token, "hive_mail_publish", {
      from: ORCHESTRATOR_NAME,
      to: "maya",
      lane: "control",
      topic: "handoff",
      body: "settle me with a long reason",
      idempotencyKey: "queen-annotation-1",
    });
    const itemId = String(mailOf(published).itemId);

    const declined = await callTool(daemon, maya.token, "hive_mail_poll", {
      recipient: "maya",
      workDigestLimit: 0,
    });
    expect(declined.ok).toBe(true);
    expect(mailOf(declined).workDigest).toEqual([]);

    await callTool(daemon, maya.token, "hive_mail_claim", {
      recipient: "maya",
      itemId,
      handlerId: "maya-turn-1",
    });
    const settled = await callTool(daemon, maya.token, "hive_mail_complete", {
      recipient: "maya",
      itemId,
      handlerId: "maya-turn-1",
      disposition: "rejected",
      reason: "z".repeat(400),
    });
    expect(settled.ok).toBe(true);
    expect(mailOf(settled).reason).toBe("z".repeat(280));
    await daemon.stop();
  });

  test("a message addressed to the root's synonym reaches the same mailbox", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const maya = daemon.capabilities.mint("maya", "writer");
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");

    expect(
      (
        await callTool(daemon, maya.token, "hive_mail_publish", {
          from: "maya",
          to: "orchestrator",
          lane: "control",
          topic: "report",
          body: "done",
          idempotencyKey: "maya-report-1",
        })
      ).ok,
    ).toBe(true);

    const polled = await callTool(daemon, queen.token, "hive_mail_poll", {
      recipient: ORCHESTRATOR_NAME,
    });
    expect(mailOf(polled).control).toMatchObject({ body: "done" });
    await daemon.stop();
  });

  test("refuses an unknown recipient, a finished one, and an unbound one", async () => {
    const { daemon, db, spawner } = harness();
    db.upsertAgent(agentRecord());
    db.upsertAgent(
      agentRecord({ id: "agent-zara", name: "zara", status: "done" }),
    );
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");
    const publish = (to: string, key: string) =>
      callTool(daemon, queen.token, "hive_mail_publish", {
        from: ORCHESTRATOR_NAME,
        to,
        lane: "control",
        topic: "handoff",
        body: "work",
        idempotencyKey: key,
      });

    const absent = await publish("nobody", "k-absent");
    expect(absent.ok).toBe(false);
    expect(absent.text).toContain("absent");

    const finished = await publish("zara", "k-terminal");
    expect(finished.ok).toBe(false);
    expect(finished.text).toContain("done");

    // The same live agent, refused only because the hierarchy holds no binding
    // for it: the positive control is the accepted publish that follows.
    spawner.bindingState = "unbound";
    const unbound = await publish("maya", "k-unbound");
    expect(unbound.ok).toBe(false);
    expect(unbound.text).toContain("unbound");

    spawner.bindingState = "bound";
    expect((await publish("maya", "k-bound")).ok).toBe(true);
    await daemon.stop();
  });

  test("a message addressed to an incarnation is not handed to its successor", async () => {
    const { daemon, db } = harness();
    // The two counters are deliberately different here, and stay different
    // through the respawn: the capability epoch does not move on a respawn, so
    // a test where they agree could not tell which one the fence reads.
    db.upsertAgent(agentRecord({ capabilityEpoch: 7 }));
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");

    const published = await callTool(daemon, queen.token, "hive_mail_publish", {
      from: ORCHESTRATOR_NAME,
      to: "maya",
      lane: "control",
      topic: "handoff",
      body: "for generation one",
      idempotencyKey: "queen-pinned-1",
      addressedGeneration: 1,
    });
    expect(published.ok).toBe(true);
    const itemId = String(mailOf(published).itemId);

    // The agent is respawned onto the same name: same mailbox, new incarnation,
    // and — as on a real respawn — the same capability epoch.
    const respawned = agentRecord({ capabilityEpoch: 7 });
    db.upsertAgent({
      ...respawned,
      sessionLocator: { ...required(respawned.sessionLocator), generation: 2 },
    });
    const successor = daemon.capabilities.mint("maya", "writer", { epoch: 7 });
    const stolen = await callTool(daemon, successor.token, "hive_mail_claim", {
      recipient: "maya",
      itemId,
      handlerId: "maya-turn-1",
    });
    expect(stolen.ok).toBe(false);
    expect(stolen.text).toContain("generation");

    // The control that makes the refusal above mean something: a message
    // addressed to the incarnation that is actually live IS handed over. A
    // lookup that reported some fixed generation would fail this one.
    const forSuccessor = await callTool(
      daemon,
      queen.token,
      "hive_mail_publish",
      {
        from: ORCHESTRATOR_NAME,
        to: "maya",
        lane: "control",
        topic: "handoff",
        body: "for generation two",
        idempotencyKey: "queen-pinned-2",
        addressedGeneration: 2,
      },
    );
    await callTool(daemon, successor.token, "hive_mail_poll", {
      recipient: "maya",
    });
    expect(
      (
        await callTool(daemon, successor.token, "hive_mail_claim", {
          recipient: "maya",
          itemId: String(mailOf(forSuccessor).itemId),
          handlerId: "maya-turn-2",
        })
      ).ok,
    ).toBe(true);
    await daemon.stop();
  });

  test("an agent cannot read another agent's mailbox", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    db.upsertAgent(agentRecord({ id: "agent-zara", name: "zara" }));
    const maya = daemon.capabilities.mint("maya", "writer");

    expect(
      (
        await callTool(daemon, maya.token, "hive_mail_poll", {
          recipient: "zara",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await callTool(daemon, maya.token, "hive_mail_publish", {
          from: "zara",
          to: ORCHESTRATOR_NAME,
          lane: "control",
          topic: "report",
          body: "spoofed",
          idempotencyKey: "forged-1",
        })
      ).ok,
    ).toBe(false);
    await daemon.stop();
  });

  test("a root with no bound session has no incarnation and is refused", async () => {
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: "/tmp/hive-mail-mcp-noop",
    });
    db.upsertAgent(agentRecord());
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");
    const publish = () =>
      callTool(daemon, queen.token, "hive_mail_publish", {
        from: ORCHESTRATOR_NAME,
        to: "maya",
        lane: "control",
        topic: "handoff",
        body: "from an unbound root",
        idempotencyKey: "queen-unbound-root",
      });

    // No root has ever been bound here, so there is no incarnation to act as.
    // Answering zero would let mail addressed to the first root be claimed by
    // whoever asks next.
    const refused = await publish();
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("MAIL_SUBJECT_UNBOUND");

    // The control: binding a root session gives it one, and the same call works.
    bindRootSession(db, 1);
    expect((await publish()).ok).toBe(true);
    await daemon.stop();
  });

  test("reports a mailbox that was passed over after a safe point", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");
    const waitingSince = "2026-08-01T12:00:00.000Z";
    const publishedAt = new Date(waitingSince);
    daemon.mail.publish({
      recipient: "maya",
      sender: ORCHESTRATOR_NAME,
      lane: "control",
      topic: "handoff",
      recipientGeneration: null,
      body: "unread instruction",
      idempotencyKey: "queen-slo-1",
      ttlSeconds: null,
      expiresAt: null,
      now: waitingSince,
      controlLaneCapacity: MAIL_CONTROL_LANE_CAPACITY,
    });
    const wellPast = new Date(publishedAt.getTime() + 30 * 60_000);
    const rootMail = () =>
      mailbox(daemon.mail, ORCHESTRATOR_NAME).map((item) => item.body);

    // No safe point observed: the agent has not had the chance to read, and
    // saying it was passed over would name the wrong problem.
    await daemon.mailService.sweep(wellPast);
    expect(rootMail()).toEqual([]);

    // The control: one observed turn boundary after the message arrived is the
    // whole difference between "not yet" and "passed over".
    db.insertEvent({
      kind: "turn-end",
      agentName: "maya",
      timestamp: new Date(publishedAt.getTime() + 60_000).toISOString(),
    });
    await daemon.mailService.sweep(wellPast);
    expect(rootMail()).toEqual([
      expect.stringContaining("Safe-point latency degraded for maya"),
    ]);

    // Rate limited by the key, not by a timer: the window is named by the
    // message's arrival, so a later sweep republishes the same key and is
    // answered with the original receipt.
    const alertId = daemon.mail.itemIdForKey(
      "hive-mail-latency",
      `mail-slo:maya:${waitingSince}`,
    );
    expect(alertId).not.toBeNull();
    const complaints: string[] = [];
    const wasError = console.error;
    console.error = (...parts: unknown[]) => complaints.push(parts.join(" "));
    try {
      await daemon.mailService.sweep(new Date(wellPast.getTime() + 60_000));
    } finally {
      console.error = wasError;
    }
    expect(rootMail()).toHaveLength(1);
    // A silent refusal looks exactly like a rate limit from the outside — one
    // alert either way — so the replay is what is asserted, not the count.
    expect(complaints).toEqual([]);
    expect(
      daemon.mail.itemIdForKey(
        "hive-mail-latency",
        `mail-slo:maya:${waitingSince}`,
      ),
    ).toBe(alertId);
    void queen;
    await daemon.stop();
  });

  test("reports a message it dead-letters, once per message", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const publishedAt = "2026-08-01T12:00:00.000Z";
    const receipt = daemon.mail.publish({
      recipient: "maya",
      sender: ORCHESTRATOR_NAME,
      lane: "control",
      topic: "handoff",
      recipientGeneration: null,
      body: "expires unread",
      idempotencyKey: "queen-dlq-1",
      ttlSeconds: 60,
      expiresAt: new Date(Date.parse(publishedAt) + 60_000).toISOString(),
      now: publishedAt,
      controlLaneCapacity: MAIL_CONTROL_LANE_CAPACITY,
    });
    const past = new Date(Date.parse(publishedAt) + 30 * 60_000);

    await daemon.mailService.sweep(past);
    expect(mailbox(daemon.mail, ORCHESTRATOR_NAME).map((i) => i.body)).toEqual([
      expect.stringContaining(`Mail dead-lettered: ${receipt.itemId}`),
    ]);
    expect(
      daemon.mail.itemIdForKey("hive-mail", `mail-dlq:${receipt.itemId}`),
    ).not.toBeNull();

    // The item is gone, so a second sweep has nothing to report and cannot
    // repeat itself.
    await daemon.mailService.sweep(new Date(past.getTime() + 60_000));
    expect(mailbox(daemon.mail, ORCHESTRATOR_NAME)).toHaveLength(1);
    await daemon.stop();
  });

  test("the deadline sweep runs on the daemon's own maintenance pass", async () => {
    const { daemon, db } = harness();
    db.upsertAgent(agentRecord());
    const queen = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator");
    const maya = daemon.capabilities.mint("maya", "writer");
    const published = await callTool(daemon, queen.token, "hive_mail_publish", {
      from: ORCHESTRATOR_NAME,
      to: "maya",
      lane: "control",
      topic: "handoff",
      body: "lease me",
      idempotencyKey: "queen-lease-1",
    });
    const itemId = String(mailOf(published).itemId);
    await callTool(daemon, maya.token, "hive_mail_claim", {
      recipient: "maya",
      itemId,
      handlerId: "maya-turn-1",
    });

    // Expire the lease by hand, then let the daemon's sweep notice it. The
    // message must come back on its own; nothing writes to a terminal.
    db.database
      .query("UPDATE mail_leases SET leaseUntil = ? WHERE itemId = ?")
      .run("2026-08-01T12:00:00.000Z", itemId);
    await daemon.runMaintenance();

    expect(
      mailOf(
        await callTool(daemon, maya.token, "hive_mail_poll", {
          recipient: "maya",
        }),
      ).control,
    ).toMatchObject({ itemId });
    expect(daemon.mail.getLease(itemId)).toBeNull();
    await daemon.stop();
  });
});

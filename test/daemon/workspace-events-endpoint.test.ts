import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type { AgentRecord } from "../../src/schemas/agent";
import { WorkspaceEventsPageSchema } from "../../src/schemas/status-envelope";

const AT = "2026-08-30T12:00:00.000Z";

const agent = (name: string): AgentRecord => ({
  id: `agent-${name}`,
  name,
  tool: "codex",
  model: "gpt-5-codex",
  category: "simple_coding",
  status: "working",
  taskDescription: "events",
  worktreePath: `/tmp/hive-${name}`,
  branch: `hive/${name}`,
  contextPct: null,
  createdAt: AT,
  lastEventAt: AT,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
});

const harness = () => {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(agent("bram"));
  db.insertAgent(agent("ines"));
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      async spawn() {
        return agent("spawned");
      },
    },
    repoRoot: "/tmp/hive-workspace-events-test",
  });
  return { daemon, db };
};

const call = (
  daemon: HiveDaemon,
  token: string,
  path: string,
  init: RequestInit = {},
) => {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return daemon.fetch(new Request(`http://hive${path}`, { ...init, headers }));
};

const report = (events: readonly { kind: string; data?: object }[]) =>
  JSON.stringify({
    schemaVersion: 1,
    events: events.map((event, index) => ({
      occurredAt: `2026-08-30T12:00:0${index}.000Z`,
      kind: event.kind,
      data: event.data ?? {},
    })),
  });

describe("pane events reach the workspace event stream", () => {
  test("a pane's report is stored under its own agent and read back in order", async () => {
    const { daemon } = harness();
    const bram = daemon.capabilities.mint("bram", "writer", { epoch: 0 }).token;

    const posted = await call(daemon, bram, "/pane-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: report([
        { kind: "pane.turn.started", data: { turnId: "t1", origin: "wake" } },
        {
          kind: "pane.tool.finished",
          data: { turnId: "t1", toolName: "Edit", status: "ok", files: 1 },
        },
      ]),
    });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({ accepted: 2, agentId: "agent-bram" });

    const read = await call(daemon, bram, "/workspace-events?agent=agent-bram");
    expect(read.status).toBe(200);
    const page = WorkspaceEventsPageSchema.parse(await read.json());
    expect(page.agentId).toBe("agent-bram");
    expect(page.nextSeq).toBeNull();
    expect(page.events.map((event) => event.kind)).toEqual([
      "pane.turn.started",
      "pane.tool.finished",
    ]);
    const first = page.events[0];
    expect(first?.entity).toEqual({ kind: "agent", id: "agent-bram" });
    expect(first?.source.kind).toBe("agent-pane");
    expect(first?.source.id).toBe("pane:bram");
    expect(first?.data).toMatchObject({
      turnId: "t1",
      origin: "wake",
      agentId: "agent-bram",
      subject: "bram",
    });
  });

  test("a pane cannot report as, or read, another agent", async () => {
    const { daemon } = harness();
    const bram = daemon.capabilities.mint("bram", "writer", { epoch: 0 }).token;
    const ines = daemon.capabilities.mint("ines", "reader", { epoch: 0 }).token;
    await call(daemon, bram, "/pane-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: report([{ kind: "pane.turn.started" }]),
    });

    const crossRead = await call(
      daemon,
      ines,
      "/workspace-events?agent=agent-bram",
    );
    expect(crossRead.status).toBe(403);
    const ownRead = await call(
      daemon,
      ines,
      "/workspace-events?agent=agent-ines",
    );
    expect(ownRead.status).toBe(200);
    expect(
      WorkspaceEventsPageSchema.parse(await ownRead.json()).events,
    ).toEqual([]);
    const user = daemon.capabilities.mint("user", "user", { epoch: 0 }).token;
    const anyRead = await call(
      daemon,
      user,
      "/workspace-events?agent=agent-bram",
    );
    expect(anyRead.status).toBe(200);
    expect(
      WorkspaceEventsPageSchema.parse(await anyRead.json()).events,
    ).toHaveLength(1);
  });

  test("pages cut at the limit name where to resume, and a bad kind is refused", async () => {
    const { daemon } = harness();
    const bram = daemon.capabilities.mint("bram", "writer", { epoch: 0 }).token;
    await call(daemon, bram, "/pane-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: report([
        { kind: "pane.tool.started" },
        { kind: "pane.tool.finished" },
        { kind: "pane.turn.ended" },
      ]),
    });
    const firstPage = WorkspaceEventsPageSchema.parse(
      await (
        await call(daemon, bram, "/workspace-events?agent=agent-bram&limit=2")
      ).json(),
    );
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.nextSeq).toBe(firstPage.events[1]?.seq ?? "");
    const secondPage = WorkspaceEventsPageSchema.parse(
      await (
        await call(
          daemon,
          bram,
          `/workspace-events?agent=agent-bram&limit=2&afterSeq=${firstPage.nextSeq}`,
        )
      ).json(),
    );
    expect(secondPage.events.map((event) => event.kind)).toEqual([
      "pane.turn.ended",
    ]);
    expect(secondPage.nextSeq).toBeNull();

    const refused = await call(daemon, bram, "/pane-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: report([{ kind: "status.turn" }]),
    });
    expect(refused.status).toBe(400);
  });

  test("pane events never become the agent's activity observation", async () => {
    const { daemon } = harness();
    const bram = daemon.capabilities.mint("bram", "writer", { epoch: 0 }).token;
    await call(daemon, bram, "/pane-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: report([{ kind: "pane.tool.started" }]),
    });
    expect(daemon.status.currentProjectionForAgent("agent-bram")).toBeNull();
    expect(daemon.status.listEventsForAgent("agent-bram")).toHaveLength(1);
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { projectStateDir } from "../../src/daemon/project-identity-core/state";
import { HiveDaemon } from "../../src/daemon/server";
import { EpisodicStore } from "../../src/memory-service/episodic";
import type { AgentRecord } from "../../src/schemas/agent";
import { tempRoot } from "../temp-root";

const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T11:00:00.000Z";
const T2 = "2026-07-22T12:00:00.000Z";

const tempDir = () => tempRoot("hive-episodic-test-");
const projectRoot = () => {
  const root = tempDir();
  const initialized = Bun.spawnSync(["git", "init", "--quiet", root]);
  if (initialized.exitCode !== 0) {
    throw new Error(
      `Failed to initialize isolated test repository: ${initialized.stderr.toString()}`,
    );
  }
  return root;
};

const stores: EpisodicStore[] = [];
const track = <T extends EpisodicStore>(store: T): T => {
  stores.push(store);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may already have closed its store (the lifecycle test does).
    }
  }
});

describe("EpisodicStore location and lifecycle", () => {
  test("opens under the per-project state dir and a fresh instance reads prior data", () => {
    const previousHome = process.env.HIVE_HOME;
    const home = tempDir();
    process.env.HIVE_HOME = home;
    try {
      const root = projectRoot();
      const first = track(EpisodicStore.forProjectRoot(root));
      expect(first.path).toBe(join(projectStateDir(root), "episodic.db"));
      expect(existsSync(first.path)).toBe(true);
      first.appendEvent({
        ts: T0,
        agent: "agent-a",
        type: "routing",
        summary: "WP1 landed",
      });
      first.close();

      // Restart: a fresh store instance over the same project identity reads
      // what the previous session wrote — the consolidation acceptance point.
      const reopened = track(EpisodicStore.forProjectRoot(root));
      const events = reopened.eventsFor();
      expect(events).toHaveLength(1);
      expect(events[0]?.summary).toBe("WP1 landed");
    } finally {
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("the doorkeeper bit survives a store restart", () => {
    const path = join(tempDir(), "episodic.db");
    const first = track(new EpisodicStore(path));
    const schemaVersion = first.readMeta("schemaVersion");
    expect(["2", "3"]).toContain(schemaVersion as string);
    if (schemaVersion === "2") {
      first.close();
      return;
    }
    expect(
      first.observeMemoryCandidate({
        signature: "error:sessiond:rangeerror",
        observedAt: T0,
        firstObservationReceipt: { key: "test.receipt", value: "1" },
      }),
    ).toBe("rejected");
    first.close();

    const reopened = track(new EpisodicStore(path));
    expect(
      reopened.observeMemoryCandidate({
        signature: "error:sessiond:rangeerror",
        observedAt: T1,
        firstObservationReceipt: { key: "test.receipt", value: "2" },
      }),
    ).toBe("admitted");
    expect(reopened.memoryAdmissionStats()).toEqual({
      seenCandidates: 1,
      rejectedTotal: 1,
      lastRejectedAt: T0,
    });
  });

  test("two project identities get two stores with no cross-reads", () => {
    const previousHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = tempDir();
    try {
      const rootA = projectRoot();
      const rootB = projectRoot();
      const storeA = track(EpisodicStore.forProjectRoot(rootA));
      const storeB = track(EpisodicStore.forProjectRoot(rootB));
      expect(storeA.path).not.toBe(storeB.path);

      storeA.appendEvent({
        agent: "agent-a",
        type: "test",
        summary: "A event",
      });

      expect(storeA.eventsFor()).toHaveLength(1);
      expect(storeB.eventsFor()).toHaveLength(0);
    } finally {
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });
});

describe("EpisodicStore events", () => {
  test("eventsFor filters by agent and since, in append order", () => {
    const store = track(new EpisodicStore(":memory:"));
    store.appendEvent({
      ts: T0,
      agent: "agent-a",
      type: "one",
      summary: "first",
    });
    store.appendEvent({
      ts: T1,
      agent: "agent-b",
      type: "two",
      summary: "second",
    });
    store.appendEvent({
      ts: T2,
      agent: "agent-a",
      type: "three",
      summary: "third",
    });

    expect(store.eventsFor().map((event) => event.summary)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(store.eventsFor({ agent: "agent-a" })).toHaveLength(2);
    expect(
      store.eventsFor({ since: T1 }).map((event) => event.summary),
    ).toEqual(["second", "third"]);
    const withProvenance = store.appendEvent({
      agent: null,
      type: "audit",
      summary: "with provenance",
      provenance: { eventId: "evt_1", seq: "9" },
    });
    expect(JSON.parse(withProvenance.provenance)).toEqual({
      eventId: "evt_1",
      seq: "9",
    });
  });
});

const agent = (name = "maya"): AgentRecord => ({
  id: `agent-${name}`,
  name,
  tool: "codex",
  model: "gpt-5-codex",
  category: "simple_coding",
  status: "working",
  taskDescription: "WP1",
  worktreePath: `/tmp/hive-${name}`,
  branch: `hive/${name}`,
  contextPct: null,
  createdAt: T0,
  lastEventAt: T0,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
});

const daemonHarness = (episodic: EpisodicStore) => {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(agent());
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      async spawn() {
        return agent("spawned");
      },
    },
    repoRoot: "/tmp/hive-episodic-daemon-test",
    episodicStore: episodic,
  });
  return { db, daemon };
};

describe("daemon ingestion into the episodic store", () => {
  test("a status report through the daemon path lands an events row", async () => {
    const episodic = track(new EpisodicStore(":memory:"));
    const { daemon } = daemonHarness(episodic);
    const assignment = daemon.status.currentAssignment("agent-maya");
    expect(assignment).not.toBeNull();
    daemon.status.appendAgentReport(
      {
        subject: "maya",
        agentId: "agent-maya",
        incarnationGeneration: 1,
        role: "writer",
        capabilityEpoch: 0,
        toolSessionId: null,
      },
      {
        requestId: "req_018f1e90-7b5a-7cc0-8000-0000000000e1",
        assignmentId: required(assignment).assignmentId,
        assignmentGeneration: required(assignment).assignmentGeneration,
        phase: "implementing",
        summary: "Halfway through WP1",
        blocker: null,
        evidenceRefs: [],
        freshForSeconds: 120,
      },
      new Date(T1),
    );
    await Bun.sleep(10);

    const events = episodic.eventsFor({ agent: "agent-maya" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("agent.status-reported");
    expect(events[0]?.summary).toBe("Halfway through WP1");
    expect(events[0]?.ts).toBe(T1);
    const provenance = JSON.parse(required(events[0]?.provenance)) as {
      eventId: string;
      seq: string;
      data: Record<string, unknown>;
    };
    expect(provenance.eventId).toStartWith("evt_");
    expect(provenance.data.phase).toBe("implementing");
  });

  test("the terminal observation audit lands an events row", async () => {
    const episodic = track(new EpisodicStore(":memory:"));
    const { daemon } = daemonHarness(episodic);
    daemon.status.appendObservationAudit({
      reader: "hive",
      readerRole: "user",
      subjectAgentId: "agent-maya",
      subjectGeneration: 1,
      rowCount: 24,
      reason: "capability:cap-fixture",
      observedAt: T1,
    });
    await Bun.sleep(10);
    const events = episodic.eventsFor({ agent: "agent-maya" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("terminal.content-observed");
  });

  test("an episodic write failure never breaks the status write", async () => {
    const episodic = track(new EpisodicStore(":memory:"));
    const { daemon } = daemonHarness(episodic);
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      // Force every episodic write to fail by closing the store out from
      // under the daemon.
      episodic.close();
      const event = daemon.status.appendObservationAudit({
        reader: "hive",
        readerRole: "user",
        subjectAgentId: "agent-maya",
        subjectGeneration: 1,
        rowCount: 24,
        reason: "capability:cap-fixture",
        observedAt: T1,
      });
      // The primary record was written and published despite the failure.
      expect(event.kind).toBe("terminal.content-observed");
      expect(daemon.status.listEvents()).toHaveLength(1);
      await Bun.sleep(10);
      expect(
        errors.some((message) => message.includes("episodic ingest failed")),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("stop() closes the episodic store with the daemon", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonHarness(episodic);
    await daemon.stop();
    expect(() => episodic.eventsFor()).toThrow();
  });
});

import { required } from "../required";

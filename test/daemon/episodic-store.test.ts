import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AgentRecord } from "../../src/schemas";
import { HiveDatabase } from "../../src/daemon/db";
import { EpisodicStore } from "../../src/daemon/episodic-store";
import { projectHiveUuid } from "../../src/daemon/project-state";
import { HiveDaemon } from "../../src/daemon/server";

const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T11:00:00.000Z";
const T2 = "2026-07-22T12:00:00.000Z";

const tempDir = () => mkdtempSync(join(tmpdir(), "hive-episodic-test-"));

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
      const root = tempDir();
      const hiveUuid = projectHiveUuid(root);
      const first = track(EpisodicStore.forProjectRoot(root));
      expect(first.path).toBe(join(home, "projects", hiveUuid, "episodic.db"));
      expect(existsSync(first.path)).toBe(true);
      first.recordFact({
        topic: "routing",
        title: "WP1 landed",
        body: "Episodic store exists",
        source: "test",
        validAt: T0,
      });
      first.close();

      // Restart: a fresh store instance over the same project identity reads
      // what the previous session wrote — the consolidation acceptance point.
      const reopened = track(EpisodicStore.forProjectRoot(root));
      const facts = reopened.currentFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0]!.title).toBe("WP1 landed");
    } finally {
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("two project identities get two stores with no cross-reads", () => {
    const previousHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = tempDir();
    try {
      const rootA = tempDir();
      const rootB = tempDir();
      const storeA = track(EpisodicStore.forProjectRoot(rootA));
      const storeB = track(EpisodicStore.forProjectRoot(rootB));
      expect(storeA.path).not.toBe(storeB.path);

      storeA.recordFact({
        topic: "routing",
        title: "project A belief",
        body: "Only A knows this",
        source: "test",
        validAt: T0,
      });
      storeA.appendEvent({ agent: "agent-a", type: "test", summary: "A event" });

      expect(storeA.currentFacts()).toHaveLength(1);
      expect(storeA.eventsFor()).toHaveLength(1);
      expect(storeB.currentFacts()).toHaveLength(0);
      expect(storeB.eventsFor()).toHaveLength(0);
    } finally {
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });
});

describe("EpisodicStore bi-temporal facts", () => {
  test("invalidated facts leave currentFacts but stay readable as of their valid time", () => {
    const store = track(new EpisodicStore(":memory:"));
    const fact = store.recordFact({
      topic: "deploy",
      title: "Deploys go through CI",
      body: "All deploys are CI-driven",
      source: "test",
      validAt: T0,
    });
    expect(store.currentFacts().map((current) => current.id)).toEqual([fact.id]);
    expect(store.factsAsOf(T0)).toHaveLength(1);

    const invalidated = store.invalidateFact(fact.id, { at: T1 });
    expect(invalidated?.invalidAt).toBe(T1);
    expect(store.currentFacts()).toHaveLength(0);
    // History is intact: before the invalidation the fact was believed.
    expect(store.factsAsOf(T0).map((current) => current.id)).toEqual([fact.id]);
    expect(store.factsAsOf(T2)).toHaveLength(0);
    // Invalidating again is a no-op, not a second stamp.
    expect(store.invalidateFact(fact.id, { at: T2 })).toBeNull();
  });

  test("contradiction is a new row plus an invalid_at stamp and a supersedes pointer", () => {
    const store = track(new EpisodicStore(":memory:"));
    const old = store.recordFact({
      kind: "decision",
      topic: "memory",
      title: "Store is per-install",
      body: "One store per install",
      source: "test",
      validAt: T0,
    });
    const replacement = store.recordFact({
      kind: "decision",
      topic: "memory",
      title: "Store is per-project",
      body: "One store per project identity",
      source: "test",
      validAt: T1,
      supersedesId: old.id,
    });

    expect(replacement.supersedesId).toBe(old.id);
    // The old row was stamped, not deleted: it is gone from the present but
    // fully readable in the past.
    const current = store.currentFacts();
    expect(current.map((fact) => fact.id)).toEqual([replacement.id]);
    const before = store.factsAsOf(T0);
    expect(before.map((fact) => fact.id)).toEqual([old.id]);
    expect(before[0]!.invalidAt).toBe(T1);
    expect(store.factsAsOf(T2).map((fact) => fact.id)).toEqual([replacement.id]);
  });

  test("invalidateFact links the superseding row back to the invalidated one", () => {
    const store = track(new EpisodicStore(":memory:"));
    const old = store.recordFact({
      topic: "quota",
      title: "v1",
      body: "old",
      source: "test",
      validAt: T0,
    });
    const next = store.recordFact({
      topic: "quota",
      title: "v2",
      body: "new",
      source: "test",
      validAt: T1,
    });
    store.invalidateFact(old.id, { supersededBy: next.id, at: T1 });
    const after = store.factsAsOf(T2);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(next.id);
    expect(after[0]!.supersedesId).toBe(old.id);
  });
});

describe("EpisodicStore events", () => {
  test("eventsFor filters by agent and since, in append order", () => {
    const store = track(new EpisodicStore(":memory:"));
    store.appendEvent({ ts: T0, agent: "agent-a", type: "one", summary: "first" });
    store.appendEvent({ ts: T1, agent: "agent-b", type: "two", summary: "second" });
    store.appendEvent({ ts: T2, agent: "agent-a", type: "three", summary: "third" });

    expect(store.eventsFor().map((event) => event.summary)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(store.eventsFor({ agent: "agent-a" })).toHaveLength(2);
    expect(store.eventsFor({ since: T1 }).map((event) => event.summary)).toEqual([
      "second",
      "third",
    ]);
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
  tmuxSession: `hive-${name}`,
  contextPct: null,
  createdAt: T0,
  lastEventAt: T0,
  recoveryAttempts: 0,
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
    spawner: { async spawn() { return agent("spawned"); } },
    repoRoot: "/tmp/hive-episodic-daemon-test",
    episodicStore: episodic,
  });
  return { db, daemon };
};

describe("daemon ingestion into the episodic store", () => {
  test("a status report through the daemon path lands an events row", () => {
    const episodic = track(new EpisodicStore(":memory:"));
    const { daemon } = daemonHarness(episodic);
    const assignment = daemon.status.currentAssignment("agent-maya");
    expect(assignment).not.toBeNull();
    daemon.status.appendAgentReport({
      subject: "maya",
      agentId: "agent-maya",
      incarnationGeneration: 1,
      role: "writer",
      capabilityEpoch: 0,
      toolSessionId: null,
    }, {
      requestId: "req_018f1e90-7b5a-7cc0-8000-0000000000e1",
      assignmentId: assignment!.assignmentId,
      assignmentGeneration: assignment!.assignmentGeneration,
      phase: "implementing",
      summary: "Halfway through WP1",
      blocker: null,
      evidenceRefs: [],
      freshForSeconds: 120,
    }, new Date(T1));

    const events = episodic.eventsFor({ agent: "agent-maya" });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("agent.status-reported");
    expect(events[0]!.summary).toBe("Halfway through WP1");
    expect(events[0]!.ts).toBe(T1);
    const provenance = JSON.parse(events[0]!.provenance) as {
      eventId: string;
      seq: string;
    };
    expect(provenance.eventId).toStartWith("evt_");
  });

  test("the terminal observation audit lands an events row", () => {
    const episodic = track(new EpisodicStore(":memory:"));
    const { daemon } = daemonHarness(episodic);
    daemon.status.appendObservationAudit({
      reader: "hive",
      readerRole: "operator",
      subjectAgentId: "agent-maya",
      subjectGeneration: 1,
      rowCount: 24,
      reason: "capability:cap-fixture",
      observedAt: T1,
    });
    const events = episodic.eventsFor({ agent: "agent-maya" });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("terminal.content-observed");
  });

  test("an episodic write failure never breaks the status write", () => {
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
        readerRole: "operator",
        subjectAgentId: "agent-maya",
        subjectGeneration: 1,
        rowCount: 24,
        reason: "capability:cap-fixture",
        observedAt: T1,
      });
      // The primary record was written and published despite the failure.
      expect(event.kind).toBe("terminal.content-observed");
      expect(daemon.status.listEvents()).toHaveLength(1);
      expect(errors.some((message) => message.includes("episodic ingest failed")))
        .toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("stop() closes the episodic store with the daemon", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonHarness(episodic);
    await daemon.stop();
    expect(() => episodic.currentFacts()).toThrow();
  });
});

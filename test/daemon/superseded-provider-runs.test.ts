import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import type { ProviderRun } from "../../src/schemas/provider-run";

const home = mkdtempSync(join(tmpdir(), "hive-superseded-runs-"));

// sessionId is derived from the runId because provider_runs carries a partial
// unique index on (instanceId, sessionId, generation) for running rows, so two
// subjects at the same generation in one instance must not share a session.
function terminal(
  instanceId: string,
  generation: number,
  agentId: string | null,
  runId: string,
) {
  return {
    schemaVersion: 1 as const,
    instanceId,
    subject:
      agentId === null
        ? ({ kind: "root" } as const)
        : ({ kind: "agent" as const, agentId } as const),
    generation,
    sessionId: `ses_${runId}`,
    hostKind: "sessiond" as const,
    engineBuildId: "engine-fixture",
  };
}

function run(overrides: {
  runId: string;
  agentId: string | null;
  instanceId: string;
  generation: number;
  startedAt: string;
}): ProviderRun {
  return {
    runId: overrides.runId,
    agentId: overrides.agentId,
    terminal: terminal(
      overrides.instanceId,
      overrides.generation,
      overrides.agentId,
      overrides.runId,
    ),
    provider: "claude",
    model: "claude-opus-5",
    effort: null,
    conversationId: null,
    adapterChild: null,
    protocolReceipt: null,
    capabilityEpoch: 0,
    launchGrantId: `grant-${overrides.runId}`,
    startedAt: overrides.startedAt,
    endedAt: null,
    state: "running",
    exitReason: null,
  };
}

const uuid = (n: number) =>
  `018f1e90-7b5a-7cc0-8000-${String(n).padStart(12, "0")}`;

/**
 * Seeds six superseded root generations, the newest root generation, a root
 * from a SECOND instance that nothing supersedes, and a live agent run — then
 * reopens the database so the repair runs against stored rows.
 */
function seedAndReopen(path: string): HiveDatabase {
  let db = new HiveDatabase(path);
  for (let generation = 1; generation <= 7; generation += 1) {
    db.insertProviderRun(
      run({
        runId: uuid(generation),
        agentId: null,
        instanceId: "instance-live",
        generation,
        startedAt: `2026-08-1${generation}T00:00:00.000Z`,
      }),
    );
  }
  // A root in a different instance: nothing supersedes it there, so the repair
  // must not touch it however old it looks.
  db.insertProviderRun(
    run({
      runId: uuid(90),
      agentId: null,
      instanceId: "instance-other",
      generation: 1,
      startedAt: "2026-08-10T00:00:00.000Z",
    }),
  );
  // THE SEEDED SURVIVING SENTINEL. A genuinely live agent run with no successor.
  // Without it, "the stale rows are closed" and "I closed everything" are the
  // same observation.
  db.insertProviderRun(
    run({
      runId: uuid(91),
      agentId: "agent-sentinel",
      instanceId: "instance-live",
      generation: 1,
      startedAt: "2026-08-16T00:00:00.000Z",
    }),
  );
  db.close();
  db = new HiveDatabase(path);
  return db;
}

describe("closing provider runs a newer run for the same subject contradicts", () => {
  test("supersession closes the older generations and nothing else", () => {
    const path = join(home, "supersede.db");
    const db = seedAndReopen(path);
    try {
      // Root generations 1-6 are contradicted by generation 7 existing.
      for (let generation = 1; generation <= 6; generation += 1) {
        const closed = db.getProviderRun(uuid(generation));
        expect(closed?.state).toBe("exited");
        expect(closed?.exitReason).toBe("superseded-by-newer-run");
        // endedAt is the successor's startedAt: the run cannot have outlived
        // the start of the run that replaced it.
        expect(closed?.endedAt).toBe(
          `2026-08-1${generation + 1}T00:00:00.000Z`,
        );
      }

      // THE SENTINEL SURVIVED. This is the assertion that makes the six above
      // mean something.
      const sentinel = db.getProviderRun(uuid(91));
      expect(sentinel?.state).toBe("running");
      expect(sentinel?.endedAt).toBeNull();

      // The newest root generation is not decidable here and is left alone.
      const newest = db.getProviderRun(uuid(7));
      expect(newest?.state).toBe("running");

      // A root nothing supersedes stays open even though it is the oldest row
      // in the table — age is not evidence.
      const otherInstance = db.getProviderRun(uuid(90));
      expect(otherInstance?.state).toBe("running");
    } finally {
      db.close();
    }
  });

  test("reopening again changes nothing", () => {
    const path = join(home, "idempotent.db");
    let db = seedAndReopen(path);
    const afterFirst = db.getProviderRun(uuid(3));
    db.close();

    db = new HiveDatabase(path);
    try {
      expect(db.getProviderRun(uuid(3))).toEqual(afterFirst);
      expect(db.getProviderRun(uuid(91))?.state).toBe("running");
    } finally {
      db.close();
    }
  });

  test("the newest run for an agent is never closed by a run for a different agent", () => {
    const path = join(home, "cross-agent.db");
    let db = new HiveDatabase(path);
    db.insertProviderRun(
      run({
        runId: uuid(20),
        agentId: "agent-one",
        instanceId: "instance-live",
        generation: 1,
        startedAt: "2026-08-10T00:00:00.000Z",
      }),
    );
    // Inserted later, so a higher rowid — but it belongs to another agent and
    // therefore contradicts nothing about the first.
    db.insertProviderRun(
      run({
        runId: uuid(21),
        agentId: "agent-two",
        instanceId: "instance-live",
        generation: 2,
        startedAt: "2026-08-16T00:00:00.000Z",
      }),
    );
    db.close();

    db = new HiveDatabase(path);
    try {
      expect(db.getProviderRun(uuid(20))?.state).toBe("running");
      expect(db.getProviderRun(uuid(21))?.state).toBe("running");
    } finally {
      db.close();
    }
  });
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));

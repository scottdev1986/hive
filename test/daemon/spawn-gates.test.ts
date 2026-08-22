// The gated spawner IS the spawn policy: these tests stand in for a third,
// hypothetical caller that was just handed the spawner, and prove it cannot
// launch around the gates no matter which door-shaped call it makes.
import { describe, expect, test } from "bun:test";
import { GatedSpawner } from "../../src/daemon/spawn/gates";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import type { MachineOperation } from "../../src/daemon/mutation-lease";
import { ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import type { AgentRecord } from "../../src/schemas/agent";
import type { AdmissionDecision } from "../../src/daemon/queen-provider-service/succession";

const timestamp = "2026-08-09T12:00:00.000Z";

const request: SpawnRequest = {
  task: "pick up the work",
  category: "simple_coding",
};

const trackedRequest: SpawnRequest = {
  ...request,
  taskId: "task_018f1e90-7b5a-7cc0-8000-000000000001",
};

function agentRecord(name: string): AgentRecord {
  return {
    id: `agent-${name}`,
    name,
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "working",
    taskDescription: request.task,
    worktreePath: "/tmp/hive-gated",
    branch: "hive/gated-work",
    contextPct: 3,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  };
}

class StubSpawner implements Spawner {
  readonly requests: SpawnRequest[] = [];
  async spawn(spawnRequest: SpawnRequest): Promise<AgentRecord> {
    this.requests.push(spawnRequest);
    return agentRecord("spawned");
  }
}

function harness(options: {
  admit?: AdmissionDecision;
  memoryPressure?: boolean;
  stopping?: boolean;
}) {
  const inner = new StubSpawner();
  const operations: string[] = [];
  const released: string[] = [];
  const gates = {
    isStopping: () => options.stopping ?? false,
    admitRootWork: () =>
      // SAFETY: The test owns this value and its fields.
      options.admit ?? ({ admit: true } as AdmissionDecision),
    memoryPressure: () => options.memoryPressure ?? false,
    machineMutations: {
      beginOperation: async (kind: string): Promise<MachineOperation> => {
        operations.push(kind);
        return {
          release: () => {
            released.push(kind);
          },
        };
      },
    },
  };
  const spawner = new GatedSpawner(inner, gates);
  return { inner, spawner, operations, released };
}

describe("GatedSpawner — a caller handed the spawner cannot bypass the gates", () => {
  test("shutdown refuses every new launch before the inner spawner runs", async () => {
    const { inner, spawner } = harness({ stopping: true });
    await expect(spawner.spawn(request, "some-agent")).rejects.toThrow(
      "shutting down and refusing new work admission",
    );
    await expect(spawner.spawnDrainReplacement(request)).rejects.toThrow(
      "shutting down and refusing new work admission",
    );
    expect(inner.requests).toEqual([]);
  });

  test("memory pressure refuses any spawn before the inner spawner runs", async () => {
    const { inner, spawner } = harness({ memoryPressure: true });
    await expect(spawner.spawn(request, "some-agent")).rejects.toThrow(
      "refusing to spawn new agents while the system is under memory pressure",
    );
    await expect(spawner.spawn(request, "some-agent")).rejects.toThrow(
      "Fix: hive_quota_status; reduce the concurrent fleet; or wait for the resource watchdog to clear, then retry.",
    );
    expect(inner.requests).toEqual([]);
  });

  test("the root is refused when her work admission says no", async () => {
    const { inner, spawner } = harness({
      admit: { admit: false, reason: "no verified checkpoint" },
    });
    await expect(
      spawner.spawn(trackedRequest, ORCHESTRATOR_NAME),
    ).rejects.toThrow("no verified checkpoint");
    expect(inner.requests).toEqual([]);
  });

  test("the root cannot dispatch work without its board story", async () => {
    const { inner, spawner } = harness({});
    await expect(spawner.spawn(request, ORCHESTRATOR_NAME)).rejects.toThrow(
      "Queen dispatch requires a board task",
    );
    expect(inner.requests).toEqual([]);
  });

  test("work admission binds the root alone; other subjects never consult it", async () => {
    const { inner, spawner } = harness({
      admit: { admit: false, reason: "no verified checkpoint" },
    });
    await spawner.spawn(request, "some-agent");
    expect(inner.requests).toEqual([request]);
  });

  test("every spawn holds the machine-mutation lease around the launch", async () => {
    const { spawner, operations, released } = harness({});
    await spawner.spawn(request, "some-agent");
    expect(operations).toEqual(["spawn"]);
    expect(released).toEqual(["spawn"]);
  });

  test("the lease is released even when the launch itself fails", async () => {
    const inner: Spawner = {
      async spawn(): Promise<AgentRecord> {
        throw new Error("launch exploded");
      },
    };
    let released = false;
    const spawner = new GatedSpawner(inner, {
      isStopping: () => false,
      admitRootWork: () => ({ admit: true }),
      memoryPressure: () => false,
      machineMutations: {
        beginOperation: async (): Promise<MachineOperation> => ({
          release: () => {
            released = true;
          },
        }),
      },
    });
    await expect(spawner.spawn(request, "some-agent")).rejects.toThrow(
      "launch exploded",
    );
    expect(released).toBe(true);
  });

  test("drain replacement is exempt from memory pressure alone", async () => {
    const { inner, spawner, operations, released } = harness({
      memoryPressure: true,
    });
    await spawner.spawnDrainReplacement(request);
    // The launch happened despite the pressure…
    expect(inner.requests).toEqual([request]);
    // …and it still took and released the machine-mutation lease.
    expect(operations).toEqual(["spawn"]);
    expect(released).toEqual(["spawn"]);
  });
});

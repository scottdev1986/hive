import { describe, expect, test } from "bun:test";
import {
  DaemonMaintenance,
  type MaintenanceFailure,
} from "../../src/daemon/lifecycle/maintenance";

function runner(failures: MaintenanceFailure[] = []): DaemonMaintenance {
  return new DaemonMaintenance(60_000, (failure) => failures.push(failure));
}

describe("daemon maintenance", () => {
  test("is unknown until a complete successful sweep", async () => {
    const maintenance = runner();
    expect(maintenance.health()).toEqual({ status: "unknown" });

    await maintenance.sweep([], () => undefined);
    expect(maintenance.health()).toEqual({ status: "ok" });
  });

  test("isolates task failures, runs later tasks, and reports degraded health", async () => {
    const reported: MaintenanceFailure[] = [];
    const maintenance = runner(reported);
    const completed: string[] = [];

    await maintenance.sweep(
      [
        {
          component: "broken subsystem",
          run: () => {
            throw new Error("fixture failure");
          },
        },
        {
          component: "healthy subsystem",
          run: () => {
            completed.push("healthy subsystem");
          },
        },
      ],
      () => undefined,
    );

    const failure = {
      component: "broken subsystem",
      error: "fixture failure",
    };
    expect(completed).toEqual(["healthy subsystem"]);
    expect(reported).toEqual([failure]);
    expect(maintenance.health()).toEqual({
      status: "degraded",
      failures: [failure],
    });
  });

  test("a finalization failure is an error and rejects the sweep", async () => {
    const reported: MaintenanceFailure[] = [];
    const maintenance = runner(reported);

    await expect(
      maintenance.sweep([], () => {
        throw new Error("history prune failed");
      }),
    ).rejects.toThrow("history prune failed");
    expect(maintenance.health()).toEqual({
      status: "error",
      error: "history prune failed",
    });
    expect(reported).toEqual([
      {
        component: "maintenance finalization",
        error: "history prune failed",
      },
    ]);
  });

  test("paces an expensive successful component without delaying other work", async () => {
    const maintenance = runner();
    let expensiveRuns = 0;
    let ordinaryRuns = 0;
    const tasks = [
      {
        component: "expensive subsystem",
        minimumIntervalMs: 60_000,
        run: () => {
          expensiveRuns += 1;
        },
      },
      {
        component: "ordinary subsystem",
        run: () => {
          ordinaryRuns += 1;
        },
      },
    ];

    await maintenance.sweep(tasks, () => undefined);
    await maintenance.sweep(tasks, () => undefined);

    expect(expensiveRuns).toBe(1);
    expect(ordinaryRuns).toBe(2);
  });

  test("stop drains an in-flight sweep before resolving", async () => {
    // Positive control for the shared-process leak: a test that called stop()
    // while the startup recovery sweep was still doing git work used to return
    // immediately, leaving that work to land inside later tests' windows.
    const maintenance = runner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const sweepPromise = maintenance.sweep(
      [
        {
          component: "slow subsystem",
          run: async () => {
            await gate;
            finished = true;
          },
        },
      ],
      () => undefined,
    );
    // Yield so the sweep body reaches the gate before we call stop.
    await Promise.resolve();
    await Promise.resolve();
    let stopped = false;
    const stopPromise = maintenance.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(finished).toBe(false);
    release();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(finished).toBe(true);
    await sweepPromise;
  });

  test("stop clears the recurring timer so later ticks do not fire", async () => {
    const maintenance = new DaemonMaintenance(20, () => undefined);
    let ticks = 0;
    maintenance.start(async () => {
      ticks += 1;
    });
    await Bun.sleep(50);
    const ticksBeforeStop = ticks;
    expect(ticksBeforeStop).toBeGreaterThan(0);
    await maintenance.stop();
    await Bun.sleep(50);
    expect(ticks).toBe(ticksBeforeStop);
  });

  test("stop refuses by name when an in-flight task ignores cancellation", async () => {
    const maintenance = new DaemonMaintenance(60_000, () => undefined, 40);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const later: string[] = [];
    const sweepPromise = maintenance.sweep(
      [
        {
          component: "stuck drain",
          run: async () => {
            await gate;
          },
        },
        {
          component: "later drain",
          run: () => {
            later.push("ran");
          },
        },
      ],
      () => {
        later.push("finalized");
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    const outcome = await Promise.race([
      maintenance.stop().then(
        () => "resolved" as const,
        (error) => error,
      ),
      Bun.sleep(200).then(() => "still-pending" as const),
    ]);

    try {
      expect(outcome).toBeInstanceOf(Error);
      // SAFETY: The test owns this value and its fields.
      expect((outcome as Error).message).toBe(
        'Hive refused shutdown because maintenance drain "stuck drain" did not finish',
      );
    } finally {
      release();
      await sweepPromise;
    }
    expect(later).toEqual([]);
  });

  test("stop signals cancellation so a cooperative task unwinds and later work does not run", async () => {
    const maintenance = new DaemonMaintenance(60_000, () => undefined, 200);
    const seen: string[] = [];
    const sweepPromise = maintenance.sweep(
      [
        {
          component: "cooperative drain",
          run: async (signal) => {
            seen.push("started");
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
                return;
              }
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            seen.push("unwound");
          },
        },
        {
          component: "later drain",
          run: () => {
            seen.push("later");
          },
        },
      ],
      () => {
        seen.push("finalized");
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    await maintenance.stop();
    await sweepPromise;
    expect(seen).toEqual(["started", "unwound"]);
  });
});

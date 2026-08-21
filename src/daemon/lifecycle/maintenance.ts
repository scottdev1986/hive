import { errorMessage } from "../../shared/error-message";

export interface MaintenanceFailure {
  readonly component: string;
  readonly error: string;
}

export type MaintenanceHealth =
  | { readonly status: "unknown" }
  | { readonly status: "ok" }
  | {
      readonly status: "degraded";
      readonly failures: readonly MaintenanceFailure[];
    }
  | { readonly status: "error"; readonly error: string };

export interface MaintenanceTask {
  readonly component: string;
  readonly run: (signal: AbortSignal) => void | Promise<void>;
  readonly minimumIntervalMs?: number;
}

/** After stop() signals cancellation, wait this long for the current drain to unwind before refusing by name. */
export const MAINTENANCE_DRAIN_TIMEOUT_MS = 10_000;

export class DaemonMaintenance {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** The sweep currently in flight, if any. stop() drains this so callers do not race a still-running recovery against teardown. */
  private activeSweep: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private inflightComponent: string | null = null;
  private currentHealth: MaintenanceHealth = { status: "unknown" };
  private readonly lastSuccessfulRun = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly reportFailure: (failure: MaintenanceFailure) => void,
    private readonly drainTimeoutMs = MAINTENANCE_DRAIN_TIMEOUT_MS,
  ) {}

  health(): MaintenanceHealth {
    return this.currentHealth;
  }

  start(sweep: () => Promise<void>): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void sweep().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * End the recurring timer and wait for any sweep already in flight.
   * Clearing the interval alone is not enough: start() also fires an immediate
   * recovery sweep, and tests that stop a daemon within milliseconds would
   * otherwise leave that work running into later tests that share the process.
   * stop() signals cancellation so tasks that honour AbortSignal can unwind.
   * A task that does not is refused by name rather than awaited without bound.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    const inflight = this.activeSweep;
    if (inflight === null) return;

    let settled = false;
    const done = inflight
      .catch(() => undefined)
      .then(() => {
        settled = true;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.drainTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (settled) return;
    const name = this.inflightComponent ?? "maintenance sweep";
    throw new Error(
      `Hive refused shutdown because maintenance drain "${name}" did not finish`,
    );
  }

  async sweep(
    tasks: readonly MaintenanceTask[],
    finalize: () => Promise<void> | void,
  ): Promise<void> {
    if (this.running) {
      // Joining the run already in flight is what awaiting a sweep asks for.
      // Resolving straight away instead would report a sweep to a caller that
      // never got one, and readiness is read off the health this sets.
      await this.activeSweep?.catch(() => undefined);
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    const work = this.runSweep(tasks, finalize, this.abort.signal);
    this.activeSweep = work;
    try {
      await work;
    } finally {
      this.running = false;
      if (this.activeSweep === work) this.activeSweep = null;
    }
  }

  private async runSweep(
    tasks: readonly MaintenanceTask[],
    finalize: () => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<void> {
    const failures: MaintenanceFailure[] = [];
    try {
      for (const task of tasks) {
        if (signal.aborted) return;
        const lastRun = this.lastSuccessfulRun.get(task.component);
        if (
          lastRun !== undefined &&
          task.minimumIntervalMs !== undefined &&
          Date.now() - lastRun < task.minimumIntervalMs
        ) {
          continue;
        }
        this.inflightComponent = task.component;
        try {
          await task.run(signal);
          if (signal.aborted) return;
          this.lastSuccessfulRun.set(task.component, Date.now());
        } catch (error) {
          if (signal.aborted) return;
          const failure = {
            component: task.component,
            error: errorMessage(error),
          };
          failures.push(failure);
          this.reportFailure(failure);
        }
      }
      if (signal.aborted) return;
      this.inflightComponent = "maintenance finalization";
      await finalize();
      this.currentHealth =
        failures.length === 0
          ? { status: "ok" }
          : { status: "degraded", failures };
    } catch (error) {
      if (signal.aborted) return;
      const message = errorMessage(error);
      this.currentHealth = { status: "error", error: message };
      this.reportFailure({
        component: "maintenance finalization",
        error: message,
      });
      throw error;
    } finally {
      this.inflightComponent = null;
    }
  }
}

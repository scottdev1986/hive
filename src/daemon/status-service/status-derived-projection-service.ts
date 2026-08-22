import type { WorkspaceEventV2 } from "../../schemas/status-envelope";

export interface StatusDerivedProjectionServiceOptions {
  readonly project: (event: WorkspaceEventV2) => void;
  readonly capacity?: number;
  readonly batchSize?: number;
  readonly onError?: <T>(event: WorkspaceEventV2, error: T) => void;
  readonly onDrop?: (dropped: number) => void;
}

export class StatusDerivedProjectionService {
  private readonly queue: WorkspaceEventV2[] = [];
  private readonly capacity: number;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private closed = false;
  private dropped = 0;

  constructor(private readonly options: StatusDerivedProjectionServiceOptions) {
    this.capacity = options.capacity ?? 1_024;
    this.batchSize = options.batchSize ?? 32;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new Error("status projection capacity must be a positive integer");
    }
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new Error(
        "status projection batch size must be a positive integer",
      );
    }
  }

  enqueue(event: WorkspaceEventV2): void {
    if (this.closed) return;
    if (this.queue.length === this.capacity) {
      this.queue.shift();
      this.dropped += 1;
      this.options.onDrop?.(this.dropped);
    }
    this.queue.push(event);
    this.schedule();
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.drain();
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private schedule(): void {
    if (this.timer !== null || this.active !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, 0);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.active !== null) return await this.active;
    const work = this.runBatches();
    this.active = work;
    try {
      await work;
    } finally {
      if (this.active === work) this.active = null;
      if (this.queue.length > 0) this.schedule();
    }
  }

  private async runBatches(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      for (const event of batch) {
        try {
          this.options.project(event);
        } catch (error) {
          this.options.onError?.(event, error);
        }
      }
      if (this.queue.length > 0) await Bun.sleep(0);
    }
  }
}

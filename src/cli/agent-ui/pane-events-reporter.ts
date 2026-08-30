import type { JsonValue } from "../../shared/json";
import type { PaneDaemonClient } from "./pane-daemon-client";

export interface PaneEventInput {
  readonly occurredAt: string;
  readonly kind: string;
  readonly data: Readonly<Record<string, JsonValue>>;
  /** Later events with the same key replace an unsent earlier one, so a turn diff that updates on every keystroke of the agent's work ships once per flush. */
  readonly coalesceKey?: string;
}

export interface PaneEventsReporterOptions {
  readonly client: Pick<PaneDaemonClient, "request">;
  readonly onFailure: (detail: string) => void;
  readonly flushAfterMs?: number;
  readonly maxBatch?: number;
}

const DEFAULT_FLUSH_MS = 300;
const MAX_BATCH = 200;

/** Ships what the pane watched its agent do to the daemon's event stream, batched. The report is best effort: the pane already shows everything it sends, so a lost batch costs the inspector a few rows and never blocks the pane. A failure is reported once rather than once per batch, because a daemon that is down says so on every flush. */
export class PaneEventsReporter {
  private pending: PaneEventInput[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;

  constructor(private readonly options: PaneEventsReporterOptions) {}

  record(event: PaneEventInput): void {
    if (this.closed) return;
    const at = Date.parse(event.occurredAt);
    const normalized = {
      ...event,
      occurredAt: Number.isFinite(at)
        ? new Date(at).toISOString()
        : new Date().toISOString(),
    };
    if (event.coalesceKey !== undefined) {
      const index = this.pending.findIndex(
        (pending) => pending.coalesceKey === event.coalesceKey,
      );
      if (index !== -1) {
        this.pending[index] = normalized;
        this.schedule();
        return;
      }
    }
    this.pending.push(normalized);
    this.schedule();
  }

  /** Sends whatever is pending now. Awaited by tests and on detach; ordinary operation lets the timer do it. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending.splice(0, this.options.maxBatch ?? MAX_BATCH);
    if (batch.length === 0) return await this.inFlight;
    this.inFlight = this.inFlight.then(() => this.send(batch));
    await this.inFlight;
    if (this.pending.length > 0) await this.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.flushAfterMs ?? DEFAULT_FLUSH_MS);
  }

  private async send(batch: readonly PaneEventInput[]): Promise<void> {
    try {
      const response = await this.options.client.request("/pane-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          events: batch.map(({ occurredAt, kind, data }) => ({
            occurredAt,
            kind,
            data,
          })),
        }),
      });
      if (!response.ok) {
        this.reportFailure(`pane events refused: HTTP ${response.status}`);
        return;
      }
      this.failed = false;
    } catch (error) {
      this.reportFailure(
        `pane events not delivered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private reportFailure(detail: string): void {
    if (this.failed) return;
    this.failed = true;
    this.options.onFailure(detail);
  }
}

import type { NormalizedProviderEvent } from "../../adapters/providers/protocol/types";
import { MAIL_LEASE_SECONDS } from "../../schemas/mail";
import type { PaneDaemonClient } from "./pane-daemon-client";

export const MAIL_LEASE_HEARTBEAT_INTERVAL_MS =
  (MAIL_LEASE_SECONDS * 1_000) / 3;

type Timer = ReturnType<typeof setTimeout>;

interface MailLeaseHeartbeatOptions {
  readonly client: Pick<PaneDaemonClient, "request" | "errorDetail">;
  readonly onError: (error: unknown) => void;
  readonly intervalMs?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => Timer;
  readonly cancel?: (timer: Timer) => void;
}

/** Extends leases while the provider owns an active turn. Lease ownership is
 * still decided by the broker: this only asks the daemon to renew leases the
 * authenticated pane already holds, and stops at every terminal turn event. */
export class MailLeaseHeartbeat {
  private readonly intervalMs: number;
  private readonly schedule: NonNullable<MailLeaseHeartbeatOptions["schedule"]>;
  private readonly cancel: NonNullable<MailLeaseHeartbeatOptions["cancel"]>;
  private active = false;
  private stopped = false;
  private timer: Timer | null = null;
  private cycle = 0;

  constructor(private readonly options: MailLeaseHeartbeatOptions) {
    this.intervalMs = options.intervalMs ?? MAIL_LEASE_HEARTBEAT_INTERVAL_MS;
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
  }

  observe(event: NormalizedProviderEvent): void {
    switch (event.kind) {
      case "turn-started":
        if (this.active || this.stopped) return;
        this.active = true;
        this.cycle += 1;
        void this.renewAndSchedule(this.cycle);
        return;
      case "turn-idle":
      case "turn-failed":
      case "interrupted":
      case "runtime-disconnected":
      case "run-ended":
        this.pause();
        return;
      default:
        return;
    }
  }

  stop(): void {
    this.stopped = true;
    this.pause();
  }

  private pause(): void {
    this.active = false;
    this.cycle += 1;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  private async renewAndSchedule(cycle: number): Promise<void> {
    if (!this.active || this.stopped || cycle !== this.cycle) return;
    try {
      const response = await this.options.client.request(
        "/mail/lease-heartbeat",
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(await this.options.client.errorDetail(response));
      }
    } catch (error) {
      this.options.onError(error);
    }
    if (!this.active || this.stopped || cycle !== this.cycle) return;
    this.timer = this.schedule(
      () => void this.renewAndSchedule(cycle),
      this.intervalMs,
    );
  }
}

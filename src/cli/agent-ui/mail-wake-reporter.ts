import type { FrontendWakeReport } from "../../schemas/mail-wake";
import { PaneDaemonClient } from "./pane-daemon-client";

/** Reports what this frontend did with a wake, so the daemon's ledger records a lifecycle instead of inferring one. The daemon can see that it announced mail and later that the mailbox was polled, but nothing in between: whether the frontend queued the wake, whether the provider accepted the submission, and whether a turn actually started are decisions only this process observes. Without them a wake that named an already-settled item cannot be told apart from one that was held across a turn, which is the question that costs an investigation every time it is asked. Reporting is deliberately one-way. The ledger writes only the transition a report proves and refuses anything it cannot evidence, so a lost report leaves a gap in the record and never a false entry. */
export interface MailWakeReporterOptions {
  readonly port: number;
  readonly subject: string;
  readonly fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export class MailWakeReporter {
  private readonly daemon: PaneDaemonClient;

  constructor(options: MailWakeReporterOptions) {
    this.daemon = new PaneDaemonClient(options);
  }

  async report(report: FrontendWakeReport): Promise<void> {
    const response = await this.daemon.request("/mail-wake/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    if (!response.ok) {
      throw new Error(
        `mail-wake report failed: ${response.status} ${await this.daemon.errorDetail(response)}`,
      );
    }
  }
}

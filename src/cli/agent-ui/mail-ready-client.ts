import {
  deriveWakeId,
  type MailReadyEvent,
  type MailReadyNotice,
  MailReadyResponseSchema,
} from "../../schemas/mail-wake";
import { decodeJson } from "../daemon-response";
import { PaneDaemonClient } from "./pane-daemon-client";

export interface MailReadyClientOptions {
  readonly port: number;
  readonly recipient: string;
  readonly fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

function newestPerLane(
  events: readonly MailReadyEvent[],
): readonly MailReadyEvent[] {
  const byLane = new Map<string, MailReadyEvent>();
  for (const event of events) byLane.set(event.lane, event);
  return [...byLane.values()].sort((a, b) => a.cursor - b.cursor);
}

/** Reads the daemon's mail-ready notifications for one recipient. Resumes from the notification cursor, never the mailbox sequence: settling one message can make an older one offerable with no new mail arriving, and that second announcement carries a mailbox sequence this client has usually already acknowledged. Resuming on it would step straight over the instruction now waiting. */
export class MailReadyClient {
  /** Where the next poll resumes, and null before the first one. A poll cannot resume "from now": that is evaluated per request and replays nothing, so a client that never names a cursor is handed an empty list forever and no mail ever reaches the pane. The first poll therefore asks for everything retained. */
  private cursor: number | null = null;

  private readonly daemon: PaneDaemonClient;

  constructor(private readonly options: MailReadyClientOptions) {
    this.daemon = new PaneDaemonClient({
      port: options.port,
      subject: options.recipient,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async poll(): Promise<readonly MailReadyNotice[]> {
    const catchingUp = this.cursor === null;
    const response = await this.daemon.request(
      `/mail-ready?sinceCursor=${String(this.cursor ?? 0)}`,
    );
    if (!response.ok) {
      throw new Error(
        `mail-ready poll failed: ${response.status} ${await this.daemon.errorDetail(response)}`,
      );
    }
    const events = MailReadyResponseSchema.parse(
      await decodeJson(response),
    ).events;
    for (const event of events) this.cursor = event.cursor;
    this.cursor ??= 0;
    const notices: MailReadyNotice[] = [];
    for (const event of catchingUp ? newestPerLane(events) : events) {
      notices.push({
        // Imported, never reimplemented: two hand-written derivations agree only by luck, and a divergent wake id silently breaks idempotency.
        wakeId: deriveWakeId(event.recipient, event.lane, event.oldestItemId),
        recipient: event.recipient,
        lane: event.lane,
        oldestItemId: event.oldestItemId,
        backlogCount: event.backlogCount,
        cursor: event.cursor,
        brokerSeq: event.brokerSeq,
      });
    }
    return notices;
  }

  /** Tells the daemon this frontend received one exact notification. Its
   * absence is what the no-live-frontend breach measures, so it says a live
   * frontend took the notification—not that the pane finished with the mail. */
  async acknowledge(notice: MailReadyNotice): Promise<void> {
    const response = await this.daemon.request("/mail-ready/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "mail-ready-ack",
        schemaVersion: 1,
        recipient: this.options.recipient,
        cursor: notice.cursor,
        brokerSeq: notice.brokerSeq,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `mail-ready ack failed: ${response.status} ${await this.daemon.errorDetail(response)}`,
      );
    }
  }
}

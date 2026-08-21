import { type FileHandle, open, readFile } from "node:fs/promises";
import { definedFields } from "../../shared/defined-fields";

export interface DraftSnapshot {
  readonly text: string;
  readonly attachments: readonly string[];
  readonly purpose?: "user" | "compaction";
}

/** `delivery_unknown` is the transport dying between submit and acknowledgement:
 * Hive cannot tell "never accepted" from "accepted, reply lost". It is terminal for a user row,
 * because replaying a prompt the agent may already be working on is interference of its own.
 * A person can retry it explicitly.
 * */
export type DeliveryState =
  "pending" | "submitted" | "observed" | "rejected" | "delivery_unknown";

export interface OutboundRow {
  readonly clientInputId: string;
  readonly text: string;
  readonly attachments: readonly string[];
  readonly purpose: "user" | "compaction";
  readonly createdAt: string;
  readonly state: DeliveryState;
  readonly turnId: string | null;
}

type JournalRecord =
  | {
      readonly op: "append";
      readonly clientInputId: string;
      readonly text: string;
      readonly attachments: readonly string[];
      readonly purpose?: "user" | "compaction";
      readonly at: string;
    }
  | {
      readonly op: "state";
      readonly clientInputId: string;
      readonly state: DeliveryState;
      readonly turnId: string | null;
    };

function applyRecord(
  rows: Map<string, OutboundRow>,
  record: JournalRecord,
): void {
  if (record.op === "append") {
    rows.set(record.clientInputId, {
      clientInputId: record.clientInputId,
      text: record.text,
      attachments: record.attachments,
      purpose: record.purpose ?? "user",
      createdAt: record.at,
      state: "pending",
      turnId: null,
    });
    return;
  }
  const existing = rows.get(record.clientInputId);
  if (existing === undefined) return;
  rows.set(record.clientInputId, {
    ...existing,
    state: record.state,
    turnId: record.turnId,
  });
}

/** An append-only log of what the person asked for, owned by the frontend and written before the composer clears. One writer, one file: the frontend uses it to restore visible prompts and reconcile interrupted submissions. */
export class OutboundJournal {
  private constructor(
    private readonly handle: FileHandle,
    private readonly rows: Map<string, OutboundRow>,
  ) {}

  static async open(path: string): Promise<OutboundJournal> {
    const rows = new Map<string, OutboundRow>();
    const existing = await readFile(path, "utf8").catch(() => "");
    for (const line of existing.split("\n")) {
      if (line.trim() === "") continue;
      applyRecord(rows, JSON.parse(line) as JournalRecord);
    }
    return new OutboundJournal(await open(path, "a"), rows);
  }

  async recoverInterrupted(): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.state === "pending") {
        await this.setState(row.clientInputId, "delivery_unknown");
      }
    }
  }

  private async write(record: JournalRecord): Promise<void> {
    await this.handle.write(`${JSON.stringify(record)}\n`);
    await this.handle.datasync();
  }

  async append(
    clientInputId: string,
    snapshot: DraftSnapshot,
    at: string,
  ): Promise<OutboundRow> {
    if (this.rows.has(clientInputId)) {
      throw new Error(`outbound row already exists: ${clientInputId}`);
    }
    const record: JournalRecord = {
      op: "append",
      clientInputId,
      text: snapshot.text,
      attachments: snapshot.attachments,
      ...definedFields({ purpose: snapshot.purpose }),
      at,
    };
    await this.write(record);
    applyRecord(this.rows, record);
    return this.require(clientInputId);
  }

  async setState(
    clientInputId: string,
    state: DeliveryState,
    turnId: string | null = null,
  ): Promise<OutboundRow> {
    const current = this.require(clientInputId);
    if (current.state === "delivery_unknown" && state !== "delivery_unknown") {
      throw new Error(
        `${clientInputId} is delivery-unknown; only a person may resolve it`,
      );
    }
    const record: JournalRecord = { op: "state", clientInputId, state, turnId };
    await this.write(record);
    applyRecord(this.rows, record);
    return this.require(clientInputId);
  }

  require(clientInputId: string): OutboundRow {
    const row = this.rows.get(clientInputId);
    if (row === undefined) {
      throw new Error(`no outbound row: ${clientInputId}`);
    }
    return row;
  }

  all(): readonly OutboundRow[] {
    return [...this.rows.values()];
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

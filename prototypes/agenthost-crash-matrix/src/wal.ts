import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SemanticEvent, WalRecord } from "./types";

export class WalOverflowError extends Error {}

function durableReplace(path: string, contents: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  const fd = openSync(temporary, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  fsyncSync(directory);
  closeSync(directory);
}

export class BoundedWal {
  readonly path: string;
  private records: WalRecord[];

  constructor(path: string, readonly maxBytes: number) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.records = this.loadAndRepair();
  }

  all(): readonly WalRecord[] {
    return this.records;
  }

  append(record: WalRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const existingBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    if (existingBytes + Buffer.byteLength(line) > this.maxBytes) this.compact();
    const compactedBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    if (compactedBytes + Buffer.byteLength(line) > this.maxBytes) {
      throw new WalOverflowError(`WAL bound ${this.maxBytes} bytes exhausted`);
    }
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.records.push(record);
  }

  highWaterMark(): number {
    let mark = 0;
    for (const record of this.records) {
      if (record.kind === "ACK") mark = Math.max(mark, record.highWaterMark);
    }
    return mark;
  }

  events(): SemanticEvent[] {
    return this.records
      .filter((record): record is Extract<WalRecord, { kind: "EVENT" }> => record.kind === "EVENT")
      .map((record) => record.event);
  }

  private compact(): void {
    const highWater = this.highWaterMark();
    const latest = new Map<string, WalRecord>();
    const unacknowledged: WalRecord[] = [];
    for (const record of this.records) {
      if (record.kind === "EVENT") {
        if (record.event.sequence > highWater) unacknowledged.push(record);
        continue;
      }
      const key = record.kind === "APPROVAL_WRITTEN"
        ? `${record.kind}:${record.approvalId}`
        : record.kind;
      latest.set(key, record);
    }
    const retained = [...latest.values(), ...unacknowledged].sort((left, right) =>
      left.at.localeCompare(right.at)
    );
    const contents = retained.map((record) => JSON.stringify(record)).join("\n") +
      (retained.length === 0 ? "" : "\n");
    if (Buffer.byteLength(contents) > this.maxBytes) {
      throw new WalOverflowError("unacknowledged semantic events exceed the WAL bound");
    }
    durableReplace(this.path, contents);
    this.records = retained;
  }

  private loadAndRepair(): WalRecord[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    const records: WalRecord[] = [];
    let validBytes = 0;
    for (const segment of raw.match(/.*(?:\n|$)/g) ?? []) {
      if (segment.length === 0) continue;
      const line = segment.trim();
      if (line.length === 0) {
        validBytes += Buffer.byteLength(segment);
        continue;
      }
      try {
        records.push(JSON.parse(line) as WalRecord);
        validBytes += Buffer.byteLength(segment);
      } catch {
        break;
      }
    }
    if (validBytes < Buffer.byteLength(raw)) truncateSync(this.path, validBytes);
    return records;
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}

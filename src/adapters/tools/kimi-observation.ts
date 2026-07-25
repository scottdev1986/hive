import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProviderEvent, ProviderRun } from "../../schemas";

const MAX_WIRE_BYTES = 256 * 1024;

export interface KimiObservation {
  events: readonly ProviderEvent[];
  through: string | null;
  completeness: "complete" | "gap" | "unknown";
}

interface SessionIndexRow {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function indexRow(value: unknown): SessionIndexRow | null {
  const row = record(value);
  return row !== null &&
    typeof row.sessionId === "string" &&
    typeof row.sessionDir === "string" &&
    typeof row.workDir === "string"
    ? {
        sessionId: row.sessionId,
        sessionDir: row.sessionDir,
        workDir: row.workDir,
      }
    : null;
}

function createdAtMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function boundSession(
  run: ProviderRun,
  worktreePath: string,
  kimiHome: string,
): Promise<SessionIndexRow | null> {
  let index: string;
  try {
    index = await readFile(join(kimiHome, "session_index.jsonl"), "utf8");
  } catch {
    return null;
  }
  const target = resolve(worktreePath);
  const rows = index
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return indexRow(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(
      (row): row is SessionIndexRow =>
        row !== null &&
        row.workDir === target &&
        (run.conversationId === null || row.sessionId === run.conversationId),
    );
  const matches: SessionIndexRow[] = [];
  for (const row of rows) {
    try {
      const state = record(
        JSON.parse(await readFile(join(row.sessionDir, "state.json"), "utf8")),
      );
      const created = createdAtMs(state?.createdAt);
      if (
        state?.workDir === target &&
        created !== null &&
        created >= Date.parse(run.startedAt)
      ) {
        matches.push(row);
      }
    } catch {
      // Invalid state is not binding evidence.
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function eventId(runId: string, path: string, offset: number, line: string) {
  return createHash("sha256")
    .update(`${runId}\0${path}\0${offset}\0${line}`)
    .digest("hex");
}

function observedAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function normalizeLine(
  run: ProviderRun,
  conversationId: string,
  path: string,
  offset: number,
  line: string,
): ProviderEvent | null | "invalid" {
  let parsed: Record<string, unknown>;
  try {
    const value = record(JSON.parse(line));
    if (value === null) return "invalid";
    parsed = value;
  } catch {
    return "invalid";
  }
  const at = observedAt(parsed.time);
  if (at === null) return null;
  let kind: ProviderEvent["kind"] | null = null;
  let toolName: string | null = null;
  let inputDigest: string | null = null;
  if (parsed.type === "turn.prompt") {
    const origin = record(parsed.origin);
    if (origin?.kind === "user") kind = "turn-started";
  } else if (parsed.type === "turn.cancel") {
    kind = "interrupted";
  } else if (parsed.type === "context.append_loop_event") {
    const event = record(parsed.event);
    if (event?.type === "tool.call") {
      kind = "tool-started";
      toolName = typeof event.name === "string" ? event.name : null;
      inputDigest = createHash("sha256")
        .update(JSON.stringify(event.args ?? null))
        .digest("hex");
    } else if (event?.type === "tool.result") {
      kind = "tool-finished";
    } else if (
      event?.type === "step.end" &&
      event.finishReason === "end_turn"
    ) {
      kind = "turn-idle";
    }
  }
  if (kind === null) return null;
  return {
    eventId: eventId(run.runId, path, offset, line),
    providerRunId: run.runId,
    provider: "kimi",
    capabilityEpoch: run.capabilityEpoch,
    conversationId,
    kind,
    occurredAt: at,
    toolName,
    inputDigest,
  };
}

export async function readKimiProviderEvents(
  run: ProviderRun,
  worktreePath: string,
  kimiHome: string,
): Promise<KimiObservation> {
  const session = await boundSession(run, worktreePath, kimiHome);
  if (session === null) {
    return { events: [], through: null, completeness: "unknown" };
  }
  const path = join(session.sessionDir, "agents", "main", "wire.jsonl");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const size = (await file.stat()).size;
    const start = Math.max(0, size - MAX_WIRE_BYTES);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    let offset = start;
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline < 0) {
        return { events: [], through: String(size), completeness: "gap" };
      }
      offset += Buffer.byteLength(text.slice(0, newline + 1));
      text = text.slice(newline + 1);
    }
    const events: ProviderEvent[] = [];
    for (const line of text.split("\n")) {
      if (line.length > 0) {
        const normalized = normalizeLine(
          run,
          session.sessionId,
          path,
          offset,
          line,
        );
        if (normalized === "invalid") {
          return { events: [], through: String(size), completeness: "unknown" };
        }
        if (normalized !== null) events.push(normalized);
      }
      offset += Buffer.byteLength(line) + 1;
    }
    return {
      events,
      through: String(size),
      completeness: start === 0 ? "complete" : "gap",
    };
  } catch {
    return { events: [], through: null, completeness: "unknown" };
  } finally {
    await file?.close();
  }
}

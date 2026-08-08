import { open } from "node:fs/promises";
import { isRecord } from "../../shared/is-record";
import { safeJsonParse } from "../../shared/json";
import type { AgentRecord } from "../../schemas/agent";
import type { HiveDatabase } from "../database/hive-database";

const TAIL_BYTES = 256 * 1024;

async function readFileTail(path: string): Promise<string | null> {
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const offset = Math.max(0, size - TAIL_BYTES);
      const length = size - offset;
      if (length === 0) return "";
      const { buffer, bytesRead } = await handle.read(
        Buffer.alloc(length),
        0,
        length,
        offset,
      );
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function parseJsonLines(tail: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of tail.split("\n")) {
    if (line.length === 0) continue;
    const value = safeJsonParse(line);
    if (value !== undefined) parsed.push(value);
  }
  return parsed;
}

export function lastCodexTurnCompleted(tail: string): boolean | null {
  const entries = parseJsonLines(tail);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      !isRecord(entry) ||
      entry.type !== "event_msg" ||
      !isRecord(entry.payload)
    )
      continue;
    if (entry.payload.type === "task_started") return false;
    if (entry.payload.type === "task_complete") return true;
  }
  return null;
}

export function lastGrokTurnCompleted(tail: string): boolean | null {
  const entries = parseJsonLines(tail);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || !isRecord(entry.params)) continue;
    const update = entry.params.update;
    if (!isRecord(update) || typeof update.sessionUpdate !== "string") continue;
    return update.sessionUpdate === "turn_completed";
  }
  return null;
}

export async function readNativeTurnCompleted(
  path: string,
  tool: "codex" | "grok",
): Promise<boolean | null> {
  const tail = await readFileTail(path);
  if (tail === null) return null;
  return tool === "codex"
    ? lastCodexTurnCompleted(tail)
    : lastGrokTurnCompleted(tail);
}

export interface GraphifyCallCursor {
  path: string;
  offset: number;
  count: number;
}

export function isGraphifyToolName(name: string): boolean {
  return (
    name.startsWith("graphify__") ||
    name.startsWith("graphify_") ||
    name.startsWith("mcp__graphify__") ||
    name === "hive__graph_locate" ||
    name === "mcp__hive__graph_locate" ||
    name === "hive_graph_locate"
  );
}

export function countGraphifyFromProviderEvents(
  db: HiveDatabase,
  agent: AgentRecord,
): number | null {
  const run = db.getActiveProviderRunForAgent(agent.id);
  if (run === null) return null;
  let count = 0;
  for (const event of db.listProviderEvents(run.runId)) {
    if (event.kind !== "tool-started") continue;
    if (event.toolName !== null && isGraphifyToolName(event.toolName)) {
      count += 1;
    }
  }
  return count;
}

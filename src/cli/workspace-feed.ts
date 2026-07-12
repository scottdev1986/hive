/**
 * `hive workspace-feed --port <n>` — the Workspace app's status wire.
 *
 * A long-lived child of the app that turns the daemon's `hive_status` into
 * NDJSON on stdout, one JSON object per line and nothing else:
 *
 *   {"v":1,"agents":[...],"autonomy":"sandboxed"}
 *                             the full AgentRecord array plus the daemon's
 *                             live autonomy dial (omitted when unreadable) —
 *                             on the first snapshot, on any change, and at
 *                             least every 5 s (heartbeat), so a silent wire is
 *                             distinguishable from an unchanged one.
 *   {"v":1,"error":"..."}     the daemon is unreachable — emitted once per
 *                             distinct failure, not per retry, so a dead
 *                             daemon does not scroll the app's log.
 *
 * Polling lives here, not in Swift, because this process already holds the
 * operator credential (0600 file) and the MCP client; the app just decodes
 * lines. The same loop doubles as the viewer lease: it registers workspace
 * presence with the daemon on start, renews it on every emit (≤5 s apart,
 * well inside the 15 s TTL), and surrenders it on SIGINT/SIGTERM/stdin close.
 * The app closing its end of the pipe is therefore enough to give the daemon
 * its external viewer windows back; a crashed app is covered by the TTL.
 *
 * The feed retries a dead daemon with backoff and exits non-zero only after
 * 30 s of continuous unreachability — a daemon restart mid-session must look
 * like a hiccup, not a teardown.
 */
import { randomUUID } from "node:crypto";
import type { AgentRecord } from "../schemas";
import { isAutonomy, type Autonomy } from "../config/autonomy";
import { fetchAgentStatus } from "./mcp";
import { operatorFetch } from "./credential";

export const FEED_VERSION = 1;
export const FEED_POLL_MS = 1_000;
export const FEED_HEARTBEAT_MS = 5_000;
export const FEED_RETRY_MAX_MS = 4_000;
export const FEED_GIVE_UP_MS = 30_000;

export interface WorkspaceFeedDeps {
  readonly fetchStatus?: (port: number) => Promise<AgentRecord[]>;
  /** Reads the daemon's live autonomy dial for the app's Agents menu. Errors
   * degrade to null (field omitted) — the menu goes unknown, the agent list
   * must not. */
  readonly fetchAutonomy?: (port: number) => Promise<Autonomy | null>;
  readonly setPresence?: (port: number, present: boolean) => Promise<void>;
  readonly write?: (line: string) => void;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

/** `GET /autonomy` with the operator credential: the live dial, or null when
 * the daemon predates the endpoint or has no control configured. */
async function getAutonomy(port: number): Promise<Autonomy | null> {
  const response = await operatorFetch(`http://127.0.0.1:${port}/autonomy`);
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as
    | { autonomy?: unknown }
    | null;
  return isAutonomy(body?.autonomy) ? body.autonomy : null;
}

/** Who this feed is. One id per feed process, so the daemon can tell our lease
 * from another workspace's: a second app shutting down must surrender only its
 * own, never ours. */
const FEED_OWNER = randomUUID();

/** `POST /workspace` with the operator credential: grant, renew, or surrender
 * the viewer lease. */
async function postPresence(port: number, present: boolean): Promise<void> {
  const response = await operatorFetch(`http://127.0.0.1:${port}/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ present, owner: FEED_OWNER }),
  });
  if (!response.ok) {
    throw new Error(`workspace presence registration failed: HTTP ${response.status}`);
  }
}

/** A sleep the shutdown signal can cut short, so SIGTERM never waits out a
 * backoff before the lease is surrendered. */
const abortableSleep = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });

export async function runWorkspaceFeed(
  port: number,
  deps: WorkspaceFeedDeps = {},
): Promise<number> {
  const fetchStatus = deps.fetchStatus ?? fetchAgentStatus;
  const fetchAutonomy = deps.fetchAutonomy ?? getAutonomy;
  const setPresence = deps.setPresence ?? postPresence;
  const write = deps.write ??
    ((line: string) => void process.stdout.write(`${line}\n`));
  const sleep = deps.sleep ?? abortableSleep;
  const now = deps.now ?? Date.now;
  const signal = deps.signal;

  let lastSnapshot: string | null = null;
  let lastEmitAt: number | null = null;
  let lastError: string | null = null;
  let unreachableSince: number | null = null;
  let retryMs = FEED_POLL_MS;
  let exitCode = 0;

  // Take the lease before the first poll, so the daemon stops opening external
  // viewers before the app has even rendered a pane. Best-effort: a daemon
  // that cannot be reached is the poll loop's problem to report.
  await setPresence(port, true).catch(() => undefined);

  while (signal?.aborted !== true) {
    try {
      const agents = await fetchStatus(port);
      // Autonomy rides the same snapshot line so the app's menu tracks the
      // dial. Best-effort by design: its failure must never take the agent
      // list down with it.
      const autonomy = await fetchAutonomy(port).catch(() => null);
      const snapshot = JSON.stringify({ agents, autonomy });
      const heartbeatDue = lastEmitAt === null ||
        now() - lastEmitAt >= FEED_HEARTBEAT_MS;
      // A recovery from an error state re-emits even an unchanged snapshot:
      // the last thing on the wire must never remain a stale error.
      if (snapshot !== lastSnapshot || heartbeatDue || lastError !== null) {
        write(JSON.stringify({
          v: FEED_VERSION,
          agents,
          ...(autonomy === null ? {} : { autonomy }),
        }));
        lastSnapshot = snapshot;
        lastEmitAt = now();
        // Every emit renews the lease; emits are at most 5 s apart on a
        // healthy wire, well inside the daemon's 15 s TTL.
        await setPresence(port, true).catch(() => undefined);
      }
      lastError = null;
      unreachableSince = null;
      retryMs = FEED_POLL_MS;
      await sleep(FEED_POLL_MS, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) {
        write(JSON.stringify({ v: FEED_VERSION, error: message }));
        lastError = message;
      }
      unreachableSince ??= now();
      if (now() - unreachableSince >= FEED_GIVE_UP_MS) {
        exitCode = 1;
        break;
      }
      retryMs = Math.min(retryMs * 2, FEED_RETRY_MAX_MS);
      await sleep(retryMs, signal);
    }
  }

  // Surrender the lease on the way out, whatever the reason; a daemon that is
  // already gone has nothing to surrender to.
  await setPresence(port, false).catch(() => undefined);
  return exitCode;
}

/** Process wiring for the hidden CLI command: SIGINT, SIGTERM, and the app
 * closing its end of stdin all stop the loop through one AbortController, so
 * every exit path surrenders the viewer lease. */
export async function runWorkspaceFeedCli(port: number): Promise<number> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.resume();
  process.stdin.on("end", stop);
  process.stdin.on("error", stop);
  try {
    return await runWorkspaceFeed(port, { signal: controller.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdin.off("end", stop);
    process.stdin.off("error", stop);
    // A resumed stdin holds the event loop open; without this the process
    // would finish the loop, surrender the lease, and then never exit.
    process.stdin.pause();
  }
}

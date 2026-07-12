/**
 * `hive workspace-feed --port <n>` — the Workspace app's status wire.
 *
 * A long-lived child of the app that turns the daemon's `hive_status` into
 * NDJSON on stdout, one JSON object per line and nothing else:
 *
 *   {"v":1,"agents":[...],"autonomy":"sandboxed","orchestrator":{"status":"working"}}
 *                             the full AgentRecord array, the daemon's live
 *                             autonomy dial (omitted when unreadable), and what
 *                             the root is doing (omitted when the daemon cannot
 *                             honestly say — the root has no AgentRecord, so it
 *                             travels beside the array, not inside it) — on the
 *                             first snapshot, on any change, and at least every
 *                             5 s (heartbeat), so a silent wire is
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
import type { OrchestratorStatus } from "../daemon/orchestrator-status";
import { fetchAgentStatus } from "./mcp";
import { operatorFetch } from "./credential";

export const FEED_VERSION = 1;
export const FEED_POLL_MS = 1_000;
export const FEED_HEARTBEAT_MS = 5_000;
export const FEED_RETRY_MAX_MS = 4_000;
export const FEED_GIVE_UP_MS = 30_000;
/** A status poll may not outlast the presence TTL: a hung request must become a
 * reported error, not a silent lapse. */
export const FEED_STATUS_TIMEOUT_MS = 5_000;

export interface WorkspaceFeedDeps {
  readonly fetchStatus?: (port: number) => Promise<AgentRecord[]>;
  /** Reads the daemon's live autonomy dial for the app's Agents menu. Errors
   * degrade to null (field omitted) — the menu goes unknown, the agent list
   * must not. */
  readonly fetchAutonomy?: (port: number) => Promise<Autonomy | null>;
  /** Reads what the root is doing, for the orchestrator pane's dot. Errors and
   * un-knowable states alike degrade to null (field omitted): the root's dot
   * goes gray/unknown, which is the truth, rather than a fabricated word. */
  readonly fetchOrchestrator?: (port: number) => Promise<OrchestratorStatus | null>;
  readonly setPresence?: (port: number, present: boolean) => Promise<void>;
  readonly write?: (line: string) => void;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  /** Overrides FEED_STATUS_TIMEOUT_MS; tests use a short one. */
  readonly statusTimeoutMs?: number;
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

/** `GET /orchestrator-status` with the operator credential: what the root is
 * doing, derived by the daemon from the root's own turn boundaries. Null when
 * it cannot be honestly known — the field is then omitted from the line, and
 * the app's dot stays gray (unknown). Errors degrade to null for the same
 * reason: a status we could not read is not a status we may invent. */
async function getOrchestratorStatus(
  port: number,
): Promise<OrchestratorStatus | null> {
  const response = await operatorFetch(
    `http://127.0.0.1:${port}/orchestrator-status`,
  );
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as
    | { status?: unknown }
    | null;
  return body?.status === "working" || body?.status === "idle"
    ? body.status
    : null;
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

/** Reject if the work has not finished in time. Its own timer, not the injected
 * `sleep`: a test that stubs sleep to a no-op must not thereby time out every
 * poll. The loser is defused so a slow-but-successful poll cannot reject later. */
function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`status poll timed out after ${milliseconds}ms`)),
      milliseconds,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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
  const fetchOrchestrator = deps.fetchOrchestrator ?? getOrchestratorStatus;
  const setPresence = deps.setPresence ?? postPresence;
  const write = deps.write ??
    ((line: string) => void process.stdout.write(`${line}\n`));
  const sleep = deps.sleep ?? abortableSleep;
  const now = deps.now ?? Date.now;
  const signal = deps.signal;
  const statusTimeoutMs = deps.statusTimeoutMs ?? FEED_STATUS_TIMEOUT_MS;

  let lastSnapshot: string | null = null;
  let lastEmitAt: number | null = null;
  let lastError: string | null = null;
  let lastRenewAt: number | null = null;
  let unreachableSince: number | null = null;
  let retryMs = FEED_POLL_MS;
  let exitCode = 0;

  while (signal?.aborted !== true) {
    try {
      // Renew BEFORE the poll and on our own clock, never as a reward for the
      // poll succeeding. The lease says "an app is attached", and it is: this
      // process lives exactly as long as the app's end of the pipe does.
      // Renewal used to ride on an emit, so a status poll that hung — and
      // `fetchStatus` had no timeout — left a live feed renewing nothing, the
      // lease lapsed after 15s, and the daemon opened Terminal windows over
      // live panes. That is the 2026-07-12 incident reached by a hang instead
      // of a kill.
      if (
        lastRenewAt === null || now() - lastRenewAt >= FEED_HEARTBEAT_MS
      ) {
        lastRenewAt = now();
        await setPresence(port, true).catch(() => undefined);
      }
      // And bound the poll, so a wedged daemon can never outlast the TTL: at
      // worst one timeout plus one backoff, still well inside it.
      const agents = await withTimeout(fetchStatus(port), statusTimeoutMs);
      // Autonomy rides the same snapshot line so the app's menu tracks the
      // dial. Best-effort by design: its failure must never take the agent
      // list down with it.
      const autonomy = await fetchAutonomy(port).catch(() => null);
      // The root's own status rides the same line. Best-effort like autonomy —
      // and omitted, never defaulted, when the daemon cannot honestly say: the
      // Workspace renders a missing status as unknown/gray, which is exactly
      // what it should show when nobody knows.
      const orchestrator = await fetchOrchestrator(port).catch(() => null);
      const snapshot = JSON.stringify({ agents, autonomy, orchestrator });
      const heartbeatDue = lastEmitAt === null ||
        now() - lastEmitAt >= FEED_HEARTBEAT_MS;
      // A recovery from an error state re-emits even an unchanged snapshot:
      // the last thing on the wire must never remain a stale error.
      if (snapshot !== lastSnapshot || heartbeatDue || lastError !== null) {
        write(JSON.stringify({
          v: FEED_VERSION,
          agents,
          ...(autonomy === null ? {} : { autonomy }),
          ...(orchestrator === null ? {} : { orchestrator: { status: orchestrator } }),
        }));
        lastSnapshot = snapshot;
        lastEmitAt = now();
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

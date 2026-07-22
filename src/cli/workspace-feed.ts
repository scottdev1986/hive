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
 * lines.
 *
 * The feed retries a dead daemon with backoff and exits non-zero only after
 * 30 s of continuous unreachability — a daemon restart mid-session must look
 * like a hiccup, not a teardown.
 */
import type { AgentRecord } from "../schemas";
import { isAutonomy, type Autonomy } from "../config/autonomy";
import type { OrchestratorStatus } from "../daemon/orchestrator-status";
import {
  RootSessiondLocatorSchema,
  type OrchestratorHostKind,
  type RootSessiondLocator,
} from "../daemon/orchestrator-host";
import type { OrchestratorSessiondSnapshot } from "../daemon/orchestrator-sessiond";
import { macProcessIdentity } from "../daemon/lifecycle";
import {
  WorkspaceVisibilityInventoryInputSchema,
  type WorkspaceVisibilityInventoryInput,
} from "../daemon/session-host/workspace-visibility";
import { fetchAgentStatus } from "./mcp";
import { operatorFetch } from "./credential";

export const FEED_VERSION = 1;
export const FEED_POLL_MS = 1_000;
export const FEED_HEARTBEAT_MS = 5_000;
export const FEED_RETRY_MAX_MS = 4_000;
export const FEED_GIVE_UP_MS = 30_000;
/** A hung status request must become a reported error, not a silent lapse. */
export const FEED_STATUS_TIMEOUT_MS = 5_000;
/** Bounds one visibility publish. sessiond expires a visibility lease after
 * `visibility_expiry_ms` (15 s) and then terminates the host, so an unbounded
 * publish is a fleet-wide kill switch: on 2026-07-21 one stalled publish froze
 * renewal for every pane and sessiond terminated all five hosts 4 s after the
 * common deadline (docs/incidents/2026-07-21-fleet-visibility-expiry.md).
 * At 5 s a stall costs one renewal, leaving two further attempts inside the
 * lease. */
export const FEED_VISIBILITY_PUBLISH_TIMEOUT_MS = 5_000;
/** A publish slower than this is reported while it is still only a warning.
 * The incident had no latency signal at all, so a stall was only visible
 * afterwards, as a gap between recorded lease deadlines. */
export const FEED_VISIBILITY_PUBLISH_SLOW_MS = 1_000;

export interface WorkspaceOrchestratorSnapshot {
  readonly status: OrchestratorStatus | null;
  readonly host: OrchestratorHostKind;
  readonly hostState: OrchestratorSessiondSnapshot["state"] | null;
  readonly sessionLocator: RootSessiondLocator | null;
}

export interface WorkspaceFeedDeps {
  readonly fetchStatus?: (port: number) => Promise<AgentRecord[]>;
  /** Reads the daemon's live autonomy dial for the app's Agents menu. Errors
   * degrade to null (field omitted) — the menu goes unknown, the agent list
   * must not. */
  readonly fetchAutonomy?: (port: number) => Promise<Autonomy | null>;
  /** Reads the root's independent turn status and terminal lifecycle. Errors
   * degrade to null; an unknowable turn can still carry a sessiond locator. */
  readonly fetchOrchestrator?: (
    port: number,
  ) => Promise<WorkspaceOrchestratorSnapshot | null>;
  readonly write?: (line: string) => void;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  /** Overrides FEED_STATUS_TIMEOUT_MS; tests use a short one. */
  readonly statusTimeoutMs?: number;
}

export interface WorkspaceVisibilityPublishDeps {
  readonly observeProcess?: (pid: number) => Readonly<{ startToken: string }>;
  readonly post?: typeof operatorFetch;
  /** Overrides FEED_VISIBILITY_PUBLISH_TIMEOUT_MS; tests use a short one. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

class WorkspaceVisibilityPublishError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    readonly detail: string,
  ) {
    super(`workspace visibility publish failed: ${detail}`);
  }
}

/** A publish that never came back inside the bound. Distinct from a rejection:
 * nothing is known about whether the daemon applied it. */
export class WorkspaceVisibilityPublishTimeoutError extends Error {
  constructor(readonly milliseconds: number) {
    super(`workspace visibility publish timed out after ${milliseconds}ms`);
  }
}

/** Publishes exactly one Workspace-authored full inventory with the feed's
 * operator credential. The daemon independently re-reads the same PID/token.
 *
 * Bounded: the request carries an AbortSignal and is raced against its own
 * timer, so a `post` that ignores the signal still cannot hang the caller.
 * Resolves with how long the attempt took, so a stall is measurable live
 * rather than only reconstructable from lease deadlines afterwards. */
export async function publishWorkspaceVisibility(
  port: number,
  workspaceSessionId: string,
  workspacePid: number,
  inventory: WorkspaceVisibilityInventoryInput,
  deps: WorkspaceVisibilityPublishDeps = {},
): Promise<{ durationMs: number }> {
  const parsed = WorkspaceVisibilityInventoryInputSchema.parse(inventory);
  const processIdentity = (deps.observeProcess ?? macProcessIdentity)(workspacePid);
  const timeoutMs = deps.timeoutMs ?? FEED_VISIBILITY_PUBLISH_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting. `abort()` runs its listeners synchronously, so
      // aborting first lets the request's own AbortError win the race and the
      // operator sees "aborted" instead of the measured duration — which is
      // precisely the signal 2026-07-21 lacked.
      reject(new WorkspaceVisibilityPublishTimeoutError(timeoutMs));
      controller.abort();
    }, timeoutMs);
  });
  let response: Response;
  let body: { error?: unknown; diagnostic?: unknown; reason?: unknown } | null;
  try {
    [response, body] = await Promise.race([
      (async () => {
        const response = await (deps.post ?? operatorFetch)(
          `http://127.0.0.1:${port}/workspace-visibility`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              ...parsed,
              source: {
                sessionId: workspaceSessionId,
                process: {
                  processId: workspacePid,
                  startToken: processIdentity.startToken,
                },
              },
            }),
          },
        );
        const body = response.ok
          ? null
          : await response.json().catch(() => null) as
            | { error?: unknown; diagnostic?: unknown; reason?: unknown }
            | null;
        return [response, body] as const;
      })(),
      expiry,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (response.ok) return { durationMs: now() - startedAt };
  const detail = typeof body?.diagnostic === "string"
    ? body.diagnostic
    : typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
  throw new WorkspaceVisibilityPublishError(
    response.status,
    typeof body?.reason === "string" ? body.reason : null,
    detail,
  );
}

/** Publishes Workspace inventories at most one at a time, newest wins.
 *
 * Each inventory is a *full* snapshot, so a queued one is worthless the moment
 * a newer one arrives: only the latest is kept and the rest are dropped. The
 * at-most-one-in-flight rule is load-bearing and predates this — concurrent
 * publishes race the daemon's revision check and produce the 409 loop of #48 —
 * but chaining every publication onto the previous one (fde93610) made a
 * single hung request block renewal for the whole fleet indefinitely (#98).
 * Superseding keeps the serialization without the queue.
 *
 * A competing live Workspace source cannot be displaced safely, so one
 * recorded conflict halts this child rather than continuously retrying the
 * same rejected ownership claim. */
export class WorkspaceVisibilityPublisher {
  private inFlight: Promise<void> | null = null;
  private pending: WorkspaceVisibilityInventoryInput | null = null;
  private halted = false;

  constructor(
    private readonly publish: (
      inventory: WorkspaceVisibilityInventoryInput,
    ) => Promise<{ durationMs: number }>,
    private readonly write: (line: string) => void,
    private readonly slowMs: number = FEED_VISIBILITY_PUBLISH_SLOW_MS,
  ) {}

  publishLine(line: Uint8Array): void {
    if (line.byteLength === 0 || this.halted) return;
    try {
      this.pending = WorkspaceVisibilityInventoryInputSchema.parse(
        JSON.parse(Buffer.from(line).toString("utf8")),
      );
    } catch (error: unknown) {
      this.report(error);
      return;
    }
    this.pump();
  }

  private pump(): void {
    if (this.inFlight !== null || this.halted) return;
    const inventory = this.pending;
    if (inventory === null) return;
    this.pending = null;
    const run = this.runOne(inventory).catch((error: unknown) => {
      this.report(error);
    }).then(() => {
      this.inFlight = null;
      this.pump();
    });
    this.inFlight = run;
  }

  private async runOne(inventory: WorkspaceVisibilityInventoryInput): Promise<void> {
    try {
      const { durationMs } = await this.publish(inventory);
      if (durationMs >= this.slowMs) {
        this.write(JSON.stringify({
          v: FEED_VERSION,
          error: `workspace visibility publish was slow: ${durationMs}ms ` +
            `for revision ${inventory.inventoryRevision}`,
        }));
      }
    } catch (error) {
      if (
        error instanceof WorkspaceVisibilityPublishError &&
        error.status === 409 && error.reason === "source-identity-mismatch"
      ) {
        this.halted = true;
        this.pending = null;
        throw new Error(
          `workspace visibility publish halted [${error.reason}]: ${error.detail}`,
        );
      }
      throw error;
    }
  }

  private report(error: unknown): void {
    this.write(JSON.stringify({
      v: FEED_VERSION,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  async flush(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
  }
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

/** `GET /orchestrator-status` with the operator credential: independently
 * measured root turn state and terminal lifecycle. A null turn status stays
 * null; a pending sessiond locator must still reach Workspace for admission. */
async function getOrchestratorStatus(
  port: number,
): Promise<WorkspaceOrchestratorSnapshot | null> {
  const response = await operatorFetch(
    `http://127.0.0.1:${port}/orchestrator-status`,
  );
  if (!response.ok) return null;
  return parseWorkspaceOrchestratorSnapshot(
    await response.json().catch(() => null),
  );
}

/** The root's turn status and terminal lifecycle are independent. In
 * particular, a fresh sessiond root has a pending locator before it has any
 * turn boundary. Preserve that locator so Workspace can publish visibility;
 * dropping the whole object on a null status deadlocks host creation. */
export function parseWorkspaceOrchestratorSnapshot(
  value: unknown,
): WorkspaceOrchestratorSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const status = parseOrchestratorStatus(body.status);
  const host = body.host === "sessiond" ? "sessiond"
    : body.host === "tmux" ? "tmux"
    : null;
  const hostState = body.hostState === "awaiting-visibility" ||
      body.hostState === "running" || body.hostState === "exited" ||
      body.hostState === "failed"
    ? body.hostState
    : null;
  const locator = RootSessiondLocatorSchema.safeParse(body.sessionLocator);
  const sessionLocator = locator.success ? locator.data : null;
  if (host === null || (status === null && sessionLocator === null)) return null;
  return { status, host, hostState, sessionLocator };
}

/** Keep the feed and daemon lifecycle vocabularies identical. Dropping a
 * valid word here turns measured state into a gray `unknown` header. */
export function parseOrchestratorStatus(
  value: unknown,
): OrchestratorStatus | null {
  return value === "spawning" || value === "working" || value === "idle" ||
      value === "exited"
    ? value
    : null;
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

/** A sleep the shutdown signal can cut short. */
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
  const write = deps.write ??
    ((line: string) => void process.stdout.write(`${line}\n`));
  const sleep = deps.sleep ?? abortableSleep;
  const now = deps.now ?? Date.now;
  const signal = deps.signal;
  const statusTimeoutMs = deps.statusTimeoutMs ?? FEED_STATUS_TIMEOUT_MS;

  let lastSnapshot: string | null = null;
  let lastEmitAt: number | null = null;
  let lastError: string | null = null;
  let unreachableSince: number | null = null;
  let retryMs = FEED_POLL_MS;
  let exitCode = 0;

  while (signal?.aborted !== true) {
    try {
      const agents = await withTimeout(fetchStatus(port), statusTimeoutMs);
      // Autonomy rides the same snapshot line so the app's menu tracks the
      // dial. Best-effort by design: its failure must never take the agent
      // list down with it.
      const autonomy = await fetchAutonomy(port).catch(() => null);
      // Root turn status and terminal lifecycle ride the same line. Best-effort
      // like autonomy: no turn evidence stays null, while an independently
      // measured pending locator still reaches Workspace for visibility.
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
          ...(orchestrator === null ? {} : { orchestrator }),
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

  return exitCode;
}

/** Process wiring for the hidden CLI command: SIGINT, SIGTERM, and the app
 * closing its end of stdin all stop the loop through one AbortController, so
 * every exit path stops cleanly. */
export async function runWorkspaceFeedCli(
  port: number,
  workspaceSessionId: string,
): Promise<number> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  // Capture the launching Workspace once. If it dies, this child may be
  // reparented; a later process.ppid must never become a new visibility source.
  const workspacePid = process.ppid;
  let input = Buffer.alloc(0);
  const publisher = new WorkspaceVisibilityPublisher(
    (inventory) =>
      publishWorkspaceVisibility(port, workspaceSessionId, workspacePid, inventory),
    (line) => void process.stdout.write(`${line}\n`),
  );
  const publishLine = (line: Uint8Array): void => {
    publisher.publishLine(line);
  };
  const consumeInput = (chunk: Buffer | string): void => {
    input = Buffer.concat([input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    let newline = input.indexOf(0x0a);
    while (newline >= 0) {
      publishLine(input.subarray(0, newline));
      input = input.subarray(newline + 1);
      newline = input.indexOf(0x0a);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.resume();
  process.stdin.on("data", consumeInput);
  process.stdin.on("end", stop);
  process.stdin.on("error", stop);
  try {
    return await runWorkspaceFeed(port, { signal: controller.signal });
  } finally {
    if (input.byteLength > 0) publishLine(input);
    await publisher.flush();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdin.off("data", consumeInput);
    process.stdin.off("end", stop);
    process.stdin.off("error", stop);
    // A resumed stdin holds the event loop open; without this the process
    // would finish the loop and then never exit.
    process.stdin.pause();
  }
}

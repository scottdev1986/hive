/** `hive workspace-feed --port <n>` — the Workspace app's status wire. A long-lived child of the app that turns the daemon's `hive_status` into NDJSON on stdout, one JSON object per line and nothing else: {"v":1,"agents":[...],"autonomyState":{"kind":"current","value":"sandboxed"},"orchestrator":{"name":"queen","status":"working","tool":"codex","model":"gpt-5.6-sol"}} the full AgentRecord array, the daemon's typed autonomy observation, and what the root is doing (omitted when the daemon cannot honestly say — the root has no AgentRecord, so it travels beside the array, not inside it) — on the first snapshot, on any change, and at least every 5 s (heartbeat), so a silent wire is distinguishable from an unchanged one. {"v":1,"error":"..."} the daemon is unreachable — emitted once per distinct failure, not per retry, so a dead daemon does not scroll the app's log. {"v":1,"stale":true, the feed is giving up and exiting, so whatever the "reason":"..."} reader is still showing is now unproven. NO READER DECODES THIS YET: the app infers staleness from the stream ending, which cannot distinguish a feed that quit from one that never started. Emitting it regardless keeps the wire self-reporting and is what a reader needs in order to stop rendering a dead roster confidently. Polling lives here, not in Swift, because this process already holds the user credential (0600 file) and the MCP client; the app just decodes lines. The feed retries a dead daemon with backoff and exits non-zero only after 30 s of continuous refusal — a daemon restart mid-session must look like a hiccup, not a teardown. Only a refusal counts toward that deadline. A daemon that answers late is not a dead one: the status timeout climbs toward `FEED_STATUS_TIMEOUT_MAX_MS` while replies keep arriving too slowly, and those waits are charged to no deadline, because a feed that quits on a healthy-but-slow daemon leaves the app showing a roster that is wrong and looks right. */

import type { Autonomy } from "../config/autonomy";
import {
  macProcessIdentity,
  verifyDaemonInstance,
} from "../daemon/lifecycle/daemon-lifecycle";
import {
  type OrchestratorHostStatus,
  OrchestratorHostStatusSchema,
} from "../daemon/orchestrator-host/orchestrator-host-contract";
import {
  type WorkspaceVisibilityInventoryInput,
  WorkspaceVisibilityInventoryInputSchema,
} from "../daemon/session-host/workspace-visibility";
import type { AgentRecord } from "../schemas/agent";
import { AutonomyEnvelopeSchema } from "../schemas/config-schema";
import { systemNow } from "../shared/clock";
import { errorMessage } from "../shared/error-message";
import { abortableSleep } from "../shared/sleep";
import { daemonErrorDetail, decodeJson } from "./daemon-response";
import { HiveMcpSession, readAgentStatus } from "./mcp";
import { UserDaemonClient } from "./user-daemon-client";
import {
  presentWorkspaceAgent,
  presentWorkspaceOrchestrator,
} from "./workspace-feed-presentation";

export const FEED_VERSION = 1;
export const FEED_POLL_MS = 1_000;
export const FEED_HEARTBEAT_MS = 5_000;
export const FEED_RETRY_MAX_MS = 4_000;
export const FEED_GIVE_UP_MS = 30_000;
export const FEED_STATUS_TIMEOUT_MS = 5_000;
/** The ceiling the status timeout may climb to while the daemon answers late. A daemon whose answer simply costs more than the opening budget is still answering, and refusing to wait for it forever is what turns a slow daemon into an unreadable one. Being smaller than `FEED_GIVE_UP_MS` is not what keeps this safe, and reading it that way is a trap: the outage deadline accumulates across attempts, so a ladder of waits each individually under it still sums past it. What keeps the two apart is that a timeout does not touch the outage clock at all. */
export const FEED_STATUS_TIMEOUT_MAX_MS = 20_000;
/** Bounds one visibility publish. sessiond expires a visibility lease after `visibility_expiry_ms` (15 s) and then terminates the host, so an unbounded publish can freeze renewal for every pane until sessiond terminates their hosts at the common deadline. At 5 s a stall costs one renewal, leaving two further attempts inside the lease. */
export const FEED_VISIBILITY_PUBLISH_TIMEOUT_MS = 5_000;
/** Report a slow publish before it becomes a missed lease renewal. */
export const FEED_VISIBILITY_PUBLISH_SLOW_MS = 1_000;

export type WorkspaceOrchestratorSnapshot = OrchestratorHostStatus;

export type WorkspaceAutonomyState =
  | { readonly kind: "current"; readonly value: Autonomy }
  | { readonly kind: "absent" }
  | {
      readonly kind: "refused";
      readonly statusCode: number;
      readonly reason: string;
    }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly value: string }
  | { readonly kind: "unreachable"; readonly reason: string };

export interface WorkspaceFeedDeps {
  readonly verifyInstance?: (port: number) => Promise<void>;
  readonly fetchStatus?: (port: number) => Promise<AgentRecord[]>;
  /** Reads the daemon's live autonomy dial without letting its faults take down the agent list. */
  readonly fetchAutonomy?: (port: number) => Promise<WorkspaceAutonomyState>;
  /** Reads the root's independently measured identity, turn status, and terminal lifecycle. Errors degrade to null. */
  readonly fetchOrchestrator?: (
    port: number,
  ) => Promise<WorkspaceOrchestratorSnapshot | null>;
  readonly write?: (line: string) => void;
  readonly sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly statusTimeoutMs?: number;
}

export interface WorkspaceVisibilityPublishDeps {
  readonly observeProcess?: (pid: number) => Readonly<{ startToken: string }>;
  readonly post?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export async function registerWorkspaceOwner(
  port: number,
  workspaceSessionId: string,
  workspacePid: number,
  deps: WorkspaceVisibilityPublishDeps = {},
): Promise<void> {
  const processIdentity = (deps.observeProcess ?? macProcessIdentity)(
    workspacePid,
  );
  const client = new UserDaemonClient({
    port,
    ...(deps.post === undefined ? {} : { fetch: deps.post }),
    verifyIdentity: deps.post === undefined,
  });
  const response = await client.request("/workspace-owner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(
      deps.timeoutMs ?? FEED_VISIBILITY_PUBLISH_TIMEOUT_MS,
    ),
    body: JSON.stringify({
      sessionId: workspaceSessionId,
      process: {
        processId: workspacePid,
        startToken: processIdentity.startToken,
      },
    }),
  });
  if (response.ok) return;
  const detail = daemonErrorDetail(
    await decodeJson(response),
    `HTTP ${response.status}`,
  );
  throw new Error(`workspace owner registration failed: ${detail.message}`);
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

/** A publish that never came back inside the bound. Distinct from a rejection: nothing is known about whether the daemon applied it. */
export class WorkspaceVisibilityPublishTimeoutError extends Error {
  constructor(readonly milliseconds: number) {
    super(`workspace visibility publish timed out after ${milliseconds}ms`);
  }
}

/** Publishes exactly one Workspace-authored full inventory with the feed's user credential. The daemon independently re-reads the same PID/token. Bounded: the request carries an AbortSignal and is raced against its own timer, so a `post` that ignores the signal still cannot hang the caller. Resolves with how long the attempt took, so a stall is measurable live rather than only reconstructable from lease deadlines afterwards. */
export async function publishWorkspaceVisibility(
  port: number,
  workspaceSessionId: string,
  workspacePid: number,
  inventory: WorkspaceVisibilityInventoryInput,
  deps: WorkspaceVisibilityPublishDeps = {},
): Promise<{ durationMs: number }> {
  const parsed = WorkspaceVisibilityInventoryInputSchema.parse(inventory);
  const processIdentity = (deps.observeProcess ?? macProcessIdentity)(
    workspacePid,
  );
  const timeoutMs = deps.timeoutMs ?? FEED_VISIBILITY_PUBLISH_TIMEOUT_MS;
  const now = deps.now ?? systemNow;
  const startedAt = now();
  const controller = new AbortController();
  const client = new UserDaemonClient({
    port,
    ...(deps.post === undefined ? {} : { fetch: deps.post }),
    verifyIdentity: deps.post === undefined,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting. `abort()` runs its listeners synchronously, so aborting first lets the request's own AbortError win the race and the user sees "aborted" instead of the measured duration.
      reject(new WorkspaceVisibilityPublishTimeoutError(timeoutMs));
      controller.abort();
    }, timeoutMs);
  });
  let response: Response;
  let body: unknown;
  try {
    [response, body] = await Promise.race([
      (async () => {
        const response = await client.request("/workspace-visibility", {
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
        });
        const body = response.ok ? null : await decodeJson(response);
        return [response, body] as const;
      })(),
      expiry,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (response.ok) return { durationMs: now() - startedAt };
  const detail = daemonErrorDetail(body, `HTTP ${response.status}`);
  throw new WorkspaceVisibilityPublishError(
    response.status,
    detail.reason ?? null,
    detail.message,
  );
}

/** Publishes Workspace inventories at most one at a time, newest wins. Each inventory is a *full* snapshot, so a queued one is worthless the moment a newer one arrives: only the latest is kept and the rest are dropped. The at-most-one-in-flight rule is load-bearing: concurrent publishes race the daemon's revision check and loop on conflicts, while chaining every publication lets one hung request block fleet renewal indefinitely. Superseding keeps serialization without the queue. A competing live Workspace source cannot be displaced safely, so one recorded conflict halts this child rather than continuously retrying the same rejected ownership claim. */
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
    const run = this.runOne(inventory)
      .catch((error: unknown) => {
        this.report(error);
      })
      .then(() => {
        this.inFlight = null;
        this.pump();
      });
    this.inFlight = run;
  }

  private async runOne(
    inventory: WorkspaceVisibilityInventoryInput,
  ): Promise<void> {
    try {
      const { durationMs } = await this.publish(inventory);
      if (durationMs >= this.slowMs) {
        this.write(
          JSON.stringify({
            v: FEED_VERSION,
            error:
              `workspace visibility publish was slow: ${durationMs}ms ` +
              `for revision ${inventory.inventoryRevision}`,
          }),
        );
      }
    } catch (error) {
      if (
        error instanceof WorkspaceVisibilityPublishError &&
        error.status === 409 &&
        error.reason === "source-identity-mismatch"
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
    this.write(
      JSON.stringify({
        v: FEED_VERSION,
        error: errorMessage(error),
      }),
    );
  }

  async flush(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
  }
}

export function classifyWorkspaceAutonomyResponse(
  statusCode: number,
  body: unknown,
): WorkspaceAutonomyState {
  if (statusCode < 200 || statusCode >= 300) {
    return {
      kind: "refused",
      statusCode,
      reason: daemonErrorDetail(body, `HTTP ${statusCode}`).message,
    };
  }
  const parsed = AutonomyEnvelopeSchema.safeParse(body);
  if (parsed.success) return { kind: "current", value: parsed.data.autonomy };
  if (typeof body === "object" && body !== null && "autonomy" in body) {
    const value = (body as { readonly autonomy?: unknown }).autonomy;
    if (value === null) return { kind: "absent" };
    if (typeof value === "string") {
      return { kind: "unsupported", value };
    }
  }
  return { kind: "malformed", reason: parsed.error.message };
}

/** Reads the autonomy dial without collapsing daemon absence, refusal, or protocol drift into one value. */
async function getAutonomy(
  daemon: UserDaemonClient,
): Promise<WorkspaceAutonomyState> {
  const response = await daemon.request("/autonomy");
  return classifyWorkspaceAutonomyResponse(
    response.status,
    await decodeJson(response),
  );
}

/** `GET /orchestrator-status` with the user credential: independently measured root identity, turn state, and terminal lifecycle. */
async function getOrchestratorStatus(
  daemon: UserDaemonClient,
): Promise<WorkspaceOrchestratorSnapshot | null> {
  const body = await daemon.json(
    "/orchestrator-status",
    undefined,
    "return-null",
  );
  return parseWorkspaceOrchestratorSnapshot(body);
}

/** Root provider identity, turn status, and terminal lifecycle are independent. Preserve whichever measurements exist and report nothing when all three are absent. */
export function parseWorkspaceOrchestratorSnapshot(
  value: unknown,
): WorkspaceOrchestratorSnapshot | null {
  const parsed = OrchestratorHostStatusSchema.safeParse(value);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  return snapshot.status === null &&
    snapshot.tool == null &&
    snapshot.model == null &&
    snapshot.sessionLocator === null
    ? null
    : snapshot;
}

/** A poll that outran its budget, as opposed to one the daemon refused. The two are different faults with different remedies: a refusal means there is nothing to talk to, while a timeout means the answer exists and was not waited for. Only the second is worth retrying with more patience. */
export class StatusPollTimeoutError extends Error {
  constructor(readonly milliseconds: number) {
    super(`status poll timed out after ${milliseconds}ms`);
    this.name = "StatusPollTimeoutError";
  }
}

/** Reject if the work has not finished in time. Its own timer, not the injected `sleep`: a test that stubs sleep to a no-op must not thereby time out every poll. The loser is defused so a slow-but-successful poll cannot reject later. */
function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StatusPollTimeoutError(milliseconds)),
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

export async function runWorkspaceFeed(
  port: number,
  deps: WorkspaceFeedDeps = {},
): Promise<number> {
  const verifyInstance = deps.verifyInstance ?? (async () => {});
  // One MCP session and one HTTP client for the whole run. The daemon has no channel to announce a roster change, so this stays a poll — but a poll must not rebuild what it reads through: the session is opened once and reconnects only when the daemon it was opened against goes away, and the HTTP client verifies the instance once rather than ahead of every read. The per-tick instance check below is unaffected, so a daemon swap is still caught within one poll.
  const session = new HiveMcpSession(port);
  const daemon = new UserDaemonClient({ port });
  const fetchStatus: (port: number) => Promise<AgentRecord[]> =
    deps.fetchStatus ?? (() => readAgentStatus(session));
  const fetchAutonomy: (port: number) => Promise<WorkspaceAutonomyState> =
    deps.fetchAutonomy ?? (() => getAutonomy(daemon));
  const fetchOrchestrator: (
    port: number,
  ) => Promise<WorkspaceOrchestratorSnapshot | null> =
    deps.fetchOrchestrator ?? (() => getOrchestratorStatus(daemon));
  const write =
    deps.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const sleep = deps.sleep ?? abortableSleep;
  const now = deps.now ?? systemNow;
  const signal = deps.signal;
  const statusTimeoutMs = deps.statusTimeoutMs ?? FEED_STATUS_TIMEOUT_MS;

  let lastSnapshot: string | null = null;
  let lastEmitAt: number | null = null;
  let lastError: string | null = null;
  let unreachableSince: number | null = null;
  let retryMs = FEED_POLL_MS;
  let exitCode = 0;
  let statusTimeout = statusTimeoutMs;

  try {
    while (signal?.aborted !== true) {
      try {
        await withTimeout(verifyInstance(port), statusTimeoutMs);
        const agents = await withTimeout(fetchStatus(port), statusTimeout);
        // Autonomy rides the same snapshot line as a typed observation. Its own failure is data, never a reason to drop the agent list.
        const autonomyState = await fetchAutonomy(port).catch(
          (error: unknown): WorkspaceAutonomyState => ({
            kind: "unreachable",
            reason: errorMessage(error),
          }),
        );
        // Root turn status and terminal lifecycle ride the same line. Best-effort like autonomy: no turn evidence stays null, while an independently measured ready locator still reaches Workspace before the first turn.
        const orchestrator = await fetchOrchestrator(port).catch(() => null);
        const presentedAgents = agents.map((agent) => ({
          ...agent,
          presentation: presentWorkspaceAgent(agent),
        }));
        const presentedOrchestrator =
          orchestrator === null
            ? null
            : {
                ...orchestrator,
                presentation: presentWorkspaceOrchestrator(orchestrator),
              };
        const snapshot = JSON.stringify({
          agents: presentedAgents,
          autonomyState,
          orchestrator: presentedOrchestrator,
        });
        const heartbeatDue =
          lastEmitAt === null || now() - lastEmitAt >= FEED_HEARTBEAT_MS;
        // A recovery from an error state re-emits even an unchanged snapshot: the last thing on the wire must never remain a stale error.
        if (snapshot !== lastSnapshot || heartbeatDue || lastError !== null) {
          write(
            JSON.stringify({
              v: FEED_VERSION,
              agents: presentedAgents,
              autonomyState,
              ...(presentedOrchestrator === null
                ? {}
                : { orchestrator: presentedOrchestrator }),
            }),
          );
          lastSnapshot = snapshot;
          lastEmitAt = now();
        }
        lastError = null;
        unreachableSince = null;
        retryMs = FEED_POLL_MS;
        statusTimeout = statusTimeoutMs;
        await sleep(FEED_POLL_MS, signal);
      } catch (error) {
        const message = errorMessage(error);
        if (message !== lastError) {
          write(JSON.stringify({ v: FEED_VERSION, error: message }));
          lastError = message;
        }
        if (error instanceof StatusPollTimeoutError) {
          // Two clocks, and they must stay separate. This one bounds a single call; the outage deadline below bounds a daemon that will not answer at all. A late answer never spends the outage deadline, because that deadline accumulates across attempts — so counting the escalated waits against it would make waiting longer for an answer the very thing that declares the answerer dead.
          statusTimeout = Math.min(
            statusTimeout * 2,
            FEED_STATUS_TIMEOUT_MAX_MS,
          );
        } else {
          unreachableSince ??= now();
          if (now() - unreachableSince >= FEED_GIVE_UP_MS) {
            // The wire's last word: everything the reader is showing is now unproven, and it must not have to infer that from the stream ending.
            write(
              JSON.stringify({ v: FEED_VERSION, stale: true, reason: message }),
            );
            exitCode = 1;
            break;
          }
        }
        retryMs = Math.min(retryMs * 2, FEED_RETRY_MAX_MS);
        await sleep(retryMs, signal);
      }
    }
  } finally {
    // The held session owns a connection to the daemon; a feed that returns without closing it leaves the process unable to exit.
    await session.close();
  }

  return exitCode;
}

export async function runWorkspaceFeedCli(
  port: number,
  workspaceSessionId: string,
  instanceId: string,
): Promise<number> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  // Capture the launching Workspace once. If it dies, this child may be reparented; a later process.ppid must never become a new visibility source.
  const workspacePid = process.ppid;
  await registerWorkspaceOwner(port, workspaceSessionId, workspacePid);
  let input = Buffer.alloc(0);
  const publisher = new WorkspaceVisibilityPublisher(
    (inventory) =>
      publishWorkspaceVisibility(
        port,
        workspaceSessionId,
        workspacePid,
        inventory,
      ),
    (line) => void process.stdout.write(`${line}\n`),
  );
  const publishLine = (line: Uint8Array): void => {
    publisher.publishLine(line);
  };
  const consumeInput = (chunk: Buffer | string): void => {
    input = Buffer.concat([
      input,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    ]);
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
    return await runWorkspaceFeed(port, {
      signal: controller.signal,
      verifyInstance: (daemonPort) =>
        verifyDaemonInstance(daemonPort, instanceId),
    });
  } finally {
    if (input.byteLength > 0) publishLine(input);
    await publisher.flush();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdin.off("data", consumeInput);
    process.stdin.off("end", stop);
    process.stdin.off("error", stop);
    // A resumed stdin holds the event loop open; without this the process would finish the loop and then never exit.
    process.stdin.pause();
  }
}

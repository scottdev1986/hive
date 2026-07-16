import { createServer, connect, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { basename, join } from "node:path";
import type { AgentRecord, DaemonHookEvent } from "../../schemas";
import { HIVE_VERSION } from "../../version";
import type { CodexSessionBootstrap } from "./codex";
import { hiveInstanceSuffix } from "../../daemon/tmux-sessions";
import {
  buildCodexMcpExclusionArgs,
  HIVE_MCP_SERVERS,
  listInheritedCodexMcpServers,
} from "./mcp-scope";
import { CODEX_CAPABILITY_TOKEN_ENV } from "./codex";
import type {
  CodexQuotaReading,
  CodexRateLimitsResponse,
} from "../../daemon/quota";

type JsonObject = Record<string, unknown>;
type RpcId = string | number;

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcMessage extends JsonObject {
  id?: RpcId;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: RpcError;
}

export interface CodexAppServerTransport {
  send(message: RpcMessage): void;
  close(): void;
  onMessage(handler: (message: RpcMessage) => void): void;
  onClose(handler: (error?: Error) => void): void;
}

export interface CodexAppServerHandlers {
  notification(message: RpcMessage): void | Promise<void>;
  request(message: RpcMessage): Promise<unknown>;
  /** The connection dropped. Inbound requests we are still holding — a
   * mutation approval waiting on a human — can never be answered now, so the
   * owner must settle them rather than leave them pending forever. */
  closed?(error?: Error): void;
}

export class CodexAppServerClient {
  private requestId = 0;
  private readonly pending = new Map<RpcId, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly transport: CodexAppServerTransport,
    private readonly handlers: CodexAppServerHandlers,
  ) {
    transport.onMessage((message) => this.receive(message));
    transport.onClose((error) => this.closed(error));
  }

  request(method: string, params?: JsonObject, timeoutMs = 20_000): Promise<unknown> {
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ method, id, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: JsonObject): void {
    this.transport.send({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: RpcId, result: unknown): void {
    this.transport.send({ id, result });
  }

  close(): void {
    this.transport.close();
  }

  private receive(message: RpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(
          `Codex app-server error ${message.error.code}: ${message.error.message}`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === undefined) return;
    if (message.id === undefined) {
      void Promise.resolve(this.handlers.notification(message)).catch((error) => {
        console.error(
          `Hive Codex notification handler failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      return;
    }
    void this.handlers.request(message).then(
      (result) => this.transport.send({ id: message.id!, result }),
      (error) => this.transport.send({
        id: message.id!,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Hive request handler failed",
        },
      }),
    );
  }

  private closed(error?: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("Codex app-server connection closed"));
    }
    this.pending.clear();
    this.handlers.closed?.(error);
  }
}

// A frame is at most a few hundred KB. An unterminated larger buffer is not a
// valid frame and must not grow without bound.
export const MAX_FRAME_BUFFER_BYTES = 4 * 1024 * 1024;

export class SocketTransport implements CodexAppServerTransport {
  private buffer = "";
  private messageHandler: (message: RpcMessage) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("close", () => this.closeHandler());
    socket.on("error", (error) => this.closeHandler(error));
  }

  static connect(path: string): Promise<SocketTransport> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(new SocketTransport(socket));
      });
    });
  }

  send(message: RpcMessage): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.socket.destroy();
  }

  onMessage(handler: (message: RpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (this.buffer.length > MAX_FRAME_BUFFER_BYTES) {
          console.error(
            `Hive Codex transport dropped ${this.buffer.length} unterminated bytes`,
          );
          this.buffer = "";
        }
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        this.messageHandler(JSON.parse(line) as RpcMessage);
      } catch {
        // A malformed frame cannot be correlated to a request. Ignore it and
        // keep the control connection alive for subsequent valid frames.
      }
    }
  }
}

export interface CodexApprovalRequest {
  agentName: string;
  description: string;
  /** The exact holder whose session is asking, so approval insertion can
   * validate atomically against the durable row: a ghost "pending" row must
   * never appear for a replaced, revoked, or read-only holder. */
  agentId: string;
  processIncarnation: number;
  capabilityEpoch: number;
}

/** One piece of human pane input, exactly as the host submitted it. */
export type CodexPaneInput =
  | { kind: "text"; text: string }
  | { kind: "interrupt" };

/** What happened to one pane input: delivered into the live session, queued
 * for the exact holder until its session starts, or — for an interrupt — there
 * was no turn to interrupt. Never silent. */
export type CodexPaneInputOutcome = "delivered" | "queued" | "no-turn";

/**
 * What a live Codex session says about ITSELF: the holder it was started for,
 * the thread/turn running right now, and the rollout the app-server named for
 * that thread.
 *
 * The direction matters. A caller looks a session up by agent NAME, and a name
 * is reusable — so the session must hand back its own `agentId` and have the
 * caller compare that to the row it meant, rather than the caller handing the
 * session a row's identifiers and getting them politely echoed back. That is
 * the difference between proving the session belongs to this holder and
 * assuming it.
 */
export interface CodexTurnBinding {
  agentId: string;
  agentName: string;
  processIncarnation: number;
  capabilityEpoch: number;
  threadId: string;
  turnId: string;
  rolloutPath: string | null;
}

/** One mutation a Codex writer is asking Hive to allow: a session's own
 * binding, plus what it wants to do. The daemon re-fetches the row by
 * `agentId` and refuses if the snapshot moved, so a stale predecessor, a
 * same-name replacement, or a re-armed epoch cannot inherit this session's
 * authority. */
export type CodexMutationAuthorizationRequest = CodexTurnBinding & {
  method: string;
};

/** Deny-by-default: only an explicit `allowed: true` is permission. */
export type CodexMutationDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface CodexAppServerManagerOptions {
  socketPath?: (agent: AgentRecord) => string;
  transport?: (path: string) => Promise<CodexAppServerTransport>;
  commandRunner?: (argv: string[]) => Promise<number>;
  sleep?: (milliseconds: number) => Promise<void>;
  onEvent: (event: DaemonHookEvent, holder: AgentRecord) => Promise<void>;
  queueApproval: (request: CodexApprovalRequest) => Promise<string>;
  /** Mark a durable approval row denied. Called when an approval can no longer
   * be delivered (the transport dropped), so the row cannot linger in
   * `hive_approvals` for a human to approve into a decision nobody receives. */
  denyApproval: (id: string) => Promise<void>;
  /** The daemon-owned authorization for one writer mutation. It re-fetches the
   * exact holder row and re-attests the provider-applied identity for this
   * exact thread/turn. Called once before the approval is queued and again
   * immediately before the allow response is sent (TOCTOU). */
  authorizeMutation: (
    request: CodexMutationAuthorizationRequest,
  ) => Promise<CodexMutationDecision>;
  /** The live daemon-owned autonomy dial. Read when a mutation arrives to pick
   * the approval path (sandboxed queues the human; dangerous auto-decides) and
   * read AGAIN synchronously at the final allow boundary: a dial that dropped
   * to sandboxed while checks were in flight must never auto-allow. Never an
   * agent claim. Absent reads as sandboxed — fail-closed: no dial is never a
   * license to auto-allow. */
  autonomy?: () => "sandboxed" | "dangerous";
  observeRateLimits: (
    model: string,
    response: CodexRateLimitsResponse,
    observedAt?: string,
  ) => Promise<CodexQuotaReading | null>;
}

interface CodexSession {
  agent: AgentRecord;
  client: CodexAppServerClient;
  threadId: string;
  activeTurnId: string | null;
  /** The bootstrap turn has started. Between `sessions.set` and the initial
   * `turn/start` the session is live but NOT ready for pane input — a typed
   * line delivered in that window would race (or steal) the bootstrap prompt,
   * so input queues until this flips. */
  bootReady: boolean;
  /** The transport dropped or the session was torn down. Latched, and checked
   * before any approval is registered: a decision made after this can never be
   * delivered, so it must never be waited on. */
  closed: boolean;
  quotaBaselines: Map<string, CodexQuotaReading | null>;
  contextPct: number;
  // The authorized effort for this thread. Every turn — the initial one, an
  // idle follow-up, or a steer that falls back to a fresh turn — must carry it,
  // or the thread reverts to the server-side default effort (the incident's
  // productive parent silently ran a lower effort than it was authorized for).
  authorizedEffort: string;
}

interface CodexQuotaSample {
  reading: CodexQuotaReading | null;
  observedAt: string;
}

const UUID_AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function socketAgentId(id: string): string {
  if (UUID_AGENT_ID.test(id)) {
    return `~${Buffer.from(id.replaceAll("-", ""), "hex").toString("base64url")}`;
  }
  return id.replaceAll(/[^A-Za-z0-9_-]/g, "-");
}

/** The per-agent Codex app-server socket. It lives in the per-user temp dir
 * (0700 on macOS), never world-writable /tmp where any local user could
 * pre-bind the name, and is keyed by the resolved-home hash to deduplicate
 * when multiple HIVE_HOME spellings name the same place. UUID agent ids use a
 * reversible 22-character encoding so the normal macOS temp dir stays within
 * the 104-byte AF_UNIX sun_path limit. */
export function codexAgentSocketPath(
  agent: AgentRecord,
  hiveHome?: string,
): string {
  const socket = join(
    tmpdir(),
    `hive-codex-${hiveInstanceSuffix(hiveHome)}-${socketAgentId(agent.id)}.sock`,
  );
  // macOS caps sun_path at 104 bytes; an over-long TMPDIR must fail here with
  // its cause, not as an inscrutable bind error inside a subprocess.
  if (Buffer.byteLength(socket) > 103) {
    throw new Error(
      `Codex agent socket path exceeds the AF_UNIX length limit: ${socket}. ` +
        "Point TMPDIR at a shorter directory.",
    );
  }
  return socket;
}

const defaultSocketPath = (agent: AgentRecord): string =>
  codexAgentSocketPath(agent);

const asObject = (value: unknown, label: string): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Codex app-server ${label}`);
  }
  return value as JsonObject;
};

const stringField = (value: JsonObject, key: string): string => {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid Codex app-server field: ${key}`);
  }
  return field;
};

const timestamp = (): string => new Date().toISOString();
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000;
/** The daemon's authorization must never be able to hang a mutation open: a
 * gate that never answers is a denial, not a pending allow. */
const AUTHORIZE_MUTATION_TIMEOUT_MS = 10_000;

/** The only families that can ever be allowed, and only one request at a time.
 * Two exclusions, both forced by the protocol rather than chosen:
 *
 * - `item/permissions/requestApproval`: its narrowest scope is a whole turn
 *   (PermissionGrantScope is exactly ["turn","session"] on codex-cli 0.144.4),
 *   and a grant that outlives one identity check is forbidden. Always refused,
 *   never gated.
 * - `execCommandApproval` / `applyPatchApproval` (the legacy v1 families):
 *   their params carry `conversationId`/`callId` but no `turnId`, so a decision
 *   on them cannot be bound to the exact turn whose applied identity we
 *   attested. Unbindable is unknown, and unknown is refused.
 *
 * Both keep answering on the mechanical denial path below. */
const ONE_SHOT_MUTATION_METHODS = new Set([
  "item/fileChange/requestApproval",
  "item/commandExecution/requestApproval",
]);

export class CodexAppServerManager {
  private readonly sessions = new Map<string, CodexSession>();
  /** Mutation approvals awaiting a decision, keyed by the durable approval id.
   * Every path that ends one — a decision, a disconnect, a dropped transport —
   * must settle these, or a Codex turn waits forever on a promise nobody owns. */
  private readonly pendingApprovals = new Map<string, {
    agentName: string;
    /** The exact turn whose mutation waits. An interrupt or completion of
     * that turn settles the approval as denied — a decision for a turn that
     * no longer runs can never be delivered anywhere useful. */
    threadId: string;
    turnId: string;
    resolve: (approved: boolean) => void;
  }>();
  /** Pane input that arrived before the holder's session was boot-ready,
   * keyed by the EXACT holder (agentId + processIncarnation) — never by name,
   * which is reusable. Flushed in order once the session's initial turn has
   * started. A replacement never inherits it (its key differs); a same-holder
   * reconnect DOES (disconnect deliberately preserves the queue, so a line
   * the host was told is queued cannot silently vanish). */
  private readonly pendingInput = new Map<string, string[]>();
  /** One serialized action lane per exact holder. Every pane action — typed
   * line, Ctrl-C, and the automatic post-bootstrap flush — passes through it,
   * so two drains can never race one queue and typing can never interleave
   * with the bootstrap. Interrupt CANCELLATION is the one deliberate
   * exception: it clears the queue synchronously at arrival so a drain
   * mid-flight stops before its next line. */
  private readonly holderActions = new Map<string, Promise<unknown>>();
  private availability: Promise<boolean> | null = null;
  private readonly socketPath: (agent: AgentRecord) => string;
  private readonly transport: (path: string) => Promise<CodexAppServerTransport>;
  private readonly commandRunner: (argv: string[]) => Promise<number>;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: CodexAppServerManagerOptions) {
    this.socketPath = options.socketPath ?? defaultSocketPath;
    this.transport = options.transport ?? SocketTransport.connect;
    this.commandRunner = options.commandRunner ?? (async (argv) => {
      const child = Bun.spawn(argv, {
        stdout: "ignore",
        stderr: "ignore",
        timeout: AVAILABILITY_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      return child.exited;
    });
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  isAvailable(): Promise<boolean> {
    this.availability ??= this.commandRunner(["codex", "app-server", "--help"])
      .then((exitCode) => exitCode === 0, () => false);
    return this.availability;
  }

  buildHostCommand(
    agent: AgentRecord,
    daemonPort: number,
    graphifyUrl?: string,
  ): string[] {
    if (agent.worktreePath === null) {
      throw new Error(`Cannot host Codex app-server without a worktree: ${agent.name}`);
    }
    return [
      "hive",
      "codex-app-server-host",
      "--socket",
      this.socketPath(agent),
      "--worktree",
      agent.worktreePath,
      "--port",
      String(daemonPort),
      "--instance-id",
      hiveInstanceSuffix(),
      "--agent",
      agent.name,
      ...(graphifyUrl === undefined
        ? []
        : ["--graphify-url", graphifyUrl]),
    ];
  }

  hasAgent(agentName: string): boolean {
    return this.sessions.has(agentName);
  }

  /**
   * The live binding for an agent's brokered session, or null when it has none.
   *
   * Landing and daemon-side mutating tools are mutations too, so they re-use
   * the very same authority as a broker request. The session reports the holder
   * it was started for; the CALLER must check that against the row it means to
   * authorize (see `CodexTurnBinding`). Null when there is no live session, no
   * running turn, or no rollout path — each of which is a refusal, because an
   * unbrokered or unattestable Codex writer is what containment forbids.
   */
  async activeTurnBinding(agentName: string): Promise<CodexTurnBinding | null> {
    const session = this.sessions.get(agentName);
    if (session === undefined || session.activeTurnId === null) return null;
    const turnId = session.activeTurnId;
    try {
      return {
        ...this.holderSnapshot(session),
        threadId: session.threadId,
        turnId,
        rolloutPath: await this.threadRolloutPath(session),
      };
    } catch {
      return null;
    }
  }

  /** The holder this session was started for, as the session itself records it. */
  private holderSnapshot(
    session: CodexSession,
  ): Pick<
    CodexTurnBinding,
    "agentId" | "agentName" | "processIncarnation" | "capabilityEpoch"
  > {
    return {
      agentId: session.agent.id,
      agentName: session.agent.name,
      processIncarnation: session.agent.processIncarnation ?? 0,
      capabilityEpoch: session.agent.capabilityEpoch,
    };
  }

  isTurnActive(agentName: string): boolean {
    const session = this.sessions.get(agentName);
    return session !== undefined && session.activeTurnId !== null;
  }

  /** The live session's own turn facts, synchronously — no transport round
   * trip — so an authorization that awaited can re-prove the binding it is
   * about to allow without opening another await window. Null when no session
   * answers to the name. */
  sessionTurnSnapshot(agentName: string): {
    agentId: string;
    processIncarnation: number;
    threadId: string;
    turnId: string | null;
    closed: boolean;
  } | null {
    const session = this.sessions.get(agentName);
    if (session === undefined) return null;
    return {
      agentId: session.agent.id,
      processIncarnation: session.agent.processIncarnation ?? 0,
      threadId: session.threadId,
      turnId: session.activeTurnId,
      closed: session.closed,
    };
  }

  /** The session answering to this agent's name, but only when it belongs to
   * this EXACT holder — a same-name replacement must not receive a
   * predecessor's pane input, nor the other way around. */
  private holderSession(agent: AgentRecord): CodexSession | null {
    const session = this.sessions.get(agent.name);
    if (
      session === undefined || session.closed ||
      session.agent.id !== agent.id ||
      (session.agent.processIncarnation ?? 0) !==
        (agent.processIncarnation ?? 0)
    ) {
      return null;
    }
    return session;
  }

  private static holderKey(agent: AgentRecord): string {
    return `${agent.id}#${agent.processIncarnation ?? 0}`;
  }

  /** Append `action` to this holder's serialized lane. Actions run strictly
   * one at a time per exact holder, in arrival order, and a failed action
   * never wedges the lane. */
  private runHolderAction<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.holderActions.get(key) ?? Promise.resolve();
    const run = previous.then(action, action);
    this.holderActions.set(key, run.catch(() => undefined));
    return run;
  }

  /** The exact holder's boot-ready session, or null. Rechecked after EVERY
   * await inside a lane action: a replacement or teardown during an awaited
   * delivery must strand the action, never cross it over by name. */
  private readySession(agent: AgentRecord): CodexSession | null {
    const session = this.holderSession(agent);
    return session === null || !session.bootReady ? null : session;
  }

  /**
   * Route one piece of human pane input. This is conversation, not authority:
   * it deliberately never reads identityState, status, or writeRevoked — a
   * revoked writer's human must still be able to type, steer, and interrupt.
   *
   * Text goes to the boot-ready session (idle starts a turn, an active turn
   * is steered); before that it queues under the exact holder and flushes in
   * order once the initial turn has started. An interrupt stops the active
   * turn — confirmed stopped before this returns, so the next line finds a
   * clear turn — and discards this holder's queued text: the human canceled
   * what they had typed, and it must not submit later.
   */
  async paneInput(
    agent: AgentRecord,
    input: CodexPaneInput,
  ): Promise<CodexPaneInputOutcome> {
    const key = CodexAppServerManager.holderKey(agent);
    if (input.kind === "interrupt") {
      // The cancellation is synchronous, outside the lane: a drain mid-flight
      // notices the queue it holds is no longer the live one and stops before
      // its next line.
      this.pendingInput.delete(key);
      return await this.runHolderAction(key, async () => {
        const session = this.readySession(agent);
        if (session === null || session.activeTurnId === null) return "no-turn";
        await this.interruptForPane(session, agent);
        return "delivered";
      });
    }
    return await this.runHolderAction(key, async () => {
      const enqueue = (): CodexPaneInputOutcome => {
        const queue = this.pendingInput.get(key) ?? [];
        queue.push(input.text);
        this.pendingInput.set(key, queue);
        return "queued";
      };
      if (this.readySession(agent) === null) return enqueue();
      // Anything still queued for this holder goes first, so typing that
      // spanned session startup keeps its order.
      await this.drainPendingInput(agent);
      // The drain awaited; re-prove the exact holder before the new line.
      if (this.readySession(agent) === null) return enqueue();
      await this.deliver(agent, input.text);
      return "delivered";
    });
  }

  /** Interrupt the pane's active turn and wait — bounded, fail-visible — for
   * the provider to confirm the turn is over. Host POSTs are serialized, so
   * the line typed right after Ctrl-C would otherwise steer the interrupted
   * turn's corpse. Confirmation also settles any mutation approval still
   * waiting inside that turn: a decision for a turn that no longer runs can
   * never be delivered anywhere useful. */
  private async interruptForPane(
    session: CodexSession,
    agent: AgentRecord,
  ): Promise<void> {
    const threadId = session.threadId;
    const turnId = session.activeTurnId;
    if (turnId === null) return;
    await session.client.request("turn/interrupt", { threadId, turnId });
    for (
      let attempt = 0;
      attempt < 50 && session.activeTurnId === turnId;
      attempt += 1
    ) {
      await this.sleep(100);
    }
    if (session.activeTurnId === turnId) {
      throw new Error(
        `Codex did not confirm the interrupt for ${agent.name}; the turn may still be running`,
      );
    }
    await this.settleTurnApprovals(agent.name, threadId, turnId);
  }

  /** Deliver this exact holder's queued pane input, in order, into its live
   * session. Runs only inside the holder lane. A failure keeps the remainder
   * queued for the next drain; an interrupt that arrived mid-delivery cleared
   * the live queue, and the remainder of THIS drain is canceled with it. */
  private async drainPendingInput(agent: AgentRecord): Promise<void> {
    const key = CodexAppServerManager.holderKey(agent);
    const queue = this.pendingInput.get(key);
    if (queue === undefined) return;
    while (queue.length > 0) {
      if (this.readySession(agent) === null) return; // stays queued
      await this.deliver(agent, queue[0]!);
      // An interrupt while that await was in flight replaced or cleared the
      // live queue: this drain no longer owns what it holds.
      if (this.pendingInput.get(key) !== queue) return;
      queue.shift();
    }
    if (this.pendingInput.get(key) === queue) this.pendingInput.delete(key);
  }

  /** Start a thread for `agent`. A writer is admissible here — the app-server
   * is the brokered driver — but its sandbox is `read-only` exactly like a
   * reader's: the sandbox is the structural containment, and the ONLY way a
   * mutation reaches the filesystem is an approval request this manager
   * answers. Whether the agent may write is never read from a launch argument;
   * it is re-proved against the durable holder row on every mutation. */
  async startAgent(
    agent: AgentRecord,
    bootstrap: CodexSessionBootstrap,
    effort: string,
  ): Promise<void> {
    if (bootstrap.initialUserPrompt === undefined) {
      throw new Error("Codex worker bootstrap requires an initial user prompt");
    }
    const transport = await this.connectWithRetry(this.socketPath(agent));
    const client = new CodexAppServerClient(transport, {
      notification: (message) => this.handleNotification(agent.name, message),
      request: (message) => this.handleRequest(agent.name, message),
      // A dropped connection denies every mutation this agent had waiting: the
      // decision could not be delivered anyway, and a pending approval that
      // outlives its transport is authority with nobody watching it.
      closed: () => {
        void this.denyAgentApprovals(agent.name);
      },
    });
    try {
      await client.request("initialize", {
        clientInfo: { name: "hive", title: "Hive", version: HIVE_VERSION },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      });
      client.notify("initialized");
      const threadResult = asObject(await client.request("thread/start", {
        ...(agent.model === "default" ? {} : { model: agent.model }),
        cwd: agent.worktreePath,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "read-only",
        developerInstructions: bootstrap.developerInstructions,
      }), "thread/start response");
      const thread = asObject(threadResult.thread, "thread");
      const session: CodexSession = {
        agent,
        client,
        threadId: stringField(thread, "id"),
        activeTurnId: null,
        bootReady: false,
        closed: false,
        quotaBaselines: new Map(),
        contextPct: 0,
        authorizedEffort: effort,
      };
      this.sessions.set(agent.name, session);
      await this.options.onEvent({
        kind: "session-start",
        agentName: agent.name,
        timestamp: timestamp(),
      }, session.agent);
      await this.startTurn(agent, bootstrap.initialUserPrompt, effort);
      // Only now is the session ready for pane input: a line delivered
      // between sessions.set and this point would race the bootstrap prompt.
      session.bootReady = true;
    } catch (error) {
      client.close();
      this.sessions.delete(agent.name);
      throw error;
    }
    // Pane input typed before the session was boot-ready flushes now, through
    // the same serialized holder lane every pane action uses, so it lands as
    // ordered follow-up steering. A failure keeps the remainder queued — the
    // next pane input retries the drain — and is logged rather than silent.
    await this.runHolderAction(
      CodexAppServerManager.holderKey(agent),
      () => this.drainPendingInput(agent),
    ).catch((error) => {
      console.error(
        `Hive could not deliver ${agent.name}'s queued pane input (kept queued): ${
          error instanceof Error ? error.message : "delivery failed"
        }`,
      );
    });
  }

  async startTurn(agent: AgentRecord, text: string, effort?: string): Promise<void> {
    const session = this.requireExactSession(agent);
    session.agent = agent;
    // Default to the thread's authorized effort so an idle follow-up or a steer
    // that starts a fresh turn never silently drops to the server-side default.
    const turnEffort = effort ?? session.authorizedEffort;
    const quotaBaseline = (await this.readRateLimits(session).catch(() => null))
      ?.reading ?? null;
    const response = asObject(await session.client.request("turn/start", {
      threadId: session.threadId,
      input: [{ type: "text", text }],
      ...(turnEffort === undefined ? {} : { effort: turnEffort }),
    }), "turn/start response");
    const turn = asObject(response.turn, "turn");
    session.activeTurnId = stringField(turn, "id");
    session.quotaBaselines.set(session.activeTurnId, quotaBaseline);
  }

  async steer(agent: AgentRecord, text: string): Promise<void> {
    const session = this.requireExactSession(agent);
    if (session.activeTurnId === null) {
      await this.startTurn(agent, text);
      return;
    }
    await session.client.request("turn/steer", {
      threadId: session.threadId,
      input: [{ type: "text", text }],
      expectedTurnId: session.activeTurnId,
    });
  }

  async deliver(
    agent: AgentRecord,
    text: string,
    options: { interrupt?: boolean } = {},
  ): Promise<void> {
    const session = this.requireExactSession(agent);
    if (options.interrupt === true && session.activeTurnId !== null) {
      await this.interruptAndStart(agent, text);
    } else if (session.activeTurnId !== null) {
      await this.steer(agent, text);
    } else {
      await this.startTurn(agent, text);
    }
  }

  async interrupt(agent: AgentRecord): Promise<void> {
    // Exact holder or nothing: a caller holding a replaced row has no turn of
    // ITS OWN to interrupt in the session now answering to this name.
    const session = this.holderSession(agent);
    if (session === null || session.activeTurnId === null) return;
    await session.client.request("turn/interrupt", {
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });
  }

  async interruptAndStart(agent: AgentRecord, text: string): Promise<void> {
    const session = this.requireExactSession(agent);
    await this.interrupt(agent);
    for (let attempt = 0; attempt < 50 && session.activeTurnId !== null; attempt += 1) {
      await this.sleep(100);
    }
    if (session.activeTurnId !== null) {
      throw new Error(`Codex turn did not interrupt for ${agent.name}`);
    }
    await this.startTurn(agent, text);
  }

  /** Hand one queued mutation decision back to the waiting request. Returns
   * false when nothing was waiting on that id — an unknown id is never an
   * allow. An `approved` decision still has to survive the TOCTOU recheck in
   * `brokerWriterMutation` before it becomes an allow response. */
  async resolveApproval(id: string, approved: boolean): Promise<boolean> {
    const pending = this.pendingApprovals.get(id);
    if (pending === undefined) return false;
    this.pendingApprovals.delete(id);
    pending.resolve(approved);
    return true;
  }

  /** Settle every pending mutation approval for `agentName` as denied — the
   * durable rows included — WITHOUT closing the session. This is the
   * revocation shape: brokered revocation removes authority, not the
   * conversation, so the session stays open for typing, steer, and interrupt.
   * The insert-after-revocation race is closed at insertion itself:
   * `queueApproval` validates the exact holder and `writeRevoked` atomically
   * with the insert. */
  async denyPendingMutationApprovals(agentName: string): Promise<void> {
    for (const [id, pending] of [...this.pendingApprovals]) {
      if (pending.agentName !== agentName) continue;
      this.pendingApprovals.delete(id);
      pending.resolve(false);
      await this.settleDurableApproval(id);
    }
  }

  /** Settle the mutation approvals still waiting inside ONE exact turn, as
   * denied, without touching the session. Runs when that turn is interrupted
   * or completes: the decision a human might still make could only authorize
   * a mutation of a turn that no longer runs. */
  private async settleTurnApprovals(
    agentName: string,
    threadId: string,
    turnId: string,
  ): Promise<void> {
    for (const [id, pending] of [...this.pendingApprovals]) {
      if (
        pending.agentName !== agentName || pending.threadId !== threadId ||
        pending.turnId !== turnId
      ) {
        continue;
      }
      this.pendingApprovals.delete(id);
      pending.resolve(false);
      await this.settleDurableApproval(id);
    }
  }

  async denyAgentApprovals(agentName: string): Promise<void> {
    // Latch the session closed FIRST, so an approval being created concurrently
    // sees the flag and denies itself instead of registering behind this sweep.
    // Closing is for teardown/disconnect paths only — revocation must call
    // denyPendingMutationApprovals instead, or it would kill the conversation.
    const session = this.sessions.get(agentName);
    if (session !== undefined) session.closed = true;
    await this.denyPendingMutationApprovals(agentName);
  }

  disconnect(agentName: string): void {
    const session = this.sessions.get(agentName);
    if (session !== undefined) session.closed = true;
    // The pending-input queue is deliberately PRESERVED: the host was told
    // "queued", so the line must not silently vanish on a transport drop. A
    // same-holder reconnect flushes it; a replacement never sees it (its
    // exact-holder key differs).
    session?.client.close();
    this.sessions.delete(agentName);
    void this.denyAgentApprovals(agentName);
  }

  close(): void {
    for (const agentName of [...this.sessions.keys()]) this.disconnect(agentName);
  }

  private async connectWithRetry(path: string): Promise<CodexAppServerTransport> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        return await this.transport(path);
      } catch (error) {
        lastError = error;
        await this.sleep(100);
      }
    }
    throw new Error(
      `Codex app-server host was unavailable at ${path}: ${
        lastError instanceof Error ? lastError.message : "connection failed"
      }`,
    );
  }

  private requireSession(agentName: string): CodexSession {
    const session = this.sessions.get(agentName);
    if (session === undefined) {
      throw new Error(`Codex app-server session unavailable: ${agentName}`);
    }
    return session;
  }

  /** A name is reusable; a session is not. Every turn-mutating verb resolves
   * the session by name and then proves it belongs to the CALLER'S exact
   * holder — after any await, a name-only lookup could hand a replacement's
   * session to a stale caller (and `startTurn` would even rebind
   * `session.agent` to the stale record, poisoning the holder snapshot the
   * broker authorizes against). */
  private requireExactSession(agent: AgentRecord): CodexSession {
    const session = this.requireSession(agent.name);
    if (
      session.agent.id !== agent.id ||
      (session.agent.processIncarnation ?? 0) !==
        (agent.processIncarnation ?? 0)
    ) {
      throw new Error(
        `Codex app-server session answering to ${agent.name} belongs to a different holder`,
      );
    }
    return session;
  }

  private async readRateLimits(session: CodexSession): Promise<CodexQuotaSample> {
    const response = asObject(
      await session.client.request("account/rateLimits/read", undefined, 10_000),
      "rate-limits response",
    ) as unknown as CodexRateLimitsResponse;
    const observedAt = timestamp();
    return {
      reading: await this.options.observeRateLimits(
        session.agent.model,
        response,
        observedAt,
      ),
      observedAt,
    };
  }

  private async handleNotification(agentName: string, message: RpcMessage): Promise<void> {
    const session = this.sessions.get(agentName);
    if (session === undefined || message.method === undefined) return;
    const params = message.params ?? {};
    if (message.method === "turn/started") {
      const turn = asObject(params.turn, "turn notification");
      const turnId = stringField(turn, "id");
      session.activeTurnId = turnId;
      // The applied identity for THIS turn is readable from the rollout the
      // app-server itself names — carry that evidence on the event so the
      // daemon can attest and persist it (identity always known, and the
      // writer containment gates key on this exact-source observation). A
      // failed thread/read degrades to null: unknown, never a guess.
      const rolloutPath = await this.threadRolloutPath(session)
        .catch(() => null);
      await this.options.onEvent({
        kind: "turn-start",
        agentName,
        timestamp: timestamp(),
        appServerTurn: { rolloutPath, turnId },
      }, session.agent);
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      const usage = asObject(params.tokenUsage, "token usage");
      const total = asObject(usage.total, "total token usage");
      const totalTokens = total.totalTokens;
      const window = usage.modelContextWindow;
      if (typeof totalTokens === "number" && typeof window === "number" && window > 0) {
        session.contextPct = Math.max(0, Math.min(100, totalTokens / window * 100));
      }
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      await this.readRateLimits(session).catch(() => null);
      return;
    }
    if (message.method === "turn/completed") {
      const turn = asObject(params.turn, "completed turn");
      const completedTurnId = stringField(turn, "id");
      if (session.activeTurnId === completedTurnId) session.activeTurnId = null;
      // A mutation approval still waiting inside the finished turn can never
      // be delivered a usable decision — settle it as denied, session open.
      await this.settleTurnApprovals(
        agentName,
        session.threadId,
        completedTurnId,
      );
      const current = await this.readRateLimits(session).catch(() => null);
      const quotaBaseline = session.quotaBaselines.get(completedTurnId) ?? null;
      session.quotaBaselines.delete(completedTurnId);
      const usageUnits = current?.reading !== null &&
          current?.reading !== undefined && quotaBaseline !== null
        ? Math.max(
            0,
            current.reading.fiveHourUsed - quotaBaseline.fiveHourUsed,
            current.reading.weeklyUsed - quotaBaseline.weeklyUsed,
          )
        : undefined;
      await this.options.onEvent({
        kind: "turn-end",
        agentName,
        timestamp: current?.observedAt ?? timestamp(),
        contextPct: session.contextPct,
        ...(usageUnits === undefined || usageUnits === 0
          ? {}
          : { usageUnits, usageSource: "provider" as const }),
      }, session.agent);
    }
  }

  private async handleRequest(agentName: string, message: RpcMessage): Promise<unknown> {
    const method = message.method!;
    const params = message.params ?? {};
    const description = describeApproval(method, params);
    if (description === null) {
      if (method === "mcpServer/elicitation/request") {
        return { action: "decline", content: null };
      }
      throw new Error(`Unsupported Codex app-server request: ${method}`);
    }
    const session = this.sessions.get(agentName);
    // Readers — and any request we cannot bind to a live session — keep the
    // mechanical denial: no gate, no queue, nothing to get wrong. A reader
    // cannot mutate, so there is nothing here to authorize.
    if (session === undefined || session.agent.readOnly) {
      return approvalDenialResponse(method, params);
    }
    return await this.brokerWriterMutation(session, method, params, description);
  }

  /**
   * The writer mutation gate. Deny-by-default at every step: the request must
   * be a one-shot family, bound to this session's exact live thread and turn,
   * authorized by the daemon against the exact holder row and a freshly
   * attested provider-applied identity — then approved — and then authorized
   * AGAIN, because the holder or the identity can change while an approval
   * waits. Only that second pass reaches an allow response.
   */
  private async brokerWriterMutation(
    session: CodexSession,
    method: string,
    params: JsonObject,
    description: string,
  ): Promise<unknown> {
    const deny = () => approvalDenialResponse(method, params);
    if (!ONE_SHOT_MUTATION_METHODS.has(method)) return deny();

    const threadId = params.threadId;
    const turnId = params.turnId;
    if (typeof threadId !== "string" || typeof turnId !== "string") return deny();
    // The provider must be asking about the thread we started and the turn we
    // believe is running. A request for any other thread/turn is unbindable.
    if (threadId !== session.threadId || turnId !== session.activeTurnId) {
      return deny();
    }

    if (!await this.authorizeMutation(session, threadId, turnId, method)) {
      return deny();
    }

    // The daemon-owned dial picks the approval path. Sandboxed queues the
    // human, one-shot, and a flip to dangerous while that row waits never
    // converts it into an auto-approval — the human still decides. Dangerous
    // auto-decides on the identity checks alone and must create no durable
    // human approval row.
    let humanApproved = false;
    if ((this.options.autonomy?.() ?? "sandboxed") !== "dangerous") {
      const approved = await this.awaitApproval(
        session,
        description,
        threadId,
        turnId,
      );
      if (!approved) return deny();
      humanApproved = true;
    }

    // TOCTOU: re-prove everything against the state that exists NOW, not the
    // state that existed when the approval was queued.
    if (!await this.authorizeMutation(session, threadId, turnId, method)) {
      return deny();
    }

    // Final rechecks, synchronous — no await between here and the response.
    // The authorization above awaited, so the session can have dropped or the
    // turn completed/changed meanwhile; and in dangerous mode the dial itself
    // is in the CAS: a dial that dropped to sandboxed while checks were in
    // flight has no human approval to stand on, so it denies.
    if (session.closed) return deny();
    if (threadId !== session.threadId || turnId !== session.activeTurnId) {
      return deny();
    }
    if (
      !humanApproved && (this.options.autonomy?.() ?? "sandboxed") !== "dangerous"
    ) {
      return deny();
    }
    return approvalAllowResponse();
  }

  /** One authorization pass. Any failure to get a clear `allowed: true` — a
   * throw, a timeout, a closed transport, an unreadable rollout — is a denial. */
  private async authorizeMutation(
    session: CodexSession,
    threadId: string,
    turnId: string,
    method: string,
  ): Promise<boolean> {
    try {
      const rolloutPath = await this.threadRolloutPath(session);
      const decision = await withTimeout(
        this.options.authorizeMutation({
          ...this.holderSnapshot(session),
          threadId,
          turnId,
          method,
          rolloutPath,
        }),
        AUTHORIZE_MUTATION_TIMEOUT_MS,
      );
      return decision.allowed === true;
    } catch {
      return false;
    }
  }

  /** The rollout the app-server itself names for this thread, over this same
   * connection. Never scanned from the worktree, so a dead predecessor's
   * rollout cannot answer for a live thread. Null when the app-server reports
   * no path — unknown, which the caller denies. */
  private async threadRolloutPath(session: CodexSession): Promise<string | null> {
    const result = asObject(
      await session.client.request("thread/read", { threadId: session.threadId }, 10_000),
      "thread/read response",
    );
    const thread = asObject(result.thread, "thread");
    return typeof thread.path === "string" && thread.path.length > 0
      ? thread.path
      : null;
  }

  /** Queue one approval and wait for its decision. A disconnect, a teardown, or
   * a dropped transport resolves it as denied rather than leaving Codex waiting.
   *
   * The two awaits here are the subtle part: the connection can drop while the
   * gate's `thread/read` is in flight or while the approval is being inserted,
   * so by the time we have an id the session may already be closed. Settling
   * only what is ALREADY in `pendingApprovals` at close time therefore misses
   * exactly the entries created just after it. Every insert re-checks the flag,
   * and an insert after close is an immediate denial — including the durable
   * row, which must not be left pending for a human to approve later. */
  private async awaitApproval(
    session: CodexSession,
    description: string,
    threadId: string,
    turnId: string,
  ): Promise<boolean> {
    if (session.closed) return false;
    let id: string;
    try {
      id = await this.options.queueApproval({
        ...this.holderSnapshot(session),
        description,
      });
    } catch {
      return false;
    }
    if (session.closed) {
      await this.settleDurableApproval(id);
      return false;
    }
    // The turn can have been interrupted or completed while the row was being
    // inserted; registering behind that settlement would wait forever.
    if (session.activeTurnId !== turnId) {
      await this.settleDurableApproval(id);
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(id, {
        agentName: session.agent.name,
        threadId,
        turnId,
        resolve,
      });
    });
  }

  /** Deny the durable approval row so it cannot sit in `hive_approvals`
   * waiting for a human whose decision can no longer reach anyone. */
  private async settleDurableApproval(id: string): Promise<void> {
    await this.options.denyApproval(id).catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Codex mutation authorization timed out")),
      milliseconds,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describeApproval(method: string, params: JsonObject): string | null {
  const reason = typeof params.reason === "string" ? ` — ${params.reason}` : "";
  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string"
      ? params.command
      : "command requiring additional permissions";
    const cwd = typeof params.cwd === "string" ? ` in ${params.cwd}` : "";
    return `Codex wants to run ${command}${cwd}${reason}`;
  }
  if (method === "item/fileChange/requestApproval") {
    const root = typeof params.grantRoot === "string" ? ` under ${params.grantRoot}` : "";
    return `Codex wants to modify files${root}${reason}`;
  }
  if (method === "item/permissions/requestApproval") {
    return `Codex requests additional permissions: ${JSON.stringify(params.permissions)}${reason}`;
  }
  if (method === "execCommandApproval") {
    const command = Array.isArray(params.command) ? params.command.join(" ") : "command";
    return `Codex wants to run ${command}${reason}`;
  }
  if (method === "applyPatchApproval") {
    return `Codex wants to apply a file patch${reason}`;
  }
  return null;
}

/**
 * The allow response for ONE mutation request.
 *
 * `accept` decides exactly this request and nothing else. The neighbouring
 * `acceptForSession` on the same enum is a reusable permission — the thing this
 * gate exists to prevent — so it is never sent, and neither is any
 * `GrantedPermissionProfile`: the identity that was attested for this turn must
 * not be able to authorize a second mutation.
 */
function approvalAllowResponse(): unknown {
  return { decision: "accept" };
}

function approvalDenialResponse(
  method: string,
  params: JsonObject,
): unknown {
  if (method === "item/permissions/requestApproval") {
    asObject(params.permissions, "requested permissions");
    return {
      permissions: {},
      scope: "turn",
    };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: "denied" };
  }
  return { decision: "decline" };
}

export function renderCodexHostMessage(message: RpcMessage): string | null {
  const method = message.method;
  const params = message.params ?? {};
  if (method === "turn/started") {
    const turn = typeof params.turn === "object" && params.turn !== null
      ? params.turn as JsonObject
      : {};
    return `\n▶ turn ${String(turn.id ?? "started")}\n`;
  }
  if (method === "turn/completed") {
    const turn = typeof params.turn === "object" && params.turn !== null
      ? params.turn as JsonObject
      : {};
    return `\n✓ turn ${String(turn.status ?? "completed")}\n`;
  }
  if (
    method === "item/agentMessage/delta" ||
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/commandExecution/outputDelta"
  ) {
    return typeof params.delta === "string" ? params.delta : null;
  }
  if (method === "item/started") {
    const item = typeof params.item === "object" && params.item !== null
      ? params.item as JsonObject
      : {};
    if (item.type === "commandExecution") return `\n$ ${String(item.command ?? "command")}\n`;
    if (item.type === "fileChange") return "\n✎ applying file changes\n";
    if (item.type === "mcpToolCall") {
      return `\n↗ ${String(item.server ?? "mcp")}/${String(item.tool ?? "tool")}\n`;
    }
  }
  if (message.id !== undefined && method?.includes("requestApproval")) {
    return `\n⚠ ${describeApproval(method, params) ?? "Codex approval requested"}\n`;
  }
  if (method === "error") {
    return `\n✗ ${JSON.stringify(params.error ?? params)}\n`;
  }
  return null;
}

export interface CodexAppServerHostOptions {
  socket: string;
  worktree: string;
  daemonPort: number;
  agentName: string;
  graphifyUrl?: string;
  /** Exact binary used by deterministic host-boundary tests. */
  executable?: string;
}

export interface PaneInputForwarderOptions {
  agentName: string;
  daemonPort: number;
  /** Bearer for the daemon's exact-holder pane-input route, read from the
   * host's own environment (the same 0600 capability file the launch shell
   * loaded). Absent sends no authorization header and the daemon refuses. */
  token: string | undefined;
  write: (text: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Turns pane keystrokes into daemon-brokered turn input. The child's stdin is
 * the JSON-RPC stream — raw pane bytes must NEVER go there — so submitted
 * lines and Ctrl-C travel out-of-band to the daemon's `/pane-input` route,
 * which maps them onto start/steer/interrupt for this exact holder.
 *
 * Two properties are load-bearing:
 * - Everything goes through ONE promise chain: Enter then Ctrl-C must arrive
 *   as deliver then interrupt, and rapid lines must keep their order. No
 *   handler ever launches an independent fetch.
 * - A failed POST is never retried blindly: a POST accepted while its
 *   response was lost would deliver the same human prompt twice. The failure
 *   renders visibly with the undelivered line instead.
 */
export function createPaneInputForwarder(options: PaneInputForwarderOptions): {
  onData: (chunk: Buffer | string) => void;
  onInterrupt: () => void;
  /** Settles when every input submitted so far has been posted and rendered. */
  idle: () => Promise<void>;
} {
  const doFetch = options.fetchImpl ?? fetch;
  let chain = Promise.resolve();
  let lineBuffer = "";
  // Streaming decode: a multibyte character split across stdin chunks must
  // not be corrupted by per-chunk toString.
  const decoder = new StringDecoder("utf8");
  const post = (input: CodexPaneInput): void => {
    chain = chain.then(async () => {
      try {
        const response = await doFetch(
          `http://127.0.0.1:${options.daemonPort}/pane-input`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(options.token === undefined
                ? {}
                : { authorization: `Bearer ${options.token}` }),
            },
            body: JSON.stringify({ agentName: options.agentName, ...input }),
          },
        );
        if (!response.ok) throw new Error(`daemon answered ${response.status}`);
        const outcome =
          ((await response.json().catch(() => ({}))) as { outcome?: string })
            .outcome;
        if (input.kind === "interrupt") {
          options.write(
            outcome === "no-turn"
              ? "\n· nothing to interrupt\n"
              : "\n■ interrupt requested\n",
          );
        } else if (outcome === "queued") {
          options.write("\n· queued — delivers when the session is up\n");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "request failed";
        options.write(
          input.kind === "text"
            ? `\n✗ input not delivered (${message}) — not retried; retype to resend:\n${input.text}\n`
            : `\n✗ interrupt not delivered (${message})\n`,
        );
      }
    });
  };
  return {
    onData: (chunk) => {
      lineBuffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (true) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line.trim().length > 0) post({ kind: "text", text: line });
      }
    },
    onInterrupt: () => {
      // Ctrl-C discards the partially typed line — it must not submit later —
      // and interrupts the running turn only.
      lineBuffer = "";
      post({ kind: "interrupt" });
    },
    idle: () => chain,
  };
}

/** Build the scoped Codex app-server authority. Apps/connectors and global MCP
 * servers belong to the user's general Codex sessions, not a Hive agent. The
 * overrides affect only this child process and keep Hive plus the optional
 * per-instance Graphify server. */
export function buildCodexAppServerCommand(
  options: CodexAppServerHostOptions,
  inheritedMcpServers: readonly string[] = [],
): string[] {
  const keep = options.graphifyUrl === undefined
    ? HIVE_MCP_SERVERS
    : [...HIVE_MCP_SERVERS, "graphify"];
  const exclusions = buildCodexMcpExclusionArgs(
    inheritedMcpServers,
    keep,
  ).args;
  return [
    options.executable ?? "codex",
    "app-server",
    "--stdio",
    "-c",
    "features.apps=false",
    "-c",
    "features.multi_agent=false",
    ...exclusions,
    "-c",
    `projects.${JSON.stringify(options.worktree)}.trust_level=\"trusted\"`,
    "-c",
    `mcp_servers.hive.url=${JSON.stringify(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    "-c",
    `mcp_servers.hive.bearer_token_env_var=${JSON.stringify(CODEX_CAPABILITY_TOKEN_ENV)}`,
    ...(options.graphifyUrl === undefined
      ? []
      : [
          "-c",
          `mcp_servers.graphify.url=${JSON.stringify(options.graphifyUrl)}`,
        ]),
  ];
}

export async function runCodexAppServerHost(
  options: CodexAppServerHostOptions,
): Promise<number> {
  await unlink(options.socket).catch(() => undefined);
  await unlink(`${options.socket}.pid`).catch(() => undefined);
  const child = Bun.spawn(buildCodexAppServerCommand(
    options,
    await listInheritedCodexMcpServers(),
  ), {
    cwd: options.worktree,
    // The tmux launch shell reads the 0600 capability file into the host's
    // environment. Pass that environment explicitly across the second process
    // boundary so Codex can resolve bearer_token_env_var without a secret argv.
    env: { ...Bun.env },
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // The child's pid is recorded beside the socket so the daemon can reap a
  // codex app-server whose host died without cleanup (SIGKILL, OOM, crash) —
  // orphans from exactly that path were found still running days later.
  await Bun.write(`${options.socket}.pid`, `${child.pid}\n`);
  const stopChild = (): void => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited.
      }
    }
  };
  process.once("SIGTERM", stopChild);
  process.once("SIGHUP", stopChild);
  process.once("exit", stopChild);
  // Pane typing and Ctrl-C are conversation, not teardown. Ctrl-C used to run
  // stopChild — a typed interrupt SIGKILLed the whole app-server — so SIGINT
  // now travels to the daemon as a turn interrupt and the host stays up;
  // SIGTERM/SIGHUP/exit keep the teardown semantics.
  const paneInput = createPaneInputForwarder({
    agentName: options.agentName,
    daemonPort: options.daemonPort,
    token: Bun.env[CODEX_CAPABILITY_TOKEN_ENV],
    write: (text) => process.stdout.write(text),
  });
  process.on("SIGINT", paneInput.onInterrupt);
  process.stdin.on("data", paneInput.onData);
  let client: Socket | null = null;
  let childBuffer = "";
  const server = createServer((socket) => {
    if (client !== null) {
      socket.destroy(new Error("Hive Codex app-server host already has a client"));
      return;
    }
    client = socket;
    socket.on("data", (chunk) => child.stdin.write(chunk));
    socket.on("close", () => {
      client = null;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(options.socket, 0o600);
  process.stdout.write(
    `Hive Codex app-server for ${options.agentName}\n`,
  );
  const stdout = new Response(child.stdout).body!.getReader();
  const stderr = new Response(child.stderr).body!.getReader();
  const decode = new TextDecoder();
  const relayStdout = async (): Promise<void> => {
    while (true) {
      const { done, value } = await stdout.read();
      if (done) break;
      const text = decode.decode(value, { stream: true });
      if (
        client !== null && client.writableLength > MAX_FRAME_BUFFER_BYTES
      ) {
        // The daemon stopped draining its socket. Dropping the connection
        // (it re-establishes on the next agent start) beats buffering the
        // codex stream in this process until the machine runs out of memory.
        client.destroy();
        client = null;
      }
      client?.write(text);
      childBuffer += text;
      if (childBuffer.indexOf("\n") < 0) {
        if (childBuffer.length > MAX_FRAME_BUFFER_BYTES) childBuffer = "";
        continue;
      }
      while (true) {
        const newline = childBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = childBuffer.slice(0, newline).trim();
        childBuffer = childBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        try {
          const rendered = renderCodexHostMessage(JSON.parse(line) as RpcMessage);
          if (rendered !== null) process.stdout.write(rendered);
        } catch {
          // The daemon receives the original frame; host rendering never
          // controls the agent.
        }
      }
    }
  };
  const relayStderr = async (): Promise<void> => {
    while (true) {
      const { done, value } = await stderr.read();
      if (done) break;
      process.stderr.write(value);
    }
  };
  const exitCode = await Promise.all([
    child.exited,
    relayStdout(),
    relayStderr(),
  ]).then(([code]) => code);
  process.off("SIGTERM", stopChild);
  process.off("SIGHUP", stopChild);
  process.off("exit", stopChild);
  process.off("SIGINT", paneInput.onInterrupt);
  process.stdin.off("data", paneInput.onData);
  process.stdin.pause();
  server.close();
  (client as Socket | null)?.destroy();
  await unlink(options.socket).catch(() => undefined);
  await unlink(`${options.socket}.pid`).catch(() => undefined);
  return exitCode;
}

/** The host's pidfile, dropped beside its socket so a dead host's child can be
 * found by a daemon that never spawned it. */
export function codexAgentHostPidfile(
  agent: AgentRecord,
  hiveHome?: string,
): string {
  return `${codexAgentSocketPath(agent, hiveHome)}.pid`;
}

/** The agent id in this instance's host pidfile, or null for any other name. */
export function hostPidfileAgentId(
  name: string,
  hiveHome?: string,
): string | null {
  const prefix = `hive-codex-${hiveInstanceSuffix(hiveHome)}-`;
  const suffix = ".sock.pid";
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const id = name.slice(prefix.length, -suffix.length);
  if (id === "") return null;
  if (!id.startsWith("~")) return id;
  if (!/^~[A-Za-z0-9_-]{22}$/.test(id)) return null;
  const hex = Buffer.from(id.slice(1), "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export interface ReapOrphanDependencies {
  listSocketDir: () => Promise<string[]>;
  readPidFile: (name: string) => Promise<string>;
  removeFile: (name: string) => Promise<void>;
  fileState: (name: string) => Promise<"present" | "absent" | "unknown">;
  processCommand: (pid: number) => Promise<string | null>;
  processState: (pid: number) => Promise<"live" | "dead" | "unknown">;
  /** A negative target signals the process group, matching process.kill. */
  kill: (pid: number) => void;
}

/** A prompt can contain "codex app-server", so process identity must come
 * from argv[0] and the subcommand. */
function isCodexAppServer(command: string): boolean {
  const [binary, subcommand] = command.trim().split(/\s+/);
  return basename(binary ?? "") === "codex" && subcommand === "app-server";
}

async function removeVerifiedHostFile(
  name: string,
  dependencies: ReapOrphanDependencies,
): Promise<void> {
  await dependencies.removeFile(name);
  const state = await dependencies.fileState(name);
  if (state === "present") {
    throw new Error(`Codex app-server cleanup left ${name} behind`);
  }
  if (state === "unknown") {
    throw new Error(`Cannot verify removal of Codex app-server file ${name}`);
  }
}

export async function reapOrphanCodexHosts(
  agentIdStatus: (id: string) => "live" | "dead" | "unknown",
  dependencies: ReapOrphanDependencies,
  hiveHome?: string,
): Promise<number[]> {
  const reaped: number[] = [];
  for (const name of await dependencies.listSocketDir()) {
    // Socket paths flatten non-UUID ids and reversibly compact UUIDs with the
    // same rules as the writer.
    const agentId = hostPidfileAgentId(name, hiveHome);
    if (agentId === null) continue;
    const status = agentIdStatus(agentId);
    if (status !== "dead") continue;
    let rawPid: string;
    try {
      rawPid = (await dependencies.readPidFile(name)).trim();
    } catch {
      continue;
    }
    if (!/^[1-9]\d*$/.test(rawPid)) continue;
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid)) continue;

    const command = await dependencies.processCommand(pid);
    if (command === null) {
      const state = await dependencies.processState(pid);
      if (state !== "dead") {
        throw new Error(
          `Hive cannot verify process ${pid} for dead agent ${agentId}; ` +
            "preserving its Codex app-server socket and pidfile",
        );
      }
    } else if (isCodexAppServer(command)) {
      let signaled = false;
      try {
        dependencies.kill(-pid);
        signaled = true;
      } catch {
        try {
          // Hosts created before process-group isolation need direct cleanup.
          dependencies.kill(pid);
          signaled = true;
        } catch {
          // The process exited between identification and the signal.
        }
      }
      let state: "live" | "dead" | "unknown" = "live";
      for (let attempt = 0; attempt < 50 && state !== "dead"; attempt += 1) {
        state = await dependencies.processState(pid);
        if (state !== "dead") await Bun.sleep(10);
      }
      if (state === "live") {
        throw new Error(`Codex app-server ${pid} is still running after reap`);
      }
      if (state === "unknown") {
        throw new Error(
          `Hive cannot verify exit of Codex app-server ${pid}; ` +
            "preserving its socket and pidfile",
        );
      }
      if (signaled) reaped.push(pid);
    }
    await removeVerifiedHostFile(name.slice(0, -".pid".length), dependencies);
    await removeVerifiedHostFile(name, dependencies);
  }
  return reaped;
}

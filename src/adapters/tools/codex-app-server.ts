import { createServer, connect, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import type { AgentRecord, HookEvent } from "../../schemas";
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
  }
}

class SocketTransport implements CodexAppServerTransport {
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
      if (newline < 0) return;
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
}

export interface CodexAppServerManagerOptions {
  socketPath?: (agent: AgentRecord) => string;
  transport?: (path: string) => Promise<CodexAppServerTransport>;
  commandRunner?: (argv: string[]) => Promise<number>;
  sleep?: (milliseconds: number) => Promise<void>;
  onEvent: (event: HookEvent) => Promise<void>;
  queueApproval: (request: CodexApprovalRequest) => Promise<string>;
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
  quotaBaselines: Map<string, CodexQuotaReading | null>;
  contextPct: number;
}

interface CodexQuotaSample {
  reading: CodexQuotaReading | null;
  observedAt: string;
}

interface PendingApproval {
  agentName: string;
  method: string;
  params: JsonObject;
  resolve: (approved: boolean) => void;
}

const defaultSocketPath = (agent: AgentRecord): string =>
  `/tmp/hive-codex-${agent.id.replaceAll(/[^A-Za-z0-9_-]/g, "-")}.sock`;

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

export class CodexAppServerManager {
  private readonly sessions = new Map<string, CodexSession>();
  private readonly approvals = new Map<string, PendingApproval>();
  private availability: Promise<boolean> | null = null;
  private readonly socketPath: (agent: AgentRecord) => string;
  private readonly transport: (path: string) => Promise<CodexAppServerTransport>;
  private readonly commandRunner: (argv: string[]) => Promise<number>;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: CodexAppServerManagerOptions) {
    this.socketPath = options.socketPath ?? defaultSocketPath;
    this.transport = options.transport ?? SocketTransport.connect;
    this.commandRunner = options.commandRunner ?? (async (argv) => {
      const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
      return child.exited;
    });
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  isAvailable(): Promise<boolean> {
    this.availability ??= this.commandRunner(["codex", "app-server", "--help"])
      .then((exitCode) => exitCode === 0, () => false);
    return this.availability;
  }

  buildHostCommand(agent: AgentRecord, daemonPort: number): string[] {
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
      "--agent",
      agent.name,
    ];
  }

  hasAgent(agentName: string): boolean {
    return this.sessions.has(agentName);
  }

  isTurnActive(agentName: string): boolean {
    const session = this.sessions.get(agentName);
    return session !== undefined && session.activeTurnId !== null;
  }

  async startAgent(
    agent: AgentRecord,
    prompt: string,
    readOnly: boolean,
    effort: string,
  ): Promise<void> {
    const transport = await this.connectWithRetry(this.socketPath(agent));
    const client = new CodexAppServerClient(transport, {
      notification: (message) => this.handleNotification(agent.name, message),
      request: (message) => this.handleRequest(agent.name, message),
    });
    try {
      await client.request("initialize", {
        clientInfo: { name: "hive", title: "Hive", version: "0.1.0" },
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
        sandbox: readOnly ? "read-only" : "workspace-write",
      }), "thread/start response");
      const thread = asObject(threadResult.thread, "thread");
      const session: CodexSession = {
        agent,
        client,
        threadId: stringField(thread, "id"),
        activeTurnId: null,
        quotaBaselines: new Map(),
        contextPct: 0,
      };
      this.sessions.set(agent.name, session);
      await this.options.onEvent({
        kind: "session-start",
        agentName: agent.name,
        timestamp: timestamp(),
      });
      await this.startTurn(agent, prompt, effort);
    } catch (error) {
      client.close();
      this.sessions.delete(agent.name);
      throw error;
    }
  }

  async startTurn(agent: AgentRecord, text: string, effort?: string): Promise<void> {
    const session = this.requireSession(agent.name);
    session.agent = agent;
    const quotaBaseline = (await this.readRateLimits(session).catch(() => null))
      ?.reading ?? null;
    const response = asObject(await session.client.request("turn/start", {
      threadId: session.threadId,
      input: [{ type: "text", text }],
      ...(effort === undefined ? {} : { effort }),
    }), "turn/start response");
    const turn = asObject(response.turn, "turn");
    session.activeTurnId = stringField(turn, "id");
    session.quotaBaselines.set(session.activeTurnId, quotaBaseline);
  }

  async steer(agent: AgentRecord, text: string): Promise<void> {
    const session = this.requireSession(agent.name);
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
    const session = this.requireSession(agent.name);
    if (options.interrupt === true && session.activeTurnId !== null) {
      await this.interruptAndStart(agent, text);
    } else if (session.activeTurnId !== null) {
      await this.steer(agent, text);
    } else {
      await this.startTurn(agent, text);
    }
  }

  async interrupt(agent: AgentRecord): Promise<void> {
    const session = this.sessions.get(agent.name);
    if (session === undefined || session.activeTurnId === null) return;
    await session.client.request("turn/interrupt", {
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });
  }

  async interruptAndStart(agent: AgentRecord, text: string): Promise<void> {
    const session = this.requireSession(agent.name);
    await this.interrupt(agent);
    for (let attempt = 0; attempt < 50 && session.activeTurnId !== null; attempt += 1) {
      await this.sleep(100);
    }
    if (session.activeTurnId !== null) {
      throw new Error(`Codex turn did not interrupt for ${agent.name}`);
    }
    await this.startTurn(agent, text);
  }

  async resolveApproval(id: string, approved: boolean): Promise<boolean> {
    const pending = this.approvals.get(id);
    if (pending === undefined) return false;
    this.approvals.delete(id);
    pending.resolve(approved);
    return true;
  }

  async denyAgentApprovals(agentName: string): Promise<void> {
    for (const [id, pending] of this.approvals) {
      if (pending.agentName !== agentName) continue;
      this.approvals.delete(id);
      pending.resolve(false);
    }
  }

  disconnect(agentName: string): void {
    const session = this.sessions.get(agentName);
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
      session.activeTurnId = stringField(turn, "id");
      await this.options.onEvent({
        kind: "turn-start",
        agentName,
        timestamp: timestamp(),
      });
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
      });
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
    const approvalId = await this.options.queueApproval({ agentName, description });
    const approved = await new Promise<boolean>((resolve) => {
      this.approvals.set(approvalId, { agentName, method, params, resolve });
    });
    return approvalResponse(method, params, approved);
  }
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

function approvalResponse(
  method: string,
  params: JsonObject,
  approved: boolean,
): unknown {
  if (method === "item/permissions/requestApproval") {
    const requested = asObject(params.permissions, "requested permissions");
    return {
      permissions: approved
        ? Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null))
        : {},
      scope: "turn",
    };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: approved ? "approved" : "denied" };
  }
  return { decision: approved ? "accept" : "decline" };
}

export function renderCodexViewerMessage(message: RpcMessage): string | null {
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
}

export async function runCodexAppServerHost(
  options: CodexAppServerHostOptions,
): Promise<number> {
  await unlink(options.socket).catch(() => undefined);
  const child = Bun.spawn([
    "codex",
    "app-server",
    "--stdio",
    "-c",
    `projects.${JSON.stringify(options.worktree)}.trust_level=\"trusted\"`,
    "-c",
    `mcp_servers.hive.url=${JSON.stringify(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
  ], {
    cwd: options.worktree,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stopChild = (): void => {
    try {
      child.kill();
    } catch {
      // The child already exited.
    }
  };
  process.once("SIGINT", stopChild);
  process.once("SIGTERM", stopChild);
  process.once("SIGHUP", stopChild);
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
    `Hive viewer for ${options.agentName} — Codex app-server event feed\n`,
  );
  const stdout = new Response(child.stdout).body!.getReader();
  const stderr = new Response(child.stderr).body!.getReader();
  const decode = new TextDecoder();
  const relayStdout = async (): Promise<void> => {
    while (true) {
      const { done, value } = await stdout.read();
      if (done) break;
      const text = decode.decode(value, { stream: true });
      client?.write(text);
      childBuffer += text;
      while (true) {
        const newline = childBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = childBuffer.slice(0, newline).trim();
        childBuffer = childBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        try {
          const rendered = renderCodexViewerMessage(JSON.parse(line) as RpcMessage);
          if (rendered !== null) process.stdout.write(rendered);
        } catch {
          // The daemon still receives the original frame; viewer rendering is
          // deliberately best-effort and never controls the agent.
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
  process.off("SIGINT", stopChild);
  process.off("SIGTERM", stopChild);
  process.off("SIGHUP", stopChild);
  server.close();
  (client as Socket | null)?.destroy();
  await unlink(options.socket).catch(() => undefined);
  return exitCode;
}

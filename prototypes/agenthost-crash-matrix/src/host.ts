import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedWal, isoNow, WalOverflowError } from "./wal";
import type {
  ChildIdentity,
  CommandEnvelope,
  HostConfig,
  InFlightPhase,
  ProviderLedger,
  ReconnectReport,
  RpcRequest,
  SemanticEvent,
  WalRecord,
} from "./types";

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "provider-fixture.ts");

function hash(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandForPid(pid: number): string {
  const child = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "command="]);
  return child.exitCode === 0 ? child.stdout.toString().trim() : "";
}

function killVerifiedProcessGroup(identity: ChildIdentity, ledgerPath: string): void {
  if (!processExists(identity.pid)) return;
  const command = commandForPid(identity.pid);
  if (!command.includes("provider-fixture.ts") || !command.includes(ledgerPath)) return;
  try {
    process.kill(-identity.processGroupId, "SIGKILL");
  } catch {
    try {
      process.kill(identity.pid, "SIGKILL");
    } catch {
      // It exited between identity verification and kill.
    }
  }
}

function withoutPrompt(command: CommandEnvelope): Omit<CommandEnvelope, "prompt"> {
  const { prompt: _prompt, ...safe } = command;
  return safe;
}

export class AgentHost {
  private readonly wal: BoundedWal;
  private readonly ledgerPath: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private childIdentity: ChildIdentity | null = null;
  private phase: InFlightPhase = "idle";
  private vendorSessionId: string | null = null;
  private currentCommand: CommandEnvelope | null = null;
  private pendingApprovalId: string | null = null;
  private providerBuffer = "";
  private providerQueue: Promise<void> = Promise.resolve();
  private barrierRelease: (() => void) | null = null;
  private barrierPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private recovering = false;

  constructor(readonly config: HostConfig) {
    mkdirSync(config.stateDir, { recursive: true });
    this.ledgerPath = join(config.stateDir, "provider-ledger.json");
    this.wal = new BoundedWal(join(config.stateDir, "host.wal.jsonl"), config.maxWalBytes);
    this.restore();
  }

  async start(): Promise<void> {
    const previousChild = this.latestChildIdentity();
    if (previousChild !== null) killVerifiedProcessGroup(previousChild, this.ledgerPath);
    if (this.phase === "terminal_durable" || this.phase === "unknown_outcome" ||
        this.phase === "wal_overflow") return;
    if (this.currentCommand === null) {
      this.spawnProvider(false);
      return;
    }
    const written = this.hasRecord("COMMAND_WRITTEN", this.currentCommand.commandId);
    if (!written) {
      await this.recordUnknown("accepted command had no durable terminal outcome after host loss");
      return;
    }
    await this.resumeOrUnknown("host_restart");
  }

  report(): ReconnectReport {
    const events = this.wal.events();
    const highWaterMark = this.wal.highWaterMark();
    return {
      tenantId: this.config.tenantId,
      childIdentity: this.childIdentity,
      vendorSessionId: this.vendorSessionId,
      lastAcceptedCommand: this.currentCommand === null ? null : withoutPrompt(this.currentCommand),
      lastEventSequence: events.at(-1)?.sequence ?? 0,
      highWaterMark,
      inFlightPhase: this.phase,
      pendingApprovalId: this.pendingApprovalId,
      replay: events.filter((event) => event.sequence > highWaterMark),
    };
  }

  async accept(command: CommandEnvelope): Promise<void> {
    if (command.sessionEpoch !== 0) throw new Error("stale session epoch");
    const existing = this.currentCommand;
    if (existing !== null) {
      if (existing.commandId === command.commandId) return;
      throw new Error("a command is already accepted for this prototype session");
    }
    this.currentCommand = command;
    this.phase = "before_accept";
    await this.pauseAt("before_accept");
    if (this.commandCannotContinue()) return;
    this.append({ kind: "ACCEPTED", at: isoNow(), command: withoutPrompt(command) });
    this.phase = "accepted";
    await this.pauseAt("after_accept_before_write");
    if (this.commandCannotContinue()) return;
    if (this.child === null || this.child.stdin.destroyed) {
      await this.recordUnknown("provider unavailable after ACCEPTED and before write");
      return;
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.child!.stdin.write(`${JSON.stringify({
        type: "command",
        commandId: command.commandId,
        prompt: command.prompt,
      })}\n`, (error) => error ? rejectWrite(error) : resolveWrite());
    }).catch(async () => {
      await this.recordUnknown("provider pipe failed while writing an accepted command");
    });
    if (this.commandCannotContinue()) return;
    this.append({ kind: "COMMAND_WRITTEN", at: isoNow(), commandId: command.commandId });
    this.phase = "written";
    await this.pauseAt("after_write_before_first_event");
  }

  releaseBoundary(): void {
    this.barrierRelease?.();
    this.barrierRelease = null;
    this.barrierPromise = null;
  }

  async approve(approvalId: string, decision: "approve" | "deny"): Promise<void> {
    const duplicate = this.wal.all().some((record) =>
      record.kind === "APPROVAL_WRITTEN" && record.approvalId === approvalId
    );
    if (duplicate) return;
    if (this.pendingApprovalId !== approvalId) throw new Error("approval is not pending");
    this.append({ kind: "APPROVAL_WRITTEN", at: isoNow(), approvalId, decision });
    if (this.child === null || this.child.stdin.destroyed) {
      await this.recordUnknown("approval was accepted but provider delivery is ambiguous");
      return;
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.child!.stdin.write(`${JSON.stringify({ type: "approval", approvalId, decision })}\n`,
        (error) => error ? rejectWrite(error) : resolveWrite());
    }).catch(async () => {
      await this.recordUnknown("approval pipe failed after durable acceptance");
    });
    this.pendingApprovalId = null;
    if (this.phase !== "unknown_outcome") this.phase = "running";
  }

  acknowledge(highWaterMark: number): void {
    const lastSequence = this.wal.events().at(-1)?.sequence ?? 0;
    if (highWaterMark < this.wal.highWaterMark() || highWaterMark > lastSequence) {
      throw new Error("invalid broker high-water mark");
    }
    this.append({ kind: "ACK", at: isoNow(), highWaterMark });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.releaseBoundary();
    const identity = this.childIdentity;
    if (identity !== null) killVerifiedProcessGroup(identity, this.ledgerPath);
    this.child?.stdin.destroy();
    this.child = null;
  }

  private restore(): void {
    const records = this.wal.all();
    const accepted = [...records].reverse().find(
      (record): record is Extract<WalRecord, { kind: "ACCEPTED" }> => record.kind === "ACCEPTED",
    );
    if (accepted !== undefined) {
      this.currentCommand = { ...accepted.command, prompt: "[prompt intentionally absent from WAL]" };
    }
    const events = this.wal.events();
    for (const event of events) {
      if (event.type === "session_started" && typeof event.payload.vendorSessionId === "string") {
        this.vendorSessionId = event.payload.vendorSessionId;
      }
      if (event.type === "approval_requested" && typeof event.payload.approvalId === "string") {
        this.pendingApprovalId = event.payload.approvalId;
      }
      if (event.type === "tool_result") this.pendingApprovalId = null;
    }
    const terminal = events.at(-1);
    if (existsSync(join(this.config.stateDir, "wal-overflow.json"))) this.phase = "wal_overflow";
    else if (terminal?.type === "turn_completed") this.phase = "terminal_durable";
    else if (terminal?.type === "UNKNOWN_OUTCOME") this.phase = "unknown_outcome";
    else if (this.pendingApprovalId !== null) this.phase = "awaiting_approval";
    else if (this.currentCommand !== null) {
      this.phase = this.hasRecord("COMMAND_WRITTEN", this.currentCommand.commandId)
        ? "written"
        : "accepted";
    }
  }

  private latestChildIdentity(): ChildIdentity | null {
    const record = [...this.wal.all()].reverse().find(
      (candidate): candidate is Extract<WalRecord, { kind: "CHILD" }> => candidate.kind === "CHILD",
    );
    return record?.child ?? null;
  }

  private hasRecord(kind: WalRecord["kind"], commandId: string): boolean {
    return this.wal.all().some((record) =>
      record.kind === kind && "commandId" in record && record.commandId === commandId
    );
  }

  private spawnProvider(resume: boolean): void {
    const executable = process.execPath;
    const argv = [fixturePath, "--vendor", this.config.vendor, "--ledger", this.ledgerPath,
      "--resume", String(resume)];
    const child = spawn(executable, argv, {
      cwd: this.config.stateDir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid === undefined) throw new Error("provider fixture did not start");
    this.child = child;
    this.providerBuffer = "";
    const identity: ChildIdentity = {
      pid: child.pid,
      processGroupId: child.pid,
      executable,
      executableBindingHash: hash(Buffer.concat([
        readFileSync(executable),
        readFileSync(fixturePath),
      ])),
      argvHash: hash(argv.join("\0")),
      vendor: this.config.vendor,
    };
    this.childIdentity = identity;
    this.append({ kind: "CHILD", at: isoNow(), child: identity });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.providerQueue = this.providerQueue.then(() => this.consumeProvider(chunk)).catch((error) => {
        if (!(error instanceof WalOverflowError)) {
          writeFileSync(join(this.config.stateDir, "host.error.log"), `${String(error)}\n`, { flag: "a" });
        }
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      writeFileSync(join(this.config.stateDir, "provider.stderr.log"), chunk, { flag: "a" });
    });
    child.once("exit", () => {
      if (this.child === child) this.child = null;
      if (!this.shuttingDown && this.phase !== "terminal_durable" &&
          this.phase !== "unknown_outcome" && !this.recovering) {
        void this.resumeOrUnknown("provider_exit");
      }
    });
  }

  private async consumeProvider(chunk: string): Promise<void> {
    this.providerBuffer += chunk;
    while (true) {
      const newline = this.providerBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.providerBuffer.slice(0, newline).trim();
      this.providerBuffer = this.providerBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line) as {
        type: string;
        providerEventId: string;
        payload: Record<string, unknown>;
      };
      if (this.wal.events().some((event) => event.providerEventId === message.providerEventId)) continue;
      if (this.phase === "written") await this.pauseAt("after_write_before_first_event");
      if (message.type === "assistant_final") {
        this.phase = "provider_final";
        await this.pauseAt("after_provider_final_before_wal");
      }
      const commandId = this.currentCommand?.commandId ?? "none";
      const sequence = (this.wal.events().at(-1)?.sequence ?? 0) + 1;
      const event: SemanticEvent = {
        sequence,
        providerEventId: message.providerEventId,
        commandId,
        brokerGeneration: this.currentCommand?.brokerGeneration ?? 0,
        sessionEpoch: this.currentCommand?.sessionEpoch ?? 0,
        observedAt: isoNow(),
        type: message.type,
        payload: message.payload,
      };
      this.append({ kind: "EVENT", at: isoNow(), event });
      if (message.type === "session_started" && typeof message.payload.vendorSessionId === "string") {
        this.vendorSessionId = message.payload.vendorSessionId;
      }
      if (message.type === "approval_requested" && typeof message.payload.approvalId === "string") {
        this.pendingApprovalId = message.payload.approvalId;
        this.phase = "awaiting_approval";
        await this.pauseAt("during_tool_approval");
      } else if (message.type === "turn_completed") {
        this.phase = "terminal_durable";
        await this.pauseAt("after_wal_before_broker_ack");
      } else if (message.type !== "assistant_final") {
        this.phase = "running";
      }
    }
  }

  private async resumeOrUnknown(reason: string): Promise<void> {
    if (this.recovering || this.shuttingDown || this.phase === "terminal_durable" ||
        this.phase === "unknown_outcome") return;
    this.recovering = true;
    try {
      const accepted = this.wal.all().some((record) => record.kind === "ACCEPTED");
      if (!accepted) {
        this.spawnProvider(false);
        return;
      }
      if (!existsSync(this.ledgerPath)) {
        await this.recordUnknown(`${reason}: provider has no durable vendor session`);
        return;
      }
      const ledger = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as ProviderLedger;
      if (ledger.commandId !== this.currentCommand?.commandId || ledger.state === "idle") {
        await this.recordUnknown(`${reason}: provider session cannot reconcile accepted command`);
        return;
      }
      const approvalWasWritten = this.pendingApprovalId !== null && this.wal.all().some((record) =>
        record.kind === "APPROVAL_WRITTEN" && record.approvalId === this.pendingApprovalId
      );
      const toolResultIsDurable = this.wal.events().some((event) => event.type === "tool_result");
      if (approvalWasWritten && !toolResultIsDurable && ledger.state !== "completed") {
        await this.recordUnknown(`${reason}: approval delivery has no durable provider outcome`);
        return;
      }
      this.vendorSessionId = ledger.vendorSessionId;
      const sequence = (this.wal.events().at(-1)?.sequence ?? 0) + 1;
      this.append({
        kind: "EVENT",
        at: isoNow(),
        event: {
          sequence,
          providerEventId: `host:${this.currentCommand!.commandId}:resume:${sequence}`,
          commandId: this.currentCommand!.commandId,
          brokerGeneration: this.currentCommand!.brokerGeneration,
          sessionEpoch: this.currentCommand!.sessionEpoch,
          observedAt: isoNow(),
          type: "provider_resumed",
          payload: { reason, vendorSessionId: ledger.vendorSessionId },
        },
      });
      this.spawnProvider(true);
      this.phase = ledger.state === "pending_approval" ? "awaiting_approval" : "running";
    } finally {
      this.recovering = false;
    }
  }

  private async recordUnknown(reason: string): Promise<void> {
    if (this.phase === "unknown_outcome") return;
    const sequence = (this.wal.events().at(-1)?.sequence ?? 0) + 1;
    this.append({
      kind: "EVENT",
      at: isoNow(),
      event: {
        sequence,
        providerEventId: `host:${this.currentCommand?.commandId ?? "none"}:unknown`,
        commandId: this.currentCommand?.commandId ?? "none",
        brokerGeneration: this.currentCommand?.brokerGeneration ?? 0,
        sessionEpoch: this.currentCommand?.sessionEpoch ?? 0,
        observedAt: isoNow(),
        type: "UNKNOWN_OUTCOME",
        payload: { reason },
      },
    });
    this.phase = "unknown_outcome";
    this.pendingApprovalId = null;
    this.releaseBoundary();
    const identity = this.childIdentity;
    if (identity !== null) killVerifiedProcessGroup(identity, this.ledgerPath);
  }

  private append(record: WalRecord): void {
    try {
      this.wal.append(record);
    } catch (error) {
      if (!(error instanceof WalOverflowError)) throw error;
      this.phase = "wal_overflow";
      writeFileSync(join(this.config.stateDir, "wal-overflow.json"), `${JSON.stringify({
        at: isoNow(),
        reason: error.message,
      })}\n`, { mode: 0o600 });
      const identity = this.childIdentity;
      if (identity !== null) killVerifiedProcessGroup(identity, this.ledgerPath);
      throw error;
    }
  }

  private async pauseAt(boundary: HostConfig["boundary"]): Promise<void> {
    if (this.config.boundary !== boundary) return;
    const marker = join(this.config.stateDir, "boundary.json");
    if (existsSync(marker)) return;
    writeFileSync(marker, `${JSON.stringify({ boundary, at: isoNow(), pid: process.pid })}\n`, {
      mode: 0o600,
    });
    this.barrierPromise = new Promise<void>((resolveBarrier) => {
      this.barrierRelease = resolveBarrier;
    });
    await this.barrierPromise;
  }

  private commandCannotContinue(): boolean {
    return this.phase === "unknown_outcome" || this.phase === "wal_overflow" || this.shuttingDown;
  }
}

function authorized(config: HostConfig, request: RpcRequest): void {
  if (request.tenantId !== config.tenantId || request.authToken !== config.authToken) {
    throw new Error("unauthorized tenant or capability");
  }
}

export async function serve(config: HostConfig): Promise<void> {
  const host = new AgentHost(config);
  await host.start();
  mkdirSync(dirname(config.socketPath), { recursive: true });
  if (existsSync(config.socketPath)) unlinkSync(config.socketPath);
  const server = createServer((socket) => handleSocket(host, config, socket, server));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.socketPath, () => resolveListen());
  });
  chmodSync(config.socketPath, 0o600);
  const shutdown = async () => {
    await host.shutdown();
    server.close();
    if (existsSync(config.socketPath)) unlinkSync(config.socketPath);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

function handleSocket(
  host: AgentHost,
  config: HostConfig,
  socket: Socket,
  server: ReturnType<typeof createServer>,
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      void (async () => {
        try {
          const request = JSON.parse(line) as RpcRequest;
          authorized(config, request);
          let result: unknown = {};
          if (request.action === "start") {
            if (request.command === undefined) throw new Error("command required");
            void host.accept(request.command).catch(() => undefined);
            result = { acceptedForProcessing: true };
          } else if (request.action === "snapshot") {
            result = host.report();
          } else if (request.action === "release") {
            host.releaseBoundary();
          } else if (request.action === "approve") {
            if (request.approvalId === undefined || request.decision === undefined) {
              throw new Error("approval decision required");
            }
            await host.approve(request.approvalId, request.decision);
          } else if (request.action === "ack") {
            if (request.highWaterMark === undefined) throw new Error("high-water mark required");
            host.acknowledge(request.highWaterMark);
          } else if (request.action === "shutdown") {
            await host.shutdown();
            server.close();
            if (existsSync(config.socketPath)) unlinkSync(config.socketPath);
            result = { stopped: true };
          }
          socket.write(`${JSON.stringify({ ok: true, result })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })}\n`);
        }
      })();
    }
  });
}

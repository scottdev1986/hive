import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedWal, isoNow } from "./wal";
import type { ChildIdentity, SemanticEvent, Vendor } from "./types";

interface LiveEvidence {
  provider: Vendor;
  cliVersion: string;
  executableBindingHash: string;
  childIdentity: ChildIdentity;
  vendorSessionId: string;
  acceptedBeforeWrite: boolean;
  eventCount: number;
  eventTypes: string[];
  itemTypes: string[];
  monotonicSequences: boolean;
  toolObserved: boolean;
  approvalObserved: boolean;
  approvalDecisions: number;
  terminalObserved: boolean;
  expectedFinalObserved: boolean;
  highWaterMark: number;
  processGroupReaped: boolean;
  protocol: string;
  caveat: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(root, "evidence");
const permissionServerPath = join(root, "src", "permission-server.ts");

function executable(name: string): string {
  const userInstall = join(process.env.HOME ?? "", ".local", "bin", name);
  if (existsSync(userInstall)) return userInstall;
  const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${name} is not installed`);
  return result.stdout.trim();
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sanitizedIdentity(identity: ChildIdentity): ChildIdentity {
  const home = process.env.HOME;
  return {
    ...identity,
    executable: home === undefined ? identity.executable : identity.executable.replace(home, "$HOME"),
  };
}

function sanitizedSessionId(sessionId: string): string {
  return `sha256:${createHash("sha256").update(sessionId).digest("hex")}`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message())), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopGroup(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  if (child.pid === undefined) return true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  for (let index = 0; index < 50 && processExists(child.pid); index += 1) await Bun.sleep(20);
  if (processExists(child.pid)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await Bun.sleep(20);
  return !processExists(child.pid);
}

class LiveJournal {
  readonly wal: BoundedWal;
  private nextSequence = 1;

  constructor(path: string, readonly commandId: string) {
    this.wal = new BoundedWal(path, 256 * 1024);
  }

  child(identity: ChildIdentity): void {
    this.wal.append({ kind: "CHILD", at: isoNow(), child: identity });
  }

  accepted(): void {
    this.wal.append({
      kind: "ACCEPTED",
      at: isoNow(),
      command: { commandId: this.commandId, brokerGeneration: 1, sessionEpoch: 0 },
    });
  }

  written(): void {
    this.wal.append({ kind: "COMMAND_WRITTEN", at: isoNow(), commandId: this.commandId });
  }

  approval(approvalId: string): void {
    this.wal.append({
      kind: "APPROVAL_WRITTEN",
      at: isoNow(),
      approvalId,
      decision: "deny",
    });
  }

  event(type: string, providerEventId: string, payload: Record<string, unknown> = {}): void {
    const event: SemanticEvent = {
      sequence: this.nextSequence++,
      providerEventId,
      commandId: this.commandId,
      brokerGeneration: 1,
      sessionEpoch: 0,
      observedAt: isoNow(),
      type,
      payload,
    };
    this.wal.append({ kind: "EVENT", at: isoNow(), event });
  }

  acknowledge(): number {
    const highWaterMark = this.wal.events().at(-1)?.sequence ?? 0;
    this.wal.append({ kind: "ACK", at: isoNow(), highWaterMark });
    return highWaterMark;
  }
}

function identityFor(child: ChildProcessWithoutNullStreams, path: string, argv: string[], vendor: Vendor): ChildIdentity {
  if (child.pid === undefined) throw new Error(`${vendor} did not start`);
  return {
    pid: child.pid,
    processGroupId: child.pid,
    executable: path,
    executableBindingHash: digestFile(path),
    argvHash: createHash("sha256").update(argv.join("\0")).digest("hex"),
    vendor,
  };
}

async function driveClaude(runDir: string): Promise<LiveEvidence> {
  const path = executable("claude");
  const versionResult = Bun.spawnSync([path, "--version"]);
  const version = `${versionResult.stdout.toString()}${versionResult.stderr.toString()}`.trim();
  const commandId = `live-claude-${randomUUID()}`;
  const journal = new LiveJournal(join(runDir, "claude.wal.jsonl"), commandId);
  const marker = join(tmpdir(), `${commandId}.txt`);
  const approvalRequestPath = join(runDir, "approval-request.json");
  const approvalDecisionPath = join(runDir, "approval-decision.json");
  const mcpConfigPath = join(runDir, "mcp.json");
  writeFileSync(mcpConfigPath, `${JSON.stringify({
    mcpServers: {
      agenthost: {
        command: process.execPath,
        args: [permissionServerPath],
        env: {
          AGENTHOST_APPROVAL_REQUEST: approvalRequestPath,
          AGENTHOST_APPROVAL_DECISION: approvalDecisionPath,
        },
      },
    },
  }, null, 2)}\n`);
  const argv = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--permission-prompt-tool", "mcp__agenthost__permission_prompt",
    "--permission-mode", "default",
    "--settings", "{}",
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
  ];
  const child = spawn(path, argv, { cwd: runDir, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const identity = identityFor(child, path, argv, "claude");
  journal.child(identity);
  let buffer = "";
  let stderr = "";
  let vendorSessionId = "unknown";
  let toolObserved = false;
  let approvalObserved = false;
  let approvalDecisions = 0;
  let terminalObserved = false;
  let expectedFinalObserved = false;
  let eventIndex = 0;
  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolvePromise) => { resolveTerminal = resolvePromise; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, any>;
      eventIndex += 1;
      const type = String(message.type ?? "unknown");
      if (typeof message.session_id === "string") vendorSessionId = message.session_id;
      if (type === "system" && typeof message.session_id === "string") {
        vendorSessionId = message.session_id;
      }
      const content = Array.isArray(message.message?.content) ? message.message.content : [];
      if (content.some((item: Record<string, unknown>) => item.type === "tool_use")) toolObserved = true;
      if (type === "control_request" && message.request?.subtype === "can_use_tool") {
        toolObserved = true;
        approvalObserved = true;
        const approvalId = String(message.request_id);
        journal.event("approval_requested", `claude:${eventIndex}`, {
          approvalId,
          toolName: String(message.request?.tool_name ?? "unknown"),
        });
        journal.approval(approvalId);
        approvalDecisions += 1;
        child.stdin.write(`${JSON.stringify({
          type: "control_response",
          request_id: message.request_id,
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: { behavior: "deny", message: "DENIED_BY_AGENTHOST_PROTOTYPE" },
          },
        })}\n`);
        continue;
      }
      if (type === "result") {
        terminalObserved = true;
        expectedFinalObserved = String(message.result ?? "").includes("CLAUDE_CRASH_MATRIX_COMPLETE");
      }
      journal.event(type, `claude:${eventIndex}`, {
        terminal: type === "result",
        hasToolUse: content.some((item: Record<string, unknown>) => item.type === "tool_use"),
      });
      if (type === "result") resolveTerminal();
    }
  });
  journal.accepted();
  const prompt = {
    type: "user",
    message: {
      role: "user",
      content: `Attempt exactly once to use the Write tool to create ${marker}. The host will deny permission. Do not retry or use another tool after denial; reply exactly CLAUDE_CRASH_MATRIX_COMPLETE.`,
    },
  };
  await new Promise<void>((resolveWrite, rejectWrite) => {
    child.stdin.write(`${JSON.stringify(prompt)}\n`, (error) => error ? rejectWrite(error) : resolveWrite());
  });
  journal.written();
  const relayedApproval = (async () => {
    for (let attempt = 0; attempt < 6_000 && !existsSync(approvalRequestPath); attempt += 1) {
      await Bun.sleep(10);
    }
    if (!existsSync(approvalRequestPath)) throw new Error("Claude permission relay never requested approval");
    const request = JSON.parse(readFileSync(approvalRequestPath, "utf8")) as { approvalId: string };
    approvalObserved = true;
    approvalDecisions += 1;
    journal.event("approval_requested", `claude:mcp:${request.approvalId}`, {
      approvalId: request.approvalId,
      transport: "permission_mcp",
    });
    journal.approval(request.approvalId);
    writeFileSync(approvalDecisionPath, `${JSON.stringify({ behavior: "deny" })}\n`, { mode: 0o600 });
  })();
  await withTimeout(
    Promise.all([terminal, relayedApproval]),
    120_000,
    () => `Claude live run timed out: ${stderr}`,
  );
  const highWaterMark = journal.acknowledge();
  const processGroupReaped = await stopGroup(child);
  const events = journal.wal.events();
  return {
    provider: "claude",
    cliVersion: version,
    executableBindingHash: identity.executableBindingHash,
    childIdentity: sanitizedIdentity(identity),
    vendorSessionId: sanitizedSessionId(vendorSessionId),
    acceptedBeforeWrite: journal.wal.all().findIndex((record) => record.kind === "ACCEPTED") <
      journal.wal.all().findIndex((record) => record.kind === "COMMAND_WRITTEN"),
    eventCount: events.length,
    eventTypes: [...new Set(events.map((event) => event.type))],
    itemTypes: [],
    monotonicSequences: events.every((event, index) => event.sequence === index + 1),
    toolObserved,
    approvalObserved,
    approvalDecisions,
    terminalObserved,
    expectedFinalObserved,
    highWaterMark,
    processGroupReaped,
    protocol: "claude stream-json with can_use_tool control requests",
    caveat: "The permission control flag is absent from Claude Code 2.1.206 --help and remains version-gated.",
  };
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { message?: string };
}

async function driveCodex(runDir: string): Promise<LiveEvidence> {
  const path = executable("codex");
  const versionResult = Bun.spawnSync([path, "--version"]);
  const version = `${versionResult.stdout.toString()}${versionResult.stderr.toString()}`.trim();
  const commandId = `live-codex-${randomUUID()}`;
  const journal = new LiveJournal(join(runDir, "codex.wal.jsonl"), commandId);
  const argv = ["app-server", "--stdio", "-c",
    `projects.${JSON.stringify(runDir)}.trust_level=\"trusted\"`];
  const child = spawn(path, argv, { cwd: runDir, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const identity = identityFor(child, path, argv, "codex");
  journal.child(identity);
  let requestId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let buffer = "";
  let stderr = "";
  let eventIndex = 0;
  let toolObserved = false;
  let approvalObserved = false;
  let approvalDecisions = 0;
  let terminalObserved = false;
  let expectedFinalObserved = false;
  let assistantText = "";
  const itemTypes = new Set<string>();
  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolvePromise) => { resolveTerminal = resolvePromise; });
  const send = (message: RpcMessage) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params?: Record<string, any>) => new Promise<any>((resolveRequest, rejectRequest) => {
    const id = requestId++;
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    send({ id, method, ...(params === undefined ? {} : { params }) });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as RpcMessage;
      if (message.id !== undefined && message.method === undefined) {
        const waiter = pending.get(message.id);
        if (waiter !== undefined) {
          pending.delete(message.id);
          if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? "Codex RPC error"));
          else waiter.resolve(message.result);
        }
        continue;
      }
      eventIndex += 1;
      const method = String(message.method ?? "unknown");
      const item = message.params?.item ?? {};
      if (typeof item.type === "string") itemTypes.add(item.type);
      if (method === "item/started" && ["commandExecution", "fileChange"].includes(item.type)) {
        toolObserved = true;
      }
      if (method === "item/agentMessage/delta" && typeof message.params?.delta === "string") {
        assistantText += message.params.delta;
      }
      if (message.id !== undefined && (
        method.includes("requestApproval") || method === "execCommandApproval" || method === "applyPatchApproval"
      )) {
        approvalObserved = true;
        toolObserved = true;
        approvalDecisions += 1;
        journal.event("approval_requested", `codex:${eventIndex}`, {
          approvalId: String(message.id),
          method,
        });
        journal.approval(String(message.id));
        const result = method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" }
          : method === "execCommandApproval" || method === "applyPatchApproval"
            ? { decision: "denied" }
            : { decision: "decline" };
        send({ id: message.id, result });
        continue;
      }
      if (message.id !== undefined) {
        send({ id: message.id, result: { decision: "decline" } });
        continue;
      }
      if (method === "turn/completed") {
        terminalObserved = true;
        expectedFinalObserved = assistantText.includes("CODEX_CRASH_MATRIX_COMPLETE");
      }
      journal.event(method, `codex:${eventIndex}`, {
        terminal: method === "turn/completed",
        itemType: typeof item.type === "string" ? item.type : undefined,
      });
      if (method === "turn/completed") resolveTerminal();
    }
  });

  await request("initialize", {
    clientInfo: { name: "hive-agenthost-prototype", title: "Hive AgentHost Prototype", version: "0.1.0" },
    capabilities: { experimentalApi: false },
  });
  send({ method: "initialized" });
  const threadResult = await request("thread/start", {
    cwd: runDir,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  const vendorSessionId = String(threadResult.thread.id);
  journal.accepted();
  await request("turn/start", {
    threadId: vendorSessionId,
    input: [{
      type: "text",
      text: `You must invoke the shell tool exactly once with this command: printf AGENTHOST > /etc/${commandId}.txt. Do not merely discuss or simulate it, and do not reply before receiving the real tool result. If permission is denied, do not retry or use another tool; reply exactly CODEX_CRASH_MATRIX_COMPLETE.`,
    }],
  });
  journal.written();
  await withTimeout(terminal, 120_000, () => `Codex live run timed out: ${stderr}`);
  const highWaterMark = journal.acknowledge();
  const processGroupReaped = await stopGroup(child);
  const events = journal.wal.events();
  return {
    provider: "codex",
    cliVersion: version,
    executableBindingHash: identity.executableBindingHash,
    childIdentity: sanitizedIdentity(identity),
    vendorSessionId: sanitizedSessionId(vendorSessionId),
    acceptedBeforeWrite: journal.wal.all().findIndex((record) => record.kind === "ACCEPTED") <
      journal.wal.all().findIndex((record) => record.kind === "COMMAND_WRITTEN"),
    eventCount: events.length,
    eventTypes: [...new Set(events.map((event) => event.type))],
    itemTypes: [...itemTypes],
    monotonicSequences: events.every((event, index) => event.sequence === index + 1),
    toolObserved,
    approvalObserved,
    approvalDecisions,
    terminalObserved,
    expectedFinalObserved,
    highWaterMark,
    processGroupReaped,
    protocol: "Codex app-server JSON-RPC",
    caveat: "Codex app-server is experimental and exposes no numeric protocol version in initialize.",
  };
}

mkdirSync(evidenceDir, { recursive: true });
const runDir = mkdtempSync(join(tmpdir(), "hive-agenthost-live-"));
try {
  process.stdout.write("driving installed Claude Code through a denied tool task\n");
  mkdirSync(join(runDir, "claude"), { recursive: true });
  const claude = await driveClaude(join(runDir, "claude"));
  process.stdout.write("driving installed Codex through a denied tool task\n");
  mkdirSync(join(runDir, "codex"), { recursive: true });
  const codex = await driveCodex(join(runDir, "codex"));
  const providers = [claude, codex];
  const invalid = providers.filter((provider) => !provider.acceptedBeforeWrite ||
    !provider.monotonicSequences || !provider.toolObserved || !provider.approvalObserved ||
    provider.approvalDecisions !== 1 || !provider.terminalObserved ||
    !provider.expectedFinalObserved || !provider.processGroupReaped);
  writeFileSync(join(evidenceDir, "live-providers.json"), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    providers,
  }, null, 2)}\n`);
  if (invalid.length > 0) {
    throw new Error(`live provider contract failed: ${invalid.map((provider) => provider.provider).join(", ")}`);
  }
  process.stdout.write("wrote green live provider evidence to evidence/live-providers.json\n");
} finally {
  rmSync(runDir, { recursive: true, force: true });
}

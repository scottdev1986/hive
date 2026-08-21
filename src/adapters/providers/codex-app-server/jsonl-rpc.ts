import { isRecord } from "../../../shared/is-record";
import {
  type JsonValue,
  requireJsonValue,
  safeJsonParse,
} from "../../../shared/json";
import { terminateProcessGroup } from "../protocol/process-group";
import { errorMessage } from "../../../shared/error-message";

type RequestId = number | string;

export type CodexAppServerMessage = Readonly<Record<string, unknown>>;

export interface CodexAppServerWire {
  readonly adapterChild?: {
    readonly pid: number;
    readonly processGroupId: number;
  };
  readonly incoming: AsyncIterable<CodexAppServerMessage>;
  readonly closed: Promise<{
    readonly exitCode: number | null;
    readonly reason: string;
  }>;
  request(method: string, params?: unknown): Promise<JsonValue>;
  notify(method: string, params?: unknown): void;
  respond(id: RequestId, result: unknown): void;
  reject(id: RequestId, code: number, message: string): void;
  close(): Promise<void>;
}

export interface CodexAppServerWireSpawn {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type CodexAppServerWireFactory = (
  spawn: CodexAppServerWireSpawn,
) => Promise<CodexAppServerWire>;

export class CodexAppServerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

export class CodexAppServerUnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerUnknownOutcomeError";
  }
}

class AsyncMessageQueue {
  private readonly buffered: CodexAppServerMessage[] = [];
  private readonly waiting: Array<
    (value: IteratorResult<CodexAppServerMessage>) => void
  > = [];
  private ended = false;

  push(message: CodexAppServerMessage): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter === undefined) {
      this.buffered.push(message);
    } else {
      waiter({ value: message, done: false });
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<CodexAppServerMessage>> {
    const message = this.buffered.shift();
    if (message !== undefined) {
      return Promise.resolve({ value: message, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
}

interface CodexProcess {
  readonly pid: number;
  readonly stdin: Bun.FileSink;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${id}`;
}

function isRequestId(value: unknown): value is RequestId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

async function waitForExit(
  child: CodexProcess,
  milliseconds: number,
): Promise<boolean> {
  return Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), milliseconds),
    ),
  ]);
}

function signalProcessGroup(child: CodexProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export class JsonlCodexAppServerWire implements CodexAppServerWire {
  readonly incoming: AsyncIterable<CodexAppServerMessage>;
  readonly closed: Promise<{
    readonly exitCode: number | null;
    readonly reason: string;
  }>;

  get adapterChild(): { pid: number; processGroupId: number } {
    return { pid: this.child.pid, processGroupId: this.child.pid };
  }

  private readonly queue = new AsyncMessageQueue();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly child: CodexProcess;
  private nextRequestId = 1;
  private closing = false;
  private dropped = false;

  constructor(spawn: CodexAppServerWireSpawn) {
    this.child = Bun.spawn({
      cmd: [spawn.executable, "app-server", "--stdio", ...spawn.argv],
      cwd: spawn.cwd,
      env: { ...spawn.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    }) as CodexProcess;
    this.incoming = {
      [Symbol.asyncIterator]: () => ({ next: () => this.queue.next() }),
    };
    this.closed = this.observeExit();
    void this.readStdout();
    void new Response(this.child.stderr).text();
  }

  request(method: string, params?: unknown): Promise<JsonValue> {
    if (this.dropped || this.closing) {
      return Promise.reject(
        new CodexAppServerUnknownOutcomeError(
          `${method}: app-server connection is closed`,
        ),
      );
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(requestKey(id), { method, resolve, reject });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(requestKey(id));
        reject(
          new CodexAppServerUnknownOutcomeError(
            `${method}: ${errorMessage(error)}`,
          ),
        );
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  reject(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.child.exited;
      return;
    }
    this.closing = true;
    this.child.stdin.end();
    if (!(await waitForExit(this.child, 500))) {
      signalProcessGroup(this.child, "SIGTERM");
    }
    if (!(await waitForExit(this.child, 1_000))) {
      signalProcessGroup(this.child, "SIGKILL");
    }
    await this.child.exited;
    await terminateProcessGroup(this.child.pid, 500);
  }

  private write(message: unknown): void {
    if (this.dropped || this.closing) {
      throw new CodexAppServerUnknownOutcomeError(
        "app-server connection is closed",
      );
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.child.stdin.flush();
  }

  private async readStdout(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line !== "") this.acceptLine(line);
          newline = buffered.indexOf("\n");
        }
      }
      buffered += decoder.decode();
      const finalLine = buffered.trim();
      if (finalLine !== "") this.acceptLine(finalLine);
    } finally {
      reader.releaseLock();
      this.markDropped("app-server stdout closed");
    }
  }

  private acceptLine(line: string): void {
    const message = safeJsonParse(line);
    if (message === undefined) {
      this.queue.push({ method: "hive/malformed", rawLine: line });
      return;
    }
    if (!isRecord(message)) {
      this.queue.push({ method: "hive/malformed", payload: message });
      return;
    }
    if (isRequestId(message.id) && !("method" in message)) {
      const key = requestKey(message.id);
      const pending = this.pending.get(key);
      if (pending === undefined || this.dropped) return;
      this.pending.delete(key);
      if (isRecord(message.error)) {
        const code =
          typeof message.error.code === "number" ? message.error.code : -32_000;
        const errorMessage =
          typeof message.error.message === "string"
            ? message.error.message
            : `${pending.method}: app-server rejected request`;
        pending.reject(
          new CodexAppServerRpcError(code, errorMessage, message.error.data),
        );
      } else {
        pending.resolve(
          message.result === undefined
            ? null
            : requireJsonValue(message.result, pending.method),
        );
      }
      return;
    }
    this.queue.push(message);
  }

  private async observeExit(): Promise<{
    readonly exitCode: number | null;
    readonly reason: string;
  }> {
    const exitCode = await this.child.exited;
    const reason = this.closing
      ? "closed by Hive"
      : `app-server exited ${exitCode}`;
    this.markDropped(reason);
    return { exitCode, reason };
  }

  private markDropped(reason: string): void {
    if (this.dropped) return;
    this.dropped = true;
    const error = new CodexAppServerUnknownOutcomeError(reason);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.queue.end();
  }
}

export const spawnCodexAppServerWire: CodexAppServerWireFactory = (spawn) =>
  Promise.resolve(new JsonlCodexAppServerWire(spawn));

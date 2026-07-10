import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { cleanEnvironment } from "./binding";

type JsonObject = Record<string, unknown>;

interface Waiter {
  predicate: (message: JsonObject) => boolean;
  resolve: (message: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface JsonTransport {
  readonly capturedMessages: readonly JsonObject[];
  send(message: JsonObject): void;
  waitFor(
    predicate: (message: JsonObject) => boolean,
    timeoutMs?: number,
  ): Promise<JsonObject>;
  close(force?: boolean): Promise<void>;
}

export interface JsonLineProcessOptions {
  argv: string[];
  cwd: string;
  capturePath: string;
  timeoutMs: number;
  environment?: Record<string, string>;
  onMessage?: (message: JsonObject) => void | Promise<void>;
}

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_VALUE = 16 * 1024;
const REDACTED_KEYS = /email|organization|token|secret|authorization|api[_-]?key|credential/i;

export function redact(value: unknown, key = ""): unknown {
  if (REDACTED_KEYS.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.length > MAX_CAPTURE_VALUE
      ? `${value.slice(0, MAX_CAPTURE_VALUE)}…[TRUNCATED]`
      : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [entryKey, redact(entry, entryKey)]),
    );
  }
  return value;
}

export class JsonLineProcess implements JsonTransport {
  private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly waiters = new Set<Waiter>();
  private readonly messages: JsonObject[] = [];
  private readonly captureLines: string[] = [];
  private closedError: Error | null = null;
  private buffer = "";
  private stderr = "";
  private readonly pump: Promise<void>;

  constructor(private readonly options: JsonLineProcessOptions) {
    this.child = Bun.spawn(options.argv, {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...cleanEnvironment(), ...options.environment },
    });
    this.pump = Promise.all([this.readStdout(), this.readStderr(), this.observeExit()]).then(
      () => undefined,
    );
  }

  get pid(): number {
    return this.child.pid;
  }

  get capturedMessages(): readonly JsonObject[] {
    return this.messages;
  }

  send(message: JsonObject): void {
    if (this.closedError !== null) throw this.closedError;
    this.captureLines.push(JSON.stringify({ direction: "in", frame: redact(message) }));
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.child.stdin.flush();
  }

  waitFor(
    predicate: (message: JsonObject) => boolean,
    timeoutMs = this.options.timeoutMs,
  ): Promise<JsonObject> {
    const prior = this.messages.find(predicate);
    if (prior !== undefined) return Promise.resolve(prior);
    if (this.closedError !== null) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for provider frame`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async close(force = false): Promise<void> {
    if (!force) {
      try {
        this.child.stdin.end();
        await Promise.race([this.child.exited, Bun.sleep(1_000)]);
      } catch {
        // The provider may already have closed stdin.
      }
    }
    if (this.child.exitCode === null) this.child.kill();
    await this.pump.catch(() => undefined);
    await this.flushCapture();
  }

  private async readStdout(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      if (this.buffer.length > MAX_BUFFER_BYTES && !this.buffer.includes("\n")) {
        throw new Error(`Provider emitted more than ${MAX_BUFFER_BYTES} unterminated bytes`);
      }
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message: JsonObject;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("frame is not an object");
          }
          message = parsed as JsonObject;
        } catch (error) {
          this.captureLines.push(JSON.stringify({ direction: "out", malformed: redact(line) }));
          throw new Error(`Provider emitted malformed JSON: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        this.messages.push(message);
        this.captureLines.push(JSON.stringify({ direction: "out", frame: redact(message) }));
        for (const waiter of [...this.waiters]) {
          if (!waiter.predicate(message)) continue;
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(message);
        }
        await this.options.onMessage?.(message);
      }
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (this.stderr.length <= MAX_BUFFER_BYTES) {
        this.stderr += decoder.decode(value, { stream: true });
      }
    }
  }

  private async observeExit(): Promise<void> {
    const exitCode = await this.child.exited;
    const error = new Error(
      `Provider process exited with code ${exitCode}${this.stderr.trim().length > 0 ? `: ${this.stderr.trim().slice(0, 2_000)}` : ""}`,
    );
    this.closedError = error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private async flushCapture(): Promise<void> {
    await mkdir(dirname(this.options.capturePath), { recursive: true });
    const stderr = this.stderr.trim();
    if (stderr.length > 0) {
      this.captureLines.push(JSON.stringify({ direction: "stderr", text: redact(stderr) }));
    }
    await Bun.write(
      this.options.capturePath,
      `${this.captureLines.join("\n")}${this.captureLines.length > 0 ? "\n" : ""}`,
    );
  }
}

export interface JsonWebSocketOptions {
  url: string;
  capturePath: string;
  timeoutMs: number;
  onMessage?: (message: JsonObject) => void | Promise<void>;
}

export class JsonWebSocket implements JsonTransport {
  private readonly socket: WebSocket;
  private readonly waiters = new Set<Waiter>();
  private readonly messages: JsonObject[] = [];
  private readonly captureLines: string[] = [];
  private closedError: Error | null = null;
  private opened = false;
  private readonly ready: Promise<void>;
  private readonly finished: Promise<void>;
  private finish!: () => void;

  private constructor(private readonly options: JsonWebSocketOptions) {
    this.socket = new WebSocket(options.url);
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${options.timeoutMs} ms connecting to ${options.url}`));
      }, options.timeoutMs);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.opened = true;
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        if (!this.opened) {
          clearTimeout(timer);
          reject(new Error(`Could not connect to ${options.url}`));
        }
      });
    });
    this.socket.addEventListener("message", (event) => {
      void this.receive(event.data);
    });
    this.socket.addEventListener("close", (event) => {
      const error = new Error(`Provider WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
      this.closedError = error;
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.waiters.clear();
      this.finish();
    }, { once: true });
  }

  static async connect(options: JsonWebSocketOptions): Promise<JsonWebSocket> {
    const transport = new JsonWebSocket(options);
    await transport.ready;
    return transport;
  }

  get capturedMessages(): readonly JsonObject[] {
    return this.messages;
  }

  send(message: JsonObject): void {
    if (!this.opened || this.socket.readyState !== WebSocket.OPEN) {
      throw this.closedError ?? new Error("Provider WebSocket is not open");
    }
    this.captureLines.push(JSON.stringify({ direction: "in", frame: redact(message) }));
    this.socket.send(JSON.stringify(message));
  }

  waitFor(
    predicate: (message: JsonObject) => boolean,
    timeoutMs = this.options.timeoutMs,
  ): Promise<JsonObject> {
    const prior = this.messages.find(predicate);
    if (prior !== undefined) return Promise.resolve(prior);
    if (this.closedError !== null) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for provider WebSocket frame`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, "fixture complete");
    }
    await Promise.race([this.finished, Bun.sleep(1_000)]);
    await mkdir(dirname(this.options.capturePath), { recursive: true });
    await Bun.write(
      this.options.capturePath,
      `${this.captureLines.join("\n")}${this.captureLines.length > 0 ? "\n" : ""}`,
    );
  }

  private async receive(data: string | ArrayBuffer | Blob): Promise<void> {
    const text = typeof data === "string"
      ? data
      : data instanceof Blob
      ? await data.text()
      : new TextDecoder().decode(data);
    let message: JsonObject;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("frame is not an object");
      }
      message = parsed as JsonObject;
    } catch (error) {
      this.captureLines.push(JSON.stringify({ direction: "out", malformed: redact(text) }));
      this.closedError = new Error(
        `Provider emitted malformed WebSocket JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return;
    }
    this.messages.push(message);
    this.captureLines.push(JSON.stringify({ direction: "out", frame: redact(message) }));
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
    await this.options.onMessage?.(message);
  }
}

export function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as JsonObject;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string`);
  }
  return value;
}

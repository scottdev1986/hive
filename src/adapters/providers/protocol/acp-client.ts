import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import {
  type ClientConnection,
  type ClientContext,
  client,
  methods,
  ndJsonStream,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { terminateProcessGroup } from "./process-group";

function uint8ReadableStream(source: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      source.on("data", (chunk: Buffer) => {
        controller.enqueue(
          chunk instanceof Uint8Array ? chunk : Buffer.from(chunk),
        );
      });
      source.on("end", () => controller.close());
      source.on("error", (error: Error) => controller.error(error));
    },
    cancel() {
      source.destroy();
    },
  });
}

export type AcpRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export interface AcpClientOptions {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Vendor extension notifications to register with the method-specific ACP client API. */
  readonly extensionNotificationMethods?: readonly string[];
  /** Handle agent→client reverse-RPC (session/request_permission, fs/*, …). The returned value becomes the JSON-RPC result; throwing sends an error. A handler may return a promise that settles later, which is how a permission waits for the user without blocking the connection. */
  readonly onRequest?: AcpRequestHandler;
  readonly onNotification?: (method: string, params: unknown) => void;
  readonly onStderrLine?: (line: string) => void;
}

/** ACP over anonymous pipes to a child process. The protocol itself — framing, request ids, matching a response to the call that made it, reverse-RPC dispatch, the method and payload shapes — belongs to ACP's own SDK. What is left here is the part the SDK has no view of: the child is started in its own process group so close() can reap the whole tree, with no orphans and no controlling TTY. Live-session requests carry no blanket deadline because permission waits are intentionally long-lived. Probe callers add explicit deadlines around the handshake and catalog requests, then close this process group on expiry. */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private closed = false;
  private readonly options: AcpClientOptions;

  constructor(options: AcpClientOptions) {
    this.options = options;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (this.child !== null) {
      throw new Error("AcpClient.start: already started");
    }
    const child = spawn(this.options.executable, [...this.options.argv], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      // Own process group: kill(-pid) reaps descendants; never a controlling TTY.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const stderr = createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    stderr.on("line", (line) => {
      this.options.onStderrLine?.(line);
    });

    const dispatch = async (method: string, params: unknown) => {
      const handler = this.options.onRequest;
      if (handler === undefined) {
        throw new Error(`Method not found: ${method}`);
      }
      return handler(method, params);
    };

    // Leave fs/* and terminal/* unregistered because Hive advertises neither
    // capability. Calls the agent was told not to make receive method-not-found.
    const app = client({ name: "hive" })
      .onNotification(methods.client.session.update, ({ params }) => {
        this.options.onNotification?.("session/update", params);
      })
      .onRequest(
        methods.client.session.requestPermission,
        async ({ params }) =>
          (await dispatch(
            "session/request_permission",
            params,
          )) as RequestPermissionResponse,
      );

    for (const method of this.options.extensionNotificationMethods ?? []) {
      app.onNotification(
        method,
        (params: unknown) => params,
        ({ params }) => {
          this.options.onNotification?.(method, params);
        },
      );
    }

    this.connection = app.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        uint8ReadableStream(child.stdout),
      ),
    );

    child.on("exit", () => {
      this.closed = true;
    });
  }

  get acp(): ClientContext {
    return this.open().agent;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return this.open().agent.request(method, params);
  }

  notify(method: string, params?: unknown): void {
    void this.open().agent.notify(method, params);
  }

  /** Kill the child's process group and wait until it is gone. Returning means the process group is gone — not merely that a signal was sent. */
  async close(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.child === null) {
      this.closed = true;
      return;
    }
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.connection?.close();
    this.connection = null;

    const pid = child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    }

    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });

    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }
        resolve();
      }, 2_000);
    });

    await Promise.race([exited, timeout]);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 500);
      });
    }
    if (pid !== undefined) await terminateProcessGroup(pid, 500);
  }

  private open(): ClientConnection {
    const connection = this.connection;
    if (this.closed || connection === null) {
      throw new Error("AcpClient: closed");
    }
    return connection;
  }
}

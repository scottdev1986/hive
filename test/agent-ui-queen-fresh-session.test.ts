/**
 * Stage D — five-vendor fresh-session wire assertions for queen/root launch.
 *
 * Seeds a queen session ref with a sentinel vendor id and a provider-authored
 * "compaction summary", drives the real agent-ui open path (openAgentUiProviderSession),
 * and asserts per vendor that a root never resumes while a worker still can.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../src/adapters/providers/codex-app-server/runtime-adapter";
import type {
  CodexAppServerMessage,
  CodexAppServerWire,
} from "../src/adapters/providers/codex-app-server/jsonl-rpc";
import { ClaudeStreamJsonAdapter } from "../src/adapters/providers/protocol/claude-runtime-adapter";
import type { ClaudeProcess } from "../src/adapters/providers/protocol/claude-stream-process";
import {
  type DurableSessionRecord,
  readStoredSession,
} from "../src/adapters/providers/protocol/durable-session";
import {
  FakeProviderAdapter,
  type FakeProviderSession,
  fakeCapabilities,
} from "../src/adapters/providers/protocol/fake-driver";
import { KimiAcpAdapter } from "../src/adapters/providers/protocol/kimi-acp-adapter";
import type { ProviderSpawn } from "../src/adapters/providers/protocol/types";
import {
  agentUiSessionStart,
  openAgentUiProviderSession,
  sessionRefPath,
} from "../src/cli/agent-ui/run";
import type { CapabilityProvider } from "../src/schemas/capability";

const FAKE_COMPACTION_SUMMARY =
  "PROVIDER_COMPACTION_SUMMARY_SENTINEL_do_not_trust_this_body";
const SENTINEL_VENDOR_SESSION_ID = "sentinel-vendor-session-from-before";
const BOOT_CAPSULE = [
  "## Identity and proof",
  "freshSessionMandate: Open a fresh provider conversation. Never load, resume, read, or trust a stored provider session.",
  "successionId: qsc_test_stage_d",
  "targetGeneration: 4",
  `checkpointDigest=sha256:${"a".repeat(64)}`,
  "control mit_owner_ruling sender=owner topic=ruling",
  "task task_stage_d revision=3 state=blocked",
].join("\n");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function pane(): Promise<{
  root: string;
  journalPath: string;
  storePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "hive-queen-fresh-session-"));
  roots.push(root);
  const journalPath = join(root, "outbound-journal.jsonl");
  return { root, journalPath, storePath: sessionRefPath(journalPath) };
}

function storedRecord(
  provider: CapabilityProvider,
  cwd: string,
  transport: DurableSessionRecord["identity"]["transport"],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    identity: {
      provider,
      transport,
      version: "0.0.0-test",
      cwd,
    },
    session: {
      vendorSessionId: SENTINEL_VENDOR_SESSION_ID,
      replayedHistory: true,
    },
    recordedAt: "2026-08-10T00:00:00.000Z",
    // Provider-authored body a resume path must never feed into the queen.
    providerSummary: FAKE_COMPACTION_SUMMARY,
  };
}

async function seedSessionRef(
  storePath: string,
  provider: CapabilityProvider,
  cwd: string,
  transport: DurableSessionRecord["identity"]["transport"],
): Promise<void> {
  await writeFile(
    storePath,
    `${JSON.stringify(storedRecord(provider, cwd, transport), null, 2)}\n`,
  );
}

function spawnFor(
  provider: CapabilityProvider,
  cwd: string,
  executable: string,
  argv: readonly string[] = [],
): ProviderSpawn {
  return {
    provider,
    executable,
    argv: [...argv],
    cwd,
    env: {},
  };
}

function assertInstructionHasBootCapsule(
  instruction: string | undefined,
): void {
  expect(instruction).toBeDefined();
  expect(instruction).toContain("freshSessionMandate");
  expect(instruction).toContain("qsc_test_stage_d");
  expect(instruction).toContain("targetGeneration: 4");
  expect(instruction).not.toContain(FAKE_COMPACTION_SUMMARY);
  expect(instruction).not.toContain(SENTINEL_VENDOR_SESSION_ID);
}

describe("five-vendor queen fresh-session wire assertions", () => {
  test("fake adapter: root never reads the session ref; worker still resumes", async () => {
    const { root, journalPath, storePath } = await pane();
    await seedSessionRef(storePath, "claude", root, "fake");
    const before = await readFile(storePath, "utf8");
    expect(before).toContain(FAKE_COMPACTION_SUMMARY);

    const adapter = new FakeProviderAdapter(
      fakeCapabilities({
        provider: "claude",
        runtime: {
          executable: "/fake/provider",
          version: "0.0.0-fake",
          transport: "fake",
          workingDirectory: root,
        },
      }),
    );

    const queen = await openAgentUiProviderSession({
      subject: "queen",
      adapter,
      spawn: spawnFor("claude", root, "/fake/provider"),
      journalPath,
      sessionStart: agentUiSessionStart(
        { provider: "claude", readOnly: true },
        BOOT_CAPSULE,
      ),
    });
    expect(queen.decision).toEqual({ outcome: "fresh" });
    expect(queen.vendorSession.vendorSessionId).not.toBe(
      SENTINEL_VENDOR_SESSION_ID,
    );
    const queenSession = adapter.session as FakeProviderSession;
    expect(queenSession.sessionCalls.map((call) => call.kind)).toEqual([
      "newSession",
    ]);
    const newCall = queenSession.sessionCalls[0];
    if (newCall?.kind !== "newSession") throw new Error("expected newSession");
    assertInstructionHasBootCapsule(newCall.input.instruction);
    // Root path must leave the planted ref untouched (never rewritten either).
    expect(await readFile(storePath, "utf8")).toBe(before);

    const workerAdapter = new FakeProviderAdapter(
      fakeCapabilities({
        provider: "claude",
        runtime: {
          executable: "/fake/provider",
          version: "0.0.0-fake",
          transport: "fake",
          workingDirectory: root,
        },
      }),
    );
    const worker = await openAgentUiProviderSession({
      subject: "maya",
      adapter: workerAdapter,
      spawn: spawnFor("claude", root, "/fake/provider"),
      journalPath,
      sessionStart: agentUiSessionStart({
        provider: "claude",
        readOnly: false,
      }),
    });
    expect(worker.decision).toEqual({
      outcome: "resume",
      vendorSessionId: SENTINEL_VENDOR_SESSION_ID,
    });
    expect(worker.vendorSession.vendorSessionId).toBe(
      SENTINEL_VENDOR_SESSION_ID,
    );
    const workerSession = workerAdapter.session as FakeProviderSession;
    expect(workerSession.sessionCalls.map((call) => call.kind)).toEqual([
      "resumeSession",
    ]);
  });

  test("Claude: one --session-id, zero --resume/--continue; worker resumes", async () => {
    const { root, journalPath, storePath } = await pane();
    await seedSessionRef(storePath, "claude", root, "claude-stream-json");

    class ByteQueue implements AsyncIterable<Uint8Array> {
      private readonly buffered: Uint8Array[] = [];
      private readonly waiting: ((
        value: IteratorResult<Uint8Array>,
      ) => void)[] = [];
      private ended = false;
      push(value: string): void {
        const bytes = new TextEncoder().encode(value);
        const waiter = this.waiting.shift();
        if (waiter === undefined) this.buffered.push(bytes);
        else waiter({ value: bytes, done: false });
      }
      end(): void {
        this.ended = true;
        for (const waiter of this.waiting.splice(0)) {
          waiter({ value: undefined, done: true });
        }
      }
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next: () => {
            const value = this.buffered.shift();
            if (value !== undefined)
              return Promise.resolve({ value, done: false });
            if (this.ended)
              return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => this.waiting.push(resolve));
          },
        };
      }
    }

    class FakeClaudeProcess implements ClaudeProcess {
      readonly pid: number;
      readonly stdout = new ByteQueue();
      readonly stderr = new ByteQueue();
      readonly writes: Record<string, unknown>[] = [];
      readonly exited: Promise<number>;
      readonly stdin: { write(data: string): void; end(): void };
      private resolveExit: ((code: number) => void) | null = null;
      private ended = false;
      constructor(
        pid: number,
        private readonly onWrite: (
          message: Record<string, unknown>,
          process: FakeClaudeProcess,
        ) => void,
      ) {
        this.pid = pid;
        this.exited = new Promise((resolve) => {
          this.resolveExit = resolve;
        });
        this.stdin = {
          write: (data) => {
            for (const line of data.trim().split("\n")) {
              if (line.length === 0) continue;
              const message = JSON.parse(line) as Record<string, unknown>;
              this.writes.push(message);
              this.onWrite(message, this);
            }
          },
          end: () => this.exit(0),
        };
      }
      emit(message: Record<string, unknown>): void {
        this.stdout.push(`${JSON.stringify(message)}\n`);
      }
      exit(code: number): void {
        if (this.ended) return;
        this.ended = true;
        this.stdout.end();
        this.stderr.end();
        this.resolveExit?.(code);
      }
      kill(): void {
        this.exit(137);
      }
    }

    const commands: string[][] = [];
    const processes: FakeClaudeProcess[] = [];
    const adapter = new ClaudeStreamJsonAdapter({
      probeVersion: () => "2.1.220",
      processFactory: (command) => {
        commands.push([...command]);
        const process = new FakeClaudeProcess(
          processes.length + 10,
          (message, child) => {
            const request = message.request as
              Record<string, unknown> | undefined;
            const requestId = message.request_id;
            if (
              request?.subtype === "initialize" &&
              typeof requestId === "string"
            ) {
              child.emit({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: requestId,
                  response: {
                    commands: [],
                    models: [],
                    account: { subscriptionType: "test" },
                  },
                },
              });
              return;
            }
            if (
              request?.subtype === "get_context_usage" &&
              typeof requestId === "string"
            ) {
              child.emit({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: requestId,
                  response: {
                    totalTokens: 10,
                    maxTokens: 100,
                    percentage: 10,
                  },
                },
              });
            }
          },
        );
        processes.push(process);
        return process;
      },
    });

    const queen = await openAgentUiProviderSession({
      subject: "queen",
      adapter,
      spawn: spawnFor("claude", root, "/installed/claude", [
        "--model",
        "haiku",
      ]),
      journalPath,
      sessionStart: agentUiSessionStart(
        { provider: "claude", readOnly: true },
        BOOT_CAPSULE,
      ),
    });
    expect(queen.decision).toEqual({ outcome: "fresh" });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--session-id");
    expect(commands[0]).not.toContain("--resume");
    expect(commands[0]).not.toContain("--continue");
    expect(commands[0]).not.toContain(SENTINEL_VENDOR_SESSION_ID);
    const sessionIdFlag = commands[0]?.indexOf("--session-id") ?? -1;
    expect(sessionIdFlag).toBeGreaterThanOrEqual(0);
    expect(commands[0]?.[sessionIdFlag + 1]).not.toBe(
      SENTINEL_VENDOR_SESSION_ID,
    );
    await queen.session.close();

    // Positive control: worker resume uses --resume for the sentinel.
    commands.length = 0;
    processes.length = 0;
    const worker = await openAgentUiProviderSession({
      subject: "maya",
      adapter,
      spawn: spawnFor("claude", root, "/installed/claude", [
        "--model",
        "haiku",
      ]),
      journalPath,
      sessionStart: agentUiSessionStart({
        provider: "claude",
        readOnly: false,
      }),
    });
    expect(worker.decision).toEqual({
      outcome: "resume",
      vendorSessionId: SENTINEL_VENDOR_SESSION_ID,
    });
    // connect starts one process; resumeSession stops and starts with --resume.
    expect(commands.some((command) => command.includes("--resume"))).toBe(true);
    expect(
      commands.some((command) => command.includes(SENTINEL_VENDOR_SESSION_ID)),
    ).toBe(true);
    await worker.session.close();
  });

  test("Codex: one thread/start, zero thread/resume; worker resumes", async () => {
    const { root, journalPath, storePath } = await pane();
    await seedSessionRef(storePath, "codex", root, "codex-app-server");

    class Deferred<T> {
      readonly promise: Promise<T>;
      resolve!: (value: T) => void;
      reject!: (error: Error) => void;
      constructor() {
        this.promise = new Promise((resolve, reject) => {
          this.resolve = resolve;
          this.reject = reject;
        });
      }
    }
    class MessageQueue {
      private readonly buffered: CodexAppServerMessage[] = [];
      private readonly waiting: Array<
        (value: IteratorResult<CodexAppServerMessage>) => void
      > = [];
      private ended = false;
      push(message: CodexAppServerMessage): void {
        const waiter = this.waiting.shift();
        if (waiter === undefined) this.buffered.push(message);
        else waiter({ value: message, done: false });
      }
      end(): void {
        this.ended = true;
        for (const waiter of this.waiting.splice(0)) {
          waiter({ value: undefined, done: true });
        }
      }
      next(): Promise<IteratorResult<CodexAppServerMessage>> {
        const message = this.buffered.shift();
        if (message !== undefined)
          return Promise.resolve({ value: message, done: false });
        if (this.ended)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      }
    }
    type RequestHandler = (params: unknown) => unknown;
    class FakeWire implements CodexAppServerWire {
      readonly requests: Array<{ method: string; params: unknown }> = [];
      readonly notifications: Array<{ method: string; params: unknown }> = [];
      readonly responses: Array<{ id: number | string; result: unknown }> = [];
      readonly rejections: Array<{
        id: number | string;
        code: number;
        message: string;
      }> = [];
      readonly incoming: AsyncIterable<CodexAppServerMessage>;
      readonly closed: Promise<{
        readonly exitCode: number | null;
        readonly reason: string;
      }>;
      closedByHive = false;
      private readonly queue = new MessageQueue();
      private readonly closeResult = new Deferred<{
        readonly exitCode: number | null;
        readonly reason: string;
      }>();
      constructor(readonly handlers: Record<string, RequestHandler> = {}) {
        this.incoming = {
          [Symbol.asyncIterator]: () => ({ next: () => this.queue.next() }),
        };
        this.closed = this.closeResult.promise;
      }
      request(method: string, params?: unknown): Promise<unknown> {
        this.requests.push({ method, params });
        const handler = this.handlers[method];
        return Promise.resolve(handler === undefined ? {} : handler(params));
      }
      notify(method: string, params?: unknown): void {
        this.notifications.push({ method, params });
      }
      respond(id: number | string, result: unknown): void {
        this.responses.push({ id, result });
      }
      reject(id: number | string, code: number, message: string): void {
        this.rejections.push({ id, code, message });
      }
      close(): Promise<void> {
        this.closedByHive = true;
        this.queue.end();
        this.closeResult.resolve({ exitCode: 0, reason: "closed" });
        return Promise.resolve();
      }
    }

    const HANDSHAKE = {
      userAgent: "hive-protocol-terminal/0.147.0 (test)",
      codexHome: "/test/codex-home",
      platformFamily: "unix",
      platformOs: "test",
    };
    const wires: FakeWire[] = [];
    const adapter = new CodexAppServerAdapter({
      readVersion: async () => "0.147.0",
      wireFactory: async () => {
        const wire = new FakeWire({
          initialize: () => HANDSHAKE,
          "thread/start": () => ({ thread: { id: "thread-fresh-1" } }),
          "thread/resume": (params) => ({
            thread: {
              id: (params as { threadId: string }).threadId,
              turns: [],
            },
          }),
        });
        wires.push(wire);
        return wire;
      },
    });

    const queen = await openAgentUiProviderSession({
      subject: "queen",
      adapter,
      spawn: spawnFor("codex", root, "/test/codex"),
      journalPath,
      sessionStart: agentUiSessionStart(
        { provider: "codex", readOnly: true },
        BOOT_CAPSULE,
      ),
    });
    expect(queen.decision).toEqual({ outcome: "fresh" });
    expect(queen.vendorSession.vendorSessionId).toBe("thread-fresh-1");
    const queenMethods = wires[0]?.requests.map((request) => request.method);
    expect(queenMethods).toContain("thread/start");
    expect(queenMethods).not.toContain("thread/resume");
    const start = wires[0]?.requests.find(
      (request) => request.method === "thread/start",
    );
    expect(start?.params).toMatchObject({
      developerInstructions: BOOT_CAPSULE,
    });
    expect(JSON.stringify(start?.params)).not.toContain(
      FAKE_COMPACTION_SUMMARY,
    );
    await queen.session.close();

    const worker = await openAgentUiProviderSession({
      subject: "maya",
      adapter,
      spawn: spawnFor("codex", root, "/test/codex"),
      journalPath,
      sessionStart: agentUiSessionStart({ provider: "codex", readOnly: false }),
    });
    expect(worker.decision).toEqual({
      outcome: "resume",
      vendorSessionId: SENTINEL_VENDOR_SESSION_ID,
    });
    const workerMethods = wires[1]?.requests.map((request) => request.method);
    expect(workerMethods).toContain("thread/resume");
    expect(
      wires[1]?.requests.some(
        (request) =>
          request.method === "thread/resume" &&
          JSON.stringify(request.params).includes(SENTINEL_VENDOR_SESSION_ID),
      ),
    ).toBe(true);
    await worker.session.close();
  });

  test("Kimi ACP: one session/new, zero session/load or session/resume", async () => {
    const { root, journalPath, storePath } = await pane();
    await seedSessionRef(storePath, "kimi", root, "acp");
    const server = join(import.meta.dir, "protocol-kimi-fake-server.ts");
    const adapter = new KimiAcpAdapter();

    const queen = await openAgentUiProviderSession({
      subject: "queen",
      adapter,
      spawn: {
        provider: "kimi",
        executable: process.execPath,
        argv: [server],
        cwd: root,
        env: {},
      },
      journalPath,
      sessionStart: agentUiSessionStart(
        { provider: "kimi", readOnly: true },
        BOOT_CAPSULE,
      ),
    });
    expect(queen.decision).toEqual({ outcome: "fresh" });
    expect(queen.vendorSession.vendorSessionId).not.toBe(
      SENTINEL_VENDOR_SESSION_ID,
    );
    expect(queen.vendorSession.replayedHistory).toBe(false);
    // Seeded ref still holds the sentinel — queen never rewrote or consumed it.
    const stored = await readStoredSession(storePath);
    expect(stored.state).toBe("present");
    if (stored.state === "present") {
      expect(stored.record.session.vendorSessionId).toBe(
        SENTINEL_VENDOR_SESSION_ID,
      );
    }
    await queen.session.close();

    const worker = await openAgentUiProviderSession({
      subject: "maya",
      adapter,
      spawn: {
        provider: "kimi",
        executable: process.execPath,
        argv: [server],
        cwd: root,
        env: {},
      },
      journalPath,
      sessionStart: agentUiSessionStart({ provider: "kimi", readOnly: false }),
    });
    expect(worker.decision).toEqual({
      outcome: "resume",
      vendorSessionId: SENTINEL_VENDOR_SESSION_ID,
    });
    expect(worker.vendorSession.vendorSessionId).toBe(
      SENTINEL_VENDOR_SESSION_ID,
    );
    await worker.session.close();
  });

  for (const provider of ["grok", "opencode"] as const) {
    test(`${provider}: root issues newSession only; worker still load-resumes`, async () => {
      const { root, journalPath, storePath } = await pane();
      await seedSessionRef(storePath, provider, root, "acp");
      const adapter = new FakeProviderAdapter(
        fakeCapabilities({
          provider,
          runtime: {
            executable: `/fake/${provider}`,
            version: "0.0.0-fake",
            transport: "acp",
            workingDirectory: root,
          },
        }),
      );

      const queen = await openAgentUiProviderSession({
        subject: "queen",
        adapter,
        spawn: spawnFor(provider, root, `/fake/${provider}`),
        journalPath,
        sessionStart: agentUiSessionStart(
          { provider, readOnly: true },
          BOOT_CAPSULE,
        ),
      });
      expect(queen.decision).toEqual({ outcome: "fresh" });
      const queenSession = adapter.session as FakeProviderSession;
      expect(queenSession.sessionCalls.map((call) => call.kind)).toEqual([
        "newSession",
      ]);
      const newCall = queenSession.sessionCalls[0];
      if (newCall?.kind !== "newSession")
        throw new Error("expected newSession");
      assertInstructionHasBootCapsule(newCall.input.instruction);
      // Protocol mapping for ACP vendors: newSession → session/new; resumeSession
      // with style load → session/load. Zero resume/load calls on the root path.
      expect(
        queenSession.sessionCalls.some((call) => call.kind === "resumeSession"),
      ).toBe(false);
      expect(await readFile(storePath, "utf8")).toContain(
        SENTINEL_VENDOR_SESSION_ID,
      );
      expect(await readFile(storePath, "utf8")).toContain(
        FAKE_COMPACTION_SUMMARY,
      );

      const workerAdapter = new FakeProviderAdapter(
        fakeCapabilities({
          provider,
          runtime: {
            executable: `/fake/${provider}`,
            version: "0.0.0-fake",
            transport: "acp",
            workingDirectory: root,
          },
        }),
      );
      const worker = await openAgentUiProviderSession({
        subject: "worker",
        adapter: workerAdapter,
        spawn: spawnFor(provider, root, `/fake/${provider}`),
        journalPath,
        sessionStart: agentUiSessionStart({ provider, readOnly: false }),
      });
      expect(worker.decision).toEqual({
        outcome: "resume",
        vendorSessionId: SENTINEL_VENDOR_SESSION_ID,
      });
      const workerSession = workerAdapter.session as FakeProviderSession;
      expect(workerSession.sessionCalls).toEqual([
        {
          kind: "resumeSession",
          input: {
            vendorSessionId: SENTINEL_VENDOR_SESSION_ID,
            style: "load",
          },
        },
      ]);
    });
  }

  test("orchestrator subject is treated as root (fresh session)", async () => {
    const { root, journalPath, storePath } = await pane();
    await seedSessionRef(storePath, "claude", root, "fake");
    const adapter = new FakeProviderAdapter(
      fakeCapabilities({
        runtime: {
          executable: "/fake/provider",
          version: "0.0.0-fake",
          transport: "fake",
          workingDirectory: root,
        },
      }),
    );
    const opened = await openAgentUiProviderSession({
      subject: "orchestrator",
      adapter,
      spawn: spawnFor("claude", root, "/fake/provider"),
      journalPath,
      sessionStart: agentUiSessionStart(
        { provider: "claude", readOnly: true },
        BOOT_CAPSULE,
      ),
    });
    expect(opened.decision).toEqual({ outcome: "fresh" });
    expect((adapter.session as FakeProviderSession).sessionCalls).toHaveLength(
      1,
    );
  });
});

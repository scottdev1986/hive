import { describe, expect, test } from "bun:test";
import {
  type CodexAppServerMessage,
  CodexAppServerUnknownOutcomeError,
  type CodexAppServerWire,
} from "../../../src/adapters/providers/codex-app-server/jsonl-rpc";
import { CodexAppServerAdapter } from "../../../src/adapters/providers/codex-app-server/runtime-adapter";
import {
  CODEX_APP_SERVER_METHODS,
  CodexAppServerIncompatibleError,
} from "../../../src/adapters/providers/codex-app-server/wire";
import type { NormalizedProviderEvent } from "../../../src/adapters/providers/protocol/types";

import { type JsonValue, requireJsonValue } from "../../../src/shared/json";

type RequestHandler = (params: unknown) => JsonValue | Promise<JsonValue>;

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
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
    if (message !== undefined) {
      return Promise.resolve({ value: message, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

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

  request(method: string, params?: unknown): Promise<JsonValue> {
    this.requests.push({ method, params });
    const handler = this.handlers[method];
    return Promise.resolve(
      handler === undefined ? {} : requireJsonValue(handler(params), method),
    );
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

  push(message: CodexAppServerMessage): void {
    this.queue.push(message);
  }

  drop(reason = "test stream drop"): void {
    this.queue.end();
    this.closeResult.resolve({ exitCode: null, reason });
  }

  close(): Promise<void> {
    this.closedByHive = true;
    this.queue.end();
    this.closeResult.resolve({ exitCode: 0, reason: "closed by Hive" });
    return Promise.resolve();
  }
}

const HANDSHAKE = {
  userAgent: "hive-protocol-terminal/0.146.0 (test)",
  codexHome: "/test/codex-home",
  platformFamily: "unix",
  platformOs: "test",
};

function wireWith(handlers: Record<string, RequestHandler> = {}): FakeWire {
  return new FakeWire({ initialize: () => HANDSHAKE, ...handlers });
}

function spawn() {
  return {
    provider: "codex" as const,
    executable: "/test/codex",
    argv: [],
    cwd: "/test/worktree",
    env: { PATH: "/test/bin" },
  };
}

function adapterFor(
  wires: FakeWire[],
  approvalTimeoutMs = 60_000,
): CodexAppServerAdapter {
  let wireIndex = 0;
  let milliseconds = 0;
  return new CodexAppServerAdapter({
    readVersion: async () => "0.146.0",
    wireFactory: async () => {
      const wire = wires[wireIndex];
      wireIndex += 1;
      if (wire === undefined) throw new Error("test did not provide a wire");
      return wire;
    },
    now: () => {
      milliseconds += 1;
      return new Date(milliseconds);
    },
    approvalTimeoutMs,
  });
}

async function nextEvent(
  iterator: AsyncIterator<NormalizedProviderEvent>,
): Promise<NormalizedProviderEvent> {
  const result = await iterator.next();
  if (result.done) throw new Error("event stream ended early");
  return result.value;
}

describe("Codex App Server compatibility", () => {
  test("treats the installed version as metadata when the protocol works", async () => {
    let launched = false;
    const wire = wireWith({
      initialize: () => ({
        ...HANDSHAKE,
        userAgent: "hive-protocol-terminal/0.147.0 (test)",
      }),
      "model/list": () => ({
        data: [{ id: "gpt-new", model: "gpt-new" }],
        nextCursor: null,
      }),
    });
    const adapter = new CodexAppServerAdapter({
      readVersion: async () => "0.147.0",
      wireFactory: async () => {
        launched = true;
        return wire;
      },
    });

    expect(await adapter.probe("/test/codex")).toMatchObject({
      provider: "codex",
      source: "probe",
      catalog: { status: "ok" },
      executable: "/test/codex",
      version: "0.147.0",
      transport: "codex-app-server",
      verdict: "compatible",
    });
    expect(launched).toBe(true);
  });

  test("allows missing version metadata after a successful handshake", async () => {
    const wire = wireWith();
    const adapter = new CodexAppServerAdapter({
      readVersion: async () => null,
      wireFactory: async () => wire,
    });

    const session = await adapter.connect(spawn());
    expect(session.capabilities.runtime.version).toBe("unknown");
    await session.close();
  });

  test("fails closed and closes the child on a branded handshake mismatch", async () => {
    const wire = wireWith({
      initialize: () => ({ ...HANDSHAKE, userAgent: "wrong/9.9.9 (test)" }),
    });
    const adapter = adapterFor([wire]);

    await expect(adapter.connect(spawn())).rejects.toBeInstanceOf(
      CodexAppServerIncompatibleError,
    );
    expect(wire.closedByHive).toBe(true);
  });
});

describe("Codex App Server sessions", () => {
  test("uses schema-backed thread start, list, read, load, and resume", async () => {
    const wire = wireWith({
      "thread/start": () => ({ thread: { id: "thread-1" } }),
      "thread/list": () => ({
        data: [],
        nextCursor: null,
        backwardsCursor: null,
      }),
      "thread/read": () => ({ thread: { id: "thread-1", turns: [] } }),
      "thread/resume": (params) => ({
        thread: {
          id: (params as { threadId: string }).threadId,
          turns: [],
        },
      }),
    });
    const session = await adapterFor([wire]).connect(spawn());

    expect(await session.newSession({ cwd: "/test/worktree" })).toEqual({
      vendorSessionId: "thread-1",
      replayedHistory: false,
    });
    await session.listThreads({ limit: 10 });
    await session.readThread("thread-1");
    expect(
      await session.resumeSession({
        vendorSessionId: "thread-1",
        style: "load",
      }),
    ).toEqual({ vendorSessionId: "thread-1", replayedHistory: true });
    expect(
      await session.resumeSession({
        vendorSessionId: "thread-1",
        style: "resume",
      }),
    ).toEqual({ vendorSessionId: "thread-1", replayedHistory: false });
    expect(wire.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/start",
      "thread/list",
      "thread/read",
      "thread/resume",
      "thread/resume",
    ]);
    expect(wire.requests.at(-2)?.params).toMatchObject({ excludeTurns: false });
    expect(wire.requests.at(-1)?.params).toMatchObject({ excludeTurns: true });
    await session.close();
  });

  test("preserves interleaved item identity and terminal turn state", async () => {
    const wire = wireWith({
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    const session = await adapterFor([wire]).connect(spawn());
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await nextEvent(iterator)).kind).toBe("runtime-ready");

    const receipt = await session.submit({
      session: { vendorSessionId: "thread-1", replayedHistory: false },
      clientInputId: "input-1",
      text: "hello",
    });
    expect(receipt).toEqual({
      clientInputId: "input-1",
      outcome: "accepted",
      turnId: "turn-1",
    });
    wire.push({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    wire.push({
      method: "item/started",
      params: {
        turnId: "turn-1",
        item: { type: "commandExecution", id: "tool-a", command: "pwd" },
      },
    });
    wire.push({
      method: "item/started",
      params: { turnId: "turn-1", item: { type: "fileChange", id: "tool-b" } },
    });
    wire.push({
      method: "item/fileChange/outputDelta",
      params: { turnId: "turn-1", itemId: "tool-b", delta: "b" },
    });
    wire.push({
      method: "item/commandExecution/outputDelta",
      params: { turnId: "turn-1", itemId: "tool-a", delta: "a" },
    });
    wire.push({
      method: "item/commandExecution/outputDelta",
      params: { turnId: "turn-1", itemId: "tool-a", delta: "b" },
    });
    wire.push({
      method: "item/completed",
      params: {
        turnId: "turn-1",
        item: { type: "fileChange", id: "tool-b", status: "completed" },
      },
    });
    wire.push({
      method: "item/completed",
      params: {
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "tool-a",
          status: "failed",
          aggregatedOutput: "command exited with status 5",
        },
      },
    });
    wire.push({
      method: "item/agentMessage/delta",
      params: { turnId: "turn-1", itemId: "message-1", delta: "done" },
    });
    wire.push({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const events: NormalizedProviderEvent[] = [];
    for (let index = 0; index < 10; index += 1) {
      events.push(await nextEvent(iterator));
    }
    expect(events.map((event) => event.kind)).toEqual([
      "turn-started",
      "tool-started",
      "tool-started",
      "tool-updated",
      "tool-updated",
      "tool-updated",
      "tool-finished",
      "tool-finished",
      "message-delta",
      "turn-idle",
    ]);
    expect(
      events.flatMap((event) =>
        "toolCallId" in event ? [event.toolCallId] : [],
      ),
    ).toEqual([
      "tool-a",
      "tool-b",
      "tool-b",
      "tool-a",
      "tool-a",
      "tool-b",
      "tool-a",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(
      events.filter((event) => event.kind === "tool-started"),
    ).toMatchObject([
      { toolCallId: "tool-a", toolKind: "execute" },
      { toolCallId: "tool-b", toolKind: "edit" },
    ]);
    expect(
      events.filter(
        (event) =>
          event.kind === "tool-updated" && event.toolCallId === "tool-a",
      ),
    ).toMatchObject([
      { output: "a", detail: null },
      { output: "ab", detail: null },
    ]);
    expect(
      events.find(
        (event) =>
          event.kind === "tool-finished" && event.toolCallId === "tool-a",
      ),
    ).toMatchObject({
      status: "error",
      reason: "command exited with status 5",
    });
    await session.close();
  });

  test("preserves Codex failure details on a failed turn", async () => {
    const wire = wireWith();
    const session = await adapterFor([wire]).connect(spawn());
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await nextEvent(iterator)).kind).toBe("runtime-ready");
    wire.push({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-failed-1",
          status: "failed",
          error: {
            message: "usage limit reached",
            additionalDetails: "resets at 2:00 PM",
          },
        },
      },
    });

    expect(await nextEvent(iterator)).toMatchObject({
      kind: "turn-failed",
      reason: "usage limit reached — resets at 2:00 PM",
    });
    await session.close();
  });

  test("marks a submission unknown when the stream drops before its ACK", async () => {
    const turnStart = new Deferred<JsonValue>();
    const wire = wireWith({ "turn/start": () => turnStart.promise });
    const session = await adapterFor([wire]).connect(spawn());
    const submission = session.submit({
      session: { vendorSessionId: "thread-1", replayedHistory: false },
      clientInputId: "input-1",
      text: "hello",
    });

    wire.drop();
    turnStart.reject(new CodexAppServerUnknownOutcomeError("stream dropped"));
    expect(await submission).toEqual({
      clientInputId: "input-1",
      outcome: "unknown",
      turnId: null,
      detail: "stream dropped",
    });
    await session.close();
  });

  test("reconnects and resumes without duplicating the prompt", async () => {
    const first = wireWith({
      "thread/start": () => ({ thread: { id: "thread-1" } }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    const second = wireWith({
      "thread/resume": () => ({ thread: { id: "thread-1", turns: [] } }),
    });
    const session = await adapterFor([first, second]).connect(spawn());
    await session.newSession({ cwd: "/test/worktree" });
    await session.submit({
      session: { vendorSessionId: "thread-1", replayedHistory: false },
      clientInputId: "input-mid-turn",
      text: "keep running",
    });
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await nextEvent(iterator)).kind).toBe("runtime-ready");
    first.drop();
    expect((await nextEvent(iterator)).kind).toBe("runtime-disconnected");

    await session.reconnect();
    expect((await nextEvent(iterator)).kind).toBe("runtime-connecting");
    expect((await nextEvent(iterator)).kind).toBe("runtime-ready");
    expect(second.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/resume",
    ]);
    expect(
      second.requests.some((request) => request.method === "turn/start"),
    ).toBe(false);
    await session.close();
  });

  test("interrupts only a turn correlated to its thread", async () => {
    const wire = wireWith({
      "turn/interrupt": () => ({}),
    });
    const session = await adapterFor([wire]).connect(spawn());
    wire.push({
      method: "turn/started",
      params: { threadId: "thread-7", turn: { id: "turn-7" } },
    });
    await Promise.resolve();
    await session.cancel("turn-7");
    expect(wire.requests.at(-1)).toEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-7", turnId: "turn-7" },
    });
    await expect(session.cancel("missing")).rejects.toThrow(
      "cannot interrupt unknown Codex turn missing",
    );
    await session.close();
  });

  test("reads context occupancy from the last turn, not the thread total", async () => {
    const wire = wireWith();
    const session = await adapterFor([wire]).connect(spawn());
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await nextEvent(iterator)).kind).toBe("runtime-ready");

    // Counts observed on a live thread that had run for 18 minutes: the
    // cumulative total is 30x the window while the turn holding the context
    // fits inside it.
    wire.push({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 7_756_775,
            inputTokens: 7_721_809,
            cachedInputTokens: 7_042_816,
            cacheWriteInputTokens: 0,
            outputTokens: 34_966,
            reasoningOutputTokens: 18_002,
          },
          last: {
            totalTokens: 218_431,
            inputTokens: 218_286,
            cachedInputTokens: 214_784,
            cacheWriteInputTokens: 0,
            outputTokens: 145,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258_400,
        },
      },
    });

    const event = await nextEvent(iterator);
    expect(event.kind).toBe("usage-updated");
    if (event.kind !== "usage-updated") throw new Error("expected usage");
    expect(event.contextPercent).toBeCloseTo(84.53, 1);
    // The spend counters stay cumulative; only occupancy reads the last turn.
    expect(event.inputTokens).toBe(7_721_809);
    expect(event.outputTokens).toBe(34_966);
    expect(event.contextWindow).toBe(258_400);
    await session.close();
  });
});

describe("Codex App Server approvals and commands", () => {
  test("surfaces requestUserInput and returns every typed or selected answer", async () => {
    const wire = wireWith();
    const session = await adapterFor([wire]).connect(spawn());
    const iterator = session.events[Symbol.asyncIterator]();
    await nextEvent(iterator);

    wire.push({
      method: "item/tool/requestUserInput",
      id: "question-1",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        autoResolutionMs: null,
        questions: [
          {
            id: "framework",
            header: "Framework",
            question: "Which framework?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "React", description: "Use React." },
              { label: "Vue", description: "Use Vue." },
            ],
          },
          {
            id: "token",
            header: "Token",
            question: "Paste the temporary token",
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
      },
    });

    const question = await nextEvent(iterator);
    expect(question).toMatchObject({
      kind: "question-waiting",
      requestId: "string:question-1",
      turnId: "turn-1",
      questions: [
        {
          questionId: "framework",
          text: "Which framework?",
          allowCustom: true,
          secret: false,
          options: [
            { optionId: "React", name: "React" },
            { optionId: "Vue", name: "Vue" },
          ],
        },
        {
          questionId: "token",
          allowCustom: true,
          secret: true,
          options: [],
        },
      ],
    });
    if (question.kind !== "question-waiting") {
      throw new Error("expected question-waiting");
    }
    await session.respondToPermission({
      requestId: question.requestId,
      outcome: "allow",
      answers: { framework: "Svelte", token: "temporary-secret" },
    });

    expect(wire.responses).toEqual([
      {
        id: "question-1",
        result: {
          answers: {
            framework: { answers: ["Svelte"] },
            token: { answers: ["temporary-secret"] },
          },
        },
      },
    ]);
    expect(session.capabilities.measured.questions).toBe("supported");
    await session.close();
  });

  test("answers command allow and file deny using the original request ids", async () => {
    const wire = wireWith();
    const session = await adapterFor([wire]).connect(spawn());
    const iterator = session.events[Symbol.asyncIterator]();
    await nextEvent(iterator);

    wire.push({
      method: "item/commandExecution/requestApproval",
      id: 41,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        command: "pwd",
        availableDecisions: ["accept", "decline"],
      },
    });
    const command = await nextEvent(iterator);
    expect(command).toMatchObject({
      kind: "approval-waiting",
      requestId: "number:41",
      turnId: "turn-1",
      toolName: "commandExecution",
    });
    await session.respondToPermission({
      requestId: "number:41",
      outcome: "allow",
      scope: "once",
    });

    wire.push({
      method: "item/fileChange/requestApproval",
      id: "patch-2",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-2",
      },
    });
    await nextEvent(iterator);
    await session.respondToPermission({
      requestId: "string:patch-2",
      outcome: "deny",
    });
    await session.respondToPermission({
      requestId: "string:patch-2",
      outcome: "deny",
    });
    expect(wire.responses).toEqual([
      { id: 41, result: { decision: "accept" } },
      { id: "patch-2", result: { decision: "decline" } },
    ]);
    await session.close();
  });

  test("uses cancel when it is the only offered command denial", async () => {
    const wire = wireWith();
    const session = await adapterFor([wire]).connect(spawn());
    const iterator = session.events[Symbol.asyncIterator]();
    await nextEvent(iterator);
    wire.push({
      method: "item/commandExecution/requestApproval",
      id: 42,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        command: "pwd",
        availableDecisions: ["accept", "cancel"],
      },
    });
    const approval = await nextEvent(iterator);
    if (approval.kind !== "approval-waiting") {
      throw new Error("expected approval-waiting");
    }
    await session.respondToPermission({
      requestId: approval.requestId,
      outcome: "deny",
    });
    expect(wire.responses).toEqual([
      { id: 42, result: { decision: "cancel" } },
    ]);
    await session.close();
  });

  test("expires additional-permission requests with an empty grant", async () => {
    const wire = wireWith();
    const session = await adapterFor([wire], 5).connect(spawn());
    const iterator = session.events[Symbol.asyncIterator]();
    await nextEvent(iterator);
    wire.push({
      method: "item/permissions/requestApproval",
      id: "permissions-1",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        permissions: { network: { enabled: true } },
      },
    });
    await nextEvent(iterator);
    const settled = await nextEvent(iterator);

    expect(settled).toMatchObject({
      kind: "elicitation-settled",
      requestId: "string:permissions-1",
      outcome: "deny",
    });
    expect(wire.responses).toEqual([
      {
        id: "permissions-1",
        result: { permissions: {}, scope: "turn" },
      },
    ]);
    await session.close();
  });

  test("uses only the pinned action and skill methods", async () => {
    const wire = wireWith({
      "review/start": () => ({ turn: {}, reviewThreadId: "thread-1" }),
      "thread/compact/start": () => ({}),
      "model/list": () => ({ data: [], nextCursor: null }),
      "permissionProfile/list": () => ({ data: [], nextCursor: null }),
      "config/read": () => ({ config: {}, origins: {} }),
      "thread/settings/update": () => ({}),
      "skills/list": () => ({
        data: [
          {
            cwd: "/test/worktree",
            errors: [],
            skills: [
              {
                name: "ship",
                description: "Ship safely",
                enabled: true,
              },
            ],
          },
        ],
      }),
    });
    const session = await adapterFor([wire]).connect(spawn());

    await session.startReview({
      threadId: "thread-1",
      target: { type: "uncommittedChanges" },
    });
    await session.runCommand({
      vendorSessionId: "thread-1",
      name: "review",
      arguments: "focus on authorization",
    });
    await expect(
      session.runCommand({
        vendorSessionId: "thread-1",
        name: "compact",
        arguments: "preserve this",
      }),
    ).rejects.toThrow("does not accept instructions");
    await session.runCommand({
      vendorSessionId: "thread-1",
      name: "compact",
    });
    await session.listModels();
    await session.listPermissionProfiles();
    await session.readConfig();
    await session.updateThreadSettings({ threadId: "thread-1", model: "gpt" });
    expect(
      (await session.listCommands()).map((command) => command.name),
    ).toEqual(["review", "compact", "model", "ship"]);
    expect(wire.requests.map((request) => request.method)).toEqual([
      "initialize",
      CODEX_APP_SERVER_METHODS.review,
      CODEX_APP_SERVER_METHODS.review,
      CODEX_APP_SERVER_METHODS.compact,
      CODEX_APP_SERVER_METHODS.models,
      CODEX_APP_SERVER_METHODS.permissions,
      CODEX_APP_SERVER_METHODS.config,
      CODEX_APP_SERVER_METHODS.threadSettingsUpdate,
      CODEX_APP_SERVER_METHODS.skills,
    ]);
    expect(
      wire.requests.some((request) => request.method === "turn/start"),
    ).toBe(false);
    await session.close();
  });
});

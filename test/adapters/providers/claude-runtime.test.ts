import { describe, expect, test } from "bun:test";
import { ClaudeStreamJsonAdapter } from "../../../src/adapters/providers/protocol/claude-runtime-adapter";
import { isRecord, isString } from "../../../src/shared/is-record";
import {
  CLAUDE_CHANNELS_WARNING,
  type ClaudeProcess,
} from "../../../src/adapters/providers/protocol/claude-stream-process";
import {
  capabilityFinding,
  type NormalizedProviderEvent,
  type ProviderSession,
  steadyStateUnknowns,
} from "../../../src/adapters/providers/protocol/types";
import type { JsonObject, JsonValue } from "../../../src/shared/json";
import { unsafeCast } from "../../../src/shared/unsafe-cast";

class ByteQueue implements AsyncIterable<Uint8Array> {
  private readonly buffered: Uint8Array[] = [];
  private readonly waiting: ((value: IteratorResult<Uint8Array>) => void)[] =
    [];
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
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

class FakeClaudeProcess implements ClaudeProcess {
  readonly pid: number;
  readonly stdout = new ByteQueue();
  readonly stderr = new ByteQueue();
  readonly writes: JsonObject[] = [];
  readonly exited: Promise<number>;
  readonly stdin: { write(data: string): void; end(): void };
  private resolveExit: ((code: number) => void) | null = null;
  private ended = false;

  constructor(
    pid: number,
    private readonly onWrite: (
      message: JsonObject,
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
          // SAFETY: The test owns this value and its fields.
          const message = JSON.parse(line) as JsonObject;
          this.writes.push(message);
          this.onWrite(message, this);
        }
      },
      end: () => this.exit(0),
    };
  }

  emit(message: JsonObject): void {
    this.stdout.push(`${JSON.stringify(message)}\n`);
  }

  emitStderr(text: string): void {
    this.stderr.push(text);
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

interface Harness {
  readonly adapter: ClaudeStreamJsonAdapter;
  readonly processes: FakeClaudeProcess[];
  readonly commands: readonly string[][];
}

function success(requestId: string, response: JsonValue): JsonObject {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  };
}

function harness(
  onWrite?: (message: JsonObject, process: FakeClaudeProcess) => void,
  permissionTimeoutMs = 100,
  version: string | null = "2.1.220",
): Harness {
  const processes: FakeClaudeProcess[] = [];
  const commands: string[][] = [];
  const adapter = new ClaudeStreamJsonAdapter({
    probeVersion: () => version,
    permissionTimeoutMs,
    processFactory: (command) => {
      commands.push([...command]);
      const process = new FakeClaudeProcess(
        processes.length + 10,
        (message, child) => {
          // SAFETY: The test owns this value and its fields.
          const request = message.request as JsonObject | undefined;
          const requestId = message.request_id;
          if (request?.subtype === "initialize" && isString(requestId)) {
            child.emit(
              success(requestId, {
                commands: [
                  {
                    name: "context",
                    description: "Show context",
                    argumentHint: "",
                  },
                  {
                    name: "usage",
                    description: "Show usage",
                    argumentHint: "",
                  },
                ],
                models: [{ value: "haiku", resolvedModel: "claude-haiku" }],
                account: { subscriptionType: "test" },
              }),
            );
            return;
          }
          if (request?.subtype === "get_context_usage" && isString(requestId)) {
            child.emit(
              success(requestId, {
                totalTokens: 10,
                maxTokens: 100,
                percentage: 10,
              }),
            );
            return;
          }
          onWrite?.(message, child);
        },
      );
      processes.push(process);
      return process;
    },
  });
  return { adapter, processes, commands };
}

async function connect(testHarness: Harness): Promise<ProviderSession> {
  return testHarness.adapter.connect({
    provider: "claude",
    executable: "/installed/claude-2.1.220",
    argv: ["--model", "haiku"],
    cwd: "/repo",
    env: { PATH: "/bin" },
  });
}

function record(session: ProviderSession) {
  const events: NormalizedProviderEvent[] = [];
  const finished = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return { events, finished };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function requestOf(message: JsonObject): JsonObject | null {
  if (isRecord(message.request)) return message.request;
  if (Array.isArray(message.request)) {
    return unsafeCast<JsonObject>(message.request);
  }
  return null;
}

describe("Claude stream-json runtime", () => {
  test("treats the reported version as metadata when the protocol works", async () => {
    for (const version of ["2.1.221", null] as const) {
      const testHarness = harness(undefined, 100, version);
      const probe = await testHarness.adapter.probe("/installed/claude");

      expect(probe).toMatchObject({
        provider: "claude",
        version,
        verdict: "compatible",
        catalog: { status: "ok" },
      });
      expect(testHarness.processes).toHaveLength(1);
    }
  });

  test("launches only the resolved executable over pipes", async () => {
    const testHarness = harness();
    const session = await connect(testHarness);
    const command = testHarness.commands[0] ?? [];

    expect(command[0]).toBe("/installed/claude-2.1.220");
    expect(command).toContain("--input-format");
    expect(command).toContain("--output-format");
    expect(command).toContain("--permission-prompt-tool");
    expect(command).toContain("stdio");
    expect(command).toContain("--replay-user-messages");
    expect(command).toContain("--include-partial-messages");
    expect(command.join(" ")).not.toMatch(/channels?/i);
    expect(session.capabilities.runtime).toMatchObject({
      executable: "/installed/claude-2.1.220",
      version: "2.1.220",
      transport: "claude-stream-json",
    });
    expect(session.capabilities.measured.contextUsage).toBe("supported");
    expect(capabilityFinding(session.capabilities, "modeCatalog")).toEqual({
      state: "not-reported",
      absence: {
        reason:
          "Claude Code 2.1.220 initialize advertises commands and models but no mode catalog",
        citation:
          "docs/evidence/protocol-terminal/claude/initialize.sanitized.json",
      },
    });
    expect(steadyStateUnknowns(session.capabilities)).toEqual([]);
    expect(
      (await session.listCommands()).map((command) => command.name),
    ).toEqual(["context", "usage"]);

    await session.close();
  });

  test("correlates replay ACK, partial text, tools, permission, usage, and completion", async () => {
    const testHarness = harness();
    const session = await connect(testHarness);
    const log = record(session);
    const reference = await session.newSession({
      cwd: "/repo",
      model: "haiku",
    });
    const receiptPromise = session.submit({
      session: reference,
      clientInputId: "input-1",
      text: "run pwd",
    });
    const process = testHarness.processes[0];
    if (process === undefined) throw new Error("process was not spawned");
    const submitted = process.writes.find((message) => message.type === "user");
    if (submitted === undefined) throw new Error("submission missing");
    const turnId = submitted?.uuid;
    if (!isString(turnId)) throw new Error("submission UUID missing");
    process.emit(submitted);

    expect(await receiptPromise).toEqual({
      clientInputId: "input-1",
      outcome: "accepted",
      turnId,
    });
    process.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    });
    process.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "Bash",
          input: {},
        },
      },
    });
    process.emit({
      type: "control_request",
      request_id: "permission-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        input: { command: "pwd" },
        title: "Run pwd",
      },
    });
    await tick();
    await session.respondToPermission({
      requestId: "permission-1",
      outcome: "allow",
    });
    await session.respondToPermission({
      requestId: "permission-1",
      outcome: "allow",
    });
    process.emit({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "/repo" },
        ],
      },
      uuid: "tool-result-1",
    });
    process.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          id: "tool-2",
          name: "Bash",
          input: { command: "false" },
        },
      },
    });
    process.emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-2",
            is_error: true,
            content: "command exited with status 1",
          },
        ],
      },
      uuid: "tool-result-2",
    });
    process.emit({ type: "system", subtype: "compact_boundary" });
    process.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    await tick();
    await session.close();
    await log.finished;

    expect(log.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "turn-queued",
        "turn-started",
        "message-delta",
        "tool-started",
        "approval-waiting",
        "elicitation-settled",
        "tool-finished",
        "compacted",
        "usage-updated",
        "turn-idle",
      ]),
    );
    expect(
      log.events.find(
        (event) =>
          event.kind === "usage-updated" && event.contextPercent !== null,
      ),
    ).toMatchObject({ kind: "usage-updated", contextPercent: 10 });
    expect(
      log.events.find(
        (event) =>
          event.kind === "tool-finished" && event.toolCallId === "tool-2",
      ),
    ).toMatchObject({
      kind: "tool-finished",
      status: "error",
      reason: "command exited with status 1",
    });
    const permissionResponse = process.writes.find(
      (message) =>
        message.type === "control_response" &&
        // SAFETY: The test owns this value and its fields.
        (message.response as JsonObject | undefined)?.request_id ===
          "permission-1",
    );
    expect(permissionResponse).toMatchObject({
      response: { response: { behavior: "allow", toolUseID: "tool-1" } },
    });
  });

  test("the model menu lists initialize values and /model rides a turn", async () => {
    const testHarness = harness();
    const session = await connect(testHarness);
    const reference = await session.newSession({ cwd: "/repo" });

    expect(await session.listModelIds?.()).toEqual(["haiku"]);

    const process = testHarness.processes[0];
    if (process === undefined) throw new Error("process was not spawned");
    const switching = session.setModel?.({
      vendorSessionId: reference.vendorSessionId,
      model: "haiku",
    });
    await tick();
    const submitted = process.writes.find(
      (message) =>
        message.type === "user" &&
        JSON.stringify(message).includes("/model haiku"),
    );
    if (submitted === undefined) throw new Error("model switch not submitted");
    process.emit(submitted);
    await switching;

    await session.close();
  });

  test("streamed tool input surfaces as one parsed detail, never fragments", async () => {
    const testHarness = harness();
    const session = await connect(testHarness);
    const log = record(session);
    const reference = await session.newSession({ cwd: "/repo" });
    const receiptPromise = session.submit({
      session: reference,
      clientInputId: "input-stream",
      text: "claim your mail",
    });
    const process = testHarness.processes[0];
    const submitted = process?.writes.find(
      (message) => message.type === "user",
    );
    if (process === undefined || submitted === undefined) {
      throw new Error("submission missing");
    }
    process.emit(submitted);
    expect((await receiptPromise).outcome).toBe("accepted");

    process.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "Bash",
          input: {},
        },
      },
    });
    // The input arrives as raw JSON fragments; the tail alone reads `"}`.
    for (const fragment of ['{"command": "hive', " mail claim mit_1", '"}']) {
      process.emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: fragment },
        },
      });
    }
    await tick();
    await session.close();
    await log.finished;

    const updates = log.events.filter((event) => event.kind === "tool-updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      toolCallId: "tool-1",
      detail: "hive mail claim mit_1",
      toolKind: "execute",
    });
    for (const event of log.events) {
      if (event.kind === "tool-updated" || event.kind === "tool-started") {
        expect(event.detail ?? "").not.toContain("}");
      }
    }
  });

  test("a stream drop after ACK never invents terminal completion", async () => {
    const testHarness = harness();
    const session = await connect(testHarness);
    const log = record(session);
    const reference = await session.newSession({ cwd: "/repo" });
    const receiptPromise = session.submit({
      session: reference,
      clientInputId: "input-drop",
      text: "wait",
    });
    const process = testHarness.processes[0];
    const submitted = process?.writes.find(
      (message) => message.type === "user",
    );
    if (process === undefined || submitted === undefined) {
      throw new Error("submission missing");
    }
    process.emit(submitted);
    expect((await receiptPromise).outcome).toBe("accepted");
    process.exit(9);
    await tick();
    await session.close();
    await log.finished;

    expect(log.events.map((event) => event.kind)).toContain(
      "runtime-disconnected",
    );
    expect(log.events.map((event) => event.kind)).not.toContain("turn-idle");
    expect(log.events.map((event) => event.kind)).not.toContain("turn-failed");
  });

  test("a synthetic API error becomes the exact terminal failure reason", async () => {
    const testHarness = harness();
    const session = await connect(testHarness);
    const log = record(session);
    const reference = await session.newSession({ cwd: "/repo" });
    const receiptPromise = session.submit({
      session: reference,
      clientInputId: "input-rate-limit",
      text: "continue",
    });
    const process = testHarness.processes[0];
    const submitted = process?.writes.find(
      (message) => message.type === "user",
    );
    if (process === undefined || submitted === undefined) {
      throw new Error("submission missing");
    }
    process.emit(submitted);
    await receiptPromise;
    process.emit({
      type: "assistant",
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      error: "rate_limit",
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [
          {
            type: "text",
            text: "You've hit your session limit · resets 1:50pm (America/New_York)",
          },
        ],
      },
    });
    process.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await tick();
    await session.close();
    await log.finished;

    expect(
      log.events.find((event) => event.kind === "turn-failed"),
    ).toMatchObject({
      kind: "turn-failed",
      reason:
        "You've hit your session limit · resets 1:50pm (America/New_York)",
    });
  });

  test("completion winning an interrupt race stays completed", async () => {
    interface ObservedInterrupt {
      interrupt: JsonObject | null;
    }
    const observed: ObservedInterrupt = { interrupt: null };
    const testHarness = harness((message) => {
      if (requestOf(message)?.subtype === "interrupt")
        observed.interrupt = message;
    });
    const session = await connect(testHarness);
    const log = record(session);
    const reference = await session.newSession({ cwd: "/repo" });
    const receiptPromise = session.submit({
      session: reference,
      clientInputId: "input-race",
      text: "finish",
    });
    const process = testHarness.processes[0];
    const submitted = process?.writes.find(
      (message) => message.type === "user",
    );
    if (process === undefined || submitted === undefined)
      throw new Error("missing turn");
    process.emit(submitted);
    const receipt = await receiptPromise;
    if (receipt.turnId === null) throw new Error("turn id missing");
    const cancel = session.cancel(receipt.turnId);
    await tick();
    const interrupt = observed.interrupt;
    if (interrupt === null) throw new Error("interrupt request missing");
    process.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    // SAFETY: The test owns this value and its fields.
    process.emit(success(interrupt.request_id as string, { still_queued: [] }));
    await cancel;
    await tick();
    await session.close();
    await log.finished;

    expect(log.events.map((event) => event.kind)).toContain("turn-idle");
    expect(log.events.map((event) => event.kind)).not.toContain("interrupted");
  });

  test("interrupt settles a permission wait immediately", async () => {
    const testHarness = harness((message, process) => {
      if (
        requestOf(message)?.subtype === "interrupt" &&
        isString(message.request_id)
      ) {
        process.emit(success(message.request_id, {}));
      }
    });
    const session = await connect(testHarness);
    const log = record(session);
    const reference = await session.newSession({ cwd: "/repo" });
    const receiptPromise = session.submit({
      session: reference,
      clientInputId: "input-interrupt-permission",
      text: "run pwd",
    });
    const process = testHarness.processes[0];
    const submitted = process?.writes.find(
      (message) => message.type === "user",
    );
    if (process === undefined || submitted === undefined) {
      throw new Error("missing turn");
    }
    process.emit(submitted);
    const receipt = await receiptPromise;
    if (receipt.turnId === null) throw new Error("turn id missing");
    process.emit({
      type: "control_request",
      request_id: "permission-interrupted",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "tool-interrupted",
        input: { command: "pwd" },
        title: "Run pwd",
      },
    });
    await tick();

    await session.cancel(receipt.turnId);
    await tick();
    await session.close();
    await log.finished;

    expect(log.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "elicitation-settled",
          requestId: "permission-interrupted",
          outcome: "deny",
        }),
        expect.objectContaining({
          kind: "interrupted",
          turnId: receipt.turnId,
        }),
      ]),
    );
  });

  test("permission expiry denies through the control channel", async () => {
    const testHarness = harness(undefined, 5);
    const session = await connect(testHarness);
    const process = testHarness.processes[0];
    if (process === undefined) throw new Error("process missing");
    process.emit({
      type: "control_request",
      request_id: "permission-expired",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "tool-expired",
        input: { command: "pwd" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(process.writes).toContainEqual(
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "permission-expired",
          response: expect.objectContaining({ behavior: "deny" }),
        }),
      }),
    );
    await session.close();
  });

  test("resume starts the named session without duplicating a prompt", async () => {
    const testHarness = harness();
    const session = await connect(testHarness);
    await session.resumeSession({
      vendorSessionId: "session-existing",
      style: "resume",
    });

    expect(testHarness.commands).toHaveLength(2);
    expect(testHarness.commands[1]).toContain("--resume");
    expect(testHarness.commands[1]).toContain("session-existing");
    expect(
      testHarness.processes
        .flatMap((process) => process.writes)
        .filter((message) => message.type === "user"),
    ).toEqual([]);
    await session.close();
  });

  test("Channels enablement and its startup warning fail closed", async () => {
    const testHarness = harness();
    await expect(
      testHarness.adapter.connect({
        provider: "claude",
        executable: "/installed/claude-2.1.220",
        argv: [],
        cwd: "/repo",
        env: { CLAUDE_CODE_CHANNELS_ENABLED: "true" },
      }),
    ).rejects.toThrow("Channels enablement is forbidden");
    expect("Claude Code ready").not.toMatch(CLAUDE_CHANNELS_WARNING);
    expect("WARNING: Loading development channels").toMatch(
      CLAUDE_CHANNELS_WARNING,
    );

    const warningAdapter = new ClaudeStreamJsonAdapter({
      probeVersion: () => "2.1.220",
      processFactory: () => {
        const process = new FakeClaudeProcess(99, (message, child) => {
          if (requestOf(message)?.subtype === "initialize") {
            child.emitStderr("WARNING: Loading development channels");
          }
        });
        return process;
      },
    });
    await expect(
      warningAdapter.connect({
        provider: "claude",
        executable: "/installed/claude-2.1.220",
        argv: [],
        cwd: "/repo",
        env: { PATH: "/bin" },
      }),
    ).rejects.toThrow("disconnected");
  });
});

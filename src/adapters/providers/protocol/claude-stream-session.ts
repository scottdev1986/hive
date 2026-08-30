import { randomUUID } from "node:crypto";
import {
  claudeEffectiveDefault,
  recordsFromClaudeInitialize,
} from "../../../daemon/provider-capabilities/discovery";
import type { MeasuredProviderCapabilities } from "../../../schemas/capability";
import { definedFields } from "../../../shared/defined-fields";
import { errorMessage } from "../../../shared/error-message";
import { isRecord, isString } from "../../../shared/is-record";
import {
  type JsonValue,
  requireJsonValue,
  safeJsonParse,
} from "../../../shared/json";
import {
  CLAUDE_CHANNELS_ENABLEMENT,
  CLAUDE_CHANNELS_WARNING,
  type ClaudeProcess,
  type ClaudeProcessFactory,
  signalClaudeProcessGroup,
} from "./claude-stream-process";
import {
  answersInput,
  ASK_USER_QUESTION,
  claudeQuestions,
} from "./claude-stream-questions";
import {
  accountFingerprint,
  asNumber,
  asString,
  commandFrom,
  type JsonObject,
} from "./claude-stream-wire";
import {
  claudeToolChanges,
  claudeToolDetail,
  claudeToolKind,
  claudeToolLocations,
  claudeMailResultOutput,
  claudeToolResultText,
} from "./claude-tool-calls";
import type {
  NormalizedProviderEvent,
  PermissionDecision,
  ProviderCapabilitySnapshot,
  ProviderModel,
  ProviderSession,
  ProviderSpawn,
  SessionResume,
  SessionStart,
  SubmissionReceipt,
  TurnSubmission,
  VendorCommand,
  VendorSessionRef,
} from "./types";

const CONTROL_TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 2_000;

type EmittableEvent<T = NormalizedProviderEvent> =
  T extends NormalizedProviderEvent
    ? Omit<T, "sequence" | "occurredAt" | "raw">
    : never;

class EventQueue {
  private readonly buffered: NormalizedProviderEvent[] = [];
  private readonly waiting: ((
    value: IteratorResult<NormalizedProviderEvent>,
  ) => void)[] = [];
  private ended = false;

  push(event: NormalizedProviderEvent): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter === undefined) {
      this.buffered.push(event);
      return;
    }
    waiter({ value: event, done: false });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<NormalizedProviderEvent>> {
    const value = this.buffered.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

interface PendingControl {
  readonly resolve: (response: JsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingSubmission {
  readonly clientInputId: string;
  readonly resolve: (receipt: SubmissionReceipt) => void;
}

/** A pending ask waits for as long as the person takes: an expiry would answer on their behalf, and a deny the agent then acts on is worse than a wait. */
interface PendingPermission {
  readonly request: JsonObject;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly clientInputId: string;
  state: "queued" | "working" | "terminal";
  failureReason: string | null;
  readonly startedTools: Set<string>;
  readonly finishedTools: Set<string>;
  readonly toolByBlockIndex: Map<number, string>;
  readonly toolNameById: Map<string, string>;
  readonly toolDetailById: Map<string, string | null>;
  readonly toolInputBuffers: Map<string, string>;
}

export class ClaudeStreamJsonSession implements ProviderSession {
  readonly capabilities: MeasuredProviderCapabilities;

  private readonly queue = new EventQueue();
  private readonly measurements: Record<string, "supported" | "unsupported">;
  private readonly controls = new Map<string, PendingControl>();
  private readonly submissions = new Map<string, PendingSubmission>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly disconnectReasons = new Map<number, string>();
  private sequence = 0;
  private child: ClaudeProcess | null = null;
  private childGeneration = 0;
  private currentSessionId: string = randomUUID();
  private commands: readonly VendorCommand[] = [];
  private activeTurn: ActiveTurn | null = null;
  private liveModel: string | null = null;
  private instruction: string | undefined;
  private closing = false;
  private closed = false;

  constructor(
    private readonly spawn: ProviderSpawn,
    version: string | null,
    private readonly processFactory: ClaudeProcessFactory,
    private readonly terminateChildGroup: (
      processGroupId: number,
      graceMs: number,
    ) => Promise<void>,
  ) {
    this.measurements = {
      newSession: "supported",
      prompt: "supported",
      cancel: "supported",
      permissions: "supported",
      streamingText: "supported",
      toolLifecycle: "supported",
      sessionRecovery: "supported",
      questions: "unsupported",
      commandCatalog: "supported",
      modelCatalog: "supported",
      fork: "unsupported",
      compact: "supported",
      steering: "unsupported",
    };
    this.capabilities = {
      provider: "claude",
      runtime: {
        executable: spawn.executable,
        version: version ?? "unknown",
        transport: "claude-stream-json",
        workingDirectory: spawn.cwd,
      },
      measured: this.measurements,
      absences: {
        modeCatalog: {
          reason:
            "Claude Code 2.1.220 initialize advertises commands and models but no mode catalog",
          citation:
            "docs/evidence/protocol-terminal/claude/initialize.sanitized.json",
        },
      },
      handshake: null,
    };
  }

  get events(): AsyncIterable<NormalizedProviderEvent> {
    return {
      [Symbol.asyncIterator]: () => ({ next: () => this.queue.next() }),
    };
  }

  get adapterChild(): { pid: number; processGroupId: number } | null {
    return this.child === null
      ? null
      : { pid: this.child.pid, processGroupId: this.child.pid };
  }

  async connect(): Promise<void> {
    this.assertChannelsDisabled();
    await this.startProcess({ sessionId: this.currentSessionId });
  }

  newSession(input: SessionStart): Promise<VendorSessionRef> {
    this.instruction = input.instruction;
    this.assertOpen();
    return Promise.resolve({
      vendorSessionId: this.currentSessionId,
      replayedHistory: false,
    });
  }

  async resumeSession(input: SessionResume): Promise<VendorSessionRef> {
    this.assertOpen();
    if (this.activeTurn !== null && this.activeTurn.state !== "terminal") {
      throw new Error("cannot resume Claude while a turn is active");
    }
    await this.stopProcess(false);
    this.currentSessionId = input.vendorSessionId;
    await this.startProcess({ resumeSessionId: input.vendorSessionId });
    return {
      vendorSessionId: input.vendorSessionId,
      replayedHistory: false,
    };
  }

  submit(input: TurnSubmission): Promise<SubmissionReceipt> {
    this.assertOpen();
    if (input.session.vendorSessionId !== this.currentSessionId) {
      return Promise.resolve({
        clientInputId: input.clientInputId,
        outcome: "rejected",
        turnId: null,
        detail: "submission targets a different Claude session",
      });
    }
    if ((input.attachments?.length ?? 0) > 0) {
      return Promise.resolve({
        clientInputId: input.clientInputId,
        outcome: "rejected",
        turnId: null,
        detail: "Claude stream-json attachments are not measured",
      });
    }
    if (this.activeTurn !== null && this.activeTurn.state !== "terminal") {
      return Promise.resolve({
        clientInputId: input.clientInputId,
        outcome: "rejected",
        turnId: null,
        detail: "Claude already has an active turn",
      });
    }

    const turnId = randomUUID();
    this.activeTurn = {
      turnId,
      clientInputId: input.clientInputId,
      state: "queued",
      failureReason: null,
      startedTools: new Set(),
      finishedTools: new Set(),
      toolByBlockIndex: new Map(),
      toolNameById: new Map(),
      toolDetailById: new Map(),
      toolInputBuffers: new Map(),
    };
    this.emit(
      { kind: "turn-queued", turnId },
      { clientInputId: input.clientInputId },
    );

    return new Promise((resolve) => {
      this.submissions.set(turnId, {
        clientInputId: input.clientInputId,
        resolve,
      });
      try {
        this.write({
          type: "user",
          message: { role: "user", content: input.text },
          parent_tool_use_id: null,
          origin: { kind: "user" },
          uuid: turnId,
        });
      } catch (error) {
        this.submissions.delete(turnId);
        this.activeTurn = null;
        resolve({
          clientInputId: input.clientInputId,
          outcome: "rejected",
          turnId: null,
          detail: errorMessage(error),
        });
      }
    });
  }

  async cancel(turnId: string): Promise<void> {
    this.assertOpen();
    const turn = this.activeTurn;
    if (turn === null || turn.turnId !== turnId) {
      throw new Error(`Claude turn ${turnId} is not active`);
    }
    if (turn.state === "terminal") return;

    const receipt = await this.sendControl({ subtype: "interrupt" });
    const current = this.activeTurn;
    if (
      current === null ||
      current.turnId !== turnId ||
      current.state === "terminal"
    ) {
      return;
    }
    current.state = "terminal";
    this.failPendingPermissions("Turn interrupted", true);
    this.emit({ kind: "interrupted", turnId }, receipt);
  }

  async respondToPermission(input: PermissionDecision): Promise<void> {
    this.assertOpen();
    const pending = this.permissions.get(input.requestId);
    if (pending === undefined) return;
    this.permissions.delete(input.requestId);
    const toolUseId = asString(pending.request.tool_use_id);
    const response: JsonObject =
      input.outcome === "allow"
        ? {
            behavior: "allow",
            updatedInput:
              input.answers === undefined
                ? isRecord(pending.request.input)
                  ? pending.request.input
                  : {}
                : answersInput(pending.request.input, input.answers),
            ...definedFields({
              toolUseID: toolUseId ?? undefined,
              updatedPermissions:
                input.scope === "session" &&
                Array.isArray(pending.request.permission_suggestions)
                  ? pending.request.permission_suggestions
                  : undefined,
            }),
          }
        : {
            behavior: "deny",
            message: "Denied by user",
            ...definedFields({
              toolUseID: toolUseId ?? undefined,
            }),
          };
    this.writeControlResponse(input.requestId, response);
    this.emit(
      {
        kind: "elicitation-settled",
        requestId: input.requestId,
        outcome: input.outcome,
      },
      response,
    );
  }

  /** The permission modes Claude Code 2.1.220 accepts, quoted from the error it returns for an unknown one. `bypassPermissions` is listed but only works in a session launched with --dangerously-skip-permissions, which Hive does not do; asking for it fails loudly rather than silently downgrading. */
  readonly permissionModes = [
    "default",
    "acceptEdits",
    "auto",
    "dontAsk",
    "plan",
    "bypassPermissions",
  ] as const;

  async setPermissionMode(mode: string): Promise<string> {
    this.assertOpen();
    const response = await this.sendControl({
      subtype: "set_permission_mode",
      mode,
    });
    const applied = isRecord(response) ? asString(response.mode) : null;
    if (applied === null) {
      throw new Error(`Claude did not report a permission mode for ${mode}`);
    }
    this.emit(
      { kind: "config-updated", model: null, effort: null, mode: applied },
      response,
    );
    return applied;
  }

  listCommands(): Promise<readonly VendorCommand[]> {
    this.assertOpen();
    return Promise.resolve(this.commands);
  }

  listModelIds(): Promise<readonly string[]> {
    this.assertOpen();
    const handshake = this.capabilities.handshake;
    const advertised =
      isRecord(handshake) && Array.isArray(handshake.models)
        ? handshake.models
        : [];
    const values: string[] = [];
    for (const entry of advertised) {
      const value = isRecord(entry) ? asString(entry.value) : null;
      if (value !== null && value !== "") values.push(value);
    }
    return Promise.resolve(values);
  }

  listModelCatalog(): Promise<readonly ProviderModel[]> {
    this.assertOpen();
    const handshake = this.capabilities.handshake;
    const advertised =
      isRecord(handshake) && Array.isArray(handshake.models)
        ? handshake.models
        : [];
    const models: ProviderModel[] = [];
    for (const entry of advertised) {
      if (!isRecord(entry)) continue;
      const id = asString(entry.value);
      if (id === null || id === "") continue;
      models.push({
        id,
        displayName: asString(entry.displayName) ?? asString(entry.name) ?? id,
        description: asString(entry.description),
        isDefault: entry.default === true || entry.isDefault === true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      });
    }
    return Promise.resolve(models);
  }

  async setModel(input: {
    readonly vendorSessionId: string;
    readonly model: string;
    readonly effort?: string;
  }): Promise<void> {
    const receipt = await this.submit({
      session: {
        vendorSessionId: input.vendorSessionId,
        replayedHistory: false,
      },
      clientInputId: randomUUID(),
      text: `/model ${input.model}`,
    });
    if (receipt.outcome !== "accepted") {
      throw new Error(
        receipt.detail ?? "Claude did not accept the model switch",
      );
    }
  }

  snapshot(): Promise<ProviderCapabilitySnapshot> {
    const observedAt = new Date().toISOString();
    const records = recordsFromClaudeInitialize(
      this.capabilities.handshake,
      this.capabilities.runtime.version,
      observedAt,
    );
    return Promise.resolve({
      provider: "claude",
      source: "session",
      observedAt,
      catalog:
        records.length === 0
          ? {
              status: "unavailable",
              reason: "claude returned no usable model menu",
            }
          : {
              status: "ok",
              records,
              effectiveDefault: claudeEffectiveDefault(records, observedAt),
            },
      measurements: { ...this.capabilities.measured },
      ...definedFields({ absences: this.capabilities.absences }),
      commands: [...this.commands],
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.failPendingPermissions("Claude session closed");
    await this.stopProcess(true);
    this.closed = true;
    this.queue.end();
  }

  private async startProcess(session: {
    sessionId?: string;
    resumeSessionId?: string;
  }): Promise<void> {
    this.childGeneration += 1;
    const generation = this.childGeneration;
    const command = this.launchCommand(session);
    this.emit({ kind: "runtime-connecting" }, { command });
    const child = this.processFactory(command, {
      cwd: this.spawn.cwd,
      env: this.spawn.env,
    });
    this.child = child;
    void this.readOutput(child, generation);
    void this.readErrors(child, generation);
    void this.watchExit(child, generation);

    const initialization = await this.sendControl({
      subtype: "initialize",
      systemPrompt: [this.instruction ?? ""],
    });
    if (!isRecord(initialization)) {
      throw new Error("Claude initialize response was not an object");
    }
    const commands = Array.isArray(initialization.commands)
      ? initialization.commands
          .map(commandFrom)
          .filter((value) => value !== null)
      : [];
    this.commands = commands;
    const account = accountFingerprint(initialization.account);
    if (account !== undefined) {
      Object.assign(this.capabilities.runtime, {
        accountFingerprint: account,
      });
    }
    Object.assign(this.capabilities, { handshake: initialization });
    this.emit({ kind: "commands-updated", commands }, initialization);

    const context = await this.sendControl({ subtype: "get_context_usage" });
    if (!isRecord(context) || asNumber(context.maxTokens) === null) {
      throw new Error("Claude context usage response was not measurable");
    }
    this.measurements.contextUsage = "supported";
    this.emit({ kind: "runtime-ready" }, initialization);
  }

  private launchCommand(session: {
    readonly sessionId?: string;
    readonly resumeSessionId?: string;
  }): readonly string[] {
    const sessionArgs =
      session.resumeSessionId === undefined
        ? ["--session-id", session.sessionId ?? randomUUID()]
        : ["--resume", session.resumeSessionId];
    const command = [
      this.spawn.executable,
      ...this.spawn.argv,
      ...sessionArgs,
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
      "--replay-user-messages",
      "--include-partial-messages",
      "--include-hook-events",
    ];
    if (command.some((value) => CLAUDE_CHANNELS_ENABLEMENT.test(value))) {
      throw new Error("Claude Channels enablement is forbidden");
    }
    return command;
  }

  private assertChannelsDisabled(): void {
    const environment = Object.entries(this.spawn.env).map(
      ([key, value]) => `${key}=${value}`,
    );
    if (
      this.spawn.argv.some((value) => CLAUDE_CHANNELS_ENABLEMENT.test(value)) ||
      environment.some((value) => CLAUDE_CHANNELS_ENABLEMENT.test(value))
    ) {
      throw new Error("Claude Channels enablement is forbidden");
    }
  }

  private async readOutput(
    child: ClaudeProcess,
    generation: number,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    let warningTail = "";
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      const warningProbe = warningTail + text;
      warningTail = warningProbe.slice(-128);
      if (CLAUDE_CHANNELS_WARNING.test(warningProbe)) {
        this.abortForChannelsWarning(child, generation);
        return;
      }
      buffered += text;
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) this.handleLine(line);
      }
    }
    const tail = buffered + decoder.decode();
    if (tail.length > 0) this.handleLine(tail);
  }

  private async readErrors(
    child: ClaudeProcess,
    generation: number,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let warningTail = "";
    for await (const chunk of child.stderr) {
      const text = decoder.decode(chunk, { stream: true });
      const warningProbe = warningTail + text;
      warningTail = warningProbe.slice(-128);
      if (CLAUDE_CHANNELS_WARNING.test(warningProbe)) {
        this.abortForChannelsWarning(child, generation);
        return;
      }
    }
  }

  private abortForChannelsWarning(
    child: ClaudeProcess,
    generation: number,
  ): void {
    if (generation !== this.childGeneration || child !== this.child) return;
    this.disconnectReasons.set(generation, "Claude Channels warning");
    signalClaudeProcessGroup(child, "SIGKILL");
  }

  private handleLine(line: string): void {
    const message = safeJsonParse(line);
    if (message === undefined) {
      this.emit({ kind: "unrecognized" }, line);
      return;
    }
    if (!isRecord(message)) {
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    this.handleMessage(message);
  }

  private handleMessage(message: JsonObject): void {
    const type = asString(message.type);
    if (type === "control_response") {
      this.handleControlResponse(message);
      return;
    }
    if (type === "control_request") {
      this.handleControlRequest(message);
      return;
    }
    if (type === "user") {
      this.handleUserMessage(message);
      return;
    }
    if (type === "assistant") {
      this.handleAssistantMessage(message);
      return;
    }
    if (type === "stream_event") {
      this.handleStreamEvent(message);
      return;
    }
    if (type === "result") {
      this.handleResult(message);
      return;
    }
    if (type === "system") {
      this.handleSystemMessage(message);
      return;
    }
    this.emit({ kind: "unrecognized" }, message);
  }

  private handleControlResponse(message: JsonObject): void {
    const envelope = isRecord(message.response) ? message.response : null;
    const requestId = envelope === null ? null : asString(envelope.request_id);
    if (requestId === null) {
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    const pending = this.controls.get(requestId);
    if (pending === undefined) {
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    clearTimeout(pending.timer);
    this.controls.delete(requestId);
    if (envelope?.subtype === "success") {
      pending.resolve(
        requireJsonValue(envelope.response ?? null, "Claude control response"),
      );
      return;
    }
    pending.reject(
      new Error(
        asString(envelope?.error) ?? `Claude control ${requestId} failed`,
      ),
    );
  }

  private handleControlRequest(message: JsonObject): void {
    const request = isRecord(message.request) ? message.request : null;
    const requestId = asString(message.request_id);
    if (
      request === null ||
      requestId === null ||
      request.subtype !== "can_use_tool"
    ) {
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    const turnId =
      this.activeTurn?.turnId ?? asString(request.tool_use_id) ?? "unknown";
    const toolName = asString(request.tool_name);
    // AskUserQuestion is a question wearing a permission request's clothes: it arrives on the same channel as every tool approval, and only the tool name (or the interaction flag beside it) says that allowing it is not what a person is being asked for.
    const questions =
      toolName === ASK_USER_QUESTION ? claudeQuestions(request.input) : [];
    this.permissions.set(requestId, { request });
    if (questions.length > 0) {
      const first = questions[0];
      this.emit(
        {
          kind: "question-waiting",
          requestId,
          turnId,
          summary: first?.header ?? ASK_USER_QUESTION,
          detail: first?.text ?? null,
          options: first?.options ?? [],
          questions,
        },
        message,
      );
      return;
    }
    this.emit(
      {
        kind: "approval-waiting",
        requestId,
        turnId,
        toolName,
        summary:
          asString(request.title) ??
          asString(request.description) ??
          `Claude requests ${toolName ?? "a tool"}`,
        detail: claudeToolDetail(toolName ?? "", request.input),
        // Ordinary tool approvals are allow-or-deny; Claude offers no option list for them, and an empty list is the screen's cue to ask for a verdict rather than a choice.
        options: [],
      },
      message,
    );
  }

  private handleUserMessage(message: JsonObject): void {
    let projected = false;
    const uuid = asString(message.uuid);
    const pending = uuid === null ? undefined : this.submissions.get(uuid);
    if (pending !== undefined && uuid !== null) {
      this.submissions.delete(uuid);
      const turn = this.activeTurn;
      if (turn !== null && turn.turnId === uuid && turn.state === "queued") {
        turn.state = "working";
        this.emit(
          {
            kind: "turn-started",
            turnId: uuid,
            clientInputId: pending.clientInputId,
          },
          message,
        );
        projected = true;
      }
      pending.resolve({
        clientInputId: pending.clientInputId,
        outcome: "accepted",
        turnId: uuid,
      });
    }

    const payload = isRecord(message.message) ? message.message : null;
    const content = payload === null ? null : payload.content;
    if (!Array.isArray(content)) {
      if (!projected) this.emit({ kind: "unrecognized" }, message);
      return;
    }
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const toolCallId = asString(block.tool_use_id);
      if (toolCallId !== null) {
        const error = block.is_error === true;
        if (!error) this.relayMailResult(toolCallId, block.content, message);
        this.finishTool(
          toolCallId,
          error,
          error ? claudeToolResultText(block.content) : null,
          message,
        );
        projected = true;
      }
    }
    if (!projected) this.emit({ kind: "unrecognized" }, message);
  }

  private handleAssistantMessage(message: JsonObject): void {
    const payload = isRecord(message.message) ? message.message : null;
    const content = payload === null ? null : payload.content;
    if (!Array.isArray(content)) {
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    let projected = false;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (
        block.type === "text" &&
        isString(block.text) &&
        (message.isApiErrorMessage === true ||
          asString(message.error) !== null ||
          (asNumber(message.apiErrorStatus) ?? 0) >= 400)
      ) {
        const reason = block.text.trim();
        if (reason !== "" && this.activeTurn !== null) {
          this.activeTurn.failureReason = reason;
          projected = true;
        }
        continue;
      }
      if (block.type !== "tool_use") continue;
      const toolCallId = asString(block.id);
      const toolName = asString(block.name);
      if (toolCallId !== null && toolName !== null) {
        this.startTool(toolCallId, toolName, block.input, message);
        projected = true;
      }
    }
    const model = asString(payload?.model);
    if (model !== null && model !== this.liveModel) {
      this.liveModel = model;
      this.emit(
        { kind: "config-updated", model, effort: null, mode: null },
        message,
      );
      projected = true;
    }
    if (!projected) this.emit({ kind: "unrecognized" }, message);
  }

  private handleStreamEvent(message: JsonObject): void {
    const event = isRecord(message.event) ? message.event : null;
    if (event === null) {
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    if (event.type === "content_block_start" && isRecord(event.content_block)) {
      const block = event.content_block;
      const toolCallId = asString(block.id);
      const toolName = asString(block.name);
      if (
        block.type === "tool_use" &&
        toolCallId !== null &&
        toolName !== null
      ) {
        this.startTool(
          toolCallId,
          toolName,
          block.input,
          message,
          asNumber(event.index),
        );
        return;
      }
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) {
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    const turnId = this.activeTurn?.turnId;
    if (turnId === undefined) {
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    const delta = event.delta;
    if (delta.type === "text_delta" && isString(delta.text)) {
      this.emit({ kind: "message-delta", turnId, text: delta.text }, message);
      return;
    }
    if (delta.type === "thinking_delta" && isString(delta.thinking)) {
      this.emit(
        { kind: "thought-delta", turnId, text: delta.thinking },
        message,
      );
      return;
    }
    if (delta.type === "input_json_delta" && isString(delta.partial_json)) {
      const index = asNumber(event.index);
      const toolCallId = this.toolIdAtIndex(index);
      if (toolCallId !== null) {
        this.updateStreamedToolInput(toolCallId, delta.partial_json, message);
        return;
      }
    }
    this.emit({ kind: "unrecognized" }, message);
  }

  private updateStreamedToolInput(
    toolCallId: string,
    fragment: string,
    raw: JsonValue,
  ): void {
    const turn = this.activeTurn;
    if (turn === null) return;
    const buffer = (turn.toolInputBuffers.get(toolCallId) ?? "") + fragment;
    turn.toolInputBuffers.set(toolCallId, buffer);
    const input = safeJsonParse(buffer);
    if (input === undefined) return;
    turn.toolInputBuffers.delete(toolCallId);
    const toolName = turn.toolNameById.get(toolCallId) ?? "";
    this.emit(
      {
        kind: "tool-updated",
        turnId: turn.turnId,
        toolCallId,
        detail: claudeToolDetail(toolName, input),
        toolKind: claudeToolKind(toolName),
        locations: claudeToolLocations(input),
        changes: claudeToolChanges(toolName, input),
      },
      raw,
    );
  }

  private handleResult(message: JsonObject): void {
    const turn = this.activeTurn;
    if (turn === null) {
      this.emit({ kind: "unrecognized" }, message);
      return;
    }
    const usage = isRecord(message.usage) ? message.usage : {};
    const cacheCreation = asNumber(usage.cache_creation_input_tokens);
    const cacheRead = asNumber(usage.cache_read_input_tokens);
    const input = asNumber(usage.input_tokens);
    const complete =
      input !== null && cacheCreation !== null && cacheRead !== null;
    const resultId = asString(message.uuid);
    this.emit(
      {
        kind: "usage-updated",
        turnId: turn.turnId,
        contextPercent: null,
        inputTokens: complete
          ? (input ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0)
          : asNumber(usage.input_tokens),
        outputTokens: asNumber(usage.output_tokens),
        cachedInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
        reasoningTokens: null,
        ...definedFields({
          usageKey:
            complete && resultId !== null ? `result:${resultId}` : undefined,
          cumulative: complete && resultId !== null ? false : undefined,
          source:
            complete && resultId !== null ? "claude-stream-json" : undefined,
          observedAt:
            complete && resultId !== null
              ? new Date().toISOString()
              : undefined,
        }),
      },
      message,
    );
    void this.refreshContextUsage(turn.turnId);
    if (turn.state === "terminal") return;
    turn.state = "terminal";
    if (message.is_error === true || message.subtype !== "success") {
      const errors = Array.isArray(message.errors)
        ? message.errors.filter((value) => isString(value)).join("; ")
        : "";
      const reason =
        errors ||
        asString(message.result)?.trim() ||
        turn.failureReason ||
        asString(message.error) ||
        "Claude turn failed";
      this.emit({ kind: "turn-failed", turnId: turn.turnId, reason }, message);
      return;
    }
    this.emit({ kind: "turn-idle", turnId: turn.turnId }, message);
  }

  private handleSystemMessage(message: JsonObject): void {
    if (
      message.subtype === "commands_changed" &&
      Array.isArray(message.commands)
    ) {
      this.commands = message.commands
        .map(commandFrom)
        .filter((value) => value !== null);
      this.emit({ kind: "commands-updated", commands: this.commands }, message);
      return;
    }
    const turnId = this.activeTurn?.turnId;
    if (message.subtype === "compact_boundary" && turnId !== undefined) {
      this.emit({ kind: "compacted", turnId }, message);
      return;
    }
    if (message.subtype === "tool_progress" && turnId !== undefined) {
      const toolCallId = asString(message.tool_use_id);
      if (toolCallId !== null) {
        this.emit(
          {
            kind: "tool-updated",
            turnId,
            toolCallId,
            detail: asString(message.summary),
          },
          message,
        );
        return;
      }
    }
    this.emit({ kind: "unrecognized" }, message);
  }

  private startTool<T, U>(
    toolCallId: string,
    toolName: string,
    input: T,
    raw: U,
    blockIndex: number | null = null,
  ): void {
    const turn = this.activeTurn;
    if (turn === null) return;
    if (blockIndex !== null) turn.toolByBlockIndex.set(blockIndex, toolCallId);
    turn.toolNameById.set(toolCallId, toolName);
    if (turn.startedTools.has(toolCallId)) return;
    turn.startedTools.add(toolCallId);
    const detail = claudeToolDetail(toolName, input);
    turn.toolDetailById.set(toolCallId, detail);
    this.emit(
      {
        kind: "tool-started",
        turnId: turn.turnId,
        toolCallId,
        toolName,
        detail,
        toolKind: claudeToolKind(toolName),
        locations: claudeToolLocations(input),
        changes: claudeToolChanges(toolName, input),
      },
      raw,
    );
  }

  private relayMailResult<T, U>(toolCallId: string, content: T, raw: U): void {
    const turn = this.activeTurn;
    if (turn === null) return;
    const toolName = turn.toolNameById.get(toolCallId);
    if (toolName === undefined) return;
    const output = claudeMailResultOutput(toolName, content);
    if (output === null) return;
    this.emit(
      {
        kind: "tool-updated",
        turnId: turn.turnId,
        toolCallId,
        detail: turn.toolDetailById.get(toolCallId) ?? null,
        output,
      },
      raw,
    );
  }

  private finishTool(
    toolCallId: string,
    error: boolean,
    reason: string | null,
    raw: JsonValue,
  ): void {
    const turn = this.activeTurn;
    if (turn === null || turn.finishedTools.has(toolCallId)) return;
    turn.finishedTools.add(toolCallId);
    this.emit(
      error
        ? {
            kind: "tool-finished",
            turnId: turn.turnId,
            toolCallId,
            status: "error",
            reason,
          }
        : {
            kind: "tool-finished",
            turnId: turn.turnId,
            toolCallId,
            status: "ok",
          },
      raw,
    );
  }

  private toolIdAtIndex(index: number | null): string | null {
    if (index === null || this.activeTurn === null) return null;
    return this.activeTurn.toolByBlockIndex.get(index) ?? null;
  }

  private async refreshContextUsage(turnId: string): Promise<void> {
    try {
      const context = await this.sendControl({ subtype: "get_context_usage" });
      if (!isRecord(context)) return;
      this.emit(
        {
          kind: "usage-updated",
          turnId,
          contextPercent: asNumber(context.percentage),
          inputTokens: null,
          outputTokens: null,
          contextWindow: asNumber(context.maxTokens),
        },
        context,
      );
    } catch {}
  }

  private failPendingPermissions(message: string, emitSettled = false): void {
    let canWrite = true;
    for (const [requestId, pending] of this.permissions) {
      const toolUseId = asString(pending.request.tool_use_id);
      const response = {
        behavior: "deny",
        message,
        ...definedFields({
          toolUseID: toolUseId ?? undefined,
        }),
      };
      if (canWrite) {
        try {
          this.writeControlResponse(requestId, response);
        } catch {
          canWrite = false;
        }
      }
      if (emitSettled) {
        this.emit(
          { kind: "elicitation-settled", requestId, outcome: "deny" },
          response,
        );
      }
    }
    this.permissions.clear();
  }

  private sendControl(request: JsonObject): Promise<JsonValue> {
    const requestId = randomUUID();
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(requestId);
        reject(new Error(`Claude ${String(request.subtype)} timed out`));
      }, CONTROL_TIMEOUT_MS);
      this.controls.set(requestId, { resolve, reject, timer });
      try {
        this.write({ type: "control_request", request_id: requestId, request });
      } catch (error) {
        clearTimeout(timer);
        this.controls.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeControlResponse(requestId: string, response: JsonObject): void {
    this.write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  private write(message: JsonObject): void {
    if (this.child === null)
      throw new Error("Claude transport is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async stopProcess(final: boolean): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.childGeneration += 1;
    this.child = null;
    this.rejectPendingControls("Claude control stream closed");
    try {
      child.stdin.end();
    } catch {}
    const exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), CLOSE_GRACE_MS),
      ),
    ]);
    if (!exited) {
      signalClaudeProcessGroup(child, "SIGTERM");
      const terminated = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), CLOSE_GRACE_MS),
        ),
      ]);
      if (!terminated) {
        signalClaudeProcessGroup(child, "SIGKILL");
        await child.exited;
      }
    }
    await this.terminateChildGroup(child.pid, CLOSE_GRACE_MS);
    if (final) {
      this.emit(
        { kind: "run-ended", exitCode: await child.exited },
        { close: true },
      );
    }
  }

  private async watchExit(
    child: ClaudeProcess,
    generation: number,
  ): Promise<void> {
    const exitCode = await child.exited;
    if (generation !== this.childGeneration || child !== this.child) return;
    this.child = null;
    this.rejectPendingControls("Claude control stream disconnected");
    for (const [turnId, pending] of this.submissions) {
      pending.resolve({
        clientInputId: pending.clientInputId,
        outcome: "unknown",
        turnId: null,
        detail: "Claude stream ended before submission acknowledgement",
      });
      this.submissions.delete(turnId);
    }
    this.failPendingPermissions("Claude control stream disconnected");
    if (!this.closing) {
      this.emit(
        {
          kind: "runtime-disconnected",
          reason:
            this.disconnectReasons.get(generation) ?? "Claude process exited",
        },
        { exitCode },
      );
    }
    this.disconnectReasons.delete(generation);
    this.emit({ kind: "run-ended", exitCode }, { exitCode });
  }

  private emit<T>(event: EmittableEvent, raw: T): void {
    this.sequence += 1;
    // SAFETY: The surrounding code already established this contract.
    this.queue.push({
      ...event,
      sequence: this.sequence,
      occurredAt: new Date().toISOString(),
      raw,
    } as NormalizedProviderEvent);
  }

  private rejectPendingControls(message: string): void {
    for (const pending of this.controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.controls.clear();
  }

  private assertOpen(): void {
    if (this.closed || this.closing)
      throw new Error("Claude session is closed");
  }
}

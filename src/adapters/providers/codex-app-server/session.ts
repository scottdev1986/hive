// Owns Codex App Server session state machine, preserving wire-event order,
// approval timing, turn threading, and reconnect lifecycle as one boundary.

import {
  codexEffectiveDefault,
  recordsFromCodexModelList,
} from "../../../daemon/provider-capabilities/discovery";
import type { MeasuredProviderCapabilities } from "../../../schemas/capability";
import { isRecord } from "../../../shared/is-record";
import { percentOfWindow } from "../../../usage-service/context-occupancy";
import type {
  ElicitationQuestion,
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
} from "../protocol/types";
import {
  approvalSummary,
  CODEX_APPROVAL_METHODS,
  type CodexApprovalMethod,
  type PendingApproval,
} from "./approvals";
import type { ClientRequest } from "./generated/0.146.0/ClientRequest";
import type { InitializeResponse } from "./generated/0.146.0/InitializeResponse";
import type {
  ConfigReadParams,
  ConfigReadResponse,
  ModelListParams,
  ModelListResponse,
  PermissionProfileListParams,
  PermissionProfileListResponse,
  ReviewStartParams,
  ReviewStartResponse,
  SkillsListResponse,
  ThreadCompactStartResponse,
  ThreadListParams,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadSettingsUpdateParams,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
} from "./generated/0.146.0/v2/codex-app-server-v2-types";
import {
  type CodexAppServerMessage,
  CodexAppServerRpcError,
  CodexAppServerUnknownOutcomeError,
  type CodexAppServerWire,
  type CodexAppServerWireFactory,
} from "./jsonl-rpc";
import { commandForItem, toolFailureReason, toolSucceeded } from "./tool-calls";
import {
  CODEX_APP_SERVER_METHODS,
  CodexAppServerIncompatibleError,
  initializeWire,
  isRequestId,
  type RequestId,
  requestIdKey,
  requiredString,
} from "./wire";

type ClientMethod = ClientRequest["method"];

type EmittableEvent<T = NormalizedProviderEvent> =
  T extends NormalizedProviderEvent
    ? Omit<T, "sequence" | "occurredAt">
    : never;

interface PendingQuestion {
  readonly requestId: string;
  readonly wireRequestId: RequestId;
  readonly questionIds: readonly string[];
  readonly wire: CodexAppServerWire;
}

function codexTurnFailureReason(turn: Record<string, unknown>): string {
  if (typeof turn.error === "string" && turn.error.trim() !== "") {
    return turn.error;
  }
  const error = isRecord(turn.error) ? turn.error : null;
  if (error !== null && typeof error.message === "string") {
    const detail =
      typeof error.additionalDetails === "string" &&
      error.additionalDetails.trim() !== ""
        ? ` — ${error.additionalDetails}`
        : "";
    return `${error.message}${detail}`;
  }
  return "Codex turn failed";
}

class EventQueue {
  private readonly buffered: NormalizedProviderEvent[] = [];
  private readonly waiting: Array<
    (value: IteratorResult<NormalizedProviderEvent>) => void
  > = [];
  private ended = false;

  push(event: NormalizedProviderEvent): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter === undefined) this.buffered.push(event);
    else waiter({ value: event, done: false });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<NormalizedProviderEvent>> {
    const event = this.buffered.shift();
    if (event !== undefined) {
      return Promise.resolve({ value: event, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

function capabilities(
  spawn: ProviderSpawn,
  handshake: InitializeResponse,
  version: string | null,
): MeasuredProviderCapabilities {
  return {
    provider: "codex",
    runtime: {
      executable: spawn.executable,
      version: version ?? "unknown",
      transport: "codex-app-server",
      workingDirectory: spawn.cwd,
    },
    measured: {
      newSession: "supported",
      prompt: "supported",
      cancel: "supported",
      permissions: "supported",
      streamingText: "supported",
      toolLifecycle: "supported",
      sessionRecovery: "supported",
      commandCatalog: "supported",
      modelCatalog: "supported",
      compact: "supported",
      questions: "supported",
      modeCatalog: "unsupported",
      contextUsage: "supported",
      fork: "unsupported",
      steering: "unsupported",
    },
    handshake,
  };
}

function fixedCommands(): readonly VendorCommand[] {
  return [
    {
      name: "review",
      description: "Review uncommitted changes or follow custom instructions",
      argumentHint: "[instructions]",
    },
    { name: "compact", description: "Compact the current Codex thread" },
    { name: "model", description: "List or select an App Server model" },
  ];
}

export class CodexAppServerSession implements ProviderSession {
  readonly capabilities: MeasuredProviderCapabilities;
  readonly events: AsyncIterable<NormalizedProviderEvent>;

  get adapterChild(): { pid: number; processGroupId: number } | null {
    return this.wire.adapterChild ?? null;
  }

  private readonly queue = new EventQueue();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly turnThreads = new Map<string, string>();
  private readonly pendingInputs = new Map<string, string[]>();
  private readonly commandOutputs = new Map<string, string>();
  private wire: CodexAppServerWire;
  private sequence = 0;
  private currentSessionId: string | null = null;
  private disconnected = false;
  private closed = false;

  constructor(
    private readonly spawn: ProviderSpawn,
    wire: CodexAppServerWire,
    handshake: InitializeResponse,
    version: string | null,
    private readonly wireFactory: CodexAppServerWireFactory,
    private readonly now: () => Date,
    private readonly approvalTimeoutMs: number,
  ) {
    this.wire = wire;
    this.capabilities = capabilities(spawn, handshake, version);
    this.events = {
      [Symbol.asyncIterator]: () => ({ next: () => this.queue.next() }),
    };
    this.emit({ kind: "runtime-ready", raw: handshake });
    void this.pump(wire);
  }

  async newSession(input: SessionStart): Promise<VendorSessionRef> {
    const params: ThreadStartParams = {
      cwd: input.cwd,
      model: input.model,
      developerInstructions: input.instruction,
      config:
        input.effort === undefined
          ? undefined
          : { model_reasoning_effort: input.effort },
    };
    const response = (await this.request(
      CODEX_APP_SERVER_METHODS.threadStart,
      params,
    )) as ThreadStartResponse;
    const thread =
      isRecord(response) && isRecord(response.thread) ? response.thread : null;
    if (thread === null) {
      throw new CodexAppServerIncompatibleError("thread/start omitted thread");
    }
    this.currentSessionId = requiredString(thread, "id", "thread/start thread");
    this.emitThreadConfig(response);
    return { vendorSessionId: this.currentSessionId, replayedHistory: false };
  }

  async resumeSession(input: SessionResume): Promise<VendorSessionRef> {
    const response = (await this.request(
      CODEX_APP_SERVER_METHODS.threadResume,
      {
        threadId: input.vendorSessionId,
        excludeTurns: input.style === "resume",
      },
    )) as ThreadResumeResponse;
    const thread =
      isRecord(response) && isRecord(response.thread) ? response.thread : null;
    if (thread === null) {
      throw new CodexAppServerIncompatibleError("thread/resume omitted thread");
    }
    this.currentSessionId = requiredString(
      thread,
      "id",
      "thread/resume thread",
    );
    this.emitThreadConfig(response);
    if (input.style === "load") this.replayThread(thread);
    return {
      vendorSessionId: this.currentSessionId,
      replayedHistory: input.style === "load",
    };
  }

  /** The model a thread opened with. `thread/settings/updated` only fires on a change, so without this the model stays unknown until someone switches. */
  private emitThreadConfig(response: unknown): void {
    if (!isRecord(response)) return;
    const model = typeof response.model === "string" ? response.model : null;
    if (model === null) return;
    this.emit({
      kind: "config-updated",
      model,
      effort:
        typeof response.reasoningEffort === "string"
          ? response.reasoningEffort
          : null,
      mode: null,
      raw: response,
    });
  }

  async submit(input: TurnSubmission): Promise<SubmissionReceipt> {
    const textInput = {
      type: "text" as const,
      text: input.text,
      text_elements: [],
    };
    const attachments = (input.attachments ?? []).map((attachment) => {
      if (attachment.mimeType?.startsWith("image/") === true) {
        return { type: "localImage" as const, path: attachment.path };
      }
      if (attachment.mimeType?.startsWith("audio/") === true) {
        return { type: "localAudio" as const, path: attachment.path };
      }
      throw new CodexAppServerIncompatibleError(
        `turn attachment MIME type is not schema-backed: ${attachment.mimeType ?? "unknown"}`,
      );
    });
    const params: TurnStartParams = {
      threadId: input.session.vendorSessionId,
      clientUserMessageId: input.clientInputId,
      input: [textInput, ...attachments],
    };
    const pending = this.pendingInputs.get(input.session.vendorSessionId) ?? [];
    pending.push(input.clientInputId);
    this.pendingInputs.set(input.session.vendorSessionId, pending);
    try {
      const response = (await this.request(
        CODEX_APP_SERVER_METHODS.turnStart,
        params,
      )) as TurnStartResponse;
      const turn =
        isRecord(response) && isRecord(response.turn) ? response.turn : null;
      if (turn === null) {
        throw new CodexAppServerIncompatibleError("turn/start omitted turn");
      }
      const turnId = requiredString(turn, "id", "turn/start turn");
      this.turnThreads.set(turnId, input.session.vendorSessionId);
      return {
        clientInputId: input.clientInputId,
        outcome: "accepted",
        turnId,
      };
    } catch (error) {
      const index = pending.indexOf(input.clientInputId);
      if (index >= 0) pending.splice(index, 1);
      if (error instanceof CodexAppServerRpcError) {
        return {
          clientInputId: input.clientInputId,
          outcome: "rejected",
          turnId: null,
          detail: error.message,
        };
      }
      if (error instanceof CodexAppServerUnknownOutcomeError) {
        return {
          clientInputId: input.clientInputId,
          outcome: "unknown",
          turnId: null,
          detail: error.message,
        };
      }
      throw error;
    }
  }

  async cancel(turnId: string): Promise<void> {
    const threadId = this.turnThreads.get(turnId);
    if (threadId === undefined) {
      throw new Error(`cannot interrupt unknown Codex turn ${turnId}`);
    }
    const params: TurnInterruptParams = { threadId, turnId };
    await this.request(CODEX_APP_SERVER_METHODS.turnInterrupt, params);
  }

  async respondToPermission(input: PermissionDecision): Promise<void> {
    const pending = this.pendingApprovals.get(input.requestId);
    if (pending !== undefined) {
      const result = this.approvalResult(pending, input);
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(input.requestId);
      pending.wire.respond(pending.wireRequestId, result);
      this.emit({
        kind: "elicitation-settled",
        requestId: input.requestId,
        outcome: input.outcome,
        raw: input,
      });
      return;
    }
    const question = this.pendingQuestions.get(input.requestId);
    if (question === undefined) return;
    const supplied = input.answers ?? {};
    const answers: Record<string, { answers: readonly string[] }> = {};
    for (const questionId of question.questionIds) {
      const answer = supplied[questionId];
      if (answer === undefined) continue;
      const values = typeof answer === "string" ? [answer] : [...answer];
      if (values.length > 0) answers[questionId] = { answers: values };
    }
    this.pendingQuestions.delete(input.requestId);
    question.wire.respond(question.wireRequestId, { answers });
    this.emit({
      kind: "elicitation-settled",
      requestId: input.requestId,
      outcome: "answered",
      raw: input,
    });
  }

  async listModelIds(): Promise<readonly string[]> {
    const response = await this.listModels({ includeHidden: false });
    return response.data.map((model) => model.id);
  }

  async listModelCatalog(): Promise<readonly ProviderModel[]> {
    const response = await this.listModels({ includeHidden: false });
    return response.data.map((model) => ({
      id: model.id,
      displayName: model.displayName || model.id,
      description: model.description || null,
      isDefault: model.isDefault,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map(
        (effort) => ({
          id: effort.reasoningEffort,
          description: effort.description || null,
        }),
      ),
      defaultReasoningEffort: model.defaultReasoningEffort,
    }));
  }

  async setModel(input: {
    readonly vendorSessionId: string;
    readonly model: string;
    readonly effort?: string;
  }): Promise<void> {
    await this.updateThreadSettings({
      threadId: input.vendorSessionId,
      model: input.model,
      ...(input.effort === undefined
        ? {}
        : {
            effort: input.effort as ThreadSettingsUpdateParams["effort"],
          }),
    });
  }

  async runCommand(input: {
    readonly vendorSessionId: string;
    readonly name: string;
    readonly arguments?: string;
  }): Promise<boolean> {
    if (input.name === "review") {
      const instructions = (input.arguments ?? "").trim();
      await this.startReview({
        threadId: input.vendorSessionId,
        target:
          instructions === ""
            ? { type: "uncommittedChanges" }
            : { type: "custom", instructions },
      });
      return true;
    }
    if (input.name === "compact") {
      if ((input.arguments ?? "").trim() !== "") {
        throw new Error("Codex /compact does not accept instructions");
      }
      await this.compact(input.vendorSessionId);
      return true;
    }
    return false;
  }

  async listCommands(): Promise<readonly VendorCommand[]> {
    const response = (await this.request(CODEX_APP_SERVER_METHODS.skills, {
      cwds: [this.spawn.cwd],
      forceReload: false,
    })) as SkillsListResponse;
    const commands = [...fixedCommands()];
    const names = new Set(commands.map((command) => command.name));
    if (!isRecord(response) || !Array.isArray(response.data)) return commands;
    for (const entry of response.data) {
      if (!isRecord(entry) || !Array.isArray(entry.skills)) continue;
      for (const skill of entry.skills) {
        if (!isRecord(skill) || skill.enabled !== true) continue;
        const name = typeof skill.name === "string" ? skill.name : null;
        if (name === null || names.has(name)) continue;
        names.add(name);
        commands.push({
          name,
          description:
            typeof skill.description === "string" ? skill.description : null,
        });
      }
    }
    return commands;
  }

  async snapshot(): Promise<ProviderCapabilitySnapshot> {
    const observedAt = this.now().toISOString();
    const [modelList, account, config, commands] = await Promise.all([
      this.listModels({ includeHidden: true }),
      this.request(CODEX_APP_SERVER_METHODS.account, {
        refreshToken: false,
      }).catch(() => null),
      this.readConfig().catch(() => null),
      this.listCommands().catch(() => []),
    ]);
    const records = recordsFromCodexModelList(
      modelList,
      account,
      this.capabilities.runtime.version,
      observedAt,
    );
    return {
      provider: "codex",
      source: "session",
      observedAt,
      catalog:
        records.length === 0
          ? {
              status: "unavailable",
              reason: "codex app-server returned no usable model catalog",
            }
          : {
              status: "ok",
              records,
              effectiveDefault: codexEffectiveDefault(config, observedAt),
            },
      measurements: { ...this.capabilities.measured },
      ...(this.capabilities.absences === undefined
        ? {}
        : { absences: this.capabilities.absences }),
      commands,
    };
  }

  listThreads(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    return this.request(
      CODEX_APP_SERVER_METHODS.threadList,
      params,
    ) as Promise<ThreadListResponse>;
  }

  readThread(
    threadId: string,
    includeTurns = true,
  ): Promise<ThreadReadResponse> {
    return this.request(CODEX_APP_SERVER_METHODS.threadRead, {
      threadId,
      includeTurns,
    }) as Promise<ThreadReadResponse>;
  }

  startReview(params: ReviewStartParams): Promise<ReviewStartResponse> {
    return this.request(
      CODEX_APP_SERVER_METHODS.review,
      params,
    ) as Promise<ReviewStartResponse>;
  }

  compact(threadId: string): Promise<ThreadCompactStartResponse> {
    return this.request(CODEX_APP_SERVER_METHODS.compact, {
      threadId,
    }) as Promise<ThreadCompactStartResponse>;
  }

  listModels(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.request(
      CODEX_APP_SERVER_METHODS.models,
      params,
    ) as Promise<ModelListResponse>;
  }

  listPermissionProfiles(
    params: PermissionProfileListParams = {},
  ): Promise<PermissionProfileListResponse> {
    return this.request(
      CODEX_APP_SERVER_METHODS.permissions,
      params,
    ) as Promise<PermissionProfileListResponse>;
  }

  readConfig(params: ConfigReadParams = {}): Promise<ConfigReadResponse> {
    return this.request(
      CODEX_APP_SERVER_METHODS.config,
      params,
    ) as Promise<ConfigReadResponse>;
  }

  updateThreadSettings(params: ThreadSettingsUpdateParams): Promise<void> {
    return this.request(
      CODEX_APP_SERVER_METHODS.threadSettingsUpdate,
      params,
    ).then(() => undefined);
  }

  async reconnect(): Promise<void> {
    if (this.closed) throw new Error("Codex session is closed");
    if (!this.disconnected) return;
    this.emit({ kind: "runtime-connecting", raw: { reconnect: true } });
    const wire = await this.wireFactory({
      executable: this.spawn.executable,
      argv: this.spawn.argv,
      cwd: this.spawn.cwd,
      env: this.spawn.env,
    });
    const handshake = await initializeWire(wire);
    if (this.currentSessionId !== null) {
      await wire.request(CODEX_APP_SERVER_METHODS.threadResume, {
        threadId: this.currentSessionId,
        excludeTurns: true,
      });
    }
    this.wire = wire;
    this.disconnected = false;
    this.emit({ kind: "runtime-ready", raw: handshake });
    void this.pump(wire);
  }

  async disconnect(): Promise<void> {
    if (this.closed || this.disconnected) return;
    const wire = this.wire;
    await wire.close();
    this.markDisconnected(wire, await wire.closed);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failClosedApprovals(this.wire, true);
    this.failClosedQuestions(this.wire, true);
    await this.wire.close();
    this.queue.end();
  }

  private request(method: ClientMethod, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Codex session is closed"));
    }
    return this.wire.request(method, params);
  }

  private async pump(wire: CodexAppServerWire): Promise<void> {
    for await (const message of wire.incoming) {
      await this.accept(message, wire);
    }
    const closed = await wire.closed;
    this.markDisconnected(wire, closed);
  }

  private async accept(
    message: CodexAppServerMessage,
    wire: CodexAppServerWire,
  ): Promise<void> {
    const method = typeof message.method === "string" ? message.method : null;
    const params = isRecord(message.params) ? message.params : {};
    if (isRequestId(message.id) && method === "item/tool/requestUserInput") {
      this.acceptQuestion(message.id, params, wire);
      return;
    }
    if (
      isRequestId(message.id) &&
      CODEX_APPROVAL_METHODS.includes(method as CodexApprovalMethod)
    ) {
      this.acceptApproval(
        method as CodexApprovalMethod,
        message.id,
        params,
        wire,
      );
      return;
    }
    switch (method) {
      case "turn/started": {
        const turn = isRecord(params.turn) ? params.turn : null;
        if (turn === null) break;
        const turnId = requiredString(turn, "id", "turn/started turn");
        const threadId = requiredString(params, "threadId", "turn/started");
        this.turnThreads.set(turnId, threadId);
        const pending = this.pendingInputs.get(threadId);
        const clientInputId = pending?.shift();
        this.emit({
          kind: "turn-started",
          turnId,
          ...(clientInputId === undefined ? {} : { clientInputId }),
          raw: message,
        });
        return;
      }
      case "turn/completed": {
        const turn = isRecord(params.turn) ? params.turn : null;
        if (turn === null) break;
        const turnId = requiredString(turn, "id", "turn/completed turn");
        this.clearCommandOutputs(turnId);
        if (turn.status === "completed") {
          this.emit({ kind: "turn-idle", turnId, raw: message });
        } else if (turn.status === "interrupted") {
          this.emit({ kind: "interrupted", turnId, raw: message });
        } else if (turn.status === "failed") {
          this.emit({
            kind: "turn-failed",
            turnId,
            reason: codexTurnFailureReason(turn),
            raw: message,
          });
        } else {
          this.emit({ kind: "unrecognized", raw: message });
        }
        return;
      }
      case "item/agentMessage/delta":
        this.emit({
          kind: "message-delta",
          turnId: requiredString(params, "turnId", method),
          text: requiredString(params, "delta", method),
          raw: message,
        });
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.emit({
          kind: "thought-delta",
          turnId: requiredString(params, "turnId", method),
          text: requiredString(params, "delta", method),
          raw: message,
        });
        return;
      case "item/started": {
        const item = isRecord(params.item) ? params.item : null;
        if (item === null) break;
        const command = commandForItem(item);
        if (command === null) break;
        const turnId = requiredString(params, "turnId", method);
        const toolCallId = requiredString(item, "id", `${method} item`);
        if (item.type === "commandExecution") {
          this.commandOutputs.set(`${turnId}:${toolCallId}`, "");
        }
        this.emit({
          kind: "tool-started",
          turnId,
          toolCallId,
          toolName: command.name,
          toolKind: command.toolKind,
          detail: command.detail,
          raw: message,
        });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const turnId = requiredString(params, "turnId", method);
        const toolCallId = requiredString(params, "itemId", method);
        const key = `${turnId}:${toolCallId}`;
        const output =
          (this.commandOutputs.get(key) ?? "") +
          (typeof params.delta === "string" ? params.delta : "");
        this.commandOutputs.set(key, output);
        this.emit({
          kind: "tool-updated",
          turnId,
          toolCallId,
          detail: null,
          output,
          raw: message,
        });
        return;
      }
      case "item/fileChange/outputDelta":
      case "item/mcpToolCall/progress":
        this.emit({
          kind: "tool-updated",
          turnId: requiredString(params, "turnId", method),
          toolCallId: requiredString(params, "itemId", method),
          detail: typeof params.delta === "string" ? params.delta : null,
          raw: message,
        });
        return;
      case "item/completed": {
        const item = isRecord(params.item) ? params.item : null;
        if (item === null) break;
        if (item.type === "contextCompaction") {
          this.emit({
            kind: "compacted",
            turnId: requiredString(params, "turnId", method),
            raw: message,
          });
          return;
        }
        if (commandForItem(item) === null) break;
        const turnId = requiredString(params, "turnId", method);
        const toolCallId = requiredString(item, "id", `${method} item`);
        this.commandOutputs.delete(`${turnId}:${toolCallId}`);
        const common = {
          kind: "tool-finished" as const,
          turnId,
          toolCallId,
          raw: message,
        };
        this.emit(
          toolSucceeded(item)
            ? { ...common, status: "ok" }
            : { ...common, status: "error", reason: toolFailureReason(item) },
        );
        return;
      }
      case "turn/diff/updated": {
        // Codex is the one provider that aggregates the whole turn's edits into a unified diff itself, so this is taken as sent rather than rebuilt from the individual file-change items.
        const diff = typeof params.diff === "string" ? params.diff : null;
        if (diff === null) break;
        this.emit({
          kind: "turn-diff-updated",
          turnId: requiredString(params, "turnId", method),
          diff,
          raw: message,
        });
        return;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        this.emit({
          kind: "plan-updated",
          turnId: requiredString(params, "turnId", method),
          entries: plan.flatMap((step) =>
            isRecord(step) && typeof step.step === "string" ? [step.step] : [],
          ),
          raw: message,
        });
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
        const total = isRecord(usage.total) ? usage.total : {};
        const last = isRecord(usage.last) ? usage.last : {};
        const window =
          typeof usage.modelContextWindow === "number"
            ? usage.modelContextWindow
            : null;
        // `total` sums every turn the thread has ever run, so it climbs without bound and passes the window long before the context is full. `last` is the newest turn, which is what actually occupies the window now.
        const occupiedTokens =
          typeof last.totalTokens === "number" ? last.totalTokens : null;
        const count = (value: unknown): number | null =>
          typeof value === "number" ? value : null;
        this.emit({
          kind: "usage-updated",
          turnId: requiredString(params, "turnId", method),
          contextPercent: percentOfWindow(occupiedTokens, window),
          // Codex reports one running counter for the thread rather than per-turn deltas, so the running total is the reading.
          inputTokens: count(total.inputTokens),
          outputTokens: count(total.outputTokens),
          cachedInputTokens: count(total.cachedInputTokens),
          cacheCreationInputTokens: count(total.cacheWriteInputTokens),
          reasoningTokens: count(total.reasoningOutputTokens),
          contextWindow: window,
          usageKey: "cumulative",
          cumulative: true,
          source: "codex-app-server",
          observedAt: new Date().toISOString(),
          raw: message,
        });
        return;
      }
      case "thread/settings/updated": {
        const settings = isRecord(params.threadSettings)
          ? params.threadSettings
          : {};
        this.emit({
          kind: "config-updated",
          model: typeof settings.model === "string" ? settings.model : null,
          effort: typeof settings.effort === "string" ? settings.effort : null,
          mode:
            typeof settings.collaborationMode === "string"
              ? settings.collaborationMode
              : null,
          raw: message,
        });
        return;
      }
      case "thread/compacted":
        this.emit({
          kind: "compacted",
          turnId: requiredString(params, "turnId", method),
          raw: message,
        });
        return;
      case "skills/changed": {
        const commands = await this.listCommands();
        this.emit({ kind: "commands-updated", commands, raw: message });
        return;
      }
      case "serverRequest/resolved": {
        if (!isRequestId(params.requestId)) break;
        const requestId = requestIdKey(params.requestId);
        const pending = this.pendingApprovals.get(requestId);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.pendingApprovals.delete(requestId);
        } else if (this.pendingQuestions.delete(requestId) === false) {
          return;
        }
        this.emit({
          kind: "elicitation-settled",
          requestId,
          outcome: "cancelled",
          raw: message,
        });
        return;
      }
      default:
        this.emit({ kind: "unrecognized", raw: message });
        return;
    }
    this.emit({ kind: "unrecognized", raw: message });
  }

  private acceptApproval(
    method: CodexApprovalMethod,
    id: RequestId,
    params: Record<string, unknown>,
    wire: CodexAppServerWire,
  ): void {
    const requestId = requestIdKey(id);
    if (this.pendingApprovals.has(requestId)) {
      wire.reject(id, -32_000, "duplicate approval request id");
      return;
    }
    const timer = setTimeout(
      () => this.expireApproval(requestId),
      this.approvalTimeoutMs,
    );
    this.pendingApprovals.set(requestId, {
      requestId,
      wireRequestId: id,
      method,
      params,
      wire,
      timer,
    });
    this.emit({
      kind: "approval-waiting",
      requestId,
      turnId:
        typeof params.turnId === "string" ? params.turnId : "unknown-turn",
      toolName:
        method === "item/commandExecution/requestApproval"
          ? "commandExecution"
          : method === "item/fileChange/requestApproval"
            ? "fileChange"
            : "permissions",
      summary: approvalSummary(method, params),
      raw: { method, id, params },
    });
  }

  private acceptQuestion(
    id: RequestId,
    params: Record<string, unknown>,
    wire: CodexAppServerWire,
  ): void {
    const requestId = requestIdKey(id);
    if (
      this.pendingQuestions.has(requestId) ||
      this.pendingApprovals.has(requestId)
    ) {
      wire.reject(id, -32_000, "duplicate elicitation request id");
      return;
    }
    const rawQuestions = Array.isArray(params.questions)
      ? params.questions
      : [];
    const questions: ElicitationQuestion[] = rawQuestions.flatMap(
      (raw): ElicitationQuestion[] => {
        if (!isRecord(raw)) return [];
        const questionId = typeof raw.id === "string" ? raw.id : null;
        const text = typeof raw.question === "string" ? raw.question : null;
        if (questionId === null || text === null) return [];
        const options = Array.isArray(raw.options)
          ? raw.options.flatMap((value) => {
              if (!isRecord(value) || typeof value.label !== "string") {
                return [];
              }
              return [
                {
                  optionId: value.label,
                  name: value.label,
                  kind: "allow" as const,
                  description:
                    typeof value.description === "string"
                      ? value.description
                      : null,
                },
              ];
            })
          : [];
        return [
          {
            questionId,
            text,
            header: typeof raw.header === "string" ? raw.header : null,
            multiSelect: false,
            allowCustom: raw.isOther === true || options.length === 0,
            secret: raw.isSecret === true,
            options,
          },
        ];
      },
    );
    if (questions.length === 0) {
      wire.reject(
        id,
        -32_602,
        "requestUserInput contained no usable questions",
      );
      return;
    }
    this.pendingQuestions.set(requestId, {
      requestId,
      wireRequestId: id,
      questionIds: questions.map((question) => question.questionId),
      wire,
    });
    this.emit({
      kind: "question-waiting",
      requestId,
      turnId:
        typeof params.turnId === "string" ? params.turnId : "unknown-turn",
      summary: questions[0]?.header ?? "Codex needs input",
      detail: questions[0]?.text ?? null,
      questions,
      raw: { method: "item/tool/requestUserInput", id, params },
    });
  }

  private expireApproval(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending === undefined) return;
    this.pendingApprovals.delete(requestId);
    try {
      pending.wire.respond(
        pending.wireRequestId,
        this.approvalResult(pending, { requestId, outcome: "deny" }),
      );
    } catch {}
    this.emit({
      kind: "elicitation-settled",
      requestId,
      outcome: "deny",
      raw: { reason: "approval expired" },
    });
  }

  private approvalResult(
    pending: PendingApproval,
    decision: PermissionDecision,
  ): unknown {
    if (pending.method === "item/permissions/requestApproval") {
      return decision.outcome === "allow"
        ? {
            permissions: isRecord(pending.params.permissions)
              ? pending.params.permissions
              : {},
            scope: decision.scope === "session" ? "session" : "turn",
          }
        : { permissions: {}, scope: "turn" };
    }
    const allow = decision.outcome === "allow";
    let choice = allow
      ? decision.scope === "session"
        ? "acceptForSession"
        : "accept"
      : "decline";
    if (pending.method === "item/commandExecution/requestApproval") {
      const available = Array.isArray(pending.params.availableDecisions)
        ? pending.params.availableDecisions
        : null;
      if (!allow && available !== null && !available.includes(choice)) {
        choice = available.includes("cancel") ? "cancel" : choice;
      }
      if (available !== null && !available.includes(choice)) {
        throw new Error(`Codex approval did not offer ${choice}`);
      }
    }
    return { decision: choice };
  }

  private failClosedApprovals(
    wire: CodexAppServerWire,
    canRespond: boolean,
  ): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.wire !== wire) continue;
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(requestId);
      if (canRespond) {
        try {
          pending.wire.respond(
            pending.wireRequestId,
            this.approvalResult(pending, { requestId, outcome: "deny" }),
          );
        } catch {}
      }
      this.emit({
        kind: "elicitation-settled",
        requestId,
        outcome: "deny",
        raw: { reason: "app-server disconnected" },
      });
    }
  }

  private failClosedQuestions(
    wire: CodexAppServerWire,
    canRespond: boolean,
  ): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      if (pending.wire !== wire) continue;
      this.pendingQuestions.delete(requestId);
      if (canRespond) {
        try {
          pending.wire.respond(pending.wireRequestId, { answers: {} });
        } catch {}
      }
      this.emit({
        kind: "elicitation-settled",
        requestId,
        outcome: "cancelled",
        raw: { reason: "app-server disconnected" },
      });
    }
  }

  private markDisconnected(
    wire: CodexAppServerWire,
    closed: { readonly exitCode: number | null; readonly reason: string },
  ): void {
    if (this.closed || wire !== this.wire || this.disconnected) return;
    this.disconnected = true;
    this.commandOutputs.clear();
    this.failClosedApprovals(wire, false);
    this.failClosedQuestions(wire, false);
    this.emit({
      kind: "runtime-disconnected",
      reason: closed.reason,
      raw: closed,
    });
  }

  private clearCommandOutputs(turnId: string): void {
    const prefix = `${turnId}:`;
    for (const key of this.commandOutputs.keys()) {
      if (key.startsWith(prefix)) this.commandOutputs.delete(key);
    }
  }

  private replayThread(thread: Record<string, unknown>): void {
    if (!Array.isArray(thread.turns)) return;
    for (const value of thread.turns) {
      if (!isRecord(value) || typeof value.id !== "string") continue;
      const turnId = value.id;
      this.emit({ kind: "turn-started", turnId, raw: value });
      if (Array.isArray(value.items)) {
        for (const item of value.items) {
          if (!isRecord(item)) continue;
          if (item.type === "agentMessage" && typeof item.text === "string") {
            this.emit({
              kind: "message-delta",
              turnId,
              text: item.text,
              raw: item,
            });
          }
        }
      }
      if (value.status === "completed") {
        this.emit({ kind: "turn-idle", turnId, raw: value });
      } else if (value.status === "interrupted") {
        this.emit({ kind: "interrupted", turnId, raw: value });
      } else if (value.status === "failed") {
        this.emit({
          kind: "turn-failed",
          turnId,
          reason: codexTurnFailureReason(value),
          raw: value,
        });
      }
    }
  }

  private emit(event: EmittableEvent): void {
    this.sequence += 1;
    this.queue.push({
      ...event,
      sequence: this.sequence,
      occurredAt: this.now().toISOString(),
    } as NormalizedProviderEvent);
  }
}

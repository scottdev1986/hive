import { methods as acpMethods } from "@agentclientprotocol/sdk";
import type {
  CapabilityAbsences,
  CapabilityMeasurements,
  CapabilityProvider,
  MeasuredProviderCapabilities,
  ProviderTransport,
} from "../../../schemas/capability";
import { errorMessage } from "../../../shared/error-message";
import { pollUntil } from "../../../shared/poll-until";
import { HIVE_VERSION } from "../../../shared/version";
import { AcpClient } from "./acp-client";
import {
  decodeUsageTokens,
  type EmittableNormalizedEvent,
  elicitationOptions,
  normalizeSessionUpdate,
  normalizeVendorNotification,
  parseAvailableCommands,
  permissionDetail,
  permissionOptions,
  permissionSummary,
  toolNameFromPermission,
  vendorFailureReason,
} from "./acp-normalize";
import {
  discoveryFromAcp,
  modelIdsFromAcpCatalog,
  modelsFromAcpCatalog,
} from "./capability-catalog";
import type {
  NormalizedProviderEvent,
  PermissionDecision,
  ProtocolProbe,
  ProviderCapabilitySnapshot,
  ProviderModel,
  ProviderRuntimeAdapter,
  ProviderSession,
  ProviderSpawn,
  SessionResume,
  SessionStart,
  SubmissionReceipt,
  TurnSubmission,
  VendorCommand,
  VendorSessionRef,
} from "./types";

const STDERR_LINE_LIMIT = 8;
const STDERR_LINE_CHARACTER_LIMIT = 512;
/** Vendor stderr becomes user-facing only after control sequences, likely credential values, and user paths are removed. Sanitizing before code-point clipping also prevents a clipped escape sequence from becoming display input. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_ESCAPE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`,
  "g",
);
const CONTROL_CHARACTER =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: These ranges deliberately strip C0/C1 control bytes from provider stderr before it reaches the terminal.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const SENSITIVE_VALUE =
  /((?:authorization|api[-_ ]?key|token|secret|password|credentials?)\s*(?:[:=]|\bis\b)\s*)(?:Bearer\s+\S+|"[^"]*"|'[^']*'|\S+)/gi;
const OPAQUE_VALUE = /[A-Za-z0-9_+/=-]{32,}/g;
const USER_PATH = /(?:\/(?:Users|home)\/|[A-Za-z]:\\Users\\)[^\s"'`]+/g;

function captureStderrLine(lines: string[], line: string): void {
  const displayable = line
    .replaceAll(ANSI_ESCAPE, "")
    .replaceAll(CONTROL_CHARACTER, "")
    .replaceAll(USER_PATH, "[PATH]")
    .replaceAll(SENSITIVE_VALUE, "$1[REDACTED]")
    .replaceAll(OPAQUE_VALUE, "[REDACTED]")
    .trim();
  if (displayable.length === 0) return;
  const characters = Array.from(displayable);
  const bounded =
    characters.length <= STDERR_LINE_CHARACTER_LIMIT
      ? displayable
      : `${characters.slice(0, STDERR_LINE_CHARACTER_LIMIT - 1).join("")}…`;
  lines.push(bounded);
  if (lines.length > STDERR_LINE_LIMIT) lines.shift();
}

function failureDetail(error: unknown, stderrLines: readonly string[]): string {
  const sdkMessage = errorMessage(error);
  return stderrLines.length === 0
    ? sdkMessage
    : `${stderrLines.join("\n")}\nACP error: ${sdkMessage}`;
}

class EventQueue {
  private readonly buffered: NormalizedProviderEvent[] = [];
  private readonly waiting: ((
    value: IteratorResult<NormalizedProviderEvent>,
  ) => void)[] = [];
  private ended = false;

  push(event: NormalizedProviderEvent): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter !== undefined) {
      waiter({ value: event, done: false });
      return;
    }
    this.buffered.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<NormalizedProviderEvent>> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

export interface AcpVendorProfile {
  readonly provider: CapabilityProvider;
  readonly transport: ProviderTransport;
  readonly afterInitialize?: (
    client: AcpClient,
    handshake: unknown,
  ) => Promise<void>;
  readonly incompatibleReason?: (handshake: unknown) => string | null;
  readonly cancelAs: "notification" | "request";
  readonly loadMethod: string;
  readonly resumeMethod: string | null;
  readonly supportsSessionClose: boolean;
  readonly supportsFork: boolean;
  /** Vendor notification methods outside the standard ACP method catalog. */
  readonly extensionNotificationMethods?: readonly string[];
  /** Starting measurements. Baseline rows stay absent until live proof — handshake advertisements alone never write "supported". */
  readonly initialMeasured: CapabilityMeasurements;
  /** When set, distinguishes questions from tool permissions on the shared `session/request_permission` reverse-RPC (Kimi AskUserQuestion). Absent means every reverse-RPC is a permission (Grok/OpenCode default). */
  readonly isQuestion?: (params: unknown) => boolean;
  /** When true, `resumeSession({ style: "load" })` measures `replayedHistory` from observed user/agent chunks during the load window rather than from the style argument alone (Kimi load vs resume). */
  readonly measureLoadReplay?: boolean;
  readonly configOptionIds?: {
    readonly model?: string;
    readonly effort?: string;
    readonly mode?: string;
  };
  readonly sessionMode?: string;
  readonly sessionOptionMethods?: {
    readonly model?: string;
    readonly effort?: string;
  };
  readonly absences?: CapabilityAbsences;
}

interface PendingPermission {
  readonly params: unknown;
  readonly kind: "permission" | "question";
  resolve: ((result: unknown) => void) | null;
  reject: ((error: Error) => void) | null;
  settled: boolean;
}

export class AcpProviderSession implements ProviderSession {
  readonly capabilities: MeasuredProviderCapabilities;
  private readonly client: AcpClient;
  private readonly profile: AcpVendorProfile;
  private readonly stderrLines: string[];
  private readonly queue = new EventQueue();
  private sequence = 0;
  private vendorSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private commands: VendorCommand[] = [];
  private commandCatalogObserved = false;
  private sessionNewPayload: unknown = null;
  private contextWindow: number | null = null;
  private readonly modelConfigurations = new Map<string, unknown>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private permissionSeq = 0;
  private turnSeq = 0;
  private closed = false;
  private loadReplayChunkCount = 0;
  private observingLoadReplay = false;
  /** ACP session/new has no instruction field. Grok and Kimi only see a queen boot capsule (or worker brief) if it rides the first session/prompt. OpenCode already injects that file through opencode.json and must not get a second copy. */
  private pendingInstruction: string | undefined;

  private constructor(
    profile: AcpVendorProfile,
    spawn: ProviderSpawn,
    handshake: unknown,
    client: AcpClient,
    stderrLines: string[],
  ) {
    this.profile = profile;
    this.client = client;
    this.stderrLines = stderrLines;
    this.capabilities = {
      provider: profile.provider,
      runtime: {
        executable: spawn.executable,
        version: versionFromHandshake(handshake) ?? "unknown",
        transport: profile.transport,
        workingDirectory: spawn.cwd,
      },
      measured: { ...profile.initialMeasured },
      ...(profile.absences !== undefined ? { absences: profile.absences } : {}),
      handshake,
    };
  }

  static async connect(
    profile: AcpVendorProfile,
    spawn: ProviderSpawn,
    options: { requestTimeoutMs?: number } = {},
  ): Promise<AcpProviderSession> {
    let sessionRef: AcpProviderSession | null = null;
    const stderrLines: string[] = [];

    const client = new AcpClient({
      executable: spawn.executable,
      argv: spawn.argv,
      cwd: spawn.cwd,
      env: spawn.env,
      extensionNotificationMethods: profile.extensionNotificationMethods,
      onRequest: async (method, params) => {
        if (sessionRef === null) {
          throw new Error(`ACP reverse-RPC before session ready: ${method}`);
        }
        return sessionRef.handleReverseRpc(method, params);
      },
      onNotification: (method, params) => {
        sessionRef?.handleNotification(method, params);
      },
      onStderrLine: (line) => captureStderrLine(stderrLines, line),
    });

    client.start();

    try {
      const handshake = await withinDeadline(
        client.acp.request(acpMethods.agent.initialize, {
          protocolVersion: 1,
          clientInfo: { name: "hive", version: HIVE_VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
        options.requestTimeoutMs,
        `${profile.provider} ACP initialize`,
      );
      const incompatible = profile.incompatibleReason?.(handshake) ?? null;
      if (incompatible !== null) throw new Error(incompatible);

      if (profile.provider !== "grok") {
        client.notify("initialized", {});
      }

      if (profile.afterInitialize !== undefined) {
        await withinDeadline(
          profile.afterInitialize(client, handshake),
          options.requestTimeoutMs,
          `${profile.provider} ACP authentication`,
        );
      }

      const session = new AcpProviderSession(
        profile,
        spawn,
        handshake,
        client,
        stderrLines,
      );
      sessionRef = session;
      session.ingestHandshakeCommands(handshake);
      session.emit({ kind: "runtime-ready", raw: handshake });
      return session;
    } catch (error) {
      await client.close();
      throw new Error(failureDetail(error, stderrLines));
    }
  }

  get events(): AsyncIterable<NormalizedProviderEvent> {
    return {
      [Symbol.asyncIterator]: () => ({ next: () => this.queue.next() }),
    };
  }

  get adapterChild(): { pid: number; processGroupId: number } | null {
    const pid = this.client.pid;
    return pid === null ? null : { pid, processGroupId: pid };
  }

  async newSession(input: SessionStart): Promise<VendorSessionRef> {
    const configIds = this.profile.configOptionIds;
    const result = await this.client.acp.request(acpMethods.agent.session.new, {
      cwd: input.cwd,
      mcpServers: [],
      ...(configIds === undefined &&
      this.profile.sessionOptionMethods === undefined &&
      input.model !== undefined
        ? { model: input.model }
        : {}),
    });
    const sessionId = sessionIdFrom(result);
    if (sessionId === null) {
      throw new Error("session/new returned no sessionId");
    }
    this.vendorSessionId = sessionId;
    this.sessionNewPayload = result;
    this.mark("newSession", "supported");
    this.ingestSessionNewExtras(result);

    if (configIds !== undefined) {
      if (input.model !== undefined && configIds.model !== undefined) {
        await this.setConfigOption(configIds.model, input.model);
      }
      if (input.effort !== undefined && configIds.effort !== undefined) {
        await this.setConfigOption(configIds.effort, input.effort);
      }
      const mode = input.mode ?? this.profile.sessionMode;
      if (mode !== undefined && configIds.mode !== undefined) {
        await this.setConfigOption(configIds.mode, mode);
      }
      const model =
        configIds.model === undefined
          ? null
          : currentConfigValue(this.sessionNewPayload, configIds.model);
      const effort =
        configIds.effort === undefined
          ? null
          : currentConfigValue(this.sessionNewPayload, configIds.effort);
      const appliedMode =
        configIds.mode === undefined
          ? null
          : currentConfigValue(this.sessionNewPayload, configIds.mode);
      if (model !== null || effort !== null || appliedMode !== null) {
        this.emit({
          kind: "config-updated",
          model,
          effort,
          mode: appliedMode,
          raw: this.sessionNewPayload,
        });
      }
    }
    const methods = this.profile.sessionOptionMethods;
    if (methods?.model !== undefined && input.model !== undefined) {
      await this.client.request(methods.model, {
        sessionId,
        modelId: input.model,
      });
    }
    if (methods?.effort !== undefined && input.effort !== undefined) {
      await this.client.request(methods.effort, {
        sessionId,
        modeId: input.effort,
      });
    }

    if (
      (this.profile.provider === "grok" || this.profile.provider === "kimi") &&
      input.instruction !== undefined &&
      input.instruction !== ""
    ) {
      this.pendingInstruction = input.instruction;
    }

    return { vendorSessionId: sessionId, replayedHistory: false };
  }

  async resumeSession(input: SessionResume): Promise<VendorSessionRef> {
    const method =
      input.style === "load"
        ? this.profile.loadMethod
        : (this.profile.resumeMethod ?? this.profile.loadMethod);

    const measureReplay =
      this.profile.measureLoadReplay === true && input.style === "load";
    if (measureReplay) {
      this.observingLoadReplay = true;
      this.loadReplayChunkCount = 0;
    }

    const result = await this.client.request(method, {
      sessionId: input.vendorSessionId,
      cwd: this.capabilities.runtime.workingDirectory,
      mcpServers: [],
    });
    const sessionId = sessionIdFrom(result) ?? input.vendorSessionId;
    this.vendorSessionId = sessionId;
    this.mark("sessionRecovery", "supported");

    let replayedHistory: boolean;
    if (measureReplay) {
      await this.drainLoadReplayWindow(5_000, 400);
      this.observingLoadReplay = false;
      replayedHistory = this.loadReplayChunkCount > 0;
    } else if (input.style === "load" || this.profile.resumeMethod === null) {
      replayedHistory = input.style === "load";
    } else {
      replayedHistory = false;
    }

    return { vendorSessionId: sessionId, replayedHistory };
  }

  /** Apply a vendor config option (model/effort/mode/…). Used by profiles that surface config via ACP `session/set_config_option` rather than session/new. */
  async setConfigOption(configId: string, value: string): Promise<unknown> {
    const sessionId = this.vendorSessionId;
    if (sessionId === null) {
      throw new Error("setConfigOption: no active vendor session");
    }
    const result = await this.client.acp.request(
      acpMethods.agent.session.setConfigOption,
      {
        sessionId,
        configId,
        value,
      },
    );
    const resultRoot = asRecord(result);
    if (Array.isArray(resultRoot?.configOptions)) {
      this.sessionNewPayload = result;
    }
    if (
      (configId.includes("model") || configId === "model") &&
      typeof value === "string"
    ) {
      this.modelConfigurations.set(value, result);
    }
    if (configId.includes("model") || configId === "model") {
      this.mark("modelCatalog", "supported");
    }
    if (configId.includes("mode") || configId === "mode") {
      this.mark("modeCatalog", "supported");
    }
    return result;
  }

  async submit(input: TurnSubmission): Promise<SubmissionReceipt> {
    const sessionId = input.session.vendorSessionId;
    this.vendorSessionId = sessionId;
    // The turn id is the session's own, never the submission's clientInputId: the delivery ledger correlates on clientInputId and proves the turn on turnId, so the two must be distinct values (Scott's measured-status rule).
    this.turnSeq += 1;
    const turnId = `turn-${this.turnSeq}`;
    this.activeTurnId = turnId;
    this.stderrLines.length = 0;
    this.emit({
      kind: "turn-started",
      turnId,
      clientInputId: input.clientInputId,
      raw: { submitted: true },
    });

    try {
      const instruction = this.pendingInstruction;
      this.pendingInstruction = undefined;
      const text =
        instruction === undefined
          ? input.text
          : `${instruction}\n\n${input.text}`;
      const result = await this.client.acp.request(
        acpMethods.agent.session.prompt,
        {
          sessionId,
          prompt: [{ type: "text", text }],
        },
      );
      this.mark("prompt", "supported");
      this.emitUsageFromPromptResult(result, turnId);
      const stop = stopReasonFrom(result);
      if (stop === "cancelled" || stop === "interrupted") {
        this.emit({ kind: "interrupted", turnId, raw: result });
        this.mark("cancel", "supported");
      } else if (stop === "end_turn" || stop === null) {
        this.emit({ kind: "turn-idle", turnId, raw: result });
      } else {
        this.emit({
          kind: "turn-failed",
          turnId,
          reason: vendorFailureReason(result, stop),
          raw: result,
        });
      }
      this.activeTurnId = null;
      return {
        clientInputId: input.clientInputId,
        outcome: "accepted",
        turnId,
      };
    } catch (error) {
      this.activeTurnId = null;
      const detail = failureDetail(error, this.stderrLines);
      this.emit({
        kind: "turn-failed",
        turnId,
        reason: detail,
        raw: { error: detail },
      });
      // Classify on the SDK's own message, never on `detail`: `detail` now
      // leads with vendor stderr, and untrusted vendor logging can contain
      // "exited" or "closed" for reasons unrelated to this transport, which
      // would misroute a plain rejection into the unknown/unconfirmed path.
      const sdkMessage = errorMessage(error);
      if (
        this.closed ||
        sdkMessage.includes("exited") ||
        sdkMessage.includes("closed")
      ) {
        return {
          clientInputId: input.clientInputId,
          outcome: "unknown",
          turnId: null,
          detail,
        };
      }
      return {
        clientInputId: input.clientInputId,
        outcome: "rejected",
        turnId: null,
        detail,
      };
    }
  }

  async cancel(_turnId: string): Promise<void> {
    const sessionId = this.vendorSessionId;
    if (sessionId === null) {
      throw new Error("cancel: no active vendor session");
    }
    if (this.profile.cancelAs === "notification") {
      void this.client.acp.notify(acpMethods.agent.session.cancel, {
        sessionId,
      });
    } else {
      await this.client.request("session/cancel", { sessionId });
    }
  }

  async respondToPermission(input: PermissionDecision): Promise<void> {
    const pending = this.pendingPermissions.get(input.requestId);
    if (pending === undefined) return;
    if (pending.settled) return;
    pending.settled = true;

    const options = permissionOptions(pending.params);
    let optionId = input.optionId;
    if (optionId === undefined) {
      const want = input.outcome === "allow" ? "allow" : "reject";
      const match = options.find(
        (option) =>
          option.kind.toLowerCase().includes(want) ||
          option.optionId.toLowerCase().includes(want),
      );
      optionId =
        match?.optionId ??
        (pending.kind === "question" ? undefined : options[0]?.optionId);
    }
    if (optionId === undefined) {
      if (pending.kind === "question" && options.length > 0) {
        pending.settled = false;
        throw new Error(
          `respondToPermission: ${input.requestId} is a question; answer it with one of its optionIds (${options.map((option) => option.optionId).join(", ")})`,
        );
      }
      pending.reject?.(new Error("no optionId available"));
      this.pendingPermissions.delete(input.requestId);
      throw new Error("respondToPermission: no optionId available");
    }

    const result = { outcome: { outcome: "selected", optionId } };
    pending.resolve?.(result);
    this.pendingPermissions.delete(input.requestId);
    if (pending.kind === "question") {
      this.emit({
        kind: "elicitation-settled",
        requestId: input.requestId,
        outcome: "answered",
        raw: { optionId, decision: input.outcome },
      });
      this.mark("questions", "supported");
    } else {
      this.emit({
        kind: "elicitation-settled",
        requestId: input.requestId,
        outcome: input.outcome,
        raw: { optionId },
      });
      this.mark("permissions", "supported");
    }
  }

  async listCommands(): Promise<readonly VendorCommand[]> {
    return this.commands;
  }

  async listModelIds(): Promise<readonly string[]> {
    return (await this.listModelCatalog()).map((model) => model.id);
  }

  async listModelCatalog(): Promise<readonly ProviderModel[]> {
    return modelsFromAcpCatalog(
      acpProvider(this.profile.provider),
      this.capabilities.handshake,
      this.sessionNewPayload,
      this.modelConfigurations,
    );
  }

  get permissionModes(): readonly string[] {
    const configId = this.profile.configOptionIds?.mode;
    return configId === undefined
      ? []
      : configOptionValues(this.sessionNewPayload, configId);
  }

  async setPermissionMode(mode: string): Promise<string> {
    const configId = this.profile.configOptionIds?.mode;
    if (configId === undefined) {
      throw new Error(
        `${this.profile.provider} offers no permission mode switch over ACP`,
      );
    }
    const offered = this.permissionModes;
    if (offered.length > 0 && !offered.includes(mode)) {
      throw new Error(`${this.profile.provider} offers: ${offered.join(", ")}`);
    }
    const raw = await this.setConfigOption(configId, mode);
    const applied = currentConfigValue(raw, configId) ?? mode;
    this.emit({
      kind: "config-updated",
      model: null,
      effort: null,
      mode: applied,
      raw,
    });
    return applied;
  }

  /** Models over ACP are session settings: a config option for vendors that expose one, a session-option method for vendors that expose that instead. The request succeeding is the vendor accepting the value, so the config event carries what was accepted rather than a hope. */
  async setModel(input: {
    readonly vendorSessionId: string;
    readonly model: string;
    readonly effort?: string;
  }): Promise<void> {
    const configId = this.profile.configOptionIds?.model;
    if (configId !== undefined) {
      let raw = await this.setConfigOption(configId, input.model);
      const effortId = this.profile.configOptionIds?.effort;
      if (effortId !== undefined && input.effort !== undefined) {
        raw = await this.setConfigOption(effortId, input.effort);
      }
      this.emit({
        kind: "config-updated",
        model: input.model,
        effort: input.effort ?? null,
        mode: null,
        raw,
      });
      return;
    }
    const method = this.profile.sessionOptionMethods?.model;
    if (method !== undefined) {
      let raw = await this.client.request(method, {
        sessionId: input.vendorSessionId,
        modelId: input.model,
      });
      const effortMethod = this.profile.sessionOptionMethods?.effort;
      if (effortMethod !== undefined && input.effort !== undefined) {
        raw = await this.client.request(effortMethod, {
          sessionId: input.vendorSessionId,
          modeId: input.effort,
        });
      }
      this.emit({
        kind: "config-updated",
        model: input.model,
        effort: input.effort ?? null,
        mode: null,
        raw,
      });
      return;
    }
    throw new Error(`${this.profile.provider} offers no model switch over ACP`);
  }

  async measureModelCatalog(): Promise<void> {
    const modelConfigId = this.profile.configOptionIds?.model;
    if (modelConfigId === undefined) return;
    const modelIds = modelIdsFromAcpCatalog(this.sessionNewPayload);
    const current = currentConfigValue(this.sessionNewPayload, modelConfigId);
    try {
      for (const modelId of modelIds) {
        await this.setConfigOption(modelConfigId, modelId);
      }
    } finally {
      if (current !== null) await this.setConfigOption(modelConfigId, current);
    }
  }

  async settleInitialCatalog(maxMs = 500): Promise<void> {
    await pollUntil(() => this.commandCatalogObserved, {
      intervalMs: 10,
      timeoutMs: maxMs,
    });
  }

  async snapshot(): Promise<ProviderCapabilitySnapshot> {
    const provider = acpProvider(this.profile.provider);
    const observedAt = new Date().toISOString();
    return {
      provider,
      source: "session",
      observedAt,
      catalog: discoveryFromAcp(
        provider,
        {
          handshake: this.capabilities.handshake,
          sessionNew: this.sessionNewPayload,
          modelConfigurations: this.modelConfigurations,
        },
        this.capabilities.runtime.version,
        observedAt,
      ),
      measurements: { ...this.capabilities.measured },
      ...(this.capabilities.absences === undefined
        ? {}
        : { absences: this.capabilities.absences }),
      commands: [...this.commands],
    };
  }

  async forkSession(): Promise<VendorSessionRef> {
    if (!this.profile.supportsFork) {
      throw new Error("forkSession: vendor profile does not support fork");
    }
    const sessionId = this.vendorSessionId;
    if (sessionId === null) throw new Error("forkSession: no session");
    const result = await this.client.request("session/fork", {
      sessionId,
      cwd: this.capabilities.runtime.workingDirectory,
      mcpServers: [],
    });
    const forked = sessionIdFrom(result);
    if (forked === null) throw new Error("session/fork returned no sessionId");
    this.mark("fork", "supported");
    return { vendorSessionId: forked, replayedHistory: true };
  }

  async listSessions(): Promise<unknown> {
    return this.client.acp.request(acpMethods.agent.session.list, {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const [requestId, pending] of this.pendingPermissions) {
      pending.settled = true;
      pending.reject?.(new Error("session closed"));
      this.pendingPermissions.delete(requestId);
      this.emit({
        kind: "elicitation-settled",
        requestId,
        outcome: "cancelled",
        raw: { reason: "session-closed" },
      });
    }

    if (this.profile.supportsSessionClose && this.vendorSessionId !== null) {
      try {
        await this.client.acp.request(acpMethods.agent.session.close, {
          sessionId: this.vendorSessionId,
        });
      } catch {}
    }
    await this.client.close("SIGTERM");
    this.emit({
      kind: "runtime-disconnected",
      reason: "closed",
      raw: { closed: true },
    });
    this.emit({ kind: "run-ended", exitCode: null, raw: { closed: true } });
    this.queue.end();
  }

  get rawClient(): AcpClient {
    return this.client;
  }

  private handleReverseRpc(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      this.permissionSeq += 1;
      const requestId = `perm-${this.permissionSeq}`;
      const isQuestion = this.profile.isQuestion?.(params) === true;
      const pending: PendingPermission = {
        params,
        kind: isQuestion ? "question" : "permission",
        resolve: null,
        reject: null,
        settled: false,
      };
      this.pendingPermissions.set(requestId, pending);
      if (isQuestion) {
        this.emit({
          kind: "question-waiting",
          requestId,
          turnId: this.activeTurnId ?? "unknown-turn",
          summary: permissionSummary(params),
          detail: permissionDetail(params),
          options: elicitationOptions(params),
          raw: params,
        });
      } else {
        this.emit({
          kind: "approval-waiting",
          requestId,
          turnId: this.activeTurnId ?? "unknown-turn",
          toolName: toolNameFromPermission(params),
          summary: permissionSummary(params),
          detail: permissionDetail(params),
          options: elicitationOptions(params),
          raw: params,
        });
      }
      return new Promise((resolve, reject) => {
        pending.resolve = resolve;
        pending.reject = reject;
      });
    }

    if (method.startsWith("fs/") || method.startsWith("terminal/")) {
      throw new Error(`unsupported reverse-RPC: ${method}`);
    }
    throw new Error(`Method not found: ${method}`);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      const events = normalizeSessionUpdate(params, this.activeTurnId);
      for (const event of events) {
        if (this.observingLoadReplay) {
          if (
            event.kind === "message-delta" ||
            event.kind === "thought-delta"
          ) {
            this.loadReplayChunkCount += 1;
          } else if (event.kind === "unrecognized") {
            const raw = asRecord(event.raw);
            const update = asRecord(raw?.update) ?? raw;
            const kind =
              asString(update?.sessionUpdate) ??
              asString(update?.session_update);
            if (kind === "user_message_chunk") {
              this.loadReplayChunkCount += 1;
            }
          }
        }
        if (event.kind === "commands-updated") {
          this.commands = [...event.commands];
          this.commandCatalogObserved = true;
          this.mark("commandCatalog", "supported");
        }
        if (event.kind === "message-delta" || event.kind === "thought-delta") {
          this.mark("streamingText", "supported");
        }
        if (
          event.kind === "tool-started" ||
          event.kind === "tool-updated" ||
          event.kind === "tool-finished"
        ) {
          this.mark("toolLifecycle", "supported");
        }
        if (event.kind === "usage-updated") {
          this.mark("contextUsage", "supported");
        }
        this.emit(event);
      }
      return;
    }
    const events = normalizeVendorNotification(
      method,
      params,
      this.activeTurnId,
    );
    for (const event of events) {
      if (event.kind === "interrupted") {
        this.mark("cancel", "supported");
      }
      if (event.kind === "usage-updated") {
        this.mark("contextUsage", "supported");
      }
      this.emit(event);
    }
  }

  private ingestHandshakeCommands(handshake: unknown): void {
    const root = asRecord(handshake);
    const meta = asRecord(root?._meta);
    const commands = parseAvailableCommands(meta?.availableCommands);
    if (Array.isArray(meta?.availableCommands)) {
      this.commands = [...commands];
      this.commandCatalogObserved = true;
      this.mark("commandCatalog", "supported");
      this.emit({
        kind: "commands-updated",
        commands,
        raw: meta?.availableCommands,
      });
    }
    if (meta?.modelState !== undefined || root?.agentInfo !== undefined) {
      this.mark("modelCatalog", "supported");
    }
    this.ingestModelState(asRecord(meta?.modelState));
  }

  /** The model the session is on, and the window that model serves. Both come from the vendor's own model state rather than from its billing breakdown: the breakdown names what was charged (`grok-4.5-build`), which is not the id the session, its summary, or the routing policy calls this model (`grok-4.5`). One fact with two sources is two facts waiting to disagree, and the id everything else uses is the live one. */
  private ingestModelState(modelState: Record<string, unknown> | null): void {
    if (modelState === null) return;
    const current = asString(modelState.currentModelId);
    if (current === undefined) return;
    const entry = (
      Array.isArray(modelState.availableModels)
        ? modelState.availableModels
        : []
    )
      .map((raw) => asRecord(raw))
      .find((raw) => asString(raw?.modelId) === current);
    const window = asRecord(entry?._meta)?.totalContextTokens;
    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
      this.contextWindow = window;
    }
    this.emit({
      kind: "config-updated",
      model: current,
      effort: null,
      mode: null,
      raw: modelState,
    });
  }

  private ingestSessionNewExtras(result: unknown): void {
    const root = asRecord(result);
    if (Array.isArray(root?.configOptions)) {
      this.mark("modelCatalog", "supported");
      const hasMode = (root.configOptions as unknown[]).some((entry) => {
        const rec = asRecord(entry);
        return (
          asString(rec?.id) === "mode" || asString(rec?.category) === "mode"
        );
      });
      if (hasMode) this.mark("modeCatalog", "supported");
    }
    if (asRecord(root?.models) !== null) {
      this.mark("modelCatalog", "supported");
    }
  }

  private emit(event: EmittableNormalizedEvent): void {
    this.sequence += 1;
    // A usage frame states the window only where the vendor puts it on that frame. Grok states it once, on the model it selected at handshake, so the session carries it forward rather than leaving the reading windowless.
    const windowed =
      event.kind === "usage-updated" &&
      event.contextWindow == null &&
      this.contextWindow !== null
        ? { ...event, contextWindow: this.contextWindow }
        : event;
    const value = {
      ...windowed,
      sequence: this.sequence,
      occurredAt: new Date().toISOString(),
      raw: event.raw ?? { kind: event.kind },
    } as NormalizedProviderEvent;
    this.queue.push(value);
  }

  private mark(
    name: keyof CapabilityMeasurements,
    support: NonNullable<CapabilityMeasurements[keyof CapabilityMeasurements]>,
  ): void {
    (this.capabilities.measured as Record<string, string>)[name] = support;
  }

  private emitUsageFromPromptResult(result: unknown, turnId: string): void {
    const root = asRecord(result);
    const meta = asRecord(root?._meta);
    const usage = asRecord(root?.usage) ?? asRecord(meta?.usage) ?? null;
    if (usage === null) return;
    const tokens = decodeUsageTokens(usage);
    if (tokens.inputTokens === null && tokens.outputTokens === null) return;
    this.emit({
      kind: "usage-updated",
      turnId,
      contextPercent: numberOrNull(
        usage.contextPercent ?? usage.context_percent,
      ),
      ...tokens,
      raw: usage,
    });
    this.mark("contextUsage", "supported");
  }

  private async drainLoadReplayWindow(
    capMs: number,
    quietMs: number,
  ): Promise<void> {
    const started = Date.now();
    let lastCount = this.loadReplayChunkCount;
    let lastChange = Date.now();
    while (Date.now() - started < capMs) {
      await sleep(50);
      if (this.loadReplayChunkCount !== lastCount) {
        lastCount = this.loadReplayChunkCount;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= quietMs) {
        return;
      }
    }
  }
}

export async function probeAcpRuntime(
  profile: AcpVendorProfile,
  spawn: ProviderSpawn,
  measureEveryModel = false,
): Promise<ProtocolProbe> {
  const probeTimeoutMs = 10_000;
  let session: AcpProviderSession | null = null;
  try {
    session = await AcpProviderSession.connect(profile, spawn, {
      requestTimeoutMs: probeTimeoutMs,
    });
    await withinDeadline(
      session.newSession({ cwd: spawn.cwd }),
      probeTimeoutMs,
      `${profile.provider} ACP session/new`,
    );
    if (measureEveryModel) {
      await withinDeadline(
        session.measureModelCatalog(),
        probeTimeoutMs,
        `${profile.provider} ACP model catalog`,
      );
    }
    await session.settleInitialCatalog();
    const snapshot = await session.snapshot();
    return {
      ...snapshot,
      source: "probe",
      executable: spawn.executable,
      version: session.capabilities.runtime.version,
      transport: profile.transport,
      verdict: "compatible",
    };
  } catch (error) {
    const observedAt = new Date().toISOString();
    return {
      provider: profile.provider,
      source: "probe",
      observedAt,
      catalog: {
        status: "unavailable",
        reason: errorMessage(error),
      },
      measurements: {},
      ...(profile.absences === undefined ? {} : { absences: profile.absences }),
      commands: [],
      executable: spawn.executable,
      version: null,
      transport: profile.transport,
      verdict: "incompatible",
      reason: errorMessage(error),
    };
  } finally {
    await session?.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (timeoutMs === undefined) return operation;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sessionIdFrom(result: unknown): string | null {
  const root = asRecord(result);
  return asString(root?.sessionId) ?? asString(root?.session_id);
}

function stopReasonFrom(result: unknown): string | null {
  const root = asRecord(result);
  return asString(root?.stopReason) ?? asString(root?.stop_reason);
}

function versionFromHandshake(handshake: unknown): string | null {
  const root = asRecord(handshake);
  const meta = asRecord(root?._meta);
  const agentInfo = asRecord(root?.agentInfo);
  return (
    asString(meta?.agentVersion) ??
    asString(agentInfo?.version) ??
    asString(root?.agentVersion) ??
    null
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function currentConfigValue(payload: unknown, configId: string): string | null {
  const root = asRecord(payload);
  if (!Array.isArray(root?.configOptions)) return null;
  for (const value of root.configOptions) {
    const option = asRecord(value);
    if (asString(option?.id) !== configId) continue;
    return asString(option?.currentValue);
  }
  return null;
}

function configOptionValues(payload: unknown, configId: string): string[] {
  const root = asRecord(payload);
  if (!Array.isArray(root?.configOptions)) return [];
  for (const value of root.configOptions) {
    const option = asRecord(value);
    if (asString(option?.id) !== configId || !Array.isArray(option?.options)) {
      continue;
    }
    return option.options.flatMap((candidate) => {
      const entry = asRecord(candidate);
      const id = asString(entry?.value);
      return id === null ? [] : [id];
    });
  }
  return [];
}

function acpProvider(
  provider: CapabilityProvider,
): "grok" | "kimi" | "opencode" {
  switch (provider) {
    case "grok":
    case "kimi":
    case "opencode":
      return provider;
    case "claude":
    case "codex":
      throw new Error(`${provider} does not use the ACP session adapter`);
  }
}

/** The adapter half every ACP vendor shares: probe by connecting once, and connect after forcing the vendor's ACP entrypoint onto a caller that passed a bare executable. Everything vendor-specific stays outside: the profile, the entrypoint argv, and the vendor's own spawn builder, which is handed over whole rather than reconstructed here — the builders do not share a signature (OpenCode's takes a test-only `pure` option), and this only ever calls the two arguments they all accept. */
export class AcpRuntimeAdapter implements ProviderRuntimeAdapter {
  readonly transport = "acp" as const;

  constructor(
    readonly id: CapabilityProvider,
    private readonly profile: AcpVendorProfile,
    private readonly entrypointArgv: readonly string[],
    private readonly spawnFor: (
      executable: string,
      cwd: string,
    ) => ProviderSpawn,
    /** Kimi measures every advertised model during a probe; the others do not. */
    private readonly measureEveryModel: boolean = false,
  ) {}

  async probe(executable: string): Promise<ProtocolProbe> {
    return probeAcpRuntime(
      this.profile,
      this.spawnFor(executable, process.cwd()),
      this.measureEveryModel,
    );
  }

  async connect(spawn: ProviderSpawn): Promise<ProviderSession> {
    return AcpProviderSession.connect(this.profile, {
      ...spawn,
      argv: spawn.argv.length > 0 ? spawn.argv : this.entrypointArgv,
    });
  }
}

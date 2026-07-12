import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expectedCost, PROMPTS, RESUME_CHECK_TEXT, STEER_TEXT } from "./prompts";
import { JsonLineProcess, objectValue, stringValue } from "./transport";
import type {
  AdapterContext,
  AdapterRun,
  InstallationBinding,
  NormalizedEvent,
  PreparedAdapter,
  Scenario,
} from "./types";

type JsonObject = Record<string, unknown>;

const CLAUDE_CLI_DOCS = "https://code.claude.com/docs/en/cli-usage";
const CLAUDE_INPUT_DOCS = "https://code.claude.com/docs/en/agent-sdk/user-input";
const CLAUDE_STREAM_DOCS = "https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode";
const DRIVEN_REVIEW = "research/cross-vendor-architecture-review.md#appendix-reproducing-the-claude-code-observations";

class Recorder {
  readonly events: NormalizedEvent[] = [];
  private sequence = 0;

  add(event: Omit<NormalizedEvent, "sequence" | "at">): void {
    this.events.push({ sequence: ++this.sequence, at: new Date().toISOString(), ...event });
  }
}

interface ClaudeAdapterOptions {
  binding: InstallationBinding;
  selectedModel?: string;
  preflightDirectory: string;
  timeoutMs: number;
}

interface ClaudeSession {
  process: JsonLineProcess;
  recorder: Recorder;
  scenario: Scenario;
  effectiveModel?: string;
  sessionId?: string;
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  currentTurn: number;
  resultCount: number;
  resumeFrom?: string;
}

function baseArgv(executablePath: string): string[] {
  return [
    executablePath,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--safe-mode",
    "--setting-sources",
    "",
    "--settings",
    "{}",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
  ];
}

function scenarioArgv(
  executablePath: string,
  scenario: Scenario,
  model: string,
  resumeFrom?: string,
): string[] {
  const argv = [...baseArgv(executablePath), "--model", model];
  if (resumeFrom !== undefined) argv.push("--resume", resumeFrom);

  if (scenario === "read-only") {
    argv.push("--permission-mode", "dontAsk", "--tools", "Write");
  } else if (scenario === "approve" || scenario === "deny") {
    argv.push(
      "--permission-mode",
      "manual",
      "--permission-prompt-tool",
      "stdio",
      "--tools",
      "Write",
    );
  } else if (scenario === "needs-user") {
    argv.push(
      "--permission-mode",
      "manual",
      "--permission-prompt-tool",
      "stdio",
      "--tools",
      "AskUserQuestion",
    );
  } else if (scenario === "steer" || scenario === "cancel") {
    argv.push(
      "--permission-mode",
      "manual",
      "--allowed-tools",
      "Bash(/bin/sleep *)",
      "--tools",
      "Bash",
    );
  } else {
    argv.push("--permission-mode", "dontAsk", "--tools", "");
  }
  return argv;
}

function sendControlResponse(
  process: JsonLineProcess,
  requestId: string,
  response: JsonObject,
): void {
  process.send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response,
    },
  });
}

function questionAnswer(input: JsonObject): JsonObject {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers: Record<string, string> = {};
  for (const entry of questions) {
    const question = objectValue(entry, "Claude AskUserQuestion entry");
    const text = stringValue(question.question, "Claude question text");
    answers[text] = "Alpha";
  }
  return { behavior: "allow", updatedInput: { questions, answers } };
}

function contentBlocks(message: JsonObject): JsonObject[] {
  const payload = typeof message.message === "object" && message.message !== null
    ? message.message as JsonObject
    : {};
  return Array.isArray(payload.content)
    ? payload.content.filter((entry): entry is JsonObject =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
    )
    : [];
}

function usageFromResult(message: JsonObject): { input: number; output: number } {
  const usage = typeof message.usage === "object" && message.usage !== null
    ? message.usage as JsonObject
    : {};
  const input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .reduce((total, key) => total + (typeof usage[key] === "number" ? usage[key] as number : 0), 0);
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return { input, output };
}

function handleFrame(message: JsonObject, session: ClaudeSession): void {
  const type = typeof message.type === "string" ? message.type : undefined;
  const subtype = typeof message.subtype === "string" ? message.subtype : undefined;
  const sessionId = typeof message.session_id === "string" ? message.session_id : session.sessionId;
  if (sessionId !== undefined) session.sessionId = sessionId;

  if (type === "system" && subtype === "init") {
    session.effectiveModel = typeof message.model === "string" ? message.model : undefined;
    session.currentTurn += 1;
    session.recorder.add({
      type: session.resumeFrom === undefined ? "session.started" : "session.resumed",
      sessionId,
      resumedFrom: session.resumeFrom,
    });
    if (session.effectiveModel !== undefined) {
      session.recorder.add({ type: "model.reported", sessionId, model: session.effectiveModel });
    }
    const permissionMode = typeof message.permissionMode === "string" ? message.permissionMode : undefined;
    if (permissionMode !== undefined) {
      session.recorder.add({
        type: "policy.reported",
        sessionId,
        status: permissionMode === "dontAsk" && session.scenario === "read-only"
          ? "read-only"
          : permissionMode,
      });
    }
    session.recorder.add({ type: "turn.started", sessionId, turnId: `turn-${session.currentTurn}` });
    return;
  }

  if (type === "control_request") {
    const request = objectValue(message.request, "Claude control request");
    const requestId = stringValue(message.request_id, "Claude control request id");
    if (request.subtype !== "can_use_tool") {
      sendControlResponse(session.process, requestId, { behavior: "deny", message: "Unsupported fixture control request" });
      session.recorder.add({ type: "diagnostic", requestId, text: `Unsupported Claude control request: ${String(request.subtype)}` });
      return;
    }
    const tool = stringValue(request.tool_name, "Claude tool name");
    const input = objectValue(request.input ?? {}, "Claude tool input");
    if (tool === "AskUserQuestion") {
      session.recorder.add({ type: "user-input.requested", requestId, tool });
      sendControlResponse(session.process, requestId, questionAnswer(input));
      session.recorder.add({ type: "user-input.responded", requestId, tool, status: "Alpha" });
      return;
    }
    const decision = session.scenario === "approve" ? "approve" : "deny";
    session.recorder.add({ type: "approval.requested", requestId, tool });
    sendControlResponse(
      session.process,
      requestId,
      decision === "approve"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "DENIED_BY_HIVE_PROVIDER_CONFORMANCE" },
    );
    session.recorder.add({ type: "approval.responded", requestId, tool, decision });
    return;
  }

  if (type === "assistant") {
    for (const block of contentBlocks(message)) {
      if (block.type === "text" && typeof block.text === "string") session.text += block.text;
      if (block.type === "tool_use") {
        session.recorder.add({
          type: "tool.started",
          sessionId,
          turnId: `turn-${session.currentTurn}`,
          tool: typeof block.name === "string" ? block.name : "unknown",
          metadata: typeof block.id === "string" ? { toolUseId: block.id } : undefined,
        });
      }
    }
    return;
  }

  if (type === "user") {
    for (const block of contentBlocks(message)) {
      if (block.type !== "tool_result") continue;
      const denied = block.is_error === true ||
        (typeof block.content === "string" && /denied|not allowed|permission/i.test(block.content));
      session.recorder.add({
        type: denied ? "tool.denied" : "tool.completed",
        sessionId,
        turnId: `turn-${session.currentTurn}`,
        status: denied ? "denied" : "completed",
      });
    }
    return;
  }

  if (type === "system" && subtype === "permission_denied") {
    session.recorder.add({
      type: "tool.denied",
      sessionId,
      turnId: `turn-${session.currentTurn}`,
      tool: typeof message.tool_name === "string" ? message.tool_name : "unknown",
      status: "policy-denied",
    });
    return;
  }

  if (type === "result") {
    session.resultCount += 1;
    if (typeof message.total_cost_usd === "number") session.costUsd += message.total_cost_usd;
    const usage = usageFromResult(message);
    session.inputTokens += usage.input;
    session.outputTokens += usage.output;
    const text = typeof message.result === "string" ? message.result : session.text;
    const isError = message.is_error === true || subtype !== "success";
    if (session.scenario === "cancel") {
      session.recorder.add({
        type: "turn.cancelled",
        sessionId,
        turnId: `turn-${session.currentTurn}`,
        status: subtype ?? "cancelled",
        text,
      });
    } else {
      session.recorder.add({
        type: isError ? "turn.failed" : "turn.completed",
        sessionId,
        turnId: `turn-${session.currentTurn}`,
        status: subtype ?? (isError ? "failed" : "completed"),
        text,
      });
    }
    session.text = "";
  }
}

function startClaudeSession(
  options: ClaudeAdapterOptions,
  scenario: Scenario,
  model: string,
  cwd: string,
  capturePath: string,
  recorder: Recorder,
  resumeFrom?: string,
): ClaudeSession {
  let session: ClaudeSession;
  const process = new JsonLineProcess({
    argv: scenarioArgv(options.binding.executablePath, scenario, model, resumeFrom),
    cwd,
    capturePath,
    timeoutMs: options.timeoutMs,
    onMessage: (message) => handleFrame(message, session),
  });
  session = {
    process,
    recorder,
    scenario,
    text: "",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    currentTurn: 0,
    resultCount: 0,
    resumeFrom,
  };
  return session;
}

function sendUser(process: JsonLineProcess, text: string): void {
  process.send({ type: "user", message: { role: "user", content: text } });
}

async function waitForResult(session: ClaudeSession, expectedText?: string): Promise<JsonObject> {
  return session.process.waitFor((message) => {
    if (message.type !== "result") return false;
    return expectedText === undefined ||
      (typeof message.result === "string" && message.result.includes(expectedText));
  });
}

async function markerEvent(recorder: Recorder, markerPath: string): Promise<void> {
  const marker = Bun.file(markerPath);
  const exists = await marker.exists();
  recorder.add({
    type: "marker.observed",
    exists,
    content: exists ? (await marker.text()).trim() : undefined,
  });
}

async function initializeProbe(
  options: ClaudeAdapterOptions,
  capturePath: string,
): Promise<{ selectedModel: string; provenance: string[] }> {
  const process = new JsonLineProcess({
    argv: baseArgv(options.binding.executablePath),
    cwd: options.preflightDirectory,
    capturePath,
    timeoutMs: options.timeoutMs,
  });
  const requestId = "initialize-model-catalog";
  try {
    process.send({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "initialize" },
    });
    const frame = await process.waitFor((message) => {
      if (message.type !== "control_response") return false;
      const response = typeof message.response === "object" && message.response !== null
        ? message.response as JsonObject
        : {};
      return response.request_id === requestId;
    });
    const envelope = objectValue(frame.response, "Claude initialize envelope");
    const response = objectValue(envelope.response, "Claude initialize response");
    const models = Array.isArray(response.models) ? response.models : [];
    const haiku = models.find((entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      (entry as JsonObject).value === "haiku"
    );
    const preferred = haiku ?? models[0];
    const model = objectValue(preferred, "Claude reported model");
    const selectedModel = options.selectedModel ?? stringValue(
      model.resolvedModel ?? model.value,
      "Claude resolved model",
    );
    return {
      selectedModel,
      provenance: [
        `${options.binding.version} returned account-scoped models from stream-json initialize before a model turn (non-billable); sensitive account fields were redacted.`,
        CLAUDE_CLI_DOCS,
        DRIVEN_REVIEW,
      ],
    };
  } finally {
    await process.close(true);
  }
}

async function runScenario(
  options: ClaudeAdapterOptions,
  scenario: Scenario,
  context: AdapterContext,
): Promise<AdapterRun> {
  await mkdir(context.scenarioDirectory, { recursive: true });
  const recorder = new Recorder();
  const diagnostics: string[] = [];
  const markerPath = join(context.scenarioDirectory, "marker.txt");
  const capturePath = join(context.scenarioDirectory, "claude.frames.jsonl");
  let realTaskStarted = scenario !== "invalid-model";
  let session: ClaudeSession | undefined;
  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    if (scenario === "resume") {
      session = startClaudeSession(
        options,
        scenario,
        context.selectedModel,
        context.scenarioDirectory,
        capturePath,
        recorder,
      );
      sendUser(session.process, PROMPTS.resume.text(markerPath));
      await waitForResult(session);
      const durableId = stringValue(session.sessionId, "Claude durable session id");
      totalCost += session.costUsd;
      inputTokens += session.inputTokens;
      outputTokens += session.outputTokens;
      await session.process.close(true);

      session = startClaudeSession(
        options,
        scenario,
        context.selectedModel,
        context.scenarioDirectory,
        join(context.scenarioDirectory, "claude-resumed.frames.jsonl"),
        recorder,
        durableId,
      );
      sendUser(session.process, RESUME_CHECK_TEXT);
      await waitForResult(session, "HIVE_RESUME_OK:HIVE_RESUME_ANCHOR");
    } else {
      const model = scenario === "invalid-model" ? context.invalidModel : context.selectedModel;
      session = startClaudeSession(
        options,
        scenario,
        model,
        context.scenarioDirectory,
        capturePath,
        recorder,
      );
      if (scenario === "invalid-model") {
        recorder.add({ type: "validation.started", model, validationOnly: true });
      }
      sendUser(session.process, PROMPTS[scenario].text(markerPath));

      if (scenario === "steer" || scenario === "cancel") {
        await session.process.waitFor((message) =>
          message.type === "assistant" && contentBlocks(message).some((block) => block.type === "tool_use")
        );
        if (scenario === "steer") {
          sendUser(session.process, STEER_TEXT);
          await session.process.waitFor((message) => {
            if (message.type !== "user") return false;
            const payload = typeof message.message === "object" && message.message !== null
              ? message.message as JsonObject
              : {};
            return payload.content === STEER_TEXT;
          });
          recorder.add({ type: "steer.accepted", sessionId: session.sessionId, turnId: `turn-${session.currentTurn}` });
        } else {
          const requestId = "interrupt-1";
          session.process.send({
            type: "control_request",
            request_id: requestId,
            request: { subtype: "interrupt" },
          });
          await session.process.waitFor((message) => {
            if (message.type !== "control_response") return false;
            const response = typeof message.response === "object" && message.response !== null
              ? message.response as JsonObject
              : {};
            return response.request_id === requestId && response.subtype === "success";
          });
          recorder.add({ type: "cancel.receipt", sessionId: session.sessionId, turnId: `turn-${session.currentTurn}`, receipt: true });
        }
      }

      await waitForResult(session, scenario === "steer" ? "HIVE_STEERED_OK" : undefined);
      if (scenario === "invalid-model") {
        if (session.effectiveModel !== undefined && session.effectiveModel !== context.invalidModel) {
          recorder.add({
            type: "model.substituted",
            model: session.effectiveModel,
            text: `Pinned ${context.invalidModel} but provider reported ${session.effectiveModel}`,
          });
        }
        const failed = recorder.events.find((event) => event.type === "turn.failed");
        if (failed !== undefined) {
          recorder.add({ type: "model.rejected", model: context.invalidModel, text: failed.text, validationOnly: true });
          recorder.add({ type: "validation.rejected", model: context.invalidModel, text: failed.text, validationOnly: true });
        }
      }
      if (scenario === "approve" || scenario === "deny" || scenario === "read-only") {
        await markerEvent(recorder, markerPath);
      }
    }
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : "Unknown Claude adapter failure");
    recorder.add({ type: "diagnostic", text: diagnostics.at(-1) });
  } finally {
    if (session !== undefined) {
      totalCost += session.costUsd;
      inputTokens += session.inputTokens;
      outputTokens += session.outputTokens;
      await session.process.close(true);
    }
  }

  const costClass = expectedCost("claude", scenario);
  return {
    provider: "claude",
    scenario,
    binding: options.binding,
    selectedModel: context.selectedModel,
    ...(scenario === "invalid-model" ? { invalidModel: context.invalidModel } : {}),
    events: recorder.events,
    cost: {
      classification: costClass,
      observedUsd: totalCost,
      observedInputTokens: inputTokens,
      observedOutputTokens: outputTokens,
      provenance: [
        "Claude stream-json result.total_cost_usd and result.usage fields from this run.",
        scenario === "invalid-model" ? DRIVEN_REVIEW : CLAUDE_STREAM_DOCS,
      ],
    },
    fallbackConfigured: false,
    realTaskStarted,
    rawCapturePath: capturePath,
    diagnostics,
  };
}

export async function prepareClaude(options: ClaudeAdapterOptions): Promise<PreparedAdapter> {
  await mkdir(options.preflightDirectory, { recursive: true });
  const preflight = await initializeProbe(
    options,
    join(options.preflightDirectory, "initialize.frames.jsonl"),
  );
  return {
    provider: "claude",
    binding: options.binding,
    selectedModel: preflight.selectedModel,
    preflightProvenance: [
      ...preflight.provenance,
      `Approval and needs-user behavior are documented at ${CLAUDE_INPUT_DOCS}.`,
    ],
    run: (scenario, context) => runScenario(
      { ...options, selectedModel: preflight.selectedModel },
      scenario,
      context,
    ),
  };
}

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanEnvironment } from "./binding";
import {
  DUAL_CLIENT_STEER_TEXT,
  DUAL_CLIENT_INJECT_TEXT,
  DUAL_CLIENT_VERIFY_TEXT,
  expectedCost,
  PROMPTS,
  RESUME_CHECK_TEXT,
  STEER_TEXT,
} from "./prompts";
import {
  JsonLineProcess,
  JsonWebSocket,
  objectValue,
  stringValue,
  type JsonTransport,
} from "./transport";
import type {
  AdapterContext,
  AdapterRun,
  InstallationBinding,
  NormalizedEvent,
  PreparedAdapter,
  Scenario,
} from "./types";

type JsonObject = Record<string, unknown>;

const CODEX_DOCS = "https://learn.chatgpt.com/docs/app-server";

class Recorder {
  readonly events: NormalizedEvent[] = [];
  private sequence = 0;

  add(event: Omit<NormalizedEvent, "sequence" | "at">): void {
    this.events.push({
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      ...event,
    });
  }
}

class CodexRpc {
  private requestId = 0;

  constructor(readonly process: JsonTransport) {}

  async request(method: string, params?: JsonObject): Promise<unknown> {
    const id = ++this.requestId;
    this.process.send({ method, id, ...(params === undefined ? {} : { params }) });
    const response = await this.process.waitFor(
      (message) => message.id === id && message.method === undefined,
    );
    if (response.error !== undefined) {
      const error = objectValue(response.error, `${method} error`);
      throw new Error(`Codex ${method} failed: ${String(error.message ?? "unknown error")}`);
    }
    return response.result;
  }

  notify(method: string, params?: JsonObject): void {
    this.process.send({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: string | number, result: unknown): void {
    this.process.send({ id, result });
  }
}

interface CodexSession {
  rpc: CodexRpc;
  threadId: string;
  effectiveModel: string;
  capturePath: string;
  output: Map<string, string>;
}

interface ChildCapture {
  child: Bun.Subprocess;
  stdout: Promise<string>;
  stderr: Promise<string>;
}

interface StartOptions {
  model: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "never" | "on-request";
  capturePath: string;
  experimental: boolean;
  resumeThreadId?: string;
  recorder: Recorder;
  scenario: Scenario;
  timeoutMs: number;
}

interface CodexAdapterOptions {
  binding: InstallationBinding;
  selectedModel?: string;
  preflightDirectory: string;
  timeoutMs: number;
}

function paramsOf(message: JsonObject): JsonObject {
  return message.params === undefined ? {} : objectValue(message.params, "Codex params");
}

function itemOf(message: JsonObject): JsonObject {
  const params = paramsOf(message);
  return objectValue(params.item, "Codex item");
}

function turnOf(message: JsonObject): JsonObject {
  const params = paramsOf(message);
  return objectValue(params.turn, "Codex turn");
}

function turnIdOf(message: JsonObject): string | undefined {
  const params = paramsOf(message);
  if (typeof params.turnId === "string") return params.turnId;
  if (typeof params.turn === "object" && params.turn !== null && !Array.isArray(params.turn)) {
    const turn = params.turn as JsonObject;
    return typeof turn.id === "string" ? turn.id : undefined;
  }
  return undefined;
}

async function generateSchemaProbe(
  binding: InstallationBinding,
  outputDirectory: string,
): Promise<string[]> {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const child = Bun.spawn([
    binding.executablePath,
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    outputDirectory,
  ], {
    stdin: null,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`Codex schema generation failed (${code}): ${(stderr || stdout).trim()}`);
  }

  const serverRequest = await Bun.file(join(outputDirectory, "ServerRequest.json")).text();
  const clientRequest = await Bun.file(join(outputDirectory, "ClientRequest.json")).text();
  const serverNotification = await Bun.file(join(outputDirectory, "ServerNotification.json")).text();
  const turnStart = await Bun.file(join(outputDirectory, "v2", "TurnStartParams.json")).text();
  const required = [
    [clientRequest, "thread/start"],
    [clientRequest, "thread/resume"],
    [clientRequest, "turn/start"],
    [clientRequest, "turn/steer"],
    [clientRequest, "turn/interrupt"],
    [clientRequest, "thread/inject_items"],
    [serverRequest, "item/commandExecution/requestApproval"],
    [serverRequest, "item/fileChange/requestApproval"],
    [serverRequest, "item/tool/requestUserInput"],
    [serverNotification, "turn/completed"],
  ] as const;
  for (const [schema, method] of required) {
    if (!schema.includes(`\"${method}\"`)) {
      throw new Error(`Binding schema does not expose required Codex method: ${method}`);
    }
  }
  if (!turnStart.includes('"collaborationMode"') || !turnStart.includes('"plan"')) {
    throw new Error("Binding schema does not expose experimental plan collaborationMode for needs-user");
  }
  return [
    `${binding.version} generated its own JSON Schema bundle with codex app-server generate-json-schema --experimental (non-billable).`,
    `Required method shapes verified in ${outputDirectory}.`,
    ...(await remoteHelpProbe(binding)),
    CODEX_DOCS,
  ];
}

async function remoteHelpProbe(binding: InstallationBinding): Promise<string[]> {
  const probes = [
    { argv: [binding.executablePath, "app-server", "--help"], required: "--listen" },
    { argv: [binding.executablePath, "--help"], required: "--remote" },
  ];
  for (const probe of probes) {
    const child = Bun.spawn(probe.argv, {
      stdin: null,
      stdout: "pipe",
      stderr: "pipe",
      env: cleanEnvironment(),
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0 || !`${stdout}\n${stderr}`.includes(probe.required)) {
      throw new Error(`Binding help does not expose required Codex option: ${probe.required}`);
    }
  }
  return [
    `${binding.version} help exposes documented app-server --listen and TUI --remote options (non-billable).`,
  ];
}

async function prepareModel(
  binding: InstallationBinding,
  capturePath: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  let rpc: CodexRpc | undefined;
  const process = new JsonLineProcess({
    argv: [binding.executablePath, "app-server", "--stdio"],
    cwd,
    capturePath,
    timeoutMs,
  });
  rpc = new CodexRpc(process);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "hive_provider_conformance", title: "Hive provider conformance", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});
    const response = objectValue(await rpc.request("model/list", {}), "model/list response");
    const models = Array.isArray(response.data) ? response.data : [];
    const preferred = models.find((entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      (entry as JsonObject).isDefault === true
    ) ?? models[0];
    const model = objectValue(preferred, "default Codex model");
    return stringValue(model.model ?? model.id, "Codex model id");
  } finally {
    await process.close(true);
  }
}

function approvalDecision(scenario: Scenario): "approve" | "deny" {
  return scenario === "approve" ? "approve" : "deny";
}

function answerUserInput(params: JsonObject): JsonObject {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const answers: Record<string, { answers: string[] }> = {};
  for (const entry of questions) {
    const question = objectValue(entry, "Codex user-input question");
    const id = stringValue(question.id, "Codex question id");
    answers[id] = { answers: ["Alpha"] };
  }
  return { answers };
}

function handleFrame(
  message: JsonObject,
  rpc: CodexRpc,
  recorder: Recorder,
  scenario: Scenario,
  output: Map<string, string>,
): void {
  const method = typeof message.method === "string" ? message.method : undefined;
  if (method === undefined) return;
  const params = paramsOf(message);
  const turnId = turnIdOf(message);

  if (message.id !== undefined) {
    const requestId = String(message.id);
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      recorder.add({ type: "approval.requested", requestId, turnId, tool: method });
      const decision = approvalDecision(scenario);
      recorder.add({ type: "approval.responded", requestId, turnId, decision });
      if (method === "item/permissions/requestApproval") {
        rpc.respond(message.id as string | number, {
          permissions: decision === "approve" ? params.permissions ?? {} : {},
          scope: "turn",
        });
      } else {
        rpc.respond(message.id as string | number, {
          decision: decision === "approve" ? "accept" : "decline",
        });
      }
      return;
    }
    if (method === "item/tool/requestUserInput") {
      recorder.add({ type: "user-input.requested", requestId, turnId, tool: method });
      rpc.respond(message.id as string | number, answerUserInput(params));
      recorder.add({ type: "user-input.responded", requestId, turnId, status: "Alpha" });
      return;
    }
    rpc.respond(message.id as string | number, {});
    recorder.add({ type: "diagnostic", requestId, text: `Unsupported server request was declined: ${method}` });
    return;
  }

  if (method === "turn/started") {
    recorder.add({ type: "turn.started", turnId });
    return;
  }
  if (method === "item/agentMessage/delta") {
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (turnId !== undefined) output.set(turnId, `${output.get(turnId) ?? ""}${delta}`);
    return;
  }
  if (method === "item/started") {
    const item = itemOf(message);
    recorder.add({
      type: "tool.started",
      turnId,
      tool: typeof item.type === "string" ? item.type : "unknown",
      metadata: typeof item.id === "string" ? { itemId: item.id } : undefined,
    });
    return;
  }
  if (method === "item/completed") {
    const item = itemOf(message);
    const status = typeof item.status === "string" ? item.status : "completed";
    if (item.type === "agentMessage" && typeof item.text === "string" && turnId !== undefined) {
      output.set(turnId, item.text);
    }
    recorder.add({
      type: status === "declined" || status === "failed" ? "tool.denied" : "tool.completed",
      turnId,
      tool: typeof item.type === "string" ? item.type : "unknown",
      status,
    });
    return;
  }
  if (method === "turn/completed") {
    const turn = turnOf(message);
    const id = stringValue(turn.id, "completed Codex turn id");
    const status = typeof turn.status === "string" ? turn.status : "unknown";
    if (status === "interrupted") {
      recorder.add({ type: "turn.cancelled", turnId: id, status });
    } else if (status === "failed") {
      const error = typeof turn.error === "object" && turn.error !== null
        ? String((turn.error as JsonObject).message ?? "Codex turn failed")
        : "Codex turn failed";
      recorder.add({ type: "turn.failed", turnId: id, status, text: error });
    } else {
      recorder.add({ type: "turn.completed", turnId: id, status, text: output.get(id) ?? "" });
    }
  }
}

async function startSession(options: StartOptions, executablePath: string): Promise<CodexSession> {
  let rpc: CodexRpc | undefined;
  const output = new Map<string, string>();
  const process = new JsonLineProcess({
    argv: [executablePath, "app-server", "--stdio"],
    cwd: options.cwd,
    capturePath: options.capturePath,
    timeoutMs: options.timeoutMs,
    onMessage: (message) => {
      if (rpc !== undefined) handleFrame(message, rpc, options.recorder, options.scenario, output);
    },
  });
  rpc = new CodexRpc(process);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "hive_provider_conformance", title: "Hive provider conformance", version: "0.1.0" },
      capabilities: { experimentalApi: options.experimental },
    });
    rpc.notify("initialized", {});
    const method = options.resumeThreadId === undefined ? "thread/start" : "thread/resume";
    const response = objectValue(await rpc.request(method, {
      ...(options.resumeThreadId === undefined ? {} : { threadId: options.resumeThreadId }),
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: options.sandbox,
    }), `${method} response`);
    const thread = objectValue(response.thread, `${method} thread`);
    const threadId = stringValue(thread.id, `${method} thread id`);
    const effectiveModel = stringValue(response.model ?? options.model, `${method} effective model`);
    options.recorder.add({
      type: options.resumeThreadId === undefined ? "session.started" : "session.resumed",
      sessionId: threadId,
      resumedFrom: options.resumeThreadId,
    });
    options.recorder.add({ type: "model.reported", sessionId: threadId, model: effectiveModel });
    const sandbox = typeof response.sandbox === "object" && response.sandbox !== null
      ? response.sandbox as JsonObject
      : {};
    const sandboxType = typeof sandbox.type === "string" ? sandbox.type : options.sandbox;
    options.recorder.add({
      type: "policy.reported",
      sessionId: threadId,
      status: sandboxType === "readOnly" ? "read-only" : sandboxType,
    });
    return { rpc, threadId, effectiveModel, capturePath: options.capturePath, output };
  } catch (error) {
    await process.close(true);
    throw error;
  }
}

async function connectWebSocket(
  url: string,
  capturePath: string,
  timeoutMs: number,
  onMessage?: (message: JsonObject) => void | Promise<void>,
): Promise<JsonWebSocket> {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await JsonWebSocket.connect({ url, capturePath, timeoutMs, onMessage });
    } catch (error) {
      lastError = error;
      await Bun.sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not connect to ${url}`);
}

async function startWebSocketSession(
  options: StartOptions,
  url: string,
): Promise<CodexSession> {
  let rpc: CodexRpc | undefined;
  const output = new Map<string, string>();
  const transport = await connectWebSocket(
    url,
    options.capturePath,
    options.timeoutMs,
    (message) => {
      if (rpc !== undefined) handleFrame(message, rpc, options.recorder, options.scenario, output);
    },
  );
  rpc = new CodexRpc(transport);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "hive_provider_conformance", title: "Hive provider conformance", version: "0.1.0" },
      capabilities: { experimentalApi: options.experimental },
    });
    rpc.notify("initialized", {});
    const method = options.resumeThreadId === undefined ? "thread/start" : "thread/resume";
    const response = objectValue(await rpc.request(method, {
      ...(options.resumeThreadId === undefined ? {} : { threadId: options.resumeThreadId }),
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: options.sandbox,
    }), `${method} response`);
    const thread = objectValue(response.thread, `${method} thread`);
    const threadId = stringValue(thread.id, `${method} thread id`);
    const effectiveModel = stringValue(response.model ?? options.model, `${method} effective model`);
    options.recorder.add({
      type: options.resumeThreadId === undefined ? "session.started" : "session.resumed",
      sessionId: threadId,
      resumedFrom: options.resumeThreadId,
    });
    options.recorder.add({ type: "model.reported", sessionId: threadId, model: effectiveModel });
    return { rpc, threadId, effectiveModel, capturePath: options.capturePath, output };
  } catch (error) {
    await transport.close();
    throw error;
  }
}

function captureChild(argv: string[], cwd: string): ChildCapture {
  const child = Bun.spawn(argv, {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnvironment(),
  });
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

async function stopChild(capture: ChildCapture): Promise<{ stdout: string; stderr: string }> {
  if (capture.child.exitCode === null) capture.child.kill();
  await Promise.race([capture.child.exited, Bun.sleep(2_000)]);
  if (capture.child.exitCode === null) capture.child.kill("SIGKILL");
  await capture.child.exited;
  const [stdout, stderr] = await Promise.all([capture.stdout, capture.stderr]);
  return { stdout, stderr };
}

async function websocketEndpoint(): Promise<string> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved", { status: 503 }),
  });
  const port = reservation.port;
  await reservation.stop(true);
  return `ws://127.0.0.1:${port}`;
}

async function runDualClient(
  options: CodexAdapterOptions,
  context: AdapterContext,
  recorder: Recorder,
  capturePath: string,
): Promise<{ session?: CodexSession; diagnostics: string[]; tuiCapturePath: string }> {
  const diagnostics: string[] = [];
  const url = await websocketEndpoint();
  const server = captureChild([
    options.binding.executablePath,
    "app-server",
    "--listen",
    url,
  ], context.scenarioDirectory);
  const tuiCapturePath = join(context.scenarioDirectory, "codex-tui.typescript");
  let bootstrap: CodexSession | undefined;
  let session: CodexSession | undefined;
  let tui: ChildCapture | undefined;
  try {
    bootstrap = await startWebSocketSession({
      model: context.selectedModel,
      cwd: context.scenarioDirectory,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      capturePath: join(context.scenarioDirectory, "codex-bootstrap.frames.jsonl"),
      experimental: false,
      recorder,
      scenario: "dual-client",
      timeoutMs: context.timeoutMs,
    }, url);
    const threadId = bootstrap.threadId;
    await bootstrap.rpc.process.close();
    bootstrap = undefined;

    tui = captureChild([
      "/usr/bin/script",
      "-q",
      tuiCapturePath,
      options.binding.executablePath,
      "resume",
      "--remote",
      url,
      threadId,
      "--model",
      context.selectedModel,
      "--cd",
      context.scenarioDirectory,
      "--no-alt-screen",
    ], context.scenarioDirectory);
    await Bun.sleep(1_000);
    if (tui.child.exitCode !== null) {
      throw new Error(`Codex remote TUI exited before attachment with code ${tui.child.exitCode}`);
    }
    recorder.add({ type: "client.attached", sessionId: threadId, status: "tui" });

    session = await startWebSocketSession({
      model: context.selectedModel,
      cwd: context.scenarioDirectory,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      capturePath,
      experimental: false,
      resumeThreadId: threadId,
      recorder,
      scenario: "dual-client",
      timeoutMs: context.timeoutMs,
    }, url);
    recorder.add({ type: "client.subscribed", sessionId: threadId, status: "protocol" });
    const turnId = await startTurn(session, PROMPTS["dual-client"].text(""));
    await session.rpc.process.waitFor((message) =>
      message.method === "item/started" && turnIdOf(message) === turnId
    );
    const response = objectValue(await session.rpc.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: DUAL_CLIENT_STEER_TEXT }],
    }), "turn/steer response");
    recorder.add({
      type: "steer.accepted",
      turnId: stringValue(response.turnId, "turn/steer accepted turn id"),
    });
    await waitForTurn(session, turnId);
    await session.rpc.request("thread/inject_items", {
      threadId,
      items: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: DUAL_CLIENT_INJECT_TEXT }],
      }],
    });
    recorder.add({ type: "input.injected", sessionId: threadId, receipt: true });
    const verifyTurnId = await startTurn(session, DUAL_CLIENT_VERIFY_TEXT, {
      approvalPolicy: "never",
    });
    await waitForTurn(session, verifyTurnId);
    await Bun.sleep(500);
  } finally {
    await bootstrap?.rpc.process.close();
    await session?.rpc.process.close();
    if (tui !== undefined) {
      const output = await stopChild(tui);
      const transcript = await Bun.file(tuiCapturePath).text().catch(() => "");
      const combined = `${output.stdout}\n${output.stderr}\n${transcript}`;
      if (combined.includes("HIVE_INJECT_SEEN")) {
        recorder.add({ type: "client.observed", status: "tui", text: "HIVE_INJECT_SEEN" });
      } else {
        diagnostics.push("The attached TUI capture did not contain the history-dependent terminal sentinel.");
      }
    }
    await stopChild(server);
  }
  return { session, diagnostics, tuiCapturePath };
}

async function startTurn(
  session: CodexSession,
  text: string,
  extra: JsonObject = {},
): Promise<string> {
  const response = objectValue(await session.rpc.request("turn/start", {
    threadId: session.threadId,
    input: [{ type: "text", text }],
    ...extra,
  }), "turn/start response");
  const turn = objectValue(response.turn, "turn/start turn");
  return stringValue(turn.id, "turn/start turn id");
}

async function waitForTurn(session: CodexSession, turnId: string): Promise<JsonObject> {
  return session.rpc.process.waitFor((message) => {
    if (message.method !== "turn/completed") return false;
    return turnIdOf(message) === turnId;
  });
}

async function markerEvent(recorder: Recorder, markerPath: string): Promise<void> {
  const file = Bun.file(markerPath);
  const exists = await file.exists();
  recorder.add({
    type: "marker.observed",
    exists,
    content: exists ? (await file.text()).trim() : undefined,
  });
}

async function runScenario(
  options: CodexAdapterOptions,
  scenario: Scenario,
  context: AdapterContext,
): Promise<AdapterRun> {
  await mkdir(context.scenarioDirectory, { recursive: true });
  const recorder = new Recorder();
  const diagnostics: string[] = [];
  const markerPath = join(context.scenarioDirectory, "marker.txt");
  const capturePath = join(context.scenarioDirectory, "codex.frames.jsonl");
  let realTaskStarted = false;
  let observedInputTokens: number | undefined;
  let observedOutputTokens: number | undefined;

  const base = {
    model: scenario === "invalid-model" ? context.invalidModel : context.selectedModel,
    cwd: context.scenarioDirectory,
    capturePath,
    experimental: scenario === "needs-user",
    recorder,
    scenario,
    timeoutMs: context.timeoutMs,
  };

  let session: CodexSession | undefined;
  try {
    if (scenario === "dual-client") {
      realTaskStarted = true;
      const dual = await runDualClient(options, context, recorder, capturePath);
      diagnostics.push(...dual.diagnostics);
      session = dual.session;
    } else if (scenario === "invalid-model") {
      recorder.add({ type: "validation.started", model: context.invalidModel, validationOnly: true });
      try {
        session = await startSession({
          ...base,
          sandbox: "read-only",
          approvalPolicy: "never",
        }, options.binding.executablePath);
      } catch (error) {
        const text = error instanceof Error ? error.message : "Codex rejected invalid model";
        recorder.add({ type: "model.rejected", model: context.invalidModel, text, validationOnly: true });
        recorder.add({ type: "validation.rejected", model: context.invalidModel, text, validationOnly: true });
        return {
          provider: "codex",
          scenario,
          binding: options.binding,
          selectedModel: context.selectedModel,
          invalidModel: context.invalidModel,
          events: recorder.events,
          cost: {
            classification: "non-billable",
            provenance: ["Codex rejected thread/start before turn/start; no prompt was sent."],
          },
          fallbackConfigured: false,
          realTaskStarted: false,
          rawCapturePath: capturePath,
          diagnostics,
        };
      }
      if (session.effectiveModel !== context.invalidModel) {
        recorder.add({
          type: "model.substituted",
          model: session.effectiveModel,
          text: `Pinned ${context.invalidModel} but provider reported ${session.effectiveModel}`,
        });
      }
      const turnId = await startTurn(session, PROMPTS[scenario].text(markerPath));
      await waitForTurn(session, turnId);
      const failed = recorder.events.find((event) => event.type === "turn.failed" && event.turnId === turnId);
      if (failed !== undefined) {
        recorder.add({ type: "validation.rejected", model: context.invalidModel, text: failed.text, validationOnly: true });
      }
    } else if (scenario === "resume") {
      realTaskStarted = true;
      const first = await startSession({
        ...base,
        sandbox: "workspace-write",
        approvalPolicy: "never",
      }, options.binding.executablePath);
      const firstTurn = await startTurn(first, PROMPTS.resume.text(markerPath));
      await waitForTurn(first, firstTurn);
      const durableId = first.threadId;
      await first.rpc.process.close(true);
      session = await startSession({
        ...base,
        capturePath: join(context.scenarioDirectory, "codex-resumed.frames.jsonl"),
        resumeThreadId: durableId,
        sandbox: "workspace-write",
        approvalPolicy: "never",
      }, options.binding.executablePath);
      const resumedTurn = await startTurn(session, RESUME_CHECK_TEXT);
      await waitForTurn(session, resumedTurn);
    } else {
      realTaskStarted = true;
      const readOnly = scenario === "read-only";
      const requiresApproval = scenario === "approve" || scenario === "deny";
      session = await startSession({
        ...base,
        sandbox: readOnly || requiresApproval ? "read-only" : "workspace-write",
        approvalPolicy: requiresApproval ? "on-request" : "never",
      }, options.binding.executablePath);
      const turnId = await startTurn(
        session,
        PROMPTS[scenario].text(markerPath),
        scenario === "needs-user"
          ? {
            collaborationMode: {
              mode: "plan",
              settings: {
                model: context.selectedModel,
                reasoning_effort: null,
                developer_instructions: null,
              },
            },
          }
          : {},
      );

      if (scenario === "steer" || scenario === "cancel") {
        await session.rpc.process.waitFor((message) =>
          message.method === "item/started" && turnIdOf(message) === turnId
        );
        if (scenario === "steer") {
          const response = objectValue(await session.rpc.request("turn/steer", {
            threadId: session.threadId,
            expectedTurnId: turnId,
            input: [{ type: "text", text: STEER_TEXT }],
          }), "turn/steer response");
          recorder.add({
            type: "steer.accepted",
            turnId: stringValue(response.turnId, "turn/steer accepted turn id"),
          });
        } else {
          await session.rpc.request("turn/interrupt", { threadId: session.threadId, turnId });
          recorder.add({ type: "cancel.receipt", turnId, receipt: true });
        }
      }
      await waitForTurn(session, turnId);
      if (scenario === "approve" || scenario === "deny" || scenario === "read-only") {
        await markerEvent(recorder, markerPath);
      }
    }

    for (const message of session?.rpc.process.capturedMessages ?? []) {
      if (message.method !== "thread/tokenUsage/updated") continue;
      const params = paramsOf(message);
      const usage = objectValue(params.tokenUsage, "Codex token usage");
      const last = objectValue(usage.last ?? {}, "Codex last token usage");
      if (typeof last.inputTokens === "number") observedInputTokens = last.inputTokens;
      if (typeof last.outputTokens === "number") observedOutputTokens = last.outputTokens;
    }
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : "Unknown Codex adapter failure");
    recorder.add({ type: "diagnostic", text: diagnostics.at(-1) });
  } finally {
    await session?.rpc.process.close(true);
  }

  const costClass = expectedCost("codex", scenario);
  return {
    provider: "codex",
    scenario,
    binding: options.binding,
    selectedModel: context.selectedModel,
    ...(scenario === "invalid-model" ? { invalidModel: context.invalidModel } : {}),
    events: recorder.events,
    cost: {
      classification: costClass,
      ...(observedInputTokens === undefined ? {} : { observedInputTokens }),
      ...(observedOutputTokens === undefined ? {} : { observedOutputTokens }),
      provenance: [
        costClass === "unknown"
          ? "Codex exposes token usage but no adapter-level promise that a rejected invalid pin costs zero."
          : "A real Codex turn was started; treat it as billable subscription/API usage.",
        CODEX_DOCS,
      ],
    },
    fallbackConfigured: false,
    realTaskStarted,
    rawCapturePath: capturePath,
    diagnostics,
  };
}

export async function prepareCodex(options: CodexAdapterOptions): Promise<PreparedAdapter> {
  await mkdir(options.preflightDirectory, { recursive: true });
  const schemaDirectory = join(options.preflightDirectory, "generated-schema");
  const preflightProvenance = await generateSchemaProbe(options.binding, schemaDirectory);
  const selectedModel = options.selectedModel ?? await prepareModel(
    options.binding,
    join(options.preflightDirectory, "model-list.frames.jsonl"),
    options.preflightDirectory,
    options.timeoutMs,
  );
  return {
    provider: "codex",
    binding: options.binding,
    selectedModel,
    preflightProvenance,
    run: (scenario, context) => runScenario(
      { ...options, selectedModel, preflightDirectory: options.preflightDirectory },
      scenario,
      context,
    ),
  };
}

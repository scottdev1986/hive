import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  type AgentRow,
  asAgentRow,
  asCapture,
  findAgent,
  isRecord,
  observeCapture,
  recordField,
  requireSessionLocator,
  structuredContent,
  type TerminalCapture,
  terminalWritesTotal,
} from "./unknown-record";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const qaHome = required("HIVE_QA_HOME");
const port = Number(required("HIVE_QA_PORT"));
const src = required("HIVE_QA_SRC_ROOT");
const vendor = required("QA_VENDOR");
const candidate = required("QA_ROUTE_CANDIDATE");
const root = `${qaHome}/artifacts/composer-arbitration/${vendor}`;
if (process.env.HIVE_HOME !== qaHome) {
  throw new Error("start Bun with HIVE_HOME equal to HIVE_QA_HOME");
}

const credentialModule = await import(
  pathToFileURL(`${src}/src/cli/credential.ts`).href
);
const mcpProtocolModule = await import(
  pathToFileURL(`${src}/src/shared/mcp-protocol.ts`).href
);
const attachModule = await import(
  pathToFileURL(`${src}/src/daemon/session-host/sessiond-viewer-attach.ts`).href
);
const schemaModule = await import(
  pathToFileURL(`${src}/src/schemas/session-protocol.ts`).href
);
const { agentFetch, authorizationHeaders } = credentialModule;
const { HIVE_MCP_VERSION_NEGOTIATION } = mcpProtocolModule;
const { SessiondViewerAttachClient } = attachModule;
const { FRAME_FLAGS } = schemaModule;

const geometry = {
  columns: 120,
  rows: 40,
  widthPx: 960,
  heightPx: 640,
  cellWidthPx: 8,
  cellHeightPx: 16,
};
const stamp = Date.now();
const draftMarker = `QA_${vendor.toUpperCase()}_USER_DRAFT_${stamp}`;
const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const stringify = (value: unknown) =>
  `${JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  )}\n`;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Bun.write(path, stringify(value));
}

async function runCli(args: string[]): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, "run", `${src}/src/cli.ts`, ...args],
    {
      cwd: src,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`hive ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

async function routingMutation(args: string[]): Promise<void> {
  const policy = JSON.parse(
    await runCli(["routing", "export", "--port", String(port)]),
  );
  await runCli([
    ...args,
    "--expect-revision",
    String(policy.revision),
    "--port",
    String(port),
  ]);
}

const authorization = authorizationHeaders("queen");
if (!authorization) throw new Error("the QA queen credential is missing");
const authorizedFetch = (url: URL | RequestInfo, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(authorization)) {
    headers.set(key, value as string);
  }
  return fetch(url, { ...init, headers });
};

const client = new Client(
  { name: "qa-composer-arbitration", version: "1" },
  { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
);
let agent: AgentRow | null = null;
let providerArmed = false;

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw new Error(`${name}: ${stringify(result.content).trim()}`);
  }
  return result;
}

async function callAgentTool(
  agentName: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const agentClient = new Client(
    { name: "qa-composer-agent", version: "1" },
    { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { fetch: agentFetch(agentName) },
  );
  try {
    await agentClient.connect(transport);
    const result = await agentClient.callTool({ name, arguments: args });
    if (result.isError === true) {
      throw new Error(`${name}: ${stringify(result.content).trim()}`);
    }
    return result;
  } finally {
    await agentClient.close().catch(() => undefined);
  }
}

async function status(): Promise<unknown> {
  return callTool("hive_status", { detail: "full" });
}

/**
 * Live session gate after arbiter reduction (06b3cf7f): capture.composer is
 * always null. Readiness is a live session that has painted visible text so a
 * user INPUT_SUBMIT is not lost on a pre-raw-mode boot screen.
 */
async function waitForLiveSession(name: string): Promise<AgentRow> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await status();
    const row = findAgent(result, name);
    if (
      row &&
      row.status !== undefined &&
      ["dead", "done", "failed"].includes(row.status)
    ) {
      throw new Error(`agent ended during startup with status ${row.status}`);
    }
    if (row?.sessionLocator) {
      const capture = await observe(row).catch(() => null);
      if (
        capture != null &&
        capture.composer === null &&
        typeof capture.text === "string" &&
        capture.text.trim().length > 0
      ) {
        return row;
      }
    }
    await sleep(1_000);
  }
  throw new Error("agent did not expose a live painted session");
}

async function issueGrant(
  row: AgentRow,
  operations: string[],
  viewerId: string,
): Promise<unknown> {
  const response = await authorizedFetch(
    `http://127.0.0.1:${port}/agents/${encodeURIComponent(row.name)}/attach-grant`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionLocator: row.sessionLocator,
        viewerId,
        geometry,
        operations,
      }),
    },
  );
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body) || body.state !== "granted") {
    throw new Error(`attach grant ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.grant;
}

async function observe(row: AgentRow): Promise<TerminalCapture> {
  const locator = requireSessionLocator(row);
  const result = await callTool("hive_terminal_observe", {
    sessionId: locator.sessionId,
    generation: locator.generation,
    include: "visible-text",
    maxRows: 200,
  });
  const capture = asCapture(observeCapture(result));
  if (capture == null) throw new Error("terminal capture omitted");
  // Positive control on the reduced arbiter wire: the key stays, value is null.
  if (capture.composer != null) {
    throw new Error(
      `capture.composer must be null after arbiter reduction; got ${JSON.stringify(capture.composer)}`,
    );
  }
  return capture;
}

async function waitForCapture(
  row: AgentRow,
  state: string,
  predicate: (capture: TerminalCapture) => boolean,
): Promise<TerminalCapture> {
  const deadline = Date.now() + 30_000;
  let capture: TerminalCapture | null = null;
  while (Date.now() < deadline) {
    capture = await observe(row);
    if (predicate(capture)) {
      await writeJson(`${root}/${state}.json`, capture);
      return capture;
    }
    await sleep(100);
  }
  await writeJson(`${root}/${state}-failed.json`, capture);
  throw new Error(`${state} did not reach the required visual/input state`);
}

/** Pane has painted text; draft marker presence is checked separately. */
function baseReady(capture: TerminalCapture): boolean {
  return capture.composer === null && typeof capture.text === "string";
}

function hasDraftMarker(capture: TerminalCapture, marker: string): boolean {
  return (capture.text ?? "").includes(marker);
}

type AttachClient = {
  request: (
    type: string,
    expect: string,
    flags: number,
    payload: Record<string, unknown>,
  ) => Promise<{ payload: Uint8Array }>;
  close: () => void;
};

function asAttachClient(value: unknown): AttachClient {
  if (
    !isRecord(value) ||
    typeof value.request !== "function" ||
    typeof value.close !== "function"
  ) {
    throw new Error("attach client is missing request/close");
  }
  return value as AttachClient;
}

async function injectUser(
  row: AgentRow,
  bytes: Uint8Array,
  action: "edit" | "submit" | "cancel" | "gesture",
  label: string,
): Promise<unknown> {
  const viewerId = `qa-user-${vendor}-${label}-${stamp}`;
  const grant = await issueGrant(row, ["view", "user-input"], viewerId);
  const locator = requireSessionLocator(row);
  const attached = asAttachClient(
    await SessiondViewerAttachClient.attach({
      locator: row.sessionLocator,
      grant,
      geometry,
      viewerId,
    }),
  );
  const transactionId = `qa-${vendor}-${label}-${stamp}`;
  try {
    const frame = await attached.request(
      "INPUT_SUBMIT",
      "APPLIED",
      FRAME_FLAGS.contentSensitive,
      {
        schemaVersion: 1,
        session: {
          key: locator.sessionId,
          incarnation: String(locator.generation),
        },
        provenance: "user",
        action,
        transactionId,
        idempotencyKey: transactionId,
        operation: {
          kind: "bytes",
          encoding: "base64",
          bytes: Buffer.from(bytes).toString("base64"),
        },
      },
    );
    const applied: unknown = JSON.parse(
      new TextDecoder().decode(frame.payload),
    );
    if (!isRecord(applied) || applied.resultKind !== "input") {
      throw new Error(`unexpected input result: ${JSON.stringify(applied)}`);
    }
    await writeJson(`${root}/${label}-receipt.json`, applied.receipt);
    return applied.receipt;
  } finally {
    attached.close();
  }
}

/**
 * Visual draft presence is the post-cutover instrument for user text that
 * still lives in a native TUI. Frontend-owned draft state is not yet exported
 * on the daemon wire (aaron's agent-ui seam); until it is, the marker in
 * capture.text plus the user INPUT_SUBMIT receipt is the proof.
 */
function draftMarkerSnapshot(capture: TerminalCapture, marker: string): string {
  return hasDraftMarker(capture, marker) ? `present:${marker}` : "absent";
}

async function killAgent(): Promise<void> {
  if (!agent) return;
  const outcomes = [];
  for (const arguments_ of [
    { name: agent.name, removeWorktree: false },
    { name: agent.name, removeWorktree: true },
  ]) {
    outcomes.push(
      await client
        .callTool({ name: "hive_kill", arguments: arguments_ })
        .catch((error) => ({ error: String(error) })),
    );
    await sleep(1_000);
  }
  await writeJson(`${root}/cleanup.json`, outcomes);
}

let outcome: Record<string, unknown> = {
  result: "failed",
  vendor,
  startedAt: new Date().toISOString(),
};
try {
  await mkdir(root, { recursive: true });
  await routingMutation(["routing", "set-provider", vendor, "enabled"]);
  providerArmed = true;
  await routingMutation([
    "routing",
    "set-route",
    "simple_coding",
    "user-weighted",
    candidate,
  ]);
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { fetch: authorizedFetch },
  );
  await client.connect(transport);
  await callTool("hive_run_checkpoint", {
    reason: "unknown-context",
    contextUsage: {
      kind: "unknown",
      reason: "isolated QA root has no resident provider context",
    },
    decision: { decision: "replace", reason: "fresh isolated QA root" },
    written: {
      goal: "run the composer arbitration matrix",
      done: [],
      failures: [],
      uncertainty: [],
      nextAction: `profile ${vendor}`,
      rollback: "tear down the isolated QA rig",
    },
    unresolvedQuestions: [],
    model: null,
  });

  const spawn = await callTool("hive_spawn", {
    task: "Wait quietly for a terminal delivery test. Do not use tools or modify files.",
    category: "simple_coding",
    readOnly: true,
  });
  agent = asAgentRow(recordField(structuredContent(spawn), "agent"));
  if (!agent?.name) throw new Error("spawn omitted the agent identity");
  agent = await waitForLiveSession(agent.name);

  const empty = await waitForCapture(
    agent,
    "01-empty",
    (capture) => baseReady(capture) && !hasDraftMarker(capture, draftMarker),
  );

  const editReceipt = await injectUser(
    agent,
    new TextEncoder().encode(draftMarker),
    "edit",
    "user-edit",
  );
  if (!isRecord(editReceipt) || editReceipt.stage !== "written-to-terminal") {
    throw new Error(
      `user edit was not written: ${JSON.stringify(editReceipt)}`,
    );
  }
  const draft = await waitForCapture(
    agent,
    "02-user-draft",
    (capture) => baseReady(capture) && hasDraftMarker(capture, draftMarker),
  );

  const writesBeforeBusy = terminalWritesTotal(await status()) ?? null;
  const busyResult = await callTool("hive_mail_publish", {
    from: "queen",
    to: agent.name,
    lane: "control",
    topic: "qa",
    body: `busy delivery probe ${stamp}`,
    idempotencyKey: `qa-${vendor}-busy-${stamp}`,
  });
  const busyMessage = recordField(structuredContent(busyResult), "mail");
  if (typeof recordField(busyMessage, "itemId") !== "string") {
    throw new Error(`busy publish was not accepted: ${stringify(busyMessage)}`);
  }
  // Proof: durable mailbox accept while a user is mid-draft; the draft marker
  // stays visible and no automated terminal write is counted.
  const preserved = await waitForCapture(
    agent,
    "03-busy-preserved",
    (capture) => baseReady(capture) && hasDraftMarker(capture, draftMarker),
  );
  await sleep(2_000);
  const afterBusyPublish = await observe(agent);
  await writeJson(`${root}/03-busy-after-publish.json`, afterBusyPublish);
  if (
    draftMarkerSnapshot(afterBusyPublish, draftMarker) !==
    draftMarkerSnapshot(preserved, draftMarker)
  ) {
    throw new Error(
      `publishing changed a user's visible draft: ${stringify({
        before: draftMarkerSnapshot(preserved, draftMarker),
        after: draftMarkerSnapshot(afterBusyPublish, draftMarker),
      })}`,
    );
  }
  const writesAfterBusy = terminalWritesTotal(await status()) ?? null;
  if (
    typeof writesBeforeBusy === "number" &&
    typeof writesAfterBusy === "number" &&
    writesAfterBusy !== writesBeforeBusy
  ) {
    throw new Error(
      `busy publish caused automated terminal writes: before=${writesBeforeBusy} after=${writesAfterBusy}`,
    );
  }

  const clearReceipt = await injectUser(
    agent,
    new Uint8Array([0x15]),
    "edit",
    "user-clear",
  );
  if (!isRecord(clearReceipt) || clearReceipt.stage !== "written-to-terminal") {
    throw new Error(
      `user clear was not written: ${JSON.stringify(clearReceipt)}`,
    );
  }
  const cleared = await waitForCapture(
    agent,
    "04-cleared",
    (capture) => baseReady(capture) && !hasDraftMarker(capture, draftMarker),
  );

  const writesBeforeDeliver = terminalWritesTotal(await status()) ?? null;
  const deliveredResult = await callTool("hive_mail_publish", {
    from: "queen",
    to: agent.name,
    lane: "control",
    topic: "qa",
    body: `verified delivery probe ${stamp}`,
    idempotencyKey: `qa-${vendor}-delivered-${stamp}`,
  });
  const deliveredMessage = recordField(
    structuredContent(deliveredResult),
    "mail",
  );
  if (typeof recordField(deliveredMessage, "itemId") !== "string") {
    await writeJson(
      `${root}/05-delivery-failure-observe.json`,
      await observe(agent),
    );
    await writeJson(`${root}/05-delivery-failure-status.json`, await status());
    throw new Error(
      `publish to a cleared session was not accepted: ${stringify(deliveredMessage)}`,
    );
  }
  // An empty draft is not an invitation either. Delivery is a mailbox fact:
  // both publishes are waiting, and the pane still lacks the draft marker.
  await sleep(2_000);
  const delivered = await observe(agent);
  await writeJson(`${root}/05-delivered.json`, delivered);
  if (hasDraftMarker(delivered, draftMarker)) {
    throw new Error(
      `publishing reintroduced a cleared draft marker: ${stringify({
        textTail: (delivered.text ?? "").slice(-200),
      })}`,
    );
  }
  if (
    draftMarkerSnapshot(delivered, draftMarker) !==
    draftMarkerSnapshot(cleared, draftMarker)
  ) {
    throw new Error(
      `publishing changed a cleared draft snapshot: ${stringify({
        before: draftMarkerSnapshot(cleared, draftMarker),
        after: draftMarkerSnapshot(delivered, draftMarker),
      })}`,
    );
  }
  const writesAfterDeliver = terminalWritesTotal(await status()) ?? null;
  if (
    typeof writesBeforeDeliver === "number" &&
    typeof writesAfterDeliver === "number" &&
    writesAfterDeliver !== writesBeforeDeliver
  ) {
    throw new Error(
      `empty-session publish caused automated terminal writes: before=${writesBeforeDeliver} after=${writesAfterDeliver}`,
    );
  }
  const backlog = await callAgentTool(agent.name, "hive_mail_status", {
    recipient: agent.name,
  });
  const lanes = recordField(
    recordField(structuredContent(backlog), "mail"),
    "lanes",
  );
  if (recordField(recordField(lanes, "control"), "available") !== 2) {
    throw new Error(
      `both messages should be waiting in the mailbox: ${stringify(lanes)}`,
    );
  }

  outcome = {
    result: "passed",
    vendor,
    model: agent.model,
    completedAt: new Date().toISOString(),
    agent: {
      id: agent.id,
      name: agent.name,
      sessionLocator: agent.sessionLocator,
    },
    busyMessage,
    deliveredMessage,
    backlog: recordField(structuredContent(backlog), "mail"),
    userReceipts: { edit: editReceipt, clear: clearReceipt },
    terminalWrites: {
      beforeBusy: writesBeforeBusy,
      afterBusy: writesAfterBusy,
      beforeDeliver: writesBeforeDeliver,
      afterDeliver: writesAfterDeliver,
    },
    transitions: {
      empty: draftMarkerSnapshot(empty, draftMarker),
      userDraft: draftMarkerSnapshot(draft, draftMarker),
      busyPreserved: draftMarkerSnapshot(preserved, draftMarker),
      cleared: draftMarkerSnapshot(cleared, draftMarker),
      delivered: draftMarkerSnapshot(delivered, draftMarker),
    },
    captureComposerNull: true,
  };
} catch (error) {
  outcome = {
    ...outcome,
    completedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    agent,
  };
} finally {
  await killAgent().catch(() => undefined);
  await client.close().catch(() => undefined);
  if (providerArmed) {
    await routingMutation([
      "routing",
      "set-route",
      "simple_coding",
      "user-weighted",
    ]).catch(() => undefined);
    await routingMutation(["routing", "set-provider", vendor, "unset"]).catch(
      () => undefined,
    );
  }
  await writeJson(`${root}/result.json`, outcome);
  console.log(stringify(outcome));
}

if (outcome.result !== "passed") process.exitCode = 1;

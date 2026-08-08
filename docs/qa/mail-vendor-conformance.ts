import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

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
const root = `${qaHome}/artifacts/mail-conformance/${vendor}`;
if (process.env.HIVE_HOME !== qaHome) {
  throw new Error("start Bun with HIVE_HOME equal to HIVE_QA_HOME");
}

const credentialModule = await import(
  pathToFileURL(`${src}/src/cli/credential.ts`).href
);
const mcpProtocolModule = await import(
  pathToFileURL(`${src}/src/shared/mcp-protocol.ts`).href
);
const { authorizationHeaders } = credentialModule;
const { HIVE_MCP_VERSION_NEGOTIATION } = mcpProtocolModule;
const stamp = Date.now();
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
  // Prefer a compiled binary when the rig staged one; otherwise drive the same
  // sources under test (post-restart default). HIVE_QA_BIN may be empty.
  const hiveBin = process.env.HIVE_QA_BIN;
  const command =
    hiveBin && hiveBin.length > 0
      ? [hiveBin, ...args]
      : [process.execPath, "run", `${src}/src/cli.ts`, ...args];
  const child = Bun.spawn(command, {
    cwd: src,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
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
  { name: "qa-mail-vendor-conformance", version: "1" },
  { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
);
let agent: Record<string, any> | null = null;
let providerArmed = false;

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw new Error(`${name}: ${stringify(result.content).trim()}`);
  }
  return result;
}

async function status(): Promise<any> {
  return callTool("hive_status", { detail: "full" });
}

async function observe(row: Record<string, any>): Promise<any> {
  const result = await callTool("hive_terminal_observe", {
    sessionId: row.sessionLocator.sessionId,
    generation: row.sessionLocator.generation,
    include: "visible-text",
    maxRows: 200,
  });
  return result.structuredContent?.terminalObservation?.capture;
}

/**
 * Protocol-native idle gate (post arbiter reduction 06b3cf7f).
 *
 * Capture.composer is always null on the wire — the classifiers are gone — so
 * readiness is agent status plus session identity, never a fabricated composer
 * measurement. When status dimensions are present, turn idle/ready/done is a
 * positive control; absence of the dimension is not a failure (unknown ≠ false).
 */
function turnLooksIdle(row: Record<string, any>): boolean {
  const turn = row.statusDimensions?.turn;
  if (turn?.kind !== "observed" || turn.field?.value == null) return true;
  return ["idle", "ready", "done"].includes(turn.field.value);
}

async function waitForIdle(name: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await status();
    const row = result.structuredContent?.agents?.find(
      (candidate_: Record<string, any>) => candidate_.name === name,
    );
    if (row && ["dead", "done", "failed"].includes(row.status)) {
      throw new Error(`agent ended during startup with status ${row.status}`);
    }
    if (row?.sessionLocator && row.status === "idle" && turnLooksIdle(row)) {
      return row;
    }
    await sleep(1_000);
  }
  throw new Error("agent did not reach an idle session after mail settlement");
}

async function waitForAuthenticated(name: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await status();
    const row = result.structuredContent?.agents?.find(
      (candidate_: Record<string, any>) => candidate_.name === name,
    );
    if (row && ["dead", "done", "failed"].includes(row.status)) {
      throw new Error(`agent ended during authentication with status ${row.status}`);
    }
    if (row?.sessionLocator) {
      const capture = await observe(row).catch(() => null);
      // Auth probe only: visible marker that the vendor process is alive. Not
      // delivery evidence — mail contract uses journal + zero automated writes.
      if ((capture?.text ?? "").includes("M3_AUTH_OK")) {
        return row;
      }
    }
    await sleep(1_000);
  }
  throw new Error("vendor did not emit the authentication marker");
}

function mail(result: any): Record<string, any> {
  return result.structuredContent?.mail ?? {};
}

function journal(itemIds: string[]): Record<string, any>[] {
  const db = new Database(`${qaHome}/hive.db`, { readonly: true });
  try {
    return db
      .query(
        `SELECT itemId, kind, actor, actorGeneration, idempotencyKey, at, detailJson
           FROM mail_events
          WHERE itemId IN (${itemIds.map(() => "?").join(",")})
          ORDER BY rowid`,
      )
      .all(...itemIds) as Record<string, any>[];
  } finally {
    db.close();
  }
}

async function waitForSettled(itemIds: string[]): Promise<Record<string, any>[]> {
  const timeout = Number(process.env.M3_SETTLE_TIMEOUT_MS ?? "360000");
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("M3_SETTLE_TIMEOUT_MS must be a positive number");
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const events = journal(itemIds);
    if (
      itemIds.every((itemId) =>
        events.some(
          (event) => event.itemId === itemId && event.kind === "completed",
        ),
      )
    ) {
      return events;
    }
    await sleep(1_000);
  }
  throw new Error("agent did not settle every conformance item");
}

async function killAgent(): Promise<void> {
  if (!agent) return;
  await client
    .callTool({
      name: "hive_kill",
      arguments: { name: agent.name, removeWorktree: true },
    })
    .catch(() => undefined);
}

let outcome: Record<string, unknown> = {
  result: "failed",
  vendor,
  startedAt: new Date().toISOString(),
};
const publishedItemIds: string[] = [];
try {
  await mkdir(root, { recursive: true });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { fetch: authorizedFetch },
  );
  await client.connect(transport);
  const beforeSpawn = await status();
  await routingMutation(["routing", "set-provider", vendor, "enabled"]);
  providerArmed = true;
  await routingMutation([
    "routing",
    "set-route",
    "simple_coding",
    "user-weighted",
    candidate,
  ]);
  await callTool("hive_run_checkpoint", {
    reason: "unknown-context",
    contextUsage: {
      kind: "unknown",
      reason: "isolated conformance root has no provider context",
    },
    decision: { decision: "replace", reason: "fresh isolated root" },
    written: {
      goal: "run the mail conformance contract",
      done: [],
      failures: [],
      uncertainty: [],
      nextAction: `profile ${vendor}`,
      rollback: "tear down the isolated rig",
    },
    unresolvedQuestions: [],
    model: null,
  });
  const authProbe = process.env.M3_AUTH_PROBE === "1";
  const contractTask = [
    "At the first safe point, handle the mailbox for your exact assigned name.",
    "First call hive_update_status and preserve its mailBacklog result as the notice receipt.",
    "Then call hive_mail_poll for your own recipient name.",
    "Claim the returned control item and every returned work digest item with handlerId m3-safe-point. After each successful claim, try once to claim that same item with handlerId m3-competing and preserve the expected refusal.",
    "Complete each claimed item as completed, then call hive_mail_complete a second time for each with the same handlerId to prove replay.",
    "Finally call hive_mail_status for your own recipient and report the tool receipts exactly.",
  ].join(" ");
  const spawn = await callTool("hive_spawn", {
    task: authProbe
      ? "Reply exactly M3_AUTH_OK, then wait. Do not call tools or modify files."
      : contractTask,
    category: "simple_coding",
    readOnly: true,
  });
  agent = spawn.structuredContent?.agent;
  if (!agent?.name) throw new Error("spawn omitted the agent identity");
  if (authProbe) {
    agent = await waitForAuthenticated(agent.name);
    const afterSpawn = await status();
    const authenticatedCapture = await observe(agent);
    await writeJson(`${root}/auth-probe-status.json`, afterSpawn.structuredContent);
    await writeJson(`${root}/auth-probe-terminal.json`, authenticatedCapture);
    outcome = {
      result: "auth-worked",
      vendor,
      completedAt: new Date().toISOString(),
      agent: {
        id: agent.id,
        name: agent.name,
        model: agent.model,
        sessionLocator: agent.sessionLocator,
      },
    };
    await writeJson(`${root}/result.json`, outcome);
  } else {
  const afterSpawn = await status();
  const spawnWrites = afterSpawn.structuredContent?.terminalWrites?.total;
  if (typeof spawnWrites !== "number") {
    throw new Error("terminal-write counter is absent");
  }

  // The post-restart counter tallies the kickoff delivery too, and for a
  // vendor whose TUI boots slowly those writes land after the afterSpawn
  // snapshot. The zero-write invariant covers mail handling, not kickoff, so
  // the baseline waits for the turn to start: the task bytes are delivered
  // by then, and anything afterwards belongs to the measured window.
  const workingDeadline = Date.now() + 180_000;
  let baselineStatus: any = null;
  for (;;) {
    const current = await status();
    const row = current.structuredContent?.agents?.find(
      (candidate_: Record<string, any>) => candidate_.name === agent?.name,
    );
    if (row && ["dead", "done", "failed"].includes(row.status)) {
      throw new Error(`agent ended before its first turn with status ${row.status}`);
    }
    if (row && (row.status === "working" || row.status === "idle")) {
      baselineStatus = current;
      break;
    }
    if (Date.now() >= workingDeadline) {
      throw new Error("agent never began its kickoff turn");
    }
    await sleep(1_000);
  }
  const baselineWrites = baselineStatus.structuredContent?.terminalWrites?.total;
  if (typeof baselineWrites !== "number") {
    throw new Error("terminal-write counter is absent at the working baseline");
  }
  await writeJson(`${root}/status-working.json`, baselineStatus.structuredContent);

  const controlKey = `m3-${vendor}-control-${stamp}`;
  const workKey = `m3-${vendor}-work-${stamp}`;
  const controlRequest = {
    from: "queen",
    to: agent.name,
    lane: "control",
    topic: "m3-control",
    body: `control conformance ${stamp}`,
    idempotencyKey: controlKey,
  };
  const controlFirst = mail(await callTool("hive_mail_publish", controlRequest));
  const controlReplay = mail(await callTool("hive_mail_publish", controlRequest));
  if (controlReplay.itemId !== controlFirst.itemId) {
    throw new Error("idempotent publish returned a different control item");
  }
  const workFirst = mail(
    await callTool("hive_mail_publish", {
      from: "queen",
      to: agent.name,
      lane: "work",
      topic: "m3-work",
      body: `work conformance ${stamp}`,
      idempotencyKey: workKey,
    }),
  );
  const workMerged = mail(
    await callTool("hive_mail_publish", {
      from: "queen",
      to: agent.name,
      lane: "work",
      topic: "m3-work",
      body: `work conformance merged ${stamp}`,
      idempotencyKey: `${workKey}-merged`,
    }),
  );
  if (workMerged.itemId !== workFirst.itemId || workMerged.mergedCount !== 1) {
    throw new Error("work lane did not coalesce by sender and topic");
  }
  publishedItemIds.push(controlFirst.itemId, workFirst.itemId);

  const writesBeforeMail = baselineWrites;
  const events = await waitForSettled([controlFirst.itemId, workFirst.itemId]);
  agent = await waitForIdle(agent.name);
  const finalStatus = await status();
  const writesAfterMail = finalStatus.structuredContent?.terminalWrites?.total;
  if (writesAfterMail !== writesBeforeMail) {
    throw new Error("mail handling caused an automated terminal write");
  }
  const finalCapture = await observe(agent).catch(() => null);
  // Positive control: arbiter reduction left the key on the wire as null.
  // A non-null composer means we are reading an old daemon or a fabricated fact.
  if (finalCapture != null && finalCapture.composer != null) {
    throw new Error(
      `capture.composer must be null after arbiter reduction; got ${JSON.stringify(finalCapture.composer)}`,
    );
  }
  const finalAgent = finalStatus.structuredContent?.agents?.find(
    (candidate_: Record<string, any>) => candidate_.name === agent?.name,
  );
  await writeJson(`${root}/journal.json`, events);
  await writeJson(`${root}/status-before-spawn.json`, beforeSpawn.structuredContent);
  await writeJson(`${root}/status-after-spawn.json`, afterSpawn.structuredContent);
  await writeJson(`${root}/status-final.json`, finalStatus.structuredContent);
  if (finalCapture != null) {
    await writeJson(`${root}/terminal-final.json`, finalCapture);
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
      status: agent.status,
      statusDimensions: finalAgent?.statusDimensions ?? null,
    },
    publish: { controlFirst, controlReplay, workFirst, workMerged },
    // Protocol receipts: durable mail journal settlement, not terminal delivery.
    settlement: {
      itemIds: [controlFirst.itemId, workFirst.itemId],
      completedKinds: events
        .filter((event) => event.kind === "completed")
        .map((event) => event.itemId),
      eventCount: events.length,
    },
    terminalWrites: {
      beforeSpawn: beforeSpawn.structuredContent?.terminalWrites,
      afterSpawn: afterSpawn.structuredContent?.terminalWrites,
      workingBaseline: baselineStatus.structuredContent?.terminalWrites,
      final: finalStatus.structuredContent?.terminalWrites,
    },
    captureComposerNull: finalCapture == null ? "unobserved" : true,
    eventCount: events.length,
  };
  }
} catch (error) {
  if (agent?.name) {
    const failureStatus = await status().catch(() => null);
    const currentAgent = failureStatus?.structuredContent?.agents?.find(
      (candidate_: Record<string, any>) => candidate_.name === agent?.name,
    );
    if (failureStatus) {
      await writeJson(`${root}/failure-status.json`, failureStatus.structuredContent).catch(
        () => undefined,
      );
    }
    if (currentAgent?.sessionLocator) {
      agent = currentAgent;
      await writeJson(`${root}/failure-terminal.json`, await observe(currentAgent)).catch(
        () => undefined,
      );
    }
  }
  if (publishedItemIds.length > 0) {
    await writeJson(`${root}/failure-journal.json`, journal(publishedItemIds)).catch(
      () => undefined,
    );
  }
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
    await routingMutation([
      "routing",
      "set-provider",
      vendor,
      "unset",
    ]).catch(() => undefined);
  }
  await writeJson(`${root}/result.json`, outcome);
  console.log(stringify(outcome));
}

if (!new Set(["passed", "auth-worked"]).has(String(outcome.result))) {
  process.exitCode = 1;
}

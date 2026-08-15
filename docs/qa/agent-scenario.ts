// Drives one real agent through spawn, observation, messaging, and teardown
// against an already-running QA rig. Every empty read has a positive control:
// terminal output must be non-empty, the exact message row must exist, and the
// process reader must recover this script's own pid plus cwd inode.

import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import { agentFetch } from "../../src/cli/credential";
import { AgentRecordSchema } from "../../src/schemas/agent";
import { CaptureResultSchema } from "../../src/schemas/session-protocol";
import {
  findMarkerAgents,
  isProductFailure,
  planTeardown,
  readbackAllowsRemoval,
  teardownReport,
  type TeardownReadback,
} from "./agent-scenario-core";
import { callMcpTool } from "./qa-client";

const home = requiredEnv("HIVE_QA_HOME");
const project = requiredEnv("HIVE_QA_PROJECT");
const port = z.coerce
  .number()
  .int()
  .positive()
  .parse(requiredEnv("HIVE_QA_PORT"));
const rootFetch = agentFetch("queen");
const marker = `HIVE_QA_AGENT_SCENARIO_${Date.now()}`;
const initialHead = git("rev-parse", "HEAD");
const initialWorktrees = git("worktree", "list", "--porcelain");
let agent: z.infer<typeof AgentRecordSchema> | null = null;
let workingIdentities = new Set<string>();

const SpawnSummarySchema = z.object({ id: z.string() });
const TerminalObservationSchema = z.object({
  capture: CaptureResultSchema,
});
const SendSummarySchemaShape = z.object({ itemId: z.string() });
const MailStatusSchema = z.object({
  recipient: z.string(),
  lanes: z.object({
    control: z.object({ available: z.number(), leased: z.number() }),
    work: z.object({ available: z.number(), leased: z.number() }),
  }),
  oldestAvailable: z
    .object({ itemId: z.string(), ageSeconds: z.number() })
    .nullable(),
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is required; run this through qa/rig.sh or pass its published coordinates`,
    );
  return value;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", project, ...args]);
  if (!result.success)
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  return new TextDecoder().decode(result.stdout).trim();
}

async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return await callMcpTool(port, rootFetch, name, args, key, schema);
}

async function status(): Promise<z.infer<typeof AgentRecordSchema>[]> {
  return await callTool(
    "hive_status",
    { detail: "full" },
    "agents",
    AgentRecordSchema.array(),
  );
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(500);
  }
}

async function lsof(args: string[]): Promise<string> {
  const child = Bun.spawn(["lsof", "-n", "-P", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0 && stdout.length === 0) {
    if (code === 1 && stderr.length === 0) return "";
    throw new Error(`lsof failed (${code}): ${stderr.trim()}`);
  }
  return stdout;
}

function parseCwdIdentities(output: string): Set<string> {
  const identities = new Set<string>();
  let pid: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    if (line.startsWith("i") && pid !== null)
      identities.add(`${pid}:${line.slice(1)}`);
  }
  return identities;
}

async function cwdIdentitiesUnder(path: string): Promise<Set<string>> {
  return parseCwdIdentities(
    await lsof(["-a", "-d", "cwd", "+D", path, "-Fpfi"]),
  );
}

async function cwdIdentityForPid(pid: number): Promise<string | null> {
  const identities = parseCwdIdentities(
    await lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fpfi"]),
  );
  return identities.values().next().value ?? null;
}

/**
 * What the recipient's mailbox still holds, through the daemon's own tool.
 *
 * Settlement is absence: a handled message leaves `mail_items` entirely, so
 * "nothing outstanding" is the milestone this scenario waits on.
 */
async function mailboxStatus(
  recipient: string,
): Promise<z.infer<typeof MailStatusSchema>> {
  return callTool("hive_mail_status", { recipient }, "mail", MailStatusSchema);
}

function outstanding(status: z.infer<typeof MailStatusSchema>): number {
  return (
    status.lanes.control.available +
    status.lanes.control.leased +
    status.lanes.work.available +
    status.lanes.work.leased
  );
}

function mailTimeline(status: z.infer<typeof MailStatusSchema>): string {
  return (
    `outstanding=${outstanding(status)} ` +
    `oldest=${status.oldestAvailable === null ? "none" : `${status.oldestAvailable.itemId} (+${status.oldestAvailable.ageSeconds}s)`}`
  );
}
async function reconcileMarkerAdmissions(): Promise<
  z.infer<typeof AgentRecordSchema>[]
> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const matched = findMarkerAgents(await status(), marker);
    if (matched.length > 0) {
      agent ??= matched[0] ?? null;
      return matched;
    }
    if (Date.now() >= deadline) return [];
    await Bun.sleep(250);
  }
}

async function teardown(): Promise<TeardownReadback> {
  const teardownAgents = await reconcileMarkerAdmissions();
  const plan = planTeardown(teardownAgents, project);
  if (plan.kind === "no-admission") return "no-admission";

  const { readbackRoot } = plan;
  if (!existsSync(readbackRoot)) {
    throw new Error(`survivor readback root does not exist: ${readbackRoot}`);
  }
  if (workingIdentities.size === 0) {
    workingIdentities = await cwdIdentitiesUnder(readbackRoot);
  }
  for (const target of teardownAgents) {
    await callTool("hive_kill", { name: target.name }, "result", z.unknown());
  }

  await waitFor("provider processes to exit", 30_000, async () => {
    for (const identity of workingIdentities) {
      const pid = Number(identity.slice(0, identity.indexOf(":")));
      if ((await cwdIdentityForPid(pid)) === identity) return null;
    }
    return readbackAllowsRemoval(await cwdIdentitiesUnder(readbackRoot))
      ? true
      : null;
  });

  for (const target of teardownAgents) {
    await callTool(
      "hive_kill",
      { name: target.name, removeWorktree: true },
      "result",
      z.unknown(),
    );
  }
  await waitFor("test project restoration", 15_000, async () => {
    const clean = git("status", "--porcelain") === "";
    const sameHead = git("rev-parse", "HEAD") === initialHead;
    const sameWorktrees =
      git("worktree", "list", "--porcelain") === initialWorktrees;
    return clean && sameHead && sameWorktrees ? true : null;
  });
  return "clean";
}

if (git("status", "--porcelain") !== "")
  throw new Error(`QA project is not fresh: ${project}`);
const readerControl = await cwdIdentityForPid(process.pid);
const expectedReaderControl = `${process.pid}:${statSync(process.cwd(), { bigint: true }).ino}`;
if (readerControl !== expectedReaderControl) {
  throw new Error(
    "lsof process reader failed its pid+cwd-inode positive control",
  );
}

let failure: unknown = null;
try {
  await callTool(
    "hive_run_checkpoint",
    {
      reason: "unknown-context",
      contextUsage: {
        kind: "unknown",
        reason: "headless QA owner has no root TUI context measurement",
      },
      decision: {
        decision: "replace",
        reason: "checkpoint the headless owner before agent admission",
      },
      written: {
        goal: "Run one QA agent through spawn, observation, messaging, and teardown",
        done: ["QA rig coordinates and routing were verified"],
        failures: [],
        uncertainty: [
          "Provider assignment is unknown until spawn admission completes",
        ],
        nextAction: "Spawn one standard_coding agent and measure its lifecycle",
        rollback: "Kill the spawned agent and discard its branch and worktree",
      },
      unresolvedQuestions: [],
      model: null,
    },
    "checkpoint",
    z.unknown(),
  );

  const spawned = await callTool(
    "hive_spawn",
    {
      category: "standard_coding",
      task:
        `QA lifecycle marker ${marker}. Implement TASK 3 from TASKS.md. ` +
        "Do not land. Stay available for one follow-up message from queen. " +
        "At each safe point call hive_mail_poll; claim the control message with hive_mail_claim and settle it with hive_mail_complete before resuming.",
    },
    "agent",
    SpawnSummarySchema,
  );
  agent = await waitFor(
    "spawn admission and terminal locator",
    120_000,
    async () => {
      const row = (await status()).find(
        (candidate) => candidate.id === spawned.id,
      );
      if (row !== undefined) {
        agent = row;
      }
      if (row?.status === "dead" || row?.status === "done") {
        agent = row;
        throw new Error(`agent startup ended: ${row.status}`);
      }
      if (
        row?.sessionLocator === undefined ||
        !["working", "idle", "awaiting-approval"].includes(row.status)
      ) {
        return null;
      }
      return row;
    },
  );
  console.log(
    `admitted ${agent.name} (${agent.tool}/${agent.model}) id=${agent.id}`,
  );

  const observed = await waitFor(
    "non-empty provider terminal output",
    60_000,
    async () => {
      if (agent?.sessionLocator === undefined) return null;
      const value = await callTool(
        "hive_terminal_observe",
        {
          sessionId: agent.sessionLocator.sessionId,
          generation: agent.sessionLocator.generation,
          include: "visible-text",
          maxRows: 200,
        },
        "terminalObservation",
        TerminalObservationSchema,
      );
      return value.capture.text?.trim() ? value : null;
    },
  );
  if (observed.capture.locator.sessionId !== agent.sessionLocator?.sessionId) {
    throw new Error("terminal observation returned the wrong session");
  }
  console.log(
    `positive-control observation passed sha256=${observed.capture.sha256}`,
  );

  if (agent.worktreePath === null)
    throw new Error("admitted agent has no worktree");
  workingIdentities = await waitFor(
    "provider cwd identity",
    30_000,
    async () => {
      const identities = await cwdIdentitiesUnder(agent?.worktreePath ?? "");
      return identities.size === 0 ? null : identities;
    },
  );
  console.log(
    `observed working cwd identities: ${[...workingIdentities].join(",")}`,
  );

  const sent = await callTool(
    "hive_mail_publish",
    {
      from: "queen",
      to: agent.name,
      lane: "control",
      topic: "qa",
      body: `QA follow-up ${marker}: handle and settle this message, then publish queen a one-line acknowledgement.`,
      idempotencyKey: `qa-follow-up:${marker}`,
    },
    "mail",
    SendSummarySchemaShape,
  );
  const stored = await mailboxStatus(agent.name);
  if (outstanding(stored) === 0)
    throw new Error("mailbox reader failed its positive control");
  const acknowledgementDeadline = Date.now() + 240_000;
  let acknowledged = stored;
  while (outstanding(acknowledged) > 0) {
    if (Date.now() >= acknowledgementDeadline) {
      const currentAgent = (await status()).find(
        (candidate) => candidate.id === agent?.id,
      );
      let lastObservation = "unavailable";
      if (agent?.sessionLocator !== undefined) {
        try {
          const finalObservation = await callTool(
            "hive_terminal_observe",
            {
              sessionId: agent.sessionLocator.sessionId,
              generation: agent.sessionLocator.generation,
              include: "visible-text",
              maxRows: 200,
            },
            "terminalObservation",
            TerminalObservationSchema,
          );
          lastObservation =
            finalObservation.capture.text?.trim().slice(-500) ?? "<empty>";
        } catch (error) {
          lastObservation = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      throw new Error(
        `PRODUCT_RED message settlement timed out agentStatus=${currentAgent?.status ?? "unknown"} ` +
          `lastObservation=${JSON.stringify(lastObservation)} ${mailTimeline(acknowledged)}`,
      );
    }
    await Bun.sleep(500);
    acknowledged = await mailboxStatus(agent.name);
  }
  console.log(
    `message settled itemId=${sent.itemId} ${mailTimeline(acknowledged)}`,
  );
} catch (error) {
  failure = error;
} finally {
  try {
    console.log(teardownReport(await teardown()));
  } catch (error) {
    failure =
      failure === null
        ? error
        : new AggregateError([failure, error], "scenario and teardown failed");
  }
}

if (failure !== null) {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (isProductFailure(failure)) throw failure;
  throw new Error(`INFRASTRUCTURE_RED ${message}`, { cause: failure });
}
console.log("agent scenario passed");

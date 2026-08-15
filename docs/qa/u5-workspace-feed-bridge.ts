// Bridges one held live-proof snapshot into the Workspace's existing feed
// override. Terminal grants and rendering still use their production paths;
// this process only avoids competing with the rig's daemon-lifetime owner.

import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { publishWorkspaceVisibility } from "../../src/cli/workspace-feed";
import { SessionLocatorSchema } from "../../src/schemas/session-protocol";
import { WorkspaceVisibilityInventoryInputSchema } from "../../src/daemon/session-host/workspace-visibility";
import { requiredQaCoordinates } from "./qa-client";
import { qaRepoRoot } from "./repo-root";

const ReadySchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.literal("ready"),
  observedAt: z.iso.datetime({ offset: true }),
  evidenceRoot: z.string().min(1),
  agents: z.array(
    z.strictObject({
      agentId: z.string().min(1),
      name: z.string().min(1),
      provider: z.enum(["claude", "codex", "grok", "kimi", "opencode"]),
      model: z.string().min(1),
      status: z.string().min(1),
      locator: SessionLocatorSchema,
    }),
  ),
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function writeReceipt(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

// Publication is safe only when every coordinate binds this process to the
// same private rig that owns the daemon and rendezvous files.
const coordinates = requiredQaCoordinates();
const home = realpathSync(required("HIVE_HOME"));
const qaHome = realpathSync(coordinates.home);
const project = realpathSync(coordinates.project);
const artifacts = realpathSync(coordinates.artifacts);
const sourceRoot = realpathSync(coordinates.sourceRoot);
const scriptSourceRoot = qaRepoRoot(import.meta.dir);

if (home !== qaHome) {
  throw new Error(`HIVE_HOME does not match HIVE_QA_HOME: ${home} != ${qaHome}`);
}
if (!home.startsWith("/private/tmp/hvqa-") && !home.startsWith("/tmp/hvqa-")) {
  throw new Error(`QA home is not an isolated short rig: ${home}`);
}
if (home.length > 20) {
  throw new Error(`QA home is too long for the session host socket path: ${home}`);
}
if (project === "/Users/scottkellar/Projects/hive-test-project") {
  throw new Error("refusing the shared hive-test-project");
}
if (!project.startsWith("/private/tmp/") && !project.startsWith("/tmp/")) {
  throw new Error(`QA project is not isolated under the temporary root: ${project}`);
}
if (!artifacts.startsWith(`${home}/`)) {
  throw new Error(`artifact directory is outside the QA home: ${artifacts}`);
}
if (sourceRoot !== scriptSourceRoot) {
  throw new Error(
    `running daemon source ${sourceRoot} does not match bridge source ${scriptSourceRoot}`,
  );
}

const port = z.coerce.number().int().positive().parse(argument("--port"));
if (port !== coordinates.port) {
  throw new Error(
    `daemon port ${port} does not match HIVE_QA_PORT ${coordinates.port}`,
  );
}
const readyPath = resolve(required("HIVE_QA_U5_APP_READY_PATH"));
const receiptPath = resolve(required("HIVE_QA_U5_APP_FEED_RECEIPT"));
for (const path of [readyPath, receiptPath]) {
  if (!path.startsWith(`${artifacts}/`)) {
    throw new Error(`feed bridge path is outside the rig artifacts: ${path}`);
  }
}

const ready = ReadySchema.parse(JSON.parse(readFileSync(readyPath, "utf8")));
const ownerPid = z.coerce
  .number()
  .int()
  .positive()
  .parse(readFileSync(`${home}/owner.pid`, "utf8").trim());
const workspaceSessionID = `qa-rig-${ownerPid}`;
const agents = ready.agents.map((agent) => ({
  id: agent.agentId,
  name: agent.name,
  tool: agent.provider,
  model: agent.model,
  status: agent.status,
  sessionLocator: agent.locator,
}));

process.stdout.write(`${JSON.stringify({ v: 1, agents })}\n`);
const accepted: Array<Record<string, unknown>> = [];
writeReceipt(receiptPath, {
  schemaVersion: 1,
  state: "snapshot-emitted",
  emittedAt: new Date().toISOString(),
  sourceReadyPath: readyPath,
  agentCount: agents.length,
  agents,
  acceptedVisibility: accepted,
});

let revision = BigInt(process.env.HIVE_QA_U5_VISIBILITY_BASE_REVISION ?? "1");
let pending = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true });
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line.trim().length === 0) continue;
    const input = WorkspaceVisibilityInventoryInputSchema.parse(JSON.parse(line));
    revision += 1n;
    const projected = {
      ...input,
      inventoryRevision: revision.toString(),
    };
    const result = await publishWorkspaceVisibility(
      port,
      workspaceSessionID,
      ownerPid,
      projected,
    );
    accepted.push({
      acceptedAt: new Date().toISOString(),
      appInventoryRevision: input.inventoryRevision,
      publishedInventoryRevision: projected.inventoryRevision,
      terminalCount: projected.terminals.length,
      durationMs: result.durationMs,
    });
    writeReceipt(receiptPath, {
      schemaVersion: 1,
      state: "visibility-accepted",
      emittedAt: new Date().toISOString(),
      sourceReadyPath: readyPath,
      agentCount: agents.length,
      agents,
      acceptedVisibility: accepted,
    });
  }
}

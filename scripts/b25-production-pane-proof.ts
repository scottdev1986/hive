/**
 * B2.5.1b — real production spawn rendered by HiveTerminalView in the real
 * Workspace. This is deliberately not the B2.2 manual-create demo harness.
 *
 * The driver starts the staged production daemon, launches the real Workspace,
 * calls hive_spawn through the daemon's MCP surface, and requires two
 * independent observations:
 *   1. the Workspace reports a first-correct HiveTerminalView frame on the
 *      exact sessiond locator, with no hidden SwiftTerm child PTY; and
 *   2. the real vendor agent executes its one-step task by sending a nonce to
 *      the isolated daemon's queen inbox.
 *
 * Env:
 *   HIVE_B25_HOME       short fresh home (default /tmp/hb25-pane-<random>)
 *   HIVE_B25_PORT       requested port (default 43141)
 *   HIVE_B25_TOOL       claude|codex|grok (default codex)
 *   HIVE_B25_MODEL      optional exact model pin
 *   HIVE_B25_AGENT      fixed Hive name in the throwaway project (default aria)
 *   HIVE_B25_EVIDENCE   evidence root
 *   HIVE_INSTALL_ROOT   staged release root (default .dev/root)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { operatorFetch } from "../src/cli/credential";
import { hiveInstanceSuffix } from "../src/daemon/tmux-sessions";

type Tool = "claude" | "codex" | "grok";
type Child = Bun.Subprocess<
  "ignore",
  ReturnType<typeof Bun.file>,
  ReturnType<typeof Bun.file>
>;

interface SessionLocator {
  instanceId: string;
  generation: number;
  sessionId: string;
  hostKind: string;
  engineBuildId?: string;
}

interface AgentStatus {
  name: string;
  tool: string;
  model: string;
  status: string;
  sessionLocator?: SessionLocator;
}

const repoRoot = resolve(import.meta.dir, "..");
const installRoot = process.env.HIVE_INSTALL_ROOT ?? join(repoRoot, ".dev/root");
const stagedHive = join(installRoot, "current", "hive");
const stagedSessiond = join(installRoot, "current", "hive-sessiond");
const workspaceBinary = join(
  installRoot,
  "current/HiveWorkspace.app/Contents/MacOS/HiveWorkspace",
);
const suffix = Math.random().toString(16).slice(2, 8);
const home = process.env.HIVE_B25_HOME ?? `/tmp/hb25-pane-${suffix}`;
const project = `/tmp/hb25-project-${suffix}`;
const port = Number(process.env.HIVE_B25_PORT ?? "43141");
const agent = process.env.HIVE_B25_AGENT ?? "aria";
const requestedTool = process.env.HIVE_B25_TOOL ?? "codex";
const evidence = process.env.HIVE_B25_EVIDENCE ??
  join(repoRoot, "raw/qualification/hive-b25-production-pane");
const outPath = join(evidence, "matrix/production-wiring-pane.txt");
const manifestPath = join(evidence, "manifests/production-wiring-pane.json");
const paneResultPath = join(home, "production-pane-result.txt");
const workspaceStdoutPath = join(home, "workspace.stdout.log");
const workspaceStderrPath = join(home, "workspace.stderr.log");
const daemonStdoutPath = join(home, "daemon.stdout.log");
const daemonStderrPath = join(home, "daemon.stderr.log");
const startedAt = new Date().toISOString();
const marker = `B25_PRODUCTION_PANE_EXECUTED_${crypto.randomUUID()}`;
const lines: string[] = [];
let observed: AgentStatus | null = null;
let sideEffectMessageId: string | null = null;
let paneReport: string | null = null;
let daemon: Child | null = null;
let workspace: Child | null = null;
let client: Client | null = null;
let boundPort: number | null = null;
let spawned = false;
let ok = false;

function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  lines.push(stamped);
  console.log(stamped);
}

function command(argv: string[], cwd: string, env = process.env): string {
  const result = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

function toolValue(result: unknown, key: string): unknown {
  const value = result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (value.isError === true) {
    throw new Error(
      value.content?.map((item) => item.text ?? "").join(" ") || "MCP tool failed",
    );
  }
  const structured = value.structuredContent?.[key];
  if (structured !== undefined) return structured;
  const text = value.content?.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error(`MCP tool returned no ${key}`);
  return JSON.parse(text) as unknown;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForPaneReport(): Promise<string> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (existsSync(paneResultPath)) {
      const report = readFileSync(paneResultPath, "utf8");
      if (report.includes("PRODUCTION PANE PROOF FAIL")) throw new Error(report.trim());
      if (report.includes("PRODUCTION PANE PROOF OK")) return report;
    }
    if (workspace !== null && workspace.exitCode !== null) {
      const stderr = existsSync(workspaceStderrPath)
        ? readFileSync(workspaceStderrPath, "utf8").trim()
        : "";
      throw new Error(`Workspace exited before pane proof: ${stderr}`);
    }
    await Bun.sleep(100);
  }
  throw new Error("Workspace did not record a production-pane result within 90s");
}

function validatePaneReport(report: string, record: AgentStatus): void {
  const locator = record.sessionLocator;
  if (locator === undefined) throw new Error("spawned agent has no sessionLocator");
  if (locator.hostKind !== "sessiond") {
    throw new Error(`spawned agent hostKind=${locator.hostKind}, expected sessiond`);
  }
  const exact = `agent=${record.name} session=${locator.sessionId} generation=${locator.generation} ` +
    `engine=${locator.engineBuildId ?? "missing"}`;
  if (!report.includes(exact) || !report.includes("PRODUCTION PANE PROOF OK")) {
    throw new Error(`Workspace proof did not bind the exact daemon locator: ${exact}`);
  }
}

function flush(): void {
  mkdirSync(join(evidence, "matrix"), { recursive: true });
  mkdirSync(join(evidence, "manifests"), { recursive: true });
  writeFileSync(outPath, lines.join("\n") + "\n");
  writeFileSync(manifestPath, JSON.stringify({
    cell: "production-wiring-pane",
    ok,
    head: command(["git", "rev-parse", "HEAD"], repoRoot),
    home,
    port: boundPort ?? port,
    project,
    requestedTool,
    requestedModel: process.env.HIVE_B25_MODEL ?? null,
    agent,
    observed,
    sideEffectMessageId,
    paneReport,
    startedAt,
    writtenAt: new Date().toISOString(),
  }, null, 2) + "\n");
}

async function stopChild(child: Child | null, label: string): Promise<void> {
  if (child === null || child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await withTimeout(child.exited, 5_000, `${label} SIGTERM`);
  } catch {
    log(`${label} required SIGKILL during harness cleanup`);
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function main(): Promise<void> {
  if (!Number.isInteger(port) || port < 43140 || port > 65_535) {
    throw new Error(`HIVE_B25_PORT must be an integer in 43140...65535 (got ${port})`);
  }
  if (!["claude", "codex", "grok"].includes(requestedTool)) {
    throw new Error(`HIVE_B25_TOOL must be claude, codex, or grok (got ${requestedTool})`);
  }
  if (existsSync(home)) throw new Error(`refusing to reuse HIVE_B25_HOME: ${home}`);
  for (const path of [stagedHive, stagedSessiond, workspaceBinary]) {
    if (!existsSync(path)) throw new Error(`required staged artifact is missing: ${path}`);
  }

  mkdirSync(home, { recursive: false, mode: 0o700 });
  mkdirSync(project, { recursive: false, mode: 0o700 });
  const env = {
    ...process.env,
    HIVE_HOME: home,
    HIVE_INSTALL_ROOT: installRoot,
    HIVE_PROJECT_ROOT: project,
    HIVE_PORT: String(port),
    HIVE_DISABLE_UPDATES: "1",
  };
  process.env.HIVE_HOME = home;

  command(["git", "init", "-q", "-b", "main"], project);
  writeFileSync(join(project, "README.md"), "# B2.5 production-pane qualification\n");
  command(["git", "add", "README.md"], project);
  command([
    "git", "-c", "user.name=Hive B2.5", "-c", "user.email=b25@hive.local",
    "commit", "-q", "-m", "qualification project",
  ], project);
  command([stagedHive, "init", "--no-graphify"], project, env);
  command(["git", "add", "-A"], project);
  command([
    "git", "-c", "user.name=Hive B2.5", "-c", "user.email=b25@hive.local",
    "commit", "-q", "--allow-empty", "-m", "initialize Hive",
  ], project);
  log(`HEAD=${command(["git", "rev-parse", "HEAD"], repoRoot)}`);
  log(`home=${home} (${join(home, "runtime/sessiond/broker.sock").length}-byte broker path)`);
  log(`project=${project} (non-Hive throwaway git repository)`);
  log(`stagedHive=${realpathSync(stagedHive)}`);
  log(`stagedSessiond=${realpathSync(stagedSessiond)}`);
  log(`workspace=${realpathSync(workspaceBinary)}`);

  const daemonProcess = Bun.spawn([stagedHive, "daemon"], {
    cwd: project,
    env,
    stdin: "ignore",
    stdout: Bun.file(daemonStdoutPath),
    stderr: Bun.file(daemonStderrPath),
  });
  daemon = daemonProcess;
  const portFile = join(home, "daemon.port");
  const daemonDeadline = Date.now() + 45_000;
  while (Date.now() < daemonDeadline) {
    if (daemonProcess.exitCode !== null) {
      throw new Error(`daemon exited ${daemonProcess.exitCode}: ${readFileSync(daemonStderrPath, "utf8")}`);
    }
    if (existsSync(portFile)) {
      const candidate = Number(readFileSync(portFile, "utf8").trim());
      if (Number.isInteger(candidate) && candidate > 0) {
        boundPort = candidate;
        break;
      }
    }
    await Bun.sleep(100);
  }
  if (boundPort === null) throw new Error("daemon did not publish a listening port");
  log(`daemon ready pid=${daemonProcess.pid} port=${boundPort}`);

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${boundPort}/mcp`),
    { fetch: operatorFetch },
  );
  client = new Client({ name: "b25-production-pane-proof", version: "1" });
  await client.connect(transport);

  const instanceId = hiveInstanceSuffix(home);
  const workspaceProcess = Bun.spawn([
    workspaceBinary,
    "--project", project,
    "--port", String(boundPort),
    "--instance-id", instanceId,
    "--instance-home", home,
    "--hive", stagedHive,
    "--orchestrator-session", "hive-b25-orchestrator-not-started",
  ], {
    cwd: project,
    env: {
      ...env,
      HIVE_B25_PRODUCTION_PANE_AGENT: agent,
      HIVE_B25_PRODUCTION_PANE_RESULT: paneResultPath,
    },
    stdin: "ignore",
    stdout: Bun.file(workspaceStdoutPath),
    stderr: Bun.file(workspaceStderrPath),
  });
  workspace = workspaceProcess;
  log(`real Workspace launched pid=${workspaceProcess.pid} instanceId=${instanceId}`);
  await Bun.sleep(1_000);
  if (workspaceProcess.exitCode !== null) {
    throw new Error(`Workspace exited during settle: ${readFileSync(workspaceStderrPath, "utf8")}`);
  }

  const task = [
    "Production-pane qualification; do not edit any file.",
    `Immediately call hive_send with from=${JSON.stringify(agent)}, to=\"queen\",`,
    `priority=\"normal\", and body=${JSON.stringify(marker)}.`,
    "After the tool reports the message state, wait for further instructions.",
  ].join(" ");
  log(`hive_spawn requested tool=${requestedTool} name=${agent} readOnly=true`);
  const spawnArguments: Record<string, unknown> = {
    task,
    category: "simple_coding",
    name: agent,
    tool: requestedTool as Tool,
    readOnly: true,
    ...(process.env.HIVE_B25_MODEL === undefined
      ? {}
      : { model: process.env.HIVE_B25_MODEL }),
  };
  const [, report] = await Promise.all([
    withTimeout(
      client.callTool({ name: "hive_spawn", arguments: spawnArguments }),
      180_000,
      "hive_spawn",
    ).then((result) => {
      toolValue(result, "agent");
      spawned = true;
      return result;
    }),
    waitForPaneReport(),
  ]);
  paneReport = report.trim();
  for (const line of paneReport.split("\n")) log(`workspace: ${line}`);

  let messages: Array<{ id?: string; body?: string }> = [];
  const markerDeadline = Date.now() + 120_000;
  while (Date.now() < markerDeadline) {
    const result = await client.callTool({
      name: "hive_inbox",
      arguments: { agent: "queen" },
    });
    const batch = toolValue(result, "messages") as Array<{ id?: string; body?: string }>;
    messages = messages.concat(batch);
    const match = messages.find((message) => message.body === marker);
    if (match !== undefined) {
      sideEffectMessageId = match.id ?? null;
      break;
    }
    await Bun.sleep(250);
  }
  if (sideEffectMessageId === null) {
    throw new Error("real vendor session did not deliver the execution side effect");
  }
  log(`GREEN execution side effect received messageId=${sideEffectMessageId}`);
  if (messages.some((message) => message.body === `${marker}-mutated`)) {
    throw new Error("mutated execution marker unexpectedly matched");
  }
  log("MUTATION VERIFIED: exact marker check rejects a one-suffix mutation");

  const statusResult = await client.callTool({
    name: "hive_status",
    arguments: { detail: "full" },
  });
  const statuses = toolValue(statusResult, "agents") as AgentStatus[];
  observed = statuses.find((candidate) => candidate.name === agent) ?? null;
  if (observed === null) throw new Error(`hive_status has no ${agent} positive control`);
  validatePaneReport(report, observed);
  log(
    `GREEN exact production locator: ${observed.sessionLocator!.sessionId} ` +
      `generation=${observed.sessionLocator!.generation} hostKind=sessiond`,
  );
  const mutated: AgentStatus = {
    ...observed,
    sessionLocator: {
      ...observed.sessionLocator!,
      sessionId: `${observed.sessionLocator!.sessionId}-mutated`,
    },
  };
  let mutationRejected = false;
  try {
    validatePaneReport(report, mutated);
  } catch {
    mutationRejected = true;
  }
  if (!mutationRejected) throw new Error("session-id mutation did not break the pane proof");
  log("MUTATION VERIFIED: one-session-id mutation breaks the exact-locator row");
  log(`RESULT: production spawn + real Workspace HiveTerminalView GREEN (${observed.tool}/${observed.model})`);
  ok = true;
}

try {
  await main();
} catch (error) {
  log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  const activeClient = client as Client | null;
  if (activeClient !== null) {
    if (spawned) {
      try {
        await activeClient.callTool({
          name: "hive_kill",
          arguments: { name: agent, removeWorktree: true },
        });
        log(`cleanup: hive_kill ${agent} completed`);
      } catch (error) {
        log(`cleanup: hive_kill ${agent} failed: ${error}`);
        ok = false;
      }
    }
    await activeClient.close().catch(() => undefined);
  }
  await stopChild(workspace, "Workspace");
  await stopChild(daemon, "daemon");
  flush();
}

process.exit(ok ? 0 : 1);

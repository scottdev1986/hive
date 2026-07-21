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
 *      queen, recorded in the isolated daemon's durable message store.
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { operatorFetch } from "../src/cli/credential";
import { hiveInstanceSuffix } from "../src/daemon/tmux-sessions";
import { captureProcessTree, reapCapturedTree } from "../src/daemon/teardown";

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
const caffeinateStdoutPath = join(home, "caffeinate.stdout.log");
const caffeinateStderrPath = join(home, "caffeinate.stderr.log");
const startedAt = new Date().toISOString();
const marker = `B25_PRODUCTION_PANE_EXECUTED_${crypto.randomUUID()}`;
const lines: string[] = [];
let observed: AgentStatus | null = null;
let sideEffectMessageId: string | null = null;
let sideEffectMessageState: string | null = null;
let paneReport: string | null = null;
let daemon: Child | null = null;
let workspace: Child | null = null;
let displayLease: Child | null = null;
let client: Client | null = null;
let boundPort: number | null = null;
let instanceId: string | null = null;
let spawned = false;
let ok = false;
let displayPreflight: {
  initialActiveDisplays: number;
  activeDisplays: number;
  wokeDisplay: boolean;
  sessionLockState: SessionLockState;
} | null = null;
let capture: {
  journal: { path: string; bytes: number; sha256: string; sequencePrefixHex: string };
  screenshot: {
    path: string;
    bytes: number;
    sha256: string;
    windowNumber: number;
    captureRect: string;
    pixelWidth: number;
    pixelHeight: number;
  };
} | null = null;

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

function activeDisplayCount(): number {
  const output = command([
    "/usr/bin/swift", "-e",
    "import CoreGraphics; var count: UInt32 = 0; " +
      "let result = CGGetActiveDisplayList(0, nil, &count); " +
      "print(\"\\(result.rawValue) \\(count)\")",
  ], repoRoot);
  const match = output.match(/^0 (\d+)$/);
  if (match === null) throw new Error(`active-display probe failed: ${output}`);
  return Number(match[1]);
}

function requireActiveDisplay(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`real Workspace qualification requires an active display (got ${count})`);
  }
}

// macOS OMITS CGSSessionScreenIsLocked from the session dictionary when the
// screen is UNLOCKED; it appears (as 1) only while locked. Absence therefore
// means "unlocked" ONLY on a dictionary we can actually read — we use the
// presence of kCGSSessionOnConsoleKey to prove readability, so an unreadable
// dictionary stays a distinct, still-failing state rather than reading unlocked.
type SessionLockState = "locked" | "unlocked" | "unreadable";

function sessionLockState(): SessionLockState {
  const output = command([
    "/usr/bin/swift", "-e",
    "import CoreGraphics; import Foundation; " +
      "let value = CGSessionCopyCurrentDictionary() as? [String: Any]; " +
      "if value?[\"kCGSSessionOnConsoleKey\"] == nil { print(\"unreadable\") } " +
      "else if ((value?[\"CGSSessionScreenIsLocked\"] as? NSNumber)?.intValue ?? 0) == 1 { print(\"locked\") } " +
      "else { print(\"unlocked\") }",
  ], repoRoot);
  if (output !== "locked" && output !== "unlocked" && output !== "unreadable") {
    throw new Error(`screen-lock probe failed: ${output}`);
  }
  return output;
}

function requireUnlockedSession(state: SessionLockState): void {
  if (state === "locked") {
    throw new Error(
      "real Workspace pixel qualification requires an unlocked macOS session",
    );
  }
  if (state === "unreadable") {
    throw new Error(
      "real Workspace pixel qualification could not read the macOS session dictionary",
    );
  }
}

async function prepareActiveDisplay(): Promise<void> {
  const initialActiveDisplays = activeDisplayCount();
  const lockState = sessionLockState();
  displayPreflight = {
    initialActiveDisplays,
    activeDisplays: initialActiveDisplays,
    wokeDisplay: false,
    sessionLockState: lockState,
  };
  // Branch control over the ASSERTION only: both non-passing states must still
  // throw, so the absent-key fix cannot have collapsed them into "unlocked".
  // This says nothing about this session's state; that is the measured line
  // logged below and gated by requireUnlockedSession(lockState).
  for (const rejected of ["locked", "unreadable"] as const) {
    let threw = false;
    try {
      requireUnlockedSession(rejected);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`${rejected}-session state did not break the preflight`);
  }
  log("ASSERTION CONTROL (literals, not this session): locked and unreadable both break the preflight");
  log(`MEASURED session lock state: ${lockState}`);
  requireUnlockedSession(lockState);
  let activeDisplays = initialActiveDisplays;
  if (activeDisplays === 0) {
    command(["/usr/bin/caffeinate", "-u", "-t", "1"], repoRoot);
    const deadline = Date.now() + 10_000;
    while (activeDisplays === 0 && Date.now() < deadline) {
      await Bun.sleep(250);
      activeDisplays = activeDisplayCount();
    }
  }
  requireActiveDisplay(activeDisplays);
  let mutationRejected = false;
  try {
    requireActiveDisplay(0);
  } catch {
    mutationRejected = true;
  }
  if (!mutationRejected) throw new Error("zero-display mutation did not break the preflight");
  displayPreflight = {
    initialActiveDisplays,
    activeDisplays,
    wokeDisplay: initialActiveDisplays === 0,
    sessionLockState: lockState,
  };
  log(
    `GREEN active-display preflight: initial=${initialActiveDisplays} ` +
      `settled=${activeDisplays} woke=${initialActiveDisplays === 0}`,
  );
  log("MUTATION VERIFIED: zero active displays breaks the real-Workspace preflight");
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

function findSideEffectMessage(body: string): { id: string; state: string } | null {
  const database = new Database(join(home, "hive.db"), { readonly: true });
  try {
    return database.query(
      `SELECT id, state FROM messages
       WHERE "from" = ?1 AND "to" IN ('queen', 'orchestrator') AND body = ?2
       LIMIT 1`,
    ).get(agent, body) as { id: string; state: string } | null;
  } finally {
    database.close();
  }
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
  const exact = `agent=${record.name} instance=${locator.instanceId} session=${locator.sessionId} ` +
    `generation=${locator.generation} ` +
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
    sideEffectMessageState,
    paneReport,
    capture,
    displayPreflight,
    startedAt,
    writtenAt: new Date().toISOString(),
  }, null, 2) + "\n");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function imageDimensions(path: string): { width: number; height: number } {
  const output = command(
    ["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
    project,
  );
  const width = Number(output.match(/pixelWidth: (\d+)/)?.[1]);
  const height = Number(output.match(/pixelHeight: (\d+)/)?.[1]);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(`could not read PNG dimensions: ${output}`);
  }
  return { width, height };
}

function locatorFromPaneReport(report: string): SessionLocator {
  const match = report.match(
    /agent=([^ ]+) instance=([^ ]+) session=([^ ]+) generation=(\d+) engine=([^ ]+)/,
  );
  if (match === null || match[1] !== agent) {
    throw new Error("Workspace pane report has no exact agent locator");
  }
  return {
    instanceId: match[2]!,
    sessionId: match[3]!,
    generation: Number(match[4]),
    hostKind: "sessiond",
    engineBuildId: match[5]!,
  };
}

async function captureVendorArtifacts(
  locator: SessionLocator,
  report: string,
  phase: "pane-ready" | "post-side-effect",
): Promise<void> {
  const journalSource = join(
    home,
    "runtime/sessiond/hosts",
    locator.sessionId,
    "journal.bin",
  );
  const journal = readFileSync(journalSource);
  if (journal.byteLength <= 16) {
    throw new Error(`sessiond journal has no PTY payload (${journal.byteLength} bytes)`);
  }
  const transcriptDirectory = join(evidence, "transcripts");
  const screenshotDirectory = join(evidence, "screenshots");
  mkdirSync(transcriptDirectory, { recursive: true });
  mkdirSync(screenshotDirectory, { recursive: true });
  const journalPath = join(
    transcriptDirectory,
    `${requestedTool}-${locator.sessionId}.journal.bin`,
  );
  writeFileSync(journalPath, journal);
  const journalDigest = sha256(journal);
  const preserved = readFileSync(journalPath);
  if (sha256(preserved) !== journalDigest || !preserved.equals(journal)) {
    throw new Error("preserved sessiond journal is not byte-exact");
  }

  const windowMatch = report.match(/ window=(\d+)/);
  if (windowMatch === null) throw new Error("Workspace pane report has no window number");
  const windowNumber = Number(windowMatch[1]);
  const captureMatch = report.match(
    / captureRect=(-?\d+),(-?\d+),(\d+),(\d+) screenSize=(\d+),(\d+)/,
  );
  if (captureMatch === null) throw new Error("Workspace pane report has no capture rectangle");
  const [x, y, width, height, screenWidth, screenHeight] = captureMatch.slice(1).map(Number);
  if (x! < 0 || y! < 0 || width! < 1 || height! < 1 ||
      x! + width! > screenWidth! || y! + height! > screenHeight!) {
    throw new Error(`Workspace capture rectangle is outside the main screen: ${captureMatch[0]}`);
  }
  const screenshotPath = join(
    screenshotDirectory,
    `${requestedTool}-${locator.sessionId}-workspace.png`,
  );
  const fullScreenPath = join(home, `production-pane-screen-${phase}.png`);
  command(["/usr/sbin/screencapture", "-x", "-m", fullScreenPath], project);
  const fullScreen = imageDimensions(fullScreenPath);
  const xScale = fullScreen.width / screenWidth!;
  const yScale = fullScreen.height / screenHeight!;
  const pixelX = Math.round(x! * xScale);
  const pixelY = Math.round(y! * yScale);
  const pixelWidth = Math.round(width! * xScale);
  const pixelHeight = Math.round(height! * yScale);
  command([
    "/usr/bin/sips",
    "--cropToHeightWidth", String(pixelHeight), String(pixelWidth),
    "--cropOffset", String(pixelY), String(pixelX),
    fullScreenPath,
    "--out", screenshotPath,
  ], project);
  unlinkSync(fullScreenPath);
  const cropped = imageDimensions(screenshotPath);
  if (cropped.width !== pixelWidth || cropped.height !== pixelHeight) {
    throw new Error(
      `Workspace crop has ${cropped.width}x${cropped.height}, ` +
        `expected ${pixelWidth}x${pixelHeight}`,
    );
  }
  const screenshot = readFileSync(screenshotPath);
  const preservedScreenshot = readFileSync(screenshotPath);
  if (!preservedScreenshot.equals(screenshot)) {
    throw new Error("preserved Workspace screenshot is not byte-exact");
  }
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (screenshot.byteLength <= pngSignature.byteLength ||
      !screenshot.subarray(0, pngSignature.byteLength).equals(pngSignature)) {
    throw new Error("Workspace screenshot is not a non-empty PNG");
  }

  const mutated = Buffer.from(journal);
  mutated[16] = mutated[16]! ^ 0x01;
  if (sha256(mutated) === journalDigest) {
    throw new Error("one-byte journal mutation did not change the transcript digest");
  }
  log("MUTATION VERIFIED: one-byte PTY transcript mutation changes its SHA-256");
  const mutatedScreenshot = Buffer.from(screenshot);
  mutatedScreenshot[0] = mutatedScreenshot[0]! ^ 0x01;
  if (!mutatedScreenshot.subarray(0, pngSignature.byteLength).equals(pngSignature)) {
    log("MUTATION VERIFIED: one-byte PNG signature mutation breaks screenshot validation");
  } else {
    throw new Error("one-byte PNG signature mutation did not break validation");
  }
  capture = {
    journal: {
      path: journalPath,
      bytes: journal.byteLength,
      sha256: journalDigest,
      sequencePrefixHex: journal.subarray(0, 16).toString("hex"),
    },
    screenshot: {
      path: screenshotPath,
      bytes: screenshot.byteLength,
      sha256: sha256(screenshot),
      windowNumber,
      captureRect: `${x},${y},${width},${height}`,
      pixelWidth,
      pixelHeight,
    },
  };
  log(
    `CAPTURED before hive_kill phase=${phase}: requestedVendor=${requestedTool}/` +
      `${process.env.HIVE_B25_MODEL ?? "policy-default"} ` +
      `session=${locator.sessionId} journalBytes=${journal.byteLength} window=${windowNumber}`,
  );
}

async function cleanupRootSession(): Promise<void> {
  if (instanceId === null) return;
  const socket = `hive-${instanceId}`;
  const session = `hive-orchestrator-${instanceId}`;
  const panes = Bun.spawnSync([
    "tmux", "-L", socket, "list-panes", "-t", `=${session}:`, "-F", "#{pane_pid}",
  ], { stdout: "pipe", stderr: "pipe" });
  if (panes.exitCode !== 0) {
    log(`cleanup: root session ${session} already absent`);
    return;
  }
  const roots = panes.stdout.toString().trim().split("\n")
    .map(Number).filter((pid) => Number.isInteger(pid) && pid > 1);
  const tree = await captureProcessTree(roots);
  const killed = Bun.spawnSync([
    "tmux", "-L", socket, "kill-session", "-t", `=${session}`,
  ], { stdout: "pipe", stderr: "pipe" });
  if (killed.exitCode !== 0) {
    throw new Error(`could not kill exact root session ${session}: ${killed.stderr.toString().trim()}`);
  }
  const reaped = await reapCapturedTree(tree);
  const stillExists = Bun.spawnSync([
    "tmux", "-L", socket, "has-session", "-t", `=${session}`,
  ]).exitCode === 0;
  if (reaped.survivors.length > 0 || stillExists) {
    throw new Error(
      `root cleanup could not verify absence: session=${stillExists} ` +
        `pids=${reaped.survivors.map((entry) => entry.pid).join(",")}`,
    );
  }
  log(`cleanup: exact root session ${session} and ${reaped.killed.length} captured process(es) absent`);
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

  await prepareActiveDisplay();
  const keepAwake = Bun.spawn(["/usr/bin/caffeinate", "-d"], {
    cwd: project,
    env,
    stdin: "ignore",
    stdout: Bun.file(caffeinateStdoutPath),
    stderr: Bun.file(caffeinateStderrPath),
  });
  displayLease = keepAwake;
  await Bun.sleep(100);
  if (keepAwake.exitCode !== null) {
    throw new Error(`display keep-awake exited ${keepAwake.exitCode}`);
  }
  log(`display keep-awake active pid=${keepAwake.pid}`);

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
  log(command([stagedHive, "autonomy", "dangerous"], project, env));
  const autonomyReadback = command([stagedHive, "autonomy"], project, env);
  if (!autonomyReadback.startsWith("dangerous — ")) {
    throw new Error(`autonomy readback is not dangerous: ${autonomyReadback}`);
  }
  log(`GREEN autonomy readback: ${autonomyReadback}`);

  instanceId = hiveInstanceSuffix(home);
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
  spawned = true;
  const [spawnResult, report] = await Promise.all([
    withTimeout(
      client.callTool({ name: "hive_spawn", arguments: spawnArguments }),
      180_000,
      "hive_spawn",
    ),
    waitForPaneReport().then(async (value) => {
      await captureVendorArtifacts(locatorFromPaneReport(value), value, "pane-ready");
      return value;
    }),
  ]);
  observed = toolValue(spawnResult, "agent") as AgentStatus;
  paneReport = report.trim();
  for (const line of paneReport.split("\n")) log(`workspace: ${line}`);

  const markerDeadline = Date.now() + 120_000;
  while (Date.now() < markerDeadline) {
    const match = findSideEffectMessage(marker);
    if (match !== null) {
      sideEffectMessageId = match.id;
      sideEffectMessageState = match.state;
      break;
    }
    await Bun.sleep(250);
  }
  if (sideEffectMessageId === null) {
    throw new Error("real vendor session did not deliver the execution side effect");
  }
  log(
    `GREEN execution side effect persisted messageId=${sideEffectMessageId} ` +
      `state=${sideEffectMessageState}`,
  );
  if (findSideEffectMessage(`${marker}-mutated`) !== null) {
    throw new Error("mutated execution marker unexpectedly matched");
  }
  log("MUTATION VERIFIED: exact marker check rejects a one-suffix mutation");

  const statusResult = await client.callTool({
    name: "hive_status",
    arguments: { detail: "full" },
  });
  const statuses = toolValue(statusResult, "agents") as AgentStatus[];
  const current = statuses.find((candidate) => candidate.name === agent) ?? null;
  if (current === null) throw new Error(`hive_status has no ${agent} positive control`);
  observed = current;
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
  await captureVendorArtifacts(
    locatorFromPaneReport(report), report, "post-side-effect");
  if (capture === null) throw new Error("pre-kill vendor capture is missing");
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
  await stopChild(displayLease, "display keep-awake");
  try {
    await cleanupRootSession();
  } catch (error) {
    log(`cleanup: root session failed: ${error}`);
    ok = false;
  }
  await stopChild(daemon, "daemon");
  flush();
}

process.exit(ok ? 0 : 1);

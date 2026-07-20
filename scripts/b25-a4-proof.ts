#!/usr/bin/env bun
/** B2.5.2 live A4 qualification over the existing real sessiond/Workspace stack. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

interface ProofLocator {
  schemaVersion: number;
  instanceId: string;
  subject: { kind: string; agentId?: string };
  generation: number;
  sessionId: string;
  hostKind: string;
  engineBuildId?: string;
}

interface ProofProcess {
  pid: number;
  command: string;
}

interface B22Proof {
  hiveCli: string;
  port: number;
  agent: string;
  workspaceProject: string;
  hostPid: number;
  processTree: ProofProcess[];
  locator: ProofLocator;
}

interface FinalRecord {
  state?: string;
  survivors?: unknown[];
  errors?: unknown[];
}

type Stack = {
  home: string;
  project: string;
  trigger: string;
  result: string;
  stdout: string;
  stderr: string;
  child: Bun.Subprocess<"ignore", ReturnType<typeof Bun.file>, ReturnType<typeof Bun.file>>;
};

const repoRoot = resolve(import.meta.dir, "..");
const workspaceRoot = join(repoRoot, "workspace");
const evidence = process.env.HIVE_B25_EVIDENCE
  ?? join(repoRoot, "raw/qualification/hive-b25-production-pane");
const basePort = Number(process.env.HIVE_B25_A4_PORT ?? "43142");
const suffix = Math.random().toString(16).slice(2, 6);
const head = command(["git", "rev-parse", "HEAD"], repoRoot);
const startedAt = new Date().toISOString();

if (!Number.isInteger(basePort) || basePort < 43_140 || basePort + 2 > 65_535) {
  throw new Error(`HIVE_B25_A4_PORT must leave three ports in 43140...65535`);
}
for (const path of [
  join(repoRoot, "native/sessiond/zig-out/bin/hive-sessiond"),
  join(workspaceRoot, ".build/debug/HiveWorkspace"),
]) {
  if (!existsSync(path)) throw new Error(`required HEAD-built artifact is missing: ${path}`);
}

mkdirSync(join(evidence, "matrix"), { recursive: true });
mkdirSync(join(evidence, "manifests"), { recursive: true });

function command(argv: string[], cwd: string): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function runAllowFailure(argv: string[], cwd: string): {
  exitCode: number;
  output: string;
} {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stamp(lines: string[], message: string): void {
  lines.push(`${new Date().toISOString()} ${message}`);
}

function makePlainProject(tag: string): string {
  const project = `/tmp/hb25-${tag}-${suffix}`;
  if (existsSync(project)) throw new Error(`refusing to reuse project ${project}`);
  mkdirSync(project, { mode: 0o700 });
  writeFileSync(join(project, "README.md"), `# B2.5 ${tag} plain repository\n`);
  command(["git", "init", "-q", "-b", "main"], project);
  command(["git", "add", "README.md"], project);
  command([
    "git", "-c", "user.name=Hive B2.5", "-c", "user.email=b25@hive.local",
    "commit", "-q", "-m", "plain qualification repository",
  ], project);
  assertPlainProject(project);
  return project;
}

function assertPlainProject(project: string): void {
  for (const forbidden of ["package.json", "bun.lock", "bun.lockb", ".hive"]) {
    if (existsSync(join(project, forbidden))) {
      throw new Error(`plain project unexpectedly contains ${forbidden}`);
    }
  }
  command(["git", "rev-parse", "--show-toplevel"], project);
}

function verifyPlainProjectMutation(project: string): void {
  const mutation = join(project, "package.json");
  writeFileSync(mutation, "{}\n");
  let rejected = false;
  try {
    assertPlainProject(project);
  } catch {
    rejected = true;
  } finally {
    unlinkSync(mutation);
  }
  if (!rejected) throw new Error("package.json mutation did not break the plain-project check");
  assertPlainProject(project);
}

function processStates(): Map<number, string> {
  const output = command(["ps", "-ax", "-o", "pid=,stat="], repoRoot);
  const states = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)/);
    if (match !== null) states.set(Number(match[1]), match[2]!);
  }
  if (!states.has(process.pid)) throw new Error("process-state positive control cannot see harness pid");
  return states;
}

function liveProcesses(tree: ProofProcess[]): ProofProcess[] {
  const states = processStates();
  return tree.filter((entry) => {
    const state = states.get(entry.pid);
    return state !== undefined && !state.startsWith("Z");
  });
}

function requireWholeTreeAlive(proof: B22Proof): void {
  if (proof.processTree.length < 2) throw new Error("captured tree has no provider process");
  const live = liveProcesses(proof.processTree);
  if (live.length !== proof.processTree.length) {
    throw new Error(`pre-action tree is not wholly alive: ${JSON.stringify({ live, tree: proof.processTree })}`);
  }
}

async function waitTreeAbsent(tree: ProofProcess[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  let live = liveProcesses(tree);
  while (live.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    live = liveProcesses(tree);
  }
  if (live.length > 0) throw new Error(`captured processes survived: ${JSON.stringify(live)}`);
}

async function waitForFile(path: string, label: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(100);
  if (!existsSync(path)) throw new Error(`${label} did not appear: ${path}`);
}

async function waitForText(path: string, text: string, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(text)) return;
    await Bun.sleep(100);
  }
  throw new Error(`${label} never contained ${JSON.stringify(text)}`);
}

async function waitForExit(stack: Stack, timeoutMs = 60_000): Promise<number> {
  const timeout = Bun.sleep(timeoutMs).then(() => null);
  const exit = await Promise.race([stack.child.exited, timeout]);
  if (exit === null) throw new Error(`stack ${stack.home} did not exit in ${timeoutMs}ms`);
  return exit;
}

async function stopStack(stack: Stack): Promise<number> {
  if (stack.child.exitCode === null) stack.child.kill("SIGTERM");
  return waitForExit(stack);
}

function startStack(tag: string, port: number, project: string, action?: "close"): Stack {
  const home = `/tmp/hb25-${tag[0]}${suffix}`;
  if (existsSync(home)) throw new Error(`refusing to reuse home ${home}`);
  mkdirSync(home, { mode: 0o700 });
  const trigger = join(home, "a4.trigger");
  const result = join(home, "a4-workspace-result.txt");
  const stdout = join(home, "driver.stdout.log");
  const stderr = join(home, "driver.stderr.log");
  const env: Record<string, string | undefined> = {
    ...process.env,
    HIVE_B22_HOME: home,
    HIVE_B22_PORT: String(port),
    HIVE_B22_WORKSPACE_PROJECT: project,
    HIVE_B25_A4_AGENT: action === undefined ? undefined : "aria",
    HIVE_B25_A4_ACTION: action,
    HIVE_B25_A4_TRIGGER: action === undefined ? undefined : trigger,
    HIVE_B25_A4_RESULT: action === undefined ? undefined : result,
    HIVE_B22_NO_APP: action === undefined ? "1" : undefined,
  };
  const child = Bun.spawn([process.execPath, join(repoRoot, "scripts/b22-live-attach-proof.ts")], {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: Bun.file(stdout),
    stderr: Bun.file(stderr),
  });
  return { home, project, trigger, result, stdout, stderr, child };
}

async function loadProof(stack: Stack): Promise<B22Proof> {
  const path = join(stack.home, "b22-proof.json");
  const deadline = Date.now() + 45_000;
  while (!existsSync(path) && Date.now() < deadline) {
    if (stack.child.exitCode !== null) {
      throw new Error(`stack exited ${stack.child.exitCode}: ${readFileSync(stack.stderr, "utf8")}`);
    }
    await Bun.sleep(100);
  }
  await waitForFile(path, "b22 proof descriptor");
  return JSON.parse(readFileSync(path, "utf8")) as B22Proof;
}

async function runSwiftTest(filter: string, outputPath: string): Promise<string> {
  const child = Bun.spawn(["swift", "test", "--filter", filter], {
    cwd: workspaceRoot,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}${stderr}`;
  writeFileSync(outputPath, output);
  if (exit !== 0) throw new Error(`${filter} failed (${exit}); see ${outputPath}`);
  return output;
}

function journalEvidence(stack: Stack, proof: B22Proof): {
  path: string;
  bytes: number;
  sha256: string;
} {
  const path = join(
    stack.home, "runtime/sessiond/hosts", proof.locator.sessionId, "journal.bin",
  );
  const bytes = readFileSync(path);
  if (bytes.byteLength <= 16) throw new Error("live journal has no PTY payload");
  return { path, bytes: bytes.byteLength, sha256: digest(bytes) };
}

function finalRecord(stack: Stack, proof: B22Proof): FinalRecord {
  const path = join(
    stack.home, "runtime/sessiond/hosts", proof.locator.sessionId, "final.json",
  );
  if (!existsSync(path)) throw new Error(`final session record is missing: ${path}`);
  const record = JSON.parse(readFileSync(path, "utf8")) as FinalRecord;
  if (record.state !== "terminated" || record.survivors?.length !== 0) {
    throw new Error(`session termination is not exact: ${JSON.stringify(record)}`);
  }
  return record;
}

function mutatedLocator(proof: B22Proof): ProofLocator {
  return { ...proof.locator, generation: proof.locator.generation + 1 };
}

function wrongLocatorKill(proof: B22Proof): { exitCode: number; output: string } {
  const result = runAllowFailure([
    proof.hiveCli, "kill", proof.agent,
    "--port", String(proof.port),
    "--session-locator", JSON.stringify(mutatedLocator(proof)),
  ], proof.workspaceProject);
  if (result.exitCode === 0 || !result.output.toLowerCase().includes("session")) {
    throw new Error(`wrong-locator kill did not fail closed: ${JSON.stringify(result)}`);
  }
  requireWholeTreeAlive(proof);
  return result;
}

function writeMatrix(name: string, lines: string[]): string {
  const path = join(evidence, "matrix", name);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function writeManifest(name: string, value: unknown): string {
  const path = join(evidence, "manifests", name);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  return path;
}

async function reconnectReplay(): Promise<void> {
  const lines: string[] = [];
  const project = makePlainProject("replay");
  const stack = startStack("replay", basePort, project);
  try {
    const proof = await loadProof(stack);
    requireWholeTreeAlive(proof);
    stamp(lines, `HEAD=${head}`);
    stamp(lines, `home=${stack.home} project=${project} port=${proof.port}`);
    stamp(lines, `session=${proof.locator.sessionId} generation=${proof.locator.generation}`);
    stamp(lines, `pre-action process tree=${proof.processTree.map((entry) => entry.pid).join(",")}`);

    const testPath = join(evidence, "matrix", "a4-reconnect-xctest.txt");
    const child = Bun.spawn(["swift", "test", "--filter", "LiveHostAttachTests.testLiveAttachReplayReconnectAndFence"], {
      cwd: workspaceRoot,
      env: { ...process.env, HIVE_B22_PROOF_HOME: stack.home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    writeFileSync(testPath, `${stdout}${stderr}`);
    if (exit !== 0) throw new Error(`live reconnect XCTest failed (${exit})`);
    stamp(lines, "GREEN live sessiond attach -> replay -> contiguous live output -> same-locator reconnect");

    const geometry = JSON.stringify({
      columns: 80, rows: 24, widthPx: 800, heightPx: 480,
      cellWidthPx: 10, cellHeightPx: 20,
    });
    const wrong = runAllowFailure([
      proof.hiveCli, "workspace-attach", proof.agent,
      "--port", String(proof.port),
      "--session-locator", JSON.stringify(mutatedLocator(proof)),
      "--viewer-id", "b25-mutated-replay",
      "--geometry", geometry,
    ], project);
    if (wrong.exitCode === 0 || !wrong.output.includes("session-locator-mismatch")) {
      throw new Error(`wrong-generation reconnect was not fenced: ${JSON.stringify(wrong)}`);
    }
    requireWholeTreeAlive(proof);
    stamp(lines, `MUTATION VERIFIED wrong-generation attach refused: ${wrong.output}`);
    const journal = journalEvidence(stack, proof);
    stamp(lines, `journal=${journal.path} bytes=${journal.bytes} sha256=${journal.sha256}`);
    stamp(lines, `xctest=${testPath}`);
    const exitCode = await stopStack(stack);
    if (exitCode !== 0) throw new Error(`reconnect stack cleanup exited ${exitCode}`);
    stamp(lines, "RESULT: A4 restart/reconnect/replay GREEN");
    writeMatrix("a4-reconnect-replay.txt", lines);
    writeManifest("a4-reconnect-replay.json", {
      cell: "a4-reconnect-replay", ok: true, head, startedAt,
      home: stack.home, project, port: proof.port, locator: proof.locator,
      processTree: proof.processTree, journal, xctest: testPath,
      mutation: { generation: proof.locator.generation + 1, exitCode: wrong.exitCode, output: wrong.output },
    });
  } catch (error) {
    await stopStack(stack).catch(() => undefined);
    stamp(lines, `FAIL: ${error instanceof Error ? error.message : String(error)}`);
    writeMatrix(`diagnostic-a4-reconnect-${suffix}.txt`, lines);
    throw error;
  }
}

async function exactClose(): Promise<{ project: string; proof: B22Proof; stack: Stack }> {
  const lines: string[] = [];
  const project = makePlainProject("close");
  const stack = startStack("close", basePort + 1, project, "close");
  try {
    const proof = await loadProof(stack);
    await waitForText(stack.result, "A4 CLOSE READY", "Workspace close readiness");
    requireWholeTreeAlive(proof);
    assertPlainProject(project);
    stamp(lines, `HEAD=${head}`);
    stamp(lines, `home=${stack.home} project=${project} port=${proof.port}`);
    stamp(lines, `session=${proof.locator.sessionId} generation=${proof.locator.generation}`);
    stamp(lines, `captured-before-close=${JSON.stringify(proof.processTree)}`);
    const wrong = wrongLocatorKill(proof);
    stamp(lines, `MUTATION VERIFIED wrong-locator pane target survived: ${wrong.output}`);
    writeFileSync(stack.trigger, "close\n");
    const exitCode = await waitForExit(stack);
    if (exitCode !== 0) throw new Error(`close stack exited ${exitCode}`);
    await waitTreeAbsent(proof.processTree);
    const final = finalRecord(stack, proof);
    const workspaceResult = readFileSync(stack.result, "utf8").trim();
    if (!workspaceResult.includes("A4 CLOSE PROOF OK")) {
      throw new Error(`Workspace did not confirm its close: ${workspaceResult}`);
    }
    const driver = readFileSync(join(stack.home, "b22-proof-transcript.log"), "utf8");
    if (!driver.includes("A4 CLOSE VERIFIED")) {
      throw new Error("driver did not observe daemon/broker survival after exact close");
    }
    stamp(lines, workspaceResult.replaceAll("\n", " | "));
    stamp(lines, "GREEN captured target process tree absent after real pane close");
    stamp(lines, "GREEN session final state=terminated survivors=[]");
    stamp(lines, "GREEN unrelated daemon and broker survived until post-close readback");
    stamp(lines, "RESULT: A4 exact per-pane close GREEN");
    writeMatrix("a4-exact-close.txt", lines);
    writeManifest("a4-exact-close.json", {
      cell: "a4-exact-close", ok: true, head, startedAt,
      home: stack.home, project, port: proof.port, locator: proof.locator,
      capturedProcessTree: proof.processTree, final,
      workspaceResult, mutation: { generation: proof.locator.generation + 1, ...wrong },
      unrelatedControlPlaneSurvivedClose: true,
    });
    return { project, proof, stack };
  } catch (error) {
    await stopStack(stack).catch(() => undefined);
    stamp(lines, `FAIL: ${error instanceof Error ? error.message : String(error)}`);
    writeMatrix(`diagnostic-a4-close-${suffix}.txt`, lines);
    throw error;
  }
}

async function concurrentQuit(unitPath: string): Promise<{ project: string; proof: B22Proof; stack: Stack }> {
  const lines: string[] = [];
  const project = makePlainProject("quit");
  const stack = startStack("quit", basePort + 2, project);
  try {
    const proof = await loadProof(stack);
    requireWholeTreeAlive(proof);
    assertPlainProject(project);
    stamp(lines, `HEAD=${head}`);
    stamp(lines, `home=${stack.home} project=${project} port=${proof.port}`);
    stamp(lines, `session=${proof.locator.sessionId} generation=${proof.locator.generation}`);
    stamp(lines, `captured-before-quit=${JSON.stringify(proof.processTree)}`);
    const stop = Bun.spawn([proof.hiveCli, "stop"], {
      cwd: project,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stopStdout, stopStderr, stopExit] = await Promise.all([
      new Response(stop.stdout).text(),
      new Response(stop.stderr).text(),
      stop.exited,
    ]);
    const stopOutput = `${stopStdout}${stopStderr}`.trim();
    if (stopExit !== 0 || !stopOutput.includes("Stopped the Hive daemon")) {
      throw new Error(`live hive stop failed (${stopExit}): ${stopOutput}`);
    }
    const exitCode = await waitForExit(stack);
    if (exitCode !== 0) throw new Error(`quit stack exited ${exitCode}`);
    await waitTreeAbsent(proof.processTree);
    const final = finalRecord(stack, proof);
    const driver = readFileSync(join(stack.home, "b22-proof-transcript.log"), "utf8");
    if (!driver.includes("shutting down (SIGTERM)") || !driver.includes("daemon stopped; session torn down")) {
      throw new Error("Workspace quit did not drive verified hive stop");
    }
    stamp(lines, `GREEN live hive stop output: ${stopOutput}`);
    stamp(lines, "GREEN live provider process tree absent after verified hive stop");
    stamp(lines, "GREEN session final state=terminated survivors=[]");
    stamp(lines, `COMPOSED Workspace quit request/wait + failure refusal: ${unitPath}`);
    stamp(lines, "COMPOSED real production Workspace/vendor lifecycle: diagnostic-p14-locked-screen-crop.txt");
    stamp(lines, "MUTATION VERIFIED termination-failure refusal cancels quit and surfaces the survivor");
    stamp(lines, "RESULT: A4 concurrent quit + provider-tree teardown GREEN");
    writeMatrix("a4-quit.txt", lines);
    writeManifest("a4-quit.json", {
      cell: "a4-quit", ok: true, head, startedAt,
      home: stack.home, project, port: proof.port, locator: proof.locator,
      capturedProcessTree: proof.processTree, final, stopOutput,
      composition: {
        productionWorkspaceVendor: "matrix/diagnostic-p14-locked-screen-crop.txt",
        lifecycleRequestAndRefusal: unitPath,
        liveSentinelStop: "this manifest",
      },
      mutation: {
        xctest: unitPath,
        control: "testTerminationFailureCancelsQuitAndSurfacesReason",
      },
    });
    return { project, proof, stack };
  } catch (error) {
    await stopStack(stack).catch(() => undefined);
    stamp(lines, `FAIL: ${error instanceof Error ? error.message : String(error)}`);
    writeMatrix(`diagnostic-a4-quit-${suffix}.txt`, lines);
    throw error;
  }
}

const unitPath = join(evidence, "matrix", "a4-lifecycle-xctest.txt");
await runSwiftTest("AppDelegateLifecycleTests", unitPath);
await reconnectReplay();
const close = await exactClose();
const quit = await concurrentQuit(unitPath);

const nonHiveLines: string[] = [];
stamp(nonHiveLines, `HEAD=${head}`);
for (const row of [close]) {
  assertPlainProject(row.project);
  verifyPlainProjectMutation(row.project);
  stamp(nonHiveLines, `GREEN plain git project=${row.project}`);
  stamp(nonHiveLines, `Workspace session=${row.proof.locator.sessionId} hostKind=${row.proof.locator.hostKind}`);
  stamp(nonHiveLines, "no project package.json, Bun lockfile, .hive directory, or Hive source layout");
}
stamp(nonHiveLines, "MUTATION VERIFIED: planted package.json breaks the plain-project check; removal restores it");
stamp(nonHiveLines, "RESULT: A4 non-Hive project GREEN");
writeMatrix("a4-non-hive-project.txt", nonHiveLines);
writeManifest("a4-non-hive-project.json", {
  cell: "a4-non-hive-project", ok: true, head, startedAt,
  projects: [close.project],
  sessions: [close.proof.locator],
  forbiddenProjectEntries: ["package.json", "bun.lock", "bun.lockb", ".hive"],
});

console.log("B2.5 A4 LIVE PROOF OK");
process.exit(0);

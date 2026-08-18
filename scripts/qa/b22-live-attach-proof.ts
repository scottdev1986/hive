#!/usr/bin/env bun
/** B2.2 live watchable proof harness: black-box, manually-launched simple command (not an agent spawn). Stands up the real stack end to end: 1. real Hive daemon in this process 2. one manually-created sessiond session (B2.2 ticker, or login shell with HIVE_B22_REAL_SHELL=1) via HiveTerminalHostAdapter.create; the running host keeps its visibility lease open 3. real Workspace debug app; pane carries the sessiond locator so HiveTerminalView attaches and renders live output Stays in the foreground; Ctrl-C tears down (session → daemon). Steps append to a transcript for the evidence bundle. There is no broker process to stand up: the host binds its own sockets and the daemon dials them directly, which `hive-sessiond` states by having no `serve` role at all. */
import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { TERMINAL_SHELL } from "../../src/daemon/session-host/shell-session";

const repoRoot = resolve(import.meta.dir, "../..");
const realShell = process.env.HIVE_B22_REAL_SHELL === "1";
const launchApp = process.env.HIVE_B22_NO_APP !== "1";
const shellExecutable = TERMINAL_SHELL;
try {
  accessSync(shellExecutable, constants.X_OK);
} catch {
  console.error(
    `b22-live-attach-proof: required terminal shell is not executable: ${shellExecutable}`,
  );
  process.exit(2);
}

const releaseSessiond = join(
  repoRoot,
  ".cache/sessiond-releasefast/bin/hive-sessiond",
);
const selectedSessiond = resolve(
  process.env.HIVE_SESSIOND_BIN ?? releaseSessiond,
);
const sessiondBuild = Bun.spawnSync(["make", releaseSessiond], {
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (sessiondBuild.exitCode !== 0) {
  console.error(
    "b22-live-attach-proof: could not build the ReleaseFast sessiond",
  );
  process.exit(2);
}
const sessiondDigest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
let expectedSessiondDigest: string;
let selectedSessiondDigest: string;
try {
  accessSync(selectedSessiond, constants.X_OK);
  expectedSessiondDigest = sessiondDigest(releaseSessiond);
  selectedSessiondDigest = sessiondDigest(selectedSessiond);
} catch {
  console.error(
    `b22-live-attach-proof: selected sessiond binary is not executable: ${selectedSessiond}`,
  );
  process.exit(2);
}
if (selectedSessiondDigest !== expectedSessiondDigest) {
  console.error(
    `b22-live-attach-proof: selected sessiond binary ${selectedSessiond} does not match the ReleaseFast proof build ${releaseSessiond}; refusing stale artifact`,
  );
  process.exit(2);
}
// A throwaway home for the proof run. Its length no longer matters: sockets are bound under sessiond's own socket root, which the preflight below measures, and the home holds only the per-session files, which have no length limit.
const home =
  process.env.HIVE_B22_HOME ??
  `/tmp/hb22-${Math.random().toString(16).slice(2, 6)}`;
process.env.HIVE_HOME = home;
const port = Number(process.env.HIVE_B22_PORT ?? "43117");
const agentName = realShell ? "terminal" : "aria";
const agentId = `agent-${agentName}`;
const workspaceProject = process.env.HIVE_B22_WORKSPACE_PROJECT ?? repoRoot;
const a4Action = process.env.HIVE_B25_A4_ACTION;
if (a4Action !== undefined && a4Action !== "close") {
  throw new Error(`HIVE_B25_A4_ACTION must be close (got ${a4Action})`);
}
if (!workspaceProject.startsWith("/") || !existsSync(workspaceProject)) {
  throw new Error(
    `HIVE_B22_WORKSPACE_PROJECT must name an existing absolute directory`,
  );
}

mkdirSync(home, { recursive: true, mode: 0o700 });
// Run the verified bytes from the throwaway home. macOS can reject an ad-hoc executable staged under a hidden worktree even when its signature verifies, while accepting the same bytes from this runtime location.
const stagedSessiond = join(home, "hive-sessiond");
copyFileSync(selectedSessiond, stagedSessiond);
chmodSync(stagedSessiond, 0o755);
if (sessiondDigest(stagedSessiond) !== expectedSessiondDigest) {
  console.error(
    `b22-live-attach-proof: staged sessiond binary ${stagedSessiond} does not match the ReleaseFast proof build ${releaseSessiond}`,
  );
  process.exit(2);
}
process.env.HIVE_SESSIOND_BIN = stagedSessiond;
const { sessiondRuntimeRoot } = await import("../../src/hive-home/home");
const sessiondRoot = sessiondRuntimeRoot(home);
mkdirSync(sessiondRoot, { recursive: true, mode: 0o700 });
const canonicalSessiondRoot = realpathSync(sessiondRoot);
// Measured from the name the launcher and the host actually bind, not from a copy of its shape: every socket name under the root is the same length, so this is the longest bindable path and not an estimate of one.
const { hostDirectory, hostSocketName, hostSocketPath } = await import(
  "../../src/daemon/session-host/host-operations"
);
const unixSocketPathBytes = Buffer.byteLength(
  join(
    canonicalSessiondRoot,
    hostSocketName("ses_00000000-0000-7000-8000-000000000000"),
  ),
);
if (unixSocketPathBytes > 103) {
  console.error(
    "b22-live-attach-proof: sessiond's socket root resolves to a path too long for host sockets: " +
      `${canonicalSessiondRoot} (${unixSocketPathBytes} bytes; maximum 103). Set HIVE_SESSIOND_ROOT to something shorter.`,
  );
  process.exit(2);
}
const transcriptPath = join(home, "b22-proof-transcript.log");
const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(transcriptPath, `${stamped}\n`);
};

const { HiveDatabase } = await import(
  "../../src/daemon/database/hive-database"
);
const { hiveInstanceSuffix } = await import("../../src/hive-home/home");
const { HiveTerminalHostAdapter } = await import(
  "../../src/daemon/session-host/hive-terminal-host"
);
const { SessiondHost } = await import(
  "../../src/daemon/session-host/sessiond-host"
);
const { macProcessIdentity } = await import(
  "../../src/daemon/lifecycle/daemon-lifecycle"
);
const { mintSessionLocator } = await import(
  "../../src/daemon/session-host/locators"
);

// Pass-through CLI wrapper: every verb hits the real CLI except orchestrator boot, which is a placeholder so a demo never launches a real vendor TUI.
const hiveWrapper = join(home, "hive-cli");
writeFileSync(
  hiveWrapper,
  `#!/bin/sh
if [ "$1" = "workspace-orchestrator" ]; then
  printf 'B2.2 live proof: orchestrator placeholder (no vendor TUI)\\n'
  exec /bin/sleep 100000
fi
export HIVE_HOME=${JSON.stringify(home)}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repoRoot, "src/cli.ts"))} "$@"
`,
);
chmodSync(hiveWrapper, 0o755);

log(`B2.2 live proof home: ${home}`);
log(`transcript: ${transcriptPath}`);
log(`Workspace project: ${workspaceProject}`);

// 1. Real daemon in this process: a session's visibility is held by whoever created it, so the harness must BE the daemon rather than sit beside one.
process.env.HIVE_PORT = String(port);
const { acquireDaemonLock, releaseDaemonLock } = await import(
  "../../src/daemon/lifecycle/daemon-lifecycle"
);
await acquireDaemonLock();
process.once("exit", () => {
  releaseDaemonLock();
});
const { startDaemon, HiveDaemon } = await import("../../src/daemon/server");
const { WorkspaceVisibilityAuthority } = await import(
  "../../src/daemon/session-host/workspace-visibility"
);
const db = new HiveDatabase(join(home, "hive.db"));
const bootstrapHost = new SessiondHost({
  repoRoot,
  hiveHome: home,
  pendingBindings: db,
});
const publisher = macProcessIdentity(process.pid);
const workspaceVisibility = new WorkspaceVisibilityAuthority({
  expectedInstanceId: hiveInstanceSuffix(),
  observeProcess: (pid) => {
    try {
      return macProcessIdentity(pid);
    } catch {
      return null;
    }
  },
  discoverEngineBuildId: () => bootstrapHost.discoverEngineBuildId(),
});
// Headless mode launches no Workspace, so the harness process that owns this in-process daemon also supplies its live owner identity.
if (!launchApp) {
  const registered = workspaceVisibility.register({
    sessionId: "b22-live-proof-publisher",
    process: { processId: process.pid, startToken: publisher.startToken },
  });
  if (registered.state !== "accepted") {
    throw new Error(
      `headless Workspace ownership refused: ${registered.reason}`,
    );
  }
}
const daemon = startDaemon({
  statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
  db,
  repoRoot,
  spawner: {
    spawn: async () => {
      throw new Error("B2.2 live proof does not spawn agents");
    },
  },
  workspaceVisibility,
  manageLifecycle: true,
});
for (let i = 0; i < 100; i += 1) {
  if (daemon.listeningPort !== null) break;
  await Bun.sleep(100);
}
log(`daemon live in-process on port ${daemon.listeningPort}`);

// 2. Manually-created sessiond session through the daemon's locator-fenced adapter and binding store.
const instanceId = hiveInstanceSuffix();
const adapter = daemon.sessiondTerminalHost as InstanceType<
  typeof HiveTerminalHostAdapter
>;
// The adapter needs daemon.lock; fail loud if it never appears.
for (let i = 0; i < 100 && !existsSync(join(home, "daemon.lock")); i += 1) {
  await Bun.sleep(100);
}
if (!existsSync(join(home, "daemon.lock"))) {
  throw new Error(
    "daemon.lock was never written — the adapter would fail closed",
  );
}
let engineBuildId = "";
for (let i = 0; i < 60; i += 1) {
  try {
    engineBuildId = await bootstrapHost.discoverEngineBuildId();
    break;
  } catch (error) {
    if (i === 59) throw error;
    await Bun.sleep(500);
  }
}
const locator = {
  ...mintSessionLocator(
    instanceId,
    { kind: "agent", agentId },
    1,
    engineBuildId,
  ),
};
const visibility = {
  workspaceSessionId: "b22-live-proof-publisher",
  workspacePid: process.pid,
  workspaceStartToken: publisher.startToken,
  openTerminalRevision: "1",
};
const now = new Date().toISOString();
db.insertAgent({
  id: agentId,
  name: agentName,
  tool: "codex",
  model: realShell ? "interactive-login-shell" : "b22-live-proof",
  category: "simple_coding",
  status: "working",
  taskDescription: realShell
    ? "Real interactive login shell (manual session)"
    : "B2.2 live watchable terminal proof (manual session)",
  worktreePath: null,
  branch: null,
  contextPct: null,
  createdAt: now,
  lastEventAt: now,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
  sessionLocator: locator,
});
log(
  `agent row inserted: ${agentName} → ${locator.sessionId} generation ${locator.generation}`,
);

const ticker =
  '(i=0; while true; do printf "\\033[1;3%dm● B2.2 LIVE %04d\\033[0m  " ' +
  '"$(( (i % 6) + 1 ))" "$i"; i=$((i+1)); [ $((i % 4)) -eq 0 ] && printf "\\n"; ' +
  "sleep 0.25; done) & ticker_pid=$!; " +
  "trap 'kill \"$ticker_pid\" 2>/dev/null' EXIT; " +
  'while IFS= read -r line; do printf "\\nB2.3 RESPONSE:%s\\n" "$line"; done';
const shellEnvironment = Object.fromEntries(
  [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
  ].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }),
);
const environment: Record<string, string> = realShell
  ? { ...shellEnvironment, TERM: "xterm-256color", SHELL: shellExecutable }
  : { TERM: "xterm-256color", PATH: "/usr/bin:/bin" };
const spec = {
  schemaVersion: 1 as const,
  locator,
  provider: "codex" as const,
  toolSessionId: null,
  cwd: realShell ? repoRoot : home,
  argv: realShell
    ? ([shellExecutable, "-l"] as const)
    : ([shellExecutable, "-f", "-c", ticker] as const),
  environment,
  expectedExecutable: shellExecutable,
  readOnly: false,
  capabilityEpoch: 0,
  geometry: {
    columns: 80,
    rows: 24,
    widthPx: 800,
    heightPx: 480,
    cellWidthPx: 10,
    cellHeightPx: 20,
  },
  launchGrantId: "b22-live-proof-grant",
  launchGrantRevision: 1,
};
let created: Awaited<ReturnType<typeof adapter.create>>;
try {
  created = await adapter.create(spec, { locator, visibility });
} catch (error) {
  log(`session create failed: ${error}`);
  await daemon.stop();
  process.exit(1);
}
const createdHostPid = created.inspection.hostPid;
if (createdHostPid === null)
  throw new Error("session create returned no live host pid");
log(
  `session created: hostPid=${createdHostPid} shell=${created.inspection.shellRoot?.pid}`,
);
if (realShell)
  log(`interactive login shell: ${shellExecutable} -l (cwd ${repoRoot})`);
await Bun.sleep(250);
const { captureProcessTree } = await import(
  "../../src/daemon/resource-management/teardown"
);
const processTree = (await captureProcessTree([createdHostPid])).filter(
  (entry) => entry.command !== "sleep 0.25",
);
if (processTree.length < 2) {
  throw new Error(
    `live session tree did not include a provider: ${JSON.stringify(processTree)}`,
  );
}
log(
  `captured live session tree before action: ${processTree.map((entry) => entry.pid).join(",")}`,
);

const workspaceBinary = join(
  repoRoot,
  "workspace/.build/debug/HiveWorkspaceDev",
);
// Build the Workspace binary here by naming the file (make no-ops when current). HIVE_B22_NO_APP=1 runs never need it.
if (launchApp) {
  const built = Bun.spawnSync(["make", workspaceBinary], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (built.exitCode !== 0) {
    console.error(
      `b22-live-attach-proof: could not build ${workspaceBinary} (run 'make build' first)`,
    );
    process.exit(2);
  }
}
const workspaceArgs = [
  "--project",
  workspaceProject,
  "--port",
  String(port),
  "--instance-id",
  instanceId,
  "--instance-home",
  home,
  "--hive",
  hiveWrapper,
];
log(
  `launch the Workspace now:\n  ${workspaceBinary} ${workspaceArgs.join(" ")}`,
);
const workspace = !launchApp
  ? null
  : Bun.spawn([workspaceBinary, ...workspaceArgs], {
      cwd: workspaceProject,
      env: { ...process.env, HIVE_HOME: home },
      stdin: "ignore",
      stdout: Bun.file(join(home, "workspace.stdout.log")),
      stderr: Bun.file(join(home, "workspace.stderr.log")),
    });
if (workspace !== null) log(`workspace app launched (pid ${workspace.pid})`);

let shuttingDown = false;
const shutdown = async (reason: string, requestedExitCode = 0) => {
  if (shuttingDown) {
    // Second signal during shutdown: force exit rather than re-enter orderly path.
    log(`forced exit (${reason} during shutdown)`);
    process.exit(130);
  }
  shuttingDown = true;
  log(`shutting down (${reason})`);
  try {
    workspace?.kill();
  } catch {}
  // ONE teardown path. daemon.stop() closes every live agent — this session included — through the daemon's own teardown; terminating here as well races two teardowns. An unreachable host is treated as an already-dead session, so stop() refuses only when teardown ACTIVELY failed: something it captured is still running.
  let exitCode = requestedExitCode;
  try {
    const stopDeadline = setTimeout(() => {
      const runningPids = processTree
        .filter((entry) => {
          const ps = Bun.spawnSync([
            "/bin/ps",
            "-o",
            "stat=",
            "-p",
            String(entry.pid),
          ]);
          const state = ps.stdout.toString().trim();
          return state !== "" && !state.startsWith("Z");
        })
        .map((entry) => entry.pid);
      const finalPath = join(
        hostDirectory(home, locator.sessionId),
        "final.json",
      );
      if (runningPids.length === 0 && existsSync(finalPath)) {
        log(
          "KNOWN TEARDOWN DRAIN DEFECT: await daemon.stop() did not return within 60s after the host tree and final.json had settled; force-killing the proof harness",
        );
      } else {
        log(
          `TEARDOWN TIMEOUT: await daemon.stop() did not return within 60s; running host-tree pids=${runningPids.join(",") || "none"} final.json=${existsSync(finalPath) ? "present" : "absent"}; force-killing the proof harness`,
        );
      }
      process.kill(process.pid, "SIGKILL");
    }, 60_000);
    try {
      await daemon.stop();
    } finally {
      clearTimeout(stopDeadline);
    }
    log("daemon stopped; session torn down");
  } catch (error) {
    // Refusal means real work is still standing. Kill by host pid recorded at create; exit code reports process-table state, not the signal we sent.
    log(`daemon stop refused (${error}); killing session host directly`);
    const hostPid = createdHostPid;
    try {
      process.kill(hostPid, "SIGKILL");
    } catch {}
    // Do not use kill(pid, 0) for liveness: a zombie still answers signal 0 until it is reaped. Read process state; a zombie has stopped executing.
    let state = "?";
    for (let i = 0; i < 40; i += 1) {
      await Bun.sleep(50);
      const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(hostPid)]);
      state = ps.stdout.toString().trim();
      if (state === "" || state.startsWith("Z")) break;
    }
    if (state === "") {
      log(`session host ${hostPid} confirmed gone`);
    } else if (state.startsWith("Z")) {
      log(
        `session host ${hostPid} exited; zombie awaiting reap (stat=${state})`,
      );
    } else {
      log(
        `session host ${hostPid} SURVIVED SIGKILL (stat=${state}); exiting non-zero`,
      );
      exitCode = 1;
    }
  }
  process.exit(exitCode);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
writeFileSync(
  join(home, "b22-proof.json"),
  JSON.stringify({
    hiveCli: hiveWrapper,
    port,
    agent: agentName,
    mode: realShell ? "shell" : "ticker",
    workspaceProject,
    hostPid: createdHostPid,
    processTree,
    locator,
    // The two trees this session occupies, resolved by the same functions the daemon dials with. Outside readers take them from here rather than rebuilding a path from a root and a shape, which is how a shell stage ends up asserting against a layout the code stopped using.
    hostDirectory: hostDirectory(home, locator.sessionId),
    hostSocket: hostSocketPath(home, locator.sessionId),
  }),
);
log(
  "proof descriptor written for opt-in live tests: " +
    join(home, "b22-proof.json"),
);
log(
  realShell
    ? "terminal stack is up — click the terminal pane and type a command; Ctrl-C here tears down"
    : "proof stack is up — Ctrl-C to tear down",
);
if (
  workspace !== null &&
  (process.env.HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT === "1" ||
    a4Action === "close")
) {
  const proofExit = await workspace.exited;
  // Signal-driven shutdown already kills the app; do not re-enter shutdown for that passive exit (would look like a second Ctrl-C).
  if (!shuttingDown) {
    log(`Workspace live-resize proof exited ${proofExit}`);
    if (a4Action === "close") {
      const finalPath = join(
        hostDirectory(home, locator.sessionId),
        "final.json",
      );
      for (let i = 0; i < 100 && !existsSync(finalPath); i += 1)
        await Bun.sleep(50);
      if (!existsSync(finalPath))
        throw new Error("A4 close produced no final session record");
      const final = JSON.parse(readFileSync(finalPath, "utf8")) as {
        state?: string;
        survivors?: unknown[];
      };
      if (
        proofExit !== 0 ||
        final.state !== "terminated" ||
        final.survivors?.length !== 0
      ) {
        throw new Error(
          `A4 close was not verified: exit=${proofExit} final=${JSON.stringify(final)}`,
        );
      }
      if (daemon.listeningPort === null) {
        throw new Error("A4 close killed the unrelated daemon control plane");
      }
      log(
        "A4 CLOSE VERIFIED: exact session terminated with no survivors; daemon still live",
      );
    }
    await shutdown("Workspace live-resize proof complete", proofExit);
  }
}
await new Promise(() => {});

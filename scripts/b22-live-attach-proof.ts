#!/usr/bin/env bun
/**
 * B2.2 live watchable proof harness: black-box, manually-launched simple
 * command (not an agent spawn).
 *
 * Stands up the real stack end to end:
 *   1. real `hive-sessiond serve` broker
 *   2. real Hive daemon sharing the same HIVE_HOME
 *   3. one manually-created sessiond session (B2.2 ticker, or login shell with
 *      HIVE_B22_REAL_SHELL=1) via HiveTerminalHostAdapter.create; this process
 *      owns visibility and renews the lease
 *   4. real Workspace debug app; pane carries the sessiond locator so
 *      HiveTerminalView attaches and renders live output
 *
 * Stays in the foreground; Ctrl-C tears down (session → daemon → broker).
 * Steps append to a transcript for the evidence bundle.
 */
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const realShell = process.env.HIVE_B22_REAL_SHELL === "1";
const shellExecutable = process.env.SHELL ?? "/bin/zsh";
if (realShell) {
  try {
    if (!shellExecutable.startsWith("/")) throw new Error("not absolute");
    accessSync(shellExecutable, constants.X_OK);
  } catch {
    console.error(
      `b22-live-attach-proof: SHELL is not an absolute executable: ${shellExecutable}`,
    );
    process.exit(2);
  }
}
// Short by necessity: the home canonicalizes under /private/tmp and the host
// socket path (…/runtime/sessiond/hosts/ses_<36-char uuid>/host.sock) must
// stay inside the 104-byte sun_path limit.
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
const canonicalHome = realpathSync(home);
const longestHostSocketPath = join(
  canonicalHome,
  "runtime/sessiond/hosts",
  "ses_00000000-0000-7000-8000-000000000000",
  "host.sock",
);
const unixSocketPathBytes = Buffer.byteLength(longestHostSocketPath);
if (unixSocketPathBytes > 103) {
  console.error(
    "b22-live-attach-proof: HIVE_B22_HOME resolves to a path too long for sessiond host sockets: " +
      `${canonicalHome} (${unixSocketPathBytes} bytes; maximum 103). Use a shorter path such as /tmp/hv.`,
  );
  process.exit(2);
}
const transcriptPath = join(home, "b22-proof-transcript.log");
const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(transcriptPath, `${stamped}\n`);
};

const { HiveDatabase } = await import("../src/daemon/db");
const { hiveInstanceSuffix } = await import("../src/daemon/instance-identity");
const { HiveTerminalHostAdapter } = await import(
  "../src/daemon/session-host/hive-terminal-host"
);
const { SessiondHost } = await import(
  "../src/daemon/session-host/sessiond-host"
);
const { macProcessIdentity } = await import("../src/daemon/lifecycle");
const { mintSessionLocator } = await import(
  "../src/daemon/session-host/locators"
);

// Pass-through CLI wrapper: every verb hits the real CLI except orchestrator
// boot, which is a placeholder so a demo never launches a real vendor TUI.
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

// 1. Real broker. A terminal Ctrl-C signals the whole foreground process
// group. Do not let that kill the broker first: orderly teardown terminates
// sessions through it, and a broker that dies on SIGINT manufactures a
// broker-unavailable shutdown. Ignore SIGINT on the broker (an ignored
// disposition survives exec, unlike a handler) and kill it only from the
// explicit shutdown path and the exit hook.
const brokerBinary = join(
  repoRoot,
  "native/sessiond/zig-out/bin/hive-sessiond",
);
const broker = Bun.spawn(
  ["/bin/sh", "-c", 'trap "" INT; exec "$0" "$@"', brokerBinary, "serve"],
  {
    cwd: repoRoot,
    env: { ...process.env, HIVE_HOME: home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  },
);
const brokerSocket = join(home, "runtime/sessiond/broker.sock");
for (let i = 0; i < 100; i += 1) {
  if (existsSync(brokerSocket)) break;
  if (broker.exitCode !== null) throw new Error("broker exited during startup");
  await Bun.sleep(100);
}
log(`broker live (pid ${broker.pid}) at ${brokerSocket}`);

// 2. Real daemon in this process: the broker authenticates exactly one daemon
// identity (daemon.lock), so the harness must BE the daemon, not sit beside it.
process.env.HIVE_PORT = String(port);
const { acquireDaemonLock, releaseDaemonLock } = await import(
  "../src/daemon/lifecycle"
);
await acquireDaemonLock();
// The broker ignores process-group SIGINT, so every exit path — not just the
// orderly one below — must take it down or the run leaks a broker.
process.once("exit", () => {
  try {
    broker.kill();
  } catch {
    /* already gone */
  }
  releaseDaemonLock();
});
const { startDaemon, HiveDaemon } = await import("../src/daemon/server");
const { WorkspaceVisibilityAuthority } = await import(
  "../src/daemon/session-host/workspace-visibility"
);
const db = new HiveDatabase(join(home, "hive.db"));
const bootstrapHost = new SessiondHost({
  repoRoot,
  hiveHome: home,
  pendingBindings: db,
});
const daemon = startDaemon({
  statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
  db,
  repoRoot,
  spawner: {
    spawn: async () => {
      throw new Error("B2.2 live proof does not spawn agents");
    },
  },
  workspaceVisibility: new WorkspaceVisibilityAuthority({
    expectedInstanceId: hiveInstanceSuffix(),
    observeProcess: (pid) => {
      try {
        return macProcessIdentity(pid);
      } catch {
        return null;
      }
    },
    discoverEngineBuildId: () => bootstrapHost.discoverEngineBuildId(),
  }),
  manageLifecycle: true,
});
for (let i = 0; i < 100; i += 1) {
  if (daemon.listeningPort !== null) break;
  await Bun.sleep(100);
}
log(`daemon live in-process on port ${daemon.listeningPort}`);

// 3. Manually-created sessiond session through the daemon's locator-fenced
// adapter and binding store.
const instanceId = hiveInstanceSuffix();
// Runtime-full adapter; the getter's compile-time Pick is narrower.
const adapter = daemon.sessiondTerminalHost as InstanceType<
  typeof HiveTerminalHostAdapter
>;
// Broker auth needs daemon.lock; fail loud if it never appears.
for (let i = 0; i < 100 && !existsSync(join(home, "daemon.lock")); i += 1) {
  await Bun.sleep(100);
}
if (!existsSync(join(home, "daemon.lock"))) {
  throw new Error(
    "daemon.lock was never written — broker auth would fail closed",
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
const publisher = macProcessIdentity(process.pid);
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
  recoveryAttempts: 0,
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
  ].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]!]],
  ),
);
const spec = {
  schemaVersion: 1 as const,
  locator,
  provider: "codex" as const,
  toolSessionId: null,
  cwd: realShell ? repoRoot : home,
  argv: realShell
    ? ([shellExecutable, "-l"] as const)
    : (["/bin/sh", "-c", ticker] as const),
  environment: realShell
    ? { ...shellEnvironment, TERM: "xterm-256color", SHELL: shellExecutable }
    : { TERM: "xterm-256color", PATH: "/usr/bin:/bin" },
  expectedExecutable: realShell ? shellExecutable : "/bin/sh",
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
  created = await adapter.create(spec, new Uint8Array(), {
    locator,
    visibility,
  });
} catch (error) {
  log(`session create failed: ${error}`);
  broker.kill();
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
const { captureProcessTree } = await import("../src/daemon/teardown");
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

const renewals = setInterval(() => {
  adapter.renewVisibility(locator, visibility).then(
    (lease) => log(`visibility renewed until ${lease.expiresAt}`),
    (error) => log(`visibility renewal failed: ${error}`),
  );
}, 5_000);

// 4. The real Workspace app. Binary is HiveWorkspaceDev so a debug build's
// process name is not the installed app's name in the unified log.
const workspaceBinary = join(
  repoRoot,
  "workspace/.build/debug/HiveWorkspaceDev",
);
const launchApp = process.env.HIVE_B22_NO_APP !== "1";
// Build the Workspace binary here by naming the file (make no-ops when current).
// HIVE_B22_NO_APP=1 runs never need it.
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
    try {
      broker.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    process.exit(130);
  }
  shuttingDown = true;
  log(`shutting down (${reason})`);
  clearInterval(renewals);
  try {
    workspace?.kill();
  } catch {
    /* already gone */
  }
  // ONE teardown path. daemon.stop() closes every live agent — this session
  // included — through the daemon's own teardown; terminating here as well
  // races two teardowns. An unreachable broker is treated as an already-dead
  // session, so stop() refuses only when teardown ACTIVELY failed: something
  // it captured is still running.
  let exitCode = requestedExitCode;
  try {
    await daemon.stop();
    log("daemon stopped; session torn down");
  } catch (error) {
    // Refusal means real work is still standing. Kill by host pid recorded at
    // create (no broker needed); exit code reports process-table state, not
    // the signal we sent.
    log(`daemon stop refused (${error}); killing session host directly`);
    const hostPid = createdHostPid;
    try {
      process.kill(hostPid, "SIGKILL");
    } catch {
      /* already gone */
    }
    // Do not use kill(pid, 0) for liveness: a zombie still answers signal 0
    // until the broker reaps it. Read process state; a zombie has stopped
    // executing.
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
        `session host ${hostPid} exited; zombie awaiting broker reap (stat=${state})`,
      );
    } else {
      log(
        `session host ${hostPid} SURVIVED SIGKILL (stat=${state}); exiting non-zero`,
      );
      exitCode = 1;
    }
  }
  broker.kill();
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
    brokerPid: broker.pid,
    hostPid: createdHostPid,
    processTree,
    locator,
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
  // Signal-driven shutdown already kills the app; do not re-enter shutdown
  // for that passive exit (would look like a second Ctrl-C).
  if (!shuttingDown) {
    log(`Workspace live-resize proof exited ${proofExit}`);
    if (a4Action === "close") {
      const finalPath = join(
        home,
        "runtime/sessiond/hosts",
        locator.sessionId,
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
      if (broker.exitCode !== null || daemon.listeningPort === null) {
        throw new Error(
          "A4 close killed the unrelated daemon/broker control plane",
        );
      }
      log(
        "A4 CLOSE VERIFIED: exact session terminated with no survivors; daemon and broker still live",
      );
    }
    await shutdown("Workspace live-resize proof complete", proofExit);
  }
}
await new Promise(() => {});

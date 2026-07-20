#!/usr/bin/env bun
/**
 * B2.2 live watchable proof harness (M1 boundary: black-box, manually-launched
 * simple command — NOT M2 spawn).
 *
 * Stands up the REAL stack end to end:
 *   1. real `hive-sessiond serve` broker
 *   2. real Hive daemon (`bun src/cli.ts daemon`) sharing the same HIVE_HOME
 *   3. one manually-created sessiond session running either the visible B2.2
 *      ticker or (with HIVE_B22_REAL_SHELL=1) the user's interactive login
 *      shell, admitted through HiveTerminalHostAdapter.create with a harness-
 *      owned visibility publisher (this process), lease sustained by renewal
 *   4. the REAL Workspace debug app launched against the daemon; its pane for
 *      the agent carries the exact sessiond locator, so the B2.2 wiring
 *      attaches a HiveTerminalView and renders the live output
 *
 * The harness stays in the foreground; Ctrl-C tears everything down (session
 * terminate → daemon SIGTERM → broker SIGTERM). All steps append to a
 * transcript file for the evidence bundle.
 */
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
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
    console.error(`make terminal: SHELL is not an absolute executable: ${shellExecutable}`);
    process.exit(2);
  }
}
// Short by necessity: the home canonicalizes under /private/tmp and the host
// socket path (…/runtime/sessiond/hosts/ses_<36-char uuid>/host.sock) must
// stay inside the 104-byte sun_path limit.
const home = process.env.HIVE_B22_HOME
  ?? `/tmp/hb22-${Math.random().toString(16).slice(2, 6)}`;
process.env.HIVE_HOME = home;
const port = Number(process.env.HIVE_B22_PORT ?? "43117");
const agentName = realShell ? "terminal" : "aria";
const agentId = `agent-${agentName}`;

mkdirSync(home, { recursive: true, mode: 0o700 });
const transcriptPath = join(home, "b22-proof-transcript.log");
const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(transcriptPath, `${stamped}\n`);
};

// Imports that read HIVE_HOME resolve it lazily per call; the env above is set
// before any daemon-path helper runs.
const { HiveDatabase } = await import("../src/daemon/db");
const { hiveInstanceSuffix } = await import("../src/daemon/tmux-sessions");
const { HiveTerminalHostAdapter } = await import(
  "../src/daemon/session-host/hive-terminal-host"
);
const { SessiondHost } = await import("../src/daemon/session-host/sessiond-host");
const { macProcessIdentity } = await import("../src/daemon/lifecycle");
const { mintTmuxSessionLocator } = await import("../src/daemon/session-host/locators");

// The Workspace's `--hive` binary: passes every verb through to the real CLI
// except the orchestrator boot, which is a placeholder so a recorded demo
// never launches a real vendor TUI.
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

// 1. Real broker. A terminal Ctrl-C signals the whole foreground process
// group, so the broker used to die FIRST — before the orderly teardown below
// could terminate the session through it. That is what manufactured the
// broker-unavailable shutdown in the first place. The broker therefore ignores
// SIGINT (an ignored disposition survives exec, unlike a handler) and dies on
// the explicit signal the shutdown path and the exit hook send instead.
const brokerBinary = join(repoRoot, "native/sessiond/zig-out/bin/hive-sessiond");
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

// 2. The REAL daemon, in this process: the broker authenticates exactly one
// daemon identity (daemon.lock pid/start-token), so the harness must BE the
// daemon rather than sit beside it.
process.env.HIVE_PORT = String(port);
const { acquireDaemonLock, releaseDaemonLock } = await import("../src/daemon/lifecycle");
await acquireDaemonLock();
// The broker no longer dies with the process group, so every exit path — not
// just the orderly one below — has to take it down or the run leaks a broker.
process.once("exit", () => {
  try {
    broker.kill();
  } catch { /* already gone */ }
  releaseDaemonLock();
});
const { startDaemon, HiveDaemon } = await import("../src/daemon/server");
const { WorkspaceVisibilityAuthority } = await import(
  "../src/daemon/session-host/workspace-visibility"
);
const db = new HiveDatabase(join(home, "hive.db"));
const bootstrapHost = new SessiondHost({ repoRoot, hiveHome: home, pendingBindings: db });
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

// 3. Manually-created sessiond session (the M1 black-box act) through the
// daemon's own locator-fenced adapter and binding store.
const instanceId = hiveInstanceSuffix();
// Runtime-full adapter; the getter's compile-time Pick is narrower.
const adapter = daemon.sessiondTerminalHost as InstanceType<typeof HiveTerminalHostAdapter>;
// The broker authenticates against daemon.lock and finishes its own startup
// recovery before serving; fail loud if the lock never appeared.
for (let i = 0; i < 100 && !existsSync(join(home, "daemon.lock")); i += 1) {
  await Bun.sleep(100);
}
if (!existsSync(join(home, "daemon.lock"))) {
  throw new Error("daemon.lock was never written — broker auth would fail closed");
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
  ...mintTmuxSessionLocator(instanceId, { kind: "agent", agentId }, 1),
  hostKind: "sessiond" as const,
  engineBuildId,
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
  tmuxSession: `hive-${agentName}`,
  contextPct: null,
  createdAt: now,
  lastEventAt: now,
  recoveryAttempts: 0,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
  sessionLocator: locator,
});
log(`agent row inserted: ${agentName} → ${locator.sessionId} generation ${locator.generation}`);

const ticker =
  '(i=0; while true; do printf "\\033[1;3%dm● B2.2 LIVE %04d\\033[0m  " ' +
  '"$(( (i % 6) + 1 ))" "$i"; i=$((i+1)); [ $((i % 4)) -eq 0 ] && printf "\\n"; ' +
  'sleep 0.25; done) & ticker_pid=$!; ' +
  'trap \'kill "$ticker_pid" 2>/dev/null\' EXIT; ' +
  'while IFS= read -r line; do printf "\\nB2.3 RESPONSE:%s\\n" "$line"; done';
const shellEnvironment = Object.fromEntries(
  ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"]
    .flatMap((name) => process.env[name] === undefined
      ? []
      : [[name, process.env[name]!]]),
);
const spec = {
  schemaVersion: 1 as const,
  locator,
  provider: "codex" as const,
  toolSessionId: null,
  cwd: realShell ? repoRoot : home,
  argv: realShell
    ? [shellExecutable, "-l"] as const
    : ["/bin/sh", "-c", ticker] as const,
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
let created;
try {
  created = await adapter.create(spec, new Uint8Array(), { locator, visibility });
} catch (error) {
  log(`session create failed: ${error}`);
  broker.kill();
  await daemon.stop();
  process.exit(1);
}
log(`session created: hostPid=${created.inspection.hostPid} provider=${created.inspection.providerRoot?.pid}`);
if (realShell) log(`interactive login shell: ${shellExecutable} -l (cwd ${repoRoot})`);

// Sustain the visibility lease from this live publisher process.
const renewals = setInterval(() => {
  adapter.renewVisibility(locator, visibility).then(
    (lease) => log(`visibility renewed until ${lease.expiresAt}`),
    (error) => log(`visibility renewal failed: ${error}`),
  );
}, 5_000);

// 4. The real Workspace app.
const workspaceBinary = join(repoRoot, "workspace/.build/debug/HiveWorkspace");
const workspaceArgs = [
  "--project", repoRoot,
  "--port", String(port),
  "--instance-id", instanceId,
  "--instance-home", home,
  "--hive", hiveWrapper,
  "--orchestrator-session", `hive-b22-orch`,
];
log(`launch the Workspace now:\n  ${workspaceBinary} ${workspaceArgs.join(" ")}`);
const workspace = process.env.HIVE_B22_NO_APP === "1" ? null : Bun.spawn(
  [workspaceBinary, ...workspaceArgs],
  {
    cwd: repoRoot,
    env: { ...process.env, HIVE_HOME: home },
    stdin: "ignore",
    stdout: Bun.file(join(home, "workspace.stdout.log")),
    stderr: Bun.file(join(home, "workspace.stderr.log")),
  },
);
if (workspace !== null) log(`workspace app launched (pid ${workspace.pid})`);

let shuttingDown = false;
const shutdown = async (reason: string) => {
  if (shuttingDown) {
    // A second Ctrl-C means "stop waiting": force the exit rather than
    // re-entering the orderly path.
    log(`forced exit (${reason} during shutdown)`);
    try {
      broker.kill("SIGKILL");
    } catch { /* already gone */ }
    process.exit(130);
  }
  shuttingDown = true;
  log(`shutting down (${reason})`);
  clearInterval(renewals);
  try {
    workspace?.kill();
  } catch { /* already gone */ }
  // ONE teardown path. daemon.stop() closes every live agent — this session
  // included — through the daemon's own teardown, so terminating here as well
  // would be the two-racing-teardowns bug docs/daemon/agent-teardown.md exists
  // to prevent. Since 16908cc1 an unreachable broker is treated as an
  // already-dead session, so stop() refuses only when teardown ACTIVELY failed:
  // something it captured is still running.
  let exitCode = 0;
  try {
    await daemon.stop();
    log("daemon stopped; session torn down");
  } catch (error) {
    // A refusal means real work is still standing. The host pid was recorded at
    // create time, so killing it needs no broker — but a kill is an act and a
    // process gone is a state, so the exit code reports what the process table
    // says rather than what we sent.
    log(`daemon stop refused (${error}); killing session host directly`);
    const hostPid = created.inspection.hostPid;
    try {
      process.kill(hostPid, "SIGKILL");
    } catch { /* already gone */ }
    let alive = true;
    for (let i = 0; i < 20 && alive; i += 1) {
      await Bun.sleep(50);
      try {
        process.kill(hostPid, 0);
      } catch {
        alive = false;
      }
    }
    if (alive) {
      log(`session host ${hostPid} SURVIVED SIGKILL; exiting non-zero`);
      exitCode = 1;
    } else {
      log(`session host ${hostPid} confirmed gone`);
    }
  }
  broker.kill();
  process.exit(exitCode);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
writeFileSync(join(home, "b22-proof.json"), JSON.stringify({
  hiveCli: hiveWrapper,
  port,
  agent: agentName,
  mode: realShell ? "shell" : "ticker",
  locator,
}));
log("proof descriptor written for opt-in live tests: " + join(home, "b22-proof.json"));
log(realShell
  ? "terminal stack is up — click the terminal pane and type a command; Ctrl-C here tears down"
  : "proof stack is up — Ctrl-C to tear down");
await new Promise(() => {});

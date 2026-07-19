#!/usr/bin/env bun
/**
 * B2.2 live watchable proof harness (M1 boundary: black-box, manually-launched
 * simple command — NOT M2 spawn).
 *
 * Stands up the REAL stack end to end:
 *   1. real `hive-sessiond serve` broker
 *   2. real Hive daemon (`bun src/cli.ts daemon`) sharing the same HIVE_HOME
 *   3. one manually-created sessiond session running a visible animated
 *      shell ticker, admitted through HiveTerminalHostAdapter.create with a
 *      harness-owned visibility publisher (this process), lease sustained by
 *      a renewal ticker
 *   4. the REAL Workspace debug app launched against the daemon; its pane for
 *      the agent carries the exact sessiond locator, so the B2.2 wiring
 *      attaches a HiveTerminalView and renders the live output
 *
 * The harness stays in the foreground; Ctrl-C tears everything down (session
 * terminate → daemon SIGTERM → broker SIGTERM). All steps append to a
 * transcript file for the evidence bundle.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const home = process.env.HIVE_B22_HOME
  ?? `/tmp/hive-b22-proof-${Math.random().toString(16).slice(2, 10)}`;
process.env.HIVE_HOME = home;
const port = Number(process.env.HIVE_B22_PORT ?? "43117");
const agentName = "aria";
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

// 1. Real broker.
const brokerBinary = join(repoRoot, "native/sessiond/zig-out/bin/hive-sessiond");
const broker = Bun.spawn([brokerBinary, "serve"], {
  cwd: repoRoot,
  env: { ...process.env, HIVE_HOME: home },
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
});
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
process.once("exit", () => releaseDaemonLock());
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
  model: "b22-live-proof",
  category: "simple_coding",
  status: "working",
  taskDescription: "B2.2 live watchable terminal proof (manual session)",
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
  'i=0; while true; do printf "\\033[1;3%dm● B2.2 LIVE %04d\\033[0m  " ' +
  '"$(( (i % 6) + 1 ))" "$i"; i=$((i+1)); [ $((i % 4)) -eq 0 ] && printf "\\n"; ' +
  "sleep 0.25; done";
const spec = {
  schemaVersion: 1 as const,
  locator,
  provider: "codex" as const,
  toolSessionId: null,
  cwd: home,
  argv: ["/bin/sh", "-c", ticker] as const,
  environment: { TERM: "xterm-256color", PATH: "/usr/bin:/bin" },
  expectedExecutable: "/bin/sh",
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
const created = await adapter.create(spec, new Uint8Array(), { locator, visibility });
log(`session created: hostPid=${created.inspection.hostPid} provider=${created.inspection.providerRoot?.pid}`);

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
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  clearInterval(renewals);
  try {
    workspace?.kill();
  } catch { /* already gone */ }
  try {
    const { mintSessionRequestId } = await import(
      "../src/daemon/session-host/locators"
    );
    const termination = await adapter.terminate(locator, {
      mode: "immediate",
      reason: "b22-live-proof-shutdown",
      requestId: mintSessionRequestId(),
    });
    log(`session terminated: ${JSON.stringify(termination).slice(0, 200)}`);
  } catch (error) {
    log(`session terminate failed: ${error}`);
  }
  await daemon.stop();
  broker.kill();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
writeFileSync(join(home, "b22-proof.json"), JSON.stringify({
  hiveCli: hiveWrapper,
  port,
  agent: agentName,
  locator,
}));
log("proof descriptor written for opt-in live tests: " + join(home, "b22-proof.json"));
log("proof stack is up — Ctrl-C to tear down");
await new Promise(() => {});

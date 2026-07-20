#!/usr/bin/env bun
/**
 * Staged-app proof that the production daemon owns the sessiond broker.
 *
 * Uses the release layout under HIVE_INSTALL_ROOT (default .dev/root from
 * `make build`): sibling hive + hive-sessiond. The daemon process itself
 * spawns the broker under its lock identity — this script never runs
 * `hive-sessiond serve`. Short HIVE_HOME for sun_path.
 *
 * HELLO is peer-authenticated to the daemon PID, so this proof measures
 * ownership from outside: socket presence, process tree, and crash recovery
 * (SIGKILL broker → daemon supervisor restarts it). Engine discovery is
 * covered by src/daemon/sessiond-broker.live.test.ts (in-process daemon).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  connectUnixSocket,
  readLocalPeerPid,
  socketFileDescriptor,
} from "../src/daemon/sessiond-broker";

const repoRoot = resolve(import.meta.dir, "..");
const installRoot = process.env.HIVE_INSTALL_ROOT ?? join(repoRoot, ".dev/root");
const stagedHive = join(installRoot, "current", "hive");
const stagedSessiond = join(installRoot, "current", "hive-sessiond");
// Process tables show the realpath through versions/, not the `current` symlink.
const stagedSessiondReal = existsSync(stagedSessiond)
  ? realpathSync(stagedSessiond)
  : stagedSessiond;

if (!existsSync(stagedHive) || !existsSync(stagedSessiond)) {
  console.error(
    `staged binaries missing under ${installRoot}/current — run 'make build' first`,
  );
  process.exit(2);
}

const home = process.env.HIVE_PROOF_HOME
  ?? `/tmp/hsl-${Math.random().toString(16).slice(2, 6)}`;
const port = Number(process.env.HIVE_PROOF_PORT ?? "0");
mkdirSync(home, { recursive: true, mode: 0o700 });
const transcript = join(home, "sessiond-lifecycle-proof.log");
const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(transcript, `${stamped}\n`);
};

log(`installRoot=${installRoot}`);
log(`stagedHive=${stagedHive}`);
log(`stagedSessiond=${stagedSessiond}`);
log(`HIVE_HOME=${home}`);

const env = {
  ...process.env,
  HIVE_HOME: home,
  HIVE_INSTALL_ROOT: installRoot,
  HIVE_PORT: String(port),
  HIVE_PROJECT_ROOT: repoRoot,
};

const daemon = Bun.spawn([stagedHive, "daemon"], {
  cwd: repoRoot,
  env,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});

const brokerSocket = join(home, "runtime/sessiond/broker.sock");
const portFile = join(home, "daemon.port");
let boundPort: number | null = null;

/** Only hive-sessiond children of THIS daemon — global pgrep matches every
 * concurrent worktree using the same staged binary path. */
async function sessiondPids(): Promise<number[]> {
  const daemonPid = daemon.pid;
  if (daemonPid === undefined || daemonPid <= 0) return [];
  const proc = Bun.spawn(["ps", "-ax", "-o", "pid=,ppid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3] ?? "";
    if (ppid !== daemonPid) continue;
    if (!command.includes("hive-sessiond") || !command.includes("serve")) continue;
    // Prefer the staged binary when the path is present; still accept a
    // realpath form under versions/.
    if (
      command.includes(stagedSessiondReal) ||
      command.includes("hive-sessiond")
    ) {
      pids.push(pid);
    }
  }
  return pids;
}

try {
  const deadline = Date.now() + 30_000;
  let fullyReady = false;
  let pidsBefore: number[] = [];
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      const err = await new Response(daemon.stderr).text();
      throw new Error(`staged daemon exited ${daemon.exitCode}: ${err}`);
    }
    if (existsSync(brokerSocket) && existsSync(portFile)) {
      boundPort = Number((await Bun.file(portFile).text()).trim());
      if (Number.isFinite(boundPort) && boundPort > 0) {
        // Socket+port alone is not ready: runDaemon writes port before
        // broker.start() returns. External HELLO cannot authenticate (only the
        // daemon-lock peer can). Wait for LOCAL_PEERPID == daemon child, then
        // hold that match briefly so in-process HELLO can finish before we
        // SIGKILL for crash recovery.
        const children = await sessiondPids();
        if (children.length === 1) {
          try {
            const client = await connectUnixSocket(brokerSocket, 500);
            let peer = -1;
            try {
              peer = readLocalPeerPid(socketFileDescriptor(client));
            } finally {
              client.destroy();
            }
            if (peer === children[0]) {
              await Bun.sleep(400);
              // Re-check: still owned by the same child after settle.
              const still = await sessiondPids();
              if (still.length === 1 && still[0] === peer) {
                const client2 = await connectUnixSocket(brokerSocket, 500);
                try {
                  if (readLocalPeerPid(socketFileDescriptor(client2)) === peer) {
                    pidsBefore = still;
                    fullyReady = true;
                    break;
                  }
                } finally {
                  client2.destroy();
                }
              }
            }
          } catch {
            // still starting / stale sock
          }
        }
      }
    }
    await Bun.sleep(50);
  }
  if (!existsSync(brokerSocket)) {
    throw new Error(`broker.sock never appeared at ${brokerSocket}`);
  }
  if (boundPort === null || boundPort <= 0) {
    throw new Error("daemon.port never became a positive port");
  }
  if (!fullyReady || pidsBefore.length === 0) {
    throw new Error(
      "broker never became stably kernel-owned by a daemon child within deadline",
    );
  }
  log(`daemon live on port ${boundPort} (pid ${daemon.pid})`);
  log(`broker.sock present without any harness spawn of hive-sessiond`);
  log(`stable peer-pid ${pidsBefore[0]} — treating broker start as complete`);
  log(`broker pids after start: ${pidsBefore.join(",") || "(none)"}`);

  // Crash recovery: kill the broker; the daemon supervisor must respawn it.
  for (const pid of pidsBefore) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  log(`SIGKILL sent to broker pids ${pidsBefore.join(",")}`);

  const restartDeadline = Date.now() + 20_000;
  let recoveredPid: number | null = null;
  while (Date.now() < restartDeadline) {
    if (daemon.exitCode !== null) {
      const err = await new Response(daemon.stderr).text();
      throw new Error(`daemon died during broker recovery: ${err}`);
    }
    const pids = await sessiondPids();
    const fresh = pids.find((pid) => !pidsBefore.includes(pid));
    if (fresh !== undefined && existsSync(brokerSocket)) {
      try {
        const client = await connectUnixSocket(brokerSocket, 500);
        try {
          if (readLocalPeerPid(socketFileDescriptor(client)) === fresh) {
            await Bun.sleep(400);
            const still = await sessiondPids();
            if (still.includes(fresh)) {
              recoveredPid = fresh;
              break;
            }
          }
        } finally {
          client.destroy();
        }
      } catch {
        // not ready yet
      }
    }
    await Bun.sleep(50);
  }
  if (recoveredPid === null) {
    throw new Error("broker did not recover after SIGKILL within 20s");
  }
  log(`crash recovery: new broker pid ${recoveredPid}; socket restored`);

  writeFileSync(
    join(home, "PROOF.json"),
    `${JSON.stringify({
      ok: true,
      home,
      installRoot,
      boundPort,
      daemonPid: daemon.pid,
      brokerPidsBefore: pidsBefore,
      brokerPidAfterRestart: recoveredPid,
      stagedHive,
      stagedSessiond,
      brokerSocket,
      harnessSpawnedBroker: false,
      recovered: true,
    }, null, 2)}\n`,
  );
  log(`PROOF.json written at ${join(home, "PROOF.json")}`);
  log(`PASS: staged daemon owns sessiond broker with crash recovery`);
} catch (error) {
  const err = await new Response(daemon.stderr).text().catch(() => "");
  if (err.trim()) log(`daemon stderr:\n${err}`);
  throw error;
} finally {
  try {
    daemon.kill("SIGTERM");
  } catch {
    // ignore
  }
  const stopDeadline = Date.now() + 8_000;
  while (Date.now() < stopDeadline && daemon.exitCode === null) {
    await Bun.sleep(50);
  }
  if (daemon.exitCode === null) {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  // Confirm broker is gone after daemon stop (teardown ownership).
  await Bun.sleep(200);
  const leftover = await sessiondPids();
  log(`broker pids after daemon stop: ${leftover.join(",") || "(none)"}`);
  if (leftover.length > 0) {
    log(`WARN: broker process(es) survived daemon stop — sending SIGKILL`);
    for (const pid of leftover) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  log(`daemon stopped (exit ${daemon.exitCode})`);
  log(`transcript: ${transcript}`);
}

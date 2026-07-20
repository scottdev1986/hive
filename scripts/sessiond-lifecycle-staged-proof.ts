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

async function sessiondPids(): Promise<number[]> {
  const proc = Bun.spawn(["pgrep", "-f", `${stagedSessiondReal} serve`], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      const err = await new Response(daemon.stderr).text();
      throw new Error(`staged daemon exited ${daemon.exitCode}: ${err}`);
    }
    if (existsSync(brokerSocket) && existsSync(portFile)) {
      boundPort = Number((await Bun.file(portFile).text()).trim());
      if (Number.isFinite(boundPort) && boundPort > 0) break;
    }
    await Bun.sleep(50);
  }
  if (!existsSync(brokerSocket)) {
    throw new Error(`broker.sock never appeared at ${brokerSocket}`);
  }
  if (boundPort === null || boundPort <= 0) {
    throw new Error("daemon.port never became a positive port");
  }
  log(`daemon live on port ${boundPort} (pid ${daemon.pid})`);
  log(`broker.sock present without any harness spawn of hive-sessiond`);

  const pidsBefore = await sessiondPids();
  log(`broker pids after start: ${pidsBefore.join(",") || "(none)"}`);
  if (pidsBefore.length === 0) {
    throw new Error("no hive-sessiond serve process found under staged binary");
  }

  // Crash recovery: kill the broker; the daemon supervisor must respawn it.
  for (const pid of pidsBefore) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  log(`SIGKILL sent to broker pids ${pidsBefore.join(",")}`);

  const restartDeadline = Date.now() + 15_000;
  let recoveredPid: number | null = null;
  while (Date.now() < restartDeadline) {
    if (daemon.exitCode !== null) {
      const err = await new Response(daemon.stderr).text();
      throw new Error(`daemon died during broker recovery: ${err}`);
    }
    const pids = await sessiondPids();
    const fresh = pids.find((pid) => !pidsBefore.includes(pid));
    if (fresh !== undefined && existsSync(brokerSocket)) {
      recoveredPid = fresh;
      break;
    }
    await Bun.sleep(50);
  }
  if (recoveredPid === null) {
    throw new Error("broker did not recover after SIGKILL within 15s");
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

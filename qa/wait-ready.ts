// Wait until the QA daemon has written daemon.port — the artefact the rest of
// the lifecycle actually uses. The startup announcement is not that proof: it
// can print while the port file is still absent, and the next step then fails
// with "no daemon port file". This process exits 0 only after a usable port
// file exists under a home inside the QA staging tree; 2 is NO MEASUREMENT.
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDaemonPort } from "../src/daemon/lifecycle/daemon-lifecycle";
import { repoInstanceName } from "../src/daemon/lifecycle/instances";
import { projectKey } from "../src/daemon/project-identity-core/state";
import { instancesRoot } from "../src/hive-home/home";

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Homes the QA daemon may write daemon.port into. The product rebinds `hive daemon` to the repo instance when HIVE_HOME equals HIVE_DEFAULT_HOME and cwd is a project; it stays on the machine home otherwise. Watch both, provided each resolves inside the QA home. */
export function daemonHomesToWatch(qaHome: string, project: string): string[] {
  const root = canonical(qaHome);
  const instanceHome = join(
    instancesRoot(),
    repoInstanceName(projectKey(realpathSync(project))),
  );
  const homes: string[] = [];
  for (const home of [instanceHome, qaHome]) {
    const resolved = canonical(home);
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw new Error(
        `refusing: daemon home ${home} resolves outside QA_HOME ${qaHome}`,
      );
    }
    if (!homes.includes(resolved)) homes.push(resolved);
  }
  return homes;
}

export async function waitForDaemonPort(deps: {
  homes: readonly string[];
  daemonPid: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  readPort?: (home: string) => number | null;
}): Promise<
  { ok: true; home: string; port: number } | { ok: false; reason: string }
> {
  const isAlive = deps.isAlive ?? processIsAlive;
  const readPort = deps.readPort ?? readDaemonPort;
  const deadline = Date.now() + deps.timeoutMs;
  const listed = deps.homes.join(", ");
  for (;;) {
    for (const home of deps.homes) {
      const port = readPort(home);
      if (port !== null) return { ok: true, home, port };
    }
    if (!isAlive(deps.daemonPid)) {
      return {
        ok: false,
        reason: `daemon pid ${deps.daemonPid} exited before daemon.port appeared under ${listed}`,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        reason: `no daemon.port under ${listed} within ${deps.timeoutMs}ms`,
      };
    }
    await deps.sleep(Math.min(50, remaining));
  }
}

if (import.meta.main) {
  const [qaHome, project, pidRaw, timeoutRaw] = process.argv.slice(2);
  const daemonPid = Number(pidRaw);
  const timeoutMs =
    timeoutRaw === undefined || timeoutRaw.length === 0
      ? 10_000
      : Number(timeoutRaw);
  if (
    qaHome === undefined ||
    project === undefined ||
    !Number.isSafeInteger(daemonPid) ||
    daemonPid <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    process.stderr.write(
      "usage: wait-ready <qa-home> <project> <daemon-pid> [timeout-ms]\n",
    );
    process.exit(2);
  }
  if (
    process.env.HIVE_DEFAULT_HOME === undefined ||
    process.env.HIVE_DEFAULT_HOME.length === 0
  ) {
    process.stderr.write(
      "NO MEASUREMENT: HIVE_DEFAULT_HOME is not set; run via 'make qa'\n",
    );
    process.exit(2);
  }
  let homes: string[];
  try {
    homes = daemonHomesToWatch(qaHome, project);
  } catch (error) {
    process.stderr.write(
      `NO MEASUREMENT: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
  const result = await waitForDaemonPort({
    homes,
    daemonPid,
    timeoutMs,
    sleep: (ms) => Bun.sleep(ms),
  });
  if (!result.ok) {
    process.stderr.write(`NO MEASUREMENT: ${result.reason}\n`);
    process.exit(2);
  }
  process.stderr.write(
    `qa: daemon.port ready home=${result.home} port=${result.port}\n`,
  );
  process.stdout.write(`${result.home}\n`);
}

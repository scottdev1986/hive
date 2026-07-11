// Resource watchdog: the 2026-07-10 incident proved one runaway process
// inside an agent session (a hung `bun test` allocating ~1.5 GB/s) can drive
// the whole machine into jetsam and kill every agent. The daemon therefore
// samples the process tree under every hive-owned tmux session on each
// maintenance tick, hard-kills anything past a per-process memory ceiling,
// and pauses new spawns while system memory is scarce. Detection is pure
// functions over `ps`/`vm_stat` text so the policy is testable without
// spawning anything.

export interface ProcessSample {
  pid: number;
  ppid: number;
  rssMb: number;
  command: string;
}

export interface ResourceLimits {
  enabled: boolean;
  /** Hard ceiling for any single process under a hive session. */
  perProcessMemoryMb: number;
  /** Spawns pause while the system has less than this much reclaimable memory. */
  minSystemAvailableMb: number;
}

export interface SessionProcessRoots {
  /** Agent (or "orchestrator") whose tmux session owns these pane processes. */
  owner: string;
  rootPids: number[];
}

export interface ResourceKill {
  owner: string;
  process: ProcessSample;
}

export interface ResourceAssessment {
  kills: ResourceKill[];
  daemonRssMb: number | null;
  availableMb: number | null;
  memoryPressure: boolean;
}

export type CommandOutput = () => Promise<string>;

export const runPs: CommandOutput = async () => {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return await new Response(child.stdout).text();
};

export const runVmStat: CommandOutput = async () => {
  const child = Bun.spawn(["vm_stat"], { stdout: "pipe", stderr: "ignore" });
  return await new Response(child.stdout).text();
};

export function parseProcessTable(raw: string): ProcessSample[] {
  const samples: ProcessSample[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    samples.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssMb: Number(match[3]) / 1024,
      command: match[4]!.trim(),
    });
  }
  return samples;
}

// Reclaimable ≈ free + inactive + purgeable + speculative. File-backed pages
// are ignored, so this undercounts what the kernel could reclaim — a floor
// gauge should err exactly that way.
export function parseAvailableMemoryMb(raw: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(raw);
  if (pageSize === null) return null;
  let pages = 0;
  let matched = false;
  for (const label of [
    "Pages free",
    "Pages inactive",
    "Pages purgeable",
    "Pages speculative",
  ]) {
    const match = new RegExp(`${label}:\\s+(\\d+)`).exec(raw);
    if (match !== null) {
      pages += Number(match[1]);
      matched = true;
    }
  }
  if (!matched) return null;
  return pages * Number(pageSize[1]) / (1024 * 1024);
}

/** Every sample reachable from the given roots by following parent links,
 * including the roots themselves. */
export function descendantsOf(
  samples: ProcessSample[],
  rootPids: number[],
): ProcessSample[] {
  const byParent = new Map<number, ProcessSample[]>();
  const byPid = new Map<number, ProcessSample>();
  for (const sample of samples) {
    byPid.set(sample.pid, sample);
    const siblings = byParent.get(sample.ppid);
    if (siblings === undefined) byParent.set(sample.ppid, [sample]);
    else siblings.push(sample);
  }
  const seen = new Set<number>();
  const result: ProcessSample[] = [];
  const queue = [...rootPids];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const sample = byPid.get(pid);
    if (sample !== undefined) result.push(sample);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return result;
}

/**
 * The bare name of the binary a `ps` command line is running.
 *
 * `ps` reports the full argv (`/Users/x/.local/bin/codex -c model=...`), and the
 * only part that identifies *what* is running is the basename of argv[0]. Used
 * to ask whether the command hive launched into a pane is still alive in it.
 */
export function processCommandName(command: string): string {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  return argv0.split("/").pop() ?? "";
}

/** Is `command` running anywhere in the process tree under these pane pids? */
export function treeRunsCommand(
  samples: ProcessSample[],
  rootPids: number[],
  command: string,
): boolean {
  return descendantsOf(samples, rootPids).some(
    (sample) => processCommandName(sample.command) === command,
  );
}

export interface AssessResourcesInput {
  samples: ProcessSample[];
  sessions: SessionProcessRoots[];
  daemonPid: number;
  availableMb: number | null;
  limits: ResourceLimits;
}

export function assessResources(
  input: AssessResourcesInput,
): ResourceAssessment {
  const { samples, sessions, daemonPid, availableMb, limits } = input;
  const kills: ResourceKill[] = [];
  const claimed = new Set<number>();
  for (const session of sessions) {
    for (const process of descendantsOf(samples, session.rootPids)) {
      if (claimed.has(process.pid)) continue;
      claimed.add(process.pid);
      if (process.pid === daemonPid) continue;
      if (process.rssMb > limits.perProcessMemoryMb) {
        kills.push({ owner: session.owner, process });
      }
    }
  }
  return {
    kills,
    daemonRssMb: samples.find((sample) => sample.pid === daemonPid)?.rssMb ??
      null,
    availableMb,
    memoryPressure: availableMb !== null &&
      availableMb < limits.minSystemAvailableMb,
  };
}

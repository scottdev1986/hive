// Resource watchdog: the 2026-07-10 incident proved one runaway process
// inside an agent session (a hung `bun test` allocating ~1.5 GB/s) can drive
// the whole machine into jetsam and kill every agent. The daemon therefore
// samples the process tree under every Hive-owned terminal session on each
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
  /** Agent (or "orchestrator") whose terminal owns these processes. */
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
export function descendantsOf<T extends { pid: number; ppid: number }>(
  samples: T[],
  rootPids: number[],
): T[] {
  const byParent = new Map<number, T[]>();
  const byPid = new Map<number, T>();
  for (const sample of samples) {
    byPid.set(sample.pid, sample);
    const siblings = byParent.get(sample.ppid);
    if (siblings === undefined) byParent.set(sample.ppid, [sample]);
    else siblings.push(sample);
  }
  const seen = new Set<number>();
  const result: T[] = [];
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
 * What the OS says about the processes in a pane, for the stalled-message
 * sweep. Silence is an inference; a process state is a measurement — a
 * SIGSTOPped agent shows `T` in one `ps` call, and waiting thirty minutes to
 * conclude what the kernel already published is the exact act-for-state
 * substitution this repo keeps paying for.
 */
export type PaneProcessState = "running" | "stopped" | "gone";

export interface ProcessStateSample {
  pid: number;
  ppid: number;
  stat: string;
}

export interface ForegroundProcessSample extends ProcessStateSample {
  processGroupId: number;
  foregroundProcessGroupId: number;
}

export const runPsState: CommandOutput = async () => {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,stat="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return await new Response(child.stdout).text();
};

export const runPsForeground: CommandOutput = async () => {
  const child = Bun.spawn([
    "ps",
    "-axo",
    "pid=,ppid=,pgid=,tpgid=,stat=",
  ], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return await new Response(child.stdout).text();
};

export function parseStateTable(raw: string): ProcessStateSample[] {
  const samples: ProcessStateSample[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (match === null) continue;
    samples.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3]!,
    });
  }
  return samples;
}

export function parseForegroundProcessTable(
  raw: string,
): ForegroundProcessSample[] {
  const samples: ForegroundProcessSample[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)/.exec(line);
    if (match === null) continue;
    samples.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      processGroupId: Number(match[3]),
      foregroundProcessGroupId: Number(match[4]),
      stat: match[5]!,
    });
  }
  return samples;
}

/** Whether the PTY foreground belongs to a child job or its idle shell. */
export function foregroundJobState(
  samples: ForegroundProcessSample[],
  shellPid: number,
): PaneProcessState | "unknown" {
  const shell = samples.find((sample) => sample.pid === shellPid);
  if (shell === undefined || shell.foregroundProcessGroupId <= 0) return "unknown";
  if (shell.foregroundProcessGroupId === shell.processGroupId) return "gone";
  const foreground = samples.filter(
    (sample) => sample.processGroupId === shell.foregroundProcessGroupId,
  );
  if (foreground.length === 0) return "unknown";
  if (foreground.some((sample) => sample.stat.startsWith("T"))) return "stopped";
  if (foreground.every((sample) => sample.stat.startsWith("Z"))) return "gone";
  return "running";
}

/**
 * The verdict over a pane's whole process tree. "stopped" wins over
 * "running": a suspended CLI under a sleeping shell is a wedge even though
 * the shell itself looks healthy. An empty tree means every process is gone —
 * nothing left in the pane can ever hear anything. Zombies count as gone,
 * not running: a `Z` process is an exit the parent has not reaped.
 */
export function paneProcessState(
  samples: ProcessStateSample[],
  rootPids: number[],
): PaneProcessState {
  const tree = descendantsOf(samples, rootPids);
  if (tree.length === 0) return "gone";
  if (tree.some((sample) => sample.stat.startsWith("T"))) return "stopped";
  if (tree.every((sample) => sample.stat.startsWith("Z"))) return "gone";
  return "running";
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

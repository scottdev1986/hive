import type { ResourceLimits } from "../../schemas/config-schema";

export type { ResourceLimits };

export interface ProcessSample {
  pid: number;
  ppid: number;
  rssMb: number;
  command: string;
}

export interface SessionProcessRoots {
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
    if (match === null || match[4] === undefined) continue;
    samples.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssMb: Number(match[3]) / 1024,
      command: match[4].trim(),
    });
  }
  return samples;
}

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
  return (pages * Number(pageSize[1])) / (1024 * 1024);
}

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
    const pid = queue.shift();
    if (pid === undefined) break;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const sample = byPid.get(pid);
    if (sample !== undefined) result.push(sample);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return result;
}

export type PaneProcessState = "running" | "stopped" | "gone";

export interface ProcessStateSample {
  pid: number;
  ppid: number;
  stat: string;
}

export const runPsState: CommandOutput = async () => {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,stat="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return await new Response(child.stdout).text();
};

export function parseStateTable(raw: string): ProcessStateSample[] {
  const samples: ProcessStateSample[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (match === null || match[3] === undefined) continue;
    samples.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3],
    });
  }
  return samples;
}

export function processCommandName(command: string): string {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  const name = argv0.split("/").pop() ?? "";
  return name === "kimi-code" ? "kimi" : name;
}

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
    daemonRssMb:
      samples.find((sample) => sample.pid === daemonPid)?.rssMb ?? null,
    availableMb,
    memoryPressure:
      availableMb !== null && availableMb < limits.minSystemAvailableMb,
  };
}

import { type ProcessLiveness, probeProcessLiveness } from "./process-liveness";

/** Three-way ownership answer used by reclamation decisions. Collapses other-uid into live: a process that exists is never treated as gone. */
export type OwnershipLiveness = "live" | "dead" | "unknown";

/** Collapse the four-way probe into the three-way reclamation answer. other-uid is live: the process exists. */
export function asOwnershipLiveness(
  result: ProcessLiveness,
): OwnershipLiveness {
  if (result === "live" || result === "other-uid") return "live";
  if (result === "dead") return "dead";
  return "unknown";
}

/**
 * Owner liveness from an agent status row alone.
 * A missing row is unknown — bookkeeping absence is not proof of death.
 * A non-terminal status is live; a terminal status is dead.
 */
export function agentRowOwnershipLiveness<T extends { status: string }>(
  agent: T | undefined,
  isLive: (agent: T) => boolean,
): OwnershipLiveness {
  if (agent === undefined) return "unknown";
  return isLive(agent) ? "live" : "dead";
}

/**
 * Three-valued process ownership of a worktree directory.
 * Finds processes whose cwd is the worktree, then classifies each with
 * probeProcessLiveness. Absence is believed only after a positive control
 * (this process must probe live) and a successful empty holder list.
 */
export async function probeWorktreeOwnerProcessLiveness(
  worktreePath: string,
  probe: (pid: number) => ProcessLiveness = probeProcessLiveness,
  listHolders: (
    path: string,
  ) => Promise<
    { state: "listed"; pids: number[] } | { state: "unknown" }
  > = listProcessesWithCwd,
): Promise<OwnershipLiveness> {
  // Positive control: if we cannot see our own live pid, no absence claim is safe.
  if (asOwnershipLiveness(probe(process.pid)) !== "live") return "unknown";

  const holders = await listHolders(worktreePath);
  if (holders.state === "unknown") return "unknown";

  let sawUnknown = false;
  for (const pid of holders.pids) {
    const ownership = asOwnershipLiveness(probe(pid));
    if (ownership === "live") return "live";
    if (ownership === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "dead";
}

export async function listProcessesWithCwd(
  worktreePath: string,
): Promise<{ state: "listed"; pids: number[] } | { state: "unknown" }> {
  try {
    const child = Bun.spawn(
      ["lsof", "-a", "-d", "cwd", "-F", "p", "--", worktreePath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode === 0) {
      const pids = new Set<number>();
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("p")) continue;
        const pid = Number(line.slice(1));
        if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
      }
      return { state: "listed", pids: [...pids] };
    }
    // lsof exits 1 with empty stdout when the directory exists and no process
    // holds it as cwd. Any stderr content, or any other exit, is unknown.
    if (exitCode === 1 && stdout.trim() === "" && stderr.trim() === "") {
      return { state: "listed", pids: [] };
    }
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

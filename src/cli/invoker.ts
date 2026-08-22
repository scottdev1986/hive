import { spawnSync } from "node:child_process";
import { isString } from "../shared/is-record";

export interface InvokerIdentity {
  readonly pid: number;
  readonly ppid: number;
  /** `process.argv.slice(2)` — [] is the signature of an in-process library call (bun test, a bun script), never of a shell `hive stop`. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Parent chain as `pid:command`, nearest first, bounded depth. A pid whose parent cannot be resolved ends the chain honestly rather than guessing. */
  readonly chain: readonly string[];
  /** Whether the invoking process runs inside a Hive agent worktree. Agent shells hold no fleet authority. */
  readonly agentWorktree: boolean;
}

const CHAIN_DEPTH = 6;

export function isAgentWorktreePath(path: string): boolean {
  return (
    path.includes("/.hive/worktrees/") || path.endsWith("/.hive/worktrees")
  );
}

function readProcess(pid: number): { ppid: number; command: string } | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid=,comm="], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !isString(result.stdout)) return null;
  const line = result.stdout.trim();
  if (line === "") return null;
  const space = line.indexOf(" ");
  if (space === -1) return null;
  const ppid = Number.parseInt(line.slice(0, space), 10);
  if (!Number.isSafeInteger(ppid)) return null;
  return { ppid, command: line.slice(space + 1).trim() };
}

export function captureInvokerIdentity(
  readParent: (
    pid: number,
  ) => { ppid: number; command: string } | null = readProcess,
  /** Where the walk starts. Explicit so a caller can chain pids it controls rather than whichever parent this process happens to have; nothing in the CLI has reason to pass it. */
  origin: number = process.ppid,
): InvokerIdentity {
  const cwd = process.cwd();
  const chain: string[] = [];
  let current = origin;
  for (let depth = 0; depth < CHAIN_DEPTH && current > 1; depth += 1) {
    const parent = readParent(current);
    if (parent === null) break;
    chain.push(`${current}:${parent.command}`);
    current = parent.ppid;
  }
  return {
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv.slice(2),
    cwd,
    chain,
    agentWorktree: isAgentWorktreePath(cwd),
  };
}

/** The provenance string a kill carries to the daemon's audit log. Compact — the daemon truncates reasons at 1024 bytes and a kill must never be refused because its provenance is long. */
export function formatInvokerOrigin(
  subcommand: "kill" | "stop",
  invoker: InvokerIdentity,
): string {
  return (
    `hive ${subcommand} pid=${invoker.pid} ppid=${invoker.ppid} argv=${JSON.stringify(
      invoker.argv,
    )} cwd=${invoker.cwd} agentWorktree=${invoker.agentWorktree ? "yes" : "no"}` +
    ` chain=[${invoker.chain.join(",")}]`
  );
}

/** `bun test` stamps NODE_ENV=test. Inside a test-runner process, a lethal default must never reach through the ambient environment. */
export function isTestRunnerEnv(): boolean {
  return process.env.NODE_ENV === "test";
}

// Who is invoking this CLI process — captured at the origin because the audit
// row is the only record that survives a teardown cascade (#64), and a bare
// ppid is useless once the parent exits (#70: both 2026-07-20 fleet-kill waves
// were audited as `hive stop ppid=<gone> argv=[]` and needed a day of
// forensics to attribute).
//
// This is accident prevention, not a security boundary: a same-UID process can
// read the operator credential and lie about all of it (credentials.ts says
// the same). What it buys is that every HONEST caller — every test runner,
// build script, Workspace teardown and human shell — is decisively
// attributable from its audit row alone.
import { spawnSync } from "node:child_process";

export interface InvokerIdentity {
  readonly pid: number;
  readonly ppid: number;
  /** `process.argv.slice(2)` — [] is the signature of an in-process library
   * call (bun test, a bun script), never of a shell `hive stop`. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Parent chain as `pid:command`, nearest first, bounded depth. A pid whose
   * parent cannot be resolved ends the chain honestly rather than guessing. */
  readonly chain: readonly string[];
  /** Whether the invoking process runs inside a Hive agent worktree — the
   * path-prefix check #70 prescribes. Agent shells hold no fleet authority. */
  readonly agentWorktree: boolean;
}

const CHAIN_DEPTH = 6;

export function isAgentWorktreePath(path: string): boolean {
  return path.includes("/.hive/worktrees/") ||
    path.endsWith("/.hive/worktrees");
}

/** One `ps` read: a pid's parent and command. Null when the pid is gone or
 * `ps` is unavailable — the chain simply ends there. */
function readProcess(pid: number): { ppid: number; command: string } | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid=,comm="], {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const line = result.stdout.trim();
  if (line === "") return null;
  const space = line.indexOf(" ");
  if (space === -1) return null;
  const ppid = Number.parseInt(line.slice(0, space), 10);
  if (!Number.isSafeInteger(ppid)) return null;
  return { ppid, command: line.slice(space + 1).trim() };
}

export function captureInvokerIdentity(
  readParent: (pid: number) => { ppid: number; command: string } | null =
    readProcess,
): InvokerIdentity {
  const cwd = process.cwd();
  const chain: string[] = [];
  let current = process.ppid;
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

/** The provenance string a kill carries to the daemon's audit log. Compact —
 * the daemon truncates reasons at 1024 bytes and a kill must never be refused
 * because its provenance is long. */
export function formatInvokerOrigin(
  subcommand: "kill" | "stop",
  invoker: InvokerIdentity,
): string {
  return `hive ${subcommand} pid=${invoker.pid} ppid=${invoker.ppid} argv=${
    JSON.stringify(invoker.argv)
  } cwd=${invoker.cwd} agentWorktree=${invoker.agentWorktree ? "yes" : "no"}` +
    ` chain=[${invoker.chain.join(",")}]`;
}

/** `bun test` stamps NODE_ENV=test. Inside a test-runner process, a lethal
 * default must never reach through the ambient environment (#70). */
export function isTestRunnerEnv(): boolean {
  return process.env.NODE_ENV === "test";
}

/** The one way Hive drives the `git` binary. Every git invocation goes through here so the facts that make a git call safe are written once: argv is always an array, so no shell ever sees a branch name or a path and interpolation attacks have no interpreter to attack; the child runs with the sanitized environment from git-env, because an inherited GIT_DIR silently redirects any git command at another repository; and a timeout is reported by an explicit flag the runner sets itself — never inferred from `Subprocess.killed`, which Bun sets on any exited process and which therefore cannot tell "we killed it" from "it failed instantly". Stdout and stderr come back untrimmed: trimming and error mapping are the caller's policy, not the mechanism's. Lives beside git-env for the same reason git-env does — driving the binary is a fact about the vendor tool, and every layer that shells out to git can reach adapters without a new import edge. */
import { sanitizedGitEnv } from "./git-env";

/** A stuck git — a stale `index.lock`, a stalled filesystem — must fail its caller rather than wedge it forever. A local operation that has not finished in this long is not going to. */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set only when the runner killed the child at the deadline. */
  timedOut: boolean;
}

export interface RunGitOptions {
  timeoutMs?: number;
  /** The signal a timed-out child dies by. The default is SIGTERM so git's own cleanup (lock-file removal) still runs; callers driving throwaway maintenance operations pass SIGKILL. */
  killSignal?: "SIGTERM" | "SIGKILL";
  /**
   * Deliberate env overrides applied after the host's hostile git discovery
   * variables are stripped. Callers that need an alternate index pass
   * `GIT_INDEX_FILE` here; an inherited `GIT_INDEX_FILE` from the host is still
   * never trusted.
   */
  env?: NodeJS.ProcessEnv;
}

export async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...sanitizedGitEnv(), ...options.env },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(options.killSignal ?? "SIGTERM");
  }, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export interface GitSyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The synchronous form, for the resolver paths that are themselves synchronous. Carries no `timedOut` because Bun.spawnSync does not report one, and a flag the API cannot fill honestly is worse than none. Throws (as Bun.spawnSync does) when the git binary itself cannot be exec'd; callers that treat any failure as "not a repository" already catch. */
export function runGitSync(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): GitSyncResult {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: sanitizedGitEnv(),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.killSignal === undefined
      ? {}
      : { killSignal: options.killSignal }),
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

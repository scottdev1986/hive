// Picking which copy of a vendor CLI a spawn will actually run, shared by all five provider adapters. Hive cannot delegate this to PATH lookup. A terminal host outlives the daemon and carries its own environment, so `claude` resolved at spawn time and `claude` resolved in the pane can be different files. And PATH order is not a preference ranking: a package-manager shim left behind by a failed or half-removed install sits early on a normal login PATH and is happy to be found while being unable to start anything. So candidates are gathered rather than resolved, and each one has to prove it runs before it is allowed to launch an agent.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface ProviderExecutable {
  path: string;
  version: string | null;
}

/** Every installed file named `command`, in the order they should be tried: PATH first, then the vendor's own installer locations. Fallbacks come last because a user who has deliberately put a build on their PATH means it — but they are present at all because that is where the working copy lives once a broken shim has taken the name. */
export function providerExecutableCandidates(
  command: string,
  homeRelativeFallbacks: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  const home = env.HOME ?? homedir();
  const fromPath = (env.PATH ?? "")
    .split(":")
    .filter((directory) => directory.length > 0)
    .map((directory) => join(directory, command));
  const fallbacks = homeRelativeFallbacks.map((path) =>
    isAbsolute(path) ? path : join(home, path),
  );
  return [...new Set([...fromPath, ...fallbacks])].filter((candidate) =>
    existsSync(candidate),
  );
}

/** Ask one candidate to identify itself. Null means it cannot launch anything. `--version` and nothing else. Every vendor here bills by the session, and a guessed subcommand does not fail cleanly on these CLIs — it is taken as a prompt and charged for. `--version` is the only invocation that is non-billable by construction. A hung binary is treated as a failed one: this runs on the spawn path, so the timeout and SIGKILL are what stop an unresponsive shim from holding up the launch instead of just losing the race. */
export function probeProviderExecutable(
  executable: string,
  timeoutMs = 5_000,
): string | null {
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString().trim();
    return output.length === 0 ? "unknown" : output;
  } catch {
    return null;
  }
}

/** The first candidate that answers the probe, as an absolute path a terminal host can run without consulting its own PATH. Null when none answered. The path is reported as its realpath so that what Hive records is the file that ran, not the shim or version-manager link that happened to point at it today — those get repointed, and a recorded launch should stay meaningful. A version that will not parse is null rather than a guess, so callers can report that metadata as unknown while testing the actual protocol. */
export function resolveProviderExecutable(
  command: string,
  homeRelativeFallbacks: readonly string[],
  probe: (executable: string) => string | null = probeProviderExecutable,
  candidates: () => string[] = () =>
    providerExecutableCandidates(command, homeRelativeFallbacks),
): ProviderExecutable | null {
  for (const candidate of candidates()) {
    const output = probe(candidate);
    if (output === null) continue;
    let path = candidate;
    try {
      path = realpathSync.native(candidate);
    } catch {}
    const version = /(\d+\.\d+\.\d+[^\s)]*)/.exec(output)?.[1] ?? null;
    return { path, version };
  }
  return null;
}

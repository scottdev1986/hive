import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface ProviderExecutable {
  path: string;
  version: string | null;
}

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
    isAbsolute(path) ? path : join(home, path)
  );
  return [...new Set([...fromPath, ...fallbacks])]
    .filter((candidate) => existsSync(candidate));
}

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
    } catch {
      // The successful launch probe is authoritative; keep its literal path.
    }
    const version = /(\d+\.\d+\.\d+[^\s)]*)/.exec(output)?.[1] ?? null;
    return { path, version };
  }
  return null;
}

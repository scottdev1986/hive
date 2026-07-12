import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { InstallationBinding, Provider } from "./types";

const VERSION_PROVENANCE: Record<Provider, string> = {
  claude: "https://code.claude.com/docs/en/cli-usage",
  codex: "https://learn.chatgpt.com/docs/app-server",
};

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest("hex");
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    if (text.length > limit) throw new Error(`Probe output exceeded ${limit} bytes`);
  }
}

async function versionProbe(path: string): Promise<string> {
  const child = Bun.spawn([path, "--version"], {
    stdin: null,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnvironment(),
  });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readLimited(child.stdout, 64 * 1024),
      readLimited(child.stderr, 64 * 1024),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Version probe failed (${exitCode}): ${(stderr || stdout).trim()}`);
    }
    return stdout.trim() || stderr.trim();
  } finally {
    clearTimeout(timer);
  }
}

export function cleanEnvironment(): Record<string, string> {
  const keep = [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "PATH",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
  ];
  const env: Record<string, string> = { NO_COLOR: "1" };
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function resolveBinding(
  provider: Provider,
  requestedPath: string,
): Promise<InstallationBinding> {
  if (!isAbsolute(requestedPath)) {
    throw new Error(`${provider} binding must be an absolute path: ${requestedPath}`);
  }
  const executablePath = await realpath(requestedPath);
  const info = await stat(executablePath);
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new Error(`${provider} binding is not an executable file: ${executablePath}`);
  }
  const [sha256, version] = await Promise.all([
    hashFile(executablePath),
    versionProbe(executablePath),
  ]);
  return {
    provider,
    requestedPath,
    executablePath,
    sha256,
    sizeBytes: info.size,
    version,
    probedAt: new Date().toISOString(),
    probe: {
      argv: [executablePath, "--version"],
      billable: "no",
      provenance: VERSION_PROVENANCE[provider],
    },
  };
}

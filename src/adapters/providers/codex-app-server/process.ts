export function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export async function readInstalledVersion(
  executable: string,
): Promise<string | null> {
  const child = Bun.spawn([executable, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) return null;
  const match = `${stdout}\n${stderr}`.match(/codex-cli\s+(\S+)/);
  return match?.[1] ?? null;
}

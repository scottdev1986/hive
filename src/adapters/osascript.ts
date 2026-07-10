const OSASCRIPT_TIMEOUT_MS = 5_000;

export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export const appleScriptString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");

export async function runOsascript(
  script: string,
  operation: string,
): Promise<string> {
  const process = Bun.spawn(
    ["osascript", "-e", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = new Response(process.stdout).text();
  const stderr = new Response(process.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  let exitCode: number;
  try {
    exitCode = await Promise.race([
      process.exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          try {
            process.kill();
          } catch {
            // The process can exit between the race and timeout callback.
          }
          reject(new Error(`could not ${operation}: osascript timed out`));
        }, OSASCRIPT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }

  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    throw new Error(
      `could not ${operation}: ${
        stderrText.trim() || `exit code ${exitCode}`
      }`,
    );
  }
  return stdoutText.trim();
}

const OSASCRIPT_TIMEOUT_MS = 5_000;

export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export const appleScriptString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");

export type OsascriptLanguage = "AppleScript" | "JavaScript";

const MACOS_PERMISSION_DENIED =
  /(?:-1743|-25211|not authorized to send apple events|not allowed assistive access|accessibility access)/i;

export function osascriptFailure(operation: string, detail: string): Error {
  const message = `could not ${operation}: ${detail}`;
  if (!MACOS_PERMISSION_DENIED.test(detail)) {
    return new Error(message);
  }
  // A command the user has earned: only they can grant this permission, and it
  // is granted in System Settings, not by anything Hive can run for them.
  return new Error(
    `${message}\nmacOS denied terminal automation\n` +
      "Fix: System Settings > Privacy & Security > Automation — allow the app " +
      "that launched Hive (Terminal, or your terminal emulator) to control the " +
      "selected terminal application, then run `hive stop` and retry",
  );
}

export async function runOsascript(
  script: string,
  operation: string,
  language: OsascriptLanguage = "AppleScript",
): Promise<string> {
  const process = Bun.spawn(
    language === "JavaScript"
      ? ["osascript", "-l", "JavaScript", "-e", script]
      : ["osascript", "-e", script],
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
    throw osascriptFailure(
      operation,
      stderrText.trim() || `exit code ${exitCode}`,
    );
  }
  return stdoutText.trim();
}

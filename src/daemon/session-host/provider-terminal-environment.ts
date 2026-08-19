import { bundledTerminfoPath } from "./terminfo";

/**
 * Build the environment for a provider terminal session.
 * Sets Ghostty terminal identity and strips incompatible variables.
 *
 * TERM: xterm-ghostty is the bundled Ghostty terminfo name.
 * COLORTERM: truecolor signals 24-bit color support.
 * TERMINFO: Points at Hive's bundled terminfo tree (next to hive-sessiond, or
 * resources/terminfo in a source checkout). Not copied into the hive home.
 * TERMINFO_DIRS: Fallback search path including Hive's terminfo plus system dirs.
 *
 * NO_COLOR is stripped so agents see color by default.
 */
export function providerTerminalEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "NO_COLOR" && entry[1] !== undefined,
    ),
  );

  const hiveTerminfoPath = bundledTerminfoPath();

  return {
    ...base,
    TERM: "xterm-ghostty",
    COLORTERM: "truecolor",
    TERMINFO: hiveTerminfoPath,
    TERMINFO_DIRS: `${hiveTerminfoPath}:${environment.TERMINFO_DIRS ?? "/usr/share/terminfo:/lib/terminfo:/usr/local/share/terminfo"}`,
  };
}

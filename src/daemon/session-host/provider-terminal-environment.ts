import { ensureTerminfoInstalled } from "./terminfo-installer";

/**
 * Build the environment for a provider terminal session.
 * Sets Ghostty terminal identity and strips incompatible variables.
 * 
 * TERM: xterm-ghostty is the bundled Ghostty terminfo name.
 * COLORTERM: truecolor signals 24-bit color support.
 * TERMINFO: Points directly to Hive's bundled terminfo database (installed on demand).
 * TERMINFO_DIRS: Fallback search path including Hive's terminfo plus system dirs.
 * 
 * NO_COLOR is stripped so agents see color by default.
 */
export async function providerTerminalEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string>> {
  const base = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "NO_COLOR" && entry[1] !== undefined,
    ),
  );
  
  // Ensure Hive's bundled terminfo is installed (no-op if already present).
  // This makes Hive self-contained: no Ghostty.app, no tic, no system install required.
  const hiveTerminfoPath = await ensureTerminfoInstalled();
  
  return {
    ...base,
    TERM: "xterm-ghostty",
    COLORTERM: "truecolor",
    // TERMINFO points ncurses directly at Hive's bundled terminfo.
    TERMINFO: hiveTerminfoPath,
    // TERMINFO_DIRS is a colon-separated list. Put Hive's bundled terminfo first,
    // then fall back to system terminfo dirs if something is missing.
    TERMINFO_DIRS: `${hiveTerminfoPath}:${environment.TERMINFO_DIRS ?? "/usr/share/terminfo:/lib/terminfo:/usr/local/share/terminfo"}`,
  };
}

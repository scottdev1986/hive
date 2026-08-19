import { join } from "node:path";
import { machineHiveHome } from "../../hive-home/home";

/**
 * Build the environment for a provider terminal session.
 * Sets Ghostty terminal identity and strips incompatible variables.
 * 
 * TERM: xterm-ghostty is the bundled Ghostty terminfo name.
 * COLORTERM: truecolor signals 24-bit color support.
 * TERMINFO_DIRS: Points to Hive's bundled terminfo database.
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
  
  // Hive-bundled terminfo is installed alongside hive-sessiond in the machine home.
  // This path exists whether running from dev or installed release.
  const hiveTerminfoPath = join(machineHiveHome(), "terminfo");
  
  return {
    ...base,
    TERM: "xterm-ghostty",
    COLORTERM: "truecolor",
    // TERMINFO_DIRS is a colon-separated list. Put Hive's bundled terminfo first,
    // then fall back to system terminfo dirs if something is missing.
    TERMINFO_DIRS: `${hiveTerminfoPath}:${environment.TERMINFO_DIRS ?? "/usr/share/terminfo:/lib/terminfo:/usr/local/share/terminfo"}`,
  };
}

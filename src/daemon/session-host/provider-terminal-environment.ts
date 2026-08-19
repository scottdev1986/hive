/**
 * Build the environment for a provider terminal session.
 * Sets Ghostty terminal identity and strips incompatible variables.
 * 
 * TERM: xterm-ghostty is the bundled Ghostty terminfo name.
 * COLORTERM: truecolor signals 24-bit color support.
 * TERMINFO_DIRS: Points to Hive's bundled terminfo database (when available).
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
  
  return {
    ...base,
    TERM: "xterm-ghostty",
    COLORTERM: "truecolor",
    // TERMINFO_DIRS will point to bundled terminfo when available.
    // For now, rely on system terminfo or fall back to xterm-256color.
    // TODO: Set TERMINFO_DIRS to bundled path once terminfo is packaged.
  };
}

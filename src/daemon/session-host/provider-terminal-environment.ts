interface ProviderTerminalEnv {
  // Never undefined: the entries a process environment leaves unset are dropped below, so callers spread this into a launch spec without a second filter.
  readonly [key: string]: string;
}

// NO_COLOR: agents should see color. TERMINFO*: a launcher like Ghostty.app
// points at a database that does not contain xterm-256color.
const STRIPPED = new Set(["NO_COLOR", "TERMINFO", "TERMINFO_DIRS"]);

export function providerTerminalEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ProviderTerminalEnv {
  const base = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        !STRIPPED.has(entry[0]) && entry[1] !== undefined,
    ),
  );

  return {
    ...base,
    // Hive's libghostty renderer is the terminal. Child programs need a TERM
    // that exists on every Mac; xterm-256color does. COLORTERM is the usual
    // 24-bit signal.
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
}

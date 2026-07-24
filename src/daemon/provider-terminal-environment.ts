/**
 * Build the environment inherited by an interactive provider TUI.
 *
 * NO_COLOR may describe the shell that launched Hive, but the provider runs in
 * Hive's full-color terminal. Passing it through makes Claude replace its
 * normal logo with a geometry-breaking monochrome fallback.
 */
export function providerTerminalEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "NO_COLOR" && entry[1] !== undefined,
    ),
  );
}

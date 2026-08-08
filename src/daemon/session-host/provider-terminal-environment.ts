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

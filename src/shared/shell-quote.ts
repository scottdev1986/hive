export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Quote only when the value needs it. Use for text a user reads: an agent's
 * settings file and its hook commands are opened and edited by hand, and
 * quoting every already-safe path makes them harder to read for no gain. */
export function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return shellQuote(value);
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

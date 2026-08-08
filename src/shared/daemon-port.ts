export function isDaemonPort(
  port: number,
  options: { readonly allowZero?: boolean } = {},
): boolean {
  // Zero asks the OS to choose a port when binding. It is never an address a client can connect to, so only daemon startup opts into accepting it.
  return (
    Number.isInteger(port) &&
    port >= (options.allowZero === true ? 0 : 1) &&
    port <= 65_535
  );
}

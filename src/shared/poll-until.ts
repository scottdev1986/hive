function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Polls `condition` on a fixed interval until it is true or `timeoutMs` elapses, returning whether it ever observed true. Checks once more after the deadline passes, so a condition that flips true on the same tick the deadline expires still counts. `sleep` is injectable for tests; it defaults to a real timer. */
export async function pollUntil(
  condition: () => boolean,
  options: {
    intervalMs: number;
    timeoutMs: number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<boolean> {
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(options.intervalMs);
  }
  return condition();
}

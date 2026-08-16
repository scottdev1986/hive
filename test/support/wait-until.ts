// Wait for a condition the test does not control. An attempt-count loop
// exhausts into the same assertion as "the thing never existed". A deadline
// that names what it waited for keeps those two failures apart.

export const PROCESS_TABLE_VISIBLE_MS = 2_000;

export interface WaitUntilOptions {
  readonly deadlineMs: number;
  readonly label: string;
  readonly intervalMs?: number;
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: WaitUntilOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + options.deadlineMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${options.deadlineMs}ms waiting for ${options.label}`,
      );
    }
    await Bun.sleep(intervalMs);
  }
}

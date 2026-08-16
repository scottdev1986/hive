// Wait for a condition the test does not control. An attempt-count loop
// exhausts into the same assertion as "the thing never existed". A deadline
// that names what it waited for keeps those two failures apart.

// Sized 2026-08-16 against measured work, not copied from the old 2000ms
// sibling polls. Fleet load {21.44 21.63 18.32} then {15.10 20.07 17.88};
// the fleet was live, so there is no quiet baseline. First-fork via the
// tests' Bun `ps` path: max 69.85ms (ppid/runPs, n=16), max 64.62ms
// (pgid/zsh detached, n=12). In-test grandchild wait earlier the same day:
// 52.28ms and 123.33ms. lsof cwd listing: max 290.99ms (n=12). 1000ms is
// 3.4× the slowest of those (lsof 291ms, 29% of budget) and 8× the
// slowest in-test first-fork (123ms). The old member-1 200ms attempt
// ceiling sat at 163% of that 123ms sample.

export const PROCESS_TABLE_VISIBLE_MS = 1_000;

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

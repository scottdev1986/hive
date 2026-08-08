import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The only way a test gets a temp directory. The directory registers its own
 * teardown at creation, so a test cannot leak one by forgetting an afterAll:
 * every dir this hands out is removed when the file's tests end. (A SIGKILLed
 * run still strands that run's dirs — no in-process mechanism can reap those;
 * what this removes is the happy-path leak, which is the one that accumulated
 * tens of thousands of dirs in .dev/tmp.)
 *
 * Dirs that need unusual teardown — e.g. fixtures with write bits stripped
 * that need a chmod walk before removal — keep their own teardown instead of
 * forcing that through here.
 */
export function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Async twin of tempRoot for files that otherwise only use fs/promises. */
export async function tempRootAsync(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

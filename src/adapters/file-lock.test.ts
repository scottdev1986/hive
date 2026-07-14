import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("withFileLock", () => {
  test("waits for an owner that is still writing its lock record", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-"));
    roots.push(root);
    const path = join(root, "state.lock");
    await writeFile(path, "");
    let releasedAt = 0;
    const writer = (async () => {
      await Bun.sleep(30);
      await writeFile(path, JSON.stringify({
        pid: process.pid,
        token: "existing-owner",
      }));
      await Bun.sleep(30);
      releasedAt = Date.now();
      await unlink(path);
    })();

    const acquiredAt = await withFileLock(path, async () => Date.now());
    await writer;
    expect(acquiredAt).toBeGreaterThanOrEqual(releasedAt);
  });

  test("refuses a valid JSON lock with unknown owner keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-wire-"));
    roots.push(root);
    const path = join(root, "state.lock");
    await writeFile(path, JSON.stringify({
      pdi: process.pid,
      token: "misspelled-owner",
    }));

    expect(withFileLock(path, async () => undefined)).rejects.toThrow(
      "Invalid lock owner",
    );
  });

  test("does not steal an unreadable lock — it may be a live owner mid-write", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-empty-"));
    roots.push(root);
    const path = join(root, "state.lock");
    // An unreadable lock: no owner record to check for liveness. It might be a
    // corpse, or an owner still writing — a clock cannot tell them apart, so it
    // must never be reclaimed. A build that reclaimed it on a timer would enter
    // while the writer was still finishing, and two holders is the one thing a
    // lock may not produce.
    await writeFile(path, "");

    let clearedAt = 0;
    const clearer = (async () => {
      // Longer than any grace a timed reclaim would have used (the build under
      // review reclaimed at 1s): if this lock is stolen, it is stolen before
      // here, and the ordering assertion below catches it.
      await Bun.sleep(1_500);
      clearedAt = Date.now();
      await unlink(path);
    })();

    const acquiredAt = await withFileLock(path, async () => Date.now());
    await clearer;
    // The only way in was to wait for the unreadable lock to be cleared, never
    // to reclaim it.
    expect(acquiredAt).toBeGreaterThanOrEqual(clearedAt);
  }, 15_000);

  test("a held lock always has a legible owner record", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-atomic-"));
    roots.push(root);
    const path = join(root, "state.lock");

    // Publication is atomic: the lock's name and its full owner record appear in
    // the same instant, so a held lock is never empty for a reader to trip over.
    await withFileLock(path, async () => {
      const source = await readFile(path, "utf8");
      expect(source.trim().length).toBeGreaterThan(0);
      expect(() => JSON.parse(source)).not.toThrow();
    });
  });

  test("reclaims a well-formed lock whose owner is dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-stale-"));
    roots.push(root);
    const path = join(root, "state.lock");
    await writeFile(path, JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER,
      token: "stale-owner",
    }));

    expect(await withFileLock(path, async () => "acquired")).toBe("acquired");
  });
});

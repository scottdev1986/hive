import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../src/adapters/file-lock";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
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
      await writeFile(
        path,
        JSON.stringify({
          pid: process.pid,
          token: "existing-owner",
        }),
      );
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
    await writeFile(
      path,
      JSON.stringify({
        pdi: process.pid,
        token: "misspelled-owner",
      }),
    );

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
      // Longer than a 1s timed reclaim: a steal would land before this sleep.
      await Bun.sleep(1_500);
      clearedAt = Date.now();
      await unlink(path);
    })();

    const acquiredAt = await withFileLock(path, async () => Date.now());
    await clearer;
    expect(acquiredAt).toBeGreaterThanOrEqual(clearedAt);
  }, 15_000);

  test("a held lock exposes a legible owner record", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-legible-"));
    roots.push(root);
    const path = join(root, "state.lock");

    // Weaker than atomicity: after acquisition returns, the owner record is
    // present and parseable while held. Publication-window atomicity is
    // structural (staging file + atomic link) and is not exercised here.
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
    await writeFile(
      path,
      JSON.stringify({
        pid: Number.MAX_SAFE_INTEGER,
        token: "stale-owner",
      }),
    );

    expect(
      await withFileLock(path, async () => "acquired", {
        probe: () => "dead",
      }),
    ).toBe("acquired");
  });

  test("breaks a foreign-uid lock only after the full wait window", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-foreign-"));
    roots.push(root);
    const path = join(root, "state.lock");
    await writeFile(
      path,
      JSON.stringify({ pid: 424242, token: "foreign-owner" }),
    );

    const startedAt = Date.now();
    const holder = await withFileLock(
      path,
      async () => JSON.parse(await readFile(path, "utf8")),
      {
        probe: () => "other-uid",
        deadlineMs: 300,
      },
    );
    // Not immediate (a dead owner is reclaimed on sight) and not never (the
    // old EPERM-is-alive reading wedged the lock until a user deleted it):
    // the break lands at the window's end.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(holder.token).not.toBe("foreign-owner");
  });

  test("never breaks a live same-uid holder's lock at the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-held-"));
    roots.push(root);
    const path = join(root, "state.lock");
    await writeFile(path, JSON.stringify({ pid: 424242, token: "live-owner" }));

    await expect(
      withFileLock(path, async () => "acquired", {
        probe: () => "live",
        deadlineMs: 200,
      }),
    ).rejects.toThrow("Timed out waiting for lock");
    // The lock is untouched: it still names the original owner.
    expect(JSON.parse(await readFile(path, "utf8")).token).toBe("live-owner");
  });
});

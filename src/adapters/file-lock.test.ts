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

  test("reclaims an abandoned lock whose owner never wrote its record", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-empty-"));
    roots.push(root);
    const path = join(root, "state.lock");
    // The corpse of a process that died between creating the lock and writing
    // who it was: no owner to check for liveness, so nothing used to reclaim it.
    // The lock was held by nobody, forever.
    await writeFile(path, "");

    expect(await withFileLock(path, async () => "acquired")).toBe("acquired");
  }, 15_000);

  test("never publishes a lock name without its owner record", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-file-lock-atomic-"));
    roots.push(root);
    const path = join(root, "state.lock");

    // Whatever a concurrent reader catches, it never catches an empty lock:
    // the name and the contents appear in the same instant.
    const seen: string[] = [];
    const reader = (async () => {
      for (let index = 0; index < 200; index += 1) {
        const source = await readFile(path, "utf8").catch(() => null);
        if (source !== null) seen.push(source);
        await Bun.sleep(1);
      }
    })();
    for (let index = 0; index < 40; index += 1) {
      await withFileLock(path, async () => undefined);
    }
    await reader;

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((source) => source.trim().length > 0)).toBe(true);
  }, 15_000);

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

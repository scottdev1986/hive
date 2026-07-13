import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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

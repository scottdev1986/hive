// Unit tests for the `make run` dev-home memory sharing (scripts/dev-memory-
// setup.ts): the four shared paths are linked dev → real, pre-existing dev
// state is never touched, stale links are refreshed, the real dirs are
// created when absent, and daemon runtime state is never linked.
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatShareSummary,
  SHARED_STATE_NAMES,
  shareMemoryState,
} from "./dev-memory-setup";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeHomes(): Promise<{ devHome: string; realHome: string }> {
  const root = await mkdtemp(join(tmpdir(), "hive-dev-mem-setup-"));
  tempRoots.push(root);
  const devHome = join(root, "dev-home");
  const realHome = join(root, "real-home");
  await mkdir(devHome, { recursive: true });
  await mkdir(realHome, { recursive: true });
  return { devHome, realHome };
}

async function plantRealMemory(realHome: string): Promise<void> {
  await mkdir(join(realHome, "memory"), { recursive: true });
  await mkdir(join(realHome, "projects"), { recursive: true });
  await mkdir(join(realHome, "models"), { recursive: true });
  await writeFile(join(realHome, "project-registry.json"), "{}");
}

async function linkTarget(path: string): Promise<string | null> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null || !stat.isSymbolicLink()) return null;
  return readlink(path);
}

describe("shareMemoryState", () => {
  test("links all four shared paths dev -> real", async () => {
    const { devHome, realHome } = await makeHomes();
    await plantRealMemory(realHome);

    const result = await shareMemoryState(devHome, realHome);

    expect(result.linked.sort()).toEqual([...SHARED_STATE_NAMES].sort());
    expect(result.warnings).toEqual([]);
    for (const name of SHARED_STATE_NAMES) {
      expect(await linkTarget(join(devHome, name))).toBe(join(realHome, name));
    }
  });

  test("a write through the dev links lands in the real home", async () => {
    const { devHome, realHome } = await makeHomes();
    await plantRealMemory(realHome);
    await shareMemoryState(devHome, realHome);

    await writeFile(join(devHome, "memory", "probe.md"), "dev wrote this");
    await writeFile(join(devHome, "project-registry.json"), '{"via":"dev"}');

    expect(await Bun.file(join(realHome, "memory", "probe.md")).text())
      .toBe("dev wrote this");
    expect(await Bun.file(join(realHome, "project-registry.json")).text())
      .toBe('{"via":"dev"}');
  });

  test("creates and links every shared path before the first installed release", async () => {
    const { devHome, realHome } = await makeHomes();

    const result = await shareMemoryState(devHome, realHome);

    expect((await lstat(join(realHome, "memory"))).isDirectory()).toBe(true);
    expect((await lstat(join(realHome, "projects"))).isDirectory()).toBe(true);
    expect((await lstat(join(realHome, "models"))).isDirectory()).toBe(true);
    expect(
      JSON.parse(await Bun.file(join(realHome, "project-registry.json")).text()),
    ).toEqual({ records: [], tombstones: [] });
    expect(result.linked.sort()).toEqual([...SHARED_STATE_NAMES].sort());
    expect(result.skipped).toEqual([]);
    for (const name of SHARED_STATE_NAMES) {
      expect(await linkTarget(join(devHome, name))).toBe(join(realHome, name));
    }
  });

  test("an existing real dev directory with content warns and stays untouched", async () => {
    const { devHome, realHome } = await makeHomes();
    await plantRealMemory(realHome);
    const devOnly = join(devHome, "memory");
    await mkdir(devOnly, { recursive: true });
    await writeFile(join(devOnly, "dev-only.md"), "private dev memory");

    const result = await shareMemoryState(devHome, realHome);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("NOT linked");
    expect(result.warnings[0]).toContain(devOnly);
    expect(result.linked).not.toContain("memory");
    const stat = await lstat(devOnly);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
    expect(await Bun.file(join(devOnly, "dev-only.md")).text())
      .toBe("private dev memory");
  });

  test("a stale symlink is refreshed to point at the real home", async () => {
    const { devHome, realHome } = await makeHomes();
    await plantRealMemory(realHome);
    const elsewhere = join(devHome, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(devHome, "projects"));

    const result = await shareMemoryState(devHome, realHome);

    expect(result.refreshed).toEqual(["projects"]);
    expect(await linkTarget(join(devHome, "projects")))
      .toBe(join(realHome, "projects"));
    // The stale target itself is dev-home data; refreshing never deletes it.
    expect((await lstat(elsewhere)).isDirectory()).toBe(true);
  });

  test("an already-correct symlink is left in place", async () => {
    const { devHome, realHome } = await makeHomes();
    await plantRealMemory(realHome);
    await shareMemoryState(devHome, realHome);

    const second = await shareMemoryState(devHome, realHome);

    expect(second.linked.sort()).toEqual([...SHARED_STATE_NAMES].sort());
    expect(second.refreshed).toEqual([]);
    expect(second.warnings).toEqual([]);
  });

  test("daemon runtime state in the real home is never linked", async () => {
    const { devHome, realHome } = await makeHomes();
    await plantRealMemory(realHome);
    const runtimeState = [
      "daemon.port",
      "daemon.pid",
      "hive.db",
      "quota.db",
      "update-check.json",
    ];
    for (const name of runtimeState) {
      await writeFile(join(realHome, name), "real runtime state");
    }
    for (const name of ["credentials", "runtime", "logs", "instances", "tools"]) {
      await mkdir(join(realHome, name), { recursive: true });
    }

    const result = await shareMemoryState(devHome, realHome);

    expect(result.warnings).toEqual([]);
    for (const name of [...runtimeState, "credentials", "runtime", "logs", "instances", "tools"]) {
      await expect(lstat(join(devHome, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  test("the summary prints the shared-store concurrency note", async () => {
    const { devHome, realHome } = await makeHomes();
    await plantRealMemory(realHome);
    const result = await shareMemoryState(devHome, realHome);

    const summary = formatShareSummary(devHome, realHome, result).join("\n");
    expect(summary).toContain("episodic stores");
    expect(summary).toContain("WAL + busy_timeout");
    expect(summary).toContain("stays per-home");
  });
});

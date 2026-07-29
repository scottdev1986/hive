import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/db";
import { HiveDaemon } from "../../src/daemon/server";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

async function withDatabase<T>(run: (db: HiveDatabase) => T): Promise<T> {
  const directory = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "stranded-"));
  const db = new HiveDatabase(join(directory, "hive.db"));
  try {
    return run(db);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const entry = {
  branch: "hive/maya-refactor",
  agentName: "maya",
  worktreePath: "/tmp/worktrees/maya",
  unmergedCommits: 2,
  dirtyFileCount: 1,
};

describe("stranded worktrees", () => {
  test("the record holds the agent's name until the work is accounted for", async () => {
    await withDatabase((db) => {
      expect(db.isNameHeldByStrandedWork("maya")).toBe(false);

      db.recordStrandedWorktree(entry);
      // The hold is what stops a second maya being spawned onto a name that
      // still identifies undecided work — its branch, its credential, and the
      // sentence "there is work on maya" would all become ambiguous.
      expect(db.isNameHeldByStrandedWork("maya")).toBe(true);
      expect(db.isNameHeldByStrandedWork("nina")).toBe(false);

      // Releasing is what makes the name available again.
      expect(db.clearStrandedWorktree(entry.branch)).toBe(true);
      expect(db.isNameHeldByStrandedWork("maya")).toBe(false);
    });
  });

  test("re-recording updates the counts without losing when it was first seen", async () => {
    await withDatabase((db) => {
      db.recordStrandedWorktree({ ...entry, at: "2026-07-01T00:00:00.000Z" });
      db.recordStrandedWorktree({
        ...entry,
        unmergedCommits: 1,
        dirtyFileCount: 0,
        at: "2026-07-09T00:00:00.000Z",
      });

      const [row] = db.listStrandedWorktrees();
      expect(row?.unmergedCommits).toBe(1);
      expect(row?.dirtyFileCount).toBe(0);
      // Age is the signal that separates "a decision nobody has made yet" from
      // "this happened a minute ago", so a re-check must not reset it.
      expect(row?.firstSeenAt).toBe("2026-07-01T00:00:00.000Z");
      expect(row?.lastCheckedAt).toBe("2026-07-09T00:00:00.000Z");
    });
  });

  test("the record survives a restart, so the hold is not a process's memory", async () => {
    const directory = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "stranded-"));
    const path = join(directory, "hive.db");
    try {
      const first = new HiveDatabase(path);
      first.recordStrandedWorktree(entry);
      // Transient spawn reservations are cleared at startup by design; this
      // hold must NOT be, or a restart quietly frees a name whose work is
      // still waiting on someone.
      first.clearAgentNameReservations();
      first.close();

      const second = new HiveDatabase(path);
      expect(second.isNameHeldByStrandedWork("maya")).toBe(true);
      expect(second.listStrandedWorktrees()).toHaveLength(1);
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("the stranded-worktree sweep", () => {
  function daemonWith(options: {
    unmergedCommits: number;
    dirtyFiles?: readonly string[];
    removals: string[];
    db: HiveDatabase;
  }): HiveDaemon {
    return new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db: options.db,
      spawner: {
        spawn: async () => {
          throw new Error("no spawns in this test");
        },
      },
      repoRoot: "/tmp/hive-stranded-noop",
      assessStrandedWork: async () => ({
        dirtyFiles: [...(options.dirtyFiles ?? [])],
        unmergedCommits: options.unmergedCommits,
      }),
      removeWorktree: async (_root, path) => {
        options.removals.push(path);
      },
    });
  }

  test("work that reached main releases the name and removes the worktree", async () => {
    const directory = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "sweep-"));
    const db = new HiveDatabase(join(directory, "hive.db"));
    const removals: string[] = [];
    // The agent is long gone, so nobody is left to say the work landed. Git is
    // asked again, and it now answers that nothing is missing from main —
    // which is exactly the cherry-picked case that used to strand a worktree
    // forever, because a cherry-pick keeps the change and takes a new sha.
    const daemon = daemonWith({ unmergedCommits: 0, removals, db });
    try {
      db.recordStrandedWorktree(entry);
      expect(await daemon.sweepStrandedWorktrees()).toBe(1);
      expect(removals).toEqual([entry.worktreePath]);
      expect(db.isNameHeldByStrandedWork("maya")).toBe(false);
    } finally {
      await daemon.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("work still missing from main keeps its worktree and its hold", async () => {
    const directory = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "sweep-"));
    const db = new HiveDatabase(join(directory, "hive.db"));
    const removals: string[] = [];
    const daemon = daemonWith({ unmergedCommits: 1, removals, db });
    try {
      db.recordStrandedWorktree(entry);
      expect(await daemon.sweepStrandedWorktrees()).toBe(0);
      // The sweep may only ever delete a worktree, never work.
      expect(removals).toEqual([]);
      expect(db.isNameHeldByStrandedWork("maya")).toBe(true);
    } finally {
      await daemon.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// The daemon start reports how many rendezvous nodes sit under the resolved
// socket root, so the sweep threshold can be seen to cross instead of passing
// unnoticed. These tests pin the count's correctness against a fixture whose
// total cannot arise by accident, the absent-root case reading as zero rather
// than failing, and the wiring that lands the number in the daemon log.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../../src/daemon/database/hive-database";
import { daemonLogPath } from "../../../src/daemon/observability/daemon-log";
import { HiveDaemon } from "../../../src/daemon/server";
import { countSocketRootNodes } from "../../../src/daemon/session-host/host-operations";
import type {
  Spawner,
  SpawnRequest,
} from "../../../src/daemon/spawn/spawn-service";
import { sessiondRuntimeRoot } from "../../../src/hive-home/instance-identity";

const tempRoots: string[] = [];
let previousHiveHome: string | undefined;

beforeEach(() => {
  previousHiveHome = process.env.HIVE_HOME;
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHiveHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-sockcount-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  return home;
}

/** Plants exactly 42 nodes under the root: two directories and one file at the top, 20 entries in the first directory, 19 in the second. A count that skipped nesting reads 3, one that included the root itself reads 43 — 42 cannot arise by accident. */
async function plantSocketTree(root: string): Promise<void> {
  await mkdir(join(root, "a"), { recursive: true });
  await mkdir(join(root, "b"), { recursive: true });
  const writes: Promise<unknown>[] = [writeFile(join(root, "stray.s"), "")];
  for (let i = 0; i < 20; i += 1) {
    writes.push(writeFile(join(root, "a", `n${i}.s`), ""));
  }
  for (let i = 0; i < 19; i += 1) {
    writes.push(writeFile(join(root, "b", `n${i}.s`), ""));
  }
  await Promise.all(writes);
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<never> {
    throw new Error("not exercised by socket-root count tests");
  }
}

async function makeDaemon(): Promise<HiveDaemon> {
  const repoRoot = await mkdtemp(join(tmpdir(), "hive-sockcount-repo-"));
  tempRoots.push(repoRoot);
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    repoRoot,
  });
}

describe("countSocketRootNodes", () => {
  test("counts every node under the root, nesting included", async () => {
    const home = await makeTempHome();
    await plantSocketTree(sessiondRuntimeRoot(home));
    expect(countSocketRootNodes(home)).toBe(42);
  });

  test("an absent root reads as zero rather than failing", async () => {
    const home = await makeTempHome();
    expect(countSocketRootNodes(home)).toBe(0);
  });
});

describe("HiveDaemon socket-root count reporting", () => {
  test("start reports the exact node count for the planted tree", async () => {
    const home = await makeTempHome();
    const root = sessiondRuntimeRoot(home);
    await plantSocketTree(root);
    const daemon = await makeDaemon();
    daemon.start();
    try {
      const content = await readFile(daemonLogPath(home), "utf8");
      expect(content).toContain(
        `Hive sessiond socket root: 42 node(s) under ${root} (sweep threshold 1000)`,
      );
    } finally {
      await daemon.stop();
    }
  });

  test("start reports zero for an absent root instead of failing", async () => {
    const home = await makeTempHome();
    const daemon = await makeDaemon();
    daemon.start();
    try {
      const content = await readFile(daemonLogPath(home), "utf8");
      expect(content).toContain(
        `Hive sessiond socket root: 0 node(s) under ${sessiondRuntimeRoot(home)} (sweep threshold 1000)`,
      );
    } finally {
      await daemon.stop();
    }
  });
});
